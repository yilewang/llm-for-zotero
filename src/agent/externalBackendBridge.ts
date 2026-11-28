import { fnv1a32Raw } from "../utils/fnv1a";
import { appLogger } from "../core/logging";
import {
  hasRuntimeHistory,
  selectRuntimeHistory,
} from "./context/runtimeHistory";
import { createClaudeTurnStageTracker } from "./claudeTurnStages";
import { config } from "../../package.json";
import {
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_PAPER_CONTEXTS,
} from "../shared/contextLimits";
import { getConversationSystemPref } from "../shared/conversationSystemPrefs";
import {
  getClaudeBridgeUrl,
  getClaudeSettingSourcesCsvByPref,
} from "../claudeCode/prefs";
import {
  fetchClaudeModelCatalog,
  type ClaudeModelCatalog,
  type ClaudeModelCatalogRequestContext,
} from "../claudeCode/modelCatalog";
import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  claudeBridgeFetch,
  isManagedClaudeBridgeActive,
  isManagedClaudeBridgeIdle,
} from "../claudeCode/bridgeProcess";
import { buildScopedConversationKey } from "../shared/conversationScopedKey";
import { getClaudeConversationSummary } from "../claudeCode/store";
import { hasPendingEmptyClaudeCleanupJob } from "../core/conversations/conversationCleanupJobs";
import type { ClaudePermissionMode } from "../shared/claudePermissionMode";
import type { ConversationSystem } from "../shared/types";
import { getClaudePermissionModePref } from "../claudeCode/prefs";
import {
  buildClaudeZoteroMcpServerConfig,
  REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES,
  REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
} from "../codexAppServer/mcpSetup";
import { dbg, dbgError } from "../utils/debugLogger";
import {
  externalRuntimeCommandEffect,
  externalRuntimeFileEffect,
  recordExternalRuntimeEffect,
  type ExternalRuntimeEffect,
} from "./contracts/externalRuntimeEffects";
import type { AgentRuntime } from "./runtime";
import {
  resolveConversationScopeToken,
  type ZoteroMcpActiveScope,
} from "./mcp/server";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import {
  makeProfilingEvent,
  renderExternalRuntimePrompt,
  requestLocalDocuments,
  requestPaperRefs,
  runExternalRuntimeTurn,
  type ExternalRunTurnParams,
  type ExternalRuntimeTransport,
  type ResolvedExternalRunTurnParams,
} from "./externalRuntimeTurnHost";
import { buildAgentModelCapabilities } from "./model/contentCapabilities";
import type {
  ActionConfirmationMode,
  ActionProgressEvent,
  ActionResult,
} from "./actions/types";
import type { AgentConfirmationResolution, AgentPendingAction } from "./types";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
} from "./types";
import type {
  LocalDocumentResource,
  PaperContentSourceMode,
  PaperContextRef,
} from "../shared/types";
import {
  normalizeExcludedItemIds,
  synthesizeSelectedTextContexts,
  normalizePaperContentSourceMode,
} from "../services/context/normalizers";
import { formatSelectedTextLocator } from "../services/context/selectedTextAnchorFormatting";
import { resolveTurnUserRequestText } from "./context/turnMaterial";
import {
  getActiveTurnPaper,
  getSelectedPassagePaper,
} from "./context/turnPaperScope";
import { resolveAgentPromptBudgetLimits } from "./context/promptBudget";
import {
  renderAgentPastChatMessageText,
  type PastConversationSource,
} from "../services/pastConversations/pastConversationLoader";
import {
  isSlashCommandText,
  normalizeAttachedConversationScope,
} from "../services/pastConversations/pastConversationText";
import { LocalDocumentPathStreamRedactor } from "./privacy/localDocumentPathRedaction";
import { positiveIntOrUndefined, trimmedStringOrNull } from "../core/values";

export type RunTurnParams = ExternalRunTurnParams;

type ResolvedRunTurnParams = ResolvedExternalRunTurnParams;

type ResolveExternalConfirmation = (
  requestId: string,
  resolution: AgentConfirmationResolution,
) => Promise<{
  ok: boolean;
  requestId: string;
  httpStatus: number;
  accepted: boolean;
  source?: string;
  pendingPermissionCount?: number;
  recentPendingRequestIds?: string[];
  errorMessage?: string;
}>;

type SessionInvalidationParams = {
  conversationKey: number;
  scope?: BridgeScope;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeLike = Pick<
  AgentRuntime,
  | "listTools"
  | "getToolDefinition"
  | "unregisterTool"
  | "registerTool"
  | "prepareExecutionRequest"
  | "registerPendingConfirmation"
  | "resolveConfirmation"
  | "getRunTrace"
> & {
  getCapabilities(
    request: AgentRuntimeRequestInput,
    options?: ClaudeBridgeGateOptions,
  ): AgentModelCapabilities;
  runTurn(params: RunTurnParams): Promise<AgentRuntimeOutcome>;
  listExternalActionsSync(options?: ClaudeBridgeGateOptions): Array<{
    name: string;
    description: string;
    inputSchema: object;
    source: "backend";
    backendToolName: string;
    riskLevel: "low" | "medium" | "high";
    requiresConfirmation: boolean;
    mutability: "read" | "write";
  }>;
  refreshExternalActions(force?: boolean): Promise<void>;
  listSlashCommandsSync(options?: ClaudeBridgeGateOptions): Array<{
    name: string;
    description: string;
    argumentHint?: string;
    source: "sdk" | "fallback";
  }>;
  refreshSlashCommands(force?: boolean): Promise<void>;
  listEfforts(
    model?: string,
    context?: ClaudeModelCatalogRequestContext,
    options?: ClaudeBridgeGateOptions,
  ): Promise<string[]>;
  listModels(
    force?: boolean,
    context?: ClaudeModelCatalogRequestContext,
    options?: ClaudeBridgeGateOptions,
  ): Promise<ClaudeModelCatalog>;
  updateRuntimeRetention(params: {
    conversationKey: number;
    scope?: BridgeScope;
    mountId: string;
    retain: boolean;
    probeId?: string;
    providerSessionId?: string;
  }): Promise<RuntimeRetentionResponse | null>;
  invalidateSession(
    params: SessionInvalidationParams,
  ): Promise<SessionInvalidationResponse | null>;
  /** Caller must already hold the conversation write lock. */
  invalidateSessionWithinWriteLock(
    params: SessionInvalidationParams,
  ): Promise<SessionInvalidationResponse | null>;
  invalidateAllHotRuntimes(): Promise<{ invalidated: boolean } | null>;
  runExternalAction(
    name: string,
    input: unknown,
    opts?: {
      conversationKey?: number;
      libraryID?: number;
      confirmationMode?: ActionConfirmationMode;
      onProgress?: (event: ActionProgressEvent) => void;
      requestConfirmation?: (
        requestId: string,
        action: AgentPendingAction,
      ) => Promise<AgentConfirmationResolution>;
    },
  ): Promise<ActionResult<unknown>>;
};

/**
 * What the bridge server streams as a turn's outcome: Claude answered or
 * fell back. A stop or a failure arrives as an error line instead, and the
 * bridge runtime turns it into a cancelled or failed outcome.
 */
type BridgeTurnOutcome = Extract<
  AgentRuntimeOutcome,
  { kind: "completed" | "fallback" }
>;

type BridgeLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "outcome"; outcome: BridgeTurnOutcome }
  | { type: "error"; error: string };

type ToolMutability = "read" | "write";
type ToolRiskLevel = "low" | "medium" | "high";
type ToolSource = "claude-runtime" | "zotero-bridge" | "mcp";

type ExternalToolDescriptor = {
  name: string;
  description: string;
  inputSchema: object;
  mutability: ToolMutability;
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  source: ToolSource;
};

type ExternalSlashCommandDescriptor = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "fallback";
};

type ExternalEffortInfo = {
  efforts: string[];
  expiresAt?: number;
};

type RuntimeRetentionResponse = {
  originalConversationKey: string;
  scopedConversationKey: string;
  retained: boolean;
};

type SessionInvalidationResponse = {
  originalConversationKey: string;
  scopedConversationKey: string;
  invalidated: boolean;
};

const EXTERNAL_ACTION_PREFIX = "cc_tool::";

/** Distinguishes two provider actions dispatched within the same millisecond. */
let externalActionSequence = 0;

type ContextEnvelope = {
  activeItemId?: number;
  libraryID?: number;
  selectedTextCount: number;
  selectedPaperCount: number;
  selectedCollectionCount: number;
  selectedTagCount: number;
  fullTextPaperCount: number;
  pinnedPaperCount: number;
  attachmentCount: number;
  screenshotCount: number;
  selectedTexts: Array<{
    source: string;
    text: string;
    /** The user's question attached to this selected text, when any. */
    userQuery?: string;
    locator?: string;
    localContext?: string;
    noteContext?: {
      noteItemId?: number;
      title: string;
      noteKind: string;
      parentItemId?: number;
    };
  }>;
  selectedPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }>;
  selectedCollections: Array<{
    collectionId: number;
    name: string;
    libraryID: number;
  }>;
  selectedTags: Array<{
    name: string;
    libraryID: number;
    normalizedName?: string;
    scope?: "allTagged" | "untagged";
    includeAutomatic?: boolean;
  }>;
  fullTextPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
  }>;
  pinnedPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
  }>;
  attachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    category: string;
    sizeBytes: number;
  }>;
  activeNote?: {
    noteId: number;
    noteKind: string;
    title: string;
    parentItemId?: number;
    preview: string;
  };
};

type BridgeAttachment = {
  id: string;
  name: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  storedPath?: string;
  contentHash?: string;
};

type BridgePaperContext = {
  itemId?: number;
  contextItemId?: number;
  title?: string;
  attachmentTitle?: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  contentSourceMode?: PaperContentSourceMode;
  mineruCacheDir?: string;
  mineruFullMdPath?: string;
  contextFilePath?: string;
};

type BridgeScopeType =
  | "paper"
  | "open"
  | "folder"
  | "tag"
  | "tagset"
  | "custom";

export type BridgeScopeSnapshot = {
  scopeType: BridgeScopeType;
  scopeId: string;
  scopeLabel?: string;
};
type BridgeScope = BridgeScopeSnapshot;
type ClaudeMcpServersConfig = Record<string, Record<string, unknown>>;

function hashProviderIdentityStack(stack: string[]): string {
  return `fnv1a-${fnv1a32Raw(stack.join("\n")).toString(16)}`;
}

async function buildClaudeProviderIdentityStack(): Promise<string[]> {
  const sources = getClaudeSettingSourcesByPref();
  const configSource = getClaudeConfigSourcePref();
  const bridgeUrl = normalizeBaseUrl(getClaudeBridgeUrl());
  const profileSignature = getClaudeProfileSignature();
  return [
    `profile:${profileSignature}`,
    `configSource:${configSource}`,
    `settingSources:${sources.join(",")}`,
    `bridgeUrl:${bridgeUrl}`,
  ];
}

export type LastRunBridgeContext = {
  conversationKey: number;
  scope: BridgeScopeSnapshot;
  updatedAt: number;
};

export type ExternalBridgeSessionInfo = {
  originalConversationKey: string;
  scopedConversationKey: string;
  providerSessionId?: string;
  scopeType?: BridgeScopeType;
  scopeId?: string;
  scopeLabel?: string;
  runtimeCwdRelative?: string;
  cwd?: string;
};

