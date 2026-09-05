import { pendingDeletionStore } from "./pendingDeletionStore";
import {
  createClaudeGlobalConversation,
  createClaudePaperConversation,
  deleteClaudeConversationLocalRows,
  deleteClaudeConversation,
  deleteClaudeTurnMessages,
  ensureClaudeGlobalConversation,
  ensureClaudePaperConversation,
  getClaudeConversationSummary,
  loadClaudeConversation,
  listAllClaudePaperConversationsByLibrary,
  listClaudeGlobalConversations,
  listClaudePaperConversations,
  preflightDeleteClaudeConversationLocalRows,
  setClaudeConversationTitle,
  touchClaudeConversationTitle,
  upsertClaudeConversationSummary,
} from "../../claudeCode/store";
import {
  createCodexGlobalConversation,
  createCodexPaperConversation,
  deleteCodexConversationLocalRows,
  deleteCodexConversation,
  deleteCodexTurnMessages,
  ensureCodexGlobalConversation,
  ensureCodexPaperConversation,
  forkCodexConversationMessages,
  getLatestCodexForkableAssistantTimestamp,
  getCodexConversationSummary,
  loadCodexConversation,
  listAllCodexPaperConversationsByLibrary,
  listCodexGlobalConversations,
  listCodexPaperConversations,
  preflightDeleteCodexConversationLocalRows,
  setCodexConversationTitle,
  touchCodexConversationTitle,
  upsertCodexConversationSummary,
} from "../../codexAppServer/store";
import { isConversationKeyForKind } from "../../shared/conversationKeySpace";
import {
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getRegisteredConversationScope,
  getCatalogInstanceIDForScope,
  repairRegisteredConversationScope,
  syncCatalogInstanceID,
} from "../../shared/conversationRegistry";
import type {
  ClaudeConversationSummary,
  CodexConversationSummary,
  ConversationSystem,
  GlobalConversationSummary,
  PaperConversationSummary,
} from "../../shared/types";
import {
  clearConversationTitle,
  createGlobalConversation,
  createPaperConversation,
  deleteUpstreamConversationLocalRows,
  deleteGlobalConversation,
  deletePaperConversation,
  deleteTurnMessages as deleteUpstreamTurnMessages,
  ensureGlobalConversationExists,
  ensurePaperV1Conversation,
  forkUpstreamConversationMessages,
  getGlobalConversation,
  getPaperConversation,
  loadConversation as loadUpstreamConversation,
  listAllPaperConversationsByLibrary,
  listGlobalConversations,
  listPaperConversations,
  preflightDeleteUpstreamConversationLocalRows,
  setGlobalConversationTitle,
  setPaperConversationTitle,
  touchEmptyGlobalConversation,
  touchEmptyPaperConversation,
  touchGlobalConversationTitle,
  touchPaperConversationTitle,
  type StoredChatMessage,
} from "../../utils/chatStore";
import { codexAppServerForkService } from "../../codexAppServer/forkService";
import { getCodexProfileSignature } from "../../codexAppServer/constants";
import { getConversationKeyLedgerEntry } from "../../shared/conversationKeyLedger";
import { releaseConversationScopeToken } from "../../agent/mcp/server";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import {
  deleteConversationForkLink,
  recordConversationForkLink,
  type ConversationForkLink,
} from "../../shared/conversationForkLinks";
import {
  enqueueConversationCleanupJobInTransaction,
  initConversationCleanupJobs,
  type ConversationCleanupProviderScope,
} from "./conversationCleanupJobs";

export type ConversationCatalogKind = "global" | "paper";

export type ConversationCatalogEntry = {
  /** Cryptographically random immutable identity for this catalog instance. */
  instanceID?: string;
  conversationID: string;
  conversationKey: number;
  system: ConversationSystem;
  kind: ConversationCatalogKind;
  libraryID: number;
  createdAt: number;
  lastActivityAt: number;
  title?: string;
  userTurnCount: number;
  paperItemID?: number;
  sessionVersion?: number;
  providerSessionId?: string;
  scopedConversationKey?: string;
  scopeType?: string;
  scopeId?: string;
  scopeLabel?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Ephemeral webchat session row: hidden from history, swept at startup. */
  webchatSession?: boolean;
};

export type ConversationCatalogIdentityWitness = {
  instanceID: string;
  catalogCreatedAt: number;
  conversationID: string;
};

/** Immutable, scope-bound identity used by destructive conversation flows. */
export type ConversationInstanceRef = {
  instanceId: string;
  conversationID: string;
  conversationKey: number;
  catalogCreatedAt: number;
  system: ConversationSystem;
  kind: ConversationCatalogKind;
  profileSignature: string;
  libraryID: number;
  paperItemID?: number;
};

export type ConversationCatalogScope = {
  system: ConversationSystem;
  kind: ConversationCatalogKind;
  libraryID: number;
  paperItemID?: number;
};

type ConversationCatalogListParams = ConversationCatalogScope & {
  limit?: number;
  includeEmpty?: boolean;
};

type ConversationCatalogMutationTarget = {
  instanceID?: string;
  conversationID?: string;
  system: ConversationSystem;
  conversationKey: number;
  kind?: ConversationCatalogKind;
  providerSessionId?: string | null;
  libraryID?: number;
  paperItemID?: number;
  providerScope?: ConversationCleanupProviderScope;
  /**
   * Provider sessions captured by pending turn intents that are being folded
   * into this whole-conversation deletion.  They are inserted into the
   * cleanup queue in the same transaction as the local delete, so purging the
   * turn intents can never discard the last exact provider witness.
   */
  additionalProviderCleanup?: Array<{
    operation: "codex_archive" | "claude_invalidate";
    system: "codex" | "claude_code";
    providerSessionId: string;
    providerScope?: ConversationCleanupProviderScope;
  }>;
  onBeforeCommit?: () => Promise<void>;
  expectedGeneration?: number;
  /** DML is already enclosed by the caller's owning transaction. */
  inTransaction?: boolean;
};

