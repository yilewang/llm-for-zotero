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
import { createAgentModelAdapter } from "./model/factory";
import type {
  AgentEvent,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "./types";

let runtime: AgentRuntime | null = null;

// Hoisted so getAgentApi() can expose them to third-party plugin authors.
let _zoteroGateway: ZoteroGateway | null = null;

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
  runtime = new AgentRuntime({
    registry: createToolRegistry(),
    adapterFactory: (request) => createAgentModelAdapter(request),
  });
  return runtime;
}

export function getAgentRuntime(): AgentRuntime {
  if (!runtime) {
    throw new Error("Agent subsystem is not initialized");
  }
  return runtime;
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
      approved: boolean,
      data?: unknown,
    ) => getAgentRuntime().resolveConfirmation(requestId, approved, data),

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
  };
}
