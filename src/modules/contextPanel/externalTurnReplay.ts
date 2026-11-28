/**
 * Workflow-test fixture: one Claude Code turn through the real panel, agent
 * engine, and external-runtime turn host, against a scripted bridge.
 *
 * The bridge server is the only fake. Its address is a fake custom bridge
 * URL, and `fetch` answers that address from a script: `/run-turn` streams
 * the script's lines, `/resolve-confirmation` records the answer,
 * `/session-info` reports a session for the chat, `/invalidate-session` counts
 * the call, and other paths answer 404. Every other request (the plugin's own Zotero MCP server)
 * goes to the real `fetch`. A script step can also call a tool on the
 * plugin's MCP endpoint with the scope token the turn handed the bridge, as
 * Claude would, so the per-turn scope, tool activity, and review cards run
 * for real.
 */

import { config } from "../../../package.json";
import { retryAgentTurn, sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { bindProvisionedConversationKey } from "./conversationIdentity";
import { createClaudePaperConversation } from "../../claudeCode/store";
import { panelPaperPdfContext } from "./antigravityTurnReplay";
import {
  detachRuntimeSessionForResend,
  finishPendingRuntimeSessionResets,
  PENDING_RESET_REFUSAL,
} from "./runtimeSessionReset";
import {
  buildClaudeScope,
  updateClaudeRuntimeRetention,
} from "../../claudeCode/runtime";
import { getClaudeConversationSummary } from "../../claudeCode/store";
import { buildScopedConversationKey } from "../../shared/conversationScopedKey";
import {
  CONVERSATION_CLEANUP_JOBS_TABLE,
  enqueueConversationCleanupJob,
} from "../../core/conversations/conversationCleanupJobs";
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
import type { SelectedTextContext } from "../../shared/types";
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

/** One retry after the turn; several run in order. */
export type ExternalTurnRetry = {
  steps: FakeBridgeStep[];
  /** The bridge's `/invalidate-session` answers 500 during this retry. */
  invalidateFails?: boolean;
};

export type ExternalTurnScenario = {
  question: string;
  steps: FakeBridgeStep[];
  /** Turns the native Zotero MCP tools on for the turn. */
  mcp?: boolean;
  /** Answers every review card the turn shows; unset leaves them open. */
  approve?: boolean;
  /** Passages the user selected or quoted for the turn. */
  selectedTextContexts?: SelectedTextContext[];
  /**
   * After the turn, retries it through the agent engine's retry, as the
   * panel's Retry does, against these bridge steps.
   */
  retry?: ExternalTurnRetry | ExternalTurnRetry[];
  /**
   * After the turn, a "keep warm" retain of the chat's session is held at
   * the bridge while a Retry/Edit reset runs, then let through.
   */
  retainDuringReset?: boolean;
  /**
   * After the retries, a pending drop of the chat's current session is
   * stored, as a turn deletion whose bridge reply was lost leaves one.
   */
  plantPendingDrop?: boolean;
  /** After the retries, a "keep warm" retain of the chat; records its hint. */
  retainAfterRetries?: boolean;
  /** After the retries, the user sends these next messages, in order. */
  followUps?: Array<{
    question: string;
    steps: FakeBridgeStep[];
    /** The bridge's `/invalidate-session` answers 500 during this turn. */
    invalidateFails?: boolean;
  }>;
  /**
   * Sends the panel paper's PDF file with the turn, as the paper chip's
   * "PDF file" source does.
   */
  localPdf?: boolean;
};

export type ExternalTurnResult = {
  /** The chat the turn ran in. */
  conversationKey: number;
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
    /** The prompt text the bridge received as the user's words. */
    userText: string;
    /** The turn context the bridge places before the user's words. */
    turnContext: string;
  } | null;
  /** Answers the plugin sent to `/resolve-confirmation`. */
  confirmationAnswers: Array<{ requestId: string; approved: boolean }>;
  /** Results of `mcpCall` steps: the JSON-RPC result or error text. */
  mcpCallResults: Array<{ ok: boolean; text: string }>;
  /** Whether the turn's MCP scope still answered after the turn. */
  scopeLiveAfterTurn: boolean | null;
  /** How many times the plugin called `/run-turn`. */
  runTurnCalls: number;
  /** Calls to the bridge's `/invalidate-session`, before the retry and after. */
  invalidateSessionCalls: { beforeRetry: number; afterRetry: number };
  /**
   * Each retry in order: its `/invalidate-session` calls, and what its
   * `/run-turn` asked of the bridge (null when it sent none).
   */
  retries: Array<{
    invalidateCalls: number;
    /** The panel's status line when the retry ended. */
    status: string;
    payload: ExternalTurnResult["retryTurnPayload"];
  }>;
  /**
   * Each follow-up in order: its `/invalidate-session` calls, the panel's
   * status line when it ended, and what its `/run-turn` asked of the bridge
   * (null when it sent none).
   */
  followUps: Array<{
    invalidateCalls: number;
    status: string;
    /** The session the bridge resumed for it (null: a fresh one). */
    resumed: string | null;
    payload: ExternalTurnResult["retryTurnPayload"];
  }>;
  /**
   * With `retainDuringReset`: whether the reset succeeded, the session the
   * fake bridge maps the chat to afterwards, and the chat's saved session.
   */
  /** With `retainAfterRetries`: the session hint the retain sent ("" none). */
  retainHint?: string;
  /** With `plantPendingDrop`: the session whose drop was planted. */
  plantedSession?: string;
  /** With `retainAfterRetries`: whether its retain reached the bridge. */
  retainReachedBridge?: boolean;
  retainRace?: {
    resetOk: boolean;
    bridgeMapping: string | null;
    savedSessionId: string;
  };
  /** What the last retry's `/run-turn` asked of the bridge; null without retry. */
  retryTurnPayload: {
    providerSessionId: string;
    forceFreshSession: boolean;
    userText: string;
  } | null;
  /** How many times the runtime's runTurn was called. */
  runtimeCalls: number;
  /** The local PDF files each `/run-turn` payload carried, in order. */
  localDocumentPaths: string[][];
};

