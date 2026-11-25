/**
 * Inline writing in the note editor: selecting text in a note opens a small
 * popup under the selection (noteInlinePopup.ts) with Rewrite, Expand,
 * Proofread, Ask in sidebar, and a composer for the user's own instruction.
 *
 * The popup opens on every selection and does not take the keyboard, so the
 * user keeps typing in the note until they click it. Until the user asks
 * something it follows the selection: it moves with a new selection and
 * closes when the selection goes away. Once asked, it stays until the answer
 * is used or discarded.
 *
 * Writing back:
 * - Replace goes through note_write's bound selection (replaceNoteSelection
 *   in the agent API): the text must still occur once in the note, unsaved
 *   typing is saved first, and the change journal records it for undo.
 * - Insert below asks the note editor itself to insert the answer after the
 *   selected paragraph, so the editor saves it and Cmd+Z undoes it.
 * - Ask in sidebar adds the selection to the paper's chat (a note-editing
 *   chip) and moves any composer text into the chat's input.
 */
import { getAgentApi, initAgentSubsystem } from "../../../agent";
import type { NoteContextRef, NoteTextOccurrence } from "../../../shared/types";
import {
  noteHtmlToModelText,
  normalizeNoteSourceText,
  renderRawNoteHtml,
} from "../../../services/notes/noteRendering";
import { renderDiffPreviewField } from "../agentTrace/diffPreviewField";
import { resolveNoteEditingParentItem } from "../../../services/notes/scope";
import { resolvePaperContextRefFromItem } from "../../../services/paperContent/paperAttribution";
import { getAbortController } from "../../../utils/apiHelpers";
import { locateNoteTextOccurrence } from "../../../utils/noteEdit";
import { t } from "../../../utils/i18n";
import { appendSelectedTextContextForItem } from "../contextResolution";
import { getEditableSelectionFromDocument } from "../noteSelection";
import { resolvePaperConversationKeyForBaseItem } from "../portalScope";
import { refreshSelectedTextPanels } from "../readerTextInclusion";
import {
  createInlineAskModelPicker,
  resolveInlineAskModelChoice,
} from "../selectionPrompt/inlineAskReader";
import { createInlineAskTurnRunner } from "../selectionPrompt/inlineAskRequest";
import { activeContextPanels } from "../state";
import {
  openNoteInlinePopup,
  type NoteInlinePopupHandle,
  type NoteInlinePopupRect,
} from "./noteInlinePopup";
import { buildNoteEditingSelectedTextContext } from "./selectionController";

export const NOTE_INLINE_WRITING_SYSTEM_MESSAGE = [
  "Note writing: the user selected text in their own Zotero note and asks for help writing it.",
  "When asked to rewrite, expand, proofread or otherwise change the text, reply with only the new text in Markdown, with no preamble, quotes or commentary, so it can replace the selection as is.",
  "Keep the selection's language, meaning and structure (headings, lists) unless asked to change them.",
  "The new text replaces exactly the selection, which may start or end mid-sentence: keep its first and last characters' kind, so add no final period or capital letter the selection does not have.",
  "Cover only the selected text: the whole note is there for context, so never add, repeat or continue text from outside the selection, such as further list items.",
  "Keep the selection's list items as list items (one Markdown item each, with their numbering or bullets), and keep their number unless asked to change it.",
  "When asked a question, answer briefly.",
  "Do not add citation markers, quote tokens, or source lists.",
].join(" ");

/**
 * What the answer must look like to replace the selection: a selection of
 * list items comes back as the same number of items, so a model that sees
 * the whole note does not add the items around the selection.
 */
export function describeSelectionShape(selectedMarkdown: string): string {
  const items = selectedMarkdown
    .split("\n")
    .filter((line) => /^(?:[-*]|\d+\.) /.test(line)).length;
  if (!items) return "";
  return ` The selection is ${items} list item${items === 1 ? "" : "s"}: reply with exactly ${items} Markdown list item${items === 1 ? "" : "s"}, numbered or bulleted as in the selection, and nothing from the items around it.`;
}

function writingActions(selectedMarkdown: string) {
  const shape = describeSelectionShape(selectedMarkdown);
  return [
    {
      id: "rewrite",
      label: t("Rewrite"),
      instruction: `Rewrite the selected text so it reads clearly and concisely. Reply with only the rewritten text.${shape}`,
    },
    {
      id: "expand",
      label: t("Expand"),
      instruction: `Expand the selected text with more detail, using the paper where it helps. Reply with only the expanded text.${shape}`,
    },
    {
      id: "proofread",
      label: t("Proofread"),
      instruction: `Proofread the selected text: fix spelling, grammar and punctuation without changing its meaning or style. Reply with only the corrected text.${shape}`,
    },
  ];
}

