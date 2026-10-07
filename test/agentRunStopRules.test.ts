import { assert } from "chai";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import {
  clearAgentTranscriptStore,
  loadAgentTranscriptSegment,
  PORTABLE_TRANSCRIPT_KEY,
} from "../src/agent/store/transcriptStore";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { INTERRUPTED_AGENT_RUN_MARKER } from "../src/agent/store/traceStore";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import { TAVILY_API_KEY_PREF } from "../src/webAccess/prefs";
import type { WebAccessProvider } from "../src/webAccess/types";
import {
  MAX_AGENT_ROUNDS,
  MAX_AGENT_TOOL_CALLS_PER_ROUND,
} from "../src/agent/model/limits";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../src/agent/types";
import {
  installMockDb,
  type InstalledMockDb,
  type MockDbRow,
} from "./helpers/agentRuntimeMockDb";

/**
 * Golden endings of the Original Agent loop.
 *
 * Each case drives `AgentRuntime.runTurn` to one ending and pins what that
 * ending produced before the loop named its stop rules: the outcome (or the
 * error) and the run row as persisted. Each case then checks that the ending
 * named its rule exactly once, both to the live observer and in the trace.
 */

const TOOL_CAPABILITIES: AgentModelCapabilities = {
  streaming: false,
  toolCalls: true,
  multimodal: false,
  fileInputs: false,
  reasoning: false,
};

type StopRecord = Record<string, unknown>;

type Ending = {
  outcome?: AgentRuntimeOutcome;
  error?: unknown;
  run: MockDbRow;
  /** Stop records the live observer received, in order. */
  liveStops: StopRecord[];
  /** Stop records persisted in the run's trace, in order. */
  persistedStops: StopRecord[];
};

function stopRecords(events: readonly AgentEvent[]): StopRecord[] {
  return events.flatMap((event) =>
    event.type === "provider_event" && event.providerType === "agent_run_stop"
      ? [{ ...event.payload }]
      : [],
  );
}

function assertStoppedBy(
  ending: Ending,
  rule: string,
  status: "completed" | "failed" | "cancelled",
): void {
  assert.deepEqual(
    ending.liveStops,
    [{ rule, status }],
    "the live observer hears the stop rule exactly once",
  );
  assert.deepEqual(
    ending.persistedStops,
    [{ rule, status }],
    "the trace records the stop rule exactly once",
  );
  assert.equal(
    ending.run.status,
    status,
    "the stop record names the status the run was finished with",
  );
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

function toolStep(calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

/** An adapter that answers each model step with `next(stepNumber, params)`. */
function scriptedAdapter(
  next: (
    step: number,
    params: AgentStepParams,
  ) => AgentModelStep | Promise<AgentModelStep>,
  capabilities: AgentModelCapabilities = TOOL_CAPABILITIES,
): AgentModelAdapter & { steps: () => number } {
  let step = 0;
  return {
    getCapabilities: () => capabilities,
    supportsTools: () => capabilities.toolCalls,
    runStep: async (params) => next(++step, params),
    steps: () => step,
  };
}

function baseRequest(
  conversationKey: number,
  userText: string,
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey,
    mode: "agent",
    userText,
    model: "gpt-5.4",
    apiBase: "",
    apiKey: "test",
    ...overrides,
  };
}

async function runToEnding(
  installed: InstalledMockDb,
  params: {
    adapter: AgentModelAdapter;
    request: AgentRuntimeRequest;
    registry?: AgentToolRegistry;
    signal?: AbortSignal;
  },
): Promise<Ending> {
  const runtime = new AgentRuntime({
    registry: params.registry || new AgentToolRegistry(),
    adapterFactory: () => params.adapter,
  });
  const liveEvents: AgentEvent[] = [];
  let outcome: AgentRuntimeOutcome | undefined;
  let error: unknown;
  try {
    outcome = await runtime.runTurn({
      request: params.request,
      signal: params.signal,
      onEvent: (event) => {
        liveEvents.push(event);
      },
    });
  } catch (caught) {
    error = caught;
  }
  const runs = [...installed.runs.values()].filter(
    (entry) => Number(entry.conversationKey) === params.request.conversationKey,
  );
  assert.lengthOf(runs, 1, "a turn writes exactly one run row");
  const persistedEvents = installed.events
    .filter((row) => row.runId === runs[0].runId)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((row) => JSON.parse(String(row.payloadJson)) as AgentEvent);
  return {
    outcome,
    error,
    run: runs[0],
    liveStops: stopRecords(liveEvents),
    persistedStops: stopRecords(persistedEvents),
  };
}

function registerTerminalTool(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "finish_with_result",
      description: "Finish the turn with a terminal result",
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ done: true }),
    resolveTerminalResult: async () => ({
      finalText: "Terminal result.",
      providerTranscript: "tool_only",
    }),
  });
}

