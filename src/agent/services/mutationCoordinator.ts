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
import {
  getActiveMutationActionId,
  withActiveMutationAction,
} from "../../services/mutationActionContext";

export type CoordinatedMutationResult = {
  actionId?: string;
  effect: AgentToolEffect;
  affectedCount: number;
  results: LibraryMutationExecutionResult[];
  actionEvidence: AgentActionEvidence[];
};

class MutationMayHaveAppliedError extends Error {
  constructor(
    message: string,
    readonly reversibility: JournalReversibility,
  ) {
    super(message);
  }
}

export function getActiveJournalActionId(): string | null {
  return getActiveMutationActionId();
}

export async function withActiveJournalAction<T>(
  actionId: string | null,
  task: () => Promise<T>,
): Promise<T> {
  return withActiveMutationAction(actionId, task);
}

function runIdFor(context: AgentToolContext): string {
  return context.runId || `conv-${context.request.conversationKey}`;
}

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

type MutationStepPlan = {
  operation: string;
  description: string;
  forward: unknown;
  inverse?: unknown;
  precondition?: unknown;
  reversibility: JournalReversibility;
  reason?: string;
  deferredInverse?: boolean;
};

type MutationStepOutcome<T> = {
  result: T;
  inverse?: unknown;
  expectedPostcondition?: unknown;
  reversibility?: JournalReversibility;
  affectedCount: number;
  effect: AgentToolEffect;
  reason?: string;
};

type JournalActionSeed = {
  runId: string;
  conversationKey: number;
  toolName: string;
  description: string;
  reversibility: JournalReversibility;
  recovery?: string;
};

