/**
 * Helpers shared by the plugin's floating boxes in Zotero's reader document:
 * the Add Text prompt (readerSelectionPromptOverlay.ts) and the Inline Ask
 * card (inlineAskOverlay.ts).
 *
 * Plugin CSS never reaches reader documents, so every style is inline. One
 * overlay per document: opening one closes the one that is there.
 */

export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const READER_OVERLAY_MARGIN = 8;
export const READER_OVERLAY_GAP = 6;
const OVERLAY_KEY = "__llmReaderSelectionPromptOverlay";

export type ReaderOverlayAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /**
   * Set when the overlay takes this box's place instead of opening below
   * it: "top" puts its top-left corner on the box's top-left corner,
   * "bottom" its bottom-left corner on the box's bottom-left corner.
   */
  cover?: "top" | "bottom";
};

export type ReaderOverlayHandle = {
  close(): void;
  root: HTMLElement;
  /**
   * True when a new text selection popup must leave this overlay open (an
   * Inline Ask card that holds a conversation). Absent means it closes.
   */
  keepsOpenOnNewSelection?: () => boolean;
};

type DocWithOverlay = Document & {
  [OVERLAY_KEY]?: ReaderOverlayHandle;
};

/**
 * Every open overlay and its document, so plugin shutdown can close them
 * all. Entries whose reader document lost its window (tab closed) are
 * dropped at the next open, so the registry does not keep dead documents.
 */
const openOverlays = new Map<ReaderOverlayHandle, Document>();

function pruneDeadOverlays(): void {
  for (const [handle, doc] of Array.from(openOverlays)) {
    let alive = false;
    try {
      alive = Boolean(doc.defaultView);
    } catch {
      alive = false;
    }
    if (alive) continue;
    openOverlays.delete(handle);
    try {
      handle.close();
    } catch {
      // The document is gone; nothing left to detach.
    }
  }
}

/** Frees the document's slot for a new overlay: closes the one open there. */
export function prepareReaderOverlaySlot(doc: Document): void {
  pruneDeadOverlays();
  (doc as DocWithOverlay)[OVERLAY_KEY]?.close();
}

/** Puts a mounted overlay into the document's slot and the registry. */
export function registerReaderOverlay(
  doc: Document,
  handle: ReaderOverlayHandle,
): void {
  (doc as DocWithOverlay)[OVERLAY_KEY] = handle;
  openOverlays.set(handle, doc);
}

/** Removes a closing overlay from the registry and its document's slot. */
export function releaseReaderOverlay(
  doc: Document,
  handle: ReaderOverlayHandle,
): void {
  openOverlays.delete(handle);
  if ((doc as DocWithOverlay)[OVERLAY_KEY] === handle) {
    delete (doc as DocWithOverlay)[OVERLAY_KEY];
  }
}

/** The overlay open on `doc`, if any. */
export function getReaderOverlay(doc: Document): ReaderOverlayHandle | null {
  return (doc as DocWithOverlay)[OVERLAY_KEY] || null;
}

/** Closes any overlay open on `doc`. Safe when none is open. */
export function closeReaderOverlay(doc: Document): void {
  (doc as DocWithOverlay)[OVERLAY_KEY]?.close();
}

/**
 * True when the overlay on `doc` holds work the user has not finished (an
 * Inline Ask card with a conversation; it says so itself).
 */
export function readerOverlayHoldsWork(doc: Document): boolean {
  const handle = (doc as DocWithOverlay)[OVERLAY_KEY];
  if (!handle) return false;
  try {
    return Boolean(handle.keepsOpenOnNewSelection?.());
  } catch {
    return false;
  }
}

/**
 * A new selection popup closes the overlay on `doc`, unless the overlay
 * holds work the user has not finished.
 */
export function closeReaderOverlayForNewSelection(doc: Document): void {
  if (readerOverlayHoldsWork(doc)) return;
  (doc as DocWithOverlay)[OVERLAY_KEY]?.close();
}

/** Closes every open overlay (plugin shutdown). */
export function closeAllReaderOverlays(): void {
  for (const handle of Array.from(openOverlays.keys())) {
    try {
      handle.close();
    } catch {
      // A torn-down reader document; nothing left to detach.
    }
  }
  openOverlays.clear();
}

