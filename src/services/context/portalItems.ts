import { UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE } from "../../shared/conversationKeySpace";
import { isSupportedContextAttachment } from "../paperContent/contextAttachmentSupport";
import { normalizePositiveInt } from "./normalizers";

export type GlobalPortalItem = {
  __llmGlobalPortalItem: true;
  id: number;
  libraryID: number;
  parentID?: number;
  attachmentContentType?: string;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  isRegularItem: () => boolean;
};

export type PaperPortalItem = {
  __llmPaperPortalItem: true;
  __llmPaperPortalBaseItemID: number;
  __llmPaperPortalSessionVersion: number;
  id: number;
  libraryID: number;
  parentID?: number;
  attachmentContentType?: string;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  isRegularItem: () => boolean;
};

export function isGlobalPortalItem(item: unknown): item is GlobalPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<GlobalPortalItem>;
  if (typed.__llmGlobalPortalItem !== true) return false;
  const id = normalizePositiveInt(typed.id);
  return Boolean(id && id >= UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE);
}

export function isPaperPortalItem(item: unknown): item is PaperPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<PaperPortalItem>;
  return Boolean(
    typed.__llmPaperPortalItem === true &&
    normalizePositiveInt(typed.id) &&
    normalizePositiveInt(typed.__llmPaperPortalBaseItemID),
  );
}

export function getPaperPortalBaseItemID(item: unknown): number | null {
  return isPaperPortalItem(item)
    ? normalizePositiveInt(item.__llmPaperPortalBaseItemID)
    : null;
}

export function isPaperChatBaseItem(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  if (!item) return false;
  if (item.isAttachment?.()) return isSupportedContextAttachment(item);
  return Boolean(item.isRegularItem?.());
}

export function resolvePaperPortalBaseItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const baseItemId = getPaperPortalBaseItemID(item);
  if (!baseItemId) return null;
  const resolved = Zotero.Items.get(baseItemId) || null;
  return isPaperChatBaseItem(resolved) ? resolved : null;
}
