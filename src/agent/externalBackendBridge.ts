import { config } from "../../package.json";
import {
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_PAPER_CONTEXTS,
} from "../shared/contextLimits";
import {
  getClaudeBridgeUrl,
  getClaudeCustomInstructionPref,
  getConversationSystemPref,
} from "../claudeCode/prefs";
import {
  fetchClaudeModelCatalog,
  type ClaudeModelCatalog,
  type ClaudeModelCatalogRequestContext,
} from "../claudeCode/modelCatalog";
import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import { buildScopedConversationKey } from "../shared/conversationScopedKey";
import { getClaudeConversationSummary } from "../claudeCode/store";
import { hasPendingEmptyClaudeCleanupJob } from "../core/conversations/conversationCleanupJobs";
import { isNativeZoteroMcpToolsEnabled } from "../codexAppServer/prefs";
import {
  normalizeAgentPermissionMode,
  type AgentPermissionMode,
} from "../shared/agentPermissionMode";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  buildClaudeZoteroMcpServerConfig,
  preflightCodexZoteroMcpServer,
  REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES,
  REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
} from "../codexAppServer/mcpSetup";
import { dbg, dbgError } from "../utils/debugLogger";
import { buildNotesDirectoryConfigSection } from "../utils/notesDirectoryConfig";
import type { AgentRuntime } from "./runtime";
import {
  addZoteroMcpConfirmationHandler,
  addZoteroMcpToolActivityObserver,
  registerScopedZoteroMcpScope,
  setActiveZoteroMcpScope,
  type ZoteroMcpActiveScope,
  type ZoteroMcpToolActivityEvent,
} from "./mcp/server";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
} from "./store/traceStore";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { AGENT_PERSONA_INSTRUCTIONS } from "./model/agentPersona";
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
import { resolveAgentRuntimeRequest } from "./context/resolvedAgentRequest";
import type {
  LocalDocumentResource,
  NoteContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
} from "../shared/types";
import { synthesizeSelectedTextContexts } from "../modules/contextPanel/normalizers";
import { formatSelectedTextLocator } from "../modules/contextPanel/selectedTextAnchorFormatting";
import {
  buildTurnContextEnvelope,
  renderTurnContextEnvelopeForModel,
} from "./context/turnContextEnvelope";
import {
  getActiveTurnPaper,
  getSelectedPassagePaper,
  listTurnPapersWithRoles,
  type TurnPaperRole,
} from "./context/turnPaperScope";
import { validateLocalPdfDocumentBatch } from "./context/localDocumentBatch";
import { RAW_PDF_TRANSPORT_POLICY_BLOCK } from "./context/rawPdfTransportPolicy";
import {
  AgentEventLocalDocumentStreamRedactor,
  acquireLocalDocumentPathLease,
  LocalDocumentPathStreamRedactor,
} from "./privacy/localDocumentPathRedaction";

export type RunTurnParams = {
  request: AgentRuntimeRequestInput;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
};

type ResolvedRunTurnParams = Omit<RunTurnParams, "request"> & {
  request: AgentRuntimeRequest;
};

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
  | "registerPendingConfirmation"
  | "resolveConfirmation"
  | "getRunTrace"
