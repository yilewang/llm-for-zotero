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
import type { NoteContextRef } from "../../../shared/types";
import { renderRawNoteHtml } from "../../../services/notes/noteRendering";
import { resolveNoteEditingParentItem } from "../../../services/notes/scope";
import { resolvePaperContextRefFromItem } from "../../../services/paperContent/paperAttribution";
import { getAbortController } from "../../../utils/apiHelpers";
import { t } from "../../../utils/i18n";
import { appendSelectedTextContextForItem } from "../contextResolution";
import { getEditableSelectionFromDocument } from "../noteSelection";
import { resolvePaperConversationKeyForBaseItem } from "../portalScope";
import { refreshSelectedTextPanels } from "../readerTextInclusion";
import { resolveInlineAskModelChoice } from "../selectionPrompt/inlineAskReader";
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
  "When asked a question, answer briefly.",
  "Do not add citation markers, quote tokens, or source lists.",
].join(" ");

function writingActions() {
  return [
    {
      id: "rewrite",
      label: t("Rewrite"),
      instruction:
        "Rewrite the selected text so it reads clearly and concisely. Reply with only the rewritten text.",
    },
    {
      id: "expand",
      label: t("Expand"),
      instruction:
        "Expand the selected text with more detail, using the paper where it helps. Reply with only the expanded text.",
    },
    {
      id: "proofread",
      label: t("Proofread"),
      instruction:
        "Proofread the selected text: fix spelling, grammar and punctuation without changing its meaning or style. Reply with only the corrected text.",
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
  const choice = resolveInlineAskModelChoice(parent?.id || noteItem.id);
  const runTurn = createInlineAskTurnRunner({
    getModel: () =>
      choice ? { target: choice.target, reasoning: choice.reasoning } : null,
    noModelMessage: t("Inline writing needs an API model."),
    systemMessage: NOTE_INLINE_WRITING_SYSTEM_MESSAGE,
    getContext: async () =>
      buildNoteInlineWritingContext({
        noteTitle: noteContext.title,
        noteText: (
          (doc.querySelector(".ProseMirror") as HTMLElement | null)
            ?.innerText || ""
        ).trim(),
        paper: parent ? resolvePaperContextRefFromItem(parent) : null,
        abstract: readField(parent, "abstractNote"),
        selectedText,
      }),
  });

  const handle = openNoteInlinePopup({
    hostDoc,
    readAnchor,
    actions: writingActions(),
    labels: {
      askInSidebar: t("Ask in sidebar"),
      composerPlaceholder: t("Tell AI what to do with this text…"),
      send: t("Send"),
      replace: t("Replace"),
      insertBelow: t("Insert below"),
      discard: t("Discard"),
      working: t("Writing…"),
    },
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
        replacement: answer.trim(),
      });
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    },
    insertBelow: async (answer) => {
      const post = host.editor._editorInstance?._postMessage;
      if (!post) return { ok: false, error: t("The note editor is not open.") };
      post.call(host.editor._editorInstance, {
        action: "insertHTML",
        pos: null,
        html: renderRawNoteHtml(answer),
      });
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