function readField(item: Zotero.Item | null, field: string): string {
  try {
    return `${(item as any)?.getField?.(field) || ""}`.trim();
  } catch {
    return "";
  }
}

/** The note, its paper and the selection, as the model's context. */
export function buildNoteInlineWritingContext(input: {
  noteTitle: string;
  noteText: string;
  paper: { title?: string; firstCreator?: string; year?: string } | null;
  abstract: string;
  selectedText: string;
}): string {
  const sections: string[] = [];
  if (input.paper?.title?.trim()) {
    const byline = [input.paper.firstCreator?.trim(), input.paper.year?.trim()]
      .filter(Boolean)
      .join(", ");
    sections.push(
      `Paper the note is about: ${input.paper.title.trim()}${
        byline ? ` (${byline})` : ""
      }`,
    );
  }
  if (input.abstract)
    sections.push(`Paper abstract:\n"""\n${input.abstract}\n"""`);
  sections.push(
    `The whole note${input.noteTitle ? ` ("${input.noteTitle}")` : ""}:\n"""\n${input.noteText}\n"""`,
  );
  sections.push(`Selected text:\n"""\n${input.selectedText}\n"""`);
  return sections.join("\n\n");
}

/** The visible chat panel this note writes beside: its paper's chat, or its
 *  own chat for a standalone note; one in the editor's own window first. */
function findChatPanelForNote(
  win: Window,
  noteItem: Zotero.Item,
): { body: Element; conversationKey: number } | null {
  const parent = resolveNoteEditingParentItem(noteItem);
  const candidates: Array<{ body: Element; conversationKey: number }> = [];
  for (const body of activeContextPanels.keys()) {
    if (!body.isConnected || !body.getClientRects().length) continue;
    const root = body.querySelector("#llm-main") as HTMLElement | null;
    const conversationKey = Number(root?.dataset.itemId || 0);
    if (!root || !(conversationKey > 0)) continue;
    const matches = parent
      ? Number(root.dataset.basePaperItemId || 0) === parent.id ||
        Number(root.dataset.noteParentItemId || 0) === parent.id
      : Number(root.dataset.noteId || 0) === noteItem.id;
    if (matches) candidates.push({ body, conversationKey });
  }
  return (
    candidates.find(
      (candidate) => candidate.body.ownerDocument?.defaultView === win,
    ) ||
    candidates[0] ||
    null
  );
}

type NoteEditorElement = Element & {
  _editorInstance?: { _postMessage?: (message: unknown) => void };
};

/** The note editor element whose iframe holds `doc`. */
function findNoteEditorForDocument(
  win: Window,
  doc: Document,
): { editor: NoteEditorElement; iframe: HTMLIFrameElement } | null {
  for (const editor of Array.from(
    win.document.querySelectorAll("note-editor"),
  ) as Element[]) {
    const iframe = editor.querySelector("iframe") as HTMLIFrameElement | null;
    if (iframe?.contentDocument === doc)
      return { editor: editor as NoteEditorElement, iframe };
  }
  return null;
}

type OpenPopup = {
  handle: NoteInlinePopupHandle;
  doc: Document;
  noteId: number;
  selectedText: string;
};

const openPopups = new WeakMap<Window, OpenPopup>();
/** The selection whose popup the user closed: it does not open again until
 *  the selection changes. */
const dismissedSelections = new WeakMap<Document, string>();
const pressedDocuments = new WeakSet<Document>();
/** Editors an answer was just written into: until the written text is
 *  selected, their selection is the editor's own doing, not the user's. */
const settlingDocuments = new WeakSet<Document>();
const watchedDocuments = new WeakSet<Document>();

function watchEditorDocument(win: Window, doc: Document): void {
  if (watchedDocuments.has(doc)) return;
  watchedDocuments.add(doc);
  doc.addEventListener("mousedown", () => pressedDocuments.add(doc), true);
  doc.addEventListener("mouseup", () => pressedDocuments.delete(doc), true);
  // Escape in the note closes the popup; scrolling the note moves it.
  doc.addEventListener(
    "keydown",
    (event) => {
      const popup = openPopups.get(win);
      if (event.key === "Escape" && popup?.doc === doc) popup.handle.close();
    },
    true,
  );
  doc.addEventListener(
    "scroll",
    () => {
      const popup = openPopups.get(win);
      if (popup?.doc === doc) popup.handle.reposition();
    },
    true,
  );
}