type BridgeRuntimeRequest = {
  conversationKey: number;
  userText: string;
  activeItemId?: number;
  libraryID?: number;
  model?: string;
  apiBase?: string;
  authMode?: string;
  providerProtocol?: string;
  executionContext?: AgentRuntimeRequest["executionContext"];
  /**
   * The Zotero context and the material the user attached (the open note,
   * the selected passages), rendered as the original agent's prompt states
   * them; the bridge places it before the user's words.
   */
  turnContext?: string;
  selectedPaperContexts?: BridgePaperContext[];
  fullTextPaperContexts?: BridgePaperContext[];
  pinnedPaperContexts?: BridgePaperContext[];
  localDocuments?: readonly LocalDocumentResource[];
  attachments?: BridgeAttachment[];
  screenshots?: string[];
  history?: Array<{ role: string; content: string }>;
  /** Earlier messages left out of `history` by its budget. */
  historyOmitted?: number;
  /** With `historyOmitted`: the chat id past_chat_read opens to read them. */
  historyChatId?: string;
};

const lastRunBridgeContextByConversationKey = new Map<
  number,
  LastRunBridgeContext
>();

function isBridgeDebugEnabled(): boolean {
  return false;
}

async function resolveClaudeProviderSessionHint(
  conversationKey: number,
  scope?: BridgeScope,
): Promise<string | undefined> {
  const summary = await getClaudeConversationSummary(conversationKey).catch(
    () => null,
  );
  const providerSessionId = summary?.providerSessionId?.trim();
  if (!summary || !providerSessionId) return undefined;
  const expectedScopedConversationKey = buildScopedConversationKey(
    conversationKey,
    scope,
  );
  if (
    summary.scopedConversationKey &&
    summary.scopedConversationKey !== expectedScopedConversationKey
  ) {
    return undefined;
  }
  if (scope) {
    if (
      summary.scopeType !== scope.scopeType ||
      summary.scopeId !== scope.scopeId
    ) {
      return undefined;
    }
  } else if (summary.scopeType || summary.scopeId) {
    return undefined;
  }
  return providerSessionId;
}

function getBridgeHealthUrl(baseUrl?: string): string {
  const normalized = normalizeBaseUrl(baseUrl || "");
  return `${normalized || "http://127.0.0.1:19787"}/healthz`;
}

function supportsClaudeBridgeLocalPdfPaths(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return (
    record.ok === true &&
    Number(record.protocolVersion) >= 2 &&
    Array.isArray(record.capabilities) &&
    record.capabilities.includes("local_pdf_paths")
  );
}

async function assertClaudeBridgeLocalPdfCapability(
  baseUrl: string,
): Promise<void> {
  const response = await claudeBridgeFetch(getBridgeHealthUrl(baseUrl));
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!supportsClaudeBridgeLocalPdfPaths(payload)) {
    throw new Error(
      "Claude bridge does not support raw local PDF paths. Update and restart the Claude bridge.",
    );
  }
}

export async function preflightClaudeBridgeLocalPdfCapability(): Promise<void> {
  const bridgeUrl = normalizeBaseUrl(getClaudeBridgeUrl());
  if (!bridgeUrl) {
    throw new Error("Claude bridge URL is empty.");
  }
  await assertClaudeBridgeLocalPdfCapability(bridgeUrl);
}

export function getBridgeQuickFixHint(baseUrl?: string): string {
  if (isManagedClaudeBridgeActive()) {
    return "Open the plugin settings, Claude Code section, to see the bridge status and log, or press Restart bridge.";
  }
  const healthUrl = getBridgeHealthUrl(baseUrl);
  return `Your own Claude Code bridge is not answering. Check that it is running and that the Bridge URL matches it: curl -fsS ${healthUrl}`;
}

function formatBridgeUserError(
  error: unknown,
  baseUrl: string,
  context: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = getBridgeQuickFixHint(baseUrl);
  if (/Bridge HTTP \d+/i.test(message)) {
    return `${context}: ${message}. Check Bridge URL and health endpoint. ${hint}`;
  }
  if (
    /(fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted)/i.test(
      message,
    )
  ) {
    return `${context}: ${hint}`;
  }
  return `${context}: ${message}. ${hint}`;
}

function getLastRunBridgeContext(
  conversationKey: number,
): LastRunBridgeContext | undefined {
  return lastRunBridgeContextByConversationKey.get(Math.floor(conversationKey));
}

function rememberLastRunBridgeContext(
  conversationKey: number,
  scope: BridgeScope,
): void {
  const normalizedConversationKey = Math.floor(conversationKey);
  if (!Number.isFinite(normalizedConversationKey)) return;
  lastRunBridgeContextByConversationKey.set(normalizedConversationKey, {
    conversationKey: normalizedConversationKey,
    scope: {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
    },
    updatedAt: Date.now(),
  });
}

function clearLastRunBridgeContext(conversationKey: number): void {
  const normalizedConversationKey = Math.floor(conversationKey);
  if (!Number.isFinite(normalizedConversationKey)) return;
  lastRunBridgeContextByConversationKey.delete(normalizedConversationKey);
}

function getClaudeConfigSourcePref(): "default" | "user-only" | "zotero-only" {
  try {
    const raw = String(
      Zotero.Prefs.get(`${config.prefsPrefix}.agentClaudeConfigSource`, true) ||
        "",
    )
      .trim()
      .toLowerCase();
    if (raw === "user-level" || raw === "user-only") return "user-only";
    if (raw === "zotero-specific" || raw === "zotero-only")
      return "zotero-only";
    return "default";
  } catch {
    return "default";
  }
}

function getClaudeSettingSourcesByPref(): Array<"user" | "project" | "local"> {
  const source = getClaudeConfigSourcePref();
  if (source === "user-only") return ["user"];
  if (source === "zotero-only") return ["project", "local"];
  return ["user", "project", "local"];
}

function buildAgentPermissionMetadata(): {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: true;
} {
  const permissionMode = getClaudePermissionModePref();
  if (permissionMode === "bypassPermissions") {
    return {
      permissionMode,
      allowDangerouslySkipPermissions: true,
    };
  }
  return { permissionMode };
}

function isClaudeCodeModeEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get(
      `${config.prefsPrefix}.enableClaudeCodeMode`,
      true,
    );
    return enabled === true || `${enabled || ""}`.toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * Which conversation system a caller acts for. The standalone window and the
 * sidebar each have their own (surfaceChoices.ts), so callers acting for a
 * panel or a turn name it; only callers acting for no panel leave it out and
 * get the saved system.
 */
export type ClaudeBridgeGateOptions = {
  conversationSystem?: ConversationSystem | null;
};

function isClaudeBridgeActive(options?: ClaudeBridgeGateOptions): boolean {
  const system = options?.conversationSystem || getConversationSystemPref();
  return system === "claude_code" && isClaudeCodeModeEnabled();
}

export function resolveClaudeBridgeModelForMetadata(
  model: unknown,
): string | undefined {
  if (typeof model !== "string") return undefined;
  return model.trim() || undefined;
}

function normalizeScopeType(value: unknown): BridgeScopeType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "paper":
    case "open":
    case "folder":
    case "tag":
    case "tagset":
    case "custom":
      return normalized;
    default:
      return null;
  }
}

function resolvePaperScopeFromRequest(
  request: AgentRuntimeRequest,
): BridgeScope | null {
  const libraryID =
    typeof request.libraryID === "number" && Number.isFinite(request.libraryID)
      ? Math.floor(request.libraryID)
      : undefined;

  let paperItemId: number | undefined;
  const fromActiveItem =
    typeof request.activeItemId === "number" &&
    Number.isFinite(request.activeItemId)
      ? Math.floor(request.activeItemId)
      : undefined;
  if (fromActiveItem && fromActiveItem > 0) {
    const item = Zotero.Items.get(fromActiveItem);
    if (item?.isAttachment?.() && item.parentID) {
      paperItemId = Math.floor(item.parentID);
    } else if (item?.isRegularItem?.()) {
      paperItemId = Math.floor(item.id);
    }
  }

  if (!paperItemId || paperItemId <= 0) {
    const allRefs = request.turnPaperScope.papers.map((entry) => entry.paper);
    const firstRef = allRefs.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.itemId === "number" &&
        Number.isFinite(entry.itemId),
    );
    if (firstRef?.itemId) {
      paperItemId = Math.floor(firstRef.itemId);
    }
  }

  if (!paperItemId || paperItemId <= 0) {
    return null;
  }

  const titleItem = Zotero?.Items?.get?.(paperItemId);
  const scopedPaperTitle = request.turnPaperScope.papers.find(
    (entry) => entry.paper.itemId === paperItemId,
  )?.paper.title;
  const scopeLabel =
    titleItem?.isRegularItem?.() && typeof titleItem.getField === "function"
      ? String(titleItem.getField("title") || "").trim() || undefined
      : scopedPaperTitle;

  const scopeId = `${getClaudeProfileSignature()}:${libraryID ?? 0}:${paperItemId}`;
  return { scopeType: "paper", scopeId, scopeLabel };
}

function resolveBridgeScope(request: AgentRuntimeRequest): BridgeScope {
  const profileSignature = getClaudeProfileSignature();
  const explicitType = normalizeScopeType(
    (request as unknown as { scopeType?: unknown }).scopeType,
  );
  const explicitId = trimmedStringOrNull(
    (request as unknown as { scopeId?: unknown }).scopeId,
  );
  const explicitLabel =
    typeof (request as unknown as { scopeLabel?: unknown }).scopeLabel ===
    "string"
      ? String(
          (request as unknown as { scopeLabel?: unknown }).scopeLabel,
        ).trim() || undefined
      : undefined;
  if (explicitType && explicitId) {
    return {
      scopeType: explicitType,
      scopeId: explicitId,
      scopeLabel: explicitLabel,
    };
  }

  const paperScope = resolvePaperScopeFromRequest(request);
  if (paperScope) {
    return paperScope;
  }

  const libraryID =
    typeof request.libraryID === "number" && Number.isFinite(request.libraryID)
      ? Math.floor(request.libraryID)
      : 0;
  return {
    scopeType: "open",
    scopeId: `${profileSignature}:${libraryID}`,
    scopeLabel: "Open Chat",
  };
}

function parseLine(raw: string): BridgeLine | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as BridgeLine;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

async function updateExternalRuntimeRetention(params: {
  baseUrl: string;
  conversationKey: number;
  scope?: BridgeScope;
  mountId: string;
  retain: boolean;
  probeId?: string;
  providerSessionId?: string;
}): Promise<RuntimeRetentionResponse | null> {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) return null;
  // No managed bridge running means no warm session to keep or release.
  if (isManagedClaudeBridgeIdle(normalized)) return null;
  const response = await claudeBridgeFetch(`${normalized}/runtime-retention`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: params.conversationKey,
      providerSessionId: params.providerSessionId,
      scopeType: params.scope?.scopeType,
      scopeId: params.scope?.scopeId,
      scopeLabel: params.scope?.scopeLabel,
      mountId: params.mountId,
      retain: params.retain,
      probeId: params.probeId,
    }),
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  return (await response.json()) as unknown as RuntimeRetentionResponse;
}

