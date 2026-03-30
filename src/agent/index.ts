import { config } from "../../package.json";
import { AgentRuntime } from "./runtime";
import { createBuiltInToolRegistry } from "./tools";
import { ZoteroGateway } from "./services/zoteroGateway";
import { PdfService } from "./services/pdfService";
import { PdfPageService } from "./services/pdfPageService";
import { RetrievalService } from "./services/retrievalService";
import {
  initAgentTraceStore,
  getAgentRunTrace,
} from "./store/traceStore";
import { initConversationMemoryStore } from "./store/conversationMemory";
import { createAgentModelAdapter } from "./model/factory";
import { createBuiltInActionRegistry, type ActionRegistry } from "./actions";
import { registerMcpServer, unregisterMcpServer } from "./mcp/server";
import {
  createExternalBackendBridgeRuntime,
  type AgentRuntimeLike,
} from "./externalBackendBridge";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "./types";

let runtime: AgentRuntime | null = null;
let runtimeBridge: AgentRuntimeLike | null = null;
let _actionRegistry: ActionRegistry | null = null;
let _toolRegistry: ReturnType<typeof createBuiltInToolRegistry> | null = null;

// Hoisted so getAgentApi() can expose them to third-party plugin authors.
let _zoteroGateway: ZoteroGateway | null = null;

