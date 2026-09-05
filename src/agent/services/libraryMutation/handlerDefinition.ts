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
