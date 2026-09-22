import { AgentRunContinuationSession } from "../src/agent/continuation/runContinuationSession";
import { loadWorkflowCheckpoint } from "../src/agent/contracts/workflowCheckpoint";
import {
  createAgentRun,
  appendAgentRunEvent,
} from "../src/agent/store/traceStore";
import { createRequestUserInputTool } from "../src/agent/tools/plan/requestUserInput";
import {
  bumpConversationWriteGeneration,
  getConversationWriteGeneration,
} from "../src/shared/conversationWriteFence";
import { actionFixture } from "./helpers/semanticIntent";
import { classifiedFixture } from "./helpers/semanticIntent";
import { semanticContractFixture } from "./helpers/semanticIntent";
import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { stripNoteHtml } from "../src/utils/noteText";
import { renderMarkdownForNote } from "../src/utils/markdown";
import { DatabaseSync } from "node:sqlite";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import { initAgentPlanStore } from "../src/agent/plans/store";
import { initResearchStore } from "../src/agent/research/store";
import { createDocumentPlan } from "./helpers/documentPlan";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import { createSubmitDocumentTool } from "../src/agent/tools/plan/submitPlanDocument";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/agent/runtime";
import { PlanExecutionRunSession } from "../src/agent/plans/runSession";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import {
  createAgentRunEventJournal,
  getAgentRunTrace,
  initAgentTraceStore,
  INTERRUPTED_AGENT_RUN_MARKER,
} from "../src/agent/store/traceStore";
import {
  initAgentChangeJournal,
  prepareJournalAction,
  updateJournalAction,
} from "../src/agent/store/changeJournal";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import { clearAgentMemory } from "../src/agent/store/conversationMemory";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { PlanAmendmentService } from "../src/agent/plans/amendments";
import {
  ActionContractService,
  describeLibraryMutationActions,
} from "../src/agent/contracts/actionContract";
import { createToolResultReadTool } from "../src/agent/tools/read/toolResultRead";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { TAVILY_API_KEY_PREF } from "../src/webAccess/prefs";
import type { WebAccessProvider } from "../src/webAccess/types";
import {
  MAX_AGENT_ROUNDS,
  MAX_ANSWER_CONTINUATIONS,
  MAX_AGENT_TOOL_CALLS_PER_ROUND,
} from "../src/agent/model/limits";
import {
  BUILTIN_SKILL_FILES,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../src/agent/types";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";
import {
  createBatchItems,
  initAgentBatchItemStore,
  markBatchItemFailed,
  markBatchItemSaved,
} from "../src/agent/store/batchItemStore";
import {
  createBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import {
  installMockDb,
  installAgentStoreSqlite,
  type InstalledMockDb,
} from "./helpers/agentRuntimeMockDb";
import { createTestActionContractService } from "./helpers/actionContractService";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import { withImageRetrieval } from "./helpers/retrievalMocks";

function registerZeroEffectLibraryUpdate(registry: AgentToolRegistry): void {
  registry.register({
    effectOperations: ["move_to_collection"],
    spec: {
      name: "library_update",
      description: "update",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args as never }),
    planInvocation: async () =>
      stateChangeInvocationPlan({
        reversibility: "full",
        reason: "Test library write.",
      }),
    describeAction: () => [
      {
        id: "move-to-collection:unverified",
        proofDomain: "zotero_state",
        capability: "zotero.collections",
        operation: "move_to_collection",
        source: "zotero_native",
        requestedTargets: ["item:1", "item:2"],
        destinationCollectionIds: [],
      },
    ],
    async execute() {
      return {
        content: {
          movedCount: 0,
          selectedCount: 2,
          items: [
            { itemId: 1, status: "missing", reason: "wrong type" },
            { itemId: 2, status: "missing", reason: "wrong type" },
          ],
        },
        effect: "none",
      };
    },
  } as never);
}

function createRequiredMoveActionContractService(): ActionContractService {
  const service = createTestActionContractService();
  service.createContract = async () =>
    semanticContractFixture(
      semanticContractFixture({
        version: 3,
        id: "required-move-contract",
        writeDisposition: "required",
        interpretationSource: "classifier",
        obligations: [
          {
            id: "required-move-contract:obligation:0",
            capability: "zotero.collections",
            operation: "move_to_collection",
            proofDomain: "zotero_state",
            coverage: "all",
            targetKind: "items",
          },
        ],
      }),
    );
  return service;
}

function commandActionDescriptor(id: string) {
  return [
    {
      id,
      proofDomain: "execution" as const,
      capability: "command.execute" as const,
      operation: "command_execute" as const,
      source: "command" as const,
      requestedTargets: [],
      destinationCollectionIds: [],
    },
  ];
}

function readPersistedTranscript(
  installed: InstalledMockDb,
  conversationKey: number,
): AgentModelMessage[] {
  return installed.transcripts
    .filter((row) => Number(row.conversationKey) === Number(conversationKey))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((row) => JSON.parse(String(row.messageJson)) as AgentModelMessage);
}

class MockAdapter implements AgentModelAdapter {
  private stepIndex = 0;

  constructor(
    private readonly steps: AgentModelStep[],
    private readonly capabilities: AgentModelCapabilities,
  ) {}

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return this.capabilities;
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return this.capabilities.toolCalls;
  }

  async runStep(_params: AgentStepParams): Promise<AgentModelStep> {
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    return step;
  }
}

