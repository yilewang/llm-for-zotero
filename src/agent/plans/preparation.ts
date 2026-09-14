import { isActionIndexList } from "../contracts/workflowDependencies";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import type { AgentToolContext, AgentToolInputValidation } from "../types";
import { planExecutionCoordinator } from "./coordinator";
import { buildDefaultPlanContract, decodePlanContract } from "./contracts";
import type {
  PlanAcceptanceCriterion,
  PlanCompletionRequirementKind,
  PlanContract,
  PlanStepEffect,
} from "./types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { resolvePlanDocumentCitationPreference } from "../documents/citationPreference";
import { materializeResearchScopeSnapshot } from "../research/scopeSnapshot";
import { fail, ok, validateObject } from "../tools/shared";
import { loadPlanArtifact } from "./store";

export type UpdatePlanInput = {
  explanation?: string;
  ready: boolean;
  contract?: unknown;
  steps: Array<{
    planStepId?: string;
    actionIndexes?: number[];
    materialOutputId?: string;
    content: string;
    activeForm: string;
    acceptanceCriteria: PlanAcceptanceCriterion[];
    expectedCapability?: string;
    expectedEffect: PlanStepEffect;
  }>;
};

const EFFECTS = new Set<PlanStepEffect>([
  "read",
  "artifact",
  "mutation",
  "reasoning",
]);

const CRITERION_VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "bounded_reasoning",
  "research_coverage",
  "material_integrity",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "user_decision",
]);

export function validateUpdatePlanInput(
  args: unknown,
): AgentToolInputValidation<UpdatePlanInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("update_plan expects an object");
  }
  if (!Array.isArray(args.steps) || !args.steps.length) {
    return fail("update_plan requires at least one step");
  }
  const steps: UpdatePlanInput["steps"] = [];
  for (let index = 0; index < args.steps.length; index += 1) {
    const raw = args.steps[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      return fail(`steps[${index}] must be an object`);
    }
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const activeForm =
      typeof raw.activeForm === "string" ? raw.activeForm.trim() : "";
    const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.flatMap((entry) => {
          if (!validateObject<Record<string, unknown>>(entry)) return [];
          const criterionId =
            typeof entry.criterionId === "string"
              ? entry.criterionId.trim()
              : "";
          const description =
            typeof entry.description === "string"
              ? entry.description.trim()
              : "";
          const verifier = entry.verifier as PlanCompletionRequirementKind;
          return criterionId && description && CRITERION_VERIFIERS.has(verifier)
            ? [{ criterionId, description, verifier }]
            : [];
        })
      : [];
    const expectedEffect = raw.expectedEffect as PlanStepEffect;
    if (!content || !activeForm || !acceptanceCriteria.length) {
      return fail(
        `steps[${index}] requires content, activeForm, and acceptanceCriteria`,
      );
    }
    if (!EFFECTS.has(expectedEffect)) {
      return fail(`steps[${index}].expectedEffect is invalid`);
    }
    if (
      Array.isArray(raw.acceptanceCriteria) &&
      acceptanceCriteria.length !== raw.acceptanceCriteria.length
    ) {
      return fail(`steps[${index}].acceptanceCriteria is invalid`);
    }
    if (
      raw.actionIndexes !== undefined &&
      !isActionIndexList(raw.actionIndexes)
    )
      return fail(
        `steps[${index}].actionIndexes must be unique nonnegative action indexes`,
      );
    steps.push({
      actionIndexes: raw.actionIndexes as number[] | undefined,
      materialOutputId:
        typeof raw.materialOutputId === "string"
          ? raw.materialOutputId.trim() || undefined
          : undefined,
      planStepId:
        typeof raw.planStepId === "string" && raw.planStepId.trim()
          ? raw.planStepId.trim()
          : undefined,
      content,
      activeForm,
      acceptanceCriteria,
      expectedCapability:
        typeof raw.expectedCapability === "string" &&
        raw.expectedCapability.trim()
          ? raw.expectedCapability.trim()
          : undefined,
      expectedEffect,
    });
  }
  if (args.ready === true && (steps.length < 3 || steps.length > 7)) {
    return fail("A ready plan requires 3–7 user-visible steps");
  }
  return ok({
    explanation:
      typeof args.explanation === "string" && args.explanation.trim()
        ? args.explanation.trim()
        : undefined,
    ready: args.ready === true,
    contract: validateObject(args.contract) ? args.contract : undefined,
    steps,
  });
}

