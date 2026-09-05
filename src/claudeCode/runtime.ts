import type { AgentRuntime } from "../agent/runtime";
import type {
  AgentEvent,
  AgentRuntimeOutcome,
  AgentRuntimeRequestInput as AgentRuntimeRequest,
} from "../agent/types";
import type {
  ClaudeConversationKind,
  ClaudeConversationSummary,
  ConversationSystem,
} from "../shared/types";
import {
  createExternalBackendBridgeRuntime,
  fetchExternalBridgeSessionInfo,
  type AgentRuntimeLike,
  type ExternalBridgeSessionInfo,
} from "../agent/externalBackendBridge";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "./state";
import {
  appendClaudeMessage,
  clearClaudeConversationSessionMetadata,
  createClaudeGlobalConversation,
  createClaudePaperConversation,
  deleteClaudeTurnMessages as deleteClaudeConversationTurnMessagesStore,
  ensureClaudeGlobalConversation,
  ensureClaudePaperConversation,
  getClaudeConversationSummary,
  listClaudeGlobalConversations,
  listClaudePaperConversations,
  loadClaudeConversation,
  pruneClaudeConversation,
  updateLatestClaudeAssistantMessage,
  updateLatestClaudeUserMessage,
  upsertClaudeConversationSummary,
} from "./store";
import type { StoredChatMessage } from "../utils/chatStore";
import {
  getClaudeBridgeUrl,
  getClaudePermissionModePref,
  getClaudeReasoningModePref,
  getClaudeRuntimeModelPref,
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  setConversationSystemPref,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "./prefs";
import type { RuntimeModelEntry } from "../utils/modelProviders";
import {
  CLAUDE_REASONING_OPTIONS,
  type ClaudeReasoningMode,
  type ClaudeRuntimeModel,
} from "./constants";
import { dbg } from "../utils/debugLogger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { getClaudeProfileSignature } from "./projectSkills";
import {
  buildClaudeRuntimeModelEntries,
  type ClaudeModelCatalog,
  type ClaudeModelCatalogRequestContext,
} from "./modelCatalog";

export type ClaudeBridgeActionDescriptor = {
  name: string;
  description: string;
  inputSchema: object;
  source: "backend";
  backendToolName: string;
  riskLevel: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  mutability: "read" | "write";
};

export type ClaudeSlashCommandDescriptor = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "fallback";
};

export type ClaudeEffortFallback = {
  requested: string;
  resolved: string;
  supported: string[];
};

export type ClaudeBridgeSessionInfo = ExternalBridgeSessionInfo;

export type ClaudeBridgeScope = {
  scopeType: "paper" | "open";
  scopeId: string;
  scopeLabel?: string;
};

const conversationScopeCache = new Map<number, ClaudeBridgeScope>();
const conversationScopeIdentityCache = new Map<number, string>();
let bridgeRuntimeCache: AgentRuntimeLike | null = null;
let bridgeRuntimeCoreRef: AgentRuntime | null = null;

function getBridgeUrl(): string {
  return getClaudeBridgeUrl();
}

export function isClaudeConversationSystemActive(): boolean {
  return getConversationSystemPref() === "claude_code";
}

export function setClaudeConversationSystemActive(active: boolean): void {
  setConversationSystemPref(active ? "claude_code" : "upstream");
}

export function getClaudeConversationSystem(): ConversationSystem {
  return getConversationSystemPref();
}

export function getClaudeRuntimeModelEntries(): RuntimeModelEntry[] {
  return buildClaudeRuntimeModelEntries({
    models: [],
    selectedModel: getClaudeRuntimeModelPref(),
  });
}

export function getSelectedClaudeRuntimeEntry(): RuntimeModelEntry {
  const selectedModel = getClaudeRuntimeModelPref();
  return (
    getClaudeRuntimeModelEntries().find(
      (entry) => entry.model === selectedModel,
    ) || getClaudeRuntimeModelEntries()[0]
  );
}

export function getSelectedClaudeReasoningMode(): ClaudeReasoningMode {
  return getClaudeReasoningModePref();
}

export function getClaudePermissionMode(): "safe" | "yolo" {
  return getClaudePermissionModePref();
}

export function buildClaudeReasoningConfig():
  | { provider: "anthropic"; level: "low" | "medium" | "high" | "xhigh" }
  | undefined {
  const mode = getClaudeReasoningModePref();
  if (mode === "auto") return undefined;
  return {
    provider: "anthropic",
    level: mode === "max" ? "xhigh" : mode,
  };
}

