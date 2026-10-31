import {
  executeJournaledStep,
  runIdFor,
  MutationMayHaveAppliedError,
  MutationNoEffectError,
  getActiveJournalActionId,
  withActiveJournalAction,
  type JournalActionSeed,
  type MutationStepPlan,
} from "./externalMutationCoordinator";
import type {
  AgentJournalActionScope,
  AgentJournalStepOutcome,
  AgentActionEvidence,
  AgentLibraryMutationEvidence,
  AgentToolContext,
  AgentToolEffect,
  AgentWriteToolOutput,
} from "../types";
import {
  claimJournalAction,
  claimJournalStep,
  createJournalId,
  inJournalTransaction,
  isAgentChangeJournalAvailable,
  listJournalActions,
  listJournalSteps,
  prepareJournalAction,
  prepareJournalStep,
  registerJournalRecoveryPayloads,
  updateJournalAction,
  updateJournalStep,
  type JournalReversibility,
  type JournalStatus,
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
  /**
   * The operation that stopped the action, when the caller asked for the
   * outcome instead of a throw. `results` and `actionEvidence` then hold the
   * operations before it, which stay applied; the ones after it never ran.
   */
  failure?: {
    index: number;
    message: string;
    /** The operation had started, so it may have applied. */
    uncertain: boolean;
  };
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

/**
 * Operations whose concrete writes are journalled one step each.
 *
 * A note batch is not one change: it is N note creations that each reserve a
 * native identity, each carry their own durable inverse, and each fail
 * independently. It therefore contributes one step per note to the action
 * that owns it instead of being flattened into a single journalled step with
 * one whole-batch inverse.
 */
function ownsItsOwnJournalSteps(operation: LibraryMutationOperation): boolean {
  return operation.type === "save_notes_batch";
}

/** Step states that mean the action still owes work it has not applied. */
const UNFINISHED_STEP_STATUSES: ReadonlySet<JournalStatus> = new Set([
  "prepared",
  "applying",
  "partially_applied",
  "failed",
  "uncertain",
]);

/**
 * The status a reused action now deserves, read from every step it holds.
 *
 * This call's own outcomes cannot answer it: a resume that writes the one
 * item an earlier attempt failed still leaves that attempt's failed step in
 * the action, and summarizing only the new steps would rewrite the action as
 * fully applied. `unfinishedWork` covers what has no step at all -- a batch
 * item whose body was never finalized is failed in the batch's rows and was
 * never journalled.
 */
async function resumedActionSummary(params: {
  actionId: string;
  affectedCount: number;
  unfinishedWork: boolean;
  fallbackReversibility: JournalReversibility;
}): Promise<{
  status: JournalStatus;
  reversibility: JournalReversibility;
  affectedCount: number;
}> {
  const steps = await listJournalSteps(params.actionId);
  const incomplete =
    params.unfinishedWork ||
    steps.some((step) => UNFINISHED_STEP_STATUSES.has(step.status));
  const recoveryRelevant = steps.filter((step) => step.status !== "no_effect");
  const reversibility = recoveryRelevant.length
    ? combineReversibility(recoveryRelevant.map((step) => step.reversibility))
    : params.fallbackReversibility;
  return {
    status: params.affectedCount
      ? incomplete
        ? "partially_applied"
        : reversibility === "none"
          ? "irreversible"
          : "applied"
      : incomplete
        ? "failed"
        : "no_effect",
    reversibility,
    affectedCount: params.affectedCount,
  };
}

/**
 * Reopen the action a resumed call continues, or decline it.
 *
 * A batch that stopped halfway is finished under the action its first attempt
 * opened: undo has to revert every note of the batch, and a second action
 * would split them so "undo that" reverted only the notes written after the
 * interruption. An action is only a container while it is still this
 * conversation's and still holds applied work -- one that was reverted,
 * failed outright or belongs to another conversation is history, and the
 * caller mints a new action instead.
 */
async function reopenJournalAction(params: {
  actionId: string;
  conversationKey: number;
}): Promise<{
  actionId: string;
  /** Highest sequence already used, so resumed steps do not collide. */
  lastSequence: number;
  /** What the action already applied, so its summary does not shrink. */
  prior: AgentJournalStepOutcome | null;
} | null> {
  const [action] = await listJournalActions({
    actionId: params.actionId,
    limit: 1,
  });
  if (
    !action ||
    action.conversationKey !== params.conversationKey ||
    (action.status !== "applied" && action.status !== "partially_applied")
  )
    return null;
  const claimed = await claimJournalAction({
    actionId: action.actionId,
    from: ["applied", "partially_applied"],
    to: "applying",
  });
  if (!claimed) return null;
  return {
    actionId: action.actionId,
    lastSequence: action.steps.reduce(
      (highest, step) => Math.max(highest, step.sequence),
      0,
    ),
    prior: action.affectedCount
      ? {
          effect: "applied",
          status: "applied",
          reversibility: action.reversibility,
          affectedCount: action.affectedCount,
        }
      : null,
  };
}

async function stepPlanFor(
  service: LibraryMutationService,
  operation: LibraryMutationOperation,
  context: AgentToolContext,
): Promise<MutationStepPlan> {
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
}

/**
 * Run an operation that journals its own steps.
 *
 * The action is seeded before the first child write so the children can claim
 * steps under it, and the native write window is held for the whole composite
 * under the owning action id: the children's own acquires are reentrant, so
 * no concurrent write can slip between two notes of the same batch.
 */
async function executeComposite(params: {
  service: LibraryMutationService;
  operation: LibraryMutationOperation;
  context: AgentToolContext;
  actionId: string | null;
  parentScope?: AgentJournalActionScope;
  allocateSequence: () => number;
  prepareAction?: (plan: MutationStepPlan) => JournalActionSeed;
  /**
   * Reported as each step lands, so an operation that throws midway still
   * leaves its applied steps visible to the action that owns them.
   */
  onStepOutcome?: (outcome: AgentJournalStepOutcome) => void;
}) {
  const { service, operation, context, actionId, parentScope } = params;
  const run = async () => {
    const plan = await stepPlanFor(service, operation, context);
    if (actionId && params.prepareAction) {
      const action = params.prepareAction(plan);
      // Its own transaction, so another flow's rollback cannot drop the row.
      await inJournalTransaction(() =>
        prepareJournalAction({ actionId, ...action, effect: "write" }),
      );
    }
    const stepOutcomes: AgentJournalStepOutcome[] = [];
    const scope: AgentJournalActionScope | undefined = actionId
      ? {
          actionId,
          allocateSequence: params.allocateSequence,
          recordStep: (outcome) => {
            stepOutcomes.push(outcome);
            params.onStepOutcome?.(outcome);
            parentScope?.recordStep(outcome);
          },
        }
      : undefined;
    let executed: Awaited<
      ReturnType<LibraryMutationService["executeOperation"]>
    >;
    let expectedPostcondition: unknown;
    try {
      executed = await service.executeOperation(
        operation,
        scope ? { ...context, journalActionScope: scope } : context,
      );
      expectedPostcondition = await service.captureOperationState(
        operation,
        context,
        executed.result,
      );
    } catch (error) {
      // Native evidence of no effect is a proof, not a doubt: pass it on so
      // the action is recorded as failed rather than uncertain.
      if (error instanceof MutationNoEffectError) throw error;
      // The children own their own durable state; from here the composite
      // can only report that its window may have changed the library.
      throw new MutationMayHaveAppliedError(
        error instanceof Error ? error.message : String(error),
        plan.reversibility,
      );
    }
    const changed = executed.effect !== "none";
    const reversibility = changed
      ? summarizeMutationOutcomes(stepOutcomes).reversibility
      : "full";
    const status: AgentJournalStepOutcome["status"] = changed
      ? executed.effect === "partial"
        ? "partially_applied"
        : reversibility === "none"
          ? "irreversible"
          : "applied"
      : "no_effect";
    return {
      result: executed.result,
      reversibility,
      effect: executed.effect,
      status,
      affectedCount: executed.affectedCount,
      expectedPostcondition,
      precondition: plan.precondition,
      journalStepId: undefined as string | undefined,
      // The per-note read-backs the operation's own executor performed, so
      // the receipt owner can prove each note this call wrote.
      noteWrites: executed.noteWrites,
    };
  };
  return actionId ? withActiveJournalAction(actionId, run) : run();
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
    plan: async () => stepPlanFor(service, operation, context),
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
  /**
   * Return a failed operation as `failure`, with the results and evidence of
   * the operations already applied, rather than throwing them away. The
   * journal records the action exactly as it does for a throw.
   */
  reportFailure?: boolean;
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
  const resumed =
    journalAvailable && !parentScope && context.resumeJournalAction
      ? await reopenJournalAction({
          actionId: context.resumeJournalAction.actionId,
          conversationKey: context.request.conversationKey,
        })
      : null;
  const actionId =
    parentScope?.actionId ||
    resumed?.actionId ||
    (journalAvailable ? createJournalId("action") : null);
  const ownsAction = Boolean(actionId && !parentScope);

  const results: LibraryMutationExecutionResult[] = [];
  const completedOutcomes: AgentJournalStepOutcome[] = [];
  // What a reopened action already applied. It never counts as this call's
  // own effect, but the action's own status and affected count have to keep
  // it: a resume must not shrink the action it continues, nor report an
  // action that already wrote notes as having failed outright.
  const priorOutcome = resumed?.prior || null;
  const actionEvidence: AgentActionEvidence[] = [];
  let affectedCount = priorOutcome?.affectedCount || 0;
  let localSequence = resumed?.lastSequence || 0;
  // One allocator for the whole action, so an operation that contributes N
  // steps cannot collide with the sequences of its siblings.
  const allocateSequence = () =>
    parentScope ? parentScope.allocateSequence() : (localSequence += 1);
  // Steps that landed inside the operation currently running. If it throws,
  // its own summary never reaches completedOutcomes, and the action would
  // otherwise forget durable steps that already changed the library.
  let inFlightOutcomes: AgentJournalStepOutcome[] = [];
  try {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      // A reopened action was seeded by the attempt that opened it.
      const prepareAction =
        ownsAction && !resumed && index === 0
          ? (plan: MutationStepPlan) => ({
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
          : undefined;
      // A prior step may have created or changed an object referenced by this
      // operation. Re-plan at the step boundary so its pre-image describes
      // the state immediately before this write, not the state before the
      // whole batch started.
      const executed = ownsItsOwnJournalSteps(operation)
        ? await executeComposite({
            service,
            operation,
            context,
            actionId,
            parentScope,
            allocateSequence,
            prepareAction,
            onStepOutcome: (outcome) => inFlightOutcomes.push(outcome),
          })
        : await executeOne({
            service,
            operation,
            context,
            actionId,
            sequence: allocateSequence(),
            prepareAction,
          });
      results.push(executed.result);
      // Only the composite path writes several notes under one operation, so
      // only it carries per-note read-backs.
      const noteWrites =
        "noteWrites" in executed ? executed.noteWrites : undefined;
      if (
        executed.precondition &&
        executed.expectedPostcondition &&
        typeof executed.precondition === "object" &&
        typeof executed.expectedPostcondition === "object"
      ) {
        actionEvidence.push({
          version: 1,
          source: "library_mutation",
          proofDomain: "zotero_state",
          operationValue: operation,
          preState:
            executed.precondition as AgentLibraryMutationEvidence["preState"],
          postState:
            executed.expectedPostcondition as AgentLibraryMutationEvidence["postState"],
          journalStepId: executed.journalStepId,
          effect: executed.effect,
          ...(noteWrites?.length ? { noteWrites } : {}),
        });
      }
      completedOutcomes.push({
        effect: executed.effect,
        status: executed.status,
        reversibility: executed.reversibility,
        affectedCount: executed.affectedCount,
      });
      // The operation finished, so its own outcome now speaks for its steps.
      inFlightOutcomes = [];
      if (executed.effect !== "none") {
        affectedCount += executed.affectedCount;
      }
    }
    const summary = summarizeMutationOutcomes(completedOutcomes);
    const effect = summary.effect;
    const status =
      effect === "none"
        ? "no_effect"
        : effect === "partial"
          ? "partially_applied"
          : summary.reversibility === "none"
            ? "irreversible"
            : "applied";
    if (actionId && ownsAction) {
      // The caller is told what this call changed; the action records what it
      // holds altogether. A reused action is therefore summarized from every
      // step it owns, so a resume can neither shrink it nor rewrite an action
      // that still carries a failed step as fully applied.
      const final: Awaited<ReturnType<typeof resumedActionSummary>> = resumed
        ? await resumedActionSummary({
            actionId,
            affectedCount:
              (priorOutcome?.affectedCount || 0) + summary.affectedCount,
            unfinishedWork: Boolean(
              context.resumeJournalAction?.unfinishedWork,
            ),
            fallbackReversibility: summary.reversibility,
          })
        : {
            status,
            reversibility: summary.reversibility,
            affectedCount: summary.affectedCount,
          };
      // Its own transaction, so another flow's rollback cannot drop it. This
      // runs from a tool call, never inside a Zotero transaction, and the
      // steps above already journalled in transactions of this same flow.
      await inJournalTransaction(() =>
        updateJournalAction({ actionId, ...final }),
      );
    }
    return {
      actionId: actionId || undefined,
      effect,
      affectedCount: summary.affectedCount,
      results,
      actionEvidence,
    };
  } catch (error) {
    const changedOutcomes = [
      ...(priorOutcome ? [priorOutcome] : []),
      ...completedOutcomes,
      ...inFlightOutcomes,
    ].filter((outcome) => outcome.effect !== "none");
    for (const outcome of inFlightOutcomes) {
      if (outcome.effect !== "none") affectedCount += outcome.affectedCount;
    }
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
      await inJournalTransaction(() =>
        updateJournalAction({
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
        }),
      ).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (params.reportFailure) {
      return {
        actionId: actionId || undefined,
        effect: changedOutcomes.length ? "partial" : "none",
        affectedCount,
        results,
        actionEvidence,
        failure: { index: results.length, message, uncertain },
      };
    }
    if (changedOutcomes.length) throw new Error(`${message} (${recovery})`);
    if (uncertain) throw new Error(`${message} (${recovery})`);
    throw error;
  }
}

export function currentMutationActionId(): string | null {
  return getActiveJournalActionId();
}