function getExternalBackendBridgeUrl(): string {
  try {
    const value = Zotero.Prefs.get(`${config.prefsPrefix}.agentBackendBridgeUrl`, true);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function createToolRegistry() {
  _zoteroGateway = new ZoteroGateway();
  const pdfService = new PdfService();
  const pdfPageService = new PdfPageService(pdfService, _zoteroGateway);
  const retrievalService = new RetrievalService(pdfService);
  return createBuiltInToolRegistry({
    zoteroGateway: _zoteroGateway,
    pdfService,
    pdfPageService,
    retrievalService,
  });
}

export async function initAgentSubsystem(): Promise<AgentRuntime> {
  if (runtime) return runtime;
  await initAgentTraceStore();
  await initConversationMemoryStore();
  _toolRegistry = createToolRegistry();
  runtime = new AgentRuntime({
    registry: _toolRegistry,
    adapterFactory: (request) => createAgentModelAdapter(request),
  });

  // Initialize action registry and MCP server
  _actionRegistry = createBuiltInActionRegistry();
  registerMcpServer({
    actionRegistry: _actionRegistry,
    toolRegistry: _toolRegistry,
    zoteroGateway: _zoteroGateway!,
  });

  runtimeBridge = createExternalBackendBridgeRuntime({
    coreRuntime: runtime,
    getBridgeUrl: getExternalBackendBridgeUrl,
  });

  return runtime;
}

export function shutdownAgentSubsystem(): void {
  unregisterMcpServer();
  _actionRegistry = null;
  _toolRegistry = null;
  runtimeBridge = null;
  runtime = null;
  _zoteroGateway = null;
}

export function getAgentRuntime(): AgentRuntime {
  if (!runtime) {
    throw new Error("Agent subsystem is not initialized");
  }
  return (runtimeBridge || runtime) as unknown as AgentRuntime;
}

/**
 * Returns the shared ZoteroGateway instance for use outside the agent runtime
 * (e.g. UI components that need to trigger Zotero operations directly).
 */
export function getSharedZoteroGateway(): ZoteroGateway {
  if (!_zoteroGateway) {
    throw new Error("Agent subsystem is not initialized");
  }
  return _zoteroGateway;
}

export function getAgentApi() {
  return {
    // ── Core turn API ──────────────────────────────────────────────────────
    runTurn: (
      request: AgentRuntimeRequest,
      onEvent?: (event: AgentEvent) => void | Promise<void>,
    ) => getAgentRuntime().runTurn({ request, onEvent }),
    listTools: () => getAgentRuntime().listTools(),
    getToolDefinition: (name: string) =>
      getAgentRuntime().getToolDefinition(name),
    getCapabilities: (request: AgentRuntimeRequest) =>
      getAgentRuntime().getCapabilities(request),
    getRunTrace: (runId: string) => getAgentRunTrace(runId),
    resolveConfirmation: (
      requestId: string,
      approved: boolean | AgentConfirmationResolution,
      data?: unknown,
    ) => getAgentRuntime().resolveConfirmation(requestId, approved, data),

    /**
     * Registers an external pending confirmation so that `resolveConfirmation`
     * can settle it.  Used by the action-picker UI to wire action HITL cards
     * into the same resolution path as agent-turn confirmations.
     */
    registerPendingConfirmation: (
      requestId: string,
      resolve: (resolution: AgentConfirmationResolution) => void,
    ) => getAgentRuntime().registerPendingConfirmation(requestId, resolve),

    // ── Extension API ──────────────────────────────────────────────────────
    /**
     * Register a custom tool with the agent.  The tool is available immediately
     * for all subsequent `runTurn` calls.  Registering a tool whose name
     * matches an existing built-in tool replaces that built-in.
     *
     * See `src/agent/extensionApi.ts` for the full set of types and helpers
     * available to third-party tool authors.
     *
     * @example
     * ```ts
     * import type { AgentToolDefinition } from "llm-for-zotero/src/agent/extensionApi";
     * import { ok, fail } from "llm-for-zotero/src/agent/extensionApi";
     *
     * addon.api.agent.registerTool({
     *   spec: {
     *     name: "my_custom_tool",
     *     description: "Does something custom",
     *     inputSchema: { type: "object", properties: { query: { type: "string" } } },
     *     mutability: "read",
     *     requiresConfirmation: false,
     *   },
     *   validate: (args) => {
     *     if (!args || typeof args !== "object") return fail("Expected object");
     *     return ok(args as { query?: string });
     *   },
     *   execute: async (input) => ({ result: `Got: ${input.query}` }),
     * });
     * ```
     */
    registerTool: <TInput, TResult>(
      tool: AgentToolDefinition<TInput, TResult>,
    ) => getAgentRuntime().registerTool(tool),

    /**
     * Remove a previously registered tool by name.  Returns `true` if the
     * tool existed and was removed, `false` if it was not found.
     */
    unregisterTool: (name: string) => getAgentRuntime().unregisterTool(name),

    /**
     * Returns the shared `ZoteroGateway` instance.  Custom tools can use this
     * to query the Zotero library (items, collections, tags, notes, …) without
     * having to instantiate their own copy.
     *
     * Only available after `initAgentSubsystem()` has resolved.
     */
    getZoteroGateway: (): ZoteroGateway => {
      if (!_zoteroGateway) {
        throw new Error("Agent subsystem is not initialized");
      }
      return _zoteroGateway;
    },

    // ── Action API ─────────────────────────────────────────────────────────
    /**
     * List all registered actions (name, description, inputSchema).
     */
    listActions: () => {
      if (!_actionRegistry) throw new Error("Agent subsystem is not initialized");
      return _actionRegistry.listActions();
    },

    /**
     * Run a named action programmatically.
     *
     * @example
     * ```ts
     * const result = await addon.api.agent.runAction("audit_library", {
     *   scope: "all",
     *   saveNote: true,
     * }, {
     *   libraryID: Zotero.Libraries.userLibraryID,
     *   confirmationMode: "auto_approve",
     *   onProgress: (event) => console.log(event),
     *   requestConfirmation: async (_id, _action) => ({ approved: true }),
     * });
     * ```
     */
    runAction: (
      name: string,
      input: unknown,
      opts: {
        libraryID?: number;
        confirmationMode?: import("./actions").ActionConfirmationMode;
        onProgress?: (event: import("./actions").ActionProgressEvent) => void;
        requestConfirmation?: (
          requestId: string,
          action: import("./types").AgentPendingAction,
        ) => Promise<import("./types").AgentConfirmationResolution>;
      } = {},
    ) => {
      if (!_actionRegistry || !_toolRegistry) throw new Error("Agent subsystem is not initialized");
      if (!_zoteroGateway) throw new Error("Agent subsystem is not initialized");
      const libraryID =
        opts.libraryID ??
        (Zotero as unknown as { Libraries: { userLibraryID: number } }).Libraries.userLibraryID;
      const ctx: import("./actions").ActionExecutionContext = {
        registry: _toolRegistry,
        zoteroGateway: _zoteroGateway,
        services: {} as import("./actions").ActionServices,
        libraryID,
        confirmationMode: opts.confirmationMode ?? "native_ui",
        onProgress: opts.onProgress ?? (() => {}),
        requestConfirmation: opts.requestConfirmation ?? (async () => ({ approved: true })),
      };
      return _actionRegistry.run(name, input, ctx);
    },
  };
}