describe("AgentRuntime", function () {
  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
  });

  for (const nativeCallback of [false, true]) {
    it(`preserves compact tool results and exact answers on follow-up (${nativeCallback ? "native callback" : "ordinary tool loop"})`, async function () {
      const restore = installMockDb();
      const conversationKey = nativeCallback ? 810003 : 810002;
      const content = {
        results: [
          {
            itemId: 17,
            title: "Working memory",
            text: "Source passage.\n\n  Preserve indentation.",
          },
        ],
        totalCount: 1,
      };
      const answer = `A summary based on the source. ${"Evidence detail. ".repeat(30)}Final sentence must remain available.`;
      const call = { id: "read-compact", name: "query_library", arguments: {} };
      function checkToolText(text: string) {
        assert.notInclude(
          text,
          "\n",
          "only JSON formatting whitespace is removed",
        );
        assert.deepEqual(JSON.parse(text), { ...content, actionReceipts: [] });
      }
      try {
        await clearAgentMemory(conversationKey);
        const registry = new AgentToolRegistry();
        registry.register({
          spec: {
            name: "query_library",
            description: "Read library",
            inputSchema: { type: "object" },
            executionClass: "read",
            requiresConfirmation: false,
          },
          validate: () => ({ ok: true, value: {} }),
          execute: async () => content,
        });
        let step = 0;
        let followup = false;
        const runtime = new AgentRuntime({
          registry,
          adapterFactory: () => ({
            getCapabilities: () => ({
              streaming: false,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              step++;
              if (followup) {
                assert.equal(
                  params.messages.findLast(
                    (message) =>
                      message.role === "assistant" &&
                      !message.tool_calls?.length,
                  )?.content,
                  answer,
                );
                const turn = params.messages.findLast(
                  (message) => message.role === "user",
                );
                assert.notInclude(
                  String(turn?.content),
                  "Conversation continuity notes",
                );
                const tool = params.messages.find(
                  (message) =>
                    message.role === "user" &&
                    message.retainedTool?.callId === call.id,
                );
                assert.exists(
                  tool,
                  "the prior tool result is retained on follow-up",
                );
                if (tool?.role !== "user" || !tool.retainedTool?.handle)
                  throw new Error("Missing retained tool handle");
                const stored = await getAgentToolResultHandle({
                  conversationKey,
                  handle: tool.retainedTool.handle,
                });
                assert.deepEqual(stored?.content, {
                  ...content,
                  actionReceipts: [],
                });
              } else if (step === 1) {
                if (!nativeCallback)
                  return {
                    kind: "tool_calls",
                    calls: [call],
                    assistantMessage: {
                      role: "assistant",
                      content: "",
                      tool_calls: [call],
                    },
                  };
                const result = await params.onToolCall!(call);
                const text = result.contentItems.find(
                  (item) => item.type === "inputText",
                );
                assert.equal(text?.type, "inputText");
                if (text?.type === "inputText") checkToolText(text.text);
              } else {
                const tool = params.messages.find(
                  (message) => message.role === "tool",
                );
                checkToolText(String(tool?.content));
              }
              return {
                kind: "final",
                text: answer,
                assistantMessage: { role: "assistant", content: answer },
              };
            },
          }),
        });
        const request: AgentRuntimeRequest = {
          classifiedIntent: classifiedFixture(),
          conversationKey,
          mode: "agent",
          userText: "Summarize the library result",
          model: "test",
          apiKey: "test",
        };
        assert.equal((await runtime.runTurn({ request })).kind, "completed");
        followup = true;
        assert.equal(
          (
            await runtime.runTurn({
              request: { ...request, userText: "Explain that summary" },
            })
          ).kind,
          "completed",
        );
        assert.equal(step, nativeCallback ? 2 : 3);
      } finally {
        await clearAgentMemory(conversationKey);
        restore();
      }
    });
  }

  it("reaches the main model without a preliminary semantic model call", async function () {
    const restore = installMockDb();
    let mainModelCalls = 0;
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            mainModelCalls++;
            return {
              kind: "final",
              text: "The paper argues that attention changes sensory gain.",
              assistantMessage: {
                role: "assistant",
                content:
                  "The paper argues that attention changes sensory gain.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 998812,
          mode: "agent",
          userText: "What is the main claim?",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(mainModelCalls, 1);
    } finally {
      restore();
    }
  });

  it("preserves prior durable workflow evidence when the main model fails", async function () {
    const restore = installMockDb();
    try {
      const service = createRequiredMoveActionContractService();
      const contract = await service.createContract({} as never);
      const progress = service.createProgress(contract);
      await createAgentRun({
        runId: "prior-workflow",
        conversationKey: 998811,
        mode: "agent",
        status: "failed",
        createdAt: 1,
      });
      await appendAgentRunEvent("prior-workflow", 1, {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { contract, progress },
      });
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(service),
        adapterFactory: () =>
          new MockAdapter([], {
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
      });
      let failed = false;
      try {
        await runtime.runTurn({
          request: {
            conversationKey: 998811,
            mode: "agent",
            userText: "Continue the unfinished workflow",
            libraryID: 1,
            model: "test",
            apiKey: "test",
            apiBase: "https://example.invalid",
          },
        });
      } catch {
        failed = true;
      }
      assert.isTrue(failed, "The injected interpretation failure must occur");
      const retained = await loadWorkflowCheckpoint(998811);
      assert.equal(
        retained?.contract.id,
        contract.id,
        "A failed interpretation must not hide the last durable workflow from the next turn",
      );
    } finally {
      restore();
    }
  });

  it("durably orders immutable native authority snapshots before finalization", async function () {
    const restore = installMockDb();
    try {
      const journal = createAgentRunEventJournal({
        conversationKey: 991001,
        conversationGeneration: getConversationWriteGeneration(991001),
      });
      const event: AgentEvent = {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { progress: { status: "staged" } },
      };
      const first = journal.append(event);
      (event.payload as { progress: { status: string } }).progress.status =
        "applied";
      const second = journal.append(event);
      await Promise.all([first, second]);
      await journal.finish("completed", "Verified");
      const trace = await getAgentRunTrace(journal.runId);
      assert.equal(trace.run?.status, "completed");
      assert.deepEqual(
        trace.events.map((entry) => entry.seq),
        [1, 2, 3],
      );
      assert.include(JSON.stringify(trace.events[0]), "staged");
      assert.include(JSON.stringify(trace.events[1]), "applied");
      let lateError = "";
      try {
        await journal.append(event);
      } catch (error) {
        lateError = String(error);
      }
      assert.include(lateError, "finalized");
    } finally {
      restore();
    }
  });

  it("keeps failed native authority persistence terminal and never publishes a later success", async function () {
    const restore = installMockDb();
    const query = Zotero.DB.queryAsync;
    try {
      const journal = createAgentRunEventJournal({
        conversationKey: 991003,
        conversationGeneration: getConversationWriteGeneration(991003),
      });
      Zotero.DB.queryAsync = (async (sql: string, ...args: any[]) => {
        if (sql.startsWith("INSERT INTO llm_for_zotero_agent_run_events"))
          throw new Error("disk write failed");
        return (query as any)(sql, ...args);
      }) as typeof query;
      for (const operation of [
        () => journal.append({ type: "status", text: "staged authority" }),
        () => journal.append({ type: "status", text: "execution" }),
        () => journal.finish("completed", "Done"),
      ]) {
        let failure = "";
        try {
          await operation();
        } catch (error) {
          failure = String(error);
        }
        assert.include(failure, "disk write failed");
      }
      const trace = await getAgentRunTrace(journal.runId);
      assert.equal(trace.run?.status, "running");
      assert.isEmpty(trace.events);
    } finally {
      Zotero.DB.queryAsync = query;
      restore();
    }
  });

  it("invalidates queued native execution authority when the conversation changes", async function () {
    const restore = installMockDb();
    try {
      const key = 991002;
      const journal = createAgentRunEventJournal({
        conversationKey: key,
        conversationGeneration: getConversationWriteGeneration(key),
      });
      const pending = journal.append({
        type: "provider_event",
        providerType: "agent_semantic_intent",
        payload: {},
      });
      bumpConversationWriteGeneration(key);
      let failure = "";
      try {
        await pending;
      } catch (error) {
        failure = String(error);
      }
      assert.include(failure, "no longer current");
      assert.isNull((await getAgentRunTrace(journal.runId)).run);
    } finally {
      restore();
    }
  });

  for (const scenario of [
    {
      name: "concise paper summary",
      userText: "List the key points as concise bullet points.",
      modes: ["overview"],
      answer:
        "- Synaptic intelligence protects important parameters.\n- Importance is estimated during training.",
    },
    {
      name: "targeted paper question",
      userText: "How is parameter importance estimated?",
      modes: ["overview", "targeted"],
      answer: "Importance is estimated along the training trajectory.",
    },
    {
      name: "explicit paper claim audit",
      userText:
        "Verify whether the paper establishes that 0.52 is chance-level accuracy.",
      modes: ["targeted"],
      answer:
        "The paper reports 0.52 but supplies neither a class count nor a chance baseline. The chance-level claim is unsupported.",
    },
  ]) {
    it(`completes ${scenario.name} without an automatic review or final rollback`, async function () {
      const restoreDb = installMockDb();
      const events: AgentEvent[] = [];
      let steps = 0;
      const reads: string[] = [];
      try {
        const registry = new AgentToolRegistry();
        registry.register({
          spec: {
            name: "paper_read",
            description: "Read paper evidence",
            inputSchema: { type: "object" },
            executionClass: "read",
            requiresConfirmation: false,
          },
          validate: (args) => ({ ok: true, value: args }),
          execute: async (args) => {
            const mode = (args as { mode: string }).mode;
            reads.push(mode);
            return {
              mode,
              results: [
                {
                  paperContext: { itemId: 3928, contextItemId: 3931 },
                  chunkIndex: mode === "overview" ? 0 : 1,
                  text:
                    mode === "overview"
                      ? "Synaptic intelligence protects important parameters. Importance is estimated during training."
                      : "Importance is estimated along the training trajectory. Accuracy is 0.52; no class count or chance baseline is supplied.",
                },
              ],
            };
          },
        });
        const runtime = new AgentRuntime({
          registry,
          adapterFactory: () => ({
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              assert.notInclude(
                JSON.stringify(params.messages),
                "Perform the final paper-answer source-check",
              );
              const mode = scenario.modes[steps++];
              if (mode) {
                const call = {
                  id: `paper-read-${steps}`,
                  name: "paper_read",
                  arguments: {
                    mode,
                    ...(mode === "targeted"
                      ? { query: scenario.userText }
                      : {}),
                  },
                };
                return {
                  kind: "tool_calls",
                  calls: [call],
                  assistantMessage: {
                    role: "assistant",
                    content: "",
                    tool_calls: [call],
                  },
                };
              }
              assert.equal(
                steps,
                scenario.modes.length + 1,
                "the completed answer must not be retried",
              );
              await params.onTextDelta?.(scenario.answer);
              return {
                kind: "final",
                text: scenario.answer,
                assistantMessage: {
                  role: "assistant",
                  content: scenario.answer,
                },
              };
            },
          }),
        });
        const outcome = await runtime.runTurn({
          request: {
            conversationKey: 939301,
            mode: "agent",
            conversationKind: "paper",
            activeItemId: 3928,
            libraryID: 1,
            userText: scenario.userText,
            model: "test-model",
            apiKey: "test",
            apiBase: "",
            classifiedIntent: {
              ...classifiedFixture(),
              semantic: semanticFixture(),
              retrievalIntent: "none",
              wantedSections: [],
              actionIntents: [],
            },
          },
          onEvent: (event) => events.push(event),
        });
        assert.equal(outcome.kind, "completed");
        if (outcome.kind !== "completed") return;
        assert.equal(outcome.text, scenario.answer);
        assert.equal(steps, scenario.modes.length + 1);
        assert.deepEqual(reads, scenario.modes);
        assert.equal(
          events
            .filter((event) => event.type === "message_delta")
            .map((event) => event.text)
            .join(""),
          scenario.answer,
        );
        assert.isFalse(
          events.some(
            (event) =>
              event.type === "message_rollback" ||
              event.type === "confirmation_required",
          ),
        );
        const trace = await getAgentRunTrace(outcome.runId);
        assert.equal(trace.run?.finalText, scenario.answer);
      } finally {
        restoreDb();
      }
    });
  }

  it("falls back when the adapter does not support tools", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter([], {
            streaming: false,
            toolCalls: false,
            multimodal: false,
          }),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          libraryID: 1,
          mode: "agent",
          userText: "hello",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "fallback");
      assert.deepInclude(events[0], {
        type: "fallback",
      });
    } finally {
      restoreDb();
    }
  });

  it("retains figure provenance for authored documents before their submission", async function () {
    const restoreDb = installMockDb();
    try {
      (Zotero as unknown as { Items: unknown }).Items = {
        get: (id: number) => ({
          id,
          key: id === 10 ? "PAPER001" : "PDF00001",
          libraryID: 1,
          ...(id === 20 ? { parentID: 10 } : {}),
        }),
      };
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "paper_read",
          description: "Extract figure",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          mode: "figures",
          figures: [
            {
              paperContext: { itemId: 10, contextItemId: 20 },
              cropPath: "/tmp/crop.png",
              pageIndex: 2,
              sourceFingerprint: "sha256:pdf",
            },
          ],
        }),
      });
      let observed: AgentRuntimeRequest["documentReadObservations"];
      let calls = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          supportsTools: () => true,
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          runStep: async ({ request }) => {
            if (calls++) {
              observed = request.documentReadObservations;
              throw new Error("test provenance checkpoint");
            }
            const call = {
              id: "read-figure",
              name: "paper_read",
              arguments: { mode: "figures" },
            };
            return {
              kind: "tool_calls",
              calls: [call],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [call],
              },
            };
          },
        }),
      });
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture({
              deliverableIntent: "document",
              documentKind: "report",
            }),
            conversationKey: 421,
            libraryID: 1,
            mode: "agent",
            userText: "Write a report including Figure 1",
            model: "gpt-5.4",
            apiKey: "test",
          },
        });
        assert.fail("expected test checkpoint");
      } catch (error) {
        assert.include(String(error), "test provenance checkpoint");
      }
      assert.lengthOf(observed || [], 1);
      assert.deepInclude(observed![0], {
        itemKey: "PAPER001",
        attachmentItemKey: "PDF00001",
        pageIndex: 2,
      });
      assert.deepEqual(observed![0].capabilities, ["figure"]);
    } finally {
      restoreDb();
    }
  });

  it("finalizes a run row when the provider throws", async function () {
    const restoreDb = installMockDb();
    const originalInterrupt = PlanExecutionRunSession.prototype.interrupt;
    const interruptions: string[] = [];
    PlanExecutionRunSession.prototype.interrupt = async function (reason) {
      interruptions.push(reason);
    };
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          runStep: async () => {
            throw new Error("provider interrupted");
          },
        }),
      });

      let failure = "";
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 3,
            libraryID: 1,
            mode: "agent",
            userText: "Explain this topic",
          },
        });
      } catch (error) {
        failure = String(error);
      }

      assert.match(failure, /provider interrupted/);
      const run = [...restoreDb.runs.values()].find(
        (entry) => Number(entry.conversationKey) === 3,
      );
      assert.equal(run?.status, "failed");
      assert.equal(run?.finalText, INTERRUPTED_AGENT_RUN_MARKER);
      assert.lengthOf(
        interruptions,
        1,
        "provider failure must terminalize the active plan session too",
      );
    } finally {
      PlanExecutionRunSession.prototype.interrupt = originalInterrupt;
      restoreDb();
    }
  });

  it("runs issue #393 from Agent request through an empty-target paper_read call", async function () {
    const restoreDb = installMockDb();
    const paperContext = {
      itemId: 101,
      contextItemId: 202,
      title: "Issue 393 paper",
    };
    let ensuredPaper: unknown;
    try {
      const registry = new AgentToolRegistry();
      registry.register(
        createPaperReadTool(
          {
            ensurePaperContext: async (paper: unknown) => {
              ensuredPaper = paper;
              return {
                title: paperContext.title,
                chunks: ["The method used a stable readout."],
                chunkMeta: [
                  {
                    chunkIndex: 0,
                    text: "The method used a stable readout.",
                    normalizedText: "the method used a stable readout.",
                    chunkKind: "body",
                  },
                ],
                chunkStats: [],
                docFreq: {},
                avgChunkLength: 0,
                fullLength: 35,
              };
            },
          } as never,
          withImageRetrieval({
            retrieveEvidence: async () => [
              {
                paperContext,
                chunkIndex: 0,
                text: "The method used a stable readout.",
                score: 1,
                sourceLabel: "Issue 393 paper",
              },
            ],
          }) as never,
          {} as never,
          {
            resolvePaperContextTarget: () => paperContext,
          } as never,
        ),
      );
      const toolCall = {
        id: "issue-393-paper-read",
        name: "paper_read",
        arguments: {
          mode: "targeted",
          target: {},
          query: "Use the actual PDF/full text to explain the method.",
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [toolCall],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [toolCall],
                },
              },
              {
                kind: "final",
                text: "The paper uses a stable readout.",
                assistantMessage: {
                  role: "assistant",
                  content: "The paper uses a stable readout.",
                },
              },
              {
                kind: "final",
                text: "The paper uses a stable readout.",
                assistantMessage: {
                  role: "assistant",
                  content: "The paper uses a stable readout.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 393,
          libraryID: 1,
          conversationKind: "paper",
          mode: "agent",
          userText: "Use the actual PDF/full text to explain the method.",
          activeItemId: paperContext.itemId,
          selectedPaperContexts: [paperContext],
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      assert.deepInclude(ensuredPaper as Record<string, unknown>, paperContext);
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "tool_result" &&
            event.name === "paper_read" &&
            !event.ok,
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("loads semantic skill choices before the first main-model step without creating action authority", async function () {
    const restoreDb = installMockDb();
    setUserSkills(
      Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
    );
    const events: AgentEvent[] = [];
    let selected = false;
    let observed = false;
    try {
      const adapter = new MockAdapter([], {
        streaming: false,
        toolCalls: true,
        multimodal: false,
      });
      adapter.runStep = async (params) => {
        assert.isTrue(selected);
        assert.includeMembers(
          params.request.loadedSkillRecords!.map((skill) => skill.id),
          ["analyze-figures", "write-note"],
        );
        assert.isUndefined(params.request.classifiedIntent);
        assert.isUndefined(params.request.actionContract);
        const prompt = JSON.stringify(params);
        assert.include(prompt, "bundled Python source-PDF extractor");
        assert.include(prompt, "narrowly scoped note");
        assert.includeMembers(
          events.filter((e) => e.type === "status").map((e) => e.text),
          ["Skill activated: analyze-figures", "Skill activated: write-note"],
        );
        observed = true;
        return {
          kind: "final",
          text: "Ready",
          assistantMessage: { role: "assistant", content: "Ready" },
        };
      };
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => adapter,
        skillSelector: async () => {
          selected = true;
          return {
            status: "selected",
            skillIds: ["analyze-figures", "write-note"],
          };
        },
      });
      await runtime.runTurn({
        request: {
          conversationKey: 90012,
          libraryID: 1,
          mode: "agent",
          userText: "Save a crop in a note",
          model: "test",
          apiKey: "test",
          apiBase: "",
          selectedPaperContexts: [
            { itemId: 10, contextItemId: 11, title: "Paper" },
          ],
        },
        onEvent: (event) => {
          events.push(event);
        },
      });
      assert.isTrue(observed);
    } finally {
      setUserSkills([]);
      restoreDb();
    }
  });

  it("emits explicitly forced slash skills when automatic routing is unavailable", async function () {
    const restoreDb = installMockDb();
    setUserSkills(
      Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
    );
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "final",
                text: "Done.",
                assistantMessage: {
                  role: "assistant",
                  content: "Done.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
            },
          ),
      });
      const events: AgentEvent[] = [];

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          libraryID: 1,
          mode: "agent",
          userText: "help me understand this paper",
          selectedPaperContexts: [
            { itemId: 10, contextItemId: 11, title: "Paper" },
          ],
          forcedSkillIds: ["evidence-based-qa"],
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
          metadata: { instructionHarnessInventory: true },
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      const statusTexts = events
        .filter(
          (event): event is Extract<AgentEvent, { type: "status" }> =>
            event.type === "status",
        )
        .map((event) => event.text);
      assert.includeMembers(statusTexts, [
        "Skill activated: evidence-based-qa",
      ]);
      const inventoryEvent = events.find(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "instruction_harness_inventory",
      );
      assert.isDefined(inventoryEvent);
      if (inventoryEvent?.type === "provider_event") {
        assert.deepEqual(inventoryEvent.payload?.matchedSkillIds, [
          "evidence-based-qa",
        ]);
        assert.isAbove(Number(inventoryEvent.payload?.fixedTokens || 0), 0);
        assert.isAbove(
          Number(inventoryEvent.payload?.matchedSkillTokens || 0),
          0,
        );
        assert.match(
          String(inventoryEvent.payload?.promptHash || ""),
          /^fnv1a32-[0-9a-f]{8}$/,
        );
      }
    } finally {
      setUserSkills([]);
      restoreDb();
    }
  });

  it("keeps instruction inventory telemetry opt-in", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "final",
                text: "Done.",
                assistantMessage: { role: "assistant", content: "Done." },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      const events: AgentEvent[] = [];

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 2,
          mode: "agent",
          userText: "Hello",
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
        onEvent: (event) => events.push(event),
      });

      assert.isFalse(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.providerType === "instruction_harness_inventory",
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("executes tool calls and resumes after approval", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      globalThis.Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.originalAgentPermissionMode",
        "safe",
      );
      const registry = new AgentToolRegistry(
        createTestActionContractService((itemId) =>
          itemId === 500
            ? ({
                id: 500,
                parentID: false,
                deleted: false,
                isNote: () => true,
                getNote: () => "edited hello",
                getCollections: () => [],
              } as unknown as Zotero.Item)
            : null,
        ),
      );
      registry.register({
        effectOperations: ["note_create"],
        spec: {
          name: "mutate_library",
          description: "mutate",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          workCategory: "zotero_action",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: { content: "hello" } }),
        describeAction: (input) => [
          {
            id: "note_create:approval-test",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: {
              noteMode: "create",
              expectedText: input.content,
            },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        createPendingAction: () => ({
          toolName: "mutate_library",
          title: "Save hello",
          confirmLabel: "Approve",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "textarea",
              id: "content",
              label: "Note content",
              value: "hello",
            },
            {
              type: "select",
              id: "target",
              label: "Save target",
              value: "item",
              options: [
                { id: "item", label: "Save as item note" },
                { id: "standalone", label: "Save as standalone note" },
              ],
            },
          ],
        }),
        applyConfirmation: (input, resolutionData) => {
          if (!resolutionData || typeof resolutionData !== "object") {
            return { ok: true, value: input };
          }
          const data = resolutionData as {
            content?: unknown;
            target?: unknown;
          };
          return {
            ok: true,
            value: {
              content:
                typeof data.content === "string" && data.content.trim()
                  ? data.content.trim()
                  : input.content,
              target:
                data.target === "item" || data.target === "standalone"
                  ? data.target
                  : "item",
            },
          };
        },
        execute: async (input) => ({
          content: {
            status: "created",
            noteId: 500,
            saved: input.content,
            target: input.target,
          },
          effect: "applied",
        }),
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-1",
                    name: "mutate_library",
                    arguments: { content: "hello" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      name: "mutate_library",
                      arguments: { content: "hello" },
                    },
                  ],
                },
              },
              {
                kind: "final",
                text: "Saved.",
                assistantMessage: {
                  role: "assistant",
                  content: "Saved.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
            },
          ),
      });

      const events: AgentEvent[] = [];
      const outcomePromise = runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("note_create", undefined, {
            noteDestination: "zotero",
          }),
          conversationKey: 1,
          mode: "agent",
          libraryID: 1,
          userText: "create a standalone note with hello",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "confirmation_required") {
            runtime.resolveConfirmation(event.requestId, true, {
              content: "edited hello",
              target: "standalone",
            });
          }
        },
      });
      const outcome = await outcomePromise;

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(
        outcome.text,
        "Saved.\n\n[Action status: note_create — applied 1/1; Verified; proof:zotero_state]",
      );
      assert.isTrue(events.some((event) => event.type === "tool_call"));
      assert.isTrue(events.some((event) => event.type === "tool_result"));
      assert.equal(
        events.find((event) => event.type === "tool_call")?.workCategory,
        "zotero_action",
      );
      const toolResultIndex = events.findIndex(
        (event) => event.type === "tool_result",
      );
      const toolResultEvent = events[toolResultIndex];
      assert.isAtLeast(toolResultIndex, 0);
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.providerType === "agent_action_contract",
        ),
        "ordinary execution must not recreate an action-contract stage",
      );
      assert.deepEqual(
        toolResultEvent && toolResultEvent.type === "tool_result"
          ? toolResultEvent.content
          : null,
        {
          status: "created",
          noteId: 500,
          saved: "edited hello",
          target: "standalone",
        },
      );
      assert.equal(
        toolResultEvent?.type === "tool_result"
          ? toolResultEvent.workCategory
          : undefined,
        "zotero_action",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "confirmation_resolved" && event.approved === true,
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("passes image artifacts back into the next model step", async function () {
    const restoreDb = installMockDb();
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        btoa?: (value: string) => string;
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-agent-runtime-"));
    const imagePath = join(tempDir, "page.png");
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    try {
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = {
        read: async (path: string) => new Uint8Array(readFileSync(path)),
      };
      (
        globalThis as typeof globalThis & {
          btoa?: (value: string) => string;
        }
      ).btoa = (value: string) =>
        Buffer.from(value, "binary").toString("base64");

      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "view_pdf_pages",
          description: "inspect pdf",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          content: { pageCount: 1 },
          artifacts: [
            {
              kind: "image" as const,
              mimeType: "image/png",
              storedPath: imagePath,
              contentHash: "hash-1",
              pageIndex: 2,
              pageLabel: "3",
              title: "Paper - page 3",
            },
          ],
        }),
      });

      let sawArtifactUserMessage = false;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            if (!sawArtifactUserMessage) {
              sawArtifactUserMessage = params.messages.some(
                (message) =>
                  message.role === "user" &&
                  Array.isArray(message.content) &&
                  message.content.some(
                    (part) =>
                      part.type === "image_url" &&
                      part.image_url.url.startsWith("data:image/png;base64,"),
                  ),
              );
              if (!sawArtifactUserMessage) {
                return {
                  kind: "tool_calls",
                  calls: [
                    {
                      id: "call-1",
                      name: "view_pdf_pages",
                      arguments: {},
                    },
                  ],
                  assistantMessage: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "call-1",
                        name: "view_pdf_pages",
                        arguments: {},
                      },
                    ],
                  },
                };
              }
            }
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: {
                role: "assistant",
                content: "Done.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "Explain the figure",
          model: "gpt-4.1",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.isTrue(sawArtifactUserMessage);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
      restoreDb();
    }
  });

  it("passes image artifacts while omitting PDF artifacts for image-only adapters", async function () {
    const restoreDb = installMockDb();
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        btoa?: (value: string) => string;
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-agent-runtime-"));
    const imagePath = join(tempDir, "page.png");
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    try {
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = {
        read: async (path: string) => new Uint8Array(readFileSync(path)),
      };
      (
        globalThis as typeof globalThis & {
          btoa?: (value: string) => string;
        }
      ).btoa = (value: string) =>
        Buffer.from(value, "binary").toString("base64");

      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "prepare_visual_artifacts",
          description: "prepare visual artifacts",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          content: { pageTexts: [{ pageLabel: "1", text: "Extracted text" }] },
          artifacts: [
            {
              kind: "image" as const,
              mimeType: "image/png",
              storedPath: imagePath,
              pageLabel: "1",
            },
            {
              kind: "file_ref" as const,
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/nonexistent-paper.pdf",
            },
          ],
        }),
      });

      let stepIndex = 0;
      let continuationMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            contentInputs: {
              images: true,
              pdfDocuments: false,
              nativeFiles: false,
            },
            multimodal: true,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            if (stepIndex === 0) {
              stepIndex += 1;
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-1",
                    name: "prepare_visual_artifacts",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      name: "prepare_visual_artifacts",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            continuationMessages = params.messages;
            return {
              kind: "final",
              text: "done",
              assistantMessage: { role: "assistant", content: "done" },
            };
          },
        }),
      });

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 98,
          mode: "agent",
          userText: "inspect the figure",
          model: "image-capable-chat",
        },
      });

      const serialized = JSON.stringify(continuationMessages);
      assert.include(serialized, "image_url");
      assert.notInclude(serialized, "file_ref");
      assert.include(serialized, "PDF/document input");
      assert.include(serialized, "does not support PDF/document input");
      assert.include(serialized, "Extracted text");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
      restoreDb();
    }
  });

  it("does not pass image or PDF artifacts to non-multimodal models", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "prepare_visual_artifacts",
          description: "prepare visual artifacts",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          content: { pageTexts: [{ pageLabel: "1", text: "Extracted text" }] },
          artifacts: [
            {
              kind: "image" as const,
              mimeType: "image/png",
              storedPath: "/tmp/nonexistent-page.png",
              pageLabel: "1",
            },
            {
              kind: "file_ref" as const,
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/nonexistent-paper.pdf",
            },
          ],
        }),
      });

      let stepIndex = 0;
      let continuationMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            if (stepIndex === 0) {
              stepIndex += 1;
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-1",
                    name: "prepare_visual_artifacts",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      name: "prepare_visual_artifacts",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            continuationMessages = params.messages;
            return {
              kind: "final",
              text: "done",
              assistantMessage: { role: "assistant", content: "done" },
            };
          },
        }),
      });

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 99,
          mode: "agent",
          userText: "inspect the figure",
          model: "local-text-only",
        },
      });

      const serialized = JSON.stringify(continuationMessages);
      assert.notInclude(serialized, "image_url");
      assert.notInclude(serialized, "file_ref");
      assert.include(serialized, "does not support image input");
      assert.include(serialized, "PDF/document input");
      assert.include(serialized, "Extracted text");
    } finally {
      restoreDb();
    }
  });

  it("allows one final synthesis step after the last tool round", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          ok: true,
        }),
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [1, 2, 3, 4]
              .map((index) => ({
                kind: "tool_calls" as const,
                calls: [
                  {
                    id: `call-${index}`,
                    name: "read_context",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant" as const,
                  content: "",
                  tool_calls: [
                    {
                      id: `call-${index}`,
                      name: "read_context",
                      arguments: {},
                    },
                  ],
                },
              }))
              .concat([
                {
                  kind: "final" as const,
                  text: "Summary ready.",
                  assistantMessage: {
                    role: "assistant",
                    content: "Summary ready.",
                  },
                },
              ]),
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
            },
          ),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "summarize the paper",
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Summary ready.");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "status" &&
            event.text === `Continuing agent (5/${MAX_AGENT_ROUNDS})`,
        ),
      );
      assert.equal(
        events.filter((event) => event.type === "tool_result").length,
        4,
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "final" &&
            event.text ===
              "Agent stopped before reaching a final answer. Try narrowing the request.",
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("continues beyond one round segment while tools make new progress", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_chunk",
          description: "read one distinct chunk",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async (input) => ({ chunk: input }),
      });
      const toolSteps: AgentModelStep[] = Array.from(
        { length: MAX_AGENT_ROUNDS + 1 },
        (_, index) => {
          const call = {
            id: `chunk-${index + 1}`,
            name: "read_chunk",
            arguments: { index: index + 1 },
          };
          return {
            kind: "tool_calls" as const,
            calls: [call],
            assistantMessage: {
              role: "assistant" as const,
              content: "",
              tool_calls: [call],
            },
          };
        },
      );
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            toolSteps.concat({
              kind: "final",
              text: "All chunks synthesized.",
              assistantMessage: {
                role: "assistant",
                content: "All chunks synthesized.",
              },
            }),
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
            },
          ),
      });
      const events: AgentEvent[] = [];

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 171,
          mode: "agent",
          userText: "read every distinct chunk and synthesize",
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "All chunks synthesized.");
      assert.equal(
        events.filter((event) => event.type === "tool_result").length,
        MAX_AGENT_ROUNDS + 1,
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "status" &&
            event.text === "Checkpointed agent segment 1; continuing",
        ),
      );
    } finally {
      restoreDb();
    }
  });

  // Invalid input is rejected before execution, so it runs on the six-round
  // input-rejection cap; three sibling calls in one round still count once.
  for (const failingRounds of [1, 6]) {
    it(`counts repeated input rejections across ${failingRounds} model rounds, not sibling calls`, async function () {
      const restoreDb = installMockDb();
      try {
        const registry = new AgentToolRegistry();
        const paperTool = createPaperReadTool(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        );
        let reads = 0;
        registry.register({
          ...paperTool,
          execute: async () => {
            reads += 1;
            return { text: "Verified paper evidence" };
          },
        });
        const steps: AgentModelStep[] = Array.from(
          { length: failingRounds },
          (_, round) => {
            const calls = Array.from({ length: 3 }, (_, i) => ({
              id: `invalid-${round}-${i}`,
              name: "paper_read",
              arguments: {
                mode: "overview",
                targets: [
                  {
                    itemId: 101,
                    contextItemId: 202,
                    title: "Descriptive title from research manifest",
                  },
                ],
              },
            }));
            return {
              kind: "tool_calls" as const,
              calls,
              assistantMessage: {
                role: "assistant" as const,
                content: "",
                tool_calls: calls,
              },
            };
          },
        );
        const repaired = {
          id: "corrected-selector",
          name: "paper_read",
          arguments: {
            mode: "overview",
            targets: [{ itemId: 101, contextItemId: 202 }],
          },
        };
        steps.push(
          {
            kind: "tool_calls",
            calls: [repaired],
            assistantMessage: {
              role: "assistant",
              content: "",
              tool_calls: [repaired],
            },
          },
          {
            kind: "final",
            text: "Evidence read successfully.",
            assistantMessage: {
              role: "assistant",
              content: "Evidence read successfully.",
            },
          },
        );
        const events: AgentEvent[] = [];
        const runtime = new AgentRuntime({
          registry,
          adapterFactory: () =>
            new MockAdapter(steps, {
              streaming: false,
              toolCalls: true,
              multimodal: false,
            }),
        });
        const outcome = await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 9010 + failingRounds,
            mode: "agent",
            userText: "Read these papers and answer from their evidence.",
            model: "gpt-5.4",
            apiBase: "",
            apiKey: "test",
          },
          onEvent: (event) => events.push(event),
        });
        assert.equal(
          events.filter((event) => event.type === "tool_result" && !event.ok)
            .length,
          failingRounds * 3,
        );
        assert.equal(reads, failingRounds === 1 ? 1 : 0);
        assert.equal(outcome.kind, "completed");
        if (outcome.kind !== "completed") return;
        assert.equal(
          outcome.text,
          failingRounds === 1
            ? "Evidence read successfully."
            : "Agent stopped after repeated invalid tool inputs. Please adjust the request and try again.",
        );
      } finally {
        restoreDb();
      }
    });
  }

  it("stops segmented continuation when a full segment only repeats prior work", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_same_chunk",
          description: "read a chunk",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: { index: 1 } }),
        execute: async () => ({ chunk: "unchanged" }),
      });
      const repeatedSteps: AgentModelStep[] = Array.from(
        { length: MAX_AGENT_ROUNDS * 2 },
        (_, index) => {
          const call = {
            id: `repeat-${index + 1}`,
            name: "read_same_chunk",
            arguments: { index: 1 },
          };
          return {
            kind: "tool_calls" as const,
            calls: [call],
            assistantMessage: {
              role: "assistant" as const,
              content: "",
              tool_calls: [call],
            },
          };
        },
      );
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(repeatedSteps, {
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 172,
          mode: "agent",
          userText: "keep reading until done",
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "no new successful tool result");
    } finally {
      restoreDb();
    }
  });

  it("rejects an oversized native tool step whole and retries from a semantic checkpoint", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      let executionCount = 0;
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => {
          executionCount += 1;
          return { ok: true };
        },
      });

      let modelStep = 0;
      let resetCount = 0;
      let sawBoundedFollowup = false;
      let initialMessages: AgentModelMessage[] = [];
      const overLimitCallCount = MAX_AGENT_TOOL_CALLS_PER_ROUND + 1;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          resetState: () => {
            resetCount += 1;
          },
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelStep += 1;
            if (modelStep === 1) {
              initialMessages = structuredClone(params.messages);
              const calls = Array.from(
                { length: overLimitCallCount },
                (_unused, index) => ({
                  id: `call-${index + 1}`,
                  name: "read_context",
                  arguments: {},
                }),
              );
              return {
                kind: "tool_calls",
                calls,
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: calls,
                },
              };
            }
            if (modelStep === 2) {
              const restartedMessages = structuredClone(params.messages);
              assert.isTrue(
                restartedMessages.every(
                  (message) =>
                    message.role === "system" || message.role === "user",
                ),
              );
              assert.deepEqual(
                restartedMessages.slice(0, -1),
                initialMessages,
                "the frozen system/current-turn envelope must be unchanged",
              );
              assert.equal(restartedMessages.at(-1)?.role, "user");
              assert.include(
                JSON.stringify(restartedMessages.at(-1)),
                "Agent semantic continuation checkpoint",
              );
              assert.equal(
                restartedMessages.filter((message) =>
                  JSON.stringify(message).includes(
                    "Agent semantic continuation checkpoint",
                  ),
                ).length,
                1,
              );
              assert.include(
                restartedMessages
                  .map((message) =>
                    typeof message.content === "string" ? message.content : "",
                  )
                  .join("\n"),
                `at most ${MAX_AGENT_TOOL_CALLS_PER_ROUND} tool calls`,
              );
              const call = {
                id: "bounded-call",
                name: "read_context",
                arguments: {},
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            const toolMessages = params.messages.filter(
              (message) => message.role === "tool",
            );
            sawBoundedFollowup =
              toolMessages.length === 1 &&
              toolMessages[0].tool_call_id === "bounded-call";
            return {
              kind: "final",
              text: sawBoundedFollowup ? "Done." : "Inconsistent.",
              assistantMessage: {
                role: "assistant",
                content: sawBoundedFollowup ? "Done." : "Inconsistent.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "summarize the paper",
          systemPrompt: "SYSTEM_RESTART_SENTINEL",
          customInstructions: "CUSTOM_RESTART_SENTINEL",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Done.");
      assert.isTrue(sawBoundedFollowup);
      assert.equal(executionCount, 1);
      assert.equal(resetCount, 1);
    } finally {
      restoreDb();
    }
  });

  it("does not install or reset a semantic restart when checkpoint storage fails", async function () {
    const installed = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      let modelStep = 0;
      let resetCount = 0;
      let executionCount = 0;
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => {
          executionCount += 1;
          return { ok: true };
        },
      });
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          resetState: () => {
            resetCount += 1;
          },
          async runStep(): Promise<AgentModelStep> {
            modelStep += 1;
            installed.setTranscriptWriteFailure(true);
            const calls = Array.from(
              { length: MAX_AGENT_TOOL_CALLS_PER_ROUND + 1 },
              (_unused, index) => ({
                id: `rejected-${index}`,
                name: "read_context",
                arguments: {},
              }),
            );
            return {
              kind: "tool_calls",
              calls,
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: calls,
              },
            };
          },
        }),
      });

      let error: unknown;
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 2,
            mode: "agent",
            userText: "Read safely",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
          },
        });
      } catch (caught) {
        error = caught;
      }

      assert.match(String(error), /transcript checkpoint storage failed/i);
      assert.equal(modelStep, 1);
      assert.equal(executionCount, 0);
      assert.equal(resetCount, 0);
      assert.isAbove(installed.transcriptWriteAttempts(), 0);
    } finally {
      installed();
    }
  });

  it("emits incremental message_delta events when the adapter streams text", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onTextDelta?.("Hello ");
            return {
              kind: "final",
              text: "Hello world.",
              assistantMessage: {
                role: "assistant",
                content: "Hello world.",
              },
            };
          },
        }),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "hello",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Hello world.");
      assert.deepEqual(
        events
          .filter((event) => event.type === "message_delta")
          .map((event) => (event.type === "message_delta" ? event.text : "")),
        ["Hello ", "world."],
      );
    } finally {
      restoreDb();
    }
  });

  for (const incompleteReason of ["stream_interrupted"] as const) {
    it(`rolls back ${incompleteReason} and continues from the preserved step`, async function () {
      const restoreDb = installMockDb();
      try {
        let modelSteps = 0;
        let continuationMessages: AgentModelMessage[] = [];
        const runtime = new AgentRuntime({
          registry: new AgentToolRegistry(),
          adapterFactory: () => ({
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              modelSteps += 1;
              if (modelSteps === 1) {
                await params.onTextDelta?.("Partial scratch text");
                return {
                  kind: "incomplete",
                  reason: incompleteReason,
                  text: "Partial scratch text",
                  recoveryInstruction:
                    "Continue without repeating prior text and emit only complete tool arguments.",
                  assistantMessage: {
                    role: "assistant",
                    content: "Partial scratch text",
                  },
                };
              }
              continuationMessages = structuredClone(params.messages);
              return {
                kind: "final",
                text: "Complete answer",
                assistantMessage: {
                  role: "assistant",
                  content: "Complete answer",
                },
              };
            },
          }),
        });
        const events: AgentEvent[] = [];

        const outcome = await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 1_909,
            mode: "agent",
            userText: "finish this task",
            model: "gpt-5.4",
            apiBase: "https://api.openai.com/v1/responses",
            apiKey: "test",
            advanced: { outputTokenLimit: { mode: "auto" } },
          },
          onEvent: (event) => events.push(event),
        });

        assert.equal(modelSteps, 2);
        assert.equal(outcome.kind, "completed");
        if (outcome.kind === "completed") {
          assert.equal(outcome.text, "Complete answer");
        }
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "message_rollback" &&
              event.text === "Partial scratch text",
          ),
        );
        assert.include(
          JSON.stringify(continuationMessages),
          "Continue without repeating prior text",
        );
      } finally {
        restoreDb();
      }
    });
  }

  it("keeps a truncated final answer on screen and appends its continuation", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      let continuationMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelSteps += 1;
            if (modelSteps === 1) {
              await params.onTextDelta?.("First half of the answer ");
              return {
                kind: "incomplete",
                reason: "output_limit",
                text: "First half of the answer ",
                recoveryInstruction: "Continue with a complete tool call.",
                assistantMessage: {
                  role: "assistant",
                  content: "First half of the answer ",
                },
              };
            }
            continuationMessages = structuredClone(params.messages);
            await params.onTextDelta?.("and the second half.");
            return {
              kind: "final",
              text: "and the second half.",
              assistantMessage: {
                role: "assistant",
                content: "and the second half.",
              },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1_912,
          mode: "agent",
          userText: "write the full review",
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "test",
          advanced: { outputTokenLimit: { mode: "auto" } },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(modelSteps, 2);
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.equal(
          outcome.text,
          "First half of the answer and the second half.",
        );
      }
      assert.isFalse(
        events.some((event) => event.type === "message_rollback"),
        "a truncated answer must stay visible",
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "message_delta")
          .map((event) => (event.type === "message_delta" ? event.text : "")),
        ["First half of the answer ", "and the second half."],
      );
      const serialized = JSON.stringify(continuationMessages);
      assert.include(serialized, "First half of the answer ");
      assert.include(serialized.toLowerCase(), "continue exactly");
      assert.notInclude(serialized, "Continue with a complete tool call.");
      assert.equal([...restoreDb.runs.values()][0]?.status, "completed");
    } finally {
      restoreDb();
    }
  });

  it("bounds answer continuations and delivers what was written", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelSteps += 1;
            const chunk = `part ${modelSteps} `;
            await params.onTextDelta?.(chunk);
            return {
              kind: "incomplete",
              reason: "output_limit",
              text: chunk,
              recoveryInstruction: "Continue with a complete tool call.",
              assistantMessage: { role: "assistant", content: chunk },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1_913,
          mode: "agent",
          userText: "write the full review",
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "test",
          advanced: { outputTokenLimit: { mode: "auto" } },
        },
      });

      assert.equal(modelSteps, MAX_ANSWER_CONTINUATIONS + 1);
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.include(outcome.text, "part 1 part 2 ");
        assert.include(outcome.text, `part ${MAX_ANSWER_CONTINUATIONS + 1} `);
        assert.include(outcome.text.toLowerCase(), "output limit");
      }
    } finally {
      restoreDb();
    }
  });

  it("still rolls back truncated text that preceded a tool call", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelSteps += 1;
            if (modelSteps === 1) {
              await params.onTextDelta?.("Let me look that up ");
              return {
                kind: "incomplete",
                reason: "output_limit",
                text: "Let me look that up ",
                recoveryInstruction: "Continue with a complete tool call.",
                assistantMessage: {
                  role: "assistant",
                  content: "Let me look that up ",
                },
              };
            }
            if (modelSteps === 2) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-1",
                    name: "missing_tool",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    { id: "call-1", name: "missing_tool", arguments: {} },
                  ],
                },
              };
            }
            return {
              kind: "final",
              text: "Final answer.",
              assistantMessage: { role: "assistant", content: "Final answer." },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1_914,
          mode: "agent",
          userText: "look it up",
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "test",
          advanced: { outputTokenLimit: { mode: "auto" } },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.equal(outcome.text, "Final answer.");
      }
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "message_rollback" &&
            event.text === "Let me look that up ",
        ),
        "text kept for continuation must be rolled back once the model calls a tool instead",
      );
    } finally {
      restoreDb();
    }
  });

  it("bounds stream recovery to one retry instead of an endless interrupted Plan", async function () {
    const restoreDb = installMockDb();
    try {
      let calls = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          runStep: async () => {
            calls++;
            return {
              kind: "incomplete",
              reason: "stream_interrupted",
              text: "",
              recoveryInstruction: "Retry the unfinished step",
            } as AgentModelStep;
          },
        }),
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 19091,
          mode: "agent",
          userText: "finish this task",
        },
      });
      assert.equal(calls, 2);
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") assert.include(outcome.text, "stream");
      assert.equal([...restoreDb.runs.values()][0]?.status, "failed");
    } finally {
      restoreDb();
    }
  });

  it("keeps a repeated Custom cap authoritative and terminates with guidance", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            modelSteps += 1;
            return {
              kind: "incomplete",
              reason: "output_limit",
              text: "",
              recoveryInstruction: "Continue with a complete tool call.",
              assistantMessage: { role: "assistant", content: "" },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1_910,
          mode: "agent",
          userText: "finish this task",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
          advanced: {
            outputTokenLimit: { mode: "custom", tokens: 128 },
          },
        },
      });

      assert.equal(modelSteps, MAX_AGENT_ROUNDS);
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.include(outcome.text, "128 tokens");
        assert.include(outcome.text, "Raise the limit");
      }
    } finally {
      restoreDb();
    }
  });

  it("does not expose a local PDF path split across answer or reasoning deltas", async function () {
    const restoreDb = installMockDb();
    const rawPath = "/private/papers/stream-selected.pdf";
    const split = Math.floor(rawPath.length / 2);
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onTextDelta?.(rawPath.slice(0, split));
            await params.onTextDelta?.(rawPath.slice(split));
            await params.onTextDelta?.(" complete");
            await params.onReasoning?.({
              stepId: "split-reasoning",
              summary: rawPath.slice(0, split),
            });
            await params.onReasoning?.({
              stepId: "split-reasoning",
              summary: rawPath.slice(split),
            });
            return {
              kind: "final",
              text: `${rawPath} complete`,
              assistantMessage: {
                role: "assistant",
                content: `${rawPath} complete`,
              },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 7_940_001,
          libraryID: 1,
          mode: "agent",
          userText: "read selected PDF",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
          pdfPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "Selected",
              contentSourceMode: "pdf",
            },
          ],
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:10:11",
              itemId: 10,
              contextItemId: 11,
              title: "Selected",
              name: "stream-selected.pdf",
              mimeType: "application/pdf",
              absolutePath: rawPath,
            },
          ],
        },
        onEvent: (event) => events.push(event),
      });
      const trace = await runtime.getRunTrace(outcome.runId);
      const serialized = JSON.stringify({ events, outcome, trace });

      assert.notInclude(serialized, rawPath);
      assert.include(serialized, "[raw_pdf_path:zotero-pdf:10:11]");
      assert.include(serialized, '"type":"message_delta"');
      assert.include(serialized, '"type":"reasoning"');
    } finally {
      restoreDb();
    }
  });

  it("redacts local document paths from durable tool-result handles", async function () {
    const restoreDb = installMockDb();
    const conversationKey = 7_940_002;
    const rawPath = "/private/papers/durable-selected.pdf";
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_local_path",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ sourcePath: rawPath, text: "Evidence" }),
      });
      let stepIndex = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex === 1) {
              const call = {
                id: "durable-path-call",
                name: "read_local_path",
                arguments: {},
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: { role: "assistant", content: "Done." },
            };
          },
        }),
      });

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey,
          libraryID: 1,
          mode: "agent",
          userText: "Read the selected PDF.",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
          pdfPaperContexts: [
            {
              itemId: 20,
              contextItemId: 21,
              title: "Selected",
              contentSourceMode: "pdf",
            },
          ],
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:20:21",
              itemId: 20,
              contextItemId: 21,
              title: "Selected",
              name: "durable-selected.pdf",
              mimeType: "application/pdf",
              absolutePath: rawPath,
            },
          ],
        },
      });

      const transcript = readPersistedTranscript(restoreDb, conversationKey);
      const handle = JSON.stringify(transcript).match(
        /handle=(trh_[a-z0-9]+)/i,
      )?.[1];
      assert.match(handle || "", /^trh_/);
      const record = await getAgentToolResultHandle({
        conversationKey,
        handle: handle || "",
      });
      const serialized = JSON.stringify(record);
      assert.notInclude(serialized, rawPath);
      assert.include(serialized, "[raw_pdf_path:zotero-pdf:20:21]");
    } finally {
      restoreDb();
    }
  });

  it("rolls back streamed scratch text before adapter tool callbacks", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ ok: true }),
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onTextDelta?.("Let me inspect this first.");
            await params.onToolCall?.({
              id: "call-1",
              name: "read_context",
              arguments: {},
            });
            await params.onTextDelta?.("Done.");
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: {
                role: "assistant",
                content: "Done.",
              },
            };
          },
        }),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "summarize",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Done.");
      assert.deepEqual(
        events
          .filter((event) =>
            ["message_delta", "message_rollback", "tool_call"].includes(
              event.type,
            ),
          )
          .map((event) =>
            event.type === "message_delta"
              ? { type: event.type, text: event.text }
              : event.type === "message_rollback"
                ? { type: event.type, text: event.text }
                : { type: event.type, name: event.name },
          ),
        [
          { type: "message_delta", text: "Let me inspect this first." },
          { type: "message_rollback", text: "Let me inspect this first." },
          { type: "tool_call", name: "read_context" },
          { type: "message_delta", text: "Done." },
        ],
      );
    } finally {
      restoreDb();
    }
  });

  it("prefers post-rollback streamed text when final step text includes scratch text", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ ok: true }),
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onTextDelta?.("I'm reading the parsed paper text.");
            await params.onToolCall?.({
              id: "call-1",
              name: "read_context",
              arguments: {},
            });
            await params.onTextDelta?.("This paper is about working memory.");
            return {
              kind: "final",
              text:
                "I'm reading the parsed paper text." +
                "This paper is about working memory.",
              assistantMessage: {
                role: "assistant",
                content:
                  "I'm reading the parsed paper text." +
                  "This paper is about working memory.",
              },
            };
          },
        }),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "what is this paper about?",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "This paper is about working memory.");
      const trace = await getAgentRunTrace(outcome.runId);
      assert.equal(trace.run?.finalText, "This paper is about working memory.");
      assert.deepEqual(
        events
          .filter((event) =>
            [
              "message_delta",
              "message_rollback",
              "tool_call",
              "final",
            ].includes(event.type),
          )
          .map((event) =>
            event.type === "message_delta"
              ? { type: event.type, text: event.text }
              : event.type === "message_rollback"
                ? { type: event.type, text: event.text }
                : event.type === "tool_call"
                  ? { type: event.type, name: event.name }
                  : { type: event.type, text: event.text },
          ),
        [
          {
            type: "message_delta",
            text: "I'm reading the parsed paper text.",
          },
          {
            type: "message_rollback",
            text: "I'm reading the parsed paper text.",
          },
          { type: "tool_call", name: "read_context" },
          {
            type: "message_delta",
            text: "This paper is about working memory.",
          },
          { type: "final", text: "This paper is about working memory." },
        ],
      );
    } finally {
      restoreDb();
    }
  });

  it("keeps a successful preclassified empty intent authoritative", async function () {
    const restoreDb = installMockDb();
    try {
      let stepIndex = 0;
      let sawCorrection = false;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            sawCorrection ||= params.messages.some(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("open typed obligation(s)"),
            );
            const text = stepIndex === 1 ? "I found it." : "Done.";
            return {
              kind: "final",
              text,
              assistantMessage: { role: "assistant", content: text },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 1,
          mode: "agent",
          userText:
            'Move the paper titled "A very long named paper that previously bypassed the action fallback" to the destination.',
          model: "test-model",
          apiBase: "",
          apiKey: "test",
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "none",
            wantedSections: [],
            actionIntents: [],
          },
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.isFalse(sawCorrection);
      assert.equal(outcome.text, "I found it.");
    } finally {
      restoreDb();
    }
  });

  it("preserves an informational final after permitted exploratory reads", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      let paperReads = 0;
      let effectExecutions = 0;
      const events: AgentEvent[] = [];
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => {
          paperReads += 1;
          return {
            mode: "targeted",
            results: [
              {
                paperContext: {
                  itemId: 1,
                  contextItemId: 2,
                  title:
                    "Overcoming catastrophic forgetting in neural networks",
                },
                chunkIndex: 4,
                sourceFingerprint: "paper-source-1",
                sectionLabel: "Introduction",
                text: "Elastic weight consolidation slows forgetting.",
              },
            ],
          };
        },
      });
      const registerBlockedExploration = (
        name: "zotero_script" | "run_command",
      ) => {
        registry.register({
          effectOperations:
            name === "zotero_script"
              ? ["zotero_script_execute"]
              : ["command_execute"],
          spec: {
            name,
            description: name,
            inputSchema: { type: "object" },
            executionClass: "external_effect",
            requiresConfirmation: true,
          },
          validate: (args) => ({ ok: true, value: args }),
          describeAction: () =>
            name === "zotero_script"
              ? [
                  {
                    id: "zotero_script_execute:qa-inspection",
                    proofDomain: "execution" as const,
                    capability: "zotero.script" as const,
                    operation: "zotero_script_execute" as const,
                    source: "zotero_script" as const,
                    requestedTargets: [],
                    destinationCollectionIds: [],
                  },
                ]
              : commandActionDescriptor("command_execute:qa-inspection"),
          planInvocation: () =>
            stateChangeInvocationPlan({
              reason: "Test blocked exploratory action.",
            }),
          createPendingAction: () => ({
            toolName: name,
            title: `Review ${name}`,
            confirmLabel: "Run",
            cancelLabel: "Cancel",
            fields: [],
          }),
          execute: async () => {
            effectExecutions += 1;
            return {
              content: { status: "unexpected_execution" },
              effect: "applied" as const,
            };
          },
        });
      };
      registerBlockedExploration("zotero_script");
      registerBlockedExploration("run_command");

      const toolStep = (
        id: string,
        name: "paper_read" | "zotero_script" | "run_command",
        args: Record<string, unknown>,
      ): AgentModelStep => ({
        kind: "tool_calls",
        calls: [{ id, name, arguments: args }],
        assistantMessage: {
          role: "assistant",
          content: "",
          tool_calls: [{ id, name, arguments: args }],
        },
      });
      const substantiveAnswer =
        "Elastic weight consolidation protects parameters important to earlier tasks, reducing catastrophic forgetting while leaving other parameters available for new learning.";
      const steps: AgentModelStep[] = [
        toolStep("read-1", "paper_read", {
          mode: "targeted",
          query: "How does the method prevent forgetting?",
        }),
        toolStep("read-2", "paper_read", {
          mode: "targeted",
          query: "How does the method prevent forgetting?",
        }),
        toolStep("script-1", "zotero_script", {
          access: "library",
          effect: "read",
        }),
        toolStep("command-1", "run_command", { command: "rg EWC paper.txt" }),
        {
          kind: "final",
          text: substantiveAnswer,
          assistantMessage: {
            role: "assistant",
            content: substantiveAnswer,
          },
        },
        {
          kind: "final",
          text: "No response.",
          assistantMessage: { role: "assistant", content: "No response." },
        },
      ];
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            const step = steps[modelSteps];
            modelSteps += 1;
            return step;
          },
        }),
      });
      let confirmations = 0;
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 2448,
          conversationKind: "paper",
          mode: "agent",
          userText:
            "How does Overcoming catastrophic forgetting in neural networks prevent forgetting?",
          model: "test-model",
          apiBase: "",
          apiKey: "test",
          libraryID: 1,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "targeted",
            wantedSections: [],
            writeDisposition: "none",
            actionIntents: [],
          },
        },
        onEvent: (event) => {
          events.push(event);
          if (event.type !== "confirmation_required") return;
          confirmations += 1;
          runtime.resolveConfirmation(event.requestId, false);
        },
      });

      assert.equal(
        confirmations,
        0,
        "The concrete calls are assessed as read-only inspection.",
      );
      assert.equal(
        paperReads,
        1,
        "the identical second read must reuse the turn-local evidence handle",
      );
      assert.equal(effectExecutions, 2);
      assert.isFalse(events.some((event) => event.type === "message_rollback"));
      assert.equal(modelSteps, 5, "the substantive final must not be retried");
      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, substantiveAnswer);
      assert.include(outcome.text, "zotero_script_execute — observed");
      assert.include(outcome.text, "command_execute — observed");
    } finally {
      restoreDb();
    }
  });

  it("rehydrates immediately preserved paper evidence without repeating retrieval", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      let paperReads = 0;
      const evidenceText =
        "The diagonal Fisher information estimates each parameter's importance.";
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => {
          paperReads += 1;
          return {
            mode: "targeted",
            results: [
              {
                paperContext: { itemId: 20, contextItemId: 21 },
                sourceKind: "paper_text",
                sourceFingerprint: "ewc-source",
                chunkIndex: 7,
                text: evidenceText,
                quoteCitationIds: ["quote-fisher"],
              },
            ],
            quoteCitations: [
              {
                id: "quote-fisher",
                quoteText: evidenceText,
                itemId: 20,
                contextItemId: 21,
                sourceFingerprint: "ewc-source",
              },
            ],
          };
        },
      });
      registry.register(createToolResultReadTool());

      let step = 0;
      let restoredContent: Record<string, unknown> | undefined;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params): Promise<AgentModelStep> {
            step += 1;
            if (step === 1) {
              const call = {
                id: "paper-source-call",
                name: "paper_read",
                arguments: { mode: "targeted", query: "Fisher importance" },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            if (step === 2) {
              assert.include(
                params.tools.map((tool) => tool.name),
                "tool_result_read",
              );
              const paperMessage = params.messages.find(
                (message) =>
                  message.role === "tool" && message.name === "paper_read",
              );
              assert.equal(paperMessage?.role, "tool");
              const delivered = JSON.parse(
                (paperMessage as { content: string }).content,
              ) as { toolResultHandle?: string };
              assert.match(delivered.toolResultHandle || "", /^trh_/);
              const call = {
                id: "rehydrate-paper-call",
                name: "tool_result_read",
                arguments: {
                  handle: delivered.toolResultHandle,
                  path: "results",
                  offset: 0,
                  limit: 1,
                },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            const restoredMessage = params.messages.find(
              (message) =>
                message.role === "tool" && message.name === "tool_result_read",
            );
            assert.equal(restoredMessage?.role, "tool");
            restoredContent = JSON.parse(
              (restoredMessage as { content: string }).content,
            );
            return {
              kind: "final",
              text: "The Fisher estimate identifies important parameters.",
              assistantMessage: {
                role: "assistant",
                content: "The Fisher estimate identifies important parameters.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 2449,
          mode: "agent",
          userText: "How does EWC estimate parameter importance?",
          model: "test-model",
          apiBase: "",
          apiKey: "test",
          libraryID: 1,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "targeted",
            wantedSections: [],
            writeDisposition: "none",
            actionIntents: [],
          },
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(paperReads, 1);
      assert.equal(restoredContent?.path, "results");
      assert.equal(restoredContent?.returnedCount, 1);
      assert.equal(
        (
          restoredContent?.items as Array<{
            text: string;
            quoteCitationIds: string[];
          }>
        )[0].text,
        evidenceText,
      );
      assert.deepEqual(
        (
          restoredContent?.items as Array<{
            text: string;
            quoteCitationIds: string[];
          }>
        )[0].quoteCitationIds,
        ["quote-fisher"],
      );
    } finally {
      restoreDb();
    }
  });

  it("publishes citations re-anchored to the sentences the answer makes", async function () {
    const restoreDb = installMockDb();
    try {
      const retrievedSentence =
        "Median animal accuracy was 84% on day 1 and 85% on day 10.";
      const claimSentence =
        "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
      const passage = `${retrievedSentence} ${claimSentence}`;
      const answer =
        "The fixed decoder declined from 80% to 62% accuracy by day 10 [[quote:q1]].";
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          mode: "targeted",
          results: [
            {
              paperContext: { itemId: 20, contextItemId: 21 },
              sourceKind: "paper_text",
              sourceFingerprint: "drift-source",
              chunkIndex: 4,
              text: passage,
              quoteCitationIds: ["q1"],
            },
          ],
          quoteCitations: [
            {
              id: "q1",
              quoteText: retrievedSentence,
              citationLabel: "(Orion et al., 2025)",
              sourceMatchText: retrievedSentence,
              sourceMatchKind: "exact",
              sourceMatchSource: "context-text",
              itemId: 20,
              contextItemId: 21,
              sourceFingerprint: "drift-source",
            },
          ],
        }),
      });

      let step = 0;
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            step += 1;
            if (step === 1) {
              const call = {
                id: "decoder-call",
                name: "paper_read",
                arguments: { mode: "targeted", query: "decoder accuracy" },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: answer,
              assistantMessage: { role: "assistant", content: answer },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 2451,
          mode: "agent",
          userText: "How much accuracy did the fixed decoder lose?",
          model: "test-model",
          apiBase: "",
          apiKey: "test",
          libraryID: 1,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "targeted",
            wantedSections: [],
            writeDisposition: "none",
            actionIntents: [],
          },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      const final = events.find((event) => event.type === "final");
      assert.isDefined(final, "the run publishes a final event");
      if (final?.type !== "final") return;
      assert.deepEqual(
        (final.quoteCitations || []).map((citation) => citation.id),
        ["q1"],
      );
      assert.equal(
        final.quoteCitations?.[0].quoteText,
        claimSentence,
        "the anchor moves to the passage sentence the answer's claim matches",
      );
      assert.equal(final.quoteCitations?.[0].anchorMatch, "claim");
      if (outcome.kind !== "completed") return;
      assert.deepEqual(outcome.quoteCitations, final.quoteCitations);
    } finally {
      restoreDb();
    }
  });

  it("still publishes the answer when claim re-anchoring throws", async function () {
    const restoreDb = installMockDb();
    try {
      const passage =
        "Median animal accuracy was 84% on day 1 and 85% on day 10. The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
      const answer =
        "The fixed decoder declined from 80% to 62% accuracy by day 10 [[quote:q1]].";
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          mode: "targeted",
          results: [
            {
              paperContext: { itemId: 20, contextItemId: 21 },
              sourceKind: "paper_text",
              text: passage,
              quoteCitationIds: ["q1"],
            },
          ],
          quoteCitations: [
            {
              id: "q1",
              quoteText:
                "Median animal accuracy was 84% on day 1 and 85% on day 10.",
              citationLabel: "(Orion et al., 2025)",
              itemId: 20,
              contextItemId: 21,
            },
          ],
        }),
      });

      let step = 0;
      let reanchorCalls = 0;
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        reanchorCitations: () => {
          reanchorCalls += 1;
          throw new Error("re-anchoring blew up");
        },
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            step += 1;
            if (step === 1) {
              const call = {
                id: "decoder-call",
                name: "paper_read",
                arguments: { mode: "targeted", query: "decoder accuracy" },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: answer,
              assistantMessage: { role: "assistant", content: answer },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 2452,
          mode: "agent",
          userText: "How much accuracy did the fixed decoder lose?",
          model: "test-model",
          apiBase: "",
          apiKey: "test",
          libraryID: 1,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "targeted",
            wantedSections: [],
            writeDisposition: "none",
            actionIntents: [],
          },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(reanchorCalls, 1, "the failing re-anchoring was reached");
      assert.equal(outcome.kind, "completed");
      const final = events.find((event) => event.type === "final");
      assert.isDefined(final, "the finished answer is still published");
      if (final?.type !== "final") return;
      assert.equal(final.text, answer);
      assert.isUndefined(final.quoteCitations);
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, answer);
      assert.isUndefined(outcome.quoteCitations);
    } finally {
      restoreDb();
    }
  });

  it("does not force file writes after a standalone Zotero note request is satisfied", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      (
        globalThis as typeof globalThis & {
          Zotero: {
            Prefs: {
              set: (key: string, value: unknown, global?: boolean) => void;
            };
          };
        }
      ).Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.obsidianVaultPath",
        "/tmp/obsidian-vault",
        true,
      );
      (
        globalThis as typeof globalThis & {
          Zotero: {
            Prefs: {
              set: (key: string, value: unknown, global?: boolean) => void;
            };
          };
        }
      ).Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.notesDirectoryNickname",
        "Obsidian",
        true,
      );

      let noteExists = false;
      const registry = new AgentToolRegistry(
        new ActionContractService({
          getCollectionSummary: () => null,
          listCollectionSummaries: () => [],
          listCollectionPaperTargets: async () => ({ papers: [] }),
          listCollectionItemTargets: async () => ({ items: [] }),
          getItem: (itemId) =>
            itemId === 500 && noteExists
              ? ({
                  id: 500,
                  parentID: false,
                  deleted: false,
                  isNote: () => true,
                  getNote: () => "<h2>Summary</h2><p>Zotero note body.</p>",
                  getCollections: () => [],
                } as unknown as Zotero.Item)
              : null,
          getEditableArticleMetadata: () => null,
        }),
      );
      const noteWrites: unknown[] = [];
      registry.register({
        effectOperations: ["note_create"],
        spec: {
          name: "note_write",
          description: "write note",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({
          ok: true,
          value: {
            operation: {
              type: "save_note" as const,
              content: String((args as { content?: unknown }).content || ""),
              target: "standalone" as const,
            },
          },
        }),
        describeAction: (input) => [
          {
            id: "note_create:standalone",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: {
              noteMode: "create",
              expectedText: stripNoteHtml(
                renderMarkdownForNote(input.operation.content),
              ),
            },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test note write.",
          }),
        execute: async (input) => {
          noteWrites.push(input.operation);
          noteExists = true;
          return {
            content: {
              result: {
                operation: "save_note",
                result: { status: "saved", noteId: 500, collections: [] },
              },
            },
            effect: "applied",
          };
        },
      });

      let stepIndex = 0;
      let sawInitialZoteroRule = false;
      let sawInitialFileRule = false;
      let sawCorrectivePrompt = false;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            const allText = params.messages
              .map((message) =>
                typeof message.content === "string" ? message.content : "",
              )
              .join("\n");
            if (stepIndex === 1) {
              sawInitialZoteroRule = allText.includes(
                "Semantic intent specifies a Zotero note",
              );
              sawInitialFileRule = allText.includes(
                "Semantic intent specifies a file export",
              );
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-note",
                    name: "note_write",
                    arguments: {
                      mode: "create",
                      target: "standalone",
                      content: "## Summary\nZotero note body.",
                    },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-note",
                      name: "note_write",
                      arguments: {
                        mode: "create",
                        target: "standalone",
                        content: "## Summary\nZotero note body.",
                      },
                    },
                  ],
                },
              };
            }
            sawCorrectivePrompt ||= allText.includes(
              "requires writing a Markdown note",
            );
            return {
              kind: "final",
              text: "Saved Zotero note.",
              assistantMessage: {
                role: "assistant",
                content: "Saved Zotero note.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("note_create", undefined, {
            noteDestination: "zotero",
          }),
          conversationKey: 1,
          mode: "agent",
          libraryID: 1,
          userText:
            "help me summarize this paper and save a standalone note into my zotero library",
          forcedSkillIds: ["write-note"],
          model: "gpt-5.5",
          apiBase: "",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "Saved Zotero note.");
      assert.include(outcome.text, "note_create — applied");
      assert.isFalse(sawInitialZoteroRule);
      assert.isFalse(sawInitialFileRule);
      assert.isFalse(sawCorrectivePrompt);
      assert.equal(stepIndex, 2);
      assert.deepEqual(noteWrites, [
        {
          type: "save_note",
          target: "standalone",
          content: "## Summary\nZotero note body.",
        },
      ]);
    } finally {
      restoreDb();
    }
  });

  it("writes file notes at the exact path the agent chose, creating subfolders", async function () {
    const restoreDb = installMockDb();
    const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;
    const createdDirs: string[] = [];
    const writes: Array<{ path: string; text: string }> = [];
    const writtenBytes = new Map<string, Uint8Array>();
    try {
      await initAgentChangeJournal();
      (
        globalThis as typeof globalThis & {
          Zotero: {
            Prefs: {
              set: (key: string, value: unknown, global?: boolean) => void;
            };
          };
        }
      ).Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.obsidianVaultPath",
        "/tmp/obsidian-vault",
        true,
      );
      (
        globalThis as typeof globalThis & {
          Zotero: {
            Prefs: {
              set: (key: string, value: unknown, global?: boolean) => void;
            };
          };
        }
      ).Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.obsidianTargetFolder",
        "Zotero Notes",
        true,
      );
      (
        globalThis as typeof globalThis & {
          Zotero: {
            Prefs: {
              set: (key: string, value: unknown, global?: boolean) => void;
            };
          };
        }
      ).Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.notesDirectoryNickname",
        "Obsidian",
        true,
      );
      (globalThis as { IOUtils?: unknown }).IOUtils = {
        exists: async () => false,
        makeDirectory: async (path: string) => {
          createdDirs.push(path);
        },
        write: async (path: string, data: Uint8Array) => {
          writes.push({
            path,
            text: new TextDecoder("utf-8").decode(data),
          });
          writtenBytes.set(path, data);
        },
        read: async (path: string) =>
          writtenBytes.get(path) || new Uint8Array(),
      };

      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register(createFileIOTool());
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-write",
                    name: "file_io",
                    arguments: {
                      action: "write",
                      filePath:
                        "/tmp/obsidian-vault/Stable Coding/Stable Coding.md",
                      content: "## Figure 2\nGrounded note.",
                    },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-write",
                      name: "file_io",
                      arguments: {
                        action: "write",
                        filePath:
                          "/tmp/obsidian-vault/Stable Coding/Stable Coding.md",
                        content: "## Figure 2\nGrounded note.",
                      },
                    },
                  ],
                },
              },
              {
                kind: "final",
                text: "Saved.",
                assistantMessage: {
                  role: "assistant",
                  content: "Saved.",
                },
              },
            ],
            {
              streaming: true,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("file_write", undefined, {
            noteDestination: "file",
          }),
          conversationKey: 1,
          mode: "agent",
          userText: "write this figure note to my Obsidian",
          forcedSkillIds: ["write-note"],
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.deepEqual(writes, [
        {
          path: "/tmp/obsidian-vault/Stable Coding/Stable Coding.md",
          text: "## Figure 2\nGrounded note.",
        },
      ]);
      assert.include(createdDirs, "/tmp/obsidian-vault/Stable Coding");
    } finally {
      (globalThis as { IOUtils?: unknown }).IOUtils = originalIOUtils;
      restoreDb();
    }
  });

  it("emits reasoning events for each model round", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_context",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          ok: true,
        }),
      });

      let stepIndex = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex === 1) {
              await params.onReasoning?.({
                details: "Inspecting the request.",
              });
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-1",
                    name: "read_context",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      name: "read_context",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            await params.onReasoning?.({ details: "Writing the answer." });
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: {
                role: "assistant",
                content: "Done.",
              },
            };
          },
        }),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "summarize the paper",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Done.");
      assert.deepEqual(
        events
          .filter((event) => event.type === "reasoning")
          .map((event) =>
            event.type === "reasoning"
              ? { round: event.round, details: event.details }
              : null,
          ),
        [
          { round: 1, details: "Inspecting the request." },
          { round: 2, details: "Writing the answer." },
        ],
      );
      const persisted = readPersistedTranscript(restoreDb, 1);
      assert.notInclude(JSON.stringify(persisted), "Inspecting the request.");
      assert.notInclude(JSON.stringify(persisted), "Writing the answer.");
      const finalEvent = events.findLast((event) => event.type === "final");
      assert.notInclude(JSON.stringify(finalEvent), "Writing the answer.");
    } finally {
      restoreDb();
    }
  });

  it("emits usage events without accumulating them inside the runtime", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onUsage?.({
              promptTokens: 10,
              completionTokens: 4,
              totalTokens: 14,
            });
            await params.onUsage?.({
              promptTokens: 0,
              completionTokens: 2,
              totalTokens: 2,
            });
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: {
                role: "assistant",
                content: "Done.",
              },
            };
          },
        }),
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "count tokens",
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1/responses",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(outcome.kind, "completed");
      const contextUsageEvents = events.filter(
        (event) =>
          event.type === "usage" &&
          event.totalTokens === 0 &&
          typeof event.contextTokens === "number" &&
          event.contextTokens > 0,
      );
      assert.lengthOf(contextUsageEvents, 1);
      if (contextUsageEvents[0]?.type === "usage") {
        assert.equal(contextUsageEvents[0].contextWindow, 1050000);
      }
      assert.deepEqual(
        events
          .filter((event) => event.type === "usage" && event.totalTokens > 0)
          .map((event) =>
            event.type === "usage"
              ? {
                  round: event.round,
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  totalTokens: event.totalTokens,
                }
              : null,
          ),
        [
          {
            round: 1,
            promptTokens: 10,
            completionTokens: 4,
            totalTokens: 14,
          },
          {
            round: 1,
            promptTokens: 0,
            completionTokens: 2,
            totalTokens: 2,
          },
        ],
      );
    } finally {
      restoreDb();
    }
  });

  it("keeps the explicit agent context denominator after provider usage", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            await params.onUsage?.({
              promptTokens: 10,
              completionTokens: 4,
              totalTokens: 14,
              contextTokens: 10,
              contextWindow: 128_000,
              contextWindowIsAuthoritative: true,
            });
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: { role: "assistant", content: "Done." },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];

      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "count tokens",
          model: "qwen3.8-max",
          apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "test",
          advanced: { inputTokenCap: 1_000_000 },
        },
        onEvent: async (event) => events.push(event),
      });

      const providerUsage = events.find(
        (event) => event.type === "usage" && event.totalTokens === 14,
      );
      assert.equal(providerUsage?.type, "usage");
      if (providerUsage?.type === "usage") {
        assert.equal(providerUsage.contextWindow, 1_000_000);
        assert.isNotTrue(providerUsage.contextWindowIsAuthoritative);
      }
    } finally {
      restoreDb();
    }
  });

  it("emits current context events and renders context on repeated turns", async function () {
    const restoreDb = installMockDb();
    try {
      const request: AgentRuntimeRequest = {
        classifiedIntent: classifiedFixture(),
        conversationKey: 501,
        mode: "agent",
        userText: "summarize this paper",
        activeItemId: 1,
        libraryID: 1,
        selectedPaperContexts: [
          {
            itemId: 1,
            contextItemId: 10,
            title: "Lifecycle Paper",
          },
        ],
        model: "gpt-5.4",
      };

      const firstRuntime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "final",
                text: "First answer.",
                assistantMessage: {
                  role: "assistant",
                  content: "First answer.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      const firstEvents: AgentEvent[] = [];
      await firstRuntime.runTurn({
        request,
        onEvent: (event) => {
          firstEvents.push(event);
        },
      });
      const firstContextEvent = firstEvents.find(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_context_envelope",
      );
      assert.deepInclude(
        firstContextEvent?.type === "provider_event"
          ? firstContextEvent.payload
          : {},
        {
          selectedPaperCount: 1,
          fullTextPaperCount: 0,
        },
      );

      let secondInitialUserMessage = "";
      const secondRuntime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            const userMessage = params.messages.findLast(
              (message) => message.role === "user",
            );
            secondInitialUserMessage =
              typeof userMessage?.content === "string"
                ? userMessage.content
                : "";
            return {
              kind: "final",
              text: "Second answer.",
              assistantMessage: {
                role: "assistant",
                content: "Second answer.",
              },
            };
          },
        }),
      });
      const secondEvents: AgentEvent[] = [];
      await secondRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "what about the methods?",
        },
        onEvent: (event) => {
          secondEvents.push(event);
        },
      });
      const secondContextEvent = secondEvents.find(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_context_envelope",
      );
      assert.deepInclude(
        secondContextEvent?.type === "provider_event"
          ? secondContextEvent.payload
          : {},
        {
          selectedPaperCount: 1,
          fullTextPaperCount: 0,
        },
      );
      assert.include(secondInitialUserMessage, "Zotero context for this turn:");
      assert.include(secondInitialUserMessage, "Paper 1:");
      assert.include(secondInitialUserMessage, 'title="Lifecycle Paper"');

      const failingRuntime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [],
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      const failedEvents: AgentEvent[] = [];
      await failingRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          conversationKey: 777,
          userText: "this will fail",
        },
        onEvent: (event) => {
          failedEvents.push(event);
        },
      });
      const retryRuntime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "final",
                text: "Retry answer.",
                assistantMessage: {
                  role: "assistant",
                  content: "Retry answer.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      const retryEvents: AgentEvent[] = [];
      await retryRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          conversationKey: 777,
          userText: "retry",
        },
        onEvent: (event) => {
          retryEvents.push(event);
        },
      });
      const retryContextEvent = retryEvents.find(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_context_envelope",
      );
      assert.deepInclude(
        retryContextEvent?.type === "provider_event"
          ? retryContextEvent.payload
          : {},
        {
          selectedPaperCount: 1,
          fullTextPaperCount: 0,
        },
      );
    } finally {
      restoreDb();
    }
  });

  it("records successful paper_read calls as prior-read hints for later turns", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "paper_read",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        presentation: {
          label: "Read Paper",
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        execute: async () => ({
          mode: "targeted",
          papers: [
            {
              paperContext: request.selectedPaperContexts?.[0],
              sourceKind: "paper_text",
              passages: [
                {
                  text: "paper text",
                  sourceLabel: "(Ledger, 2024)",
                },
              ],
            },
          ],
          results: [],
        }),
      });

      const request: AgentRuntimeRequest = {
        classifiedIntent: classifiedFixture(),
        conversationKey: 601,
        mode: "agent",
        userText: "read the abstract",
        activeItemId: 1,
        libraryID: 1,
        selectedPaperContexts: [
          {
            itemId: 1,
            contextItemId: 10,
            title: "Ledger Paper",
          },
        ],
        model: "gpt-5.4",
      };

      const firstRuntime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-read",
                    name: "paper_read",
                    arguments: {
                      mode: "targeted",
                      target: {
                        paperContext: request.selectedPaperContexts?.[0],
                      },
                      query: "abstract",
                    },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-read",
                      name: "paper_read",
                      arguments: {
                        mode: "targeted",
                        target: {
                          paperContext: request.selectedPaperContexts?.[0],
                        },
                        query: "abstract",
                      },
                    },
                  ],
                },
              },
              {
                kind: "final",
                text: "Read it.",
                assistantMessage: {
                  role: "assistant",
                  content: "Read it.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      await firstRuntime.runTurn({ request });

      let secondInitialUserMessage = "";
      const secondRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            const userMessage = params.messages.findLast(
              (message) => message.role === "user",
            );
            secondInitialUserMessage =
              typeof userMessage?.content === "string"
                ? userMessage.content
                : "";
            return {
              kind: "final",
              text: "Follow-up.",
              assistantMessage: {
                role: "assistant",
                content: "Follow-up.",
              },
            };
          },
        }),
      });
      await secondRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "use what you read",
        },
      });

      assert.include(
        secondInitialUserMessage,
        "Preserved evidence from prior agent tool reads:",
      );
      assert.include(secondInitialUserMessage, "Read Paper");
      assert.include(secondInitialUserMessage, "Ledger Paper");
      assert.include(secondInitialUserMessage, "mode=targeted");
      assert.include(secondInitialUserMessage, 'query="abstract"');
      assert.include(secondInitialUserMessage, "paper text");
    } finally {
      restoreDb();
    }
  });

  it("persists the user goal and each complete tool pair before the next model request", async function () {
    const installed = installMockDb();
    try {
      const conversationKey = 701;
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "checkpoint_read",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ value: "durable result" }),
      });
      let step = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            step += 1;
            const persisted = readPersistedTranscript(
              installed,
              conversationKey,
            );
            if (step === 1) {
              assert.include(
                JSON.stringify(persisted),
                "persist this before inference",
              );
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "checkpoint-call",
                    name: "checkpoint_read",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "checkpoint-call",
                      name: "checkpoint_read",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            const serialized = JSON.stringify(persisted);
            assert.include(serialized, "checkpoint-call");
            assert.include(serialized, "Historical tool result");
            assert.include(serialized, "durable result");
            const handle = serialized.match(/handle=(trh_[a-z0-9]+)/i)?.[1];
            assert.match(handle || "", /^trh_/);
            const storedResult = await getAgentToolResultHandle({
              conversationKey,
              handle: handle || "",
            });
            assert.include(
              JSON.stringify(storedResult?.content),
              "durable result",
            );
            throw new Error("simulated process interruption");
          },
        }),
      });

      let thrown: unknown;
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey,
            mode: "agent",
            userText: "persist this before inference",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
          },
        });
      } catch (error) {
        thrown = error;
      }

      assert.instanceOf(thrown, Error);
      assert.equal((thrown as Error).message, "simulated process interruption");
    } finally {
      installed();
    }
  });

  it("does not serialize a confirmation while it is still awaiting approval", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      globalThis.Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.originalAgentPermissionMode",
        "safe",
      );
      const conversationKey = 704;
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["command_execute"],
        spec: {
          name: "confirmation_write",
          description: "write",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:pending-confirmation"),
        planInvocation: () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test confirmed write.",
          }),
        createPendingAction: () => ({
          toolName: "confirmation_write",
          title: "Confirm write",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        }),
        execute: async () => ({
          content: { status: "saved" },
          effect: "applied",
        }),
      });
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [
                  {
                    id: "pending-confirmation-call",
                    name: "confirmation_write",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "pending-confirmation-call",
                      name: "confirmation_write",
                      arguments: {},
                    },
                  ],
                },
              },
              {
                kind: "final",
                text: "The write was cancelled.",
                assistantMessage: {
                  role: "assistant",
                  content: "The write was cancelled.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      let resolveConfirmationId: ((requestId: string) => void) | undefined;
      const confirmationId = new Promise<string>((resolve) => {
        resolveConfirmationId = resolve;
      });
      const run = runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("command_execute"),
          conversationKey,
          mode: "agent",
          libraryID: 1,
          userText: "run command after asking for confirmation",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: (event) => {
          if (event.type === "confirmation_required") {
            resolveConfirmationId?.(event.requestId);
          }
        },
      });

      const requestId = await confirmationId;
      const pendingTranscript = JSON.stringify(
        readPersistedTranscript(installed, conversationKey),
      );
      assert.include(
        pendingTranscript,
        "run command after asking for confirmation",
      );
      assert.notInclude(pendingTranscript, "pending-confirmation-call");
      assert.isTrue(runtime.resolveConfirmation(requestId, false));
      await run;
    } finally {
      installed();
    }
  });

  it("reuses the local append-only transcript across agent turns", async function () {
    const restoreDb = installMockDb();
    try {
      const request: AgentRuntimeRequest = {
        classifiedIntent: classifiedFixture(),
        conversationKey: 7,
        mode: "agent",
        userText: "remember alpha",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/chat/completions",
        apiKey: "test",
      };
      const registry = new AgentToolRegistry();
      registry.register(createToolResultReadTool());
      const firstRuntime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "final",
                text: "Alpha is preserved.",
                assistantMessage: {
                  role: "assistant",
                  content: "Alpha is preserved.",
                },
              },
            ],
            {
              streaming: false,
              toolCalls: true,
              multimodal: false,
              fileInputs: false,
              reasoning: true,
            },
          ),
      });
      await firstRuntime.runTurn({ request });

      const handleRecord = createAgentToolResultHandleRecord({
        conversationKey: request.conversationKey,
        toolName: "library_search",
        toolCallId: "stored-call",
        content: { results: [{ itemId: 1, title: "Stored row" }] },
      });
      assert.exists(handleRecord);
      await upsertAgentToolResultHandles([handleRecord!]);

      let secondMessages: AgentModelMessage[] = [];
      let secondToolNames: string[] = [];
      const secondRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            secondMessages = params.messages;
            secondToolNames = params.tools.map((tool) => tool.name);
            return {
              kind: "final",
              text: "Used it.",
              assistantMessage: {
                role: "assistant",
                content: "Used it.",
              },
            };
          },
        }),
      });
      await secondRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "what did I ask you to remember?",
        },
      });

      const serialized = JSON.stringify(secondMessages);
      const priorSemanticCheckpoints = secondMessages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Agent semantic continuation checkpoint"),
      );
      assert.lengthOf(priorSemanticCheckpoints, 0);
      assert.isTrue(
        secondMessages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === "Alpha is preserved.",
        ),
      );
      assert.include(serialized, "remember alpha");
      assert.include(serialized, "Alpha is preserved.");
      assert.include(secondToolNames, "tool_result_read");
    } finally {
      restoreDb();
    }
  });

  it("continues an interrupted same-key run from durable pairs and journal facts without replaying writes", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      const conversationKey = 702;
      const actionId = "recovery-action";
      let writes = 0;
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["command_execute"],
        spec: {
          name: "recovery_write",
          description: "write",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:recovery-write"),
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["local_execution"],
            reversibility: "full",
            reason: "Test recovery write.",
          }),
        execute: async (_input, context) => {
          writes += 1;
          assert.isString(context.runId);
          await prepareJournalAction({
            actionId,
            runId: context.runId!,
            conversationKey,
            toolName: "recovery_write",
            description: "commit one recovery test write",
            effect: "write",
            reversibility: "full",
          });
          await updateJournalAction({
            actionId,
            status: "applied",
            affectedCount: 2,
          });
          return {
            content: { status: "saved" },
            effect: "applied",
          };
        },
      });
      let firstStep = 0;
      const firstRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            firstStep += 1;
            if (firstStep === 1) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "recovery-call",
                    name: "recovery_write",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "recovery-call",
                      name: "recovery_write",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            throw new Error("simulated restart");
          },
        }),
      });

      try {
        await firstRuntime.runTurn({
          request: {
            classifiedIntent: actionFixture("command_execute", undefined, {
              continuation: "resume",
            }),
            conversationKey,
            mode: "agent",
            userText: "run the recovery command once",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
          },
        });
        assert.fail("expected the first run to be interrupted");
      } catch (error) {
        assert.equal((error as Error).message, "simulated restart");
      }

      const priorRun = [...installed.runs.values()][0];
      assert.equal(
        installed.journalDb.actions.get(actionId)?.run_id,
        priorRun.runId,
      );
      await initAgentTraceStore();
      assert.equal(priorRun.status, "failed");
      assert.equal(priorRun.finalText, INTERRUPTED_AGENT_RUN_MARKER);
      clearAgentTranscriptStore();

      let continuedMessages: AgentModelMessage[] = [];
      const continuedRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params): Promise<AgentModelStep> {
            continuedMessages = params.messages;
            return {
              kind: "final",
              text: "Recovered without replaying the write.",
              assistantMessage: {
                role: "assistant",
                content: "Recovered without replaying the write.",
              },
            };
          },
        }),
      });
      await continuedRuntime.runTurn({
        request: {
          classifiedIntent: actionFixture("command_execute", undefined, {
            continuation: "resume",
          }),
          conversationKey,
          mode: "agent",
          userText: "continue",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
      });

      const serialized = JSON.stringify(continuedMessages);
      assert.include(serialized, "recovery-call");
      assert.include(serialized, `actionId=${actionId}`);
      assert.include(serialized, "status=applied");
      assert.include(serialized, "affectedCount=2");
      assert.include(serialized, "reversibility=full");
      assert.equal(writes, 1, "the committed write must not be replayed");
    } finally {
      installed();
    }
  });

  it("uses only a bounded goal and journal summary when an interrupted run's compatibility key changed", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      const conversationKey = 703;
      const actionId = "changed-key-action";
      let writes = 0;
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["command_execute"],
        spec: {
          name: "changed_key_write",
          description: "write",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:changed-key"),
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["local_execution"],
            reversibility: "full",
            reason: "Test changed-key write.",
          }),
        execute: async (_input, context) => {
          writes += 1;
          await prepareJournalAction({
            actionId,
            runId: context.runId!,
            conversationKey,
            toolName: "changed_key_write",
            description: "commit before transcript append",
            effect: "write",
            reversibility: "partial",
          });
          await updateJournalAction({
            actionId,
            status: "partially_applied",
            affectedCount: 1,
          });
          return {
            content: { status: "partially_saved" },
            effect: "partial",
          };
        },
      });
      let step = 0;
      const interruptedRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            step += 1;
            if (step === 1) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "changed-key-call",
                    name: "changed_key_write",
                    arguments: {},
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "changed-key-call",
                      name: "changed_key_write",
                      arguments: {},
                    },
                  ],
                },
              };
            }
            throw new Error("simulated restart before final response");
          },
        }),
      });

      try {
        await interruptedRuntime.runTurn({
          request: {
            classifiedIntent: actionFixture("command_execute", undefined, {
              continuation: "resume",
            }),
            conversationKey,
            mode: "agent",
            userText: "run the recovery command to preserve this original goal",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
          },
        });
        assert.fail("expected interruption");
      } catch (error) {
        assert.equal(
          (error as Error).message,
          "simulated restart before final response",
        );
      }

      // Fault injection: retain the pre-inference user checkpoint but remove
      // the pair, matching a crash after the journal commit and before the
      // transcript append reached durable storage.
      for (
        let index = installed.transcripts.length - 1;
        index >= 0;
        index -= 1
      ) {
        const message = JSON.parse(
          String(installed.transcripts[index].messageJson),
        ) as AgentModelMessage;
        if (message.role !== "user" || message.retainedTool)
          installed.transcripts.splice(index, 1);
      }
      await initAgentTraceStore();
      clearAgentTranscriptStore();

      let continuedMessages: AgentModelMessage[] = [];
      const continuedRuntime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params): Promise<AgentModelStep> {
            continuedMessages = params.messages;
            return {
              kind: "final",
              text: "Recovered from the summary only.",
              assistantMessage: {
                role: "assistant",
                content: "Recovered from the summary only.",
              },
            };
          },
        }),
      });
      await continuedRuntime.runTurn({
        request: {
          classifiedIntent: actionFixture("command_execute", undefined, {
            continuation: "resume",
          }),
          conversationKey,
          mode: "agent",
          userText: "continue after the model change",
          model: "gpt-4.1-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
      });

      const serialized = JSON.stringify(continuedMessages);
      assert.include(
        serialized,
        "run the recovery command to preserve this original goal",
      );
      assert.include(serialized, `actionId=${actionId}`);
      assert.include(serialized, "status=partially_applied");
      assert.include(serialized, "affectedCount=1");
      assert.include(serialized, "reversibility=partial");
      assert.notInclude(serialized, "changed-key-call");
      assert.notInclude(serialized, "partially_saved");
      assert.equal(writes, 1, "recovery must not replay the prior write");
    } finally {
      installed();
    }
  });

  it("compacts the prompt on request without erasing durable conversation content", async function () {
    const restoreDb = installMockDb();
    try {
      const request: AgentRuntimeRequest = {
        classifiedIntent: classifiedFixture(),
        conversationKey: 8,
        mode: "agent",
        userText: "seed",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/chat/completions",
        apiKey: "test",
        advanced: { inputTokenCap: 32000 },
      };
      const longAnswer = `Important older answer. ${"detail ".repeat(1200)}`;
      const seedRegistry = new AgentToolRegistry();
      seedRegistry.register({
        spec: {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          totalCount: 2,
          returnedCount: 2,
          results: [
            { itemId: 1, title: "Compacted handle paper A" },
            { itemId: 2, title: "Compacted handle paper B" },
          ],
        }),
      });
      let seedStep = 0;
      const seedRuntime = new AgentRuntime({
        registry: seedRegistry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            seedStep += 1;
            if (seedStep === 1) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "seed-tool-call",
                    name: "query_library",
                    arguments: { entity: "items", mode: "list" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "seed-tool-call",
                      name: "query_library",
                      arguments: { entity: "items", mode: "list" },
                    },
                  ],
                },
              };
            }
            return {
              kind: "final",
              text: "Seeded tool result.",
              assistantMessage: {
                role: "assistant",
                content: "Seeded tool result.",
              },
            };
          },
        }),
      });
      await seedRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "seed tool result",
        },
      });
      for (let index = 0; index < 3; index += 1) {
        const runtime = new AgentRuntime({
          registry: seedRegistry,
          adapterFactory: () =>
            new MockAdapter(
              [
                {
                  kind: "final",
                  text: `${longAnswer} ${index}`,
                  assistantMessage: {
                    role: "assistant",
                    content: `${longAnswer} ${index}`,
                  },
                },
              ],
              {
                streaming: false,
                toolCalls: true,
                multimodal: false,
                fileInputs: false,
                reasoning: true,
              },
            ),
        });
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            ...request,
            userText: `seed ${index}`,
          },
        });
      }

      const compactEvents: AgentEvent[] = [];
      const compactRuntime = new AgentRuntime({
        registry: seedRegistry,
        adapterFactory: () =>
          new MockAdapter([], {
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
      });
      const compactOutcome = await compactRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "/compact",
        },
        onEvent: (event) => compactEvents.push(event),
      });

      assert.equal(compactOutcome.kind, "completed");
      if (compactOutcome.kind !== "completed") return;
      assert.equal(compactOutcome.text, "Conversation compacted");
      assert.isTrue(
        compactEvents.some(
          (event) =>
            event.type === "context_compacted" && event.automatic === false,
        ),
      );

      let followupMessages: AgentModelMessage[] = [];
      const followupRuntime = new AgentRuntime({
        registry: seedRegistry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            followupMessages = params.messages;
            return {
              kind: "final",
              text: "After compact.",
              assistantMessage: {
                role: "assistant",
                content: "After compact.",
              },
            };
          },
        }),
      });
      await followupRuntime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          ...request,
          userText: "continue",
        },
      });

      assert.include(
        JSON.stringify(followupMessages),
        "Agent transcript compact checkpoint",
      );
      assert.match(JSON.stringify(followupMessages), /trh_[a-z0-9]+/i);
    } finally {
      restoreDb();
    }
  });

  it("passes large library tool results through when the full prompt fits", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      const fullResult = {
        entity: "items",
        mode: "list",
        totalCount: 120,
        returnedCount: 120,
        limited: false,
        results: Array.from({ length: 120 }, (_, index) => ({
          itemId: index + 1,
          itemType: "journalArticle",
          title: `Large library result ${index}`,
          firstCreator: `Author ${index}`,
          year: "2026",
          abstract: "A".repeat(700),
          attachments: [
            { title: "PDF", path: `/tmp/${index}.pdf` },
            { title: "Supplement", path: `/tmp/${index}-supp.pdf` },
          ],
        })),
      };
      registry.register({
        spec: {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => fullResult,
      });
      registry.register(createToolResultReadTool());

      let synthesisMessages: AgentModelMessage[] = [];
      const toolNamesByStep: string[][] = [];
      const adapter: AgentModelAdapter = {
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: true,
        }),
        supportsTools: () => true,
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          toolNamesByStep.push(params.tools.map((tool) => tool.name));
          if (!synthesisMessages.length) {
            synthesisMessages = params.messages;
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call-library",
                  name: "query_library",
                  arguments: { entity: "items", mode: "list" },
                },
              ],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-library",
                    name: "query_library",
                    arguments: { entity: "items", mode: "list" },
                  },
                ],
              },
            };
          }
          synthesisMessages = params.messages;
          return {
            kind: "final",
            text: "Compacted result used.",
            assistantMessage: {
              role: "assistant",
              content: "Compacted result used.",
            },
          };
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 11,
          mode: "agent",
          userText: "list my library",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 200_000 },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      const fullToolEvent = events.find(
        (event) => event.type === "tool_result",
      );
      assert.lengthOf(
        (
          (fullToolEvent?.type === "tool_result"
            ? fullToolEvent.content
            : {}) as typeof fullResult
        ).results || [],
        120,
      );
      const toolMessage = synthesisMessages.find(
        (message) => message.role === "tool",
      );
      assert.equal(toolMessage?.role, "tool");
      const modelFacing = JSON.parse(
        (toolMessage as { content: string }).content,
      );
      assert.notProperty(modelFacing, "modelContextCompacted");
      assert.lengthOf(modelFacing.results, 120);
      assert.include(JSON.stringify(modelFacing), "A".repeat(200));
      assert.isAtLeast(toolNamesByStep.length, 2);
      assert.notInclude(toolNamesByStep[0], "tool_result_read");
      assert.notInclude(toolNamesByStep[1], "tool_result_read");
    } finally {
      restoreDb();
    }
  });

  it("reduces large library tool results only under provider-send pressure", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      const fullResult = {
        entity: "items",
        mode: "list",
        filters: { collectionId: 42 },
        totalCount: 160,
        returnedCount: 160,
        limited: false,
        results: Array.from({ length: 160 }, (_, index) => ({
          itemId: index + 1,
          itemType: "journalArticle",
          title: `Large library result ${index}`,
          firstCreator: `Author ${index}`,
          year: "2026",
          abstract: "A".repeat(700),
          tags: [`tag-${index % 4}`],
          collectionIds: [42],
          attachments: [
            { title: "PDF", path: `/tmp/${index}.pdf` },
            { title: "Supplement", path: `/tmp/${index}-supp.pdf` },
          ],
        })),
      };
      registry.register({
        spec: {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => fullResult,
      });
      registry.register(createToolResultReadTool());

      let synthesisMessages: AgentModelMessage[] = [];
      const toolNamesByStep: string[][] = [];
      const adapter: AgentModelAdapter = {
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: true,
        }),
        supportsTools: () => true,
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          toolNamesByStep.push(params.tools.map((tool) => tool.name));
          if (!synthesisMessages.length) {
            synthesisMessages = params.messages;
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call-library",
                  name: "query_library",
                  arguments: { entity: "items", mode: "list" },
                },
              ],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-library",
                    name: "query_library",
                    arguments: { entity: "items", mode: "list" },
                  },
                ],
              },
            };
          }
          synthesisMessages = params.messages;
          return {
            kind: "final",
            text: "Reduced result used.",
            assistantMessage: {
              role: "assistant",
              content: "Reduced result used.",
            },
          };
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 13,
          mode: "agent",
          userText: "list my library",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 8_000 },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      const fullToolEvent = events.find(
        (event) => event.type === "tool_result",
      );
      assert.lengthOf(
        (
          (fullToolEvent?.type === "tool_result"
            ? fullToolEvent.content
            : {}) as typeof fullResult
        ).results || [],
        160,
      );
      const budgetEvent = events.find(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_context_budget",
      );
      assert.exists(budgetEvent);
      assert.equal(
        budgetEvent?.type === "provider_event"
          ? budgetEvent.payload?.handleCount
          : undefined,
        1,
      );
      const checkpoint = synthesisMessages.find(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Agent semantic continuation checkpoint"),
      );
      assert.equal(checkpoint?.role, "user");
      const checkpointText = String(checkpoint?.content || "");
      assert.include(checkpointText, "query_library");
      assert.match(checkpointText, /handle=trh_[a-z0-9]+/i);
      assert.isAtLeast(toolNamesByStep.length, 2);
      assert.notInclude(toolNamesByStep[0], "tool_result_read");
      assert.include(toolNamesByStep[1], "tool_result_read");
      assert.notInclude(checkpointText, "A".repeat(200));
    } finally {
      restoreDb();
    }
  });

  it("lets the model read a compacted tool-result handle in a later step", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      const fullResult = {
        entity: "items",
        mode: "list",
        totalCount: 160,
        returnedCount: 160,
        limited: false,
        results: Array.from({ length: 160 }, (_, index) => ({
          itemId: index + 1,
          itemType: "journalArticle",
          title: `Stored row ${index}`,
          firstCreator: `Author ${index}`,
          year: "2026",
          abstract: "A".repeat(500),
        })),
      };
      registry.register({
        spec: {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => fullResult,
      });
      registry.register(createToolResultReadTool());

      let stepIndex = 0;
      let storedHandle = "";
      let readToolMessage: AgentModelMessage | undefined;
      let readToolStepMessages: Array<{
        role: string;
        name?: string;
        toolCallId?: string;
        contentStart?: string;
      }> = [];
      const toolNamesByStep: string[][] = [];
      const adapter: AgentModelAdapter = {
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: true,
        }),
        supportsTools: () => true,
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          stepIndex += 1;
          toolNamesByStep.push(params.tools.map((tool) => tool.name));
          if (stepIndex === 1) {
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call-library",
                  name: "query_library",
                  arguments: { entity: "items", mode: "list" },
                },
              ],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-library",
                    name: "query_library",
                    arguments: { entity: "items", mode: "list" },
                  },
                ],
              },
            };
          }
          if (stepIndex === 2) {
            const checkpoint = params.messages.find(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes(
                  "Agent semantic continuation checkpoint",
                ),
            );
            assert.equal(checkpoint?.role, "user");
            const match = String(checkpoint?.content || "").match(
              /handle=(trh_[a-z0-9]+)/i,
            );
            storedHandle = match?.[1] || "";
            assert.match(storedHandle, /^trh_/);
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call-read",
                  name: "tool_result_read",
                  arguments: {
                    handle: storedHandle,
                    path: "results",
                    offset: 50,
                    limit: 2,
                  },
                },
              ],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-read",
                    name: "tool_result_read",
                    arguments: {
                      handle: storedHandle,
                      path: "results",
                      offset: 50,
                      limit: 2,
                    },
                  },
                ],
              },
            };
          }
          readToolMessage = params.messages.find(
            (message) =>
              message.role === "tool" && message.name === "tool_result_read",
          );
          readToolStepMessages = params.messages.map((message) => ({
            role: message.role,
            name: "name" in message ? message.name : undefined,
            toolCallId:
              "tool_call_id" in message ? message.tool_call_id : undefined,
            contentStart:
              typeof message.content === "string"
                ? message.content.slice(0, 80)
                : undefined,
          }));
          return {
            kind: "final",
            text: "Read stored rows.",
            assistantMessage: {
              role: "assistant",
              content: "Read stored rows.",
            },
          };
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 15,
          mode: "agent",
          userText: "list my library, then inspect omitted rows",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 10_000 },
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.notInclude(toolNamesByStep[0], "tool_result_read");
      assert.include(toolNamesByStep[1], "tool_result_read");
      assert.equal(
        readToolMessage?.role,
        "tool",
        JSON.stringify(
          {
            stepIndex,
            outcome,
            readToolStepMessages,
          },
          null,
          2,
        ),
      );
      const readContent = JSON.parse(
        (readToolMessage as { content: string }).content,
      );
      assert.equal(readContent.handle, storedHandle);
      assert.equal(readContent.path, "results");
      assert.equal(readContent.returnedCount, 2);
      assert.deepEqual(
        readContent.items.map((item: { itemId: number; title: string }) => ({
          itemId: item.itemId,
          title: item.title,
        })),
        [
          { itemId: 51, title: "Stored row 50" },
          { itemId: 52, title: "Stored row 51" },
        ],
      );
    } finally {
      restoreDb();
    }
  });

  it("preserves library_retrieve evidence anchors when reducing under pressure", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      const fullResult = {
        intent: "enumerate",
        depth: "evidence",
        resourcePool: {
          totalItems: 120,
          queryCoverage: {
            metadataInspected: 120,
            indexedTextScanned: 90,
            snippetsReturned: 70,
          },
        },
        answerContract: {
          coverage: "indexed/searchable text scanned for the scoped pool",
        },
        paperMatches: Array.from({ length: 70 }, (_, index) => ({
          itemId: 20_000 + index,
          contextItemId: 30_000 + index,
          title: `Evidence paper ${index}`,
          matchStatus: "matched",
          score: 0.9,
        })),
        snippets: Array.from({ length: 70 }, (_, index) => ({
          snippetId: `lr_${20_000 + index}_${30_000 + index}_${index}_bm25`,
          itemId: `${20_000 + index}`,
          contextItemId: `${30_000 + index}`,
          chunkIndex: index,
          title: `Evidence paper ${index}`,
          sourceKind: "pdf_text",
          matchMethod: "bm25",
          sectionLabel: "Results",
          snippet: `Evidence snippet ${index} ${"B".repeat(900)}`,
          surroundingText: `Surrounding evidence ${index} ${"C".repeat(900)}`,
          score: 0.9,
          whyMatched: "Full-text BM25 retrieval ranked this passage highly",
          matchedQueryVariant: "representational drift",
        })),
        warnings: ["coverage is bounded by indexed text availability"],
      };
      registry.register({
        spec: {
          name: "library_retrieve",
          description: "retrieve",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => fullResult,
      });
      registry.register(createToolResultReadTool());

      let stepIndex = 0;
      let synthesisMessages: AgentModelMessage[] = [];
      let storedHandle = "";
      const adapter: AgentModelAdapter = {
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: true,
        }),
        supportsTools: () => true,
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          stepIndex += 1;
          if (stepIndex === 1) {
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call-retrieve",
                  name: "library_retrieve",
                  arguments: { query: "representational drift" },
                },
              ],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-retrieve",
                    name: "library_retrieve",
                    arguments: { query: "representational drift" },
                  },
                ],
              },
            };
          }
          if (stepIndex === 2) {
            const checkpoint = params.messages.find(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes(
                  "Agent semantic continuation checkpoint",
                ),
            );
            const match = String(checkpoint?.content || "").match(
              /handle=(trh_[a-z0-9]+)/i,
            );
            storedHandle = match?.[1] || "";
            assert.match(storedHandle, /^trh_/);
            const call = {
              id: "call-read-evidence",
              name: "tool_result_read",
              arguments: {
                handle: storedHandle,
                path: "snippets",
                offset: 0,
                limit: 1,
              },
            };
            return {
              kind: "tool_calls",
              calls: [call],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [call],
              },
            };
          }
          synthesisMessages = params.messages;
          return {
            kind: "final",
            text: "Evidence reduced.",
            assistantMessage: {
              role: "assistant",
              content: "Evidence reduced.",
            },
          };
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 14,
          mode: "agent",
          userText: "find evidence",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 10_000 },
        },
      });

      assert.equal(outcome.kind, "completed");
      const toolMessage = synthesisMessages.find(
        (message) =>
          message.role === "tool" && message.name === "tool_result_read",
      );
      assert.equal(toolMessage?.role, "tool");
      const restored = JSON.parse((toolMessage as { content: string }).content);
      assert.equal(restored.handle, storedHandle);
      assert.equal(restored.path, "snippets");
      assert.equal(restored.returnedCount, 1);
      assert.include(restored.items[0].snippet, "Evidence snippet 0");
      assert.equal(restored.items[0].snippetId, "lr_20000_30000_0_bm25");
      assert.equal(restored.items[0].itemId, "20000");
      assert.equal(restored.items[0].contextItemId, "30000");
      assert.equal(restored.items[0].matchMethod, "bm25");
    } finally {
      restoreDb();
    }
  });

  it("resets stateful adapters when preflight compacts prompt messages", async function () {
    const restoreDb = installMockDb();
    try {
      let resetCount = 0;
      let stepIndex = 0;
      let initialMessages: AgentModelMessage[] = [];
      let inspectedMessages: AgentModelMessage[] = [];
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "query_library",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          entity: "items",
          mode: "list",
          totalCount: 200,
          returnedCount: 200,
          results: Array.from({ length: 200 }, (_, index) => ({
            itemId: index + 1,
            title: `Large row ${index}`,
            abstract: "B".repeat(1_000),
          })),
        }),
      });
      registry.register(createToolResultReadTool());
      const adapter: AgentModelAdapter = {
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: true,
        }),
        supportsTools: () => true,
        resetState: () => {
          resetCount += 1;
        },
        async runStep(params: AgentStepParams): Promise<AgentModelStep> {
          stepIndex += 1;
          inspectedMessages = structuredClone(params.messages);
          if (stepIndex === 1) {
            initialMessages = structuredClone(params.messages);
            const call = {
              id: "large-read-call",
              name: "query_library",
              arguments: { entity: "items", mode: "list" },
            };
            return {
              kind: "tool_calls",
              calls: [call],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [call],
              },
            };
          }
          return {
            kind: "final",
            text: "Done.",
            assistantMessage: {
              role: "assistant",
              content: "Done.",
            },
          };
        },
      };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 12,
          mode: "agent",
          userText: "current request",
          systemPrompt: "SYSTEM_PREFLIGHT_SENTINEL",
          customInstructions: "CUSTOM_PREFLIGHT_SENTINEL",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 8_000 },
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(resetCount, 1);
      assert.deepEqual(inspectedMessages.slice(0, -1), initialMessages);
      assert.equal(inspectedMessages.at(-1)?.role, "user");
      assert.notInclude(JSON.stringify(inspectedMessages), "B".repeat(1000));
      assert.include(JSON.stringify(inspectedMessages), "current request");
      assert.include(
        JSON.stringify(inspectedMessages),
        "SYSTEM_PREFLIGHT_SENTINEL",
      );
      assert.include(
        JSON.stringify(inspectedMessages),
        "CUSTOM_PREFLIGHT_SENTINEL",
      );
      assert.include(
        JSON.stringify(inspectedMessages),
        "Agent semantic continuation checkpoint",
      );
    } finally {
      restoreDb();
    }
  });

  it("checkpoints raw paper text after a durable research batch", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "paper_read",
          description: "read papers",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          results: [
            {
              identity: "1:AAAA1111",
              text: `FULL_PAPER_TEXT_SENTINEL ${"P".repeat(20_000)}`,
            },
          ],
        }),
      });
      registry.register({
        spec: {
          name: "research_update",
          description: "persist paper understanding",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          content: {
            progress: { totalItems: 30, deepReadCompleted: 1 },
          },
          continuationCheckpoint: {
            reason: "research_batch_durable",
            instruction:
              "The completed paper understanding is durable. Continue with the remaining reading manifest.",
          },
        }),
      });
      registry.register(createToolResultReadTool());

      let stepIndex = 0;
      let resetCount = 0;
      let messagesAfterBatch: AgentModelMessage[] = [];
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          resetState: () => {
            resetCount += 1;
          },
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex === 1) {
              const call = {
                id: "read-paper-batch",
                name: "paper_read",
                arguments: {
                  mode: "overview",
                  targets: [{ itemId: 1, contextItemId: 2 }],
                },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            if (stepIndex === 2) {
              const call = {
                id: "record-paper-batch",
                name: "research_update",
                arguments: {
                  operation: "record_papers",
                  papers: [{ libraryID: 1, itemKey: "AAAA1111" }],
                },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            messagesAfterBatch = structuredClone(params.messages);
            return {
              kind: "final",
              text: "Durable batch recorded.",
              assistantMessage: {
                role: "assistant",
                content: "Durable batch recorded.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1213,
          mode: "agent",
          userText: "Read every paper and persist each completed group.",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
          advanced: { inputTokenCap: 1_000_000 },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(resetCount, 1);
      assert.notInclude(
        JSON.stringify(messagesAfterBatch),
        "FULL_PAPER_TEXT_SENTINEL",
      );
      assert.include(
        JSON.stringify(messagesAfterBatch),
        "Agent semantic continuation checkpoint",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.providerType === "agent_context_budget" &&
            event.payload?.action === "checkpoint_durable_tool_state" &&
            event.payload?.reason === "research_batch_durable",
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("does not abort after repeated input rejections", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      let executed = 0;
      registry.register({
        spec: {
          name: "research_update",
          description: "persist paper understanding",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) =>
          (args as { ok?: boolean }).ok
            ? { ok: true, value: args }
            : { ok: false, error: "papers[0].finding is required" },
        execute: async () => {
          executed += 1;
          return { content: { progress: { totalItems: 1 } } };
        },
      });

      let stepIndex = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex <= 4) {
              const call = {
                id: `c${stepIndex}`,
                name: "research_update",
                arguments: { ok: false },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            if (stepIndex === 5) {
              const call = {
                id: "c5",
                name: "research_update",
                arguments: { ok: true },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "done",
              assistantMessage: { role: "assistant", content: "done" },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1219,
          mode: "agent",
          userText: "record",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(outcome.text, "done");
      assert.equal(
        executed,
        1,
        "the valid call still executes after four rejections",
      );
    } finally {
      restoreDb();
    }
  });

  it("still aborts after three rounds of tool execution failures", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "research_update",
          description: "persist paper understanding",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => {
          throw new Error("the research store is unavailable");
        },
      });

      let stepIndex = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            stepIndex += 1;
            const call = {
              id: `c${stepIndex}`,
              name: "research_update",
              arguments: { operation: "record_papers" },
            };
            return {
              kind: "tool_calls",
              calls: [call],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [call],
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1220,
          mode: "agent",
          userText: "record",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
        },
      });

      assert.equal(stepIndex, 3);
      assert.match(String(outcome.text), /repeated tool errors/);
    } finally {
      restoreDb();
    }
  });

  it("checkpoints cached provider state when reported replay usage exceeds the send budget", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "small_read",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ value: "small result" }),
      });
      registry.register(createToolResultReadTool());

      let stepIndex = 0;
      let resetCount = 0;
      let initialStepMessages: AgentModelMessage[] = [];
      let secondStepMessages: AgentModelMessage[] = [];
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          resetState: () => {
            resetCount += 1;
          },
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex === 1) {
              initialStepMessages = structuredClone(params.messages);
              await params.onUsage?.({
                promptTokens: 90_000,
                completionTokens: 10_000,
                totalTokens: 100_000,
              });
              const call = {
                id: "small-read-call",
                name: "small_read",
                arguments: {},
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            secondStepMessages = structuredClone(params.messages);
            return {
              kind: "final",
              text: "Done after checkpoint.",
              assistantMessage: {
                role: "assistant",
                content: "Done after checkpoint.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1212,
          mode: "agent",
          userText: "Use the small result.",
          systemPrompt: "SYSTEM_REPLAY_SENTINEL",
          customInstructions: "CUSTOM_REPLAY_SENTINEL",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
          advanced: { inputTokenCap: 8_000 },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(resetCount, 1);
      assert.isTrue(
        secondStepMessages.every(
          (message) => message.role === "system" || message.role === "user",
        ),
      );
      assert.include(
        JSON.stringify(secondStepMessages),
        "Agent semantic continuation checkpoint",
      );
      assert.equal(secondStepMessages.at(-1)?.role, "user");
      assert.deepEqual(secondStepMessages.slice(0, -1), initialStepMessages);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.providerType === "agent_context_budget" &&
            event.payload?.action === "checkpoint_provider_replay_usage",
        ),
      );
    } finally {
      restoreDb();
    }
  });

  it("keeps one frozen envelope and one latest checkpoint across consecutive semantic restarts", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "small_read",
          description: "read",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args as { index: number } }),
        execute: async (args: { index: number }, context) => {
          context.request.userText = `mutated request ${args.index}`;
          context.request.customInstructions = `mutated instructions ${args.index}`;
          context.request.metadata = {
            ...(context.request.metadata || {}),
            mutatedAfterPromptRender: args.index,
          };
          return {
            index: args.index,
            evidence: `evidence-${args.index}`,
          };
        },
      });
      registry.register(createToolResultReadTool());

      let stepIndex = 0;
      let resetCount = 0;
      let initialMessages: AgentModelMessage[] = [];
      let firstCheckpointHandle = "";
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          resetState: () => {
            resetCount += 1;
          },
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepIndex += 1;
            if (stepIndex === 1) {
              initialMessages = structuredClone(params.messages);
            } else {
              const restarted = structuredClone(params.messages);
              assert.deepEqual(restarted.slice(0, -1), initialMessages);
              assert.equal(restarted.at(-1)?.role, "user");
              assert.equal(
                restarted.filter((message) =>
                  JSON.stringify(message).includes(
                    "Agent semantic continuation checkpoint",
                  ),
                ).length,
                1,
              );
              assert.isFalse(
                restarted.some(
                  (message) =>
                    message.role === "assistant" || message.role === "tool",
                ),
              );
              const checkpointText = JSON.stringify(restarted.at(-1));
              const handles = [
                ...checkpointText.matchAll(/handle=(trh_[a-z0-9]+)/gi),
              ].map((match) => match[1]);
              if (stepIndex === 2) {
                assert.lengthOf(handles, 1);
                firstCheckpointHandle = handles[0];
              } else {
                assert.include(handles, firstCheckpointHandle);
                assert.isAtLeast(new Set(handles).size, 2);
              }
            }

            if (stepIndex <= 2) {
              await params.onUsage?.({
                promptTokens: 90_000,
                completionTokens: 10_000,
                totalTokens: 100_000,
              });
              const call = {
                id: `small-read-${stepIndex}`,
                name: "small_read",
                arguments: { index: stepIndex },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Done after two checkpoints.",
              assistantMessage: {
                role: "assistant",
                content: "Done after two checkpoints.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1213,
          mode: "agent",
          userText: "Use both small results.",
          systemPrompt: "SYSTEM_DOUBLE_RESTART_SENTINEL",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
          advanced: { inputTokenCap: 8_000 },
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(resetCount, 2);
      assert.equal(stepIndex, 3);
    } finally {
      restoreDb();
    }
  });

  for (const mode of ["yolo", "auto"] as const) {
    it(`${mode}: a typed same-library write is applied by the configured policy`, async function () {
      const restoreDb = installMockDb();
      try {
        await initAgentChangeJournal();
        globalThis.Zotero.Prefs.set(
          "extensions.zotero.llmforzotero.originalAgentPermissionMode",
          mode,
        );
        const registry = new AgentToolRegistry(
          createTestActionContractService(),
          new PlanAmendmentService(),
        );
        let writes = 0;
        registry.register({
          effectOperations: ["apply_tags"],
          spec: {
            name: "tag_related",
            description: "tag a related paper",
            inputSchema: { type: "object" },
            executionClass: "external_effect",
            requiresConfirmation: false,
          },
          validate: () => ({ ok: true, value: {} }),
          describeAction: () => [
            {
              id: "apply_tags:judgment",
              proofDomain: "zotero_state",
              capability: "zotero.tags",
              operation: "apply_tags",
              source: "zotero_native",
              parameters: { tags: ["follow-up"] },
              requestedTargets: ["item:41"],
              destinationCollectionIds: [],
            },
          ],
          planInvocation: () =>
            stateChangeInvocationPlan({
              domains: ["zotero_library"],
              effects: ["modify"],
              targets: ["item:41"],
              reversibility: "full",
              reason: "Apply a routine same-library tag.",
            }),
          execute: async () => {
            writes++;
            return { content: { tagged: 1 }, effect: "applied" };
          },
        });
        const call = { id: "call-1", name: "tag_related", arguments: {} };
        const runtime = new AgentRuntime({
          registry,
          adapterFactory: () =>
            new MockAdapter(
              [
                {
                  kind: "tool_calls",
                  calls: [call],
                  assistantMessage: {
                    role: "assistant",
                    content: "",
                    tool_calls: [call],
                  },
                },
                {
                  kind: "final",
                  text: "Done.",
                  assistantMessage: { role: "assistant", content: "Done." },
                },
              ],
              { streaming: false, toolCalls: true, multimodal: false },
            ),
        });
        const events: AgentEvent[] = [];
        const outcome = await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 1,
            mode: "agent",
            libraryID: 1,
            userText: "tidy up this folder",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
          },
          onEvent: async (event) => {
            events.push(event);
          },
        });
        const toolResult = events.find((event) => event.type === "tool_result");
        assert.exists(toolResult);
        if (!toolResult || toolResult.type !== "tool_result") return;
        assert.isFalse(
          events.some((event) => event.type === "confirmation_required"),
          "no card in either mode",
        );
        assert.equal(writes, 1);
        assert.isTrue(toolResult.ok);
        assert.equal(
          toolResult.authority,
          mode === "yolo" ? "yolo_judgment" : undefined,
        );
        assert.equal(outcome.kind, "completed");
      } finally {
        restoreDb();
      }
    });
  }

  it("yolo applies a requested write and an unrequested one in the same turn", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      globalThis.Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.originalAgentPermissionMode",
        "yolo",
      );
      const registry = new AgentToolRegistry(
        createTestActionContractService((itemId) =>
          itemId === 500
            ? ({
                id: 500,
                parentID: false,
                deleted: false,
                isNote: () => true,
                getNote: () => "hello",
                getCollections: () => [],
              } as unknown as Zotero.Item)
            : null,
        ),
        new PlanAmendmentService(),
      );
      let requestedWrites = 0;
      let judgmentWrites = 0;
      registry.register({
        effectOperations: ["note_create"],
        spec: {
          name: "mutate_library",
          description: "mutate",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          workCategory: "zotero_action",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: { content: "hello" } }),
        describeAction: (input) => [
          {
            id: "note_create:requested",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: { noteMode: "create", expectedText: input.content },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => {
          requestedWrites++;
          return {
            content: { status: "created", noteId: 500, saved: "hello" },
            effect: "applied",
          };
        },
      });
      registry.register({
        effectOperations: ["apply_tags"],
        spec: {
          name: "tag_related",
          description: "tag a related paper",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () => [
          {
            id: "apply_tags:judgment",
            proofDomain: "zotero_state",
            capability: "zotero.tags",
            operation: "apply_tags",
            source: "zotero_native",
            parameters: { tags: ["follow-up"] },
            requestedTargets: ["item:41"],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => {
          judgmentWrites++;
          return { content: { tagged: 1 }, effect: "applied" };
        },
      });
      const requested = {
        id: "call-1",
        name: "mutate_library",
        arguments: { content: "hello" },
      };
      const unrequested = { id: "call-2", name: "tag_related", arguments: {} };
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              {
                kind: "tool_calls",
                calls: [requested],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [requested],
                },
              },
              {
                kind: "tool_calls",
                calls: [unrequested],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [unrequested],
                },
              },
              {
                kind: "final",
                text: "Saved the note and tagged the related paper.",
                assistantMessage: {
                  role: "assistant",
                  content: "Saved the note and tagged the related paper.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("note_create", undefined, {
            noteDestination: "zotero",
          }),
          conversationKey: 1,
          mode: "agent",
          libraryID: 1,
          userText: "create a note with hello",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: async (event) => {
          events.push(event);
          // Never leave a card unanswered: an unexpected one would hang the
          // turn instead of failing the assertion below.
          if (event.type === "confirmation_required")
            runtime.resolveConfirmation(event.requestId, false);
        },
      });

      assert.isFalse(
        events.some((event) => event.type === "confirmation_required"),
        "yolo reviews neither the requested nor the unrequested write",
      );
      const results = events.filter((event) => event.type === "tool_result");
      assert.lengthOf(results, 2);
      assert.equal(requestedWrites, 1);
      assert.equal(judgmentWrites, 1);
      assert.isTrue(results[0].ok);
      assert.isTrue(results[1].ok);
      // Fresh ordinary turns have no semantic contract. YOLO owns both
      // concrete calls at the shared invocation boundary.
      assert.equal(results[0].authority, "yolo_judgment");
      assert.equal(results[1].authority, "yolo_judgment");
      assert.equal(outcome.kind, "completed");
    } finally {
      restoreDb();
    }
  });
});

