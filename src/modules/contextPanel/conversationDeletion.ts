import type { ConversationSystem } from "../../shared/types";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  chatHistory,
  getAbortController,
  getPendingRequestId,
  setAbortController,
  setCancelledRequestId,
  setPendingRequestId,
  clearConversationOwnedRuntimeState,
} from "./state";
import { clearConversationSummary as clearConversationSummaryFromCache } from "./conversationSummaryCache";
import {
  conversationRepository,
  type ConversationCatalogEntry,
  type ConversationCatalogIdentityWitness,
} from "../../core/conversations/repository";
import {
  buildPaperStateKey,
  getLastUsedUpstreamGlobalConversationKey,
  getLockedGlobalConversationKey,
  removeLastUsedUpstreamGlobalConversationKey,
  setLockedGlobalConversationKey,
} from "./prefHelpers";
import {
  clearOwnerAttachmentRefs,
  clearOwnerAttachmentRefsInTransaction,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type {
  PendingConversationDeletionEntry,
  PendingFinalizeOutcome,
  PendingTurnDeletionEntry,
} from "../../core/conversations/pendingDeletionStore";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import type { Message } from "./types";
import {
  collectAttachmentHashesFromMessages,
  findTurnPairByTimestamps,
} from "./turnMessageUtils";
import { removeConversationAttachmentFiles } from "./attachmentStorage";
import {
  buildClaudeScope,
  invalidateClaudeConversationSession,
} from "../../claudeCode/runtime";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  getLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
} from "../../claudeCode/prefs";
import { getRegisteredConversationScope } from "../../shared/conversationRegistry";
import {
  completeConversationCleanupJob,
  enqueueConversationCleanupJob,
  failConversationCleanupJob,
  listDueConversationCleanupJobs,
  type ConversationCleanupProviderScope,
  type ConversationCleanupJob,
} from "../../core/conversations/conversationCleanupJobs";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import { clearCodexNativeReadLedgerForConversation } from "../../codexAppServer/nativeContextLedger";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  getLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexGlobalConversationKey,
} from "../../codexAppServer/prefs";
import { invalidatePaperRestoreTargetCache } from "../../shared/paperConversationRestore";
import {
  clearAgentConversationState,
  clearDeletedAgentConversationState,
  clearPersistedAgentConversationRowsInTransaction,
} from "./agentConversationCleanup";
import { initAgentTraceStore } from "../../agent/store/traceStore";
import { resolveConversationRefForKey } from "../../shared/conversationRef";
import {
  getConversationScopeValidationDetails,
  type ConversationRegistryRow,
  type ConversationScopeValidationDetails,
} from "../../shared/conversationRegistry";
import { getConversationKeyLedgerEntry } from "../../shared/conversationKeyLedger";
import {
  bumpConversationWriteGeneration,
  unfreezeConversationWrites,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";

type ConversationDeletionKind = "global" | "paper";

export type ConversationDeletionTarget = {
  instanceID?: string;
  conversationID?: string;
  conversationKey: number;
  kind: ConversationDeletionKind;
  conversationSystem: ConversationSystem;
  libraryID: number;
  paperItemID?: number;
  providerSessionId?: string | null;
  providerScope?: ConversationCleanupProviderScope;
  /** Provider sessions captured by pending turn intents folded into this delete. */
  additionalProviderCleanup?: Array<{
    operation: "codex_archive" | "claude_invalidate";
    system: "codex" | "claude_code";
    providerSessionId: string;
    providerScope?: ConversationCleanupProviderScope;
  }>;
};

export type ConversationDeletionIssueCode =
  | "cancel_pending_request"
  | "runtime_cache"
  | "agent_state"
  | "claude_session"
  | "codex_thread_archive"
  | "message_rows"
  | "attachment_refs"
  | "attachment_files"
  | "catalog_row"
  | "remembered_selection"
  | "attachment_gc";

export type ConversationDeletionIssue = {
  code: ConversationDeletionIssueCode;
  message: string;
  error?: unknown;
};

export type ConversationDeletionResult = {
  ok: boolean;
  blocked: boolean;
  errors: ConversationDeletionIssue[];
  warnings: ConversationDeletionIssue[];
};

type ConversationDeletionOperations = {
  preflightDeleteLocalConversationRows: (
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  deleteLocalConversationRows: (
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  clearOwnerAttachmentRefs: typeof clearOwnerAttachmentRefs;
  removeConversationAttachmentFiles: typeof removeConversationAttachmentFiles;
  archiveCodexThread: (threadId: string) => Promise<void>;
  invalidateClaudeConversation: (
    conversationKey: number,
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  clearRememberedSelection: (
    target: ConversationDeletionTarget,
  ) => void | Promise<void>;
};

export type ConversationDeletionDeps = {
  log?: (message: string, ...args: unknown[]) => void;
  cancelPendingRequest?: (conversationKey: number) => void;
  clearConversationOwnedRuntimeState?: (conversationKey: number) => void;
  /** Compatibility hook for older callers; not used by the production path. */
  clearTransientComposeStateForItem?: (itemId: number) => void;
  resetSessionTokens?: (conversationKey: number) => void;
  scheduleAttachmentGc?: () => void;
  getCoreAgentRuntime?: () => unknown | Promise<unknown>;
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  operations?: Partial<ConversationDeletionOperations>;
};

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeProviderSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConversationID(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getClaudeProviderScope(
  target: Pick<
    ConversationDeletionTarget,
    | "conversationSystem"
    | "providerScope"
    | "libraryID"
    | "kind"
    | "paperItemID"
    | "providerSessionId"
  >,
): ConversationCleanupProviderScope | undefined {
  if (target.conversationSystem !== "claude_code") return undefined;
  if (target.providerScope) return target.providerScope;
  // The catalog may not have captured a provider session yet even though the
  // scoped Claude runtime is already retained by the bridge.  Derive the
  // scope from the immutable conversation identity so an empty-session
  // invalidation can still be persisted and retried safely.
  if (target.libraryID <= 0) return undefined;
  try {
    return buildClaudeScope({
      libraryID: target.libraryID,
      kind: target.kind,
      paperItemID: target.paperItemID,
    });
  } catch {
    // Provider-scope derivation must never block the authoritative local
    // deletion.  A cleanup job without a scope remains visible for retry or
    // attention-required handling once the provider runtime is available.
    return undefined;
  }
}

export function isProviderNotFoundError(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error || "",
  ).toLowerCase();
  return /no rollout found|thread not found|unknown thread|missing thread|no such thread/.test(
    message,
  );
}

function createResult(): ConversationDeletionResult {
  return {
    ok: true,
    blocked: false,
    errors: [],
    warnings: [],
  };
}

export function getConversationDeletionFailureMessage(
  result: Pick<ConversationDeletionResult, "blocked" | "errors">,
): string {
  if (result.errors.some((issue) => issue.code === "catalog_row")) {
    return "Failed to delete conversation because its saved identity is inconsistent. Check logs.";
  }
  if (
    result.blocked &&
    result.errors.some(
      (issue) =>
        issue.code === "codex_thread_archive" || issue.code === "message_rows",
    )
  ) {
    return "Failed to delete conversation. Codex thread was not archived.";
  }
  return "Failed to fully delete conversation. Check logs.";
}

function defaultCancelPendingRequest(conversationKey: number): void {
  const pendingRequestId = getPendingRequestId(conversationKey);
  if (pendingRequestId <= 0) return;
  const ctrl = getAbortController(conversationKey);
  if (ctrl) ctrl.abort();
  setCancelledRequestId(conversationKey, pendingRequestId);
  setPendingRequestId(conversationKey, 0);
  setAbortController(conversationKey, null);
}

function clearSharedRuntimeCaches(
  target: ConversationDeletionTarget,
  deps: ConversationDeletionDeps,
): void {
  const conversationKey = normalizePositiveInt(target.conversationKey);
  if (!conversationKey) return;
  if (target.conversationSystem === "codex") {
    clearCodexNativeReadLedgerForConversation({
      conversationKey,
      instanceID: target.instanceID,
    });
  }
  deps.resetSessionTokens?.(conversationKey);
  if (deps.clearConversationOwnedRuntimeState) {
    deps.clearConversationOwnedRuntimeState(conversationKey);
  } else if (deps.clearTransientComposeStateForItem) {
    // Keep test/embedding compatibility with the pre-coordinator hook.  The
    // production wiring supplies the identity-safe callback above, so shared
    // item-scoped context state is never cleared merely because a paper chat
    // was deleted.
    deps.clearTransientComposeStateForItem(
      target.kind === "paper"
        ? normalizePositiveInt(target.paperItemID)
        : conversationKey,
    );
  } else {
    clearConversationOwnedRuntimeState(conversationKey);
  }
  clearConversationSummaryFromCache(conversationKey);
}

function buildOperations(
  deps: ConversationDeletionDeps,
): ConversationDeletionOperations {
  return {
    preflightDeleteLocalConversationRows: async (target) => {
      await conversationRepository.preflightDeleteLocalConversationRows({
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
      });
    },
    deleteLocalConversationRows: async (target) => {
      // Ensure the trace-file cleanup table exists before the owning catalog
      // transaction starts; the transaction callback itself is DML-only.
      await initAgentTraceStore();
      await conversationRepository.deleteLocalConversationRows({
        instanceID: target.instanceID,
        conversationID: target.conversationID,
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
        providerScope: getClaudeProviderScope(target),
        providerSessionId: target.providerSessionId,
        additionalProviderCleanup: target.additionalProviderCleanup,
        libraryID: target.libraryID,
        paperItemID: target.paperItemID,
        onBeforeCommit: async () => {
          await clearPersistedAgentConversationRowsInTransaction(
            target.conversationKey,
          );
          await clearOwnerAttachmentRefsInTransaction(
            "conversation",
            target.conversationKey,
          );
        },
      });
    },
    clearOwnerAttachmentRefs,
    removeConversationAttachmentFiles,
    archiveCodexThread: (threadId) => archiveCodexAppServerThread({ threadId }),
    invalidateClaudeConversation: async (conversationKey, target) => {
      if (!deps.getCoreAgentRuntime) {
        return;
      }
      await invalidateClaudeConversationSession(
        (await deps.getCoreAgentRuntime()) as any,
        {
          conversationKey,
          scope: getClaudeProviderScope(target),
          metadata: target.providerSessionId
            ? {
                providerSessionId: target.providerSessionId,
                instanceID: target.instanceID,
              }
            : target.instanceID
              ? { instanceID: target.instanceID }
              : undefined,
        },
      );
    },
    clearRememberedSelection,
    ...deps.operations,
  };
}

function recordIssue(
  result: ConversationDeletionResult,
  list: "errors" | "warnings",
  issue: ConversationDeletionIssue,
  log?: (message: string, ...args: unknown[]) => void,
): void {
  result[list].push(issue);
  if (list === "errors") result.ok = false;
  if ("error" in issue) {
    log?.(issue.message, issue.error);
  } else {
    log?.(issue.message);
  }
}

function summarizeRegistryScope(
  scope: ConversationRegistryRow | null | undefined,
): Record<string, unknown> | null {
  if (!scope) return null;
  return {
    instanceID: scope.instanceID,
    conversationID: scope.conversationID,
    conversationKey: scope.conversationKey,
    system: scope.system,
    kind: scope.kind,
    profileSignature: scope.profileSignature,
    libraryID: scope.libraryID,
    paperItemID: scope.paperItemID,
    valid: scope.valid,
    invalidReason: scope.invalidReason,
  };
}

function summarizeScopeValidationFailure(
  details: ConversationScopeValidationDetails,
): Record<string, unknown> {
  return {
    reason: details.reason || "unknown",
    target: summarizeRegistryScope(details.target),
    registered: summarizeRegistryScope(details.registered),
  };
}

function canCanonicalizeRegistryConversationID(
  details: ConversationScopeValidationDetails,
): boolean {
  const target = details.target;
  const registered = details.registered;
  if (
    details.reason !== "conversation_id_mismatch" ||
    !target ||
    !registered?.valid
  ) {
    return false;
  }
  return (
    registered.conversationKey === target.conversationKey &&
    registered.system === target.system &&
    registered.kind === target.kind &&
    registered.profileSignature === target.profileSignature &&
    registered.libraryID === target.libraryID &&
    (registered.paperItemID || null) === (target.paperItemID || null)
  );
}

async function runStep(
  result: ConversationDeletionResult,
  code: ConversationDeletionIssueCode,
  message: string,
  fn: () => void | Promise<void>,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    recordIssue(result, "errors", { code, message, error }, log);
  }
}

async function runWarningStep(
  result: ConversationDeletionResult,
  code: ConversationDeletionIssueCode,
  message: string,
  fn: () => void | Promise<void>,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    recordIssue(result, "warnings", { code, message, error }, log);
  }
}

async function clearRememberedSelection(
  target: ConversationDeletionTarget,
): Promise<void> {
  // The numeric key is permanently retired. Still prove the captured instance
  // before clearing any active/last-used pointer so a delayed cleanup cannot
  // touch an unrelated surviving surface.
  if (target.instanceID) {
    try {
      const current = await conversationRepository.getCatalogIdentityWitness({
        instanceID: undefined,
        conversationID: undefined,
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
        libraryID: target.libraryID,
        paperItemID: target.paperItemID,
      });
      if (current?.instanceID && current.instanceID !== target.instanceID) {
        return;
      }
    } catch {
      // The local commit has already established the deletion boundary. If the
      // replacement witness cannot be read now, fail closed and preserve the
      // pointer rather than risking a newer instance's state.
      return;
    }
  }
  const conversationKey = target.conversationKey;
  if (target.kind === "global") {
    if (target.conversationSystem === "claude_code") {
      const stateKey = buildClaudeLibraryStateKey(target.libraryID);
      if (
        Math.floor(
          Number(activeClaudeGlobalConversationByLibrary.get(stateKey) || 0),
        ) === conversationKey
      ) {
        activeClaudeGlobalConversationByLibrary.delete(stateKey);
      }
      const persistedKey = Number(
        getLastUsedClaudeGlobalConversationKey(target.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedClaudeGlobalConversationKey(target.libraryID);
      }
      return;
    }
    if (target.conversationSystem === "codex") {
      const stateKey = buildCodexLibraryStateKey(target.libraryID);
      if (
        Math.floor(
          Number(activeCodexGlobalConversationByLibrary.get(stateKey) || 0),
        ) === conversationKey
      ) {
        activeCodexGlobalConversationByLibrary.delete(stateKey);
      }
      const persistedKey = Number(
        getLastUsedCodexGlobalConversationKey(target.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedCodexGlobalConversationKey(target.libraryID);
      }
      return;
    }
    if (
      Math.floor(
        Number(activeGlobalConversationByLibrary.get(target.libraryID) || 0),
      ) === conversationKey
    ) {
      activeGlobalConversationByLibrary.delete(target.libraryID);
    }
    const persistedKey = Number(
      getLastUsedUpstreamGlobalConversationKey(target.libraryID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedUpstreamGlobalConversationKey(target.libraryID);
    }
    const lockedKey = getLockedGlobalConversationKey(target.libraryID);
    if (
      lockedKey !== null &&
      Number.isFinite(lockedKey) &&
      Math.floor(Number(lockedKey)) === conversationKey
    ) {
      setLockedGlobalConversationKey(target.libraryID, null);
    }
    return;
  }

  const paperItemID = normalizePositiveInt(target.paperItemID);
  if (!paperItemID) return;
  if (target.conversationSystem === "claude_code") {
    const stateKey = buildClaudePaperStateKey(target.libraryID, paperItemID);
    if (
      Math.floor(
        Number(activeClaudePaperConversationByPaper.get(stateKey) || 0),
      ) === conversationKey
    ) {
      activeClaudePaperConversationByPaper.delete(stateKey);
    }
    invalidatePaperRestoreTargetCache(
      {
        system: "claude_code",
        libraryID: target.libraryID,
        paperItemID,
      },
      conversationKey,
      target.instanceID,
    );
    return;
  }
  if (target.conversationSystem === "codex") {
    const stateKey = buildCodexPaperStateKey(target.libraryID, paperItemID);
    if (
      Math.floor(
        Number(activeCodexPaperConversationByPaper.get(stateKey) || 0),
      ) === conversationKey
    ) {
      activeCodexPaperConversationByPaper.delete(stateKey);
    }
    invalidatePaperRestoreTargetCache(
      {
        system: "codex",
        libraryID: target.libraryID,
        paperItemID,
      },
      conversationKey,
      target.instanceID,
    );
    return;
  }
  const stateKey = buildPaperStateKey(target.libraryID, paperItemID);
  if (
    Math.floor(Number(activePaperConversationByPaper.get(stateKey) || 0)) ===
    conversationKey
  ) {
    activePaperConversationByPaper.delete(stateKey);
  }
  invalidatePaperRestoreTargetCache(
    {
      system: "upstream",
      libraryID: target.libraryID,
      paperItemID,
    },
    conversationKey,
    target.instanceID,
  );
}

export async function finalizeConversationDeletion(
  target: ConversationDeletionTarget,
  deps: ConversationDeletionDeps = {},
): Promise<ConversationDeletionResult> {
  const result = createResult();
  const conversationKey = normalizePositiveInt(target.conversationKey);
  const libraryID = normalizePositiveInt(target.libraryID);
  const log = deps.log;
  if (!conversationKey || !libraryID) {
    recordIssue(
      result,
      "errors",
      {
        code: "catalog_row",
        message: "LLM: Cannot delete conversation with invalid identity",
      },
      log,
    );
    return result;
  }

  const targetConversationID = normalizeConversationID(target.conversationID);
  const resolvedRef = targetConversationID
    ? null
    : await resolveConversationRefForKey(conversationKey);
  const conversationID =
    targetConversationID || resolvedRef?.conversationID || "";
  let normalizedTarget: ConversationDeletionTarget = {
    ...target,
    conversationID: conversationID || undefined,
    conversationKey,
    libraryID,
    paperItemID: normalizePositiveInt(target.paperItemID) || undefined,
  };
  normalizedTarget = {
    ...normalizedTarget,
    providerScope: getClaudeProviderScope(normalizedTarget),
  };
  let scopeValidation = await getConversationScopeValidationDetails({
    instanceID: normalizedTarget.instanceID,
    conversationID: normalizedTarget.conversationID,
    conversationKey,
    system: normalizedTarget.conversationSystem,
    kind: normalizedTarget.kind,
    libraryID,
    paperItemID: normalizedTarget.paperItemID,
  });
  if (canCanonicalizeRegistryConversationID(scopeValidation)) {
    normalizedTarget = {
      ...normalizedTarget,
      conversationID: scopeValidation.registered?.conversationID || undefined,
    };
    scopeValidation = await getConversationScopeValidationDetails({
      instanceID: normalizedTarget.instanceID,
      conversationID: normalizedTarget.conversationID,
      conversationKey,
      system: normalizedTarget.conversationSystem,
      kind: normalizedTarget.kind,
      libraryID,
      paperItemID: normalizedTarget.paperItemID,
    });
  }
  if (!scopeValidation.valid) {
    result.blocked = true;
    recordIssue(
      result,
      "errors",
      {
        code: "catalog_row",
        message:
          "LLM: Refused to delete conversation with mismatched registry scope",
        error: summarizeScopeValidationFailure(scopeValidation),
      },
      log,
    );
    return result;
  }
  if (!normalizedTarget.instanceID && scopeValidation.registered?.instanceID) {
    normalizedTarget = {
      ...normalizedTarget,
      instanceID: scopeValidation.registered.instanceID,
    };
  }
  // A whole-conversation delete absorbs any still-pending turn intents for
  // the exact same instance.  Their provider session IDs are independent
  // witnesses (for example, a Codex turn may have captured an older thread),
  // so preserve each one as a cleanup job inside the local-delete transaction
  // before the turn rows are purged.
  const additionalProviderCleanup = pendingDeletionStore
    .getPendingTurnsForConversation(conversationKey)
    .filter(
      (
        turn,
      ): turn is PendingTurnDeletionEntry & {
        system: "codex" | "claude_code";
        providerSessionId: string;
      } =>
        (turn.system === "codex" || turn.system === "claude_code") &&
        (Boolean(turn.providerSessionId?.trim()) ||
          (turn.system === "claude_code" &&
            Boolean(turn.libraryID && turn.conversationKind) &&
            Boolean(turn.instanceID))) &&
        (!turn.instanceID ||
          !normalizedTarget.instanceID ||
          turn.instanceID === normalizedTarget.instanceID),
    )
    .map((turn) => ({
      operation:
        turn.system === "codex"
          ? ("codex_archive" as const)
          : ("claude_invalidate" as const),
      system: turn.system,
      providerSessionId: String(turn.providerSessionId || "").trim(),
      providerScope:
        turn.system === "claude_code" && turn.libraryID && turn.conversationKind
          ? buildClaudeScope({
              libraryID: turn.libraryID,
              kind: turn.conversationKind,
              paperItemID: turn.paperItemID,
            })
          : undefined,
    }));
  if (additionalProviderCleanup.length) {
    normalizedTarget = {
      ...normalizedTarget,
      additionalProviderCleanup,
    };
  }
  const operations = buildOperations(deps);

  const preflightErrorCount = result.errors.length;
  await runStep(
    result,
    "cancel_pending_request",
    "LLM: Failed to cancel pending request for deleted conversation",
    () =>
      (deps.cancelPendingRequest || defaultCancelPendingRequest)(
        conversationKey,
      ),
    log,
  );

  const codexThreadId =
    normalizedTarget.conversationSystem === "codex"
      ? normalizeProviderSessionId(normalizedTarget.providerSessionId)
      : "";
  await runStep(
    result,
    "message_rows",
    "LLM: Failed to validate local conversation rows before deletion",
    () => operations.preflightDeleteLocalConversationRows(normalizedTarget),
    log,
  );
  if (result.errors.length > preflightErrorCount) {
    result.blocked = true;
    return result;
  }
  const localDeleteErrorCount = result.errors.length;
  await runStep(
    result,
    "message_rows",
    "LLM: Failed to delete local conversation rows",
    () =>
      withConversationWriteLock(conversationKey, () =>
        operations.deleteLocalConversationRows(normalizedTarget),
      ),
    log,
  );
  if (result.errors.length > localDeleteErrorCount) {
    return result;
  }
  await runStep(
    result,
    "runtime_cache",
    "LLM: Failed to clear deleted conversation runtime caches",
    () => clearSharedRuntimeCaches(normalizedTarget, deps),
    log,
  );

  const agentHadError = await clearDeletedAgentConversationState(
    {
      clearAgentToolCaches: deps.clearAgentToolCaches,
      clearAgentConversationState:
        deps.clearAgentConversationState || clearAgentConversationState,
      log: log || (() => {}),
    },
    conversationKey,
    normalizedTarget.kind,
  );
  if (agentHadError) {
    recordIssue(result, "errors", {
      code: "agent_state",
      message: "LLM: Failed to fully clear deleted agent conversation state",
    });
  }
  await runStep(
    result,
    "attachment_refs",
    "LLM: Failed to clear deleted conversation attachment refs",
    () => operations.clearOwnerAttachmentRefs("conversation", conversationKey),
    log,
  );
  await runStep(
    result,
    "attachment_files",
    "LLM: Failed to remove deleted conversation attachment files",
    () =>
      operations.removeConversationAttachmentFiles(
        conversationKey,
        normalizedTarget.instanceID,
      ),
    log,
  );
  await runStep(
    result,
    "remembered_selection",
    "LLM: Failed to clear deleted conversation selection state",
    () => operations.clearRememberedSelection(normalizedTarget),
    log,
  );
  await runStep(
    result,
    "attachment_gc",
    "LLM: Failed to schedule deleted conversation attachment GC",
    () => deps.scheduleAttachmentGc?.(),
    log,
  );

  // Provider cleanup is deliberately after the local commit.  A provider
  // outage or an already-missing Codex rollout must never keep the local
  // conversation alive.  Persist the exact session first so the operation can
  // be retried after restart without retaining conversation content.
  if (codexThreadId) {
    let job: ConversationCleanupJob | null = null;
    try {
      job = await enqueueConversationCleanupJob({
        operation: "codex_archive",
        system: "codex",
        conversationKey,
        instanceID: normalizedTarget.instanceID,
        providerScope: normalizedTarget.providerScope,
        providerSessionId: codexThreadId,
      });
    } catch (error) {
      recordIssue(result, "errors", {
        code: "codex_thread_archive",
        message:
          "LLM: Could not persist Codex cleanup job; deletion remains pending for a safe retry",
        error,
      });
    }
    if (job) {
      await runWarningStep(
        result,
        "codex_thread_archive",
        "LLM: Failed to archive deleted Codex thread; local conversation is already deleted",
        async () => {
          try {
            await operations.archiveCodexThread(codexThreadId);
          } catch (error) {
            if (isProviderNotFoundError(error)) return;
            throw error;
          }
          await completeConversationCleanupJob(job.id);
        },
        log,
      );
      if (
        result.warnings.some((issue) => issue.code === "codex_thread_archive")
      ) {
        await failConversationCleanupJob(
          job,
          result.warnings.find((issue) => issue.code === "codex_thread_archive")
            ?.error,
        );
      }
    } else if (
      !result.errors.some((issue) => issue.code === "codex_thread_archive")
    ) {
      // A missing job is not success: enqueueConversationCleanupJob returns
      // null when the database is unavailable.  Try the exact provider
      // operation immediately, but keep the deletion retryable if that also
      // fails so the thread ID is never silently discarded.
      await runWarningStep(
        result,
        "codex_thread_archive",
        "LLM: Could not persist or perform Codex cleanup for deleted conversation",
        async () => {
          try {
            await operations.archiveCodexThread(codexThreadId);
          } catch (error) {
            if (isProviderNotFoundError(error)) return;
            throw error;
          }
        },
        log,
      );
    }
  }

  if (normalizedTarget.conversationSystem === "claude_code") {
    const providerSessionId = normalizeProviderSessionId(
      normalizedTarget.providerSessionId,
    );
    let job: ConversationCleanupJob | null = null;
    try {
      job = await enqueueConversationCleanupJob({
        operation: "claude_invalidate",
        system: "claude_code",
        conversationKey,
        instanceID: normalizedTarget.instanceID,
        providerScope: normalizedTarget.providerScope,
        providerSessionId,
      });
    } catch (error) {
      if (providerSessionId) {
        recordIssue(result, "errors", {
          code: "claude_session",
          message:
            "LLM: Could not persist Claude cleanup job; deletion remains pending for a safe retry",
          error,
        });
      }
    }
    if (job) {
      await runWarningStep(
        result,
        "claude_session",
        "LLM: Failed to invalidate deleted Claude conversation; local conversation is already deleted",
        async () => {
          await operations.invalidateClaudeConversation(
            conversationKey,
            normalizedTarget,
          );
          await completeConversationCleanupJob(job.id);
        },
        log,
      );
      if (result.warnings.some((issue) => issue.code === "claude_session")) {
        await failConversationCleanupJob(
          job,
          result.warnings.find((issue) => issue.code === "claude_session")
            ?.error,
        );
      }
    } else {
      // The catalog may not have captured a provider session yet even though
      // the Claude bridge has already retained a scoped runtime. Make the
      // identity-bound invalidation attempt anyway; an empty session ID means
      // there is no durable provider ID to enqueue, but the bridge can still
      // remove its exact conversation scope and hot runtime.
      await runWarningStep(
        result,
        "claude_session",
        "LLM: Failed to invalidate Claude runtime for deleted conversation",
        () =>
          operations.invalidateClaudeConversation(
            conversationKey,
            normalizedTarget,
          ),
        log,
      );
    }
  }

  return result;
}

/** Drain provider cleanup jobs without ever touching local conversation state. */
export async function processPendingConversationCleanupJobs(
  deps: ConversationDeletionDeps & {
    includeAttentionRequired?: boolean;
  } = {},
): Promise<void> {
  const jobs = await listDueConversationCleanupJobs(Date.now(), {
    includeAttentionRequired: deps.includeAttentionRequired,
  });
  if (!jobs.length) return;
  const operations = buildOperations(deps);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        if (job.operation === "codex_archive") {
          try {
            await operations.archiveCodexThread(job.providerSessionId);
          } catch (error) {
            if (!isProviderNotFoundError(error)) throw error;
          }
        } else if (job.operation === "claude_invalidate") {
          if (!job.providerSessionId) {
            // An empty-session Claude job is a pre-Clear lifecycle witness.
            // If a replacement turn has already persisted, the catalog still
            // has no provider ID until post-turn capture. Do not consume the
            // witness in that window: leave it retryable so the new turn can
            // observe it and force a fresh provider session.
            const current = await conversationRepository.getCatalogEntry({
              system: "claude_code",
              kind: job.conversationKind,
              conversationKey: job.conversationKey,
            });
            if (current && current.userTurnCount > 0) {
              throw new Error(
                "Claude empty-session cleanup deferred while replacement turn is active",
              );
            }
          }
          await operations.invalidateClaudeConversation(job.conversationKey, {
            instanceID: job.instanceID || undefined,
            conversationKey: job.conversationKey,
            kind: job.conversationKind,
            conversationSystem: "claude_code",
            libraryID: job.libraryID,
            paperItemID: job.paperItemID,
            providerScope: job.providerScope,
            providerSessionId: job.providerSessionId,
          });
        }
        await completeConversationCleanupJob(job.id);
      } catch (error) {
        await failConversationCleanupJob(job, error);
      }
    }),
  );
}

// ── Headless finalizers for the durable pending-deletion queue ────────────────
// These run with no live panel (startup sweep, orphaned-window recovery), so
// they must not touch DOM or per-controller state; live panels react to the
// store's events instead.

// Conversation keys are permanently retired and conversation instance IDs are
// cryptographically random. The exact instance witness is authoritative; the
// catalog-created timestamp remains a migration witness and is immune to clock
// rollback because it is compared for exact equality.
// "stale" intents are simply dropped; "unknown" means ownership could not be
// verified, so nothing destructive may run until a later retry can verify.
async function classifyQueuedConversationDeletionStaleness(
  entry: PendingConversationDeletionEntry,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<"stale" | "fresh" | "unknown" | "unverifiable"> {
  const witness = Math.floor(Number(entry.catalogCreatedAt || 0));
  if (witness <= 0 || !entry.instanceID) {
    // Persisted by a build that recorded no witness. The intent is unverifiable
    // now and forever, so drop it rather than gamble on whatever conversation
    // owns the key today. The user's conversation simply reappears and can be
    // deleted again.
    log?.("LLM: dropping queued deletion carrying no identity witness", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
      instanceID: entry.instanceID,
    });
    // "unverifiable", NOT "stale": nothing was deleted and the conversation on
    // this key is still there. Surfaces must not treat this as a deletion.
    return "unverifiable";
  }
  let summary: ConversationCatalogEntry | null = null;
  try {
    summary = await conversationRepository.getCatalogEntry({
      system: entry.system,
      kind: entry.conversationKind,
      conversationKey: entry.conversationKey,
    });
  } catch (err) {
    log?.("LLM: stale-deletion check failed; deferring for retry", err);
    return "unknown";
  }
  if (!summary) {
    // No catalog row owns the key any more: the queued conversation is already
    // gone, so there is nothing left to delete — and nothing may be deleted.
    log?.("LLM: dropping queued deletion — catalog row no longer exists", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
    });
    return "stale";
  }
  if (Math.floor(Number(summary.createdAt || 0)) !== witness) {
    log?.(
      "LLM: dropping stale queued deletion — the key is owned by a different catalog row now",
      {
        conversationKey: entry.conversationKey,
        queuedCatalogCreatedAt: witness,
        currentCatalogCreatedAt: summary.createdAt,
      },
    );
    return "stale";
  }
  const catalogConversationID = normalizeConversationID(summary.conversationID);
  if (
    entry.conversationID &&
    catalogConversationID &&
    catalogConversationID !== entry.conversationID
  ) {
    log?.(
      "LLM: dropping stale queued deletion — catalog row carries a different conversation id",
      {
        conversationKey: entry.conversationKey,
        queuedConversationID: entry.conversationID,
        currentConversationID: catalogConversationID,
      },
    );
    return "stale";
  }
  let registered: Awaited<ReturnType<typeof getRegisteredConversationScope>> =
    null;
  try {
    registered = await getRegisteredConversationScope(entry.conversationKey);
  } catch (err) {
    log?.(
      "LLM: stale-deletion registry check failed; deferring for retry",
      err,
    );
    return "unknown";
  }
  if (!registered) {
    return "unverifiable";
  }
  if (
    registered.instanceID !== entry.instanceID ||
    (entry.conversationID && registered.conversationID !== entry.conversationID)
  ) {
    log?.(
      "LLM: dropping stale queued deletion — key now registered to another conversation",
      {
        conversationKey: entry.conversationKey,
        queuedConversationID: entry.conversationID,
        queuedInstanceID: entry.instanceID,
        currentConversationID: registered.conversationID,
        currentInstanceID: registered.instanceID,
      },
    );
    return "stale";
  }
  return "fresh";
}