export function buildClaudeScope(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  paperTitle?: string;
}): ClaudeBridgeScope {
  const profileSignature = getClaudeProfileSignature();
  if (params.kind === "paper" && params.paperItemID) {
    return {
      scopeType: "paper",
      scopeId: `${profileSignature}:${Math.floor(params.libraryID)}:${Math.floor(params.paperItemID)}`,
      scopeLabel: params.paperTitle || undefined,
    };
  }
  return {
    scopeType: "open",
    scopeId: `${profileSignature}:${Math.floor(params.libraryID)}`,
    scopeLabel: "Open Chat",
  };
}

export function rememberClaudeConversationScope(
  conversationKey: number,
  scope: ClaudeBridgeScope,
  instanceID?: string,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const key = Math.floor(conversationKey);
  conversationScopeCache.set(key, scope);
  if (instanceID?.trim())
    conversationScopeIdentityCache.set(key, instanceID.trim());
}

export function getRememberedClaudeConversationScope(
  conversationKey: number,
): ClaudeBridgeScope | null {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return null;
  return conversationScopeCache.get(Math.floor(conversationKey)) || null;
}

export function forgetClaudeConversationScope(
  conversationKey: number,
  expectedInstanceID?: string,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const key = Math.floor(conversationKey);
  const expected = expectedInstanceID?.trim();
  if (expected) {
    // If a cleanup job carries an identity, absence is not permission to
    // delete an unlabelled/new runtime entry.  This closes the old-key race.
    const remembered = conversationScopeIdentityCache.get(key);
    if (!remembered || remembered !== expected) return;
  }
  conversationScopeCache.delete(key);
  conversationScopeIdentityCache.delete(key);
}

export function resetClaudeBridgeRuntime(): void {
  bridgeRuntimeCache = null;
  bridgeRuntimeCoreRef = null;
  conversationScopeCache.clear();
  conversationScopeIdentityCache.clear();
}

export function getClaudeBridgeRuntime(
  coreRuntime: AgentRuntime,
): AgentRuntimeLike {
  if (!bridgeRuntimeCache || bridgeRuntimeCoreRef !== coreRuntime) {
    bridgeRuntimeCache = createExternalBackendBridgeRuntime({
      coreRuntime,
      getBridgeUrl,
    });
    bridgeRuntimeCoreRef = coreRuntime;
  }
  return bridgeRuntimeCache;
}

export async function refreshClaudeSlashCommands(
  coreRuntime: AgentRuntime,
  force = false,
): Promise<void> {
  await getClaudeBridgeRuntime(coreRuntime).refreshSlashCommands(force);
}

export function listClaudeSlashCommands(
  coreRuntime: AgentRuntime,
): ClaudeSlashCommandDescriptor[] {
  return getClaudeBridgeRuntime(coreRuntime).listSlashCommandsSync();
}

export async function listClaudeEfforts(
  coreRuntime: AgentRuntime,
  model?: string,
  context?: ClaudeModelCatalogRequestContext,
): Promise<string[]> {
  return getClaudeBridgeRuntime(coreRuntime).listEfforts(model, context);
}

export async function listClaudeModels(
  coreRuntime: AgentRuntime,
  force = false,
  context?: ClaudeModelCatalogRequestContext,
): Promise<ClaudeModelCatalog> {
  return getClaudeBridgeRuntime(coreRuntime).listModels(force, context);
}

export async function runClaudeTurn(
  coreRuntime: AgentRuntime,
  params: {
    request: AgentRuntimeRequest;
    onStart?: (runId: string) => void | Promise<void>;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    signal?: AbortSignal;
  },
): Promise<AgentRuntimeOutcome> {
  return getClaudeBridgeRuntime(coreRuntime).runTurn(params);
}

export async function updateClaudeRuntimeRetention(
  coreRuntime: AgentRuntime,
  params: {
    conversationKey: number;
    scope?: ClaudeBridgeScope | null;
    mountId: string;
    retain: boolean;
    probeId?: string;
  },
): Promise<boolean> {
  const bridgeUrl = getBridgeUrl();
  if (!bridgeUrl.trim()) return false;
  await getClaudeBridgeRuntime(coreRuntime).updateRuntimeRetention({
    conversationKey: params.conversationKey,
    scope: params.scope || undefined,
    mountId: params.mountId,
    retain: params.retain,
  });
  return true;
}

export async function invalidateAllClaudeHotRuntimes(
  coreRuntime: AgentRuntime,
): Promise<void> {
  const bridgeUrl = getBridgeUrl();
  if (!bridgeUrl.trim()) return;
  await getClaudeBridgeRuntime(coreRuntime).invalidateAllHotRuntimes();
}

