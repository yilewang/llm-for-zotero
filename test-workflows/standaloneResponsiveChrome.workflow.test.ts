import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: standalone responsive chrome", function () {
  this.timeout(45000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let win: Window;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Responsive chrome",
      pdfTitle: "Responsive chrome PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow;
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("animates the occupied sidebar width to zero when narrowing the window", async function () {
    await api.resizeStandaloneWindow(900, 650);
    const sidebar = win.document.querySelector(".llm-standalone-sidebar")!;
    const before = sidebar.getBoundingClientRect().width;
    const widths: number[] = [];
    const start = win.performance.now();
    const sampling = new Promise<void>((resolve) => {
      const sample = () => {
        widths.push(sidebar.getBoundingClientRect().width);
        if (win.performance.now() - start < 600)
          win.requestAnimationFrame(sample);
        else resolve();
      };
      win.requestAnimationFrame(sample);
    });
    await api.resizeStandaloneWindow(650, 650);
    await sampling;
    assert.equal(sidebar.getAttribute("data-sidebar-state"), "collapsed");
    assert.equal(sidebar.getBoundingClientRect().width, 0);
    assert.isTrue(
      widths.some((width) => width > 1 && width < before - 10),
      `Expected intermediate collapse frames: ${JSON.stringify(widths)}`,
    );
    await api.resizeStandaloneWindow(900, 650);
    assert.closeTo(sidebar.getBoundingClientRect().width, before, 1);
    await api.toggleStandaloneSidebar();
    const hover = await api.hoverStandaloneSidebarToggle();
    assert.equal(hover.sidebarWidthPx, 0);
    assert.isAbove(hover.sidebarPanelWidthPx ?? 0, 100);
  });

  it("keeps both runtime icons clear of the tabs and compacts title actions in sync", async function () {
    const doc = win.document;
    const root = doc.querySelector(
      "#llmforzotero-standalone-chat-root",
    ) as HTMLElement;
    const runtime = doc.querySelector(
      ".llm-standalone-runtime-system-controls",
    ) as HTMLElement;
    // Exercise both optional runtimes without starting a provider session.
    runtime.dataset.visibleCount = "2";
    runtime.style.display = "inline-flex";
    for (const child of Array.from(runtime.children) as HTMLElement[])
      child.style.display = "inline-flex";
    const rect = (selector: string) =>
      doc.querySelector(selector)!.getBoundingClientRect();
    const actionWidth = () => rect(".llm-standalone-icon-export").width;
    await api.resizeStandaloneWindow(1000, 650);
    const wideAction = actionWidth();
    for (const scale of [1, 1.8]) {
      root.style.setProperty("--llm-font-scale", String(scale));
      for (const width of [700, 550, 500]) {
        await api.resizeStandaloneWindow(width, 650);
        const leading = rect(".llm-standalone-tab-row-leading");
        const tabs = rect(".llm-standalone-tab-group");
        assert.isAtMost(
          leading.right,
          tabs.left + 0.5,
          `Controls overlap tabs at ${width}px / scale ${scale}`,
        );
        assert.isAtMost(tabs.right, win.innerWidth);
        for (const tab of Array.from(
          doc.querySelectorAll(".llm-standalone-tab"),
        ) as HTMLElement[]) {
          assert.isAtMost(
            tab.scrollWidth,
            tab.clientWidth + 1,
            "Tab label must remain fully visible",
          );
        }
        assert.equal(actionWidth(), rect(".llm-standalone-icon-clear").width);
      }
    }
    await api.hoverStandaloneSidebarToggle();
    for (const tab of Array.from(
      doc.querySelectorAll(".llm-standalone-tab"),
    ) as HTMLElement[]) {
      const bounds = tab.getBoundingClientRect();
      assert.isTrue(
        tab.contains(
          doc.elementFromPoint(bounds.left + 2, bounds.top + bounds.height / 2),
        ),
        "Hover sidebar must not cover the tab's leading edge",
      );
    }
    assert.isBelow(
      actionWidth(),
      wideAction,
      "Export and trash spacing must compact with the toolbar",
    );
  });
});
