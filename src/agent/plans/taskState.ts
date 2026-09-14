import type {
  ExecutionTask,
  ExecutionTaskStatus,
  PlanExecutionLedger,
  TaskEvidence,
  TaskTransitionRequest,
} from "./types";

export function taskStatusAfterTransition(
  ledger: PlanExecutionLedger,
  tasks: readonly ExecutionTask[],
): PlanExecutionLedger["status"] {
  const required = tasks.filter((task) => task.kind === "required_step");
  if (tasks.some((task) => task.status === "waiting_for_user"))
    return "waiting_for_user";
  if (tasks.some((task) => task.status === "in_progress")) return "running";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "interrupted")) return "interrupted";
  if (required.some((task) => task.status === "cancelled")) return "cancelled";
  if (
    required.every((task) => task.status === "completed") &&
    tasks.every(
      (task) => task.status === "completed" || task.status === "cancelled",
    )
  ) {
    return "completed";
  }
  if (
    required.every(
      (task) => task.status === "completed" || task.status === "skipped",
    ) &&
    tasks.every((task) =>
      ["completed", "skipped", "cancelled"].includes(task.status),
    )
  ) {
    return "completed_with_exceptions";
  }
  return ledger.status === "pending" ? "pending" : "running";
}

export function assertExecutionMutable(ledger: PlanExecutionLedger): void {
  if (ledger.status === "superseded") {
    throw new Error(
      `Plan execution ${ledger.executionId} was superseded by ${ledger.supersededByExecutionId || "a successor"}`,
    );
  }
}

const ALLOWED_TRANSITIONS: Record<ExecutionTaskStatus, ExecutionTaskStatus[]> =
  {
    pending: ["in_progress", "cancelled", "skipped"],
    in_progress: [
      "waiting_for_user",
      "interrupted",
      "completed",
      "blocked",
      "failed",
      "skipped",
      "cancelled",
    ],
    waiting_for_user: ["in_progress", "blocked", "skipped", "cancelled"],
    interrupted: ["in_progress", "completed", "failed", "cancelled"],
    completed: [],
    blocked: ["in_progress", "failed", "cancelled"],
    failed: ["in_progress", "cancelled"],
    skipped: [],
    cancelled: [],
  };

export function assertTaskTransitionRequest(params: {
  ledger: PlanExecutionLedger;
  task: ExecutionTask;
  request: TaskTransitionRequest;
}): void {
  const { ledger, task, request } = params;
  if (!ALLOWED_TRANSITIONS[task.status].includes(request.toStatus)) {
    throw new Error(
      `Invalid task transition: ${task.status} -> ${request.toStatus}`,
    );
  }
  if (
    request.toStatus === "in_progress" &&
    ledger.tasks.some(
      (entry) => entry.taskId !== task.taskId && entry.status === "in_progress",
    )
  ) {
    throw new Error("Only one user-visible task may be in progress");
  }
  if (
    request.toStatus === "skipped" &&
    task.kind === "required_step" &&
    request.requestedBy !== "user"
  ) {
    throw new Error("Only the user may skip an approved plan step");
  }
}

