/**
 * Minimal MCP (Model Context Protocol) JSON-RPC 2.0 type definitions.
 * Covers the subset of MCP used by the llm-for-zotero action server.
 *
 * Spec reference: https://modelcontextprotocol.io/specification
 */

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: JsonRpcError };

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

// Standard JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
} as const;

// MCP-specific types

export type McpServerInfo = {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    tools: Record<string, never>;
  };
};

export type McpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations?: {
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
    destructiveHint?: boolean;
  };
};

export type McpToolsListResult = {
  tools: McpToolDefinition[];
};

export type McpToolCallParams = {
  name: string;
  arguments?: unknown;
};

export type McpToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// MCP method names
export const MCP_METHODS = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

export function makeResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