> & {
  getCapabilities(request: AgentRuntimeRequestInput): AgentModelCapabilities;
  runTurn(params: RunTurnParams): Promise<AgentRuntimeOutcome>;
  listExternalActionsSync(): Array<{
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
  listSlashCommandsSync(): Array<{
    name: string;
    description: string;
    argumentHint?: string;
    source: "sdk" | "fallback";
  }>;
  refreshSlashCommands(force?: boolean): Promise<void>;
  listEfforts(
    model?: string,
    context?: ClaudeModelCatalogRequestContext,
  ): Promise<string[]>;
  listModels(
    force?: boolean,
    context?: ClaudeModelCatalogRequestContext,
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

type BridgeLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "outcome"; outcome: AgentRuntimeOutcome }
  | { type: "error"; error: string };

function makeProfilingEvent(
  stage: string,
  payload?: Record<string, unknown>,
): AgentEvent {
  return {
    type: "provider_event",
    providerType: "profiling",
    ts: Date.now(),
    payload: {
      stage,
      ...(payload || {}),
    },
  };
}

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
  visibleContext?: string;
  selectedTexts: Array<{
    source: string;
    text: string;
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

type BridgeCollectionContext = {
  collectionId?: number;
  name?: string;
  libraryID?: number;
};

type BridgeTagContext = {
  name?: string;
  libraryID?: number;
  normalizedName?: string;
  scope?: "allTagged" | "untagged";
  includeAutomatic?: boolean;
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
  let hash = 2166136261;
  const input = stack.join("\n");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
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
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: unknown[];
  selectedTextNoteContexts?: NoteContextRef[];
  selectedPaperContexts?: BridgePaperContext[];
  fullTextPaperContexts?: BridgePaperContext[];
  pinnedPaperContexts?: BridgePaperContext[];
  selectedCollectionContexts?: BridgeCollectionContext[];
  selectedTagContexts?: BridgeTagContext[];
  localDocuments?: readonly LocalDocumentResource[];
  attachments?: BridgeAttachment[];
  screenshots?: string[];
  history?: Array<{ role: string; content: string }>;
  activeNoteContext?: {
    noteId: number;
    title: string;
    noteKind: string;
    parentItemId?: number;
    noteText?: string;
  };
};

function requestPaperRefs(
  request: AgentRuntimeRequest,
  roles: readonly TurnPaperRole[],
): PaperContextRef[] {
  return [...listTurnPapersWithRoles(request.turnPaperScope, roles)];
}

function requestLocalDocuments(
  request: AgentRuntimeRequest,
): readonly LocalDocumentResource[] {
  return (request.localDocuments || []).map((entry) => entry.resource);
}

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
  const response = await fetch(getBridgeHealthUrl(baseUrl));
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

export function supportsClaudeBridgeLocalPdfPathsForTests(
  payload: unknown,
): boolean {
  return supportsClaudeBridgeLocalPdfPaths(payload);
}

export function getBridgeQuickFixHint(baseUrl?: string): string {
  const healthUrl = getBridgeHealthUrl(baseUrl);
  return `Bridge not running. Try: launchctl stop com.toha.ccbridge && launchctl start com.toha.ccbridge ; curl -fsS ${healthUrl}`;
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

function getClaudeSettingSourcesCsvByPref(): string {
  return getClaudeSettingSourcesByPref().join(",");
}

function getAgentPermissionModePref(): AgentPermissionMode {
  try {
    const raw = Zotero.Prefs.get(
      `${config.prefsPrefix}.agentPermissionMode`,
      true,
    );
    return normalizeAgentPermissionMode(raw);
  } catch {
    return "safe";
  }
}

function buildAgentPermissionMetadata(): {
  permissionMode: AgentPermissionMode;
  allowDangerouslySkipPermissions?: true;
} {
  const permissionMode = getAgentPermissionModePref();
  if (permissionMode === "yolo") {
    return {
      permissionMode,
      allowDangerouslySkipPermissions: true,
    };
  }
  return { permissionMode };
}

function buildOriginalAgentModeInstructionBlock(): string {
  return [
    "## Original agent-mode Zotero behavior",
    ...AGENT_PERSONA_INSTRUCTIONS,
  ].join("\n\n");
}

function buildClaudeBridgeNotesDirectoryInstruction(): string {
  const configSection = buildNotesDirectoryConfigSection().trim();
  if (!configSection) return "";
  return [
    configSection,
    "Claude Code note-directory rules:",
    "- The notes directory is already configured by the user. Do not use Bash, Glob, Find, LS, or Read to rediscover the vault path, inspect likely note folders, or probe write access when this section is present.",
    "- When the user asks to save a file-based note into the configured notes directory, use the configured Default target path unless the user explicitly names a different folder or absolute path.",
    "- Do not create a Papers, papers, Notes, or other alternate subfolder unless the user explicitly requested that exact folder.",
    "- If using Claude Code's Write tool for a Markdown note, pass a `.md` file path under the configured Default target path. Use the configured Attachments path for copied figure or image assets.",
  ].join("\n");
}

function buildClaudeBridgeCustomInstruction(
  options: {
    rawPdfMode?: boolean;
  } = {},
): string {
  return [
    getClaudeCustomInstructionPref(),
    buildOriginalAgentModeInstructionBlock(),
    options.rawPdfMode
      ? "Claude Code receives Zotero MCP access for metadata and write operations. For raw-PDF identities, use the exact current-turn local paths instead of Zotero paper-content retrieval."
      : "Claude Code receives Zotero access through the scoped MCP tools for this turn. When those tools are available, use library_search, library_retrieve, library_read, and paper_read for Zotero library or paper-content questions before relying on filesystem exploration or conversation-visible snippets. Use zotero_script for Zotero-native API inspection or scripted library operations only when the semantic Zotero tools cannot cover the request.",
    'If the turn includes selected collection or tag scopes, resolve phrases like "this folder", "this collection", "inside this folder", and "this tag" against those selected Zotero scopes. Do not ask the user which folder or tag they mean unless no selected scope is present or multiple selected scopes make the reference genuinely ambiguous.',
    buildClaudeBridgeNotesDirectoryInstruction(),
    options.rawPdfMode ? RAW_PDF_TRANSPORT_POLICY_BLOCK : "",
  ]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function buildClaudeBridgeCustomInstructionForTests(
  rawPdfMode = false,
): string {
  return buildClaudeBridgeCustomInstruction({ rawPdfMode });
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

function isClaudeBridgeActive(): boolean {
  return (
    getConversationSystemPref() === "claude_code" && isClaudeCodeModeEnabled()
  );
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

function normalizeScopeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
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
  const explicitId = normalizeScopeId(
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
  const response = await fetch(`${normalized}/runtime-retention`, {
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
  const response = await fetch(`${normalized}/invalidate-session`, {
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

async function runExternalBridgeTurn(
  baseUrl: string,
  params: ResolvedRunTurnParams & {
    contextEnvelope?: ContextEnvelope;
    runtimeRequest?: BridgeRuntimeRequest;
    allowedTools?: string[];
    mcpServers?: ClaudeMcpServersConfig;
    scope?: BridgeScope;
    registerPendingConfirmation?: (
      requestId: string,
      resolve: (resolution: AgentConfirmationResolution) => void,
    ) => void;
    resolveExternalConfirmation?: ResolveExternalConfirmation;
  },
): Promise<AgentRuntimeOutcome> {
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

  const userTextRaw = params.request.userText || "";
  const probeMatch = userTextRaw.match(
    /^\s*\/(?:debug-)?permission-probe\b\s*(.*)$/i,
  );
  const probeRequested = Boolean(probeMatch && debugModeEnabled);
  const probeStrippedText = probeMatch?.[1]?.trim() || "";
  const userTextForBridge = probeRequested
    ? probeStrippedText || "Permission probe run."
    : userTextRaw;

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
      customInstruction: buildClaudeBridgeCustomInstruction({
        rawPdfMode: requestLocalDocuments(params.request).length > 0,
      }),
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }

  let finalOutcome: AgentRuntimeOutcome | null = null;
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

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
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
  const userLibraryId = normalizePositiveInt(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
  return (
    normalizePositiveInt(request.libraryID) ||
    normalizePositiveInt(request.item?.libraryID) ||
    selectedCollectionLibraryId ||
    selectedTagLibraryId ||
    userLibraryId
  );
}

function buildClaudeZoteroMcpScope(
  request: AgentRuntimeRequest,
  profileSignature: string,
): ZoteroMcpActiveScope {
  const selectedPaper =
    getActiveTurnPaper(request.turnPaperScope) ||
    request.turnPaperScope.papers[0]?.paper;
  const kind = request.conversationKind === "paper" ? "paper" : "global";
  const activeItemId =
    normalizePositiveInt(request.activeItemId) ||
    normalizePositiveInt(request.item?.id) ||
    selectedPaper?.itemId;
  const activeNote = request.activeNoteContext;
  const paperItemID =
    kind === "paper" ? selectedPaper?.itemId || activeItemId : undefined;
  const libraryID = resolveFallbackLibraryId(request);
  return {
    profileSignature,
    conversationKey: normalizePositiveInt(request.conversationKey),
    libraryID,
    kind,
    paperItemID,
    activeItemId: paperItemID || activeItemId,
    activeContextItemId: selectedPaper?.contextItemId,
    activeNoteId: normalizePositiveInt(activeNote?.noteId),
    activeNoteKind:
      activeNote?.noteKind === "item" || activeNote?.noteKind === "standalone"
        ? activeNote.noteKind
        : undefined,
    activeNoteTitle: activeNote?.title,
    activeNoteParentItemId: normalizePositiveInt(activeNote?.parentItemId),
    libraryName: resolveLibraryName(libraryID),
    title: selectedPaper?.title,
    userText: request.userText,
    exhaustiveReadBackend: "unavailable",
    turnPaperScope: request.turnPaperScope,
    turnPaperScopeWarnings: request.turnPaperScopeWarnings,
  };
}

function buildClaudeMcpToolActivityEvent(
  event: ZoteroMcpToolActivityEvent,
): AgentEvent {
  return {
    type: "codex_tool_activity",
    itemId: `mcp:${event.requestId || `${event.toolName}:${event.timestamp}`}`,
    phase: event.phase,
    toolName: event.toolName,
    toolLabel: event.toolLabel,
    serverName: event.serverName,
    args: event.arguments,
    ok: event.ok,
    text: event.error,
    artifacts: event.artifacts,
  };
}

function normalizePaperContentSourceMode(
  value: unknown,
): PaperContentSourceMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "text":
    case "mineru":
    case "pdf":
    case "markdown":
    case "html":
    case "txt":
    case "docx":
      return normalized;
    default:
      return undefined;
  }
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
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    collectionId: number;
    name: string;
    libraryID: number;
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
    refs.push({
      collectionId,
      libraryID,
      name: trimText(record.name, 180) || `Collection ${collectionId}`,
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
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    name: string;
    libraryID: number;
    normalizedName?: string;
    scope?: "allTagged" | "untagged";
    includeAutomatic?: boolean;
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
    refs.push({
      name,
      libraryID,
      normalizedName: normalizedName || undefined,
      scope,
      includeAutomatic: includeAutomatic || undefined,
    });
    if (refs.length >= limit) break;
  }
  return refs;
}

function buildContextEnvelope(request: AgentRuntimeRequest): ContextEnvelope {
  const turnContextEnvelope = buildTurnContextEnvelope(request);
  const visibleContext =
    renderTurnContextEnvelopeForModel(turnContextEnvelope) || undefined;
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
    visibleContext,
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
    selectedTextContexts: Array.isArray(request.selectedTextContexts)
      ? request.selectedTextContexts
      : undefined,
    resolvedSelectedTextAnchors: Array.isArray(
      request.resolvedSelectedTextAnchors,
    )
      ? request.resolvedSelectedTextAnchors
      : undefined,
    selectedTexts: Array.isArray(request.selectedTexts)
      ? request.selectedTexts
      : undefined,
    selectedTextSources: Array.isArray(request.selectedTextSources)
      ? request.selectedTextSources
      : undefined,
    selectedTextNoteContexts: Array.isArray(request.selectedTextNoteContexts)
      ? request.selectedTextNoteContexts.filter(
          (entry): entry is NoteContextRef => Boolean(entry),
        )
      : undefined,
    selectedPaperContexts,
    fullTextPaperContexts,
    pinnedPaperContexts,
    selectedCollectionContexts: normalizeCollectionRefs(
      request.turnPaperScope.collections,
      20,
    ),
    selectedTagContexts: normalizeTagRefs(request.turnPaperScope.tags, 20),
    localDocuments: requestLocalDocuments(request).length
      ? requestLocalDocuments(request)
      : undefined,
    attachments: attachments.length ? attachments : undefined,
    screenshots: screenshots.length ? screenshots : undefined,
    activeNoteContext: request.activeNoteContext
      ? {
          noteId: request.activeNoteContext.noteId,
          title: request.activeNoteContext.title,
          noteKind: request.activeNoteContext.noteKind,
          parentItemId: request.activeNoteContext.parentItemId,
          noteText: request.activeNoteContext.noteText,
        }
      : undefined,
    history: Array.isArray(request.history)
      ? request.history.map((entry) => ({
          role: typeof entry.role === "string" ? entry.role : "user",
          content: typeof entry.content === "string" ? entry.content : "",
        }))
      : undefined,
  };
}

export function buildBridgeRuntimeRequestForTests(
  request: AgentRuntimeRequestInput,
): Promise<BridgeRuntimeRequest> {
  return buildBridgeRuntimeRequest(resolveAgentRuntimeRequest(request));
}

export function buildExternalBridgeContextEnvelopeForTests(
  request: AgentRuntimeRequestInput,
) {
  return buildContextEnvelope(resolveAgentRuntimeRequest(request));
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

export function buildExternalBridgeContextSignatureForTests(
  request: AgentRuntimeRequestInput,
): string {
  return signatureForContextEnvelope(
    buildContextEnvelope(resolveAgentRuntimeRequest(request)),
  );
}

async function fetchExternalTools(
  baseUrl: string,
  encodedSources: string,
): Promise<ExternalToolDescriptor[]> {
  const response = await fetch(
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
  const response = await fetch(
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
    const response = await fetch(
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
      const response = await fetch(url, {
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
): Promise<AgentRuntimeOutcome> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/run-action`, {
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
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  let finalOutcome: AgentRuntimeOutcome | null = null;
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

export function createExternalBackendBridgeRuntime(options: {
  coreRuntime: AgentRuntime;
  getBridgeUrl: () => string;
}): AgentRuntimeLike {
  const { coreRuntime, getBridgeUrl } = options;
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
        ztoolkit.log("LLM Agent: Failed to refresh external actions", error);
      } finally {
        refreshInFlight = null;
      }
    })();
    await refreshInFlight;
  };

  const listEfforts = async (
    model?: string,
    context?: ClaudeModelCatalogRequestContext,
  ): Promise<string[]> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl || !isClaudeBridgeActive()) {
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
  ): Promise<ClaudeModelCatalog> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl || !isClaudeBridgeActive()) {
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
        ztoolkit.log(
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
        ztoolkit.log(
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

  const listSlashCommandsSync = (): ExternalSlashCommandDescriptor[] => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    const hasBridge = !!bridgeUrl && isClaudeBridgeActive();
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
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approvedOrResolution, data) =>
      coreRuntime.resolveConfirmation(requestId, approvedOrResolution, data),
    getRunTrace: (runId: string) => coreRuntime.getRunTrace(runId),
    getCapabilities: (request) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl || !isClaudeBridgeActive()) {
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
    listExternalActionsSync: () => {
      if (!normalizeBaseUrl(getBridgeUrl()) || !isClaudeBridgeActive()) {
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
      return updateExternalRuntimeRetention({
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
      const response = await fetch(`${bridgeUrl}/invalidate-all-hot-runtimes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
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
              return {
                ok: false,
                error: "Conversation lifecycle changed before action approval",
              };
            }
            if (!resolution.approved) {
              return { ok: false, error: "User denied action" };
            }
            return doRun(true);
          }
          return { ok: false, error: "Approval required" };
        }

        if (outcome.kind === "fallback") {
          return { ok: false, error: outcome.reason || "Action failed" };
        }
        return { ok: true, output: outcome.text };
      };

      const result = await doRun(false);
      onProgress({
        type: "step_done",
        step: `Run ${toolName}`,
        summary: result.ok ? "Completed" : `Failed: ${result.error}`,
      });
      return result;
    },
    runTurn: async (rawParams: RunTurnParams): Promise<AgentRuntimeOutcome> => {
      const params: ResolvedRunTurnParams = {
        ...rawParams,
        request: resolveAgentRuntimeRequest(rawParams.request),
      };
      const requestMetadata =
        params.request.metadata && typeof params.request.metadata === "object"
          ? params.request.metadata
          : {};
      const conversationInstanceID =
        typeof requestMetadata.conversationInstanceID === "string"
          ? requestMetadata.conversationInstanceID.trim()
          : "";
      if (params.request.conversationKey > 0) {
        try {
          if (
            await hasPendingEmptyClaudeCleanupJob({
              conversationKey: params.request.conversationKey,
              ...(conversationInstanceID
                ? { instanceID: conversationInstanceID }
                : {}),
            })
          ) {
            // Clear may have had to defer an empty-session invalidation while
            // the catalog had no provider ID. Do not resume the old bridge
            // mapping; the adapter will invalidate it before starting fresh.
            params.request = {
              ...params.request,
              metadata: {
                ...requestMetadata,
                forceFreshSession: true,
              },
            };
          }
        } catch {
          // A pending empty-session cleanup is a deletion boundary, not an
          // advisory hint. If the cleanup table cannot be read, fail closed
          // by forcing a fresh provider session; reusing a hot mapping here
          // could resurrect the pre-Clear runtime while the durable worker
          // is still waiting to invalidate it.
          params.request = {
            ...params.request,
            metadata: {
              ...requestMetadata,
              forceFreshSession: true,
            },
          };
        }
      }
      validateLocalPdfDocumentBatch({
        pdfPaperContexts: requestPaperRefs(params.request, ["raw_pdf"]),
        localDocuments: requestLocalDocuments(params.request),
      });
      const pathLease = acquireLocalDocumentPathLease(
        params.request.conversationKey,
        requestLocalDocuments(params.request),
      );
      try {
        const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
        if (!bridgeUrl) {
          throw new Error(
            "Claude bridge URL is empty. Set Bridge URL to http://127.0.0.1:19787.",
          );
        }
        if (requestLocalDocuments(params.request).length) {
          await assertClaudeBridgeLocalPdfCapability(bridgeUrl);
        }
        const writeAllowed = () =>
          !areConversationWritesFrozen(params.request.conversationKey) &&
          (params.request.conversationGeneration === undefined ||
            isConversationWriteGenerationCurrent(
              params.request.conversationKey,
              params.request.conversationGeneration,
            ));
        const persistIfLive = async <T>(task: () => Promise<T>) => {
          if (!writeAllowed()) return undefined;
          return withConversationWriteLock(
            params.request.conversationKey,
            async () => {
              if (!writeAllowed()) return undefined;
              return task();
            },
          );
        };
        const notifyIfLive = async (event: AgentEvent): Promise<void> => {
          if (writeAllowed()) await params.onEvent?.(event);
        };
        let persistedRunId = "";
        let persistedRunCreated = false;
        let persistedSeq = 0;
        const pendingEventsBeforeRunId: AgentEvent[] = [];
        const eventStreamRedactor = new AgentEventLocalDocumentStreamRedactor(
          params.request.conversationKey,
        );
        const turnPathRedactor = new LocalDocumentPathStreamRedactor(
          params.request.conversationKey,
        );
        const ensurePersistedRun = async (runId: string): Promise<void> => {
          const normalized = (runId || "").trim();
          if (!normalized) return;
          if (!writeAllowed()) return;
          if (!persistedRunCreated || persistedRunId !== normalized) {
            persistedRunId = normalized;
            persistedSeq = 0;
            await persistIfLive(() =>
              createAgentRun({
                runId: persistedRunId,
                conversationKey: params.request.conversationKey,
                mode: "agent",
                model: params.request.model,
                status: "running",
                createdAt: Date.now(),
              }),
            );
            persistedRunCreated = writeAllowed();
            if (!persistedRunCreated) return;
            if (pendingEventsBeforeRunId.length) {
              for (const event of pendingEventsBeforeRunId.splice(0)) {
                persistedSeq += 1;
                await persistIfLive(() =>
                  appendAgentRunEvent(persistedRunId, persistedSeq, event),
                );
              }
            }
          }
        };
        const appendPersistedEvent = async (
          event: AgentEvent,
        ): Promise<void> => {
          const redactedEvent = turnPathRedactor.redactTerminalValue(event);
          if (!persistedRunCreated || !persistedRunId) {
            pendingEventsBeforeRunId.push(redactedEvent);
            return;
          }
          persistedSeq += 1;
          await persistIfLive(() =>
            appendAgentRunEvent(persistedRunId, persistedSeq, redactedEvent),
          );
        };
        await appendPersistedEvent(
          makeProfilingEvent("frontend.run_turn.enter"),
        );
        await notifyIfLive(makeProfilingEvent("frontend.run_turn.enter"));
        const contextEnvelope = buildContextEnvelope(params.request);
        await appendPersistedEvent(
          makeProfilingEvent("frontend.context_envelope.ready"),
        );
        await notifyIfLive(
          makeProfilingEvent("frontend.context_envelope.ready"),
        );
        const runtimeRequest = await buildBridgeRuntimeRequest(params.request);
        await appendPersistedEvent(
          makeProfilingEvent("frontend.bridge_runtime_request.ready"),
        );
        await notifyIfLive(
          makeProfilingEvent("frontend.bridge_runtime_request.ready"),
        );
        const scope = resolveBridgeScope(params.request);
        await withConversationWriteLock(
          params.request.conversationKey,
          async () => {
            if (!writeAllowed()) {
              throw new Error("Conversation write generation changed");
            }
            rememberLastRunBridgeContext(params.request.conversationKey, scope);
            if (isBridgeDebugEnabled()) {
              dbg("run-turn scope snapshot", {
                conversationKey: params.request.conversationKey,
                scopeType: scope.scopeType,
                scopeId: scope.scopeId,
                scopeLabel: scope.scopeLabel,
                scopedConversationKey: buildScopedConversationKey(
                  params.request.conversationKey,
                  scope,
                ),
              });
            }
            conversationScopeByKey.set(params.request.conversationKey, scope);
            const currentSignature =
              signatureForContextEnvelope(contextEnvelope);
            conversationContextSignature.set(
              params.request.conversationKey,
              currentSignature,
            );
          },
        );
        const emitTurnEvent = async (event: AgentEvent): Promise<void> => {
          for (const redactedEvent of eventStreamRedactor.process(event)) {
            await appendPersistedEvent(redactedEvent);
            await notifyIfLive(redactedEvent);
          }
        };
        let mcpServers: ClaudeMcpServersConfig | undefined;
        let allowedTools: string[] | undefined;
        let clearScopedMcpScope: () => void = () => undefined;
        let clearActiveMcpScope: () => void = () => undefined;
        let clearMcpConfirmationHandler: () => void = () => undefined;
        let unregisterMcpToolActivity: () => void = () => undefined;
        try {
          if (isNativeZoteroMcpToolsEnabled()) {
            const rawPdfMode = requestLocalDocuments(params.request).length > 0;
            const profileSignature = getClaudeProfileSignature();
            const mcpScope = buildClaudeZoteroMcpScope(
              params.request,
              profileSignature,
            );
            const scopedMcp = registerScopedZoteroMcpScope(mcpScope);
            clearScopedMcpScope = scopedMcp.clear;
            clearActiveMcpScope = setActiveZoteroMcpScope(mcpScope);
            clearMcpConfirmationHandler = addZoteroMcpConfirmationHandler(
              mcpScope,
              async ({ requestId, action }) => {
                const resolution = new Promise<AgentConfirmationResolution>(
                  (resolve) => {
                    coreRuntime.registerPendingConfirmation(requestId, resolve);
                  },
                );
                await emitTurnEvent({
                  type: "confirmation_required",
                  requestId,
                  action,
                });
                const settled = await resolution;
                await emitTurnEvent({
                  type: "confirmation_resolved",
                  requestId,
                  approved: settled.approved,
                  actionId: settled.actionId,
                  data: settled.data,
                });
                return settled;
              },
            );
            unregisterMcpToolActivity = addZoteroMcpToolActivityObserver(
              (event) => {
                const sameConversation =
                  !event.conversationKey ||
                  event.conversationKey === params.request.conversationKey;
                const sameProfile =
                  !event.profileSignature ||
                  !profileSignature ||
                  event.profileSignature === profileSignature;
                if (!sameConversation || !sameProfile) return;
                void emitTurnEvent(buildClaudeMcpToolActivityEvent(event));
              },
            );
            const mcpConfig = buildClaudeZoteroMcpServerConfig({
              profileSignature,
              scopeToken: scopedMcp.token,
              required: true,
              rawPdfMode,
            });
            const mcpStatus = await preflightCodexZoteroMcpServer({
              serverName: mcpConfig.serverName,
              scopeToken: scopedMcp.token,
              required: true,
              rawPdfMode,
            });
            assertRequiredCodexZoteroMcpToolsReady(
              mcpStatus,
              rawPdfMode
                ? REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES
                : REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
            );
            mcpServers = mcpConfig.mcpServers;
            allowedTools = mcpConfig.allowedTools;
            await emitTurnEvent(
              makeProfilingEvent("frontend.zotero_mcp.ready", {
                serverName: mcpConfig.serverName,
                toolNames: mcpStatus.toolNames,
              }),
            );
          }
          const outcome = await runExternalBridgeTurn(bridgeUrl, {
            ...params,
            onStart: async (runId) => {
              await ensurePersistedRun(runId);
              if (writeAllowed()) await params.onStart?.(runId);
            },
            onEvent: emitTurnEvent,
            contextEnvelope,
            runtimeRequest,
            allowedTools,
            mcpServers,
            scope,
            registerPendingConfirmation: (requestId, resolve) =>
              coreRuntime.registerPendingConfirmation(requestId, resolve),
            resolveExternalConfirmation: async (requestId, resolution) => {
              const response = await fetch(
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
              const payload = (await response
                .json()
                .catch(() => ({}))) as Record<string, unknown>;
              const accepted = Boolean(payload.ok);
              return {
                ok: response.ok && accepted,
                requestId,
                httpStatus: response.status,
                accepted,
                source:
                  typeof payload.source === "string"
                    ? payload.source
                    : undefined,
                pendingPermissionCount:
                  typeof payload.pendingPermissionCount === "number"
                    ? payload.pendingPermissionCount
                    : undefined,
                recentPendingRequestIds: Array.isArray(
                  payload.recentPendingRequestIds,
                )
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
            },
          });
          for (const redactedEvent of eventStreamRedactor.flush()) {
            await appendPersistedEvent(redactedEvent);
            await notifyIfLive(redactedEvent);
          }
          const safeOutcome: AgentRuntimeOutcome =
            outcome.kind === "completed"
              ? {
                  ...outcome,
                  text: turnPathRedactor.redactTerminalText(outcome.text),
                }
              : {
                  ...outcome,
                  reason: turnPathRedactor.redactTerminalText(outcome.reason),
                };
          const finalRunId = persistedRunId || safeOutcome.runId;
          if (finalRunId) {
            await ensurePersistedRun(finalRunId);
            await persistIfLive(() =>
              finishAgentRun(
                finalRunId,
                safeOutcome.kind === "completed" ? "completed" : "failed",
                safeOutcome.kind === "completed"
                  ? safeOutcome.text
                  : safeOutcome.reason,
              ),
            );
          }
          return safeOutcome;
        } catch (error) {
          if (persistedRunId) {
            await persistIfLive(() =>
              finishAgentRun(
                persistedRunId,
                "failed",
                turnPathRedactor.redactTerminalText(
                  error instanceof Error ? error.message : String(error),
                ),
              ),
            );
          }
          const rawErrorMessage =
            error instanceof Error ? error.message : String(error);
          const safeErrorMessage =
            turnPathRedactor.redactTerminalText(rawErrorMessage);
          const safeError =
            error instanceof Error
              ? new Error(safeErrorMessage)
              : safeErrorMessage;
          const message = turnPathRedactor.redactTerminalText(
            formatBridgeUserError(
              safeError,
              bridgeUrl,
              "External agent backend unavailable",
            ),
          );
          const fallbackRunId = persistedRunId || `bridge-error-${Date.now()}`;
          if (!persistedRunCreated) {
            await ensurePersistedRun(fallbackRunId);
            if (writeAllowed()) await params.onStart?.(fallbackRunId);
          }
          const statusEvent: AgentEvent = {
            type: "status",
            text: message,
          };
          await appendPersistedEvent(statusEvent);
          await notifyIfLive(statusEvent);
          const fallbackEvent: AgentEvent = {
            type: "fallback",
            reason: message,
          };
          await appendPersistedEvent(fallbackEvent);
          await notifyIfLive(fallbackEvent);
          await persistIfLive(() =>
            finishAgentRun(fallbackRunId, "failed", message),
          );
          if (
            typeof ztoolkit !== "undefined" &&
            typeof ztoolkit.log === "function"
          ) {
            ztoolkit.log("LLM Agent: External bridge unavailable", message);
          }
          throw new Error(message);
        } finally {
          unregisterMcpToolActivity();
          clearMcpConfirmationHandler();
          clearActiveMcpScope();
          clearScopedMcpScope();
        }
      } finally {
        pathLease.release();
      }
    },
  };
}
