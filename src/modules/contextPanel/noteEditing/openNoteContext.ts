/**
 * The note the user has open, attached to its paper's chat.
 *
 * Opening a note keeps the chat on its paper's conversation (issue #577);
 * that chat then carries the open note as a removable whole-note chip, next
 * to the paper's own chip, so the model reads both. The chip's text follows
 * the note as the user writes. A chip the user removes stays removed for
 * that note in that conversation; opening another note attaches that one
 * instead.
 *
 * The note selection tracker calls this after each selection change and on
 * its interval, with the note open in the window.
 */
import type { NoteContextRef } from "../../../shared/types";
import { readNoteSnapshot } from "../../../services/notes/noteSnapshot";
import { resolveNoteEditingParentItem } from "../../../services/notes/scope";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
} from "../contextResolution";

/** Per conversation: the note this module attached last. */
const attachedNotes = new Map<number, number>();

const isOpenNoteEntry = (
  entry: { source?: string; noteContext?: NoteContextRef },
  noteId: number,
) => entry.source === "note" && entry.noteContext?.noteItemId === noteId;

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
  if (!noteItem || !parent) return [];
  const snapshot = readNoteSnapshot(noteItem);
  if (!snapshot) return [];
  const noteContext: NoteContextRef = {
    libraryID: snapshot.libraryID,
    noteItemKey: snapshot.noteItemKey || "",
    noteItemId: snapshot.noteId,
    parentItemId: snapshot.parentItemId,
    parentItemKey: snapshot.parentItemKey,
    noteKind: snapshot.noteKind,
    title: snapshot.title || `Note ${snapshot.noteId}`,
  };
  const changed: number[] = [];
  for (const { conversationKey, root } of params.panels) {
    // Only the paper's own chat; a note chat shows its note already.
    if (
      root.dataset.conversationKind !== "paper" ||
      root.dataset.noteId ||
      Number(root.dataset.basePaperItemId || 0) !== parent.id
    )
      continue;
    const entries = getSelectedTextContextEntries(conversationKey);
    const previous = attachedNotes.get(conversationKey);
    if (previous !== noteItem.id) {
      // Another note is open now: its chip replaces the one attached before.
      const kept = previous
        ? entries.filter((entry) => !isOpenNoteEntry(entry, previous))
        : entries;
      if (kept.length !== entries.length)
        setSelectedTextContextEntries(conversationKey, kept);
      // An empty note is attached once it has text.
      if (!snapshot.text.trim()) {
        if (kept.length !== entries.length) changed.push(conversationKey);
        attachedNotes.delete(conversationKey);
        continue;
      }
      attachedNotes.set(conversationKey, noteItem.id);
      if (!kept.some((entry) => isOpenNoteEntry(entry, noteItem.id)))
        appendSelectedTextContextForItem(
          conversationKey,
          snapshot.text,
          "note",
          undefined,
          { contextItemId: snapshot.noteId },
          noteContext,
        );
      changed.push(conversationKey);
      continue;
    }
    // Kept current while the user writes; a removed chip stays removed.
    const index = entries.findIndex((entry) =>
      isOpenNoteEntry(entry, noteItem.id),
    );
    if (index < 0 || entries[index].text === snapshot.text) continue;
    const next = entries.slice();
    next[index] = { ...entries[index], text: snapshot.text };
    setSelectedTextContextEntries(conversationKey, next);
    changed.push(conversationKey);
  }
  return changed;
}