async function invalidateExternalBridgeSession(params: {
  baseUrl: string;
  conversationKey: number;
  scope?: BridgeScope;
  metadata?: Record<string, unknown>;
}): Promise<SessionInvalidationResponse | null> {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) return null;
  const response = await claudeBridgeFetch(`${normalized}/invalidate-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: params.conversationKey,
      scopeType: params.scope?.scopeType,
      scopeId: params.scope?.scopeId,
      scopeLabel: params.scope?.scopeLabel,
      metadata: params.metadata,
    }),
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  return (await response.json()) as unknown as SessionInvalidationResponse;
}

function toExternalActionName(toolName: string): string {
  return `${EXTERNAL_ACTION_PREFIX}${toolName}`;
}

/**
 * Claude Code's own tools that change something outside the host.
 *
 * Only these need a receipt: everything else Claude Code runs here is a read,
 * and every Zotero effect arrives instead as an MCP tool call that already has
 * the full proposal, authorization, journal and verification path.
 */
const CLAUDE_RUNTIME_EFFECT_TOOLS: Readonly<
  Record<string, "file_write" | "command_execute">
> = {
  Write: "file_write",
  Edit: "file_write",
  MultiEdit: "file_write",
  NotebookEdit: "file_write",
  Bash: "command_execute",
};

const CLAUDE_RUNTIME_FILE_PATH_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
] as const;

/** The catalogued effect one of Claude Code's own tool calls performs. */
export function describeClaudeRuntimeToolEffect(
  toolName: string,
  input: unknown,
): ExternalRuntimeEffect | null {
  const operation = Object.prototype.hasOwnProperty.call(
    CLAUDE_RUNTIME_EFFECT_TOOLS,
    toolName,
  )
    ? CLAUDE_RUNTIME_EFFECT_TOOLS[toolName]
    : undefined;
  if (!operation) return null;
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (operation === "command_execute") {
    return externalRuntimeCommandEffect(
      "claude_code",
      typeof record.command === "string" ? record.command : "",
    );
  }
  const path = CLAUDE_RUNTIME_FILE_PATH_KEYS.map((key) => record[key]).find(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
  return externalRuntimeFileEffect("claude_code", path ? [path] : []);
}

function fromExternalActionName(actionName: string): string | null {
  if (!actionName.startsWith(EXTERNAL_ACTION_PREFIX)) return null;
  const tool = actionName.slice(EXTERNAL_ACTION_PREFIX.length).trim();
  return tool || null;
}

async function streamBridgeLines(
  response: Response,
  onLine: (line: BridgeLine) => void | Promise<void>,
): Promise<void> {
  if (!response.body) {
    const text = await response.text();
    for (const chunk of text.split("\n")) {
      const line = parseLine(chunk);
      if (line) await onLine(line);
    }
    return;
  }

  const reader = (response.body as any).getReader() as {
    read: () => Promise<{ done: boolean; value?: Uint8Array<ArrayBufferLike> }>;
  };
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = parseLine(rawLine);
      if (line) await onLine(line);
      idx = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode(new Uint8Array());
  if (buffer.trim()) {
    const line = parseLine(buffer);
    if (line) await onLine(line);
  }
}

/**
 * The text a Claude Code turn sends the bridge: the turn's past-chat block,
 * a blank line, then the user's text; the user's text alone when the turn
 * delivers no past chat (request.deliveredConversations) or is a slash
 * message. The block is the built-in agent's past-chat message, rendered
 * under the same memo key as the resume-fallback history
 * (agentMode/pastChatHistory.ts), so a later replay sends the same bytes.
 * The bridge needs no change: it reads userText as the prompt. A send from
 * an empty composer carries only the questions attached to the selections,
 * which the turn context already shows under each quote, so a short
 * instruction stands in for them (resolveTurnUserRequestText).
 *
 * request.userText itself stays unchanged, for the MCP scope and skill
 * routing. Never fails the turn.
 */
export async function buildExternalRuntimeUserText(
  request: AgentRuntimeRequest,
  source?: PastConversationSource,
): Promise<string> {
  const userText = resolveTurnUserRequestText(request) || "";
  const refs = normalizeAttachedConversationScope(
    request.deliveredConversations,
  );
  // A slash message goes to Claude Code's command handling as it is.
  if (!refs.length || isSlashCommandText(userText)) return userText;
  try {
    let contextWindowTokens: number | undefined;
    try {
      contextWindowTokens = resolveAgentPromptBudgetLimits({
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        outputTokenLimit: request.advanced?.outputTokenLimit,
      }).contextWindow;
    } catch {
      contextWindowTokens = undefined;
    }
    const block = await renderAgentPastChatMessageText({
      conversationKey: request.conversationKey,
      userMessageTimestamp: request.metadata?.sourceMessageTimestamp,
      refs,
      libraryID: request.libraryID,
      contextWindowTokens,
      source,
    });
    if (!block) return userText;
    // The fallback history applies the same redaction to the same text.
    const redacted = new LocalDocumentPathStreamRedactor(
      request.conversationKey,
    ).redactTerminalText(block);
    return `${redacted}\n\n${userText}`;
  } catch (error) {
    appLogger.warn(
      "Claude Code bridge: rendering the attached past chats failed",
      error,
    );
    return userText;
  }
}

async function runExternalBridgeTurn(
  baseUrl: string,
  params: ResolvedRunTurnParams & {
    pastConversationSource?: PastConversationSource;
    contextEnvelope?: ContextEnvelope;
    runtimeRequest?: BridgeRuntimeRequest;
    /** The prompt's standing blocks (renderExternalRuntimePrompt). */
    standingInstructions?: string;
    allowedTools?: string[];
    mcpServers?: ClaudeMcpServersConfig;
    scope?: BridgeScope;
    registerPendingConfirmation?: (
      requestId: string,
      resolve: (resolution: AgentConfirmationResolution) => void,
    ) => void;
    resolveExternalConfirmation?: ResolveExternalConfirmation;
  },
): Promise<BridgeTurnOutcome> {
  const url = `${normalizeBaseUrl(baseUrl)}/run-turn`;
  const reasoningLevel =
    typeof params.request.reasoning?.level === "string"
      ? params.request.reasoning.level
      : "";
  const claudeEffortLevel =
    typeof params.request.claudeEffortLevel === "string"
      ? params.request.claudeEffortLevel.trim().toLowerCase()
      : "";
  const effort =
    claudeEffortLevel === "max" ||
    claudeEffortLevel === "xhigh" ||
    claudeEffortLevel === "high" ||
    claudeEffortLevel === "medium" ||
    claudeEffortLevel === "low"
      ? claudeEffortLevel
      : reasoningLevel === "xhigh"
        ? "xhigh"
        : reasoningLevel === "high" ||
            reasoningLevel === "medium" ||
            reasoningLevel === "low"
          ? reasoningLevel
          : reasoningLevel === "default"
            ? "auto"
            : undefined;
  const debugModeEnabled = false;

  const probeRequested =
    debugModeEnabled && params.request.metadata?.testPermissionProbe === true;
  const userTextForBridge = await buildExternalRuntimeUserText(
    params.request,
    params.pastConversationSource,
  );

  const requestMetadata =
    params.request.metadata && typeof params.request.metadata === "object"
      ? params.request.metadata
      : undefined;
  const providerIdentityStack = await buildClaudeProviderIdentityStack();
  const providerIdentity = hashProviderIdentityStack(providerIdentityStack);
  const providerSessionIdHint = await resolveClaudeProviderSessionHint(
    params.request.conversationKey,
    params.scope,
  );
  const payload = {
    conversationKey: params.request.conversationKey,
    userText: userTextForBridge,
    providerSessionId: providerSessionIdHint,
    allowedTools: params.allowedTools,
    scopeType: params.scope?.scopeType,
    scopeId: params.scope?.scopeId,
    scopeLabel: params.scope?.scopeLabel,
    runtimeRequest: params.runtimeRequest,
    mcpServers: params.mcpServers,
    metadata: {
      ...requestMetadata,
      runType: "chat",
      claudeConfigSource: getClaudeConfigSourcePref(),
      claudeSettingSources: getClaudeSettingSourcesByPref(),
      settingSources: getClaudeSettingSourcesCsvByPref(),
      ...buildAgentPermissionMetadata(),
      customInstruction: params.standingInstructions,
      providerIdentity,
      providerIdentityStack,
      model: resolveClaudeBridgeModelForMetadata(params.request.model),
      effort,
      activeItemId: params.request.activeItemId,
      libraryID: params.request.libraryID,
      contextEnvelope: params.contextEnvelope,
      scopeType: params.scope?.scopeType,
      scopeId: params.scope?.scopeId,
      scopeLabel: params.scope?.scopeLabel,
      debugPermissionProbe: probeRequested,
    },
  };

  await params.onEvent?.(makeProfilingEvent("frontend.bridge_fetch.dispatch"));
  const response = await claudeBridgeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }

  let finalOutcome: BridgeTurnOutcome | null = null;
  let sawFirstBridgeLine = false;

  await streamBridgeLines(response, async (line) => {
    if (!sawFirstBridgeLine) {
      sawFirstBridgeLine = true;
      await params.onEvent?.(
        makeProfilingEvent("frontend.bridge_stream.first_line"),
      );
    }
    if (line.type === "start") {
      await params.onStart?.(line.runId);
      return;
    }
    if (line.type === "event") {
      if (
        line.event.type === "confirmation_required" &&
        params.registerPendingConfirmation &&
        params.resolveExternalConfirmation
      ) {
        const requestId = line.event.requestId;
        const registerResolver = () => {
          params.registerPendingConfirmation?.(requestId, (resolution) => {
            const syncConfirmation = async (attempt = 0): Promise<void> => {
              try {
                const result = await params.resolveExternalConfirmation?.(
                  requestId,
                  resolution,
                );
                if (!result) return;
                if (debugModeEnabled) {
                  await params.onEvent?.({
                    type: "status",
                    text:
                      `confirmation_sync ${result.requestId} http=${result.httpStatus} accepted=${result.accepted}` +
                      (result.errorMessage
                        ? ` error=${result.errorMessage}`
                        : ""),
                  });
                  await params.onEvent?.({
                    type: "status",
                    text: `confirm ${result.requestId} -> POST /resolve-confirmation -> HTTP ${result.httpStatus} -> accepted=${result.accepted}`,
                  });
                }
                if (!result.ok || !result.accepted) {
                  if (attempt < 2) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, 150 * (attempt + 1)),
                    );
                    await syncConfirmation(attempt + 1);
                    return;
                  }
                  await params.onEvent?.({
                    type: "status",
                    text: `Confirmation sync failed for ${requestId}: ${result.errorMessage || "not accepted by backend"}`,
                  });
                  // Re-register so the user can retry approval instead of getting stuck.
                  registerResolver();
                  return;
                }
                // External bridges may not emit confirmation_resolved events.
                // Emit one locally after a successful sync so pending-card UI
                // advances and older pending confirmations can surface.
                await params.onEvent?.({
                  type: "confirmation_resolved",
                  requestId: result.requestId,
                  approved: Boolean(resolution.approved),
                  actionId: resolution.actionId,
                  data: resolution.data,
                });
              } catch (error) {
                if (attempt < 2) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, 150 * (attempt + 1)),
                  );
                  await syncConfirmation(attempt + 1);
                  return;
                }
                await params.onEvent?.({
                  type: "status",
                  text: `Confirmation sync failed for ${requestId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                });
                // Re-register so the user can retry approval instead of getting stuck.
                registerResolver();
              }
            };
            void syncConfirmation();
          });
        };
        registerResolver();
      }
      await params.onEvent?.(line.event);
      return;
    }
    if (line.type === "outcome") {
      finalOutcome = line.outcome;
      return;
    }
    if (line.type === "error") {
      throw new Error(line.error || "Bridge stream error");
    }
  });

  if (!finalOutcome) {
    return {
      kind: "fallback",
      runId: `bridge-${Date.now()}`,
      reason: "Bridge ended without outcome",
      usedFallback: true,
    };
  }

  return finalOutcome;
}

