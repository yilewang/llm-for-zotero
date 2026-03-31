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
  params: RunTurnParams,
): Promise<AgentRuntimeOutcome> {
  const url = `${normalizeBaseUrl(baseUrl)}/run-turn`;
  const payload = {
    conversationKey: params.request.conversationKey,
    userText: params.request.userText,
    metadata: {
      model: params.request.model,
      providerLabel: params.request.modelProviderLabel,
      activeItemId: params.request.activeItemId,
      libraryID: params.request.libraryID,
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
      return runExternalBridgeTurn(bridgeUrl, params);
    },
  };
}
