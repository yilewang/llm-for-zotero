/**
 * The note editor's inline writing card: selecting text in a note opens the
 * Inline Ask card right under the selection, with writing prompts (Rewrite,
 * Expand, Shorten), a question field, and actions that write the answer back
 * (Replace, Insert below) or hand the selection to the chat (Add to chat).
 *
 * The card opens by itself on every selection (the user chose a full menu
 * over a small icon first), so it does not take the keyboard: the user keeps
 * typing in the note until they click the card. A selection the user leaves
 * (collapsed or changed) closes a card that has no answer yet; a card with
 * an answer stays until it is discarded, used, or closed.
 *
 * Writing back:
 * - Replace goes through note_write's bound selection (replaceNoteSelection
 *   in the agent API): the text must still occur once in the note, unsaved
 *   typing is saved first, and the change journal records it for undo.
 * - Insert below asks the note editor itself to insert the answer after the
 *   selected paragraph, so the editor saves it and Cmd+Z undoes it.
 */
import { getAgentApi, initAgentSubsystem } from "../../../agent";
import type { NoteContextRef } from "../../../shared/types";
import { renderRawNoteHtml } from "../../../services/notes/noteRendering";
import { resolveNoteEditingParentItem } from "../../../services/notes/scope";
import { resolvePaperContextRefFromItem } from "../../../services/paperContent/paperAttribution";
import { getAbortController } from "../../../utils/apiHelpers";
import { t } from "../../../utils/i18n";
import { appendSelectedTextContextForItem } from "../contextResolution";
import { setNumberPref } from "../prefHelpers";
import { resolvePaperConversationKeyForBaseItem } from "../portalScope";
import { refreshSelectedTextPanels } from "../readerTextInclusion";
import {
  openInlineAskOverlay,
  type InlineAskOverlayHandle,
} from "../selectionPrompt/inlineAskOverlay";
import {
  createInlineAskModelPicker,
  INLINE_ASK_TEXT_SIZE_PREF,
  readInlineAskTextSize,
  resolveInlineAskModelChoice,
} from "../selectionPrompt/inlineAskReader";
import { createInlineAskTurnRunner } from "../selectionPrompt/inlineAskRequest";
import type { InlineAskQuickPrompt } from "../selectionPrompt/inlineAskPrompts";
import { activeContextPanels } from "../state";
import { getEditableSelectionFromDocument } from "../noteSelection";
import { buildNoteEditingSelectedTextContext } from "./selectionController";

export const NOTE_INLINE_WRITING_SYSTEM_MESSAGE = [
  "Note writing: the user selected text in their own Zotero note and asks for help writing it.",
  "When asked to rewrite, expand, shorten or otherwise change the text, reply with only the new text in Markdown, with no preamble, quotes or commentary, so it can replace the selection as is.",
  "Keep the selection's language, meaning and structure (headings, lists) unless asked to change them.",
  "When asked a question, answer briefly.",
  "Do not add citation markers, quote tokens, or source lists.",
].join(" ");

