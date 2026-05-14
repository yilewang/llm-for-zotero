import type { ConversationSystem } from "../../../../shared/types";
import { sanitizeText } from "../../textUtils";

export const GLOBAL_HISTORY_UNDO_WINDOW_MS = 6_000;
export const GLOBAL_HISTORY_TITLE_MAX_LENGTH = 64;
export const HISTORY_ROW_TITLE_MAX_LENGTH = 42;

export type ConversationHistoryEntry = {
  kind: "paper" | "global";
  section: "paper" | "open";
  sectionTitle: string;
  conversationKey: number;
  title: string;
  timestampText: string;
  deletable: boolean;
  isDraft: boolean;
  isPendingDelete: boolean;
  lastActivityAt: number;
  paperItemID?: number;
  sessionVersion?: number;
};

export type HistorySwitchTarget =
  | { kind: "paper"; conversationKey: number }
  | { kind: "global"; conversationKey: number }
  | null;

export type PendingHistoryDeletion = {
  kind: "paper" | "global";
  conversationKey: number;
  libraryID: number;
  conversationSystem: ConversationSystem;
  paperItemID?: number;
  title: string;
  wasActive: boolean;
  fallbackTarget: HistorySwitchTarget;
  expiresAt: number;
  timeoutId: number | null;
};

export type PaperHistoryNavigationDecision =
  | "load-in-place"
  | "select-target-paper"
  | "missing-target-paper";

export type HistoryPaperPaneSelector = {
  selectItems?: (itemIDs: number[], selectInLibrary?: boolean) => unknown;
  selectItem?: (itemID: number, selectInLibrary?: boolean) => unknown;
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
  if (timestamp >= yesterdayStart) return translateHistoryLabel("Yesterday", options);
  if (timestamp >= weekStart) return translateHistoryLabel("Last 7 days", options);
  if (timestamp >= monthStart) return translateHistoryLabel("Last 30 days", options);
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
    await pane.selectItems([paperItemID], true);
    return true;
  }
  if (typeof pane.selectItem === "function") {
    await pane.selectItem(paperItemID, true);
    return true;
  }
  return false;
}
