/**
 * The sidebar header's chat mode controls.
 *
 * Independent: two rows, a centered Paper chat | Library chat toggle above
 * the actions row (new chat, history, a thin divider, the runtime systems,
 * then the panel actions). Stacked: one row, with the mode chip in the
 * divider's place; on hover or keyboard focus the chip drops down into a
 * Paper chat | Library chat switch over the top of the chat. Every header
 * builds both controls and the root layout attribute picks one, so a live
 * layout change swaps them. A pick from either control navigates the way the
 * history menu does: each mode returns to the conversation it last showed.
 */
import { assert } from "chai";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import { waitForNativeWindowFrame } from "./nativeWindowReadiness";
import type {
  WorkflowTestApi,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
  WorkflowTestNoteFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

type Tab = "paper" | "library";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const LAYOUT_PREF = `${PREF_PREFIX}.sidebarLayout`;

/** Always-present icons; the conditional Task progress action is added below. */
const HEADER_BUTTONS = [
  "#llm-history-new",
  "#llm-history-toggle",
  "#llm-codex-system-toggle",
  "#llm-claude-system-toggle",
  "#llm-popout",
  "#llm-settings",
  "#llm-export",
  "#llm-clear",
];

function visibleTaskProgressControls(root: ParentNode): string[] {
  const button = root.querySelector<HTMLElement>("#llm-task-progress-toggle");
  assert.isOk(button, "the header builds its Task progress control");
  // Dedicated Task progress tests cover applicability and the compact-layout
  // visibility rule. Whenever shown here it must also clear the mode switch.
  return button!.getBoundingClientRect().width > 0
    ? ["#llm-task-progress-toggle"]
    : [];
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function getPanelRoot(panelId: string): HTMLElement {
  const doc = Zotero.getMainWindow().document;
  const root = doc.querySelector<HTMLElement>(
    `[data-workflow-panel-id="${panelId}"]`,
  );
  assert.isOk(root, "workflow panel root should be in the document");
  return root as HTMLElement;
}

function clickTab(root: HTMLElement, selector: string): void {
  const tab = root.querySelector<HTMLButtonElement>(selector);
  assert.isOk(tab, `${selector} should be rendered`);
  tab!.dispatchEvent(
    new (root.ownerDocument.defaultView as any).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function waitForKind(
  api: WorkflowTestApi,
  panelId: string,
  kind: "global" | "paper",
): Promise<WorkflowTestDiagnostics> {
  const deadline = Date.now() + 15000;
  let diagnostics = await api.getDiagnostics(panelId);
  while (diagnostics.conversationKind !== kind && Date.now() < deadline) {
    await Zotero.Promise.delay(25);
    diagnostics = await api.getDiagnostics(panelId);
  }
  assert.equal(
    diagnostics.conversationKind,
    kind,
    JSON.stringify(diagnostics, null, 2),
  );
  return diagnostics;
}

function assertActiveTab(root: HTMLElement, tab: Tab): void {
  const paperTab = root.querySelector("#llm-paper-chat-tab")!;
  const libraryTab = root.querySelector("#llm-library-chat-tab")!;
  const active = tab === "paper" ? paperTab : libraryTab;
  const inactive = tab === "paper" ? libraryTab : paperTab;
  assert.isTrue(active.classList.contains("active"), `${tab} tab is active`);
  assert.equal(active.getAttribute("aria-pressed"), "true");
  assert.isFalse(inactive.classList.contains("active"));
  assert.equal(inactive.getAttribute("aria-pressed"), "false");
}

function chipOf(root: ParentNode): HTMLElement {
  const capsule = root.querySelector<HTMLElement>("#llm-mode-capsule");
  assert.isOk(capsule, "the mode chip is built");
  return capsule!;
}

function optionOf(root: ParentNode, tab: Tab): HTMLButtonElement {
  const option = root.querySelector<HTMLButtonElement>(
    `#llm-mode-option-${tab}`,
  );
  assert.isOk(option, `the chip's ${tab} option is built`);
  return option!;
}

function optionLabel(option: HTMLElement): string {
  return (
    option.querySelector(".llm-mode-switch-label")?.textContent || ""
  ).trim();
}

/** The chip and the hidden tabs both show `tab`. */
function assertChipShows(root: ParentNode, tab: Tab): void {
  const other: Tab = tab === "paper" ? "library" : "paper";
  assert.equal(chipOf(root).dataset.mode, tab, `the chip shows ${tab}`);
  assert.equal(optionOf(root, tab).getAttribute("aria-pressed"), "true");
  assert.equal(optionOf(root, other).getAttribute("aria-pressed"), "false");
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  );
}

/** Long enough for the switch's 300 ms motion to finish. */
const settleMotion = () => Zotero.Promise.delay(450);

describe("workflow: sidebar chat mode toggle", function () {
  this.timeout(90000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  describe("in the native item pane", function () {
    const runtimePrefs = [
      `${PREF_PREFIX}.enableCodexAppServerMode`,
      `${PREF_PREFIX}.enableClaudeCodeMode`,
    ];
    const themePref = "browser.theme.toolbar-theme";
    const savedPrefs = new Map<string, unknown>();
    const shots: string[] = [];
    let win: any;

    before(function () {
      win = Zotero.getMainWindow();
      for (const key of [LAYOUT_PREF, themePref, ...runtimePrefs]) {
        savedPrefs.set(key, Zotero.Prefs.get(key, true));
      }
      for (const key of runtimePrefs) Zotero.Prefs.set(key, true, true);
    });

    after(function () {
      for (const [key, value] of savedPrefs) {
        if (value === undefined) Zotero.Prefs.clear?.(key, true);
        else Zotero.Prefs.set(key, value as never, true);
      }
      if (shots.length) {
        Zotero.debug(`SIDEBAR_HEADER_SCREENSHOTS ${JSON.stringify(shots)}`, 1);
      }
    });

    async function until(check: () => boolean, message: string) {
      const deadline = Date.now() + 10000;
      while (!check() && Date.now() < deadline) {
        await Zotero.Promise.delay(50);
      }
      assert.isTrue(check(), message);
    }

    function activeDetails(): any {
      const readerPane = getReaderContextPanelForTab(
        win.document,
        win.Zotero_Tabs.selectedID,
      );
      if (readerPane) return readerPane;
      return Array.from(win.document.querySelectorAll("item-details")).find(
        (node: any) =>
          node.tabType === "library" && node.getBoundingClientRect().width > 0,
      );
    }

    /** Select the fixture and open its chat in the given layout. */
    async function openChat(
      layout: "independent" | "stacked",
      itemId: number,
    ): Promise<HTMLElement> {
      Zotero.Prefs.set(LAYOUT_PREF, layout, true);
      const view = layout === "independent" ? "chat" : "stacked";
      await win.ZoteroPane.selectItem(itemId);
      const details = activeDetails();
      assert.isOk(details, "native item details is visible");
      const section = () =>
        details.querySelector(".llm-dedicated-chat-pane") as HTMLElement;
      const mainVisible = () =>
        (section()?.querySelector("#llm-main")?.getBoundingClientRect()
          .height || 0) > 0;
      if (
        win.document.documentElement.getAttribute("data-llm-pane-view") !==
          view ||
        details.sidenav._collapsed ||
        !mainVisible()
      ) {
        const paneID = section()?.dataset.pane;
        const button: any = Array.from(
          details.sidenav.querySelectorAll("[data-pane]"),
        ).find((node: any) => node.getAttribute("data-pane") === paneID);
        assert.isOk(button, "the plugin's rail icon exists");
        button.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
        );
      }
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
            view &&
          !details.sidenav._collapsed &&
          mainVisible(),
        `${layout} chat is open and visible`,
      );
      if (layout === "stacked") {
        section().scrollIntoView?.();
      }
      const root = section().querySelector("#llm-main") as HTMLElement;
      await until(
        () =>
          root.dataset.conversationKind === "paper" &&
          root.dataset.basePaperItemId === String(itemId),
        "the chat shows the selected paper",
      );
      return section();
    }

    async function switchLayout(layout: "independent" | "stacked") {
      Zotero.Prefs.set(LAYOUT_PREF, layout, true);
      await until(
        () =>
          win.document.documentElement.getAttribute(
            "data-llm-sidebar-layout",
          ) === layout,
        `${layout} layout applies`,
      );
    }

    /** A native mouse move: real hover, :hover and pointer events. */
    function movePointer(x: number, y: number) {
      win.windowUtils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
    }

    function hover(element: Element) {
      const rect = element.getBoundingClientRect();
      movePointer(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    /** A native press and release: the browser makes the click. */
    function clickOn(element: Element) {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      win.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      win.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    }

    /** Rest the pointer on the chat, well clear of the chip's column. */
    function parkPointer(section: HTMLElement) {
      const box = section
        .querySelector("#llm-chat-box")!
        .getBoundingClientRect();
      movePointer(
        box.left + box.width * 0.85,
        box.top + Math.min(box.height - 8, 140),
      );
    }

    /** Park the pointer and let any open switch close and settle. */
    async function restPointer(section: HTMLElement) {
      parkPointer(section);
      await until(
        () => chipOf(section).dataset.expanded !== "true",
        "the chip comes to rest",
      );
      await settleMotion();
    }

    function key(target: Element, name: string) {
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: name,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    function assertChipHidden(section: HTMLElement): void {
      const capsule = chipOf(section);
      assert.equal(
        win.getComputedStyle(capsule).display,
        "none",
        "Independent shows no chip",
      );
      assert.equal(capsule.getBoundingClientRect().width, 0);
    }

    function assertToggleAndActionRows(section: HTMLElement): void {
      const view = win as Window;
      const toggleRow = section.querySelector<HTMLElement>(
        ".llm-header-toggle-row",
      );
      const navRow = section.querySelector<HTMLElement>(".llm-header-nav-row");
      assert.isOk(toggleRow, "the toggle row is rendered");
      assert.isOk(navRow, "the actions row is rendered");
      const toggleRect = toggleRow!.getBoundingClientRect();
      const navRect = navRow!.getBoundingClientRect();
      assert.isAbove(toggleRect.height, 0, "the toggle row is visible");
      assert.isAtMost(
        toggleRect.bottom,
        navRect.top + 0.5,
        "the toggle row sits above the actions row",
      );
      const toggleStyle = view.getComputedStyle(toggleRow!)!;
      assert.equal(
        toggleStyle.borderBottomStyle,
        "none",
        "the toggle row has no divider",
      );
      assert.equal(
        view.getComputedStyle(navRow!)!.borderBottomStyle,
        "none",
        "no divider under the actions row",
      );

      // The standalone window's wording.
      const paperTab = toggleRow!.querySelector<HTMLElement>(
        "#llm-paper-chat-tab",
      )!;
      const libraryTab = toggleRow!.querySelector<HTMLElement>(
        "#llm-library-chat-tab",
      )!;
      assert.equal(paperTab.textContent!.trim(), "Paper chat");
      assert.equal(libraryTab.textContent!.trim(), "Library chat");
      const tabsRect = toggleRow!
        .querySelector(".llm-header-mode-tabs")!
        .getBoundingClientRect();
      assert.closeTo(
        tabsRect.left + tabsRect.width / 2,
        toggleRect.left + toggleRect.width / 2,
        1,
        "the toggle is centered",
      );
      assert.closeTo(
        paperTab.getBoundingClientRect().width,
        libraryTab.getBoundingClientRect().width,
        12,
        "the two tabs are balanced",
      );
      for (const tab of [paperTab, libraryTab]) {
        assert.isAtLeast(tab.getBoundingClientRect().width, 63.5);
      }

      // New chat, history, divider, Codex, Claude; then the panel actions.
      const order = [
        "#llm-history-new",
        "#llm-history-toggle",
        ".llm-header-runtime-divider",
        "#llm-codex-system-toggle",
        "#llm-claude-system-toggle",
        ...visibleTaskProgressControls(section),
        "#llm-popout",
        "#llm-settings",
        "#llm-export",
        "#llm-clear",
      ].map((selector) => {
        const element = navRow!.querySelector<HTMLElement>(selector);
        assert.isOk(element, `${selector} sits in the actions row`);
        const rect = element!.getBoundingClientRect();
        assert.isAbove(rect.width, 0, `${selector} is visible`);
        return { selector, rect };
      });
      // Centers, not edges: the compact actions overlap their hit areas by
      // design (negative margins below the 380px container breakpoint).
      const center = (rect: DOMRect) => rect.left + rect.width / 2;
      for (let index = 1; index < order.length; index += 1) {
        assert.isAbove(
          center(order[index].rect),
          center(order[index - 1].rect),
          `${order[index].selector} follows ${order[index - 1].selector}`,
        );
      }
      assert.isAtLeast(
        order[2].rect.left,
        order[1].rect.right,
        "the divider clears the history button",
      );
      assert.isAtLeast(
        order[3].rect.left,
        order[2].rect.right,
        "the runtime systems clear the divider",
      );
      const divider = order[2].rect;
      assert.closeTo(divider.width, 1, 0.5, "the divider is a thin rule");
      assert.closeTo(divider.height, 16, 0.5);
      for (const { selector, rect } of order) {
        if (selector === ".llm-header-runtime-divider") continue;
        assert.closeTo(
          rect.top + rect.height / 2,
          order[0].rect.top + order[0].rect.height / 2,
          0.5,
          `${selector} shares the actions row's line`,
        );
      }
      assertChipHidden(section);
      assert.isNull(section.querySelector(".llm-header-mode-row"));
      // No docked title row: the toggle opens the header.
      assert.isNull(section.querySelector(".llm-docked-title-row"));
      const panelTop = section
        .querySelector(".llm-panel")!
        .getBoundingClientRect().top;
      assert.isAtMost(
        toggleRect.top - panelTop,
        12,
        "the toggle row leads the header",
      );
    }

    /** Stacked: one row, + · history · chip · Codex · Claude | actions. */
    function assertStackedRow(section: HTMLElement): void {
      const view = win as Window;
      const toggleRow = section.querySelector<HTMLElement>(
        ".llm-header-toggle-row",
      )!;
      assert.equal(
        view.getComputedStyle(toggleRow)!.display,
        "none",
        "Stacked has no toggle row",
      );
      assert.equal(toggleRow.getBoundingClientRect().height, 0);
      const navRow = section.querySelector<HTMLElement>(".llm-header-nav-row")!;
      const capsule = chipOf(section);
      assert.isTrue(navRow.contains(capsule), "the chip is in the actions row");
      const chipRect = capsule.getBoundingClientRect();
      assert.isAbove(chipRect.width, 0, "Stacked shows the chip");
      assert.closeTo(chipRect.height, 22, 0.5);
      assert.equal(
        section
          .querySelector(".llm-header-runtime-divider")!
          .getBoundingClientRect().width,
        0,
        "the chip takes the divider's place",
      );
      const order = [
        "#llm-history-new",
        "#llm-history-toggle",
        "#llm-mode-capsule",
        "#llm-codex-system-toggle",
        "#llm-claude-system-toggle",
        ...visibleTaskProgressControls(section),
        "#llm-popout",
        "#llm-settings",
        "#llm-export",
        "#llm-clear",
      ].map((selector) => {
        const element = navRow.querySelector<HTMLElement>(selector);
        assert.isOk(element, `${selector} sits in the one header row`);
        const rect = element!.getBoundingClientRect();
        assert.isAbove(rect.width, 0, `${selector} is visible`);
        return { selector, rect };
      });
      const center = (rect: DOMRect) => rect.left + rect.width / 2;
      for (let index = 1; index < order.length; index += 1) {
        assert.isAbove(
          center(order[index].rect),
          center(order[index - 1].rect),
          `${order[index].selector} follows ${order[index - 1].selector}`,
        );
        assert.closeTo(
          order[index].rect.top + order[index].rect.height / 2,
          order[0].rect.top + order[0].rect.height / 2,
          0.5,
          `${order[index].selector} shares the row's line`,
        );
      }
      // 4px between history and the chip, and between the chip and Codex.
      const [, history, chip, codex] = order.map((entry) => entry.rect);
      assert.closeTo(chip.left - history.right, 4, 0.6, "history to chip");
      const compression = Number(
        navRow.style.getPropertyValue("--llm-runtime-compression") || 0,
      );
      if (compression === 0) {
        assert.closeTo(codex.left - chip.right, 4, 0.6, "chip to Codex");
      }
      for (const selector of [
        ...HEADER_BUTTONS,
        ...visibleTaskProgressControls(section),
      ]) {
        const rect = section.querySelector(selector)!.getBoundingClientRect();
        assert.isFalse(
          intersects(rect, chipRect),
          `${selector} stays clear of the chip`,
        );
      }
      assert.equal(view.getComputedStyle(navRow)!.borderBottomStyle, "none");
      assert.isNull(section.querySelector(".llm-docked-title-row"));
      const panelTop = section
        .querySelector(".llm-panel")!
        .getBoundingClientRect().top;
      assert.isAtMost(
        navRow.getBoundingClientRect().top - panelTop,
        12,
        "the one row leads the header",
      );
    }

    /** The open switch: down from the chip, in its column, over the chat. */
    async function assertOpenSwitch(
      section: HTMLElement,
      rows: [Tab, Tab],
    ): Promise<void> {
      await waitForNativeWindowFrame(win);
      await until(() => {
        const capsule = chipOf(section);
        const track = capsule.querySelector(".llm-mode-switch-track")!;
        return (
          capsule.dataset.expanded === "true" &&
          Math.abs(track.getBoundingClientRect().height - 52) <= 0.5
        );
      }, "the open switch reaches its two-row height");
      const capsule = chipOf(section);
      assert.equal(capsule.dataset.expanded, "true", "the switch is open");
      const chipRect = capsule.getBoundingClientRect();
      const track = capsule
        .querySelector(".llm-mode-switch-track")!
        .getBoundingClientRect();
      assert.closeTo(track.top, chipRect.top, 0.5, "it opens from the chip");
      assert.closeTo(track.height, 52, 0.5, "and drops two rows down");
      assert.closeTo(track.left, chipRect.left, 0.5, "inside the chip's");
      assert.closeTo(track.right, chipRect.right, 0.5, "own column");
      const navRow = section
        .querySelector(".llm-header-nav-row")!
        .getBoundingClientRect();
      assert.isAbove(track.bottom, navRow.bottom, "it reaches over the chat");
      for (const selector of [
        ...HEADER_BUTTONS,
        ...visibleTaskProgressControls(section),
      ]) {
        const rect = section.querySelector(selector)!.getBoundingClientRect();
        assert.isAbove(rect.width, 0, `${selector} is visible`);
        assert.isFalse(
          intersects(rect, track),
          `${selector} stays clear of the open switch`,
        );
      }
      // The current mode keeps the chip's place; the other is beneath it.
      const [upper, lower] = rows;
      assert.closeTo(
        optionOf(section, upper).getBoundingClientRect().top,
        chipRect.top + 3,
        0.5,
        `${upper} is the upper row`,
      );
      assert.closeTo(
        optionOf(section, lower).getBoundingClientRect().top,
        chipRect.top + 27,
        0.5,
        `${lower} is the lower row`,
      );
      // It floats over the top of the chat: the lower row is what the
      // pointer finds there.
      const lowerRect = optionOf(section, lower).getBoundingClientRect();
      const hit = win.document.elementFromPoint(
        lowerRect.left + lowerRect.width / 2,
        lowerRect.top + lowerRect.height / 2,
      );
      assert.isTrue(
        optionOf(section, lower).contains(hit),
        `the lower row paints over the chat (hit ${hit?.className})`,
      );
    }

    /** The pill sits on `tab`'s row. */
    function assertPillOn(section: HTMLElement, tab: Tab): void {
      const thumb = chipOf(section)
        .querySelector(".llm-mode-switch-thumb")!
        .getBoundingClientRect();
      assert.closeTo(
        thumb.top,
        optionOf(section, tab).getBoundingClientRect().top,
        0.5,
        `the pill is on ${tab}`,
      );
    }

    /** At rest: the chosen mode fills the chip; the other is out of sight. */
    async function assertChipAtRest(
      section: HTMLElement,
      tab: Tab,
    ): Promise<void> {
      const capsule = chipOf(section);
      const other: Tab = tab === "paper" ? "library" : "paper";
      // Conversation selection can update before the chip's async state sync
      // and CSS transition finish. Wait for the observable rest state rather
      // than treating a fixed sleep as proof that those operations completed.
      await until(() => {
        const chip = capsule.getBoundingClientRect();
        const selected = optionOf(section, tab);
        const bounds = selected.getBoundingClientRect();
        const track = capsule.querySelector(".llm-mode-switch-track")!;
        return (
          capsule.dataset.mode === tab &&
          selected.getAttribute("aria-pressed") === "true" &&
          capsule.dataset.expanded === "false" &&
          chip.width > 0 &&
          Math.abs(bounds.top - chip.top) <= 0.5 &&
          Math.abs(bounds.width - chip.width) <= 0.5 &&
          win.getComputedStyle(optionOf(section, other)).opacity === "0" &&
          win.getComputedStyle(track).opacity === "0"
        );
      }, `${tab} chip reaches its closed, selected position`);
      assert.equal(capsule.dataset.expanded, "false");
      const chipRect = capsule.getBoundingClientRect();
      const shown = optionOf(section, tab).getBoundingClientRect();
      assert.closeTo(shown.top, chipRect.top, 0.5, `${tab} fills the chip`);
      assert.closeTo(shown.width, chipRect.width, 0.5);
      assert.equal(
        win.getComputedStyle(optionOf(section, other)).opacity,
        "0",
        `${other} is out of sight`,
      );
      const track = capsule.querySelector(".llm-mode-switch-track")!;
      assert.equal(win.getComputedStyle(track).opacity, "0");
      assertChipShows(section, tab);
    }

    it("keeps two rows in the independent pane and follows Paper chat | Library chat", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Independent Paper",
        pdfTitle: "Sidebar Header Independent PDF",
      });
      const section = await openChat("independent", fixture.parentItemId);
      const root = section.querySelector("#llm-main") as HTMLElement;
      assertToggleAndActionRows(section);
      const navRow = section.querySelector(".llm-header-nav-row")!;
      assert.closeTo(
        navRow.getBoundingClientRect().width,
        root.getBoundingClientRect().width,
        0.5,
        "the header divider spans the whole panel",
      );

      clickTab(root, "#llm-library-chat-tab");
      await until(
        () => root.dataset.conversationKind === "global",
        "Library chat opens",
      );
      assertActiveTab(root, "library");
      // The hidden chip follows too, ready for a switch to Stacked.
      assertChipShows(section, "library");
      assertToggleAndActionRows(section);

      clickTab(root, "#llm-paper-chat-tab");
      await until(
        () => root.dataset.conversationKind === "paper",
        "Paper chat returns",
      );
      assertActiveTab(root, "paper");
      assertChipShows(section, "paper");
    });

    it("shows one row with the mode chip when stacked", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Stacked Paper",
        pdfTitle: "Sidebar Header Stacked PDF",
      });
      const section = await openChat("stacked", fixture.parentItemId);
      await restPointer(section);
      assertStackedRow(section);
      await assertChipAtRest(section, "paper");
      assert.equal(optionLabel(optionOf(section, "paper")), "Paper chat");
      assert.equal(optionLabel(optionOf(section, "library")), "Library chat");
    });

    it("swaps the toggle row and the chip on a live layout change, keeping the mode", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Layout Swap Paper",
        pdfTitle: "Sidebar Header Layout Swap PDF",
      });
      const section = await openChat("independent", fixture.parentItemId);
      const root = section.querySelector("#llm-main") as HTMLElement;
      assertToggleAndActionRows(section);

      clickTab(root, "#llm-library-chat-tab");
      await until(
        () => root.dataset.conversationKind === "global",
        "Library chat opens from the tab",
      );
      const libraryKey = root.dataset.itemId;

      // The same mounted panel: the chip appears already on Library chat.
      await switchLayout("stacked");
      await until(
        () => chipOf(section).getBoundingClientRect().width > 0,
        "the stacked header shows the chip",
      );
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        "a layout change does not rebuild the panel",
      );
      section.scrollIntoView?.();
      await restPointer(section);
      assertStackedRow(section);
      await assertChipAtRest(section, "library");
      assert.equal(root.dataset.itemId, libraryKey);

      // A click with no hover (as on touch) toggles the chip.
      clickTab(root, "#llm-mode-option-library");
      await until(
        () => root.dataset.conversationKind === "paper",
        "the chip toggles to Paper chat",
      );
      await settleMotion();
      await assertChipAtRest(section, "paper");
      assertActiveTab(root, "paper");

      // Back to Independent: the tabs already show Paper chat.
      await switchLayout("independent");
      await until(
        () =>
          (section
            .querySelector(".llm-header-toggle-row")
            ?.getBoundingClientRect().height || 0) > 0,
        "the independent header shows the toggle row",
      );
      assertToggleAndActionRows(section);
      assertActiveTab(root, "paper");
      assertChipShows(section, "paper");
    });

    it("opens the stacked chip downward on hover, clear of every header icon, and picks through the tabs' path", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Hover Switch Paper",
        pdfTitle: "Sidebar Header Hover Switch PDF",
      });
      const section = await openChat("stacked", fixture.parentItemId);
      const root = section.querySelector("#llm-main") as HTMLElement;
      const capsule = chipOf(section);
      await restPointer(section);
      await assertChipAtRest(section, "paper");
      const paperKey = root.dataset.itemId;
      const restWidth = capsule.getBoundingClientRect().width;

      // Hover: the track drops down, Paper chat in the chip's place.
      hover(optionOf(section, "paper"));
      await until(
        () => capsule.dataset.expanded === "true",
        "hover opens the switch",
      );
      assert.isTrue(capsule.matches(":hover"), "a real hover");
      await settleMotion();
      await assertOpenSwitch(section, ["paper", "library"]);
      assertPillOn(section, "paper");
      assert.closeTo(
        capsule.getBoundingClientRect().width,
        restWidth,
        0.5,
        "opening does not resize the chip",
      );

      // Click the other option: the tabs' path opens Library chat; the pill
      // follows while the rows stay where they are in the switch.
      const library = optionOf(section, "library");
      const rowOffset = () => {
        const row = library.getBoundingClientRect();
        const chip = capsule.getBoundingClientRect();
        return { top: row.top - chip.top, left: row.left - chip.left };
      };
      const libraryRow = rowOffset();
      clickOn(library);
      await until(
        () => root.dataset.conversationKind === "global",
        "Library chat opens from the chip",
      );
      const libraryKey = root.dataset.itemId;
      assert.notEqual(libraryKey, paperKey);
      assertActiveTab(root, "library");
      assert.equal(
        capsule.dataset.expanded,
        "true",
        "the switch stays open under the pointer",
      );
      await settleMotion();
      await assertOpenSwitch(section, ["paper", "library"]);
      assertPillOn(section, "library");
      // Measured against the chip: the Stacked pane itself may scroll while
      // the conversation changes.
      assert.closeTo(rowOffset().top, libraryRow.top, 0.5, "the row stays");
      assert.closeTo(rowOffset().left, libraryRow.left, 0.5);

      // Leave: a 160 ms grace, then Library chat rises into the chip.
      const leftAt = Date.now();
      parkPointer(section);
      assert.equal(capsule.dataset.expanded, "true", "the grace period holds");
      await until(
        () => capsule.dataset.expanded === "false",
        "the switch closes after its grace period",
      );
      assert.isAtLeast(Date.now() - leftAt, 155, "not before the grace ends");
      await settleMotion();
      await assertChipAtRest(section, "library");
      assert.closeTo(
        capsule.getBoundingClientRect().width,
        restWidth,
        0.5,
        "one chip width in both modes",
      );

      // And back the same way: each mode returns to its own conversation.
      hover(optionOf(section, "library"));
      await until(() => capsule.dataset.expanded === "true", "hover reopens");
      await settleMotion();
      await assertOpenSwitch(section, ["library", "paper"]);
      clickOn(optionOf(section, "paper"));
      await until(
        () => root.dataset.conversationKind === "paper",
        "Paper chat returns from the chip",
      );
      assert.equal(
        root.dataset.itemId,
        paperKey,
        "Paper chat returns to the paper's remembered conversation",
      );
      assertActiveTab(root, "paper");
      await restPointer(section);
      hover(optionOf(section, "paper"));
      await until(() => capsule.dataset.expanded === "true", "hover reopens");
      await settleMotion();
      await assertOpenSwitch(section, ["paper", "library"]);
      clickOn(optionOf(section, "library"));
      await until(
        () => root.dataset.conversationKind === "global",
        "Library chat opens again",
      );
      assert.equal(
        root.dataset.itemId,
        libraryKey,
        "Library chat returns to the remembered library conversation",
      );
      parkPointer(section);
      await until(
        () => capsule.dataset.expanded === "false",
        "the switch closes",
      );
      await settleMotion();
      await assertChipAtRest(section, "library");
    });

    it("drives the stacked chip from the keyboard", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Keyboard Paper",
        pdfTitle: "Sidebar Header Keyboard PDF",
      });
      const section = await openChat("stacked", fixture.parentItemId);
      const root = section.querySelector("#llm-main") as HTMLElement;
      const capsule = chipOf(section);
      const paper = optionOf(section, "paper");
      const library = optionOf(section, "library");
      const input = section.querySelector("#llm-input") as HTMLElement;
      // The switch path focuses the composer when it starts a new Library
      // chat (the tabs do the same). Start that chat first, so the keys below
      // move between remembered conversations and focus stays on the chip.
      clickTab(root, "#llm-library-chat-tab");
      await until(
        () => root.dataset.conversationKind === "global",
        "a Library chat exists",
      );
      clickTab(root, "#llm-paper-chat-tab");
      await until(
        () => root.dataset.conversationKind === "paper",
        "back in Paper chat",
      );
      // Gecko fires focus events only in the active window, and a test window
      // behind another app cannot take activation on macOS. The focus
      // manager's test mode lets win.focus() raise it the way a click would.
      const testModePref = "focusmanager.testmode";
      const savedTestMode = Zotero.Prefs.get(testModePref, true);
      Zotero.Prefs.set(testModePref, true, true);
      try {
        win.focus();
        await until(() => win.document.hasFocus(), "the window takes focus");
        await restPointer(section);
        input.focus();
        await driveFromKeyboard();
      } finally {
        input.blur();
        if (savedTestMode === undefined) Zotero.Prefs.clear(testModePref, true);
        else Zotero.Prefs.set(testModePref, savedTestMode as never, true);
      }

      async function driveFromKeyboard() {
        assert.equal(paper.tabIndex, 0, "the chip is a tab stop");
        assert.equal(library.tabIndex, -1, "the hidden row is not, closed");

        // Tab to the chip: keyboard focus opens it.
        paper.focus({ focusVisible: true });
        assert.strictEqual(win.document.activeElement, paper);
        assert.equal(
          capsule.dataset.expanded,
          "true",
          `keyboard focus opens (:focus-visible ${paper.matches(":focus-visible")})`,
        );
        assert.equal(library.tabIndex, 0, "open, both rows are tab stops");

        key(paper, "Escape");
        assert.equal(capsule.dataset.expanded, "false", "Escape closes");
        assert.strictEqual(win.document.activeElement, paper, "focus stays");

        key(paper, "ArrowDown");
        assert.equal(capsule.dataset.expanded, "true", "Down opens");
        assert.equal(
          root.dataset.conversationKind,
          "paper",
          "and picks nothing",
        );
        await settleMotion();
        await assertOpenSwitch(section, ["paper", "library"]);

        key(paper, "ArrowDown");
        await until(
          () => root.dataset.conversationKind === "global",
          "Down picks Library chat",
        );
        assert.strictEqual(
          win.document.activeElement,
          library,
          "focus follows",
        );
        assertActiveTab(root, "library");
        await settleMotion();
        await assertOpenSwitch(section, ["paper", "library"]);
        assertPillOn(section, "library");

        key(library, "ArrowUp");
        await until(
          () => root.dataset.conversationKind === "paper",
          "Up picks Paper chat",
        );
        assert.strictEqual(win.document.activeElement, paper);
        assertActiveTab(root, "paper");

        key(paper, "Escape");
        assert.equal(capsule.dataset.expanded, "false");
        await settleMotion();
        await assertChipAtRest(section, "paper");

        // Moving focus away closes it too.
        input.focus();
        paper.focus({ focusVisible: true });
        assert.equal(capsule.dataset.expanded, "true");
        input.focus();
        assert.equal(capsule.dataset.expanded, "false", "focus leaving closes");
      }
    });

    it("captures the header in both layouts and themes", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Screenshot Paper",
        pdfTitle: "Sidebar Header Screenshot PDF",
      });

      async function useTheme(theme: "dark" | "light") {
        Zotero.Prefs.set(themePref, theme === "dark" ? 0 : 1, true);
        await until(
          () =>
            win.matchMedia("(prefers-color-scheme: light)").matches ===
            (theme === "light"),
          `the ${theme} theme applies`,
        );
        await Zotero.Promise.delay(150);
      }

      /** The top of the item pane: the header and the start of the chat. */
      async function capture(filename: string) {
        await settleMotion();
        const pane = win.document
          .getElementById("zotero-item-pane")!
          .getBoundingClientRect();
        const width = Math.floor(pane.width);
        const height = Math.floor(Math.min(pane.height, 380));
        const canvas = win.document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "canvas",
        );
        const scale = win.devicePixelRatio || 1;
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        const context = canvas.getContext("2d");
        context.scale(scale, scale);
        context.drawWindow(win, pane.left, pane.top, width, height, "#ffffff");
        const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
        const path = PathUtils.join(Zotero.DataDirectory.dir, filename);
        await win.IOUtils.write(
          path,
          Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
        );
        shots.push(path);
      }

      for (const theme of ["dark", "light"] as const) {
        await useTheme(theme);
        const section = await openChat("stacked", fixture.parentItemId);
        await restPointer(section);
        await assertChipAtRest(section, "paper");
        await capture(`header-stacked-rest-${theme}.png`);
        hover(optionOf(section, "paper"));
        await until(
          () => chipOf(section).dataset.expanded === "true",
          "hover opens the switch",
        );
        await settleMotion();
        await assertOpenSwitch(section, ["paper", "library"]);
        await capture(`header-stacked-open-${theme}.png`);
        parkPointer(section);
        await until(
          () => chipOf(section).dataset.expanded === "false",
          "the switch closes",
        );
        if (theme === "dark") {
          const independent = await openChat(
            "independent",
            fixture.parentItemId,
          );
          parkPointer(independent);
          assertToggleAndActionRows(independent);
          await capture(`header-independent-${theme}.png`);
        }
      }
    });
  });

  it("switches Library chat and Paper chat through the header toggle", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Sidebar Mode Toggle Switch",
      pdfTitle: "Sidebar Mode Toggle Switch PDF",
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const root = getPanelRoot(panel.panelId);
    const initial = await waitForKind(api, panel.panelId, "paper");
    assertActiveTab(root, "paper");

    // The active tab is a no-op.
    clickTab(root, "#llm-paper-chat-tab");
    await Zotero.Promise.delay(300);
    const unchanged = await api.getDiagnostics(panel.panelId);
    assert.equal(unchanged.conversationKind, "paper");
    assert.equal(unchanged.conversationKey, initial.conversationKey);

    clickTab(root, "#llm-library-chat-tab");
    const library = await waitForKind(api, panel.panelId, "global");
    assert.notEqual(library.conversationKey, initial.conversationKey);
    assertActiveTab(root, "library");

    clickTab(root, "#llm-paper-chat-tab");
    const paper = await waitForKind(api, panel.panelId, "paper");
    assert.equal(
      paper.conversationKey,
      initial.conversationKey,
      "Paper chat returns to the paper's remembered conversation",
    );
    assertActiveTab(root, "paper");

    clickTab(root, "#llm-library-chat-tab");
    const libraryAgain = await waitForKind(api, panel.panelId, "global");
    assert.equal(
      libraryAgain.conversationKey,
      library.conversationKey,
      "Library chat returns to the remembered library conversation",
    );
    assertActiveTab(root, "library");
  });

  /**
   * Note sessions and WebChat hold the chip static: it shows their label (a
   * site with its connection dot for WebChat), keeps the chip's one width,
   * and nothing opens its switch.
   */
  describe("static chips", function () {
    const API_MODEL_ENTRY_ID = "workflow-chip-api-model";
    const WEBCHAT_MODEL_ENTRY_ID = "workflow-chip-webchat-model";
    const prefs: Record<string, unknown> = {
      sidebarLayout: "stacked",
      enableAgentMode: false,
      enableCodexAppServerMode: false,
      enableClaudeCodeMode: false,
      conversationSystem: "upstream",
      modelProviderGroups: JSON.stringify([
        {
          id: "workflow-chip-api-provider",
          authMode: "api_key",
          apiBase: "http://localhost:1234/v1",
          apiKey: "",
          providerProtocol: "openai_chat_compat",
          presetIdOverride: "customized",
          models: [
            {
              id: API_MODEL_ENTRY_ID,
              model: "local-model",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
        {
          id: "workflow-chip-webchat-provider",
          apiBase: "",
          apiKey: "",
          authMode: "webchat",
          providerProtocol: "web_sync",
          models: [
            {
              id: WEBCHAT_MODEL_ENTRY_ID,
              model: "chatgpt.com",
              temperature: 0.7,
              maxTokens: 4096,
            },
          ],
        },
      ]),
      modelProviderGroupsMigrationVersion: 3,
      lastUsedModelEntryId: API_MODEL_ENTRY_ID,
    };
    const saved = new Map<string, unknown>();
    let note: WorkflowTestNoteFixture | null = null;

    before(function () {
      for (const [key, value] of Object.entries(prefs)) {
        const fullKey = `${PREF_PREFIX}.${key}`;
        saved.set(fullKey, Zotero.Prefs.get(fullKey, true));
        Zotero.Prefs.set(fullKey, value as never, true);
      }
    });

    after(function () {
      for (const [fullKey, value] of saved) {
        if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
        else Zotero.Prefs.set(fullKey, value as never, true);
      }
    });

    afterEach(async function () {
      if (note) await api.cleanupFixture(note);
      note = null;
    });

    /** Everything that opens a live chip, tried on a static one. */
    function tryToOpen(root: HTMLElement): void {
      const view = root.ownerDocument.defaultView as any;
      const capsule = chipOf(root);
      capsule.dispatchEvent(
        new view.PointerEvent("pointerenter", { pointerType: "mouse" }),
      );
      for (const tab of ["paper", "library"] as const) {
        optionOf(root, tab).focus({ focusVisible: true });
      }
      capsule.dispatchEvent(
        new view.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      optionOf(root, "paper").dispatchEvent(
        new view.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    }

    function assertStatic(root: HTMLElement, label: string): void {
      const capsule = chipOf(root);
      assert.isAbove(
        capsule.getBoundingClientRect().width,
        0,
        "Stacked shows the chip",
      );
      assert.equal(capsule.dataset.static, "true");
      assert.equal(optionLabel(optionOf(root, "paper")), label);
      for (const tab of ["paper", "library"] as const) {
        assert.isTrue(optionOf(root, tab).disabled, `${tab} is static`);
      }
      tryToOpen(root);
      assert.equal(capsule.dataset.expanded, "false", "nothing opens it");
      assertChipShows(root, "paper");
    }

    /** One width in every state, wide enough for the label it shows. */
    function assertFits(root: HTMLElement, normalWidth: number): void {
      const chip = chipOf(root).getBoundingClientRect();
      assert.closeTo(chip.width, normalWidth, 0.5, "the chip keeps its width");
      const option = optionOf(root, "paper");
      const content = Array.from(option.children) as HTMLElement[];
      const left = Math.min(
        ...content.map((child) => child.getBoundingClientRect().left),
      );
      const right = Math.max(
        ...content.map((child) => child.getBoundingClientRect().right),
      );
      assert.isAtLeast(left, chip.left + 8.5, "the label fits on the left");
      assert.isAtMost(right, chip.right - 8.5, "and on the right");
    }

    /** The chip's width on a paper's own panel, at the same font scale. */
    async function normalChipWidth(paperItemId: number): Promise<number> {
      const paper = await api.renderPanelForItem(paperItemId);
      const root = getPanelRoot(paper.panelId);
      await waitForKind(api, paper.panelId, "paper");
      assert.equal(chipOf(root).dataset.static, "false");
      const width = chipOf(root).getBoundingClientRect().width;
      assert.isAbove(width, 0, "Stacked shows the paper panel's chip");
      return width;
    }

    it("keeps a note session's chip static", async function () {
      note = await api.createItemNoteFixture({
        title: "Sidebar Chip Note Parent",
        pdfTitle: "Sidebar Chip Note PDF",
        noteHtml: "<p>A note for the static chip.</p>",
      });
      const width = await normalChipWidth(note.parentItemId);
      const panel = await api.renderPanelForItem(note.noteItemId);
      const root = getPanelRoot(panel.panelId);
      const before = await api.getDiagnostics(panel.panelId);
      assertStatic(root, "Note chat");
      assertFits(root, width);
      await Zotero.Promise.delay(300);
      const after = await api.getDiagnostics(panel.panelId);
      assert.equal(after.conversationKey, before.conversationKey);
      assert.equal(after.conversationKind, before.conversationKind);
    });

    it("keeps the WebChat chip static, showing its site and connection dot", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Chip WebChat Parent",
        pdfTitle: "Sidebar Chip WebChat PDF",
      });
      const width = await normalChipWidth(fixture.parentItemId);
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const root = getPanelRoot(panel.panelId);
      const entered = await api.selectPanelModelEntry(
        panel.panelId,
        WEBCHAT_MODEL_ENTRY_ID,
      );
      assert.isTrue(entered.webChatMode, "the panel is in WebChat");
      assertStatic(root, "chatgpt");
      assert.isOk(
        optionOf(root, "paper").querySelector(".llm-webchat-dot"),
        "the site shows its connection dot",
      );
      assert.include(optionOf(root, "paper").title, "chatgpt.com");
      assertFits(root, width);
      await Zotero.Promise.delay(300);
      const still = await api.getDiagnostics(panel.panelId);
      assert.isTrue(still.webChatMode);
      assert.equal(still.conversationKey, entered.conversationKey);

      // Leaving WebChat restores the live chip.
      const left = await api.selectPanelModelEntry(
        panel.panelId,
        API_MODEL_ENTRY_ID,
      );
      assert.isFalse(left.webChatMode);
      const capsule = chipOf(root);
      assert.equal(capsule.dataset.static, "false");
      assert.equal(optionLabel(optionOf(root, "paper")), "Paper chat");
      assert.isFalse(optionOf(root, "paper").disabled);
      assert.isNull(optionOf(root, "paper").querySelector(".llm-webchat-dot"));
      assert.equal(optionOf(root, "paper").title, "");
      capsule.dispatchEvent(
        new (root.ownerDocument.defaultView as any).PointerEvent(
          "pointerenter",
          { pointerType: "mouse" },
        ),
      );
      assert.equal(capsule.dataset.expanded, "true", "it opens again");
      capsule.dispatchEvent(
        new (root.ownerDocument.defaultView as any).PointerEvent(
          "pointerleave",
          { pointerType: "mouse" },
        ),
      );
      await Zotero.Promise.delay(300);
      assert.equal(capsule.dataset.expanded, "false");
    });
  });
});
