import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  clearRememberedLocalDocumentPaths,
  rememberLocalDocumentPaths,
} from "../src/agent/privacy/localDocumentPathRedaction";
import { createTestActionContractService } from "./helpers/actionContractService";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../src/agent/types";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";

const CONVERSATION_KEY = 991_455;
const PRIVATE_PATH = "/Users/Alice Doe/Private Papers/Drift.pdf";

class ScriptedAdapter implements AgentModelAdapter {
  private stepIndex = 0;

  constructor(private readonly steps: AgentModelStep[]) {}

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return { streaming: false, toolCalls: true, multimodal: false };
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return true;
  }

  async runStep(_params: AgentStepParams): Promise<AgentModelStep> {
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    return step;
  }
}

function toolCallStep(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): AgentModelStep {
  const call = { id, name, arguments: args };
  return {
    kind: "tool_calls",
    calls: [call],
    assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
  };
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

function readTool(
  name: string,
  execute: (input: unknown) => Promise<unknown>,
): Parameters<AgentToolRegistry["register"]>[0] {
  return {
    spec: {
      name,
      description: name,
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: { label: name },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (input: unknown) => ({ content: await execute(input) }),
  } as never;
}

function registerTools(registry: AgentToolRegistry): void {
  registry.register(
    readTool("library_retrieve", async () => ({
      resourcePool: { scope: { libraryID: 1 } },
      candidates: [
        { itemId: "11", title: "Drift", queryState: ["matched_bm25"] },
        { itemId: "12", title: "Learning", queryState: ["matched_metadata"] },
      ],
      snippets: [
        {
          itemId: "11",
          sourceKind: "pdf_text",
          matchMethod: "bm25",
          sectionLabel: "Methods",
          // A local path the redactor must strip before the event persists.
          snippet: `Cells drift; see ${PRIVATE_PATH} for the raw file.`,
        },
      ],
    })),
  );
  registry.register(
    readTool("paper_read", async () => ({
      mode: "targeted",
      results: [],
      papers: [
        {
          paperContext: { itemId: 11, contextItemId: 21, libraryID: 1 },
          passages: [{ text: "Targeted passage", sectionLabel: "Results" }],
        },
      ],
    })),
  );
  registry.register(
    readTool("library_search", async () => {
      throw new Error("index unavailable");
    }),
  );
  // A read tool the ledger does not cover, whose rows still name a paper.
  registry.register(
    readTool("conversation_read", async () => ({
      results: [{ itemId: 11, text: "an earlier answer" }],
    })),
  );
}

async function runTurn(options: { conversationKey?: number }): Promise<{
  events: AgentEvent[];
  persisted: Array<{ eventType: string; payload: AgentEvent }>;
}> {
  const restoreDb = installMockDb();
  try {
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(createTestActionContractService());
    registerTools(registry);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      registry,
      adapterFactory: () =>
        new ScriptedAdapter([
          toolCallStep("call-retrieve", "library_retrieve", { query: "d" }),
          toolCallStep("call-read", "paper_read", { mode: "targeted" }),
          toolCallStep("call-fail", "library_search", { text: "d" }),
          toolCallStep("call-other", "conversation_read", {}),
          finalStep("Done."),
        ]),
    });
    const outcome = await runtime.runTurn({
      request: {
        conversationKey: options.conversationKey ?? CONVERSATION_KEY,
        mode: "agent",
        libraryID: 1,
        userText: "What is common about drift?",
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(outcome.kind, "completed");
    const persisted = restoreDb.events.map((row) => ({
      eventType: String(row.eventType),
      payload: JSON.parse(String(row.payloadJson)) as AgentEvent,
    }));
    return { events, persisted };
  } finally {
    restoreDb();
  }
}

type LedgerEvent = Extract<AgentEvent, { type: "paper_ledger_update" }>;

function ledgerEvents(events: readonly AgentEvent[]): LedgerEvent[] {
  return events.filter(
    (event): event is LedgerEvent => event.type === "paper_ledger_update",
  );
}

describe("task paper ledger emission", function () {
  before(function () {
    rememberLocalDocumentPaths(CONVERSATION_KEY, [
      {
        kind: "local_pdf",
        sourceKey: "zotero-pdf:11:21",
        itemId: 11,
        contextItemId: 21,
        title: "Drift",
        name: "Drift.pdf",
        mimeType: "application/pdf",
        absolutePath: PRIVATE_PATH,
      },
    ]);
  });

  after(function () {
    clearRememberedLocalDocumentPaths(CONVERSATION_KEY);
  });

  it("emits one update right after each successful ledger read's tool_result", async function () {
    const { events, persisted } = await runTurn({});
    const updates = ledgerEvents(events);
    assert.deepEqual(
      updates.map((event) => event.callId),
      ["call-retrieve", "call-read"],
      "failed calls and tools outside the ledger emit nothing",
    );
    for (const update of updates) {
      const index = events.indexOf(update);
      const previous = events[index - 1];
      assert.equal(previous.type, "tool_result");
      assert.equal(
        (previous as Extract<AgentEvent, { type: "tool_result" }>).callId,
        update.callId,
        "the update directly follows its own tool_result",
      );
    }
    const retrieve = updates[0].delta;
    assert.equal(retrieve.runId && typeof retrieve.runId, "string");
    assert.deepEqual(
      retrieve.papers.map((paper) => [paper.key, paper.state]),
      [
        ["1:11", "read"],
        ["1:12", "matched"],
      ],
    );
    assert.deepEqual(
      updates[1].delta.reads.map((read) => [read.granularity, read.label]),
      [["passage", "Results"]],
    );

    // Stage ordering is untouched: each call still closes its stage before
    // its tool_result.
    const shapes = events
      .filter((event) =>
        ["agent_stage", "tool_result", "paper_ledger_update"].includes(
          event.type,
        ),
      )
      .map((event) =>
        event.type === "agent_stage"
          ? `stage:${event.status}:${event.callId}`
          : `${event.type}:${(event as { callId?: string }).callId}`,
      );
    const at = (shape: string) => {
      const index = shapes.indexOf(shape);
      assert.isAtLeast(index, 0, `${shape} is in the trace`);
      return index;
    };
    assert.deepEqual(
      [
        at("stage:completed:call-retrieve"),
        at("tool_result:call-retrieve"),
        at("paper_ledger_update:call-retrieve"),
        at("stage:started:call-read"),
      ],
      [0, 1, 2, 3].map(
        (offset) => at("stage:completed:call-retrieve") + offset,
      ),
    );

    // Persisted exactly as delivered, and redacted like every other event.
    const stored = persisted.filter(
      (entry) => entry.eventType === "paper_ledger_update",
    );
    assert.lengthOf(stored, 2);
    assert.deepEqual(
      stored.map((entry) => entry.payload),
      JSON.parse(JSON.stringify(updates)),
    );
    const storedText = JSON.stringify(stored);
    assert.notInclude(storedText, PRIVATE_PATH);
    assert.notInclude(JSON.stringify(updates), PRIVATE_PATH);
    assert.include(
      String(
        stored[0].payload.type === "paper_ledger_update" &&
          stored[0].payload.delta.reads.find((read) => read.snippet)?.snippet,
      ),
      "Cells drift",
    );
  });

  it("leaves tool_result content unchanged", async function () {
    const { events } = await runTurn({});
    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.callId === "call-read",
    );
    assert.deepInclude(result!.content as object, { mode: "targeted" });
    assert.notProperty(result!.content as object, "paperLedgerDelta");
  });
});
