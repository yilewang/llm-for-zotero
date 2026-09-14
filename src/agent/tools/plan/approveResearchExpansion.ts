import type {
  AgentPendingAction,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { loadPlanArtifact } from "../../plans/store";
import { loadPlanExecutionLedger } from "../../plans/store";
import { planExecutionCoordinator } from "../../plans/coordinator";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import {
  planAmendmentService,
  type PlanAmendmentService,
} from "../../plans/amendments";
import { shouldCheckpointResearchExpansion } from "../../research/policy";
import {
  loadResearchJobForExecution,
  saveResearchJob,
} from "../../research/store";
import type { ResearchProgress } from "../../research/types";
import { fail, ok, validateObject } from "../shared";

type ApproveResearchExpansionInput = {
  proposedDeepReadCeiling: number;
  reason: string;
  decision?: "expand_continue" | "finish_limitations" | "revise_cancel";
};

function validateInput(
  args: unknown,
): AgentToolInputValidation<ApproveResearchExpansionInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("approve_research_expansion expects an object");
  }
  if (
    !Number.isInteger(args.proposedDeepReadCeiling) ||
    Number(args.proposedDeepReadCeiling) < 1
  ) {
    return fail("proposedDeepReadCeiling must be a positive integer");
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return fail("reason is required");
  return ok({
    proposedDeepReadCeiling: Number(args.proposedDeepReadCeiling),
    reason,
  });
}

function pendingAction(
  input: ApproveResearchExpansionInput,
): AgentPendingAction {
  return {
    toolName: "approve_research_expansion",
    title: "More scoped papers qualify for deep reading.",
    description:
      `${input.reason}\n\nContinue deep reading up to ` +
      `${input.proposedDeepReadCeiling} candidate papers?`,
    confirmLabel: "Continue research",
    cancelLabel: "Keep current limit",
    fields: [
      {
        type: "text",
        id: "deepReadCeiling",
        label: "Proposed deep-read ceiling",
        value: String(input.proposedDeepReadCeiling),
      },
    ],
    actions: [
      {
        id: "expand_continue",
        label: "Expand and continue",
        approved: true,
      },
      {
        id: "finish_limitations",
        label: "Finish with limitations",
        approved: true,
      },
      {
        id: "revise_cancel",
        label: "Revise or cancel",
        approved: true,
      },
    ],
    defaultActionId: "expand_continue",
    cancelActionId: "revise_cancel",
  };
}

function progress(
  job: NonNullable<Awaited<ReturnType<typeof loadResearchJobForExecution>>>,
): ResearchProgress {
  return {
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    stage: job.activeStage,
    totalItems: job.totalItems,
    screenedItems: job.screenedItems,
    candidateItems: job.candidateItems,
    deepReadCompleted: job.deepReadCompleted,
    deepReadPlanned: job.deepReadPlanned,
    coverageStatus: job.coverageStatus,
  };
}

