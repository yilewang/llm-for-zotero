import { assert } from "chai";
import {
  forgetAntigravitySentContext,
  runAntigravityPanelTurn,
  type AntigravityTurnDeps,
} from "../src/antigravity/runtime";
import type { AgyEvent } from "../src/antigravity/agyStream";
import type { AgyTurnOptions } from "../src/antigravity/agyProcess";
import type { ChatMessage, UsageStats } from "../src/shared/llm";

type Result = Extract<AgyEvent, { kind: "result" }>;

function harness(params: {
  stored?: string;
  permissionMode?: "default" | "plan" | "full";
  effort?: "auto" | "low" | "medium" | "high";
  model?: string;
  events?: AgyEvent[];
  result?: Partial<Result>;
}) {
  const calls: AgyTurnOptions[] = [];
  const remembered: Array<[number, string]> = [];
  const deps: Partial<AntigravityTurnDeps> = {
    getStoredConversationId: async () => params.stored || "",
    rememberConversationId: async (key, id) => {
      remembered.push([key, id]);
    },
    readSettings: () => ({
      binaryPath: "/opt/agy",
      model: params.model ?? "",
      effort: params.effort ?? "auto",
      permissionMode: params.permissionMode ?? "default",
      cwd: "/tmp/skills",
    }),
    runTurn: async (options) => {
      calls.push(options);
      for (const event of params.events || []) options.onEvent(event);
      return {
        kind: "result",
        conversationId: "agy-new",
        status: "SUCCESS",
        response: "",
        deniedActions: [],
        ...params.result,
      };
    },
  };
  return { calls, remembered, deps };
}

function panel() {
  const deltas: string[] = [];
  const statuses: string[] = [];
  const usage: UsageStats[] = [];
  return {
    deltas,
    statuses,
    usage,
    callbacks: {
      isLive: () => true,
      onDelta: (delta: string) => deltas.push(delta),
      onStatus: (text: string) => statuses.push(text),
      onUsage: (stats: UsageStats) => usage.push(stats),
    },
  };
}

const messages: ChatMessage[] = [
  { role: "system", content: "Paper text" },
  { role: "user", content: "First?" },
  { role: "assistant", content: "One." },
  { role: "user", content: "Second?" },
];

