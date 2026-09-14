declare const Zotero: any;

import { getNoteConversation } from "./conversationItem";

import type {
  ActiveNoteSession,
  ConversationSystem,
} from "../../../shared/types";

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
}): ConversationSystem {
  const preferred = params.preferredSystem || "upstream";
  if (preferred === "claude_code" && !params.claudeAvailable) {
    return "upstream";
  }
  if (preferred === "codex" && !params.codexAvailable) {
    return "upstream";
  }
  return preferred;
}

export function resolveNoteFocusSystemSwitch(params: {
  nextSystem: ConversationSystem;
  claudeAvailable?: boolean;
  codexAvailable: boolean;
}): ConversationSystem | null {
  if (params.nextSystem === "claude_code" && !params.claudeAvailable) {
    return null;
  }
  if (params.nextSystem === "codex" && !params.codexAvailable) {
    return null;
  }
  return params.nextSystem;
}