describe("web attribution runtime guard", function () {
  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
  });

  const capabilities: AgentModelCapabilities = {
    streaming: false,
    toolCalls: true,
    multimodal: false,
    fileInputs: false,
    reasoning: true,
  };

  const provider: WebAccessProvider = {
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

  const searchStep: AgentModelStep = {
    kind: "tool_calls",
    calls: [
      {
        id: "web-call-1",
        name: "web_search",
        arguments: { query: "current fact", depth: "basic" },
      },
    ],
    assistantMessage: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "web-call-1",
          name: "web_search",
          arguments: { query: "current fact", depth: "basic" },
        },
      ],
    },
  };

  function findSourceId(messages: AgentModelMessage[]): string {
    for (const message of messages) {
      if (message.role !== "tool" || message.name !== "web_search") continue;
      const content = JSON.parse(String(message.content)) as {
        results?: Array<{ sourceId?: string }>;
      };
      const sourceId = content.results?.[0]?.sourceId;
      if (sourceId) return sourceId;
    }
    throw new Error("Missing web source ID in mock model context");
  }

  it("rejects missing depth without a request and executes a corrected call", async function () {
    const restoreDb = installMockDb();
    let searchCalls = 0;
    const countingProvider: WebAccessProvider = {
      ...provider,
      search: async (request) => {
        searchCalls += 1;
        return provider.search(request);
      },
    };
    try {
      Zotero.Prefs.set(TAVILY_API_KEY_PREF, "tvly-test", true);
      const registry = new AgentToolRegistry();
      registry.register(createWebSearchTool(() => countingProvider));
      let step = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => capabilities,
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            step += 1;
            if (step === 1) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "web-call-missing-depth",
                    name: "web_search",
                    arguments: { query: "current fact" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "web-call-missing-depth",
                      name: "web_search",
                      arguments: { query: "current fact" },
                    },
                  ],
                },
              };
            }
            if (step === 2) {
              assert.equal(searchCalls, 0);
              assert.include(
                JSON.stringify(params.messages),
                "depth must be one of: basic, advanced",
              );
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "web-call-corrected",
                    name: "web_search",
                    arguments: { query: "current fact", depth: "basic" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "web-call-corrected",
                      name: "web_search",
                      arguments: { query: "current fact", depth: "basic" },
                    },
                  ],
                },
              };
            }
            assert.equal(searchCalls, 1);
            const sourceId = findSourceId(params.messages);
            const text = `A supported current claim.<!--llm-web-source:${sourceId}-->`;
            return {
              kind: "final",
              text,
              assistantMessage: { role: "assistant", content: text },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 920,
          mode: "agent",
          userText: "What is current?",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          authMode: "api_key",
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(searchCalls, 1);
      const validationError = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_error" }> =>
          event.type === "tool_error",
      );
      assert.include(
        validationError?.error || "",
        "depth must be one of: basic, advanced",
      );
    } finally {
      restoreDb();
    }
  });

  it("allows one correction, persists clean Markdown, and stores terminal anchors", async function () {
    const restoreDb = installMockDb();
    try {
      Zotero.Prefs.set(TAVILY_API_KEY_PREF, "tvly-test", true);
      const registry = new AgentToolRegistry();
      registry.register(createWebSearchTool(() => provider));
      let step = 0;
      const modelInputs: AgentModelMessage[][] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => capabilities,
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelInputs.push(params.messages.slice());
            step += 1;
            if (step === 1) return searchStep;
            if (step === 2) {
              return {
                kind: "final",
                text: "An unsupported current claim.",
                assistantMessage: {
                  role: "assistant",
                  content: "An unsupported current claim.",
                },
              };
            }
            const sourceId = findSourceId(params.messages);
            const text = `A supported current claim.<!--llm-web-source:${sourceId}-->`;
            return {
              kind: "final",
              text,
              assistantMessage: { role: "assistant", content: text },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 921,
          mode: "agent",
          userText: "What is current?",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          authMode: "api_key",
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "A supported current claim.");
      assert.lengthOf(modelInputs, 3);
      const correction = modelInputs[2].find(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Correct the web attribution"),
      );
      assert.exists(correction);
      const finalEvent = events.findLast(
        (event): event is Extract<AgentEvent, { type: "final" }> =>
          event.type === "final",
      );
      assert.equal(finalEvent?.text, "A supported current claim.");
      assert.lengthOf(finalEvent?.webSourceAnchors || [], 1);
      assert.equal(
        finalEvent?.webSourceAnchors?.[0].offset,
        outcome.text.length,
      );
      assert.notInclude(outcome.text, "llm-web-source");
      const transcript = readPersistedTranscript(restoreDb, 921);
      assert.equal(transcript.at(-1)?.role, "assistant");
      assert.equal(transcript.at(-1)?.content, "A supported current claim.");
      assert.notInclude(JSON.stringify(transcript), "llm-web-source");
    } finally {
      restoreDb();
    }
  });

  it("fails closed after a second invalid attribution response", async function () {
    const restoreDb = installMockDb();
    try {
      Zotero.Prefs.set(TAVILY_API_KEY_PREF, "tvly-test", true);
      const registry = new AgentToolRegistry();
      registry.register(createWebSearchTool(() => provider));
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              searchStep,
              {
                kind: "final",
                text: "First uncited claim.",
                assistantMessage: {
                  role: "assistant",
                  content: "First uncited claim.",
                },
              },
              {
                kind: "final",
                text: "Second uncited claim.",
                assistantMessage: {
                  role: "assistant",
                  content: "Second uncited claim.",
                },
              },
            ],
            capabilities,
          ),
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 922,
          mode: "agent",
          userText: "What is current?",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          authMode: "api_key",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "could not safely attach valid");
      const run = restoreDb.runs.get(outcome.runId);
      assert.equal(run?.status, "failed");
      assert.notInclude(outcome.text, "First uncited claim");
      assert.notInclude(outcome.text, "Second uncited claim");
    } finally {
      restoreDb();
    }
  });
});

