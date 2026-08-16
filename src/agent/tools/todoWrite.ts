import type {
  AgentModelMessage,
  AgentTodo,
  AgentTodoStatus,
  AgentToolDefinition,
} from "../types";
import { fail, ok, validateObject } from "./shared";

const MAX_TODOS = 20;
const MAX_TODO_TEXT_LENGTH = 320;
const TODO_STATUSES = new Set<AgentTodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

const todosByConversation = new Map<number, AgentTodo[]>();

type TodoWriteInput = {
  todos: AgentTodo[];
};

type TodoWriteResult = {
  todos: AgentTodo[];
  completed: string[];
  inProgress?: string;
};

function normalizeTodoText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeTodo(value: unknown): AgentTodo | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const content = normalizeTodoText(value.content);
  const activeForm = normalizeTodoText(value.activeForm);
  const status = normalizeTodoText(value.status) as AgentTodoStatus;
  if (!content || !activeForm || !TODO_STATUSES.has(status)) return null;
  if (
    content.length > MAX_TODO_TEXT_LENGTH ||
    activeForm.length > MAX_TODO_TEXT_LENGTH
  ) {
    return null;
  }
  return { content, activeForm, status };
}

function cloneTodos(todos: readonly AgentTodo[]): AgentTodo[] {
  return todos.map((todo) => ({ ...todo }));
}

function isCompletedTransition(
  todo: AgentTodo,
  previousByContent: ReadonlyMap<string, AgentTodo>,
): boolean {
  return (
    todo.status === "completed" &&
    previousByContent.get(todo.content)?.status !== "completed"
  );
}

/** Returns the current in-memory checklist for prompt restoration and tests. */
export function getAgentTodos(conversationKey: number): AgentTodo[] {
  return cloneTodos(todosByConversation.get(conversationKey) || []);
}

/** Removes a checklist when its owning conversation is cleared. */
export function clearAgentTodos(conversationKey: number): void {
  todosByConversation.delete(conversationKey);
}

/**
 * Rehydrates the list after a plugin restart from the latest todo tool result
 * retained in the agent transcript. Invalid historical entries are ignored.
 */
export function hydrateAgentTodosFromMessages(
  conversationKey: number,
  messages: readonly AgentModelMessage[],
): void {
  if (todosByConversation.has(conversationKey)) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool" || message.name !== "todo_write") continue;
    const content = typeof message.content === "string" ? message.content : "";
    try {
      const parsed = JSON.parse(content) as { todos?: unknown };
      if (!Array.isArray(parsed.todos) || !parsed.todos.length) continue;
      const todos = parsed.todos.map(normalizeTodo);
      if (todos.some((todo) => !todo)) continue;
      const normalized = todos as AgentTodo[];
      if (
        normalized.filter((todo) => todo.status === "in_progress").length > 1
      ) {
        continue;
      }
      todosByConversation.set(conversationKey, cloneTodos(normalized));
      return;
    } catch {
      // Continue searching older tool results when a transcript entry is malformed.
    }
  }
}

export function createTodoWriteTool(): AgentToolDefinition<
  TodoWriteInput,
  TodoWriteResult
> {
  return {
    spec: {
      name: "todo_write",
      description:
        "Create or update the session task list for a complex, multi-step agent task. " +
        "Send the complete current list each time, with content, activeForm, and status for every task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["todos"],
        properties: {
          todos: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TODOS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content", "activeForm", "status"],
              properties: {
                content: {
                  type: "string",
                  description:
                    "Imperative task description, for example 'Run the test suite'.",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Present-continuous progress label, for example 'Running the test suite'.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: () => true,
      instruction:
        "Use `todo_write` proactively for complex work with three or more distinct steps, multi-operation workflows, explicit user requests for progress tracking, or a list of requested tasks. Do not use it for a single straightforward action, a simple question, or pure research. When you use it, create the checklist before starting material work; mark the current item `in_progress` before working; update it immediately to `completed` only after it is fully done and verified; then advance the next item. Keep at most one item `in_progress`. Never mark an item completed when the work is partial, a required test or validation fails, or an error/blocker remains. Add follow-up tasks discovered during execution and remove tasks that are no longer relevant. Every `todo_write` call must send the complete current list.",
    },
    presentation: {
      label: "Update Todo List",
      summaries: {
        onCall: "Updating task progress",
        onSuccess: ({ content }) => {
          const result = content as Partial<TodoWriteResult> | null;
          const todos = Array.isArray(result?.todos) ? result.todos : [];
          const completed = todos.filter(
            (todo) => todo.status === "completed",
          ).length;
          return todos.length
            ? `Task progress: ${completed}/${todos.length} completed`
            : "Task progress updated";
        },
      },
      buildResultCards: (content) => {
        const result = content as Partial<TodoWriteResult> | null;
        const todos = Array.isArray(result?.todos) ? result.todos : [];
        return todos.map((todo) => ({
          title: todo.content,
          status: todo.status,
        }));
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with a todos array");
      }
      if (!Array.isArray(args.todos) || !args.todos.length) {
        return fail("todos must contain at least one task");
      }
      if (args.todos.length > MAX_TODOS) {
        return fail(`todos supports at most ${MAX_TODOS} tasks`);
      }
      const todos = args.todos.map(normalizeTodo);
      if (todos.some((todo) => !todo)) {
        return fail(
          "Each todo needs non-empty content, activeForm, and a status of pending, in_progress, or completed",
        );
      }
      const normalized = todos as AgentTodo[];
      const seen = new Set<string>();
      for (const todo of normalized) {
        const key = todo.content.toLocaleLowerCase();
        if (seen.has(key)) return fail("Todo content must be unique");
        seen.add(key);
      }
      if (
        normalized.filter((todo) => todo.status === "in_progress").length > 1
      ) {
        return fail("Only one todo may be in_progress at a time");
      }
      return ok({ todos: normalized });
    },
    execute: async (input, context) => {
      const previous = getAgentTodos(context.request.conversationKey);
      const previousByContent = new Map(
        previous.map((todo) => [todo.content, todo] as const),
      );
      const todos = cloneTodos(input.todos);
      todosByConversation.set(context.request.conversationKey, todos);
      const completed = todos
        .filter((todo) => isCompletedTransition(todo, previousByContent))
        .map((todo) => todo.content);
      return {
        todos,
        completed,
        inProgress: todos.find((todo) => todo.status === "in_progress")
          ?.content,
      };
    },
  };
}
