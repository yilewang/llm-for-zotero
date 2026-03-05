import { assert } from "chai";
import { createAgentOrchestratorRunner } from "../src/modules/contextPanel/Agent/orchestrator";

describe("agent orchestrator", function () {
  it("runs a tool step then stops and returns responder context", async function () {
    let step = 0;
    const run = createAgentOrchestratorRunner({
      loadPromptPack: async () => ({
        routerPrompt: "router",
        responderPrompt: "responder instructions",
        source: "file",
      }),
      runRouterStep: async () => {
        if (step === 0) {
          step += 1;
          return {
            decision: "tool_call",
            trace: "Read sections",
            call: {
              name: "get_paper_sections",
              target: { scope: "active-paper" },
            },
          };
        }
        return {
          decision: "stop",
          trace: "Sufficient context",
          stopReason: "done",
        };
      },
      executeTool: async () => ({
        kind: "context_update",
        result: {
          name: "get_paper_sections",
          targetLabel: "active-paper",
          ok: true,
          traceLines: ["Sections loaded."],
          groundingText: "Method and Results sections found",
          addedPaperContexts: [],
          estimatedTokens: 42,
          truncated: false,
        },
      }),
    });

    const result = await run({
      item: { id: 1, libraryID: 1 } as Zotero.Item,
      question: "Explain the method section",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10000,
      maxIterations: 4,
    });

    assert.include(result.contextPrefix, "Method and Results sections found");
    assert.include(result.responderContext, "responder instructions");
    assert.isTrue(result.allowPlannerPaperReads);
    assert.equal(result.depthAchieved, "deep");
    assert.lengthOf(result.toolLogs, 1);
    assert.equal(result.toolLogs[0]?.toolName, "get_paper_sections");
  });

  it("stops when no progress repeats", async function () {
    let routerCalls = 0;
    const run = createAgentOrchestratorRunner({
      loadPromptPack: async () => ({
        routerPrompt: "router",
        responderPrompt: "responder",
        source: "fallback",
      }),
      runRouterStep: async () => {
        routerCalls += 1;
        return {
          decision: "tool_call",
          trace: "Try reading",
          call: {
            name: "read_paper_text",
            target: { scope: "active-paper" },
          },
        };
      },
      executeTool: async () => ({
        kind: "error",
        error: "target unavailable",
        result: {
          name: "read_paper_text",
          targetLabel: "active-paper",
          ok: false,
          traceLines: ["Tool target was unavailable"],
          groundingText: "",
          addedPaperContexts: [],
          estimatedTokens: 0,
          truncated: false,
        },
      }),
    });

    await run({
      item: { id: 1, libraryID: 1 } as Zotero.Item,
      question: "Read full paper",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10000,
      maxIterations: 10,
    });

    assert.equal(routerCalls, 2);
  });

  it("stops after metadata stage for library count queries and avoids auto-pinning", async function () {
    let routerCalls = 0;
    let executeCalls = 0;
    const retrievedPaper = {
      itemId: 11,
      contextItemId: 101,
      title: "Hippocampus Paper",
    };
    const run = createAgentOrchestratorRunner({
      loadPromptPack: async () => ({
        routerPrompt: "router",
        responderPrompt: "responder",
        source: "file",
      }),
      runRouterStep: async () => {
        routerCalls += 1;
        return {
          decision: "tool_call",
          trace: "Count via list",
          call: {
            name: "list_papers",
            query: "hippocampus",
            limit: 6,
          },
        };
      },
      executeTool: async () => {
        executeCalls += 1;
        return {
          kind: "context_update",
          result: {
            name: "list_papers",
            targetLabel: 'library search: "hippocampus"',
            ok: true,
            traceLines: [
              "Sufficiency hint: sufficiency=high (metadata count available).",
            ],
            groundingText: "Zotero Agent Retrieval\n- quicksearch matches: 76",
            addedPaperContexts: [retrievedPaper],
            retrievedPaperContexts: [retrievedPaper],
            depthAchieved: "metadata",
            sufficiency: "high",
            estimatedTokens: 32,
            truncated: false,
          },
        };
      },
    });

    const result = await run({
      item: { id: 1, libraryID: 1 } as Zotero.Item,
      question: "How many papers about hippocampus are in my library?",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10_000,
      maxIterations: 4,
    });

    assert.equal(routerCalls, 1);
    assert.equal(executeCalls, 1);
    assert.lengthOf(result.paperContexts, 1);
    assert.lengthOf(result.pinnedPaperContexts, 0);
    assert.isFalse(result.allowPlannerPaperReads);
    assert.equal(result.depthAchieved, "metadata");
  });

  it("escalates metadata -> abstract for thematic library queries", async function () {
    const depths: string[] = [];
    const run = createAgentOrchestratorRunner({
      loadPromptPack: async () => ({
        routerPrompt: "router",
        responderPrompt: "responder",
        source: "file",
      }),
      runRouterStep: async () => ({
        decision: "tool_call",
        trace: "Use list_papers",
        call: {
          name: "list_papers",
          query: "hippocampus",
          limit: 6,
        },
      }),
      executeTool: async (params) => {
        const depth =
          params.call.name === "list_papers"
            ? (params.call.depth || "metadata")
            : "metadata";
        depths.push(depth);
        return {
          kind: "context_update",
          result: {
            name: "list_papers",
            targetLabel: 'library search: "hippocampus"',
            ok: true,
            traceLines: [
              depth === "metadata"
                ? "Sufficiency hint: sufficiency=low (abstract tier recommended)."
                : "Sufficiency hint: sufficiency=high (depth=abstract).",
            ],
            groundingText: `Zotero Agent Retrieval (${depth})`,
            addedPaperContexts: [],
            retrievedPaperContexts: [],
            depthAchieved: depth as "metadata" | "abstract",
            sufficiency: depth === "metadata" ? "low" : "high",
            estimatedTokens: 32,
            truncated: false,
          },
        };
      },
    });

    const result = await run({
      item: { id: 1, libraryID: 1 } as Zotero.Item,
      question: "What themes are common in my hippocampus papers?",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10_000,
      maxIterations: 6,
    });

    assert.deepEqual(depths, ["metadata", "abstract"]);
    assert.isFalse(result.allowPlannerPaperReads);
    assert.equal(result.depthAchieved, "abstract");
  });

  it("keeps deep tools enabled for explicit paper-specific requests", async function () {
    const executedNames: string[] = [];
    let step = 0;
    const run = createAgentOrchestratorRunner({
      loadPromptPack: async () => ({
        routerPrompt: "router",
        responderPrompt: "responder",
        source: "file",
      }),
      runRouterStep: async () => {
        if (step === 0) {
          step += 1;
          return {
            decision: "tool_call",
            trace: "Read paper 3",
            call: {
              name: "read_paper_text",
              target: { scope: "retrieved-paper", index: 1 },
            },
          };
        }
        return {
          decision: "stop",
          trace: "done",
          stopReason: "done",
        };
      },
      executeTool: async (params) => {
        executedNames.push(params.call.name);
        return {
          kind: "context_update",
          result: {
            name: "read_paper_text",
            targetLabel: "retrieved-paper#1",
            ok: true,
            traceLines: ["Loaded full text."],
            groundingText: "Paper text...",
            addedPaperContexts: [],
            estimatedTokens: 20,
            truncated: false,
          },
        };
      },
    });

    const result = await run({
      item: { id: 1, libraryID: 1 } as Zotero.Item,
      question: "Read paper 3 in detail and summarize methods/results.",
      activeContextItem: null,
      conversationMode: "open",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      model: "gpt-4o-mini",
      availableContextBudgetTokens: 10_000,
      maxIterations: 4,
    });

    assert.deepEqual(executedNames, ["read_paper_text"]);
    assert.isTrue(result.allowPlannerPaperReads);
    assert.equal(result.depthAchieved, "deep");
  });
});