async function ensureQueuedProviderCleanupJob(
  entry: PendingConversationDeletionEntry,
): Promise<boolean> {
  if (entry.providerCleanupState === "complete") return true;
  const providerSessionId = normalizeProviderSessionId(entry.providerSessionId);
  if (entry.system !== "codex" && entry.system !== "claude_code") return true;
  if (!providerSessionId && entry.system !== "claude_code") return true;
  try {
    const job = await enqueueConversationCleanupJob({
      operation:
        entry.system === "codex" ? "codex_archive" : "claude_invalidate",
      system: entry.system,
      conversationKey: entry.conversationKey,
      providerScope: getClaudeProviderScope({
        conversationSystem: entry.system,
        providerScope: undefined,
        libraryID: entry.libraryID,
        kind: entry.conversationKind,
        paperItemID: entry.paperItemID,
      }),
      instanceID: entry.instanceID,
      providerSessionId,
    });
    return Boolean(job);
  } catch {
    return false;
  }
}

/**
 * Retry work that necessarily happens after the local transaction (runtime
 * caches, agent state, attachment references/files, and remembered selection).
 * The catalog may already be absent when a restart reaches this path, so this
 * recovery is deliberately independent of catalog lookup.  Keys are
 * permanently retired, which makes these identity-scoped cleanup operations
 * safe to repeat without touching a future conversation.
 */
