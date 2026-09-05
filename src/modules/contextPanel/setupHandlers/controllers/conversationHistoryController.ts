import type { ConversationSystem } from "../../../../shared/types";
import { resolveContextAttachmentSupportFromMetadata } from "../../contextAttachmentSupport";
import { sanitizeText } from "../../textUtils";

export const GLOBAL_HISTORY_TITLE_MAX_LENGTH = 64;
export const HISTORY_ROW_TITLE_MAX_LENGTH = 42;

export type ConversationHistoryEntry = {
  kind: "paper" | "global";
  sourceState: HistoryEntrySourceState;
  section: "paper" | "open";
  sectionTitle: string;
  conversationID?: string;
  conversationKey: number;
  libraryID?: number;
  title: string;
  timestampText: string;
  deletable: boolean;
  isDraft: boolean;
  isPendingDelete: boolean;
  lastActivityAt: number;
  userTurnCount?: number;
  paperItemID?: number;
  catalogPaperItemID?: number;
  sessionVersion?: number;
  providerSessionId?: string;
  scopedConversationKey?: string;
};

export type HistoryEntrySourceState = "active" | "orphan";
export type HistoryEntryLabelType = "paper" | "library" | "orphan";

export type HistorySwitchTarget =
  | { kind: "paper"; conversationKey: number }
  | { kind: "global"; conversationKey: number }
  | null;

export type PaperHistoryNavigationDecision =
  | "load-in-place"
  | "select-target-paper"
  | "missing-target-paper";

export type HistoryPaperPaneSelector = {
  selectItems?: (
    itemIDs: number[],
    options?: boolean | { selectInLibrary?: boolean },
  ) => unknown;
  selectItem?: (itemID: number, selectInLibrary?: boolean) => unknown;
};

export type HistoryPaperItemLike = {
  id?: unknown;
  parentID?: unknown;
  deleted?: unknown;
  firstCreator?: unknown;
  attachmentContentType?: unknown;
  attachmentFilename?: unknown;
  isAttachment?: () => boolean;
  isRegularItem?: () => boolean;
  isNote?: () => boolean;
  getField?: (field: string) => unknown;
  getDisplayTitle?: () => unknown;
};

export type HistoryPaperDisplayMetadata = {
  itemID: number;
  title: string;
  firstCreator: string;
  year: string;
};

export type HistoryDayGroup<T> = {
  label: string;
  items: T[];
};

type HistoryDayGroupOptions = {
  now?: Date | number;
  translate?: (label: string) => string;
};

function translateHistoryLabel(
  label: string,
  options?: HistoryDayGroupOptions,
): string {
  return options?.translate ? options.translate(label) : label;
}

export function getHistoryDayGroupLabel(
  timestamp: number,
  options?: HistoryDayGroupOptions,
): string {
  const nowInput = options?.now;
  const now =
    nowInput instanceof Date
      ? nowInput
      : typeof nowInput === "number" && Number.isFinite(nowInput)
        ? new Date(nowInput)
        : new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const monthStart = todayStart - 29 * 86_400_000;
  if (timestamp >= todayStart) return translateHistoryLabel("Today", options);
  if (timestamp >= yesterdayStart)
    return translateHistoryLabel("Yesterday", options);
  if (timestamp >= weekStart)
    return translateHistoryLabel("Last 7 days", options);
  if (timestamp >= monthStart)
    return translateHistoryLabel("Last 30 days", options);
  return translateHistoryLabel("Older", options);
}

export function groupHistoryEntriesByDay<T extends { lastActivityAt: number }>(
  entries: T[],
  options?: HistoryDayGroupOptions,
): Array<HistoryDayGroup<T>> {
  const groups: Array<HistoryDayGroup<T>> = [];
  let currentLabel = "";
  for (const entry of entries) {
    const label = getHistoryDayGroupLabel(entry.lastActivityAt, options);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(entry);
  }
  return groups;
}

