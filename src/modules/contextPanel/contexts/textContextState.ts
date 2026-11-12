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

export function retainPinnedTextState(
  pinnedSelectedTextKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const contexts = getSelectedTextContextEntries(itemId);
  const liveNoteEditingContexts = contexts.filter(
    (context) => context.source === "note-edit",
  );
  const retained = retainPinnedSelectedTextContexts(
    pinnedSelectedTextKeys,
    itemId,
    contexts.filter((context) => context.source !== "note-edit"),
  );
  // A kept chip keeps its text across sends; its question was for the turn
  // just sent (D5).
  const withoutQuestion = (context: SelectedTextContext) => {
    if (context.userQuery === undefined) return context;
    const { userQuery: _sentQuestion, ...rest } = context;
    return rest;
  };
  setSelectedTextContextEntries(
    itemId,
    [...liveNoteEditingContexts, ...retained].map(withoutQuestion),
  );
  setSelectedTextExpandedIndex(itemId, null);
  setNoteContextExpanded(itemId, null);
}
