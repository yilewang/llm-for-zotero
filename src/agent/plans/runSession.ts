import type {
  AgentEvent,
  AgentRuntimeRequest,
  AgentToolArtifact,
  AgentToolResult,
} from "../types";
import { loadPlanArtifact, loadPlanExecutionLedger } from "./store";
import { planExecutionCoordinator } from "./coordinator";
import type { PlanExecutionLedger, PlanEvent, TaskEvidence } from "./types";
import type { PlanRuntimeContext } from "./types";
import type { ZoteroMcpToolActivityEvent } from "../mcp/server";
import {
  interruptResearchExecution,
  loadLatestResearchMutationApprovalGrant,
} from "../research/store";
import { validateResearchMutationGrant } from "../research/mutationApproval";
import {
  loadLatestPlanDocumentForExecution,
  loadPlanDocumentOutbox,
} from "../documents/store";
import { createTrustedReadObservations } from "./readObservation";
import { planRequiresModelTaskUpdates } from "./taskOwnership";

export function buildPlanFinalCorrection(
  failure: string,
  requiresDocument: boolean,
  documentTaskActive = requiresDocument,
  modelTaskUpdatesRequired = true,
): string {
  if (requiresDocument && documentTaskActive) {
    return `${failure}. This approved plan requires a published document. Do not stop with ordinary answer text and do not try to complete the document task with task_update. Call submit_document now with the model-authored Markdown plus its citation and evidence mappings. If validation rejects the submission, correct the reported fields and call submit_document again; the host finalizer owns References, publication evidence, and completion of the document task.`;
  }
  if (!modelTaskUpdatesRequired) {
    return requiresDocument
      ? `${failure}. Complete the current approved research task: continue with the active research tool; the host advances its task state from verified evidence. Once the document task becomes active, call submit_document with the model-authored Markdown plus its citation and evidence mappings.`
      : `${failure}. Continue with the active scholarly tool; the host advances its task state from verified evidence.`;
  }
  return requiresDocument
    ? `${failure}. Complete the current approved task before attempting document publication. Use task_update only after the current task has its required verified evidence. Once the document task becomes active, call submit_document with the model-authored Markdown plus its citation and evidence mappings; do not try to complete the document task with task_update.`
    : `${failure}. Continue the approved plan. Use task_update only after the current task has verified evidence; do not claim completion from model judgment alone.`;
}

export function shouldOfferPlanFinalCorrection(params: {
  canCorrect: boolean;
  successfulToolResultCount: number;
  lastCorrectionSuccessfulToolCount: number;
}): boolean {
  return (
    params.canCorrect &&
    params.successfulToolResultCount > params.lastCorrectionSuccessfulToolCount
  );
}

export async function recordMcpPlanEvidence(
  plan: PlanRuntimeContext | undefined,
  event: ZoteroMcpToolActivityEvent,
): Promise<PlanExecutionLedger | null> {
  if (plan?.phase !== "executing" || event.phase !== "completed" || !event.ok) {
    return null;
  }
  let ledger = await loadPlanExecutionLedger(plan.executionId);
  const taskId = ledger?.activeTaskId;
  if (!ledger || !taskId) return null;
  if (event.actionReceipts?.length) {
    ledger = await planExecutionCoordinator.attachReceiptEvidence({
      executionId: plan.executionId,
      taskId,
      receipts: event.actionReceipts,
    });
  }
  const evidence = async (
    kind: TaskEvidence["kind"],
    reference: string,
    summary: string,
    payload?: TaskEvidence["payload"],
  ) => {
    const task = ledger?.tasks.find((entry) => entry.taskId === taskId);
    const requirementKind =
      kind === "reasoning_assertion" ? "bounded_reasoning" : kind;
    const requirement = task?.completionRequirements?.find(
      (entry) => entry.kind === requirementKind,
    );
    ledger = await planExecutionCoordinator.attachEvidence({
      version: requirement ? 3 : 1,
      evidenceId: `${plan.executionId}:${taskId}:${kind}:${event.requestId}`,
      executionId: plan.executionId,
      taskId,
      kind,
      verified: true,
      requirementId: requirement?.requirementId,
      criterionIds: requirement?.criterionIds,
      contractDigest: requirement?.contractDigest,
      payload:
        payload ||
        (requirement?.kind === "verified_read"
          ? {
              type: "verified_read",
              reference,
              sources: event.verifiedReadSources,
              observations: event.readObservations,
            }
          : requirement?.kind === "bounded_reasoning"
            ? { type: "bounded_reasoning", assertion: summary }
            : undefined),
      reference,
      summary,
      createdAt: event.timestamp,
    });
  };
  if (event.mutability === "read") {
    await evidence(
      "verified_read",
      `mcp:${event.requestId}`,
      `Verified ${event.toolName} result`,
    );
  }
  if (event.artifacts?.length) {
    await evidence(
      "artifact",
      `mcp:${event.requestId}:artifacts`,
      `${event.artifacts.length} durable artifact${event.artifacts.length === 1 ? "" : "s"}`,
      {
        type: "tool_artifacts",
        artifacts: event.artifacts.map((artifact) => ({
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          storedPath: artifact.storedPath,
          contentHash: artifact.contentHash,
        })),
      },
    );
  }
  return planExecutionCoordinator.advanceVerifiedTasks({
    executionId: plan.executionId,
    requirementKinds: [
      "verified_read",
      "material_integrity",
      "mutation_receipts",
    ],
  });
}