type ClaudeConversationInvalidationParams = {
  conversationKey: number;
  scope?: ClaudeBridgeScope | null;
  metadata?: Record<string, unknown>;
};

export async function invalidateClaudeConversationSession(
  coreRuntime: AgentRuntime,
  params: ClaudeConversationInvalidationParams,
): Promise<void> {
  await withConversationWriteLock(params.conversationKey, () =>
    invalidateClaudeConversationSessionWithinWriteLock(coreRuntime, params),
  );
}

/** Caller must already hold the conversation write lock. */
export async function invalidateClaudeConversationSessionWithinWriteLock(
  coreRuntime: AgentRuntime,
  params: ClaudeConversationInvalidationParams,
): Promise<void> {
  const bridgeUrl = getBridgeUrl();
  const expectedInstanceID =
    params.metadata && typeof params.metadata.instanceID === "string"
      ? params.metadata.instanceID.trim()
      : "";
  const expectedProviderSessionId =
    params.metadata && typeof params.metadata.providerSessionId === "string"
      ? params.metadata.providerSessionId.trim()
      : "";
  // An empty-session cleanup job is a scope/instance witness for the session
  // that existed before deletion.  Serialize the witness check with runtime
  // metadata persistence so a replacement turn cannot win between the read
  // and adapter invalidation.
  if (!expectedProviderSessionId && expectedInstanceID) {
    const current = await getClaudeConversationSummary(params.conversationKey);
    if (String(current?.providerSessionId || "").trim()) return;
    // A delayed empty-session cleanup witness must never
    // wildcard-invalidate a catalog instance that still has live turns.
    // The turn's own start path will force a fresh provider session when a
    // durable cleanup job is still pending.
    if (Number(current?.userTurnCount || 0) > 0) return;
  }
  forgetClaudeConversationScope(
    params.conversationKey,
    expectedInstanceID || undefined,
  );
  await clearClaudeConversationSessionMetadata(
    params.conversationKey,
    expectedProviderSessionId || undefined,
    expectedInstanceID || undefined,
  );
  if (!bridgeUrl.trim()) return;
  await getClaudeBridgeRuntime(coreRuntime).invalidateSessionWithinWriteLock({
    conversationKey: params.conversationKey,
    scope: params.scope || undefined,
    metadata: params.metadata,
  });
}

export async function fetchClaudeSessionInfo(
  conversationKey: number,
  scope?: ClaudeBridgeScope | null,
): Promise<ClaudeBridgeSessionInfo | null> {
  const baseUrl = getBridgeUrl();
  if (!baseUrl.trim()) return null;
  const rememberedScope =
    scope || getRememberedClaudeConversationScope(conversationKey);
  return fetchExternalBridgeSessionInfo({
    baseUrl,
    conversationKey,
    scopeType: rememberedScope?.scopeType,
    scopeId: rememberedScope?.scopeId,
    scopeLabel: rememberedScope?.scopeLabel,
  });
}

export async function listClaudeConversationsForScope(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  limit?: number;
}): Promise<ClaudeConversationSummary[]> {
  return params.kind === "paper"
    ? listClaudePaperConversations(
        params.libraryID,
        params.paperItemID || 0,
        params.limit,
      )
    : listClaudeGlobalConversations(params.libraryID, params.limit);
}

export async function ensureClaudeConversationForScope(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
}): Promise<ClaudeConversationSummary | null> {
  const summary =
    params.kind === "paper"
      ? await ensureClaudePaperConversation(
          params.libraryID,
          params.paperItemID || 0,
        )
      : await ensureClaudeGlobalConversation(params.libraryID);
  if (!summary) return null;
  rememberClaudeConversationSelection(summary);
  return summary;
}

export async function createClaudeConversationForScope(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
}): Promise<ClaudeConversationSummary | null> {
  const summary =
    params.kind === "paper"
      ? await createClaudePaperConversation(
          params.libraryID,
          params.paperItemID || 0,
        )
      : await createClaudeGlobalConversation(params.libraryID);
  if (!summary) return null;
  rememberClaudeConversationSelection(summary);
  return summary;
}

export async function loadClaudeConversationMessages(
  conversationKey: number,
): Promise<StoredChatMessage[]> {
  return loadClaudeConversation(conversationKey);
}

export async function appendClaudeConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
  instanceID?: string,
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    appendClaudeConversationMessageWithinWriteLock(
      conversationKey,
      message,
      instanceID,
    ),
  );
}