/**
 * The selection as Markdown, keeping its structure: a selection across list
 * items is read inside its list (and quote), so the model sees "- " items
 * and answers with items, which Replace writes back as items. Plain text
 * only finds the passage in the note; it is never what the model rewrites.
 */
function readSelectionMarkdown(doc: Document, range: Range): string {
  const holder = doc.createElement("div");
  holder.append(range.cloneContents());
  let html = holder.innerHTML;
  const body = doc.querySelector(".ProseMirror");
  const spansBlocks = Boolean(
    holder.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre"),
  );
  const start = range.commonAncestorContainer;
  let element: Element | null =
    start.nodeType === 1 ? (start as Element) : start.parentElement;
  for (
    ;
    spansBlocks && element && element !== body;
    element = element.parentElement
  ) {
    const tag = element.tagName.toLowerCase();
    if (tag === "ul" || tag === "blockquote") html = `<${tag}>${html}</${tag}>`;
    if (tag === "ol") {
      // Numbered from the selection's first item, as the note numbers it.
      const items = Array.from(element.children).filter(
        (child) => child.tagName.toLowerCase() === "li",
      );
      const first = items.findIndex((item) => range.intersectsNode(item));
      const start =
        Number(element.getAttribute("start") || 1) + Math.max(0, first);
      html = `<ol start="${start}">${html}</ol>`;
    }
  }
  return noteHtmlToModelText(html).trim() || range.toString();
}

/** The note's text as the editor shows it: its text nodes joined in order. */
function readEditorText(doc: Document): {
  text: string;
  nodes: Array<{ node: Text; start: number }>;
} {
  const body = doc.querySelector(".ProseMirror");
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  if (!body) return { text, nodes };
  const walker = doc.createTreeWalker(body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent || "";
  }
  return { text, nodes };
}

/**
 * Which of the note's occurrences of the selected text the range is, in the
 * note as the editor shows it now, so Replace changes that one when the text
 * repeats. Null when the range no longer holds the selected text.
 */
function readSelectionOccurrence(
  doc: Document,
  range: Range,
  selectedText: string,
): NoteTextOccurrence | null {
  const body = doc.querySelector(".ProseMirror");
  if (!body) return null;
  const toSelectionEnd = doc.createRange();
  toSelectionEnd.selectNodeContents(body);
  toSelectionEnd.setEnd(range.endContainer, range.endOffset);
  const holder = doc.createElement("div");
  holder.append(toSelectionEnd.cloneContents());
  return locateNoteTextOccurrence(
    body.innerHTML,
    holder.innerHTML,
    selectedText,
  );
}

/** Where a point of the editor (a node and offset) falls in that text. */
function editorTextOffset(doc: Document, node: Node, offset: number): number {
  const { text, nodes } = readEditorText(doc);
  const entry = nodes.find((candidate) => candidate.node === node);
  if (entry) return entry.start + offset;
  // A point between elements: the text before the element's child there.
  const range = doc.createRange();
  range.setStart(doc.querySelector(".ProseMirror") || doc.body, 0);
  range.setEnd(node, offset);
  return Math.min(text.length, range.toString().length);
}

/** A DOM point for an offset in the editor's text. */
function editorTextPoint(
  nodes: Array<{ node: Text; start: number }>,
  offset: number,
  preferEnd: boolean,
): { node: Text; offset: number } | null {
  for (const { node, start } of nodes) {
    const end = start + (node.textContent || "").length;
    if (offset < end || (preferEnd && offset === end))
      return { node, offset: offset - start };
  }
  const last = nodes.at(-1);
  return last
    ? { node: last.node, offset: (last.node.textContent || "").length }
    : null;
}

/**
 * Selects the text an answer put into the note, so the whole change shows,
 * once the editor shows it: from the first to the last line of the answer,
 * searched from `from` (where the selection began, or ended for text
 * inserted below it). The new selection does not open the popup again.
 */