function notePrompts(): InlineAskQuickPrompt[] {
  return [
    {
      id: "note-rewrite",
      label: t("Rewrite"),
      prompt:
        "Rewrite the selected text so it reads clearly and concisely. Reply with only the rewritten text.",
    },
    {
      id: "note-expand",
      label: t("Expand"),
      prompt:
        "Expand the selected text with more detail, using the paper where it helps. Reply with only the expanded text.",
    },
    {
      id: "note-shorten",
      label: t("Shorten"),
      prompt:
        "Shorten the selected text while keeping its key points. Reply with only the shortened text.",
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

/** The visible chat panel showing this note's paper (or the library chat
 *  for a standalone note); one in the editor's own window first. */
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
      : root.dataset.conversationKind === "global" ||
        Number(root.dataset.noteId || 0) === noteItem.id;
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

/** The note editor element whose document is `doc`. */
function findNoteEditorForDocument(
  win: Window,
  doc: Document,
): (Element & { _editorInstance?: any }) | null {
  for (const editor of Array.from(
    win.document.querySelectorAll("note-editor"),
  ) as Element[]) {
    const iframe = editor.querySelector("iframe") as HTMLIFrameElement | null;
    if (iframe?.contentDocument === doc) return editor as any;
  }
  return null;
}

type OpenCard = {
  handle: InlineAskOverlayHandle;
  doc: Document;
  noteId: number;
  selectedText: string;
};

const openCards = new WeakMap<Window, OpenCard>();
/** The selection whose card the user closed: it does not open again until
 *  the selection changes. */
const dismissedSelections = new WeakMap<Document, string>();
const pressedDocuments = new WeakSet<Document>();
const watchedDocuments = new WeakSet<Document>();

function watchPointer(doc: Document): void {
  if (watchedDocuments.has(doc)) return;
  watchedDocuments.add(doc);
  doc.addEventListener("mousedown", () => pressedDocuments.add(doc), true);
  doc.addEventListener("mouseup", () => pressedDocuments.delete(doc), true);
}

function selectionAnchor(doc: Document) {
  const selection = doc.defaultView?.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function closeCard(win: Window): void {
  const card = openCards.get(win);
  if (!card) return;
  openCards.delete(win);
  card.handle.close();
}

function openCard(params: {
  win: Window;
  doc: Document;
  noteItem: Zotero.Item;
  selectedText: string;
}): void {
  const { win, doc, noteItem, selectedText } = params;
  const anchor = selectionAnchor(doc);
  const noteContext: NoteContextRef | null =
    buildNoteEditingSelectedTextContext(noteItem);
  if (!anchor || !noteContext) return;
  const parent = resolveNoteEditingParentItem(noteItem);
  const reasoningItemId = parent?.id || noteItem.id;
  const state = { choice: resolveInlineAskModelChoice(reasoningItemId) };
  const runTurn = createInlineAskTurnRunner({
    getModel: () =>
      state.choice
        ? { target: state.choice.target, reasoning: state.choice.reasoning }
        : null,
    noModelMessage: t("Inline Ask needs an API model."),
    systemMessage: NOTE_INLINE_WRITING_SYSTEM_MESSAGE,
    getContext: async () => {
      const paper = parent ? resolvePaperContextRefFromItem(parent) : null;
      return buildNoteInlineWritingContext({
        noteTitle: noteContext.title,
        noteText: (
          (doc.querySelector(".ProseMirror") as HTMLElement | null)
            ?.innerText || ""
        ).trim(),
        paper,
        abstract: readField(parent, "abstractNote"),
        selectedText,
      });
    },
  });
  const conversationKeyForChange = () =>
    findChatPanelForNote(win, noteItem)?.conversationKey ||
    resolvePaperConversationKeyForBaseItem(parent || noteItem, "upstream");

  const handle = openInlineAskOverlay({
    doc,
    anchor,
    selectedText,
    sourceLabel: noteContext.title,
    prompts: notePrompts(),
    model: state.choice?.line ?? null,
    modelPicker: createInlineAskModelPicker(reasoningItemId, state),
    labels: {
      placeholder: t("Ask about or change the selection"),
      followUpPlaceholder: t("Ask a follow-up"),
      hint: t("Enter to send · Shift+Enter for a new line · Esc to close"),
      send: t("Send"),
      reading: t("Reading the selection…"),
      discard: t("Discard"),
      continueInSidebar: t("Continue in sidebar"),
      saveAsAnnotation: t("Save as annotation"),
      reasoningEffort: t("Reasoning effort"),
      more: t("More"),
      textSize: t("Text size"),
      resetTextSize: t("Reset to 100%"),
      modelUnavailable: t("Inline Ask needs an API model."),
    },
    textSize: readInlineAskTextSize(),
    onTextSizeChange: (size) => setNumberPref(INLINE_ASK_TEXT_SIZE_PREF, size),
    runTurn,
    autoFocus: false,
    showSaveAsAnnotation: false,
    composeActions: [
      {
        id: "note-add-to-chat",
        label: t("Add to chat"),
        run: async () => {
          const panel = findChatPanelForNote(win, noteItem);
          if (!panel)
            return {
              ok: false,
              error: t("Open the chat in the side pane to add text to it."),
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
          return { ok: true };
        },
      },
    ],
    answerActions: [
      {
        id: "note-replace",
        label: t("Replace"),
        run: async (answer) => {
          await initAgentSubsystem();
          const outcome = await getAgentApi().replaceNoteSelection({
            noteContext,
            conversationKey: conversationKeyForChange(),
            selectedText,
            replacement: answer.trim(),
          });
          return outcome.ok
            ? { ok: true }
            : { ok: false, error: outcome.error };
        },
      },
      {
        id: "note-insert-below",
        label: t("Insert below"),
        run: async (answer) => {
          const editor = findNoteEditorForDocument(win, doc);
          const instance = editor?._editorInstance;
          if (!instance?._postMessage)
            return { ok: false, error: t("The note editor is not open.") };
          instance._postMessage({
            action: "insertHTML",
            pos: null,
            html: renderRawNoteHtml(answer),
          });
          return { ok: true };
        },
      },
    ],
    createAbortController: () => {
      const Controller = getAbortController();
      return Controller ? new Controller() : null;
    },
    onClose: () => {
      if (openCards.get(win)?.handle === handle) openCards.delete(win);
      dismissedSelections.set(doc, selectedText);
    },
  });
  openCards.set(win, { handle, doc, noteId: noteItem.id, selectedText });
}

/**
 * Follows the selection in the open note editors (called by the note
 * selection tracker after each selection change, mouse release or key).
 */
export function syncNoteInlineWritingCard(params: {
  win: Window;
  noteItem: Zotero.Item | null;
  docs: Document[];
}): void {
  const { win, noteItem, docs } = params;
  for (const doc of docs) watchPointer(doc);
  const card = openCards.get(win);
  // A card with an answer (or a question on its way) stays until the user
  // closes it; one without follows the selection.
  if (card?.handle.hasConversation()) return;
  const live = noteItem
    ? docs
        .map((doc) => ({ doc, text: getEditableSelectionFromDocument(doc) }))
        .find((entry) => entry.text)
    : undefined;
  for (const doc of docs) {
    const text = getEditableSelectionFromDocument(doc);
    if (!text) dismissedSelections.delete(doc);
  }
  if (!live || !noteItem) {
    closeCard(win);
    return;
  }
  // Wait for the drag to end; the tracker checks again on mouse release.
  if (pressedDocuments.has(live.doc)) return;
  if (dismissedSelections.get(live.doc) === live.text) return;
  if (
    card &&
    card.doc === live.doc &&
    card.noteId === noteItem.id &&
    card.selectedText === live.text
  )
    return;
  closeCard(win);
  dismissedSelections.delete(live.doc);
  openCard({ win, doc: live.doc, noteItem, selectedText: live.text });
}

/** Closes the window's card (the window or the tracker goes away). */
export function closeNoteInlineWritingCard(win: Window): void {
  closeCard(win);
}
