import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createSelfContainedTestTool } from "../src/agent/tools/test/createSelfContainedTestTool";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import type {
  AgentEvent,
  AgentModelStep,
  AgentRuntimeRequest,
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

class InspectingAdapter implements AgentModelAdapter {
  sawGuidance = false;
  sawFollowup = false;

  getCapabilities() {
    return {
      streaming: false,
      toolCalls: true,
      multimodal: false,
    };
  }

  supportsTools() {
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const systemMessage = params.messages[0];
    this.sawGuidance =
      systemMessage?.role === "system" &&
      typeof systemMessage.content === "string" &&
      systemMessage.content.includes("self_contained_test_tool");
    this.sawFollowup = params.messages.some(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "text" &&
            part.text.includes("Self-contained follow-up:"),
        ),
    );
    if (!this.sawFollowup) {
      return {
        kind: "tool_calls",
        calls: [
          {
            id: "call-1",
            name: "self_contained_test_tool",
            arguments: { content: "demo" },
          },
        ],
        assistantMessage: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "self_contained_test_tool",
              arguments: { content: "demo" },
            },
          ],
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
  }
}

describe("self-contained agent tool", function () {
  const request: AgentRuntimeRequest = {
    conversationKey: 1,
    mode: "agent",
    userText: "Run the self-contained demo tool",
    model: "gpt-4o-mini",
    apiBase: "https://api.openai.com/v1/chat/completions",
    apiKey: "test",
  };

  it("adds tool-local guidance into the shared initial messages", function () {
    const tool = createSelfContainedTestTool();
    const messages = buildAgentInitialMessages(request, [tool]);
    assert.equal(messages[0]?.role, "system");
    assert.include(
      typeof messages[0]?.content === "string" ? messages[0].content : "",
      "self_contained_test_tool",
    );
  });

  it("defines the generic confirmation field schema in the tool file", function () {
    const tool = createSelfContainedTestTool();
    const pending = tool.createPendingAction?.(
      {
        content: "demo",
        target: "primary",
      },
      {
        request,
        item: null,
        currentAnswerText: "",
        modelName: "gpt-4o-mini",
      },
    );
    assert.exists(pending);
    assert.deepEqual(
      pending?.fields.map((field) => field.type),
      [
        "textarea",
        "text",
        "select",
        "checklist",
        "assignment_table",
        "tag_assignment_table",
        "review_table",
        "image_gallery",
      ],
    );
  });

  it("runs end-to-end with generic confirmation payloads and custom follow-up", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry();
      registry.register(createSelfContainedTestTool());
      const adapter = new InspectingAdapter();
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => adapter,
      });

      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request,
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "confirmation_required") {
            assert.deepEqual(
              event.action.fields.map((field) => field.type),
              [
                "textarea",
                "text",
                "select",
                "checklist",
                "assignment_table",
                "tag_assignment_table",
                "review_table",
                "image_gallery",
              ],
            );
            runtime.resolveConfirmation(event.requestId, true, {
              content: "approved demo",
              note: "kept",
              target: "secondary",
              selectedItemIds: ["demo-1"],
              assignments: [
                { id: "demo-1", value: "secondary", checked: true },
                { id: "demo-2", value: "__skip__", checked: false },
              ],
              tagAssignments: [
                { id: "demo-1", value: ["approved", "demo"] },
                { id: "demo-2", value: [] },
              ],
            });
          }
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.isTrue(adapter.sawGuidance);
      assert.isTrue(adapter.sawFollowup);
    } finally {
      restoreDb();
    }
  });
});