function selectWrittenText(
  win: Window,
  doc: Document,
  from: number,
  answerHtml: string,
): void {
  const parsed = new (doc.defaultView as any).DOMParser().parseFromString(
    answerHtml,
    "text/html",
  ) as Document;
  const lines = Array.from(parsed.body.children)
    .map((block) => (block.textContent || "").trim())
    .filter(Boolean);
  if (!lines.length) return;
  const firstKey = lines[0].slice(0, 40);
  const lastKey = lines[lines.length - 1].slice(-40);
  const deadline = Date.now() + 3000;
  settlingDocuments.add(doc);
  const select = (): "retry" | "done" => {
    if (!doc.defaultView || Date.now() > deadline) return "done";
    const { text, nodes } = readEditorText(doc);
    const start = text.indexOf(firstKey, Math.max(0, from - 2));
    const lastAt = start < 0 ? -1 : text.indexOf(lastKey, start);
    if (start < 0 || lastAt < 0) return "retry";
    const startPoint = editorTextPoint(nodes, start, false);
    const endPoint = editorTextPoint(nodes, lastAt + lastKey.length, true);
    const selection = doc.defaultView.getSelection();
    if (!startPoint || !endPoint || !selection) return "done";
    (doc.querySelector(".ProseMirror") as HTMLElement | null)?.focus();
    const range = doc.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    dismissedSelections.set(doc, getEditableSelectionFromDocument(doc));
    return "done";
  };
  const attempt = () => {
    if (select() === "retry") win.setTimeout(attempt, 50);
    else settlingDocuments.delete(doc);
  };
  // After the popup has closed (its close marks the old selection).
  win.setTimeout(attempt, 50);
}

function closePopup(win: Window): void {
  openPopups.get(win)?.handle.close();
}