async function retryPostCommitCleanupForDeletedInstance(
  entry: PendingConversationDeletionEntry,
  deps: ConversationDeletionDeps,
): Promise<void> {
  const target: ConversationDeletionTarget = {
    instanceID: entry.instanceID,
    conversationID: entry.conversationID,
    conversationKey: entry.conversationKey,
    kind: entry.conversationKind,
    conversationSystem: entry.system,
    libraryID: entry.libraryID,
    paperItemID: entry.paperItemID,
    providerSessionId: entry.providerSessionId,
  };
  const operations = buildOperations(deps);
  clearSharedRuntimeCaches(target, deps);
  const agentHadError = await clearDeletedAgentConversationState(
    {
      clearAgentToolCaches: deps.clearAgentToolCaches,
      clearAgentConversationState:
        deps.clearAgentConversationState || clearAgentConversationState,
      log: deps.log || (() => {}),
    },
    entry.conversationKey,
    entry.conversationKind,
  );
  if (agentHadError) throw new Error("agent cleanup remains pending");
  await operations.clearOwnerAttachmentRefs(
    "conversation",
    entry.conversationKey,
  );
  await operations.removeConversationAttachmentFiles(
    entry.conversationKey,
    entry.instanceID,
  );
  await operations.clearRememberedSelection(target);
}