describe("direct Q&A completion", function () {
  it("accepts a supported answer without a hidden retrieval classifier", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            modelSteps += 1;
            return {
              kind: "final",
              text: "Answer from the evidence already supplied.",
              assistantMessage: {
                role: "assistant",
                content: "Answer from the evidence already supplied.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 8201,
          mode: "agent",
          libraryID: 1,
          userText: "Explain the result using the evidence above.",
          model: "test-model",
          apiKey: "test",
          apiBase: "",
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(modelSteps, 1);
      if (outcome.kind === "completed")
        assert.equal(
          outcome.text,
          "Answer from the evidence already supplied.",
        );
    } finally {
      restoreDb();
    }
  });
});

describe("shallow guard round-limit safety", function () {
  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
  });

  it("does not roll back a final answer on the last allowed round", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "noop_probe",
          description: "noop",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ ok: true }),
      });
      const steps: AgentModelStep[] = [];
      for (let index = 0; index < 23; index += 1) {
        steps.push({
          kind: "tool_calls",
          calls: [{ id: `noop-${index}`, name: "noop_probe", arguments: {} }],
          assistantMessage: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: `noop-${index}`, name: "noop_probe", arguments: {} },
            ],
          },
        });
      }
      steps.push({
        kind: "final",
        text: "Answer on the last round.",
        assistantMessage: {
          role: "assistant",
          content: "Answer on the last round.",
        },
      });
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(steps, {
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1,
          mode: "agent",
          userText: "What methods do these papers share?",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          selectedCollectionContexts: [
            { collectionId: 3, name: "C", libraryID: 1 },
          ],
        },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Answer on the last round.");
    } finally {
      restoreDb();
    }
  });

  /**
   * A library write that changed nothing used to be summarized as done: the
   * registry stamped ok:true, the trace showed a constant "Library updated",
   * and nothing at end of turn compared the claim to the ledger. The runtime
   * already refuses to finalize on an unfulfilled file write or full-text
   * read; this is the same shape for Zotero mutations.
   *
   * It corrects once and then accepts. A zero-effect write is often
   * legitimate ("they were already in that collection") — the goal is an
   * accurate report, not a failed run.
   */
  it("does not retry a typed obligation after the user declines it", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["command_execute"],
        spec: {
          name: "library_update",
          description: "update",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: (args) => ({ ok: true, value: args as never }),
        describeAction: () =>
          commandActionDescriptor("command_execute:cancel-once"),
        createPendingAction: () => ({
          toolName: "library_update",
          title: "Confirm",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        }),
        async execute() {
          return {
            content: {
              movedCount: 1,
              items: [{ itemId: 1, status: "moved" }],
            },
            effect: "applied",
          };
        },
      } as never);

      const toolStep = (id: string) => ({
        kind: "tool_calls" as const,
        calls: [{ id, name: "library_update", arguments: {} }],
        assistantMessage: { role: "assistant" as const, content: "" },
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolStep("c1"),
              {
                kind: "final",
                text: "You cancelled the write, so nothing changed.",
                assistantMessage: {
                  role: "assistant",
                  content: "You cancelled the write, so nothing changed.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });

      // "safe" is what this test is about: declining a card the user was
      // shown. Under the default "auto" mode these writes are reversible and
      // apply without a card, so there would be nothing to decline.
      const previousZotero = (globalThis as Record<string, any>).Zotero;
      (globalThis as Record<string, any>).Zotero = {
        ...(previousZotero || {}),
        Prefs: {
          ...(previousZotero?.Prefs || {}),
          get: (key: string, ...rest: unknown[]) =>
            String(key).endsWith("originalAgentPermissionMode")
              ? "safe"
              : previousZotero?.Prefs?.get?.(key, ...rest),
        },
      };

      let denials = 0;
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("command_execute"),
          conversationKey: 992,
          mode: "agent",
          userText: "run command after confirmation",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          libraryID: 1,
        },
        onEvent: async (event) => {
          if (event.type === "confirmation_required") {
            denials += 1;
            runtime.resolveConfirmation(event.requestId, false);
          }
        },
      });

      (globalThis as Record<string, any>).Zotero = previousZotero;

      assert.equal(denials, 1, "the cancelled obligation must not be retried");

      assert.equal(
        outcome.kind,
        "completed",
        "declining is the user steering, not the tool failing",
      );
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "nothing changed");
    } finally {
      restoreDb();
    }
  });

  /**
   * The guard reads turn-wide records, so without scoping a first attempt
   * that failed and was then correctly retried still produced "ran but
   * changed nothing … Do not report the request as completed" — with the
   * items sitting in the collection and the user told otherwise. The false
   * correction was also persisted into the transcript. The first attempt
   * below is deliberately unverified; the second attaches native tag state.
   */
  it("does not correct a zero-effect write that a later call superseded", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      let call = 0;
      const operation = {
        type: "apply_tags" as const,
        itemIds: [1, 2, 3],
        tags: ["reviewed"],
      };
      const registry = new AgentToolRegistry(
        createTestActionContractService((itemId) =>
          [1, 2, 3].includes(itemId)
            ? ({
                id: itemId,
                libraryID: 1,
                isRegularItem: () => true,
                isAttachment: () => false,
                isAnnotation: () => false,
              } as unknown as Zotero.Item)
            : null,
        ),
      );
      registry.register({
        effectOperations: ["apply_tags"],
        spec: {
          name: "library_update",
          description: "update",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: { operation } }),
        describeAction: (input) => describeLibraryMutationActions(input),
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test library write.",
          }),
        async execute() {
          call += 1;
          return call === 1
            ? {
                content: {
                  taggedCount: 0,
                  selectedCount: 3,
                  items: [
                    {
                      itemId: 1,
                      status: "missing",
                      reason: "wrong collection",
                    },
                  ],
                },
                effect: "none",
              }
            : {
                content: {
                  taggedCount: 3,
                  selectedCount: 3,
                  items: [
                    { itemId: 1, status: "moved" },
                    { itemId: 2, status: "moved" },
                    { itemId: 3, status: "moved" },
                  ],
                },
                effect: "applied",
                actionEvidence: [
                  {
                    version: 1 as const,
                    source: "library_mutation" as const,
                    proofDomain: "zotero_state" as const,
                    operationValue: operation,
                    preState: {
                      version: 1 as const,
                      operation: "apply_tags" as const,
                      items: [1, 2, 3].map((itemId) => ({
                        itemId,
                        exists: true,
                        tags: [],
                      })),
                    },
                    postState: {
                      version: 1 as const,
                      operation: "apply_tags" as const,
                      items: [1, 2, 3].map((itemId) => ({
                        itemId,
                        exists: true,
                        tags: ["reviewed"],
                      })),
                    },
                    journalStepId: "retry:2",
                    effect: "applied" as const,
                  },
                ],
              };
        },
      } as never);

      const toolStep = (id: string) => ({
        kind: "tool_calls" as const,
        calls: [{ id, name: "library_update", arguments: {} }],
        assistantMessage: { role: "assistant" as const, content: "" },
      });

      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolStep("c1"),
              toolStep("c2"),
              {
                kind: "final",
                text: "Tagged all 3 papers as reviewed.",
                assistantMessage: {
                  role: "assistant",
                  content: "Tagged all 3 papers as reviewed.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: {
            ...actionFixture("apply_tags", { tags: ["reviewed"] }),
            paperTargetIntent: "all_visible",
            actionIntents: [
              {
                ...actionFixture("apply_tags", { tags: ["reviewed"] })
                  .actionIntents[0],
                coverage: "some",
                targetKind: "papers",
              },
            ],
          },
          conversationKey: 993,
          mode: "agent",
          userText: 'Add the tag "reviewed" to these papers.',
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          libraryID: 1,
          selectedPaperContexts: [1, 2, 3].map((itemId) => ({
            itemId,
            contextItemId: itemId,
            title: `Paper ${itemId}`,
          })),
        },
        onEvent: () => undefined,
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(
        outcome.text,
        "Tagged all 3",
        "the retry succeeded, so the true answer must survive",
      );
      assert.equal(call, 2, "exactly the two writes, no forced third round");
    } finally {
      restoreDb();
    }
  });
});