function openPopup(params: {
  win: Window;
  doc: Document;
  noteItem: Zotero.Item;
  selectedText: string;
}): void {
  const { win, doc, noteItem, selectedText } = params;
  const host = findNoteEditorForDocument(win, doc);
  const selection = doc.defaultView?.getSelection?.();
  const noteContext: NoteContextRef | null =
    buildNoteEditingSelectedTextContext(noteItem);
  if (!host || !selection?.rangeCount || !noteContext) return;
  // The selection the popup works on, kept while focus moves to the popup.
  const range = selection.getRangeAt(0).cloneRange();
  const selectedMarkdown = readSelectionMarkdown(doc, range);
  const selectionStart = editorTextOffset(
    doc,
    range.startContainer,
    range.startOffset,
  );
  const selectionEnd = editorTextOffset(
    doc,
    range.endContainer,
    range.endOffset,
  );
  const hostDoc = host.iframe.ownerDocument as Document;
  const readAnchor = (): NoteInlinePopupRect | null => {
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const frame = host.iframe.getBoundingClientRect();
    return {
      left: frame.left + rect.left,
      top: frame.top + rect.top,
      right: frame.left + rect.right,
      bottom: frame.top + rect.bottom,
    };
  };
  if (!readAnchor()) return;

  const parent = resolveNoteEditingParentItem(noteItem);
  // Inline Ask's model choice: the field shows it, its menus change it, and
  // each answer reads it.
  const reasoningItemId = parent?.id || noteItem.id;
  const modelState = { choice: resolveInlineAskModelChoice(reasoningItemId) };
  const runTurn = createInlineAskTurnRunner({
    getModel: () =>
      modelState.choice
        ? {
            target: modelState.choice.target,
            reasoning: modelState.choice.reasoning,
          }
        : null,
    noModelMessage: t("Inline writing needs an API model."),
    systemMessage: NOTE_INLINE_WRITING_SYSTEM_MESSAGE,
    getContext: async () =>
      buildNoteInlineWritingContext({
        noteTitle: noteContext.title,
        noteText: noteHtmlToModelText(
          doc.querySelector(".ProseMirror")?.innerHTML || "",
        ).trim(),
        paper: parent ? resolvePaperContextRefFromItem(parent) : null,
        abstract: readField(parent, "abstractNote"),
        selectedText: selectedMarkdown,
      }),
  });

  const handle = openNoteInlinePopup({
    hostDoc,
    readAnchor,
    actions: writingActions(selectedMarkdown),
    modelPicker: createInlineAskModelPicker(reasoningItemId, modelState),
    labels: {
      askInSidebar: t("Ask in sidebar"),
      composerPlaceholder: t("Tell AI what to do with this text…"),
      send: t("Send"),
      reasoningEffort: t("Reasoning effort"),
      replace: t("Replace"),
      insertBelow: t("Insert below"),
      discard: t("Discard"),
      working: t("Writing…"),
    },
    renderChange: (answer) =>
      renderDiffPreviewField(hostDoc, {
        type: "diff_preview",
        id: "noteInlineChange",
        label: "",
        before: selectedMarkdown,
        after: normalizeNoteSourceText(answer),
      }).element,
    ask: (instruction, onDelta, signal) =>
      runTurn({ prompt: instruction, history: [], signal, onDelta }),
    replace: async (answer) => {
      await initAgentSubsystem();
      const outcome = await getAgentApi().replaceNoteSelection({
        noteContext,
        conversationKey:
          findChatPanelForNote(win, noteItem)?.conversationKey ||
          resolvePaperConversationKeyForBaseItem(
            parent || noteItem,
            "upstream",
          ),
        selectedText,
        occurrence:
          readSelectionOccurrence(doc, range, selectedText) || undefined,
        replacement: answer.trim(),
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      selectWrittenText(win, doc, selectionStart, renderRawNoteHtml(answer));
      return { ok: true };
    },
    insertBelow: async (answer) => {
      const post = host.editor._editorInstance?._postMessage;
      if (!post) return { ok: false, error: t("The note editor is not open.") };
      const html = renderRawNoteHtml(answer);
      post.call(host.editor._editorInstance, {
        action: "insertHTML",
        pos: null,
        html,
      });
      selectWrittenText(win, doc, selectionEnd, html);
      return { ok: true };
    },
    askInSidebar: async (composerText) => {
      const panel = findChatPanelForNote(win, noteItem);
      if (!panel)
        return {
          ok: false,
          error: t("Open the chat in the side pane first."),
        };
      appendSelectedTextContextForItem(
        panel.conversationKey,
        selectedText,
        "note-edit",
        null,
        null,
        noteContext,
      );
      refreshSelectedTextPanels(panel.body, panel.conversationKey);
      const input = panel.body.querySelector(
        "#llm-input",
      ) as HTMLTextAreaElement | null;
      if (input) {
        if (composerText) {
          input.value = composerText;
          input.dispatchEvent(
            new (input.ownerDocument.defaultView as any).Event("input", {
              bubbles: true,
            }),
          );
        }
        input.focus();
      }
      return { ok: true };
    },
    createAbortController: () => {
      const Controller = getAbortController();
      return Controller ? new Controller() : null;
    },
    onClose: () => {
      if (openPopups.get(win)?.handle === handle) openPopups.delete(win);
      dismissedSelections.set(doc, selectedText);
    },
  });
  openPopups.set(win, { handle, doc, noteId: noteItem.id, selectedText });
}

/**
 * Follows the selection in the open note editors (called by the note
 * selection tracker after each selection change, mouse release or key).
 */
export function syncNoteInlineWritingPopup(params: {
  win: Window;
  noteItem: Zotero.Item | null;
  docs: Document[];
}): void {
  const { win, noteItem, docs } = params;
  for (const doc of docs) watchEditorDocument(win, doc);
  const popup = openPopups.get(win);
  // Its note is no longer the one shown (another item, a closed editor).
  if (
    popup &&
    (!noteItem ||
      popup.noteId !== noteItem.id ||
      !docs.includes(popup.doc) ||
      !popup.doc.defaultView)
  ) {
    closePopup(win);
    return syncNoteInlineWritingPopup(params);
  }
  // Asked, or being worked in (its composer has the focus): it stays.
  if (
    popup &&
    (popup.handle.isEngaged() ||
      popup.handle.contains(win.document.activeElement))
  )
    return;
  for (const doc of docs)
    if (!getEditableSelectionFromDocument(doc)) dismissedSelections.delete(doc);
  const live = noteItem
    ? docs
        .map((doc) => ({ doc, text: getEditableSelectionFromDocument(doc) }))
        .find((entry) => entry.text)
    : undefined;
  if (!live || !noteItem) {
    closePopup(win);
    return;
  }
  // Wait for the drag to end; the tracker checks again on mouse release.
  if (pressedDocuments.has(live.doc)) return;
  // Wait for the written text to be selected; that selection is dismissed.
  if (settlingDocuments.has(live.doc)) return;
  if (dismissedSelections.get(live.doc) === live.text) return;
  if (
    popup &&
    popup.doc === live.doc &&
    popup.noteId === noteItem.id &&
    popup.selectedText === live.text
  )
    return;
  closePopup(win);
  dismissedSelections.delete(live.doc);
  openPopup({ win, doc: live.doc, noteItem, selectedText: live.text });
}

/** Closes the window's popup (the window or the tracker goes away). */
export function closeNoteInlineWritingPopup(win: Window): void {
  closePopup(win);
}