/** Caller must already hold the conversation write lock. */
export async function appendClaudeConversationMessageWithinWriteLock(
  conversationKey: number,
  message: StoredChatMessage,
  instanceID?: string,
): Promise<void> {
  await appendClaudeMessage(conversationKey, message, instanceID);
  await pruneClaudeConversation(conversationKey);
  await touchClaudeConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
    model: message.modelName,
    instanceID,
  });
}

export async function updateLatestClaudeConversationUserMessage(
  conversationKey: number,
  message: Parameters<typeof updateLatestClaudeUserMessage>[1],
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    updateLatestClaudeConversationUserMessageWithinWriteLock(
      conversationKey,
      message,
    ),
  );
}

/** Caller must already hold the conversation write lock. */
export async function updateLatestClaudeConversationUserMessageWithinWriteLock(
  conversationKey: number,
  message: Parameters<typeof updateLatestClaudeUserMessage>[1],
): Promise<void> {
  await updateLatestClaudeUserMessage(conversationKey, message);
  await touchClaudeConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
  });
}

export async function updateLatestClaudeConversationAssistantMessage(
  conversationKey: number,
  message: Parameters<typeof updateLatestClaudeAssistantMessage>[1],
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    updateLatestClaudeConversationAssistantMessageWithinWriteLock(
      conversationKey,
      message,
    ),
  );
}

/** Caller must already hold the conversation write lock. */
export async function updateLatestClaudeConversationAssistantMessageWithinWriteLock(
  conversationKey: number,
  message: Parameters<typeof updateLatestClaudeAssistantMessage>[1],
): Promise<void> {
  await updateLatestClaudeAssistantMessage(conversationKey, message);
  await touchClaudeConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
    model: message.modelName,
  });
}

export async function deleteClaudeConversationTurnMessages(
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
): Promise<void> {
  await withConversationWriteLock(conversationKey, async () => {
    await deleteClaudeConversationTurnMessagesStore(
      conversationKey,
      userTimestamp,
      assistantTimestamp,
    );
    await touchClaudeConversationWithinWriteLock(conversationKey, {
      updatedAt: Date.now(),
    });
  });
}

type ClaudeConversationTouchUpdates = {
  title?: string | null;
  updatedAt?: number;
  providerSessionId?: string | null;
  scopedConversationKey?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  scopeLabel?: string | null;
  cwd?: string | null;
  model?: string | null;
  effort?: string | null;
  instanceID?: string;
  expectedGeneration?: number;
};

/** Caller must already hold the conversation write lock. */
export async function touchClaudeConversationWithinWriteLock(
  conversationKey: number,
  updates: ClaudeConversationTouchUpdates,
): Promise<void> {
  const expectedGeneration =
    updates.expectedGeneration ??
    getConversationWriteGeneration(conversationKey);
  if (
    areConversationWritesFrozen(conversationKey) ||
    !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
  ) {
    return;
  }
  const summary = await getClaudeConversationSummary(conversationKey);
  if (!summary) return;
  const hasOwn = (key: string) =>
    Object.prototype.hasOwnProperty.call(updates, key);
  if (
    updates.instanceID &&
    summary.instanceID &&
    updates.instanceID !== summary.instanceID
  ) {
    return;
  }
  await upsertClaudeConversationSummary({
    conversationKey: summary.conversationKey,
    instanceID: summary.instanceID,
    libraryID: summary.libraryID,
    kind: summary.kind,
    paperItemID: summary.paperItemID,
    createdAt: summary.createdAt,
    updatedAt: updates.updatedAt || Date.now(),
    title: hasOwn("title") ? updates.title || undefined : summary.title,
    providerSessionId: hasOwn("providerSessionId")
      ? updates.providerSessionId || undefined
      : summary.providerSessionId,
    scopedConversationKey: hasOwn("scopedConversationKey")
      ? updates.scopedConversationKey || undefined
      : summary.scopedConversationKey,
    scopeType: hasOwn("scopeType")
      ? updates.scopeType || undefined
      : summary.scopeType,
    scopeId: hasOwn("scopeId") ? updates.scopeId || undefined : summary.scopeId,
    scopeLabel: hasOwn("scopeLabel")
      ? updates.scopeLabel || undefined
      : summary.scopeLabel,
    cwd: hasOwn("cwd") ? updates.cwd || undefined : summary.cwd,
    model: hasOwn("model") ? updates.model || undefined : summary.model,
    effort: hasOwn("effort") ? updates.effort || undefined : summary.effort,
  });
}