export function createApproveResearchExpansionTool(
  amendments: PlanAmendmentService = planAmendmentService,
): AgentToolDefinition<ApproveResearchExpansionInput, unknown> {
  return {
    spec: {
      name: "approve_research_expansion",
      description:
        "Resolve a material increase in deep-read candidates. Safe asks the user; Auto and YOLO record a durable amendment and continue. This changes only reading depth, never the Zotero library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["proposedDeepReadCeiling", "reason"],
        properties: {
          proposedDeepReadCeiling: { type: "number" },
          reason: { type: "string" },
        },
      },
      executionClass: "control",
      requiresConfirmation: true,
      interaction: "user_input",
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "When research_update reports checkpointRequired, stop deep reading and call approve_research_expansion. Do not raise the ceiling through research_update. If approval is declined, either finalize a partial result at the user's direction or revise the plan to narrow scope.",
    },
    validate: validateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        reason: "This confirmation changes only the active plan workflow.",
      }),
    shouldRequireConfirmation: (_input, context) =>
      context.request.planContext?.provider === "original" &&
      getOriginalAgentPermissionMode() === "safe",
    createPendingAction: pendingAction,
    applyConfirmation: (input, data) => {
      const record = validateObject<Record<string, unknown>>(data) ? data : {};
      const decision = record.confirmationActionId;
      if (
        decision !== "expand_continue" &&
        decision !== "finish_limitations" &&
        decision !== "revise_cancel"
      ) {
        return fail("A declared research expansion decision is required");
      }
      return ok({ ...input, decision });
    },
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error("Research expansion requires approved plan execution");
      }
      const [job, artifact, ledger] = await Promise.all([
        loadResearchJobForExecution(plan.executionId),
        loadPlanArtifact(plan.planId, plan.revision),
        loadPlanExecutionLedger(plan.executionId),
      ]);
      const investigation = artifact?.contract?.investigation;
      if (
        !job ||
        !artifact ||
        artifact.digest !== plan.approvedDigest ||
        !investigation ||
        !ledger ||
        ledger.planDigest !== artifact.digest ||
        artifact.status !== "approved" ||
        ledger.executionId !== plan.executionId ||
        ["failed", "cancelled", "superseded"].includes(ledger.status)
      ) {
        throw new Error("The approved research contract is unavailable");
      }
      if (job.status !== "waiting_for_user") {
        throw new Error(
          "This research job is not waiting for an expansion decision",
        );
      }
      if (
        !shouldCheckpointResearchExpansion({
          approvedEstimate: investigation.estimatedDeepReadPapers,
          actualDeepReadCandidates: job.candidateItems,
          approvedLargeCorpus: investigation.approvedLargeCorpus,
          policy: job.policy,
        })
      ) {
        throw new Error(
          "The research expansion checkpoint is no longer required",
        );
      }
      if (
        (input.decision || "expand_continue") === "expand_continue" &&
        (input.proposedDeepReadCeiling < job.candidateItems ||
          input.proposedDeepReadCeiling <= job.deepReadPlanned)
      ) {
        throw new Error(
          "The approved ceiling must cover current candidates and exceed the prior ceiling",
        );
      }
      const now = Date.now();
      if (input.decision === "finish_limitations") {
        const next = {
          ...job,
          exceptionGrant: {
            version: 1 as const,
            grantId: `${job.researchJobId}:exception:${now}`,
            planDigest: artifact.digest,
            executionId: job.executionId,
            researchJobId: job.researchJobId,
            totalItems: job.totalItems,
            screenedItems: job.screenedItems,
            candidateItems: job.candidateItems,
            deepReadCompleted: job.deepReadCompleted,
            limitationSummary: input.reason,
            status: "authorized" as const,
            grantedAt: now,
          },
          updatedAt: now,
        };
        await saveResearchJob(next, artifact.conversationKey);
        return {
          approved: true,
          decision: input.decision,
          exceptionGrantId: next.exceptionGrant.grantId,
        };
      }
      if (input.decision === "revise_cancel") {
        const next = {
          ...job,
          status: "cancelled" as const,
          updatedAt: now,
          completedAt: now,
        };
        await saveResearchJob(next, artifact.conversationKey);
        await planExecutionCoordinator.requestTransition({
          executionId: plan.executionId,
          taskId: job.parentTaskId,
          toStatus: "cancelled",
          requestedBy: "user",
          reason: input.reason,
        });
        return { approved: true, decision: input.decision };
      }
      const next = {
        ...job,
        status: "running" as const,
        deepReadPlanned: input.proposedDeepReadCeiling,
        updatedAt: now,
      };
      const originalMode = getOriginalAgentPermissionMode();
      const mode = plan.provider === "original" ? originalMode : "native";
      const authorityDecision = amendments.decideAuthority({
        provider: plan.provider,
        originalMode,
        goalImpact: "deep_read",
        hardBlocked: false,
      });
      if (authorityDecision.kind === "block") {
        throw new Error(authorityDecision.reason);
      }
      const authority =
        authorityDecision.kind === "execute"
          ? authorityDecision.authority
          : "user";
      const previousScopeDigest =
        job.scopeLineageDigest ||
        investigation.scopeSnapshot?.digest ||
        job.snapshotId;
      const targetSetDigest = await amendments.digest({
        researchJobId: job.researchJobId,
        proposedDeepReadCeiling: input.proposedDeepReadCeiling,
      });
      const proposal = await amendments.buildProposal({
        kind: "research_ceiling",
        goalImpact: "deep_read",
        planId: artifact.planId,
        planRevision: artifact.revision,
        planDigest: artifact.digest,
        executionId: ledger.executionId,
        executionDigest: await amendments.executionIdentityDigest(ledger),
        conversationKey: artifact.conversationKey,
        previousScopeDigest,
        resultingScopeDigest: previousScopeDigest,
        targetSetDigest,
        proposalPayloadDigest: targetSetDigest,
        proposedDeepReadCeiling: input.proposedDeepReadCeiling,
        rationale: input.reason,
        now,
      });
      let grant = await amendments.authorize(proposal, authority, now);
      try {
        await Zotero.DB.executeTransaction(async () => {
          await saveResearchJob(next, artifact.conversationKey);
          grant = await amendments.markApplied(grant, now);
        });
      } catch (error) {
        await amendments.markFailed(grant, error, now);
        throw error;
      }
      await context.publishPlanEvent?.({
        type: "plan_scope_amended",
        amendmentId: proposal.amendmentId,
        executionId: plan.executionId,
        mode,
        rationale: input.reason,
        previousItemCount: job.deepReadPlanned,
        newItemCount: next.deepReadPlanned,
        authority: grant.authority,
      });
      await context.publishPlanEvent?.({
        type: "plan_research_progress",
        progress: progress(next),
      });
      return {
        approved: true,
        deepReadPlanned: next.deepReadPlanned,
        candidateItems: next.candidateItems,
      };
    },
  };
}
