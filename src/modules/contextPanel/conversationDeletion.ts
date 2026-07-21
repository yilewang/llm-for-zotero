import type { ConversationSystem } from "../../shared/types";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  chatHistory,
  getAbortController,
  getPendingRequestId,
  loadedConversationKeys,
  selectedModelCache,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  setAbortController,
  setCancelledRequestId,
  setPendingRequestId,
} from "./state";
import { clearConversationSummary as clearConversationSummaryFromCache } from "./conversationSummaryCache";
import { conversationRepository } from "../../core/conversations/repository";
import {
  buildPaperStateKey,
  getLastUsedUpstreamGlobalConversationKey,
  getLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  removeLastUsedUpstreamGlobalConversationKey,
  removeLastUsedPaperConversationKey,
  setLockedGlobalConversationKey,
} from "./prefHelpers";
import { clearOwnerAttachmentRefs } from "../../utils/attachmentRefStore";
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
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
} from "../../claudeCode/prefs";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import {
  clearAgentConversationState,
  clearDeletedAgentConversationState,
} from "./agentConversationCleanup";
import { resolveConversationRefForKey } from "../../shared/conversationRef";
import {
  getConversationScopeValidationDetails,
  type ConversationRegistryRow,
  type ConversationScopeValidationDetails,
} from "../../shared/conversationRegistry";

type ConversationDeletionKind = "global" | "paper";

export type ConversationDeletionTarget = {
  conversationID?: string;
  conversationKey: number;
  kind: ConversationDeletionKind;
  conversationSystem: ConversationSystem;
  libraryID: number;
  paperItemID?: number;
  providerSessionId?: string | null;
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
  clearRememberedSelection: (target: ConversationDeletionTarget) => void;
};

export type ConversationDeletionDeps = {
  log?: (message: string, ...args: unknown[]) => void;
  cancelPendingRequest?: (conversationKey: number) => void;
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
  chatHistory.delete(conversationKey);
  loadedConversationKeys.delete(conversationKey);
  selectedModelCache.delete(conversationKey);
  selectedReasoningCache.delete(conversationKey);
  selectedReasoningProviderCache.delete(conversationKey);
  deps.resetSessionTokens?.(conversationKey);
  const composeStateKey =
    target.kind === "paper"
      ? normalizePositiveInt(target.paperItemID)
      : conversationKey;
  if (composeStateKey) {
    deps.clearTransientComposeStateForItem?.(composeStateKey);
  }
  clearConversationSummaryFromCache(conversationKey);
}

function buildOperations(
  deps: ConversationDeletionDeps,
): ConversationDeletionOperations {
  return {
    preflightDeleteLocalConversationRows: async (target) => {
      await conversationRepository.preflightDeleteLocalConversationRows({
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
      });
    },
    deleteLocalConversationRows: async (target) => {
      await conversationRepository.deleteLocalConversationRows({
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
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
          scope: buildClaudeScope({
            libraryID: target.libraryID,
            kind: target.kind,
            paperItemID: target.paperItemID,
          }),
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

function clearRememberedSelection(target: ConversationDeletionTarget): void {
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
    const persistedKey = Number(
      getLastUsedClaudePaperConversationKey(target.libraryID, paperItemID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedClaudePaperConversationKey(target.libraryID, paperItemID);
    }
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
    const persistedKey = Number(
      getLastUsedCodexPaperConversationKey(target.libraryID, paperItemID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedCodexPaperConversationKey(target.libraryID, paperItemID);
    }
    return;
  }
  const stateKey = buildPaperStateKey(target.libraryID, paperItemID);
  if (
    Math.floor(Number(activePaperConversationByPaper.get(stateKey) || 0)) ===
    conversationKey
  ) {
    activePaperConversationByPaper.delete(stateKey);
  }
  const persistedKey = Number(
    getLastUsedPaperConversationKey(target.libraryID, paperItemID) || 0,
  );
  if (
    Number.isFinite(persistedKey) &&
    Math.floor(persistedKey) === conversationKey
  ) {
    removeLastUsedPaperConversationKey(target.libraryID, paperItemID);
  }
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
  let scopeValidation = await getConversationScopeValidationDetails({
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
  const operations = buildOperations(deps);

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

  if (normalizedTarget.conversationSystem === "claude_code") {
    await runStep(
      result,
      "claude_session",
      "LLM: Failed to invalidate deleted Claude conversation",
      () =>
        operations.invalidateClaudeConversation(
          conversationKey,
          normalizedTarget,
        ),
      log,
    );
  }

  const codexThreadId =
    normalizedTarget.conversationSystem === "codex"
      ? normalizeProviderSessionId(normalizedTarget.providerSessionId)
      : "";
  if (codexThreadId) {
    const preflightErrorCount = result.errors.length;
    await runStep(
      result,
      "message_rows",
      "LLM: Failed to validate local conversation rows before archiving Codex thread",
      () => operations.preflightDeleteLocalConversationRows(normalizedTarget),
      log,
    );
    if (result.errors.length > preflightErrorCount) {
      result.blocked = true;
      return result;
    }
    try {
      await operations.archiveCodexThread(codexThreadId);
    } catch (error) {
      result.blocked = true;
      recordIssue(
        result,
        "errors",
        {
          code: "codex_thread_archive",
          message:
            "LLM: Failed to archive Codex thread; local conversation was not deleted",
          error,
        },
        log,
      );
      return result;
    }
  }

  const localDeleteErrorCount = result.errors.length;
  await runStep(
    result,
    "message_rows",
    "LLM: Failed to delete local conversation rows",
    () => operations.deleteLocalConversationRows(normalizedTarget),
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
    () => operations.removeConversationAttachmentFiles(conversationKey),
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

  return result;
}