export function assertTaskCompletionEvidence(
  task: ExecutionTask,
  evidence: readonly TaskEvidence[],
): void {
  const verified = evidence.filter(
    (entry) =>
      entry.verified &&
      entry.executionId === task.executionId &&
      entry.taskId === task.taskId,
  );
  if (task.completionRequirements?.length) {
    for (const requirement of task.completionRequirements) {
      const matching = verified.filter(
        (entry) =>
          entry.requirementId === requirement.requirementId &&
          entry.contractDigest === requirement.contractDigest &&
          requirement.criterionIds.every((criterionId) =>
            entry.criterionIds?.includes(criterionId),
          ),
      );
      const satisfied =
        requirement.kind === "mutation_receipts"
          ? (() => {
              const valid = matching.filter(
                (entry) =>
                  entry.kind === "mutation_receipt" &&
                  entry.payload?.type === "mutation_receipts" &&
                  entry.payload.receiptIds.includes(entry.receipt?.id || "") &&
                  entry.receipt?.verification === "verified" &&
                  ["applied", "already_satisfied", "observed"].includes(
                    entry.receipt.status,
                  ),
              );
              return task.obligationIds.length
                ? task.obligationIds.every((obligationId) =>
                    valid.some(
                      (entry) => entry.receipt?.obligationId === obligationId,
                    ),
                  )
                : valid.length > 0;
            })()
          : matching.some((entry) => {
              if (requirement.kind === "verified_read") {
                // A reading task bound to a research scope completes only when
                // the research job reports every manifest paper durable for
                // that exact scope. Individual verified reads are evidence, not
                // completion.
                const boundScope = requirement.targetBoundary?.scopeDigest;
                if (boundScope) {
                  return (
                    entry.kind === "verified_read" &&
                    entry.payload?.type === "research_reading" &&
                    entry.payload.scopeLineageDigest === boundScope
                  );
                }
                return (
                  entry.kind === "verified_read" &&
                  entry.payload?.type === "verified_read" &&
                  Boolean(entry.payload.observations?.length)
                );
              }
              if (requirement.kind === "bounded_reasoning") {
                return (
                  entry.kind === "reasoning_assertion" &&
                  entry.payload?.type === "bounded_reasoning"
                );
              }
              if (requirement.kind === "research_coverage") {
                return (
                  entry.kind === "research_coverage" &&
                  entry.payload?.type === "research_coverage" &&
                  (!requirement.targetBoundary?.scopeDigest ||
                    entry.payload.scopeLineageDigest ===
                      requirement.targetBoundary.scopeDigest) &&
                  (entry.payload.coverageStatus === "complete" ||
                    entry.payload.coverageStatus ===
                      "complete_with_limitations")
                );
              }
              if (requirement.kind === "material_integrity") {
                return (
                  entry.kind === "material_integrity" &&
                  entry.payload?.type === "material_integrity" &&
                  entry.payload.integrityValidated &&
                  entry.payload.materialOutputId === task.materialOutputId
                );
              }
              if (requirement.kind === "document_integrity") {
                return (
                  entry.kind === "document_integrity" &&
                  entry.payload?.type === "document_integrity" &&
                  entry.payload.integrityValidated
                );
              }
              if (requirement.kind === "document_published") {
                return (
                  entry.kind === "document_published" &&
                  entry.payload?.type === "document_published"
                );
              }
              if (requirement.kind === "user_decision") {
                return (
                  entry.kind === "user_decision" &&
                  entry.payload?.type === "user_decision"
                );
              }
              return false;
            });
      if (!satisfied) {
        throw new Error(
          `Task completion requirement ${requirement.kind} (${requirement.requirementId}) is not satisfied for contract ${requirement.contractDigest}`,
        );
      }
    }
    const integrity = verified.find(
      (entry) => entry.payload?.type === "document_integrity",
    )?.payload;
    const published = verified.find(
      (entry) => entry.payload?.type === "document_published",
    )?.payload;
    if (
      integrity?.type === "document_integrity" &&
      published?.type === "document_published" &&
      (integrity.documentId !== published.documentId ||
        integrity.contentHash !== published.contentHash)
    ) {
      throw new Error(
        "Document integrity and publication evidence do not match",
      );
    }
    return;
  }
  if (task.expectedEffect === "reasoning") {
    if (!verified.some((entry) => entry.kind === "reasoning_assertion")) {
      throw new Error("Reasoning task requires a bounded completion assertion");
    }
    return;
  }
  if (task.expectedEffect === "mutation") {
    if (
      !verified.some(
        (entry) =>
          entry.kind === "mutation_receipt" &&
          entry.receipt?.verification === "verified",
      )
    ) {
      throw new Error(
        "Mutation task cannot complete without a verified receipt",
      );
    }
    return;
  }
  if (task.expectedEffect === "artifact") {
    if (
      !verified.some(
        (entry) => entry.kind === "artifact" || entry.kind === "validation",
      )
    ) {
      throw new Error(
        "Artifact task requires a verified artifact or validation result",
      );
    }
    return;
  }
  if (
    !verified.some(
      (entry) => entry.kind === "verified_read" || entry.kind === "validation",
    )
  ) {
    throw new Error("Read task requires verified read evidence");
  }
}