type ScriptState = {
  steps: FakeBridgeStep[];
  runTurnCalls: number;
  invalidateSessionCalls: number;
  invalidateFails: boolean;
  /**
   * Bumped when the fake drops the chat's session or starts a fresh one, so
   * `/session-info` reports a new session id, as the real bridge does.
   */
  sessionGeneration: number;
  /** The session the fake bridge maps the chat to, as the real one keeps. */
  bridgeMapping: string | null;
  /** While set, a retain waits for it before the bridge maps its session. */
  retainGate: Promise<void> | null;
  retentionRequests: number;
  /** The session hint of the latest retain ("" for none). */
  lastRetainHint: string;
  /** The session the latest `/run-turn` resumed (null: a fresh one). */
  lastResumed: string | null;

  payload: Record<string, unknown> | null;
  localDocumentPaths: string[][];
  confirmationAnswers: Array<{ requestId: string; approved: boolean }>;
  confirmationWaiters: Array<() => void>;
  mcpCallResults: Array<{ ok: boolean; text: string }>;
  abort: () => void;
  bump: () => void;
};

/** The session the fake holds for a chat: a new one after each reset. */
function fakeSessionId(state: ScriptState, conversationKey: string): string {
  return `fake-claude-session-${conversationKey}${
    state.sessionGeneration ? `-${state.sessionGeneration}` : ""
  }`;
}

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
      const runMetadata = (body.metadata || {}) as Record<string, unknown>;
      // What the bridge resumes: its mapping, unless told to start fresh.
      state.lastResumed =
        runMetadata.forceFreshSession === true ? null : state.bridgeMapping;
      if (runMetadata.forceFreshSession === true) state.sessionGeneration += 1;
      state.bridgeMapping = fakeSessionId(
        state,
        String(body.conversationKey ?? ""),
      );
      const runtimeRequest = (body.runtimeRequest || {}) as {
        localDocuments?: unknown;
      };
      state.localDocumentPaths.push(
        (Array.isArray(runtimeRequest.localDocuments)
          ? runtimeRequest.localDocuments
          : []
        ).map((document: { absolutePath?: unknown }) =>
          String(document?.absolutePath || ""),
        ),
      );
      return streamScript(state, init?.signal || undefined);
    }
    if (path.startsWith("/session-info?")) {
      // The session the real bridge reports after a turn; the panel saves
      // its id on the chat.
      const query = new URLSearchParams(path.slice("/session-info?".length));
      const conversationKey = query.get("conversationKey") || "";
      const scopeType = query.get("scopeType") || undefined;
      const scopeId = query.get("scopeId") || undefined;
      // The session the bridge maps the chat to; none after a reset.
      return jsonResponse(200, {
        session: state.bridgeMapping
          ? {
              originalConversationKey: conversationKey,
              scopedConversationKey: buildScopedConversationKey(
                Number(conversationKey),
                { scopeType, scopeId },
              ),
              providerSessionId: state.bridgeMapping,
              scopeType,
              scopeId,
              scopeLabel: query.get("scopeLabel") || undefined,
            }
          : null,
      });
    }
    if (path === "/healthz") {
      // A bridge that reads local PDF paths, as the bundled one does.
      return jsonResponse(200, {
        ok: true,
        protocolVersion: 2,
        capabilities: ["local_pdf_paths"],
      });
    }
    if (path === "/runtime-retention") {
      state.retentionRequests += 1;
      if (body.retain === true)
        state.lastRetainHint = String(body.providerSessionId || "");
      if (body.retain === true) {
        if (state.retainGate) await state.retainGate;
        // A retain with a session hint maps it, as the bridge adapter does.
        if (
          typeof body.providerSessionId === "string" &&
          body.providerSessionId
        )
          state.bridgeMapping = body.providerSessionId;
      }
      return jsonResponse(200, { retained: body.retain === true });
    }
    if (path === "/invalidate-session") {
      state.invalidateSessionCalls += 1;
      if (state.invalidateFails) return jsonResponse(500, { error: "down" });
      state.sessionGeneration += 1;
      state.bridgeMapping = null;
      return jsonResponse(200, { invalidated: true });
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
  if (
    scenario.retry ||
    scenario.retainDuringReset ||
    scenario.plantPendingDrop
  ) {
    // A retry resets the chat's Claude Code session, which needs the chat's
    // Claude Code record, as a real Claude Code chat has.
    const created = await createClaudePaperConversation(
      item.libraryID,
      item.id,
    );
    if (!created) throw new Error("Could not create a Claude Code chat");
    bindProvisionedConversationKey(item, created.conversationKey);
  }
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
    invalidateSessionCalls: 0,
    invalidateFails: false,
    sessionGeneration: 0,
    bridgeMapping: null,
    retainGate: null,
    retentionRequests: 0,
    lastRetainHint: "",
    lastResumed: null,

    localDocumentPaths: [],
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
    // As the send flow does: the PDF paper, and its file resolved for the turn.
    const pdfPaperContexts = scenario.localPdf
      ? [panelPaperPdfContext(item)]
      : undefined;
    const localDocuments = pdfPaperContexts
      ? await deps.resolveLocalPdfResources(pdfPaperContexts)
      : undefined;
    await sendAgentTurn(
      {
        body,
        item,
        question: scenario.question,
        ...(scenario.selectedTextContexts
          ? { selectedTextContexts: scenario.selectedTextContexts }
          : {}),
        ...(pdfPaperContexts ? { pdfPaperContexts, localDocuments } : {}),
      },
      deps,
    ).catch((error) => {
      threw ||= error instanceof Error ? error.message : String(error);
    });
    let retainRace: ExternalTurnResult["retainRace"];
    if (scenario.retainDuringReset) {
      let release!: () => void;
      state.retainGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const retaining = updateClaudeRuntimeRetention(getCoreAgentRuntime(), {
        conversationKey: key,
        scope: buildClaudeScope({
          libraryID: item.libraryID,
          kind: "paper",
          paperItemID: item.id,
        }),
        mountId: "fixture-mount",
        retain: true,
      }).catch(() => false);
      for (let i = 0; i < 100 && !state.retentionRequests; i += 1)
        await Zotero.Promise.delay(20);
      const resetting = detachRuntimeSessionForResend({
        conversationKey: key,
        conversationGeneration: getConversationWriteGeneration(key),
        storageSystem: "claude_code",
        kind: "paper",
      }).catch(() => false);
      await Zotero.Promise.delay(200);
      release();
      const [, resetOk] = await Promise.all([retaining, resetting]);
      state.retainGate = null;
      retainRace = {
        resetOk,
        bridgeMapping: state.bridgeMapping,
        savedSessionId: String(
          (await getClaudeConversationSummary(key))?.providerSessionId || "",
        ),
      };
    }
    const invalidatedBeforeRetry = state.invalidateSessionCalls;
    let retryTurnPayload: ExternalTurnResult["retryTurnPayload"] = null;
    const retries: ExternalTurnResult["retries"] = [];
    const retryList = Array.isArray(scenario.retry)
      ? scenario.retry
      : scenario.retry
        ? [scenario.retry]
        : [];
    for (const retry of retryList) {
      const firstPayload = state.payload;
      const invalidatedBefore = state.invalidateSessionCalls;
      state.steps = retry.steps;
      state.invalidateFails = Boolean(retry.invalidateFails);
      setAbortController(key, createAbortController());
      await retryAgentTurn(
        body,
        item,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
      ).catch((error) => {
        threw ||= error instanceof Error ? error.message : String(error);
      });
      const retried = state.payload !== firstPayload ? state.payload : null;
      const metadata = (retried?.metadata || {}) as Record<string, unknown>;
      retryTurnPayload = retried
        ? {
            providerSessionId: String(retried.providerSessionId ?? ""),
            forceFreshSession: metadata.forceFreshSession === true,
            userText: String(retried.userText ?? ""),
          }
        : null;
      retries.push({
        invalidateCalls: state.invalidateSessionCalls - invalidatedBefore,
        status: body.querySelector("#llm-status")?.textContent?.trim() || "",
        payload: retryTurnPayload,
      });
      state.invalidateFails = false;
    }
    if (scenario.plantPendingDrop) {
      const summary = await getClaudeConversationSummary(key);
      await enqueueConversationCleanupJob({
        operation: "claude_invalidate",
        system: "claude_code",
        conversationKey: key,
        instanceID: summary?.instanceID,
        conversationKind: "paper",
        libraryID: item.libraryID,
        paperItemID: item.id,
        providerScope: buildClaudeScope({
          libraryID: item.libraryID,
          kind: "paper",
          paperItemID: item.id,
        }),
        providerSessionId: String(summary?.providerSessionId || ""),
      });
    }
    const plantedSession = scenario.plantPendingDrop
      ? String(
          (await getClaudeConversationSummary(key))?.providerSessionId || "",
        )
      : "";
    let retainHint: string | undefined;
    let retainReachedBridge: boolean | undefined;
    if (scenario.retainAfterRetries) {
      const retainsBefore = state.retentionRequests;
      await updateClaudeRuntimeRetention(getCoreAgentRuntime(), {
        conversationKey: key,
        scope: buildClaudeScope({
          libraryID: item.libraryID,
          kind: "paper",
          paperItemID: item.id,
        }),
        mountId: "fixture-mount",
        retain: true,
      }).catch(() => false);
      retainHint = state.lastRetainHint;
      retainReachedBridge = state.retentionRequests > retainsBefore;
    }
    const followUps: ExternalTurnResult["followUps"] = [];
    for (const followUp of scenario.followUps || []) {
      const beforePayload = state.payload;
      const invalidatedBefore = state.invalidateSessionCalls;
      state.steps = followUp.steps;
      state.invalidateFails = Boolean(followUp.invalidateFails);
      setAbortController(key, createAbortController());
      // The first step of the panel's send (sendFlowController) for a
      // runtime chat: finish a reset an earlier Retry left pending.
      const ready = await finishPendingRuntimeSessionResets({
        conversationKey: key,
        storageSystem: "claude_code",
      }).catch(() => false);
      if (!ready) {
        followUps.push({
          invalidateCalls: state.invalidateSessionCalls - invalidatedBefore,
          resumed: null,
          status: PENDING_RESET_REFUSAL,
          payload: null,
        });
        state.invalidateFails = false;
        continue;
      }
      await sendAgentTurn(
        { body, item, question: followUp.question },
        deps,
      ).catch((error) => {
        threw ||= error instanceof Error ? error.message : String(error);
      });
      const sent = state.payload !== beforePayload ? state.payload : null;
      const metadata = (sent?.metadata || {}) as Record<string, unknown>;
      followUps.push({
        invalidateCalls: state.invalidateSessionCalls - invalidatedBefore,
        resumed: sent ? state.lastResumed : null,
        status: body.querySelector("#llm-status")?.textContent?.trim() || "",
        payload: sent
          ? {
              providerSessionId: String(sent.providerSessionId ?? ""),
              forceFreshSession: metadata.forceFreshSession === true,
              userText: String(sent.userText ?? ""),
            }
          : null,
      });
      state.invalidateFails = false;
    }
    const { token, headerNames } = scopeTokenFromPayload(state.payload);
    const scopeLiveAfterTurn = token
      ? (await callMcpEndpoint(token, "library_search", { query: "x" })).ok
      : null;
    const message = deps.chatHistory.get(key)?.at(-1);
    const runId = message?.agentRunId || "";
    const trace = runId ? await getAgentRunTrace(runId) : null;
    const finished = outcome as AgentRuntimeOutcome | null;
    return {
      conversationKey: key,
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
            userText: String(state.payload.userText ?? ""),
            turnContext: String(
              (state.payload.runtimeRequest as { turnContext?: unknown })
                ?.turnContext ?? "",
            ),
          }
        : null,
      confirmationAnswers: state.confirmationAnswers,
      mcpCallResults: state.mcpCallResults,
      scopeLiveAfterTurn,
      runTurnCalls: state.runTurnCalls,
      invalidateSessionCalls: {
        beforeRetry: invalidatedBeforeRetry,
        afterRetry: state.invalidateSessionCalls - invalidatedBeforeRetry,
      },
      retryTurnPayload,
      retries,
      followUps,
      ...(retainRace ? { retainRace } : {}),
      ...(retainHint !== undefined ? { retainHint } : {}),
      ...(scenario.plantPendingDrop ? { plantedSession } : {}),
      ...(retainReachedBridge !== undefined ? { retainReachedBridge } : {}),
      runtimeCalls,
      localDocumentPaths: state.localDocumentPaths,
    };
  } finally {
    setAbortController(key, previousController);
    // A failed reset leaves a cleanup job for the chat this fixture made;
    // the background worker would send it to the real bridge once the fake
    // is gone. A chat the fixture did not make keeps its jobs.
    if (
      scenario.retry ||
      scenario.retainDuringReset ||
      scenario.plantPendingDrop
    ) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${CONVERSATION_CLEANUP_JOBS_TABLE} WHERE conversation_key = ?`,
        [key],
      ).catch(() => undefined);
    }
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
