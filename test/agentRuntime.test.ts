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
import { declaredSemanticInterpreter } from "./helpers/semanticIntent";
import { actionFixture } from "./helpers/semanticIntent";
import { classifiedFixture } from "./helpers/semanticIntent";
import { semanticContractFixture } from "./helpers/semanticIntent";
import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { stripNoteHtml } from "../src/utils/noteText";
import { renderMarkdownForNote } from "../src/utils/markdown";
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
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import { AgentToolRegistry } from "../src/agent/tools/registry";
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
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";

type MockDbRow = Record<string, unknown>;

type InstalledMockDb = (() => void) & {
  runs: Map<string, MockDbRow>;
  events: MockDbRow[];
  transcripts: MockDbRow[];
  journalDb: ChangeJournalTestDb;
  setTranscriptWriteFailure: (enabled: boolean) => void;
  transcriptWriteAttempts: () => number;
};

function createTestActionContractService(
  getItem: (itemId: number) => Zotero.Item | null = () => null,
): ActionContractService {
  return new ActionContractService({
    getCollectionSummary: () => null,
    listCollectionSummaries: () => [],
    listCollectionPaperTargets: async () => ({ papers: [] }),
    listCollectionItemTargets: async () => ({ items: [] }),
    getItem,
    getEditableArticleMetadata: () => null,
  });
}

