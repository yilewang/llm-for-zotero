/**
 * Workflow-test fixture: one Claude Code turn through the real panel, agent
 * engine, and external-runtime turn host, against a scripted bridge.
 *
 * The bridge server is the only fake. Its address is a fake custom bridge
 * URL, and `fetch` answers that address from a script: `/run-turn` streams
 * the script's lines, `/resolve-confirmation` records the answer, and other
 * paths answer 404. Every other request (the plugin's own Zotero MCP server)
 * goes to the real `fetch`. A script step can also call a tool on the
 * plugin's MCP endpoint with the scope token the turn handed the bridge, as
 * Claude would, so the per-turn scope, tool activity, and review cards run
 * for real.
 */

import { config } from "../../../package.json";
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { getCoreAgentRuntime } from "../../agent";
import {
  bindClaudeBridgeConversationSystem,
  createExternalBackendBridgeRuntime,
} from "../../agent/externalBackendBridge";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../../agent/mcp/server";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import { createAbortController } from "../../utils/apiHelpers";
import { getAbortController, setAbortController } from "./state";
import type { AgentEvent, AgentRuntimeOutcome } from "../../agent/types";
import {
  isNativeZoteroMcpToolsEnabled,
  setNativeZoteroMcpToolsEnabled,
} from "../../codexAppServer/prefs";
import {
  bumpConversationWriteGeneration,
  getConversationWriteGeneration,
} from "../../shared/conversationWriteFence";

const FAKE_BRIDGE_BASE = "http://127.0.0.1:9/fake-claude-bridge";

export type FakeBridgeStep =
  /** A bridge line, sent as is: start, event, outcome, or error. */
  | { line: Record<string, unknown> }
  /** Calls a tool on the plugin's MCP endpoint under the turn's scope. */
  | { mcpCall: { name: string; arguments: unknown } }
  /** Holds the stream until the plugin answers the last confirmation. */
  | { waitForConfirmation: true }
  /** Stops the turn the way the panel's Stop button does. */
  | { abort: true }
  /** Moves the conversation to a new write generation, as Clear does. */
  | { bumpGeneration: true };

export type ExternalTurnScenario = {
  question: string;
  steps: FakeBridgeStep[];
  /** Turns the native Zotero MCP tools on for the turn. */
  mcp?: boolean;
  /** Answers every review card the turn shows; unset leaves them open. */
  approve?: boolean;
};

export type ExternalTurnResult = {
  outcomeKind: AgentRuntimeOutcome["kind"] | "threw";
  outcomeText: string;
  /** Types of the events the panel received, in order. */
  deliveredEvents: string[];
  /** Types of the events stored with the run, in order. */
  storedEvents: string[];
  runStatus?: string;
  runFinalText?: string;
  messageText?: string;
  runTurnPayload: {
    hasMcpServers: boolean;
    mcpHeaderNames: string[];
    allowedTools: string[];
    scopeToken: string;
  } | null;
  /** Answers the plugin sent to `/resolve-confirmation`. */
  confirmationAnswers: Array<{ requestId: string; approved: boolean }>;
  /** Results of `mcpCall` steps: the JSON-RPC result or error text. */
  mcpCallResults: Array<{ ok: boolean; text: string }>;
  /** Whether the turn's MCP scope still answered after the turn. */
  scopeLiveAfterTurn: boolean | null;
  /** How many times the plugin called `/run-turn`. */
  runTurnCalls: number;
  /** How many times the runtime's runTurn was called. */
  runtimeCalls: number;
};

type ScriptState = {
  steps: FakeBridgeStep[];
  runTurnCalls: number;
  payload: Record<string, unknown> | null;
  confirmationAnswers: Array<{ requestId: string; approved: boolean }>;
  confirmationWaiters: Array<() => void>;
  mcpCallResults: Array<{ ok: boolean; text: string }>;
  abort: () => void;
  bump: () => void;
};

function scopeTokenFromPayload(payload: Record<string, unknown> | null): {
  token: string;
  headerNames: string[];
} {
  const servers = (payload?.mcpServers || {}) as Record<
    string,
    { headers?: Record<string, string> }
  >;
  for (const server of Object.values(servers)) {
    const headers = server?.headers || {};
    const token = headers[ZOTERO_MCP_SCOPE_HEADER];
    if (token) return { token, headerNames: Object.keys(headers).sort() };
  }
  return { token: "", headerNames: [] };
}

