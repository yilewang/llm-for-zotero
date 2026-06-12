import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/agent/runtime";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import { getAgentRunTrace } from "../src/agent/store/traceStore";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createToolResultReadTool } from "../src/agent/tools/read/toolResultRead";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
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

type MockDbRow = Record<string, unknown>;

function installMockDb() {
  const runs = new Map<string, MockDbRow>();
  const events: MockDbRow[] = [];
  const prefs = new Map<string, unknown>();
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
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => {
        prefs.set(key, value);
      },
    },
  };
  return () => {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  };
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
          mode: "agent",
          userText: "help me understand this paper",
          selectedPaperContexts: [
            { itemId: 10, contextItemId: 11, title: "Paper" },
          ],
          forcedSkillIds: ["evidence-based-qa"],
          model: "gpt-5.4",
          apiBase: "",
          apiKey: "test",
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      const statusTexts = events
        .filter((event): event is Extract<AgentEvent, { type: "status" }> =>
          event.type === "status",
        )
        .map((event) => event.text);
      assert.includeMembers(statusTexts, [
        "Skill activated: simple-paper-qa",
        "Skill activated: evidence-based-qa",
      ]);
    } finally {
      setUserSkills([]);
      restoreDb();
    }
  });

  it("executes tool calls and resumes after approval", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register({
        spec: {
          name: "mutate_library",
          description: "mutate",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: true,
        },
        validate: () => ({ ok: true, value: { content: "hello" } }),
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
          status: "created",
          saved: input.content,
          target: input.target,
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
          userText: "save this",
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
      assert.equal(outcome.text, "Saved.");
      assert.isTrue(events.some((event) => event.type === "tool_call"));
      assert.isTrue(events.some((event) => event.type === "tool_result"));
      const toolResultEvent = events.find(
        (event) => event.type === "tool_result",
      );
      assert.deepEqual(
        toolResultEvent && toolResultEvent.type === "tool_result"
          ? toolResultEvent.content
          : null,
        {
          status: "created",
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
          model: "deepseek-v4-pro",
        },
      });

      const serialized = JSON.stringify(continuationMessages);
      assert.notInclude(serialized, "image_url");
      assert.notInclude(serialized, "file_ref");
      assert.include(serialized, "does not support image or file input");
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

  it("keeps assistant tool calls aligned with executed tool outputs when capped", async function () {
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

      let sawConsistentFollowup = false;
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
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            if (!sawConsistentFollowup) {
              const priorAssistant = params.messages.findLast(
                (message) =>
                  message.role === "assistant" &&
                  Array.isArray(message.tool_calls) &&
                  message.tool_calls.length > 0,
              );
              if (
                !priorAssistant ||
                !Array.isArray(priorAssistant.tool_calls)
              ) {
                return {
                  kind: "tool_calls",
                  calls: Array.from(
                    { length: overLimitCallCount },
                    (_unused, index) => index + 1,
                  ).map((index) => ({
                    id: `call-${index}`,
                    name: "read_context",
                    arguments: {},
                  })),
                  assistantMessage: {
                    role: "assistant",
                    content: "",
                    tool_calls: Array.from(
                      { length: overLimitCallCount },
                      (_unused, index) => index + 1,
                    ).map((index) => ({
                      id: `call-${index}`,
                      name: "read_context",
                      arguments: {},
                    })),
                  },
                };
              }
              const toolMessages = params.messages.filter(
                (message) => message.role === "tool",
              );
              sawConsistentFollowup =
                priorAssistant.tool_calls.length ===
                  MAX_AGENT_TOOL_CALLS_PER_ROUND &&
                toolMessages.length === MAX_AGENT_TOOL_CALLS_PER_ROUND &&
                toolMessages.every(
                  (message, index) =>
                    message.tool_call_id === `call-${index + 1}`,
                );
            }
            return {
              kind: "final",
              text: sawConsistentFollowup ? "Done." : "Inconsistent.",
              assistantMessage: {
                role: "assistant",
                content: sawConsistentFollowup ? "Done." : "Inconsistent.",
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
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(outcome.text, "Done.");
      assert.isTrue(sawConsistentFollowup);
    } finally {
      restoreDb();
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

      const registry = new AgentToolRegistry();
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
        execute: async (input) => {
          writes.push(input);
          return input;
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
                message.content.includes("requires writing a Markdown note"),
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
      assert.equal(outcome.text, "Saved.");
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

  it("does not force file writes after a standalone Zotero note request is satisfied", async function () {
    const restoreDb = installMockDb();
    try {
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

      const registry = new AgentToolRegistry();
      const noteWrites: unknown[] = [];
      registry.register({
        spec: {
          name: "note_write",
          description: "write note",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: (args: unknown) => ({ ok: true, value: args }),
        execute: async (input) => {
          noteWrites.push(input);
          return { status: "saved" };
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
      assert.equal(outcome.text, "Saved Zotero note.");
      assert.isTrue(sawInitialZoteroRule);
      assert.isFalse(sawInitialFileRule);
      assert.isFalse(sawCorrectivePrompt);
      assert.equal(stepIndex, 2);
      assert.deepEqual(noteWrites, [
        {
          mode: "create",
          target: "standalone",
          content: "## Summary\nZotero note body.",
        },
      ]);
    } finally {
      restoreDb();
    }
  });

  it("routes default file notes into the configured folder and creates it", async function () {
    const restoreDb = installMockDb();
    const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;
    const createdDirs: string[] = [];
    const writes: Array<{ path: string; text: string }> = [];
    try {
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
        },
      };

      const registry = new AgentToolRegistry();
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
          path: "/tmp/obsidian-vault/Zotero Notes/Figure 2.md",
          text: "## Figure 2\nGrounded note.",
        },
      ]);
      assert.include(createdDirs, "/tmp/obsidian-vault/Zotero Notes");
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
      assert.include(
        secondInitialUserMessage,
        "Zotero context for this turn:",
      );
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
      assert.include(serialized, "remember alpha");
      assert.include(serialized, "Alpha is preserved.");
      assert.include(secondToolNames, "tool_result_read");
    } finally {
      restoreDb();
    }
  });

  it("compacts the reusable transcript when /compact is requested", async function () {
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
      const toolMessage = synthesisMessages.find(
        (message) => message.role === "tool",
      );
      assert.equal(toolMessage?.role, "tool");
      const modelFacing = JSON.parse(
        (toolMessage as { content: string }).content,
      );
      assert.isTrue(modelFacing.modelContextCompacted);
      assert.equal(modelFacing.totalCount, 160);
      assert.equal(modelFacing.filters.collectionId, 42);
      assert.isBelow(modelFacing.results.length, 160);
      assert.match(modelFacing.toolResultHandle, /^trh_/);
      assert.isAtLeast(toolNamesByStep.length, 2);
      assert.notInclude(toolNamesByStep[0], "tool_result_read");
      assert.include(toolNamesByStep[1], "tool_result_read");
      assert.notInclude(JSON.stringify(modelFacing), "A".repeat(200));
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
            const compactedToolMessage = params.messages.find(
              (message) =>
                message.role === "tool" && message.name === "query_library",
            );
            assert.equal(compactedToolMessage?.role, "tool");
            const modelFacing = JSON.parse(
              (compactedToolMessage as { content: string }).content,
            );
            storedHandle = modelFacing.toolResultHandle;
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
          advanced: { inputTokenCap: 8_000 },
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.notInclude(toolNamesByStep[0], "tool_result_read");
      assert.include(toolNamesByStep[1], "tool_result_read");
      assert.equal(readToolMessage?.role, "tool");
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

      let synthesisMessages: AgentModelMessage[] = [];
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
          if (!synthesisMessages.length) {
            synthesisMessages = params.messages;
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
        (message) => message.role === "tool",
      );
      assert.equal(toolMessage?.role, "tool");
      const modelFacing = JSON.parse(
        (toolMessage as { content: string }).content,
      );
      assert.isTrue(modelFacing.modelContextCompacted);
      assert.match(modelFacing.toolResultHandle, /^trh_/);
      const serialized = JSON.stringify(modelFacing);
      assert.include(serialized, "queryCoverage");
      assert.include(modelFacing.snippets[0].text, "Evidence snippet 0");
      assert.equal(modelFacing.snippets[0].itemId, "20000");
      assert.equal(modelFacing.snippets[0].contextItemId, "30000");
      assert.equal(modelFacing.snippets[0].matchMethod, "bm25");
      assert.equal(modelFacing.snippets[0].paperContext.itemId, "20000");
      assert.equal(modelFacing.snippets[0].paperContext.contextItemId, "30000");
    } finally {
      restoreDb();
    }
  });

  it("resets stateful adapters when preflight compacts prompt messages", async function () {
    const restoreDb = installMockDb();
    try {
      let resetCount = 0;
      let inspectedMessages: AgentModelMessage[] = [];
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
          inspectedMessages = params.messages;
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
        registry: new AgentToolRegistry(),
        adapterFactory: () => adapter,
      });
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 12,
          mode: "agent",
          userText: "current request",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1/messages",
          apiKey: "test",
          advanced: { inputTokenCap: 8_000 },
          history: [
            { role: "user", content: "old question" },
            { role: "assistant", content: "B".repeat(80_000) },
          ],
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.isAtLeast(resetCount, 1);
      assert.notInclude(JSON.stringify(inspectedMessages), "B".repeat(1000));
      assert.include(JSON.stringify(inspectedMessages), "current request");
    } finally {
      restoreDb();
    }
  });
});
