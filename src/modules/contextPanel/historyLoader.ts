import { conversationRepository } from "../../core/conversations/repository";
import { normalizeHistoryTitle } from "./setupHandlers/controllers/conversationHistoryController";

export type ConversationHistoryScopeMode = "open" | "paper";

export type ConversationHistoryScopeParams = {
  mode: ConversationHistoryScopeMode;
  libraryID: number;
  paperItemID?: number;
  limit: number;
};

export type ConversationHistoryScopeEntry = {
  mode: ConversationHistoryScopeMode;
  conversationID: string;
  conversationKey: number;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  userTurnCount: number;
  isDraft: boolean;
  sessionVersion?: number;
  paperItemID?: number;
};

function normalizeScopeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.floor(limit));
}

function normalizeTitle(raw: unknown, isDraft: boolean): string {
  return normalizeHistoryTitle(raw) || (isDraft ? "New chat" : "Untitled chat");
}

function isDraftSummary(summary: {
  title?: unknown;
  userTurnCount?: unknown;
}): boolean {
  const userTurnCount = Number(summary.userTurnCount || 0);
  const title = normalizeHistoryTitle(summary.title);
  return userTurnCount <= 0 && !title;
}

export async function loadConversationHistoryScope(
  params: ConversationHistoryScopeParams,
): Promise<ConversationHistoryScopeEntry[]> {
  const normalizedLibraryID =
    Number.isFinite(params.libraryID) && params.libraryID > 0
      ? Math.floor(params.libraryID)
      : 0;
  if (normalizedLibraryID <= 0) return [];

  const normalizedLimit = normalizeScopeLimit(params.limit);

  if (params.mode === "open") {
    const summaries = await conversationRepository.listCatalogEntries({
      system: "upstream",
      kind: "global",
      libraryID: normalizedLibraryID,
      limit: normalizedLimit,
      includeEmpty: true,
    });
    return summaries.map((summary) => {
      const lastActivityAt = Number(
        summary.lastActivityAt || summary.createdAt || 0,
      );
      const createdAt = Number(summary.createdAt || lastActivityAt || 0);
      const userTurnCount = Number(summary.userTurnCount || 0);
      const isDraft = isDraftSummary(summary);
      return {
        mode: "open" as const,
        conversationID: summary.conversationID,
        conversationKey: summary.conversationKey,
        title: normalizeTitle(summary.title, isDraft),
        createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : 0,
        lastActivityAt: Number.isFinite(lastActivityAt)
          ? Math.floor(lastActivityAt)
          : 0,
        userTurnCount: Number.isFinite(userTurnCount)
          ? Math.max(0, Math.floor(userTurnCount))
          : 0,
        isDraft,
      };
    });
  }

  const normalizedPaperItemID =
    Number.isFinite(params.paperItemID) && Number(params.paperItemID) > 0
      ? Math.floor(Number(params.paperItemID))
      : 0;
  if (normalizedPaperItemID <= 0) return [];

  const summaries = await conversationRepository.listCatalogEntries({
    system: "upstream",
    kind: "paper",
    libraryID: normalizedLibraryID,
    paperItemID: normalizedPaperItemID,
    limit: normalizedLimit,
    includeEmpty: true,
  });
  return summaries.map((summary) => {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const sessionVersion = Number(summary.sessionVersion || 0);
    const paperItemID = Number(summary.paperItemID || 0);
    const isDraft = isDraftSummary(summary);
    return {
      mode: "paper" as const,
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      title: normalizeTitle(summary.title, isDraft),
      createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : 0,
      lastActivityAt: Number.isFinite(lastActivityAt)
        ? Math.floor(lastActivityAt)
        : 0,
      userTurnCount: Number.isFinite(userTurnCount)
        ? Math.max(0, Math.floor(userTurnCount))
        : 0,
      isDraft,
      sessionVersion:
        Number.isFinite(sessionVersion) && sessionVersion > 0
          ? Math.floor(sessionVersion)
          : undefined,
      paperItemID:
        Number.isFinite(paperItemID) && paperItemID > 0
          ? Math.floor(paperItemID)
          : undefined,
    };
  });
}

/**
 * Load all conversations (both paper and global) for a library,
 * sorted by lastActivityAt descending. Used by standalone search.
 */
export async function loadAllConversationHistory(params: {
  libraryID: number;
  limit?: number | null;
}): Promise<ConversationHistoryScopeEntry[]> {
  const normalizedLibraryID =
    Number.isFinite(params.libraryID) && params.libraryID > 0
      ? Math.floor(params.libraryID)
      : 0;
  if (normalizedLibraryID <= 0) return [];

  const limit = params.limit === null ? null : (params.limit ?? 100);

  const summaries = await conversationRepository.listAllCatalogEntries({
    system: "upstream",
    libraryID: normalizedLibraryID,
    limit,
  });

  const entries: ConversationHistoryScopeEntry[] = [];

  for (const summary of summaries.filter((entry) => entry.kind === "paper")) {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const sessionVersion = Number(summary.sessionVersion || 0);
    const paperItemID = Number(summary.paperItemID || 0);
    const isDraft = isDraftSummary(summary);
    entries.push({
      mode: "paper",
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      title: normalizeTitle(summary.title, isDraft),
      createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : 0,
      lastActivityAt: Number.isFinite(lastActivityAt)
        ? Math.floor(lastActivityAt)
        : 0,
      userTurnCount: Number.isFinite(userTurnCount)
        ? Math.max(0, Math.floor(userTurnCount))
        : 0,
      isDraft,
      sessionVersion:
        Number.isFinite(sessionVersion) && sessionVersion > 0
          ? Math.floor(sessionVersion)
          : undefined,
      paperItemID:
        Number.isFinite(paperItemID) && paperItemID > 0
          ? Math.floor(paperItemID)
          : undefined,
    });
  }

  for (const summary of summaries.filter((entry) => entry.kind === "global")) {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const isDraft = isDraftSummary(summary);
    entries.push({
      mode: "open",
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      title: normalizeTitle(summary.title, isDraft),
      createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : 0,
      lastActivityAt: Number.isFinite(lastActivityAt)
        ? Math.floor(lastActivityAt)
        : 0,
      userTurnCount: Number.isFinite(userTurnCount)
        ? Math.max(0, Math.floor(userTurnCount))
        : 0,
      isDraft,
    });
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return entries;
}
