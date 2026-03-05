import { assert } from "chai";
import {
  createAgentToolBrokerState,
  createToolBrokerExecutor,
} from "../src/modules/contextPanel/Agent/toolBroker";

describe("agent tool broker", function () {
  it("maps write_note success to ui_action", async function () {
    const executeToolViaBroker = createToolBrokerExecutor({
      executeCall: async () => ({
        name: "write_note",
        targetLabel: "active-paper",
        ok: true,
        traceLines: ["Note ready."],
        groundingText: "note grounding",
        addedPaperContexts: [],
        estimatedTokens: 10,
        truncated: false,
      }),
    });

    const outcome = await executeToolViaBroker({
      call: {
        name: "write_note",
        target: { scope: "active-paper" },
      },
      ctx: {
        question: "save this as note",
        libraryID: 1,
        panelItemId: 1,
        conversationMode: "paper",
        activePaperContext: null,
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      state: createAgentToolBrokerState(),
    });

    assert.equal(outcome.kind, "ui_action");
    if (outcome.kind !== "ui_action") return;
    assert.equal(outcome.action.type, "show_note_review");
  });

  it("returns error when call validation fails", async function () {
    const executeToolViaBroker = createToolBrokerExecutor({
      executeCall: async () => {
        throw new Error("should not execute");
      },
    });

    const outcome = await executeToolViaBroker({
      call: {
        name: "search_paper_content",
        target: { scope: "active-paper" },
      },
      ctx: {
        question: "find method",
        libraryID: 1,
        panelItemId: 1,
        conversationMode: "paper",
        activePaperContext: null,
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      state: createAgentToolBrokerState(),
    });

    assert.equal(outcome.kind, "error");
    assert.include(outcome.error, "Malformed tool call");
  });

  it("returns context_update for non-ui tool", async function () {
    const executeToolViaBroker = createToolBrokerExecutor({
      executeCall: async () => ({
        name: "read_paper_text",
        targetLabel: "active-paper",
        ok: true,
        traceLines: ["Loaded text."],
        groundingText: "paper body",
        addedPaperContexts: [],
        estimatedTokens: 100,
        truncated: false,
      }),
    });

    const outcome = await executeToolViaBroker({
      call: {
        name: "read_paper_text",
        target: { scope: "active-paper" },
      },
      ctx: {
        question: "read it",
        libraryID: 1,
        panelItemId: 1,
        conversationMode: "paper",
        activePaperContext: null,
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      state: createAgentToolBrokerState(),
    });

    assert.equal(outcome.kind, "context_update");
  });
});