async function hasRetiredLedgerIdentity(
  entry: PendingConversationDeletionEntry,
): Promise<boolean> {
  try {
    const ledger = await getConversationKeyLedgerEntry(entry.conversationKey);
    return Boolean(
      ledger?.retiredAt &&
      ledger.instanceID === String(entry.instanceID || "").trim(),
    );
  } catch (error) {
    // A legacy/test database without the ledger cannot prove that the local
    // transaction committed, so do not run destructive post-commit recovery.
    if (/no such table|no table/i.test(String(error))) return false;
    throw error;
  }
}

/**
 * Legacy pending rows may predate the immutable catalog witness. If the live
 * catalog and registry still agree, bind that row to the exact instance before
 * attempting destructive work. A different witness proves the original row
 * has already been replaced and is therefore a stale, satisfied intent.
 */
async function repairQueuedConversationIdentity(
  entry: PendingConversationDeletionEntry,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<"fresh" | "stale" | "unverifiable"> {
  if (entry.instanceID && entry.catalogCreatedAt > 0) return "fresh";
  // A legacy row with neither an immutable instance nor a catalog-createdAt
  // witness has no evidence tying it to the current numeric key.  Even if the
  // key and deterministic conversation ID still match, binding it to the live
  // row would turn an unverifiable historical intent into a destructive one.
  // Keep it quarantined until an explicit migration supplies the missing
  // witness; never infer identity from the numeric key alone.
  if (!(entry.catalogCreatedAt > 0)) {
    log?.("LLM: pending deletion has no repairable catalog witness", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
    });
    return "unverifiable";
  }
  let witness: ConversationCatalogIdentityWitness | null = null;
  try {
    witness = await conversationRepository.getCatalogIdentityWitness({
      instanceID: entry.instanceID,
      conversationID: entry.conversationID,
      system: entry.system,
      kind: entry.conversationKind,
      conversationKey: entry.conversationKey,
      libraryID: entry.libraryID,
      paperItemID: entry.paperItemID,
    });
  } catch (error) {
    log?.("LLM: pending deletion identity repair failed", error);
    return "unverifiable";
  }
  if (!witness) return "unverifiable";
  if (
    (entry.instanceID && entry.instanceID !== witness.instanceID) ||
    (entry.conversationID &&
      witness.conversationID &&
      entry.conversationID !== witness.conversationID) ||
    (entry.catalogCreatedAt > 0 &&
      entry.catalogCreatedAt !== witness.catalogCreatedAt)
  ) {
    log?.("LLM: pending deletion identity belongs to a newer catalog row", {
      conversationKey: entry.conversationKey,
      queuedInstanceID: entry.instanceID,
      currentInstanceID: witness.instanceID,
    });
    return "stale";
  }
  const repaired = await pendingDeletionStore.repairConversationIdentity(
    entry,
    witness,
  );
  return repaired ? "fresh" : "unverifiable";
}