describe("AgentRuntime evidence stop policy", function () {
  it("tells a targeted question to answer now after a repeated paper read", async function () {
    const restoreDb = installMockDb();
    const toolMessages: string[] = [];
    let steps = 0;
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "paper_read",
          description: "Read paper evidence",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args }),
        execute: async () => ({
          mode: "targeted",
          results: [
            {
              paperContext: { itemId: 3928, contextItemId: 3931 },
              chunkIndex: 7,
              sourceFingerprint: "source-a",
              sourceKind: "paper_text",
              text: "Cross-scanning day decoding remained stable over time.",
            },
          ],
        }),
      });
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            steps += 1;
            for (const message of params.messages) {
              if (message.role === "tool") toolMessages.push(message.content);
            }
            if (steps <= 2) {
              const call = {
                id: `paper-read-${steps}`,
                name: "paper_read",
                arguments: { mode: "targeted", query: "cross-day decoding" },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Decoding stayed stable across days.",
              assistantMessage: {
                role: "assistant",
                content: "Decoding stayed stable across days.",
              },
            };
          },
        }),
      });
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 939777,
          mode: "agent",
          conversationKind: "paper",
          activeItemId: 3928,
          libraryID: 1,
          userText: "What happened to cross-day decoding?",
          model: "test-model",
          apiKey: "test",
          apiBase: "",
          classifiedIntent: classifiedFixture({
            semantic: semanticFixture({
              reading: { source: "document_text", coverage: "targeted" },
            }),
          }),
        },
        onEvent: () => {},
      });
      assert.equal(outcome.kind, "completed");
      assert.equal(steps, 3);
      const last = JSON.parse(
        toolMessages[toolMessages.length - 1] || "{}",
      ) as {
        paperEvidenceProgress?: { recommendation?: string; reason?: string };
      };
      assert.equal(last.paperEvidenceProgress?.recommendation, "answer_now");
      assert.include(
        last.paperEvidenceProgress?.reason || "",
        "read one unread section by sectionId from the outline",
      );
    } finally {
      restoreDb();
    }
  });
});

