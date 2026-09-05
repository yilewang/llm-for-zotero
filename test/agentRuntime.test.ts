import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/agent/runtime";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import {
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
      mutability: "write",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args as never }),
    planMutation: async () => ({
      effect: "write",
      reversibility: "full",
    }),
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
            ],
            { streaming: false, toolCalls: true, multimodal: false },
          ),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
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

  it("emits explicitly forced slash skills alongside auto-detected skills", async function () {
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
        "Skill activated: simple-paper-qa",
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
          "simple-paper-qa",
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
          mutability: "write",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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

  it("stops segmented continuation when a full segment only repeats prior work", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "read_same_chunk",
          description: "read a chunk",
          inputSchema: { type: "object" },
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        planMutation: async () => ({
          effect: "write",
          reversibility: "full",
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

  it("requires paper_read full before completing an explicit Agent full-text request", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      const reads: unknown[] = [];
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          mutability: "read",
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
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "paper_read",
          description: "read paper",
          inputSchema: { type: "object" },
          mutability: "read",
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
          mutability: "write",
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
              expectedText: String(input.operation.content || ""),
            },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        planMutation: async () => ({
          effect: "write",
          reversibility: "full",
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
                "The user is asking for a Zotero note workflow",
              );
              sawInitialFileRule = allText.includes(
                "The user is asking for an Obsidian/file-based note",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
      const conversationKey = 704;
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "confirmation_write",
          description: "write",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:pending-confirmation"),
        planMutation: () => ({
          effect: "write",
          reversibility: "full",
          requiresConfirmation: true,
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
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:recovery-write"),
        planMutation: () => ({ effect: "write", reversibility: "full" }),
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
            conversationKey,
            mode: "agent",
            userText: "run command once",
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
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () =>
          commandActionDescriptor("command_execute:changed-key"),
        planMutation: () => ({ effect: "write", reversibility: "full" }),
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
            conversationKey,
            mode: "agent",
            userText: "run command to preserve this original goal",
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
        "Prior goal: run command to preserve this original goal",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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
          mutability: "read",
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

  it("checkpoints cached provider state when reported replay usage exceeds the send budget", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "small_read",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
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
          mutability: "read",
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
        mutability: "read",
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
        registry: new AgentToolRegistry(),
        adapterFactory: () =>
          new MockAdapter([finalStep("Direct answer.")], GUARD_CAPS),
      });
      const outcome = await runtime.runTurn({
        request: {
          ...GUARD_REQUEST,
          classifiedIntent: { retrievalIntent: "none", wantedSections: [] },
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
          mutability: "read",
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
        new ActionContractService({
          getCollectionSummary: () => null,
          listCollectionSummaries: () => [],
          listCollectionPaperTargets: async () => ({ papers: [] }),
          listCollectionItemTargets: async () => ({ items: [] }),
          getItem: () => null,
          getEditableArticleMetadata: () => null,
        }),
      );
      registerZeroEffectLibraryUpdate(registry);

      let stepIndex = 0;
      let resolvedRequest: AgentRuntimeRequest | undefined;
      let correctionRequestMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
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
            "failed",
          );
          assert.equal(
            progress?.state,
            "pending",
            "failed evaluation must remain nonterminal until rollback succeeds",
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
      assert.include(outcome.text, "write was blocked");
      assert.deepEqual(rollbackProgress, [
        { correctionCount: 0, state: "pending", updatedAt: 11 },
        { correctionCount: 1, state: "pending", updatedAt: 22 },
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
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerZeroEffectLibraryUpdate(registry);

      let resolvedRequest: AgentRuntimeRequest | undefined;
      let modelStep = 0;
      let transcriptAttemptsAtRollback = 0;
      const runtime = new AgentRuntime({
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
      assert.equal(resolvedRequest?.actionProgress?.state, "pending");
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
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerZeroEffectLibraryUpdate(registry);

      let resolvedRequest: AgentRuntimeRequest | undefined;
      let modelStep = 0;
      let rollbackObserved = false;
      const runtime = new AgentRuntime({
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
      assert.equal(resolvedRequest?.actionProgress?.state, "pending");
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
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "library_update",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
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
            String(key).endsWith("agentLibraryWriteMode")
              ? "safe"
              : previousZotero?.Prefs?.get?.(key, ...rest),
        },
      };

      let denials = 0;
      const outcome = await runtime.runTurn({
        request: {
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
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: { operation } }),
        describeAction: (input) => describeLibraryMutationActions(input),
        planMutation: async () => ({
          effect: "write",
          reversibility: "full",
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