async function callMcpEndpoint(
  scopeToken: string,
  name: string,
  args: unknown,
): Promise<{ ok: boolean; text: string }> {
  const Endpoint = (
    Zotero.Server.Endpoints as unknown as Record<
      string,
      new () => {
        init(request: unknown): Promise<[number, string, string]>;
      }
    >
  )[ZOTERO_MCP_ENDPOINT_PATH];
  if (!Endpoint) return { ok: false, text: "MCP endpoint not registered" };
  const [status, , body] = await new Endpoint().init({
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      [ZOTERO_MCP_SCOPE_HEADER]: scopeToken,
    },
    data: {
      jsonrpc: "2.0",
      id: `fake-bridge-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const parsed = (() => {
    try {
      return JSON.parse(body) as {
        error?: unknown;
        result?: { isError?: boolean };
      };
    } catch {
      return null;
    }
  })();
  return {
    ok:
      status === 200 &&
      Boolean(parsed) &&
      !parsed?.error &&
      parsed?.result?.isError !== true,
    text: body,
  };
}

/**
 * The `/run-turn` response: the script's lines, streamed as they run. The
 * plugin scope has no ReadableStream, so this is the part of a Response the
 * turn host reads: `ok`, `status`, and `body.getReader()`.
 */
function streamScript(
  state: ScriptState,
  signal: AbortSignal | undefined,
): Response {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let waitedConfirmations = 0;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const onAbort = () => {
    // The plugin scope has no DOMException; fetch rejects with this shape.
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    failure = aborted;
    for (const wakeWaiter of state.confirmationWaiters.splice(0)) wakeWaiter();
    notify();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      for (const step of state.steps) {
        if (failure) return;
        if ("line" in step) {
          chunks.push(encoder.encode(`${JSON.stringify(step.line)}\n`));
          notify();
          // Let the plugin read the line before the next step runs.
          await new Promise((resolve) => setTimeout(resolve, 20));
        } else if ("mcpCall" in step) {
          const { token } = scopeTokenFromPayload(state.payload);
          state.mcpCallResults.push(
            await callMcpEndpoint(
              token,
              step.mcpCall.name,
              step.mcpCall.arguments,
            ),
          );
        } else if ("waitForConfirmation" in step) {
          // Each wait consumes one answer, whether it came before or after.
          const wanted = ++waitedConfirmations;
          while (state.confirmationAnswers.length < wanted && !failure) {
            await new Promise<void>((resolve) =>
              state.confirmationWaiters.push(resolve),
            );
          }
        } else if ("abort" in step) {
          state.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else if ("bumpGeneration" in step) {
          state.bump();
        }
      }
    } finally {
      done = true;
      signal?.removeEventListener("abort", onAbort);
      notify();
    }
  })();
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      for (;;) {
        if (failure) throw failure;
        if (chunks.length) return { done: false, value: chunks.shift() };
        if (done) return { done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

function installFakeBridgeFetch(state: ScriptState): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" || input instanceof URL
        ? input
        : (input as Request).url,
    );
    if (!url.startsWith(FAKE_BRIDGE_BASE)) return realFetch(input, init);
    const path = url.slice(FAKE_BRIDGE_BASE.length);
    const body = (() => {
      try {
        return JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
      } catch {
        return {};
      }
    })();
    if (path === "/run-turn") {
      state.runTurnCalls += 1;
      state.payload = body;
      return streamScript(state, init?.signal || undefined);
    }
    if (path === "/resolve-confirmation") {
      state.confirmationAnswers.push({
        requestId: String(body.requestId || ""),
        approved: Boolean(body.approved),
      });
      for (const wake of state.confirmationWaiters.splice(0)) wake();
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, {});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function setPrefRaw(name: string, value: unknown): void {
  const key = `${config.prefsPrefix}.${name}`;
  if (value === undefined) Zotero.Prefs.clear(key, true);
  else Zotero.Prefs.set(key, value as string, true);
}

export async function exerciseClaudeBridgeTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  scenario: ExternalTurnScenario,
): Promise<ExternalTurnResult> {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const deps = buildAgentEngineDepsForTests(
    item,
    "claude_code",
    getConversationWriteGeneration(key),
  );
  const coreRuntime = getCoreAgentRuntime();
  const state: ScriptState = {
    steps: scenario.steps,
    runTurnCalls: 0,
    payload: null,
    confirmationAnswers: [],
    confirmationWaiters: [],
    mcpCallResults: [],
    abort: () => deps.currentAbortController(key)?.abort(),
    bump: () => void bumpConversationWriteGeneration(key),
  };
  const bridgeRuntime = bindClaudeBridgeConversationSystem(
    createExternalBackendBridgeRuntime({
      coreRuntime,
      getBridgeUrl: () => FAKE_BRIDGE_BASE,
    }),
    "claude_code",
  );
  const deliveredEvents: string[] = [];
  let outcome: AgentRuntimeOutcome | null = null;
  let threw = "";
  let runtimeCalls = 0;
  deps.getAgentRuntime = () =>
    ({
      ...bridgeRuntime,
      runTurn: async (params: Parameters<typeof bridgeRuntime.runTurn>[0]) => {
        runtimeCalls += 1;
        try {
          outcome = await bridgeRuntime.runTurn({
            ...params,
            onEvent: async (event: AgentEvent) => {
              deliveredEvents.push(event.type);
              if (
                event.type === "confirmation_required" &&
                scenario.approve !== undefined
              ) {
                const approved = scenario.approve;
                setTimeout(
                  () =>
                    coreRuntime.resolveConfirmation(event.requestId, approved),
                  10,
                );
              }
              await params.onEvent?.(event);
            },
          });
          return outcome;
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    }) as never;

  const prefsBefore = {
    claudeCodeBridgeMode: Zotero.Prefs.get(
      `${config.prefsPrefix}.claudeCodeBridgeMode`,
      true,
    ),
    agentBackendBridgeUrl: Zotero.Prefs.get(
      `${config.prefsPrefix}.agentBackendBridgeUrl`,
      true,
    ),
    enableClaudeCodeMode: Zotero.Prefs.get(
      `${config.prefsPrefix}.enableClaudeCodeMode`,
      true,
    ),
  };
  const mcpBefore = isNativeZoteroMcpToolsEnabled();
  // Any bridge call outside the turn host (session capture, warm-up) also
  // reaches the fake, never a real bridge on this machine.
  setPrefRaw("claudeCodeBridgeMode", "custom");
  setPrefRaw("agentBackendBridgeUrl", FAKE_BRIDGE_BASE);
  // A Claude Code user has the mode on; without it the runtime reports no
  // tool support and the engine probes it with an extra plain turn.
  Zotero.Prefs.set(`${config.prefsPrefix}.enableClaudeCodeMode`, true, true);
  setNativeZoteroMcpToolsEnabled(Boolean(scenario.mcp));
  const restoreFetch = installFakeBridgeFetch(state);
  // The panel creates the conversation's Stop controller before it sends.
  const previousController = getAbortController(key);
  setAbortController(key, createAbortController());
  try {
    await sendAgentTurn(
      { body, item, question: scenario.question },
      deps,
    ).catch((error) => {
      threw ||= error instanceof Error ? error.message : String(error);
    });
    const { token, headerNames } = scopeTokenFromPayload(state.payload);
    const scopeLiveAfterTurn = token
      ? (await callMcpEndpoint(token, "library_search", { query: "x" })).ok
      : null;
    const message = deps.chatHistory.get(key)?.at(-1);
    const runId = message?.agentRunId || "";
    const trace = runId ? await getAgentRunTrace(runId) : null;
    const finished = outcome as AgentRuntimeOutcome | null;
    return {
      outcomeKind: finished ? finished.kind : "threw",
      outcomeText: finished
        ? finished.kind === "completed"
          ? finished.text
          : "reason" in finished
            ? String(finished.reason)
            : "message" in finished
              ? String(finished.message)
              : ""
        : threw,
      deliveredEvents,
      storedEvents: (trace?.events || []).map((event) =>
        String((event.payload as { type?: unknown }).type),
      ),
      runStatus: trace?.run?.status,
      runFinalText: trace?.run?.finalText,
      messageText: message?.text,
      runTurnPayload: state.payload
        ? {
            hasMcpServers: Boolean(state.payload.mcpServers),
            mcpHeaderNames: headerNames,
            allowedTools: Array.isArray(state.payload.allowedTools)
              ? (state.payload.allowedTools as string[])
              : [],
            scopeToken: token,
          }
        : null,
      confirmationAnswers: state.confirmationAnswers,
      mcpCallResults: state.mcpCallResults,
      scopeLiveAfterTurn,
      runTurnCalls: state.runTurnCalls,
      runtimeCalls,
    };
  } finally {
    setAbortController(key, previousController);
    restoreFetch();
    setNativeZoteroMcpToolsEnabled(mcpBefore);
    setPrefRaw("claudeCodeBridgeMode", prefsBefore.claudeCodeBridgeMode);
    setPrefRaw("agentBackendBridgeUrl", prefsBefore.agentBackendBridgeUrl);
    if (prefsBefore.enableClaudeCodeMode === undefined)
      Zotero.Prefs.clear(`${config.prefsPrefix}.enableClaudeCodeMode`, true);
    else
      Zotero.Prefs.set(
        `${config.prefsPrefix}.enableClaudeCodeMode`,
        prefsBefore.enableClaudeCodeMode,
        true,
      );
  }
}
