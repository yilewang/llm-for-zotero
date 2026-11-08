import { assert } from "chai";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: the reader-side panel follows the active reader tab", function () {
  this.timeout(120000);
  let api: WorkflowTestApi;
  let win: any;
  const fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[] = [];
  const readers: any[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let originalLayout: unknown;

  async function until(check: () => boolean, message: string, ms = 15000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
    for (let index = 0; index < 3; index += 1) {
      const fixture = await api.createPaperWithPdfFixture({
        title: `Reader follow paper ${index + 1}`,
        pdfTitle: `Reader follow PDF ${index + 1}`,
      });
      fixtures.push(fixture);
      const reader = (await Zotero.Reader.open(
        fixture.pdfAttachmentId,
      )) as _ZoteroTypes.ReaderInstance;
      await reader._initPromise;
      await reader._waitForReader();
      readers.push(reader);
    }
  });

  after(async function () {
    for (const reader of readers) reader.close();
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
  });

  /** The chat panel root shown for a reader tab, opening its section once. */
  async function panelFor(tabID: string): Promise<HTMLElement> {
    await until(
      () => Boolean(getReaderContextPanelForTab(win.document, tabID)),
      "reader sidebar host exists",
    );
    const details: any = getReaderContextPanelForTab(win.document, tabID);
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
        (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
      ) as Element;
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    await section._forceRenderAll?.();
    await until(
      () =>
        Boolean(
          section.querySelector("#llm-main")?.dataset.handlersInitialized,
        ),
      "chat panel is initialized",
    );
    return section.querySelector("#llm-main");
  }

  for (const layout of ["independent", "stacked"] as const) {
    it(`switches the panel to each tab's paper (${layout})`, async function () {
      Zotero.Prefs.set(layoutPref, layout, true);
      const timings: number[] = [];
      // Two full rounds over three tabs: every switch must land on the
      // selected tab's paper, and the chat box must take input again.
      for (const round of [0, 1]) {
        for (let index = 0; index < readers.length; index += 1) {
          const started = Date.now();
          win.Zotero_Tabs.select(readers[index].tabID);
          const expected = `${fixtures[index].parentItemId}`;
          let root: HTMLElement | null = null;
          await until(
            () => {
              const details: any = getReaderContextPanelForTab(
                win.document,
                readers[index].tabID,
              );
              root =
                details?.querySelector(".llm-dedicated-chat-pane #llm-main") ||
                null;
              return root?.dataset.basePaperItemId === expected;
            },
            `${layout} round ${round}: panel follows tab ${index + 1} (shows ${
              (root as HTMLElement | null)?.dataset.basePaperItemId
            }, expected ${expected})`,
            8000,
          ).catch(async (error) => {
            // The first visit may need the section opened.
            if (round > 0) throw error;
            root = await panelFor(readers[index].tabID);
            await until(
              () => root?.dataset.basePaperItemId === expected,
              `${layout}: panel follows tab ${index + 1} after opening (shows ${root?.dataset.basePaperItemId}, expected ${expected})`,
              8000,
            );
          });
          timings.push(Date.now() - started);
          const chatBox = (root as HTMLElement | null)?.querySelector(
            "#llm-chat-box",
          );
          await until(
            () => !chatBox?.hasAttribute("inert"),
            `${layout}: tab ${index + 1}'s chat takes input`,
            5000,
          );
        }
      }
      Zotero.debug(
        `READER_TAB_FOLLOW ${JSON.stringify({ layout, timings })}`,
        1,
      );
    });
  }

  it("switches the pop-out window's Paper chat to each tab's paper", async function () {
    Zotero.Prefs.set(layoutPref, "independent", true);
    win.Zotero_Tabs.select(readers[0].tabID);
    await api.openStandaloneForItem(fixtures[0].parentItemId);
    const standalone = (Zotero as any).LLMForZotero.data
      .standaloneWindow as Window;
    const root = () =>
      standalone.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement | null;
    try {
      for (const round of [0, 1]) {
        for (let index = 0; index < readers.length; index += 1) {
          win.Zotero_Tabs.select(readers[index].tabID);
          const expected = `${fixtures[index].parentItemId}`;
          await until(
            () => root()?.dataset.basePaperItemId === expected,
            `pop-out round ${round}: follows tab ${index + 1} (shows ${
              root()?.dataset.basePaperItemId
            }, expected ${expected})`,
            8000,
          );
          await until(
            () =>
              !root()?.querySelector("#llm-chat-box")?.hasAttribute("inert"),
            `pop-out: tab ${index + 1}'s chat takes input`,
            5000,
          );
        }
      }
    } finally {
      await api.closeStandalone();
    }
  });
});
