import { AgentRuntime } from "./runtime";
import { createBuiltInToolRegistry } from "./tools";
import { ZoteroGateway } from "./services/zoteroGateway";
import { PdfService } from "./services/pdfService";
import { PdfPageService } from "./services/pdfPageService";
import { RetrievalService } from "./services/retrievalService";
import { initAgentTraceStore, getAgentRunTrace } from "./store/traceStore";
import { initConversationMemoryStore } from "./store/conversationMemory";
import { initAgentTranscriptStore } from "./store/transcriptStore";
import { initAgentToolResultHandleStore } from "./store/toolResultHandles";
import { initAgentEvidenceStore } from "./context/cacheManagement";
import { initAgentCoverageStore } from "./context/coverageLedger";
import { createAgentModelAdapter } from "./model/factory";
import { createBuiltInActionRegistry, type ActionRegistry } from "./actions";
import { createLibraryBatchTool } from "./tools/write/libraryBatch";
import {
  initAgentBatchJobStore,
  sweepInterruptedBatchJobs,
} from "./store/batchJobStore";
import { initAgentChangeJournal } from "./store/changeJournal";
import { registerMcpServer, unregisterMcpServer } from "./mcp/server";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentRuntimeRequestInput,
  AgentToolDefinition,
} from "./types";
import {
  getConversationSystemPref,
  isClaudeCodeModeEnabled,
} from "../claudeCode/prefs";
import { getClaudeCommandCatalog } from "../claudeCode/commandCatalog";
import {
  getClaudeBridgeRuntime,
  resetClaudeBridgeRuntime,
} from "../claudeCode/runtime";
import { clearCodexZoteroMcpPreflightCache } from "../codexAppServer/mcpSetup";
import { getConversationWriteGeneration } from "../shared/conversationWriteFence";
import { setLibraryOverviewGateway } from "./context/libraryOverview";

let runtime: AgentRuntime | null = null;
let runtimeInitTask: Promise<AgentRuntime> | null = null;
let agentLifecycleGeneration = 0;
let _actionRegistry: ActionRegistry | null = null;
let _toolRegistry: ReturnType<typeof createBuiltInToolRegistry> | null = null;

// Hoisted so getAgentApi() can expose them to third-party plugin authors.
let _zoteroGateway: ZoteroGateway | null = null;

class AgentSubsystemInitializationCancelledError extends Error {
  constructor() {
    super("Agent subsystem initialization was cancelled");
    this.name = "AgentSubsystemInitializationCancelledError";
  }
}

function assertAgentInitCurrent(generation: number): void {
  if (generation !== agentLifecycleGeneration) {
    throw new AgentSubsystemInitializationCancelledError();
  }
}

function createToolRegistry(zoteroGateway: ZoteroGateway) {
  const pdfService = new PdfService();
  const pdfPageService = new PdfPageService(pdfService, zoteroGateway);
  const retrievalService = new RetrievalService(pdfService);
  return createBuiltInToolRegistry({
    zoteroGateway,
    pdfService,
    pdfPageService,
    retrievalService,
  });
}

async function createAgentSubsystemRuntime(
  generation: number,
): Promise<AgentRuntime> {
  await initAgentTraceStore();
  assertAgentInitCurrent(generation);
  await initConversationMemoryStore();
  assertAgentInitCurrent(generation);
  await initAgentTranscriptStore();
  assertAgentInitCurrent(generation);
  await initAgentToolResultHandleStore();
  assertAgentInitCurrent(generation);
  await initAgentEvidenceStore();
  assertAgentInitCurrent(generation);
  await initAgentCoverageStore();
  assertAgentInitCurrent(generation);

  const zoteroGateway = new ZoteroGateway();
  const toolRegistry = createToolRegistry(zoteroGateway);
  const nextRuntime = new AgentRuntime({
    registry: toolRegistry,
    adapterFactory: (request) => createAgentModelAdapter(request),
    paperContextResolver: (selector) =>
      zoteroGateway.resolvePaperContextTarget(selector),
  });
  const actionRegistry = createBuiltInActionRegistry();

  // Registered here rather than inside createBuiltInToolRegistry: the batch
  // tool needs both registries, and the action registry is built after the
  // tool one. Wiring it this way keeps the two from depending on each other.
  toolRegistry.register(
    createLibraryBatchTool({
      actionRegistry,
      toolRegistry,
      zoteroGateway,
    }),
  );
  await initAgentBatchJobStore();
  // Claim abandoned rows before the runtime is published. A deferred sweep
  // can race with a newly started job and misclassify live work as failed.
  await sweepInterruptedBatchJobs({ now: Date.now() });
  await initAgentChangeJournal();

  assertAgentInitCurrent(generation);
  registerMcpServer({
    toolRegistry,
    zoteroGateway,
  });

  assertAgentInitCurrent(generation);
  _zoteroGateway = zoteroGateway;
  // The prompt layer cannot import this module without creating a cycle,
  // so the gateway is pushed to it instead.
  setLibraryOverviewGateway(zoteroGateway);
  _toolRegistry = toolRegistry;
  runtime = nextRuntime;
  _actionRegistry = actionRegistry;

  return nextRuntime;
}

