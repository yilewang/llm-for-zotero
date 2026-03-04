import { assert } from "chai";
import { createAgentLoopRunner } from "../src/modules/contextPanel/Agent/loop";
import type { AgentStepDecision } from "../src/modules/contextPanel/Agent/types";
import type { AgentToolExecutionResult } from "../src/modules/contextPanel/Agent/Tools/types";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

describe("agentLoop", function () {
  const retrievedPaper: PaperContextRef = {
    itemId: 1,
    contextItemId: 10,
    title: "Retrieved Paper",
  };
  const activePaper: PaperContextRef = {
    itemId: 2,
    contextItemId: 20,
    title: "Active Paper",
  };
  const selectedPaperA: PaperContextRef = {
    itemId: 3,
    contextItemId: 30,
    title: "Same Title",
    attachmentTitle: "Main PDF",
    firstCreator: "Kim",
    year: "2025",
  };
  const selectedPaperB: PaperContextRef = {
    itemId: 3,
    contextItemId: 31,
    title: "Same Title",
    attachmentTitle: "Supplement PDF",
    firstCreator: "Kim",
    year: "2025",
  };

  it("skips all LLM calls when images are attached (vision questions bypass agent retrieval)", async function () {
    let stepCalled = false;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        stepCalled = true;
        return { type: "stop", traceLines: [] };
      },
      executeAgentToolCall: async () => null,
    });

    const result = await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "can you explain this figure to me?",
      activeContextItem: { id: 20 } as Zotero.Item,
      conversationMode: "paper",
      paperContexts: [activePaper],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      images: ["data:image/png;base64,ABC"],
    });

    assert.isFalse(stepCalled, "runAgentStep must not be called when images are attached");
    assert.equal(result.contextPrefix, "");
    // Paper contexts should pass through unchanged
    assert.deepEqual(result.paperContexts, [activePaper]);
  });

  it("immediately stops when runAgentStep returns stop on the first iteration", async function () {
    const traces: string[] = [];
    const toolCallCount = { n: 0 };
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => ({
        type: "stop",
        traceLines: ["Nothing to retrieve."],
      }),
      executeAgentToolCall: async () => {
        toolCallCount.n += 1;
        return null;
      },
    });

    const result = await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "what is the meaning of life?",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      onTrace: (line) => traces.push(line),
    });

    assert.equal(toolCallCount.n, 0);
    assert.equal(result.contextPrefix, "");
    assert.include(traces, "Nothing to retrieve.");
  });

  it("runs one tool call then stops, combining context prefixes", async function () {
    const traces: string[] = [];
    let step = 0;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        if (step === 0) {
          step += 1;
          return {
            type: "tool",
            traceLines: ["Reading retrieved paper."],
            call: {
              name: "read_paper_text",
              target: { scope: "retrieved-paper", index: 1 },
            },
          };
        }
        return { type: "stop", traceLines: ["Done."] };
      },
      executeAgentToolCall: async (): Promise<AgentToolExecutionResult> => ({
        name: "read_paper_text",
        targetLabel: "Retrieved Paper",
        ok: true,
        traceLines: ["Loaded full text for Retrieved Paper."],
        groundingText: "Full text content",
        addedPaperContexts: [retrievedPaper],
        estimatedTokens: 500,
        truncated: false,
      }),
    });

    const result = await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "summarise the retrieved paper",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [retrievedPaper],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10000,
      onTrace: (line) => traces.push(line),
    });

    assert.equal(result.conversationMode, "open");
    assert.include(result.contextPrefix, "Full text content");
    assert.include(traces, "Reading retrieved paper.");
    assert.include(traces, "Tool call: read_paper_text(retrieved-paper#1).");
    assert.include(traces, "Done.");
  });

  it("list_papers result switches loop to library mode", async function () {
    const traces: string[] = [];
    let step = 0;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        if (step === 0) {
          step += 1;
          return {
            type: "tool",
            traceLines: ["Searching library."],
            call: { name: "list_papers", query: "memory consolidation", limit: 3 },
          };
        }
        return { type: "stop", traceLines: ["Library loaded."] };
      },
      executeAgentToolCall: async (): Promise<AgentToolExecutionResult> => ({
        name: "list_papers",
        targetLabel: "library",
        ok: true,
        traceLines: ["Found 2 papers."],
        groundingText: "Library overview text",
        addedPaperContexts: [],
        retrievedPaperContexts: [retrievedPaper, activePaper],
        estimatedTokens: 300,
        truncated: false,
      }),
    });

    const result = await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "what papers do I have about memory?",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10000,
      onTrace: (line) => traces.push(line),
    });

    assert.equal(result.conversationMode, "open");
    assert.isNull(result.activeContextItem);
    assert.deepEqual(result.paperContexts, [retrievedPaper, activePaper]);
    assert.include(result.contextPrefix, "Library overview text");
    assert.include(traces, 'Tool call: list_papers("memory consolidation").');
  });

  it("respects maxIterations and does not call runAgentStep more than maxIterations times", async function () {
    let stepCalls = 0;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        stepCalls += 1;
        return {
          type: "tool",
          traceLines: [],
          call: { name: "read_paper_text", target: { scope: "active-paper" } },
        };
      },
      executeAgentToolCall: async (): Promise<AgentToolExecutionResult> => ({
        name: "read_paper_text",
        targetLabel: "active-paper",
        ok: true,
        traceLines: [],
        groundingText: "text",
        addedPaperContexts: [],
        estimatedTokens: 100,
        truncated: false,
      }),
    });

    await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "summarise",
      activeContextItem: { id: 20 } as Zotero.Item,
      conversationMode: "paper",
      paperContexts: [activePaper],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 100000,
      maxIterations: 2,
    });

    assert.equal(stepCalls, 2);
  });

  it("stops when context budget is exhausted after the first tool call", async function () {
    let stepCalls = 0;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        stepCalls += 1;
        return {
          type: "tool",
          traceLines: [],
          call: { name: "read_paper_text", target: { scope: "selected-paper", index: 1 } },
        };
      },
      executeAgentToolCall: async (): Promise<AgentToolExecutionResult> => ({
        name: "read_paper_text",
        targetLabel: "selected-paper#1",
        ok: true,
        traceLines: [],
        groundingText: "text",
        addedPaperContexts: [selectedPaperA],
        estimatedTokens: 5000,
        truncated: false,
      }),
    });

    const traces: string[] = [];
    await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "compare",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [selectedPaperA],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 4999,
      maxIterations: 4,
      onTrace: (line) => traces.push(line),
    });

    // After first call spends 5000 tokens on a 4999 budget, the loop stops.
    assert.equal(stepCalls, 1);
    assert.include(traces, "Context budget exhausted; stopping retrieval.");
  });

  it("deduplicates paper contexts added by multiple tool calls", async function () {
    let step = 0;
    const runAgentLoop = createAgentLoopRunner({
      runAgentStep: async (): Promise<AgentStepDecision> => {
        if (step < 2) {
          const index = step + 1;
          step += 1;
          return {
            type: "tool",
            traceLines: [],
            call: { name: "read_paper_text", target: { scope: "selected-paper", index } },
          };
        }
        return { type: "stop", traceLines: [] };
      },
      executeAgentToolCall: async ({ call }): Promise<AgentToolExecutionResult> => {
        const idx =
          call.target && "index" in call.target ? call.target.index : 1;
        const paper = idx === 1 ? selectedPaperA : selectedPaperB;
        return {
          name: "read_paper_text",
          targetLabel: `selected-paper#${idx}`,
          ok: true,
          traceLines: [],
          groundingText: `text for paper ${idx}`,
          addedPaperContexts: [paper],
          estimatedTokens: 200,
          truncated: false,
        };
      },
    });

    const result = await runAgentLoop({
      item: { libraryID: 5 } as Zotero.Item,
      question: "compare both papers",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [selectedPaperA, selectedPaperB],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10000,
      maxIterations: 4,
    });

    // selectedPaperA and selectedPaperB have the same itemId but different contextItemId.
    // After two tool calls that each add one of them, there should be 2 unique entries.
    assert.equal(result.paperContexts.length, 2);
    assert.include(result.contextPrefix, "text for paper 1");
    assert.include(result.contextPrefix, "text for paper 2");
  });
});
