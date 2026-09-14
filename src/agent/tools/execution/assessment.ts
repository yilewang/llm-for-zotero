import { resolveActionInteraction } from "../../authorization/interaction";
import { defaultInvocationPlan } from "../../authorization/invocationPlan";
import {
  authorizeOriginalAction,
  authorizeExternalAction,
} from "../../authorization/policy";
import { buildActionProposal } from "../../authorization/proposal";
import type {
  ActionInteraction,
  ActionProposal,
  AuthorizationDecision,
} from "../../authorization/types";
import {
  ActionContractService,
  type PreparedActionExecution,
  type ScopeValidationFailure,
} from "../../contracts/actionContract";
import { prepareActionExecution } from "../../contracts/actionOperationEvidence";
import { preparationEffectBlock } from "../../contracts/actionPreparation";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import { isAgentChangeJournalAvailable } from "../../store/changeJournal";
import type {
  AgentInvocationPlan,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecutionOptions,
} from "../../types";

export type AssessedInvocation = {
  input: unknown;
  plan: AgentInvocationPlan;
  preparedAction?: PreparedActionExecution;
  proposal: ActionProposal;
  scopeFailure: ScopeValidationFailure | null;
  interaction: ActionInteraction;
  authorization: AuthorizationDecision;
};

function completePlan(value: unknown): value is AgentInvocationPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    ["none", "shell", "zotero_script"].includes(String(plan.mechanism)) &&
    ["read_only", "state_change", "ambiguous", "prohibited"].includes(
      String(plan.impact),
    ) &&
    ["runtime_enforced", "statically_recognized", "unknown"].includes(
      String(plan.assurance),
    ) &&
    ["domains", "effects", "targets", "riskSignals"].every((key) =>
      Array.isArray(plan[key]),
    ) &&
    ["full", "partial", "none"].includes(String(plan.reversibility)) &&
    typeof plan.reason === "string" &&
    Boolean(plan.reason.trim())
  );
}

/** Exact invocation assessment is shared by preparation, edited review and execution. */
export class InvocationAssessor {
  constructor(
    readonly tool: AgentToolDefinition<any, any>,
    readonly context: AgentToolContext,
    readonly options: PreparedToolExecutionOptions,
    readonly contracts?: ActionContractService,
  ) {}

  async assess(
    input: unknown,
    concreteWrite = true,
  ): Promise<AssessedInvocation> {
    const { tool, context, options, contracts } = this;
    const request = context.request;
    const delegated = context.authorization?.kind === "external_runtime";
    const plan = await (
      tool.planInvocation ||
      (() => defaultInvocationPlan(tool.spec.executionClass))
    )(input, context);
    if (!completePlan(plan))
      throw new Error(
        `${tool.spec.name} returned an incomplete AgentInvocationPlan. Execution was refused.`,
      );
    const preparedAction =
      tool.spec.executionClass === "external_effect"
        ? await (contracts
            ? contracts.prepare(tool, input, context)
            : prepareActionExecution(tool, input, context))
        : undefined;
    const proposal = buildActionProposal({
      tool,
      input,
      plan,
      typedProposals: preparedAction?.proposals,
      intentBinding: {
        conversationKey: request.conversationKey,
        conversationGeneration: request.conversationGeneration,
        actionContractId: request.actionContract?.id,
        userText: request.userText,
      },
    });
    const effect =
      tool.spec.executionClass === "external_effect" &&
      plan.impact !== "read_only";
    const hostAction =
      Boolean(options.inheritedApproval) ||
      (options.callerKind === "action" &&
        request.actionEntryPoint !== "conversation");
    const enforceContract =
      !delegated && (!hostAction || Boolean(context.journalActionScope));
    const preparationBlock =
      hostAction || delegated ? null : preparationEffectBlock(request, plan);
    if (preparationBlock) throw new Error(preparationBlock);
    if (
      effect &&
      (!preparedAction?.hasExplicitAdapter || !preparedAction.proposals.length)
    )
      throw new Error(
        `External effect blocked for ${tool.spec.name}: no typed action adapter describes its exact operation, capability, proof domain, and targets.`,
      );
    if (effect && request.planContext?.phase === "planning")
      throw new Error(
        `Plan mode blocked ${tool.spec.name}: no effects may run before plan approval.`,
      );
    if (
      effect &&
      request.planContext?.phase === "executing" &&
      !delegated &&
      !request.actionContract
    )
      throw new Error(
        `Approved Plan execution blocked ${tool.spec.name}: the frozen action contract is unavailable.`,
      );
    if (
      effect &&
      !delegated &&
      !hostAction &&
      contracts &&
      !request.actionContract
    )
      throw new Error(
        `Mutation blocked for ${tool.spec.name}: no validated action contract exists for this request.`,
      );
    if (
      enforceContract &&
      request.actionContract &&
      plan.impact !== "read_only" &&
      !contracts
    )
      throw new Error(
        `Write blocked: ${tool.spec.name} has no configured Action Contract verifier.`,
      );
    const scopeValidated = Boolean(
      enforceContract &&
      plan.impact !== "read_only" &&
      preparedAction &&
      request.actionContract &&
      contracts,
    );
    const scopeFailure = scopeValidated
      ? await contracts!.validateScope(
          request.actionContract!,
          preparedAction!,
          {
            allowPartialCoverage: Boolean(
              options.checkpointedWorkflow ||
              request.planContext?.phase === "executing" ||
              (options.callerKind === "action" && context.journalActionScope),
            ),
            concreteWrite: concreteWrite && plan.impact !== "read_only",
            progress: request.actionProgress,
          },
        )
      : null;
    if (
      !scopeFailure &&
      plan.impact !== "read_only" &&
      !isAgentChangeJournalAvailable()
    )
      throw new Error(
        `${tool.spec.name} was refused because the durable change journal is unavailable. Effects cannot run without restart-safe authorization and recovery.`,
      );
    const interaction = resolveActionInteraction(
      request,
      preparedAction?.proposals || [],
      Boolean(options.forceConfirmation),
    );
    if (delegated) proposal.runtime = "external";
    const authorization = delegated
      ? authorizeExternalAction(proposal)
      : authorizeOriginalAction(proposal, {
          mode: getOriginalAgentPermissionMode(),
          interaction,
          hasApprovedPlanAuthority: request.planContext?.phase === "executing",
          semantic: options.inheritedApproval
            ? undefined
            : request.classifiedIntent?.semantic ||
              request.actionContract?.intent?.semantic,
          constraints:
            request.actionContract?.intent?.semantic?.constraints ||
            request.classifiedIntent?.semantic?.constraints ||
            [],
          hasMatchingActionIntent:
            hostAction ||
            Boolean(
              scopeValidated &&
              !scopeFailure &&
              preparedAction?.proposals.length &&
              request.actionContract?.obligations.length,
            ),
        });
    return {
      input,
      plan,
      preparedAction,
      proposal,
      scopeFailure,
      interaction,
      authorization,
    };
  }
}
