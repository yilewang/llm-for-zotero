declare const Zotero: any;

import { getNoteConversation } from "./conversationItem";

import type { ActiveNoteSession, ConversationSystem } from "../../shared/types";
import {
  isRuntimeConversationSystem,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";

export type NoteEditingScope = ActiveNoteSession;

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveActiveTabTitleForNote(
  item: Zotero.Item | null | undefined,
): string {
  item = getNoteConversation(item)?.note || item;
  const noteId = normalizePositiveInt(item?.id);
  if (!noteId) return "";
  const tabsCandidates = [
    (Zotero as unknown as { Tabs?: unknown }).Tabs,
    (Zotero.getMainWindow?.() as { Zotero?: { Tabs?: unknown } } | undefined)
      ?.Zotero?.Tabs,
    (Zotero.getActiveZoteroPane?.() as { document?: Document } | undefined)
      ?.document?.defaultView &&
      (
        (Zotero.getActiveZoteroPane?.() as { document?: Document } | undefined)
          ?.document?.defaultView as { Zotero?: { Tabs?: unknown } }
      ).Zotero?.Tabs,
  ];
  for (const candidate of tabsCandidates) {
    const tabs = candidate as
      | {
          selectedID?: string | number;
          _tabs?: Array<Record<string, unknown>>;
        }
      | undefined;
    const selectedId =
      tabs?.selectedID === undefined || tabs?.selectedID === null
        ? ""
        : `${tabs.selectedID}`;
    const activeTab = Array.isArray(tabs?._tabs)
      ? tabs!._tabs!.find((tab) => `${tab?.id || ""}` === selectedId)
      : null;
    if (!activeTab) continue;
    const data = (activeTab.data || {}) as Record<string, unknown>;
    const candidateItemId = normalizePositiveInt(
      data.itemID || data.itemId || data.id,
    );
    if (candidateItemId && candidateItemId !== noteId) continue;
    const titleCandidates = [
      activeTab.title,
      activeTab.label,
      activeTab.name,
      data.title,
      data.label,
      data.name,
      data.noteTitle,
      data.itemTitle,
    ];
    for (const raw of titleCandidates) {
      const title = normalizeTitle(raw);
      if (title) return title;
    }
  }
  return "";
}

export function resolveNoteEditingParentItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  item = getNoteConversation(item)?.note || item;
  if (!(item as any)?.isNote?.()) return null;
  const parentID = normalizePositiveInt(item?.parentID);
  if (!parentID) return null;
  const parentItem = Zotero.Items.get(parentID) || null;
  return parentItem?.isRegularItem?.() ? parentItem : null;
}

/**
 * The paper whose chat an opened note joins.
 *
 * A note joins the chat of what it belongs to: a paper's note is a place to
 * write beside that paper's conversation, so opening it keeps the paper's
 * chat. A standalone note belongs to nothing and keeps its own chat, and a
 * note conversation the user opens on purpose (from the history) is already
 * bound to its note: both return null, as does anything that is not a note.
 */
export function resolveOpenedNotePaper(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item || getNoteConversation(item)) return null;
  return resolveNoteEditingParentItem(item);
}

/**
 * The item whose chats a history row belongs with: a child note's chats sit
 * with its parent paper's chats, so a paper's history also lists the chats
 * of its notes. Anything else is its own family.
 */
export function resolveChatFamilyItemID(itemID: unknown): number {
  const id = normalizePositiveInt(itemID);
  if (!id) return 0;
  const item = Zotero.Items.get(id) || null;
  return normalizePositiveInt(resolveNoteEditingParentItem(item)?.id) || id;
}

/** The family's own item first, then the notes of a regular item. */
export function listChatFamilyItemIDs(itemID: unknown): number[] {
  const rootID = resolveChatFamilyItemID(itemID);
  if (!rootID) return [];
  const root = Zotero.Items.get(rootID) || null;
  const noteIDs = root?.isRegularItem?.()
    ? (root.getNotes?.() || []).map(Number)
    : [];
  return [rootID, ...noteIDs.filter((id: number) => id > 0 && id !== rootID)];
}

export function resolveNoteEditingTitle(
  item: Zotero.Item | null | undefined,
): string {
  item = getNoteConversation(item)?.note || item;
  if (!(item as any)?.isNote?.()) return "";
  const activeTabTitle = resolveActiveTabTitleForNote(item);
  if (activeTabTitle) return activeTabTitle;
  try {
    const raw = normalizeTitle((item as any).getDisplayTitle?.());
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  try {
    const raw = normalizeTitle((item as any).getField?.("title"));
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  try {
    const raw = normalizeTitle((item as any).getNoteTitle?.());
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  return "";
}

export function resolveNoteEditingScope(
  item: Zotero.Item | null | undefined,
): NoteEditingScope | null {
  item = getNoteConversation(item)?.note || item;
  if (!(item as any)?.isNote?.()) return null;
  const noteId = normalizePositiveInt(item?.id);
  const libraryID = normalizePositiveInt(item?.libraryID);
  if (!noteId || !libraryID) return null;
  const parentItem = resolveNoteEditingParentItem(item);
  const title = resolveNoteEditingTitle(item);
  return {
    noteKind: parentItem ? "item" : "standalone",
    noteId,
    libraryID,
    title,
    parentItemId: parentItem?.id,
    // The catalog's historical "paper" kind is an individual-item scope.
    // Notes use their own item, never a library or parent-paper conversation.
    conversationKind: "paper",
  };
}

export function resolvePreferredNoteFocusSystem(params: {
  preferredSystem?: ConversationSystem | null;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  antigravityAvailable?: boolean;
}): ConversationSystem {
  const preferred = params.preferredSystem || "upstream";
  const available: Record<RuntimeConversationSystem, boolean> = {
    claude_code: params.claudeAvailable,
    codex: params.codexAvailable,
    antigravity: Boolean(params.antigravityAvailable),
  };
  if (isRuntimeConversationSystem(preferred) && !available[preferred]) {
    return "upstream";
  }
  return preferred;
}

export function resolveNoteFocusSystemSwitch(params: {
  nextSystem: ConversationSystem;
  claudeAvailable?: boolean;
  codexAvailable: boolean;
  antigravityAvailable?: boolean;
}): ConversationSystem | null {
  const available: Record<RuntimeConversationSystem, boolean> = {
    claude_code: Boolean(params.claudeAvailable),
    codex: params.codexAvailable,
    antigravity: Boolean(params.antigravityAvailable),
  };
  if (
    isRuntimeConversationSystem(params.nextSystem) &&
    !available[params.nextSystem]
  ) {
    return null;
  }
  return params.nextSystem;
}
