import { assert } from "chai";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: streaming in actual native chat hosts", function () {
  this.timeout(120000);
  let api: WorkflowTestApi;
  let win: any;
  const fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[] = [];
  const readers: any[] = [];
  const measurements: unknown[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let originalLayout: unknown;

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
  });

  after(async function () {
    await api.closeStandalone();
    for (const reader of readers) reader.close();
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
    await Zotero.File.putContentsAsync(
      `${Zotero.DataDirectory.dir}/native-streaming-measurements.json`,
      JSON.stringify(measurements, null, 2),
    );
  });

  const mean = (values: number[]) =>
    values.reduce((total, value) => total + value, 0) /
    Math.max(1, values.length);

  // Tab count is a load setting, not a code path: agent runs use the heavier
  // 4 tabs. The 1-tab chat runs go first so no extra readers exist yet.
  for (const tabCount of [1, 4]) {
    for (const surface of ["independent", "stacked", "standalone"] as const) {
      for (const runMode of ["agent", "chat"] as const) {
        // Ordinary Chat shares the host lifecycle; one retained tab is enough.
        if (runMode === "chat" && (tabCount !== 1 || surface === "stacked"))
          continue;
        if (runMode === "agent" && tabCount === 1) continue;
        const title =
          runMode === "agent"
            ? `keeps streaming interactive in ${surface} with ${tabCount} retained reader tabs`
            : `streams ordinary Chat in place in ${surface} with ${tabCount} retained reader tabs`;
        it(title, async function () {
          await api.closeStandalone();
          Zotero.Prefs.set(
            layoutPref,
            surface === "stacked" ? "stacked" : "independent",
            true,
          );
          while (readers.length < tabCount) {
            const fixture = await api.createPaperWithPdfFixture({
              title: `Native stream ${readers.length + 1}`,
              pdfTitle: `Native stream PDF ${readers.length + 1}`,
            });
            fixtures.push(fixture);
            const reader = (await Zotero.Reader.open(
              fixture.pdfAttachmentId,
            )) as _ZoteroTypes.ReaderInstance;
            await reader._initPromise;
            await reader._waitForReader();
            readers.push(reader);
          }
          let root: HTMLElement;
          if (surface === "standalone") {
            await api.openStandaloneForItem(fixtures[0].parentItemId);
            root = (
              Zotero as any
            ).LLMForZotero.data.standaloneWindow.document.querySelector(
              "#llm-main",
            );
          } else {
            win.Zotero_Tabs.select(readers[0].tabID);
            await until(
              () =>
                Boolean(
                  getReaderContextPanelForTab(win.document, readers[0].tabID),
                ),
              "reader sidebar host exists",
            );
            const details: any = getReaderContextPanelForTab(
              win.document,
              readers[0].tabID,
            );
            await until(
              () => Boolean(details.querySelector(".llm-dedicated-chat-pane")),
              "chat section exists",
            );
            const section = details.querySelector(".llm-dedicated-chat-pane");
            if (
              details.sidenav._collapsed ||
              !["chat", "stacked"].includes(
                win.document.documentElement.getAttribute("data-llm-pane-view"),
              )
            ) {
              const button = Array.from(
                details.sidenav.querySelectorAll("[data-pane]"),
              ).find(
                (node: any) =>
                  node.getAttribute("data-pane") === section.dataset.pane,
              ) as Element;
              button.dispatchEvent(
                new win.MouseEvent("click", { bubbles: true, button: 0 }),
              );
            }
            await until(
              () => !details._disableScrollHandler,
              "native pane navigation settles",
            );
            await section._forceRenderAll();
            await until(
              () =>
                Boolean(
                  section.querySelector("#llm-main")?.dataset
                    .handlersInitialized,
                ) &&
                section.querySelector("#llm-main")?.getBoundingClientRect()
                  .height > 0,
              "native chat is initialized and visible",
            );
            root = section.querySelector("#llm-main");
          }
          const body = root.parentElement!;
          const styleBefore = body.getAttribute("style");
          const result = await api.exerciseNativeStreamingReplay({
            surface: surface === "standalone" ? "standalone" : "embedded",
            historyTurns: 60,
            chunks: 30,
            runMode,
          });
          measurements.push({ ...result, surface, tabCount, runMode });
          assert.strictEqual(
            body.querySelector("#llm-main"),
            root,
            "native lifecycle finished before replay",
          );
          assert.equal(
            body.getAttribute("style"),
            styleBefore,
            "replay preserves the actual host layout",
          );
          assert.equal(
            result.wrapperReplacements,
            0,
            `${runMode} streaming updates the mounted answer in place (flushes: ${result.renderMs.length})`,
          );
          assert.closeTo(result.manualScrollDelta, 0, 2);
          assert.isTrue(result.composerPreserved);
          assert.isTrue(result.answerVisibleBeforeFinal);
          assert.isTrue(result.finalAnswerVisible);
          assert.isTrue(result.statusVisible);
          if (runMode === "agent") {
            assert.equal(result.progressReplacements, 0);
            assert.equal(result.progressMutations, 0);
            assert.equal(result.ledgerReadsDuringText, 0);
            assert.isTrue(result.focusPreserved);
            assert.isTrue(result.exactReasoning);
          } else {
            // A rebuilt wrapper re-parses the whole answer, so per-flush cost
            // would climb with its length. In place, it stays flat.
            assert.isNotEmpty(result.flushMsFirst);
            assert.isBelow(
              mean(result.flushMsLast),
              3 * mean(result.flushMsFirst),
              `per-flush render cost stays flat (first5=${JSON.stringify(
                result.flushMsFirst.map((v) => Math.round(v * 10) / 10),
              )} last5=${JSON.stringify(
                result.flushMsLast.map((v) => Math.round(v * 10) / 10),
              )})`,
            );
          }
          const inputDelays = [...result.inputFrameMs, ...result.typingFrameMs];
          assert.isNotEmpty(inputDelays);
          // A coarse freeze alarm, not a frame-rate claim on shared CI hardware.
          assert.isBelow(
            Math.max(...inputDelays),
            1000,
            "input reaches a frame without a one-second stall",
          );
          Zotero.debug(
            `NATIVE_STREAMING ${JSON.stringify({ surface, tabCount, runMode, inputDelays, renderMs: result.renderMs })}`,
            1,
          );
        });
      }
    }
  }
});