function trimText(value: unknown, max = 360): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function resolveLibraryName(libraryID: number | undefined): string | undefined {
  if (!libraryID) return undefined;
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          userLibraryID?: number;
          getName?: (libraryID: number) => string;
          get?: (libraryID: number) => { name?: string } | null | undefined;
        };
      }
    ).Libraries;
    const directName = libraries?.getName?.(libraryID);
    if (typeof directName === "string" && directName.trim()) {
      return directName.trim();
    }
    const library = libraries?.get?.(libraryID);
    if (typeof library?.name === "string" && library.name.trim()) {
      return library.name.trim();
    }
    return libraries?.userLibraryID === libraryID ? "My Library" : undefined;
  } catch {
    return undefined;
  }
}

function resolveFallbackLibraryId(
  request: AgentRuntimeRequest,
): number | undefined {
  const selectedCollectionLibraryId = normalizeCollectionRefs(
    request.turnPaperScope.collections,
    1,
  )[0]?.libraryID;
  const selectedTagLibraryId = normalizeTagRefs(
    request.turnPaperScope.tags,
    1,
  )[0]?.libraryID;
  const userLibraryId = positiveIntOrUndefined(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
  return (
    positiveIntOrUndefined(request.libraryID) ||
    positiveIntOrUndefined(request.item?.libraryID) ||
    selectedCollectionLibraryId ||
    selectedTagLibraryId ||
    userLibraryId
  );
}

/**
 * Resolves the scope header token for a bridge turn.
 *
 * The adapter binds the MCP scope header when it creates the hot runtime and
 * keeps sending it on resume, so a token that only lives for one turn changes
 * the runtime's MCP config signature every turn and forces a full runtime
 * rebuild.  A conversation-stable token lets every turn re-register its own
 * scope under the same header value while the runtime stays hot.
 */
export function resolveClaudeBridgeMcpScopeToken(
  request: Pick<AgentRuntimeRequest, "conversationKey" | "metadata">,
  profileSignature: string,
): string {
  const requestMetadata =
    request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : {};
  const instanceID =
    typeof requestMetadata.conversationInstanceID === "string"
      ? requestMetadata.conversationInstanceID.trim()
      : "";
  return resolveConversationScopeToken({
    profileSignature,
    conversationKey: request.conversationKey,
    ...(instanceID ? { instanceID } : {}),
  });
}

/**
 * What the Zotero MCP scope says about the runtime that holds it: who is
 * calling (the server maps it to the conversation system) and what can read
 * a paper in full for it.
 */
export type ExternalRuntimeMcpIdentity = {
  runtimeAuthority: NonNullable<ZoteroMcpActiveScope["runtimeAuthority"]>;
  exhaustiveReadBackend: NonNullable<
    ZoteroMcpActiveScope["exhaustiveReadBackend"]
  >;
};

const CLAUDE_MCP_IDENTITY: ExternalRuntimeMcpIdentity = {
  runtimeAuthority: "claude",
  // paper_read's full mode reads with the chat's model through the bridge.
  exhaustiveReadBackend: "claude_bridge",
};

/** The per-turn Zotero MCP scope for an external runtime's request. */
export function buildExternalRuntimeZoteroMcpScope(
  request: AgentRuntimeRequest,
  profileSignature: string,
  identity: ExternalRuntimeMcpIdentity,
): ZoteroMcpActiveScope {
  const selectedPaper =
    getActiveTurnPaper(request.turnPaperScope) ||
    request.turnPaperScope.papers[0]?.paper;
  const kind = request.conversationKind === "paper" ? "paper" : "global";
  const activeItemId =
    positiveIntOrUndefined(request.activeItemId) ||
    positiveIntOrUndefined(request.item?.id) ||
    selectedPaper?.itemId;
  const activeNote = request.activeNoteContext;
  const paperItemID =
    kind === "paper" ? selectedPaper?.itemId || activeItemId : undefined;
  const libraryID = resolveFallbackLibraryId(request);
  return {
    runtimeAuthority: identity.runtimeAuthority,
    sourceMessageTimestamp: Number(request.metadata?.sourceMessageTimestamp),
    executionContext: request.executionContext,
    clarificationHistory: request.clarificationHistory,
    documentReadObservations: request.documentReadObservations,
    documentArtifactObservations: request.documentArtifactObservations,
    outsidePaperRecords: request.outsidePaperRecords,
    outsidePaperSelection: request.outsidePaperSelection,
    profileSignature,
    conversationGeneration: request.conversationGeneration,
    conversationKey: positiveIntOrUndefined(request.conversationKey),
    libraryID,
    kind,
    paperItemID,
    activeItemId: paperItemID || activeItemId,
    activeContextItemId: selectedPaper?.contextItemId,
    activeNoteId: positiveIntOrUndefined(activeNote?.noteId),
    activeNoteKind:
      activeNote?.noteKind === "item" || activeNote?.noteKind === "standalone"
        ? activeNote.noteKind
        : undefined,
    activeNoteTitle: activeNote?.title,
    activeNoteParentItemId: positiveIntOrUndefined(activeNote?.parentItemId),
    libraryName: resolveLibraryName(libraryID),
    title: selectedPaper?.title,
    userText: request.userText,
    // The chat's own model and reasoning, as the Codex scope carries them:
    // paper_read's full mode reads with this model through the bridge.
    model: resolveClaudeBridgeModelForMetadata(request.model),
    reasoning: request.reasoning,
    exhaustiveReadBackend: identity.exhaustiveReadBackend,
    // The reader model the user picked for this runtime, by entry ID or name.
    readerSelection: request.readerSelection,
    attachedConversationScope: request.attachedConversationScope,
    turnPaperScope: request.turnPaperScope,
    turnPaperScopeWarnings: request.turnPaperScopeWarnings,
  };
}

function normalizePaperRefs(list: unknown, limit = 8): PaperContextRef[] {
  if (!Array.isArray(list)) return [];
  const refs: PaperContextRef[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemId =
      typeof record.itemId === "number" ? record.itemId : undefined;
    const contextItemId =
      typeof record.contextItemId === "number"
        ? record.contextItemId
        : undefined;
    const title = trimText(record.title, 180);
    if (!itemId || !contextItemId || !title) continue;
    const paperRef: PaperContextRef = {
      itemId,
      contextItemId,
      title,
      attachmentTitle:
        typeof record.attachmentTitle === "string"
          ? trimText(record.attachmentTitle, 180)
          : undefined,
      citationKey:
        typeof record.citationKey === "string"
          ? trimText(record.citationKey, 80)
          : undefined,
      firstCreator:
        typeof record.firstCreator === "string"
          ? trimText(record.firstCreator, 80)
          : undefined,
      year:
        typeof record.year === "string" ? trimText(record.year, 16) : undefined,
      contentSourceMode: normalizePaperContentSourceMode(
        record.contentSourceMode,
      ),
      mineruCacheDir:
        typeof record.mineruCacheDir === "string"
          ? trimText(record.mineruCacheDir, 1024)
          : undefined,
    };
    refs.push(paperRef);
    if (refs.length >= limit) break;
  }
  return refs;
}

function normalizeCollectionRefs(
  list: unknown,
  limit = 8,
): Array<{
  collectionId: number;
  name: string;
  libraryID: number;
  excludedItemIds?: number[];
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    collectionId: number;
    name: string;
    libraryID: number;
    excludedItemIds?: number[];
  }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const collectionId =
      typeof record.collectionId === "number"
        ? Math.floor(record.collectionId)
        : 0;
    const libraryID =
      typeof record.libraryID === "number" ? Math.floor(record.libraryID) : 0;
    if (!collectionId || !libraryID) continue;
    const excludedItemIds = normalizeExcludedItemIds(record.excludedItemIds);
    refs.push({
      collectionId,
      libraryID,
      name: trimText(record.name, 180) || `Collection ${collectionId}`,
      ...(excludedItemIds ? { excludedItemIds } : {}),
    });
    if (refs.length >= limit) break;
  }
  return refs;
}