/** Test seam: how many overlays are open. */
export function countOpenReaderOverlays(): number {
  return openOverlays.size;
}

/**
 * `doc` plus every same-origin iframe document nested in it. The reader UI
 * document hosts the popup, but the PDF page lives in a nested view iframe,
 * and pointer events there never reach `doc`.
 */
export function collectPointerDocuments(doc: Document, depth = 3): Document[] {
  const docs: Document[] = [doc];
  if (depth <= 0) return docs;
  let frames: ArrayLike<HTMLIFrameElement> = [];
  try {
    frames = doc.querySelectorAll?.("iframe") ?? [];
  } catch {
    return docs;
  }
  for (const frame of Array.from(frames)) {
    let inner: Document | null = null;
    try {
      inner = frame.contentDocument;
    } catch {
      continue; // cross-origin
    }
    if (inner && !docs.includes(inner)) {
      for (const nested of collectPointerDocuments(inner, depth - 1)) {
        if (!docs.includes(nested)) docs.push(nested);
      }
    }
  }
  return docs;
}

export function isDarkReaderDocument(doc: Document): boolean {
  try {
    return Boolean(
      doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")?.matches,
    );
  } catch {
    return false;
  }
}

/** The reader overlay colors for one theme. */
export type ReaderOverlayPalette = {
  bg: string;
  fg: string;
  border: string;
  fieldBg: string;
  quoteFg: string;
  labelFg: string;
  /** Icon color of a bare control (the send button). */
  fill2: string;
  /** Icon color of a disabled bare control. */
  fill3: string;
  accent: string;
  accentTint: string;
  accentFg: string;
  hover: string;
};

export function readerOverlayPalette(dark: boolean): ReaderOverlayPalette {
  return dark
    ? {
        bg: "#2b2b2b",
        fg: "#e6e6e6",
        border: "rgba(255,255,255,0.18)",
        fieldBg: "#1f1f1f",
        quoteFg: "#b3b3b3",
        labelFg: "#8f8f8f",
        fill2: "#a8a8ad",
        fill3: "#5c5c60",
        accent: "#0a84ff",
        accentTint: "rgba(10,132,255,0.16)",
        accentFg: "#ffffff",
        hover: "rgba(255,255,255,0.08)",
      }
    : {
        bg: "#ffffff",
        fg: "#1f1f1f",
        border: "rgba(0,0,0,0.18)",
        fieldBg: "#f6f6f6",
        quoteFg: "#5b5b5b",
        labelFg: "#7a7a7a",
        fill2: "#6e6e73",
        fill3: "#b0b0b5",
        accent: "#3478f6",
        accentTint: "rgba(52,120,246,0.1)",
        accentFg: "#ffffff",
        hover: "rgba(0,0,0,0.06)",
      };
}

/** Builds XHTML elements in `doc` with an inline style. */
export function createReaderOverlayElementFactory(doc: Document) {
  return (tag: string, css: string[]): HTMLElement => {
    const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
    node.style.cssText = css.join(";");
    return node;
  };
}

/**
 * Places a mounted overlay below the anchor, or above it when there is no
 * room below, clamped into the viewport. An anchor with `cover` is a box the
 * overlay replaces: the overlay takes its place, at the box's unrounded
 * edges so they line up with it exactly. Call after mount so the measured
 * size is real.
 */
export function positionReaderOverlay(
  root: HTMLElement,
  doc: Document,
  anchor: ReaderOverlayAnchor,
): void {
  const view = doc.defaultView;
  const vw = view?.innerWidth ?? 800;
  const vh = view?.innerHeight ?? 600;
  const rect = root.getBoundingClientRect();
  let top: number;
  if (anchor.cover === "top") {
    top = anchor.top;
  } else if (anchor.cover === "bottom") {
    top = anchor.bottom - rect.height;
  } else {
    top = anchor.bottom + READER_OVERLAY_GAP;
    if (top + rect.height > vh - READER_OVERLAY_MARGIN) {
      top = anchor.top - READER_OVERLAY_GAP - rect.height;
    }
  }
  top = Math.max(
    READER_OVERLAY_MARGIN,
    Math.min(top, vh - READER_OVERLAY_MARGIN - rect.height),
  );
  const left = Math.max(
    READER_OVERLAY_MARGIN,
    Math.min(anchor.left, vw - READER_OVERLAY_MARGIN - rect.width),
  );
  const px = (n: number) => `${anchor.cover ? n : Math.round(n)}px`;
  root.style.left = px(left);
  root.style.top = px(top);
}