describe("truncated answer continuation with a non-streaming final step", function () {
  it("does not duplicate the kept text when the continuation returns nothing new", async function () {
    const restoreDb = installMockDb();
    try {
      let modelSteps = 0;
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            modelSteps += 1;
            if (modelSteps === 1) {
              return {
                kind: "incomplete",
                reason: "output_limit",
                text: "Everything that fits.",
                recoveryInstruction: "Continue with a complete tool call.",
                assistantMessage: {
                  role: "assistant",
                  content: "Everything that fits.",
                },
              };
            }
            return {
              kind: "final",
              text: "",
              assistantMessage: { role: "assistant", content: "" },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 1_915,
          mode: "agent",
          userText: "write it",
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "test",
          advanced: { outputTokenLimit: { mode: "auto" } },
        },
      });

      assert.equal(modelSteps, 2);
      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") {
        assert.equal(outcome.text, "Everything that fits.");
      }
    } finally {
      restoreDb();
    }
  });
});

describe("delegating facade trace labels", function () {
  for (const scenario of [
    {
      name: "an identifier import",
      args: { kind: "identifiers", identifiers: ["10.1000/example"] },
      workCategory: "zotero_action",
    },
    {
      name: "a local-file import",
      args: { kind: "files", paths: ["/tmp/paper.pdf"] },
      workCategory: "external_system",
    },
  ]) {
    it(`labels ${scenario.name} by the delegate it chose`, async function () {
      const restoreDb = installMockDb();
      const events: AgentEvent[] = [];
      let steps = 0;
      try {
        const registry = createBuiltInToolRegistry({
          zoteroGateway: {} as never,
          pdfService: {} as never,
          pdfPageService: {} as never,
          retrievalService: {} as never,
        });
        const runtime = new AgentRuntime({
          registry,
          adapterFactory: () => ({
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(): Promise<AgentModelStep> {
              if (steps++ === 0) {
                const call = {
                  id: "library-import-1",
                  name: "library_import",
                  arguments: scenario.args,
                };
                return {
                  kind: "tool_calls",
                  calls: [call],
                  assistantMessage: {
                    role: "assistant",
                    content: "",
                    tool_calls: [call],
                  },
                };
              }
              return {
                kind: "final",
                text: "Done.",
                assistantMessage: { role: "assistant", content: "Done." },
              };
            },
          }),
        });
        await runtime.runTurn({
          request: {
            conversationKey: 771201,
            mode: "agent",
            userText: "Import this.",
            model: "test-model",
            apiKey: "test",
            apiBase: "",
            classifiedIntent: {
              ...classifiedFixture(),
              semantic: semanticFixture(),
              retrievalIntent: "none",
              wantedSections: [],
              actionIntents: [],
            },
          },
          onEvent: (event) => events.push(event),
        });
        const call = events.find(
          (event) =>
            event.type === "tool_call" && event.name === "library_import",
        );
        const result = events.find(
          (event) =>
            event.type === "tool_result" && event.name === "library_import",
        );
        assert.isDefined(call, "the facade call must reach the trace");
        assert.isDefined(result, "the facade result must reach the trace");
        assert.equal(
          call?.type === "tool_call" ? call.workCategory : undefined,
          scenario.workCategory,
        );
        assert.equal(
          result?.type === "tool_result" ? result.workCategory : undefined,
          scenario.workCategory,
        );
      } finally {
        restoreDb();
      }
    });
  }
});