function registerReadTool(
  registry: AgentToolRegistry,
  execute: () => Promise<unknown>,
  validate: (
    args: unknown,
  ) => { ok: true; value: unknown } | { ok: false; error: string } = () => ({
    ok: true,
    value: {},
  }),
): void {
  registry.register({
    spec: {
      name: "read_notes",
      description: "Read notes",
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
    validate: validate as never,
    execute: execute as never,
  });
}

const readCall = (id: string, args: unknown = {}): AgentToolCall => ({
  id,
  name: "read_notes",
  arguments: args,
});

const webProvider: WebAccessProvider = {
  search: async (request) => ({
    provider: "tavily",
    query: request.query,
    depth: request.depth,
    topic: request.topic,
    results: [
      {
        sourceId: "provider-source",
        url: "https://example.com/current",
        hostname: "example.com",
        organization: "Example",
        title: "Current facts",
        snippet: "A current fact",
      },
    ],
    usage: { credits: 1 },
  }),
  read: async (request) => ({
    provider: "tavily",
    query: request.query,
    depth: request.depth,
    pages: [],
    failedResults: [],
    usage: { credits: 0 },
  }),
  getUsage: async () => ({
    key: { usage: 0, limit: 1000, searchUsage: 0, extractUsage: 0 },
    account: {
      currentPlan: "Free",
      planUsage: 0,
      planLimit: 1000,
      paygoUsage: 0,
      paygoLimit: 0,
    },
  }),
};

describe("Original Agent run endings", function () {
  let installed: InstalledMockDb;

  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
    installed = installMockDb();
  });

  afterEach(function () {
    installed();
  });

  it("final_answer: publishes an accepted final answer", async function () {
    const ending = await runToEnding(installed, {
      adapter: scriptedAdapter(() => finalStep("The answer.")),
      request: baseRequest(97_301, "Answer directly"),
    });

    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text: "The answer.",
      usedFallback: false,
    });
    assert.notProperty(ending.outcome, "runStatus");
    assert.equal(ending.run.status, "completed");
    assert.equal(ending.run.finalText, "The answer.");
    assertStoppedBy(ending, "final_answer", "completed");
  });

  it("terminal_tool: ends with the terminal result of a tool the model called", async function () {
    const registry = new AgentToolRegistry();
    registerTerminalTool(registry);
    const ending = await runToEnding(installed, {
      registry,
      adapter: scriptedAdapter(() =>
        toolStep([
          { id: "finish-1", name: "finish_with_result", arguments: {} },
        ]),
      ),
      request: baseRequest(97_302, "Finish with the tool"),
    });

    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text: "Terminal result.",
    });
    assert.equal(ending.run.status, "completed");
    assert.equal(ending.run.finalText, "Terminal result.");
    assertStoppedBy(ending, "terminal_tool", "completed");
  });

  it("provider_terminal_outcome: ends with a terminal tool the provider ran through its callback", async function () {
    const registry = new AgentToolRegistry();
    registerTerminalTool(registry);
    const ending = await runToEnding(installed, {
      registry,
      adapter: scriptedAdapter(async (_step, params) => {
        await params.onToolCall!({
          id: "finish-native",
          name: "finish_with_result",
          arguments: {},
        });
        return finalStep("This text is never published.");
      }),
      request: baseRequest(97_303, "Finish natively"),
    });

    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text: "Terminal result.",
    });
    assert.equal(ending.run.status, "completed");
    assert.equal(ending.run.finalText, "Terminal result.");
    assertStoppedBy(ending, "provider_terminal_outcome", "completed");
  });

  it("repeated_tool_errors: stops after three rounds of failing tools", async function () {
    const registry = new AgentToolRegistry();
    registerReadTool(registry, async () => {
      throw new Error("the notes store is unavailable");
    });
    const adapter = scriptedAdapter((step) => toolStep([readCall(`c${step}`)]));
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      request: baseRequest(97_304, "Read the notes"),
    });

    const text =
      "Agent stopped after repeated tool errors. Please adjust the request and try again.";
    assert.equal(adapter.steps(), 3);
    // It answered, so it completed; the run was stored as failed.
    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text,
      runStatus: "failed",
    });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "repeated_tool_errors", "failed");
  });

  it("repeated_input_rejections: stops after six rounds of rejected tool inputs", async function () {
    const registry = new AgentToolRegistry();
    registerReadTool(
      registry,
      async () => ({ notes: [] }),
      () => ({ ok: false, error: "query is required" }),
    );
    const adapter = scriptedAdapter((step) => toolStep([readCall(`c${step}`)]));
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      request: baseRequest(97_305, "Read the notes"),
    });

    const text =
      "Agent stopped after repeated invalid tool inputs. Please adjust the request and try again.";
    assert.equal(adapter.steps(), 6);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "repeated_input_rejections", "failed");
  });

  it("tool_call_overflow: stops when a retried step still asks for too many tool calls", async function () {
    const registry = new AgentToolRegistry();
    registerReadTool(registry, async () => ({ notes: [] }));
    const callCount = MAX_AGENT_TOOL_CALLS_PER_ROUND + 1;
    const adapter = scriptedAdapter((step) =>
      toolStep(
        Array.from({ length: callCount }, (_, index) =>
          readCall(`c${step}-${index}`),
        ),
      ),
    );
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      request: baseRequest(97_306, "Read everything at once"),
    });

    const text = `The model returned ${callCount} tool calls in one step, exceeding the safe limit of ${MAX_AGENT_TOOL_CALLS_PER_ROUND}. None of those calls were executed. Please narrow the request and try again.`;
    assert.equal(adapter.steps(), 2);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "tool_call_overflow", "failed");
  });

  it("segment_without_progress: stops when a full segment only repeats prior work", async function () {
    const registry = new AgentToolRegistry();
    registerReadTool(registry, async () => ({ notes: ["unchanged"] }));
    const adapter = scriptedAdapter((step) =>
      toolStep([readCall(`repeat-${step}`, { index: 1 })]),
    );
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      request: baseRequest(97_307, "Keep reading until done"),
    });

    const text =
      "Agent stopped after segment 2 produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.";
    assert.equal(adapter.steps(), MAX_AGENT_ROUNDS * 2);
    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text,
      runStatus: "failed",
    });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "segment_without_progress", "failed");
  });

  it("answer_continuation_limit: delivers a repeatedly truncated answer with a note", async function () {
    const adapter = scriptedAdapter(
      async (step, params) => {
        const chunk = `part ${step} `;
        await params.onTextDelta?.(chunk);
        return {
          kind: "incomplete",
          reason: "output_limit",
          text: chunk,
          recoveryInstruction: "Continue with a complete tool call.",
          assistantMessage: { role: "assistant", content: chunk },
        };
      },
      { ...TOOL_CAPABILITIES, streaming: true },
    );
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_308, "Write the full review", {
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/v1",
        advanced: { outputTokenLimit: { mode: "auto" } },
      }),
    });

    // Each chunk adds new text, and deepseek-chat's 1M window holds about a
    // hundred full-size answers (891,808 / 8,192), so the continuations run
    // to the end of the segment, where the kept text ships.
    const parts = Array.from(
      { length: MAX_AGENT_ROUNDS },
      (_, index) => `part ${index + 1} `,
    ).join("");
    const text = `${parts}\n\n[This answer was cut short by the provider's output limit ${MAX_AGENT_ROUNDS} times. Ask to continue if it is incomplete.]`;
    assert.equal(adapter.steps(), MAX_AGENT_ROUNDS);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "completed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "answer_continuation_limit", "completed");
  });

  it("answer_continuation_limit: delivers the answer when a continuation only repeats it", async function () {
    const adapter = scriptedAdapter(
      async (_step, params) => {
        const chunk = "The review covers drift in CA1. ";
        await params.onTextDelta?.(chunk);
        return {
          kind: "incomplete",
          reason: "output_limit",
          text: chunk,
          recoveryInstruction: "Continue with a complete tool call.",
          assistantMessage: { role: "assistant", content: chunk },
        };
      },
      { ...TOOL_CAPABILITIES, streaming: true },
    );
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_318, "Write the full review", {
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/v1",
        advanced: { outputTokenLimit: { mode: "auto" } },
      }),
    });

    const text = `The review covers drift in CA1. The review covers drift in CA1. \n\n[This answer was cut short by the provider's output limit 2 times. Ask to continue if it is incomplete.]`;
    assert.equal(adapter.steps(), 2);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "completed");
    assertStoppedBy(ending, "answer_continuation_limit", "completed");
  });

  it("stream_interrupted_again: stops when the stream breaks after its one retry", async function () {
    const adapter = scriptedAdapter(
      () =>
        ({
          kind: "incomplete",
          reason: "stream_interrupted",
          text: "",
          recoveryInstruction: "Retry the unfinished step",
        }) as AgentModelStep,
      { ...TOOL_CAPABILITIES, streaming: true },
    );
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_309, "Finish this task"),
    });

    const text =
      "The response stream failed again after one automatic retry. Durable Plan progress was preserved; continue when the connection is available.";
    assert.equal(adapter.steps(), 2);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "stream_interrupted_again", "failed");
  });

  it("incomplete_step_limit: stops when incomplete steps reach the round limit", async function () {
    const adapter = scriptedAdapter(
      () => ({
        kind: "incomplete",
        reason: "output_limit",
        text: "",
        recoveryInstruction: "Continue with a complete tool call.",
        assistantMessage: { role: "assistant", content: "" },
      }),
      { ...TOOL_CAPABILITIES, streaming: true },
    );
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_310, "Finish this task", {
        apiBase: "https://api.openai.com/v1/responses",
        advanced: { outputTokenLimit: { mode: "custom", tokens: 128 } },
      }),
    });

    const text =
      "The custom per-response output limit (128 tokens) repeatedly prevented the model from completing the required structured step. Raise the limit in Advanced settings, then continue; durable Plan progress was preserved.";
    assert.equal(adapter.steps(), MAX_AGENT_ROUNDS);
    assert.deepInclude(ending.outcome, { kind: "completed", text });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "incomplete_step_limit", "failed");
  });

  it("final_gate_rejected: fails closed when the final gate rejects an answer it cannot correct", async function () {
    Zotero.Prefs.set(TAVILY_API_KEY_PREF, "tvly-test", true);
    const registry = new AgentToolRegistry();
    registry.register(createWebSearchTool(() => webProvider));
    const search: AgentToolCall = {
      id: "web-call-1",
      name: "web_search",
      arguments: { query: "current fact", depth: "basic" },
    };
    const adapter = scriptedAdapter((step) =>
      step === 1
        ? toolStep([search])
        : finalStep(
            step === 2 ? "First uncited claim." : "Second uncited claim.",
          ),
    );
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      request: baseRequest(97_311, "What is current?", {
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/chat/completions",
        authMode: "api_key",
      }),
    });

    const text =
      "I used web access for this task, but could not safely attach valid paragraph-level sources to the answer.";
    assert.equal(adapter.steps(), 3);
    // It answered, so it completed; the run was stored as failed.
    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text,
      runStatus: "failed",
    });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "final_gate_rejected", "failed");
  });

  it("prompt_budget_exceeded: stops when protected context cannot fit the input budget", async function () {
    const adapter = scriptedAdapter(() => finalStep("Never reached."));
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_312, "X".repeat(30_000), {
        model: "claude-haiku-4-5",
        advanced: { inputTokenCap: 2_000 },
      }),
    });

    assert.equal(adapter.steps(), 0, "no oversized request is sent");
    assert.equal(ending.outcome?.kind, "completed");
    const text =
      ending.outcome?.kind === "completed" ? ending.outcome.text : "";
    assert.match(
      text,
      /^I could not safely continue because the current protected context is still above the active input budget \(\d+ estimated tokens > \d+ send budget; context window \d+\)\. I did not send an oversized provider request, and retrieved tool\/source records remain preserved in the trace and internal ledgers\. To continue, raise the Input cap or switch to a larger-context model, narrow the question\/scope, or ask me to answer from a smaller evidence subset with explicit coverage limits\.$/,
    );
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, text);
    assertStoppedBy(ending, "prompt_budget_exceeded", "failed");
  });

  it("cancelled_before_step: finishes as cancelled when the user stops before the next model step", async function () {
    const controller = new AbortController();
    const registry = new AgentToolRegistry();
    registerReadTool(registry, async () => {
      controller.abort();
      return { notes: [] };
    });
    const adapter = scriptedAdapter((step) => toolStep([readCall(`c${step}`)]));
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      signal: controller.signal,
      request: baseRequest(97_313, "Read the notes"),
    });

    assert.equal(adapter.steps(), 1);
    assert.isUndefined(ending.error);
    assert.deepEqual(ending.outcome, {
      kind: "cancelled",
      runId: String(ending.run.runId),
    });
    assert.equal(ending.run.status, "cancelled");
    assert.isNull(ending.run.finalText);
    assertStoppedBy(ending, "cancelled_before_step", "cancelled");
  });

  it("cancelled_before_step: a round Stop cut short keeps the result it let finish, beside the call it kept from starting", async function () {
    const controller = new AbortController();
    const registry = new AgentToolRegistry();
    let runs = 0;
    registerReadTool(registry, async () => {
      runs += 1;
      // The user presses Stop while the round's first call runs.
      controller.abort();
      return { notes: ["kept note"] };
    });
    const adapter = scriptedAdapter(() =>
      toolStep([readCall("c1"), readCall("c2")]),
    );
    const ending = await runToEnding(installed, {
      registry,
      adapter,
      signal: controller.signal,
      request: baseRequest(97_319, "Read the notes twice"),
    });

    assert.equal(runs, 1, "Stop kept the second call from starting");
    assert.equal(adapter.steps(), 1);
    // The round reaches the stored transcript whole, so a resumed model
    // neither redoes the call that ran nor takes the other for done.
    const stored = await loadAgentTranscriptSegment({
      conversationKey: 97_319,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    const results = new Map(
      stored.messages.flatMap((message) =>
        message.role === "user" && message.retainedTool
          ? [[message.retainedTool.callId, String(message.content)] as const]
          : [],
      ),
    );
    assert.deepEqual([...results.keys()], ["c1", "c2"]);
    assert.include(results.get("c1"), "kept note");
    assert.notInclude(results.get("c1"), "not_started");
    assert.include(results.get("c2"), '"status":"not_started"');
    assert.include(results.get("c2"), "Stopped before it started");
    // The next model step ends the run, as Stop between rounds does.
    assert.isUndefined(ending.error);
    assert.equal(ending.outcome?.kind, "cancelled");
    assert.equal(ending.run.status, "cancelled");
    assertStoppedBy(ending, "cancelled_before_step", "cancelled");
  });
  it("cancelled_in_flight: finishes as cancelled when the user stops a step in flight", async function () {
    const controller = new AbortController();
    const thrown = new Error("The request was aborted.");
    const adapter = scriptedAdapter(() => {
      controller.abort();
      throw thrown;
    });
    const ending = await runToEnding(installed, {
      adapter,
      signal: controller.signal,
      request: baseRequest(97_314, "Explain this topic"),
    });

    assert.isUndefined(ending.error);
    assert.deepEqual(ending.outcome, {
      kind: "cancelled",
      runId: String(ending.run.runId),
      cause: thrown,
    });
    assert.equal(ending.run.status, "cancelled");
    assert.equal(ending.run.finalText, "The request was aborted.");
    assertStoppedBy(ending, "cancelled_in_flight", "cancelled");
  });

  it("interrupted_by_error: marks the run interrupted when the provider throws", async function () {
    const thrown = new Error("provider interrupted");
    const adapter = scriptedAdapter(() => {
      throw thrown;
    });
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_315, "Explain this topic"),
    });

    assert.isUndefined(ending.error);
    assert.deepEqual(ending.outcome, {
      kind: "failed",
      runId: String(ending.run.runId),
      message: "provider interrupted",
      interrupted: true,
      cause: thrown,
    });
    assert.equal(ending.run.status, "failed");
    assert.equal(ending.run.finalText, INTERRUPTED_AGENT_RUN_MARKER);
    assertStoppedBy(ending, "interrupted_by_error", "failed");
  });

  it("ends once: a run whose ending fails partway is not ended a second time", async function () {
    // The answer is accepted, and then the run row's write fails.
    const db = (globalThis as any).Zotero.DB;
    const query = db.queryAsync;
    let rowWrites = 0;
    db.queryAsync = async (sql: string, params?: unknown[]) => {
      if (
        sql.includes("UPDATE llm_for_zotero_agent_runs") &&
        !sql.includes("WHERE status = 'running'")
      ) {
        rowWrites += 1;
        if (rowWrites === 1) throw new Error("Injected run row write failure");
      }
      return query(sql, params);
    };
    const ending = await runToEnding(installed, {
      adapter: scriptedAdapter(() => finalStep("The answer.")),
      request: baseRequest(97_320, "Explain this topic"),
    });

    assert.equal(
      (ending.error as Error)?.message,
      "Injected run row write failure",
    );
    assert.deepEqual(
      ending.liveStops,
      [{ rule: "final_answer", status: "completed" }],
      "the run's one ending is the only one heard",
    );
    assert.deepEqual(ending.persistedStops, [
      { rule: "final_answer", status: "completed" },
    ]);
    assert.equal(rowWrites, 1, "the run row is finished once");
    // Its one write failed, so the row stays as the startup sweep finds it,
    // never marked interrupted after the run answered.
    assert.equal(ending.run.status, "running");
    assert.isNull(ending.run.finalText);
  });

  it("tools_unsupported_fallback: hands a tool-less model back for a direct response", async function () {
    const adapter = scriptedAdapter(() => finalStep("Never reached."), {
      ...TOOL_CAPABILITIES,
      toolCalls: false,
    });
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_316, "hello", {
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/chat/completions",
      }),
    });

    assert.equal(adapter.steps(), 0);
    assert.deepInclude(ending.outcome, {
      kind: "fallback",
      reason:
        "Agent tools unavailable for this model; used direct response instead.",
      usedFallback: true,
    });
    assert.equal(ending.run.status, "completed");
    assert.isNull(ending.run.finalText);
    assertStoppedBy(ending, "tools_unsupported_fallback", "completed");
  });

  it("manual_compaction: ends a /compact turn without a model step", async function () {
    const adapter = scriptedAdapter(() => finalStep("Never reached."));
    const ending = await runToEnding(installed, {
      adapter,
      request: baseRequest(97_317, "/compact"),
    });

    assert.equal(adapter.steps(), 0);
    assert.deepInclude(ending.outcome, {
      kind: "completed",
      text: "Nothing to compact yet",
    });
    assert.equal(ending.run.status, "completed");
    assert.equal(ending.run.finalText, "Nothing to compact yet");
    assertStoppedBy(ending, "manual_compaction", "completed");
  });
});

