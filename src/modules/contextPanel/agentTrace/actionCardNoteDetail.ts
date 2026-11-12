import type { ActionCardEntry } from "./actionCardModel";
import { renderNoteChangeDetail } from "./noteChangeCard";
import { renderSavedNoteDetail } from "./savedNoteCard";

/**
 * The body an action row opens, for the rows that have one.
 *
 * Only a note row carries a detail today: the note the row wrote, or the diff
 * of the change it made. A row the projection gave no detail stays a single
 * line, so this returns null and the renderer draws no disclosure.
 */
export function renderActionCardDetail(
  doc: Document,
  entry: ActionCardEntry,
  status: HTMLElement,
  options: { readOnly?: boolean } = {},
): HTMLElement | null {
  if (!entry.detail) return null;
  return entry.detail.kind === "note_change"
    ? renderNoteChangeDetail(doc, entry.detail.card, status, options)
    : renderSavedNoteDetail(doc, entry.detail.card, status);
}
