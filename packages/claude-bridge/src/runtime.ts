import type { JsonObject, McpServersConfig } from "./types.js";

export type ProviderEventType =
  | "provider_event"
  | "status"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "confirmation_required"
  | "confirmation_resolved"
  | "message_delta"
  | "message_rollback"
  | "usage"
  | "context_compacted"
  | "codex_progress"
  | "final"
  | "unknown";

export interface ProviderEvent {
  type: ProviderEventType;
  payload: JsonObject;
}

export interface RuntimeTurnRequest {
  conversationKey: string;
  userMessage: string;
  providerSessionId?: string;
  allowedTools?: string[];
  runtimeRequest?: JsonObject;
  mcpServers?: McpServersConfig;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface RuntimeTurnStream {
  runId: string;
  providerSessionId?: string;
  events: AsyncIterable<ProviderEvent>;
}

export interface McpServerStatus {
  name: string;
  status: string;
  serverInfo?: JsonObject;
  error?: string;
  config?: JsonObject;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: JsonObject;
  }>;
}

export interface RuntimeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface RuntimeModelCatalog {
  models: string[];
  modelInfos?: RuntimeModelInfo[];
}

export interface RuntimeAccountQuota {
  windows: Array<{
    usedPercent: number;
    durationMins: number;
    resetsAt?: number;
  }>;
}

export interface RuntimeAccountQuotaOptions {
  settingSources?: Array<"user" | "project" | "local">;
  runtimeCwdRelative?: string;
}

export interface RuntimePermissionModeInfo {
  id:
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "dontAsk"
    | "bypassPermissions";
  description: string;
  available: boolean;
  disabledReason?: string;
}

export interface RuntimePermissionModeCatalog {
  modes: RuntimePermissionModeInfo[];
  configuredDefaultMode?: string;
}

export type StructuredCompletionRequest = {
  prompt: string;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};
/** Token counts the SDK reported for one structured completion. */
export type StructuredCompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  model?: string;
};
export type StructuredCompletionResult = {
  text: string;
  /** Present only when the SDK reported token counts. */
  usage?: StructuredCompletionUsage;
};

/**
 * A structured completion that failed with an HTTP-style status the caller
 * can act on (429 = the provider rate-limited the request). The HTTP bridge
 * answers with this status instead of a generic 500.
 */
export class StructuredCompletionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StructuredCompletionError";
    this.status = status;
  }
}

export interface ClaudeCodeRuntimeClient {
  getAccountQuota?(
    options?: RuntimeAccountQuotaOptions,
  ): Promise<RuntimeAccountQuota | null>;
  completeStructured?(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResult>;
  startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream>;
  retainHotRuntime?(
    request: RuntimeTurnRequest,
    mountId: string,
  ): Promise<void>;
  warmHotRuntime?(request: RuntimeTurnRequest): Promise<void>;
  releaseHotRuntime?(conversationKey: string, mountId: string): Promise<void>;
  invalidateHotRuntime?(conversationKey: string): Promise<void>;
  invalidateAllHotRuntimes?(): Promise<void>;
  listCommands?(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }): Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  >;
  listModels?(options?: {
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
    forceRefresh?: boolean;
  }): Promise<Array<RuntimeModelInfo | string>>;
  listEfforts?(options?: {
    model?: string;
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
  }): Promise<string[]>;
  listPermissionModes?(options?: {
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
  }): Promise<RuntimePermissionModeCatalog>;
  listMcpServers?(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }): Promise<McpServerStatus[]>;
}
