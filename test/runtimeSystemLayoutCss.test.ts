import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    css.match(
      new RegExp(`^[ \t]*${escapedSelector}\\s*\\{[^}]*\\}`, "m"),
    )?.[0] || ""
  );
}

/** The declarations of every rule whose selector list names `selector`. */
function cssRulesFor(css: string, selector: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((part) => part.replace(/\s+/g, " ").trim());
    if (selectors.includes(selector)) rules.push(match[2]);
  }
  return rules;
}

/** The text of the first at-rule block that opens with `prelude`. */
function cssBlock(css: string, prelude: string): string {
  const start = css.indexOf(`${prelude} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
  }
  return "";
}

/** Every at-rule block that opens with `prelude`. */
function cssBlocks(css: string, prelude: string): string[] {
  const blocks: string[] = [];
  let rest = css;
  for (;;) {
    const block = cssBlock(rest, prelude);
    if (!block) return blocks;
    blocks.push(block);
    rest = rest.slice(rest.indexOf(block) + block.length);
  }
}

const STACKED = ':root[data-llm-sidebar-layout="stacked"]';

describe("runtime system control layout", function () {
  it("scales the mode toggle labels with the plugin font setting at every width", function () {
    const css = source("addon/content/zoteroPane.css");
    const tabRule = extractCssRule(css, ".llm-standalone-tab");
    const toggleRowRule = extractCssRule(css, ".llm-header-toggle-row");

    // The labels follow --llm-font-scale like the rest of the plugin's text,
    // at the standalone window's own size: the sidebar row supplies the same
    // values the standalone root does.
    const standaloneRootRule = extractCssRule(
      css,
      "#llmforzotero-standalone-chat-root",
    );
    assert.include(tabRule, "font-size: var(--llm-standalone-ui-font-size)");
    for (const declaration of [
      "--llm-standalone-ui-font-size: var(--llm-fs-12);",
      "--llm-standalone-ui-line-height: calc(20px * var(--llm-font-scale));",
    ]) {
      assert.include(standaloneRootRule, declaration);
      assert.include(toggleRowRule, declaration);
    }

    // No width breakpoint may pin it either: the compact header shrinks buttons
    // to icons, but the toggle keeps scaling.
    const compactBlock =
      css.match(/@container \(max-width: 380px\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.notEqual(compactBlock, "", "compact header block must still exist");
    assert.notInclude(compactBlock, ".llm-header-mode-tab");
    // Main's old single-button chip is gone; the Stacked chip is the switch.
    assert.notInclude(css, ".llm-mode-chip");

    // The Stacked chip's labels scale the same way, and so does its sizer.
    for (const selector of [
      ".llm-mode-switch-option",
      ".llm-mode-switch-sizer > span",
    ]) {
      const rule = cssRulesFor(css, selector).join("\n");
      assert.include(rule, "font-size: var(--llm-fs-12)", selector);
      assert.include(rule, "font-weight: 600", selector);
    }
    assert.notMatch(
      compactBlock,
      /\.llm-mode-switch[^{]*\{[^}]*font-size/,
      "no breakpoint pins the chip's labels",
    );
  });

  it("gives Independent two header rows and Stacked one, from the root layout attribute", function () {
    const css = source("addon/content/zoteroPane.css");
    // Both controls are always built; the root layout attribute picks one, so
    // a live layout change swaps them without rebuilding the panel.
    assert.include(
      cssRulesFor(css, ".llm-mode-switch").join("\n"),
      "display: none",
      "the chip is hidden outside Stacked (Independent, standalone window)",
    );
    assert.include(
      cssRulesFor(css, `${STACKED} .llm-mode-switch`).join("\n"),
      "display: grid",
      "Stacked shows the chip",
    );
    // The divider is the capsule's separator in Stacked (see the capsule
    // header test), so only the toggle row goes.
    const hidden = ".llm-header-toggle-row";
    assert.include(
      cssRulesFor(css, `${STACKED} ${hidden}`).join("\n"),
      "display: none",
      `Stacked hides ${hidden}: one row, with the chip in the divider's place`,
    );
    assert.lengthOf(
      cssRulesFor(css, `:root[data-llm-pane-view="stacked"] ${hidden}`),
      0,
      "the pane view is not the layout: an empty Stacked library opens the full-pane view",
    );
    // Independent keeps its toggle row exactly as before.
    assert.include(
      extractCssRule(css, ".llm-header-toggle-row"),
      "display: flex",
    );

    // Spacing: 4px from history and from Codex. The narrow header drops the
    // history bar's gap, so the chip carries its own 4px there.
    const runtimeRule = extractCssRule(css, ".llm-header-runtime-controls");
    assert.include(runtimeRule, "gap: 4px");
    const compactBlock = cssBlock(css, "@container (max-width: 380px)");
    assert.include(
      cssRulesFor(compactBlock, ".llm-history-bar").join("\n"),
      "gap: 0",
    );
    assert.include(
      cssRulesFor(compactBlock, ".llm-mode-switch").join("\n"),
      "margin-inline-start: 4px",
    );

    // An empty Stacked library opens the full-pane view; its single row takes
    // the 6px of top space the toggle row gives the Independent pane.
    assert.include(
      cssRulesFor(
        css,
        `${STACKED}:not([data-llm-pane-view="stacked"]) .llm-dedicated-chat-pane .llm-header-nav-row`,
      ).join("\n"),
      "padding-top: 6px",
    );
  });

  it("drops the Stacked chip's switch down over the chat in the approved look", function () {
    const css = source("addon/content/zoteroPane.css");
    const chip = cssRulesFor(css, ".llm-mode-switch").join("\n");
    // Above the chat and the Task progress card (z-index 8), below the header
    // menus (13, 14) and the composer's popups.
    assert.include(chip, "position: relative");
    assert.include(chip, "z-index: 12");
    assert.include(chip, "--llm-mode-switch-duration: 300ms");
    assert.include(
      chip,
      "--llm-mode-switch-ease: cubic-bezier(0.22, 1, 0.36, 1)",
    );
    // Dark is the default; Zotero 10 leaves --stroke-secondary unset.
    for (const declaration of [
      "--llm-mode-switch-track: color-mix(\n    in srgb,\n    var(--material-sidepane) 66%,\n    black 34%\n  )",
      "--llm-mode-switch-thumb: color-mix(\n    in srgb,\n    var(--fill-primary) 11%,\n    var(--material-sidepane)\n  )",
      "--llm-mode-switch-edge: var(--stroke-secondary, rgba(255, 255, 255, 0.1))",
    ]) {
      assert.include(chip, declaration);
    }
    const light = cssBlocks(css, "@media (prefers-color-scheme: light)")
      .map((block) => cssRulesFor(block, ".llm-mode-switch").join("\n"))
      .join("\n");
    for (const declaration of [
      "--llm-mode-switch-track: color-mix(\n      in srgb,\n      var(--material-sidepane) 88%,\n      black 12%\n    )",
      "--llm-mode-switch-thumb: var(--material-background)",
      "--llm-mode-switch-edge: var(--stroke-secondary, rgba(0, 0, 0, 0.09))",
    ]) {
      assert.include(light, declaration);
    }

    // The open track: a 52px drop (two 22px rows, 2px apart, 3px padding)
    // with an inner edge and a soft shadow.
    const open = cssRulesFor(
      css,
      '.llm-mode-switch[data-expanded="true"] .llm-mode-switch-track',
    ).join("\n");
    assert.include(open, "height: 52px");
    assert.include(open, "opacity: 1");
    assert.include(open, "inset 0 0 0 1px var(--llm-mode-switch-edge)");
    assert.include(open, "0 6px 16px rgba(0, 0, 0, 0.28)");
    // Unselected text brightens on hover, only while the switch is open.
    assert.include(
      cssRulesFor(
        css,
        '.llm-mode-switch[data-expanded="true"] .llm-mode-switch-option:not([aria-pressed="true"]):hover',
      ).join("\n"),
      "color: var(--fill-primary)",
    );
    assert.include(
      cssRulesFor(css, ".llm-mode-switch-option").join("\n"),
      "color: var(--fill-secondary)",
    );
    // The selected pill keeps the chip's place; the other row is 24px lower.
    assert.include(
      cssRulesFor(
        css,
        '.llm-mode-switch[data-expanded="true"] .llm-mode-switch-option',
      ).join("\n"),
      "transform: translate(3px, 27px)",
    );
    const option = cssRulesFor(css, ".llm-mode-switch-option").join("\n");
    assert.include(option, "opacity 180ms ease");
    assert.include(option, "color 200ms ease");
    assert.include(option, "transform var(--llm-mode-switch-duration)");

    // The chat settles in on a mode change, in the Stacked sidebar only.
    assert.include(
      cssRulesFor(
        css,
        `${STACKED} .llm-dedicated-chat-pane .llm-messages.llm-mode-switch-fade`,
      ).join("\n"),
      "animation: llm-mode-switch-fade 260ms ease both",
    );
    const fade = cssBlock(css, "@keyframes llm-mode-switch-fade");
    assert.include(fade, "transform: translateY(4px)");
    assert.include(fade, "opacity: 0");

    // All of it stops under reduced motion.
    const reduced = cssBlocks(css, "@media (prefers-reduced-motion: reduce)")
      .filter((block) => block.includes(".llm-mode-switch"))
      .join("\n");
    assert.include(reduced, "transition-duration: 0ms !important");
    assert.include(reduced, "animation: none !important");
  });

  it("lays the Independent header out as the mode toggle, then actions", function () {
    const css = source("addon/content/zoteroPane.css");
    const toggleRowRule = extractCssRule(css, ".llm-header-toggle-row");
    const modeTabRule = extractCssRule(
      css,
      ".llm-header-toggle-row .llm-header-mode-tab",
    );
    const navRowRule = extractCssRule(css, ".llm-header-nav-row");
    const dividerRule = extractCssRule(css, ".llm-header-runtime-divider");

    // No docked title row in either layout: the header opens with the toggle.
    assert.notInclude(css, ".llm-docked-");
    assert.notInclude(
      source("src/modules/contextPanel/buildUI.ts"),
      "createDockedPanelTitle",
    );

    // Row 1: the centered toggle, free of any divider or fixed height.
    assert.notInclude(toggleRowRule, "border");
    assert.notMatch(toggleRowRule, /(^|\s)height:/);
    assert.include(toggleRowRule, "justify-content: center");
    assert.include(toggleRowRule, "padding: 6px 0 8px");
    assert.include(modeTabRule, "min-width: 64px");
    assert.include(modeTabRule, "padding-inline: 12px");

    // Row 2: actions, with no divider under them (none above the chat).
    assert.notInclude(navRowRule, "border-bottom");
    assert.include(dividerRule, "width: 1px");
    assert.include(dividerRule, "height: 16px");
    assert.include(
      dividerRule,
      "border-inline-start: var(--material-panedivider)",
    );

    // The items-list alignment is gone for good.
    assert.notInclude(css, "--llm-items-header");
    assert.notInclude(css, ".llm-header-mode-row");
    assert.notInclude(
      source("src/modules/contextPanel/dedicatedChatPane.ts"),
      "itemsHeaderHeight",
    );
    assert.notInclude(
      source("src/modules/contextPanel/buildUI.ts"),
      "itemsHeaderHeight",
    );
  });

  it("shows the Independent toggle row exactly when the history bar shows", function () {
    const css = source("addon/content/zoteroPane.css");
    // The history bar is always laid out: its display is !important so no
    // transient inline write can hide it (see the tab-switch fix that made
    // it so). The toggle row carries no inline display writes of its own, so
    // the two rows can never fall out of step; only the Stacked layout rule
    // hides it, and the chip that replaces it lives in the history bar.
    assert.include(
      extractCssRule(css, ".llm-history-bar"),
      "display: flex !important",
    );
    assert.include(
      extractCssRule(css, ".llm-header-toggle-row"),
      "display: flex",
    );
    for (const path of [
      "src/modules/contextPanel/buildUI.ts",
      "src/modules/contextPanel/setupHandlers.ts",
      "src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      "src/modules/contextPanel/panelHostOwnership.ts",
      "src/modules/contextPanel/sidebarModeSwitch.ts",
    ]) {
      const text = source(path);
      assert.notInclude(text, "headerToggleRow", path);
      assert.notInclude(text, "#llm-header-toggle-row", path);
      // Nor does any script show or hide the chip: CSS picks the control.
      assert.notMatch(text, /(modeSwitch|capsule)\.style\.display/, path);
    }
    // No script hides the runtime controls wrapper any more: it holds the
    // Stacked chip, which stays when no runtime system is enabled.
    assert.notInclude(
      source("src/modules/contextPanel/setupHandlers.ts"),
      "headerRuntimeControls.style.display",
    );
  });

  it("uses the shared mask assets instead of inline runtime glyph markup", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(css, 'mask-image: url("icons/claude-code.svg")');
    assert.include(sidebarSource, "createRuntimeSystemControls");
    assert.include(standaloneSource, "createRuntimeSystemControls");
    assert.notInclude(sidebarSource, "<svg");
    assert.notInclude(standaloneSource, "20.998 10.949");
  });

  it("uses the existing compact trash icon at every sidebar width", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const handlerSource = source("src/modules/contextPanel/setupHandlers.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const deleteButtonRule = extractCssRule(css, ".llm-clear-btn");
    const deleteIconRule = extractCssRule(css, ".llm-clear-btn::before");

    assert.include(sidebarSource, "llm-btn-icon llm-clear-btn");
    assert.include(sidebarSource, 'title: t("Delete conversation")');
    assert.include(
      sidebarSource,
      'clearBtn.setAttribute("aria-label", t("Delete conversation"))',
    );
    assert.notInclude(sidebarSource, 'textContent: t("Clear")');
    assert.include(deleteButtonRule, "width: 28px");
    assert.include(deleteButtonRule, "font-size: 0");
    assert.include(deleteIconRule, "display: block");
    assert.notInclude(css, '.llm-clear-btn[data-compact="true"]');
    assert.include(css, "@container (max-width: 380px)");
    assert.equal(
      css.split('url("icons/action-clear.svg")').length - 1,
      4,
      "the sidebar and standalone masks must share the existing trash asset",
    );
    assert.notInclude(handlerSource, "syncResponsiveHeaderClearButton");
    assert.notInclude(handlerSource, "shouldCompactHeaderClearButton");
    assert.include(handlerSource, 'clearBtn.textContent = ""');
    assert.include(handlerSource, 't("Delete conversation")');
    assert.include(
      standaloneSource,
      'iconClear.title = t("Delete conversation")',
    );
    assert.notInclude(standaloneSource, 'iconClear.title = t("Clear")');
  });

  it("lays the Stacked header out as left block, capsule, right block", function () {
    const css = source("addon/content/zoteroPane.css");
    const nav = `${STACKED} .llm-header-nav-row`;
    const rules = (selector: string) => cssRulesFor(css, selector).join("\n");

    // Sizes: 28px boxes and 10px between blocks; compact and tight are 24px
    // and 8px.
    assert.include(rules(nav), "--llm-header-box: 28px");
    assert.include(rules(nav), "--llm-header-gap-min: 10px");
    assert.include(rules(nav), "column-gap: var(--llm-header-gap-min)");
    assert.include(
      rules(`${nav}[data-fit="compact"]`),
      "--llm-header-box: 24px",
    );
    assert.include(
      rules(`${nav}[data-fit="compact"]`),
      "--llm-header-gap-min: 8px",
    );

    // The capsule: the existing runtime wrapper, 26px with 2px padding and gap.
    const capsule = rules(`${nav} .llm-header-runtime-controls`);
    for (const declaration of [
      "height: 26px",
      "padding: 2px",
      "gap: 2px",
      "border-radius: 13px",
      "background: var(--fill-quinary)",
      "margin-inline: auto",
    ]) {
      assert.include(capsule, declaration);
    }
    for (const stage of ["compact", "tight"]) {
      assert.include(
        rules(`${nav}[data-fit="${stage}"]`),
        "--llm-header-box: 24px",
      );
      assert.include(
        rules(`${nav}[data-fit="${stage}"]`),
        "--llm-header-gap-min: 8px",
      );
    }
    // The chip is a fixed 12px in this header, so the capsule has one width
    // at every plugin font scale; the base rule still scales it.
    const fixedChip = rules(`${nav} .llm-mode-switch-sizer > span`);
    assert.match(fixedChip, /font-size: 12px/);
    assert.match(rules(`${nav} .llm-mode-switch-option`), /font-size: 12px/);
    assert.notInclude(fixedChip, "--llm-font-scale");
    assert.match(
      css.replace(/\s+/g, " "),
      /\.llm-mode-switch-sizer > span, \.llm-mode-switch-option \{[^}]*font-size: var\(--llm-fs-12\)/,
      "outside the Stacked header the chip still scales with the font",
    );
    // Runtime toggles are 22px circles; the chip keeps its 22px height.
    assert.include(
      rules(`${STACKED} .llm-header .llm-runtime-system-controls`),
      "--llm-runtime-button-width: 22px",
    );
    const toggle = rules(`${STACKED} .llm-header .llm-runtime-system-toggle`);
    assert.include(toggle, "height: 22px");
    assert.include(toggle, "border-radius: 11px");
    // The capsule is quinary, so a hovered toggle needs a darker fill.
    assert.include(
      rules(
        `${STACKED} .llm-header .llm-runtime-system-toggle:hover:not(:disabled)`,
      ),
      "background: var(--fill-quarternary)",
    );
    assert.include(extractCssRule(css, ".llm-mode-switch"), "height: 22px");
    // The separator is the existing divider, moved between chip and toggles.
    const sep = rules(`${nav} .llm-header-runtime-divider`);
    assert.include(sep, "display: block");
    assert.include(sep, "order: 1");
    assert.include(sep, "height: 12px");
    assert.include(
      rules(`${STACKED} .llm-header .llm-runtime-system-controls`),
      "order: 2",
    );

    // Every icon button: a 28px box (24px compact), 6px radius, 0.72 at rest,
    // the quinary fill and full opacity on hover.
    const box = rules(`${nav} .llm-history-new`);
    for (const declaration of [
      "width: var(--llm-header-box)",
      "height: var(--llm-header-box)",
      "border-radius: 6px",
    ]) {
      assert.include(box, declaration);
    }
    assert.include(
      rules(`${nav} .llm-history-new:not(:disabled)`),
      "opacity: 0.72",
    );
    const hover = rules(`${nav} .llm-history-new:hover:not(:disabled)`);
    assert.include(hover, "background: var(--fill-quinary)");
    assert.include(hover, "opacity: 1");
    assert.include(hover, "color: var(--fill-primary)");
    // 2px between buttons inside a block.
    assert.include(rules(`${nav} .llm-header-actions`), "gap: 2px");
    assert.include(rules(`${nav} .llm-header-actions`), "min-height: 28px");
    assert.include(
      rules(`${nav} .llm-history-toggle`),
      "margin-inline: 2px var(--llm-header-gap-min)",
    );

    // More: hidden outside the folded stages, in every layout.
    assert.include(
      extractCssRule(css, ".llm-header-more-btn"),
      "display: none",
    );
    const flat = css.replace(/\s+/g, " ");
    for (const stage of ["menu", "compact", "tight"]) {
      assert.include(flat, `${nav}[data-fit="${stage}"] .llm-header-more-btn`);
      for (const button of ["settings", "export", "clear"]) {
        assert.include(flat, `${nav}[data-fit="${stage}"] .llm-${button}-btn`);
      }
    }
    // Only the tight stage also hides Task progress and Open in window.
    for (const button of ["task-progress", "popout"]) {
      assert.include(flat, `${nav}[data-fit="tight"] .llm-${button}-btn`);
      for (const stage of ["menu", "compact"]) {
        assert.notInclude(
          flat,
          `${nav}[data-fit="${stage}"] .llm-${button}-btn`,
        );
      }
    }
    assert.match(
      flat,
      /\.llm-header-nav-row\[data-fit="tight"\] \.llm-popout-btn \{ display: none; \}/,
    );
    assert.match(
      flat,
      /\.llm-header-nav-row\[data-fit="tight"\] \.llm-header-more-btn \{ display: inline-flex; \}/,
    );
  });

  it("leaves the Independent header on its own rules", function () {
    const css = source("addon/content/zoteroPane.css");
    // Every capsule rule is scoped to the Stacked root, so none reaches
    // Independent or the standalone window.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    let scoped = 0;
    for (const match of flat.matchAll(
      /([^{}]*(?:--llm-header-box|data-fit)[^{}]*)\{/g,
    )) {
      for (const selector of match[1].split(",")) {
        const text = selector.trim();
        if (!text || text.startsWith("@")) continue;
        assert.include(text, STACKED, `scoped to Stacked: ${text}`);
        scoped++;
      }
    }
    assert.isAtLeast(scoped, 6, "the scan found the capsule rules");
    // The compress-and-squeeze rules Independent keeps.
    assert.include(css, "--llm-runtime-compression");
    assert.include(css, "@container (max-width: 380px)");
    assert.include(
      source("src/modules/contextPanel/setupHandlers.ts"),
      "updateHeaderSpacing(headerRow)",
    );
  });

  it("builds the More button and its menu from existing menu styles", function () {
    const ui = source("src/modules/contextPanel/buildUI.ts");
    assert.include(ui, 'id: "llm-header-more"');
    assert.include(ui, "llm-btn-icon llm-header-more-btn");
    assert.include(ui, 'moreBtn.setAttribute("aria-haspopup", "menu")');
    assert.include(ui, 'moreBtn.setAttribute("aria-expanded", "false")');
    assert.include(ui, 't("More actions")');
    // Items reuse the standalone More menu's classes; Delete is the
    // destructive one, after a separator.
    assert.include(ui, "llm-standalone-skill-ctx-menu llm-header-more-menu");
    assert.include(ui, "llm-follower-menu-separator");
    // The tight stage adds Task progress and Open in window above Settings.
    for (const id of [
      "llm-header-more-task-progress",
      "llm-header-more-popout",
    ]) {
      assert.include(ui, `"${id}"`);
    }
    assert.include(ui, 'id: "llm-header-more-top-separator"');
    assert.match(
      ui,
      /headerMoreMenu\.append\(\s*headerMoreTaskItem,\s*headerMorePopoutItem,\s*headerMoreTopSeparator,\s*createHeaderMoreItem\("llm-header-more-settings"/,
    );
    assert.include(
      ui,
      'headerMoreDeleteItem.classList.add("llm-standalone-skill-ctx-delete")',
    );
    assert.include(
      source("addon/content/zoteroPane.css"),
      'url("icons/action-more.svg")',
    );
  });
});