describe("run stop rule declarations", function () {
  const read = (path: string): ts.SourceFile => {
    const text = readFileSync(path, "utf8");
    // A file that moved, emptied or was reduced to a stub would let the scans
    // below pass without proving anything.
    assert.isAbove(
      text.length,
      200,
      `${path} was read but looks empty; the scan would pass vacuously`,
    );
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  };

  function declaredRules(): string[] {
    const source = read("src/agent/loop/stopRules.ts");
    const alias = source.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === "RunStopRule",
    );
    if (!alias) throw new Error("stopRules.ts must declare RunStopRule");
    if (!ts.isUnionTypeNode(alias.type))
      throw new Error("RunStopRule must be a union of string literals");
    return alias.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal))
        throw new Error(`${member.getText(source)} is not a string literal`);
      return member.literal.text;
    });
  }

  function collect<T extends ts.Node>(
    source: ts.SourceFile,
    matches: (node: ts.Node) => node is T,
  ): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node) => {
      if (matches(node)) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it("names every declared rule at an ending of the loop", function () {
    const rules = declaredRules();
    assert.isAbove(rules.length, 15, "the declared rules were read");
    assert.equal(
      new Set(rules).size,
      rules.length,
      "no rule is declared twice",
    );
    const literals = new Set(
      collect(read("src/agent/runtime.ts"), ts.isStringLiteral).map(
        (literal) => literal.text,
      ),
    );
    assert.deepEqual(
      rules.filter((rule) => !literals.has(rule)),
      [],
      "declared rules that no ending in runtime.ts names",
    );
  });

  it("finishes a run from one place inside the loop", function () {
    const source = read("src/agent/runtime.ts");
    const calls = collect(
      source,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "finishAgentRun",
    );
    assert.lengthOf(
      calls,
      1,
      `finishAgentRun must be called only by terminateRun; found:\n${calls
        .map((call) => call.getText(source))
        .join("\n")}`,
    );
    let owner: ts.Node | undefined = calls[0].parent;
    while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
    assert.equal(
      owner && ts.isVariableDeclaration(owner)
        ? owner.name.getText(source)
        : undefined,
      "terminateRun",
    );
  });
});