export function formatGlobalHistoryTimestamp(timestamp: number): string {
  try {
    const parsed = Number(timestamp);
    if (!Number.isFinite(parsed) || parsed <= 0) return "";
    return new Intl.DateTimeFormat(undefined, {
      year: "2-digit",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(parsed));
  } catch (_err) {
    return "";
  }
}

export function normalizeConversationTitleSeed(
  raw: unknown,
  maxLength = GLOBAL_HISTORY_TITLE_MAX_LENGTH,
): string {
  const normalized = sanitizeText(String(raw || ""))
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 3) {
    return normalized;
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

export function normalizeHistoryTitle(raw: unknown): string {
  return normalizeConversationTitleSeed(raw, GLOBAL_HISTORY_TITLE_MAX_LENGTH);
}

export function formatHistoryRowDisplayTitle(title: string): string {
  return (
    normalizeConversationTitleSeed(title, HISTORY_ROW_TITLE_MAX_LENGTH) ||
    "Untitled chat"
  );
}

export function normalizeHistoryPaperItemID(raw: unknown): number {
  const parsed = Number(raw || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function resolveHistoryEntryPaperItem<T>(
  entry: Pick<ConversationHistoryEntry, "paperItemID">,
  getItem: (paperItemID: number) => T | null | undefined,
): T | null {
  const paperItemID = normalizeHistoryPaperItemID(entry.paperItemID);
  if (!paperItemID) return null;
  try {
    return getItem(paperItemID) || null;
  } catch (_err) {
    return null;
  }
}

function normalizeHistoryMetadataText(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

function readHistoryPaperField(
  item: HistoryPaperItemLike | null | undefined,
  field: string,
): string {
  try {
    return normalizeHistoryMetadataText(item?.getField?.(field));
  } catch (_err) {
    return "";
  }
}

function extractHistoryPaperYear(raw: string): string {
  const direct = raw.trim();
  if (/^\d{4}$/.test(direct)) return direct;
  const match = direct.match(/\b([12][0-9]{3})\b/);
  return match?.[1] || "";
}

function isHistoryPaperItemDeleted(
  item: HistoryPaperItemLike | null | undefined,
): boolean {
  return Boolean(item?.deleted);
}

function isSupportedStandaloneHistoryAttachment(
  item: HistoryPaperItemLike | null | undefined,
): boolean {
  if (!item?.isAttachment?.() || normalizeHistoryPaperItemID(item.parentID)) {
    return false;
  }
  return Boolean(
    resolveContextAttachmentSupportFromMetadata({
      contentType: item.attachmentContentType,
      filename: item.attachmentFilename,
    }),
  );
}

export function resolveHistoryEntryPaperBaseItem<
  T extends HistoryPaperItemLike,
>(
  entry: Pick<ConversationHistoryEntry, "paperItemID">,
  getItem: (paperItemID: number) => T | null | undefined,
): T | null {
  const item = resolveHistoryEntryPaperItem(entry, getItem);
  if (!item) return null;

  const isRegular = Boolean(item.isRegularItem?.());
  const isAttachment = Boolean(item.isAttachment?.());
  const isNote = Boolean(item.isNote?.());
  if (isRegular && !isAttachment && !isNote) {
    return isHistoryPaperItemDeleted(item) ? null : item;
  }

  if (isAttachment || isNote) {
    const parentID = normalizeHistoryPaperItemID(item.parentID);
    if (parentID) {
      try {
        const parentItem = getItem(parentID) || null;
        if (
          parentItem?.isRegularItem?.() &&
          !isHistoryPaperItemDeleted(parentItem)
        ) {
          return parentItem;
        }
      } catch (_err) {
        return null;
      }
    }
    if (
      isAttachment &&
      isSupportedStandaloneHistoryAttachment(item) &&
      !isHistoryPaperItemDeleted(item)
    ) {
      return item;
    }
  }

  return isRegular && !isHistoryPaperItemDeleted(item) ? item : null;
}

export function readHistoryPaperDisplayMetadata(
  item: HistoryPaperItemLike | null | undefined,
): HistoryPaperDisplayMetadata | null {
  if (!item) return null;
  const itemID = normalizeHistoryPaperItemID(item.id);
  if (!itemID) return null;
  const title =
    readHistoryPaperField(item, "title") ||
    normalizeHistoryMetadataText(item.getDisplayTitle?.());
  const firstCreator =
    readHistoryPaperField(item, "firstCreator") ||
    normalizeHistoryMetadataText(item.firstCreator);
  const year =
    extractHistoryPaperYear(readHistoryPaperField(item, "year")) ||
    extractHistoryPaperYear(readHistoryPaperField(item, "date")) ||
    extractHistoryPaperYear(readHistoryPaperField(item, "issued"));
  return { itemID, title, firstCreator, year };
}

export function resolveHistoryEntryPaperDisplayMetadata<
  T extends HistoryPaperItemLike,
>(
  entry: Pick<ConversationHistoryEntry, "paperItemID">,
  getItem: (paperItemID: number) => T | null | undefined,
): HistoryPaperDisplayMetadata | null {
  return readHistoryPaperDisplayMetadata(
    resolveHistoryEntryPaperBaseItem(entry, getItem),
  );
}

export function resolveHistoryEntrySourceState<T extends HistoryPaperItemLike>(
  entry: Pick<ConversationHistoryEntry, "kind" | "paperItemID">,
  getItem: (paperItemID: number) => T | null | undefined,
): HistoryEntrySourceState {
  if (entry.kind !== "paper") return "active";
  return resolveHistoryEntryPaperBaseItem(entry, getItem) ? "active" : "orphan";
}

export function isOrphanHistoryEntry(
  entry: Pick<ConversationHistoryEntry, "kind" | "sourceState">,
): boolean {
  return entry.kind === "paper" && entry.sourceState === "orphan";
}

export function getHistoryEntryLabelType(
  entry: Pick<ConversationHistoryEntry, "kind" | "sourceState">,
): HistoryEntryLabelType {
  if (isOrphanHistoryEntry(entry)) return "orphan";
  return entry.kind === "paper" ? "paper" : "library";
}

export function formatHistoryPaperScopeLabel(
  metadata: HistoryPaperDisplayMetadata | null | undefined,
  fallback = "Paper chat",
): string {
  if (!metadata) return fallback;
  if (metadata.firstCreator && metadata.year) {
    return `${metadata.firstCreator}, ${metadata.year}`;
  }
  return metadata.firstCreator || metadata.year || fallback;
}

export function resolvePaperHistoryNavigationDecision(params: {
  entryPaperItemID?: unknown;
  currentPaperItemID?: unknown;
}): PaperHistoryNavigationDecision {
  const entryPaperItemID = normalizeHistoryPaperItemID(params.entryPaperItemID);
  if (!entryPaperItemID) return "missing-target-paper";
  const currentPaperItemID = normalizeHistoryPaperItemID(
    params.currentPaperItemID,
  );
  return currentPaperItemID === entryPaperItemID
    ? "load-in-place"
    : "select-target-paper";
}

export async function maybeSelectPaperHistoryTarget(params: {
  decision: PaperHistoryNavigationDecision;
  paperItemID?: unknown;
  getPane: () => HistoryPaperPaneSelector | null | undefined;
}): Promise<boolean> {
  if (params.decision === "load-in-place") return true;
  if (params.decision === "missing-target-paper") return false;
  const paperItemID = normalizeHistoryPaperItemID(params.paperItemID);
  if (!paperItemID) return false;
  const pane = params.getPane();
  if (!pane) return false;
  if (typeof pane.selectItems === "function") {
    await pane.selectItems([paperItemID], { selectInLibrary: true });
    return true;
  }
  if (typeof pane.selectItem === "function") {
    await pane.selectItem(paperItemID, true);
    return true;
  }
  return false;
}