export type PlanFinalDecision =
  | { kind: "accept" }
  | { kind: "correct"; correction: string }
  | { kind: "fail"; failure: string };

export class PlanExecutionRunSession {
  private lastCorrectionSuccessfulToolCount = -1;
  private ledger: PlanExecutionLedger | null = null;

  constructor(
    private readonly request: Pick<
      AgentRuntimeRequest,
      | "conversationKey"
      | "planContext"
      | "actionContract"
      | "actionProgress"
      | "classifiedIntent"
    >,
    private readonly emit: (event: AgentEvent) => Promise<void>,
  ) {}

  async initialize(): Promise<
    { kind: "ready" } | { kind: "failed"; userMessage: string }
  > {
    const plan = this.request.planContext;
    if (!plan) return { kind: "ready" };
    if (plan.phase === "planning") {
      const existing = await loadPlanArtifact(plan.planId, plan.revision);
      if (existing?.status === "approved") {
        return {
          kind: "failed",
          userMessage: "This plan revision is already approved and immutable.",
        };
      }
      return { kind: "ready" };
    }
    const ledger = await loadPlanExecutionLedger(plan.executionId);
    if (!ledger) {
      return {
        kind: "failed",
        userMessage: "The approved plan execution ledger could not be loaded.",
      };
    }
    if (
      ledger.planId !== plan.planId ||
      ledger.revision !== plan.revision ||
      ledger.planDigest !== plan.approvedDigest ||
      ledger.conversationKey !== this.request.conversationKey
    ) {
      return {
        kind: "failed",
        userMessage:
          "The approved plan identity no longer matches this conversation.",
      };
    }
    const artifact = await loadPlanArtifact(plan.planId, plan.revision);
    if (!artifact || artifact.digest !== plan.approvedDigest) {
      return {
        kind: "failed",
        userMessage: "The approved plan artifact is unavailable or changed.",
      };
    }
    if (
      artifact.version !== 4 ||
      ledger.version !== 2 ||
      ledger.tasks.some((task) => task.version !== 2) ||
      (artifact.actionContract && artifact.actionContract.version !== 4)
    ) {
      return {
        kind: "failed",
        userMessage:
          "This plan uses a legacy execution schema and is history-only. Create and approve a new plan to continue.",
      };
    }
    if (artifact.actionContract) {
      this.request.actionContract = artifact.actionContract;
      this.request.classifiedIntent = artifact.actionContract.intent;
      if (
        this.request.actionProgress?.contractId !== artifact.actionContract.id
      ) {
        this.request.actionProgress = undefined;
      }
    } else if (
      artifact.contract?.effects?.libraryMutation.approval === "after_research"
    ) {
      // Never retain an action contract inferred from the synthetic execution
      // prompt. Only the separately approved exact-target grant is authority.
      this.request.actionContract = undefined;
      this.request.actionProgress = undefined;
      const grant = await loadLatestResearchMutationApprovalGrant(
        plan.executionId,
      );
      if (grant?.status === "approved") {
        try {
          this.request.actionContract = await validateResearchMutationGrant({
            grant,
            artifact,
          });
        } catch {
          // A stale grant is never authority. The model must show a refreshed
          // exact-target preview before attempting another write.
        }
      }
    }
    this.ledger = await planExecutionCoordinator.startNextTask(
      plan.executionId,
    );
    this.request.planContext = {
      ...plan,
      activeTaskId: this.ledger.activeTaskId,
    };
    await this.publish({ type: "plan_execution_updated", ledger: this.ledger });
    return { kind: "ready" };
  }