export async function resolvePlanContract(params: {
  raw: unknown;
  steps: UpdatePlanInput["steps"];
  actionContract?: NonNullable<
    import("../types").AgentRuntimeRequest["actionContract"]
  >;
  ready: boolean;
  gateway?: ZoteroGateway;
  planId: string;
  revision: number;
  conversationKey: number;
}): Promise<PlanContract> {
  const defaultContract = buildDefaultPlanContract({
    actionContract: params.actionContract,
    steps: params.steps,
  });
  const raw: Record<string, unknown> = validateObject<Record<string, unknown>>(
    params.raw,
  )
    ? { ...params.raw }
    : { ...defaultContract };
  const deliverable = validateObject<Record<string, unknown>>(raw.deliverable)
    ? { ...raw.deliverable }
    : defaultContract.deliverable;
  if (
    validateObject<Record<string, unknown>>(deliverable) &&
    deliverable.kind === "document"
  ) {
    const spec = validateObject<Record<string, unknown>>(deliverable.spec)
      ? { ...deliverable.spec }
      : {};
    if (!validateObject(spec.citationStyle)) {
      spec.citationStyle = resolvePlanDocumentCitationPreference(
        params.gateway,
      );
    }
    raw.deliverable = { ...deliverable, spec };
  }
  if (validateObject<Record<string, unknown>>(raw.effects)) {
    const effects = { ...raw.effects };
    if (validateObject<Record<string, unknown>>(effects.libraryMutation)) {
      const mutation = { ...effects.libraryMutation };
      if (mutation.approval === "initial") {
        if (!params.actionContract && !mutation.contract) {
          throw new Error(
            "An initially approved library mutation requires a frozen action contract",
          );
        }
        if (params.actionContract) {
          if (
            validateObject<Record<string, unknown>>(mutation.contract) &&
            mutation.contract.id !== params.actionContract.id
          )
            throw new Error(
              "The plan contract action authority does not match the request",
            );
          // The host owns targets and restrictions. A model-supplied copy may
          // identify that contract, but cannot replace its frozen authority.
          mutation.contract = params.actionContract;
        }
      }
      effects.libraryMutation = mutation;
      raw.effects = effects;
    }
  }
  let contract = decodePlanContract(raw, { requireSnapshot: false });
  if (
    contract.investigation?.reviewMode === "systematic" &&
    !contract.investigation.criteria.length
  ) {
    throw new Error(
      "A systematic review requires at least one explicit inclusion or exclusion criterion",
    );
  }
  if (
    contract.investigation?.readingStrategy === "adaptive" &&
    contract.investigation.estimatedDeepReadPapers !== 0
  ) {
    throw new Error(
      "An adaptive review must not preselect a paper count; set estimatedDeepReadPapers to 0",
    );
  }
  if (params.ready && contract.investigation) {
    if (!params.gateway) {
      throw new Error(
        "The Zotero gateway is required to freeze research scope",
      );
    }
    const snapshot = await materializeResearchScopeSnapshot({
      gateway: params.gateway,
      planId: params.planId,
      revision: params.revision,
      conversationKey: params.conversationKey,
      scope: contract.investigation.scope,
    });
    contract = decodePlanContract(
      {
        ...contract,
        investigation: {
          ...contract.investigation,
          scopeSnapshot: snapshot.ref,
        },
      },
      { requireSnapshot: true },
    );
  }
  return contract;
}

export async function preparePlanExecution(
  input: UpdatePlanInput,
  context: AgentToolContext,
  gateway?: ZoteroGateway,
) {
  if (
    context.request.planContext?.phase === "planning" &&
    context.request.planContext.nativePlanning
  ) {
    return withConversationWriteLock(
      context.request.conversationKey,
      async () => {
        const generation = context.request.conversationGeneration;
        if (
          context.signal?.aborted ||
          areConversationWritesFrozen(context.request.conversationKey) ||
          (generation !== undefined &&
            !isConversationWriteGenerationCurrent(
              context.request.conversationKey,
              generation,
            ))
        )
          throw new Error("The native planning conversation changed");
        return preparePlanExecutionUnlocked(input, context, gateway);
      },
    );
  }
  return preparePlanExecutionUnlocked(input, context, gateway);
}