type ConversationMessageTarget = {
  system: ConversationSystem;
  conversationKey: number;
};

type DeleteTurnMessagesParams = ConversationMessageTarget & {
  userTimestamp: number;
  assistantTimestamp: number;
  /** Immutable row IDs captured when the turn was selected. */
  userMessageID?: number;
  assistantMessageID?: number;
  /** Runs inside the provider's message-delete transaction before commit. */
  onBeforeCommit?: () => Promise<void>;
};

type EnsureCatalogEntryParams = ConversationCatalogScope & {
  conversationKey?: number;
  title?: string;
};

type CreateCatalogEntryParams = ConversationCatalogScope & {
  /**
   * Upstream only: create the row as an ephemeral webchat session. Flagged
   * rows are hidden from catalog listings and swept at startup unless a
   * persisted message adopts them into a normal conversation.
   */
  webchatSession?: boolean;
  /**
   * Provisioning-only witness for preserving an existing canonical default
   * key on its first issuance. Ordinary creation must leave this unset so
   * the permanent allocator issues a fresh key.
   */
  preferredConversationKey?: number;
};

type ForkConversationParams = ConversationCatalogScope & {
  sourceConversationKey: number;
  throughAssistantTimestamp: number;
  title?: string;
};

export type ForkConversationResult = {
  entry: ConversationCatalogEntry;
  copiedMessageCount: number;
  targetAnchorAssistantTimestamp: number;
  forkLink: ConversationForkLink;
};

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function normalizeTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeUserTurnCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

async function hydrateCatalogEntryInstanceID(
  entry: ConversationCatalogEntry | null,
): Promise<ConversationCatalogEntry | null> {
  if (!entry || entry.instanceID) return entry;
  const ledger = await getConversationKeyLedgerEntry(entry.conversationKey);
  if (ledger?.instanceID) return { ...entry, instanceID: ledger.instanceID };
  const scope = await getRegisteredConversationScope(entry.conversationKey);
  if (scope?.instanceID) return { ...entry, instanceID: scope.instanceID };
  return entry;
}

function isUpstreamGlobalConversationKey(conversationKey: number): boolean {
  return isConversationKeyForKind("upstream", "global", conversationKey);
}

function isUpstreamPaperConversationKey(conversationKey: number): boolean {
  return isConversationKeyForKind("upstream", "paper", conversationKey);
}

function fromUpstreamGlobalSummary(
  summary: GlobalConversationSummary | null | undefined,
): ConversationCatalogEntry | null {
  if (!summary) return null;
  const conversationKey = normalizePositiveInt(summary.conversationKey);
  const libraryID = normalizePositiveInt(summary.libraryID);
  const createdAt = normalizeTimestamp(summary.createdAt);
  if (
    !conversationKey ||
    !isUpstreamGlobalConversationKey(conversationKey) ||
    !libraryID ||
    !createdAt
  ) {
    return null;
  }
  const lastActivityAt = normalizeTimestamp(summary.lastActivityAt, createdAt);
  return {
    conversationID: summary.conversationID,
    conversationKey,
    system: "upstream",
    kind: "global",
    libraryID,
    createdAt,
    lastActivityAt,
    title: normalizeTitle(summary.title),
    userTurnCount: normalizeUserTurnCount(summary.userTurnCount),
    ...(summary.webchatSession === true ? { webchatSession: true } : {}),
  };
}

function fromUpstreamPaperSummary(
  summary: PaperConversationSummary | null | undefined,
): ConversationCatalogEntry | null {
  if (!summary) return null;
  const conversationKey = normalizePositiveInt(summary.conversationKey);
  const libraryID = normalizePositiveInt(summary.libraryID);
  const paperItemID = normalizePositiveInt(summary.paperItemID);
  const sessionVersion = normalizePositiveInt(summary.sessionVersion);
  const createdAt = normalizeTimestamp(summary.createdAt);
  if (
    !conversationKey ||
    !isUpstreamPaperConversationKey(conversationKey) ||
    !libraryID ||
    !paperItemID ||
    !sessionVersion ||
    !createdAt
  ) {
    return null;
  }
  const lastActivityAt = normalizeTimestamp(summary.lastActivityAt, createdAt);
  return {
    conversationID: summary.conversationID,
    conversationKey,
    system: "upstream",
    kind: "paper",
    libraryID,
    paperItemID,
    sessionVersion,
    createdAt,
    lastActivityAt,
    title: normalizeTitle(summary.title),
    userTurnCount: normalizeUserTurnCount(summary.userTurnCount),
    ...(summary.webchatSession === true ? { webchatSession: true } : {}),
  };
}

function fromClaudeSummary(
  summary: ClaudeConversationSummary | null | undefined,
): ConversationCatalogEntry | null {
  if (!summary) return null;
  const conversationKey = normalizePositiveInt(summary.conversationKey);
  const libraryID = normalizePositiveInt(summary.libraryID);
  const createdAt = normalizeTimestamp(summary.createdAt);
  const paperItemID = normalizePositiveInt(summary.paperItemID);
  if (!conversationKey || !libraryID || !createdAt) return null;
  if (summary.kind === "paper" && !paperItemID) return null;
  return {
    instanceID: summary.instanceID,
    conversationID: summary.conversationID,
    conversationKey,
    system: "claude_code",
    kind: summary.kind,
    libraryID,
    paperItemID: summary.kind === "paper" ? paperItemID : undefined,
    createdAt,
    lastActivityAt: normalizeTimestamp(summary.updatedAt, createdAt),
    title: normalizeTitle(summary.title),
    userTurnCount: normalizeUserTurnCount(summary.userTurnCount),
    providerSessionId: normalizeTitle(summary.providerSessionId),
    scopedConversationKey: normalizeTitle(summary.scopedConversationKey),
    scopeType: normalizeTitle(summary.scopeType),
    scopeId: normalizeTitle(summary.scopeId),
    scopeLabel: normalizeTitle(summary.scopeLabel),
    cwd: normalizeTitle(summary.cwd),
    model: normalizeTitle(summary.model),
    effort: normalizeTitle(summary.effort),
  };
}