/** Plan, document and research stores need real SQL; the rest stays on the mock. */
function installPlanSqlite(): () => void {
  const zotero = globalThis as typeof globalThis & { Zotero: typeof Zotero };
  const base = zotero.Zotero.DB;
  const db = new DatabaseSync(":memory:");
  zotero.Zotero.DB = {
    ...base,
    queryAsync: async (sql: string, params: unknown[] = []) => {
      if (
        !sql.includes("llm_for_zotero_plan_") &&
        !sql.includes("llm_for_zotero_research")
      )
        return base.queryAsync(sql, params);
      const statement = db.prepare(sql);
      const values = params.map((value) =>
        value === undefined ? null : value,
      ) as never[];
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return statement.all(...values);
      statement.run(...values);
      return [];
    },
  } as unknown as typeof Zotero.DB;
  return () => {
    zotero.Zotero.DB = base;
    db.close();
  };
}

const submitDocumentGateway = {
  formatStructuredCitations: () => ({
    styleId: "apa",
    styleTitle: "APA",
    locale: "en-US",
    clusters: [],
    bibliographyEntries: [],
  }),
} as unknown as import("../src/agent/services/zoteroGateway").ZoteroGateway;

describe("finalized material announcement", function () {
  it("emits material_finalized and carries the same ref on the final event", async function () {
    const restoreDb = installMockDb();
    const restoreDocuments = installAgentStoreSqlite();
    const events: AgentEvent[] = [];
    let steps = 0;
    try {
      await initPlanDocumentStore();
      const registry = new AgentToolRegistry();
      registry.register(createSubmitDocumentTool(submitDocumentGateway));
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            if (steps++ === 0) {
              const call = {
                id: "submit-document-1",
                name: "submit_document",
                arguments: {
                  documentKind: "guide",
                  integrityPolicy: "authored",
                  title: "Representational drift",
                  markdown: "# Representational drift\n\nA complete guide.",
                  citations: [],
                  quotes: [],
                  assets: [],
                  groundingReviewed: "passed",
                  groundingIssues: [],
                },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Unreachable: submit_document ends the turn.",
              assistantMessage: {
                role: "assistant",
                content: "Unreachable: submit_document ends the turn.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 774411,
          mode: "agent",
          userText: "Write a guide about representational drift",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: 100 },
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      const toolResult = events.find(
        (event) =>
          event.type === "tool_result" && event.name === "submit_document",
      );
      assert.exists(toolResult, "the document tool must report a result");
      const returnedRef = (
        toolResult as Extract<AgentEvent, { type: "tool_result" }>
      ).content as { materialRef?: unknown };
      const announced = events.find(
        (event) => event.type === "material_finalized",
      ) as Extract<AgentEvent, { type: "material_finalized" }> | undefined;
      assert.exists(
        announced,
        "a finalized document must be announced as material",
      );
      assert.deepEqual(announced?.materialRef, returnedRef.materialRef);
      assert.equal(announced?.callId, "submit-document-1");
      assert.equal(announced?.materialKind, "guide");
      assert.equal(announced?.materialTitle, "Representational drift");

      const materialIndex = events.findIndex(
        (event) => event.type === "material_finalized",
      );
      const materialStage = events[materialIndex - 1];
      assert.equal(
        materialStage?.type,
        "agent_stage",
        "the generation stage precedes the material it announces",
      );
      assert.deepEqual(
        materialStage?.type === "agent_stage"
          ? [materialStage.stage, materialStage.status]
          : null,
        ["generation", "completed"],
      );
      assert.deepEqual(
        materialStage?.type === "agent_stage"
          ? materialStage.materialRef
          : null,
        announced?.materialRef,
      );
      assert.equal(
        materialStage?.type === "agent_stage" ? materialStage.callId : null,
        "submit-document-1",
      );

      const finalEvent = events.find((event) => event.type === "final") as
        | Extract<AgentEvent, { type: "final" }>
        | undefined;
      assert.deepEqual(finalEvent?.materialRef, announced?.materialRef);
      assert.equal(
        finalEvent?.documentId,
        announced?.materialRef.documentId,
        "the final event's document and material must be the same document",
      );

      const trace = await getAgentRunTrace(outcome.runId);
      const persisted = trace.events.filter(
        (entry) => entry.eventType === "material_finalized",
      );
      assert.lengthOf(
        persisted,
        1,
        "the material announcement is persisted like every other run event",
      );
      const toolResultIndex = trace.events.findIndex(
        (entry) => entry.eventType === "tool_result",
      );
      assert.isAbove(
        persisted[0].seq,
        trace.events[toolResultIndex].seq,
        "material is announced after the tool result that carried it",
      );
    } finally {
      restoreDocuments();
      restoreDb();
    }
  });

  it("announces each batch item and never as turn material", async function () {
    const restoreDb = installMockDb();
    const events: AgentEvent[] = [];
    const batchItems = [1, 2, 3].map((position) => ({
      batchId: "batch-note_write_batch-1",
      itemKey: `item:${position}`,
      materialRef: {
        documentId: `run:document:${position}`,
        documentVersion: 1,
        contentHash: `sha256:note-${position}`,
      },
      status: position === 2 ? ("failed" as const) : ("saved" as const),
      written: position !== 2,
      ...(position === 2
        ? { error: "Zotero refused the note write" }
        : { noteId: 500 + position }),
    }));
    let steps = 0;
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry();
      registry.register({
        effectOperations: ["save_notes_batch"],
        spec: {
          name: "note_write_batch",
          description: "Write a note onto each of many items",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args as never }),
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test note batch.",
          }),
        describeAction: () => [
          {
            id: "save_notes_batch:0",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "save_notes_batch",
            source: "library_mutation",
            requestedTargets: ["item:1", "item:2", "item:3"],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => ({
          content: { createdCount: 2, failedCount: 1 },
          effect: "partial",
          batchItems,
        }),
      } as never);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            if (steps++ === 0) {
              const call = {
                id: "note-batch-1",
                name: "note_write_batch",
                arguments: { notes: [] },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Wrote the notes.",
              assistantMessage: {
                role: "assistant",
                content: "Wrote the notes.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 774422,
          mode: "agent",
          userText: "Write a note on each of these papers",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: 100 },
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(outcome.kind, "completed");

      const announced = events.filter(
        (event) => event.type === "batch_item_outcome",
      ) as Extract<AgentEvent, { type: "batch_item_outcome" }>[];
      assert.lengthOf(announced, 3, "one announcement per batch item");
      assert.deepEqual(
        announced.map((event) => event.itemKey),
        ["item:1", "item:2", "item:3"],
      );
      assert.deepEqual(
        announced.map((event) => event.status),
        ["saved", "failed", "saved"],
      );
      assert.deepEqual(announced[0].materialRef, batchItems[0].materialRef);
      assert.equal(announced[0].noteId, 501);
      assert.equal(announced[1].error, "Zotero refused the note write");
      assert.deepEqual(
        announced.map((event) => event.callId),
        ["note-batch-1", "note-batch-1", "note-batch-1"],
      );

      const itemStages = events.filter(
        (event) => event.type === "agent_stage" && Boolean(event.itemKey),
      ) as Extract<AgentEvent, { type: "agent_stage" }>[];
      assert.deepEqual(
        itemStages.map((event) => [event.stage, event.status, event.itemKey]),
        [
          ["zotero_action", "completed", "item:1"],
          ["zotero_action", "failed", "item:2"],
          ["zotero_action", "completed", "item:3"],
        ],
        "each announced item reports its own stage outcome",
      );
      assert.deepEqual(
        itemStages.map((event) => event.batchId),
        [
          "batch-note_write_batch-1",
          "batch-note_write_batch-1",
          "batch-note_write_batch-1",
        ],
      );
      assert.deepEqual(itemStages[0].materialRef, batchItems[0].materialRef);
      const batchOrder = events.map((event) => event.type);
      assert.equal(
        batchOrder[batchOrder.indexOf("batch_item_outcome") - 1],
        "agent_stage",
        "the item stage precedes the outcome it describes",
      );
      // Fifty note bodies must never flood the turn's material ledger.
      assert.isEmpty(
        events.filter((event) => event.type === "material_finalized"),
      );

      const trace = await getAgentRunTrace(outcome.runId);
      const persisted = trace.events.filter(
        (entry) => entry.eventType === "batch_item_outcome",
      );
      assert.lengthOf(persisted, 3, "the announcements are persisted");
      const toolResultIndex = trace.events.findIndex(
        (entry) => entry.eventType === "tool_result",
      );
      assert.isAbove(
        persisted[0].seq,
        trace.events[toolResultIndex].seq,
        "items are announced after the tool result that carried them",
      );
    } finally {
      restoreDb();
    }
  });

  it("separates the items a resumed batch wrote from the ones it skipped", async function () {
    const restoreDb = installMockDb();
    const events: AgentEvent[] = [];
    // What a resume reports: it announces every row the batch holds, and both
    // of these are saved. Only the second one was saved by this call.
    const resumedItems = [
      {
        batchId: "batch-note_write_batch-1",
        itemKey: "item:1",
        materialRef: {
          documentId: "run:document:1",
          documentVersion: 1,
          contentHash: "sha256:note-1",
        },
        status: "saved" as const,
        written: false,
        noteId: 501,
      },
      {
        batchId: "batch-note_write_batch-1",
        itemKey: "item:2",
        materialRef: {
          documentId: "run:document:2",
          documentVersion: 1,
          contentHash: "sha256:note-2",
        },
        status: "saved" as const,
        written: true,
        noteId: 502,
      },
    ];
    let steps = 0;
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry();
      registry.register({
        effectOperations: ["save_notes_batch"],
        spec: {
          name: "note_write_batch",
          description: "Write a note onto each of many items",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args as never }),
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test note batch resume.",
          }),
        describeAction: () => [
          {
            id: "save_notes_batch:0",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "save_notes_batch",
            source: "library_mutation",
            requestedTargets: ["item:2"],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => ({
          content: { createdCount: 1, alreadySavedCount: 1 },
          effect: "applied",
          batchItems: resumedItems,
        }),
      } as never);
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            if (steps++ === 0) {
              const call = {
                id: "note-batch-resume",
                name: "note_write_batch",
                arguments: { resumeBatchId: "batch-note_write_batch-1" },
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Finished the batch.",
              assistantMessage: {
                role: "assistant",
                content: "Finished the batch.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 774423,
          mode: "agent",
          userText: "Finish that batch",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: 100 },
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(outcome.kind, "completed");

      const announced = events.filter(
        (event) => event.type === "batch_item_outcome",
      ) as Extract<AgentEvent, { type: "batch_item_outcome" }>[];
      assert.deepEqual(
        announced.map((event) => event.status),
        ["saved", "saved"],
      );
      // Anything rendering these as "what just happened" must read `written`;
      // the status alone would show the same note being written twice.
      assert.deepEqual(
        announced.map((event) => ({
          itemKey: event.itemKey,
          written: event.written,
        })),
        [
          { itemKey: "item:1", written: false },
          { itemKey: "item:2", written: true },
        ],
      );
      const persisted = (await getAgentRunTrace(outcome.runId)).events
        .filter((entry) => entry.eventType === "batch_item_outcome")
        .map(
          (entry) =>
            (
              entry.payload as Extract<
                AgentEvent,
                { type: "batch_item_outcome" }
              >
            ).written,
        );
      assert.deepEqual(
        persisted,
        [false, true],
        "the distinction survives into the durable trace",
      );
    } finally {
      restoreDb();
    }
  });

  /** Turn 1 finalizes a direct document through the real submit_document tool. */
  async function runFinalizingTurn(
    conversationKey: number,
  ): Promise<{ documentId: string; materialRef: MaterialRef }> {
    const registry = new AgentToolRegistry();
    registry.register(createSubmitDocumentTool(submitDocumentGateway));
    const events: AgentEvent[] = [];
    let steps = 0;
    const runtime = new AgentRuntime({
      registry,
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(): Promise<AgentModelStep> {
          if (steps++ === 0) {
            const call = {
              id: "submit-document-1",
              name: "submit_document",
              arguments: {
                documentKind: "guide",
                integrityPolicy: "authored",
                title: "Representational drift",
                markdown: "# Representational drift\n\nA complete guide.",
                citations: [],
                quotes: [],
                assets: [],
                groundingReviewed: "passed",
                groundingIssues: [],
              },
            };
            return {
              kind: "tool_calls",
              calls: [call],
              assistantMessage: {
                role: "assistant",
                content: "",
                tool_calls: [call],
              },
            };
          }
          return {
            kind: "final",
            text: "Unreachable: submit_document ends the turn.",
            assistantMessage: {
              role: "assistant",
              content: "Unreachable: submit_document ends the turn.",
            },
          };
        },
      }),
    });
    const outcome = await runtime.runTurn({
      request: {
        conversationKey,
        mode: "agent",
        userText: "Write a guide about representational drift",
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: 100 },
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(outcome.kind, "completed");
    const announced = events.find(
      (event) => event.type === "material_finalized",
    ) as Extract<AgentEvent, { type: "material_finalized" }> | undefined;
    assert.exists(announced, "turn 1 must finalize material");
    return {
      runId: outcome.runId,
      documentId: announced!.materialRef.documentId,
      materialRef: announced!.materialRef,
    };
  }

  const BLOCK_HEADER = "Finalized material available (not saved as a note):";

  /** A plain turn whose adapter answers immediately; returns its prompt. */
  async function runPlainTurn(
    conversationKey: number,
    userText: string,
    sourceMessageTimestamp: number,
  ): Promise<{
    request: AgentRuntimeRequest | undefined;
    promptMessages: AgentModelMessage[];
  }> {
    const registry = new AgentToolRegistry();
    registry.register(createSubmitDocumentTool(submitDocumentGateway));
    let request: AgentRuntimeRequest | undefined;
    let promptMessages: AgentModelMessage[] = [];
    const runtime = new AgentRuntime({
      registry,
      adapterFactory: (resolved) => {
        request = resolved;
        return {
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            promptMessages = params.messages;
            return {
              kind: "final",
              text: "Acknowledged.",
              assistantMessage: { role: "assistant", content: "Acknowledged." },
            };
          },
        };
      },
    });
    const outcome = await runtime.runTurn({
      request: {
        conversationKey,
        mode: "agent",
        userText,
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp },
      },
    });
    assert.equal(outcome.kind, "completed");
    return { request, promptMessages };
  }

  function countBlocks(messages: readonly AgentModelMessage[]): number {
    return messages.filter((message) =>
      String(message.content).includes(BLOCK_HEADER),
    ).length;
  }

  it("tells the next turn which finalized material is still unsaved, without persisting the block", async function () {
    const installed = installMockDb();
    const restoreDocuments = installAgentStoreSqlite();
    clearAgentTranscriptStore();
    try {
      await initPlanDocumentStore();
      const conversationKey = 774412;
      const { runId, documentId, materialRef } =
        await runFinalizingTurn(conversationKey);

      const second = await runPlainTurn(
        conversationKey,
        "Save that as a note",
        200,
      );
      assert.deepEqual(
        second.request?.materialOutcomes?.map((entry) => ({
          documentId: entry.materialRef.documentId,
          status: entry.status,
        })),
        [{ documentId, status: "finalized" }],
        "the ledger is exposed on the request the turn ran with",
      );

      assert.equal(
        countBlocks(second.promptMessages),
        1,
        "the next turn's prompt names the unsaved material exactly once",
      );
      const blockIndex = second.promptMessages.findIndex((message) =>
        String(message.content).includes(BLOCK_HEADER),
      );
      assert.isTrue(
        (second.promptMessages[blockIndex] as { transient?: boolean })
          .transient,
        "the block is marked transient, so no checkpoint can copy it into the transcript",
      );
      const block = String(second.promptMessages[blockIndex]?.content);
      assert.include(
        block,
        `documentId=${documentId} version=${materialRef.documentVersion} hash=${materialRef.contentHash} title="Representational drift" status=finalized`,
      );
      assert.include(
        block,
        "If the user asks to save it, call note_write with that documentId; do not regenerate it.",
      );
      assert.include(
        String(second.promptMessages[blockIndex + 1]?.content),
        "Save that as a note",
        "the host block sits immediately before this turn's user message",
      );
      const persisted = readPersistedTranscript(installed, conversationKey)
        .map((message) => String(message.content))
        .join("\n");
      assert.notInclude(
        persisted,
        BLOCK_HEADER,
        "the block is recomputed every turn, so it must never enter the transcript",
      );

      // A third turn must not stack a second copy: if the block were durable,
      // the prompt would carry one per turn while the material stays unsaved.
      const third = await runPlainTurn(conversationKey, "And now?", 300);
      assert.equal(
        countBlocks(third.promptMessages),
        1,
        "a later turn still names the material exactly once",
      );
      assert.notInclude(
        readPersistedTranscript(installed, conversationKey)
          .map((message) => String(message.content))
          .join("\n"),
        BLOCK_HEADER,
      );

      // Once the material is written, no turn may still tell the model to
      // save it -- a stale copy is what makes a second, unrequested note.
      await appendAgentRunEvent(runId, 100, {
        type: "tool_result",
        callId: "note-write-1",
        name: "note_write",
        ok: true,
        actionReceipts: [
          {
            version: 2,
            id: "receipt:saved",
            proposalId: "proposal:saved",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            verification: "verified",
            status: "applied",
            requestedTargets: ["item:101"],
            appliedTargets: ["item:101"],
            alreadySatisfiedTargets: [],
            rejectedTargets: [],
            reasons: [],
            materialRef,
          },
        ],
        content: { noteId: 501 },
      });
      const fourth = await runPlainTurn(conversationKey, "Thanks", 400);
      assert.deepEqual(
        fourth.request?.materialOutcomes?.map((entry) => entry.status),
        ["saved"],
      );
      assert.equal(
        countBlocks(fourth.promptMessages),
        0,
        "saved material is never offered for saving again",
      );
    } finally {
      restoreDocuments();
      installed();
    }
  });

  const BATCH_HEADER = "Resumable note batches:";

  /** Seeds one interrupted batch: A saved, B failed, C never attempted. */
  async function seedInterruptedBatch(
    conversationKey: number,
    batchId: string,
  ): Promise<void> {
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await createBatchJob({
      jobId: batchId,
      conversationKey,
      action: "note_write_batch",
      input: { target: "item" },
      totalCount: 3,
      now: 1000,
    });
    await createBatchItems(
      batchId,
      [1, 2, 3].map((id) => ({
        itemKey: `item:${id}`,
        position: id,
        materialRef: {
          documentId: `run-batch:document:${id}`,
          documentVersion: 1,
          contentHash: `sha256:note-${id}`,
        },
      })),
      1000,
    );
    await markBatchItemSaved(batchId, "item:1", {
      actionId: "action-batch",
      stepSequence: 1,
      noteId: 900,
      now: 1100,
    });
    await markBatchItemFailed(batchId, "item:2", {
      actionId: "action-batch",
      stepSequence: 2,
      error: "Zotero refused the note write",
      now: 1100,
    });
  }

  it("tells the next turn which note batch it can continue, and where", async function () {
    const installed = installMockDb();
    const restoreStores = installAgentStoreSqlite();
    clearAgentTranscriptStore();
    try {
      await initPlanDocumentStore();
      const conversationKey = 774413;
      const batchId = "batch-note_write_batch-resume";
      await seedInterruptedBatch(conversationKey, batchId);

      const next = await runPlainTurn(conversationKey, "Keep going", 200);
      const blockIndex = next.promptMessages.findIndex((message) =>
        String(message.content).includes(BATCH_HEADER),
      );
      assert.isAtLeast(blockIndex, 0, "the turn must name the open batch");
      const block = String(next.promptMessages[blockIndex]?.content);
      assert.include(
        block,
        `batchId=${batchId} total=3 saved=1 failed=1 pending=1`,
      );
      assert.include(
        block,
        `To continue, call note_write_batch with resumeBatchId=${batchId}; the saved items are skipped and no note is regenerated.`,
      );
      assert.isTrue(
        (next.promptMessages[blockIndex] as { transient?: boolean }).transient,
        "the rows are read again every turn, so the block must never persist",
      );
      assert.include(
        String(next.promptMessages[blockIndex + 1]?.content),
        "Keep going",
        "the host block sits immediately before this turn's user message",
      );
      assert.notInclude(
        readPersistedTranscript(installed, conversationKey)
          .map((message) => String(message.content))
          .join("\n"),
        BATCH_HEADER,
      );

      // Once every item has landed there is nothing to continue, and an
      // offer to resume would write the same three notes a second time.
      await markBatchItemSaved(batchId, "item:2", {
        actionId: "action-batch",
        stepSequence: 3,
        noteId: 901,
        now: 1200,
      });
      await markBatchItemSaved(batchId, "item:3", {
        actionId: "action-batch",
        stepSequence: 4,
        noteId: 902,
        now: 1200,
      });
      const after = await runPlainTurn(conversationKey, "And now?", 300);
      assert.isEmpty(
        after.promptMessages.filter((message) =>
          String(message.content).includes(BATCH_HEADER),
        ),
        "a batch whose items are all written is never offered",
      );
    } finally {
      restoreStores();
      installed();
    }
  });

  it("carries the material ref on the final event when a later turn re-adopts the document", async function () {
    const installed = installMockDb();
    const restoreStores = installPlanSqlite();
    clearAgentTranscriptStore();
    try {
      await initAgentPlanStore();
      await initPlanDocumentStore();
      await initResearchStore();
      const conversationKey = 41;
      const { documentId, materialRef } =
        await runFinalizingTurn(conversationKey);
      // Only a plan-executing turn keeps a progress ledger across runs; an
      // ordinary turn discards any contract it is handed (runtime.ts clears
      // actionContract/actionProgress/classifiedIntent before the model runs).
      const plan = await createDocumentPlan(conversationKey);

      const registry = new AgentToolRegistry();
      registry.register(createSubmitDocumentTool(submitDocumentGateway));
      const events: AgentEvent[] = [];
      const secondTurn = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            return {
              kind: "final",
              text: "The guide is ready.",
              assistantMessage: {
                role: "assistant",
                content: "The guide is ready.",
              },
            };
          },
        }),
      });
      const intent = classifiedFixture({
        semantic: semanticFixture({
          materialOutputs: [
            {
              id: "guide",
              description: "The requested guide",
              afterActions: [],
              sourceActionIndexes: [],
              requiredEvidence: "none",
            },
          ],
        }),
      });
      await secondTurn.runTurn({
        request: {
          conversationKey,
          mode: "agent",
          userText: "Continue the approved plan",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: 200 },
          planContext: {
            phase: "executing",
            planId: plan.planId,
            revision: plan.revision,
            executionId: plan.executionId,
            approvedDigest: plan.planDigest,
            provider: "original",
          },
          actionContract: {
            version: 4,
            id: "contract:reused",
            interpretationSource: "semantic",
            writeDisposition: "none",
            intent,
            obligations: [],
          },
          actionProgress: {
            version: 1,
            contractId: "contract:reused",
            state: "pending",
            correctionCount: 0,
            obligations: [],
            appliedReceiptKeys: [],
            materialOutputs: [{ outputId: "guide", ...materialRef }],
          },
        },
        onEvent: (event) => events.push(event),
      });

      const finalEvent = events.find((event) => event.type === "final") as
        | Extract<AgentEvent, { type: "final" }>
        | undefined;
      assert.equal(
        finalEvent?.documentId,
        documentId,
        "the re-adopted document must name the turn's outcome",
      );
      assert.deepEqual(
        finalEvent?.materialRef,
        materialRef,
        "re-adopted material keeps the exact identity turn 1 finalized",
      );
    } finally {
      restoreStores();
      installed();
    }
  });
});