function normalizeTagRefs(
  list: unknown,
  limit = 8,
): Array<{
  name: string;
  libraryID: number;
  normalizedName?: string;
  scope?: "allTagged" | "untagged";
  includeAutomatic?: boolean;
  excludedItemIds?: number[];
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    name: string;
    libraryID: number;
    normalizedName?: string;
    scope?: "allTagged" | "untagged";
    includeAutomatic?: boolean;
    excludedItemIds?: number[];
  }> = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const libraryID =
      typeof record.libraryID === "number" ? Math.floor(record.libraryID) : 0;
    const scope =
      record.scope === "allTagged" || record.scope === "untagged"
        ? record.scope
        : undefined;
    const name =
      trimText(record.name, 180) ||
      (scope === "allTagged"
        ? "All Tagged"
        : scope === "untagged"
          ? "Untagged"
          : "");
    if (!libraryID || !name) continue;
    const normalizedName = trimText(record.normalizedName || record.name, 180)
      .toLowerCase()
      .trim();
    const includeAutomatic = record.includeAutomatic === true;
    const key = scope
      ? `${libraryID}:scope:${scope}:${includeAutomatic ? "auto" : "manual"}`
      : `${libraryID}:tag:${normalizedName || name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const excludedItemIds = normalizeExcludedItemIds(record.excludedItemIds);
    refs.push({
      name,
      libraryID,
      normalizedName: normalizedName || undefined,
      scope,
      includeAutomatic: includeAutomatic || undefined,
      ...(excludedItemIds ? { excludedItemIds } : {}),
    });
    if (refs.length >= limit) break;
  }
  return refs;
}

function buildContextEnvelope(request: AgentRuntimeRequest): ContextEnvelope {
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: request.selectedTextContexts,
    selectedTexts: request.selectedTexts,
    selectedTextSources: request.selectedTextSources,
    selectedTextPaperContexts: (request.selectedTextContexts || []).map(
      (_context, index) =>
        getSelectedPassagePaper(request.turnPaperScope, index),
    ),
    selectedTextNoteContexts: request.selectedTextNoteContexts,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const anchorsByIndex = new Map(
    (request.resolvedSelectedTextAnchors || []).map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  const selectedTextRows = selectedTexts
    .slice(0, 6)
    .map((text, index) => ({
      source: selectedTextContexts[index]?.source || "unknown",
      text: trimText(text, 280),
      ...(selectedTextContexts[index]?.userQuery
        ? { userQuery: selectedTextContexts[index].userQuery }
        : {}),
      locator:
        formatSelectedTextLocator(
          selectedTextContexts[index],
          anchorsByIndex.get(index),
        ) || undefined,
      localContext: anchorsByIndex.get(index)?.contextText,
      noteContext: selectedTextContexts[index]?.noteContext
        ? {
            noteItemId: selectedTextContexts[index]?.noteContext?.noteItemId,
            title: trimText(
              selectedTextContexts[index]?.noteContext?.title,
              120,
            ),
            noteKind: selectedTextContexts[index]?.noteContext?.noteKind || "",
            parentItemId:
              selectedTextContexts[index]?.noteContext?.parentItemId,
          }
        : undefined,
    }))
    .filter((row) => row.text);
  const selectedPapers = normalizePaperRefs(
    requestPaperRefs(request, ["selected"]),
    MAX_SELECTED_PAPER_CONTEXTS,
  );
  const fullTextPapers = normalizePaperRefs(
    requestPaperRefs(request, ["full_text"]),
    MAX_FULL_TEXT_PAPER_CONTEXTS,
  ).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const pinnedPapers = normalizePaperRefs(
    requestPaperRefs(request, ["pinned"]),
    MAX_FULL_TEXT_PAPER_CONTEXTS,
  ).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const selectedCollections = normalizeCollectionRefs(
    request.turnPaperScope.collections,
    8,
  );
  const selectedTags = normalizeTagRefs(request.turnPaperScope.tags, 8);
  const attachments = (
    Array.isArray(request.attachments) ? request.attachments : []
  )
    .slice(0, 10)
    .map((attachment) => ({
      id: attachment.id,
      name: trimText(attachment.name, 120),
      mimeType: attachment.mimeType,
      category: attachment.category,
      sizeBytes: attachment.sizeBytes,
    }));
  const activeNote = request.activeNoteContext
    ? {
        noteId: request.activeNoteContext.noteId,
        noteKind: request.activeNoteContext.noteKind,
        title: trimText(request.activeNoteContext.title, 120),
        parentItemId: request.activeNoteContext.parentItemId,
        preview: trimText(request.activeNoteContext.noteText, 420),
      }
    : undefined;

  return {
    activeItemId: request.activeItemId,
    libraryID: request.libraryID,
    selectedTextCount: selectedTexts.length,
    selectedPaperCount: requestPaperRefs(request, ["selected"]).length,
    selectedCollectionCount: request.turnPaperScope.collections.length,
    selectedTagCount: request.turnPaperScope.tags.length,
    fullTextPaperCount: requestPaperRefs(request, ["full_text"]).length,
    pinnedPaperCount: requestPaperRefs(request, ["pinned"]).length,
    attachmentCount: Array.isArray(request.attachments)
      ? request.attachments.length
      : 0,
    screenshotCount: Array.isArray(request.screenshots)
      ? request.screenshots.length
      : 0,
    selectedTexts: selectedTextRows,
    selectedPapers,
    selectedCollections,
    selectedTags,
    fullTextPapers,
    pinnedPapers,
    attachments,
    activeNote,
  };
}

async function buildBridgeRuntimeRequest(
  request: AgentRuntimeRequest,
  /** The prompt's turn blocks (renderExternalRuntimePrompt). */
  turnContext: string,
  /** The turn has the Zotero tools (past_chat_read among them). */
  offersZoteroTools: boolean,
): Promise<BridgeRuntimeRequest> {
  const joinPath = (base: string, segment: string): string => {
    if (!base) return segment;
    if (!segment) return base;
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const normalizedSegment = segment.startsWith("/")
      ? segment.slice(1)
      : segment;
    return `${normalizedBase}/${normalizedSegment}`;
  };

  const resolveAttachmentAbsolutePath = async (
    contextItemId: unknown,
    fallbackItemId?: unknown,
  ): Promise<string | undefined> => {
    const normalizedId =
      typeof contextItemId === "number" && Number.isFinite(contextItemId)
        ? Math.floor(contextItemId)
        : 0;
    const readAttachmentPath = async (
      attachmentId: number,
    ): Promise<string | undefined> => {
      if (attachmentId <= 0) return undefined;
      const attachment = Zotero.Items.get(attachmentId);
      if (!attachment?.isAttachment?.()) return undefined;
      const asyncPath = await (
        attachment as unknown as {
          getFilePathAsync?: () => Promise<string | false>;
        }
      ).getFilePathAsync?.();
      const directPath =
        typeof asyncPath === "string" && asyncPath.trim()
          ? asyncPath.trim()
          : typeof (attachment as { getFilePath?: () => string | undefined })
                .getFilePath === "function"
            ? (
                attachment as { getFilePath: () => string | undefined }
              ).getFilePath()
            : (attachment as unknown as { attachmentPath?: string })
                .attachmentPath;
      if (typeof directPath !== "string") return undefined;
      const normalizedPath = directPath.trim();
      return normalizedPath.startsWith("/") ? normalizedPath : undefined;
    };

    const normalizedFallbackItemId =
      typeof fallbackItemId === "number" && Number.isFinite(fallbackItemId)
        ? Math.floor(fallbackItemId)
        : 0;
    const scoreAttachment = (attachment: Zotero.Item): number => {
      const contentType = String(
        (attachment as unknown as { attachmentContentType?: string })
          .attachmentContentType || "",
      )
        .trim()
        .toLowerCase();
      const pathHint = String(
        (attachment as unknown as { attachmentFilename?: string })
          .attachmentFilename || "",
      )
        .trim()
        .toLowerCase();
      if (contentType === "text/markdown" || pathHint.endsWith(".md"))
        return 100;
      if (contentType === "application/pdf" || pathHint.endsWith(".pdf"))
        return 90;
      if (
        contentType === "text/html" ||
        pathHint.endsWith(".html") ||
        pathHint.endsWith(".htm")
      )
        return 80;
      if (contentType.startsWith("text/")) return 70;
      return 10;
    };

    try {
      if (normalizedId > 0) {
        const direct = await readAttachmentPath(normalizedId);
        if (direct) return direct;
      }
      if (normalizedFallbackItemId > 0) {
        const parentItem = Zotero.Items.get(normalizedFallbackItemId);
        if (parentItem?.isRegularItem?.()) {
          const attachmentIds = parentItem.getAttachments?.() || [];
          const scoredAttachments = attachmentIds
            .map((attachmentId) => Zotero.Items.get(attachmentId))
            .filter((attachment): attachment is Zotero.Item =>
              Boolean(attachment?.isAttachment?.()),
            )
            .map((attachment) => ({
              attachment,
              score: scoreAttachment(attachment),
            }))
            .sort((a, b) => b.score - a.score);
          for (const { attachment } of scoredAttachments) {
            const path = await readAttachmentPath(attachment.id);
            if (path) return path;
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const enrichPaperContexts = async (
    list: unknown,
  ): Promise<BridgePaperContext[] | undefined> => {
    if (!Array.isArray(list) || !list.length) return undefined;
    const enriched: BridgePaperContext[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const paper = raw as Record<string, unknown>;
      const mineruCacheDir =
        typeof paper.mineruCacheDir === "string" && paper.mineruCacheDir.trim()
          ? paper.mineruCacheDir.trim()
          : undefined;
      const contextFilePath = await resolveAttachmentAbsolutePath(
        paper.contextItemId,
        paper.itemId,
      );
      const context: BridgePaperContext = {
        itemId:
          typeof paper.itemId === "number" && Number.isFinite(paper.itemId)
            ? Math.floor(paper.itemId)
            : undefined,
        contextItemId:
          typeof paper.contextItemId === "number" &&
          Number.isFinite(paper.contextItemId)
            ? Math.floor(paper.contextItemId)
            : undefined,
        title: typeof paper.title === "string" ? paper.title : undefined,
        attachmentTitle:
          typeof paper.attachmentTitle === "string"
            ? paper.attachmentTitle
            : undefined,
        citationKey:
          typeof paper.citationKey === "string" ? paper.citationKey : undefined,
        firstCreator:
          typeof paper.firstCreator === "string"
            ? paper.firstCreator
            : undefined,
        year: typeof paper.year === "string" ? paper.year : undefined,
        contentSourceMode: normalizePaperContentSourceMode(
          paper.contentSourceMode,
        ),
        mineruCacheDir,
        mineruFullMdPath: mineruCacheDir
          ? joinPath(mineruCacheDir, "full.md")
          : undefined,
        contextFilePath,
      };
      enriched.push(context);
    }
    return enriched.length ? enriched : undefined;
  };

  const attachments = (
    Array.isArray(request.attachments) ? request.attachments : []
  )
    .filter((entry) => Boolean(entry))
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      category: attachment.category,
      sizeBytes: attachment.sizeBytes,
      storedPath:
        typeof attachment.storedPath === "string" &&
        attachment.storedPath.trim()
          ? attachment.storedPath.trim()
          : undefined,
      contentHash:
        typeof attachment.contentHash === "string" &&
        attachment.contentHash.trim()
          ? attachment.contentHash.trim()
          : undefined,
    }));

  const history = selectRuntimeHistory(request, {
    pastChatReadAvailable: offersZoteroTools,
  });
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

  const [selectedPaperContexts, fullTextPaperContexts, pinnedPaperContexts] =
    await Promise.all([
      enrichPaperContexts(requestPaperRefs(request, ["selected"])),
      enrichPaperContexts(requestPaperRefs(request, ["full_text"])),
      enrichPaperContexts(requestPaperRefs(request, ["pinned"])),
    ]);

  return {
    conversationKey: request.conversationKey,
    userText: request.userText,
    activeItemId: request.activeItemId,
    libraryID: request.libraryID,
    model: request.model,
    apiBase: request.apiBase,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    executionContext: request.executionContext,
    turnContext: turnContext || undefined,
    selectedPaperContexts,
    fullTextPaperContexts,
    pinnedPaperContexts,
    localDocuments: requestLocalDocuments(request).length
      ? requestLocalDocuments(request)
      : undefined,
    attachments: attachments.length ? attachments : undefined,
    screenshots: screenshots.length ? screenshots : undefined,
    // The bridge replays it only when the Claude session cannot be resumed.
    ...(hasRuntimeHistory(history)
      ? {
          history: history.entries,
          ...(history.omitted
            ? {
                historyOmitted: history.omitted,
                ...(history.chatId ? { historyChatId: history.chatId } : {}),
              }
            : {}),
        }
      : {}),
  };
}

function signatureForContextEnvelope(envelope: ContextEnvelope): string {
  return JSON.stringify({
    activeItemId: envelope.activeItemId,
    libraryID: envelope.libraryID,
    selectedTextCount: envelope.selectedTextCount,
    selectedPaperCount: envelope.selectedPaperCount,
    selectedCollectionCount: envelope.selectedCollectionCount,
    selectedTagCount: envelope.selectedTagCount,
    fullTextPaperCount: envelope.fullTextPaperCount,
    pinnedPaperCount: envelope.pinnedPaperCount,
    attachmentCount: envelope.attachmentCount,
    screenshotCount: envelope.screenshotCount,
    selectedPaperIds: envelope.selectedPapers
      .map((paper) => paper.contextItemId)
      .sort(),
    selectedCollectionIds: envelope.selectedCollections
      .map((collection) => collection.collectionId)
      .sort(),
    selectedTags: envelope.selectedTags
      .map((tag) =>
        [
          tag.libraryID,
          tag.scope || "",
          tag.normalizedName || tag.name.toLowerCase(),
          tag.includeAutomatic === true ? "auto" : "manual",
        ].join(":"),
      )
      .sort(),
    fullTextPaperIds: envelope.fullTextPapers
      .map((paper) => paper.contextItemId)
      .sort(),
    pinnedPaperIds: envelope.pinnedPapers
      .map((paper) => paper.contextItemId)
      .sort(),
    selectedTextFingerprints: envelope.selectedTexts.map((row) =>
      row.text.slice(0, 80),
    ),
    activeNoteId: envelope.activeNote?.noteId,
  });
}

async function fetchExternalTools(
  baseUrl: string,
  encodedSources: string,
): Promise<ExternalToolDescriptor[]> {
  const response = await claudeBridgeFetch(
    `${normalizeBaseUrl(baseUrl)}/tools?settingSources=${encodedSources}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = (await response.json()) as { tools?: unknown[] };
  const rawTools = Array.isArray(json.tools) ? json.tools : [];
  const tools: ExternalToolDescriptor[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.trim()) continue;
    tools.push({
      name: tool.name,
      description:
        typeof tool.description === "string" ? tool.description : tool.name,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as object)
          : { type: "object", properties: {} },
      mutability: tool.mutability === "write" ? "write" : "read",
      riskLevel:
        tool.riskLevel === "high" ||
        tool.riskLevel === "medium" ||
        tool.riskLevel === "low"
          ? tool.riskLevel
          : "medium",
      requiresConfirmation: Boolean(tool.requiresConfirmation),
      source:
        tool.source === "claude-runtime" ||
        tool.source === "mcp" ||
        tool.source === "zotero-bridge"
          ? tool.source
          : "claude-runtime",
    });
  }
  return tools;
}

