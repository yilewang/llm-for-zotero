import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../src/agent/reviewCards";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../src/agent/types";
import type { AgentModelAdapter, AgentStepParams } from "../src/agent/model/adapter";

type MockDbRow = Record<string, unknown>;

function installMockDb() {
  const runs = new Map<string, MockDbRow>();
  const events: MockDbRow[] = [];
  const originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero;
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT OR REPLACE INTO llm_for_zotero_agent_runs")) {
          runs.set(String(params[0]), {
            runId: params[0],
            conversationKey: params[1],
            mode: params[2],
            modelName: params[3],
            status: params[4],
            createdAt: params[5],
            completedAt: params[6],
            finalText: params[7],
          });
          return [];
        }
        if (sql.includes("UPDATE llm_for_zotero_agent_runs")) {
          const run = runs.get(String(params[3]));
          if (run) {
            run.status = params[0];
            run.completedAt = params[1];
            run.finalText = params[2];
          }
          return [];
        }
        if (sql.includes("INSERT INTO llm_for_zotero_agent_run_events")) {
          events.push({
            runId: params[0],
            seq: params[1],
            eventType: params[2],
            payloadJson: params[3],
            createdAt: params[4],
          });
          return [];
        }
        if (sql.includes("SELECT run_id AS runId") && sql.includes("agent_run_events")) {
          return events
            .filter((entry) => entry.runId === params[0])
            .sort((a, b) => Number(a.seq) - Number(b.seq));
        }
        if (sql.includes("SELECT run_id AS runId") && sql.includes("agent_runs")) {
          const run = runs.get(String(params[0]));
          return run ? [run] : [];
        }
        return [];
      },
    },
  };
  return () => {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  };
}

class StepAdapter implements AgentModelAdapter {
  stepIndex = 0;
  readonly seenSteps: AgentStepParams[] = [];

  constructor(
    private readonly steps: Array<
      AgentModelStep | ((params: AgentStepParams) => Promise<AgentModelStep> | AgentModelStep)
    >,
    private readonly capabilities: AgentModelCapabilities = {
      streaming: false,
      toolCalls: true,
      multimodal: false,
      fileInputs: false,
      reasoning: false,
    },
  ) {}

  getCapabilities(): AgentModelCapabilities {
    return this.capabilities;
  }

  supportsTools(): boolean {
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    this.seenSteps.push(params);
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    if (!step) {
      throw new Error(`Unexpected model step ${this.stepIndex}`);
    }
    return typeof step === "function" ? step(params) : step;
  }
}

function makeRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 51,
    mode: "agent",
    userText: "Find related papers from the internet",
    model: "gpt-5.4",
    apiBase: "https://api.openai.com/v1/responses",
    apiKey: "test",
    ...overrides,
  };
}

function createStubSearchTool(
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
): AgentToolDefinition<Record<string, unknown>, unknown> {
  return {
    spec: {
      name: "literature_search",
      description: "search",
      inputSchema: { type: "object" },
      mutability: "read",
      requiresConfirmation: false,
    },
    validate: (args) => ({
      ok: true,
      value:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    }),
    execute: async (input) => execute(input),
    createResultReviewAction: (input, result, context) =>
      createSearchLiteratureReviewAction(result, context, input),
    resolveResultReview: (input, result, resolution, context) =>
      resolveSearchLiteratureReview(input, result, resolution, context),
  };
}

function createStubFacadeTool(
  toolName: string,
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  acceptActionIds: string[] = [],
): AgentToolDefinition<Record<string, unknown>, unknown> {
  return {
    spec: {
      name: toolName,
      description: toolName,
      inputSchema: { type: "object" },
      mutability: "write",
      requiresConfirmation: true,
    },
    validate: (args) => ({
      ok: true,
      value:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    }),
    createPendingAction: (input) => ({
      toolName,
      title: "Confirm library change",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "textarea",
          id: "inputJson",
          label: "Input",
          value: JSON.stringify(input, null, 2),
          editorMode: "json",
        },
      ],
    }),
    acceptInheritedApproval: (_input, approval) =>
      approval.sourceToolName === "literature_search" &&
      acceptActionIds.includes(approval.sourceActionId),
    applyConfirmation: (input) => ({ ok: true, value: input }),
    execute: async (input) => execute(input),
  };
}