export async function finalizeQueuedConversationDeletion(
  entry: PendingConversationDeletionEntry,
  deps: ConversationDeletionDeps = {},
): Promise<boolean | PendingFinalizeOutcome> {
  const releaseStaleWriteFence = () => {
    bumpConversationWriteGeneration(entry.conversationKey);
    unfreezeConversationWrites(entry.conversationKey);
  };
  const identityRepair = await repairQueuedConversationIdentity(
    entry,
    deps.log,
  );
  if (identityRepair === "stale") {
    releaseStaleWriteFence();
    return (await ensureQueuedProviderCleanupJob(entry))
      ? entry.providerSessionId
        ? { ok: true, cleanupPending: true }
        : true
      : { ok: false };
  }
  const staleness = await classifyQueuedConversationDeletionStaleness(
    entry,
    deps.log,
  );
  if (staleness === "unverifiable") {
    // Identity cannot be proven. Keep the write-ahead obligation durable and
    // quarantine it; a numeric key is never sufficient for a destructive retry.
    return { ok: false, quarantined: true };
  }
  if (staleness === "stale") {
    releaseStaleWriteFence();
    // The queued conversation is genuinely gone (no catalog row owns the key,
    // or the key now belongs to a different conversation). Report a plain
    // completion: surfaces must NOT restore anyone onto this key — that is how
    // a deleted chat came back as an empty "New chat" — and the write-ahead row
    // must not be retried against the key's new owner.
    // Local rows may already be gone after a provider-job persistence failure.
    // Reconcile the exact captured session before withdrawing the write-ahead
    // intent; if the DB is still unavailable, retain the intent for another
    // retry instead of losing provider cleanup permanently.
    if (await hasRetiredLedgerIdentity(entry)) {
      try {
        await retryPostCommitCleanupForDeletedInstance(entry, deps);
      } catch (error) {
        deps.log?.("LLM: post-commit deletion cleanup remains pending", error);
        return { ok: false, cleanupPending: true };
      }
    }
    return (await ensureQueuedProviderCleanupJob(entry))
      ? entry.providerSessionId
        ? { ok: true, cleanupPending: true }
        : true
      : { ok: false };
  }
  if (staleness === "unknown") {
    // Ownership could not be verified; nothing destructive has run yet, so
    // report a retry-safe failure instead of risking the key's new owner.
    return false;
  }
  let paperItemID = Number(entry.paperItemID || 0) || undefined;
  if (entry.conversationKind === "paper" && !paperItemID) {
    const summary = await conversationRepository.getCatalogEntry({
      system: entry.system,
      kind: "paper",
      conversationKey: entry.conversationKey,
    });
    paperItemID = Number(summary?.paperItemID || 0) || undefined;
  }
  const result = await finalizeConversationDeletion(
    {
      conversationID: entry.conversationID,
      instanceID: entry.instanceID,
      conversationKey: entry.conversationKey,
      kind: entry.conversationKind,
      conversationSystem: entry.system,
      libraryID: entry.libraryID,
      paperItemID,
      providerSessionId: entry.providerSessionId,
    },
    deps,
  );
  if (result.ok) {
    const cleanupPending = result.warnings.some(
      (issue) =>
        issue.code === "codex_thread_archive" ||
        issue.code === "claude_session",
    );
    return cleanupPending ? { ok: true, cleanupPending: true } : true;
  }
  // Every failure that aborts BEFORE local rows are deleted early-returns with
  // one of these markers; retrying those is safe. Any other failure happened
  // AFTER the destructive delete — report success to the queue so the undo
  // affordance cannot claim to restore a chat whose rows are already gone.
  const retrySafe =
    result.blocked ||
    result.errors.some(
      (issue) =>
        issue.code === "codex_thread_archive" ||
        issue.code === "claude_session" ||
        issue.code === "message_rows" ||
        issue.code === "catalog_row",
    );
  if (retrySafe) {
    // The individual issues were logged as they were recorded, but nothing
    // recorded the DECISION. Without it the log cannot distinguish "deferred,
    // will retry" from "gave up", which is exactly what the user's
    // "Failed to fully delete conversation. Check logs." toast points at.
    deps.log?.("LLM: queued conversation deletion deferred; will retry", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
      blocked: result.blocked,
      errors: result.errors,
    });
    return false;
  }
  // Local rows have committed, but one of the post-commit obligations failed.
  // Keep the write-ahead row so a restart can run the identity-scoped recovery
  // above; never report success merely because the catalog is already gone.
  return { ok: false, cleanupPending: true };
}

