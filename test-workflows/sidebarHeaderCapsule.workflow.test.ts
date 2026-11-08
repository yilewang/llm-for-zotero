/**
 * The Stacked sidebar header is three blocks: new chat and history, a capsule
 * with the mode chip and runtime toggles, and the panel actions. As the pane
 * narrows it moves through four stages, which the row writes as `data-fit`:
 * "full", "menu" (Settings, Export and Delete fold into the More button),
 * "compact" (24px boxes, 8px least between blocks), and "tight" (Task
 * progress and Open in window fold into More too). The chip has a fixed font
 * size here, so the stage and the capsule do not change with the plugin font
 * scale. This test sweeps the pane width in the real sidebar and checks the
 * stage, the geometry in each stage, the font-scale invariance, and the More
 * menu. The choice itself is unit-tested in
 * test/headerSpacing.test.ts.
 */
import { assert } from "chai";
import {
  chooseHeaderFit,
  headerFitRequiredWidth,
  type HeaderFit,
  type HeaderFitInput,
} from "../src/modules/contextPanel/setupHandlers/controllers/headerSpacing";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const LAYOUT_PREF = "extensions.zotero.llmforzotero.sidebarLayout";
/** Half a CSS pixel either way: what a 2x screen can still show. */
const TOLERANCE = 0.5;
const STAGES = ["full", "menu", "compact", "tight"] as const;
type Stage = (typeof STAGES)[number];
const MIN_GAP: Record<Stage, number> = {
  full: 10,
  menu: 10,
  compact: 8,
  tight: 8,
};
const BOX: Record<Stage, number> = {
  full: 28,
  menu: 28,
  compact: 24,
  tight: 24,
};