/** A `setTimeout` bound to the document's window (Gecko chrome needs it). */
export function readerOverlayScheduler(
  doc: Document,
): (fn: () => void, ms: number) => unknown {
  const view = doc.defaultView;
  // Bind: calling a window's setTimeout unbound throws in Gecko chrome.
  return view
    ? (view.setTimeout.bind(view) as (fn: () => void, ms: number) => unknown)
    : (fn, ms) => setTimeout(fn, ms);
}

export type ReaderOverlayEditor = {
  field: HTMLElement;
  editor: HTMLElement;
  placeholder: HTMLElement;
  /** The typed text; innerText keeps Shift+Enter line breaks as "\n". */
  readText(): string;
  setText(text: string): void;
  setPlaceholder(text: string): void;
  syncPlaceholder(): void;
  /** Puts the caret after the text, so typing extends it. */
  placeCaretAtEnd(): void;
  /** Starts the input and paste listeners. */
  attach(): void;
  /** Removes the listeners that attach added. */
  detach(): void;
};

/**
 * The text field both reader boxes use: a contenteditable="true" div with an
 * overlaid placeholder and plain-text paste.
 *
 * It is not a <textarea>: Zotero's reader KeyboardManager and FocusManager
 * listen for keydown on the reader window in the capture phase, before any
 * listener here, and they skip only <input type=text> and
 * contenteditable="true" targets. A <textarea> there loses Cmd/Ctrl+A, arrow
 * keys, Alt+digits, "h", "s", and digits to reader shortcuts.
 * ("plaintext-only" fails their exact "true" check.)
 */
export function createReaderOverlayEditor(params: {
  doc: Document;
  placeholder: string;
  fieldCss: string[];
  editorCss: string[];
  placeholderCss: string[];
  editorAttribute: string;
  placeholderAttribute: string;
  /** Called after each input or paste. */
  onInput?: () => void;
}): ReaderOverlayEditor {
  const { doc } = params;
  const el = createReaderOverlayElementFactory(doc);
  const field = el("div", params.fieldCss);
  const editor = el("div", params.editorCss);
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("aria-placeholder", params.placeholder);
  editor.setAttribute(params.editorAttribute, "true");
  const placeholder = el("span", params.placeholderCss);
  placeholder.setAttribute(params.placeholderAttribute, "true");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = params.placeholder;
  field.append(editor, placeholder);

  const readText = () => editor.innerText ?? editor.textContent ?? "";
  const syncPlaceholder = () => {
    placeholder.style.display = editor.textContent ? "none" : "";
  };
  const onInput = () => {
    syncPlaceholder();
    params.onInput?.();
  };
  const placeCaretAtEnd = () => {
    if (!editor.textContent) return;
    try {
      const range = doc.createRange?.();
      const selection = doc.defaultView?.getSelection?.();
      if (!range || !selection) return;
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Focus alone still lets the user edit the text.
    }
  };
  const onPaste = (e: Event) => {
    // Rich paste would put markup into the box; keep it plain text.
    const text = (e as ClipboardEvent).clipboardData?.getData("text/plain");
    e.preventDefault();
    if (!text) return;
    let inserted = false;
    try {
      inserted = doc.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) editor.textContent = `${editor.textContent || ""}${text}`;
    onInput();
  };
  return {
    field,
    editor,
    placeholder,
    readText,
    setText: (text) => {
      editor.textContent = text;
      syncPlaceholder();
    },
    setPlaceholder: (text) => {
      placeholder.textContent = text;
      editor.setAttribute("aria-placeholder", text);
    },
    syncPlaceholder,
    placeCaretAtEnd,
    attach: () => {
      editor.addEventListener("input", onInput);
      editor.addEventListener("paste", onPaste);
    },
    detach: () => {
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("paste", onPaste);
    },
  };
}
