import type {
  AgentActionCapability,
  AgentActionParameters,
  AgentToolContext,
} from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import type { LibraryMutationOperation } from "./contracts";
import { forwardExecutors, type ForwardExecution } from "./forwardExecutors";
import type { MutationStateView } from "./stateView";

export type LibraryMutationOperationType = LibraryMutationOperation["type"];
export type LibraryMutationOperationOf<
  Type extends LibraryMutationOperationType,
> = Extract<LibraryMutationOperation, { type: Type }>;

/**
 * An operation's targets judged one at a time against the states captured
 * around the write.
 *
 * `refused` holds the targets the operation cannot apply to at all, decided
 * from the state captured before it ran, grouped by reason; each reason names
 * its own items, so it can be read on its own. `judged` holds every other
 * target, with whether its own postcondition held before the write and holds
 * after it.
 */
export type MutationTargetJudgment = Readonly<{
  refused: ReadonlyArray<
    Readonly<{ itemIds: readonly number[]; reason: string }>
  >;
  judged: ReadonlyArray<
    Readonly<{ itemId: number; before: boolean; after: boolean }>
  >;
}>;

export type LibraryMutationHandler<Type extends LibraryMutationOperationType> =
  Readonly<{
    type: Type;
    validate: (value: unknown) => value is LibraryMutationOperationOf<Type>;
    targetCount: (operation: LibraryMutationOperationOf<Type>) => number;
    targetItemIds: (
      operation: LibraryMutationOperationOf<Type>,
    ) => readonly number[];
    affectedCount: (
      operation: LibraryMutationOperationOf<Type>,
      result: unknown,
    ) => number;
    atomize: (
      operation: LibraryMutationOperationOf<Type>,
    ) => LibraryMutationOperation[];
    stateSections: readonly (
      | "items"
      | "collections"
      | "savedSearches"
      | "libraryTags"
      | "relations"
    )[];
    deferredInverse: (operation: LibraryMutationOperationOf<Type>) => boolean;
    planInverse: (
      operation: LibraryMutationOperationOf<Type>,
      state: MutationStateView,
    ) => Readonly<{
      inverseOperations?: LibraryMutationOperation[];
      reason?: string;
    }>;
    postconditionSatisfied: (
      operation: LibraryMutationOperationOf<Type>,
      state: MutationStateView,
    ) => boolean;
    /**
     * The targets judged one by one, for a handler whose operation names
     * items it can judge independently. Without it, a receipt rests on
     * `postconditionSatisfied` for the whole set, which cannot say which
     * targets landed when some did not.
     */
    judgeTargets?: (
      operation: LibraryMutationOperationOf<Type>,
      before: MutationStateView,
      after: MutationStateView,
    ) => MutationTargetJudgment;
    /**
     * Why a call that changed nothing changed nothing, when that outcome is
     * an answer rather than work already done (a search that found nothing),
     * and the states captured before and after the call prove that nothing
     * changed. Undefined for every other outcome. Its receipt is `observed`:
     * verified, with the reason, and its targets not counted as done.
     */
    noChangeOutcome: (
      operation: LibraryMutationOperationOf<Type>,
      result: unknown,
      before: MutationStateView,
      after: MutationStateView,
    ) => string | undefined;
    /**
     * The part of the operation a call the user stopped between its items
     * had reached, read from the call's result payload; undefined for a call
     * that ran to its end. Only an operation that stops between items has
     * one, and its receipt is judged on that part alone.
     */
    reached: (
      operation: LibraryMutationOperationOf<Type>,
      result: unknown,
    ) => LibraryMutationOperationOf<Type> | undefined;
    execute: (
      operation: LibraryMutationOperationOf<Type>,
      context: AgentToolContext,
      gateway: ZoteroGateway,
    ) => Promise<ForwardExecution>;
    replay: "state-aware" | "forward-only";
    targetScope: "items" | "none";
    actionCapability: AgentActionCapability;
    actionParameters: (
      operation: LibraryMutationOperationOf<Type>,
    ) => AgentActionParameters | undefined;
    destinationCollectionIds: (
      operation: LibraryMutationOperationOf<Type>,
    ) => readonly number[];
    additionalActionTargets: (
      operation: LibraryMutationOperationOf<Type>,
    ) => readonly string[];
    createdItemIds: (result: unknown) => readonly number[];
    createdCollectionIds: (result: unknown) => readonly number[];
    createdSavedSearchIds: (result: unknown) => readonly number[];
    executionDomain:
      | "item-metadata-tags-relations"
      | "collection-search-structure"
      | "notes-lifecycle"
      | "attachments-imports";
  }>;

export type LibraryMutationHandlerRegistry = {
  [Type in LibraryMutationOperationType]: LibraryMutationHandler<Type>;
};

type HandlerOptions<Type extends LibraryMutationOperationType> = Pick<
  LibraryMutationHandler<Type>,
  "actionCapability" | "postconditionSatisfied" | "targetScope"
> &
  Partial<
    Pick<
      LibraryMutationHandler<Type>,
      | "targetCount"
      | "targetItemIds"
      | "actionParameters"
      | "destinationCollectionIds"
      | "additionalActionTargets"
      | "createdItemIds"
      | "createdCollectionIds"
      | "createdSavedSearchIds"
      | "affectedCount"
      | "atomize"
      | "stateSections"
      | "deferredInverse"
      | "planInverse"
      | "judgeTargets"
      | "noChangeOutcome"
      | "reached"
      | "execute"
      | "replay"
      | "executionDomain"
    >
  >;

export function defineHandler<Type extends LibraryMutationOperationType>(
  type: Type,
  options: HandlerOptions<Type>,
): LibraryMutationHandler<Type> {
  return Object.freeze({
    type,
    validate: (value: unknown): value is LibraryMutationOperationOf<Type> =>
      Boolean(
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === type,
      ),
    targetCount: options.targetCount || (() => 1),
    targetItemIds: options.targetItemIds || (() => []),
    actionParameters: options.actionParameters || (() => undefined),
    destinationCollectionIds: options.destinationCollectionIds || (() => []),
    additionalActionTargets: options.additionalActionTargets || (() => []),
    createdItemIds: options.createdItemIds || (() => []),
    createdCollectionIds: options.createdCollectionIds || (() => []),
    createdSavedSearchIds: options.createdSavedSearchIds || (() => []),
    affectedCount: options.affectedCount || (() => 1),
    atomize: options.atomize || ((operation) => [operation]),
    stateSections: options.stateSections || [],
    deferredInverse: options.deferredInverse || (() => false),
    planInverse: options.planInverse || (() => ({})),
    postconditionSatisfied: options.postconditionSatisfied,
    ...(options.judgeTargets ? { judgeTargets: options.judgeTargets } : {}),
    noChangeOutcome: options.noChangeOutcome || (() => undefined),
    reached: options.reached || (() => undefined),
    execute:
      options.execute ||
      ((operation, context, gateway) =>
        forwardExecutors[type](operation as never, context, gateway)),
    replay: options.replay || "forward-only",
    targetScope: options.targetScope,
    actionCapability: options.actionCapability,
    executionDomain: options.executionDomain || "item-metadata-tags-relations",
  });
}
