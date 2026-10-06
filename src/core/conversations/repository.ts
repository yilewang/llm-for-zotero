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
  scheduleConversationCleanupJobsChangedNotification,
  type ConversationCleanupProviderScope,
} from "./conversationCleanupJobs";
import { copyPlanDocumentOwnersForFork } from "../../agent/documents/store";
import { notifyBackgroundCleanupNeeded } from "../maintenance/backgroundCleanupSignals";

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
  upsertSummary: typeof upsertClaudeConversationSummary,
): Promise<void> {
  if (entry.userTurnCount > 0) return;
  const updatedAt = normalizeTimestamp(timestamp, Date.now());
  await upsertSummary({
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

type CatalogTitleIdentity = {
  instanceID?: string;
  conversationID?: string;
  inTransaction?: boolean;
};

type LocalRowDeletionIdentity = {
  instanceID?: string;
  conversationID?: string;
  onBeforeCommit?: () => Promise<void>;
  onCommit?: () => Promise<void>;
};

/**
 * One conversation store as the repository drives it.  Each method body is
 * the store's former branch of the matching repository method; the
 * repository normalizes its arguments and runs the shared part (identity
 * enrichment, write locks, provider cleanup jobs) around the call.
 */
type ConversationStoreAdapter = {
  getCatalogEntry(
    conversationKey: number,
    kind: ConversationCatalogKind | undefined,
  ): Promise<ConversationCatalogEntry | null>;
  loadMessages(
    conversationKey: number,
    limit: number,
  ): Promise<StoredChatMessage[]>;
  deleteTurnMessages(
    conversationKey: number,
    userTimestamp: number,
    assistantTimestamp: number,
    userMessageID?: number,
    assistantMessageID?: number,
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void>;
  ensureCatalogEntry(
    params: EnsureCatalogEntryParams,
    normalized: {
      libraryID: number;
      paperItemID: number;
      conversationKey: number;
    },
  ): Promise<ConversationCatalogEntry | null>;
  createCatalogEntry(
    params: CreateCatalogEntryParams,
    normalized: { libraryID: number; paperItemID: number },
  ): Promise<ConversationCatalogEntry | null>;
  /** Absent for a store that cannot fork (Claude Code). */
  fork?: {
    /**
     * Codex only: a fork must start from the latest forkable assistant turn,
     * because the native thread fork copies the whole provider thread.
     */
    getLatestForkableAssistantTimestamp?: typeof getLatestCodexForkableAssistantTimestamp;
    copyMessages: typeof forkUpstreamConversationMessages;
  };
  listCatalogEntries(
    params: ConversationCatalogListParams,
    normalized: { libraryID: number; paperItemID: number; limit: number },
  ): Promise<ConversationCatalogEntry[]>;
  listAllCatalogEntries(
    libraryID: number,
    limit: number | null,
  ): Promise<ConversationCatalogEntry[]>;
  setCatalogTitle(
    conversationKey: number,
    kind: ConversationCatalogKind | undefined,
    title: string,
  ): Promise<void>;
  clearCatalogTitle(
    conversationKey: number,
    identity: CatalogTitleIdentity,
  ): Promise<void>;
  touchCatalogTitle(
    conversationKey: number,
    kind: ConversationCatalogKind | undefined,
    title: string,
  ): Promise<void>;
  touchEmptyCatalogActivity(
    target: ConversationCatalogMutationTarget,
    conversationKey: number,
    expectedGeneration: number,
    timestamp: number,
  ): Promise<void>;
  /** The pre-ledger deletion, for a row without an instance witness. */
  deleteLegacyConversation(
    conversationKey: number,
    kind: ConversationCatalogKind | undefined,
  ): Promise<void>;
  deleteLocalConversationRows(
    conversationKey: number,
    kind: ConversationCatalogKind | undefined,
    identity: LocalRowDeletionIdentity,
  ): Promise<void>;
  preflightDeleteLocalConversationRows(conversationKey: number): Promise<void>;
  /** Runs after either deletion (Codex releases the MCP scope token). */
  afterDelete?(conversationKey: number, instanceID: string | undefined): void;
  /** The provider job a deleted conversation queues (runtime stores only). */
  providerCleanup?: {
    operation: "codex_archive" | "claude_invalidate";
    system: "codex" | "claude_code";
    /** A Claude scope alone (without a session) witnesses a provider session. */
    scopeIsSessionWitness: boolean;
  };
};

const UPSTREAM_STORE: ConversationStoreAdapter = {
  async getCatalogEntry(conversationKey, kind) {
    if (kind === "global" || isUpstreamGlobalConversationKey(conversationKey)) {
      return fromUpstreamGlobalSummary(
        await getGlobalConversation(conversationKey),
      );
    }
    if (kind === "paper" || isUpstreamPaperConversationKey(conversationKey)) {
      return fromUpstreamPaperSummary(
        await getPaperConversation(conversationKey),
      );
    }
    return null;
  },

  loadMessages(conversationKey, limit) {
    return loadUpstreamConversation(conversationKey, limit);
  },

  async deleteTurnMessages(
    conversationKey,
    userTimestamp,
    assistantTimestamp,
    userMessageID,
    assistantMessageID,
    onBeforeCommit,
  ) {
    await deleteUpstreamTurnMessages(
      conversationKey,
      userTimestamp,
      assistantTimestamp,
      userMessageID,
      assistantMessageID,
      onBeforeCommit,
    );
  },

  async ensureCatalogEntry(
    params,
    { libraryID, paperItemID, conversationKey },
  ) {
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

  async createCatalogEntry(params, { libraryID, paperItemID }) {
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

  fork: {
    copyMessages: (params) => forkUpstreamConversationMessages(params),
  },

  async listCatalogEntries(params, { libraryID, paperItemID, limit }) {
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

  async listAllCatalogEntries(libraryID, limit) {
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

  async setCatalogTitle(conversationKey, kind, title) {
    if (kind === "paper" || isUpstreamPaperConversationKey(conversationKey)) {
      await setPaperConversationTitle(conversationKey, title);
      return;
    }
    await setGlobalConversationTitle(conversationKey, title);
  },

  async clearCatalogTitle(conversationKey, identity) {
    await clearConversationTitle(conversationKey, identity);
  },

  async touchCatalogTitle(conversationKey, kind, title) {
    if (kind === "paper" || isUpstreamPaperConversationKey(conversationKey)) {
      await touchPaperConversationTitle(conversationKey, title);
      return;
    }
    await touchGlobalConversationTitle(conversationKey, title);
  },

  async touchEmptyCatalogActivity(
    target,
    conversationKey,
    expectedGeneration,
    timestamp,
  ) {
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

  async deleteLegacyConversation(conversationKey, kind) {
    if (kind === "paper" || isUpstreamPaperConversationKey(conversationKey)) {
      await deletePaperConversation(conversationKey);
      return;
    }
    await deleteGlobalConversation(conversationKey);
  },

  async deleteLocalConversationRows(conversationKey, kind, identity) {
    await deleteUpstreamConversationLocalRows(conversationKey, kind, identity);
  },

  async preflightDeleteLocalConversationRows(conversationKey) {
    await preflightDeleteUpstreamConversationLocalRows(conversationKey);
  },
};

/** The store functions a runtime backend (Claude Code, Codex) exports. */
type RuntimeStoreFunctions = {
  system: "claude_code" | "codex";
  fromSummary(
    summary: ClaudeConversationSummary | null | undefined,
  ): ConversationCatalogEntry | null;
  getSummary: typeof getClaudeConversationSummary;
  loadConversation: typeof loadClaudeConversation;
  deleteTurnMessages: typeof deleteClaudeTurnMessages;
  ensureGlobalConversation: typeof ensureClaudeGlobalConversation;
  ensurePaperConversation: typeof ensureClaudePaperConversation;
  createGlobalConversation: typeof createClaudeGlobalConversation;
  createPaperConversation: typeof createClaudePaperConversation;
  listGlobalConversations: typeof listClaudeGlobalConversations;
  listPaperConversations: typeof listClaudePaperConversations;
  listAllPaperConversationsByLibrary: typeof listAllClaudePaperConversationsByLibrary;
  setConversationTitle: typeof setClaudeConversationTitle;
  touchConversationTitle: typeof touchClaudeConversationTitle;
  upsertSummary: typeof upsertClaudeConversationSummary;
  deleteConversation: typeof deleteClaudeConversation;
  deleteConversationLocalRows: typeof deleteClaudeConversationLocalRows;
  preflightDeleteConversationLocalRows: typeof preflightDeleteClaudeConversationLocalRows;
};

/**
 * A runtime store's adapter.  Claude Code and Codex ran the same branch
 * bodies against their own store functions; Codex adds the fork capability,
 * the MCP scope-token release after a deletion, and its own cleanup job.
 */
function createRuntimeStoreAdapter(
  store: RuntimeStoreFunctions,
  extra: Pick<
    ConversationStoreAdapter,
    "fork" | "afterDelete" | "providerCleanup"
  >,
): ConversationStoreAdapter {
  return {
    async getCatalogEntry(conversationKey) {
      return store.fromSummary(await store.getSummary(conversationKey));
    },

    loadMessages(conversationKey, limit) {
      return store.loadConversation(conversationKey, limit);
    },

    async deleteTurnMessages(
      conversationKey,
      userTimestamp,
      assistantTimestamp,
      userMessageID,
      assistantMessageID,
      onBeforeCommit,
    ) {
      await store.deleteTurnMessages(
        conversationKey,
        userTimestamp,
        assistantTimestamp,
        userMessageID,
        assistantMessageID,
        onBeforeCommit,
      );
    },

    async ensureCatalogEntry(
      params,
      { libraryID, paperItemID, conversationKey },
    ) {
      if (conversationKey) {
        const existing = await store.getSummary(conversationKey);
        if (existing) {
          const entry = store.fromSummary(existing);
          if (!catalogEntryMatchesScope(entry, params)) return null;
          await repairRuntimeRegistryFromSummary(store.system, existing);
          return entry;
        }
        // An explicit key is a lookup witness, never an instruction to create
        // a row. Recreating a missing key here would allow a stale history
        // read to resurrect a retired conversation; new conversations must go
        // through createCatalogEntry().
        return null;
      }
      return store.fromSummary(
        params.kind === "paper"
          ? await store.ensurePaperConversation(libraryID, paperItemID)
          : await store.ensureGlobalConversation(libraryID),
      );
    },

    async createCatalogEntry(params, { libraryID, paperItemID }) {
      return hydrateCatalogEntryInstanceID(
        store.fromSummary(
          params.kind === "paper"
            ? await store.createPaperConversation(libraryID, paperItemID, {
                conversationKey: params.preferredConversationKey,
              })
            : await store.createGlobalConversation(libraryID, {
                conversationKey: params.preferredConversationKey,
              }),
        ),
      );
    },

    async listCatalogEntries(params, { libraryID, paperItemID, limit }) {
      const rows =
        params.kind === "paper"
          ? await store.listPaperConversations(libraryID, paperItemID, limit)
          : await store.listGlobalConversations(libraryID, limit);
      return rows
        .map((row) => store.fromSummary(row))
        .filter((row): row is ConversationCatalogEntry => Boolean(row));
    },

    async listAllCatalogEntries(libraryID, limit) {
      const [paperRows, globalRows] = await Promise.all([
        store.listAllPaperConversationsByLibrary(libraryID, limit),
        store.listGlobalConversations(libraryID, limit),
      ]);
      return sortCatalogEntries(
        [...paperRows, ...globalRows]
          .map((row) => store.fromSummary(row))
          .filter((row): row is ConversationCatalogEntry => Boolean(row)),
      );
    },

    async setCatalogTitle(conversationKey, _kind, title) {
      await store.setConversationTitle(conversationKey, title);
    },

    async clearCatalogTitle(conversationKey, identity) {
      await store.setConversationTitle(conversationKey, "", identity);
    },

    async touchCatalogTitle(conversationKey, _kind, title) {
      const existing = await store.getSummary(conversationKey);
      if (!existing?.title?.trim()) {
        await store.touchConversationTitle(conversationKey, title);
      }
    },

    async touchEmptyCatalogActivity(
      target,
      conversationKey,
      expectedGeneration,
      timestamp,
    ) {
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
        await touchRuntimeEmptyCatalogActivity(
          current,
          timestamp,
          store.upsertSummary,
        );
      });
    },

    async deleteLegacyConversation(conversationKey) {
      await store.deleteConversation(conversationKey);
    },

    async deleteLocalConversationRows(conversationKey, _kind, identity) {
      await store.deleteConversationLocalRows(conversationKey, identity);
    },

    async preflightDeleteLocalConversationRows(conversationKey) {
      await store.preflightDeleteConversationLocalRows(conversationKey);
    },

    ...extra,
  };
}

const CLAUDE_CODE_STORE = createRuntimeStoreAdapter(
  {
    system: "claude_code",
    fromSummary: fromClaudeSummary,
    getSummary: getClaudeConversationSummary,
    loadConversation: loadClaudeConversation,
    deleteTurnMessages: deleteClaudeTurnMessages,
    ensureGlobalConversation: ensureClaudeGlobalConversation,
    ensurePaperConversation: ensureClaudePaperConversation,
    createGlobalConversation: createClaudeGlobalConversation,
    createPaperConversation: createClaudePaperConversation,
    listGlobalConversations: listClaudeGlobalConversations,
    listPaperConversations: listClaudePaperConversations,
    listAllPaperConversationsByLibrary:
      listAllClaudePaperConversationsByLibrary,
    setConversationTitle: setClaudeConversationTitle,
    touchConversationTitle: touchClaudeConversationTitle,
    upsertSummary: upsertClaudeConversationSummary,
    deleteConversation: deleteClaudeConversation,
    deleteConversationLocalRows: deleteClaudeConversationLocalRows,
    preflightDeleteConversationLocalRows:
      preflightDeleteClaudeConversationLocalRows,
  },
  {
    providerCleanup: {
      operation: "claude_invalidate",
      system: "claude_code",
      scopeIsSessionWitness: true,
    },
  },
);

const CODEX_STORE = createRuntimeStoreAdapter(
  {
    system: "codex",
    fromSummary: fromCodexSummary,
    getSummary: getCodexConversationSummary,
    loadConversation: loadCodexConversation,
    deleteTurnMessages: deleteCodexTurnMessages,
    ensureGlobalConversation: ensureCodexGlobalConversation,
    ensurePaperConversation: ensureCodexPaperConversation,
    createGlobalConversation: createCodexGlobalConversation,
    createPaperConversation: createCodexPaperConversation,
    listGlobalConversations: listCodexGlobalConversations,
    listPaperConversations: listCodexPaperConversations,
    listAllPaperConversationsByLibrary: listAllCodexPaperConversationsByLibrary,
    setConversationTitle: setCodexConversationTitle,
    touchConversationTitle: touchCodexConversationTitle,
    upsertSummary: upsertCodexConversationSummary,
    deleteConversation: deleteCodexConversation,
    deleteConversationLocalRows: deleteCodexConversationLocalRows,
    preflightDeleteConversationLocalRows:
      preflightDeleteCodexConversationLocalRows,
  },
  {
    fork: {
      getLatestForkableAssistantTimestamp: (sourceConversationKey) =>
        getLatestCodexForkableAssistantTimestamp(sourceConversationKey),
      copyMessages: (params) => forkCodexConversationMessages(params),
    },
    afterDelete(conversationKey, instanceID) {
      releaseConversationScopeToken({
        profileSignature: getCodexProfileSignature(),
        conversationKey,
        instanceID,
      });
    },
    providerCleanup: {
      operation: "codex_archive",
      system: "codex",
      scopeIsSessionWitness: false,
    },
  },
);

/**
 * The conversation stores, by system.  A value that names neither runtime
 * store is served by the upstream store, as the repository always did.
 */
const STORES: Readonly<
  Record<"claude_code" | "codex", ConversationStoreAdapter>
> = {
  claude_code: CLAUDE_CODE_STORE,
  codex: CODEX_STORE,
};

function storeFor(system: ConversationSystem): ConversationStoreAdapter {
  return system === "claude_code" || system === "codex"
    ? STORES[system]
    : UPSTREAM_STORE;
}

export const conversationRepository = {
  async getCatalogEntry(
    target: ConversationCatalogMutationTarget,
  ): Promise<ConversationCatalogEntry | null> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return null;
    const entry = await storeFor(target.system).getCatalogEntry(
      conversationKey,
      target.kind,
    );
    return entry ? attachCatalogInstanceIdentity(entry) : null;
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
    return storeFor(target.system).loadMessages(conversationKey, limit);
  },

  async deleteTurnMessages(target: DeleteTurnMessagesParams): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    const userTimestamp = normalizeTimestamp(target.userTimestamp);
    const assistantTimestamp = normalizeTimestamp(target.assistantTimestamp);
    await storeFor(target.system).deleteTurnMessages(
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
    return storeFor(params.system).ensureCatalogEntry(params, {
      libraryID,
      paperItemID,
      conversationKey,
    });
  },

  async createCatalogEntry(
    params: CreateCatalogEntryParams,
  ): Promise<ConversationCatalogEntry | null> {
    const libraryID = normalizePositiveInt(params.libraryID);
    const paperItemID = normalizePositiveInt(params.paperItemID);
    if (!libraryID) return null;
    return storeFor(params.system).createCatalogEntry(params, {
      libraryID,
      paperItemID,
    });
  },

  async forkConversation(
    params: ForkConversationParams,
  ): Promise<ForkConversationResult | null> {
    if (params.system !== "upstream" && params.system !== "codex") {
      return null;
    }
    const fork = storeFor(params.system).fork;
    if (!fork) return null;
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

      if (fork.getLatestForkableAssistantTimestamp) {
        const latestForkableAssistantTimestamp =
          await fork.getLatestForkableAssistantTimestamp(sourceConversationKey);
        if (latestForkableAssistantTimestamp !== throughAssistantTimestamp) {
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
        const copyResult = await fork.copyMessages({
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
      const [sourceMessages, targetMessages] = await Promise.all([
        conversationRepository.loadMessages({
          system: params.system,
          conversationKey: sourceConversationKey,
          limit: 10_000,
        }),
        conversationRepository.loadMessages({
          system: params.system,
          conversationKey: entry.conversationKey,
          limit: 10_000,
        }),
      ]);
      const sourceAssistantTimestamps = sourceMessages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.timestamp <= throughAssistantTimestamp,
        )
        .map((message) => message.timestamp);
      const targetAssistantTimestamps = targetMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.timestamp);
      await copyPlanDocumentOwnersForFork({
        sourceConversationKey,
        targetConversationKey: entry.conversationKey,
        throughAssistantTimestamp,
        sourceAssistantTimestamps,
        targetAssistantTimestamps,
      });

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
    return storeFor(params.system).listCatalogEntries(params, {
      libraryID,
      paperItemID,
      limit,
    });
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
    return storeFor(params.system).listAllCatalogEntries(libraryID, limit);
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
      await storeFor(target.system).setCatalogTitle(
        conversationKey,
        target.kind,
        target.title,
      );
    });
  },

  async clearCatalogTitle(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    await storeFor(target.system).clearCatalogTitle(conversationKey, {
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
    await storeFor(target.system).touchCatalogTitle(
      conversationKey,
      target.kind,
      target.title,
    );
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
    await storeFor(target.system).touchEmptyCatalogActivity(
      target,
      conversationKey,
      expectedGeneration,
      timestamp,
    );
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
      scheduleConversationCleanupJobsChangedNotification();
      return;
    }
    const store = storeFor(target.system);
    await store.deleteLegacyConversation(conversationKey, target.kind);
    store.afterDelete?.(conversationKey, target.instanceID);
    await deleteConversationForkLink(conversationKey).catch(() => {});
  },

  async deleteLocalConversationRows(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    const store = storeFor(target.system);
    const providerCleanup = store.providerCleanup;
    const providerSessionId = String(target.providerSessionId || "").trim();
    const hasClaudeScopeWitness =
      Boolean(providerCleanup?.scopeIsSessionWitness) &&
      Boolean(target.providerScope?.scopeType && target.providerScope.scopeId);
    const cleanupParams =
      (providerSessionId || hasClaudeScopeWitness) && providerCleanup
        ? [
            {
              operation: providerCleanup.operation,
              system: providerCleanup.system,
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
    await store.deleteLocalConversationRows(conversationKey, target.kind, {
      instanceID: target.instanceID,
      conversationID: target.conversationID,
      onBeforeCommit: target.onBeforeCommit,
      onCommit,
    });
    store.afterDelete?.(conversationKey, target.instanceID);
    notifyBackgroundCleanupNeeded();
  },

  async preflightDeleteLocalConversationRows(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    await storeFor(target.system).preflightDeleteLocalConversationRows(
      conversationKey,
    );
  },
};
