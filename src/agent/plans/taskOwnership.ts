import type {
  ExecutionTaskStatus,
  PlanCompletionRequirementKind,
  PlanExecutionLedger,
} from "./types";

const TERMINAL_TASK_STATUSES = new Set<ExecutionTaskStatus>([
  "completed",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);

/**
 * These requirements are completed by the tool that creates their verified
 * evidence. Mirroring that state through task_update adds a second owner and
 * can turn a successful research or document transition into a tool error.
 */
const HOST_ADVANCED_REQUIREMENTS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "material_integrity",
  "mutation_receipts",
  "research_coverage",
  "document_integrity",
  "document_published",
]);

export function planRequiresModelTaskUpdates(
  ledger: PlanExecutionLedger,
): boolean {
  const unfinishedTasks = ledger.tasks.filter(
    (task) => !TERMINAL_TASK_STATUSES.has(task.status),
  );
  if (!unfinishedTasks.length) return false;
  return unfinishedTasks.some((task) => {
    const requirements = task.completionRequirements || [];
    return (
      !requirements.length ||
      requirements.some(
        (requirement) => !HOST_ADVANCED_REQUIREMENTS.has(requirement.kind),
      )
    );
  });
}
