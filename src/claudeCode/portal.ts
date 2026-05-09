declare const Zotero: any;

import type {
  ClaudeGlobalPortalItem,
  ClaudePaperPortalItem,
} from "../modules/contextPanel/types";

export function createClaudeGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): any {
  const normalizedLibraryID = Number.isFinite(libraryID) && libraryID > 0
    ? Math.floor(libraryID)
    : 1;
  const normalizedConversationKey = Number.isFinite(conversationKey) && conversationKey > 0
    ? Math.floor(conversationKey)
    : 1;
  const portalItem: ClaudeGlobalPortalItem = {
    __llmClaudeGlobalPortalItem: true,
    __llmClaudeConversationKind: "global",
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "Claude Code Chat";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as any;
}

export function createClaudePaperPortalItem(
  basePaperItem: any,
  conversationKey: number,
): any {
  const basePaperItemID = Number.isFinite(basePaperItem?.id) && basePaperItem.id > 0
    ? Math.floor(basePaperItem.id)
    : 0;
  const normalizedLibraryID =
    Number.isFinite(basePaperItem?.libraryID) && basePaperItem.libraryID > 0
      ? Math.floor(basePaperItem.libraryID)
      : 1;
  const normalizedConversationKey = Number.isFinite(conversationKey) && conversationKey > 0
    ? Math.floor(conversationKey)
    : Math.max(1, basePaperItemID);
  const portalItem: ClaudePaperPortalItem = {
    __llmClaudePaperPortalItem: true,
    __llmClaudeConversationKind: "paper",
    __llmClaudePaperPortalBaseItemID: basePaperItemID,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => {
      const resolvedBase = basePaperItemID ? Zotero.Items.get(basePaperItemID) || null : null;
      if (!resolvedBase?.isRegularItem?.()) return [];
      return resolvedBase.getAttachments();
    },
    getField: (field: string) => {
      const resolvedBase = basePaperItemID ? Zotero.Items.get(basePaperItemID) || null : null;
      if (resolvedBase) {
        try {
          return String(resolvedBase.getField(field) || "");
        } catch {
          return "";
        }
      }
      if (field === "title") return "Claude Code Paper Chat";
      return "";
    },
  };
  return portalItem as any;
}

export function isClaudeGlobalPortalItem(
  item: unknown,
): item is ClaudeGlobalPortalItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      (item as Partial<ClaudeGlobalPortalItem>).__llmClaudeGlobalPortalItem === true,
  );
}

export function isClaudePaperPortalItem(
  item: unknown,
): item is ClaudePaperPortalItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      (item as Partial<ClaudePaperPortalItem>).__llmClaudePaperPortalItem === true,
  );
}

export function isClaudePortalItem(
  item: unknown,
): item is ClaudeGlobalPortalItem | ClaudePaperPortalItem {
  return isClaudeGlobalPortalItem(item) || isClaudePaperPortalItem(item);
}

export function getClaudePaperPortalBaseItemID(item: unknown): number | null {
  if (!isClaudePaperPortalItem(item)) return null;
  const value = Number(item.__llmClaudePaperPortalBaseItemID);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveClaudePaperPortalBaseItem(
  item: any,
): any {
  const baseItemID = getClaudePaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  return resolved?.isRegularItem?.() ? resolved : null;
}