function fromCodexSummary(
  summary: CodexConversationSummary | null | undefined,
): ConversationCatalogEntry | null {
  if (!summary) return null;
  const conversationKey = normalizePositiveInt(summary.conversationKey);
  const libraryID = normalizePositiveInt(summary.libraryID);
  const createdAt = normalizeTimestamp(summary.createdAt);
  const paperItemID = normalizePositiveInt(summary.paperItemID);
  if (!conversationKey || !libraryID || !createdAt) return null;
  if (summary.kind === "paper" && !paperItemID) return null;
  return {
    instanceID: summary.instanceID,
    conversationID: summary.conversationID,
    conversationKey,
    system: "codex",
    kind: summary.kind,
    libraryID,
    paperItemID: summary.kind === "paper" ? paperItemID : undefined,
    createdAt,
    lastActivityAt: normalizeTimestamp(summary.updatedAt, createdAt),
    title: normalizeTitle(summary.title),
    userTurnCount: normalizeUserTurnCount(summary.userTurnCount),
    providerSessionId: normalizeTitle(summary.providerSessionId),
    scopedConversationKey: normalizeTitle(summary.scopedConversationKey),
    scopeType: normalizeTitle(summary.scopeType),
    scopeId: normalizeTitle(summary.scopeId),
    scopeLabel: normalizeTitle(summary.scopeLabel),
    cwd: normalizeTitle(summary.cwd),
    model: normalizeTitle(summary.model),
    effort: normalizeTitle(summary.effort),
  };
}

async function repairRuntimeRegistryFromSummary(
  system: "claude_code" | "codex",
  summary: ClaudeConversationSummary | CodexConversationSummary,
): Promise<void> {
  const existing = await getRegisteredConversationScope(
    summary.conversationKey,
  );
  if (
    existing &&
    !existing.valid &&
    !canMigrateLegacyAmbiguousPaperRegistryScope(existing, {
      system,
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
    })
  ) {
    return;
  }
  await repairRegisteredConversationScope({
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    system,
    kind: summary.kind,
    libraryID: summary.libraryID,
    paperItemID: summary.paperItemID,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    title: summary.title,
  });
}

async function repairUpstreamRuntimeRegistryFromEntry(
  entry: ConversationCatalogEntry,
): Promise<boolean> {
  if (entry.system !== "upstream") return true;
  if (
    !isConversationKeyForKind("upstream", entry.kind, entry.conversationKey)
  ) {
    return false;
  }
  return await repairRegisteredConversationScope({
    conversationID: entry.conversationID,
    conversationKey: entry.conversationKey,
    system: "upstream",
    kind: entry.kind,
    libraryID: entry.libraryID,
    paperItemID: entry.paperItemID,
    createdAt: entry.createdAt,
    updatedAt: entry.lastActivityAt,
    title: entry.title,
  });
}

function sortCatalogEntries(
  entries: ConversationCatalogEntry[],
): ConversationCatalogEntry[] {
  return entries.sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return b.conversationKey - a.conversationKey;
  });
}

function catalogEntryMatchesScope(
  entry: ConversationCatalogEntry | null,
  scope: ConversationCatalogScope,
): entry is ConversationCatalogEntry {
  if (!entry) return false;
  if (entry.system !== scope.system) return false;
  if (entry.kind !== scope.kind) return false;
  if (entry.libraryID !== normalizePositiveInt(scope.libraryID)) return false;
  if (scope.kind === "paper") {
    return (
      normalizePositiveInt(entry.paperItemID) ===
      normalizePositiveInt(scope.paperItemID)
    );
  }
  return true;
}

async function attachCatalogInstanceIdentity(
  entry: ConversationCatalogEntry | null,
): Promise<ConversationCatalogEntry | null> {
  if (!entry) return null;
  try {
    const registered = await getRegisteredConversationScope(
      entry.conversationKey,
    );
    if (
      registered?.valid &&
      registered.instanceID &&
      registered.system === entry.system &&
      registered.kind === entry.kind &&
      registered.libraryID === entry.libraryID &&
      (registered.paperItemID || null) === (entry.paperItemID || null)
    ) {
      return { ...entry, instanceID: registered.instanceID };
    }
  } catch {
    // Identity enrichment is best-effort for non-destructive catalog reads.
  }
  return entry;
}

async function touchRuntimeEmptyCatalogActivity(
  entry: ConversationCatalogEntry,
  timestamp: number,
): Promise<void> {
  if (entry.userTurnCount > 0) return;
  const updatedAt = normalizeTimestamp(timestamp, Date.now());
  if (entry.system === "claude_code") {
    await upsertClaudeConversationSummary({
      conversationKey: entry.conversationKey,
      libraryID: entry.libraryID,
      kind: entry.kind,
      paperItemID: entry.paperItemID,
      createdAt: entry.createdAt,
      updatedAt,
      title: entry.title,
      providerSessionId: entry.providerSessionId,
      scopedConversationKey: entry.scopedConversationKey,
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
      scopeLabel: entry.scopeLabel,
      cwd: entry.cwd,
      model: entry.model,
      effort: entry.effort,
    });
    return;
  }
  if (entry.system === "codex") {
    await upsertCodexConversationSummary({
      conversationKey: entry.conversationKey,
      libraryID: entry.libraryID,
      kind: entry.kind,
      paperItemID: entry.paperItemID,
      createdAt: entry.createdAt,
      updatedAt,
      title: entry.title,
      providerSessionId: entry.providerSessionId,
      scopedConversationKey: entry.scopedConversationKey,
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
      scopeLabel: entry.scopeLabel,
      cwd: entry.cwd,
      model: entry.model,
      effort: entry.effort,
    });
  }
}

