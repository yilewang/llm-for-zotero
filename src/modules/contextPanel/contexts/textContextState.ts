/**
 * Text selection context state — pure state operations with no DOM dependencies.
 */

import {
  clearPinnedContextOwner,
  retainPinnedSelectedTextContexts,
} from "../setupHandlers/controllers/pinnedContextController";
import {
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  setSelectedTextExpandedIndex,
  setNoteContextExpanded,
} from "../contextResolution";
import { isOpenNoteContext } from "../noteEditing/openNoteContext";
import { isMirroredNoteSelection } from "../noteEditing/selectionController";
import type { SelectedTextContext } from "../types";

export function clearSelectedTextState(
  pinnedSelectedTextKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  setSelectedTextContextEntries(itemId, []);
  setSelectedTextExpandedIndex(itemId, null);
  setNoteContextExpanded(itemId, null);
  clearPinnedContextOwner(pinnedSelectedTextKeys, itemId);
}

/**
 * What stays in the composer after a send: the pinned chips, and the chips
 * the note tracker keeps current for this conversation (the open note, and
 * the note's selection where the chat mirrors it). Every other chip went
 * with the message, a selection handed over from a note included.
 */
export function retainPinnedTextState(
  pinnedSelectedTextKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const contexts = getSelectedTextContextEntries(itemId);
  const isKeptCurrent = (context: SelectedTextContext) =>
    isMirroredNoteSelection(itemId, context) ||
    isOpenNoteContext(itemId, context);
  const kept = new Set([
    ...contexts.filter(isKeptCurrent),
    ...retainPinnedSelectedTextContexts(
      pinnedSelectedTextKeys,
      itemId,
      contexts.filter((context) => !isKeptCurrent(context)),
    ),
  ]);
  // A kept chip keeps its text across sends; its question was for the turn
  // just sent (D5).
  const withoutQuestion = (context: SelectedTextContext) => {
    if (context.userQuery === undefined) return context;
    const { userQuery: _sentQuestion, ...rest } = context;
    return rest;
  };
  setSelectedTextContextEntries(
    itemId,
    contexts.filter((context) => kept.has(context)).map(withoutQuestion),
  );
  setSelectedTextExpandedIndex(itemId, null);
  setNoteContextExpanded(itemId, null);
}
