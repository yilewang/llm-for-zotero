import type {
  AgentPendingAction,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { PlanAmendmentService } from "../../plans/amendments";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  loadOpenContractRevisionProposal,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../../plans/store";
import {
  computePlanContractDigest,
  planExecutionCoordinator,
  resolvePreResearchActionContract,
} from "../../plans/coordinator";
import type { PlanStep } from "../../plans/types";
import {
  createUpdatePlanTool,
  resolvePlanContract,
  type UpdatePlanInput,
  validateUpdatePlanInput,
} from "./updatePlan";
import { fail, ok, validateObject } from "../shared";

type ResearchScopeInput = {
  kind: "research_scope";
  addedTargets: Array<{ libraryID: number; itemKey: string }>;
  rationale: string;
};

type ContractRevisionInput = {
  kind: "contract_revision";
  contract: unknown;
  steps: UpdatePlanInput["steps"];
  rationale: string;
};

type AmendPlanInput = ResearchScopeInput | ContractRevisionInput;

function validateInput(
  args: unknown,
): AgentToolInputValidation<AmendPlanInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("amend_plan expects an object");
  }
  const rationale =
    typeof args.rationale === "string" ? args.rationale.trim() : "";
  if (!rationale) return fail("rationale is required");
  if (args.kind === "research_scope") {
    if (!Array.isArray(args.addedTargets) || !args.addedTargets.length) {
      return fail("research_scope requires addedTargets");
    }
    const addedTargets: ResearchScopeInput["addedTargets"] = [];
    for (let index = 0; index < args.addedTargets.length; index += 1) {
      const raw = args.addedTargets[index];
      if (!validateObject<Record<string, unknown>>(raw)) {
        return fail(`addedTargets[${index}] must be an object`);
      }
      const libraryID = Number(raw.libraryID);
      const itemKey = typeof raw.itemKey === "string" ? raw.itemKey.trim() : "";
      if (!Number.isInteger(libraryID) || libraryID < 1 || !itemKey) {
        return fail(`addedTargets[${index}] requires libraryID and itemKey`);
      }
      addedTargets.push({ libraryID, itemKey });
    }
    return ok({ kind: "research_scope", addedTargets, rationale });
  }
  if (args.kind === "contract_revision") {
    const validated = validateUpdatePlanInput({
      ready: true,
      contract: args.contract,
      steps: args.steps,
    });
    if (!validated.ok)
      return fail(validated.error.replace(/^update_plan/, "amend_plan"));
    return ok({
      kind: "contract_revision",
      contract: validated.value.contract,
      steps: validated.value.steps,
      rationale,
    });
  }
  return fail("kind must be research_scope or contract_revision");
}

function pendingAction(input: AmendPlanInput): AgentPendingAction {
  return {
    toolName: "amend_plan",
    title: "Add papers within the approved research source",
    description:
      input.kind === "research_scope"
        ? `${input.rationale}\n\nAdd ${input.addedTargets.length} exact paper target(s) and continue?`
        : input.rationale,
    confirmLabel: "Amend and continue",
    cancelLabel: "Keep current scope",
    fields: [],
  };
}

