import type { CodexConversationSummary } from "../shared/types";
import {
  listAllCodexPaperConversationsByLibrary,
  listCodexGlobalConversations,
  listCodexPaperConversations,
} from "./store";

export type CodexConversationHistoryEntry = {
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

function normalizeTitle(summary: CodexConversationSummary): string {
  const title = (summary.title || "").trim();
  if (title) return title;
  return summary.kind === "paper" ? "New Codex paper chat" : "New Codex chat";
}

function toEntry(summary: CodexConversationSummary): CodexConversationHistoryEntry {
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

export async function loadCodexConversationHistoryScope(params: {
  libraryID: number;
  kind: "global" | "paper";
  paperItemID?: number;
  limit?: number;
}): Promise<CodexConversationHistoryEntry[]> {
  const summaries = params.kind === "paper"
    ? await listCodexPaperConversations(
        params.libraryID,
        params.paperItemID || 0,
        params.limit,
      )
    : await listCodexGlobalConversations(params.libraryID, params.limit);
  return summaries.map(toEntry);
}

export async function loadAllCodexConversationHistory(params: {
  libraryID: number;
  limit?: number;
}): Promise<CodexConversationHistoryEntry[]> {
  const normalizedLimit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit as number))
    : 100;
  const [paperSummaries, globalSummaries] = await Promise.all([
    listAllCodexPaperConversationsByLibrary(params.libraryID, normalizedLimit),
    listCodexGlobalConversations(params.libraryID, normalizedLimit),
  ]);
  return [...paperSummaries, ...globalSummaries]
    .map(toEntry)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
