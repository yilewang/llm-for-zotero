import {
  conversationRepository,
  type ConversationCatalogEntry,
  type ConversationCatalogKind,
} from "../../core/conversations/repository";
import type { ConversationSystem } from "../../shared/types";
import { isReusableConversationDraft } from "./standaloneConversationResolution";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import { getConversationKeyLedgerEntry } from "../../shared/conversationKeyLedger";

declare const ztoolkit: any;

export type FreshConversationDraftResult = {
  conversationKey: number;
  sessionVersion?: number;
  reused: boolean;
  source: "current" | "listed" | "created" | "none";
};

export type FreshConversationDraftRepository = Pick<
  typeof conversationRepository,
  "getCatalogEntry" | "listCatalogEntries" | "createCatalogEntry"
> &
  Partial<Pick<typeof conversationRepository, "loadMessages">>;

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function emptyResult(): FreshConversationDraftResult {
  return {
    conversationKey: 0,
    reused: false,
    source: "none",
  };
}

function logFreshDraftError(message: string, err: unknown): void {
  try {
    ztoolkit?.log?.(message, err);
  } catch (_error) {
    void _error;
  }
}

async function hasStoredMessages(
  repository: FreshConversationDraftRepository,
  system: ConversationSystem,
  conversationKey: number,
): Promise<boolean> {
  if (!repository.loadMessages || conversationKey <= 0) return false;
  try {
    const messages = await repository.loadMessages({
      system,
      conversationKey,
      limit: 1,
    });
    return messages.length > 0;
  } catch (err) {
    logFreshDraftError("LLM: Failed to inspect draft transcript messages", err);
    return false;
  }
}

export async function resolveFreshConversationDraft(params: {
  repository?: FreshConversationDraftRepository;
  system: ConversationSystem;
  kind: ConversationCatalogKind;
  libraryID: number;
  paperItemID?: number | null;
  currentConversationKey?: number | null;
  excludeConversationKey?: number | null;
  limit?: number;
}): Promise<FreshConversationDraftResult> {
  const repository = params.repository || conversationRepository;
  const libraryID = normalizePositiveInt(params.libraryID);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  const currentConversationKey = normalizePositiveInt(
    params.currentConversationKey,
  );
  const excludeConversationKey = normalizePositiveInt(
    params.excludeConversationKey,
  );
  const limit = normalizePositiveInt(params.limit) || 50;
  if (!libraryID) return emptyResult();
  if (params.kind === "paper" && !paperItemID) return emptyResult();

  if (
    currentConversationKey > 0 &&
    currentConversationKey !== excludeConversationKey &&
    // Same rule as the listed-candidates branch below: a chat queued for
    // deletion must never be handed back as the user's "new" chat, or it is
    // destroyed under them ~6s later.
    !pendingDeletionStore.isConversationPendingDeletion(currentConversationKey)
  ) {
    try {
      const currentSummary = await repository.getCatalogEntry({
        system: params.system,
        kind: params.kind,
        conversationKey: currentConversationKey,
      });
      if (
        isReusableConversationDraft({
          summary: currentSummary,
          kind: params.kind,
          libraryID,
          paperItemID,
        }) &&
        !(await getConversationKeyLedgerEntry(currentConversationKey))
          ?.retiredAt &&
        !(await hasStoredMessages(
          repository,
          params.system,
          currentConversationKey,
        ))
      ) {
        return {
          conversationKey: currentConversationKey,
          sessionVersion: currentSummary?.sessionVersion,
          reused: true,
          source: "current",
        };
      }
    } catch (err) {
      logFreshDraftError(
        "LLM: Failed to inspect current draft conversation",
        err,
      );
    }
  }

  try {
    const summaries = await repository.listCatalogEntries({
      system: params.system,
      kind: params.kind,
      libraryID,
      paperItemID: params.kind === "paper" ? paperItemID : undefined,
      limit,
      includeEmpty: true,
    });
    const reusableCandidates: ConversationCatalogEntry[] = [];
    for (const summary of summaries) {
      const key = normalizePositiveInt(summary.conversationKey);
      if (!key || key === excludeConversationKey) continue;
      // Never hand back a chat the user just asked to delete. Besides being
      // the wrong chat to reuse, adopting it rewrites its catalog createdAt
      // (touchEmptyCatalogActivity), which is the identity witness the queued
      // deletion is verified against — the deletion would then be silently
      // abandoned as "stale".
      if (pendingDeletionStore.isConversationPendingDeletion(key)) continue;
      const ledger = await getConversationKeyLedgerEntry(key);
      if (ledger?.retiredAt) continue;
      if (
        !isReusableConversationDraft({
          summary,
          kind: params.kind,
          libraryID,
          paperItemID,
        })
      )
        continue;
      reusableCandidates.push(summary);
    }
    for (const summary of reusableCandidates) {
      const key = normalizePositiveInt(summary.conversationKey);
      if (
        key > 0 &&
        !(await hasStoredMessages(repository, params.system, key))
      ) {
        const reusable = summary as ConversationCatalogEntry;
        return {
          conversationKey: key,
          sessionVersion: reusable.sessionVersion,
          reused: true,
          source: "listed",
        };
      }
    }
  } catch (err) {
    logFreshDraftError("LLM: Failed to list reusable draft conversations", err);
  }

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = await repository.createCatalogEntry({
        system: params.system,
        kind: params.kind,
        libraryID,
        paperItemID: params.kind === "paper" ? paperItemID : undefined,
      });
      const createdKey = normalizePositiveInt(created?.conversationKey);
      if (createdKey <= 0 || createdKey === excludeConversationKey) continue;
      if (await hasStoredMessages(repository, params.system, createdKey)) {
        continue;
      }
      return {
        conversationKey: createdKey,
        sessionVersion: created?.sessionVersion,
        reused: false,
        source: "created",
      };
    }
  } catch (err) {
    logFreshDraftError("LLM: Failed to create fresh draft conversation", err);
  }

  return emptyResult();
}
