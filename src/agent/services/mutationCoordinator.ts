import {
  executeJournaledStep,
  runIdFor,
  MutationMayHaveAppliedError,
  getActiveJournalActionId,
  type JournalActionSeed,
  type MutationStepPlan,
} from "./externalMutationCoordinator";
import type {
  AgentJournalStepOutcome,
  AgentActionEvidence,
  AgentToolContext,
  AgentToolEffect,
  AgentWriteToolOutput,
} from "../types";
import {
  claimJournalAction,
  claimJournalStep,
  createJournalId,
  isAgentChangeJournalAvailable,
  prepareJournalAction,
  prepareJournalStep,
  registerJournalRecoveryPayloads,
  updateJournalAction,
  updateJournalStep,
  type JournalReversibility,
} from "../store/changeJournal";
import type {
  LibraryMutationExecutionResult,
  LibraryMutationOperation,
  LibraryMutationService,
} from "./libraryMutationService";
import { mutationPostconditionIsSatisfied } from "./libraryMutation/handlerOperations";

export type CoordinatedMutationResult = {
  actionId?: string;
  effect: AgentToolEffect;
  affectedCount: number;
  results: LibraryMutationExecutionResult[];
  actionEvidence: AgentActionEvidence[];
};

function inversePayload(operations: LibraryMutationOperation[] | undefined) {
  return operations?.length
    ? { version: 1, kind: "library_operations", operations }
    : undefined;
}

function combineReversibility(
  values: JournalReversibility[],
): JournalReversibility {
  if (!values.length || values.every((value) => value === "full")) {
    return "full";
  }
  if (values.every((value) => value === "none")) return "none";
  return "partial";
}

function combineEffects(values: AgentToolEffect[]): AgentToolEffect {
  if (!values.length || values.every((value) => value === "none")) {
    return "none";
  }
  return values.every((value) => value === "applied") ? "applied" : "partial";
}

export function summarizeMutationOutcomes(
  outcomes: ReadonlyArray<
    Pick<
      AgentJournalStepOutcome,
      "effect" | "status" | "reversibility" | "affectedCount"
    >
  >,
): {
  effect: AgentToolEffect;
  reversibility: JournalReversibility;
  affectedCount: number;
} {
  const changed = outcomes.filter((outcome) => outcome.effect !== "none");
  const recoveryRelevant = outcomes.filter(
    (outcome) => outcome.status !== "no_effect",
  );
  return {
    effect: combineEffects(changed.map((outcome) => outcome.effect)),
    reversibility: combineReversibility(
      recoveryRelevant.map((outcome) => outcome.reversibility),
    ),
    affectedCount: changed.reduce(
      (total, outcome) => total + Math.max(0, outcome.affectedCount),
      0,
    ),
  };
}

async function executeOne(params: {
  service: LibraryMutationService;
  operation: LibraryMutationOperation;
  context: AgentToolContext;
  actionId: string | null;
  sequence: number;
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
}) {
  const { service, operation, context } = params;
  return executeJournaledStep({
    ...params,
    plan: async () => {
      const plan = await service.planOperation(operation, context);
      return {
        operation: operation.type,
        description: plan.description,
        forward: operation,
        inverse: inversePayload(plan.inverseOperations),
        precondition: plan.precondition,
        reversibility: plan.reversibility,
        reason: plan.reason,
        deferredInverse: plan.deferredInverse,
      };
    },
    execute: async () => {
      const executed = await service.executeOperation(operation, context);
      const inverse = executed.inverse;
      return {
        result: executed.result,
        inverse:
          inverse === undefined
            ? undefined
            : (inversePayload(inverse?.inverseOperations) ?? null),
        expectedPostcondition: await service.captureOperationState(
          operation,
          context,
          executed.result,
        ),
        affectedCount: executed.affectedCount,
        effect: executed.effect,
        reason: inverse?.irreversibleReason,
      };
    },
    reconcileAfterError: async () => {
      const postState = await service.captureOperationState(
        operation,
        context,
        {
          reconciliation: true,
        },
      );
      if (!mutationPostconditionIsSatisfied(operation, postState)) return null;
      return {
        result: {
          operation: operation.type,
          operationId: operation.id,
          result: { status: "reconciled_after_uncertain_execution" },
        },
        expectedPostcondition: postState,
        affectedCount: 0,
        effect: "none",
        reason:
          "The mutation call threw after starting, but authoritative Zotero state already satisfied its postcondition.",
      };
    },
  });
}

/**
 * Execute one user-visible action with one or more durable ordered steps.
 */
