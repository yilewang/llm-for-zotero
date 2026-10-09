import { assert } from "chai";
import { updateHeaderSpacing } from "../src/modules/contextPanel/setupHandlers/controllers/headerSpacing";
import { applyTaskProgressToggleState } from "../src/modules/contextPanel/taskProgress/toggleButton";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { waitForNativeWindowFrame } from "./nativeWindowReadiness";

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
    await waitForNativeWindowFrame(win);
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("keeps each embedded header row on one line at every font size", async function () {
    const doc = win.document;
    const layoutAttribute = "data-llm-sidebar-layout";
    const previousLayout = doc.documentElement.getAttribute(layoutAttribute);
    // This fixture exercises the independent, two-row embedded header.
    // Do not inherit a previous suite's stacked layout, which deliberately
    // hides the toggle row and narrow Task progress action.
    doc.documentElement.setAttribute(layoutAttribute, "independent");
    const panel = doc.createElement("div");
    panel.className = "llm-panel";
    // The native XUL window has no HTML body. Keep this fixture independent
    // of the window's flex layout so each requested width is measured exactly.
    panel.style.position = "fixed";
    panel.style.left = "0";
    panel.style.top = "0";
    const header = doc
      .querySelector(".llm-header")!
      .cloneNode(true) as HTMLElement;
    panel.appendChild(header);
    (doc.body || doc.documentElement).appendChild(panel);
    try {
      const runtime = panel.querySelector(
        ".llm-runtime-system-controls",
      ) as HTMLElement;
      runtime.dataset.visibleCount = "2";
      runtime.style.display = "inline-flex";
      for (const child of Array.from(runtime.children) as HTMLElement[])
        child.style.display = "inline-flex";
      const paperTabLabel = panel.querySelector(
        "#llm-paper-chat-tab .llm-header-mode-tab-label",
      ) as HTMLElement;
      const toggleRow = header.querySelector(
        ".llm-header-toggle-row",
      ) as HTMLElement;
      const navRow = header.querySelector(".llm-header-nav-row") as HTMLElement;
      const tabGroup = header.querySelector(
        ".llm-header-mode-tabs",
      ) as HTMLElement;
      assert.isOk(paperTabLabel, "the paper tab renders its label");
      assert.isOk(toggleRow, "the toggle row is rendered");
      assert.isOk(navRow, "the actions row is rendered");
      // The cloned header comes from a live panel that may hide its rows.
      toggleRow.style.display = "";
      const historyBar = header.querySelector(
        "#llm-history-bar",
      ) as HTMLElement;
      historyBar.style.display = "inline-flex";
      const runtimeWrapper = header.querySelector(
        "#llm-header-runtime-controls",
      ) as HTMLElement;
      runtimeWrapper.style.display = "";
      assert.deepEqual(
        Array.from(header.querySelectorAll(".llm-header-actions > button")).map(
          (button) => (button as HTMLElement).id,
        ),
        [
          "llm-task-progress-toggle",
          "llm-popout",
          "llm-settings",
          "llm-export",
          "llm-clear",
        ],
        "the embedded header includes its Task progress action",
      );
      // The standalone source leaves its inner header button unbound/hidden.
      // Exercise the full embedded action row, including the new control,
      // rather than silently dropping it from the geometry checks.
      applyTaskProgressToggleState(
        header.querySelector<HTMLButtonElement>("#llm-task-progress-toggle")!,
        { applies: true, shown: false },
      );
      for (const label of ["Paper chat", "Note chat", "Web chat"]) {
        paperTabLabel.textContent = label;
        for (const scale of [0.8, 1.2, 1.8]) {
          panel.style.setProperty("--llm-font-scale", String(scale));
          for (const width of [320, 340, 380, 500]) {
            panel.style.width = `${width}px`;
            await waitForNativeWindowFrame(win);
            updateHeaderSpacing(navRow);
            if (width >= 380) {
              assert.equal(
                navRow.style.getPropertyValue("--llm-runtime-compression"),
                "0",
                "Ample room must restore the original runtime spacing",
              );
            }
            const bounds = header.getBoundingClientRect();
            const buttons = (
              Array.from(
                header.querySelectorAll("button"),
              ) as HTMLButtonElement[]
            )
              .map((button) => button.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0);
            const context = `${label}, ${width}px, scale ${scale}`;
            for (const button of Array.from(
              header.querySelectorAll(".llm-header-actions button"),
            ) as Element[]) {
              assert.closeTo(
                button.getBoundingClientRect().width,
                bounds.width <= 380 ? 24 : 28,
                0.5,
                `Action-button padding must be preserved: ${context}, ${button.id}, display=${win.getComputedStyle(button)?.display}, layout=${doc.documentElement.getAttribute(layoutAttribute)}`,
              );
            }
            for (const button of Array.from(
              header.querySelectorAll(".llm-history-new, .llm-history-toggle"),
            ) as Element[]) {
              assert.closeTo(
                button.getBoundingClientRect().width,
                bounds.width <= 380 ? 24 : 28,
                0.5,
                `History buttons keep their hit area: ${context}`,
              );
            }
            const runtimeGlyphs = (
              Array.from(
                runtime.querySelectorAll(".llm-runtime-system-toggle-icon"),
              ) as Element[]
            ).map((icon) => icon.getBoundingClientRect());
            assert.lengthOf(runtimeGlyphs, 2);
            for (const glyph of runtimeGlyphs) {
              assert.closeTo(glyph.width, 16, 0.5);
              assert.closeTo(glyph.height, 16, 0.5);
            }
            assert.isAtLeast(
              runtimeGlyphs[1].left - runtimeGlyphs[0].right,
              1.5,
              `Runtime glyphs need visible separation: ${context}`,
            );
            assert.lengthOf(
              buttons,
              11,
              `All header controls visible: ${context}`,
            );
            const toggleRowRect = toggleRow.getBoundingClientRect();
            const navRowRect = navRow.getBoundingClientRect();
            for (const [row, rowButtons] of [
              [
                toggleRow,
                Array.from(toggleRow.querySelectorAll("button")) as Element[],
              ],
              [
                navRow,
                Array.from(navRow.querySelectorAll("button")) as Element[],
              ],
            ] as const) {
              const rects = rowButtons
                .map((button) => button.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0);
              assert.isAbove(rects.length, 0, context);
              for (const rect of rects) {
                assert.closeTo(
                  (rect.top + rect.bottom) / 2,
                  (rects[0].top + rects[0].bottom) / 2,
                  0.5,
                  `Each header row must stay on one line: ${context}`,
                );
                const rowRect = row.getBoundingClientRect();
                assert.isAtLeast(rect.top, rowRect.top - 0.5, context);
                assert.isAtMost(rect.bottom, rowRect.bottom + 0.5, context);
              }
            }
            assert.isAtMost(
              toggleRowRect.bottom,
              navRowRect.top + 0.5,
              `The toggle row sits above the actions row: ${context}`,
            );
            const tabsRect = tabGroup.getBoundingClientRect();
            assert.closeTo(
              tabsRect.left + tabsRect.width / 2,
              toggleRowRect.left + toggleRowRect.width / 2,
              1,
              `The mode toggle is centered: ${context}`,
            );
            // The runtime systems follow the history button in the actions row.
            const historyRect = header
              .querySelector("#llm-history-toggle")!
              .getBoundingClientRect();
            assert.isAtLeast(
              runtimeGlyphs[0].left,
              historyRect.right,
              `Runtime systems follow history: ${context}`,
            );
            for (const [index, rect] of buttons.entries()) {
              assert.isAtLeast(rect.left, bounds.left - 0.5, context);
              assert.isAtMost(rect.right, bounds.right + 0.5, context);
              for (const other of buttons.slice(index + 1)) {
                const overlaps =
                  Math.min(rect.right, other.right) -
                    Math.max(rect.left, other.left) >
                    0.5 &&
                  Math.min(rect.bottom, other.bottom) -
                    Math.max(rect.top, other.top) >
                    0.5;
                assert.isFalse(overlaps, `Header buttons overlap: ${context}`);
              }
            }
          }
        }
      }
    } finally {
      panel.remove();
      if (previousLayout === null)
        doc.documentElement.removeAttribute(layoutAttribute);
      else doc.documentElement.setAttribute(layoutAttribute, previousLayout);
    }
  });

  it("animates the occupied sidebar width to zero when narrowing the window", async function () {
    await api.resizeStandaloneWindow(900, 650);
    const sidebar = win.document.querySelector(".llm-standalone-sidebar")!;
    const before = sidebar.getBoundingClientRect().width;
    const widths: number[] = [];
    const start = win.performance!.now();
    const sampling = (async () => {
      do {
        await waitForNativeWindowFrame(win);
        widths.push(sidebar.getBoundingClientRect().width);
      } while (win.performance!.now() - start < 600);
    })();
    await Promise.all([api.resizeStandaloneWindow(650, 650), sampling]);
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
    await waitForNativeWindowFrame(win);
    const wideAction = actionWidth();
    for (const scale of [1, 1.8]) {
      root.style.setProperty("--llm-font-scale", String(scale));
      for (const width of [700, 550, 500]) {
        await api.resizeStandaloneWindow(width, 650);
        await waitForNativeWindowFrame(win);
        const leading = rect(".llm-standalone-tab-row-leading");
        const tabs = rect(".llm-standalone-tab-row .llm-standalone-tab-group");
        assert.isAtMost(
          leading.right,
          tabs.left + 0.5,
          `Controls overlap tabs at ${width}px / scale ${scale}`,
        );
        assert.isAtMost(tabs.right, win.innerWidth);
        for (const tab of Array.from(
          doc.querySelectorAll(".llm-standalone-tab-row .llm-standalone-tab"),
        ) as HTMLElement[]) {
          assert.isAtMost(
            tab.scrollWidth,
            tab.clientWidth + 1,
            "Tab label must remain fully visible",
          );
        }
        assert.closeTo(
          actionWidth(),
          rect(".llm-standalone-icon-clear").width,
          0.01,
          "Action widths must match within subpixel DOMRect rounding",
        );
      }
    }
    await api.hoverStandaloneSidebarToggle();
    for (const tab of Array.from(
      doc.querySelectorAll(".llm-standalone-tab-row .llm-standalone-tab"),
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
