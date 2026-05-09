declare const Zotero: any;

import type {
  CodexGlobalPortalItem,
  CodexPaperPortalItem,
} from "../modules/contextPanel/types";

export function createCodexGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): any {
  const normalizedLibraryID = Number.isFinite(libraryID) && libraryID > 0
    ? Math.floor(libraryID)
    : 1;
  const normalizedConversationKey = Number.isFinite(conversationKey) && conversationKey > 0
    ? Math.floor(conversationKey)
    : 1;
  const portalItem: CodexGlobalPortalItem = {
    __llmCodexGlobalPortalItem: true,
    __llmCodexConversationKind: "global",
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "Codex Chat";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as any;
}

export function createCodexPaperPortalItem(
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
  const portalItem: CodexPaperPortalItem = {
    __llmCodexPaperPortalItem: true,
    __llmCodexConversationKind: "paper",
    __llmCodexPaperPortalBaseItemID: basePaperItemID,
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
      if (field === "title") return "Codex Paper Chat";
      return "";
    },
  };
  return portalItem as any;
}

export function isCodexGlobalPortalItem(
  item: unknown,
): item is CodexGlobalPortalItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      (item as Partial<CodexGlobalPortalItem>).__llmCodexGlobalPortalItem === true,
  );
}

export function isCodexPaperPortalItem(
  item: unknown,
): item is CodexPaperPortalItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      (item as Partial<CodexPaperPortalItem>).__llmCodexPaperPortalItem === true,
  );
}

export function isCodexPortalItem(
  item: unknown,
): item is CodexGlobalPortalItem | CodexPaperPortalItem {
  return isCodexGlobalPortalItem(item) || isCodexPaperPortalItem(item);
}

export function getCodexPaperPortalBaseItemID(item: unknown): number | null {
  if (!isCodexPaperPortalItem(item)) return null;
  const value = Number(item.__llmCodexPaperPortalBaseItemID);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveCodexPaperPortalBaseItem(
  item: any,
): any {
  const baseItemID = getCodexPaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  return resolved?.isRegularItem?.() ? resolved : null;
}
