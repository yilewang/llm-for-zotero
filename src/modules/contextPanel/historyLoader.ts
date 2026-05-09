import {
  ensurePaperV1Conversation,
  listGlobalConversations,
  listPaperConversations,
  listAllPaperConversationsByLibrary,
} from "../../utils/chatStore";
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
    const summaries = await listGlobalConversations(
      normalizedLibraryID,
      normalizedLimit,
      true,
    );
    return summaries.map((summary) => {
      const lastActivityAt = Number(
        summary.lastActivityAt || summary.createdAt || 0,
      );
      const createdAt = Number(summary.createdAt || lastActivityAt || 0);
      const userTurnCount = Number(summary.userTurnCount || 0);
      const isDraft = userTurnCount <= 0;
      return {
        mode: "open" as const,
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

  await ensurePaperV1Conversation(normalizedLibraryID, normalizedPaperItemID);
  const summaries = await listPaperConversations(
    normalizedLibraryID,
    normalizedPaperItemID,
    normalizedLimit,
    true,
  );
  return summaries.map((summary) => {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const isDraft = userTurnCount <= 0;
    return {
      mode: "paper" as const,
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
        Number.isFinite(summary.sessionVersion) && summary.sessionVersion > 0
          ? Math.floor(summary.sessionVersion)
          : undefined,
      paperItemID:
        Number.isFinite(summary.paperItemID) && summary.paperItemID > 0
          ? Math.floor(summary.paperItemID)
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
  limit?: number;
}): Promise<ConversationHistoryScopeEntry[]> {
  const normalizedLibraryID =
    Number.isFinite(params.libraryID) && params.libraryID > 0
      ? Math.floor(params.libraryID)
      : 0;
  if (normalizedLibraryID <= 0) return [];

  const limit = params.limit ?? 100;

  const [paperSummaries, globalSummaries] = await Promise.all([
    listAllPaperConversationsByLibrary(normalizedLibraryID, limit),
    listGlobalConversations(normalizedLibraryID, limit, false),
  ]);

  const entries: ConversationHistoryScopeEntry[] = [];

  for (const summary of paperSummaries) {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const isDraft = userTurnCount <= 0;
    entries.push({
      mode: "paper",
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
        Number.isFinite(summary.sessionVersion) && summary.sessionVersion > 0
          ? Math.floor(summary.sessionVersion)
          : undefined,
      paperItemID:
        Number.isFinite(summary.paperItemID) && summary.paperItemID > 0
          ? Math.floor(summary.paperItemID)
          : undefined,
    });
  }

  for (const summary of globalSummaries) {
    const lastActivityAt = Number(
      summary.lastActivityAt || summary.createdAt || 0,
    );
    const createdAt = Number(summary.createdAt || lastActivityAt || 0);
    const userTurnCount = Number(summary.userTurnCount || 0);
    const isDraft = userTurnCount <= 0;
    entries.push({
      mode: "open",
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