describe("workflow: Stacked sidebar header capsule", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let savedLayout: unknown;
  let body: HTMLElement;
  let header: HTMLElement;
  const win = () => Zotero.getMainWindow() as any;

  async function until(check: () => boolean, message: string, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
    assert.isTrue(check(), message);
  }

  const q = <T extends HTMLElement>(selector: string) =>
    body.querySelector(selector) as T;
  const row = () => q(".llm-header-nav-row");
  const stage = () => row().dataset.fit as Stage | undefined;
  const widthOf = (selector: string) =>
    q(selector).getBoundingClientRect().width;

  /**
   * The inputs `updateHeaderFit` reads, measured the same way: the row's
   * width, its padding, the capsule's width, and the buttons code left shown.
   */
  function fitInput(): HeaderFitInput {
    const node = row();
    const style = win().getComputedStyle(node);
    const count = (selectors: string[]) =>
      selectors.filter((selector) => {
        const button = node.querySelector<HTMLElement>(selector);
        return Boolean(button) && button!.style.display !== "none";
      }).length;
    return {
      available: node.getBoundingClientRect().width,
      padding:
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0),
      capsule: q(".llm-header-runtime-controls").getBoundingClientRect().width,
      leftButtons: count(["#llm-history-new", "#llm-history-toggle"]),
      pinnedRightButtons: count(["#llm-task-progress-toggle", "#llm-popout"]),
      foldableRightButtons: count([
        "#llm-settings",
        "#llm-export",
        "#llm-clear",
      ]),
    };
  }

  /** Set the pane width and wait for the row to settle on a stage. */
  async function setWidth(width: number): Promise<Stage> {
    header.style.width = `${width}px`;
    // The row is wider than the header by its negative side margins, so wait
    // on the header itself.
    await until(
      () => Math.abs(header.getBoundingClientRect().width - width) < 1,
      `the header is ${width}px wide`,
    );
    // The fit runs on a frame after the resize (or a 100ms fallback). It has
    // settled when the stage is set, choosing it again from the measured
    // inputs keeps it, and it has held for several reads in a row.
    let held = 0;
    await until(() => {
      const current = stage();
      const settled =
        Boolean(current) &&
        (STAGES as readonly string[]).includes(current as string) &&
        chooseHeaderFit(fitInput(), current as HeaderFit) === current;
      held = settled ? held + 1 : 0;
      return held >= 4;
    }, `the row settles on a stage at ${width}px (data-fit ${stage()})`);
    return stage() as Stage;
  }

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    savedLayout = Zotero.Prefs.get(LAYOUT_PREF, true);
    Zotero.Prefs.set(LAYOUT_PREF, "stacked", true);
    fixture = await api.createPaperWithPdfFixture({
      title: "Header Capsule Paper",
      pdfTitle: "Header Capsule Paper",
      pages: ["Header capsule evidence."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    body = win().document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    ) as HTMLElement;
    assert.isOk(body, "the sidebar panel is rendered");
    await until(
      () =>
        win().document.documentElement.getAttribute(
          "data-llm-sidebar-layout",
        ) === "stacked",
      "the Stacked layout applies",
    );
    header = q(".llm-header");
  });

  after(async function () {
    if (header) header.style.width = "";
    if (savedLayout === undefined) Zotero.Prefs.clear?.(LAYOUT_PREF, true);
    else Zotero.Prefs.set(LAYOUT_PREF, savedLayout as never, true);
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
  });

  it("moves full, menu, compact, tight as the pane narrows, with sound geometry at every width", async function () {
    const seen: Stage[] = [];
    let fullHeight = 0;
    for (let width = 600; width >= 200; width -= 10) {
      const current = await setWidth(width);
      if (seen[seen.length - 1] !== current) seen.push(current);
      const context = `${width}px (${current})`;
      const rowRect = row().getBoundingClientRect();
      if (!fullHeight) fullHeight = rowRect.height;
      assert.closeTo(
        rowRect.height,
        fullHeight,
        TOLERANCE,
        `the row keeps its height: ${context}`,
      );

      const visible = (selector: string) => {
        const node = q(selector);
        return node && node.getBoundingClientRect().width > 0 ? node : null;
      };
      const folded = current !== "full";
      for (const id of ["#llm-settings", "#llm-export", "#llm-clear"]) {
        assert.equal(
          Boolean(visible(id)),
          !folded,
          `${id} shows only in full: ${context}`,
        );
      }
      assert.equal(
        Boolean(visible("#llm-header-more")),
        folded,
        `More shows only when the row is folded: ${context}`,
      );
      for (const id of ["#llm-task-progress-toggle", "#llm-popout"]) {
        // Task progress belongs to a paper chat; it is shown here.
        if (q<HTMLElement>(id).style.display === "none") continue;
        assert.equal(
          Boolean(visible(id)),
          current !== "tight",
          `${id} shows in every stage but tight: ${context}`,
        );
      }

      // Left block, capsule, right block: in the row, in this order, apart.
      const left = ["#llm-history-new", "#llm-history-toggle"].map((id) =>
        q(id).getBoundingClientRect(),
      );
      const capsule = q(".llm-header-runtime-controls").getBoundingClientRect();
      const right = (
        Array.from(
          body.querySelectorAll(".llm-header-actions > button"),
        ) as HTMLElement[]
      )
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
      assert.isAtLeast(
        right.length,
        current === "tight" ? 1 : 3,
        `right block shows: ${context}`,
      );
      if (current === "tight") {
        assert.lengthOf(right, 1, `tight keeps only More: ${context}`);
      }
      // Below the tight minimum no stage is smaller, so the capsule may
      // overlap the actions there. Product behaviour allows it; the order and
      // fit checks count only where the tight stage has room.
      const hasRoom =
        headerFitRequiredWidth("tight", fitInput()) <= rowRect.width;
      if (!hasRoom) {
        assert.equal(current, "tight", `narrowest stage: ${context}`);
      }
      const controls = [...left, capsule, ...right];
      if (hasRoom) {
        for (const rect of controls) {
          assert.isAtLeast(rect.left, rowRect.left - TOLERANCE, context);
          assert.isAtMost(rect.right, rowRect.right + TOLERANCE, context);
        }
        for (let i = 1; i < controls.length; i++) {
          assert.isAtLeast(
            controls[i].left - controls[i - 1].right,
            -TOLERANCE,
            `controls ${i - 1} and ${i} do not overlap: ${context}`,
          );
        }
      }
      for (const rect of [...left, ...right]) {
        assert.closeTo(rect.width, BOX[current], TOLERANCE, context);
        assert.closeTo(rect.height, BOX[current], TOLERANCE, context);
      }
      assert.closeTo(capsule.height, 26, TOLERANCE, `capsule: ${context}`);

      // Gaps between blocks: at least the stage minimum, and equal either
      // side of the capsule. The narrowest widths may overflow the row (no
      // stage is smaller), so the gaps count only where the row has room.
      const gapLeft = capsule.left - left[1].right;
      const gapRight = right[0].left - capsule.right;
      const room = rowRect.width - (capsule.width + 2 * MIN_GAP[current]);
      const blocks =
        left[1].right -
        left[0].left +
        (right[right.length - 1].right - right[0].left);
      if (blocks + 8 <= room) {
        assert.isAtLeast(gapLeft, MIN_GAP[current] - TOLERANCE, context);
        assert.isAtLeast(gapRight, MIN_GAP[current] - TOLERANCE, context);
        assert.closeTo(gapLeft, gapRight, 1, `capsule is centred: ${context}`);
      }
    }
    assert.deepEqual(
      seen,
      ["full", "menu", "compact", "tight"],
      `the stages come in order down the sweep: ${seen.join(" > ")}`,
    );
  });

  it("is full when wide and keeps hysteresis while the width wobbles", async function () {
    const wide = await setWidth(600);
    assert.equal(wide, "full");
    // The stage the chooser gives for the measured inputs, coming from wide.
    const narrow = await setWidth(260);
    assert.equal(narrow, chooseHeaderFit(fitInput(), wide));
    const back = await setWidth(600);
    assert.equal(back, chooseHeaderFit(fitInput(), narrow));
    assert.equal(back, "full");
  });

  it("re-fits when Task progress appears or hides, without a width change", async function () {
    const toggle = q("#llm-task-progress-toggle");
    const savedDisplay = toggle.style.display;
    try {
      // Task progress hidden: choose a width just above what "menu" needs.
      toggle.style.display = "none";
      const without = fitInput();
      const width = headerFitRequiredWidth("menu", without) + 2;
      // The header is narrower than the row by its side margins.
      const margin =
        row().getBoundingClientRect().width -
        header.getBoundingClientRect().width;
      const settled = await setWidth(width - margin);
      assert.equal(settled, "menu", "menu with Task progress hidden");
      // Showing Task progress adds a button, so menu no longer fits.
      toggle.style.display = "";
      assert.isAbove(
        headerFitRequiredWidth("menu", fitInput()),
        row().getBoundingClientRect().width,
        "menu needs more than the row has once Task progress shows",
      );
      await until(
        () => stage() !== "menu",
        "the row re-fits when Task progress appears",
      );
    } finally {
      toggle.style.display = savedDisplay;
    }
  });

  it("keeps the stage and the capsule width the same at every plugin font scale", async function () {
    const panel = q(".llm-panel");
    const chip = () => q<HTMLElement>(".llm-header-nav-row .llm-mode-switch");
    const snapshot = () => ({
      stage: stage(),
      capsule: widthOf(".llm-header-runtime-controls"),
      chip: chip().getBoundingClientRect().width,
      chipFont: parseFloat(
        win().getComputedStyle(
          chip().querySelector(".llm-mode-switch-option") as HTMLElement,
        ).fontSize,
      ),
      left: widthOf("#llm-history-new"),
      more: widthOf("#llm-header-more"),
    });
    try {
      for (const width of [420, 330, 290, 260]) {
        const results: Array<[string, ReturnType<typeof snapshot>]> = [];
        for (const scale of ["1", "1.4", "1.8"]) {
          panel.style.setProperty("--llm-font-scale", scale);
          // Guard: the scale reaches the panel, so a scaled chip would show.
          await until(
            () =>
              Math.abs(
                parseFloat(win().getComputedStyle(panel).fontSize) -
                  12 * parseFloat(scale),
              ) < 0.1,
            `the panel font follows --llm-font-scale ${scale}`,
          );
          // Come from a wide row each time: stepping up from a folded stage
          // would need the hysteresis spare and hide a difference.
          await setWidth(600);
          await setWidth(width);
          results.push([scale, snapshot()]);
        }
        const [, base] = results[0];
        assert.closeTo(base.chipFont, 12, 0.01, "the chip font is fixed 12px");
        for (const [scale, now] of results) {
          const context = `${width}px, --llm-font-scale ${scale}`;
          assert.equal(now.stage, base.stage, `same stage: ${context}`);
          assert.closeTo(now.capsule, base.capsule, 0.1, `capsule: ${context}`);
          assert.closeTo(now.chip, base.chip, 0.1, `chip: ${context}`);
          assert.closeTo(now.chipFont, 12, 0.01, `chip font: ${context}`);
          assert.closeTo(now.left, base.left, 0.1, `box: ${context}`);
          assert.closeTo(now.more, base.more, 0.1, `More: ${context}`);
        }
      }
    } finally {
      panel.style.removeProperty("--llm-font-scale");
    }
  });

  const visibleItems = (menu: HTMLElement) =>
    (Array.from(menu.querySelectorAll("[role=menuitem]")) as HTMLElement[])
      .filter((item) => item.style.display !== "none")
      .map((item) => item.id);

  it("lists five items at a tight width and three at a menu width", async function () {
    const menu = q<HTMLElement>("#llm-header-more-menu");
    const more = q<HTMLButtonElement>("#llm-header-more");
    const separators = () =>
      (
        Array.from(menu.querySelectorAll("[role=separator]")) as HTMLElement[]
      ).filter((node) => node.style.display !== "none").length;
    const open = async () => {
      more.click();
      await until(() => menu.style.display !== "none", "More opens the menu");
    };
    const close = async () => {
      more.click();
      await until(() => menu.style.display === "none", "More closes the menu");
    };
    assert.equal(await setWidth(600), "full");
    // Find a width for each stage from the same arithmetic the row uses.
    const input = fitInput();
    const need = (s: Stage) => headerFitRequiredWidth(s, input);
    const menuWidth = Math.ceil(need("menu")) + 4;
    const tightWidth = Math.floor(need("compact")) - 6;
    assert.equal(await setWidth(menuWidth), "menu");
    await open();
    assert.deepEqual(visibleItems(menu), [
      "llm-header-more-settings",
      "llm-header-more-export",
      "llm-header-more-delete",
    ]);
    assert.equal(separators(), 1, "one separator above Delete");
    await close();

    assert.equal(await setWidth(tightWidth), "tight");
    await open();
    assert.deepEqual(visibleItems(menu), [
      "llm-header-more-task-progress",
      "llm-header-more-popout",
      "llm-header-more-settings",
      "llm-header-more-export",
      "llm-header-more-delete",
    ]);
    assert.equal(separators(), 2, "a separator under Open in window too");
    await close();
  });

  it("opens the More menu with Settings, Export and Delete, Export matching its button", async function () {
    assert.equal(await setWidth(600), "full");
    assert.equal(widthOf("#llm-header-more"), 0, "More is hidden in full");
    const folded = await setWidth(
      Math.ceil(headerFitRequiredWidth("menu", fitInput())) + 4,
    );
    assert.equal(folded, "menu");
    const more = q<HTMLButtonElement>("#llm-header-more");
    const menu = q<HTMLElement>("#llm-header-more-menu");
    assert.isAbove(more.getBoundingClientRect().width, 0, "More shows");
    assert.equal(more.getAttribute("aria-haspopup"), "menu");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.equal(menu.style.display, "none", "the menu starts closed");

    more.click();
    await until(() => menu.style.display !== "none", "More opens the menu");
    assert.equal(more.getAttribute("aria-expanded"), "true");
    const items = Array.from(
      menu.querySelectorAll("[role=menuitem]"),
    ) as HTMLButtonElement[];
    assert.deepEqual(
      items
        .filter((item) => item.style.display !== "none")
        .map((item) => item.id),
      [
        "llm-header-more-settings",
        "llm-header-more-export",
        "llm-header-more-delete",
      ],
    );
    const menuRect = menu.getBoundingClientRect();
    assert.isAbove(menuRect.width, 0, "the menu is laid out");
    assert.isAbove(menuRect.height, 0, "the menu is laid out");
    for (const [item, button] of [
      ["llm-header-more-settings", "#llm-settings"],
      ["llm-header-more-export", "#llm-export"],
      ["llm-header-more-delete", "#llm-clear"],
    ]) {
      assert.equal(
        (menu.querySelector(`#${item}`) as HTMLButtonElement).disabled,
        q<HTMLButtonElement>(button).disabled,
        `${item} is disabled exactly when ${button} is`,
      );
    }
    assert.isFalse(q<HTMLButtonElement>("#llm-export").disabled);
    assert.isOk(
      menu.querySelector(".llm-follower-menu-separator"),
      "a separator sits above Delete",
    );

    // Escape closes the menu and returns focus to the button.
    const KeyEvent = win().KeyboardEvent;
    win().document.dispatchEvent(
      new KeyEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => menu.style.display === "none", "Escape closes it");
    assert.equal(more.getAttribute("aria-expanded"), "false");

    // A pointer press outside closes it too.
    more.click();
    await until(() => menu.style.display !== "none", "it opens again");
    q(".llm-messages").dispatchEvent(
      new (win().PointerEvent)("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    await until(() => menu.style.display === "none", "an outside press closes");

    // Export runs the Export button's handler: its own menu opens, beside
    // the More button because the Export button is hidden.
    more.click();
    await until(() => menu.style.display !== "none", "it opens a third time");
    (menu.querySelector("#llm-header-more-export") as HTMLElement).click();
    const exportMenu = q<HTMLElement>("#llm-export-menu");
    await until(
      () => exportMenu.style.display !== "none",
      "the Export item opens the export menu",
    );
    assert.equal(menu.style.display, "none", "picking an item closes the menu");
    const exportRect = exportMenu.getBoundingClientRect();
    const moreRect = more.getBoundingClientRect();
    assert.isAbove(exportRect.top, moreRect.bottom - TOLERANCE, "below More");
    exportMenu.style.display = "none";
  });
});
