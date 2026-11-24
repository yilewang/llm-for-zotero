import type {
  ConversationSystem,
  NoteContextRef,
  SelectedTextContext,
} from "../../../shared/types";
import {
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  syncSelectedTextContextForSource,
} from "../contextResolution";
import { resolveConversationKeyForNoteFocus } from "../portalScope";
import {
  resolveNoteEditingParentItem,
  resolveNoteEditingScope,
} from "../../../services/notes/scope";

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The conversations whose "Editing" chip mirrors the note's selection: the
 * note tracker rewrites the chip as the selection changes and clears it when
 * the selection ends.
 */
const mirroredConversations = new Set<number>();

/**
 * True for the "Editing" chip of a conversation that mirrors the note's
 * selection, which a send leaves in the composer. A selection handed to
 * another chat (the inline popup's Ask in sidebar) is not mirrored there.
 */
export function isMirroredNoteSelection(
  conversationKey: number,
  context: SelectedTextContext,
): boolean {
  return (
    context.source === "note-edit" && mirroredConversations.has(conversationKey)
  );
}

export function getNoteFocusConversationKey(
  item: Zotero.Item | null | undefined,
  system?: ConversationSystem | null,
): number | null {
  return resolveConversationKeyForNoteFocus(item, {
    conversationSystem: system,
  });
}

export function buildNoteEditingSelectedTextContext(
  item: Zotero.Item | null | undefined,
): NoteContextRef | null {
  const scope = resolveNoteEditingScope(item);
  if (!scope) return null;
  const parentItem = resolveNoteEditingParentItem(item);
  return {
    libraryID: scope.libraryID,
    noteItemKey: normalizeTitle((item as any)?.key) || `${scope.noteId}`,
    noteItemId: scope.noteId,
    parentItemId: scope.parentItemId,
    parentItemKey: normalizeTitle((parentItem as any)?.key) || undefined,
    noteKind: scope.noteKind,
    title: scope.title || `Note ${scope.noteId}`,
  };
}

export function syncNoteEditingSelectedText(params: {
  noteItem: Zotero.Item | null | undefined;
  text: string;
  system?: ConversationSystem | null;
  conversationKey?: number;
}): { conversationKey: number; changed: boolean } | null {
  const conversationKey =
    params.conversationKey ||
    getNoteFocusConversationKey(params.noteItem, params.system);
  const noteContext = buildNoteEditingSelectedTextContext(params.noteItem);
  if (!conversationKey || !noteContext) return null;
  mirroredConversations.add(conversationKey);
  return {
    conversationKey,
    changed: syncSelectedTextContextForSource(
      conversationKey,
      params.text,
      "note-edit",
      { noteContext },
    ),
  };
}

export function clearNoteEditingSelectedText(
  conversationKey: number | null | undefined,
): { conversationKey: number; changed: boolean } | null {
  const normalized = Math.floor(Number(conversationKey || 0));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  mirroredConversations.delete(normalized);
  return {
    conversationKey: normalized,
    changed: syncSelectedTextContextForSource(normalized, "", "note-edit"),
  };
}

export function copyNoteEditingSelectedTextContext(params: {
  fromConversationKey: number;
  toConversationKey: number;
}): boolean {
  const fromKey = Math.floor(Number(params.fromConversationKey || 0));
  const toKey = Math.floor(Number(params.toConversationKey || 0));
  if (!Number.isFinite(fromKey) || fromKey <= 0) return false;
  if (!Number.isFinite(toKey) || toKey <= 0) return false;
  if (fromKey === toKey) return false;
  const noteEditingEntries = getSelectedTextContextEntries(fromKey).filter(
    (entry) => entry.source === "note-edit",
  );
  if (!noteEditingEntries.length) return false;
  const existing = getSelectedTextContextEntries(toKey).filter(
    (entry) => entry.source !== "note-edit",
  );
  setSelectedTextContextEntries(toKey, [...noteEditingEntries, ...existing]);
  mirroredConversations.add(toKey);
  return true;
}
