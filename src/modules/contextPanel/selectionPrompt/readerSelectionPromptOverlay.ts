import type { IncludeReaderSelectedTextOutcome } from "../readerTextInclusion";
import { classifySelectionPromptKey } from "./selectionPromptKeys";
import {
  closeAllReaderOverlays,
  closeReaderOverlay,
  collectPointerDocuments,
  countOpenReaderOverlays,
  createReaderOverlayEditor,
  createReaderOverlayElementFactory,
  isDarkReaderDocument,
  positionReaderOverlay,
  prepareReaderOverlaySlot,
  readerOverlayHoldsWork,
  readerOverlayPalette,
  readerOverlayScheduler,
  registerReaderOverlay,
  releaseReaderOverlay,
  type ReaderOverlayAnchor,
  type ReaderOverlayHandle,
} from "./readerOverlayShared";

export type ReaderSelectionPromptAnchor = ReaderOverlayAnchor;

export type ReaderSelectionPromptOverlayInput = {
  /** Reader popup document (the renderTextSelectionPopup event's doc). */
  doc: Document;
  /** "Add Text" button rect in viewport coordinates, measured at pointerdown. */
  anchor: ReaderSelectionPromptAnchor;
  /** The selection the box asks about, shown above the editor. */
  selectedText: string;
  /** Editor text at open (the chip's current question), caret at the end. */
  initialText?: string;
  labels: {
    placeholder: string;
    hint: string;
    /** The button label ("Add"). */
    submit: string;
    /** Label above the quoted selection ("Selected text"). */
    selectedTextLabel: string;
    /** Shown in place of the hint when onSubmit refuses the text. */
    chipGone?: string;
  };
  /**
   * Receives non-empty, trimmed text. `send` is true for Cmd/Ctrl+Enter.
   * Return false when the text was not accepted; the box then stays open.
   */
  onSubmit: (text: string, options: { send: boolean }) => boolean;
  /** Called exactly once on any close path. */
  onClose: () => void;
};

export type ReaderSelectionPromptOverlayHandle = ReaderOverlayHandle;

/**
 * Plugin-owned floating prompt box for the reader (D6). It lives outside
 * Zotero's selection popup, so popup teardown cannot remove it. One overlay
 * per document; a new one replaces the old one. Plugin CSS never reaches
 * reader documents, so every style is inline.
 */