export async function finalizeQueuedTurnDeletion(
  entry: PendingTurnDeletionEntry,
  deps: {
    log?: (message: string, ...args: unknown[]) => void;
    scheduleAttachmentGc?: () => void;
    detachProviderSession?: (entry: PendingTurnDeletionEntry) => Promise<void>;
    clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  } = {},
): Promise<boolean | PendingFinalizeOutcome> {
  const log = deps.log || (() => {});
  return withConversationWriteLock(entry.conversationKey, async () => {
    try {
      const deleteTarget = {
        system: entry.system,
        conversationKey: entry.conversationKey,
        userTimestamp: entry.userTimestamp,
        assistantTimestamp: entry.assistantTimestamp,
        ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}),
        ...(entry.assistantMessageID
          ? { assistantMessageID: entry.assistantMessageID }
          : {}),
        // Agent transcript/memory/evidence/run state is keyed by the immutable
        // conversation, not by the chat-message row IDs.  Purge it in the same
        // transaction as the turn rows so a crash cannot leave deleted turn
        // content available to the next prompt.
        onBeforeCommit: () =>
          clearPersistedAgentConversationRowsInTransaction(
            entry.conversationKey,
          ),
      };
      await conversationRepository.deleteTurnMessages(deleteTarget);
    } catch (err) {
      log("LLM: queued turn deletion failed to delete rows", err);
      return false;
    }
    try {
      await deps.detachProviderSession?.(entry);
    } catch (err) {
      log("LLM: queued turn deletion failed to detach provider session", err);
      return { ok: false, localDeleted: true };
    }
    if (entry.system === "codex") {
      clearCodexNativeReadLedgerForConversation({
        conversationKey: entry.conversationKey,
        instanceID: entry.instanceID,
      });
    }
    try {
      await (deps.clearAgentConversationState || clearAgentConversationState)(
        entry.conversationKey,
      );
    } catch (err) {
      // Persistent agent rows were already purged atomically.  Keep the intent
      // retryable so in-memory caches and trace files are cleared before the
      // queue reports the turn as complete.
      log("LLM: queued turn deletion could not clear agent runtime state", err);
      return { ok: false, localDeleted: true };
    }
    const history = chatHistory.get(entry.conversationKey);
    if (history) {
      const pair = findTurnPairByTimestamps(
        history,
        entry.userTimestamp,
        entry.assistantTimestamp,
      );
      if (pair) {
        history.splice(pair.userIndex, 2);
        chatHistory.set(entry.conversationKey, history);
      }
    }
    try {
      const remaining =
        chatHistory.get(entry.conversationKey) ||
        ((await conversationRepository.loadMessages({
          system: entry.system,
          conversationKey: entry.conversationKey,
        })) as unknown as Message[]);
      await replaceOwnerAttachmentRefs(
        "conversation",
        entry.conversationKey,
        collectAttachmentHashesFromMessages(remaining),
      );
    } catch (err) {
      // Attachment ownership is part of the turn deletion boundary.  A failed
      // recomputation must keep the durable turn intent alive so a later retry
      // can remove the stale references; reporting success here would make the
      // deleted blobs permanently unreachable from lifecycle cleanup.
      log("LLM: queued turn deletion could not reconcile attachment refs", err);
      return { ok: false, localDeleted: true };
    }
    deps.scheduleAttachmentGc?.();
    return true;
  });
}