describe("AgentRuntime HITL review workflow", function () {
  it("routes approved metadata reviews directly into a metadata update review", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register(
        createStubSearchTool(async () => ({
          mode: "metadata",
          results: [
            {
              source: "Crossref",
              displayTitle: "Paper A",
              patch: {
                title: "Paper A",
                DOI: "10.1000/a",
                date: "2024",
                url: "https://doi.org/10.1000/a",
                creators: [{ creatorType: "author", name: "Alice Example", fieldMode: 1 }],
              },
            },
            {
              source: "Semantic Scholar",
              displayTitle: "Paper B",
              patch: {
                title: "Paper B",
                DOI: "10.1000/b",
                date: "2025",
                url: "https://doi.org/10.1000/b",
                creators: [{ creatorType: "author", name: "Bob Example", fieldMode: 1 }],
              },
            },
          ],
        })),
      );
      registry.register(
        createStubFacadeTool("library_update", async (input) => {
          const metadata = input.metadata as Record<string, unknown> | undefined;
          assert.exists(metadata);
          assert.equal(metadata?.DOI, "10.1000/a");
          return {
            appliedCount: 1,
            results: [{ itemId: 1 }],
          };
        }, ["apply_direct", "review_changes"]),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: { mode: "metadata", query: "paper metadata" },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: { mode: "metadata", query: "paper metadata" },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: makeRequest({
          selectedPaperContexts: [
            { itemId: 1, contextItemId: 101, title: "Paper A" },
          ],
        }),
        onEvent: async (event) => {
          events.push(event);
          if (
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_search"
          ) {
            assert.equal(event.action.mode, "review");
            assert.deepEqual(
              event.action.actions?.map((action) => action.id),
              ["review_changes", "save_note", "cancel"],
            );
            runtime.resolveConfirmation(event.requestId, {
              approved: true,
              actionId: "review_changes",
              data: { selectedMetadataResult: "metadata-1" },
            });
          }
          // library_update accepts inherited approval from the review card,
          // so no separate confirmation is expected here
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Applied the selected metadata to the paper.");
      assert.equal(adapter.stepIndex, 1);
      const resultIndex = events.findIndex(
        (event) =>
          event.type === "tool_result" &&
          event.name === "literature_search",
      );
      const reviewIndex = events.findIndex(
        (event) =>
          event.type === "confirmation_required" &&
          event.action.toolName === "literature_search",
      );
      const updateResultIndex = events.findIndex(
        (event) =>
          event.type === "tool_result" &&
          event.name === "library_update",
      );
      assert.isAtLeast(resultIndex, 0);
      assert.isAbove(reviewIndex, resultIndex);
      // library_update accepts inherited approval from review_changes,
      // so it executes directly without a separate confirmation
      assert.isAbove(updateResultIndex, reviewIndex);
    } finally {
      restoreDb();
    }
  });

  it("can import selected reviewed papers through library_import", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register(
        createStubSearchTool(async () => ({
          mode: "search",
          source: "OpenAlex",
          query: "plasticity",
          results: [
            {
              title: "Importable Paper",
              authors: ["Alice Example"],
              year: 2024,
              doi: "10.1000/importable",
            },
          ],
        })),
      );
      registry.register(
        createStubFacadeTool("library_import", async (input) => {
          assert.deepEqual(
            input.identifiers,
            ["10.1000/importable"],
          );
          return {
            appliedCount: 1,
            result: { succeeded: 1, failed: 0 },
            warnings: [],
          };
        }, ["import"]),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: { mode: "search", query: "plasticity" },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: { mode: "search", query: "plasticity" },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      let sawFacadeConfirmation = false;
      const outcome = await runtime.runTurn({
        request: makeRequest(),
        onEvent: async (event) => {
          if (
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_search"
          ) {
            assert.deepEqual(
              event.action.actions?.map((action) => action.id),
              ["import", "save_note", "new_search", "cancel"],
            );
            runtime.resolveConfirmation(event.requestId, {
              approved: true,
              actionId: "import",
              data: { selectedPaperIds: ["paper-1"] },
            });
            return;
          }
          if (event.type === "confirmation_required" && event.action.toolName === "library_import") {
            sawFacadeConfirmation = true;
          }
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Imported the selected papers into Zotero.");
      assert.equal(adapter.stepIndex, 1);
      assert.isFalse(sawFacadeConfirmation);
    } finally {
      restoreDb();
    }
  });

  it("can save reviewed papers into a note through note_write", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register(
        createStubSearchTool(async () => ({
          mode: "recommendations",
          source: "OpenAlex",
          results: [
            {
              title: "Paper For Note",
              authors: ["Dana Example"],
              year: 2025,
              doi: "10.1000/note",
            },
          ],
        })),
      );
      registry.register(
        createStubFacadeTool("note_write", async (input) => {
          assert.equal(input.mode, "create");
          assert.include(
            String(input.content || ""),
            "Custom reviewed note",
          );
          return {
            appliedCount: 1,
            result: { status: "created" },
            warnings: [],
          };
        }, ["save_paper_note", "save_metadata_note"]),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: { mode: "recommendations" },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: { mode: "recommendations" },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      let sawFacadeConfirmation = false;
      const outcome = await runtime.runTurn({
        request: makeRequest(),
        onEvent: async (event) => {
          if (
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_search"
          ) {
            runtime.resolveConfirmation(event.requestId, {
              approved: true,
              actionId: "save_note",
              data: {
                selectedPaperIds: ["paper-1"],
                noteContent: "## Custom reviewed note",
              },
            });
            return;
          }
          if (event.type === "confirmation_required" && event.action.toolName === "note_write") {
            sawFacadeConfirmation = true;
          }
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Saved the selected papers to a note.");
      assert.equal(adapter.stepIndex, 1);
      assert.isFalse(sawFacadeConfirmation);
    } finally {
      restoreDb();
    }
  });

  it("can rerun the online search from the review card without resuming model reasoning", async function () {
    const restoreDb = installMockDb();
    try {
      const searchQueries: string[] = [];
      const registry = new AgentToolRegistry();
      registry.register(
        createStubSearchTool(async (input) => {
          const query = String(input.query || "initial");
          searchQueries.push(query);
          return {
            mode: "search",
            source: "OpenAlex",
            query,
            results: [
              {
                title: query === "refined search" ? "Refined Paper" : "Initial Paper",
                authors: ["Elliot Example"],
                year: 2026,
                doi:
                  query === "refined search"
                    ? "10.1000/refined"
                    : "10.1000/initial",
              },
            ],
          };
        }),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: { mode: "search", query: "initial search" },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: { mode: "search", query: "initial search" },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      let searchReviewCount = 0;
      const outcome = await runtime.runTurn({
        request: makeRequest(),
        onEvent: async (event) => {
          if (
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_search"
          ) {
            searchReviewCount += 1;
            if (searchReviewCount === 1) {
              runtime.resolveConfirmation(event.requestId, {
                approved: true,
                actionId: "new_search",
                data: {
                  nextQuery: "refined search",
                  nextSource: "openalex",
                  nextLimit: "5",
                },
              });
              return;
            }
            runtime.resolveConfirmation(event.requestId, {
              approved: false,
              actionId: "cancel",
            });
          }
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Stopped after review.");
      assert.deepEqual(searchQueries, ["initial search", "refined search"]);
      assert.equal(adapter.stepIndex, 1);
    } finally {
      restoreDb();
    }
  });

  it("stops immediately when the user cancels the review card", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register(
        createStubSearchTool(async () => ({
          mode: "search",
          source: "OpenAlex",
          query: "cancel flow",
          results: [
            {
              title: "Cancelled Paper",
              authors: ["Zoe Example"],
              year: 2025,
              doi: "10.1000/cancel",
            },
          ],
        })),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: { mode: "search", query: "cancel flow" },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: { mode: "search", query: "cancel flow" },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      const outcome = await runtime.runTurn({
        request: makeRequest(),
        onEvent: async (event) => {
          if (
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_search"
          ) {
            runtime.resolveConfirmation(event.requestId, {
              approved: false,
              actionId: "cancel",
            });
          }
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Stopped after review.");
      assert.equal(adapter.stepIndex, 1);
    } finally {
      restoreDb();
    }
  });
});
