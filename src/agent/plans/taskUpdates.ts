import type { AgentActionReceipt } from "../contracts/types";
import {
  listTaskEvidence,
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "./store";
import {
  assertExecutionMutable,
  assertTaskCompletionEvidence,
  assertTaskTransitionRequest,
  taskStatusAfterTransition,
} from "./taskState";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
  TaskTransitionRequest,
} from "./types";

type TaskUpdate = {
  executionId: string;
  taskId: string;
  now?: number;
  alreadyInTransaction?: boolean;
} & (
  | { kind: "evidence"; evidence: readonly TaskEvidence[] }
  | { kind: "receipts"; receipts: readonly AgentActionReceipt[] }
  | {
      kind: "transition";
      request: TaskTransitionRequest;
      evidence?: readonly TaskEvidence[];
    }
);

function receiptEvidence(
  task: ExecutionTask,
  receipts: readonly AgentActionReceipt[],
  now: number,
): TaskEvidence[] {
  const requirement = task.completionRequirements?.find(
    (entry) => entry.kind === "mutation_receipts",
  );
  return receipts.map((receipt) => {
    const evidenceId = `${task.executionId}:${task.taskId}:receipt:${receipt.id}`;
    const verified =
      receipt.verification === "verified" &&
      ["applied", "already_satisfied", "observed"].includes(receipt.status);
    const evidence: TaskEvidence = {
      version: requirement ? 3 : 1,
      evidenceId,
      executionId: task.executionId,
      taskId: task.taskId,
      kind: "mutation_receipt",
      verified,
      requirementId: requirement?.requirementId,
      criterionIds: requirement?.criterionIds,
      contractDigest: requirement?.contractDigest,
      receipt,
      payload: requirement
        ? { type: "mutation_receipts", receiptIds: [receipt.id] }
        : undefined,
      reference: receipt.evidenceRef,
      summary: receipt.verifiedFacts.join("; ") || receipt.reasons.join("; "),
      createdAt: now,
    };
    return evidence;
  });
}

/** Calculate every transition with the same status, timing and attempt rules. */
function transitionLedger(
  ledger: PlanExecutionLedger,
  task: ExecutionTask,
  request: TaskTransitionRequest,
  now: number,
): PlanExecutionLedger {
  const updatedTask: ExecutionTask = {
    ...task,
    status: request.toStatus,
    attemptCount:
      request.toStatus === "in_progress"
        ? task.attemptCount + 1
        : task.attemptCount,
    failureReasons:
      request.reason && ["blocked", "failed"].includes(request.toStatus)
        ? [...task.failureReasons, request.reason]
        : task.failureReasons,
    updatedAt: now,
    startedAt:
      request.toStatus === "in_progress"
        ? task.startedAt || now
        : task.startedAt,
    completedAt:
      request.toStatus === "completed" || request.toStatus === "skipped"
        ? now
        : task.completedAt,
  };
  const tasks = ledger.tasks.map((entry) =>
    entry.taskId === task.taskId ? updatedTask : entry,
  );
  const status = taskStatusAfterTransition(ledger, tasks);
  const terminal = [
    "completed",
    "completed_with_exceptions",
    "blocked",
    "failed",
    "cancelled",
  ].includes(status);
  const updated: PlanExecutionLedger = {
    ...ledger,
    tasks,
    status,
    activeTaskId:
      request.toStatus === "in_progress"
        ? task.taskId
        : ledger.activeTaskId === task.taskId
          ? undefined
          : ledger.activeTaskId,
    updatedAt: now,
    completedAt: terminal ? now : ledger.completedAt,
  };
  return updated;
}

/** Evidence, task references and transition history are one durable update.
 * Read the ledger inside the transaction so callers cannot overwrite a newer
 * task snapshot while waiting for a previous database transaction to finish. */
export async function updatePlanTask(
  params: TaskUpdate,
): Promise<PlanExecutionLedger> {
  const write = async () => {
    const ledger = await loadPlanExecutionLedger(params.executionId);
    if (!ledger) throw new Error("Plan execution ledger not found");
    assertExecutionMutable(ledger);
    const task = ledger.tasks.find((entry) => entry.taskId === params.taskId);
    if (!task) throw new Error("Execution task not found");
    const now = params.now ?? Date.now();
    const evidence =
      params.kind === "receipts"
        ? receiptEvidence(task, params.receipts, now)
        : params.evidence || [];
    for (const entry of evidence) {
      if (
        entry.executionId !== ledger.executionId ||
        entry.taskId !== task.taskId ||
        (params.kind === "transition" && !entry.verified)
      )
        throw new Error("Transition evidence does not match the active task");
    }
    if (params.kind === "transition")
      assertTaskTransitionRequest({ ledger, task, request: params.request });
    for (const entry of evidence) await saveTaskEvidence(entry);
    const taskWithEvidence: ExecutionTask = {
      ...task,
      evidenceIds: [
        ...new Set([
          ...task.evidenceIds,
          ...evidence.map((entry) => entry.evidenceId),
        ]),
      ],
      updatedAt: now,
    };
    if (params.kind === "transition" && params.request.toStatus === "completed")
      assertTaskCompletionEvidence(
        taskWithEvidence,
        await listTaskEvidence(ledger.executionId, task.taskId),
      );
    const updated =
      params.kind === "transition"
        ? transitionLedger(ledger, taskWithEvidence, params.request, now)
        : {
            ...ledger,
            tasks: ledger.tasks.map((entry) =>
              entry.taskId === task.taskId ? taskWithEvidence : entry,
            ),
            updatedAt: now,
          };
    await savePlanExecutionLedger(
      updated,
      params.kind === "transition"
        ? {
            taskId: task.taskId,
            fromStatus: task.status,
            toStatus: params.request.toStatus,
            payload: {
              requestedBy: params.request.requestedBy,
              reason: params.request.reason,
              ...(evidence.length
                ? { evidenceId: evidence[0].evidenceId }
                : {}),
            },
            createdAt: now,
          }
        : undefined,
      { alreadyInTransaction: true },
    );
    return updated;
  };
  return params.alreadyInTransaction
    ? write()
    : Zotero.DB.executeTransaction(write);
}
