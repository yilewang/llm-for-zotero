import { assert } from "chai";
import {
  clearAgentTodos,
  createTodoWriteTool,
  getAgentTodos,
  hydrateAgentTodosFromMessages,
} from "../src/agent/tools/todoWrite";

describe("todo_write", function () {
  const conversationKey = 941;

  beforeEach(function () {
    clearAgentTodos(conversationKey);
  });

  it("tracks one current task and records completion immediately", async function () {
    const tool = createTodoWriteTool();
    const initial = tool.validate({
      todos: [
        {
          content: "Inspect selected papers",
          activeForm: "Inspecting selected papers",
          status: "in_progress",
        },
        {
          content: "Write the synthesis note",
          activeForm: "Writing the synthesis note",
          status: "pending",
        },
      ],
    });
    assert.isTrue(initial.ok);
    if (!initial.ok) return;
    await tool.execute(initial.value, {
      request: {
        conversationKey,
        mode: "agent",
        userText: "Compare these papers and write a note",
      },
      item: null,
      currentAnswerText: "",
      modelName: "test",
    });

    const advanced = tool.validate({
      todos: [
        {
          content: "Inspect selected papers",
          activeForm: "Inspecting selected papers",
          status: "completed",
        },
        {
          content: "Write the synthesis note",
          activeForm: "Writing the synthesis note",
          status: "in_progress",
        },
      ],
    });
    assert.isTrue(advanced.ok);
    if (!advanced.ok) return;
    const result = await tool.execute(advanced.value, {
      request: {
        conversationKey,
        mode: "agent",
        userText: "Compare these papers and write a note",
      },
      item: null,
      currentAnswerText: "",
      modelName: "test",
    });

    assert.deepEqual(result.completed, ["Inspect selected papers"]);
    assert.equal(result.inProgress, "Write the synthesis note");
    assert.deepEqual(getAgentTodos(conversationKey), result.todos);
  });

  it("rejects concurrent in-progress tasks and malformed items", function () {
    const tool = createTodoWriteTool();
    const concurrent = tool.validate({
      todos: [
        { content: "Read", activeForm: "Reading", status: "in_progress" },
        { content: "Write", activeForm: "Writing", status: "in_progress" },
      ],
    });
    assert.isFalse(concurrent.ok);

    const malformed = tool.validate({
      todos: [{ content: "Read", activeForm: "", status: "completed" }],
    });
    assert.isFalse(malformed.ok);
  });

  it("builds compact title-only cards with a semantic status", function () {
    const tool = createTodoWriteTool();
    const cards = tool.presentation?.buildResultCards?.({
      todos: [
        {
          content: "Inspect selected papers",
          activeForm: "Inspecting selected papers",
          status: "completed",
        },
      ],
    });

    assert.deepEqual(cards, [
      {
        title: "Inspect selected papers",
        status: "completed",
      },
    ]);
  });

  it("restores the latest checklist from an agent transcript", function () {
    hydrateAgentTodosFromMessages(conversationKey, [
      {
        role: "tool",
        tool_call_id: "todo-call",
        name: "todo_write",
        content: JSON.stringify({
          todos: [
            {
              content: "Verify the exported note",
              activeForm: "Verifying the exported note",
              status: "in_progress",
            },
          ],
        }),
      },
    ]);

    assert.deepEqual(getAgentTodos(conversationKey), [
      {
        content: "Verify the exported note",
        activeForm: "Verifying the exported note",
        status: "in_progress",
      },
    ]);
  });
});
