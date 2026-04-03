import type { AgentRuntime } from "./runtime";
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
  runExternalAction(
    name: string,
    input: unknown,
    opts?: {
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

const EXTERNAL_ACTION_PREFIX = "cc_tool::";

type ContextEnvelope = {
  activeItemId?: number;
  libraryID?: number;
  selectedTextCount: number;
  selectedPaperCount: number;
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
  selectedPaperContexts?: unknown[];
  fullTextPaperContexts?: unknown[];
  pinnedPaperContexts?: unknown[];
  attachments?: BridgeAttachment[];
  screenshots?: string[];
  activeNoteContext?: {
    noteId: number;
    title: string;
    noteKind: string;
    parentItemId?: number;
    noteText?: string;
  };
};

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
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
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
  },
): Promise<AgentRuntimeOutcome> {
  const url = `${normalizeBaseUrl(baseUrl)}/run-turn`;
  const payload = {
    conversationKey: params.request.conversationKey,
    userText: params.request.userText,
    runtimeRequest: params.runtimeRequest,
    metadata: {
      runType: "chat",
      activeItemId: params.request.activeItemId,
      libraryID: params.request.libraryID,
      contextEnvelope: params.contextEnvelope,
    },
  };

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
    fullTextPapers,
    pinnedPapers,
    attachments,
    activeNote,
  };
}

function buildBridgeRuntimeRequest(
  request: AgentRuntimeRequest,
): BridgeRuntimeRequest {
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
    selectedPaperContexts: Array.isArray(request.selectedPaperContexts)
      ? request.selectedPaperContexts
      : undefined,
    fullTextPaperContexts: Array.isArray(request.fullTextPaperContexts)
      ? request.fullTextPaperContexts
      : undefined,
    pinnedPaperContexts: Array.isArray(request.pinnedPaperContexts)
      ? request.pinnedPaperContexts
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
  };
}

function signatureForContextEnvelope(envelope: ContextEnvelope): string {
  return JSON.stringify({
    activeItemId: envelope.activeItemId,
    libraryID: envelope.libraryID,
    selectedTextCount: envelope.selectedTextCount,
    selectedPaperCount: envelope.selectedPaperCount,
    fullTextPaperCount: envelope.fullTextPaperCount,
    pinnedPaperCount: envelope.pinnedPaperCount,
    attachmentCount: envelope.attachmentCount,
    screenshotCount: envelope.screenshotCount,
    selectedPaperIds: envelope.selectedPapers.map((paper) => paper.contextItemId).sort(),
    fullTextPaperIds: envelope.fullTextPapers.map((paper) => paper.contextItemId).sort(),
    pinnedPaperIds: envelope.pinnedPapers.map((paper) => paper.contextItemId).sort(),
    selectedTextFingerprints: envelope.selectedTexts.map((row) => row.text.slice(0, 80)),
    activeNoteId: envelope.activeNote?.noteId,
  });
}

async function fetchExternalTools(baseUrl: string): Promise<ExternalToolDescriptor[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/tools`, {
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
  const conversationContextSignature = new Map<number, string>();
  const TOOL_CACHE_TTL_MS = 60_000;

  const refreshExternalActions = async (force = false): Promise<void> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl) {
      cachedTools = [];
      cacheExpiresAt = 0;
      return;
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
        cachedTools = await fetchExternalTools(bridgeUrl);
        cacheExpiresAt = Date.now() + TOOL_CACHE_TTL_MS;
      } catch (error) {
        ztoolkit.log("LLM Agent: Failed to refresh external actions", error);
      } finally {
        refreshInFlight = null;
      }
    })();
    await refreshInFlight;
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
      if (!bridgeUrl) {
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

      onProgress({ type: "step_start", step: `Run ${toolName}`, index: 1, total: 1 });
      const doRun = async (approved = false): Promise<ActionResult<unknown>> => {
        const outcome = await runExternalBridgeAction(bridgeUrl, {
          conversationKey: Date.now(),
          toolName,
          args: input,
          libraryID: opts.libraryID,
          approved,
          onEvent: async (event) => {
            if (event.type === "status") {
              onProgress({ type: "status", message: event.text });
            }
          },
        });

        if (outcome.kind === "fallback" && outcome.reason === "approval_required") {
          if (
            tool?.requiresConfirmation &&
            opts.confirmationMode === "native_ui" &&
            typeof opts.requestConfirmation === "function"
          ) {
            const requestId = `ext-confirm-${Date.now()}`;
            const pendingAction: AgentPendingAction = {
              toolName,
              title: `Approve ${toolName}`,
              mode: "approval",
              confirmLabel: "Run",
              cancelLabel: "Cancel",
              description: `This action is marked as ${tool.riskLevel} risk.`,
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
        return coreRuntime.runTurn(params);
      }
      const contextEnvelope = buildContextEnvelope(params.request);
      const runtimeRequest = buildBridgeRuntimeRequest(params.request);
      const currentSignature = signatureForContextEnvelope(contextEnvelope);
      const previousSignature = conversationContextSignature.get(
        params.request.conversationKey,
      );
      const contextStatus =
        previousSignature && previousSignature === currentSignature
          ? "已复用上轮上下文"
          : "检测到新上下文并更新";
      conversationContextSignature.set(params.request.conversationKey, currentSignature);
      await params.onEvent?.({ type: "status", text: contextStatus });
      try {
        return await runExternalBridgeTurn(bridgeUrl, {
          ...params,
          contextEnvelope,
          runtimeRequest,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof ztoolkit !== "undefined" && typeof ztoolkit.log === "function") {
          ztoolkit.log("LLM Agent: External bridge unavailable, fallback to local runtime", message);
        }
        await params.onEvent?.({
          type: "status",
          text: "外部 Agent 后端不可用，已自动回退到本地模式",
        });
        return coreRuntime.runTurn(params);
      }
    },
  };
}