export async function executeLibraryMutationAction(params: {
  service: LibraryMutationService;
  operations: LibraryMutationOperation[];
  context: AgentToolContext;
  facadeToolName: string;
}): Promise<CoordinatedMutationResult> {
  const { service, operations, context, facadeToolName } = params;
  const journalToolName = context.journalToolName || facadeToolName;
  if (!operations.length) {
    return {
      effect: "none",
      affectedCount: 0,
      results: [],
      actionEvidence: [],
    };
  }

  const parentScope = context.journalActionScope;
  const journalAvailable = isAgentChangeJournalAvailable();
  if (!journalAvailable && !context.journalFallbackApproved) {
    throw new Error(
      "The durable change journal is unavailable. This write requires explicit fallback confirmation.",
    );
  }
  const actionId =
    parentScope?.actionId ||
    (journalAvailable ? createJournalId("action") : null);
  const ownsAction = Boolean(actionId && !parentScope);

  const results: LibraryMutationExecutionResult[] = [];
  const completedOutcomes: AgentJournalStepOutcome[] = [];
  const actionEvidence: AgentActionEvidence[] = [];
  let affectedCount = 0;
  try {
    for (let index = 0; index < operations.length; index += 1) {
      // A prior step may have created or changed an object referenced by this
      // operation. Re-plan at the step boundary so its pre-image describes
      // the state immediately before this write, not the state before the
      // whole batch started.
      const executed = await executeOne({
        service,
        operation: operations[index],
        context,
        actionId,
        sequence: parentScope?.allocateSequence() ?? index + 1,
        prepareAction:
          ownsAction && index === 0
            ? (plan) => ({
                runId: runIdFor(context),
                conversationKey: context.request.conversationKey,
                toolName: journalToolName,
                description:
                  operations.length === 1
                    ? plan.description
                    : `${journalToolName}: ${operations.length} planned changes`,
                reversibility: plan.reversibility,
                recovery: plan.reason,
              })
            : undefined,
      });
      results.push(executed.result);
      if (
        executed.precondition &&
        executed.expectedPostcondition &&
        typeof executed.precondition === "object" &&
        typeof executed.expectedPostcondition === "object"
      ) {
        actionEvidence.push({
          version: 1,
          proofDomain: "zotero_state",
          operationValue: operations[index],
          preState: executed.precondition as AgentActionEvidence["preState"],
          postState:
            executed.expectedPostcondition as AgentActionEvidence["postState"],
          journalStepId: executed.journalStepId,
          effect: executed.effect,
        });
      }
      completedOutcomes.push({
        effect: executed.effect,
        status: executed.status,
        reversibility: executed.reversibility,
        affectedCount: executed.affectedCount,
      });
      if (executed.effect !== "none") {
        affectedCount += executed.affectedCount;
      }
    }
    const summary = summarizeMutationOutcomes(completedOutcomes);
    const effect = summary.effect;
    if (actionId && ownsAction) {
      await updateJournalAction({
        actionId,
        status:
          effect === "none"
            ? "no_effect"
            : effect === "partial"
              ? "partially_applied"
              : summary.reversibility === "none"
                ? "irreversible"
                : "applied",
        reversibility: summary.reversibility,
        affectedCount: summary.affectedCount,
      });
    }
    return {
      actionId: actionId || undefined,
      effect,
      affectedCount: summary.affectedCount,
      results,
      actionEvidence,
    };
  } catch (error) {
    const changedOutcomes = completedOutcomes.filter(
      (outcome) => outcome.effect !== "none",
    );
    const uncertain = error instanceof MutationMayHaveAppliedError;
    const recovery = changedOutcomes.length
      ? `${changedOutcomes.length} prior operation${
          changedOutcomes.length === 1 ? "" : "s"
        } changed the library; durable recovery steps were retained.`
      : uncertain
        ? "The current operation may have applied; inspect journal state before retrying."
        : undefined;
    if (actionId && ownsAction) {
      const failureReversibilities = uncertain
        ? [
            ...changedOutcomes.map((outcome) => outcome.reversibility),
            error.reversibility,
          ]
        : changedOutcomes.map((outcome) => outcome.reversibility);
      await updateJournalAction({
        actionId,
        status: changedOutcomes.length
          ? "partially_applied"
          : uncertain
            ? "uncertain"
            : "failed",
        reversibility: combineReversibility(failureReversibilities),
        affectedCount,
        error: error instanceof Error ? error.message : String(error),
        recovery,
      }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (changedOutcomes.length) throw new Error(`${message} (${recovery})`);
    if (uncertain) throw new Error(`${message} (${recovery})`);
    throw error;
  }
}

export function currentMutationActionId(): string | null {
  return getActiveJournalActionId();
}
