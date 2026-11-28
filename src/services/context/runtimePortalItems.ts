/**
 * Portal items of the runtime conversation systems (Claude Code, Codex,
 * Antigravity): the stand-in Zotero items a runtime's library chat or paper
 * chat is bound to. The three are built the same way; only the marker
 * properties, the titles and the system differ.
 */
declare const Zotero: any;

import {
  RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS,
  RUNTIME_CONVERSATION_SYSTEMS,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";
import { createNoteConversationItem } from "../notes/conversationItem";
import { isSupportedContextAttachment } from "../paperContent/contextAttachmentSupport";

/**
 * The properties that mark each runtime's portal items. They exist only in
 * memory, and a few call sites read them by name, so they keep these names.
 */
const PORTAL_MARKERS: Record<
  RuntimeConversationSystem,
  { global: string; paper: string; kind: string; baseItemID: string }
> = {
  claude_code: {
    global: "__llmClaudeGlobalPortalItem",
    paper: "__llmClaudePaperPortalItem",
    kind: "__llmClaudeConversationKind",
    baseItemID: "__llmClaudePaperPortalBaseItemID",
  },
  codex: {
    global: "__llmCodexGlobalPortalItem",
    paper: "__llmCodexPaperPortalItem",
    kind: "__llmCodexConversationKind",
    baseItemID: "__llmCodexPaperPortalBaseItemID",
  },
  antigravity: {
    global: "__llmAntigravityGlobalPortalItem",
    paper: "__llmAntigravityPaperPortalItem",
    kind: "__llmAntigravityConversationKind",
    baseItemID: "__llmAntigravityPaperPortalBaseItemID",
  },
};

/** The item a runtime's library chat is bound to. */
export function createRuntimeGlobalPortalItem(
  system: RuntimeConversationSystem,
  libraryID: number,
  conversationKey: number,
): any {
  const markers = PORTAL_MARKERS[system];
  const normalizedLibraryID =
    Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 1;
  const normalizedConversationKey =
    Number.isFinite(conversationKey) && conversationKey > 0
      ? Math.floor(conversationKey)
      : 1;
  return {
    [markers.global]: true,
    [markers.kind]: "global",
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") {
        return `${RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].label} Chat`;
      }
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
}

/**
 * The item a runtime's paper chat is bound to. A note gets a note
 * conversation item instead.
 */
export function createRuntimePaperPortalItem(
  system: RuntimeConversationSystem,
  basePaperItem: any,
  conversationKey: number,
): any {
  if (basePaperItem?.isNote?.()) {
    return createNoteConversationItem(basePaperItem, system, conversationKey);
  }
  const markers = PORTAL_MARKERS[system];
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
  return {
    [markers.paper]: true,
    [markers.kind]: "paper",
    [markers.baseItemID]: basePaperItemID,
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
      if (field === "title") {
        return `${RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].label} Paper Chat`;
      }
      return "";
    },
  };
}

function hasMarker(item: unknown, marker: string): boolean {
  return Boolean(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>)[marker] === true,
  );
}

export function isRuntimeGlobalPortalItem(
  system: RuntimeConversationSystem,
  item: unknown,
): boolean {
  return hasMarker(item, PORTAL_MARKERS[system].global);
}

export function isRuntimePaperPortalItem(
  system: RuntimeConversationSystem,
  item: unknown,
): boolean {
  return hasMarker(item, PORTAL_MARKERS[system].paper);
}

/** Whether the item is any runtime's library-chat portal item. */
export function isAnyRuntimeGlobalPortalItem(item: unknown): boolean {
  return RUNTIME_CONVERSATION_SYSTEMS.some((system) =>
    isRuntimeGlobalPortalItem(system, item),
  );
}

/** The runtime whose paper-chat portal item this is, or null. */
export function runtimePaperPortalSystemOf(
  item: unknown,
): RuntimeConversationSystem | null {
  return (
    RUNTIME_CONVERSATION_SYSTEMS.find((system) =>
      isRuntimePaperPortalItem(system, item),
    ) ?? null
  );
}

/** The id of the paper a runtime's paper-chat portal item stands for. */
export function getRuntimePaperPortalBaseItemID(
  system: RuntimeConversationSystem,
  item: unknown,
): number | null {
  if (!isRuntimePaperPortalItem(system, item)) return null;
  const value = Number(
    (item as Record<string, unknown>)[PORTAL_MARKERS[system].baseItemID],
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** The paper or supported attachment behind a runtime's paper-chat item. */
export function resolveRuntimePaperPortalBaseItem(
  system: RuntimeConversationSystem,
  item: unknown,
): any {
  const baseItemID = getRuntimePaperPortalBaseItemID(system, item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  if (resolved?.isRegularItem?.()) return resolved;
  return isSupportedContextAttachment(resolved) ? resolved : null;
}