async function preparePlanExecutionUnlocked(
  input: UpdatePlanInput,
  context: AgentToolContext,
  gateway?: ZoteroGateway,
) {
  const freeze =
    input.ready ||
    Boolean(
      context.request.planContext?.phase === "planning" &&
      context.request.planContext.nativePlanning,
    );
  const plan = context.request.planContext;
  if (!plan || plan.phase !== "planning") {
    throw new Error("update_plan is available only during planning");
  }
  // Revision feedback supplements the user's restrictions. It does not grant
  // permission to drop them merely because the feedback omits their wording.
  let actionContract = context.request.actionContract;
  if (plan.nativePlanning && actionContract) {
    const previous =
      (await loadPlanArtifact(plan.planId, plan.revision)) ||
      (plan.revision > 1
        ? await loadPlanArtifact(plan.planId, plan.revision - 1)
        : null);
    if (previous?.conversationKey === context.request.conversationKey) {
      const rawContract = input.contract as PlanContract | undefined;
      if (
        rawContract?.effects?.libraryMutation?.approval === "initial" &&
        !actionContract.obligations.some(
          (obligation) => obligation.operation !== "read_full",
        ) &&
        previous.contract?.effects?.libraryMutation.approval === "initial"
      ) {
        // A wording-only revision can retain the prior typed effect. An
        // explicit new action uses the newly resolved request contract; a
        // proposal without that effect receives no inherited write authority.
        actionContract = {
          ...previous.contract.effects.libraryMutation.contract,
          hardConstraints: actionContract.hardConstraints,
        };
      }
      const restrictions = new Map(
        [
          ...(previous.actionContract?.hardConstraints || []),
          ...(actionContract.hardConstraints || []),
        ].map((constraint) => [JSON.stringify(constraint), constraint]),
      );
      actionContract = {
        ...actionContract,
        hardConstraints: [...restrictions.values()],
      };
    }
  }
  const contract = await resolvePlanContract({
    raw: input.contract,
    steps: input.steps,
    actionContract,
    ready: freeze,
    gateway,
    planId: plan.planId,
    revision: plan.revision,
    conversationKey: context.request.conversationKey,
  });
  const explicitScopeCount =
    context.request.classifiedIntent?.semantic?.researchScopeCount;
  if (
    freeze &&
    explicitScopeCount !== undefined &&
    contract.investigation?.scopeSnapshot?.itemCount !== explicitScopeCount
  ) {
    throw new Error(
      `The user requested exactly ${explicitScopeCount} research items, but the frozen scope contains ${contract.investigation?.scopeSnapshot?.itemCount ?? 0}. Resolve exactly those items with a bounded sorted metadata query and use investigation.scope kind 'items' with their exact itemKeys.`,
    );
  }
  if (context.signal?.aborted)
    throw new Error("The planning attempt was interrupted");
  const artifact = await planExecutionCoordinator.updateDraft({
    planId: plan.planId,
    conversationKey: context.request.conversationKey,
    provider: plan.provider,
    revision: plan.revision,
    explanation: input.explanation,
    steps: input.steps,
    contract,
    actionContractId: actionContract?.id,
    actionContract,
    sourceRunId: context.runId || "external-mcp-structured",
    skillRoutingReceipt: context.request.skillRoutingReceipt
      ? {
          routerSchemaVersion:
            context.request.skillRoutingReceipt.routerSchemaVersion,
          skillManifestHash:
            context.request.skillRoutingReceipt.skillManifestHash,
          skills: context.request.skillRoutingReceipt.skills.map(
            ({ id, version, instructionHash, source }) => ({
              id,
              version,
              instructionHash,
              source,
            }),
          ),
        }
      : undefined,
    ready: input.ready && !plan.nativePlanning,
    nativePlanning: plan.nativePlanning,
  });
  return artifact;
}
