import type { AgentRuntime } from "./runtime";
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
};

type BridgeLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "outcome"; outcome: AgentRuntimeOutcome }
  | { type: "error"; error: string };

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

export function createExternalBackendBridgeRuntime(options: {
  coreRuntime: AgentRuntime;
  getBridgeUrl: () => string;
}): AgentRuntimeLike {
  const { coreRuntime, getBridgeUrl } = options;

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
    runTurn: async (params: RunTurnParams): Promise<AgentRuntimeOutcome> => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return coreRuntime.runTurn(params);
      }
      return runExternalBridgeTurn(bridgeUrl, params);
    },
  };
}
