/**
 * The note editor's inline writing popup (the DOM only; noteInlineWriting.ts
 * decides when it opens and what its actions do).
 *
 * It lives in the document around the note editor, not in the editor's own
 * iframe: focusing its composer then never moves the note's selection, which
 * stays the text the popup works on.
 *
 * Two views:
 * - menu: one row of actions (Rewrite, Expand, Proofread, Ask in sidebar)
 *   and a composer for the user's own instruction;
 * - result: the streamed answer with Replace, Insert below and Discard.
 */

import {
  inlineAskPalette,
  sendIcon,
} from "../selectionPrompt/inlineAskOverlay";
import { isDarkReaderDocument } from "../selectionPrompt/readerOverlayShared";

export type NoteInlinePopupRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type NoteInlinePopupResult = { ok: true } | { ok: false; error: string };

export type NoteInlinePopupInput = {
  /** The document around the note editor; the popup is fixed in it. */
  hostDoc: Document;
  /** The selection's box in the host document's viewport, or null. */
  readAnchor: () => NoteInlinePopupRect | null;
  /** The writing actions; each one asks the model with its instruction. */
  actions: Array<{ id: string; label: string; instruction: string }>;
  labels: {
    askInSidebar: string;
    composerPlaceholder: string;
    send: string;
    replace: string;
    insertBelow: string;
    discard: string;
    working: string;
  };
  /** Streams the answer to `instruction` about the selection. */
  /**
   * The finished answer as a change to the selection (the plugin's diff
   * view); shown for the writing actions, whose answer replaces it.
   */
  renderChange: (answer: string) => HTMLElement;
  ask: (
    instruction: string,
    onDelta: (delta: string) => void,
    signal: AbortSignal | undefined,
  ) => Promise<{ text: string; errorMessage?: string }>;
  replace: (answer: string) => Promise<NoteInlinePopupResult>;
  insertBelow: (answer: string) => Promise<NoteInlinePopupResult>;
  /** Hands the selection (and the composer's text) to the sidebar chat. */
  askInSidebar: (composerText: string) => Promise<NoteInlinePopupResult>;
  createAbortController: () => { signal?: AbortSignal; abort(): void } | null;
  onClose: () => void;
};

export type NoteInlinePopupHandle = {
  /** True once the user asked something: the popup no longer follows the
   *  note's selection and closes only on Discard, an action, or Escape. */
  isEngaged(): boolean;
  /** True while focus or the pointer works inside the popup. */
  contains(node: Node | null | undefined): boolean;
  reposition(): void;
  close(): void;
};

const HTML_NS = "http://www.w3.org/1999/xhtml";

