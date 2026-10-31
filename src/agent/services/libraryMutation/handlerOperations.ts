import type { AgentActionCapability, AgentToolContext } from "../../types";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "./contracts";
import { libraryMutationHandlers } from "./handlerRegistry";
import type {
  LibraryMutationHandler,
  LibraryMutationOperationOf,
  LibraryMutationOperationType,
  MutationTargetJudgment,
} from "./handlerDefinition";
import type { ZoteroGateway } from "../zoteroGateway";
import type { ForwardExecution } from "./forwardExecutors";
import { asMutationStateView, type MutationStateView } from "./stateView";

export function getLibraryMutationHandler<
  Type extends LibraryMutationOperationType,
>(operation: LibraryMutationOperationOf<Type>): LibraryMutationHandler<Type> {
  return libraryMutationHandlers[
    operation.type
  ] as unknown as LibraryMutationHandler<Type>;
}

export function capabilityForLibraryMutation(
  operation: LibraryMutationOperation | LibraryMutationOperationType,
): AgentActionCapability {
  const type = typeof operation === "string" ? operation : operation.type;
  return libraryMutationHandlers[type].actionCapability;
}

export function targetItemIdsForLibraryMutation(
  operation: LibraryMutationOperation,
): number[] {
  return [
    ...new Set(
      libraryMutationHandlers[operation.type]
        .targetItemIds(operation as never)
        .filter((itemId) => Number.isInteger(itemId) && itemId > 0),
    ),
  ];
}

export function actionDetailsForLibraryMutation(
  operation: LibraryMutationOperation,
): {
  parameters: ReturnType<
    LibraryMutationHandler<LibraryMutationOperationType>["actionParameters"]
  >;
  requestedTargets: string[];
  destinationCollectionIds: number[];
} {
  const handler = libraryMutationHandlers[operation.type];
  const destinationCollectionIds = [
    ...new Set(
      handler
        .destinationCollectionIds(operation as never)
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  return {
    parameters: handler.actionParameters(operation as never),
    requestedTargets: [
      ...new Set([
        ...targetItemIdsForLibraryMutation(operation).map(
          (itemId) => `item:${itemId}`,
        ),
        ...handler.additionalActionTargets(operation as never),
      ]),
    ],
    destinationCollectionIds,
  };
}

function mutationResultPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.result && typeof record.result === "object"
    ? record.result
    : value;
}

export function createdObjectIdsForLibraryMutation(
  operation: LibraryMutationOperation,
  executionResult: unknown,
): {
  itemIds: number[];
  collectionIds: number[];
  savedSearchIds: number[];
} {
  const handler = libraryMutationHandlers[operation.type];
  const payload = mutationResultPayload(executionResult);
  const normalize = (values: readonly number[]) => [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
  return {
    itemIds: normalize(handler.createdItemIds(payload)),
    collectionIds: normalize(handler.createdCollectionIds(payload)),
    savedSearchIds: normalize(handler.createdSavedSearchIds(payload)),
  };
}

export function mutationTargetCountFromHandler(
  operation: LibraryMutationOperation,
): number {
  return libraryMutationHandlers[operation.type].targetCount(
    operation as never,
  );
}

export function mutationAffectedCountFromHandler(
  operation: LibraryMutationOperation,
  result: unknown,
): number {
  return libraryMutationHandlers[operation.type].affectedCount(
    operation as never,
    result,
  );
}

export function atomizeMutationOperationFromHandler(
  operation: LibraryMutationOperation,
): LibraryMutationOperation[] {
  return libraryMutationHandlers[operation.type].atomize(operation as never);
}

export function mutationUsesDeferredInverse(
  operation: LibraryMutationOperation,
): boolean {
  return libraryMutationHandlers[operation.type].deferredInverse(
    operation as never,
  );
}

export function planMutationInverseFromHandler(
  operation: LibraryMutationOperation,
  state: LibraryMutationState | MutationStateView,
): Readonly<{
  inverseOperations?: LibraryMutationOperation[];
  reason?: string;
}> {
  return libraryMutationHandlers[operation.type].planInverse(
    operation as never,
    asMutationStateView(state),
  );
}

export function mutationPostconditionIsSatisfied(
  operation: LibraryMutationOperation,
  state: LibraryMutationState | MutationStateView,
): boolean {
  return libraryMutationHandlers[operation.type].postconditionSatisfied(
    operation as never,
    asMutationStateView(state),
  );
}

/**
 * The handler's own target-by-target judgment of a write, from the states
 * captured before and after it, or undefined when the handler does not judge
 * its targets one by one.
 */
export function judgeLibraryMutationTargets(
  operation: LibraryMutationOperation,
  before: LibraryMutationState | MutationStateView,
  after: LibraryMutationState | MutationStateView,
): MutationTargetJudgment | undefined {
  const judge = libraryMutationHandlers[operation.type].judgeTargets as
    | ((
        operation: never,
        before: MutationStateView,
        after: MutationStateView,
      ) => MutationTargetJudgment)
    | undefined;
  return judge?.(
    operation as never,
    asMutationStateView(before),
    asMutationStateView(after),
  );
}

/**
 * The handler's reason that a call which changed nothing found nothing to
 * do, proved by the states around it; undefined otherwise.
 */
export function mutationNoChangeOutcome(
  operation: LibraryMutationOperation,
  result: unknown,
  before: LibraryMutationState | MutationStateView,
  after: LibraryMutationState | MutationStateView,
): string | undefined {
  return libraryMutationHandlers[operation.type].noChangeOutcome(
    operation as never,
    result,
    asMutationStateView(before),
    asMutationStateView(after),
  );
}

/**
 * The part of `operation` a call the user stopped between its items reached,
 * from the call's result payload; undefined when the call was not stopped.
 */
export function mutationReachedFromHandler(
  operation: LibraryMutationOperation,
  result: unknown,
): LibraryMutationOperation | undefined {
  return libraryMutationHandlers[operation.type].reached(
    operation as never,
    result,
  ) as LibraryMutationOperation | undefined;
}

export function executeMutationFromHandler(
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  gateway: ZoteroGateway,
): Promise<ForwardExecution> {
  return libraryMutationHandlers[operation.type].execute(
    operation as never,
    context,
    gateway,
  );
}

export function isRegisteredLibraryMutationOperation(
  value: unknown,
): value is LibraryMutationOperation {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (!isLibraryMutationOperationType(type)) return false;
  return libraryMutationHandlers[type].validate(value);
}

export function isLibraryMutationOperationType(
  value: unknown,
): value is LibraryMutationOperationType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(libraryMutationHandlers, value)
  );
}
