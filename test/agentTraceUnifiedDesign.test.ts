import { assert } from "chai";
import { createClaudeTurnStageTracker } from "../src/agent/claudeTurnStages";
import { resolveClaudeCodeNativeWorkCategory } from "../src/agent/workCategory";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import { setAgentToolPresentationResolverForTests } from "../src/modules/contextPanel/agentTrace/toolPresentation";
import { resolveClaudeCodeToolPresentation } from "../src/modules/contextPanel/agentTrace/claudeCodeToolPresentation";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import type { Message } from "../src/modules/contextPanel/types";

type TraceItem = ReturnType<
  typeof buildAgentTraceDisplayItems
>["items"][number];

function records(events: AgentEvent[]): AgentRunEventRecord[] {
  return events.map((payload, index) => ({
    runId: "run-1",
    seq: index + 1,
    eventType: payload.type,
    payload,
    createdAt: index + 1,
  }));
}

/**
 * The run's own steps: what the trace shows after the opening lines every
 * run gets ("Request received" and the line above it).
 */
function steps(items: TraceItem[]): TraceItem[] {
  const opening = items.findIndex(
    (item) =>
      item.type === "action" && /request(?: received)?$/i.test(item.row.text),
  );
  return opening >= 0 ? items.slice(opening + 1) : items;
}

/** Each step as the reader sees it: a group with its rows, or a row. */
function outline(items: TraceItem[]): unknown[] {
  return steps(items).map((item) => {
    if (item.type === "stage") {
      return {
        group: item.label,
        rows: item.children.map((child) =>
          child.type === "action" ? child.row.text : child.type,
        ),
      };
    }
    if (item.type === "action") return item.row.text;
    if (item.type === "reasoning") return `thinking: ${item.label}`;
    return item.type;
  });
}

function actions(items: TraceItem[]) {
  return steps(items).flatMap((item) =>
    item.type === "stage"
      ? item.children.filter((child) => child.type === "action")
      : item.type === "action"
        ? [item]
        : [],
  ) as Array<Extract<TraceItem, { type: "action" }>>;
}