async function executeJournaledStep<T>(params: {
  context: AgentToolContext;
  actionId: string | null;
  sequence: number;
  plan: MutationStepPlan | (() => Promise<MutationStepPlan>);
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
  execute: (plan: MutationStepPlan) => Promise<MutationStepOutcome<T>>;
  reconcileAfterError?: (
    plan: MutationStepPlan,
    error: unknown,
  ) => Promise<MutationStepOutcome<T> | null>;
}): Promise<{
  result: T;
  reversibility: JournalReversibility;
  effect: AgentToolEffect;
  status: AgentJournalStepOutcome["status"];
  affectedCount: number;
  expectedPostcondition?: unknown;
  precondition?: unknown;
  journalStepId?: string;
}> {
  const { context, actionId, sequence } = params;
  const parentScope = context.journalActionScope;
  const stepId = actionId ? `${actionId}:${sequence}` : null;
  return withActiveJournalAction(actionId, async () => {
    const plan =
      typeof params.plan === "function" ? await params.plan() : params.plan;
    const action = params.prepareAction?.(plan);
    if (actionId && stepId) {
      try {
        if (action) {
          await prepareJournalAction({
            actionId,
            ...action,
            effect: "write",
          });
        }
        await prepareJournalStep({
          stepId,
          actionId,
          sequence,
          operation: plan.operation,
          forward: plan.forward,
          inverse: plan.inverse,
          precondition: plan.precondition,
          reversibility: plan.reversibility,
          status: "prepared",
          error: plan.reason,
        });
        if (plan.inverse !== undefined) {
          await registerJournalRecoveryPayloads({
            actionId,
            stepId,
            value: plan.inverse,
          });
        }
        const claimed = await claimJournalStep({
          stepId,
          from: ["prepared"],
          to: "applying",
        });
        if (!claimed) {
          throw new Error(`Journal step ${stepId} could not be claimed`);
        }
        const actionClaimed = await claimJournalAction({
          actionId,
          from: ["prepared", "applying"],
          to: "applying",
        });
        if (!actionClaimed) {
          throw new Error(`Journal action ${actionId} could not be claimed`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await updateJournalStep({
          stepId,
          status: "failed",
          reversibility: "full",
          error: reason,
        }).catch(() => undefined);
        if (action) {
          await updateJournalAction({
            actionId,
            status: "failed",
            error: reason,
          }).catch(() => undefined);
        }
        throw error;
      }
    }

    const recordOutcome = async (outcome: MutationStepOutcome<T>) => {
      const changed = outcome.effect !== "none";
      const finalInverse =
        outcome.inverse === undefined ? plan.inverse : outcome.inverse;
      const recoveryReason =
        outcome.reason || (plan.deferredInverse ? undefined : plan.reason);
      const reversibility: JournalReversibility = changed
        ? outcome.reversibility ||
          (finalInverse !== undefined && finalInverse !== null
            ? recoveryReason
              ? "partial"
              : "full"
            : "none")
        : "full";
      const status: AgentJournalStepOutcome["status"] =
        outcome.effect === "none"
          ? "no_effect"
          : outcome.effect === "partial"
            ? "partially_applied"
            : reversibility === "none"
              ? "irreversible"
              : "applied";
      if (actionId && stepId) {
        if (outcome.inverse !== undefined && outcome.inverse !== null) {
          await registerJournalRecoveryPayloads({
            actionId,
            stepId,
            value: outcome.inverse,
          });
        }
        await updateJournalStep({
          stepId,
          status,
          inverse: finalInverse,
          expectedPostcondition: outcome.expectedPostcondition,
          result: outcome.result,
          reversibility,
          error: recoveryReason,
        });
      }
      parentScope?.recordStep({
        effect: outcome.effect,
        status,
        reversibility,
        affectedCount: changed ? outcome.affectedCount : 0,
      });
      return {
        result: outcome.result,
        reversibility,
        effect: outcome.effect,
        status,
        affectedCount: outcome.affectedCount,
        expectedPostcondition: outcome.expectedPostcondition,
        precondition: plan.precondition,
        journalStepId: stepId || undefined,
      };
    };

    try {
      return await recordOutcome(await params.execute(plan));
    } catch (error) {
      const reconciled = await params
        .reconcileAfterError?.(plan, error)
        .catch(() => null);
      if (reconciled) {
        try {
          return await recordOutcome(reconciled);
        } catch {
          // Fall through to the uncertain journal state below.
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (actionId && stepId) {
        await updateJournalStep({
          stepId,
          // Once the Zotero call has started, a throw cannot prove that no
          // object committed. Startup/recovery must inspect this step.
          status: "uncertain",
          reversibility: plan.reversibility,
          error: reason,
        }).catch(() => undefined);
      }
      parentScope?.recordStep({
        effect: "none",
        status: "uncertain",
        reversibility: plan.reversibility,
        affectedCount: 0,
      });
      throw new MutationMayHaveAppliedError(reason, plan.reversibility);
    }
  });
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

export type ExternalMutationPlan = MutationStepPlan;
export type ExternalMutationOutcome<T> = MutationStepOutcome<T>;

/** Journal a write that is not represented by LibraryMutationOperation. */
export async function executeExternalMutation<T>(params: {
  context: AgentToolContext;
  toolName: string;
  plan: ExternalMutationPlan | (() => Promise<ExternalMutationPlan>);
  execute: () => Promise<ExternalMutationOutcome<T>>;
}): Promise<AgentWriteToolOutput<T>> {
  const { context, toolName } = params;
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
  try {
    const executed = await executeJournaledStep({
      context,
      actionId,
      sequence: parentScope?.allocateSequence() ?? 1,
      plan: params.plan,
      prepareAction: ownsAction
        ? (plan) => ({
            runId: runIdFor(context),
            conversationKey: context.request.conversationKey,
            toolName: context.journalToolName || toolName,
            description: plan.description,
            reversibility: plan.reversibility,
            recovery: plan.reason,
          })
        : undefined,
      execute: async () => params.execute(),
    });
    if (actionId && ownsAction) {
      await updateJournalAction({
        actionId,
        status:
          executed.effect === "none"
            ? "no_effect"
            : executed.effect === "partial"
              ? "partially_applied"
              : executed.reversibility === "none"
                ? "irreversible"
                : "applied",
        reversibility: executed.reversibility,
        affectedCount: executed.effect !== "none" ? executed.affectedCount : 0,
      });
    }
    const content =
      executed.result && typeof executed.result === "object"
        ? Object.assign({}, executed.result, {
            ...(actionId ? { actionId } : {}),
          })
        : executed.result;
    return {
      content: content as T,
      effect: executed.effect,
    };
  } catch (error) {
    if (actionId && ownsAction) {
      const uncertain = error instanceof MutationMayHaveAppliedError;
      await updateJournalAction({
        actionId,
        status: uncertain ? "uncertain" : "failed",
        reversibility: uncertain ? error.reversibility : undefined,
        affectedCount: 0,
        error: error instanceof Error ? error.message : String(error),
        recovery: uncertain
          ? "Inspect the affected object before retrying; the forward operation had already started."
          : undefined,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export function currentMutationActionId(): string | null {
  return getActiveJournalActionId();
}
