import type { ClaudeConversationSummary } from "../shared/types";
import { listClaudeConversationsForScope } from "./runtime";
import {
  listAllClaudePaperConversationsByLibrary,
  listClaudeGlobalConversations,
} from "./store";

export type ClaudeConversationHistoryEntry = {
  conversationKey: number;
  kind: "global" | "paper";
  title: string;
  createdAt: number;
  lastActivityAt: number;
  userTurnCount: number;
  isDraft: boolean;
  paperItemID?: number;
  providerSessionId?: string;
  scopedConversationKey?: string;
};

function normalizeTitle(summary: ClaudeConversationSummary): string {
  const title = (summary.title || "").trim();
  if (title) return title;
  return summary.kind === "paper" ? "New Claude paper chat" : "New Claude chat";
}

function toEntry(summary: ClaudeConversationSummary): ClaudeConversationHistoryEntry {
  const isDraft = (summary.userTurnCount || 0) <= 0;
  return {
    conversationKey: summary.conversationKey,
    kind: summary.kind,
    title: normalizeTitle(summary),
    createdAt: summary.createdAt,
    lastActivityAt: summary.updatedAt,
    userTurnCount: summary.userTurnCount,
    isDraft,
    paperItemID: summary.paperItemID,
    providerSessionId: summary.providerSessionId,
    scopedConversationKey: summary.scopedConversationKey,
  };
}

export async function loadClaudeConversationHistoryScope(params: {
  libraryID: number;
  kind: "global" | "paper";
  paperItemID?: number;
  limit?: number;
}): Promise<ClaudeConversationHistoryEntry[]> {
  const summaries = await listClaudeConversationsForScope({
    libraryID: params.libraryID,
    kind: params.kind,
    paperItemID: params.paperItemID,
    limit: params.limit,
  });
  return summaries.map(toEntry);
}

export async function loadAllClaudeConversationHistory(params: {
  libraryID: number;
  limit?: number;
}): Promise<ClaudeConversationHistoryEntry[]> {
  const normalizedLimit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit as number))
    : 100;
  const [paperSummaries, globalSummaries] = await Promise.all([
    listAllClaudePaperConversationsByLibrary(params.libraryID, normalizedLimit),
    listClaudeGlobalConversations(params.libraryID, normalizedLimit),
  ]);
  return [...paperSummaries, ...globalSummaries]
    .map(toEntry)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
