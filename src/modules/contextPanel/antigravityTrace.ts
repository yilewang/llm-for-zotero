import type { AntigravityActivity } from "../../antigravity/runtime";

/**
 * One agy tool step as a trace row. agy names the tool (`view_file`) and
 * describes the call (`Reading paper.md`), and that description is the row;
 * the step index keeps a step's start and finish on one row.
 */
export function toAntigravityTraceStep(activity: AntigravityActivity): {
  itemId: string;
  phase: "started" | "completed";
  toolName: string;
  text?: string;
  ok?: boolean;
} {
  const summary = activity.summary?.trim() || "";
  const done = activity.phase === "completed";
  const text =
    done && activity.failed
      ? `${summary || activity.toolName.replace(/_/g, " ")} failed`
      : summary;
  return {
    itemId: `agy-step-${activity.stepIndex}`,
    phase: activity.phase,
    toolName: activity.toolName,
    ...(text ? { text } : {}),
    ...(done ? { ok: !activity.failed } : {}),
  };
}
