/**
 * Wire vocabulary of the Agent Client Protocol (ACP), version 1.
 *
 * ACP is JSON-RPC 2.0 with one JSON message per line on stdio. The plugin is
 * the client; an agent process such as `agy acp` is the agent. These types
 * cover the subset the plugin speaks, as observed from agy 1.5.10 (see
 * test/fixtures/acp/agy-1.5.10.json). Agents add fields freely, so every field
 * the plugin does not strictly need is optional and readers must tolerate
 * absence.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC error code agy returns while its credentials are still loading. */
export const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;
export const ACP_METHOD_NOT_FOUND_ERROR_CODE = -32601;

export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const;

// ---------------------------------------------------------------- JSON-RPC

export type JsonRpcId = number | string;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcRequest<P = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
};

export type JsonRpcNotification<P = unknown> = {
  jsonrpc: "2.0";
  method: string;
  params?: P;
};

export type JsonRpcResponse<R = unknown> =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: R }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isJsonRpcRequest(
  message: JsonRpcMessage,
): message is JsonRpcRequest {
  return "method" in message && "id" in message && message.id !== undefined;
}

export function isJsonRpcNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message && message.id !== undefined);
}

export function isJsonRpcResponse(
  message: JsonRpcMessage,
): message is JsonRpcResponse {
  return !("method" in message) && "id" in message;
}

// ---------------------------------------------------------------- initialize

export type AcpClientCapabilities = {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
};

export type AcpInitializeParams = {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
};

export type AcpAuthMethod = {
  id: string;
  name: string;
  description?: string;
};

export type AcpAgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: {
    resume?: object;
    close?: object;
    load?: object;
    list?: object;
    additionalDirectories?: object;
  };
  _meta?: {
    antigravity?: {
      tier?: boolean;
      systemPrompt?: { append?: boolean };
    };
  };
};

export type AcpInitializeResult = {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: { name?: string; version?: string };
  authMethods?: AcpAuthMethod[];
};

// ---------------------------------------------------------------- sessions

export type AcpHttpHeader = { name: string; value: string };

export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: AcpHttpHeader[] }
  | { type: "sse"; name: string; url: string; headers: AcpHttpHeader[] }
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };

export type AcpSessionMeta = {
  antigravity?: { systemPrompt?: { append?: string } };
};

export type AcpNewSessionParams = {
  cwd: string;
  mcpServers: AcpMcpServer[];
  _meta?: AcpSessionMeta;
};

export type AcpLoadSessionParams = AcpNewSessionParams & { sessionId: string };

export type AcpModelInfo = { modelId: string; name: string };

export type AcpSessionMode = {
  id: string;
  name: string;
  description?: string;
};

export type AcpConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
};

export type AcpSessionState = {
  models?: { availableModels: AcpModelInfo[]; currentModelId: string };
  modes?: { availableModes: AcpSessionMode[]; currentModeId: string };
  configOptions?: AcpConfigOption[];
  _meta?: {
    antigravity?: {
      tier?: { name?: string; id?: string; upgradeUri?: string };
    };
  };
};

export type AcpNewSessionResult = AcpSessionState & { sessionId: string };

export type AcpSessionInfo = {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
};

export type AcpListSessionsResult = {
  sessions: AcpSessionInfo[];
  nextCursor?: string;
};

export type AcpSetModeParams = { sessionId: string; modeId: string };
export type AcpSetModelParams = { sessionId: string; modelId: string };
export type AcpSetConfigOptionParams = {
  sessionId: string;
  configId: string;
  value: string;
};

// ---------------------------------------------------------------- prompts

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        text?: string;
        blob?: string;
        mimeType?: string;
      };
    }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string };

export type AcpPromptParams = {
  sessionId: string;
  prompt: AcpContentBlock[];
};

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AcpPromptResult = {
  stopReason: AcpStopReason;
  usage?: AcpUsage;
};

export type AcpCancelParams = { sessionId: string };

// ---------------------------------------------------------------- updates

export type AcpToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/**
 * A tool call as agy reports it. `name` and `args` are agy extensions beside
 * the standard `title`, `kind`, `rawInput`, and `content`.
 */
export type AcpToolCall = {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind | string;
  status?: AcpToolCallStatus;
  name?: string;
  args?: Record<string, unknown>;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: Array<{ path: string; line?: number }>;
};

export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | {
      sessionUpdate: "plan";
      entries: Array<{ content: string; priority?: string; status?: string }>;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: Array<{ name: string; description?: string }>;
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: AcpConfigOption[] }
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "session_info_update"; title?: string };

export type AcpSessionUpdateKind = AcpSessionUpdate["sessionUpdate"];

export type AcpSessionNotification = {
  sessionId: string;
  update: AcpSessionUpdate;
};

// ---------------------------------------------------------------- permissions

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
};

export type AcpRequestPermissionParams = {
  sessionId: string;
  toolCall: AcpToolCall & { sessionUpdate?: string };
  options: AcpPermissionOption[];
};

export type AcpRequestPermissionResult = {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
};
