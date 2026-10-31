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
  freezeJournalActionOperations,
  inJournalTransaction,
  isAgentChangeJournalAvailable,
  listJournalActions,
  listJournalSteps,
  prepareJournalAction,
  prepareJournalStep,
  readFrozenJournalActionOperations,
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
import {
  isRegisteredLibraryMutationOperation,
  mutationPostconditionIsSatisfied,
  targetItemIdsForLibraryMutation,
} from "./libraryMutation/handlerOperations";
import type { LibraryMutationState } from "./libraryMutation/contracts";
import { canonicalJson } from "./libraryMutation/canonicalJson";
import { withMoreChanges } from "./libraryMutation/describe";
import {
  checkpointedParts,
  mergeMutationStates,
  readCheckpointedBatch,
  remainingOperations,
  type CheckpointPart,
  type CheckpointedBatchReport,
} from "./checkpointedBatch";

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
  /** Set when the call ran as a checkpointed batch, one step per item. */
  checkpoint?: CheckpointedBatchReport;
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
  /** The states it may be reopened from; applied work by default. */
  from?: JournalStatus[];
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
  const from = params.from || ["applied", "partially_applied"];
  if (
    !action ||
    action.conversationKey !== params.conversationKey ||
    !from.includes(action.status)
  )
    return null;
  const claimed = await claimJournalAction({
    actionId: action.actionId,
    from,
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

function isMutationState(value: unknown): value is LibraryMutationState {
  return Boolean(value && typeof value === "object");
}

/** Why a part that ran did not land, from its own result rows. */
function partFailureReason(result: unknown): string | undefined {
  const reasons: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.reason === "string" &&
      ["missing", "refused", "error", "failed", "not_found"].includes(
        String(record.status),
      )
    )
      reasons.push(record.reason);
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(result, 0);
  return reasons[0];
}

/** What a receipt needs of an item that was written. */
type CheckpointPartRun = Pick<
  Awaited<ReturnType<typeof executeOne>>,
  "effect" | "precondition" | "expectedPostcondition" | "journalStepId"
>;

type CheckpointPartOutcome =
  | {
      kind: "ran" | "failed";
      error?: string;
      executed?: CheckpointPartRun;
    }
  | { kind: "not_started" };

/**
 * An item an interrupted attempt wrote and the journal left `uncertain`,
 * which native state showed to be there. It is recorded as done, not run.
 */
type SettledStep = CheckpointPartRun;

/** A part of the batch to run now, or one an earlier attempt settled. */
type ResumePart = CheckpointPart & { settled?: SettledStep };

/** Step states whose item was written, so the action has something to undo. */
const WRITTEN_STEP_STATUSES: ReadonlySet<JournalStatus> = new Set([
  "applied",
  "irreversible",
  "partially_applied",
]);

/**
 * The items the action holds written, from its steps. An item written again
 * (its change was not shown, so every resume wrote it once more) counts once,
 * up to as many times as the frozen list names it.
 */
function writtenItemCount(
  frozen: readonly LibraryMutationOperation[],
  steps: ReadonlyArray<{ status: JournalStatus; forwardJson: string }>,
): number {
  const allowed = new Map<string, number>();
  for (const operation of frozen) {
    const key = canonicalJson(operation);
    allowed.set(key, (allowed.get(key) || 0) + 1);
  }
  const written = new Map<string, number>();
  let unmatched = 0;
  for (const step of steps) {
    if (!WRITTEN_STEP_STATUSES.has(step.status)) continue;
    const forward = parseJsonText(step.forwardJson);
    const key = forward === undefined ? "" : canonicalJson(forward);
    if (!allowed.has(key)) unmatched += 1;
    else written.set(key, (written.get(key) || 0) + 1);
  }
  let total = unmatched;
  for (const [key, count] of written)
    total += Math.min(count, allowed.get(key) || 0);
  return total;
}

function parseJsonText(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Settle the steps an interrupted attempt left `uncertain`, by what Zotero
 * shows now, before their items are run again.
 *
 * A step whose postcondition already holds did its write: it becomes
 * `applied` (or `no_effect` when the item satisfied it before), keeping the
 * inverse planned from the pre-state, with the current state as its
 * post-image. Running the item again instead would snapshot the edited value
 * and leave this step as a conflict at undo. One that does not hold never
 * landed and becomes `failed`.
 */
async function settleUncertainSteps(params: {
  service: LibraryMutationService;
  context: AgentToolContext;
  actionId: string;
}): Promise<Map<string, SettledStep[]>> {
  const settled = new Map<string, SettledStep[]>();
  for (const step of await listJournalSteps(params.actionId)) {
    if (step.status !== "uncertain") continue;
    const forward = parseJsonText(step.forwardJson);
    if (!isRegisteredLibraryMutationOperation(forward)) continue;
    let current: unknown;
    try {
      current = await params.service.captureOperationState(
        forward,
        params.context,
        { reconciliation: true },
      );
    } catch {
      continue;
    }
    if (!isMutationState(current)) continue;
    if (!mutationPostconditionIsSatisfied(forward, current)) {
      await inJournalTransaction(() =>
        updateJournalStep({
          stepId: step.stepId,
          status: "failed",
          reversibility: "full",
          error: "Interrupted before the change landed.",
        }),
      );
      continue;
    }
    const precondition = parseJsonText(step.preconditionJson);
    let alreadyHeld = false;
    try {
      alreadyHeld =
        isMutationState(precondition) &&
        mutationPostconditionIsSatisfied(forward, precondition);
    } catch {
      alreadyHeld = false;
    }
    await inJournalTransaction(() =>
      updateJournalStep({
        stepId: step.stepId,
        status: alreadyHeld
          ? "no_effect"
          : step.reversibility === "none"
            ? "irreversible"
            : "applied",
        expectedPostcondition: current,
        reversibility: alreadyHeld ? "full" : step.reversibility,
        error: step.error,
      }),
    );
    const key = canonicalJson(forward);
    settled.set(key, [
      ...(settled.get(key) || []),
      {
        effect: alreadyHeld ? "none" : "applied",
        precondition,
        expectedPostcondition: current,
        journalStepId: step.stepId,
      },
    ]);
  }
  return settled;
}

/**
 * Continue a checkpointed batch under the action that froze it, so one undo
 * still reverts every item. Only operations the batch still owes run: an
 * item a done step already accounts for is never written again.
 */
async function resumeCheckpointedAction(params: {
  service: LibraryMutationService;
  operations: LibraryMutationOperation[];
  context: AgentToolContext;
  journalToolName: string;
  actionId: string;
}): Promise<CoordinatedMutationResult> {
  const { context } = params;
  const batch = await readCheckpointedBatch({
    actionId: params.actionId,
    conversationKey: context.request.conversationKey,
  });
  const owedBefore = new Map<string, number>();
  for (const operation of batch.remaining) {
    const key = canonicalJson(operation);
    owedBefore.set(key, (owedBefore.get(key) || 0) + 1);
  }
  const requested = params.operations.filter((operation) => {
    const key = canonicalJson(operation);
    const count = owedBefore.get(key) || 0;
    if (!count) return false;
    owedBefore.set(key, count - 1);
    return true;
  });
  if (!requested.length) {
    return {
      actionId: batch.actionId,
      effect: "none",
      affectedCount: 0,
      results: [],
      actionEvidence: [],
    };
  }
  // A crash between items leaves the action uncertain; its items are
  // one-item state edits, so the owed ones can safely run again.
  const reopened = await reopenJournalAction({
    actionId: batch.actionId,
    conversationKey: context.request.conversationKey,
    from: ["applied", "partially_applied", "uncertain"],
  });
  if (!reopened)
    throw new Error(
      `Batch ${batch.actionId} cannot be continued: it is ${batch.status}.`,
    );
  const operations: LibraryMutationOperation[] = [];
  const parts: ResumePart[] = [];
  try {
    // Only the call that holds the claim may settle the steps of an
    // interrupted attempt: a second resume must not rewrite the steps of a
    // run that is still going. An item that attempt wrote is settled from
    // native state before anything runs, so it is neither written twice nor
    // left outside the undo.
    const settled = await settleUncertainSteps({
      service: params.service,
      context,
      actionId: batch.actionId,
    });
    const owed = new Map<string, number>();
    for (const operation of remainingOperations(
      batch.frozen,
      await listJournalSteps(batch.actionId),
    )) {
      const key = canonicalJson(operation);
      owed.set(key, (owed.get(key) || 0) + 1);
    }
    for (const operation of requested) {
      const key = canonicalJson(operation);
      const count = owed.get(key) || 0;
      const earlier = settled.get(key);
      if (count) {
        owed.set(key, count - 1);
        parts.push({ source: operations.length, operation });
      } else if (earlier?.length) {
        parts.push({
          source: operations.length,
          operation,
          settled: earlier.shift(),
        });
      } else continue;
      operations.push(operation);
    }
  } catch (error) {
    // The claim moved the action to applying; give it back its status.
    await inJournalTransaction(() =>
      updateJournalAction({ actionId: batch.actionId, status: batch.status }),
    ).catch(() => undefined);
    throw error;
  }
  return executeCheckpointedAction({
    service: params.service,
    operations,
    parts,
    frozen: batch.frozen,
    context,
    journalToolName: params.journalToolName,
    reopened,
  });
}

/**
 * Run a bulk edit as one durable step per item under one action.
 *
 * The per-item list is frozen with the action before the first write, so a
 * call the user stops, or a Zotero that quits midway, leaves exactly what
 * remains on record. Stop takes effect between items; an item that fails is
 * reported and the others still run.
 */
async function executeCheckpointedAction(params: {
  service: LibraryMutationService;
  /** The call's operations, which its proposals and receipts name. */
  operations: LibraryMutationOperation[];
  /** The one-item parts to run now, each pointing at its operation. */
  parts: ResumePart[];
  /** Every part of the batch, as frozen when it was prepared. */
  frozen: LibraryMutationOperation[];
  context: AgentToolContext;
  journalToolName: string;
  reopened?: NonNullable<Awaited<ReturnType<typeof reopenJournalAction>>>;
}): Promise<CoordinatedMutationResult> {
  const { service, operations, parts, context, reopened } = params;
  const actionId = reopened?.actionId || createJournalId("action");
  let sequence = reopened?.lastSequence || 0;
  if (!reopened) {
    const first = await stepPlanFor(service, parts[0].operation, context);
    // Its own transaction: the action never exists without its frozen list.
    await inJournalTransaction(async () => {
      await prepareJournalAction({
        actionId,
        runId: runIdFor(context),
        conversationKey: context.request.conversationKey,
        toolName: params.journalToolName,
        description: withMoreChanges(first.description, parts.length),
        effect: "write",
        reversibility: first.reversibility,
        recovery: first.reason,
      });
      await freezeJournalActionOperations({
        actionId,
        operations: params.frozen,
      });
    });
  }

  const outcomes: CheckpointPartOutcome[] = [];
  const results: LibraryMutationExecutionResult[] = [];
  let changed = 0;
  let affectedCount = 0;
  let stopped = false;
  let remaining = params.frozen.length;
  // Items the action holds written, counted from its durable steps.
  let total = 0;
  try {
    for (const part of parts) {
      if (part.settled) {
        // Written by an interrupted attempt; the journal now says so.
        outcomes.push({ kind: "ran", executed: part.settled });
        if (part.settled.effect !== "none") {
          changed += 1;
          affectedCount += 1;
        }
        continue;
      }
      if (stopped || context.signal?.aborted) {
        stopped = true;
        outcomes.push({ kind: "not_started" });
        continue;
      }
      try {
        const executed = await executeOne({
          service,
          operation: part.operation,
          context,
          actionId,
          sequence: (sequence += 1),
        });
        results.push(executed.result);
        if (executed.effect !== "none") {
          changed += 1;
          affectedCount += executed.affectedCount;
        }
        const post = executed.expectedPostcondition;
        if (
          isMutationState(post) &&
          mutationPostconditionIsSatisfied(part.operation, post)
        ) {
          outcomes.push({ kind: "ran", executed });
          continue;
        }
        const error =
          partFailureReason(executed.result) ||
          "Zotero does not show this change.";
        // It changed nothing it was asked to, so the batch still owes it.
        if (executed.effect === "none" && executed.journalStepId)
          await inJournalTransaction(() =>
            updateJournalStep({
              stepId: executed.journalStepId!,
              status: "failed",
              reversibility: "full",
              error,
            }),
          );
        outcomes.push({ kind: "failed", error, executed });
      } catch (error) {
        // The step's own journal row already records how it ended.
        outcomes.push({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    // What the action holds altogether, from every step it owns: the items
    // this call ran and the ones earlier attempts did.
    // The steps are the only complete record: a process that died midway
    // never wrote the action's own count, so a resume cannot rely on it.
    const steps = await listJournalSteps(actionId);
    remaining = remainingOperations(params.frozen, steps).length;
    total = writtenItemCount(params.frozen, steps);
    const reversibility = combineReversibility(
      steps
        .filter(
          (step) => step.status !== "no_effect" && step.status !== "failed",
        )
        .map((step) => step.reversibility),
    );
    await inJournalTransaction(() =>
      updateJournalAction({
        actionId,
        status: total
          ? remaining
            ? "partially_applied"
            : reversibility === "none"
              ? "irreversible"
              : "applied"
          : remaining
            ? "failed"
            : "no_effect",
        reversibility,
        affectedCount: total,
        ...(remaining ? { recovery: `${remaining} item changes remain.` } : {}),
      }),
    ).catch(() => undefined);
  }

  const failed = parts.flatMap((part, index) => {
    const outcome = outcomes[index];
    return outcome?.kind === "failed"
      ? [
          {
            itemIds: targetItemIdsForLibraryMutation(part.operation),
            error: outcome.error || "The change failed.",
          },
        ]
      : [];
  });
  const notStarted = outcomes.filter(
    (outcome) => outcome.kind === "not_started",
  ).length;
  // A resume that tried items and finished none failed on them again, and
  // asking for it again would only add another step per item. An item that
  // wrote something Zotero does not show counts as failed here, not as
  // progress: it is written again on every resume and never lands.
  const verified = outcomes.filter((outcome) => outcome.kind === "ran").length;
  const stalled =
    Boolean(reopened) && verified === 0 && failed.length > 0 && !stopped;
  const resumable = total > 0 && remaining > 0 && !stalled;

  // Grouped once: a scan of every part per operation is quadratic.
  const partsBySource = new Map<
    number,
    Array<{ part: ResumePart; outcome: CheckpointPartOutcome }>
  >();
  parts.forEach((part, index) => {
    const group = partsBySource.get(part.source);
    const entry = { part, outcome: outcomes[index] };
    if (group) group.push(entry);
    else partsBySource.set(part.source, [entry]);
  });

  const actionEvidence: AgentActionEvidence[] = operations.map(
    (operation, source) => {
      const mine = partsBySource.get(source) || [];
      const ran = mine.flatMap(({ outcome }) =>
        outcome.kind !== "not_started" && outcome.executed
          ? [outcome.executed]
          : [],
      );
      const clean = mine.every(({ outcome }) => outcome.kind === "ran");
      return {
        version: 1,
        source: "library_mutation",
        proofDomain: "zotero_state",
        operationValue: operation,
        preState: mergeMutationStates(
          operation.type,
          ran.map((executed) => executed.precondition).filter(isMutationState),
        ),
        postState: mergeMutationStates(
          operation.type,
          ran
            .map((executed) => executed.expectedPostcondition)
            .filter(isMutationState),
        ),
        journalStepId: ran[0]?.journalStepId,
        effect: combineEffects(ran.map((executed) => executed.effect)),
        ...(clean
          ? {}
          : {
              checkpointParts: mine.map(({ part, outcome }) => ({
                operationValue: part.operation,
                outcome: outcome.kind,
                ...(outcome.kind === "failed" && outcome.error
                  ? { error: outcome.error }
                  : {}),
              })),
            }),
      } satisfies AgentLibraryMutationEvidence;
    },
  );

  return {
    actionId,
    effect: changed
      ? failed.length || notStarted
        ? "partial"
        : "applied"
      : "none",
    affectedCount,
    results,
    actionEvidence,
    checkpoint: {
      batchId: actionId,
      total: params.frozen.length,
      done: params.frozen.length - remaining,
      changed,
      failed,
      notStarted,
      stopped,
      resumable,
      ...(stalled ? { stalled } : {}),
    },
  };
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
  // A bulk edit runs one checkpointed step per item; so does the rest of a
  // batch that froze its items. Everything else runs as it always has.
  if (journalAvailable && !parentScope) {
    const resumeId = context.resumeJournalAction?.actionId;
    if (resumeId && (await readFrozenJournalActionOperations(resumeId)))
      return resumeCheckpointedAction({
        service,
        operations,
        context,
        journalToolName,
        actionId: resumeId,
      });
    const parts = resumeId ? null : checkpointedParts(operations);
    if (parts)
      return executeCheckpointedAction({
        service,
        operations,
        parts,
        frozen: parts.map((part) => part.operation),
        context,
        journalToolName,
      });
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
              description: withMoreChanges(plan.description, operations.length),
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
