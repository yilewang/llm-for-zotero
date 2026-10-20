import { createNoteConversationItem } from "../services/notes/conversationItem";
declare const Zotero: any;

import type {
  AntigravityGlobalPortalItem,
  AntigravityPaperPortalItem,
} from "../modules/contextPanel/types";
import { isSupportedContextAttachment } from "../services/paperContent/contextAttachmentSupport";

export function createAntigravityGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): any {
  const normalizedLibraryID =
    Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 1;
  const normalizedConversationKey =
    Number.isFinite(conversationKey) && conversationKey > 0
      ? Math.floor(conversationKey)
      : 1;
  const portalItem: AntigravityGlobalPortalItem = {
    __llmAntigravityGlobalPortalItem: true,
    __llmAntigravityConversationKind: "global",
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "Antigravity Chat";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as any;
}

export function createAntigravityPaperPortalItem(
  basePaperItem: any,
  conversationKey: number,
): any {
  if (basePaperItem?.isNote?.()) {
    return createNoteConversationItem(
      basePaperItem,
      "antigravity",
      conversationKey,
    );
  }
  const basePaperItemID =
    Number.isFinite(basePaperItem?.id) && basePaperItem.id > 0
      ? Math.floor(basePaperItem.id)
      : 0;
  const normalizedLibraryID =
    Number.isFinite(basePaperItem?.libraryID) && basePaperItem.libraryID > 0
      ? Math.floor(basePaperItem.libraryID)
      : 1;
  const normalizedConversationKey =
    Number.isFinite(conversationKey) && conversationKey > 0
      ? Math.floor(conversationKey)
      : Math.max(1, basePaperItemID);
  const portalItem: AntigravityPaperPortalItem = {
    __llmAntigravityPaperPortalItem: true,
    __llmAntigravityConversationKind: "paper",
    __llmAntigravityPaperPortalBaseItemID: basePaperItemID,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase?.isRegularItem?.()) return resolvedBase.getAttachments();
      if (isSupportedContextAttachment(resolvedBase)) return [basePaperItemID];
      return [];
    },
    getField: (field: string) => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase) {
        try {
          return String(resolvedBase.getField(field) || "");
        } catch {
          return "";
        }
      }
      if (field === "title") return "Antigravity Paper Chat";
      return "";
    },
  };
  return portalItem as any;
}

export function isAntigravityGlobalPortalItem(
  item: unknown,
): item is AntigravityGlobalPortalItem {
  return Boolean(
    item &&
    typeof item === "object" &&
    (item as Partial<AntigravityGlobalPortalItem>)
      .__llmAntigravityGlobalPortalItem === true,
  );
}

export function isAntigravityPaperPortalItem(
  item: unknown,
): item is AntigravityPaperPortalItem {
  return Boolean(
    item &&
    typeof item === "object" &&
    (item as Partial<AntigravityPaperPortalItem>)
      .__llmAntigravityPaperPortalItem === true,
  );
}

export function isAntigravityPortalItem(
  item: unknown,
): item is AntigravityGlobalPortalItem | AntigravityPaperPortalItem {
  return (
    isAntigravityGlobalPortalItem(item) || isAntigravityPaperPortalItem(item)
  );
}

export function getAntigravityPaperPortalBaseItemID(
  item: unknown,
): number | null {
  if (!isAntigravityPaperPortalItem(item)) return null;
  const value = Number(item.__llmAntigravityPaperPortalBaseItemID);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveAntigravityPaperPortalBaseItem(item: any): any {
  const baseItemID = getAntigravityPaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  if (resolved?.isRegularItem?.()) return resolved;
  return isSupportedContextAttachment(resolved) ? resolved : null;
}
