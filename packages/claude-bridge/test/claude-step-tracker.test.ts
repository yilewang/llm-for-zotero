import { describe, expect, it } from "vitest";

import {
  CLAUDE_STEPS_ITEM_ID,
  createClaudeStepTracker,
} from "../src/event-mapper/claude-step-tracker.js";

function toolUse(
  id: string,
  name: string,
  input: unknown,
  parentToolUseId: string | null = null,
) {
  return {
    type: "assistant",
    session_id: "s1",
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

function toolResult(
  id: string,
  content: unknown,
  extra: { structured?: unknown; isError?: boolean } = {},
) {
  return {
    type: "user",
    session_id: "s1",
    parent_tool_use_id: null,
    ...(extra.structured !== undefined
      ? { tool_use_result: extra.structured }
      : {}),
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(extra.isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

function stepsOf(events: Array<{ type: string; payload: any }>) {
  return events.map((event) => {
    expect(event.type).toBe("codex_progress");
    expect(event.payload.itemId).toBe(CLAUDE_STEPS_ITEM_ID);
    expect(event.payload.runtime).toBe("claude");
    return event.payload.steps;
  });
}

describe("createClaudeStepTracker", () => {
  it("emits the full TodoWrite list as one snapshot per change", () => {
    const tracker = createClaudeStepTracker();
    const todos = [
      { content: "Screen papers", status: "in_progress", activeForm: "x" },
      { content: "Skim papers", status: "pending", activeForm: "y" },
    ];
    const first = tracker.observe(toolUse("t1", "TodoWrite", { todos }));
    expect(stepsOf(first)).toEqual([
      [
        { content: "Screen papers", status: "in_progress" },
        { content: "Skim papers", status: "pending" },
      ],
    ]);
    expect(first[0].payload.status).toBe("running");
    expect(first[0].payload.text).toBe("• Screen papers\n• Skim papers");

    // The same list again changes nothing.
    expect(tracker.observe(toolUse("t2", "TodoWrite", { todos }))).toEqual([]);

    const done = tracker.observe(
      toolUse("t3", "TodoWrite", {
        todos: todos.map((todo) => ({ ...todo, status: "completed" })),
      }),
    );
    expect(done[0].payload.status).toBe("completed");
    expect(stepsOf(done)[0].every((s: any) => s.status === "completed")).toBe(
      true,
    );
  });

  it("builds the list from TaskCreate then TaskUpdate", () => {
    const tracker = createClaudeStepTracker();
    const created = tracker.observe(
      toolUse("c1", "TaskCreate", { subject: "Screen", description: "d" }),
    );
    expect(stepsOf(created)).toEqual([
      [{ content: "Screen", status: "pending" }],
    ]);
    // The id arrives with the result and changes nothing visible.
    expect(
      tracker.observe(
        toolResult("c1", "Task #1 created", {
          structured: { task: { id: "1", subject: "Screen" } },
        }),
      ),
    ).toEqual([]);
    tracker.observe(toolUse("c2", "TaskCreate", { subject: "Skim" }));
    tracker.observe(toolResult("c2", "Task #2 created successfully: Skim"));

    const updated = tracker.observe(
      toolUse("u1", "TaskUpdate", { taskId: "1", status: "in_progress" }),
    );
    expect(stepsOf(updated)).toEqual([
      [
        { content: "Screen", status: "in_progress" },
        { content: "Skim", status: "pending" },
      ],
    ]);
    const renamed = tracker.observe(
      toolUse("u2", "TaskUpdate", { taskId: "2", subject: "Skim fast" }),
    );
    expect(stepsOf(renamed)[0][1]).toEqual({
      content: "Skim fast",
      status: "pending",
    });
    const deleted = tracker.observe(
      toolUse("u3", "TaskUpdate", { taskId: "1", status: "deleted" }),
    );
    expect(stepsOf(deleted)).toEqual([
      [{ content: "Skim fast", status: "pending" }],
    ]);
  });

  it("binds a TaskCreate id that arrives in a later message", () => {
    const tracker = createClaudeStepTracker();
    tracker.observe(toolUse("c1", "TaskCreate", { subject: "Screen" }));
    // Other traffic lands before the result.
    tracker.observe(toolUse("r1", "Read", { file_path: "/x" }));
    tracker.observe(toolResult("c1", "Task #7 created successfully: Screen"));
    const updated = tracker.observe(
      toolUse("u1", "TaskUpdate", { taskId: "7", status: "completed" }),
    );
    expect(stepsOf(updated)).toEqual([
      [{ content: "Screen", status: "completed" }],
    ]);
  });

  it("keeps a TaskUpdate whose result never arrives", () => {
    const tracker = createClaudeStepTracker();
    tracker.observe(toolUse("c1", "TaskCreate", { subject: "Screen" }));
    tracker.observe(
      toolResult("c1", "ok", {
        structured: { task: { id: "1", subject: "S" } },
      }),
    );
    // The bridge drops messages after `result`, so no result follows.
    const updated = tracker.observe(
      toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
    );
    expect(stepsOf(updated)).toEqual([
      [{ content: "Screen", status: "completed" }],
    ]);
  });

  it("undoes a TaskUpdate the result reports as failed", () => {
    const tracker = createClaudeStepTracker();
    tracker.observe(toolUse("c1", "TaskCreate", { subject: "Screen" }));
    tracker.observe(
      toolResult("c1", "ok", {
        structured: { task: { id: "1", subject: "S" } },
      }),
    );
    tracker.observe(
      toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
    );
    const undone = tracker.observe(
      toolResult("u1", "failed", {
        structured: { success: false, taskId: "1", updatedFields: [] },
      }),
    );
    expect(stepsOf(undone)).toEqual([
      [{ content: "Screen", status: "pending" }],
    ]);
  });

  it("drops a TaskCreate whose result is an error", () => {
    const tracker = createClaudeStepTracker();
    tracker.observe(toolUse("c1", "TaskCreate", { subject: "Screen" }));
    tracker.observe(toolUse("c2", "TaskCreate", { subject: "Skim" }));
    const dropped = tracker.observe(
      toolResult("c1", "denied", { isError: true }),
    );
    expect(stepsOf(dropped)).toEqual([
      [{ content: "Skim", status: "pending" }],
    ]);
    // An empty list is not a snapshot: the panel keeps the last steps.
    expect(
      tracker.observe(toolResult("c2", "denied", { isError: true })),
    ).toEqual([]);
  });

  it("ignores a subagent's own steps and unknown task ids", () => {
    const tracker = createClaudeStepTracker();
    expect(
      tracker.observe(
        toolUse(
          "t1",
          "TodoWrite",
          { todos: [{ content: "Sub step", status: "pending" }] },
          "toolu-parent",
        ),
      ),
    ).toEqual([]);
    expect(
      tracker.observe(
        toolUse("u1", "TaskUpdate", { taskId: "99", status: "completed" }),
      ),
    ).toEqual([]);
    expect(tracker.observe({ type: "system", subtype: "init" })).toEqual([]);
  });

  it("emits each tool_use id once", () => {
    const tracker = createClaudeStepTracker();
    const message = toolUse("c1", "TaskCreate", { subject: "Screen" });
    expect(tracker.observe(message)).toHaveLength(1);
    expect(tracker.observe(message)).toEqual([]);
  });
  it("remembers only the ids of step tools", () => {
    const tracker = createClaudeStepTracker();
    // A non-step tool reusing an id must not block a later step tool.
    expect(tracker.observe(toolUse("x1", "Bash", { command: "ls" }))).toEqual(
      [],
    );
    const events = tracker.observe(
      toolUse("x1", "TodoWrite", {
        todos: [{ content: "Screen", status: "pending" }],
      }),
    );
    expect(stepsOf(events)).toHaveLength(1);
  });

  it("sends an identical TodoWrite list again after beginTurn", () => {
    const tracker = createClaudeStepTracker();
    const todos = [{ content: "Screen", status: "pending" }];
    expect(tracker.observe(toolUse("t1", "TodoWrite", { todos }))).toHaveLength(
      1,
    );
    expect(tracker.observe(toolUse("t2", "TodoWrite", { todos }))).toEqual([]);
    tracker.beginTurn();
    expect(
      stepsOf(tracker.observe(toolUse("t3", "TodoWrite", { todos }))),
    ).toEqual([[{ content: "Screen", status: "pending" }]]);
  });
});