async function fetchExternalEfforts(
  baseUrl: string,
  encodedSources: string,
  model?: string,
  context?: ClaudeModelCatalogRequestContext,
): Promise<ExternalEffortInfo> {
  const query = new URLSearchParams({
    settingSources: decodeURIComponent(encodedSources),
  });
  const normalizedModel = model?.trim();
  if (normalizedModel) query.set("model", normalizedModel);
  const conversationKey =
    context === undefined ? "" : String(context.conversationKey).trim();
  const scopeId = context?.scopeId.trim() || "";
  if (context && conversationKey && scopeId) {
    query.set("conversationKey", conversationKey);
    query.set("scopeType", context.scopeType);
    query.set("scopeId", scopeId);
    const scopeLabel = context.scopeLabel?.trim();
    if (scopeLabel) query.set("scopeLabel", scopeLabel);
  }
  const response = await claudeBridgeFetch(
    `${normalizeBaseUrl(baseUrl)}/efforts?${query}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = (await response.json()) as { efforts?: unknown[] };
  return {
    efforts: Array.isArray(json.efforts)
      ? json.efforts.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}

async function fetchExternalCommands(
  baseUrl: string,
  encodedSources: string,
): Promise<ExternalSlashCommandDescriptor[]> {
  try {
    const response = await claudeBridgeFetch(
      `${normalizeBaseUrl(baseUrl)}/commands?settingSources=${encodedSources}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}`);
    }
    const json = (await response.json()) as { commands?: unknown[] };
    const rawCommands = Array.isArray(json.commands) ? json.commands : [];
    const commands: ExternalSlashCommandDescriptor[] = [];
    for (const raw of rawCommands) {
      if (!raw || typeof raw !== "object") continue;
      const command = raw as Record<string, unknown>;
      const name =
        typeof command.name === "string"
          ? command.name.trim().replace(/^\/+/, "")
          : "";
      if (!name) continue;
      commands.push({
        name,
        description:
          typeof command.description === "string" && command.description.trim()
            ? command.description.trim()
            : `Claude Code slash command: /${name}`,
        argumentHint:
          typeof command.argumentHint === "string"
            ? command.argumentHint.trim()
            : "",
        source: command.source === "fallback" ? "fallback" : "sdk",
      });
    }
    return commands;
  } catch (error) {
    throw new Error(
      formatBridgeUserError(error, baseUrl, "Failed to load Claude commands"),
    );
  }
}

export async function fetchExternalBridgeSessionInfo(params: {
  baseUrl: string;
  conversationKey: number;
  scopeType?: BridgeScopeType;
  scopeId?: string;
  scopeLabel?: string;
}): Promise<ExternalBridgeSessionInfo | null> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  if (!baseUrl) return null;
  const debugEnabled = isBridgeDebugEnabled();
  const conversationKey = Math.floor(params.conversationKey);
  const cached = getLastRunBridgeContext(conversationKey);
  const candidates: Array<{
    scopeType?: BridgeScopeType;
    scopeId?: string;
    scopeLabel?: string;
    source:
      | "last_run_snapshot"
      | "runtime_scope"
      | "scope_no_label"
      | "conversation_only";
  }> = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: {
    scopeType?: BridgeScopeType;
    scopeId?: string;
    scopeLabel?: string;
    source:
      | "last_run_snapshot"
      | "runtime_scope"
      | "scope_no_label"
      | "conversation_only";
  }) => {
    const key = `${candidate.scopeType || ""}|${candidate.scopeId || ""}|${candidate.scopeLabel || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  if (params.scopeType && params.scopeId) {
    pushCandidate({
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      scopeLabel: params.scopeLabel,
      source: "runtime_scope",
    });
    pushCandidate({
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      source: "scope_no_label",
    });
  }

  if (cached?.scope?.scopeType && cached.scope.scopeId) {
    pushCandidate({
      scopeType: cached.scope.scopeType,
      scopeId: cached.scope.scopeId,
      scopeLabel: cached.scope.scopeLabel,
      source: "last_run_snapshot",
    });
    pushCandidate({
      scopeType: cached.scope.scopeType,
      scopeId: cached.scope.scopeId,
      source: "scope_no_label",
    });
  }

  pushCandidate({ source: "conversation_only" });

  const query = async (candidate: {
    scopeType?: BridgeScopeType;
    scopeId?: string;
    scopeLabel?: string;
    source: string;
  }): Promise<ExternalBridgeSessionInfo | null> => {
    const qs = new URLSearchParams();
    qs.set("conversationKey", String(conversationKey));
    if (candidate.scopeType) qs.set("scopeType", candidate.scopeType);
    if (candidate.scopeId) qs.set("scopeId", candidate.scopeId);
    if (candidate.scopeLabel) qs.set("scopeLabel", candidate.scopeLabel);
    const url = `${baseUrl}/session-info?${qs.toString()}`;
    try {
      const response = await claudeBridgeFetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 404) {
          if (debugEnabled) {
            dbg("session-info probe miss", {
              source: candidate.source,
              conversationKey,
              queryScopeType: candidate.scopeType,
              queryScopeId: candidate.scopeId,
              queryScopeLabel: candidate.scopeLabel,
              httpStatus: response.status,
            });
          }
          return null;
        }
        throw new Error(`Bridge HTTP ${response.status}`);
      }
      const json = (await response.json()) as {
        session?: ExternalBridgeSessionInfo | null;
      };
      const session = json?.session || null;
      if (debugEnabled) {
        dbg("session-info query", {
          source: candidate.source,
          conversationKey,
          queryScopeType: candidate.scopeType,
          queryScopeId: candidate.scopeId,
          queryScopeLabel: candidate.scopeLabel,
          queryScopedConversationKey: buildScopedConversationKey(
            conversationKey,
            candidate,
          ),
          responseScopedConversationKey: session?.scopedConversationKey || null,
          responseProviderSessionId: session?.providerSessionId || null,
        });
      }
      return session;
    } catch (error) {
      throw new Error(
        formatBridgeUserError(error, baseUrl, "Failed to fetch session info"),
      );
    }
  };

  let firstSession: ExternalBridgeSessionInfo | null = null;
  for (const candidate of candidates) {
    const session = await query(candidate);
    if (!firstSession && session) {
      firstSession = session;
    }
    if (session?.providerSessionId) {
      return session;
    }
  }
  return firstSession;
}

async function runExternalBridgeAction(
  baseUrl: string,
  params: {
    conversationKey: number;
    toolName: string;
    args: unknown;
    libraryID?: number;
    approved?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    metadata?: Record<string, unknown>;
  },
): Promise<BridgeTurnOutcome> {
  const response = await claudeBridgeFetch(
    `${normalizeBaseUrl(baseUrl)}/run-action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationKey: params.conversationKey,
        toolName: params.toolName,
        args: params.args,
        libraryID: params.libraryID,
        approved: Boolean(params.approved),
        scopeType:
          typeof params.metadata?.scopeType === "string"
            ? params.metadata.scopeType
            : undefined,
        scopeId:
          typeof params.metadata?.scopeId === "string"
            ? params.metadata.scopeId
            : undefined,
        scopeLabel:
          typeof params.metadata?.scopeLabel === "string"
            ? params.metadata.scopeLabel
            : undefined,
        metadata: params.metadata,
      }),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  let finalOutcome: BridgeTurnOutcome | null = null;
  await streamBridgeLines(response, async (line) => {
    if (line.type === "start") {
      await params.onStart?.(line.runId);
      return;
    }
    if (line.type === "event") {
      await params.onEvent?.(line.event);
      return;
    }
    if (line.type === "outcome") {
      finalOutcome = line.outcome;
      return;
    }
    if (line.type === "error") {
      throw new Error(line.error || "Bridge stream error");
    }
  });

  if (!finalOutcome) {
    return {
      kind: "fallback",
      runId: `bridge-action-${Date.now()}`,
      reason: "Bridge ended without outcome",
      usedFallback: true,
    };
  }
  return finalOutcome;
}

/**
 * The bridge runtime as seen by one turn or panel: every system gate answers
 * for `conversationSystem` instead of the saved one; everything else is the
 * same runtime.
 */
export function bindClaudeBridgeConversationSystem(
  runtime: AgentRuntimeLike,
  conversationSystem: ConversationSystem,
): AgentRuntimeLike {
  const gate: ClaudeBridgeGateOptions = { conversationSystem };
  return {
    ...runtime,
    getCapabilities: (request) => runtime.getCapabilities(request, gate),
    listExternalActionsSync: () => runtime.listExternalActionsSync(gate),
    listSlashCommandsSync: () => runtime.listSlashCommandsSync(gate),
    listEfforts: (model, context) => runtime.listEfforts(model, context, gate),
    listModels: (force, context) => runtime.listModels(force, context, gate),
  };
}

type ClaudeBridgeTurnPrepared = {
  bridgeUrl: string;
  contextEnvelope: ContextEnvelope;
  runtimeRequest: BridgeRuntimeRequest;
  /** The prompt's standing blocks, the Claude system-prompt append. */
  standingInstructions: string;
  scope: BridgeScope;
};

/** Sends the user's answer to a Claude permission request to the bridge. */
async function resolveClaudeBridgeConfirmation(
  bridgeUrl: string,
  requestId: string,
  resolution: AgentConfirmationResolution,
): ReturnType<ResolveExternalConfirmation> {
  const response = await claudeBridgeFetch(
    `${normalizeBaseUrl(bridgeUrl)}/resolve-confirmation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        approved: Boolean(resolution.approved),
        actionId: resolution.actionId,
        data: resolution.data,
      }),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const accepted = Boolean(payload.ok);
  return {
    ok: response.ok && accepted,
    requestId,
    httpStatus: response.status,
    accepted,
    source: typeof payload.source === "string" ? payload.source : undefined,
    pendingPermissionCount:
      typeof payload.pendingPermissionCount === "number"
        ? payload.pendingPermissionCount
        : undefined,
    recentPendingRequestIds: Array.isArray(payload.recentPendingRequestIds)
      ? payload.recentPendingRequestIds
          .filter((x): x is string => typeof x === "string")
          .slice(0, 5)
      : undefined,
    errorMessage:
      typeof payload.error === "string"
        ? payload.error
        : !response.ok
          ? `resolve-confirmation failed (${response.status})`
          : accepted
            ? undefined
            : "backend returned ok=false",
  };
}

