import { assert } from "chai";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../src/agent/reviewCards";
import { AgentRuntime } from "../src/agent/runtime";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createRenamedTool } from "../src/agent/tools/facade";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../src/agent/types";
import {
  classifiedFixture,
  declaredSemanticInterpreter,
} from "./helpers/semanticIntent";

type MockDbRow = Record<string, unknown>;

function installMockDb() {
  const runs = new Map<string, MockDbRow>();
  const events: MockDbRow[] = [];
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
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
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_run_events")
        ) {
          return events
            .filter((entry) => entry.runId === params[0])
            .sort((a, b) => Number(a.seq) - Number(b.seq));
        }
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_runs")
        ) {
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
      | AgentModelStep
      | ((params: AgentStepParams) => Promise<AgentModelStep> | AgentModelStep)
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
    classifiedIntent: classifiedFixture(),
    conversationKey: 51,
    mode: "agent",
    userText: "Find related papers from the internet",
    libraryID: 1,
    model: "gpt-5.4",
    apiBase: "https://api.openai.com/v1/responses",
    apiKey: "test",
    ...overrides,
  };
}

function createStubSearchTool(
  execute: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>,
): AgentToolDefinition<Record<string, unknown>, unknown> {
  return {
    spec: {
      name: "literature_search",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
    validate: (args) => ({
      ok: true,
      value:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    }),
    execute: async (input) => ({
      workflow: input.workflow || "answer",
      ...(await execute(input)),
    }),
    createResultReviewAction: (input, result, context) =>
      input.workflow === "review"
        ? createSearchLiteratureReviewAction(result, context, input)
        : null,
    resolveResultReview: (input, result, resolution, context) =>
      resolveSearchLiteratureReview(input, result, resolution, context),
  };
}

function createStubFacadeTool(
  toolName: string,
  execute: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  acceptActionIds: string[] = [],
): AgentToolDefinition<Record<string, unknown>, unknown> {
  return {
    spec: {
      name: toolName,
      description: toolName,
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      requiresConfirmation: true,
    },
    validate: (args) => ({
      ok: true,
      value:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    }),
    describeAction: () => [
      {
        id: `review:${toolName}`,
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        source: "zotero_native",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
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
      ["literature_search", "literature_review"].includes(
        approval.sourceToolName,
      ) && acceptActionIds.includes(approval.sourceActionId),
    applyConfirmation: (input) => ({ ok: true, value: input }),
    execute: async (input) => ({
      content: await execute(input),
      effect: "applied",
    }),
  };
}

describe("AgentRuntime HITL review workflow", function () {
  it("routes approved metadata reviews directly into a metadata update review", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
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
                creators: [
                  {
                    creatorType: "author",
                    name: "Alice Example",
                    fieldMode: 1,
                  },
                ],
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
                creators: [
                  { creatorType: "author", name: "Bob Example", fieldMode: 1 },
                ],
              },
            },
          ],
        })),
      );
      registry.register(
        createStubFacadeTool(
          "library_update",
          async (input) => {
            const metadata = input.metadata as
              | Record<string, unknown>
              | undefined;
            assert.exists(metadata);
            assert.equal(metadata?.DOI, "10.1000/a");
            return {
              appliedCount: 1,
              results: [{ itemId: 1 }],
            };
          },
          ["apply_direct", "review_changes"],
        ),
      );
      const adapter = new StepAdapter([
        {
          kind: "tool_calls",
          calls: [
            {
              id: "call-search",
              name: "literature_search",
              arguments: {
                workflow: "review",
                mode: "metadata",
                query: "paper metadata",
              },
            },
          ],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-search",
                name: "literature_search",
                arguments: {
                  workflow: "review",
                  mode: "metadata",
                  query: "paper metadata",
                },
              },
            ],
          },
        },
      ]);
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
          event.type === "tool_result" && event.name === "literature_search",
      );
      const reviewIndex = events.findIndex(
        (event) =>
          event.type === "confirmation_required" &&
          event.action.toolName === "literature_search",
      );
      const updateResultIndex = events.findIndex(
        (event) =>
          event.type === "tool_result" && event.name === "library_update",
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

  for (const mode of ["safe", "auto", "yolo"]) {
    for (const expand of [false, true]) {
      for (const approve of [true, false]) {
        it(`searches, ranks${expand ? ", expands" : ""}, then ${approve ? "imports only checked papers" : "cancels without writes"} in ${mode}`, async function () {
          const restoreDb = installMockDb();
          const originalFetch = globalThis.fetch;
          let imported: unknown = null;
          let candidateSetId = "";
          let sessionId = "";
          let revision = 0;
          try {
            await initAgentChangeJournal();
            globalThis.fetch = (async () => ({
              ok: true,
              status: 200,
              json: async () => ({
                results: Array.from({ length: 12 }, (_, index) => ({
                  id: `https://openalex.org/W${index + 1}`,
                  display_name: `Candidate ${index + 1}`,
                  doi: `https://doi.org/10.1000/paper-${index + 1}`,
                  publication_year: 2024,
                })),
              }),
            })) as typeof fetch;
            const registry = new AgentToolRegistry();
            const gateway = {
              resolveMetadataItem: () => null,
              getEditableArticleMetadata: () => null,
              getCollectionSummary: () => ({
                collectionId: 79,
                libraryID: 1,
                name: "Test collection",
              }),
            };
            const search = createSearchLiteratureOnlineTool(gateway as never);
            const executeSearch = search.execute;
            search.execute = async (input, context) => {
              const result = (await executeSearch(input, context)) as any;
              candidateSetId = result.candidateSetId;
              sessionId = result.sessionId;
              return result;
            };
            registry.register(
              createRenamedTool({
                tool: search,
                name: "literature_search",
                label: "Search",
              }),
            );
            registry.register(createLiteratureReviewTool(gateway as never));
            registry.register(
              createStubFacadeTool(
                "library_import",
                async (input) => {
                  imported = input;
                  return {
                    appliedCount: 4,
                    result: { succeeded: 4, failed: 0 },
                  };
                },
                ["import"],
              ),
            );
            const callStep = (name: string, args: unknown): AgentModelStep => {
              const calls = [{ id: `call-${name}`, name, arguments: args }];
              return {
                kind: "tool_calls",
                calls,
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: calls,
                },
              };
            };
            const bypassProse = mode === "auto" && !approve;
            const adapter = new StepAdapter([
              callStep("literature_search", {
                mode: "search",
                workflow: "review",
                query: "population coding",
                limit: 12,
              }),
              ...(bypassProse
                ? [
                    {
                      kind: "final",
                      text: "Here are my recommendations.",
                    } as AgentModelStep,
                  ]
                : []),
              () =>
                callStep("literature_review", {
                  selections: [8, 2, 10, 4, 1].map((candidateIndex) => ({
                    candidateSetId,
                    candidateIndex,
                    reason: "Relevant decoding evidence.",
                  })),
                  targetCollectionId: 79,
                }),
              ...(expand
                ? [
                    {
                      kind: "final",
                      text: "Already showed the card.",
                    } as AgentModelStep,
                    () =>
                      callStep("literature_review", {
                        sessionId,
                        revision,
                        selections: [3, 5, 6, 7, 9].map((candidateIndex) => ({
                          candidateSetId,
                          candidateIndex,
                          reason: "Additional relevant evidence.",
                        })),
                      }),
                  ]
                : []),
            ]);
            const runtime = new AgentRuntime({
              semanticInterpreter: declaredSemanticInterpreter,
              registry,
              adapterFactory: () => adapter,
            });
            const cards: string[] = [];
            const outcome = await runtime.runTurn({
              request: makeRequest({
                classifiedIntent: {
                  ...classifiedFixture(),
                  semantic: {
                    ...classifiedFixture().semantic!,
                    literature: "select_then_import",
                  },
                },
                userText:
                  "Find five papers relevant to this paper. Let me review them before importing.",
                metadata: { permissionMode: mode },
              }),
              onEvent: async (event) => {
                if (event.type !== "confirmation_required") return;
                cards.push(event.action.toolName);
                assert.equal(event.action.toolName, "literature_review");
                assert.isNull(imported, "no imports before shortlist approval");
                const list = event.action.fields[0];
                if (list.type !== "paper_result_list")
                  throw new Error("Not a paper card");
                assert.deepEqual(
                  list.rows.map((row) => row.title),
                  (cards.length > 1
                    ? [8, 2, 10, 4, 1, 3, 5, 6, 7, 9]
                    : [8, 2, 10, 4, 1]
                  ).map((i) => `Candidate ${i}`),
                );
                if (expand && cards.length === 1) {
                  revision = event.action.discovery!.revision + 1;
                  runtime.resolveConfirmation(event.requestId, {
                    approved: true,
                    actionId: "find_more",
                    data: { selectedPaperIds: [list.rows[0].id] },
                  });
                  return;
                }
                if (expand) {
                  assert.isTrue(list.rows[0].checked);
                  assert.isFalse(list.rows[1].checked);
                  assert.isTrue(list.rows[5].checked);
                }
                runtime.resolveConfirmation(event.requestId, {
                  approved: approve,
                  actionId: approve ? "import" : "cancel",
                  data: {
                    selectedPaperIds: (expand
                      ? [0, 5, 6, 9]
                      : [0, 2, 3, 4]
                    ).map((i) => list.rows[i].id),
                  },
                });
              },
            });
            assert.equal(outcome.kind, "completed");
            assert.deepEqual(
              cards,
              expand
                ? ["literature_review", "literature_review"]
                : ["literature_review"],
            );
            if (approve)
              assert.deepInclude(imported, {
                identifiers: (expand ? [8, 3, 5, 9] : [8, 10, 4, 1]).map(
                  (i) => `10.1000/paper-${i}`,
                ),
                libraryID: 1,
                targetCollectionId: 79,
              });
            else assert.isNull(imported);
          } finally {
            globalThis.fetch = originalFetch;
            restoreDb();
          }
        });
      }
    }
  }
});
