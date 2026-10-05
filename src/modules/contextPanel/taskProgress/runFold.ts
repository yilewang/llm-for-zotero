/**
 * Which run events move Task progress, and how: one reading shared by the
 * live run (the agent engine's event handler) and the rebuild of a stored
 * conversation (`history.ts`).
 *
 * The reading is pure. Each caller applies the effect with its own store
 * calls and keeps its own guards, because the two differ in what they hold:
 * the live run writes the store as events arrive, and the rebuild collects a
 * run's history first and hydrates the store once.
 *
 * Events stored with a run can be replayed; the others only have a meaning
 * while the run is live, and are never read back.
 */
import type { ExecutionCheckpointEvent } from "../../../agent/execution/checkpointEvents";
import type {
  TaskPaperDocumentCitation,
  TaskPaperLedgerDelta,
} from "../../../agent/context/taskPaperLedger";
import type { AgentEvent } from "../../../agent/types";
import { readCodexPlanChecklist } from "./codexPlan";
import type { TaskProgressStep } from "./store";

export type TaskProgressEffect =
  /** Reads landed: the run's paper ledger delta. */
  | { kind: "paper_delta"; delta: TaskPaperLedgerDelta }
  /** A submitted document's sources. */
  | {
      kind: "document_citations";
      citations: TaskPaperDocumentCitation[] | undefined;
    }
  /** The run's outcome ledger moved; fold it with `ExecutionCheckpointFold`. */
  | { kind: "outcomes"; event: ExecutionCheckpointEvent }
  /** Codex's own plan. */
  | { kind: "codex_checklist"; steps: TaskProgressStep[] }
  /** A plan ran (plan mode is retired; its stored events still say so). */
  | { kind: "plan_seen" }
  /** The answer started streaming. */
  | { kind: "answering" }
  /** The run waits on the user, or stops waiting. */
  | { kind: "waiting"; waiting: boolean }
  /** The answer is final. */
  | { kind: "final" };

/**
 * Event kinds stored with a run that a rebuild reads back. The `plan_*`
 * kinds were written by plan mode before it was retired, so the event union
 * no longer names them.
 */
export const TASK_PROGRESS_REPLAY_EVENT_TYPES = [
  "paper_ledger_update",
  "material_finalized",
  "codex_progress",
  "plan_updated",
  "plan_ready",
  "plan_execution_updated",
  "execution_checkpoint",
  "execution_checkpoint_delta",
] as const;

/** Event kinds that move Task progress only while the run is live. */
export const TASK_PROGRESS_LIVE_EVENT_TYPES = [
  "message_delta",
  "confirmation_required",
  "confirmation_resolved",
  "final",
] as const;

const PLAN_EVENT_TYPES = new Set<string>([
  "plan_updated",
  "plan_ready",
  "plan_execution_updated",
]);

/** What `event` does to Task progress, or null when it does nothing. */
export function taskProgressEffect(
  event: AgentEvent,
): TaskProgressEffect | null {
  switch (event.type) {
    case "paper_ledger_update":
      return { kind: "paper_delta", delta: event.delta };
    case "material_finalized":
      return { kind: "document_citations", citations: event.citedSources };
    case "execution_checkpoint":
    case "execution_checkpoint_delta":
      return { kind: "outcomes", event };
    case "codex_progress": {
      const steps = readCodexPlanChecklist(event);
      return steps ? { kind: "codex_checklist", steps } : null;
    }
    case "message_delta":
      return { kind: "answering" };
    case "confirmation_required":
      return { kind: "waiting", waiting: true };
    case "confirmation_resolved":
      return { kind: "waiting", waiting: false };
    case "final":
      return { kind: "final" };
    default:
      return PLAN_EVENT_TYPES.has(event.type) ? { kind: "plan_seen" } : null;
  }
}
