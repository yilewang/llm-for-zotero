import type {
  AgentJournalStepOutcome,
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
import {
  getActiveMutationActionId,
  withActiveMutationAction,
} from "../../services/mutationActionContext";
/** Native evidence proves the requested forward change had no effect. */
export class MutationNoEffectError extends Error {}

export class MutationMayHaveAppliedError extends Error {
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

export function runIdFor(context: AgentToolContext): string {
  return context.runId || `conv-${context.request.conversationKey}`;
}

export type MutationStepPlan = {
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

export type JournalActionSeed = {
  runId: string;
  conversationKey: number;
  toolName: string;
  description: string;
  reversibility: JournalReversibility;
  recovery?: string;
};

export async function executeJournaledStep<T>(params: {
  context: AgentToolContext;
  actionId: string | null;
  sequence: number;
  plan: MutationStepPlan | (() => Promise<MutationStepPlan>);
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
  execute: (plan: MutationStepPlan) => Promise<MutationStepOutcome<T>>;
  resume?: boolean;
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
        if (action && !params.resume) {
          await prepareJournalAction({
            actionId,
            ...action,
            effect: "write",
          });
        }
        if (!params.resume)
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
        await registerJournalRecoveryPayloads({
          actionId,
          stepId,
          value: plan.forward,
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
          from: params.resume
            ? [
                "prepared",
                "uncertain",
                "failed",
                "applied",
                "no_effect",
                "partially_applied",
              ]
            : ["prepared"],
          to: "applying",
        });
        if (!claimed) {
          throw new Error(`Journal step ${stepId} could not be claimed`);
        }
        const actionClaimed = await claimJournalAction({
          actionId,
          from: params.resume
            ? [
                "prepared",
                "applying",
                "uncertain",
                "failed",
                "applied",
                "no_effect",
                "partially_applied",
              ]
            : ["prepared", "applying"],
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
      let failure = error;
      let reconciled: MutationStepOutcome<T> | null | undefined;
      try {
        reconciled = await params.reconcileAfterError?.(plan, error);
      } catch (reconciliationError) {
        failure = reconciliationError;
      }
      if (reconciled) {
        try {
          return await recordOutcome(reconciled);
        } catch {
          // Fall through to the uncertain journal state below.
        }
      }
      const reason =
        failure instanceof Error ? failure.message : String(failure);
      const failureStatus =
        failure instanceof MutationNoEffectError ? "failed" : "uncertain";
      if (actionId && stepId) {
        await updateJournalStep({
          stepId,
          // Once the Zotero call has started, a throw cannot prove that no
          // object committed. Startup/recovery must inspect this step.
          status: failureStatus,
          reversibility: plan.reversibility,
          error: reason,
        }).catch(() => undefined);
      }
      parentScope?.recordStep({
        effect: "none",
        status: failureStatus,
        reversibility: plan.reversibility,
        affectedCount: 0,
      });
      if (failure instanceof MutationNoEffectError) throw failure;
      throw new MutationMayHaveAppliedError(reason, plan.reversibility);
    }
  });
}

export type ExternalMutationPlan = MutationStepPlan;
export type ExternalMutationOutcome<T> = MutationStepOutcome<T>;

/** Journal a write that is not represented by LibraryMutationOperation. */
export async function executeExternalMutation<T>(params: {
  context: AgentToolContext;
  toolName: string;
  plan: ExternalMutationPlan | (() => Promise<ExternalMutationPlan>);
  execute: () => Promise<ExternalMutationOutcome<T>>;
  /** Host-bound identity and frozen plan loaded from the existing journal. */
  recovery?: { actionId: string; resume: boolean };
  reconcileAfterError?: (
    plan: ExternalMutationPlan,
    error: unknown,
  ) => Promise<ExternalMutationOutcome<T> | null>;
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
    (journalAvailable
      ? params.recovery?.actionId || createJournalId("action")
      : null);
  const ownsAction = Boolean(actionId && !parentScope);
  let verifiedOutcome:
    | { reversibility: JournalReversibility; affectedCount: number }
    | undefined;
  try {
    const executed = await executeJournaledStep({
      context,
      actionId,
      sequence: parentScope?.allocateSequence() ?? 1,
      plan: params.plan,
      resume: params.recovery?.resume,
      reconcileAfterError: params.reconcileAfterError,
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
    verifiedOutcome = {
      reversibility: executed.reversibility,
      affectedCount: executed.affectedCount,
    };
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
      const uncertain =
        error instanceof MutationMayHaveAppliedError ||
        Boolean(verifiedOutcome);
      await updateJournalAction({
        actionId,
        status: uncertain ? "uncertain" : "failed",
        reversibility:
          error instanceof MutationMayHaveAppliedError
            ? error.reversibility
            : verifiedOutcome?.reversibility,
        affectedCount: verifiedOutcome?.affectedCount || 0,
        error: error instanceof Error ? error.message : String(error),
        recovery: uncertain
          ? "Inspect the affected object before retrying; the forward operation had already started."
          : undefined,
      }).catch(() => undefined);
    }
    if (actionId && error instanceof Error)
      Object.assign(error, { journalActionId: actionId });
    throw error;
  }
}
