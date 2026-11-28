/**
 * The editing UI of a quick prompt list (quickPromptStore.ts), shared by the
 * reader's Inline Ask card and the note editor's inline writing popup:
 *
 * - the right-click menu: Edit, Delete, Add, Reset on a prompt, or Add and
 *   Reset on the row's empty space;
 * - the floating editor: a Label field, a Prompt field, Cancel and Save.
 *
 * The host popup mounts and places both, and decides when they open and
 * close; this module builds them and turns a menu pick into a store change.
 */
import { inlineAskButtonCss, type InlineAskPalette } from "./inlineAskPalette";
import {
  createReaderOverlayEditor,
  createReaderOverlayElementFactory,
  XHTML_NS,
  type ReaderOverlayEditor,
} from "./readerOverlayShared";
import type {
  QuickPrompt,
  QuickPromptEditing,
  QuickPromptText,
} from "./quickPromptStore";

export type QuickPromptEditingLabels = {
  edit: string;
  delete: string;
  add: string;
  reset: string;
  /** Placeholder of the Label field. */
  label: string;
  /** Placeholder of the Prompt field. */
  prompt: string;
  cancel: string;
  save: string;
};

export type QuickPromptEditingSetup = {
  api: QuickPromptEditing;
  labels: QuickPromptEditingLabels;
};

export type QuickPromptMenuAction = "edit" | "delete" | "add" | "reset";

/** The right-click menu for prompt `promptId`, or for the row when null. */
export function buildQuickPromptMenu(params: {
  doc: Document;
  palette: InlineAskPalette;
  setup: QuickPromptEditingSetup;
  promptId: string | null;
  onAction: (action: QuickPromptMenuAction) => void;
}): HTMLElement {
  const { palette, setup, promptId } = params;
  const el = createReaderOverlayElementFactory(params.doc);
  const menu = el("div", [
    "position:absolute",
    "z-index:3",
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "min-width:64px",
    "padding:4px",
    "box-sizing:border-box",
    `background:${palette.bg}`,
    `border:1px solid ${palette.menuBorder}`,
    "border-radius:6px",
    `box-shadow:${palette.menuShadow}`,
  ]);
  menu.setAttribute("data-llm-inline-ask-prompt-menu", promptId || "");
  menu.setAttribute("role", "menu");
  const { labels, api } = setup;
  const items: Array<[QuickPromptMenuAction, string, boolean]> = [
    ...(promptId
      ? ([
          ["edit", labels.edit, true],
          ["delete", labels.delete, true],
        ] as Array<[QuickPromptMenuAction, string, boolean]>)
      : []),
    ["add", labels.add, api.canAdd()],
    ["reset", labels.reset, true],
  ];
  for (const [action, text, enabled] of items) {
    const item = el("button", [
      "display:flex",
      "align-items:center",
      "justify-content:flex-start",
      "box-sizing:border-box",
      "width:100%",
      "min-height:24px",
      "margin:0",
      "background:none",
      "border:none",
      `color:${palette.fg}`,
      "padding:4px 8px",
      "font:inherit",
      "font-size:11px",
      "line-height:1.2",
      "text-align:left",
      "cursor:pointer",
      "border-radius:4px",
      "white-space:nowrap",
    ]) as HTMLButtonElement;
    item.setAttribute("type", "button");
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-llm-inline-ask-prompt-menu-item", action);
    item.textContent = text;
    if (!enabled) {
      item.disabled = true;
      item.style.opacity = "0.45";
      item.style.cursor = "not-allowed";
    }
    item.addEventListener("mouseenter", () => {
      if (!item.disabled) item.style.background = palette.hover;
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "none";
    });
    item.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.disabled) return;
      params.onAction(action);
    });
    menu.append(item);
  }
  return menu;
}

/**
 * Runs a menu pick: Edit and Add open the editor (`openEditor`), Delete and
 * Reset change the store. True when the store changed.
 */
export function applyQuickPromptMenuAction(
  api: QuickPromptEditing,
  action: QuickPromptMenuAction,
  prompt: QuickPrompt | null,
  openEditor: (prompt: QuickPrompt | null) => void,
): boolean {
  if (action === "edit") {
    if (prompt) openEditor(prompt);
    return false;
  }
  if (action === "add") {
    if (api.canAdd()) openEditor(null);
    return false;
  }
  try {
    if (action === "delete" && prompt) api.remove(prompt.id);
    else if (action === "reset") api.reset();
    else return false;
  } catch {
    // The prefs refused the write; the list shows what is stored.
  }
  return true;
}

export type QuickPromptEditorPanel = {
  /** The floating panel; the host mounts, places and shows it. */
  node: HTMLElement;
  labelInput: HTMLInputElement;
  promptBox: ReaderOverlayEditor;
  /** Fills the fields with `prompt`, or empties them for Add. */
  fill(prompt: QuickPrompt | null): void;
  /** The typed text, or null after focusing the empty field. */
  read(): QuickPromptText | null;
  /** Starts the Cancel/Save clicks, the focus rings and the Prompt field. */
  attach(): void;
  detach(): void;
};

