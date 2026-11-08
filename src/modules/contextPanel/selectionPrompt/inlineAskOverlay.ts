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
 * Close policy: before the first question an outside pointerdown closes the
 * card, as the Add Text prompt does. Once a question exists, only Escape,
 * Discard, or another overlay on the same document closes it; a new text
 * selection popup leaves it open (keepsOpenOnNewSelection).
 *
 * Inline styles only: plugin CSS does not reach reader documents.
 */
import { renderInlineAskAnswer } from "./inlineAskAnswerRender";
import type { InlineAskQuickPrompt } from "./inlineAskPrompts";
import {
  createInlineAskSession,
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
  // Continue in sidebar (M3) and Save as annotation (M2) are not wired yet.
  setButtonDisabled(sidebarBtn, true);
  setButtonDisabled(saveBtn, true);
  footer.append(discardBtn, footerSpacer, sidebarBtn, saveBtn);

  root.append(quoteSection, thread, field, notice, pills, hint, footer);

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
    lastPhase = phase;
    syncSend();
    thread.scrollTop = thread.scrollHeight;
    if (root.isConnected) keepInViewport();
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
    const action = classifySelectionPromptKey(e as KeyboardEvent);
    // Keeps bubble-phase listeners above the card out. The reader's window
    // capture listeners have already run; see createReaderOverlayEditor.
    e.stopPropagation();
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
