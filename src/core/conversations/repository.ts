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
  repairRegisteredConversationScope,
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

export type ConversationCatalogKind = "global" | "paper";

export type ConversationCatalogEntry = {
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
  system: ConversationSystem;
  conversationKey: number;
  kind?: ConversationCatalogKind;
};

type ConversationMessageTarget = {
  system: ConversationSystem;
  conversationKey: number;
};

type DeleteTurnMessagesParams = ConversationMessageTarget & {
  userTimestamp: number;
  assistantTimestamp: number;
};

type EnsureCatalogEntryParams = ConversationCatalogScope & {
  conversationKey?: number;
  title?: string;
};

type CreateCatalogEntryParams = ConversationCatalogScope;

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
  const existing = await getRegisteredConversationScope(summary.conversationKey);
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
  if (!isConversationKeyForKind("upstream", entry.kind, entry.conversationKey)) {
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
      return fromClaudeSummary(
        await getClaudeConversationSummary(conversationKey),
      );
    }
    if (target.system === "codex") {
      return fromCodexSummary(
        await getCodexConversationSummary(conversationKey),
      );
    }
    if (
      target.kind === "global" ||
      isUpstreamGlobalConversationKey(conversationKey)
    ) {
      return fromUpstreamGlobalSummary(
        await getGlobalConversation(conversationKey),
      );
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      return fromUpstreamPaperSummary(
        await getPaperConversation(conversationKey),
      );
    }
    return null;
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
      );
      return;
    }
    if (target.system === "codex") {
      await deleteCodexTurnMessages(
        conversationKey,
        userTimestamp,
        assistantTimestamp,
      );
      return;
    }
    await deleteUpstreamTurnMessages(
      conversationKey,
      userTimestamp,
      assistantTimestamp,
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
        await upsertClaudeConversationSummary({
          conversationKey,
          libraryID,
          kind: params.kind,
          paperItemID,
          title: params.title || "",
        });
        return fromClaudeSummary(
          await getClaudeConversationSummary(conversationKey),
        );
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
        await upsertCodexConversationSummary({
          conversationKey,
          libraryID,
          kind: params.kind,
          paperItemID,
          title: params.title || "",
        });
        return fromCodexSummary(
          await getCodexConversationSummary(conversationKey),
        );
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
      conversationKey && conversationKey !== paperItemID
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
      return fromClaudeSummary(
        params.kind === "paper"
          ? await createClaudePaperConversation(libraryID, paperItemID)
          : await createClaudeGlobalConversation(libraryID),
      );
    }
    if (params.system === "codex") {
      return fromCodexSummary(
        params.kind === "paper"
          ? await createCodexPaperConversation(libraryID, paperItemID)
          : await createCodexGlobalConversation(libraryID),
      );
    }
    if (params.kind === "paper") {
      return fromUpstreamPaperSummary(
        paperItemID
          ? await createPaperConversation(libraryID, paperItemID)
          : null,
      );
    }
    const conversationKey = await createGlobalConversation(libraryID);
    return conversationKey
      ? fromUpstreamGlobalSummary(await getGlobalConversation(conversationKey))
      : null;
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
  },

  async clearCatalogTitle(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      await setClaudeConversationTitle(conversationKey, "");
      return;
    }
    if (target.system === "codex") {
      await setCodexConversationTitle(conversationKey, "");
      return;
    }
    await clearConversationTitle(conversationKey);
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
    const timestamp = normalizeTimestamp(target.timestamp, Date.now());
    if (target.system === "claude_code" || target.system === "codex") {
      const entry = await conversationRepository.getCatalogEntry(target);
      if (entry) await touchRuntimeEmptyCatalogActivity(entry, timestamp);
      return;
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      await touchEmptyPaperConversation(conversationKey, timestamp);
      return;
    }
    await touchEmptyGlobalConversation(conversationKey, timestamp);
  },

  async deleteCatalogEntry(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      await deleteClaudeConversation(conversationKey);
      return;
    }
    if (target.system === "codex") {
      await deleteCodexConversation(conversationKey);
      return;
    }
    if (
      target.kind === "paper" ||
      isUpstreamPaperConversationKey(conversationKey)
    ) {
      await deletePaperConversation(conversationKey);
      return;
    }
    await deleteGlobalConversation(conversationKey);
  },

  async deleteLocalConversationRows(
    target: ConversationCatalogMutationTarget,
  ): Promise<void> {
    const conversationKey = normalizePositiveInt(target.conversationKey);
    if (!conversationKey) return;
    if (target.system === "claude_code") {
      await deleteClaudeConversationLocalRows(conversationKey);
      return;
    }
    if (target.system === "codex") {
      await deleteCodexConversationLocalRows(conversationKey);
      return;
    }
    await deleteUpstreamConversationLocalRows(conversationKey, target.kind);
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