export function createAmendPlanTool(
  gateway: ZoteroGateway,
  amendments: PlanAmendmentService,
): AgentToolDefinition<AmendPlanInput, unknown> {
  const updateSchema = createUpdatePlanTool(gateway).spec.inputSchema as {
    properties?: Record<string, unknown>;
  };
  return {
    spec: {
      name: "amend_plan",
      description:
        "Create a durable amendment to an executing Plan. Use research_scope only for exact papers newly eligible inside the approved source. Use contract_revision with a complete replacement contract and steps when the question, source boundary, or deliverable changes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "rationale"],
        properties: {
          kind: {
            type: "string",
            enum: ["research_scope", "contract_revision"],
          },
          rationale: { type: "string" },
          addedTargets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["libraryID", "itemKey"],
              properties: {
                libraryID: { type: "integer", minimum: 1 },
                itemKey: { type: "string" },
              },
            },
          },
          contract: updateSchema.properties?.contract || { type: "object" },
          steps: updateSchema.properties?.steps || { type: "array" },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
      interaction: "user_input",
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "Use amend_plan research_scope when newly discovered papers are host-provably inside the approved source. Use contract_revision for a changed question, source boundary, deliverable, operation, or parameters. Never describe imports or Zotero mutations as research-scope amendments.",
    },
    validate: validateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        reason:
          "This host control persists Plan authority and updates only Plan execution state.",
      }),
    shouldRequireConfirmation: (input, context) =>
      input.kind === "research_scope" &&
      context.request.planContext?.provider === "original" &&
      getOriginalAgentPermissionMode() === "safe",
    createPendingAction: pendingAction,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error("amend_plan requires an approved Plan execution");
      }
      const originalMode = getOriginalAgentPermissionMode();
      const mode = plan.provider === "original" ? originalMode : "native";
      const decision = amendments.decideAuthority({
        provider: plan.provider,
        originalMode,
        goalImpact:
          input.kind === "contract_revision"
            ? "contract_revision"
            : "within_goal",
        hardBlocked: false,
      });
      if (decision.kind === "block") throw new Error(decision.reason);
      if (input.kind === "research_scope") {
        const authority =
          decision.kind === "execute" ? decision.authority : "user";
        const result = await amendments.applyResearchScopeAmendment({
          plan,
          conversationKey: context.request.conversationKey,
          addedTargets: input.addedTargets,
          rationale: input.rationale,
          authority,
        });
        await context.publishPlanEvent?.({
          type: "plan_scope_amended",
          amendmentId: result.grant.proposal.amendmentId,
          executionId: plan.executionId,
          mode,
          rationale: input.rationale,
          previousItemCount: result.previousItemCount,
          newItemCount: result.newItemCount,
          authority: result.grant.authority,
        });
        return {
          amendmentId: result.grant.proposal.amendmentId,
          snapshotId: result.job.snapshotId,
          scopeLineageDigest: result.job.scopeLineageDigest,
          totalItems: result.job.totalItems,
        };
      }

      const [priorArtifact, priorLedger] = await Promise.all([
        loadPlanArtifact(plan.planId, plan.revision),
        loadPlanExecutionLedger(plan.executionId),
      ]);
      if (
        !priorArtifact ||
        !priorLedger ||
        priorArtifact.digest !== plan.approvedDigest ||
        priorArtifact.status !== "approved" ||
        priorLedger.executionId !== plan.executionId ||
        ["failed", "cancelled", "superseded"].includes(priorLedger.status) ||
        priorArtifact.conversationKey !== context.request.conversationKey
      ) {
        throw new Error("The approved Plan identity changed before revision");
      }
      const revision = plan.revision + 1;
      if (await loadPlanArtifact(plan.planId, revision)) {
        throw new Error(
          "A successor Plan revision already exists; review it or request changes from its Plan card.",
        );
      }
      const contract = await resolvePlanContract({
        raw: input.contract,
        steps: input.steps,
        ready: true,
        gateway,
        planId: plan.planId,
        revision,
        conversationKey: context.request.conversationKey,
      });
      const normalizedSteps: UpdatePlanInput["steps"] = input.steps.map(
        (step, index) => ({
          ...step,
          planStepId:
            typeof step.planStepId === "string" && step.planStepId.trim()
              ? step.planStepId.trim()
              : `${plan.planId}:r${revision}:s${index + 1}`,
        }),
      );
      const replacementActionContract =
        resolvePreResearchActionContract(contract);
      amendments.assertContractRevisionHardBoundaries({
        priorActionContract:
          priorArtifact.actionContract || context.request.actionContract,
        replacementActionContract,
        replacementHasEffects: Boolean(contract.effects),
      });
      const resultingScopeDigest = await computePlanContractDigest(contract);
      const proposal = await amendments.buildProposal({
        kind: "contract_revision",
        goalImpact: "contract_revision",
        planId: plan.planId,
        planRevision: plan.revision,
        planDigest: priorArtifact.digest,
        executionId: plan.executionId,
        executionDigest: await amendments.executionIdentityDigest(priorLedger),
        conversationKey: context.request.conversationKey,
        previousScopeDigest:
          priorArtifact.contractDigest || priorArtifact.digest,
        resultingScopeDigest,
        targetSetDigest: await amendments.digest(
          contract.investigation?.scope || contract.deliverable,
        ),
        proposalPayloadDigest: await amendments.digest({
          contract,
          steps: normalizedSteps,
        }),
        replacementContract: contract,
        replacementSteps: normalizedSteps as readonly PlanStep[],
        replacementActionContract,
        rationale: input.rationale,
      });
      let grant:
        | Awaited<ReturnType<PlanAmendmentService["authorize"]>>
        | undefined;
      let amendmentCommitted = false;
      try {
        const openProposal = await loadOpenContractRevisionProposal(
          proposal.planId,
        );
        if (
          openProposal &&
          (openProposal.executionId !== proposal.executionId ||
            openProposal.planRevision !== proposal.planRevision)
        ) {
          throw new Error(
            "Another successor revision already owns this Plan amendment lineage",
          );
        }
        if (
          openProposal &&
          openProposal.proposalDigest !== proposal.proposalDigest
        ) {
          await amendments.supersedeProposal(
            openProposal.proposalDigest,
            proposal,
          );
        } else {
          await amendments.stageProposal(proposal);
        }
        grant =
          decision.kind === "execute"
            ? await amendments.authorize(proposal, decision.authority)
            : undefined;
        const actionContract = replacementActionContract;
        const artifact = await planExecutionCoordinator.updateDraft({
          planId: plan.planId,
          conversationKey: context.request.conversationKey,
          provider: plan.provider,
          revision,
          explanation: input.rationale,
          steps: normalizedSteps,
          contract,
          actionContractId: actionContract?.id,
          actionContract,
          sourceRunId: context.runId,
          ready: true,
        });
        if (decision.kind !== "execute") {
          const active = priorLedger.tasks.find(
            (task) => task.taskId === priorLedger.activeTaskId,
          );
          if (active?.status === "in_progress") {
            await planExecutionCoordinator.requestTransition({
              executionId: priorLedger.executionId,
              taskId: active.taskId,
              toStatus: "waiting_for_user",
              requestedBy: "host",
              reason: "A successor Plan revision is awaiting approval.",
            });
          }
          await context.publishPlanEvent?.({ type: "plan_ready", artifact });
          return {
            amendmentId: proposal.amendmentId,
            artifact,
            awaitingApproval: true,
          };
        }
        let successor = await planExecutionCoordinator.approve({
          planId: plan.planId,
          revision,
          conversationGeneration: context.request.conversationGeneration || 0,
          providerContinuationId: priorLedger.providerContinuationId,
          authority: decision.authority,
        });
        amendmentCommitted = true;
        successor = await planExecutionCoordinator.startNextTask(
          successor.executionId,
        );
        await context.publishPlanEvent?.({
          type: "plan_scope_amended",
          amendmentId: proposal.amendmentId,
          executionId: proposal.executionId,
          mode,
          rationale: input.rationale,
          previousItemCount:
            priorArtifact.contract?.investigation?.scopeSnapshot?.itemCount ||
            0,
          newItemCount:
            artifact.contract?.investigation?.scopeSnapshot?.itemCount || 0,
          authority: decision.authority,
        });
        await context.publishPlanEvent?.({
          type: "plan_execution_updated",
          ledger: successor,
        });
        return {
          amendmentId: proposal.amendmentId,
          successorExecutionId: successor.executionId,
          awaitingApproval: false,
        };
      } catch (error) {
        if (!amendmentCommitted) {
          if (grant) await amendments.markFailed(grant, error);
          else await amendments.markProposalFailed(proposal);
        }
        throw error;
      }
    },
  };
}
