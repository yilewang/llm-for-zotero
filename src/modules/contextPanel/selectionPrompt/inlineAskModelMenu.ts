/**
 * The model and effort menus behind an Inline Ask model line, built from an
 * InlineAskModelPicker. Shared by the reader's Inline Ask card and the note
 * editor's inline popup, so both offer the same menus with the same look.
 */
import type { InlineAskModelMenuGroup } from "./inlineAskModel";
import type { InlineAskPalette } from "./inlineAskPalette";
import { createReaderOverlayElementFactory } from "./readerOverlayShared";

/** The model line: the model and effort the next question uses. */
export type InlineAskModelLine = {
  label: string;
  effort?: string;
  title?: string;
};

/** The model and effort menus behind the model line. */
export type InlineAskModelPicker = {
  /** The line now; read again after each pick. */
  line(): InlineAskModelLine | null;
  /** A short note shown first (or null), then the models by provider. */
  modelMenu(): { note: string | null; groups: InlineAskModelMenuGroup[] };
  pickModel(entryId: string): void;
  /** The section title and the levels the model in use offers. */
  effortMenu(): {
    title: string;
    levels: Array<{ value: string; label: string; selected: boolean }>;
  };
  pickEffort(value: string): void;
  /**
   * Called when the model or effort menu opens: may start loading model
   * data (the Codex Direct catalog) and calls `onChange` when it arrives,
   * so the card redraws its line and the open menu.
   */
  prepareMenu?(onChange: () => void): void;
};

/** The menu panel's own style; the caller positions it. */
export function inlineAskMenuPanelCss(palette: InlineAskPalette): string[] {
  return [
    "position:absolute",
    "z-index:4",
    "display:grid",
    "gap:3px",
    "width:max-content",
    "min-width:150px",
    "max-width:240px",
    "max-height:min(320px, 60vh)",
    "overflow-y:auto",
    "padding:6px",
    "box-sizing:border-box",
    `border:1px solid ${palette.menuBorder}`,
    "border-radius:12px",
    `background:${palette.bg}`,
    `box-shadow:${palette.menuShadow}`,
  ];
}

export function inlineAskMenuSectionCss(palette: InlineAskPalette): string[] {
  return [
    "padding:4px 10px",
    "font-size:10px",
    "font-weight:600",
    `color:${palette.labelFg}`,
  ];
}

/** One radio option of a menu (a model, or an effort level). */
export function createInlineAskMenuOption(
  doc: Document,
  palette: InlineAskPalette,
  option: {
    attribute: string;
    value: string;
    text: string;
    selected: boolean;
    title?: string;
    pick: () => void;
  },
): HTMLButtonElement {
  const el = createReaderOverlayElementFactory(doc);
  const { selected } = option;
  const node = el("button", [
    `border:1px solid ${selected ? palette.accent : "transparent"}`,
    "border-radius:8px",
    "background:none",
    `color:${palette.fg}`,
    "text-align:left",
    "padding:7px 9px",
    "margin:0",
    "font:inherit",
    "font-size:11px",
    "line-height:1.2",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  node.setAttribute("type", "button");
  node.setAttribute("role", "menuitemradio");
  node.setAttribute(option.attribute, option.value);
  node.setAttribute("aria-checked", selected ? "true" : "false");
  if (option.title) node.setAttribute("title", option.title);
  node.textContent = option.text;
  node.addEventListener("mouseenter", () => {
    if (!selected) node.style.borderColor = palette.menuBorder;
  });
  node.addEventListener("mouseleave", () => {
    if (!selected) node.style.borderColor = "transparent";
  });
  node.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    option.pick();
  });
  return node;
}

/**
 * The model menu (a note, then the models by provider) or the effort menu
 * (its title, then the levels the model offers). `onPick` runs after the
 * picker took a choice. Throws when the picker cannot list its choices.
 */
export function buildInlineAskModelMenu(params: {
  doc: Document;
  palette: InlineAskPalette;
  picker: InlineAskModelPicker;
  kind: "model" | "effort";
  onPick: () => void;
}): HTMLElement {
  const { doc, palette, picker, kind, onPick } = params;
  const el = createReaderOverlayElementFactory(doc);
  const menu = el("div", inlineAskMenuPanelCss(palette));
  menu.setAttribute("data-llm-inline-ask-model-menu", kind);
  menu.setAttribute("role", "menu");
  const section = (text: string) => {
    const node = el("div", inlineAskMenuSectionCss(palette));
    node.setAttribute("data-llm-inline-ask-menu-section", "true");
    node.textContent = text;
    return node;
  };
  if (kind === "model") {
    const { note, groups } = picker.modelMenu();
    if (note) {
      const explain = el("div", [
        "padding:4px 10px 8px",
        "font-size:9.5px",
        "line-height:1.45",
        `color:${palette.labelFg}`,
        "white-space:normal",
      ]);
      explain.setAttribute("data-llm-inline-ask-model-note", "true");
      explain.textContent = note;
      menu.append(explain);
    }
    for (const group of groups) {
      menu.append(section(group.label));
      for (const option of group.options)
        menu.append(
          createInlineAskMenuOption(doc, palette, {
            attribute: "data-llm-inline-ask-model-option",
            value: option.entryId,
            text: option.label,
            selected: option.selected,
            title: option.title,
            pick: () => {
              picker.pickModel(option.entryId);
              onPick();
            },
          }),
        );
    }
    return menu;
  }
  const { title, levels } = picker.effortMenu();
  menu.append(section(title));
  for (const level of levels)
    menu.append(
      createInlineAskMenuOption(doc, palette, {
        attribute: "data-llm-inline-ask-effort-option",
        value: level.value,
        text: level.label,
        selected: level.selected,
        pick: () => {
          picker.pickEffort(level.value);
          onPick();
        },
      }),
    );
  return menu;
}
