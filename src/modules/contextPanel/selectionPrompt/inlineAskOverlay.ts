/**
 * The Inline Ask card: a floating box in the reader document where the user
 * asks about the selected text without opening the sidebar.
 *
 * Compose: "Selected text" and the quote, the question field (model and
 * effort on the left, the send arrow on the right), the quick-prompt pills,
 * and the key hint. After a question: the thread (questions and streamed
 * answers), a follow-up field once the answer is in, and the footer
 * (Discard, Continue in sidebar, Save as annotation).
 *
 * Save as annotation switches the card to an annotation card: the color
 * square (a click shows Zotero's eight colors), the page, the selected text
 * highlighted in that color, and the last answer as an editable plain-text
 * comment, with Cancel and Save. Escape, Back or Cancel return to the
 * answer; Mod+Enter saves. A failed save keeps the card and its payload, so
 * Save retries the same payload.
 *
 * Continue in sidebar hands the finished turns to the sidebar; the card
 * closes when the sidebar took them, and otherwise shows the reason under
 * the footer and keeps its conversation.
 *
 * Quick prompts: right-clicking a pill opens Edit, Delete, Add and Reset;
 * right-clicking the empty space of the pill row opens Add and Reset. Edit
 * and Add open an editor in the card (Label is an <input type=text>, Prompt
 * a contenteditable box) with Cancel and Save; Enter in Label or Mod+Enter
 * in Prompt saves, Escape cancels. Every change is saved at once.
 *
 * Model line: clicking the model opens the API models grouped by provider
 * (with a short note first when the sidebar's runtime cannot run here);
 * clicking the effort opens the levels the model offers. A pick is Inline
 * Ask's own choice; the next question uses it. Escape closes an open menu
 * first; text typed in the field stays.
 *
 * Close policy: before the first question an outside pointerdown closes the
 * card, as the Add Text prompt does. Once a question exists, only Escape,
 * Discard, or another overlay on the same document closes it; a new text
 * selection popup leaves it open (keepsOpenOnNewSelection).
 *
 * Inline styles only: plugin CSS does not reach reader documents.
 */
import {
  inlineAskAnswerToPlainText,
  renderInlineAskAnswer,
} from "./inlineAskAnswerRender";
import type { InlineAskModelMenuGroup } from "./inlineAskModel";
import type {
  InlineAskPromptEditing,
  InlineAskQuickPrompt,
} from "./inlineAskPrompts";
import {
  createInlineAskSession,
  finishedInlineAskTurns,
  type InlineAskSession,
  type InlineAskState,
  type InlineAskTurn,
  type InlineAskTurnRunner,
} from "./inlineAskSession";
import {
  collectPointerDocuments,
  createReaderOverlayEditor,
  createReaderOverlayElementFactory,
  isDarkReaderDocument,
  positionReaderOverlay,
  prepareReaderOverlaySlot,
  READER_OVERLAY_MARGIN,
  readerOverlayPalette,
  readerOverlayScheduler,
  registerReaderOverlay,
  releaseReaderOverlay,
  XHTML_NS,
  type ReaderOverlayAnchor,
  type ReaderOverlayHandle,
  type ReaderOverlayPalette,
} from "./readerOverlayShared";
import { classifySelectionPromptKey } from "./selectionPromptKeys";

const SVG_NS = "http://www.w3.org/2000/svg";

export type InlineAskOverlayLabels = {
  selectedText: string;
  placeholder: string;
  followUpPlaceholder: string;
  hint: string;
  send: string;
  /** Shown while the first chunk of an answer is on its way. */
  reading: string;
  discard: string;
  continueInSidebar: string;
  saveAsAnnotation: string;
  reasoningEffort: string;
  /** Shown when no model can answer. */
  modelUnavailable: string;
};

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
};