export function openNoteInlinePopup(
  input: NoteInlinePopupInput,
): NoteInlinePopupHandle {
  const doc = input.hostDoc;
  // The Inline Ask card's look: its colors, pills, field and send circle.
  const palette = inlineAskPalette(isDarkReaderDocument(doc));
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string[] = [],
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
    if (css.length) node.setAttribute("style", css.join(";"));
    return node;
  };
  const pillCss = [
    "display:inline-flex",
    "align-items:center",
    "padding:3px 6px",
    "border:none",
    "border-radius:6px",
    "background:none",
    `color:${palette.labelFg}`,
    "font:inherit",
    "font-size:12px",
    "white-space:nowrap",
    "cursor:pointer",
  ];
  const button = (label: string, id: string) => {
    const node = el("button", pillCss);
    node.setAttribute("type", "button");
    node.setAttribute("data-llm-note-inline-action", id);
    node.textContent = label;
    node.addEventListener("mouseenter", () => {
      if (node.disabled) return;
      node.style.color = palette.fg;
      node.style.background = palette.hover;
    });
    node.addEventListener("mouseleave", () => {
      node.style.color = palette.labelFg;
      node.style.background = "none";
    });
    // Pressing a button keeps the focus (and the note's selection) put.
    node.addEventListener("mousedown", (event) => event.preventDefault());
    return node;
  };

  const root = el("div", [
    "position:fixed",
    "z-index:10000",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "width:max-content",
    "max-width:min(360px, calc(100vw - 16px))",
    "padding:10px",
    "box-sizing:border-box",
    `background:${palette.bg}`,
    `color:${palette.fg}`,
    `border:1px solid ${palette.border}`,
    "border-radius:16px",
    `box-shadow:${palette.cardShadow}`,
    "font-size:12px",
    "line-height:1.35",
  ]);
  root.setAttribute("data-llm-note-inline-popup", "true");
  // The panel's stylesheet scope: its diff colors and text sizes.
  root.className = "llm-note-inline-popup";
  root.setAttribute("data-view", "menu");

  // ── Menu view ───────────────────────────────────────────────────────────
  const menu = el("div", ["display:flex", "flex-direction:column", "gap:6px"]);
  const actionRow = el("div", [
    "display:flex",
    "flex-wrap:wrap",
    "gap:2px",
    "margin-left:-4px",
  ]);
  for (const action of input.actions) {
    const node = button(action.label, action.id);
    node.addEventListener("click", () =>
      ask(action.label, action.instruction, true),
    );
    actionRow.append(node);
  }
  const sidebarBtn = button(input.labels.askInSidebar, "ask-in-sidebar");
  actionRow.append(sidebarBtn);
  const composerRow = el("div", [
    "display:flex",
    "align-items:flex-end",
    "gap:4px",
    "box-sizing:border-box",
    "padding:4px 2px 1px 11px",
    "border-radius:14px",
    `background:${palette.fieldBg}`,
    "cursor:text",
  ]);
  const composer = el("textarea", [
    "flex:1 1 auto",
    "min-width:0",
    "border:none",
    "outline:none",
    "resize:none",
    "background:transparent",
    `color:${palette.fg}`,
    "font:inherit",
    "line-height:18px",
    "padding:4px 0",
    "max-height:96px",
  ]);
  // Zotero's window styles give a focused text field a blue ring and a
  // native frame; the field around the composer is the only frame it needs.
  for (const property of ["outline", "box-shadow", "border"])
    composer.style.setProperty(property, "none", "important");
  composer.style.setProperty("appearance", "none", "important");
  composer.style.setProperty("-moz-appearance", "none", "important");
  composer.setAttribute("rows", "1");
  composer.setAttribute("data-llm-note-inline-composer", "true");
  composer.setAttribute("placeholder", input.labels.composerPlaceholder);
  const sendBtn = el("button", [
    "flex:none",
    "width:26px",
    "height:26px",
    "margin:1px 2px 2px 0",
    "border-radius:999px",
    "border:none",
    `background:${palette.sendOffBg}`,
    `color:${palette.sendOffFg}`,
    "transition:background-color 120ms ease, color 120ms ease",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0",
    "cursor:pointer",
  ]);
  sendBtn.setAttribute("type", "button");
  sendBtn.setAttribute("data-llm-note-inline-action", "send");
  sendBtn.setAttribute("title", input.labels.send);
  sendBtn.setAttribute("aria-label", input.labels.send);
  sendBtn.appendChild(sendIcon(doc));
  sendBtn.addEventListener("mousedown", (event) => event.preventDefault());
  const syncSend = () => {
    const ready = Boolean(composer.value.trim());
    sendBtn.disabled = !ready;
    sendBtn.style.background = ready ? palette.sendBg : palette.sendOffBg;
    sendBtn.style.color = ready ? palette.sendFg : palette.sendOffFg;
    sendBtn.style.cursor = ready ? "pointer" : "default";
  };
  composerRow.addEventListener("mousedown", (event) => {
    if (event.target === composerRow) {
      event.preventDefault();
      composer.focus();
    }
  });
  composerRow.append(composer, sendBtn);
  menu.append(actionRow, composerRow);

  // ── Result view ─────────────────────────────────────────────────────────
  const result = el("div", [
    "display:none",
    "flex-direction:column",
    "gap:6px",
    "width:340px",
    "max-width:100%",
  ]);
  const resultTitle = el("div", [`color:${palette.labelFg}`]);
  const resultText = el("div", [
    "font-size:13px",
    "line-height:1.45",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "max-height:240px",
    "overflow:auto",
  ]);
  resultText.setAttribute("data-llm-note-inline-answer", "true");
  const resultError = el("div", ["display:none", `color:${palette.labelFg}`]);
  resultError.setAttribute("data-llm-note-inline-error", "true");
  const resultActions = el("div", [
    "display:flex",
    "gap:2px",
    "margin-left:-4px",
  ]);
  const replaceBtn = button(input.labels.replace, "replace");
  const insertBtn = button(input.labels.insertBelow, "insert-below");
  const spacer = el("span", ["flex:1 1 auto"]);
  const discardBtn = button(input.labels.discard, "discard");
  resultActions.append(replaceBtn, insertBtn, spacer, discardBtn);
  const resultChange = el("div", [
    "display:none",
    "max-height:240px",
    "overflow:auto",
  ]);
  resultChange.setAttribute("data-llm-note-inline-change", "true");
  result.append(
    resultTitle,
    resultText,
    resultChange,
    resultError,
    resultActions,
  );

  root.append(menu, result);
  (doc.documentElement || doc.body)!.appendChild(root);

  let closed = false;
  let engaged = false;
  let streaming = false;
  let acting = false;
  let answer = "";
  let abort: { signal?: AbortSignal; abort(): void } | null = null;

  const setError = (text: string) => {
    resultError.textContent = text;
    resultError.style.display = text ? "block" : "none";
  };
  const syncResultButtons = () => {
    const ready = !streaming && !acting && Boolean(answer.trim());
    for (const node of [replaceBtn, insertBtn]) {
      node.disabled = !ready;
      node.style.opacity = ready ? "1" : "0.45";
      node.style.cursor = ready ? "pointer" : "default";
    }
    discardBtn.disabled = acting;
  };

  const reposition = () => {
    if (closed) return;
    const anchor = input.readAnchor();
    const view = doc.defaultView;
    if (!anchor || !view) return;
    const width = root.offsetWidth || 300;
    const height = root.offsetHeight || 80;
    const left = Math.max(
      8,
      Math.min(anchor.left, view.innerWidth - width - 8),
    );
    // Below the selection, or above it when there is no room below.
    let top = anchor.bottom + 6;
    if (top + height > view.innerHeight - 8 && anchor.top - height - 6 > 8)
      top = anchor.top - height - 6;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(Math.max(8, top))}px`;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    abort?.abort();
    doc.removeEventListener("keydown", onKeyDown, true);
    root.remove();
    input.onClose();
  };

  const ask = (title: string, instruction: string, showChange: boolean) => {
    if (closed || engaged || !instruction.trim()) return;
    engaged = true;
    streaming = true;
    answer = "";
    root.setAttribute("data-view", "result");
    menu.style.display = "none";
    result.style.display = "flex";
    resultTitle.textContent = title;
    resultText.textContent = input.labels.working;
    resultText.style.color = palette.labelFg;
    setError("");
    syncResultButtons();
    reposition();
    abort = input.createAbortController();
    void input
      .ask(
        instruction,
        (delta) => {
          if (closed) return;
          answer += delta;
          resultText.style.color = palette.fg;
          resultText.textContent = answer;
          reposition();
        },
        abort?.signal,
      )
      .then(
        (outcome) => outcome,
        (error) => ({
          text: "",
          errorMessage: String((error as Error)?.message || error || ""),
        }),
      )
      .then((outcome) => {
        if (closed) return;
        streaming = false;
        answer = outcome.text || answer;
        resultText.style.color = palette.fg;
        resultText.textContent = answer;
        if (!answer.trim()) {
          resultText.textContent = "";
          setError(outcome.errorMessage || "The model returned no answer.");
        } else if (showChange) {
          resultChange.replaceChildren(input.renderChange(answer));
          resultChange.style.display = "block";
          resultText.style.display = "none";
        }
        root.setAttribute("data-phase", "answered");
        syncResultButtons();
        reposition();
      });
  };

  const runAction = (
    run: () => Promise<NoteInlinePopupResult>,
    onError: (message: string) => void,
  ) => {
    if (closed || acting) return;
    acting = true;
    syncResultButtons();
    void run()
      .catch(
        (error): NoteInlinePopupResult => ({
          ok: false,
          error: String((error as Error)?.message || error || ""),
        }),
      )
      .then((outcome) => {
        if (closed) return;
        acting = false;
        syncResultButtons();
        if (outcome.ok) close();
        else onError(outcome.error);
      });
  };

  const sendComposer = () => {
    const text = composer.value.trim();
    if (text) ask(text, text, false);
  };
  sendBtn.addEventListener("click", sendComposer);
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendComposer();
    }
  });
  composer.addEventListener("input", () => {
    syncSend();
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 96)}px`;
  });
  sidebarBtn.addEventListener("click", () =>
    runAction(
      () => input.askInSidebar(composer.value.trim()),
      (message) => {
        composer.setAttribute("placeholder", message);
      },
    ),
  );
  replaceBtn.addEventListener("click", () =>
    runAction(() => input.replace(answer), setError),
  );
  insertBtn.addEventListener("click", () =>
    runAction(() => input.insertBelow(answer), setError),
  );
  discardBtn.addEventListener("click", () => close());
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !closed) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);

  syncResultButtons();
  syncSend();
  reposition();

  return {
    isEngaged: () => engaged,
    contains: (node) => Boolean(node && root.contains(node)),
    reposition,
    close,
  };
}
