import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../core/conversations/repository";

export type CodexConversationHistoryEntry = {
  conversationID: string;
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

function normalizeTitle(summary: ConversationCatalogEntry): string {
  const title = (summary.title || "").trim();
  if (title) return title;
  return summary.kind === "paper" ? "New Codex paper chat" : "New Codex chat";
}

function isDraftSummary(summary: ConversationCatalogEntry): boolean {
  const userTurnCount = Number(summary.userTurnCount || 0);
  return (
    userTurnCount <= 0 &&
    !summary.title?.trim() &&
    !summary.providerSessionId?.trim() &&
    !summary.scopedConversationKey?.trim()
  );
}

/** One catalog row as this runtime's history row (title and draft rules). */
export function toCodexConversationHistoryEntry(
  summary: ConversationCatalogEntry,
): CodexConversationHistoryEntry {
  const isDraft = isDraftSummary(summary);
  return {
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    kind: summary.kind,
    title: normalizeTitle(summary),
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    userTurnCount: summary.userTurnCount,
    isDraft,
    paperItemID: summary.paperItemID,
    providerSessionId: summary.providerSessionId,
    scopedConversationKey: summary.scopedConversationKey,
  };
}

export async function loadAllCodexConversationHistory(params: {
  libraryID: number;
  limit?: number | null;
}): Promise<CodexConversationHistoryEntry[]> {
  const normalizedLimit =
    params.limit === null
      ? null
      : Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit as number))
        : 100;
  return (
    await conversationRepository.listAllCatalogEntries({
      system: "codex",
      libraryID: params.libraryID,
      limit: normalizedLimit,
    })
  ).map(toCodexConversationHistoryEntry);
}