export type InlineAskPromptEditingSetup = {
  api: InlineAskPromptEditing;
  labels: {
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
};

export type InlineAskSavePayload = { color: string; comment: string };

export type InlineAskSaveResult = { ok: true } | { ok: false; error: string };

/** A finished turn as the model got it (a quick prompt's full prompt). */
export type InlineAskContinueTurn = {
  role: "user" | "assistant";
  text: string;
};

/** Moves the turns to the sidebar; ok when the sidebar took them. */
export type InlineAskContinueInSidebar = (
  turns: InlineAskContinueTurn[],
) => Promise<{ ok: true } | { ok: false; error: string }>;

/** What the card needs for Save as annotation. */
export type InlineAskSaveSetup = {
  /** Zotero's highlight colors; the first is the default. */
  colors: Array<{ hex: string; label: string }>;
  /** "Page 17"; empty hides it. */
  pageText: string;
  labels: {
    color: string;
    back: string;
    cancel: string;
    save: string;
    addComment: string;
  };
  /** Why Save cannot run now (its tooltip), or null. Read on each check. */
  blockedReason: () => string | null;
  /** Writes the annotation; resolves ok only for a verified save. */
  save: (payload: InlineAskSavePayload) => Promise<InlineAskSaveResult>;
};

export type InlineAskOverlayInput = {
  /** Reader popup document (the renderTextSelectionPopup event's doc). */
  doc: Document;
  /** Popup row rect in viewport coordinates, measured at pointerdown. */
  anchor: ReaderOverlayAnchor;
  selectedText: string;
  prompts: InlineAskQuickPrompt[];
  /** Null when no usable model exists; picker.line() replaces it. */
  model: InlineAskModelLine | null;
  /** Without it, the model line is display only. */
  modelPicker?: InlineAskModelPicker;
  /** Without it, right-clicking a pill does nothing of the card's own. */
  promptEditing?: InlineAskPromptEditingSetup;
  labels: InlineAskOverlayLabels;
  runTurn: InlineAskTurnRunner;
  createAbortController?: () => { signal?: AbortSignal; abort(): void } | null;
  /** Without it, Save as annotation stays disabled. */
  save?: InlineAskSaveSetup;
  /** Without it, Continue in sidebar stays disabled. */
  continueInSidebar?: InlineAskContinueInSidebar;
  /** Called exactly once on any close path. */
  onClose?: () => void;
};

export type InlineAskOverlayHandle = ReaderOverlayHandle & {
  session: InlineAskSession;
  hasConversation(): boolean;
};

type SvgPart = { tag: string; attrs: Record<string, string> };

function svgIcon(
  doc: Document,
  size: number,
  attrs: Record<string, string>,
  parts: SvgPart[],
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  for (const [name, value] of Object.entries(attrs)) {
    svg.setAttribute(name, value);
  }
  for (const part of parts) {
    const node = doc.createElementNS(SVG_NS, part.tag);
    for (const [name, value] of Object.entries(part.attrs)) {
      node.setAttribute(name, value);
    }
    svg.appendChild(node);
  }
  return svg;
}

/** The plugin's bare up-arrow send glyph. */
function sendIcon(doc: Document): Element {
  return svgIcon(doc, 18, { fill: "none" }, [
    {
      tag: "path",
      attrs: {
        d: "M8 13V3.2M3.8 7.2 8 3l4.2 4.2",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    },
  ]);
}

function closeIcon(doc: Document): Element {
  return svgIcon(
    doc,
    12,
    {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    },
    [{ tag: "path", attrs: { d: "M4 4l8 8M12 4l-8 8" } }],
  );
}

/** The selection's highlight in the card: the color at 40% opacity. */
function markBackground(hex: string): string {
  return `${hex}66`;
}

const PAPER_FONT = '"STIX Two Text","Times New Roman",Times,serif';

function sidebarIcon(doc: Document): Element {
  return svgIcon(
    doc,
    14,
    { fill: "none", stroke: "currentColor", "stroke-width": "1.3" },
    [
      {
        tag: "rect",
        attrs: { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" },
      },
      { tag: "path", attrs: { d: "M10 2.5v11" } },
    ],
  );
}

/** The spark glyph on the reader popup's Inline Ask button. */
export function createInlineAskSparkIcon(doc: Document): Element {
  return svgIcon(doc, 13, {}, [
    {
      tag: "path",
      attrs: {
        d: "M7 1.5l1.4 3.6 3.6 1.4-3.6 1.4L7 11.5 5.6 7.9 2 6.5l3.6-1.4z",
        fill: "currentColor",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M12.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
        fill: "currentColor",
      },
    },
  ]);
}

function buttonCss(
  palette: ReaderOverlayPalette,
  variant: "plain" | "ghost" | "primary",
  extra: string[] = [],
): string[] {
  const base = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "gap:5px",
    "padding:4px 9px",
    `border:1px solid ${palette.border}`,
    "border-radius:6px",
    `background:${palette.fieldBg}`,
    `color:${palette.fg}`,
    "white-space:nowrap",
    "font:inherit",
    "font-size:12px",
    "line-height:1.35",
    "cursor:pointer",
  ];
  if (variant === "ghost") {
    base.push(
      "background:transparent",
      "border-color:transparent",
      `color:${palette.labelFg}`,
    );
  }
  if (variant === "primary") {
    base.push(
      `background:${palette.accent}`,
      `border-color:${palette.accent}`,
      `color:${palette.accentFg}`,
    );
  }
  return [...base, ...extra];
}

function setButtonDisabled(button: HTMLButtonElement, disabled: boolean) {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.45" : "";
  button.style.cursor = disabled ? "default" : "pointer";
}

function show(node: HTMLElement, visible: boolean, display = "") {
  node.style.display = visible ? display : "none";
}

export function openInlineAskOverlay(
  input: InlineAskOverlayInput,
): InlineAskOverlayHandle {
  const { doc, labels } = input;
  prepareReaderOverlaySlot(doc);
  const palette = readerOverlayPalette(isDarkReaderDocument(doc));
  const { bg, fg, border, quoteFg, labelFg } = palette;
  const el = createReaderOverlayElementFactory(doc);
  const schedule = readerOverlayScheduler(doc);
  const currentLine = (): InlineAskModelLine | null => {
    if (!input.modelPicker) return input.model;
    try {
      return input.modelPicker.line();
    } catch {
      return input.model;
    }
  };
  const hasModel = () => Boolean(currentLine());

  const root = el("div", [
    "position:fixed",
    "z-index:10000",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "width:360px",
    "max-width:calc(100vw - 16px)",
    "padding:10px",
    "box-sizing:border-box",
    `background:${bg}`,
    `color:${fg}`,
    `border:1px solid ${border}`,
    "border-radius:10px",
    "box-shadow:0 6px 18px rgba(0,0,0,0.22)",
    "font-size:12px",
    "line-height:1.35",
    "user-select:text",
    "-moz-user-select:text",
  ]);
  root.setAttribute("data-llm-inline-ask", "true");

  // Selected text, clamped to three lines.
  const quoteSection = el("div", [
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "min-width:0",
  ]);
  const quoteLabel = el("div", [
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.2",
  ]);
  quoteLabel.setAttribute("data-llm-inline-ask-quote-label", "true");
  quoteLabel.textContent = labels.selectedText;
  const quote = el("div", [
    `color:${quoteFg}`,
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "display:-webkit-box",
    "-webkit-box-orient:vertical",
    "-webkit-line-clamp:3",
    "overflow:hidden",
  ]);
  quote.setAttribute("data-llm-inline-ask-quote", "true");
  quote.textContent = input.selectedText;
  quoteSection.append(quoteLabel, quote);

  // The thread: questions, answers, and the reading line.
  const thread = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:6px",
    "max-height:min(260px, 38vh)",
    "overflow:auto",
    `border-top:1px solid ${border}`,
    "padding-top:8px",
  ]);
  thread.setAttribute("data-llm-inline-ask-thread", "true");
  const reading = el("div", [
    `color:${labelFg}`,
    "font-style:italic",
    "display:none",
  ]);
  reading.setAttribute("data-llm-inline-ask-reading", "true");
  reading.textContent = labels.reading;
  thread.append(reading);

  // The question field with the model pair and the send arrow inside.
  // The card redraws on every session change (render is defined below; the
  // session reports no change before the first send).
  const session: InlineAskSession = createInlineAskSession({
    runTurn: input.runTurn,
    onChange: (state) => render(state),
    createAbortController: input.createAbortController,
  });
  const canSendNow = () => {
    const phase = session.getState().phase;
    // While Continue in sidebar runs, the turns it moves must stay complete.
    if (continuing) return false;
    return hasModel() && (phase === "compose" || phase === "answered");
  };
  const syncSend = () => {
    setSendDisabled(!canSendNow() || !textBox.readText().trim());
  };
  const textBox = createReaderOverlayEditor({
    doc,
    placeholder: labels.placeholder,
    fieldCss: [
      "position:relative",
      "display:flex",
      "flex-direction:column",
      `border:1px solid ${border}`,
      "border-radius:6px",
      `background:${palette.fieldBg}`,
    ],
    editorCss: [
      "min-height:28px",
      "max-height:120px",
      "overflow-y:auto",
      "box-sizing:border-box",
      "padding:6px 8px 2px",
      "border:none",
      "background:transparent",
      `color:${fg}`,
      "font:inherit",
      "font-size:12px",
      "line-height:1.35",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "outline:none",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:9px",
      "top:7px",
      "right:9px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${labelFg}`,
      "font-size:12px",
      "line-height:1.35",
    ],
    editorAttribute: "data-llm-inline-ask-editor",
    placeholderAttribute: "data-llm-inline-ask-placeholder",
    onInput: () => syncSend(),
  });
  const { field, editor } = textBox;
  field.setAttribute("data-llm-inline-ask-field", "true");
  const fieldBar = el("div", [
    "display:flex",
    "align-items:center",
    "gap:0",
    "padding:0 0 0 2px",
    "min-width:0",
  ]);
  const modelPairCss = [
    `color:${palette.fill2}`,
    "font-weight:600",
    "font-size:11px",
    "line-height:1",
    "padding:5px 5px",
    "border-radius:5px",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
  ];
  // With a picker the pair are buttons that open the model and effort
  // menus (like the composer's model and reasoning buttons).
  const picker = input.modelPicker;
  const pairTag = picker ? "button" : "span";
  const pairButtonCss = picker
    ? [
        "border:none",
        "background:transparent",
        "font-family:inherit",
        "margin:0",
        "cursor:pointer",
      ]
    : [];
  const modelLabel = el(pairTag, [
    ...modelPairCss,
    ...pairButtonCss,
    "max-width:170px",
  ]);
  modelLabel.setAttribute("data-llm-inline-ask-model", "true");
  const effortLabel = el(pairTag, [
    ...modelPairCss,
    ...pairButtonCss,
    "max-width:90px",
  ]);
  effortLabel.setAttribute("data-llm-inline-ask-effort", "true");
  effortLabel.setAttribute("title", labels.reasoningEffort);
  for (const button of picker ? [modelLabel, effortLabel] : []) {
    button.setAttribute("type", "button");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
  }
  if (input.model || picker) fieldBar.append(modelLabel, effortLabel);
  const spacer = el("span", ["flex:1 1 auto"]);
  const sendBtn = el("button", [
    "flex:none",
    "width:28px",
    "height:28px",
    "border-radius:999px",
    "border:none",
    "background:transparent",
    `color:${palette.fill2}`,
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  sendBtn.setAttribute("type", "button");
  sendBtn.setAttribute("data-llm-inline-ask-send", "true");
  sendBtn.setAttribute("title", labels.send);
  sendBtn.setAttribute("aria-label", labels.send);
  sendBtn.appendChild(sendIcon(doc));
  const setSendDisabled = (disabled: boolean) => {
    sendBtn.disabled = disabled;
    sendBtn.style.color = disabled ? palette.fill3 : palette.fill2;
    sendBtn.style.cursor = disabled ? "default" : "pointer";
  };
  fieldBar.append(spacer, sendBtn);
  field.append(fieldBar);

  const notice = el("div", [
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.3",
  ]);
  notice.setAttribute("data-llm-inline-ask-notice", "true");
  notice.textContent = labels.modelUnavailable;

  const syncModelLine = () => {
    const line = currentLine();
    show(modelLabel, Boolean(line));
    modelLabel.textContent = line?.label || "";
    if (line?.title) modelLabel.setAttribute("title", line.title);
    else modelLabel.removeAttribute("title");
    show(effortLabel, Boolean(line?.effort));
    effortLabel.textContent = line?.effort || "";
    show(notice, !line);
  };
  syncModelLine();

  // Quick prompts.
  const pills = el("div", [
    "display:flex",
    "gap:4px",
    "flex-wrap:wrap",
    "min-height:24px",
  ]);
  pills.setAttribute("data-llm-inline-ask-pills", "true");
  const promptSetup = input.promptEditing;
  let shownPrompts: InlineAskQuickPrompt[] = input.prompts.slice();
  /** The prompt the editor is open for; id null for Add. */
  let editingPrompt: { id: string | null } | null = null;
  const pillCss = (editing: boolean) => [
    "display:inline-flex",
    "align-items:center",
    "min-height:24px",
    "padding:3px 9px",
    `border:1px solid ${editing ? palette.accent : border}`,
    "border-radius:999px",
    `background:${editing ? palette.accentTint : palette.fieldBg}`,
    `color:${fg}`,
    "font:inherit",
    "font-size:11px",
    "max-width:100%",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "cursor:pointer",
  ];
  const renderPills = () => {
    for (let child = pills.firstChild; child; child = pills.firstChild) {
      pills.removeChild(child);
    }
    for (const prompt of shownPrompts) {
      const editing = editingPrompt?.id === prompt.id;
      const pill = el("button", pillCss(editing)) as HTMLButtonElement;
      pill.setAttribute("type", "button");
      pill.setAttribute("data-llm-inline-ask-pill", prompt.id);
      // The tooltip is the prompt the pill sends.
      pill.setAttribute("title", prompt.prompt);
      if (editing) pill.setAttribute("data-editing", "true");
      pill.textContent = prompt.label;
      pill.addEventListener("mouseenter", () => {
        if (pill.disabled) return;
        pill.style.background = palette.accentTint;
        pill.style.borderColor = palette.accent;
      });
      pill.addEventListener("mouseleave", () => {
        if (editingPrompt?.id === prompt.id) return;
        pill.style.background = palette.fieldBg;
        pill.style.borderColor = border;
      });
      setButtonDisabled(pill, !hasModel());
      pills.append(pill);
    }
  };
  renderPills();

  const hint = el("div", [
    "font-size:10px",
    `color:${labelFg}`,
    "line-height:1.25",
  ]);
  hint.setAttribute("data-llm-inline-ask-hint", "true");
  hint.textContent = labels.hint;

  // ── Quick-prompt editor (Edit / Add) ───────────────────────────────────
  const promptEditor = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:6px",
    `border-top:1px solid ${border}`,
    "padding-top:8px",
    "min-width:0",
  ]);
  promptEditor.setAttribute("data-llm-inline-ask-prompt-editor", "true");
  const inputCss = [
    "width:100%",
    "min-width:0",
    "box-sizing:border-box",
    "padding:5px 8px",
    `border:1px solid ${border}`,
    "border-radius:6px",
    `background:${palette.fieldBg}`,
    `color:${fg}`,
    "font:inherit",
    "font-size:12px",
    "line-height:1.35",
    "outline:none",
  ];
  // <input type=text>: the reader's key handlers skip it (see
  // createReaderOverlayEditor), so letters and digits type.
  const labelInput = doc.createElementNS(XHTML_NS, "input") as HTMLInputElement;
  labelInput.style.cssText = inputCss.join(";");
  labelInput.setAttribute("type", "text");
  labelInput.setAttribute("data-llm-inline-ask-prompt-label", "true");
  labelInput.setAttribute("placeholder", promptSetup?.labels.label || "");
  labelInput.setAttribute("aria-label", promptSetup?.labels.label || "");
  const promptBox = createReaderOverlayEditor({
    doc,
    placeholder: promptSetup?.labels.prompt || "",
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
      `color:${labelFg}`,
      "font-size:12px",
      "line-height:1.35",
    ],
    editorAttribute: "data-llm-inline-ask-prompt-text",
    placeholderAttribute: "data-llm-inline-ask-prompt-placeholder",
  });
  const promptFooter = el("div", [
    "display:flex",
    "gap:6px",
    "align-items:center",
  ]);
  const cancelPromptBtn = el(
    "button",
    buttonCss(palette, "ghost"),
  ) as HTMLButtonElement;
  cancelPromptBtn.setAttribute("type", "button");
  cancelPromptBtn.setAttribute("data-llm-inline-ask-prompt-action", "cancel");
  cancelPromptBtn.textContent = promptSetup?.labels.cancel || "";
  const savePromptBtn = el(
    "button",
    buttonCss(palette, "primary"),
  ) as HTMLButtonElement;
  savePromptBtn.setAttribute("type", "button");
  savePromptBtn.setAttribute("data-llm-inline-ask-prompt-action", "save");
  savePromptBtn.textContent = promptSetup?.labels.save || "";
  promptFooter.append(
    el("span", ["flex:1 1 auto"]),
    cancelPromptBtn,
    savePromptBtn,
  );
  promptEditor.append(labelInput, promptBox.field, promptFooter);

  // ── Menus: the pill menu, and the model and effort menus ───────────────
  type OpenMenu = { kind: "prompt" | "model" | "effort"; node: HTMLElement };
  let openMenu: OpenMenu | null = null;
  /** A pointerdown that only closed the pill menu also swallows its click. */
  let swallowPillClick = false;

  const menuItemCss = [
    "display:flex",
    "align-items:center",
    "justify-content:flex-start",
    "box-sizing:border-box",
    "width:100%",
    "min-height:24px",
    "margin:0",
    "background:none",
    "border:none",
    `color:${fg}`,
    "padding:4px 8px",
    "font:inherit",
    "font-size:11px",
    "line-height:1.2",
    "text-align:left",
    "cursor:pointer",
    "border-radius:4px",
    "white-space:nowrap",
  ];
  const addHover = (
    node: HTMLElement,
    on: () => void,
    off: () => void,
  ): void => {
    node.addEventListener("mouseenter", on);
    node.addEventListener("mouseleave", off);
  };

  const closeMenus = () => {
    const menu = openMenu;
    if (!menu) return;
    openMenu = null;
    menu.node.remove();
    for (const button of [modelLabel, effortLabel]) {
      if (!picker) break;
      button.setAttribute("aria-expanded", "false");
      button.style.color = palette.fill2;
    }
  };

  /** Mounts `node` in the card at a point relative to the card's corner. */
  const mountMenu = (
    kind: OpenMenu["kind"],
    node: HTMLElement,
    left: number,
    top: number,
    flipAbove?: number,
  ) => {
    node.style.left = `${Math.max(0, Math.round(left))}px`;
    node.style.top = `${Math.round(top)}px`;
    root.append(node);
    openMenu = { kind, node };
    if (flipAbove === undefined) return;
    // Open upwards when the menu would leave the window at the bottom.
    const vh = doc.defaultView?.innerHeight ?? 600;
    const menuRect = node.getBoundingClientRect();
    if (menuRect.bottom > vh - READER_OVERLAY_MARGIN && menuRect.height) {
      node.style.top = `${Math.round(flipAbove - menuRect.height)}px`;
    }
  };

  const openPromptMenu = (promptId: string | null, x: number, y: number) => {
    if (!promptSetup) return;
    closeMenus();
    const menu = el("div", [
      "position:absolute",
      "z-index:3",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "min-width:64px",
      "padding:4px",
      "box-sizing:border-box",
      `background:${bg}`,
      `border:1px solid ${border}`,
      "border-radius:6px",
      "box-shadow:0 8px 18px rgba(0,0,0,0.2)",
    ]);
    menu.setAttribute("data-llm-inline-ask-prompt-menu", promptId || "");
    menu.setAttribute("role", "menu");
    const items: Array<[string, string, boolean]> = promptId
      ? [
          ["edit", promptSetup.labels.edit, true],
          ["delete", promptSetup.labels.delete, true],
          ["add", promptSetup.labels.add, promptSetup.api.canAdd()],
          ["reset", promptSetup.labels.reset, true],
        ]
      : [
          ["add", promptSetup.labels.add, promptSetup.api.canAdd()],
          ["reset", promptSetup.labels.reset, true],
        ];
    for (const [action, text, enabled] of items) {
      const item = el("button", menuItemCss) as HTMLButtonElement;
      item.setAttribute("type", "button");
      item.setAttribute("role", "menuitem");
      item.setAttribute("data-llm-inline-ask-prompt-menu-item", action);
      item.textContent = text;
      if (!enabled) {
        item.disabled = true;
        item.style.opacity = "0.45";
        item.style.cursor = "not-allowed";
      }
      addHover(
        item,
        () => {
          if (!item.disabled) item.style.background = palette.hover;
        },
        () => {
          item.style.background = "none";
        },
      );
      item.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        runPromptMenuAction(action, promptId);
      });
      menu.append(item);
    }
    const width = root.getBoundingClientRect().width || 360;
    mountMenu("prompt", menu, Math.min(x, width - 130), y);
  };

  const menuPanelCss = [
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
    `border:1px solid ${border}`,
    "border-radius:12px",
    `background:${bg}`,
    "box-shadow:0 8px 18px rgba(0,0,0,0.24)",
  ];
  const sectionCss = [
    "padding:4px 10px",
    "font-size:10px",
    "font-weight:600",
    `color:${labelFg}`,
  ];
  const optionCss = (selected: boolean) => [
    `border:1px solid ${selected ? palette.accent : "transparent"}`,
    "border-radius:8px",
    "background:none",
    `color:${fg}`,
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
  ];
  const menuOption = (
    attribute: string,
    value: string,
    text: string,
    selected: boolean,
    pick: () => void,
    title?: string,
  ): HTMLButtonElement => {
    const option = el("button", optionCss(selected)) as HTMLButtonElement;
    option.setAttribute("type", "button");
    option.setAttribute("role", "menuitemradio");
    option.setAttribute(attribute, value);
    option.setAttribute("aria-checked", selected ? "true" : "false");
    if (title) option.setAttribute("title", title);
    option.textContent = text;
    addHover(
      option,
      () => {
        if (!selected) option.style.borderColor = border;
      },
      () => {
        if (!selected) option.style.borderColor = "transparent";
      },
    );
    option.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      pick();
    });
    return option;
  };
  const afterPick = () => {
    closeMenus();
    syncModelLine();
    syncSend();
    renderPills();
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };

  const toggleModelMenu = (kind: "model" | "effort") => {
    if (!picker) return;
    if (openMenu?.kind === kind) {
      closeMenus();
      return;
    }
    closeMenus();
    const button = kind === "model" ? modelLabel : effortLabel;
    const menu = el("div", menuPanelCss);
    menu.setAttribute("data-llm-inline-ask-model-menu", kind);
    menu.setAttribute("role", "menu");
    try {
      if (kind === "model") {
        const { note, groups } = picker.modelMenu();
        if (note) {
          const explain = el("div", [
            "padding:4px 10px 8px",
            "font-size:9.5px",
            "line-height:1.45",
            `color:${palette.fill2}`,
            "white-space:normal",
          ]);
          explain.setAttribute("data-llm-inline-ask-model-note", "true");
          explain.textContent = note;
          menu.append(explain);
        }
        for (const group of groups) {
          const section = el("div", sectionCss);
          section.setAttribute("data-llm-inline-ask-menu-section", "true");
          section.textContent = group.label;
          menu.append(section);
          for (const option of group.options) {
            menu.append(
              menuOption(
                "data-llm-inline-ask-model-option",
                option.entryId,
                option.label,
                option.selected,
                () => {
                  picker.pickModel(option.entryId);
                  afterPick();
                },
                option.title,
              ),
            );
          }
        }
      } else {
        const { title, levels } = picker.effortMenu();
        const section = el("div", sectionCss);
        section.setAttribute("data-llm-inline-ask-menu-section", "true");
        section.textContent = title;
        menu.append(section);
        for (const level of levels) {
          menu.append(
            menuOption(
              "data-llm-inline-ask-effort-option",
              level.value,
              level.label,
              level.selected,
              () => {
                picker.pickEffort(level.value);
                afterPick();
              },
            ),
          );
        }
      }
    } catch {
      return;
    }
    button.setAttribute("aria-expanded", "true");
    button.style.color = fg;
    const rootRect = root.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    mountMenu(
      kind,
      menu,
      rect.left - rootRect.left,
      rect.bottom - rootRect.top + 4,
      rect.top - rootRect.top - 4,
    );
  };

  const refreshPrompts = () => {
    if (promptSetup) {
      try {
        shownPrompts = promptSetup.api.list();
      } catch {
        // Keep the pills shown; the prefs could not be read.
      }
    }
    renderPills();
  };
  const syncPromptEditor = () => {
    const inCompose = session.getState().phase === "compose";
    show(promptEditor, Boolean(editingPrompt) && inCompose, "flex");
    show(hint, !editingPrompt && inCompose);
  };
  const openPromptEditor = (prompt: InlineAskQuickPrompt | null) => {
    if (!promptSetup) return;
    closeMenus();
    editingPrompt = { id: prompt?.id ?? null };
    labelInput.value = prompt?.label || "";
    promptBox.setText(prompt?.prompt || "");
    renderPills();
    syncPromptEditor();
    schedule(() => {
      if (closed || !editingPrompt) return;
      labelInput.focus({ preventScroll: true });
    }, 0);
  };
  const closePromptEditor = (refocus: boolean) => {
    if (!editingPrompt) return;
    editingPrompt = null;
    renderPills();
    syncPromptEditor();
    if (!refocus) return;
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  const savePrompt = () => {
    if (!promptSetup || !editingPrompt) return;
    const value = {
      label: (labelInput.value || "").trim(),
      prompt: promptBox.readText().trim(),
    };
    if (!value.label) {
      labelInput.focus({ preventScroll: true });
      return;
    }
    if (!value.prompt) {
      promptBox.editor.focus({ preventScroll: true });
      return;
    }
    try {
      if (editingPrompt.id) promptSetup.api.edit(editingPrompt.id, value);
      else promptSetup.api.add(value);
    } catch {
      // The prefs refused the write; the pills show what is stored.
    }
    editingPrompt = null;
    refreshPrompts();
    syncPromptEditor();
    schedule(() => {
      if (closed || editingPrompt) return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  function runPromptMenuAction(action: string, promptId: string | null) {
    closeMenus();
    if (!promptSetup) return;
    const prompt = shownPrompts.find((entry) => entry.id === promptId) || null;
    if (action === "edit" && prompt) {
      openPromptEditor(prompt);
      return;
    }
    if (action === "add") {
      if (promptSetup.api.canAdd()) openPromptEditor(null);
      return;
    }
    try {
      if (action === "delete" && promptId) promptSetup.api.remove(promptId);
      else if (action === "reset") promptSetup.api.reset();
      else return;
    } catch {
      // The prefs refused the write; the pills show what is stored.
    }
    if (action === "reset" || editingPrompt?.id === promptId) {
      editingPrompt = null;
      syncPromptEditor();
    }
    refreshPrompts();
  }

  // Footer: Discard · Continue in sidebar · Save as annotation.
  const footer = el("div", ["display:none", "gap:6px", "align-items:center"]);
  footer.setAttribute("data-llm-inline-ask-footer", "true");
  const discardBtn = el(
    "button",
    buttonCss(palette, "ghost"),
  ) as HTMLButtonElement;
  discardBtn.setAttribute("type", "button");
  discardBtn.setAttribute("data-llm-inline-ask-action", "discard");
  discardBtn.textContent = labels.discard;
  const footerSpacer = el("span", ["flex:1 1 auto"]);
  const sidebarBtn = el(
    "button",
    buttonCss(palette, "ghost", ["padding:4px 6px"]),
  ) as HTMLButtonElement;
  sidebarBtn.setAttribute("type", "button");
  sidebarBtn.setAttribute("data-llm-inline-ask-action", "sidebar");
  sidebarBtn.setAttribute("title", labels.continueInSidebar);
  sidebarBtn.setAttribute("aria-label", labels.continueInSidebar);
  sidebarBtn.appendChild(sidebarIcon(doc));
  const saveBtn = el(
    "button",
    buttonCss(palette, "primary"),
  ) as HTMLButtonElement;
  saveBtn.setAttribute("type", "button");
  saveBtn.setAttribute("data-llm-inline-ask-action", "save");
  saveBtn.textContent = labels.saveAsAnnotation;
  setButtonDisabled(sidebarBtn, true);
  setButtonDisabled(saveBtn, true);
  footer.append(discardBtn, footerSpacer, sidebarBtn, saveBtn);
  // Why Continue in sidebar did not move the conversation.
  const sidebarError = el("div", [
    "display:none",
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.3",
    "overflow-wrap:anywhere",
  ]);
  sidebarError.setAttribute("data-llm-inline-ask-sidebar-error", "true");

  // ── The annotation card (Save as annotation) ───────────────────────────
  const saveSetup = input.save;
  const colors = saveSetup?.colors.length
    ? saveSetup.colors
    : [{ hex: "#ffd400", label: "" }];
  const saveView = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:8px",
    "min-width:0",
  ]);
  saveView.setAttribute("data-llm-inline-ask-save-view", "true");
  const saveHeader = el("div", [
    "display:flex",
    "align-items:center",
    "gap:7px",
    "min-width:0",
  ]);
  const colorSquare = el("button", [
    "flex:none",
    "width:14px",
    "height:14px",
    "border-radius:3px",
    "border:none",
    "padding:0",
    "cursor:pointer",
    `background:${colors[0].hex}`,
  ]) as HTMLButtonElement;
  colorSquare.setAttribute("type", "button");
  colorSquare.setAttribute("data-llm-inline-ask-color", "toggle");
  colorSquare.setAttribute("title", saveSetup?.labels.color || "");
  colorSquare.setAttribute("aria-label", saveSetup?.labels.color || "");
  colorSquare.setAttribute("aria-expanded", "false");
  const pageText = el("span", [
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.2",
    "white-space:nowrap",
  ]);
  pageText.setAttribute("data-llm-inline-ask-page", "true");
  pageText.textContent = saveSetup?.pageText || "";
  show(pageText, Boolean(saveSetup?.pageText));
  const saveHeaderSpacer = el("span", ["flex:1 1 auto"]);
  const backBtn = el(
    "button",
    buttonCss(palette, "ghost", ["padding:4px 6px"]),
  ) as HTMLButtonElement;
  backBtn.setAttribute("type", "button");
  backBtn.setAttribute("data-llm-inline-ask-save-action", "back");
  backBtn.setAttribute("title", saveSetup?.labels.back || "");
  backBtn.setAttribute("aria-label", saveSetup?.labels.back || "");
  backBtn.appendChild(closeIcon(doc));
  saveHeader.append(colorSquare, pageText, saveHeaderSpacer, backBtn);

  const colorRow = el("div", ["display:none", "gap:6px", "align-items:center"]);
  colorRow.setAttribute("data-llm-inline-ask-colors", "true");
  const colorDots: HTMLButtonElement[] = colors.map(({ hex, label }) => {
    const dot = el("button", [
      "flex:none",
      "width:12px",
      "height:12px",
      "border-radius:50%",
      "border:none",
      "padding:0",
      "cursor:pointer",
      `background:${hex}`,
    ]) as HTMLButtonElement;
    dot.setAttribute("type", "button");
    dot.setAttribute("data-llm-inline-ask-color-dot", hex);
    dot.setAttribute("title", label);
    dot.setAttribute("aria-label", label);
    colorRow.append(dot);
    return dot;
  });

  const markClamp = el("div", [
    `font-family:${PAPER_FONT}`,
    "font-size:13px",
    "line-height:1.4",
    "display:-webkit-box",
    "-webkit-box-orient:vertical",
    "-webkit-line-clamp:3",
    "overflow:hidden",
    "overflow-wrap:anywhere",
  ]);
  const mark = el("mark", [
    `background:${markBackground(colors[0].hex)}`,
    "color:inherit",
    "padding:0 1px",
  ]);
  mark.setAttribute("data-llm-inline-ask-mark", "true");
  mark.textContent = input.selectedText;
  markClamp.append(mark);

  const commentBox = createReaderOverlayEditor({
    doc,
    placeholder: saveSetup?.labels.addComment || "",
    fieldCss: [
      "position:relative",
      `border-top:1px solid ${border}`,
      "padding-top:8px",
    ],
    editorCss: [
      "min-height:18px",
      "max-height:min(240px, 40vh)",
      "overflow:auto",
      "box-sizing:border-box",
      "border:none",
      "background:transparent",
      `color:${fg}`,
      "font:inherit",
      "font-size:12px",
      "line-height:1.5",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "outline:none",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:0",
      "top:8px",
      "right:0",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      `color:${labelFg}`,
      "font-size:12px",
      "line-height:1.5",
    ],
    editorAttribute: "data-llm-inline-ask-comment",
    placeholderAttribute: "data-llm-inline-ask-comment-placeholder",
  });

  const saveError = el("div", [
    "display:none",
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.3",
    "overflow-wrap:anywhere",
  ]);
  saveError.setAttribute("data-llm-inline-ask-save-error", "true");

  const saveFooter = el("div", [
    "display:flex",
    "gap:6px",
    "align-items:center",
  ]);
  const cancelSaveBtn = el(
    "button",
    buttonCss(palette, "ghost"),
  ) as HTMLButtonElement;
  cancelSaveBtn.setAttribute("type", "button");
  cancelSaveBtn.setAttribute("data-llm-inline-ask-save-action", "cancel");
  cancelSaveBtn.textContent = saveSetup?.labels.cancel || "";
  const confirmSaveBtn = el(
    "button",
    buttonCss(palette, "primary"),
  ) as HTMLButtonElement;
  confirmSaveBtn.setAttribute("type", "button");
  confirmSaveBtn.setAttribute("data-llm-inline-ask-save-action", "save");
  confirmSaveBtn.textContent = saveSetup?.labels.save || "";
  saveFooter.append(
    el("span", ["flex:1 1 auto"]),
    cancelSaveBtn,
    confirmSaveBtn,
  );

  saveView.append(
    saveHeader,
    colorRow,
    markClamp,
    commentBox.field,
    saveError,
    saveFooter,
  );

  root.append(
    quoteSection,
    thread,
    field,
    notice,
    pills,
    hint,
    promptEditor,
    footer,
    sidebarError,
    saveView,
  );

  // ── Rendering ──────────────────────────────────────────────────────────
  const turnNodes: Array<{ node: HTMLElement; rendered: string }> = [];
  let lastPhase: InlineAskState["phase"] = "compose";

  const renderTurn = (turn: InlineAskTurn, index: number) => {
    let entry = turnNodes[index];
    if (!entry) {
      const node =
        turn.role === "user"
          ? el("div", [
              "font-weight:600",
              "white-space:pre-wrap",
              "overflow-wrap:anywhere",
            ])
          : el("div", ["line-height:1.5", "overflow-wrap:anywhere"]);
      if (turn.role === "user") {
        node.setAttribute("data-llm-inline-ask-question", "true");
        node.textContent = turn.shownText;
      }
      thread.insertBefore(node, reading);
      entry = { node, rendered: "" };
      turnNodes[index] = entry;
    }
    if (turn.role !== "assistant") return;
    const signature = `${turn.status}\u0000${turn.text}`;
    if (entry.rendered === signature) return;
    entry.rendered = signature;
    entry.node.setAttribute("data-llm-inline-ask-answer", turn.status);
    if (turn.status === "error") {
      entry.node.textContent = turn.text;
      entry.node.style.color = labelFg;
      return;
    }
    renderInlineAskAnswer(doc, entry.node, turn.text, palette);
  };

  const keepInViewport = () => {
    const vh = doc.defaultView?.innerHeight ?? 600;
    const rect = root.getBoundingClientRect();
    if (rect.top + rect.height <= vh - READER_OVERLAY_MARGIN) return;
    const top = Math.max(
      READER_OVERLAY_MARGIN,
      vh - READER_OVERLAY_MARGIN - rect.height,
    );
    root.style.top = `${Math.round(top)}px`;
  };

  // ── Save as annotation state ───────────────────────────────────────────
  let view: "thread" | "save" = "thread";
  let color = colors[0].hex;
  let colorsOpen = false;
  let saving = false;
  /** The payload of the last failed save; Save retries it unless edited. */
  let frozen: InlineAskSavePayload | null = null;

  const lastAnswerText = (): string => {
    const turns = session.getState().turns;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (
        turn.role === "assistant" &&
        turn.status === "done" &&
        turn.text.trim()
      )
        return turn.text;
    }
    return "";
  };
  const readBlockedReason = (): string | null => {
    try {
      return saveSetup?.blockedReason() ?? null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  /** Null when Save as annotation can open; else the tooltip ("" for none). */
  const saveUnavailable = (): string | null => {
    if (!saveSetup) return "";
    if (session.getState().phase !== "answered" || !lastAnswerText()) return "";
    return readBlockedReason();
  };
  const syncFooterSave = () => {
    const reason = saveUnavailable();
    setButtonDisabled(saveBtn, reason !== null);
    if (reason) saveBtn.setAttribute("title", reason);
    else saveBtn.removeAttribute("title");
  };
  const applyColor = (hex: string) => {
    color = hex;
    colorSquare.style.background = hex;
    mark.style.background = markBackground(hex);
    for (const dot of colorDots) {
      const selected =
        dot.getAttribute("data-llm-inline-ask-color-dot") === hex;
      dot.setAttribute("aria-pressed", selected ? "true" : "false");
      dot.style.boxShadow = selected ? `0 0 0 2px ${bg}, 0 0 0 3px ${fg}` : "";
    }
  };
  const setColorsOpen = (open: boolean) => {
    colorsOpen = open;
    show(colorRow, open, "flex");
    colorSquare.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const showSaveError = (text: string) => {
    saveError.textContent = text;
    show(saveError, Boolean(text));
  };
  const syncSaveButtons = () => {
    setButtonDisabled(confirmSaveBtn, saving);
    setButtonDisabled(cancelSaveBtn, saving);
    setButtonDisabled(backBtn, saving);
  };
  const applyView = () => {
    const inSave = view === "save";
    root.setAttribute("data-view", view);
    show(saveView, inSave, "flex");
    if (!inSave) return;
    closeMenus();
    for (const node of [
      quoteSection,
      thread,
      field,
      notice,
      pills,
      hint,
      promptEditor,
      footer,
      sidebarError,
    ])
      show(node, false);
  };

  // ── Continue in sidebar state ──────────────────────────────────────────
  let continuing = false;
  let sidebarErrorText = "";
  const continueTurns = () => finishedInlineAskTurns(session.getState().turns);
  const canContinue = () =>
    Boolean(input.continueInSidebar) &&
    !continuing &&
    view === "thread" &&
    session.getState().phase === "answered" &&
    continueTurns().length > 0;
  const syncSidebar = () => {
    setButtonDisabled(sidebarBtn, !canContinue());
    sidebarError.textContent = sidebarErrorText;
    show(
      sidebarError,
      Boolean(sidebarErrorText) &&
        view === "thread" &&
        session.getState().phase === "answered",
    );
  };
  const runContinue = () => {
    const run = input.continueInSidebar;
    if (!run || !canContinue()) return;
    const turns = continueTurns();
    continuing = true;
    sidebarErrorText = "";
    syncSidebar();
    syncSend();
    let pending: ReturnType<InlineAskContinueInSidebar>;
    try {
      pending = run(turns);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (result) => result,
        (error): { ok: false; error: string } => ({
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error || ""),
        }),
      )
      .then((result) => {
        if (closed) return;
        continuing = false;
        if (result.ok) {
          // The sidebar shows the conversation now.
          close();
          return;
        }
        sidebarErrorText = result.error;
        syncSidebar();
        syncSend();
      });
  };

  const render = (state: InlineAskState) => {
    const { phase, turns } = state;
    root.setAttribute("data-phase", phase);
    turns.forEach(renderTurn);
    show(thread, turns.length > 0, "flex");
    show(reading, phase === "waiting");
    const canType = phase === "compose" || phase === "answered";
    show(field, canType, "flex");
    show(pills, phase === "compose", "flex");
    if (phase !== lastPhase) {
      // A question leaves compose: the pill editor and any menu close.
      closeMenus();
      if (phase !== "compose") editingPrompt = null;
      renderPills();
    }
    syncPromptEditor();
    show(footer, phase !== "compose", "flex");
    textBox.setPlaceholder(
      phase === "compose" ? labels.placeholder : labels.followUpPlaceholder,
    );
    if (phase === "answered" && lastPhase !== "answered") {
      textBox.setText("");
      schedule(() => {
        if (closed) return;
        editor.focus({ preventScroll: true });
      }, 0);
    }
    if (phase !== "answered") sidebarErrorText = "";
    lastPhase = phase;
    syncSend();
    syncFooterSave();
    syncSidebar();
    applyView();
    thread.scrollTop = thread.scrollHeight;
    if (root.isConnected) keepInViewport();
  };

  const openSaveView = (): boolean => {
    if (view === "save" || saveUnavailable() !== null) return false;
    const draft = frozen ?? {
      color: colors[0].hex,
      comment: inlineAskAnswerToPlainText(lastAnswerText()),
    };
    applyColor(draft.color);
    commentBox.setText(draft.comment);
    setColorsOpen(false);
    showSaveError("");
    syncSaveButtons();
    view = "save";
    render(session.getState());
    schedule(() => {
      if (closed || view !== "save") return;
      commentBox.editor.focus({ preventScroll: true });
      commentBox.placeCaretAtEnd();
    }, 0);
    return true;
  };
  const closeSaveView = () => {
    if (view !== "save" || saving) return;
    view = "thread";
    render(session.getState());
    schedule(() => {
      if (closed || view !== "thread") return;
      editor.focus({ preventScroll: true });
    }, 0);
  };
  const runSave = () => {
    if (!saveSetup || view !== "save" || saving) return;
    const reason = readBlockedReason();
    if (reason) {
      showSaveError(reason);
      return;
    }
    const payload: InlineAskSavePayload = {
      color,
      comment: commentBox.readText().trim(),
    };
    frozen = payload;
    saving = true;
    showSaveError("");
    syncSaveButtons();
    let pending: Promise<InlineAskSaveResult>;
    try {
      pending = saveSetup.save({ ...payload });
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (result) => result,
        (error): InlineAskSaveResult => ({
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error || ""),
        }),
      )
      .then((result) => {
        if (closed) return;
        saving = false;
        if (result.ok) {
          // The highlight now shows natively; the card's work is done.
          close();
          return;
        }
        syncSaveButtons();
        showSaveError(result.error);
      });
  };

  // ── Events ─────────────────────────────────────────────────────────────
  let closed = false;
  let pointerDocs: Document[] = [];
  const sendTyped = () => {
    if (!canSendNow()) return;
    const text = textBox.readText().trim();
    if (!text) return;
    if (session.send(text)) textBox.setText("");
  };
  const onDocPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && root.contains(target)) return;
    closeMenus();
    // Once a question exists, a click elsewhere keeps the conversation.
    if (session.hasConversation()) return;
    close();
  };
  const onKeyDown = (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    const action = classifySelectionPromptKey(keyEvent);
    const modEnter =
      action === "submit" && Boolean(keyEvent.metaKey || keyEvent.ctrlKey);
    // Keeps bubble-phase listeners above the card out. The reader's window
    // capture listeners have already run; see createReaderOverlayEditor.
    e.stopPropagation();
    if (action === "close" && openMenu) {
      e.preventDefault();
      closeMenus();
      return;
    }
    if (editingPrompt && view === "thread") {
      const target = e.target as Node | null;
      if (action === "close") {
        e.preventDefault();
        closePromptEditor(true);
        return;
      }
      if (target && labelInput.contains(target)) {
        // Enter in Label saves; other keys type.
        if (action === "submit") {
          e.preventDefault();
          savePrompt();
        }
        return;
      }
      if (target && promptBox.editor.contains(target)) {
        // Mod+Enter in Prompt saves; Enter is a new line.
        if (modEnter) {
          e.preventDefault();
          savePrompt();
        }
        return;
      }
    }
    if (view === "save") {
      // Escape goes back to the answer; Mod+Enter saves; a plain Enter is
      // a new line in the comment (or the focused button's own key).
      if (action === "close") {
        e.preventDefault();
        closeSaveView();
      } else if (modEnter) {
        e.preventDefault();
        runSave();
      }
      return;
    }
    if (modEnter && session.getState().phase === "answered") {
      // Mod+Enter on an answer opens the save view; it never sends.
      e.preventDefault();
      openSaveView();
      return;
    }
    if (action === "close") {
      e.preventDefault();
      close();
      return;
    }
    if (action !== "submit") return;
    const target = e.target as Node | null;
    // Enter on a button belongs to the button.
    if (!target || !editor.contains(target)) return;
    e.preventDefault();
    sendTyped();
  };
  const stop = (e: Event) => e.stopPropagation();
  const onSendClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    sendTyped();
  };
  const onDiscardClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onSaveClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    openSaveView();
  };
  const onSidebarClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    runContinue();
  };
  const clickActions: Array<[HTMLElement, () => void]> = [
    [colorSquare, () => setColorsOpen(!colorsOpen)],
    [backBtn, closeSaveView],
    [cancelSaveBtn, closeSaveView],
    [confirmSaveBtn, runSave],
    ...colorDots.map((dot): [HTMLElement, () => void] => [
      dot,
      () => applyColor(dot.getAttribute("data-llm-inline-ask-color-dot")!),
    ]),
  ];
  const saveViewListeners = clickActions.map(
    ([node, run]): [HTMLElement, (e: Event) => void] => [
      node,
      (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      },
    ],
  );
  const onRootPointerDown = (e: Event) => {
    swallowPillClick = false;
    const menu = openMenu;
    if (!menu) return;
    const target = e.target as Node | null;
    if (target && menu.node.contains(target)) return;
    // The model and effort buttons toggle their own menu on click.
    if (
      menu.kind !== "prompt" &&
      target &&
      (modelLabel.contains(target) || effortLabel.contains(target))
    )
      return;
    closeMenus();
    if (menu.kind === "prompt" && target && pills.contains(target)) {
      swallowPillClick = true;
    }
  };
  const findPill = (target: unknown): HTMLElement | null => {
    for (
      let node = target as HTMLElement | null;
      node && node !== pills;
      node = node.parentNode as HTMLElement | null
    ) {
      if (
        typeof node.getAttribute === "function" &&
        node.getAttribute("data-llm-inline-ask-pill") !== null
      )
        return node;
    }
    return null;
  };
  const onPillsClick = (e: Event) => {
    const pill = findPill(e.target);
    if (!pill) return;
    e.preventDefault();
    e.stopPropagation();
    if (swallowPillClick) {
      swallowPillClick = false;
      return;
    }
    // Pills belong to the first question; they hide after it. While the
    // prompt editor is open a pill does not send.
    if (!hasModel() || editingPrompt) return;
    if (session.getState().phase !== "compose") return;
    const prompt = shownPrompts.find(
      (entry) => entry.id === pill.getAttribute("data-llm-inline-ask-pill"),
    );
    if (prompt) session.send(prompt.prompt, prompt.label);
  };
  const onPillsContextMenu = (e: Event) => {
    if (!promptSetup || session.getState().phase !== "compose") return;
    e.preventDefault();
    e.stopPropagation();
    const pill = findPill(e.target);
    const mouse = e as MouseEvent;
    const rootRect = root.getBoundingClientRect();
    openPromptMenu(
      pill?.getAttribute("data-llm-inline-ask-pill") || null,
      (Number(mouse.clientX) || rootRect.left) - rootRect.left,
      (Number(mouse.clientY) || rootRect.top) - rootRect.top,
    );
  };
  const onModelClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleModelMenu("model");
  };
  const onEffortClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleModelMenu("effort");
  };
  const onCancelPromptClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    closePromptEditor(true);
  };
  const onSavePromptClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    savePrompt();
  };
  const focusBorder = (node: HTMLElement) => ({
    focus: () => {
      node.style.borderColor = palette.accent;
    },
    blur: () => {
      node.style.borderColor = border;
    },
  });
  const labelFocus = focusBorder(labelInput);
  const promptFocus = focusBorder(promptBox.editor);
  const onEditorFocus = () => {
    field.style.borderColor = palette.accent;
  };
  const onEditorBlur = () => {
    field.style.borderColor = border;
  };

  function close() {
    if (closed) return;
    closed = true;
    // Remove the card and registry entry first: a dead nested document can
    // make the listener removals below throw.
    root.remove();
    releaseReaderOverlay(doc, handle);
    session.dispose();
    for (const pointerDoc of pointerDocs) {
      try {
        pointerDoc.removeEventListener("pointerdown", onDocPointerDown, true);
      } catch {
        // The reader recreated that view; its listeners are gone with it.
      }
    }
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("keyup", stop);
    root.removeEventListener("keypress", stop);
    sendBtn.removeEventListener("click", onSendClick);
    discardBtn.removeEventListener("click", onDiscardClick);
    saveBtn.removeEventListener("click", onSaveClick);
    sidebarBtn.removeEventListener("click", onSidebarClick);
    for (const [node, listener] of saveViewListeners)
      node.removeEventListener("click", listener);
    commentBox.detach();
    editor.removeEventListener("focus", onEditorFocus);
    editor.removeEventListener("blur", onEditorBlur);
    textBox.detach();
    root.removeEventListener("pointerdown", onRootPointerDown);
    pills.removeEventListener("click", onPillsClick);
    pills.removeEventListener("contextmenu", onPillsContextMenu);
    if (picker) {
      modelLabel.removeEventListener("click", onModelClick);
      effortLabel.removeEventListener("click", onEffortClick);
    }
    cancelPromptBtn.removeEventListener("click", onCancelPromptClick);
    savePromptBtn.removeEventListener("click", onSavePromptClick);
    labelInput.removeEventListener("focus", labelFocus.focus);
    labelInput.removeEventListener("blur", labelFocus.blur);
    promptBox.editor.removeEventListener("focus", promptFocus.focus);
    promptBox.editor.removeEventListener("blur", promptFocus.blur);
    promptBox.detach();
    input.onClose?.();
  }

  const handle: InlineAskOverlayHandle = {
    close,
    root,
    session,
    hasConversation: () => session.hasConversation(),
    keepsOpenOnNewSelection: () => session.hasConversation(),
  };

  (doc.body || doc.documentElement).appendChild(root);
  registerReaderOverlay(doc, handle);
  render(session.getState());
  positionReaderOverlay(root, doc, input.anchor);

  pointerDocs = collectPointerDocuments(doc);
  for (const pointerDoc of pointerDocs) {
    pointerDoc.addEventListener("pointerdown", onDocPointerDown, true);
  }
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  sendBtn.addEventListener("click", onSendClick);
  discardBtn.addEventListener("click", onDiscardClick);
  saveBtn.addEventListener("click", onSaveClick);
  sidebarBtn.addEventListener("click", onSidebarClick);
  for (const [node, listener] of saveViewListeners)
    node.addEventListener("click", listener);
  commentBox.attach();
  editor.addEventListener("focus", onEditorFocus);
  editor.addEventListener("blur", onEditorBlur);
  textBox.attach();
  root.addEventListener("pointerdown", onRootPointerDown);
  pills.addEventListener("click", onPillsClick);
  pills.addEventListener("contextmenu", onPillsContextMenu);
  if (picker) {
    modelLabel.addEventListener("click", onModelClick);
    effortLabel.addEventListener("click", onEffortClick);
  }
  cancelPromptBtn.addEventListener("click", onCancelPromptClick);
  savePromptBtn.addEventListener("click", onSavePromptClick);
  labelInput.addEventListener("focus", labelFocus.focus);
  labelInput.addEventListener("blur", labelFocus.blur);
  promptBox.editor.addEventListener("focus", promptFocus.focus);
  promptBox.editor.addEventListener("blur", promptFocus.blur);
  promptBox.attach();
  // Deferred so focus lands after the popup's pointerdown handler finishes.
  schedule(() => {
    if (closed) return;
    editor.focus({ preventScroll: true });
  }, 0);
  return handle;
}