export function openReaderSelectionPromptOverlay(
  input: ReaderSelectionPromptOverlayInput,
): ReaderSelectionPromptOverlayHandle {
  const { doc, anchor, labels } = input;
  prepareReaderOverlaySlot(doc);

  const { bg, fg, border, fieldBg, quoteFg, labelFg } = readerOverlayPalette(
    isDarkReaderDocument(doc),
  );

  const el = createReaderOverlayElementFactory(doc);
  const root = el("div", [
    "position:fixed",
    "z-index:10000",
    "display:flex",
    "flex-direction:column",
    "gap:4px",
    "width:320px",
    "max-width:calc(100vw - 16px)",
    "padding:8px",
    "box-sizing:border-box",
    `background:${bg}`,
    `color:${fg}`,
    `border:1px solid ${border}`,
    "border-radius:10px",
    "box-shadow:0 6px 18px rgba(0,0,0,0.22)",
    "font-size:12px",
    "line-height:1.3",
    "user-select:text",
    "-moz-user-select:text",
  ]);
  root.setAttribute("data-llm-reader-selection-prompt", "true");
  const quoteLabel = el("div", [
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.2",
  ]);
  quoteLabel.setAttribute(
    "data-llm-reader-selection-prompt-quote-label",
    "true",
  );
  quoteLabel.textContent = labels.selectedTextLabel;
  // The selection, clamped to four lines and dimmed against the editor.
  const quote = el("div", [
    `color:${quoteFg}`,
    "font-size:12px",
    "line-height:1.3",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "display:-webkit-box",
    "-webkit-box-orient:vertical",
    "-webkit-line-clamp:4",
    "overflow:hidden",
  ]);
  quote.setAttribute("data-llm-reader-selection-prompt-quote", "true");
  quote.textContent = input.selectedText;
  const row = el("div", ["display:flex", "gap:6px", "align-items:flex-end"]);
  // A contenteditable="true" div, not a <textarea>; see
  // createReaderOverlayEditor for the reader KeyboardManager reason.
  const textBox = createReaderOverlayEditor({
    doc,
    placeholder: labels.placeholder,
    fieldCss: ["position:relative", "flex:1 1 auto", "min-width:0"],
    editorCss: [
      "min-height:24px",
      "max-height:120px",
      "overflow-y:auto",
      "box-sizing:border-box",
      "padding:4px 6px",
      `border:1px solid ${border}`,
      "border-radius:6px",
      `background:${fieldBg}`,
      `color:${fg}`,
      "font:inherit",
      "font-size:12px",
      "line-height:1.3",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "outline:none",
      "cursor:text",
    ],
    placeholderCss: [
      "position:absolute",
      "left:7px",
      "top:5px",
      "right:7px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "pointer-events:none",
      "opacity:0.55",
      "font-size:12px",
      "line-height:1.3",
    ],
    editorAttribute: "data-llm-reader-selection-prompt-editor",
    placeholderAttribute: "data-llm-reader-selection-prompt-placeholder",
  });
  const { field, editor } = textBox;
  const submitBtn = el("button", [
    "flex:0 0 auto",
    "padding:4px 8px",
    `border:1px solid ${border}`,
    "border-radius:6px",
    `background:${fieldBg}`,
    `color:${fg}`,
    "font-size:12px",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  submitBtn.setAttribute("type", "button");
  submitBtn.textContent = labels.submit;
  submitBtn.setAttribute("title", labels.submit);
  const hint = el("span", [
    "font-size:10px",
    "line-height:1.25",
    `color:${labelFg}`,
  ]);
  hint.setAttribute("data-llm-reader-selection-prompt-hint", "true");
  hint.textContent = labels.hint;
  row.append(field, submitBtn);
  const quoteSection = el("div", [
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "min-width:0",
  ]);
  quoteSection.append(quoteLabel, quote);
  root.append(quoteSection, row, hint);

  let closed = false;
  let pointerDocs: Document[] = [];
  const onDocPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && root.contains(target)) return;
    close();
  };
  if (input.initialText) textBox.setText(input.initialText);
  const submit = (send = false) => {
    const text = textBox.readText().trim();
    if (!text) {
      close();
      return;
    }
    if (input.onSubmit(text, { send })) {
      close();
      return;
    }
    if (labels.chipGone) hint.textContent = labels.chipGone;
  };
  const onKeyDown = (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    const action = classifySelectionPromptKey(keyEvent);
    // Keeps bubble-phase listeners above the box out. The reader's window
    // capture listeners have already run; see the editor comment above.
    e.stopPropagation();
    if (action === "other" || action === "newline") return;
    e.preventDefault();
    if (action === "close") {
      close();
      return;
    }
    // Cmd/Ctrl+Enter attaches the question and sends it; Enter only attaches.
    submit(Boolean(keyEvent.metaKey || keyEvent.ctrlKey));
  };
  const onSubmitClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    submit();
  };
  const stop = (e: Event) => e.stopPropagation();

  function close() {
    if (closed) return;
    closed = true;
    // Remove the box and registry entry first: a dead nested document can
    // make the listener removals below throw.
    root.remove();
    releaseReaderOverlay(doc, handle);
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
    submitBtn.removeEventListener("click", onSubmitClick);
    textBox.detach();
    input.onClose();
  }
  const handle: ReaderSelectionPromptOverlayHandle = { close, root };

  (doc.body || doc.documentElement).appendChild(root);
  registerReaderOverlay(doc, handle);

  // Position after mount so the measured size is real.
  positionReaderOverlay(root, doc, anchor);

  // Clicks on the PDF page land in the nested view iframe, not in `doc`.
  pointerDocs = collectPointerDocuments(doc);
  for (const pointerDoc of pointerDocs) {
    pointerDoc.addEventListener("pointerdown", onDocPointerDown, true);
  }
  // On the root, so Escape and Enter also work with focus on the button.
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  submitBtn.addEventListener("click", onSubmitClick);
  textBox.attach();
  // Deferred so focus lands after the Add Text handler finishes.
  readerOverlayScheduler(doc)(() => {
    if (closed) return;
    editor.focus({ preventScroll: true });
    textBox.placeCaretAtEnd();
  }, 0);
  return handle;
}

/** Closes any overlay currently open on `doc`. Safe when none is open. */
export function closeReaderSelectionPromptOverlay(doc: Document): void {
  closeReaderOverlay(doc);
}

/** Closes every open overlay (plugin shutdown). */
export function closeAllReaderSelectionPromptOverlays(): void {
  closeAllReaderOverlays();
}

/** Test seam: how many overlays are open. */
export function countOpenReaderSelectionPromptOverlays(): number {
  return countOpenReaderOverlays();
}

/**
 * Opens the reader prompt for the chip that Add Text just made, or for the
 * chip that already held this text (a duplicate add). The box starts with
 * that chip's question, if any. Enter attaches the typed text to that chip
 * as its question; Cmd/Ctrl+Enter attaches it and then calls `send`.
 * `attach` returns false when no chip took the text, and the box then stays
 * open and nothing is sent.
 *
 * An Inline Ask card that holds a conversation keeps the document's slot:
 * the chip is already in the panel, and the box does not open (null).
 */
export function openReaderSelectionPromptForChip(input: {
  doc: Document;
  anchor: ReaderSelectionPromptAnchor;
  outcome: IncludeReaderSelectedTextOutcome | null | undefined;
  /** The normalized chip text (IncludeReaderSelectedTextResult.selectedText). */
  selectedText: string;
  /** The chip's current question; the box opens with it to edit. */
  existingQuestion?: string;
  labels: ReaderSelectionPromptOverlayInput["labels"];
  attach: (text: string) => boolean;
  /** Sends the panel's message, with the chip that now holds the question. */
  send: () => void;
}): ReaderSelectionPromptOverlayHandle | null {
  if (input.outcome !== "added" && input.outcome !== "duplicate") return null;
  if (!input.selectedText.trim()) return null;
  if (readerOverlayHoldsWork(input.doc)) return null;
  return openReaderSelectionPromptOverlay({
    doc: input.doc,
    anchor: input.anchor,
    selectedText: input.selectedText,
    initialText: input.existingQuestion,
    labels: input.labels,
    onSubmit: (text, { send }) => {
      if (!input.attach(text)) return false;
      if (send) input.send();
      return true;
    },
    onClose: () => {},
  });
}