export const conversationRepository = {
  async getCatalogEntry(
    target: ConversationCatalogMutationTarget,
  ): Promise<ConversationCatalogEntry | null> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return null;
    if (target.system === "claude_code") {
      return attachCatalogInstanceIdentity(
        fromClaudeSummary(await getClaudeConversationSummary(conversationKey)),
      );
    }
    if (target.system === "codex") {
      return attachCatalogInstanceIdentity(
        fromCodexSummary(await getCodexConversationSummary(conversationKey)),
      );
    }
    if (
      target.kind === "global" ||
      isUpstreamGlobalConversationKey(conversationKey)
    ) {
      return attachCatalogInstanceIdentity(
        fromUpstreamGlobalSummary(await getGlobalConversation(conversationKey)),
      );
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      return attachCatalogInstanceIdentity(
        fromUpstreamPaperSummary(await getPaperConversation(conversationKey)),
      );
    }
    return null;
  },

  // The permanent key ledger and immutable instance ID identify the row. The
  // catalog-created timestamp remains a migration witness for legacy pending
  // intents. Returns null when no witness can be read — callers must treat that
  // as "unverifiable", never as "proceed".
  async getCatalogIdentityWitness(
    target: ConversationCatalogMutationTarget,
  ): Promise<ConversationCatalogIdentityWitness | null> {
    try {
      const entry = await conversationRepository.getCatalogEntry(target);
      if (!entry) return null;
      const catalogCreatedAt = normalizeTimestamp(entry.createdAt);
      if (!catalogCreatedAt) return null;
      const registered = await getRegisteredConversationScope(
        entry.conversationKey,
      );
      if (
        !registered ||
        !registered.valid ||
        registered.system !== entry.system ||
        registered.kind !== entry.kind ||
        registered.libraryID !== entry.libraryID ||
        (registered.paperItemID || null) !== (entry.paperItemID || null) ||
        !registered.instanceID
      ) {
        return null;
      }
      let catalogInstanceID = await getCatalogInstanceIDForScope({
        conversationKey: entry.conversationKey,
        system: entry.system,
        kind: entry.kind,
      });
      if (!catalogInstanceID) {
        // Legacy rows may have the new column but no value yet.  The registry
        // witness is already scope-validated, so backfill this one row before
        // allowing a destructive intent to be persisted.  If the write cannot
        // be observed, fail closed and quarantine rather than falling back to
        // the numeric key or deterministic conversation ID.
        await syncCatalogInstanceID({
          instanceID: registered.instanceID,
          conversationKey: entry.conversationKey,
          system: entry.system,
          kind: entry.kind,
        });
        catalogInstanceID = await getCatalogInstanceIDForScope({
          conversationKey: entry.conversationKey,
          system: entry.system,
          kind: entry.kind,
        });
      }
      if (catalogInstanceID !== registered.instanceID) return null;
      return {
        instanceID: registered.instanceID,
        catalogCreatedAt,
        conversationID:
          typeof entry.conversationID === "string"
            ? entry.conversationID.trim()
            : "",
      };
    } catch {
      // A witness that cannot be read is not a witness.
      return null;
    }
  },

  async loadMessages(
    target: ConversationMessageTarget & { limit?: number },
  ): Promise<StoredChatMessage[]> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return [];
    const limit = normalizeLimit(target.limit, 200);
    if (target.system === "claude_code") {
      return loadClaudeConversation(conversationKey, limit);
    }
    if (target.system === "codex") {
      return loadCodexConversation(conversationKey, limit);
    }
    return loadUpstreamConversation(conversationKey, limit);
  },

  async deleteTurnMessages(target: DeleteTurnMessagesParams): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    const userTimestamp = normalizeTimestamp(target.userTimestamp);
    const assistantTimestamp = normalizeTimestamp(target.assistantTimestamp);
    if (target.system === "claude_code") {
      await deleteClaudeTurnMessages(
        conversationKey,
        userTimestamp,
        assistantTimestamp,
        target.userMessageID,
        target.assistantMessageID,
        target.onBeforeCommit,
      );
      return;
    }
    if (target.system === "codex") {
      await deleteCodexTurnMessages(
        conversationKey,
        userTimestamp,
        assistantTimestamp,
        target.userMessageID,
        target.assistantMessageID,
        target.onBeforeCommit,
      );
      return;
    }
    await deleteUpstreamTurnMessages(
      conversationKey,
      userTimestamp,
      assistantTimestamp,
      target.userMessageID,
      target.assistantMessageID,
      target.onBeforeCommit,
    );
  },

  async ensureCatalogEntry(
    params: EnsureCatalogEntryParams,
  ): Promise<ConversationCatalogEntry | null> {
    const libraryID = normalizePositiveInt(params.libraryID);
    const paperItemID = normalizePositiveInt(params.paperItemID);
    const conversationKey = normalizePositiveInt(params.conversationKey);
    if (!libraryID) return null;

    if (params.system === "claude_code") {
      if (conversationKey) {
        const existing = await getClaudeConversationSummary(conversationKey);
        if (existing) {
          const entry = fromClaudeSummary(existing);
          if (!catalogEntryMatchesScope(entry, params)) return null;
          await repairRuntimeRegistryFromSummary("claude_code", existing);
          return entry;
        }
        // An explicit key is a lookup witness, never an instruction to create
        // a row. Recreating a missing key here would allow a stale history
        // read to resurrect a retired conversation.
        return null;
      }
      return fromClaudeSummary(
        params.kind === "paper"
          ? await ensureClaudePaperConversation(libraryID, paperItemID)
          : await ensureClaudeGlobalConversation(libraryID),
      );
    }

    if (params.system === "codex") {
      if (conversationKey) {
        const existing = await getCodexConversationSummary(conversationKey);
        if (existing) {
          const entry = fromCodexSummary(existing);
          if (!catalogEntryMatchesScope(entry, params)) return null;
          await repairRuntimeRegistryFromSummary("codex", existing);
          return entry;
        }
        // An explicit key is a lookup witness, never an instruction to create
        // a row. New conversations must go through createCatalogEntry().
        return null;
      }
      return fromCodexSummary(
        params.kind === "paper"
          ? await ensureCodexPaperConversation(libraryID, paperItemID)
          : await ensureCodexGlobalConversation(libraryID),
      );
    }

    if (params.kind === "global") {
      if (!conversationKey) return null;
      const ensured = await ensureGlobalConversationExists(
        libraryID,
        conversationKey,
      );
      if (!ensured) return null;
      const entry = fromUpstreamGlobalSummary(
        await getGlobalConversation(conversationKey),
      );
      if (!catalogEntryMatchesScope(entry, params)) return null;
      return (await repairUpstreamRuntimeRegistryFromEntry(entry))
        ? entry
        : null;
    }
    if (!paperItemID) return null;
    const entry = fromUpstreamPaperSummary(
      conversationKey
        ? await getPaperConversation(conversationKey)
        : await ensurePaperV1Conversation(libraryID, paperItemID),
    );
    if (!catalogEntryMatchesScope(entry, params)) return null;
    return (await repairUpstreamRuntimeRegistryFromEntry(entry)) ? entry : null;
  },

  async createCatalogEntry(
    params: CreateCatalogEntryParams,
  ): Promise<ConversationCatalogEntry | null> {
    const libraryID = normalizePositiveInt(params.libraryID);
    const paperItemID = normalizePositiveInt(params.paperItemID);
    if (!libraryID) return null;
    if (params.system === "claude_code") {
      return hydrateCatalogEntryInstanceID(
        fromClaudeSummary(
          params.kind === "paper"
            ? await createClaudePaperConversation(libraryID, paperItemID, {
                conversationKey: params.preferredConversationKey,
              })
            : await createClaudeGlobalConversation(libraryID, {
                conversationKey: params.preferredConversationKey,
              }),
        ),
      );
    }
    if (params.system === "codex") {
      return hydrateCatalogEntryInstanceID(
        fromCodexSummary(
          params.kind === "paper"
            ? await createCodexPaperConversation(libraryID, paperItemID, {
                conversationKey: params.preferredConversationKey,
              })
            : await createCodexGlobalConversation(libraryID, {
                conversationKey: params.preferredConversationKey,
              }),
        ),
      );
    }
    if (params.kind === "paper") {
      return hydrateCatalogEntryInstanceID(
        fromUpstreamPaperSummary(
          paperItemID
            ? await createPaperConversation(libraryID, paperItemID, {
                webchatSession: params.webchatSession === true,
                conversationKey: params.preferredConversationKey,
              })
            : null,
        ),
      );
    }
    const conversationKey = await createGlobalConversation(libraryID, {
      webchatSession: params.webchatSession === true,
      conversationKey: params.preferredConversationKey,
    });
    return hydrateCatalogEntryInstanceID(
      conversationKey
        ? fromUpstreamGlobalSummary(
            await getGlobalConversation(conversationKey),
          )
        : null,
    );
  },

  async forkConversation(
    params: ForkConversationParams,
  ): Promise<ForkConversationResult | null> {
    if (params.system === "claude_code") return null;
    if (params.system !== "upstream" && params.system !== "codex") {
      return null;
    }
    const libraryID = normalizePositiveInt(params.libraryID);
    const paperItemID = normalizePositiveInt(params.paperItemID);
    const sourceConversationKey = normalizePositiveInt(
      params.sourceConversationKey,
    );
    const throughAssistantTimestamp = normalizeTimestamp(
      params.throughAssistantTimestamp,
    );
    if (!libraryID || !sourceConversationKey || !throughAssistantTimestamp) {
      return null;
    }
    if (params.kind === "paper" && !paperItemID) return null;

    // Forking reads a source snapshot and then performs several asynchronous
    // target/provider writes.  Serialize the whole lifecycle with Clear and
    // other conversation-owned writes; generation checks inside the copy
    // helper remain a defense-in-depth barrier for callers that bypass this
    // repository method.
    return withConversationWriteLock(sourceConversationKey, async () => {
      const sourceEntry = await conversationRepository.getCatalogEntry({
        system: params.system,
        kind: params.kind,
        conversationKey: sourceConversationKey,
      });
      if (!catalogEntryMatchesScope(sourceEntry, params)) return null;
      const sourceProviderSessionId =
        normalizeTitle(sourceEntry.providerSessionId) || "";

      if (params.system === "codex") {
        const latestCodexForkableAssistantTimestamp =
          await getLatestCodexForkableAssistantTimestamp(sourceConversationKey);
        if (
          latestCodexForkableAssistantTimestamp !== throughAssistantTimestamp
        ) {
          return null;
        }
      }

      const entry = await conversationRepository.createCatalogEntry({
        system: params.system,
        kind: params.kind,
        libraryID,
        paperItemID,
      });
      if (!entry) return null;

      // The catalog entry is created first so the fork can be told which
      // conversation it belongs to. Codex binds the Zotero scope header when it
      // creates the target conversation, and resume never rebinds it, so a fork
      // that inherits the source header would stay bound to the source scope.
      let forkedCodexThreadId: string | null = null;
      if (params.system === "codex" && sourceProviderSessionId) {
        const discardForkEntry = async () => {
          await conversationRepository
            .deleteCatalogEntry({
              system: "codex",
              kind: entry.kind,
              conversationKey: entry.conversationKey,
              instanceID: entry.instanceID,
              conversationID: entry.conversationID,
            })
            .catch(() => {});
        };
        try {
          forkedCodexThreadId = await codexAppServerForkService.forkThread({
            threadId: sourceProviderSessionId,
            targetConversationKey: entry.conversationKey,
            targetInstanceID: entry.instanceID,
          });
        } catch (err) {
          await discardForkEntry();
          throw err;
        }
        if (!forkedCodexThreadId) {
          await discardForkEntry();
          return null;
        }
      }
      if (params.system === "codex" && forkedCodexThreadId) {
        const persistedProviderSession = await upsertCodexConversationSummary({
          conversationKey: entry.conversationKey,
          libraryID,
          kind: entry.kind,
          paperItemID: entry.paperItemID,
          createdAt: entry.createdAt,
          updatedAt: Date.now(),
          title: entry.title,
          providerSessionId: forkedCodexThreadId,
          instanceID: entry.instanceID,
        });
        if (!persistedProviderSession) {
          await conversationRepository.deleteCatalogEntry({
            system: "codex",
            kind: entry.kind,
            conversationKey: entry.conversationKey,
            instanceID: entry.instanceID,
            conversationID: entry.conversationID,
            providerSessionId: forkedCodexThreadId,
          });
          await codexAppServerForkService
            .archiveThread({ threadId: forkedCodexThreadId })
            .catch(() => {});
          return null;
        }
      }

      const cleanupForkEntry = async () => {
        await conversationRepository.deleteCatalogEntry({
          system: params.system,
          kind: entry.kind,
          conversationKey: entry.conversationKey,
          instanceID: entry.instanceID,
          conversationID: entry.conversationID,
          providerSessionId: forkedCodexThreadId || undefined,
        });
        if (params.system === "codex" && forkedCodexThreadId) {
          await codexAppServerForkService
            .archiveThread({ threadId: forkedCodexThreadId })
            .catch(() => {});
        }
      };
      let copiedMessageCount = 0;
      let targetAnchorAssistantTimestamp = 0;
      try {
        const copyResult =
          params.system === "codex"
            ? await forkCodexConversationMessages({
                sourceConversationKey,
                sourceInstanceID: sourceEntry.instanceID,
                sourceConversationID: sourceEntry.conversationID,
                targetConversationKey: entry.conversationKey,
                throughAssistantTimestamp,
                timestampBase: Date.now(),
              })
            : await forkUpstreamConversationMessages({
                sourceConversationKey,
                sourceInstanceID: sourceEntry.instanceID,
                sourceConversationID: sourceEntry.conversationID,
                targetConversationKey: entry.conversationKey,
                throughAssistantTimestamp,
                timestampBase: Date.now(),
              });
        copiedMessageCount = copyResult.copiedMessageCount;
        targetAnchorAssistantTimestamp =
          copyResult.targetAnchorAssistantTimestamp;
      } catch (err) {
        await cleanupForkEntry();
        throw err;
      }
      if (copiedMessageCount <= 0 || targetAnchorAssistantTimestamp <= 0) {
        await cleanupForkEntry();
        return null;
      }

      const titleSeed =
        normalizeTitle(params.title) ||
        normalizeTitle(sourceEntry?.title) ||
        "Forked chat";
      await conversationRepository.setCatalogTitle({
        system: params.system,
        kind: entry.kind,
        conversationKey: entry.conversationKey,
        title: `Fork: ${titleSeed}`,
      });

      const refreshed = await conversationRepository.getCatalogEntry({
        system: params.system,
        kind: entry.kind,
        conversationKey: entry.conversationKey,
      });
      const resultEntry = refreshed || entry;
      const forkLink = await recordConversationForkLink({
        targetConversationKey: resultEntry.conversationKey,
        targetInstanceID: resultEntry.instanceID,
        targetConversationID: resultEntry.conversationID,
        targetSystem: params.system,
        targetKind: resultEntry.kind,
        sourceConversationKey,
        sourceInstanceID: sourceEntry.instanceID,
        sourceConversationID: sourceEntry.conversationID,
        sourceSystem: params.system,
        sourceKind: sourceEntry.kind,
        sourceLibraryID: sourceEntry.libraryID,
        sourcePaperItemID: sourceEntry.paperItemID,
        sourceAssistantTimestamp: throughAssistantTimestamp,
        targetAnchorAssistantTimestamp,
        createdAt: Date.now(),
      }).catch(async (err) => {
        await cleanupForkEntry();
        throw err;
      });
      return {
        entry: resultEntry,
        copiedMessageCount,
        targetAnchorAssistantTimestamp,
        forkLink,
      };
    });
  },

  async listCatalogEntries(
    params: ConversationCatalogListParams,
  ): Promise<ConversationCatalogEntry[]> {
    const libraryID = normalizePositiveInt(params.libraryID);
    const paperItemID = normalizePositiveInt(params.paperItemID);
    const limit = normalizeLimit(params.limit);
    if (!libraryID) return [];
    if (params.system === "claude_code") {
      const rows =
        params.kind === "paper"
          ? await listClaudePaperConversations(libraryID, paperItemID, limit)
          : await listClaudeGlobalConversations(libraryID, limit);
      return rows
        .map((row) => fromClaudeSummary(row))
        .filter((row): row is ConversationCatalogEntry => Boolean(row));
    }
    if (params.system === "codex") {
      const rows =
        params.kind === "paper"
          ? await listCodexPaperConversations(libraryID, paperItemID, limit)
          : await listCodexGlobalConversations(libraryID, limit);
      return rows
        .map((row) => fromCodexSummary(row))
        .filter((row): row is ConversationCatalogEntry => Boolean(row));
    }
    const rows =
      params.kind === "paper"
        ? await listPaperConversations(
            libraryID,
            paperItemID,
            limit,
            Boolean(params.includeEmpty),
          )
        : await listGlobalConversations(
            libraryID,
            limit,
            Boolean(params.includeEmpty),
          );
    return rows
      .map((row) =>
        params.kind === "paper"
          ? fromUpstreamPaperSummary(row as PaperConversationSummary)
          : fromUpstreamGlobalSummary(row as GlobalConversationSummary),
      )
      .filter((row): row is ConversationCatalogEntry => Boolean(row));
  },

  async listAllCatalogEntries(params: {
    system: ConversationSystem;
    libraryID: number;
    limit?: number | null;
  }): Promise<ConversationCatalogEntry[]> {
    const libraryID = normalizePositiveInt(params.libraryID);
    const limit =
      params.limit === null ? null : normalizeLimit(params.limit, 100);
    if (!libraryID) return [];
    if (params.system === "claude_code") {
      const [paperRows, globalRows] = await Promise.all([
        listAllClaudePaperConversationsByLibrary(libraryID, limit),
        listClaudeGlobalConversations(libraryID, limit),
      ]);
      return sortCatalogEntries(
        [...paperRows, ...globalRows]
          .map((row) => fromClaudeSummary(row))
          .filter((row): row is ConversationCatalogEntry => Boolean(row)),
      );
    }
    if (params.system === "codex") {
      const [paperRows, globalRows] = await Promise.all([
        listAllCodexPaperConversationsByLibrary(libraryID, limit),
        listCodexGlobalConversations(libraryID, limit),
      ]);
      return sortCatalogEntries(
        [...paperRows, ...globalRows]
          .map((row) => fromCodexSummary(row))
          .filter((row): row is ConversationCatalogEntry => Boolean(row)),
      );
    }
    const [paperRows, globalRows] = await Promise.all([
      listAllPaperConversationsByLibrary(libraryID, limit),
      listGlobalConversations(libraryID, limit, false),
    ]);
    return sortCatalogEntries([
      ...paperRows
        .map((row) => fromUpstreamPaperSummary(row))
        .filter((row): row is ConversationCatalogEntry => Boolean(row)),
      ...globalRows
        .map((row) => fromUpstreamGlobalSummary(row))
        .filter((row): row is ConversationCatalogEntry => Boolean(row)),
    ]);
  },

  async setCatalogTitle(
    target: ConversationCatalogMutationTarget & { title: string },
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    await withConversationWriteLock(conversationKey, async () => {
      if (areConversationWritesFrozen(conversationKey)) return;
      if (
        target.expectedGeneration !== undefined &&
        !isConversationWriteGenerationCurrent(
          conversationKey,
          target.expectedGeneration,
        )
      ) {
        return;
      }
      if (target.system === "claude_code") {
        await setClaudeConversationTitle(conversationKey, target.title);
        return;
      }
      if (target.system === "codex") {
        await setCodexConversationTitle(conversationKey, target.title);
        return;
      }
      if (
        target.kind === "paper" ||
        isUpstreamPaperConversationKey(conversationKey)
      ) {
        await setPaperConversationTitle(conversationKey, target.title);
        return;
      }
      await setGlobalConversationTitle(conversationKey, target.title);
    });
  },

  async clearCatalogTitle(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      await setClaudeConversationTitle(conversationKey, "", {
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        inTransaction: target.inTransaction,
      });
      return;
    }
    if (target.system === "codex") {
      await setCodexConversationTitle(conversationKey, "", {
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        inTransaction: target.inTransaction,
      });
      return;
    }
    await clearConversationTitle(conversationKey, {
      instanceID: target.instanceID,
      conversationID: target.conversationID,
      inTransaction: target.inTransaction,
    });
  },

  async touchCatalogTitle(
    target: ConversationCatalogMutationTarget & { title: string },
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      const existing = await getClaudeConversationSummary(conversationKey);
      if (!existing?.title?.trim()) {
        await touchClaudeConversationTitle(conversationKey, target.title);
      }
      return;
    }
    if (target.system === "codex") {
      const existing = await getCodexConversationSummary(conversationKey);
      if (!existing?.title?.trim()) {
        await touchCodexConversationTitle(conversationKey, target.title);
      }
      return;
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      await touchPaperConversationTitle(conversationKey, target.title);
      return;
    }
    await touchGlobalConversationTitle(conversationKey, target.title);
  },

  async touchEmptyCatalogActivity(
    target: ConversationCatalogMutationTarget & { timestamp?: number },
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    const expectedGeneration =
      target.expectedGeneration ??
      getConversationWriteGeneration(conversationKey);
    // The upstream variants of this touch rewrite created_at, which is the
    // immutable identity witness a queued deletion is verified against. Moving
    // it would make the finalizer classify the user's own deletion as "stale"
    // and silently abandon it, so a conversation awaiting deletion is never
    // touched. (Nothing should be adopting such a conversation anyway — see
    // resolveFreshConversationDraft — this is the backstop.)
    if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
      return;
    }
    const timestamp = normalizeTimestamp(target.timestamp, Date.now());
    if (target.system === "claude_code" || target.system === "codex") {
      const entry = await conversationRepository.getCatalogEntry(target);
      if (!entry) return;
      await withConversationWriteLock(conversationKey, async () => {
        if (
          areConversationWritesFrozen(conversationKey) ||
          !isConversationWriteGenerationCurrent(
            conversationKey,
            expectedGeneration,
          )
        ) {
          return;
        }
        const current = await conversationRepository.getCatalogEntry(target);
        if (!current || current.instanceID !== entry.instanceID) return;
        await touchRuntimeEmptyCatalogActivity(current, timestamp);
      });
      return;
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      await withConversationWriteLock(conversationKey, async () => {
        if (
          areConversationWritesFrozen(conversationKey) ||
          !isConversationWriteGenerationCurrent(
            conversationKey,
            expectedGeneration,
          )
        ) {
          return;
        }
        await touchEmptyPaperConversation(conversationKey, timestamp);
      });
      return;
    }
    await withConversationWriteLock(conversationKey, async () => {
      if (
        areConversationWritesFrozen(conversationKey) ||
        !isConversationWriteGenerationCurrent(
          conversationKey,
          expectedGeneration,
        )
      ) {
        return;
      }
      await touchEmptyGlobalConversation(conversationKey, timestamp);
    });
  },

  async deleteCatalogEntry(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    // Once the permanent ledger is active, even internal rollback paths must
    // use the same identity-bound local deletion primitive as user deletion.
    // The legacy direct helpers remain only for pre-migration test/upgrade
    // databases that have no ledger witness yet.
    if (target.instanceID) {
      await conversationRepository.deleteLocalConversationRows({
        ...target,
        conversationKey,
      });
      return;
    }
    const cleanupForkLink = async () => {
      await deleteConversationForkLink(conversationKey).catch(() => {});
    };
    if (target.system === "claude_code") {
      await deleteClaudeConversation(conversationKey);
      await cleanupForkLink();
      return;
    }
    if (target.system === "codex") {
      await deleteCodexConversation(conversationKey);
      releaseConversationScopeToken({
        profileSignature: getCodexProfileSignature(),
        conversationKey,
        instanceID: target.instanceID,
      });
      await cleanupForkLink();
      return;
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      await deletePaperConversation(conversationKey);
      await cleanupForkLink();
      return;
    }
    await deleteGlobalConversation(conversationKey);
    await cleanupForkLink();
  },

  async deleteLocalConversationRows(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    const providerSessionId = String(target.providerSessionId || "").trim();
    const hasClaudeScopeWitness =
      target.system === "claude_code" &&
      Boolean(target.providerScope?.scopeType && target.providerScope.scopeId);
    const cleanupParams =
      (providerSessionId || hasClaudeScopeWitness) &&
      (target.system === "codex" || target.system === "claude_code")
        ? [
            {
              operation:
                target.system === "codex"
                  ? ("codex_archive" as const)
                  : ("claude_invalidate" as const),
              system: target.system,
              conversationKey,
              instanceID: target.instanceID,
              conversationKind: target.kind,
              libraryID: target.libraryID,
              paperItemID: target.paperItemID,
              providerScope: target.providerScope,
              providerSessionId,
            },
          ]
        : [];
    for (const cleanup of target.additionalProviderCleanup || []) {
      const allowEmptyClaudeWitness =
        cleanup.system === "claude_code" &&
        Boolean(
          cleanup.providerScope?.scopeType &&
          cleanup.providerScope.scopeId &&
          target.instanceID,
        );
      if (!cleanup.providerSessionId.trim() && !allowEmptyClaudeWitness)
        continue;
      if (
        cleanupParams.some(
          (existing) =>
            existing.operation === cleanup.operation &&
            existing.system === cleanup.system &&
            existing.providerSessionId === cleanup.providerSessionId,
        )
      ) {
        continue;
      }
      cleanupParams.push({
        operation: cleanup.operation,
        system: cleanup.system,
        conversationKey,
        instanceID: target.instanceID,
        conversationKind: target.kind,
        libraryID: target.libraryID,
        paperItemID: target.paperItemID,
        providerScope: cleanup.providerScope,
        providerSessionId: cleanup.providerSessionId.trim(),
      });
    }
    if (cleanupParams.length) await initConversationCleanupJobs();
    const onCommit = cleanupParams.length
      ? async () => {
          for (const cleanup of cleanupParams) {
            const job =
              await enqueueConversationCleanupJobInTransaction(cleanup);
            if (!job) {
              throw new Error(
                "Provider cleanup job could not be persisted with local deletion",
              );
            }
          }
        }
      : undefined;
    if (target.system === "claude_code") {
      await deleteClaudeConversationLocalRows(conversationKey, {
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        onBeforeCommit: target.onBeforeCommit,
        onCommit,
      });
      return;
    }
    if (target.system === "codex") {
      await deleteCodexConversationLocalRows(conversationKey, {
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        onBeforeCommit: target.onBeforeCommit,
        onCommit,
      });
      releaseConversationScopeToken({
        profileSignature: getCodexProfileSignature(),
        conversationKey,
        instanceID: target.instanceID,
      });
      return;
    }
    await deleteUpstreamConversationLocalRows(conversationKey, target.kind, {
      instanceID: target.instanceID,
      conversationID: target.conversationID,
      onBeforeCommit: target.onBeforeCommit,
      onCommit,
    });
  },

  async preflightDeleteLocalConversationRows(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      await preflightDeleteClaudeConversationLocalRows(conversationKey);
      return;
    }
    if (target.system === "codex") {
      await preflightDeleteCodexConversationLocalRows(conversationKey);
      return;
    }
    await preflightDeleteUpstreamConversationLocalRows(conversationKey);
  },
};