/**
 * The stage events the trace groups by.
 *
 * A stage event is emitted immediately before the event it describes, so a
 * live run and a projected legacy run interleave identically.
 */
describe("agent stage events", function () {
  type StageEvent = Extract<AgentEvent, { type: "agent_stage" }>;

  function stageEvents(events: AgentEvent[]): StageEvent[] {
    return events.filter(
      (event): event is StageEvent => event.type === "agent_stage",
    );
  }

  function registerStageReadTool(registry: AgentToolRegistry): void {
    registry.register({
      spec: {
        name: "library_search",
        description: "search",
        inputSchema: { type: "object" },
        executionClass: "read",
        workCategory: "retrieval",
      },
      presentation: { label: "Search library" },
      validate: (args) => ({ ok: true, value: args as never }),
      execute: async () => ({ content: { hits: [] } }),
    } as never);
  }

  function registerStageNoteTool(registry: AgentToolRegistry): void {
    registry.register({
      effectOperations: ["note_create"],
      spec: {
        name: "note_write",
        description: "write a note",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        workCategory: "zotero_action",
        requiresConfirmation: false,
      },
      presentation: { label: "Write note" },
      validate: (args) => ({ ok: true, value: args as never }),
      planInvocation: async () =>
        stateChangeInvocationPlan({
          reversibility: "full",
          reason: "Test note write.",
        }),
      describeAction: () => [
        {
          id: "note_create:stage-test",
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation: "note_create",
          source: "zotero_native",
          requestedTargets: [],
          destinationCollectionIds: [],
        },
      ],
      execute: async () => ({
        content: { status: "created", noteId: 900 },
        effect: "applied",
      }),
    } as never);
  }

  function toolCallStep(id: string, name: string): AgentModelStep {
    const call = { id, name, arguments: {} };
    return {
      kind: "tool_calls",
      calls: [call],
      assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
    };
  }

  it("brackets a read and a note write with their own stages", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerStageReadTool(registry);
      registerStageNoteTool(registry);
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("read-1", "library_search"),
              toolCallStep("write-1", "note_write"),
              {
                kind: "final",
                text: "Done.",
                assistantMessage: { role: "assistant", content: "Done." },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 990_101,
          mode: "agent",
          libraryID: 1,
          userText: "Find it and note it",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(outcome.kind, "completed");

      const stages = stageEvents(events);
      assert.deepEqual(
        stages.map((event) => [event.stage, event.status]),
        [
          ["retrieval", "started"],
          ["retrieval", "completed"],
          ["zotero_action", "started"],
          ["zotero_action", "completed"],
        ],
        "each resolved call opens and closes exactly one stage",
      );
      assert.deepEqual(
        stages.map((event) => event.toolLabel),
        ["Search library", "Search library", "Write note", "Write note"],
        "the label is stamped at emission, never re-derived from the name",
      );
      assert.deepEqual(
        stages.map((event) => event.callId),
        ["read-1", "read-1", "write-1", "write-1"],
      );
      assert.deepEqual(
        stages.map((event) => event.toolName),
        ["library_search", "library_search", "note_write", "note_write"],
      );

      const writeResult = events.find(
        (event) => event.type === "tool_result" && event.name === "note_write",
      ) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
      assert.isNotEmpty(
        writeResult?.actionReceipts || [],
        "the note write must produce a receipt for the stage to carry",
      );
      assert.deepEqual(
        stages[3].receiptIds,
        (writeResult?.actionReceipts || []).map((receipt) => receipt.id),
        "the closing stage carries the receipts its call produced",
      );
      assert.isUndefined(
        stages[0].receiptIds,
        "a read produces no receipts to carry",
      );

      const types = events.map((event) => event.type);
      const firstStage = types.indexOf("agent_stage");
      assert.equal(
        types[firstStage + 1],
        "tool_call",
        "a stage event precedes the event it describes",
      );
      assert.equal(
        types[types.indexOf("tool_result") - 1],
        "agent_stage",
        "the closing stage precedes the result it describes",
      );

      assert.deepEqual(
        events
          .filter((event) => event.type === "tool_call")
          .map((event) => event.toolLabel),
        ["Search library", "Write note"],
        "tool calls carry their label at emission",
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "tool_result")
          .map((event) => event.toolLabel),
        ["Search library", "Write note"],
        "tool results carry their label at emission",
      );

      const trace = await getAgentRunTrace(outcome.runId);
      assert.deepEqual(
        trace.events
          .filter((entry) => entry.eventType === "agent_stage")
          .map((entry) => entry.payload),
        stages,
        "a replayed stage event is structurally identical to the live one",
      );
    } finally {
      restoreDb();
    }
  });

  it("closes a failed call's stage as failed and carries its label", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        presentation: { label: "Search library" },
        validate: (args) => ({ ok: true, value: args as never }),
        execute: async () => {
          throw new Error("the library is unavailable");
        },
      } as never);
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("read-1", "library_search"),
              {
                kind: "final",
                text: "Could not read.",
                assistantMessage: {
                  role: "assistant",
                  content: "Could not read.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 990_102,
          mode: "agent",
          userText: "Find it",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => events.push(event),
      });

      assert.deepEqual(
        stageEvents(events).map((event) => [event.stage, event.status]),
        [
          ["retrieval", "started"],
          ["retrieval", "failed"],
        ],
      );
      assert.equal(
        events.find((event) => event.type === "tool_error")?.toolLabel,
        "Search library",
      );

      // The close describes the result, not the error: the error is a detail
      // inside the still-open stage.
      const persisted = (await getAgentRunTrace(outcome.runId)).events
        .slice()
        .sort((left, right) => left.seq - right.seq);
      const firstStage = persisted.findIndex(
        (entry) => entry.eventType === "agent_stage",
      );
      assert.isAtLeast(firstStage, 0, "the run must persist a stage event");
      assert.deepEqual(
        persisted.slice(firstStage, firstStage + 5).map((entry) => {
          const payload = entry.payload;
          return payload.type === "agent_stage"
            ? `agent_stage:${payload.status}`
            : payload.type;
        }),
        [
          "agent_stage:started",
          "tool_call",
          "tool_error",
          "agent_stage:failed",
          "tool_result",
        ],
      );
    } finally {
      restoreDb();
    }
  });

  it("emits no stage for a call the registry cannot resolve", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerStageReadTool(registry);
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("ghost-1", "no_such_tool"),
              {
                kind: "final",
                text: "Done.",
                assistantMessage: { role: "assistant", content: "Done." },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 990_103,
          mode: "agent",
          userText: "Do something",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => events.push(event),
      });
      assert.isEmpty(
        stageEvents(events),
        "an unresolvable call must never guess a stage",
      );
    } finally {
      restoreDb();
    }
  });

  it("reports no stage for a batch item this run has not written", async function () {
    const restoreDb = installMockDb();
    const batchItems = [
      {
        batchId: "batch-stage-1",
        itemKey: "item:saved",
        materialRef: {
          documentId: "run:document:1",
          documentVersion: 1,
          contentHash: "sha256:note-1",
        },
        status: "saved" as const,
        written: true,
        noteId: 601,
      },
      {
        batchId: "batch-stage-1",
        itemKey: "item:pending",
        status: "pending" as const,
        written: false,
      },
      {
        batchId: "batch-stage-1",
        itemKey: "item:failed",
        status: "failed" as const,
        written: false,
        error: "Zotero refused the note write",
      },
    ];
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["save_notes_batch"],
        spec: {
          name: "note_write_batch",
          description: "Write a note onto each of many items",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          workCategory: "zotero_action",
          requiresConfirmation: false,
        },
        presentation: { label: "Write notes" },
        validate: (args) => ({ ok: true, value: args as never }),
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test note batch.",
          }),
        describeAction: () => [
          {
            id: "save_notes_batch:stage",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "save_notes_batch",
            source: "library_mutation",
            requestedTargets: ["item:saved", "item:pending", "item:failed"],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => ({
          content: { createdCount: 1, failedCount: 1 },
          effect: "partial",
          batchItems,
        }),
      } as never);
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("batch-1", "note_write_batch"),
              {
                kind: "final",
                text: "Wrote what I could.",
                assistantMessage: {
                  role: "assistant",
                  content: "Wrote what I could.",
                },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 990_105,
          mode: "agent",
          libraryID: 1,
          userText: "Note each of these",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => events.push(event),
      });

      assert.deepEqual(
        events
          .filter((event) => event.type === "batch_item_outcome")
          .map((event) => event.itemKey),
        ["item:saved", "item:pending", "item:failed"],
        "every item is still announced",
      );
      assert.deepEqual(
        stageEvents(events)
          .filter((event) => Boolean(event.itemKey))
          .map((event) => [event.itemKey, event.status]),
        [
          ["item:saved", "completed"],
          ["item:failed", "failed"],
        ],
        "a pending item reports no stage rather than a wrong one",
      );
    } finally {
      restoreDb();
    }
  });

  it("reports each plan event as a planning stage", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "plan_probe",
          description: "publish plan events",
          inputSchema: { type: "object" },
          executionClass: "control",
          workCategory: "planning",
        },
        presentation: { label: "Plan" },
        validate: (args) => ({ ok: true, value: args as never }),
        execute: async (_input: unknown, context: any) => {
          await context.publishPlanEvent?.({
            type: "plan_updated",
            artifact: { planId: "p1", revision: 1 } as never,
          });
          await context.publishPlanEvent?.({
            type: "plan_ready",
            artifact: { planId: "p1", revision: 1 } as never,
          });
          await context.publishPlanEvent?.({
            type: "plan_execution_updated",
            ledger: { executionId: "e1", tasks: [] } as never,
          });
          await context.publishPlanEvent?.({
            type: "plan_research_progress",
            progress: { researchJobId: "r1" } as never,
          });
          return { content: { ok: true } };
        },
      } as never);
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("plan-1", "plan_probe"),
              {
                kind: "final",
                text: "Planned.",
                assistantMessage: { role: "assistant", content: "Planned." },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 990_104,
          mode: "agent",
          userText: "Plan it",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => events.push(event),
      });

      const planning = stageEvents(events).filter(
        (event) => event.stage === "planning" && !event.callId,
      );
      assert.deepEqual(
        planning.map((event) => event.status),
        ["started", "completed"],
        "only a drafted revision and a reviewable plan move the stage",
      );
      const types = events.map((event) => event.type);
      assert.equal(
        types[types.indexOf("plan_updated") - 1],
        "agent_stage",
        "the planning stage precedes the plan event it describes",
      );
    } finally {
      restoreDb();
    }
  });
});

describe("tool result review delivery", function () {
  function toolCallStep(id: string, name: string): AgentModelStep {
    const call = { id, name, arguments: {} };
    return {
      kind: "tool_calls",
      calls: [call],
      assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
    };
  }

  function reviewAction(toolName: string) {
    return {
      toolName,
      title: "Review the results",
      mode: "review" as const,
      confirmLabel: "Use these",
      cancelLabel: "Cancel",
      fields: [],
      actions: [{ id: "use", label: "Use these" }],
    };
  }

  it("delivers a review's replacement content and both follow-up messages", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      let reviewsCreated = 0;
      registry.register({
        spec: {
          name: "literature_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        presentation: { label: "Search literature" },
        validate: (args) => ({ ok: true, value: args as never }),
        execute: async () => ({ content: { hits: ["raw"] } }),
        buildFollowupMessage: async () => ({
          role: "user",
          content: "tool-followup",
        }),
        createResultReviewAction: async () => {
          reviewsCreated += 1;
          return reviewAction("literature_search");
        },
        resolveResultReview: async () => ({
          kind: "deliver",
          toolMessageContent: { reviewed: ["kept"] },
          followupMessages: [{ role: "user", content: "review-followup" }],
        }),
      } as never);

      const events: AgentEvent[] = [];
      const modelInputs: AgentModelMessage[][] = [];
      const steps: AgentModelStep[] = [
        toolCallStep("call-review", "literature_search"),
        {
          kind: "final",
          text: "Done.",
          assistantMessage: { role: "assistant", content: "Done." },
        },
      ];
      let stepIndex = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            modelInputs.push(params.messages);
            const step = steps[stepIndex];
            stepIndex += 1;
            return step;
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 991_201,
          mode: "agent",
          libraryID: 1,
          userText: "Find papers",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "confirmation_required")
            runtime.resolveConfirmation(event.requestId, {
              approved: true,
              actionId: "use",
            });
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(reviewsCreated, 1, "the review card is built exactly once");
      assert.deepEqual(
        events
          .map((event) => event.type)
          .filter((type) =>
            [
              "tool_call",
              "tool_result",
              "confirmation_required",
              "confirmation_resolved",
            ].includes(type),
          ),
        [
          "tool_call",
          "tool_result",
          "confirmation_required",
          "confirmation_resolved",
        ],
        "the result is published before its review card is raised",
      );

      const secondStep = modelInputs[1];
      const toolMessage = secondStep.find(
        (message) => message.role === "tool",
      ) as Extract<AgentModelMessage, { role: "tool" }> | undefined;
      assert.equal(toolMessage?.tool_call_id, "call-review");
      assert.deepEqual(JSON.parse(String(toolMessage?.content)), {
        reviewed: ["kept"],
        actionReceipts: [],
      });
      assert.deepEqual(
        secondStep
          .filter(
            (message) =>
              message.role === "user" && typeof message.content === "string",
          )
          .map((message) => message.content)
          .filter(
            (content) =>
              content === "review-followup" || content === "tool-followup",
          ),
        ["review-followup", "tool-followup"],
        "the review's own follow-ups precede the tool's built one",
      );
    } finally {
      restoreDb();
    }
  });

  it("chains an approved review into another tool and reports its terminal text", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      const chainedInputs: unknown[] = [];
      registry.register({
        spec: {
          name: "literature_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        validate: (args) => ({ ok: true, value: args as never }),
        execute: async () => ({ content: { hits: ["raw"] } }),
        createResultReviewAction: async () => reviewAction("literature_search"),
        resolveResultReview: async () => ({
          kind: "invoke_tool",
          call: {
            name: "note_write",
            arguments: { text: "chained" },
            inheritedApproval: {
              sourceToolName: "literature_search",
              sourceActionId: "use",
              sourceMode: "review",
            },
          },
          terminalText: {
            onSuccess: "Saved the reviewed results.",
            onDenied: "Nothing was saved.",
            onError: "The save failed.",
          },
        }),
      } as never);
      registry.register({
        effectOperations: ["note_create"],
        spec: {
          name: "note_write",
          description: "write a note",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          workCategory: "zotero_action",
          requiresConfirmation: false,
        },
        presentation: { label: "Write note" },
        validate: (args) => ({ ok: true, value: args as never }),
        acceptInheritedApproval: () => true,
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test note write.",
          }),
        describeAction: () => [
          {
            id: "note_create:review-chain",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        execute: async (input: unknown) => {
          chainedInputs.push(input);
          return {
            content: { status: "created", noteId: 901 },
            effect: "applied",
          };
        },
      } as never);

      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolCallStep("call-review", "literature_search"),
              {
                kind: "final",
                text: "Unused.",
                assistantMessage: { role: "assistant", content: "Unused." },
              },
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 991_202,
          mode: "agent",
          libraryID: 1,
          userText: "Find papers and save them",
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
        },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "confirmation_required")
            runtime.resolveConfirmation(event.requestId, {
              approved: true,
              actionId: "use",
            });
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(
        outcome.kind === "completed" ? outcome.text : "",
        "Saved the reviewed results.",
        "the review's success text, not the provider's final step, ends the run",
      );
      assert.deepEqual(chainedInputs, [{ text: "chained" }]);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "tool_call" || event.type === "tool_result",
          )
          .map((event) => [
            event.type,
            (event as Extract<AgentEvent, { type: "tool_call" }>).name,
          ]),
        [
          ["tool_call", "literature_search"],
          ["tool_result", "literature_search"],
          ["tool_call", "note_write"],
          ["tool_result", "note_write"],
        ],
        "the chained call is executed and published like any other call",
      );
      const chainedCallEvent = events.find(
        (event) => event.type === "tool_call" && event.name === "note_write",
      ) as Extract<AgentEvent, { type: "tool_call" }>;
      assert.notEqual(
        chainedCallEvent.callId,
        "call-review",
        "the chained call carries its own synthetic id",
      );
      const noteReceipts = (
        events.find(
          (event) =>
            event.type === "tool_result" && event.name === "note_write",
        ) as Extract<AgentEvent, { type: "tool_result" }>
      ).actionReceipts;
      assert.isNotEmpty(
        noteReceipts || [],
        "the chained write still produces its receipt",
      );
    } finally {
      restoreDb();
    }
  });
});
