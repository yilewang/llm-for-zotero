import {
  GLOBAL_CONVERSATION_KEY_BASE,
  PAPER_CONVERSATION_KEY_BASE,
} from "./constants";
import { normalizePositiveInt } from "./normalizers";
import { getLastUsedPaperConversationKey } from "./prefHelpers";
import { activePaperConversationByPaper } from "./state";
import type { GlobalPortalItem, PaperPortalItem } from "./types";

export function resolveActiveLibraryID(): number | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          getSelectedLibraryID?: () => unknown;
          getSelectedItems?: () => Zotero.Item[];
        }
      | undefined;
    const selectedLibraryID = normalizePositiveInt(
      pane?.getSelectedLibraryID?.(),
    );
    if (selectedLibraryID) return selectedLibraryID;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const firstItemLibrary = normalizePositiveInt(selectedItems[0]?.libraryID);
    if (firstItemLibrary) return firstItemLibrary;
  } catch (_err) {
    void _err;
  }

  const userLibraryID = normalizePositiveInt(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
  return userLibraryID;
}

export function createGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): Zotero.Item {
  const normalizedLibraryID = normalizePositiveInt(libraryID) || 1;
  const normalizedConversationKey =
    normalizePositiveInt(conversationKey) || GLOBAL_CONVERSATION_KEY_BASE;
  const portalItem: GlobalPortalItem = {
    __llmGlobalPortalItem: true,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "Global Library Portal";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as unknown as Zotero.Item;
}

export function isGlobalPortalItem(item: unknown): item is GlobalPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<GlobalPortalItem>;
  if (typed.__llmGlobalPortalItem !== true) return false;
  const normalizedId = normalizePositiveInt(typed.id);
  return Boolean(normalizedId && normalizedId >= GLOBAL_CONVERSATION_KEY_BASE);
}

export function createPaperPortalItem(
  basePaperItem: Zotero.Item,
  conversationKey: number,
  sessionVersion: number,
): Zotero.Item {
  const basePaperItemID = normalizePositiveInt(basePaperItem?.id) || 0;
  const normalizedLibraryID =
    normalizePositiveInt(basePaperItem?.libraryID) || 1;
  const normalizedConversationKey =
    normalizePositiveInt(conversationKey) || PAPER_CONVERSATION_KEY_BASE;
  const normalizedSessionVersion = normalizePositiveInt(sessionVersion) || 1;
  const portalItem: PaperPortalItem = {
    __llmPaperPortalItem: true,
    __llmPaperPortalBaseItemID: basePaperItemID,
    __llmPaperPortalSessionVersion: normalizedSessionVersion,
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
      if (!resolvedBase?.isRegularItem?.()) return [];
      return resolvedBase.getAttachments();
    },
    getField: (field: string) => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase) {
        try {
          return String(resolvedBase.getField(field) || "");
        } catch (_err) {
          void _err;
        }
      }
      if (field === "title") return "Paper chat";
      return "";
    },
  };
  return portalItem as unknown as Zotero.Item;
}

export function isPaperPortalItem(item: unknown): item is PaperPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<PaperPortalItem>;
  if (typed.__llmPaperPortalItem !== true) return false;
  const normalizedConversationKey = normalizePositiveInt(typed.id);
  const normalizedBasePaperID = normalizePositiveInt(
    typed.__llmPaperPortalBaseItemID,
  );
  return Boolean(normalizedConversationKey && normalizedBasePaperID);
}

export function getPaperPortalBaseItemID(item: unknown): number | null {
  if (!isPaperPortalItem(item)) return null;
  const normalized = normalizePositiveInt(item.__llmPaperPortalBaseItemID);
  return normalized || null;
}

export function getPaperPortalSessionVersion(item: unknown): number | null {
  if (!isPaperPortalItem(item)) return null;
  const normalized = normalizePositiveInt(item.__llmPaperPortalSessionVersion);
  return normalized || null;
}

export function resolvePaperPortalBaseItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const baseItemID = getPaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  return resolved?.isRegularItem?.() ? resolved : null;
}

export function resolveConversationBaseItem(
  targetItem: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!targetItem) return null;
  if (isGlobalPortalItem(targetItem)) return null;
  if (isPaperPortalItem(targetItem)) {
    return resolvePaperPortalBaseItem(targetItem);
  }
  if (targetItem.isAttachment() && targetItem.parentID) {
    const parent = Zotero.Items.get(targetItem.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return targetItem?.isRegularItem?.() ? targetItem : null;
}

function buildPaperStateKey(libraryID: number, paperItemID: number): string {
  return `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}

function resolveLibraryIdFromItem(
  targetItem: Zotero.Item | null | undefined,
): number {
  const parsed = Number(targetItem?.libraryID);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return resolveActiveLibraryID() || 0;
}

export function resolveInitialPanelItemState(
  initialItem: Zotero.Item | null | undefined,
): {
  item: Zotero.Item | null;
  basePaperItem: Zotero.Item | null;
} {
  let item = initialItem || null;
  const basePaperItem = resolveConversationBaseItem(item);
  if (!basePaperItem) {
    return { item, basePaperItem: null };
  }

  const libraryID = resolveLibraryIdFromItem(basePaperItem);
  const paperItemID = Number(basePaperItem.id || 0);
  const rememberedPaperKey = Number(
    activePaperConversationByPaper.get(
      buildPaperStateKey(libraryID, paperItemID),
    ) ||
      getLastUsedPaperConversationKey(libraryID, paperItemID) ||
      0,
  );
  if (
    Number.isFinite(rememberedPaperKey) &&
    rememberedPaperKey > 0 &&
    Math.floor(rememberedPaperKey) !== paperItemID
  ) {
    item = createPaperPortalItem(
      basePaperItem,
      Math.floor(rememberedPaperKey),
      0,
    );
  }

  return { item, basePaperItem };
}