describe("one step design across the three modes", function () {
  afterEach(function () {
    setAgentToolPresentationResolverForTests(null);
  });

  describe("Claude Code turns", function () {
    it("files each built-in tool under the group its kind of work belongs to", function () {
      assert.equal(resolveClaudeCodeNativeWorkCategory("Read"), "retrieval");
      assert.equal(resolveClaudeCodeNativeWorkCategory("Grep"), "retrieval");
      assert.equal(
        resolveClaudeCodeNativeWorkCategory("WebFetch"),
        "retrieval",
      );
      assert.equal(
        resolveClaudeCodeNativeWorkCategory("Bash"),
        "external_system",
      );
      assert.equal(
        resolveClaudeCodeNativeWorkCategory("Edit"),
        "external_system",
      );
      // A helper agent can do any kind of work, so it claims no group.
      assert.isUndefined(resolveClaudeCodeNativeWorkCategory("Task"));
      assert.isUndefined(
        resolveClaudeCodeNativeWorkCategory("mcp__llm_for_zotero__paper_read"),
      );
    });

    it("opens a stage before each call and closes it before its result", function () {
      const stage = createClaudeTurnStageTracker();
      const call = stage({
        type: "tool_call",
        callId: "c1",
        name: "Read",
        args: { file_path: "/tmp/paper.md" },
      });
      assert.deepEqual(
        call.map((event) => event.type),
        ["agent_stage", "tool_call"],
      );
      assert.deepInclude(call[0], { stage: "retrieval", status: "started" });
      assert.deepInclude(call[1], { workCategory: "retrieval" });

      const result = stage({
        type: "tool_result",
        callId: "c1",
        name: "",
        ok: true,
        content: "text",
        actionReceipts: [],
      });
      assert.deepEqual(
        result.map((event) => event.type),
        ["agent_stage", "tool_result"],
      );
      assert.deepInclude(result[0], {
        stage: "retrieval",
        status: "completed",
      });

      const unknown = stage({
        type: "tool_call",
        callId: "c2",
        name: "Task",
        args: {},
      });
      assert.deepEqual(
        unknown.map((event) => event.type),
        ["tool_call"],
      );
    });

    it("brackets a Zotero tool Claude called over MCP with the tool's own group", function () {
      const stage = createClaudeTurnStageTracker();
      const relayed = stage({
        type: "codex_tool_activity",
        itemId: "mcp:1",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        ok: true,
        workCategory: "retrieval",
      });
      assert.deepEqual(
        relayed.map((event) => event.type),
        ["agent_stage", "codex_tool_activity"],
      );
      assert.deepInclude(relayed[0], {
        stage: "retrieval",
        status: "completed",
      });
    });

    it("shows a Zotero tool Claude called once, as the Zotero server's row", function () {
      const stage = createClaudeTurnStageTracker();
      const raw: AgentEvent[] = [
        {
          type: "tool_call",
          callId: "m",
          name: "mcp__llm-for-zotero-profile-1__paper_read",
          args: { mode: "overview" },
        },
        {
          type: "codex_tool_activity",
          itemId: "mcp:1",
          phase: "completed",
          toolName: "paper_read",
          toolLabel: "Read Paper",
          ok: true,
          workCategory: "retrieval",
        },
        {
          type: "tool_result",
          callId: "m",
          name: "",
          ok: true,
          content: "overview",
          actionReceipts: [],
        },
      ];
      const { items } = buildAgentTraceDisplayItems(
        records(raw.flatMap((event) => stage(event))),
        null,
      );
      assert.deepEqual(outline(items), [
        { group: "Read evidence", rows: ["Used Read Paper"] },
      ]);
    });

    it("shows a Claude Code run in real groups, not one Agent activity box", function () {
      setAgentToolPresentationResolverForTests(
        resolveClaudeCodeToolPresentation,
      );
      const stage = createClaudeTurnStageTracker();
      const raw: AgentEvent[] = [
        {
          type: "tool_call",
          callId: "g",
          name: "Grep",
          args: { pattern: "Fig. 4", path: "/tmp/paper.md" },
        },
        {
          type: "tool_result",
          callId: "g",
          name: "",
          ok: true,
          content: "12:Fig. 4",
          actionReceipts: [],
        },
        {
          type: "tool_call",
          callId: "r",
          name: "Read",
          args: { file_path: "/tmp/paper.md" },
        },
        {
          type: "tool_result",
          callId: "r",
          name: "",
          ok: true,
          content: "text",
          actionReceipts: [],
        },
        { type: "reasoning", round: 1, summary: "Fig. 4 carries the claim." },
        {
          type: "tool_call",
          callId: "b",
          name: "Bash",
          args: {
            command: "python3 count.py",
            description: "Count each figure",
          },
        },
        {
          type: "tool_result",
          callId: "b",
          name: "",
          ok: true,
          content: "4: 9",
          actionReceipts: [],
        },
      ];
      const { items } = buildAgentTraceDisplayItems(
        records(raw.flatMap((event) => stage(event))),
        null,
      );

      assert.deepEqual(outline(items), [
        {
          group: "Read evidence",
          rows: ['Search for "Fig. 4"', "Read paper.md"],
        },
        "thinking: Thinking",
        { group: "External action", rows: ["Count each figure"] },
      ]);
      assert.deepEqual(
        actions(items).map((item) => item.row.iconName),
        ["search", "file", "code"],
      );
      // The row already names what was searched or read.
      assert.deepEqual(
        actions(items).flatMap((item) => item.chips || []),
        [],
      );
    });
  });

  describe("Codex turns", function () {
    function message(): Message {
      return {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
        streaming: true,
      } as Message;
    }

    it("puts Codex's thinking among the steps, one row per thought", function () {
      const msg = message();
      const trace = createCodexNativeActivityTraceControllerForTests(
        msg,
        Object.assign(() => undefined, {}),
      );
      trace.appendReasoning({ stepId: "rs_1", summary: "Reading the " });
      trace.appendReasoning({ stepId: "rs_1", summary: "results first." });
      trace.appendItemStatus(
        {
          id: "cmd-1",
          type: "commandExecution",
          command: "/bin/zsh -lc 'rg -n Fig paper.md'",
          exitCode: 0,
        },
        "completed",
      );
      trace.appendReasoning({ stepId: "rs_2", summary: "Fig. 4 leads." });

      const events = msg.pendingAgentTraceEvents || [];
      const reasoning = events.filter(
        (entry) => entry.payload.type === "reasoning",
      );
      assert.lengthOf(reasoning, 2);
      assert.deepInclude(reasoning[0].payload, {
        summary: "Reading the results first.",
      });

      const { items } = buildAgentTraceDisplayItems(events, null, {
        ...msg,
        streaming: false,
      } as Message);
      assert.deepEqual(outline(items), [
        "thinking: Thinking",
        { group: "External action", rows: ["Ran rg -n Fig paper.md"] },
        "thinking: Thinking",
      ]);
      const [command] = actions(items);
      assert.equal(command.row.iconName, "code");
      // "exit 0" no longer shows as a Status chip under the row.
      assert.deepEqual(command.chips || [], []);
    });

    it("gives a Zotero tool Codex called the words and icon it has in the plugin's own runs", function () {
      setAgentToolPresentationResolverForTests((name) =>
        name === "paper_read"
          ? {
              label: "Read Paper",
              traceIcon: "library",
              summaries: { onCall: "Reading targeted paper content" },
            }
          : resolveClaudeCodeToolPresentation(name),
      );
      const { items } = buildAgentTraceDisplayItems(
        records([
          {
            type: "codex_tool_activity",
            itemId: "mcp:1",
            phase: "completed",
            toolName: "mcp__llm_for_zotero__paper_read",
            toolLabel: "Read Paper",
            ok: true,
          },
        ]),
        null,
      );
      const [row] = actions(items);
      assert.equal(row.row.text, "Reading targeted paper content");
      assert.equal(row.row.iconName, "library");
    });
  });
});