/**
 * The floating editor. A <input type=text> and a contenteditable Prompt
 * field: Zotero's reader key handlers skip both (see
 * createReaderOverlayEditor), so letters and digits type.
 */
export function createQuickPromptEditorPanel(params: {
  doc: Document;
  palette: InlineAskPalette;
  labels: QuickPromptEditingLabels;
  width: number;
  onCancel: () => void;
  onSave: () => void;
}): QuickPromptEditorPanel {
  const { doc, palette, labels } = params;
  const el = createReaderOverlayElementFactory(doc);
  const node = el("div", [
    "display:none",
    "position:absolute",
    "z-index:5",
    "flex-direction:column",
    "gap:6px",
    `width:${params.width}px`,
    "box-sizing:border-box",
    "padding:10px",
    `background:${palette.bg}`,
    `border:1px solid ${palette.menuBorder}`,
    "border-radius:12px",
    `box-shadow:${palette.floatShadow}`,
    "min-width:0",
  ]);
  node.setAttribute("data-llm-inline-ask-prompt-editor", "true");
  const inputCss = [
    "width:100%",
    "min-width:0",
    "box-sizing:border-box",
    "padding:5px 8px",
    "border:1px solid transparent",
    "border-radius:6px",
    `background:${palette.fieldBg}`,
    `color:${palette.fg}`,
    "font:inherit",
    "font-size:12px",
    "line-height:1.35",
    "outline:none",
  ];
  const labelInput = doc.createElementNS(XHTML_NS, "input") as HTMLInputElement;
  labelInput.style.cssText = inputCss.join(";");
  labelInput.setAttribute("type", "text");
  labelInput.setAttribute("data-llm-inline-ask-prompt-label", "true");
  labelInput.setAttribute("placeholder", labels.label);
  labelInput.setAttribute("aria-label", labels.label);
  const promptBox = createReaderOverlayEditor({
    doc,
    placeholder: labels.prompt,
    fieldCss: ["position:relative", "min-width:0"],
    editorCss: [
      ...inputCss,
      "min-height:58px",
      "max-height:120px",
      "overflow-y:auto",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:9px",
      "top:6px",
      "right:9px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${palette.tertiary}`,
      "font-size:12px",
      "line-height:1.35",
    ],
    editorAttribute: "data-llm-inline-ask-prompt-text",
    placeholderAttribute: "data-llm-inline-ask-prompt-placeholder",
  });
  const footer = el("div", ["display:flex", "gap:6px", "align-items:center"]);
  const cancelBtn = el(
    "button",
    inlineAskButtonCss(palette, "ghost"),
  ) as HTMLButtonElement;
  cancelBtn.setAttribute("type", "button");
  cancelBtn.setAttribute("data-llm-inline-ask-prompt-action", "cancel");
  cancelBtn.textContent = labels.cancel;
  const saveBtn = el(
    "button",
    inlineAskButtonCss(palette, "primary"),
  ) as HTMLButtonElement;
  saveBtn.setAttribute("type", "button");
  saveBtn.setAttribute("data-llm-inline-ask-prompt-action", "save");
  saveBtn.textContent = labels.save;
  footer.append(el("span", ["flex:1 1 auto"]), cancelBtn, saveBtn);
  node.append(labelInput, promptBox.field, footer);

  const onCancelClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    params.onCancel();
  };
  const onSaveClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    params.onSave();
  };
  const focusRing = (field: HTMLElement) => ({
    focus: () => {
      field.style.borderColor = palette.accent;
    },
    blur: () => {
      field.style.borderColor = "transparent";
    },
  });
  const labelRing = focusRing(labelInput);
  const promptRing = focusRing(promptBox.editor);

  return {
    node,
    labelInput,
    promptBox,
    fill: (prompt) => {
      labelInput.value = prompt?.label || "";
      promptBox.setText(prompt?.prompt || "");
    },
    read: () => {
      const value = {
        label: (labelInput.value || "").trim(),
        prompt: promptBox.readText().trim(),
      };
      if (!value.label) {
        labelInput.focus({ preventScroll: true });
        return null;
      }
      if (!value.prompt) {
        promptBox.editor.focus({ preventScroll: true });
        return null;
      }
      return value;
    },
    attach: () => {
      cancelBtn.addEventListener("click", onCancelClick);
      saveBtn.addEventListener("click", onSaveClick);
      labelInput.addEventListener("focus", labelRing.focus);
      labelInput.addEventListener("blur", labelRing.blur);
      promptBox.editor.addEventListener("focus", promptRing.focus);
      promptBox.editor.addEventListener("blur", promptRing.blur);
      promptBox.attach();
    },
    detach: () => {
      cancelBtn.removeEventListener("click", onCancelClick);
      saveBtn.removeEventListener("click", onSaveClick);
      labelInput.removeEventListener("focus", labelRing.focus);
      labelInput.removeEventListener("blur", labelRing.blur);
      promptBox.editor.removeEventListener("focus", promptRing.focus);
      promptBox.editor.removeEventListener("blur", promptRing.blur);
      promptBox.detach();
    },
  };
}