function registerZeroEffectLibraryUpdate(registry: AgentToolRegistry): void {
  registry.register({
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

function installMockDb(): InstalledMockDb {
  const runs = new Map<string, MockDbRow>();
  const events: MockDbRow[] = [];
  const transcripts: MockDbRow[] = [];
  const prefs = new Map<string, unknown>();
  const journalDb = new ChangeJournalTestDb();
  let failTranscriptWrites = false;
  let transcriptWriteAttempts = 0;
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (
          sql.includes("llm_for_zotero_agent_transcript") &&
          (sql.includes("DELETE FROM") || sql.includes("INSERT INTO"))
        ) {
          transcriptWriteAttempts += 1;
          if (failTranscriptWrites) {
            throw new Error("Injected transcript write failure");
          }
        }
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
        if (
          sql.includes("UPDATE llm_for_zotero_agent_runs") &&
          sql.includes("WHERE status = 'running'")
        ) {
          for (const run of runs.values()) {
            if (run.status !== "running") continue;
            run.status = params[0];
            run.completedAt = params[1];
            run.finalText = params[2];
          }
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
          sql.includes("agent_runs") &&
          sql.includes("WHERE conversation_key = ?")
        ) {
          return [...runs.values()]
            .filter((run) => Number(run.conversationKey) === Number(params[0]))
            .sort(
              (left, right) => Number(right.createdAt) - Number(left.createdAt),
            )
            .slice(0, 1);
        }
        if (
          sql.includes("SELECT run_id AS runId") &&
          sql.includes("agent_runs")
        ) {
          const run = runs.get(String(params[0]));
          return run ? [run] : [];
        }
        if (sql.includes("DELETE FROM llm_for_zotero_agent_transcript")) {
          for (let index = transcripts.length - 1; index >= 0; index -= 1) {
            if (
              Number(transcripts[index].conversationKey) ===
                Number(params[0]) &&
              transcripts[index].compatibilityKey === params[1]
            ) {
              transcripts.splice(index, 1);
            }
          }
          return [];
        }
        if (sql.includes("INSERT INTO llm_for_zotero_agent_transcript")) {
          transcripts.push({
            conversationKey: params[0],
            compatibilityKey: params[1],
            sequence: params[2],
            messageJson: params[3],
            compactedAt: params[4],
            createdAt: params[5],
          });
          return [];
        }
        if (
          sql.includes("FROM llm_for_zotero_agent_transcript") &&
          sql.includes("ORDER BY created_at DESC")
        ) {
          return transcripts
            .filter(
              (row) =>
                Number(row.conversationKey) === Number(params[0]) &&
                typeof row.compatibilityKey === "string",
            )
            .sort(
              (left, right) =>
                Number(right.createdAt) - Number(left.createdAt) ||
                transcripts.indexOf(right) - transcripts.indexOf(left),
            )
            .slice(0, 1)
            .map((row) => ({ compatibilityKey: row.compatibilityKey }));
        }
        if (sql.includes("FROM llm_for_zotero_agent_transcript")) {
          return transcripts
            .filter(
              (row) =>
                Number(row.conversationKey) === Number(params[0]) &&
                row.compatibilityKey === params[1],
            )
            .sort(
              (left, right) => Number(left.sequence) - Number(right.sequence),
            );
        }
        return journalDb.queryAsync(sql, params);
      },
    },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => {
        prefs.set(key, value);
      },
    },
  };
  const restore = () => {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  };
  return Object.assign(restore, {
    runs,
    events,
    transcripts,
    journalDb,
    setTranscriptWriteFailure: (enabled: boolean) => {
      failTranscriptWrites = enabled;
    },
    transcriptWriteAttempts: () => transcriptWriteAttempts,
  });
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

  it("preserves the prior workflow when a continuation fails before interpretation", async function () {
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
        semanticInterpreter: {
          interpret: async () => ({
            skillIds: [],
            classifiedIntent: null,
            degraded: true,
            failureReason: "unparseable",
          }),
        },
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

  it("does not end a compound action when its document is finalized before the library effect", async function () {
    const restore = installMockDb();
    let steps = 0;
    try {
      const registry = new AgentToolRegistry(
        createRequiredMoveActionContractService(),
      );
      registry.register({
        spec: {
          name: "submit_document",
          description: "Finalize material",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({
          documentId: "durable-before-filing",
          visibleMarkdown: "Finalized material.",
        }),
        resolveTerminalResult: () => ({
          documentId: "durable-before-filing",
          finalText: "Finalized material.",
          providerTranscript: "tool_only",
        }),
      });
      const runtime = new AgentRuntime({
        registry,
        semanticInterpreter: declaredSemanticInterpreter,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(): Promise<AgentModelStep> {
            steps++;
            if (steps === 1)
              return {
                kind: "tool_calls",
                calls: [
                  { id: "finalize", name: "submit_document", arguments: {} },
                ],
                assistantMessage: { role: "assistant", content: "" },
              };
            return {
              kind: "final",
              text: "The document is ready; filing is not done.",
              assistantMessage: {
                role: "assistant",
                content: "The document is ready; filing is not done.",
              },
            };
          },
        }),
      });
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 998802,
          mode: "agent",
          userText: "Prepare a report and file the paper",
          model: "gpt-4o-mini",
          apiKey: "test",
          apiBase: "https://example.invalid",
          libraryID: 1,
          classifiedIntent: classifiedFixture({
            deliverableIntent: "document",
            documentKind: "report",
          }),
        },
      });
      assert.isAbove(
        steps,
        1,
        "Finalizing material must leave the unfinished action available to execute",
      );
      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.documentId, "durable-before-filing");
      assert.include(outcome.text, "Finalized material.");
      assert.equal(
        (await getAgentRunTrace(outcome.runId)).run?.status,
        "failed",
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
          semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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

  it("fails visibly instead of falling back to prose for a required document", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry: new AgentToolRegistry(createTestActionContractService()),
        adapterFactory: () =>
          new MockAdapter([], {
            streaming: false,
            toolCalls: false,
            multimodal: false,
          }),
      });
      let failure = "";
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture({
              deliverableIntent: "document",
              documentKind: "report",
            }),
            conversationKey: 2,
            libraryID: 1,
            mode: "agent",
            userText: "Write a report about this topic",
          },
        });
      } catch (error) {
        failure = String(error);
      }

      assert.match(failure, /does not support Agent tools/);
      const run = [...restoreDb.runs.values()].find(
        (entry) => Number(entry.conversationKey) === 2,
      );
      assert.equal(run?.status, "failed");
      assert.match(String(run?.finalText), /cannot be produced/);
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
          {
            retrieveEvidence: async () => [
              {
                paperContext,
                chunkIndex: 0,
                text: "The method used a stable readout.",
                score: 1,
                sourceLabel: "Issue 393 paper",
              },
            ],
          } as never,
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
        semanticInterpreter: declaredSemanticInterpreter,
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

  it("emits explicitly forced slash skills when automatic routing is unavailable", async function () {
    const restoreDb = installMockDb();
    setUserSkills(
      Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
    );
    try {
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        spec: {
          name: "mutate_library",
          description: "mutate",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        "Saved.\n\n[Action status: note_create — applied 1/1; verified; proof:zotero_state]",
      );
      assert.isTrue(events.some((event) => event.type === "tool_call"));
      assert.isTrue(events.some((event) => event.type === "tool_result"));
      const toolResultIndex = events.findIndex(
        (event) => event.type === "tool_result",
      );
      const toolResultEvent = events[toolResultIndex];
      const postToolContractIndex = events.findIndex(
        (event, index) =>
          index > toolResultIndex &&
          event.type === "provider_event" &&
          event.providerType === "agent_action_contract",
      );
      assert.isAtLeast(toolResultIndex, 0);
      assert.isAbove(postToolContractIndex, toolResultIndex);
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
          semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
          semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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

  it("issues one corrective continuation when an Obsidian note request finishes without a file write", async function () {
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

      const registry = new AgentToolRegistry(createTestActionContractService());
      const writes: unknown[] = [];
      registry.register({
        spec: {
          name: "file_io",
          description: "file io",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        planInvocation: async () =>
          stateChangeInvocationPlan({
            reversibility: "full",
            reason: "Test file write.",
          }),
        describeAction: (input) => [
          {
            id: `file_write:${String((input as { filePath?: unknown }).filePath || "")}`,
            proofDomain: "file_state",
            capability: "file.write",
            operation: "file_write",
            source: "file_io",
            parameters: {
              filePath: String(
                (input as { filePath?: unknown }).filePath || "",
              ),
            },
            requestedTargets: [
              `file:${String((input as { filePath?: unknown }).filePath || "")}`,
            ],
            destinationCollectionIds: [],
          },
        ],
        execute: async (input) => {
          writes.push(input);
          return {
            content: {
              ...(input as Record<string, unknown>),
              exists: true,
              expectedContentHash: "verified-hash",
              contentHash: "verified-hash",
            },
            effect: "applied",
          };
        },
      });

      let stepIndex = 0;
      let sawCorrectivePrompt = false;
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
              return {
                kind: "final",
                text: "## Figure 2\nDraft body in chat.",
                assistantMessage: {
                  role: "assistant",
                  content: "## Figure 2\nDraft body in chat.",
                },
              };
            }
            sawCorrectivePrompt = params.messages.some(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("open typed obligation(s)"),
            );
            if (stepIndex === 2) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-write",
                    name: "file_io",
                    arguments: {
                      action: "write",
                      filePath: "/tmp/obsidian-vault/Figure 2.md",
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
                        filePath: "/tmp/obsidian-vault/Figure 2.md",
                        content: "## Figure 2\nGrounded note.",
                      },
                    },
                  ],
                },
              };
            }
            return {
              kind: "final",
              text: "Saved.",
              assistantMessage: {
                role: "assistant",
                content: "Saved.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("file_write", undefined, {
            noteDestination: "file",
          }),
          conversationKey: 1,
          mode: "agent",
          userText: "help me write an explanation of figure 2 to my obsidian",
          forcedSkillIds: ["write-note"],
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "Saved.");
      assert.include(outcome.text, "file_write — applied");
      assert.isTrue(sawCorrectivePrompt);
      assert.deepEqual(writes, [
        {
          action: "write",
          filePath: "/tmp/obsidian-vault/Figure 2.md",
          content: "## Figure 2\nGrounded note.",
        },
      ]);
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
        semanticInterpreter: declaredSemanticInterpreter,
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

  it("preserves an informational final after unrelated exploratory actions are blocked", async function () {
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        "Unrelated effects are blocked before review.",
      );
      assert.equal(
        paperReads,
        1,
        "the identical second read must reuse the turn-local evidence handle",
      );
      assert.equal(effectExecutions, 0);
      assert.isFalse(events.some((event) => event.type === "message_rollback"));
      assert.equal(modelSteps, 5, "the substantive final must not be retried");
      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, substantiveAnswer);
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
        semanticInterpreter: declaredSemanticInterpreter,
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

  it("requires paper_read full before completing an explicit Agent full-text request", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      const reads: unknown[] = [];
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        execute: async (input) => {
          reads.push(input);
          return {
            mode: "full",
            status: "complete",
            coverageReceipt: {
              complete: true,
              processedChunks: 8,
              totalChunks: 8,
            },
          };
        },
      });

      let stepIndex = 0;
      let sawCorrection = false;
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
              return {
                kind: "final",
                text: "Here is a summary.",
                assistantMessage: {
                  role: "assistant",
                  content: "Here is a summary.",
                },
              };
            }
            sawCorrection = params.messages.some(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("open typed obligation(s)"),
            );
            if (stepIndex === 2) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-full-read",
                    name: "paper_read",
                    arguments: { mode: "full" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-full-read",
                      name: "paper_read",
                      arguments: { mode: "full" },
                    },
                  ],
                },
              };
            }
            return {
              kind: "final",
              text: "Grounded full-text answer.",
              assistantMessage: {
                role: "assistant",
                content: "Grounded full-text answer.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("read_full", undefined, {
            reading: { source: "document_text", coverage: "exhaustive" },
          }),
          conversationKey: 9,
          mode: "agent",
          conversationKind: "paper",
          activeItemId: 42,
          userText: "请先通读整篇论文，再回答问题。",
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "Grounded full-text answer.");
      assert.include(outcome.text, "read_full — observed; verified");
      assert.isTrue(sawCorrection);
      assert.deepEqual(reads, [{ mode: "full" }]);
    } finally {
      restoreDb();
    }
  });

  it("continues a rejected final without replaying the preceding tool result", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        execute: async (input) => ({
          mode: (input as { mode?: unknown }).mode,
          status: "complete",
          coverageReceipt: {
            complete: true,
            processedChunks: 2,
            totalChunks: 2,
          },
        }),
      });

      let stepIndex = 0;
      const continuationDeltas: AgentModelMessage[][] = [];
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
            continuationDeltas.push([...(params.continuationMessages || [])]);
            stepIndex += 1;
            if (stepIndex === 1) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-overview-read",
                    name: "paper_read",
                    arguments: { mode: "overview" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-overview-read",
                      name: "paper_read",
                      arguments: { mode: "overview" },
                    },
                  ],
                },
              };
            }
            if (stepIndex === 2) {
              return {
                kind: "final",
                text: "Premature answer from overview evidence.",
                assistantMessage: {
                  role: "assistant",
                  content: "Premature answer from overview evidence.",
                },
              };
            }
            if (stepIndex === 3) {
              return {
                kind: "tool_calls",
                calls: [
                  {
                    id: "call-full-read-after-correction",
                    name: "paper_read",
                    arguments: { mode: "full" },
                  },
                ],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call-full-read-after-correction",
                      name: "paper_read",
                      arguments: { mode: "full" },
                    },
                  ],
                },
              };
            }
            return {
              kind: "final",
              text: "Grounded answer after the full read.",
              assistantMessage: {
                role: "assistant",
                content: "Grounded answer after the full read.",
              },
            };
          },
        }),
      });

      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: actionFixture("read_full", undefined, {
            reading: { source: "document_text", coverage: "exhaustive" },
          }),
          conversationKey: 10,
          mode: "agent",
          conversationKind: "paper",
          activeItemId: 42,
          userText: "Read the complete paper before answering.",
          model: "deepseek-v4-pro",
          apiBase: "https://api.deepseek.com/anthropic",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.include(outcome.text, "Grounded answer after the full read.");
      assert.lengthOf(continuationDeltas, 4);
      assert.deepEqual(
        continuationDeltas[1].map((message) => message.role),
        ["tool"],
      );
      assert.deepEqual(
        continuationDeltas[2].map((message) => message.role),
        ["user"],
      );
      assert.notInclude(
        JSON.stringify(continuationDeltas[2]),
        "call-overview-read",
      );
      assert.include(
        JSON.stringify(continuationDeltas[2]),
        "open typed obligation(s)",
      );
      assert.deepEqual(
        continuationDeltas[3].map((message) => message.role),
        ["tool"],
      );
      assert.include(
        JSON.stringify(continuationDeltas[3]),
        "call-full-read-after-correction",
      );
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
        semanticInterpreter: declaredSemanticInterpreter,
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
      assert.isTrue(sawInitialZoteroRule);
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
            assert.include(
              serialized,
              "Agent semantic continuation checkpoint",
            );
            assert.notInclude(serialized, "durable result");
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
      assert.lengthOf(priorSemanticCheckpoints, 1, serialized);
      assert.notInclude(
        secondMessages.map((message) => message.role),
        "assistant",
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        if (message.role !== "user") installed.transcripts.splice(index, 1);
      }
      await initAgentTraceStore();
      clearAgentTranscriptStore();

      let continuedMessages: AgentModelMessage[] = [];
      const continuedRuntime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
        "Prior goal: run the recovery command to preserve this original goal",
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

  it("treats a durable semantic transaction checkpoint as already compacted", async function () {
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
        semanticInterpreter: declaredSemanticInterpreter,
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
          semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
      assert.equal(compactOutcome.text, "Nothing to compact yet");
      assert.isFalse(
        compactEvents.some(
          (event) =>
            event.type === "context_compacted" && event.automatic === false,
        ),
      );

      let followupMessages: AgentModelMessage[] = [];
      const followupRuntime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
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
        "Agent semantic continuation checkpoint",
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
    it(`${mode}: an unrequested typed write is ${mode === "yolo" ? "applied on judgment" : "refused"}`, async function () {
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
            writes++;
            return { content: { tagged: 1 }, effect: "applied" };
          },
        });
        const call = { id: "call-1", name: "tag_related", arguments: {} };
        const runtime = new AgentRuntime({
          semanticInterpreter: declaredSemanticInterpreter,
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
        if (mode === "yolo") {
          assert.equal(writes, 1);
          assert.isTrue(toolResult.ok);
          assert.equal(toolResult.authority, "yolo_judgment");
          assert.equal(outcome.kind, "completed");
        } else {
          assert.equal(writes, 0);
          assert.isFalse(toolResult.ok);
          assert.isUndefined(toolResult.authority);
        }
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
        spec: {
          name: "mutate_library",
          description: "mutate",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
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
        semanticInterpreter: declaredSemanticInterpreter,
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
      // The requested write runs on the contract's own authority; only the
      // action the user never asked for carries the judgment grant.
      assert.isUndefined(results[0].authority);
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        semanticInterpreter: declaredSemanticInterpreter,
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
      assert.lengthOf(transcript, 1);
      assert.equal(transcript[0]?.role, "user");
      assert.include(
        String(transcript[0]?.content || ""),
        "A supported current claim.",
      );
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
        semanticInterpreter: declaredSemanticInterpreter,
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

describe("shallow library answer guard", function () {
  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
  });

  const GUARD_CAPS = {
    streaming: false,
    toolCalls: true,
    multimodal: false,
    fileInputs: false,
    reasoning: true,
  };
  const GUARD_REQUEST = {
    classifiedIntent: classifiedFixture({ retrievalIntent: "summarize" }),
    conversationKey: 1,
    mode: "agent" as const,
    userText: "What methods do these papers share?",
    model: "gpt-4o-mini",
    apiBase: "https://api.openai.com/v1/chat/completions",
    apiKey: "test",
    selectedCollectionContexts: [{ collectionId: 3, name: "C", libraryID: 1 }],
  };
  const registerGuardRetrieve = (
    registry: AgentToolRegistry,
    result: unknown,
  ) => {
    registry.register({
      spec: {
        name: "library_retrieve",
        description: "retrieve",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => result,
    });
  };
  const finalStep = (text: string) => ({
    kind: "final" as const,
    text,
    assistantMessage: { role: "assistant" as const, content: text },
  });
  const retrieveCallStep = (id: string) => ({
    kind: "tool_calls" as const,
    calls: [{ id, name: "library_retrieve", arguments: {} }],
    assistantMessage: {
      role: "assistant" as const,
      content: "",
      tool_calls: [{ id, name: "library_retrieve", arguments: {} }],
    },
  });

  it("injects one correction when a collection-scoped evidence question skips retrieval", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registerGuardRetrieve(registry, {
        answerContract: { papersBodyRead: 3, papersPlanned: 5 },
        resourcePool: { states: { textAvailable: 5 }, queryCoverage: {} },
        snippets: [],
        warnings: [],
      });
      const stepMessages: AgentModelMessage[][] = [];
      const steps = [
        finalStep("Shallow answer."),
        retrieveCallStep("call-guard-1"),
        finalStep("Grounded answer."),
      ];
      let stepIndex = 0;
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: () => ({
          getCapabilities: () => GUARD_CAPS,
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            stepMessages.push(params.messages.slice());
            const step = steps[stepIndex];
            stepIndex += 1;
            return step;
          },
        }),
      });
      const outcome = await runtime.runTurn({
        request: { ...GUARD_REQUEST },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Grounded answer.");
      const lastMessages = stepMessages[stepMessages.length - 1];
      const corrections = lastMessages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Correction for this turn"),
      );
      assert.lengthOf(corrections, 1);
    } finally {
      restoreDb();
    }
  });

  it("accepts the next final unconditionally after one correction", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter(
            [finalStep("First answer."), finalStep("Second answer.")],
            GUARD_CAPS,
          ),
      });
      const outcome = await runtime.runTurn({
        request: { ...GUARD_REQUEST },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Second answer.");
    } finally {
      restoreDb();
    }
  });

  it("suppresses the guard when the classifier says the turn needs no retrieval", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter([finalStep("Direct answer.")], GUARD_CAPS),
      });
      const outcome = await runtime.runTurn({
        request: {
          ...GUARD_REQUEST,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "none",
            wantedSections: [],
          },
        },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Direct answer.");
    } finally {
      restoreDb();
    }
  });

  it("does not correct without a selected library scope", async function () {
    const restoreDb = installMockDb();
    try {
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter([finalStep("Direct answer.")], GUARD_CAPS),
      });
      const outcome = await runtime.runTurn({
        request: { ...GUARD_REQUEST, selectedCollectionContexts: [] },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Direct answer.");
    } finally {
      restoreDb();
    }
  });

  it("corrects a metadata-only retrieve for a classified summarize turn", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registerGuardRetrieve(registry, {
        answerContract: { papersBodyRead: 0, papersPlanned: 5 },
        resourcePool: { states: { textAvailable: 5 }, queryCoverage: {} },
        snippets: [],
        warnings: [],
      });
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              retrieveCallStep("call-guard-2"),
              finalStep("Metadata-only answer."),
              retrieveCallStep("call-guard-3"),
              finalStep("Still metadata."),
            ],
            GUARD_CAPS,
          ),
      });
      const outcome = await runtime.runTurn({
        request: {
          ...GUARD_REQUEST,
          classifiedIntent: {
            ...classifiedFixture(),
            semantic: semanticFixture(),
            retrievalIntent: "summarize",
            wantedSections: [],
          },
        },
        onEvent: () => {},
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Still metadata.");
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
        semanticInterpreter: declaredSemanticInterpreter,
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
  it("fails truthfully after one correction when a write has no verifiable receipt", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        createRequiredMoveActionContractService(),
      );
      registerZeroEffectLibraryUpdate(registry);

      let stepIndex = 0;
      let resolvedRequest: AgentRuntimeRequest | undefined;
      let correctionRequestMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: (request) => {
          resolvedRequest = request;
          return {
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              stepIndex += 1;
              if (stepIndex === 1) {
                return {
                  kind: "tool_calls",
                  calls: [
                    {
                      id: "c1",
                      name: "library_update",
                      arguments: { kind: "collections" },
                    },
                  ],
                  assistantMessage: { role: "assistant", content: "" },
                };
              }
              if (stepIndex === 2) {
                resolvedRequest!.actionProgress!.updatedAt = 11;
                await params.onTextDelta?.(
                  "Filed both papers into Neuroscience.",
                );
                return {
                  kind: "final",
                  text: "Filed both papers into Neuroscience.",
                  assistantMessage: {
                    role: "assistant",
                    content: "Filed both papers into Neuroscience.",
                  },
                };
              }
              assert.equal(resolvedRequest?.actionProgress?.correctionCount, 1);
              assert.isAbove(
                resolvedRequest?.actionProgress?.updatedAt || 0,
                11,
              );
              resolvedRequest!.actionProgress!.updatedAt = 22;
              correctionRequestMessages = structuredClone(params.messages);
              await params.onTextDelta?.(
                "Nothing changed — both items are the wrong type to file.",
              );
              return {
                kind: "final",
                text: "Nothing changed — both items are the wrong type to file.",
                assistantMessage: {
                  role: "assistant",
                  content:
                    "Nothing changed — both items are the wrong type to file.",
                },
              };
            },
          };
        },
      });

      const events: AgentEvent[] = [];
      const rollbackProgress: Array<{
        correctionCount: number | undefined;
        state: string | undefined;
        updatedAt: number | undefined;
      }> = [];
      const outcome = await runtime.runTurn({
        request: {
          classifiedIntent: classifiedFixture(),
          conversationKey: 991,
          mode: "agent",
          userText: "file these two papers into Neuroscience",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
          libraryID: 1,
        },
        onEvent: (event) => {
          events.push(event);
          if (event.type !== "message_rollback") return;
          const terminalSnapshot = [...events]
            .reverse()
            .find(
              (candidate) =>
                candidate.type === "provider_event" &&
                candidate.providerType === "agent_action_contract" &&
                typeof candidate.payload?.state === "string",
            );
          const progress = resolvedRequest?.actionProgress;
          rollbackProgress.push({
            correctionCount: progress?.correctionCount,
            state: progress?.state,
            updatedAt: progress?.updatedAt,
          });
          assert.equal(
            terminalSnapshot?.type === "provider_event"
              ? terminalSnapshot.payload?.state
              : undefined,
            "unverified",
          );
          assert.equal(
            progress?.state,
            "unverified",
            "the unverified obligation must remain nonterminal until rollback succeeds",
          );
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.notInclude(
        outcome.text,
        "Filed both papers",
        "the first, false claim must not be what the user is left with",
      );
      assert.include(outcome.text, "could not verify completion");
      assert.deepEqual(rollbackProgress, [
        { correctionCount: 0, state: "unverified", updatedAt: 11 },
        { correctionCount: 1, state: "unverified", updatedAt: 22 },
      ]);
      assert.equal(resolvedRequest?.actionProgress?.state, "failed");
      assert.isAbove(resolvedRequest?.actionProgress?.updatedAt || 0, 22);

      const falseFinalIndexes = correctionRequestMessages
        .map((message, index) =>
          message.role === "assistant" &&
          message.content === "Filed both papers into Neuroscience."
            ? index
            : -1,
        )
        .filter((index) => index >= 0);
      assert.lengthOf(falseFinalIndexes, 1);
      const falseFinalIndex = falseFinalIndexes[0];
      assert.isAtLeast(falseFinalIndex, 0);
      assert.equal(
        correctionRequestMessages[falseFinalIndex + 1]?.role,
        "user",
      );
      assert.match(
        String(correctionRequestMessages[falseFinalIndex + 1]?.content || ""),
        /^Correction for this turn:/,
      );
      assert.equal(
        correctionRequestMessages.filter(
          (message) =>
            message.role === "user" &&
            String(message.content || "").startsWith(
              "Correction for this turn:",
            ),
        ).length,
        1,
      );

      const terminalContractSnapshots = events.filter(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_action_contract" &&
          typeof event.payload?.state === "string",
      );
      assert.lengthOf(terminalContractSnapshots, 2);
      assert.deepEqual(
        terminalContractSnapshots.map((event) =>
          event.type === "provider_event"
            ? (event.payload?.progress as { correctionCount?: number })
                ?.correctionCount
            : undefined,
        ),
        [0, 1],
      );
    } finally {
      restoreDb();
    }
  });

  it("does not consume an action correction when streamed rollback fails", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        createRequiredMoveActionContractService(),
      );
      registerZeroEffectLibraryUpdate(registry);

      let resolvedRequest: AgentRuntimeRequest | undefined;
      let modelStep = 0;
      let transcriptAttemptsAtRollback = 0;
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: (request) => {
          resolvedRequest = request;
          return {
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              modelStep += 1;
              if (modelStep === 1) {
                const call = {
                  id: "rollback-c1",
                  name: "library_update",
                  arguments: { kind: "collections" },
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
              resolvedRequest!.actionProgress!.updatedAt = 17;
              await params.onTextDelta?.(
                "Filed both papers into Neuroscience.",
              );
              return {
                kind: "final",
                text: "Filed both papers into Neuroscience.",
                assistantMessage: {
                  role: "assistant",
                  content: "Filed both papers into Neuroscience.",
                },
              };
            },
          };
        },
      });

      let error: unknown;
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 993,
            mode: "agent",
            userText: "file these two papers into Neuroscience",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
            libraryID: 1,
          },
          onEvent: (event) => {
            if (event.type !== "message_rollback") return;
            transcriptAttemptsAtRollback = installed.transcriptWriteAttempts();
            throw new Error("Injected rollback failure");
          },
        });
      } catch (caught) {
        error = caught;
      }

      assert.match(String(error), /injected rollback failure/i);
      assert.equal(modelStep, 2);
      assert.equal(resolvedRequest?.actionProgress?.correctionCount, 0);
      assert.equal(resolvedRequest?.actionProgress?.state, "unverified");
      assert.equal(resolvedRequest?.actionProgress?.updatedAt, 17);
      assert.equal(
        installed.transcriptWriteAttempts(),
        transcriptAttemptsAtRollback,
        "no correction checkpoint may be attempted after rollback fails",
      );
    } finally {
      installed();
    }
  });

  it("does not consume an action correction when correction checkpoint storage fails", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        createRequiredMoveActionContractService(),
      );
      registerZeroEffectLibraryUpdate(registry);

      let resolvedRequest: AgentRuntimeRequest | undefined;
      let modelStep = 0;
      let rollbackObserved = false;
      const runtime = new AgentRuntime({
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: (request) => {
          resolvedRequest = request;
          return {
            getCapabilities: () => ({
              streaming: true,
              toolCalls: true,
              multimodal: false,
            }),
            supportsTools: () => true,
            async runStep(params: AgentStepParams): Promise<AgentModelStep> {
              modelStep += 1;
              if (modelStep === 1) {
                const call = {
                  id: "storage-c1",
                  name: "library_update",
                  arguments: { kind: "collections" },
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
              resolvedRequest!.actionProgress!.updatedAt = 19;
              installed.setTranscriptWriteFailure(true);
              await params.onTextDelta?.(
                "Filed both papers into Neuroscience.",
              );
              return {
                kind: "final",
                text: "Filed both papers into Neuroscience.",
                assistantMessage: {
                  role: "assistant",
                  content: "Filed both papers into Neuroscience.",
                },
              };
            },
          };
        },
      });

      let error: unknown;
      try {
        await runtime.runTurn({
          request: {
            classifiedIntent: classifiedFixture(),
            conversationKey: 994,
            mode: "agent",
            userText: "file these two papers into Neuroscience",
            model: "gpt-4o-mini",
            apiBase: "https://api.openai.com/v1/chat/completions",
            apiKey: "test",
            libraryID: 1,
          },
          onEvent: (event) => {
            if (event.type !== "message_rollback") return;
            rollbackObserved = true;
            assert.equal(resolvedRequest?.actionProgress?.correctionCount, 0);
          },
        });
      } catch (caught) {
        error = caught;
      }

      assert.match(String(error), /transcript checkpoint storage failed/i);
      assert.isTrue(rollbackObserved);
      assert.equal(modelStep, 2);
      assert.equal(resolvedRequest?.actionProgress?.correctionCount, 0);
      assert.equal(resolvedRequest?.actionProgress?.state, "unverified");
      assert.equal(resolvedRequest?.actionProgress?.updatedAt, 19);
      assert.notInclude(
        JSON.stringify(installed.transcripts),
        "Correction for this turn:",
      );
    } finally {
      installed();
    }
  });

  /**
   * Chain survival. Three careful "Cancel" clicks used to fail the run
   * outright, because a denial incremented the same counter as a broken tool
   * -- and persistence was gated on a clean finish, so the run discarded its
   * own transcript *after* its library writes had landed.
   */
  it("does not retry a typed obligation after the user declines it", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
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
        semanticInterpreter: declaredSemanticInterpreter,
        registry,
        adapterFactory: () =>
          new MockAdapter(
            [
              toolStep("c1"),
              toolStep("c2"),
              toolStep("c3"),
              {
                kind: "final",
                text: "You cancelled all three, so nothing changed.",
                assistantMessage: {
                  role: "assistant",
                  content: "You cancelled all three, so nothing changed.",
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
        semanticInterpreter: declaredSemanticInterpreter,
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

describe("prepared native actions through AgentRuntime", function () {
  for (const [removeSource, compound, batched, cancelBeforeExecution] of [
    [true, false],
    [false, false],
    [true, true],
    [true, false, true],
    [true, false, false, true],
  ]) {
    it(
      cancelBeforeExecution
        ? "stops a prepared action cancelled between selection and execution without reselecting it"
        : batched
          ? "rechecks host action readiness after a sibling read while preserving provider tool result IDs"
          : compound
            ? "executes the resolved move before asking the model to generate compound material"
            : removeSource
              ? "executes one bound move and persists its verified answer without an execution-model call"
              : "rejects destination-only evidence without asking the model to guess another action",
      async function () {
        const installed = installMockDb();
        clearAgentReadLedger();
        clearAgentCoverageLedger();
        clearAgentTranscriptStore();
        clearAgentToolResultHandleStore();
        await initAgentChangeJournal();
        let memberships = [1];
        let modelCalls = 0;
        let writes = 0;
        const events: AgentEvent[] = [];
        let readComplete = false;
        const abort = new AbortController();
        let preparedSelections = 0;
        const deliveredIds: string[] = [];
        const originalCompleteStep =
          AgentRunContinuationSession.prototype.completeToolStep;
        if (batched)
          AgentRunContinuationSession.prototype.completeToolStep = function (
            params,
          ) {
            deliveredIds.push(
              ...params.toolMessages.map((message) => message.tool_call_id),
            );
            return originalCompleteStep.call(this, params);
          };
        const originalReadyIds =
          PlanExecutionRunSession.prototype.activeWorkflowObligationIds;
        if (batched)
          PlanExecutionRunSession.prototype.activeWorkflowObligationIds =
            function () {
              return readComplete ? undefined : [];
            };
        try {
          const item = {
            id: 2317,
            libraryID: 1,
            isRegularItem: () => true,
            getField: () => "Representational geometry",
            getCollections: () => [...memberships],
          };
          const gateway = {
            getItem: () => item,
            listCollectionSummaries: () => [
              {
                collectionId: 7,
                libraryID: 1,
                name: "Learning",
                path: "Learning",
              },
            ],
            getCollectionSummary: (id: number) => ({
              collectionId: id,
              libraryID: 1,
              name: id === 1 ? "Geometry" : "Learning",
            }),
          };
          const registry = new AgentToolRegistry(
            new ActionContractService(gateway as never),
          );
          const operation = {
            type: "move_to_collection" as const,
            itemIds: [2317],
            targetCollectionId: 7,
            mode: "move" as const,
            from: 1,
          };
          const nativeState = () => ({
            version: 1 as const,
            operation: "move_to_collection" as const,
            items: [
              { itemId: 2317, exists: true, collectionIds: [...memberships] },
            ],
          });
          registry.register({
            spec: {
              name: "library_update",
              description: "Collection mutation test boundary",
              inputSchema: { type: "object" },
              executionClass: "external_effect",
              requiresConfirmation: false,
            },
            validate: (args) => ({ ok: true, value: args }),
            describeAction: () => describeLibraryMutationActions(operation),
            planInvocation: () =>
              stateChangeInvocationPlan({
                reversibility: "full",
                reason: "Move the resolved paper",
              }),
            execute: async (input) => {
              if (batched)
                assert.notProperty(
                  input,
                  "modelOnly",
                  "The host must supply the canonical action arguments",
                );
              writes++;
              const preState = nativeState();
              memberships = removeSource ? [7] : [1, 7];
              return {
                content: { result: "captured" },
                effect: "applied",
                actionEvidence: [
                  {
                    version: 1,
                    proofDomain: "zotero_state",
                    operationValue: operation,
                    preState,
                    postState: nativeState(),
                    effect: "applied",
                    journalStepId: "bound-move",
                  },
                ],
              };
            },
          });
          if (batched)
            registry.register({
              spec: {
                name: "library_read",
                description: "Read prerequisite",
                inputSchema: { type: "object" },
                executionClass: "read",
              },
              validate: (args) => ({ ok: true, value: args }),
              execute: async () => {
                readComplete = true;
                return { content: { read: true } };
              },
            });
          const { registerPreparedLibraryActions } =
            await import("../src/agent/tools/preparedLibraryActions");
          registerPreparedLibraryActions(registry, gateway as never);
          const runtime = new AgentRuntime({
            registry,
            semanticInterpreter: declaredSemanticInterpreter,
            adapterFactory: () => ({
              getCapabilities: () => ({
                streaming: false,
                toolCalls: true,
                multimodal: false,
              }),
              supportsTools: () => true,
              runStep: async () => {
                modelCalls++;
                if (batched) {
                  assert.equal(
                    modelCalls,
                    1,
                    "The newly ready host action must finish without another model round",
                  );
                  const calls = [
                    { id: "model-read", name: "library_read", arguments: {} },
                    {
                      id: "model-move",
                      name: "library_update",
                      arguments: {
                        modelOnly: true,
                        kind: "collections",
                        action: "add",
                        itemIds: [2317],
                        mode: "move",
                        from: 1,
                        targetCollectionId: 7,
                      },
                    },
                  ];
                  return {
                    kind: "tool_calls" as const,
                    calls,
                    assistantMessage: {
                      role: "assistant" as const,
                      content: "",
                      tool_calls: calls,
                    },
                  };
                }
                if (compound) {
                  assert.deepEqual(
                    memberships,
                    [7],
                    "the model starts only after the ready move is verified",
                  );
                  throw new Error("Generation boundary reached");
                }
                throw new Error(
                  "A resolved fixed action must not ask the execution model for arguments",
                );
              },
            }),
          });
          const intent = actionFixture("move_to_collection", {
            destinationCollectionId: 7,
          });
          intent.actionIntents[0].constraints = { collectionMode: "move" };
          if (compound) {
            intent.retrievalIntent = "summarize";
            intent.semantic!.materialOutputs = [
              {
                id: "summary",
                description: "Summarize the moved paper",
                afterActions: [0],
                sourceActionIndexes: [0],
                requiredEvidence: "body",
              },
            ];
          }
          const outcome = await runtime
            .runTurn({
              signal: abort.signal,
              request: {
                conversationKey: removeSource ? 998831 : 998832,
                mode: "agent",
                libraryID: 1,
                activeItemId: 2317,
                userText: "move this paper to learning folder",
                model: "gpt-4o-mini",
                apiKey: "test",
                apiBase: "https://example.invalid",
                classifiedIntent: intent,
              },
              onEvent: async (event) => {
                events.push(event);
                if (
                  cancelBeforeExecution &&
                  event.type === "status" &&
                  event.text === "Applying the next resolved action"
                ) {
                  if (++preparedSelections > 1)
                    throw new Error("Cancelled action selected again");
                  abort.abort();
                }
              },
            })
            .catch((error) => {
              if (cancelBeforeExecution) {
                assert.equal(String(error), "Error: Aborted");
                return {
                  kind: "completed" as const,
                  runId: "cancelled-boundary",
                  text: "",
                };
              }
              if (!compound) throw error;
              assert.include(String(error), "Generation boundary reached");
              return {
                kind: "completed" as const,
                runId: "generation-boundary",
                text: "",
              };
            });
          if (cancelBeforeExecution) {
            assert.equal(preparedSelections, 1);
            assert.equal(writes, 0);
            assert.equal(modelCalls, 0);
            assert.deepEqual(memberships, [1]);
            return;
          }
          assert.equal(modelCalls, compound || batched ? 1 : 0);
          assert.equal(
            writes,
            1,
            JSON.stringify({
              outcome,
              events: events.filter((event) =>
                ["tool_result", "final", "confirmation_required"].includes(
                  event.type,
                ),
              ),
            }),
          );
          assert.lengthOf(
            events.filter((event) => event.type === "tool_call"),
            batched ? 2 : 1,
          );
          if (batched) {
            const move = events.find(
              (event) =>
                event.type === "tool_call" && event.name === "library_update",
            );
            assert.isTrue(
              move?.type === "tool_call" && move.callId.startsWith("workflow:"),
            );
            assert.deepEqual(
              deliveredIds,
              ["model-read", "model-move"],
              "Complete the provider batch with its original IDs, not host execution IDs",
            );
          }
          if (compound) {
            assert.deepEqual(memberships, [7]);
            return;
          }
          assert.equal(outcome.kind, "completed");
          if (outcome.kind !== "completed") return;
          assert.equal(
            (await getAgentRunTrace(outcome.runId)).run?.status,
            removeSource ? "completed" : "failed",
          );
          if (removeSource) {
            assert.include(outcome.text, "Moved");
            assert.include(outcome.text, "Geometry");
            assert.include(
              JSON.stringify(readPersistedTranscript(installed, 998831)),
              outcome.text,
            );
          } else
            assert.notInclude(
              outcome.text,
              "Moved “Representational geometry”",
            );
        } finally {
          PlanExecutionRunSession.prototype.activeWorkflowObligationIds =
            originalReadyIds;
          AgentRunContinuationSession.prototype.completeToolStep =
            originalCompleteStep;
          installed();
        }
      },
    );
  }
});

describe("model continuation after host clarification", function () {
  it("rebuilds the model input from the resolved contract after choosing a native source", async function () {
    const installed = installMockDb();
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
    let firstModelInput = "";
    try {
      const item = {
        id: 2317,
        libraryID: 1,
        isRegularItem: () => true,
        getField: () => "Paper",
        getCollections: () => [1, 8],
      };
      const collections = [
        { collectionId: 1, libraryID: 1, name: "Geometry", path: "Geometry" },
        { collectionId: 7, libraryID: 1, name: "Learning", path: "Learning" },
        { collectionId: 8, libraryID: 1, name: "Other", path: "Other" },
      ];
      const service = new ActionContractService({
        getItem: () => item,
        listCollectionSummaries: () => collections,
        getCollectionSummary: (id: number) =>
          collections.find((c) => c.collectionId === id) || null,
      } as never);
      const registry = new AgentToolRegistry(service);
      registry.register(
        createRequestUserInputTool((request) =>
          service.createContract(request),
        ),
      );
      const runtime = new AgentRuntime({
        registry,
        semanticInterpreter: declaredSemanticInterpreter,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          runStep: async (params) => {
            firstModelInput ||= JSON.stringify(params.messages);
            return {
              kind: "final",
              text: "The test does not execute effects.",
              assistantMessage: {
                role: "assistant",
                content: "The test does not execute effects.",
              },
            };
          },
        }),
      });
      const intent = actionFixture("move_to_collection", {
        destinationCollectionId: 7,
      });
      intent.actionIntents[0].constraints = { collectionMode: "move" };
      await runtime.runTurn({
        request: {
          conversationKey: 998840,
          mode: "agent",
          libraryID: 1,
          activeItemId: 2317,
          userText: "Move this paper into Learning",
          model: "gpt-4o-mini",
          apiKey: "test",
          apiBase: "https://example.invalid",
          classifiedIntent: intent,
        },
        onEvent: async (event) => {
          if (event.type === "confirmation_required")
            runtime.resolveConfirmation(event.requestId, true, {
              reference: { kind: "option", optionId: "source:1" },
            });
        },
      });
      assert.include(firstModelInput, "sourceCollectionId");
      assert.notInclude(firstModelInput, "Action references are unresolved");
    } finally {
      installed();
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
        semanticInterpreter: declaredSemanticInterpreter,
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
        "do not retrieve again",
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
        semanticInterpreter: declaredSemanticInterpreter,
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
