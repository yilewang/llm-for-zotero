import { assert } from "chai";
import {
  chatHistory,
  finishRequest,
  getConversationWriteGeneration,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import {
  buildCodexNativeTurnCallbacksForTests,
  finishCodexNativePanelTurn,
  runCodexNativePanelTurn,
} from "../src/modules/contextPanel/codexNative/turnCallbacks";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import { readCodexPlanChecklist } from "../src/modules/contextPanel/taskProgress/codexPlan";
import {
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { ledgerDelta, quoteCitation } from "./helpers/taskProgressFixtures";

describe("task progress in a Codex native turn", function () {
  const key = 908173;
  afterEach(function () {
    finishRequest(key, 1);
    chatHistory.delete(key);
    clearAllTaskProgress();
  });

  it("starts working, records MCP read deltas, and answers at the first text", async function () {
    tryBeginRequest(key, 1, null);
    const assistant: Message = {
      role: "assistant",
      text: "",
      timestamp: 4,
      agentRunId: "codex-native-4",
      streaming: true,
    };
    chatHistory.set(key, [
      { role: "user", text: "Earlier", timestamp: 1 },
      { role: "assistant", text: "Done", timestamp: 2 },
      { role: "user", text: "What is drift?", timestamp: 3 },
      assistant,
    ]);
    const deltas: string[] = [];
    const callbacks = buildCodexNativeTurnCallbacksForTests({
      conversationKey: key,
      conversationGeneration: getConversationWriteGeneration(key),
      assistantMessage: assistant,
      codexActivityTrace: null,
      body: {} as Element,
      item: {} as Zotero.Item,
      flushResponseStream: () => {},
      setStatusSafely: () => {},
      handleDelta: (delta) => deltas.push(delta),
      handleReasoning: () => {},
      handleUsage: () => {},
    });
    let record = getTaskProgress(key)!;
    assert.equal(record.runState, "working");
    assert.equal(record.runId, "codex-native-4");
    assert.equal(record.turnIndex, 2, "the question's position");

    const delta = ledgerDelta(
      "mcp-1",
      [[1, "read", "Drift grows."]],
      "scope-run",
    );
    callbacks.onMcpToolActivity?.({
      phase: "completed",
      ok: true,
      toolName: "library_retrieve",
      requestId: "mcp-1",
      paperLedgerDelta: delta,
      timestamp: 5,
    } as never);
    // A started row carries no delta; a failed one records nothing.
    callbacks.onMcpToolActivity?.({
      phase: "completed",
      ok: false,
      toolName: "library_retrieve",
      requestId: "mcp-2",
      paperLedgerDelta: ledgerDelta("mcp-2", [[2, "read"]]),
      timestamp: 6,
    } as never);
    record = getTaskProgress(key)!;
    assert.deepEqual(Object.keys(record.ledger.papers), ["1:1"]);
    assert.deepEqual(Object.keys(record.ledger.papers["1:1"].turns), ["2"]);

    callbacks.onDelta?.("The answer ");
    callbacks.onDelta?.("continues.");
    record = getTaskProgress(key)!;
    assert.equal(record.runState, "answering");
    assert.equal(record.collapseSeq, 1, "one collapse, at the first text");
    assert.deepEqual(deltas, ["The answer ", "continues."]);
  });

  it("feeds Codex's update_plan into the run's steps and keeps it for history", async function () {
    tryBeginRequest(key, 1, null);
    const assistant: Message = {
      role: "assistant",
      text: "",
      timestamp: 4,
      agentRunId: "codex-plan-run",
      streaming: true,
    };
    chatHistory.set(key, [
      { role: "user", text: "Compare the drift papers", timestamp: 3 },
      assistant,
    ]);
    const trace = createCodexNativeActivityTraceControllerForTests(
      assistant,
      () => {},
    );
    const callbacks = buildCodexNativeTurnCallbacksForTests({
      conversationKey: key,
      conversationGeneration: getConversationWriteGeneration(key),
      assistantMessage: assistant,
      codexActivityTrace: trace,
      body: {} as Element,
      item: {} as Zotero.Item,
      flushResponseStream: () => {},
      setStatusSafely: () => {},
      handleDelta: () => {},
      handleReasoning: () => {},
      handleUsage: () => {},
    });
    await callbacks.onPlanUpdated?.({
      steps: [
        { content: "Inspect the scope", status: "completed" },
        { content: "Read the methods", status: "in_progress" },
        { content: "Compare results", status: "pending" },
      ],
    });
    const record = getTaskProgress(key)!;
    assert.equal(record.checklist?.source, "codex");
    assert.equal(record.checklist?.runId, "codex-plan-run");
    assert.deepEqual(
      record.checklist!.steps.map((step) => step.status),
      ["completed", "in_progress", "pending"],
    );
    assert.isTrue(record.planSeen, "the row appears whenever Codex has a plan");
    // The trace keeps one persisted event for it, which history reads back.
    const events = assistant.pendingAgentTraceEvents || [];
    assert.lengthOf(events, 1);
    assert.deepEqual(readCodexPlanChecklist(events[0].payload), [
      { label: "Inspect the scope", status: "completed" },
      { label: "Read the methods", status: "in_progress" },
      { label: "Compare results", status: "pending" },
    ]);
    // A text-only event from an older build still reads.
    assert.deepEqual(
      readCodexPlanChecklist({
        type: "codex_progress",
        itemId: "codex-plan-checklist",
        text: "✓ Inspect\n• Compare",
      }),
      [
        { label: "Inspect", status: "completed" },
        { label: "Compare", status: "pending" },
      ],
    );
    trace.dispose();
  });

  it("shows ✓ and the cited papers on the run the turn began, not the native journal's", async function () {
    tryBeginRequest(key, 1, null);
    const assistant: Message = {
      role: "assistant",
      text: "",
      timestamp: 7,
      streaming: true,
    };
    chatHistory.set(key, [
      { role: "user", text: "What is drift?", timestamp: 6 },
      assistant,
    ]);
    // The panel names the turn with its trace, as send and retry do.
    const trace = createCodexNativeActivityTraceControllerForTests(
      assistant,
      () => {},
    );
    const journalRunId = `native-host:${key}:9:journal`;
    const outcome = await runCodexNativePanelTurn(
      {
        executionRequest: {} as AgentRuntimeRequest,
        scope: { conversationKey: key, libraryID: 1, kind: "global" },
        messages: [],
      },
      {
        body: {} as Element,
        item: {} as Zotero.Item,
        assistantMessage: assistant,
        codexActivityTrace: trace,
        flushResponseStream: () => {},
        setStatusSafely: () => {},
        handleDelta: () => {},
        handleReasoning: () => {},
        handleUsage: () => {},
        conversationKey: key,
        conversationGeneration: getConversationWriteGeneration(key),
      },
      // The native turn reads one paper, answers, and reports the run its
      // event journal stored the turn under.
      async (params) => {
        params.onMcpToolActivity?.({
          phase: "completed",
          ok: true,
          toolName: "library_retrieve",
          requestId: "mcp-1",
          paperLedgerDelta: ledgerDelta("mcp-1", [[1, "read", "Drift grows."]]),
          timestamp: 8,
        } as never);
        params.onDelta?.("Drift grows.");
        return {
          agentRunId: journalRunId,
          text: "Drift grows.",
          threadId: "thread-1",
          resumed: false,
        };
      },
    );
    const began = getTaskProgress(key)!.runId;
    assert.equal(began, "codex-native-7");
    assert.equal(
      assistant.agentRunId,
      journalRunId,
      "the message holds the journal run until the trace persists",
    );
    assert.equal(getTaskProgress(key)!.runState, "answering");

    assistant.text = outcome.text;
    assistant.quoteCitations = [quoteCitation("q1", 1)];
    finishCodexNativePanelTurn({
      conversationKey: key,
      assistantMessage: assistant,
      codexActivityTrace: trace,
    });
    const record = getTaskProgress(key)!;
    assert.equal(record.runId, began);
    assert.equal(record.runState, "completed", "live ✓");
    assert.equal(
      record.ledger.papers["1:1"].turns[record.turnIndex].state,
      "cited",
      "the answer's citations mark the paper it read",
    );
    trace.dispose();
  });
});
