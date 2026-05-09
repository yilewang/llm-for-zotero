/**
 * MCP (Model Context Protocol) server for the llm-for-zotero plugin.
 *
 * Registers a JSON-RPC 2.0 endpoint on Zotero's built-in HTTP server
 * (default port 23119) at the path "/llm-for-zotero/mcp".
 *
 * External AI agents can connect to:
 *   POST http://localhost:23119/llm-for-zotero/mcp
 *   Content-Type: application/json
 *   Body: JSON-RPC 2.0 request
 *
 * Supported MCP methods:
 *   - initialize       → server info + capabilities
 *   - tools/list       → list all registered actions as MCP tools
 *   - tools/call       → execute an action by name
 */

import type { ActionRegistry } from "../actions/registry";
import type {
  ActionExecutionContext,
  ActionProgressEvent,
} from "../actions/types";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  MCP_METHODS,
  RPC_ERRORS,
  makeError,
  makeResult,
  type JsonRpcRequest,
  type McpServerInfo,
  type McpToolCallParams,
  type McpToolCallResult,
  type McpToolsListResult,
} from "./protocol";

const ENDPOINT_PATH = "/llm-for-zotero/mcp";
const SERVER_VERSION = "1.0.0";

type McpServerDeps = {
  actionRegistry: ActionRegistry;
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
};

function resolveDefaultLibraryId(): number {
  // Zotero.Libraries.userLibraryID is the personal library ID (always 1 in most setups)
  return (Zotero as unknown as { Libraries: { userLibraryID: number } })
    .Libraries.userLibraryID;
}

function makeNoopProgress(_event: ActionProgressEvent): void {
  // Progress events are fire-and-forget for MCP; callers poll for final result
}

async function handleInitialize(): Promise<McpServerInfo> {
  return {
    protocolVersion: "2024-11-05",
    serverInfo: {
      name: "llm-for-zotero",
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
    },
  };
}

function handleToolsList(actionRegistry: ActionRegistry): McpToolsListResult {
  return {
    tools: actionRegistry
      .listActions()
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
  };
}

async function handleToolsCall(
  params: McpToolCallParams,
  deps: McpServerDeps,
): Promise<McpToolCallResult> {
  const { name, arguments: rawArgs } = params;

  const libraryID = resolveDefaultLibraryId();

  const ctx: ActionExecutionContext = {
    registry: deps.toolRegistry,
    zoteroGateway: deps.zoteroGateway,
    services: {} as ActionExecutionContext["services"], // actions use callTool(), not services directly
    libraryID,
    confirmationMode: "auto_approve",
    onProgress: makeNoopProgress,
    requestConfirmation: async (_requestId, _action) => {
      // auto_approve: always approve confirmations automatically
      return { approved: true };
    },
  };

  const result = await deps.actionRegistry.run(name, rawArgs ?? {}, ctx);

  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.output, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Action failed: ${result.error}`,
      },
    ],
    isError: true,
  };
}

async function handleRequest(
  body: string,
  deps: McpServerDeps,
): Promise<string> {
  let request: JsonRpcRequest;

  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      return JSON.stringify(
        makeError(
          null,
          RPC_ERRORS.INVALID_REQUEST.code,
          RPC_ERRORS.INVALID_REQUEST.message,
        ),
      );
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return JSON.stringify(
      makeError(
        null,
        RPC_ERRORS.PARSE_ERROR.code,
        RPC_ERRORS.PARSE_ERROR.message,
      ),
    );
  }

  const { id, method, params } = request;

  try {
    if (method === MCP_METHODS.INITIALIZE) {
      const result = await handleInitialize();
      return JSON.stringify(makeResult(id, result));
    }

    if (method === MCP_METHODS.TOOLS_LIST) {
      const result = handleToolsList(deps.actionRegistry);
      return JSON.stringify(makeResult(id, result));
    }

    if (method === MCP_METHODS.TOOLS_CALL) {
      if (
        !params ||
        typeof params !== "object" ||
        typeof (params as McpToolCallParams).name !== "string"
      ) {
        return JSON.stringify(
          makeError(
            id,
            RPC_ERRORS.INVALID_PARAMS.code,
            "tools/call requires { name, arguments }",
          ),
        );
      }
      const result = await handleToolsCall(params as McpToolCallParams, deps);
      return JSON.stringify(makeResult(id, result));
    }

    return JSON.stringify(
      makeError(
        id,
        RPC_ERRORS.METHOD_NOT_FOUND.code,
        `Unknown method: ${method}`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(
      makeError(
        id,
        RPC_ERRORS.INTERNAL_ERROR.code,
        `Internal error: ${message}`,
      ),
    );
  }
}

/**
 * Registers the MCP endpoint on Zotero's built-in HTTP server.
 * Call this after the agent subsystem is initialized.
 *
 * The endpoint is accessible at:
 *   POST http://localhost:23119/llm-for-zotero/mcp
 */
export function registerMcpServer(deps: McpServerDeps): void {
  const capturedDeps = deps;

  // Zotero.Server.Endpoint class-based registration
  class McpEndpoint {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];

    init = async (options: {
      method: string;
      data: unknown;
    }): Promise<[number, string, string]> => {
      const body =
        typeof options.data === "string"
          ? options.data
          : JSON.stringify(options.data);

      const responseBody = await handleRequest(body, capturedDeps);
      return [200, "application/json", responseBody];
    };
  }

  Zotero.Server.Endpoints[ENDPOINT_PATH] = McpEndpoint;
}

/**
 * Removes the MCP endpoint from Zotero's server (call on plugin shutdown).
 */
export function unregisterMcpServer(): void {
  delete Zotero.Server.Endpoints[ENDPOINT_PATH];
}