  activeWorkflowObligationIds(): readonly string[] | undefined {
    const plan = this.request.planContext;
    if (!plan) return undefined;
    if (plan.phase !== "executing") return [];
    return (
      this.ledger?.tasks.find(
        (task) => task.taskId === this.ledger?.activeTaskId,
      )?.obligationIds || []
    );
  }

  workflowProgress() {
    if (this.request.planContext?.phase !== "executing" || !this.ledger)
      return undefined;
    const active = this.ledger.tasks.find(
      (task) => task.taskId === this.ledger!.activeTaskId,
    );
    return {
      executionId: this.ledger.executionId,
      activeTask: active
        ? {
            taskId: active.taskId,
            content: active.content,
            materialOutputId: active.materialOutputId,
            expectedEffect: active.expectedEffect,
          }
        : null,
      completedTaskIds: this.ledger.tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.taskId),
    };
  }

  async recordToolResult(params: {
    toolName: string;
    executionClass?: "read" | "control" | "external_effect";
    input?: unknown;
    result: AgentToolResult;
    artifacts?: AgentToolArtifact[];
    runId: string;
  }): Promise<void> {
    const plan = this.request.planContext;
    if (!plan || plan.phase !== "executing") return;
    let ledger = await loadPlanExecutionLedger(plan.executionId);
    const taskId = ledger?.activeTaskId;
    if (!ledger || !taskId) return;
    if (params.result.actionReceipts.length) {
      ledger = await planExecutionCoordinator.attachReceiptEvidence({
        executionId: plan.executionId,
        taskId,
        receipts: params.result.actionReceipts,
      });
    }
    if (params.result.ok && params.executionClass === "read") {
      const reference = `${params.runId}:${params.result.callId}`;
      const observations = await createTrustedReadObservations({
        toolName: params.toolName,
        callId: params.result.callId,
        input: params.input,
        result: params.result.content,
      });
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "verified_read",
          verified: true,
          payload: {
            type: "verified_read",
            reference,
            sources: observations.map(
              ({
                libraryID,
                itemKey,
                attachmentItemKey,
                pageIndex,
                sourceFingerprint,
              }) => ({
                libraryID,
                itemKey,
                attachmentItemKey,
                pageIndex,
                sourceFingerprint,
              }),
            ),
            observations,
          },
          reference,
          summary: `Verified result from ${params.toolName}`,
        }),
      );
    }
    if (params.result.ok && params.artifacts?.length) {
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "artifact",
          verified: true,
          payload: {
            type: "tool_artifacts",
            artifacts: params.artifacts.map((artifact) => ({
              kind: artifact.kind,
              mimeType: artifact.mimeType,
              storedPath: artifact.storedPath,
              contentHash: artifact.contentHash,
            })),
          },
          reference: `${params.runId}:${params.result.callId}:artifacts`,
          summary: `${params.artifacts.length} durable artifact${params.artifacts.length === 1 ? "" : "s"}`,
        }),
      );
    }
    const deniedError =
      params.result.content &&
      typeof params.result.content === "object" &&
      !Array.isArray(params.result.content) &&
      typeof (params.result.content as { error?: unknown }).error === "string"
        ? (params.result.content as { error: string }).error
        : "";
    if (
      !params.result.ok &&
      params.toolName === "approve_research_mutation" &&
      deniedError.toLowerCase() === "user denied action"
    ) {
      ledger = await planExecutionCoordinator.attachEvidence({
        version: 1,
        evidenceId: `${plan.executionId}:${taskId}:research-mutation-declined:${params.result.callId}`,
        executionId: plan.executionId,
        taskId,
        kind: "validation",
        verified: true,
        reference: `user-declined:${params.result.callId}`,
        summary:
          "The user declined the exact research-selected mutation preview",
        createdAt: Date.now(),
      });
    }
    ledger = await planExecutionCoordinator.advanceVerifiedTasks({
      executionId: plan.executionId,
      requirementKinds: [
        "verified_read",
        "material_integrity",
        "mutation_receipts",
      ],
    });
    this.ledger = ledger;
    this.request.planContext = {
      ...plan,
      activeTaskId: ledger.activeTaskId,
    };
    await this.publish({ type: "plan_execution_updated", ledger });
  }

  async interrupt(reason: string): Promise<void> {
    const plan = this.request.planContext;
    if (!plan || plan.phase !== "executing") return;
    let ledger = await loadPlanExecutionLedger(plan.executionId);
    const task = ledger?.tasks.find(
      (entry) => entry.taskId === ledger?.activeTaskId,
    );
    if (!ledger || !task || task.status !== "in_progress") return;
    ledger = await planExecutionCoordinator.requestTransition({
      executionId: plan.executionId,
      taskId: task.taskId,
      toStatus: "interrupted",
      requestedBy: plan.provider,
      reason,
    });
    await interruptResearchExecution({
      executionId: plan.executionId,
      conversationKey: this.request.conversationKey,
    });
    this.ledger = ledger;
    this.request.planContext = {
      ...plan,
      activeTaskId: undefined,
    };
    await this.publish({ type: "plan_execution_updated", ledger });
  }

  async evaluateFinal(params: {
    canCorrect: boolean;
    successfulToolResultCount?: number;
  }): Promise<PlanFinalDecision> {
    const successfulToolResultCount = Math.max(
      0,
      params.successfulToolResultCount || 0,
    );
    const canOfferCorrection = shouldOfferPlanFinalCorrection({
      canCorrect: params.canCorrect,
      successfulToolResultCount,
      lastCorrectionSuccessfulToolCount: this.lastCorrectionSuccessfulToolCount,
    });
    const plan = this.request.planContext;
    if (!plan) return { kind: "accept" };
    if (plan.phase === "planning") {
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      if (artifact?.status === "awaiting_approval") {
        await this.publish({ type: "plan_ready", artifact });
        return { kind: "accept" };
      }
      const correction =
        "Finish the planning phase by calling update_plan with objective acceptance criteria for every step and ready=true. Do not execute any mutation.";
      if (canOfferCorrection) {
        this.lastCorrectionSuccessfulToolCount = successfulToolResultCount;
        return { kind: "correct", correction };
      }
      return {
        kind: "fail",
        failure: "The provider stopped before producing a reviewable plan.",
      };
    }
    try {
      this.ledger = await loadPlanExecutionLedger(plan.executionId);
      const document = await loadLatestPlanDocumentForExecution(
        plan.executionId,
      );
      if (document) {
        const outbox = await loadPlanDocumentOutbox(document.documentId);
        if (outbox?.status === "pending" || outbox?.status === "delivered") {
          // Publication completion is committed only after the application
          // persists this exact visible message.
          return { kind: "accept" };
        }
      }
      this.ledger = await planExecutionCoordinator.assertCanFinalize(
        plan.executionId,
      );
      await this.publish({
        type: "plan_execution_updated",
        ledger: this.ledger,
      });
      return { kind: "accept" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (canOfferCorrection) {
        this.lastCorrectionSuccessfulToolCount = successfulToolResultCount;
        const artifact = await loadPlanArtifact(plan.planId, plan.revision);
        const requiresDocument =
          artifact?.version === 4 &&
          artifact.contract?.deliverable.kind === "document";
        const activeTask = this.ledger?.tasks.find(
          (task) => task.taskId === this.ledger?.activeTaskId,
        );
        return {
          kind: "correct",
          correction: buildPlanFinalCorrection(
            message,
            requiresDocument,
            activeTask?.expectedEffect === "artifact",
            this.ledger ? planRequiresModelTaskUpdates(this.ledger) : true,
          ),
        };
      }
      return { kind: "fail", failure: message };
    }
  }

  private makeEvidence(
    params: Omit<TaskEvidence, "version" | "evidenceId" | "createdAt">,
  ): TaskEvidence {
    const createdAt = Date.now();
    const task = this.ledger?.tasks.find(
      (entry) => entry.taskId === params.taskId,
    );
    const requirementKind =
      params.kind === "reasoning_assertion" ? "bounded_reasoning" : params.kind;
    const requirement = task?.completionRequirements?.find(
      (entry) => entry.kind === requirementKind,
    );
    return {
      version: requirement ? 3 : 1,
      evidenceId: `${params.executionId}:${params.taskId}:${params.kind}:${createdAt}:${Math.random().toString(36).slice(2, 7)}`,
      ...params,
      requirementId: requirement?.requirementId,
      criterionIds: requirement?.criterionIds,
      contractDigest: requirement?.contractDigest,
      payload:
        params.payload ||
        (requirement?.kind === "verified_read"
          ? {
              type: "verified_read",
              reference: params.reference || params.summary || "verified read",
            }
          : requirement?.kind === "bounded_reasoning"
            ? {
                type: "bounded_reasoning",
                assertion:
                  params.summary || params.reference || "Reasoning completed",
              }
            : undefined),
      createdAt,
    };
  }

  private async publish(event: PlanEvent): Promise<void> {
    await this.emit(event);
  }
}