export function createExternalBackendBridgeRuntime(options: {
  coreRuntime: AgentRuntime;
  getBridgeUrl: () => string;
  /**
   * Where attached past chats are read from; the conversation stores unless
   * a test supplies a fake.
   */
  pastConversationSource?: PastConversationSource;
}): AgentRuntimeLike {
  const { coreRuntime, getBridgeUrl, pastConversationSource } = options;
  const claudeBridgeTransport: ExternalRuntimeTransport<
    ClaudeBridgeTurnPrepared,
    ClaudeMcpServersConfig
  > = {
    logLabel: "External bridge",
    failureRunIdPrefix: "bridge-error",
    adjustRequest: async (request) => {
      const requestMetadata =
        request.metadata && typeof request.metadata === "object"
          ? request.metadata
          : {};
      const conversationInstanceID =
        typeof requestMetadata.conversationInstanceID === "string"
          ? requestMetadata.conversationInstanceID.trim()
          : "";
      if (request.conversationKey <= 0) return request;
      try {
        if (
          !(await hasPendingEmptyClaudeCleanupJob({
            conversationKey: request.conversationKey,
            ...(conversationInstanceID
              ? { instanceID: conversationInstanceID }
              : {}),
          }))
        )
          return request;
        // Clear may have had to defer an empty-session invalidation while
        // the catalog had no provider ID. Do not resume the old bridge
        // mapping; the adapter will invalidate it before starting fresh.
        // (A reset a Retry or Edit could not finish is finished before the
        // chat's next send: runtimeSessionReset.finishPendingRuntimeSessionResets.)
      } catch {
        // A pending empty-session cleanup is a deletion boundary, not an
        // advisory hint. If the cleanup table cannot be read, fail closed
        // by forcing a fresh provider session; reusing a hot mapping here
        // could resurrect the pre-Clear runtime while the durable worker
        // is still waiting to invalidate it.
      }
      return {
        ...request,
        metadata: { ...requestMetadata, forceFreshSession: true },
      };
    },
    prepare: async ({
      request,
      offersZoteroTools,
      recordProfiling,
      writeAllowed,
    }) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        throw new Error(
          "Claude bridge URL is empty. Set Bridge URL to http://127.0.0.1:19787.",
        );
      }
      if (requestLocalDocuments(request).length) {
        await assertClaudeBridgeLocalPdfCapability(bridgeUrl);
      }
      const contextEnvelope = buildContextEnvelope(request);
      await recordProfiling("frontend.context_envelope.ready");
      const runtimePrompt = await renderExternalRuntimePrompt(
        "claude_code",
        request,
      );
      const runtimeRequest = await buildBridgeRuntimeRequest(
        request,
        runtimePrompt.turn,
        offersZoteroTools,
      );
      await recordProfiling("frontend.bridge_runtime_request.ready");
      const scope = resolveBridgeScope(request);
      await withConversationWriteLock(request.conversationKey, async () => {
        if (!writeAllowed()) {
          throw new Error("Conversation write generation changed");
        }
        rememberLastRunBridgeContext(request.conversationKey, scope);
        if (isBridgeDebugEnabled()) {
          dbg("run-turn scope snapshot", {
            conversationKey: request.conversationKey,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            scopeLabel: scope.scopeLabel,
            scopedConversationKey: buildScopedConversationKey(
              request.conversationKey,
              scope,
            ),
          });
        }
        conversationScopeByKey.set(request.conversationKey, scope);
        conversationContextSignature.set(
          request.conversationKey,
          signatureForContextEnvelope(contextEnvelope),
        );
      });
      return {
        bridgeUrl,
        contextEnvelope,
        runtimeRequest,
        standingInstructions: runtimePrompt.standing,
        scope,
      };
    },
    createStageTracker: createClaudeTurnStageTracker,
    zoteroMcp: {
      profileSignature: getClaudeProfileSignature,
      buildScope: (request, profileSignature) =>
        buildExternalRuntimeZoteroMcpScope(
          request,
          profileSignature,
          CLAUDE_MCP_IDENTITY,
        ),
      scopeToken: resolveClaudeBridgeMcpScopeToken,
      buildServerConfig: ({ profileSignature, scopeToken, rawPdfMode }) => {
        const config = buildClaudeZoteroMcpServerConfig({
          profileSignature,
          scopeToken,
          required: true,
          rawPdfMode,
        });
        return {
          serverName: config.serverName,
          servers: config.mcpServers,
          allowedTools: config.allowedTools,
        };
      },
      requiredToolNames: (rawPdfMode) =>
        rawPdfMode
          ? REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES
          : REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
    },
    run: (ctx) =>
      runExternalBridgeTurn(ctx.prepared.bridgeUrl, {
        ...ctx.params,
        request: ctx.request,
        pastConversationSource,
        onStart: ctx.onStart,
        onEvent: ctx.emit,
        contextEnvelope: ctx.prepared.contextEnvelope,
        runtimeRequest: ctx.prepared.runtimeRequest,
        standingInstructions: ctx.prepared.standingInstructions,
        allowedTools: ctx.zoteroMcp?.allowedTools,
        mcpServers: ctx.zoteroMcp?.servers,
        scope: ctx.prepared.scope,
        registerPendingConfirmation: ctx.registerPendingConfirmation,
        resolveExternalConfirmation: (requestId, resolution) =>
          resolveClaudeBridgeConfirmation(
            ctx.prepared.bridgeUrl,
            requestId,
            resolution,
          ),
      }),
    describeFailure: (error, prepared) =>
      formatBridgeUserError(
        error,
        prepared?.bridgeUrl ?? normalizeBaseUrl(getBridgeUrl()),
        "External agent backend unavailable",
      ),
  };
  let cachedTools: ExternalToolDescriptor[] = [];
  let cacheExpiresAt = 0;
  let refreshInFlight: Promise<void> | null = null;
  let cachedSlashCommands: ExternalSlashCommandDescriptor[] = [];
  let slashCommandsCacheExpiresAt = 0;
  let slashCommandsRefreshInFlight: Promise<void> | null = null;
  const cachedEffortsByModel = new Map<string, ExternalEffortInfo>();
  let cachedModelCatalog: ClaudeModelCatalog | null = null;
  let cachedModelCatalogKey = "";
  let modelCatalogCacheExpiresAt = 0;
  let modelCatalogRefreshInFlight: Promise<ClaudeModelCatalog> | null = null;
  let modelCatalogRefreshKey = "";
  let modelCatalogRefreshForced = false;
  let modelCatalogRefreshGeneration = 0;
  const SLASH_COMMANDS_CACHE_TTL_MS = 5 * 60_000;
  const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
  const EFFORT_CACHE_TTL_MS = 60_000;
  const conversationContextSignature = new Map<number, string>();
  const conversationScopeByKey = new Map<number, BridgeScope>();
  const TOOL_CACHE_TTL_MS = 5 * 60_000;
  let lastCapabilityConfigKey = "";

  const resolveCapabilityConfigKey = (): string => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    const source = getClaudeConfigSourcePref();
    const settingSources = getClaudeSettingSourcesCsvByPref();
    let profileSignature = "";
    try {
      profileSignature = getClaudeProfileSignature();
    } catch {
      // The profile is always available in Zotero, but keep lightweight test
      // and bootstrap callers from failing before the application is ready.
    }
    return `${bridgeUrl}|${source}|${settingSources}|${profileSignature}`;
  };

  // Every capability cache (tools, slash commands, efforts, model catalog) is
  // keyed by the same config identity and must be cleared together whenever
  // that identity changes; keep this the single place that does so.
  const resetCapabilityCaches = (nextConfigKey: string): void => {
    cachedTools = [];
    cacheExpiresAt = 0;
    cachedSlashCommands = [];
    slashCommandsCacheExpiresAt = 0;
    cachedEffortsByModel.clear();
    cachedModelCatalog = null;
    cachedModelCatalogKey = "";
    modelCatalogCacheExpiresAt = 0;
    lastCapabilityConfigKey = nextConfigKey;
  };

  const refreshExternalActions = async (force = false): Promise<void> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl) {
      resetCapabilityCaches("");
      return;
    }
    const configKey = resolveCapabilityConfigKey();
    if (configKey !== lastCapabilityConfigKey) {
      force = true;
      resetCapabilityCaches(configKey);
    }
    if (!force && Date.now() < cacheExpiresAt && cachedTools.length > 0) {
      return;
    }
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    refreshInFlight = (async () => {
      try {
        const encodedSources = encodeURIComponent(
          getClaudeSettingSourcesByPref().join(","),
        );
        cachedTools = await fetchExternalTools(bridgeUrl, encodedSources);
        cacheExpiresAt = Date.now() + TOOL_CACHE_TTL_MS;
      } catch (error) {
        appLogger.warn("LLM Agent: Failed to refresh external actions", error);
      } finally {
        refreshInFlight = null;
      }
    })();
    await refreshInFlight;
  };

  const listEfforts = async (
    model?: string,
    context?: ClaudeModelCatalogRequestContext,
    options?: ClaudeBridgeGateOptions,
  ): Promise<string[]> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl || !isClaudeBridgeActive(options)) {
      return [];
    }
    const configKey = resolveCapabilityConfigKey();
    if (configKey !== lastCapabilityConfigKey) {
      resetCapabilityCaches(configKey);
    }
    const requestKey = context
      ? [
          String(context.conversationKey).trim(),
          context.scopeType,
          context.scopeId.trim(),
        ].join("|")
      : "runtime-root";
    const key = `${configKey}|${requestKey}|${(model || "").trim()}`;
    const cached = cachedEffortsByModel.get(key);
    if (cached && (cached.expiresAt || 0) > Date.now()) {
      return cached.efforts;
    }
    const encodedSources = encodeURIComponent(
      getClaudeSettingSourcesByPref().join(","),
    );
    const info = await fetchExternalEfforts(
      bridgeUrl,
      encodedSources,
      model,
      context,
    );
    cachedEffortsByModel.set(key, {
      ...info,
      expiresAt: Date.now() + EFFORT_CACHE_TTL_MS,
    });
    return info.efforts;
  };

  const listModels = async (
    force = false,
    context?: ClaudeModelCatalogRequestContext,
    options?: ClaudeBridgeGateOptions,
  ): Promise<ClaudeModelCatalog> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl || !isClaudeBridgeActive(options)) {
      return { models: [], legacy: true };
    }
    const configKey = resolveCapabilityConfigKey();
    if (configKey !== lastCapabilityConfigKey) {
      resetCapabilityCaches(configKey);
    }
    const requestKey = context
      ? [
          configKey,
          String(context.conversationKey).trim(),
          context.scopeType,
          context.scopeId.trim(),
        ].join("|")
      : `${configKey}|runtime-root`;
    if (
      !force &&
      cachedModelCatalog &&
      cachedModelCatalogKey === requestKey &&
      Date.now() < modelCatalogCacheExpiresAt
    ) {
      return cachedModelCatalog;
    }
    if (
      modelCatalogRefreshInFlight &&
      modelCatalogRefreshKey === requestKey &&
      (!force || modelCatalogRefreshForced)
    ) {
      // A forced request may piggyback on an in-flight FORCED refresh — that
      // one is already bypassing every cache. An unforced in-flight fetch
      // cannot satisfy it: its response may come from the bridge cache.
      return modelCatalogRefreshInFlight;
    }
    if (force) cachedEffortsByModel.clear();
    const refreshGeneration = ++modelCatalogRefreshGeneration;
    const refreshPromise = fetchClaudeModelCatalog({
      bridgeUrl,
      settingSources: getClaudeSettingSourcesByPref(),
      context,
      forceRefresh: force,
    })
      .then((catalog) => {
        if (
          refreshGeneration === modelCatalogRefreshGeneration &&
          resolveCapabilityConfigKey() === configKey
        ) {
          cachedModelCatalog = catalog;
          cachedModelCatalogKey = requestKey;
          modelCatalogCacheExpiresAt = Date.now() + MODEL_CATALOG_CACHE_TTL_MS;
          cachedEffortsByModel.clear();
        }
        return catalog;
      })
      .catch((error: unknown) => {
        const message = formatBridgeUserError(
          error,
          bridgeUrl,
          "Failed to refresh Claude models",
        );
        appLogger.warn(
          "LLM Agent: Failed to refresh Claude model catalog",
          message,
          error,
        );
        throw new Error(message);
      })
      .finally(() => {
        if (modelCatalogRefreshInFlight === refreshPromise) {
          modelCatalogRefreshInFlight = null;
          modelCatalogRefreshKey = "";
          modelCatalogRefreshForced = false;
        }
      });
    modelCatalogRefreshInFlight = refreshPromise;
    modelCatalogRefreshKey = requestKey;
    modelCatalogRefreshForced = force;
    return refreshPromise;
  };

  const refreshSlashCommands = async (force = false): Promise<void> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    dbg("refreshSlashCommands called", { bridgeUrl, force });
    if (force) {
      dbg("refreshSlashCommands: force=true, clearing cache");
      cachedSlashCommands = [];
      slashCommandsCacheExpiresAt = 0;
    }
    if (!bridgeUrl) {
      dbg("refreshSlashCommands: no bridgeUrl, clearing cache");
      resetCapabilityCaches("");
      return;
    }
    if (
      !force &&
      Date.now() < slashCommandsCacheExpiresAt &&
      cachedSlashCommands.length > 0
    ) {
      dbg("refreshSlashCommands: using cached", {
        count: cachedSlashCommands.length,
      });
      return;
    }
    if (slashCommandsRefreshInFlight) {
      dbg("refreshSlashCommands: waiting for in-flight");
      await slashCommandsRefreshInFlight;
      return;
    }
    slashCommandsRefreshInFlight = (async () => {
      try {
        const encodedSources = encodeURIComponent(
          getClaudeSettingSourcesByPref().join(","),
        );
        dbg("refreshSlashCommands: fetching from adapter", { bridgeUrl });
        cachedSlashCommands = await fetchExternalCommands(
          bridgeUrl,
          encodedSources,
        );
        slashCommandsCacheExpiresAt = Date.now() + SLASH_COMMANDS_CACHE_TTL_MS;
        dbg("refreshSlashCommands: fetched successfully", {
          count: cachedSlashCommands.length,
        });
      } catch (error) {
        dbgError("refreshSlashCommands failed", error);
        const message = formatBridgeUserError(
          error,
          bridgeUrl,
          "Failed to refresh slash commands",
        );
        appLogger.warn(
          "LLM Agent: Failed to refresh slash commands",
          message,
          error,
        );
        throw new Error(message);
      } finally {
        slashCommandsRefreshInFlight = null;
      }
    })();
    await slashCommandsRefreshInFlight;
  };

  const listSlashCommandsSync = (
    options?: ClaudeBridgeGateOptions,
  ): ExternalSlashCommandDescriptor[] => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    const hasBridge = !!bridgeUrl && isClaudeBridgeActive(options);
    const count = cachedSlashCommands.length;
    dbg("listSlashCommandsSync called", { hasBridge, count, bridgeUrl });
    if (!hasBridge) {
      return [];
    }
    return cachedSlashCommands;
  };

  const clearInvalidatedSessionStateWithinWriteLock = (
    conversationKey: number,
  ): void => {
    clearLastRunBridgeContext(conversationKey);
    conversationScopeByKey.delete(conversationKey);
    conversationContextSignature.delete(conversationKey);
  };

  const invalidateSessionWithinWriteLock = async ({
    conversationKey,
    scope,
    metadata,
  }: SessionInvalidationParams): Promise<SessionInvalidationResponse | null> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl) {
      clearInvalidatedSessionStateWithinWriteLock(conversationKey);
      return null;
    }
    const outcome = await invalidateExternalBridgeSession({
      baseUrl: bridgeUrl,
      conversationKey,
      scope,
      metadata,
    });
    clearInvalidatedSessionStateWithinWriteLock(conversationKey);
    return outcome;
  };

  return {
    listTools: () => coreRuntime.listTools(),
    prepareExecutionRequest: (request, options) =>
      coreRuntime.prepareExecutionRequest(request, options),
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approvedOrResolution, data) =>
      coreRuntime.resolveConfirmation(requestId, approvedOrResolution, data),
    getRunTrace: (runId: string) => coreRuntime.getRunTrace(runId),
    getCapabilities: (request, options) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl || !isClaudeBridgeActive(options)) {
        return coreRuntime.getCapabilities(request);
      }
      return buildAgentModelCapabilities({
        streaming: true,
        toolCalls: true,
        contentInputs: {
          images: true,
          pdfDocuments: true,
          nativeFiles: true,
        },
        fileInputs: true,
        reasoning: true,
      });
    },
    listExternalActionsSync: (options) => {
      if (!normalizeBaseUrl(getBridgeUrl()) || !isClaudeBridgeActive(options)) {
        return [];
      }
      return cachedTools.map((tool) => ({
        name: toExternalActionName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: "backend" as const,
        backendToolName: tool.name,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
        mutability: tool.mutability,
      }));
    },
    refreshExternalActions,
    listSlashCommandsSync,
    refreshSlashCommands,
    listEfforts,
    listModels,
    updateRuntimeRetention: async ({
      conversationKey,
      scope,
      mountId,
      retain,
      probeId,
      providerSessionId,
    }) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return null;
      }
      const send = async () =>
        updateExternalRuntimeRetention({
          baseUrl: bridgeUrl,
          conversationKey,
          scope,
          mountId,
          retain,
          probeId,
          providerSessionId:
            providerSessionId ||
            (retain
              ? await resolveClaudeProviderSessionHint(conversationKey, scope)
              : undefined),
        });
      // A retain can map the chat's session at the bridge again. Under the
      // conversation's lock it serializes with a reset: a reset after it
      // drops what it mapped, and a retain after a reset finds no session.
      return retain ? withConversationWriteLock(conversationKey, send) : send();
    },
    invalidateSession: ({ conversationKey, scope, metadata }) =>
      withConversationWriteLock(conversationKey, () =>
        invalidateSessionWithinWriteLock({
          conversationKey,
          scope,
          metadata,
        }),
      ),
    invalidateSessionWithinWriteLock,
    invalidateAllHotRuntimes: async () => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        conversationScopeByKey.clear();
        conversationContextSignature.clear();
        return null;
      }
      // Warm sessions live only in a running bridge.
      if (isManagedClaudeBridgeIdle(bridgeUrl)) {
        conversationScopeByKey.clear();
        conversationContextSignature.clear();
        return { invalidated: true };
      }
      const response = await claudeBridgeFetch(
        `${bridgeUrl}/invalidate-all-hot-runtimes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        throw new Error(
          `Failed to invalidate all hot runtimes (${response.status})`,
        );
      }
      conversationScopeByKey.clear();
      conversationContextSignature.clear();
      return { invalidated: true };
    },
    runExternalAction: async (name, input, opts = {}) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return {
          ok: false,
          error: "External backend bridge is not configured",
        };
      }
      const toolName = fromExternalActionName(name);
      if (!toolName) {
        return { ok: false, error: `Not an external action: ${name}` };
      }
      const tool = cachedTools.find((entry) => entry.name === toolName);
      const onProgress = opts.onProgress ?? (() => {});
      const actionConversationKey =
        typeof opts.conversationKey === "number" &&
        Number.isFinite(opts.conversationKey)
          ? Math.floor(opts.conversationKey)
          : Date.now();
      const actionGeneration =
        actionConversationKey > 0
          ? getConversationWriteGeneration(actionConversationKey)
          : 0;
      const actionScope = conversationScopeByKey.get(actionConversationKey);
      const actionCallId = `${toolName}:${Date.now()}:${++externalActionSequence}`;
      // Set when the host never let the action run at all — the user answered
      // the review card with No, or the conversation moved on first. That is a
      // different outcome from a run that was attempted and failed, and only
      // one of the two may claim an effect was even started.
      let cancelled = false;

      onProgress({
        type: "step_start",
        step: `Run ${toolName}`,
        index: 1,
        total: 1,
      });
      const doRun = async (
        approved = false,
      ): Promise<ActionResult<unknown>> => {
        if (
          actionConversationKey > 0 &&
          (areConversationWritesFrozen(actionConversationKey) ||
            !isConversationWriteGenerationCurrent(
              actionConversationKey,
              actionGeneration,
            ))
        ) {
          cancelled = true;
          return {
            ok: false,
            error:
              "Conversation lifecycle changed before this action could execute",
          };
        }
        const providerIdentityStack = await buildClaudeProviderIdentityStack();
        const providerIdentity = hashProviderIdentityStack(
          providerIdentityStack,
        );
        const run = () =>
          runExternalBridgeAction(bridgeUrl, {
            conversationKey: actionConversationKey,
            toolName,
            args: input,
            libraryID: opts.libraryID,
            approved,
            metadata: {
              runType: "action",
              claudeConfigSource: getClaudeConfigSourcePref(),
              claudeSettingSources: getClaudeSettingSourcesByPref(),
              settingSources: getClaudeSettingSourcesCsvByPref(),
              ...buildAgentPermissionMetadata(),
              providerIdentity,
              providerIdentityStack,
              scopeType: actionScope?.scopeType,
              scopeId: actionScope?.scopeId,
              scopeLabel: actionScope?.scopeLabel,
            },
            onEvent: async (event) => {
              if (event.type === "status") {
                onProgress({ type: "status", message: event.text });
              }
            },
          });
        // A provider action that is already approved (or has no separate
        // confirmation phase) is serialized with Clear/deletion.  An
        // unapproved action that is expected to return `approval_required`
        // must not hold the conversation lock while the UI confirmation card
        // is waiting, otherwise Clear could never acquire the lock to cancel
        // it.
        const holdLifecycleLock =
          actionConversationKey > 0 &&
          (approved || tool?.requiresConfirmation !== true);
        const outcome = holdLifecycleLock
          ? await withConversationWriteLock(actionConversationKey, run)
          : await run();

        if (
          outcome.kind === "fallback" &&
          outcome.reason === "approval_required"
        ) {
          if (
            opts.confirmationMode === "native_ui" &&
            typeof opts.requestConfirmation === "function"
          ) {
            const requestId = `ext-confirm-${Date.now()}`;
            const riskLevel =
              tool?.riskLevel === "high" ||
              tool?.riskLevel === "medium" ||
              tool?.riskLevel === "low"
                ? tool.riskLevel
                : "high";
            const pendingAction: AgentPendingAction = {
              toolName,
              title: `Approve ${toolName}`,
              mode: "approval",
              confirmLabel: "Run",
              cancelLabel: "Cancel",
              description: `This action is marked as ${riskLevel} risk.`,
              fields: [],
            };
            onProgress({
              type: "confirmation_required",
              requestId,
              action: pendingAction,
            });
            const resolution = await opts.requestConfirmation(
              requestId,
              pendingAction,
            );
            if (
              actionConversationKey > 0 &&
              (areConversationWritesFrozen(actionConversationKey) ||
                !isConversationWriteGenerationCurrent(
                  actionConversationKey,
                  actionGeneration,
                ))
            ) {
              cancelled = true;
              return {
                ok: false,
                error: "Conversation lifecycle changed before action approval",
              };
            }
            if (!resolution.approved) {
              cancelled = true;
              return { ok: false, error: "User denied action" };
            }
            return doRun(true);
          }
          cancelled = true;
          return { ok: false, error: "Approval required" };
        }

        if (outcome.kind === "fallback") {
          return { ok: false, error: outcome.reason || "Action failed" };
        }
        return { ok: true, output: outcome.text };
      };

      const result = await doRun(false);
      // A `cc_tool::` action is Claude Code's own Write/Edit/Bash, run inside
      // the connected runtime. The host authorized it and can never re-read
      // what it did, so the receipt says exactly that and no more.
      const effect = describeClaudeRuntimeToolEffect(toolName, input);
      if (effect)
        await recordExternalRuntimeEffect({
          effect,
          outcome: result.ok ? "executed" : cancelled ? "declined" : "failed",
          callId: actionCallId,
          reason: result.ok ? undefined : result.error,
          conversationKey: actionConversationKey,
        });
      onProgress({
        type: "step_done",
        step: `Run ${toolName}`,
        summary: result.ok ? "Completed" : `Failed: ${result.error}`,
      });
      return result;
    },
    runTurn: (rawParams: RunTurnParams): Promise<AgentRuntimeOutcome> =>
      runExternalRuntimeTurn(rawParams, {
        coreRuntime,
        transport: claudeBridgeTransport,
      }),
  };
}
