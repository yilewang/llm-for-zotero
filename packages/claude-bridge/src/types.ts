export type AgentEventType =
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
  | "fallback";

export type JsonObject = Record<string, unknown>;
export type McpServerConfigValue = Record<string, unknown>;
export type McpServersConfig = Record<string, McpServerConfigValue>;

export interface AgentEvent<TPayload = JsonObject> {
  type: AgentEventType;
  ts: number;
  payload: TPayload;
}

export interface RunTurnRequest {
  conversationKey: string;
  userMessage: string;
  providerSessionId?: string;
  allowedTools?: string[];
  runtimeRequest?: JsonObject;
  mcpServers?: McpServersConfig;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface RunStart {
  runId: string;
  conversationKey: string;
  providerSessionId?: string;
}

export interface RunTurnHooks {
  onStart?: (start: RunStart) => void;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface RunTurnOutcome {
  runId: string;
  conversationKey: string;
  providerSessionId?: string;
  status: "completed" | "cancelled" | "failed";
  finalText?: string;
  error?: string;
}
