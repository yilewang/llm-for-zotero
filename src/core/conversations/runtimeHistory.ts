/**
 * History rows of the runtime conversation systems (Claude Code, Codex,
 * Antigravity), read from the conversation catalog. The three share one
 * shape and one set of title and draft rules; only the system and the name
 * in a default title differ.
 */
import {
  RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS,
  type RuntimeConversationSystem,
} from "./conversationSystems";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "./repository";

export type RuntimeConversationHistoryEntry = {
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

function normalizeTitle(
  system: RuntimeConversationSystem,
  summary: ConversationCatalogEntry,
): string {
  const title = (summary.title || "").trim();
  if (title) return title;
  const name = RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].shortLabel;
  return summary.kind === "paper"
    ? `New ${name} paper chat`
    : `New ${name} chat`;
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

/** One catalog row as its runtime's history row (title and draft rules). */
export function toRuntimeConversationHistoryEntry(
  system: RuntimeConversationSystem,
  summary: ConversationCatalogEntry,
): RuntimeConversationHistoryEntry {
  const isDraft = isDraftSummary(summary);
  return {
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    kind: summary.kind,
    title: normalizeTitle(system, summary),
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    userTurnCount: summary.userTurnCount,
    isDraft,
    paperItemID: summary.paperItemID,
    providerSessionId: summary.providerSessionId,
    scopedConversationKey: summary.scopedConversationKey,
  };
}

/**
 * The conversations of one runtime in a library, in the order the catalog
 * lists them. `limit` defaults to 100; null means no limit.
 */
export async function loadAllRuntimeConversationHistory(
  system: RuntimeConversationSystem,
  params: { libraryID: number; limit?: number | null },
): Promise<RuntimeConversationHistoryEntry[]> {
  const normalizedLimit =
    params.limit === null
      ? null
      : Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit as number))
        : 100;
  return (
    await conversationRepository.listAllCatalogEntries({
      system,
      libraryID: params.libraryID,
      limit: normalizedLimit,
    })
  ).map((summary) => toRuntimeConversationHistoryEntry(system, summary));
}
