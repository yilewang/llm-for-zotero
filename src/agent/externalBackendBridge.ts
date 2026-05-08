import { config } from "../../package.json";
import {
  getClaudeBridgeUrl,
  getClaudeCustomInstructionPref,
  getConversationSystemPref,
} from "../claudeCode/prefs";
import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import { getClaudeConversationSummary } from "../claudeCode/store";
import { dbg, dbgError } from "../utils/debugLogger";
import type { AgentRuntime } from "./runtime";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
} from "./store/traceStore";
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
} from "./types";

export type RunTurnParams = {
  request: AgentRuntimeRequest;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
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
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities;
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
  listEfforts(model?: string): Promise<string[]>;
  updateRuntimeRetention(params: {
    conversationKey: number;
    scope?: BridgeScope;
    mountId: string;
    retain: boolean;
    probeId?: string;
    providerSessionId?: string;
  }): Promise<RuntimeRetentionResponse | null>;
  invalidateSession(params: {
    conversationKey: number;
    scope?: BridgeScope;
    metadata?: Record<string, unknown>;
  }): Promise<SessionInvalidationResponse | null>;
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

function makeProfilingEvent(stage: string, payload?: Record<string, unknown>): AgentEvent {
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
  fullTextPaperCount: number;
  pinnedPaperCount: number;
  attachmentCount: number;
  screenshotCount: number;
  selectedTexts: Array<{
    source: string;
    text: string;
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
  mineruCacheDir?: string;
  mineruFullMdPath?: string;
  contextFilePath?: string;
};

type BridgeCollectionContext = {
  collectionId?: number;
  name?: string;
  libraryID?: number;
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
  selectedTexts?: string[];
  selectedTextSources?: unknown[];
  selectedPaperContexts?: BridgePaperContext[];
  fullTextPaperContexts?: BridgePaperContext[];
  pinnedPaperContexts?: BridgePaperContext[];
  selectedCollectionContexts?: BridgeCollectionContext[];
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

const lastRunBridgeContextByConversationKey = new Map<number, LastRunBridgeContext>();

function isBridgeDebugEnabled(): boolean {
  return false;
}

function buildScopedConversationKey(
  conversationKey: number,
  scope?: { scopeType?: string; scopeId?: string },
): string {
  if (!scope?.scopeType || !scope.scopeId) {
    return String(conversationKey);
  }
  return `${conversationKey}::${scope.scopeType}:${scope.scopeId}`;
}

async function resolveClaudeProviderSessionHint(
  conversationKey: number,
  scope?: BridgeScope,
): Promise<string | undefined> {
  const summary = await getClaudeConversationSummary(conversationKey).catch(() => null);
  const providerSessionId = summary?.providerSessionId?.trim();
  if (!summary || !providerSessionId) return undefined;
  const expectedScopedConversationKey = buildScopedConversationKey(conversationKey, scope);
  if (
    summary.scopedConversationKey &&
    summary.scopedConversationKey !== expectedScopedConversationKey
  ) {
    return undefined;
  }
  if (scope) {
    if (summary.scopeType !== scope.scopeType || summary.scopeId !== scope.scopeId) {
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

function getLastRunBridgeContext(conversationKey: number): LastRunBridgeContext | undefined {
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
      Zotero.Prefs.get(
        `${config.prefsPrefix}.agentClaudeConfigSource`,
        true,
      ) || "",
    )
      .trim()
      .toLowerCase();
    if (raw === "user-level" || raw === "user-only") return "user-only";
    if (raw === "zotero-specific" || raw === "zotero-only") return "zotero-only";
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

function getAgentPermissionModePref(): "safe" | "yolo" {
  try {
    const raw = Zotero.Prefs.get(
      `${config.prefsPrefix}.agentPermissionMode`,
      true,
    );
    return raw === "yolo" ? "yolo" : "safe";
  } catch {
    return "safe";
  }
}

function buildAgentPermissionMetadata(): {
  permissionMode: "safe" | "yolo";
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

function isClaudeCodeModeEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get(`${config.prefsPrefix}.enableClaudeCodeMode`, true);
    return enabled === true || `${enabled || ""}`.toLowerCase() === "true";
  } catch {
    return false;
  }
}

function isClaudeBridgeActive(): boolean {
  return getConversationSystemPref() === "claude_code" && isClaudeCodeModeEnabled();
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

function resolvePaperScopeFromRequest(request: AgentRuntimeRequest): BridgeScope | null {
  const libraryID =
    typeof request.libraryID === "number" && Number.isFinite(request.libraryID)
      ? Math.floor(request.libraryID)
      : undefined;

  let paperItemId: number | undefined;
  const fromActiveItem =
    typeof request.activeItemId === "number" && Number.isFinite(request.activeItemId)
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
    const allRefs = [
      ...(Array.isArray(request.selectedPaperContexts)
        ? request.selectedPaperContexts
        : []),
      ...(Array.isArray(request.fullTextPaperContexts)
        ? request.fullTextPaperContexts
        : []),
      ...(Array.isArray(request.pinnedPaperContexts)
        ? request.pinnedPaperContexts
        : []),
    ];
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

  const titleItem = Zotero.Items.get(paperItemId);
  const scopeLabel =
    titleItem?.isRegularItem?.() && typeof titleItem.getField === "function"
      ? String(titleItem.getField("title") || "").trim() || undefined
      : undefined;

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
    typeof (request as unknown as { scopeLabel?: unknown }).scopeLabel === "string"
      ? String((request as unknown as { scopeLabel?: unknown }).scopeLabel).trim() || undefined
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
  params: RunTurnParams & {
    contextEnvelope?: ContextEnvelope;
    runtimeRequest?: BridgeRuntimeRequest;
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
  const probeMatch = userTextRaw.match(/^\s*\/(?:debug-)?permission-probe\b\s*(.*)$/i);
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
    scopeType: params.scope?.scopeType,
    scopeId: params.scope?.scopeId,
    scopeLabel: params.scope?.scopeLabel,
    runtimeRequest: params.runtimeRequest,
    metadata: {
      ...requestMetadata,
      runType: "chat",
      claudeConfigSource: getClaudeConfigSourcePref(),
      claudeSettingSources: getClaudeSettingSourcesByPref(),
      settingSources: getClaudeSettingSourcesCsvByPref(),
      ...buildAgentPermissionMetadata(),
      customInstruction: getClaudeCustomInstructionPref(),
      providerIdentity,
      providerIdentityStack,
      model:
        typeof params.request.model === "string" &&
        params.request.model.trim().toLowerCase() !== "default"
          ? params.request.model.trim()
          : undefined,
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
      await params.onEvent?.(makeProfilingEvent("frontend.bridge_stream.first_line"));
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
                      (result.errorMessage ? ` error=${result.errorMessage}` : ""),
                  });
                  await params.onEvent?.({
                    type: "status",
                    text: `confirm ${result.requestId} -> POST /resolve-confirmation -> HTTP ${result.httpStatus} -> accepted=${result.accepted}`,
                  });
                }
                if (!result.ok || !result.accepted) {
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
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
                  await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
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

function normalizePaperRefs(list: unknown, limit = 8): Array<{
  itemId: number;
  contextItemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemId = typeof record.itemId === "number" ? record.itemId : undefined;
    const contextItemId =
      typeof record.contextItemId === "number" ? record.contextItemId : undefined;
    const title = trimText(record.title, 180);
    if (!itemId || !contextItemId || !title) continue;
    refs.push({
      itemId,
      contextItemId,
      title,
      citationKey:
        typeof record.citationKey === "string" ? trimText(record.citationKey, 80) : undefined,
      firstCreator:
        typeof record.firstCreator === "string" ? trimText(record.firstCreator, 80) : undefined,
      year: typeof record.year === "string" ? trimText(record.year, 16) : undefined,
    });
    if (refs.length >= limit) break;
  }
  return refs;
}

function normalizeCollectionRefs(list: unknown, limit = 8): Array<{
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
      typeof record.collectionId === "number" ? Math.floor(record.collectionId) : 0;
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

function buildContextEnvelope(request: AgentRuntimeRequest): ContextEnvelope {
  const selectedTexts = Array.isArray(request.selectedTexts) ? request.selectedTexts : [];
  const selectedSources = Array.isArray(request.selectedTextSources)
    ? request.selectedTextSources
    : [];
  const selectedTextRows = selectedTexts.slice(0, 6).map((text, index) => ({
    source: typeof selectedSources[index] === "string" ? selectedSources[index] : "unknown",
    text: trimText(text, 280),
  })).filter((row) => row.text);
  const selectedPapers = normalizePaperRefs(request.selectedPaperContexts, 10);
  const fullTextPapers = normalizePaperRefs(request.fullTextPaperContexts, 8).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const pinnedPapers = normalizePaperRefs(request.pinnedPaperContexts, 8).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const selectedCollections = normalizeCollectionRefs(
    request.selectedCollectionContexts,
    8,
  );
  const attachments = (Array.isArray(request.attachments) ? request.attachments : [])
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
    selectedPaperCount: Array.isArray(request.selectedPaperContexts)
      ? request.selectedPaperContexts.length
      : 0,
    selectedCollectionCount: Array.isArray(request.selectedCollectionContexts)
      ? request.selectedCollectionContexts.length
      : 0,
    fullTextPaperCount: Array.isArray(request.fullTextPaperContexts)
      ? request.fullTextPaperContexts.length
      : 0,
    pinnedPaperCount: Array.isArray(request.pinnedPaperContexts)
      ? request.pinnedPaperContexts.length
      : 0,
    attachmentCount: Array.isArray(request.attachments) ? request.attachments.length : 0,
    screenshotCount: Array.isArray(request.screenshots) ? request.screenshots.length : 0,
    selectedTexts: selectedTextRows,
    selectedPapers,
    selectedCollections,
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
        attachment as unknown as { getFilePathAsync?: () => Promise<string | false> }
      ).getFilePathAsync?.();
      const directPath =
        typeof asyncPath === "string" && asyncPath.trim()
          ? asyncPath.trim()
          : typeof (attachment as { getFilePath?: () => string | undefined }).getFilePath ===
              "function"
            ? (attachment as { getFilePath: () => string | undefined }).getFilePath()
            : (attachment as unknown as { attachmentPath?: string }).attachmentPath;
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
      if (contentType === "text/markdown" || pathHint.endsWith(".md")) return 100;
      if (contentType === "application/pdf" || pathHint.endsWith(".pdf")) return 90;
      if (contentType === "text/html" || pathHint.endsWith(".html") || pathHint.endsWith(".htm")) return 80;
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

  const attachments = (Array.isArray(request.attachments)
    ? request.attachments
    : []
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
    ? request.screenshots.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  const [selectedPaperContexts, fullTextPaperContexts, pinnedPaperContexts] =
    await Promise.all([
      enrichPaperContexts(request.selectedPaperContexts),
      enrichPaperContexts(request.fullTextPaperContexts),
      enrichPaperContexts(request.pinnedPaperContexts),
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
    selectedTexts: Array.isArray(request.selectedTexts) ? request.selectedTexts : undefined,
    selectedTextSources: Array.isArray(request.selectedTextSources)
      ? request.selectedTextSources
      : undefined,
    selectedPaperContexts,
    fullTextPaperContexts,
    pinnedPaperContexts,
    selectedCollectionContexts: normalizeCollectionRefs(
      request.selectedCollectionContexts,
      20,
    ),
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

function signatureForContextEnvelope(envelope: ContextEnvelope): string {
  return JSON.stringify({
    activeItemId: envelope.activeItemId,
    libraryID: envelope.libraryID,
    selectedTextCount: envelope.selectedTextCount,
    selectedPaperCount: envelope.selectedPaperCount,
    selectedCollectionCount: envelope.selectedCollectionCount,
    fullTextPaperCount: envelope.fullTextPaperCount,
    pinnedPaperCount: envelope.pinnedPaperCount,
    attachmentCount: envelope.attachmentCount,
    screenshotCount: envelope.screenshotCount,
    selectedPaperIds: envelope.selectedPapers.map((paper) => paper.contextItemId).sort(),
    selectedCollectionIds: envelope.selectedCollections.map((collection) => collection.collectionId).sort(),
    fullTextPaperIds: envelope.fullTextPapers.map((paper) => paper.contextItemId).sort(),
    pinnedPaperIds: envelope.pinnedPapers.map((paper) => paper.contextItemId).sort(),
    selectedTextFingerprints: envelope.selectedTexts.map((row) => row.text.slice(0, 80)),
    activeNoteId: envelope.activeNote?.noteId,
  });
}

async function fetchExternalTools(
  baseUrl: string,
  encodedSources: string,
): Promise<ExternalToolDescriptor[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/tools?settingSources=${encodedSources}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = await response.json() as { tools?: unknown[] };
  const rawTools = Array.isArray(json.tools) ? json.tools : [];
  const tools: ExternalToolDescriptor[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.trim()) continue;
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : tool.name,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as object)
          : { type: "object", properties: {} },
      mutability: tool.mutability === "write" ? "write" : "read",
      riskLevel:
        tool.riskLevel === "high" || tool.riskLevel === "medium" || tool.riskLevel === "low"
          ? tool.riskLevel
          : "medium",
      requiresConfirmation: Boolean(tool.requiresConfirmation),
      source:
        tool.source === "claude-runtime" || tool.source === "mcp" || tool.source === "zotero-bridge"
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
): Promise<ExternalEffortInfo> {
  const modelParam = model?.trim() ? `&model=${encodeURIComponent(model.trim())}` : "";
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/efforts?settingSources=${encodedSources}${modelParam}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = await response.json() as { efforts?: unknown[] };
  return {
    efforts: Array.isArray(json.efforts)
      ? json.efforts.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

async function fetchExternalCommands(
  baseUrl: string,
  encodedSources: string,
): Promise<ExternalSlashCommandDescriptor[]> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/commands?settingSources=${encodedSources}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}`);
    }
    const json = await response.json() as { commands?: unknown[] };
    const rawCommands = Array.isArray(json.commands) ? json.commands : [];
    const commands: ExternalSlashCommandDescriptor[] = [];
    for (const raw of rawCommands) {
      if (!raw || typeof raw !== "object") continue;
      const command = raw as Record<string, unknown>;
      const name = typeof command.name === "string" ? command.name.trim().replace(/^\/+/, "") : "";
      if (!name) continue;
      commands.push({
        name,
        description:
          typeof command.description === "string" && command.description.trim()
            ? command.description.trim()
            : `Claude Code slash command: /${name}`,
        argumentHint:
          typeof command.argumentHint === "string" ? command.argumentHint.trim() : "",
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
    source: "last_run_snapshot" | "runtime_scope" | "scope_no_label" | "conversation_only";
  }> = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: {
    scopeType?: BridgeScopeType;
    scopeId?: string;
    scopeLabel?: string;
    source: "last_run_snapshot" | "runtime_scope" | "scope_no_label" | "conversation_only";
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
          queryScopedConversationKey: buildScopedConversationKey(conversationKey, candidate),
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
  const SLASH_COMMANDS_CACHE_TTL_MS = 5 * 60_000;
  const conversationContextSignature = new Map<number, string>();
  const conversationScopeByKey = new Map<number, BridgeScope>();
  const TOOL_CACHE_TTL_MS = 5 * 60_000;
  let lastCapabilityConfigKey = "";

  const resolveCapabilityConfigKey = (): string => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    const source = getClaudeConfigSourcePref();
    const settingSources = getClaudeSettingSourcesCsvByPref();
    return `${bridgeUrl}|${source}|${settingSources}`;
  };

  const refreshExternalActions = async (force = false): Promise<void> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl) {
      cachedTools = [];
      cacheExpiresAt = 0;
      cachedSlashCommands = [];
      slashCommandsCacheExpiresAt = 0;
      cachedEffortsByModel.clear();
      lastCapabilityConfigKey = "";
      return;
    }
    const configKey = resolveCapabilityConfigKey();
    if (configKey !== lastCapabilityConfigKey) {
      force = true;
      cachedTools = [];
      cacheExpiresAt = 0;
      cachedSlashCommands = [];
      slashCommandsCacheExpiresAt = 0;
      cachedEffortsByModel.clear();
      lastCapabilityConfigKey = configKey;
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
        const encodedSources = encodeURIComponent(getClaudeSettingSourcesByPref().join(","));
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

  const listEfforts = async (model?: string): Promise<string[]> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl || !isClaudeBridgeActive()) {
      return [];
    }
    const configKey = resolveCapabilityConfigKey();
    if (configKey !== lastCapabilityConfigKey) {
      cachedTools = [];
      cacheExpiresAt = 0;
      cachedSlashCommands = [];
      slashCommandsCacheExpiresAt = 0;
      cachedEffortsByModel.clear();
      lastCapabilityConfigKey = configKey;
    }
    const key = `${configKey}|${(model || "").trim().toLowerCase()}`;
    if (cachedEffortsByModel.has(key)) {
      return cachedEffortsByModel.get(key)?.efforts || [];
    }
    const encodedSources = encodeURIComponent(getClaudeSettingSourcesByPref().join(","));
    const info = await fetchExternalEfforts(bridgeUrl, encodedSources, model);
    cachedEffortsByModel.set(key, info);
    return info.efforts;
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
      cachedSlashCommands = [];
      slashCommandsCacheExpiresAt = 0;
      cachedEffortsByModel.clear();
      lastCapabilityConfigKey = "";
      return;
    }
    if (!force && Date.now() < slashCommandsCacheExpiresAt && cachedSlashCommands.length > 0) {
      dbg("refreshSlashCommands: using cached", { count: cachedSlashCommands.length });
      return;
    }
    if (slashCommandsRefreshInFlight) {
      dbg("refreshSlashCommands: waiting for in-flight");
      await slashCommandsRefreshInFlight;
      return;
    }
    slashCommandsRefreshInFlight = (async () => {
      try {
        const encodedSources = encodeURIComponent(getClaudeSettingSourcesByPref().join(","));
        dbg("refreshSlashCommands: fetching from adapter", { bridgeUrl });
        cachedSlashCommands = await fetchExternalCommands(bridgeUrl, encodedSources);
        slashCommandsCacheExpiresAt = Date.now() + SLASH_COMMANDS_CACHE_TTL_MS;
        dbg("refreshSlashCommands: fetched successfully", { count: cachedSlashCommands.length });
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
      return {
        streaming: true,
        toolCalls: true,
        multimodal: true,
        fileInputs: true,
        reasoning: true,
      };
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
    updateRuntimeRetention: async ({ conversationKey, scope, mountId, retain, probeId, providerSessionId }) => {
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
          (retain ? await resolveClaudeProviderSessionHint(conversationKey, scope) : undefined),
      });
    },
    invalidateSession: async ({ conversationKey, scope, metadata }) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        clearLastRunBridgeContext(conversationKey);
        conversationScopeByKey.delete(conversationKey);
        return null;
      }
      const outcome = await invalidateExternalBridgeSession({
        baseUrl: bridgeUrl,
        conversationKey,
        scope,
        metadata,
      });
      clearLastRunBridgeContext(conversationKey);
      conversationScopeByKey.delete(conversationKey);
      conversationContextSignature.delete(conversationKey);
      return outcome;
    },
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
        throw new Error(`Failed to invalidate all hot runtimes (${response.status})`);
      }
      conversationScopeByKey.clear();
      conversationContextSignature.clear();
      return { invalidated: true };
    },
    runExternalAction: async (name, input, opts = {}) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return { ok: false, error: "External backend bridge is not configured" };
      }
      const toolName = fromExternalActionName(name);
      if (!toolName) {
        return { ok: false, error: `Not an external action: ${name}` };
      }
      const tool = cachedTools.find((entry) => entry.name === toolName);
      const onProgress = opts.onProgress ?? (() => {});
      const actionConversationKey =
        typeof opts.conversationKey === "number" && Number.isFinite(opts.conversationKey)
          ? Math.floor(opts.conversationKey)
          : Date.now();
      const actionScope = conversationScopeByKey.get(actionConversationKey);

      onProgress({ type: "step_start", step: `Run ${toolName}`, index: 1, total: 1 });
      const doRun = async (approved = false): Promise<ActionResult<unknown>> => {
        const providerIdentityStack = await buildClaudeProviderIdentityStack();
        const providerIdentity = hashProviderIdentityStack(providerIdentityStack);
        const outcome = await runExternalBridgeAction(bridgeUrl, {
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

        if (outcome.kind === "fallback" && outcome.reason === "approval_required") {
          if (
            opts.confirmationMode === "native_ui" &&
            typeof opts.requestConfirmation === "function"
          ) {
            const requestId = `ext-confirm-${Date.now()}`;
            const riskLevel =
              tool?.riskLevel === "high" || tool?.riskLevel === "medium" || tool?.riskLevel === "low"
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
            onProgress({ type: "confirmation_required", requestId, action: pendingAction });
            const resolution = await opts.requestConfirmation(requestId, pendingAction);
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
    runTurn: async (params: RunTurnParams): Promise<AgentRuntimeOutcome> => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        throw new Error("Claude bridge URL is empty. Set Bridge URL to http://127.0.0.1:19787.");
      }
      let persistedRunId = "";
      let persistedRunCreated = false;
      let persistedSeq = 0;
      const pendingEventsBeforeRunId: AgentEvent[] = [];
      const ensurePersistedRun = async (runId: string): Promise<void> => {
        const normalized = (runId || "").trim();
        if (!normalized) return;
        if (!persistedRunCreated || persistedRunId !== normalized) {
          persistedRunId = normalized;
          persistedSeq = 0;
          await createAgentRun({
            runId: persistedRunId,
            conversationKey: params.request.conversationKey,
            mode: "agent",
            model: params.request.model,
            status: "running",
            createdAt: Date.now(),
          });
          persistedRunCreated = true;
          if (pendingEventsBeforeRunId.length) {
            for (const event of pendingEventsBeforeRunId.splice(0)) {
              persistedSeq += 1;
              await appendAgentRunEvent(persistedRunId, persistedSeq, event);
            }
          }
        }
      };
      const appendPersistedEvent = async (event: AgentEvent): Promise<void> => {
        if (!persistedRunCreated || !persistedRunId) {
          pendingEventsBeforeRunId.push(event);
          return;
        }
        persistedSeq += 1;
        await appendAgentRunEvent(persistedRunId, persistedSeq, event);
      };
      await appendPersistedEvent(makeProfilingEvent("frontend.run_turn.enter"));
      await params.onEvent?.(makeProfilingEvent("frontend.run_turn.enter"));
      const contextEnvelope = buildContextEnvelope(params.request);
      await appendPersistedEvent(makeProfilingEvent("frontend.context_envelope.ready"));
      await params.onEvent?.(makeProfilingEvent("frontend.context_envelope.ready"));
      const runtimeRequest = await buildBridgeRuntimeRequest(params.request);
      await appendPersistedEvent(makeProfilingEvent("frontend.bridge_runtime_request.ready"));
      await params.onEvent?.(makeProfilingEvent("frontend.bridge_runtime_request.ready"));
      const scope = resolveBridgeScope(params.request);
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
      const currentSignature = signatureForContextEnvelope(contextEnvelope);
      conversationContextSignature.set(params.request.conversationKey, currentSignature);
      try {
        const outcome = await runExternalBridgeTurn(bridgeUrl, {
          ...params,
          onStart: async (runId) => {
            await ensurePersistedRun(runId);
            await params.onStart?.(runId);
          },
          onEvent: async (event) => {
            await appendPersistedEvent(event);
            await params.onEvent?.(event);
          },
          contextEnvelope,
          runtimeRequest,
          scope,
          registerPendingConfirmation: (requestId, resolve) =>
            coreRuntime.registerPendingConfirmation(requestId, resolve),
          resolveExternalConfirmation: async (requestId, resolution) => {
            const response = await fetch(`${normalizeBaseUrl(bridgeUrl)}/resolve-confirmation`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requestId,
                approved: Boolean(resolution.approved),
                actionId: resolution.actionId,
                data: resolution.data,
              }),
            });
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
          },
        });
        const finalRunId = persistedRunId || outcome.runId;
        if (finalRunId) {
          await ensurePersistedRun(finalRunId);
          await finishAgentRun(
            finalRunId,
            outcome.kind === "completed" ? "completed" : "failed",
            outcome.kind === "completed" ? outcome.text : outcome.reason,
          );
        }
        return outcome;
      } catch (error) {
        if (persistedRunId) {
          await finishAgentRun(
            persistedRunId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        const message = formatBridgeUserError(
          error,
          bridgeUrl,
          "External agent backend unavailable",
        );
        const fallbackRunId = persistedRunId || `bridge-error-${Date.now()}`;
        if (!persistedRunCreated) {
          await ensurePersistedRun(fallbackRunId);
          await params.onStart?.(fallbackRunId);
        }
        const statusEvent: AgentEvent = {
          type: "status",
          text: message,
        };
        await appendPersistedEvent(statusEvent);
        await params.onEvent?.(statusEvent);
        const fallbackEvent: AgentEvent = {
          type: "fallback",
          reason: message,
        };
        await appendPersistedEvent(fallbackEvent);
        await params.onEvent?.(fallbackEvent);
        await finishAgentRun(fallbackRunId, "failed", message);
        if (typeof ztoolkit !== "undefined" && typeof ztoolkit.log === "function") {
          ztoolkit.log(
            "LLM Agent: External bridge unavailable",
            message,
          );
        }
        throw new Error(message);
      }
    },
  };
}
