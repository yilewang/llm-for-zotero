import type { ProviderEvent } from "../runtime.js";

/**
 * Rebuilds Claude's own step list for the Task progress Steps block.
 *
 * Claude keeps its steps with TodoWrite (the whole list each call) or with
 * TaskCreate and TaskUpdate (one step per call). A TaskCreate learns its id
 * only from its tool result, so the tracker pairs each call with its result.
 * Each change emits the whole list as one `codex_progress` event on the item
 * the plugin reads for Codex's plan: the same event, stored and replayed the
 * same way, with `runtime: "claude"` for where it came from.
 */

/** Must match `CODEX_PLAN_CHECKLIST_ITEM_ID` in the plugin's taskProgress/codexPlan.ts. */
export const CLAUDE_STEPS_ITEM_ID = "codex-plan-checklist";

type StepStatus = "pending" | "in_progress" | "completed";

type Step = {
  /** Claude's task id, once known (TaskCreate learns it from its result). */
  id?: string;
  content: string;
  status: StepStatus;
};

type PendingUpdate = {
  step: Step;
  before: Step;
  index: number;
  removed: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readStatus(value: unknown): StepStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => readText(asRecord(item).text))
    .filter(Boolean)
    .join("\n");
}

export type ClaudeStepTracker = {
  observe: (raw: unknown) => ProviderEvent[];
  /** A new turn starts: send the next snapshot even if it equals the last one. */
  beginTurn: () => void;
};

const STEP_TOOL_NAMES = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

export function createClaudeStepTracker(): ClaudeStepTracker {
  let steps: Step[] = [];
  let lastEmitted = "";
  const seenToolUses = new Set<string>();
  const pendingCreates = new Map<string, Step>();
  const pendingUpdates = new Map<string, PendingUpdate>();

  const snapshot = (): ProviderEvent[] => {
    const clean = steps.map(({ content, status }) => ({ content, status }));
    const key = JSON.stringify(clean);
    // An empty list is not a snapshot: the panel keeps the last steps.
    if (!clean.length || key === lastEmitted) return [];
    lastEmitted = key;
    return [
      {
        type: "codex_progress",
        payload: {
          itemId: CLAUDE_STEPS_ITEM_ID,
          // The text form older readers use; the steps are what the panel reads.
          text: clean
            .map(
              (step) =>
                `${step.status === "completed" ? "✓" : "•"} ${step.content}`,
            )
            .join("\n"),
          status: clean.every((step) => step.status === "completed")
            ? "completed"
            : "running",
          steps: clean,
          runtime: "claude",
        },
      },
    ];
  };

  const applyToolUse = (
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): void => {
    if (name === "TodoWrite") {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      steps = todos
        .map((todo) => {
          const record = asRecord(todo);
          return {
            content: readText(record.content) || readText(record.activeForm),
            status: readStatus(record.status) ?? "pending",
          };
        })
        .filter((step) => step.content);
      return;
    }
    if (name === "TaskCreate") {
      const content = readText(input.subject);
      if (!content) return;
      const step: Step = { content, status: "pending" };
      steps.push(step);
      pendingCreates.set(id, step);
      return;
    }
    if (name === "TaskUpdate") {
      const taskId = String(input.taskId ?? "");
      const index = steps.findIndex((step) => step.id === taskId);
      if (!taskId || index < 0) return;
      const step = steps[index];
      const before = { ...step };
      const status = input.status;
      if (status === "deleted") {
        steps.splice(index, 1);
        pendingUpdates.set(id, { step, before, index, removed: true });
        return;
      }
      step.content = readText(input.subject) || step.content;
      step.status = readStatus(status) ?? step.status;
      pendingUpdates.set(id, { step, before, index, removed: false });
    }
  };

  const applyToolResult = (
    block: Record<string, unknown>,
    structured: unknown,
  ): void => {
    const toolUseId = readText(block.tool_use_id);
    const failed = block.is_error === true;
    const create = pendingCreates.get(toolUseId);
    if (create) {
      pendingCreates.delete(toolUseId);
      if (failed) {
        steps = steps.filter((step) => step !== create);
        return;
      }
      const task = asRecord(asRecord(structured).task);
      const id =
        (typeof task.id === "string" || typeof task.id === "number"
          ? String(task.id)
          : "") || /#([A-Za-z0-9_-]+)/.exec(resultText(block.content))?.[1];
      if (id) create.id = id;
      return;
    }
    const update = pendingUpdates.get(toolUseId);
    if (update) {
      pendingUpdates.delete(toolUseId);
      if (!failed && asRecord(structured).success !== false) return;
      // The update did not happen: put the step back as it was.
      Object.assign(update.step, update.before);
      if (update.removed) steps.splice(update.index, 0, update.step);
    }
  };

  return {
    beginTurn() {
      // The task list stays; only the "already sent" memory is cleared.
      lastEmitted = "";
    },
    observe(raw) {
      const msg = asRecord(raw);
      // A subagent's own steps are not the run's steps.
      if (typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id)
        return [];
      const content = asRecord(msg.message).content;
      if (!Array.isArray(content)) return [];
      if (msg.type === "assistant") {
        for (const entry of content) {
          const block = asRecord(entry);
          const id = readText(block.id);
          const name = readText(block.name);
          if (
            block.type !== "tool_use" ||
            !id ||
            !STEP_TOOL_NAMES.has(name) ||
            seenToolUses.has(id)
          )
            continue;
          seenToolUses.add(id);
          applyToolUse(id, name, asRecord(block.input));
        }
      } else if (msg.type === "user") {
        const results = content
          .map(asRecord)
          .filter((block) => block.type === "tool_result");
        // The structured result belongs to the message; with several results
        // it cannot be told apart, so only the result text is read.
        for (const block of results) {
          applyToolResult(
            block,
            results.length === 1 ? msg.tool_use_result : undefined,
          );
        }
      }
      return snapshot();
    },
  };
}
