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
import type { InlineAskQuickPrompt } from "./inlineAskPrompts";
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

/** The model line: the model actually used, display only in M1. */
export type InlineAskModelLine = {
  label: string;
  effort?: string;
  title?: string;
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
  /** Null when no usable model exists. */
  model: InlineAskModelLine | null;
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
  const hasModel = Boolean(input.model);

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
    return hasModel && (phase === "compose" || phase === "answered");
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
  if (input.model) {
    const modelLabel = el("span", [...modelPairCss, "max-width:170px"]);
    modelLabel.setAttribute("data-llm-inline-ask-model", "true");
    modelLabel.textContent = input.model.label;
    if (input.model.title) modelLabel.setAttribute("title", input.model.title);
    fieldBar.append(modelLabel);
    if (input.model.effort) {
      const effortLabel = el("span", [...modelPairCss, "max-width:90px"]);
      effortLabel.setAttribute("data-llm-inline-ask-effort", "true");
      effortLabel.textContent = input.model.effort;
      effortLabel.setAttribute("title", labels.reasoningEffort);
      fieldBar.append(effortLabel);
    }
  }
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
  show(notice, !hasModel);

  // Quick prompts.
  const pills = el("div", [
    "display:flex",
    "gap:4px",
    "flex-wrap:wrap",
    "min-height:24px",
  ]);
  pills.setAttribute("data-llm-inline-ask-pills", "true");
  const pillButtons: HTMLButtonElement[] = [];
  for (const prompt of input.prompts) {
    const pill = el("button", [
      "display:inline-flex",
      "align-items:center",
      "min-height:24px",
      "padding:3px 9px",
      `border:1px solid ${border}`,
      "border-radius:999px",
      `background:${palette.fieldBg}`,
      `color:${fg}`,
      "font:inherit",
      "font-size:11px",
      "max-width:100%",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "cursor:pointer",
    ]) as HTMLButtonElement;
    pill.setAttribute("type", "button");
    pill.setAttribute("data-llm-inline-ask-pill", prompt.id);
    pill.setAttribute("title", prompt.prompt);
    pill.textContent = prompt.label;
    pill.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      // Pills belong to the first question; they hide after it.
      if (!hasModel || session.getState().phase !== "compose") return;
      session.send(prompt.prompt, prompt.label);
    });
    pill.addEventListener("mouseenter", () => {
      if (pill.disabled) return;
      pill.style.background = palette.accentTint;
      pill.style.borderColor = palette.accent;
    });
    pill.addEventListener("mouseleave", () => {
      pill.style.background = palette.fieldBg;
      pill.style.borderColor = border;
    });
    setButtonDisabled(pill, !hasModel);
    pillButtons.push(pill);
    pills.append(pill);
  }

  const hint = el("div", [
    "font-size:10px",
    `color:${labelFg}`,
    "line-height:1.25",
  ]);
  hint.setAttribute("data-llm-inline-ask-hint", "true");
  hint.textContent = labels.hint;

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
    for (const node of [
      quoteSection,
      thread,
      field,
      notice,
      pills,
      hint,
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
    show(hint, phase === "compose");
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
  // Deferred so focus lands after the popup's pointerdown handler finishes.
  schedule(() => {
    if (closed) return;
    editor.focus({ preventScroll: true });
  }, 0);
  return handle;
}