export async function initAgentSubsystem(): Promise<AgentRuntime> {
  if (runtime) return runtime;
  if (!runtimeInitTask) {
    const generation = agentLifecycleGeneration;
    const task = createAgentSubsystemRuntime(generation);
    runtimeInitTask = task;
    void task
      .finally(() => {
        if (runtimeInitTask === task) {
          runtimeInitTask = null;
        }
      })
      .catch(() => undefined);
  }
  return runtimeInitTask;
}

export function shutdownAgentSubsystem(): void {
  agentLifecycleGeneration += 1;
  unregisterMcpServer();
  clearCodexZoteroMcpPreflightCache();
  runtimeInitTask = null;
  _actionRegistry = null;
  _toolRegistry = null;
  resetClaudeBridgeRuntime();
  runtime = null;
  _zoteroGateway = null;
  setLibraryOverviewGateway(null);
}

export function getCoreAgentRuntime(): AgentRuntime {
  if (!runtime) {
    throw new Error("Agent subsystem is not initialized");
  }
  return runtime;
}

export function getAgentRuntime(): AgentRuntime {
  const coreRuntime = getCoreAgentRuntime();
  if (
    getConversationSystemPref() === "claude_code" &&
    isClaudeCodeModeEnabled()
  ) {
    return getClaudeBridgeRuntime(coreRuntime) as unknown as AgentRuntime;
  }
  return coreRuntime;
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
      request: AgentRuntimeRequestInput,
      onEvent?: (event: AgentEvent) => void | Promise<void>,
    ) =>
      getAgentRuntime().runTurn({
        request:
          request.conversationGeneration === undefined
            ? {
                ...request,
                conversationGeneration: getConversationWriteGeneration(
                  request.conversationKey,
                ),
              }
            : request,
        onEvent,
      }),
    listTools: () => getAgentRuntime().listTools(),
    getToolDefinition: (name: string) =>
      getAgentRuntime().getToolDefinition(name),
    getCapabilities: (request: AgentRuntimeRequestInput) =>
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
    listSlashCommands: () => getClaudeCommandCatalog(getCoreAgentRuntime()),

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
    listActions: (mode?: "paper" | "library") => {
      if (!_actionRegistry)
        throw new Error("Agent subsystem is not initialized");
      return _actionRegistry.listActions(mode);
    },
    getPaperScopedActionProfile: (name: string) => {
      if (!_actionRegistry)
        throw new Error("Agent subsystem is not initialized");
      return _actionRegistry.getPaperScopedActionProfile(name);
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
        requestContext?: import("./actions").ActionRequestContext;
        conversationKey?: number;
        confirmationMode?: import("./actions").ActionConfirmationMode;
        onProgress?: (event: import("./actions").ActionProgressEvent) => void;
        requestConfirmation?: (
          requestId: string,
          action: import("./types").AgentPendingAction,
        ) => Promise<import("./types").AgentConfirmationResolution>;
        /** LLM credentials for actions that propose per-item suggestions. */
        llm?: import("./actions").ActionLLMConfig;
        /** Cancels a long batched run part-way through. */
        signal?: AbortSignal;
      } = {},
    ) => {
      if (!_actionRegistry || !_toolRegistry)
        throw new Error("Agent subsystem is not initialized");
      if (!_zoteroGateway)
        throw new Error("Agent subsystem is not initialized");
      const libraryID =
        opts.libraryID ??
        (Zotero as unknown as { Libraries: { userLibraryID: number } })
          .Libraries.userLibraryID;
      const ctx: import("./actions").ActionExecutionContext = {
        registry: _toolRegistry,
        // Without this, every change an action makes is journalled under
        // conversation 0 and neither undo path can find it.
        conversationKey: opts.conversationKey,
        zoteroGateway: _zoteroGateway,
        libraryID,
        confirmationMode: opts.confirmationMode ?? "native_ui",
        onProgress: opts.onProgress ?? (() => {}),
        requestConfirmation:
          opts.requestConfirmation ?? (async () => ({ approved: true })),
        llm: opts.llm,
        requestContext: opts.requestContext,
        signal: opts.signal,
      };
      return _actionRegistry.run(name, input, ctx);
    },
  };
}
