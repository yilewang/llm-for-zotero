/**
 * The note the user has open, attached to its paper's chat.
 *
 * Opening a note keeps the chat on its paper's conversation (issue #577);
 * that chat then carries the open note as a removable whole-note chip, next
 * to the paper's own chip, so the model reads both. While the note is open
 * the chip's text follows the note as the user writes, and the chip stays in
 * the composer after a send, so every message carries the note. A chip the
 * user removes stays removed for that note in that conversation; opening
 * another note attaches that one instead.
 *
 * Once the note is no longer open, its chip is an ordinary chip: it goes
 * with the next message. Opening the note again attaches it again.
 *
 * The note selection tracker calls this after each selection change and on
 * its interval, with the note open in the window.
 */
import type {
  NoteContextRef,
  SelectedTextContext,
} from "../../../shared/types";
import { readNoteSnapshot } from "../../../services/notes/noteSnapshot";
import { resolveNoteEditingParentItem } from "../../../services/notes/scope";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
} from "../contextResolution";

/**
 * Per conversation: the note this module attached last, whether that note is
 * still open beside the chat, and whether the user removed its chip.
 */
const attachedNotes = new Map<
  number,
  { noteId: number; open: boolean; removed: boolean }
>();

const isOpenNoteEntry = (
  entry: { source?: string; noteContext?: NoteContextRef },
  noteId: number,
) => entry.source === "note" && entry.noteContext?.noteItemId === noteId;

/**
 * True for the chip of the note open beside this conversation, which this
 * module keeps current: a send leaves it in the composer.
 */
export function isOpenNoteContext(
  conversationKey: number,
  context: SelectedTextContext,
): boolean {
  const attached = attachedNotes.get(conversationKey);
  return attached?.open === true && isOpenNoteEntry(context, attached.noteId);
}

/**
 * Attaches (or keeps current) the open note in each paper chat of its
 * parent paper. Returns the conversations whose chips changed.
 */
export function syncOpenNoteContext(params: {
  noteItem: Zotero.Item | null;
  /** The mounted chats: their conversation key and panel root. */
  panels: Array<{ conversationKey: number; root: HTMLElement }>;
}): number[] {
  const { noteItem } = params;
  const parent = resolveNoteEditingParentItem(noteItem);
  const snapshot = noteItem && parent ? readNoteSnapshot(noteItem) : null;
  const changed: number[] = [];
  for (const { conversationKey, root } of params.panels) {
    const attached = attachedNotes.get(conversationKey);
    // Only the paper's own chat; a note chat shows its note already.
    if (
      !noteItem ||
      !parent ||
      !snapshot ||
      root.dataset.conversationKind !== "paper" ||
      root.dataset.noteId ||
      Number(root.dataset.basePaperItemId || 0) !== parent.id
    ) {
      // No note of this chat's paper is open any more.
      if (attached) attached.open = false;
      continue;
    }
    const noteContext: NoteContextRef = {
      libraryID: snapshot.libraryID,
      noteItemKey: snapshot.noteItemKey || "",
      noteItemId: snapshot.noteId,
      parentItemId: snapshot.parentItemId,
      parentItemKey: snapshot.parentItemKey,
      noteKind: snapshot.noteKind,
      title: snapshot.title || `Note ${snapshot.noteId}`,
    };
    const attach = () =>
      appendSelectedTextContextForItem(
        conversationKey,
        snapshot.text,
        "note",
        undefined,
        { contextItemId: snapshot.noteId },
        noteContext,
      );
    const entries = getSelectedTextContextEntries(conversationKey);
    if (attached?.noteId !== noteItem.id) {
      // Another note is open now: its chip replaces the one attached before.
      const kept = attached
        ? entries.filter((entry) => !isOpenNoteEntry(entry, attached.noteId))
        : entries;
      if (kept.length !== entries.length)
        setSelectedTextContextEntries(conversationKey, kept);
      // An empty note is attached once it has text.
      if (!snapshot.text.trim()) {
        if (kept.length !== entries.length) changed.push(conversationKey);
        attachedNotes.delete(conversationKey);
        continue;
      }
      attachedNotes.set(conversationKey, {
        noteId: noteItem.id,
        open: true,
        removed: false,
      });
      if (!kept.some((entry) => isOpenNoteEntry(entry, noteItem.id))) attach();
      changed.push(conversationKey);
      continue;
    }
    const wasOpen = attached.open;
    attached.open = true;
    const index = entries.findIndex((entry) =>
      isOpenNoteEntry(entry, noteItem.id),
    );
    if (index < 0) {
      // A send keeps the chip while the note is open, so only the user took
      // it away: it stays removed. A chip that went with a message while the
      // note was closed comes back now that the note is open again.
      if (wasOpen) attached.removed = true;
      else if (!attached.removed && snapshot.text.trim()) {
        attach();
        changed.push(conversationKey);
      }
      continue;
    }
    // Kept current while the user writes.
    if (entries[index].text === snapshot.text) continue;
    const next = entries.slice();
    next[index] = { ...entries[index], text: snapshot.text };
    setSelectedTextContextEntries(conversationKey, next);
    changed.push(conversationKey);
  }
  return changed;
}
