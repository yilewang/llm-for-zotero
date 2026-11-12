import { assert } from "chai";
import { getReaderContextPanelForTab } from "../../src/modules/contextPanel/readerPopupPanelRouting";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../../src/modules/contextPanel/workflowTestTypes";
import type {
  MemoryProbeSample,
  ChatModeTurnResult,
} from "../../src/modules/contextPanel/chatMemoryReplay";

describe("measurement: closed reader panels and ordinary Chat", function () {
  this.timeout(900000);

  it("records the same workload in a fresh disposable profile", async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const win = Zotero.getMainWindow() as any;
    const pref = "extensions.zotero.llmforzotero.sidebarLayout";
    const previous = Zotero.Prefs.get(pref, true);
    const fixtures: WorkflowTestFixture[] = [];
    const report = {
      schema: 1,
      zoteroVersion: Zotero.version,
      dataDirectory: Zotero.DataDirectory.dir,
      workload: { readerCycles: 8, chatTurns: 40, chunksPerTurn: 120 },
      samples: [] as MemoryProbeSample[],
      turns: [] as ChatModeTurnResult[],
    };
    const save = () =>
      Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/chat-memory.json`,
        JSON.stringify(report, null, 2),
      );
    const sample = async (label: string, gc = true) => {
      report.samples.push(await api.memoryProbeInspect({ label, gc }));
      await save();
    };
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 20000;
      while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
      assert.isTrue(check(), "reader chat panel becomes visible");
    };
    const open = async (name: string) => {
      const fixture = await api.createPaperWithPdfFixture({
        title: `Memory ${name}`,
        pages: ["Deterministic PDF fixture."],
      });
      fixtures.push(fixture);
      const reader = await Zotero.Reader.open(fixture.pdfAttachmentId!);
      await reader!._initPromise;
      await (reader as any)._waitForReader();
      win.Zotero_Tabs.select(reader!.tabID);
      await until(() =>
        Boolean(getReaderContextPanelForTab(win.document, reader!.tabID)),
      );
      const details: any = getReaderContextPanelForTab(
        win.document,
        reader!.tabID,
      );
      await until(() =>
        Boolean(details.querySelector(".llm-dedicated-chat-pane")),
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
      await until(() => !details._disableScrollHandler);
      await section._forceRenderAll();
      await until(
        () =>
          Boolean(
            section.querySelector("#llm-main")?.dataset.handlersInitialized,
          ) &&
          section.querySelector("#llm-main")?.getBoundingClientRect().height >
            0,
      );
      return reader as any;
    };
    let chatReader: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await api.reset();
      Zotero.Prefs.set(pref, "independent", true);
      // Warm the same reader/chat modules before comparing growth.
      const warm = await open("warmup");
      warm.close();
      await Zotero.Promise.delay(500);
      await sample("warm-baseline");
      for (let n = 0; n < report.workload.readerCycles; n++) {
        const reader = await open(`cycle-${n}`);
        await Zotero.Promise.delay(300);
        reader.close();
        await Zotero.Promise.delay(500);
      }
      await sample("after-reader-cycles");
      chatReader = await open("chat");
      await sample("before-chat");
      for (
        let turnIndex = 1;
        turnIndex <= report.workload.chatTurns;
        turnIndex++
      ) {
        const turn = await api.exerciseChatModeStreamingTurn({
          turnIndex,
          chunks: report.workload.chunksPerTurn,
        });
        report.turns.push(turn);
        assert.isTrue(
          turn.streamedTextVisible,
          "ordinary Chat text is visible before finalization",
        );
        // Sample before GC as well as after it; do not label a post-GC sample as a peak.
        if (turnIndex % 10 === 0) {
          await sample(`chat-${turnIndex}-pre-gc`, false);
          await sample(`chat-${turnIndex}-post-gc`);
        }
      }
      chatReader.close();
      chatReader = undefined;
      await Zotero.Promise.delay(1000);
      await sample("after-chat-close");
    } finally {
      chatReader?.close();
      await save();
      await api.reset();
      for (const fixture of fixtures) await api.cleanupFixture(fixture);
      if (previous === undefined) Zotero.Prefs.clear(pref, true);
      else Zotero.Prefs.set(pref, previous, true);
    }
  });
});
