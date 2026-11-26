/**
 * The note editor's inline writing popup (the DOM only; noteInlineWriting.ts
 * decides when it opens and what its actions do).
 *
 * It lives in the document around the note editor, not in the editor's own
 * iframe: focusing its composer then never moves the note's selection, which
 * stays the text the popup works on.
 *
 * Two views:
 * - menu: one row of actions (the user's writing shortcuts, then Ask in
 *   sidebar) and a composer for the user's own instruction. Right-clicking
 *   a shortcut opens Edit, Delete, Add and Reset (Add and Reset on the
 *   rest of the row), as on Inline Ask's pills;
 * - result: the streamed answer with Replace, Insert below and Discard.
 *
 * In both views a floating close button shows on the top-left corner while
 * the pointer is near it.
 */

import {
  inlineAskPalette,
  sendIcon,
  type InlineAskModelPicker,
} from "../selectionPrompt/inlineAskOverlay";
import { buildInlineAskModelMenu } from "../selectionPrompt/inlineAskModelMenu";
import {
  applyQuickPromptMenuAction,
  buildQuickPromptMenu,
  createQuickPromptEditorPanel,
  type QuickPromptEditingSetup,
  type QuickPromptMenuAction,
} from "../selectionPrompt/quickPromptEditingUi";
import type { QuickPrompt } from "../selectionPrompt/quickPromptStore";
import { isDarkReaderDocument } from "../selectionPrompt/readerOverlayShared";
import { createInlineCardCloseButton } from "../selectionPrompt/inlineCardCloseButton";

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
  /** The writing shortcuts; each one asks the model with its prompt. */
  prompts: QuickPrompt[];
  /** What a shortcut asks the model. */
  instructionFor: (prompt: QuickPrompt) => string;
  /** Right-click editing of the shortcuts. */
  promptEditing: QuickPromptEditingSetup;
  labels: {
    askInSidebar: string;
    composerPlaceholder: string;
    send: string;
    reasoningEffort: string;
    replace: string;
    insertBelow: string;
    discard: string;
    /** The floating close button's tooltip. */
    close: string;
    working: string;
  };
  /** The model and effort the answer uses, shown and picked in the field. */
  modelPicker: InlineAskModelPicker;
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
   *  note's selection and closes only on Discard, the close button, an
   *  action, or Escape. */
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
  const sidebarBtn = button(input.labels.askInSidebar, "ask-in-sidebar");
  let shownPrompts = input.prompts.slice();
  /** The shortcut the editor is open for; id null for Add. */
  let editingPrompt: { id: string | null } | null = null;
  const renderPrompts = () => {
    for (let child = actionRow.firstChild; child; child = actionRow.firstChild)
      actionRow.removeChild(child);
    for (const prompt of shownPrompts) {
      const node = button(prompt.label, prompt.id);
      node.setAttribute("data-llm-note-inline-prompt", prompt.id);
      // The tooltip is the prompt the shortcut sends.
      node.setAttribute("title", prompt.prompt);
      if (editingPrompt?.id === prompt.id) {
        node.setAttribute("data-editing", "true");
        node.style.background = palette.hover;
      }
      node.addEventListener("click", () => {
        if (editingPrompt || promptMenu) return;
        ask(prompt.label, input.instructionFor(prompt), true);
      });
      actionRow.append(node);
    }
    actionRow.append(sidebarBtn);
  };
  renderPrompts();
  // The Inline Ask card's field: the text, then a bar with the model, the
  // effort and the send circle.
  const composerRow = el("div", [
    "position:relative",
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "box-sizing:border-box",
    "padding:7px 4px 3px 11px",
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
    "padding:0 7px 0 0",
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
    "margin:1px 2px 1px 0",
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
    if (event.target === composerRow || event.target === fieldBar) {
      event.preventDefault();
      composer.focus();
    }
  });
  const fieldBar = el("div", [
    "display:flex",
    "align-items:center",
    "min-height:28px",
    "margin-left:-4px",
    "min-width:0",
    "cursor:default",
  ]);
  const modelPairCss = [
    `color:${palette.fill2}`,
    "font-weight:600",
    "font-size:11px",
    "line-height:1",
    "padding:5px 4px",
    "border-radius:5px",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "border:none",
    "background:transparent",
    "font-family:inherit",
    "margin:0",
    "cursor:pointer",
  ];
  const modelLabel = el("button", [...modelPairCss, "max-width:170px"]);
  modelLabel.setAttribute("data-llm-inline-ask-model", "true");
  const effortLabel = el("button", [...modelPairCss, "max-width:90px"]);
  effortLabel.setAttribute("data-llm-inline-ask-effort", "true");
  effortLabel.setAttribute("title", input.labels.reasoningEffort);
  for (const node of [modelLabel, effortLabel]) {
    node.setAttribute("type", "button");
    node.setAttribute("aria-haspopup", "menu");
    node.setAttribute("aria-expanded", "false");
    node.addEventListener("mousedown", (event) => event.preventDefault());
    node.addEventListener("mouseenter", () => {
      node.style.color = palette.fg;
    });
    node.addEventListener("mouseleave", () => {
      if (node.getAttribute("aria-expanded") !== "true")
        node.style.color = palette.fill2;
    });
  }
  const syncModelLine = () => {
    let line: ReturnType<InlineAskModelPicker["line"]> = null;
    try {
      line = input.modelPicker.line();
    } catch {
      line = null;
    }
    modelLabel.style.display = line ? "" : "none";
    modelLabel.textContent = line?.label || "";
    if (line?.title) modelLabel.setAttribute("title", line.title);
    else modelLabel.removeAttribute("title");
    effortLabel.style.display = line?.effort ? "" : "none";
    effortLabel.textContent = line?.effort || "";
  };
  let openModelMenu: { kind: "model" | "effort"; node: HTMLElement } | null =
    null;
  const closeModelMenu = () => {
    if (!openModelMenu) return;
    openModelMenu.node.remove();
    openModelMenu = null;
    for (const node of [modelLabel, effortLabel]) {
      node.setAttribute("aria-expanded", "false");
      node.style.color = palette.fill2;
    }
  };
  const showModelMenu = (kind: "model" | "effort") => {
    closeModelMenu();
    let menuNode: HTMLElement;
    try {
      menuNode = buildInlineAskModelMenu({
        doc,
        palette,
        picker: input.modelPicker,
        kind,
        onPick: () => {
          closeModelMenu();
          syncModelLine();
        },
      });
    } catch {
      return;
    }
    const button = kind === "model" ? modelLabel : effortLabel;
    button.setAttribute("aria-expanded", "true");
    button.style.color = palette.fg;
    menuNode.addEventListener("mousedown", (event) => event.preventDefault());
    root.append(menuNode);
    const rootRect = root.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    menuNode.style.left = `${Math.round(rect.left - rootRect.left)}px`;
    menuNode.style.top = `${Math.round(rect.bottom - rootRect.top + 4)}px`;
    // Open upwards when the menu would leave the window at the bottom.
    const viewHeight = doc.defaultView?.innerHeight ?? 600;
    const menuRect = menuNode.getBoundingClientRect();
    if (menuRect.bottom > viewHeight - 8 && menuRect.height)
      menuNode.style.top = `${Math.round(
        rect.top - rootRect.top - 4 - menuRect.height,
      )}px`;
    openModelMenu = { kind, node: menuNode };
  };
  const toggleModelMenu = (kind: "model" | "effort") => {
    if (openModelMenu?.kind === kind) {
      closeModelMenu();
      return;
    }
    try {
      input.modelPicker.prepareMenu?.(() => {
        syncModelLine();
        if (openModelMenu) showModelMenu(openModelMenu.kind);
      });
    } catch {
      // The menu shows what the picker has now.
    }
    showModelMenu(kind);
  };
  modelLabel.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleModelMenu("model");
  });
  effortLabel.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleModelMenu("effort");
  });
  syncModelLine();
  fieldBar.append(
    modelLabel,
    effortLabel,
    el("span", ["flex:1 1 auto"]),
    sendBtn,
  );
  composerRow.append(composer, fieldBar);
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

  // ── Shortcut editing: the right-click menu and the floating editor ─────
  const promptSetup = input.promptEditing;
  let promptMenu: HTMLElement | null = null;
  const closePromptMenu = () => {
    promptMenu?.remove();
    promptMenu = null;
  };
  const promptPanel = createQuickPromptEditorPanel({
    doc,
    palette,
    labels: promptSetup.labels,
    width: 286,
    onCancel: () => closePromptEditor(),
    onSave: () => savePrompt(),
  });
  const refreshPrompts = () => {
    try {
      shownPrompts = promptSetup.api.list();
    } catch {
      // Keep the shortcuts shown; the prefs could not be read.
    }
    renderPrompts();
    reposition();
  };
  const placePromptEditor = (anchorX: number) => {
    const rootRect = root.getBoundingClientRect();
    const rowRect = actionRow.getBoundingClientRect();
    const width = Math.min(286, (rootRect.width || 300) - 16);
    promptPanel.node.style.width = `${Math.round(width)}px`;
    const maxLeft = Math.max(6, (rootRect.width || 300) - width - 8);
    promptPanel.node.style.left = `${Math.round(
      Math.min(Math.max(6, anchorX - 14), maxLeft),
    )}px`;
    promptPanel.node.style.top = `${Math.round(
      rowRect.bottom - rootRect.top + 6,
    )}px`;
  };
  let editAnchorX = 0;
  /** Where the focus was before the editor took it: usually the note. */
  let focusBeforeEdit: HTMLElement | null = null;
  const openPromptEditor = (prompt: QuickPrompt | null) => {
    closePromptMenu();
    const active = doc.activeElement as HTMLElement | null;
    if (!editingPrompt)
      focusBeforeEdit = active && !root.contains(active) ? active : null;
    editingPrompt = { id: prompt?.id ?? null };
    promptPanel.fill(prompt);
    renderPrompts();
    promptPanel.node.style.display = "flex";
    placePromptEditor(editAnchorX);
    promptPanel.labelInput.focus({ preventScroll: true });
  };
  const closePromptEditor = () => {
    if (!editingPrompt) return;
    editingPrompt = null;
    promptPanel.node.style.display = "none";
    renderPrompts();
    // Give the focus back (to the note, which keeps its selection), so the
    // popup follows the note's selection again as before the edit.
    const previous = focusBeforeEdit;
    focusBeforeEdit = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    else if (root.contains(doc.activeElement))
      (doc.activeElement as HTMLElement).blur();
  };
  const savePrompt = () => {
    if (!editingPrompt) return;
    const value = promptPanel.read();
    if (!value) return;
    try {
      if (editingPrompt.id) promptSetup.api.edit(editingPrompt.id, value);
      else promptSetup.api.add(value);
    } catch {
      // The prefs refused the write; the row shows what is stored.
    }
    closePromptEditor();
    refreshPrompts();
  };
  const runPromptMenuAction = (
    action: QuickPromptMenuAction,
    promptId: string | null,
  ) => {
    closePromptMenu();
    const prompt = shownPrompts.find((entry) => entry.id === promptId) || null;
    if (
      !applyQuickPromptMenuAction(
        promptSetup.api,
        action,
        prompt,
        openPromptEditor,
      )
    )
      return;
    if (action === "reset" || editingPrompt?.id === promptId)
      closePromptEditor();
    refreshPrompts();
  };
  const findPrompt = (target: unknown): HTMLElement | null => {
    for (
      let node = target as HTMLElement | null;
      node && node !== actionRow;
      node = node.parentNode as HTMLElement | null
    ) {
      if (node.getAttribute?.("data-llm-note-inline-prompt") != null)
        return node;
    }
    return null;
  };
  actionRow.addEventListener("contextmenu", (event) => {
    if (engaged) return;
    event.preventDefault();
    event.stopPropagation();
    closePromptMenu();
    const pill = findPrompt(event.target);
    const promptId = pill?.getAttribute("data-llm-note-inline-prompt") || null;
    const rootRect = root.getBoundingClientRect();
    editAnchorX = pill
      ? pill.getBoundingClientRect().left - rootRect.left
      : event.clientX - rootRect.left;
    const menuNode = buildQuickPromptMenu({
      doc,
      palette,
      setup: promptSetup,
      promptId,
      onAction: (action) => runPromptMenuAction(action, promptId),
    });
    // Picking an item keeps the focus (and the note's selection) put.
    menuNode.addEventListener("mousedown", (e) => e.preventDefault());
    root.append(menuNode);
    menuNode.style.left = `${Math.round(
      Math.max(
        0,
        Math.min(event.clientX - rootRect.left, rootRect.width - 130),
      ),
    )}px`;
    menuNode.style.top = `${Math.round(event.clientY - rootRect.top)}px`;
    promptMenu = menuNode;
  });
  // A press elsewhere in the popup closes the menu and cancels the editor.
  root.addEventListener("mousedown", (event) => {
    const target = event.target as Node | null;
    if (promptMenu && target && !promptMenu.contains(target)) closePromptMenu();
    if (
      editingPrompt &&
      target &&
      !promptPanel.node.contains(target) &&
      !(promptMenu && promptMenu.contains(target))
    )
      closePromptEditor();
  });
  promptPanel.labelInput.addEventListener("keydown", (event) => {
    // Enter in Label saves.
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      savePrompt();
    }
  });
  promptPanel.promptBox.editor.addEventListener("keydown", (event) => {
    // Mod+Enter in Prompt saves; Enter is a new line.
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.isComposing
    ) {
      event.preventDefault();
      savePrompt();
    }
  });
  promptPanel.attach();

  const closeControl = createInlineCardCloseButton(
    doc,
    root,
    palette,
    input.labels.close,
  );
  const closeBtn = closeControl.button;
  closeBtn.setAttribute("data-llm-note-inline-close", "true");

  root.append(menu, result, promptPanel.node, closeBtn);
  (doc.documentElement || doc.body)!.appendChild(root);
  closeControl.attach();

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
    closeControl.setDisabled(acting);
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
    promptPanel.detach();
    closeControl.detach();
    doc.removeEventListener("keydown", onKeyDown, true);
    root.remove();
    input.onClose();
  };

  const ask = (title: string, instruction: string, showChange: boolean) => {
    if (closed || engaged || !instruction.trim()) return;
    engaged = true;
    closePromptMenu();
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
  closeBtn.addEventListener("click", () => {
    if (!acting) close();
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !closed) {
      event.preventDefault();
      event.stopPropagation();
      // Escape closes the shortcut menu or editor first, then the popup.
      if (promptMenu) closePromptMenu();
      else if (editingPrompt) closePromptEditor();
      else close();
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
