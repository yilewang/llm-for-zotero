import { assert } from "chai";
import { createAgentV2OrchestratorRunner } from "../src/modules/contextPanel/Agent/V2/orchestrator";

describe("agentV2 orchestrator", function () {
  it("runs a tool step then stops and returns responder context", async function () {
    let step = 0;
    const run = createAgentV2OrchestratorRunner({
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
    assert.lengthOf(result.toolLogs, 1);
    assert.equal(result.toolLogs[0]?.toolName, "get_paper_sections");
  });

  it("stops when no progress repeats", async function () {
    let routerCalls = 0;
    const run = createAgentV2OrchestratorRunner({
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
});