describe("Antigravity panel turn", function () {
  afterEach(function () {
    forgetAntigravitySentContext(41);
  });

  it("starts a new agy conversation with everything and remembers its id", async function () {
    const h = harness({
      events: [
        { kind: "text", stepIndex: 1, state: "ACTIVE", delta: "Two" },
        {
          kind: "tool",
          stepIndex: 2,
          toolName: "view_file",
          state: "ACTIVE",
        },
        { kind: "text", stepIndex: 3, state: "ACTIVE", delta: "!" },
      ],
      result: {
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });
    const p = panel();
    const outcome = await runAntigravityPanelTurn(
      { conversationKey: 41, messages, model: "default" },
      p.callbacks,
      h.deps,
    );
    assert.lengthOf(h.calls, 1);
    const call = h.calls[0];
    assert.isUndefined(call.conversationId);
    assert.isUndefined(call.model, "the default entry passes no --model");
    assert.isUndefined(call.effort);
    assert.isUndefined(call.mode);
    assert.isFalse(call.skipPermissions);
    assert.equal(call.binaryPath, "/opt/agy");
    assert.equal(call.cwd, "/tmp/skills");
    assert.include(call.prompt, "<instructions_and_context>");
    assert.include(call.prompt, "<earlier_conversation>");
    assert.deepEqual(p.deltas, ["Two", "\n\n!"]);
    assert.include(p.statuses, "Antigravity: using view file");
    assert.deepEqual(h.remembered, [[41, "agy-new"]]);
    assert.equal(outcome.text, "Two\n\n!");
    assert.deepEqual(p.usage, [
      { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    ]);
  });

  it("resumes the stored conversation and resends context only when it changed", async function () {
    const first = harness({ stored: "agy-1", result: { response: "A" } });
    await runAntigravityPanelTurn(
      { conversationKey: 41, messages },
      panel().callbacks,
      first.deps,
    );
    assert.equal(first.calls[0].conversationId, "agy-1");
    // First turn since start: the context is sent once.
    assert.include(first.calls[0].prompt, "<updated_context>");
    assert.notInclude(first.calls[0].prompt, "<earlier_conversation>");

    const second = harness({
      stored: "agy-1",
      result: { conversationId: "agy-1", response: "B" },
    });
    const outcome = await runAntigravityPanelTurn(
      { conversationKey: 41, messages },
      panel().callbacks,
      second.deps,
    );
    assert.equal(second.calls[0].prompt, "Second?");
    assert.deepEqual(second.remembered, [], "the same id is not rewritten");
    assert.equal(outcome.text, "B");
  });

  it("starts over on a retry even when a conversation is stored", async function () {
    const h = harness({ stored: "agy-1", result: { response: "C" } });
    await runAntigravityPanelTurn(
      { conversationKey: 41, messages, freshConversation: true },
      panel().callbacks,
      h.deps,
    );
    assert.isUndefined(h.calls[0].conversationId);
    assert.include(h.calls[0].prompt, "<earlier_conversation>");
    assert.deepEqual(h.remembered, [[41, "agy-new"]]);
  });

  it("maps the permission mode and effort to agy flags and reports denied actions", async function () {
    const plan = harness({ permissionMode: "plan", effort: "high" });
    await runAntigravityPanelTurn(
      { conversationKey: 41, messages, model: "gemini-x" },
      panel().callbacks,
      plan.deps,
    );
    assert.equal(plan.calls[0].mode, "plan");
    assert.equal(plan.calls[0].effort, "high");
    assert.equal(plan.calls[0].model, "gemini-x");

    const full = harness({
      permissionMode: "full",
      result: { response: "Partial", deniedActions: ["run a command"] },
    });
    const outcome = await runAntigravityPanelTurn(
      { conversationKey: 41, messages },
      panel().callbacks,
      full.deps,
    );
    assert.isTrue(full.calls[0].skipPermissions);
    assert.include(outcome.text, "Partial");
    assert.include(outcome.text, "not allowed to: run a command");
  });

  it("stops streaming to a panel that is no longer live", async function () {
    const h = harness({
      events: [{ kind: "text", stepIndex: 1, state: "ACTIVE", delta: "x" }],
      result: { response: "x" },
    });
    const deltas: string[] = [];
    await runAntigravityPanelTurn(
      { conversationKey: 41, messages },
      {
        isLive: () => false,
        onDelta: (delta) => deltas.push(delta),
        onStatus: () => undefined,
      },
      h.deps,
    );
    assert.deepEqual(deltas, []);
  });
  it("sends a long paper as a file agy reads, and removes the file after the turn", async function () {
    const h = harness({ result: { response: "ok" } });
    const written: string[] = [];
    const removed: string[] = [];
    h.deps.writeContextFile = async (text) => {
      written.push(text);
      return { path: "/tmp/agy-ctx/context.md", dir: "/tmp/agy-ctx" };
    };
    h.deps.removeContextFile = async (file) => {
      removed.push(file.dir);
    };
    const paper = `BEGIN ${"x".repeat(80_000)} END-CANARY`;
    await runAntigravityPanelTurn(
      {
        conversationKey: 41,
        messages: [
          { role: "system", content: paper },
          { role: "user", content: "What is at the end?" },
        ],
      },
      panel().callbacks,
      h.deps,
    );
    const call = h.calls[0];
    assert.deepEqual(call.addDirs, ["/tmp/agy-ctx"]);
    assert.isBelow(call.prompt.length, 2000);
    assert.match(
      call.prompt,
      /^<question>\nWhat is at the end\?\n<\/question>/,
    );
    assert.include(call.prompt, "/tmp/agy-ctx/context.md");
    assert.lengthOf(written, 1);
    assert.include(written[0], "END-CANARY");
    assert.notInclude(written[0], "<question>");
    assert.deepEqual(removed, ["/tmp/agy-ctx"]);
  });

  it("leads with the question when the context file cannot be written", async function () {
    const h = harness({ result: { response: "ok" } });
    h.deps.writeContextFile = async () => null;
    await runAntigravityPanelTurn(
      {
        conversationKey: 41,
        messages: [
          { role: "system", content: "y".repeat(80_000) },
          { role: "user", content: "Q?" },
        ],
      },
      panel().callbacks,
      h.deps,
    );
    assert.isUndefined(h.calls[0].addDirs);
    assert.match(
      h.calls[0].prompt,
      /^<question>\nQ\?\n<\/question>\n\n<instructions_and_context>/,
    );
  });

  it("removes the context file even when the turn fails", async function () {
    const h = harness({});
    const removed: string[] = [];
    h.deps.writeContextFile = async () => ({ path: "/t/c.md", dir: "/t" });
    h.deps.removeContextFile = async (file) => {
      removed.push(file.dir);
    };
    h.deps.runTurn = async () => {
      throw new Error("agy failed");
    };
    let error: unknown;
    try {
      await runAntigravityPanelTurn(
        {
          conversationKey: 41,
          messages: [
            { role: "system", content: "z".repeat(80_000) },
            { role: "user", content: "Q?" },
          ],
        },
        panel().callbacks,
        h.deps,
      );
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /agy failed/);
    assert.deepEqual(removed, ["/t"]);
  });
  it("reports every tool step to the activity trace, and only running ones as status", async function () {
    const h = harness({
      events: [
        {
          kind: "tool",
          stepIndex: 2,
          toolName: "view_file",
          state: "ACTIVE",
          summary: "Reading paper.md",
        },
        {
          kind: "tool",
          stepIndex: 2,
          toolName: "view_file",
          state: "DONE",
          summary: "Reading paper.md",
        },
        { kind: "tool", stepIndex: 4, toolName: "run_command", state: "ERROR" },
      ],
      result: { response: "ok" },
    });
    const p = panel();
    const activity: unknown[] = [];
    await runAntigravityPanelTurn(
      { conversationKey: 41, messages },
      { ...p.callbacks, onActivity: (entry) => activity.push(entry) },
      h.deps,
    );
    assert.deepEqual(activity, [
      {
        stepIndex: 2,
        toolName: "view_file",
        summary: "Reading paper.md",
        phase: "started",
        failed: false,
      },
      {
        stepIndex: 2,
        toolName: "view_file",
        summary: "Reading paper.md",
        phase: "completed",
        failed: false,
      },
      {
        stepIndex: 4,
        toolName: "run_command",
        summary: undefined,
        phase: "completed",
        failed: true,
      },
    ]);
    assert.deepEqual(p.statuses, [
      "Antigravity is thinking",
      "Antigravity: Reading paper.md",
    ]);
  });
});