export async function touchClaudeConversation(
  conversationKey: number,
  updates: ClaudeConversationTouchUpdates,
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    touchClaudeConversationWithinWriteLock(conversationKey, updates),
  );
}

export async function captureClaudeSessionInfo(
  conversationKey: number,
  scope?: ClaudeBridgeScope | null,
  expectedGeneration = getConversationWriteGeneration(conversationKey),
): Promise<ClaudeBridgeSessionInfo | null> {
  const before = await getClaudeConversationSummary(conversationKey);
  if (!before) return null;
  const session = await fetchClaudeSessionInfo(conversationKey, scope);
  if (!session) return null;
  if (
    areConversationWritesFrozen(conversationKey) ||
    !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
  ) {
    return session;
  }
  const current = await getClaudeConversationSummary(conversationKey);
  if (
    !current ||
    current.instanceID !== before.instanceID ||
    current.providerSessionId !== before.providerSessionId
  ) {
    return session;
  }
  await touchClaudeConversation(conversationKey, {
    providerSessionId: session.providerSessionId,
    scopedConversationKey: session.scopedConversationKey,
    scopeType: session.scopeType,
    scopeId: session.scopeId,
    scopeLabel: session.scopeLabel,
    cwd: session.cwd,
    updatedAt: Date.now(),
    instanceID: before.instanceID,
    expectedGeneration,
  });
  return session;
}

export function rememberClaudeConversationSelection(
  summary: Pick<
    ClaudeConversationSummary,
    "libraryID" | "kind" | "paperItemID" | "conversationKey"
  >,
): void {
  if (summary.kind === "paper" && summary.paperItemID) {
    const paperKey = buildClaudePaperStateKey(
      summary.libraryID,
      summary.paperItemID,
    );
    activeClaudePaperConversationByPaper.set(paperKey, summary.conversationKey);
    setLastUsedClaudePaperConversationKey(
      summary.libraryID,
      summary.paperItemID,
      summary.conversationKey,
    );
    return;
  }
  const libraryKey = buildClaudeLibraryStateKey(summary.libraryID);
  activeClaudeGlobalConversationByLibrary.set(
    libraryKey,
    summary.conversationKey,
  );
  setLastUsedClaudeGlobalConversationKey(
    summary.libraryID,
    summary.conversationKey,
  );
}

export function resolveRememberedClaudeConversationKey(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
}): number | null {
  if (params.kind === "paper" && params.paperItemID) {
    const stateKey = buildClaudePaperStateKey(
      params.libraryID,
      params.paperItemID,
    );
    return (
      activeClaudePaperConversationByPaper.get(stateKey) ||
      getLastUsedClaudePaperConversationKey(
        params.libraryID,
        params.paperItemID,
      ) ||
      null
    );
  }
  const libraryKey = buildClaudeLibraryStateKey(params.libraryID);
  return (
    activeClaudeGlobalConversationByLibrary.get(libraryKey) ||
    getLastUsedClaudeGlobalConversationKey(params.libraryID) ||
    null
  );
}

export function syncClaudeConversationMetadata(params: {
  conversationKey: number;
  kind: ClaudeConversationKind;
  libraryID: number;
  paperItemID?: number;
  title?: string;
  scope?: ClaudeBridgeScope | null;
  instanceID?: string;
}): void {
  rememberClaudeConversationSelection({
    conversationKey: params.conversationKey,
    kind: params.kind,
    libraryID: params.libraryID,
    paperItemID: params.paperItemID,
  });
  if (params.scope) {
    rememberClaudeConversationScope(
      params.conversationKey,
      params.scope,
      params.instanceID,
    );
  }
  void upsertClaudeConversationSummary({
    conversationKey: params.conversationKey,
    instanceID: params.instanceID,
    libraryID: params.libraryID,
    kind: params.kind,
    paperItemID: params.paperItemID,
    title: params.title,
    updatedAt: Date.now(),
    scopeType: params.scope?.scopeType,
    scopeId: params.scope?.scopeId,
    scopeLabel: params.scope?.scopeLabel,
  }).catch((error) => {
    dbg("failed to sync claude conversation metadata", {
      conversationKey: params.conversationKey,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function resolveClaudeSystemLabel(): string {
  return "Claude Code";
}

export function isClaudeRuntimeModel(
  model: string,
): model is ClaudeRuntimeModel {
  return Boolean(model.trim());
}

export function isClaudeReasoningMode(
  mode: string,
): mode is ClaudeReasoningMode {
  return CLAUDE_REASONING_OPTIONS.includes(mode as ClaudeReasoningMode);
}
