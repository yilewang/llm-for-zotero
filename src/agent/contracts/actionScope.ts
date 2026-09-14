import type { SemanticReferenceResolver } from "./semanticReferences";
import { proposalViolatesConstraints } from "../authorization/policy";
import { readOnlyInvocationPlan } from "../authorization/invocationPlan";
import type {
  AgentActionContract,
  AgentActionIntent,
  AgentActionObligation,
  AgentActionProgressLedger,
  AgentRuntimeRequest,
} from "../types";
import type {
  ActionContractGateway,
  CollectionSummary,
} from "./actionOperationEvidence";
import { normalizePath, uniqueNumbers } from "./actionOperationEvidence";
import {
  isLibraryMutationOperationType,
  libraryMutationTargetsItems,
} from "../services/libraryMutation/handlerOperations";
import type { LibraryMutationOperationType } from "../services/libraryMutation/handlerDefinition";
import {
  getActiveTurnPaper,
  getInterpretedTurnPapers,
} from "../context/turnPaperScope";

export class ActionReferenceResolutionError extends Error {
  /**
   * "hard_constraint" marks a resolution failure caused by the user's own
   * explicit prohibition rather than by an ambiguous reference. Judgment
   * authority may resolve ambiguity; it may never resolve a prohibition, so
   * this cause must keep raising the pre-turn card in every permission mode.
   */
  readonly cause?: "hard_constraint";

  constructor(
    message: string,
    readonly sourceSelection?: import("./actionPreparation").ActionPreparation["sourceSelection"],
    cause?: "hard_constraint",
  ) {
    super(message);
    this.name = "ActionReferenceResolutionError";
    this.cause = cause;
  }
}

function listCurrentCollectionSummaries(
  gateway: ActionContractGateway,
  libraryID: number,
): CollectionSummary[] {
  return gateway.listCurrentCollectionSummaries
    ? gateway.listCurrentCollectionSummaries(libraryID)
    : gateway.listCollectionSummaries(libraryID);
}

export async function listScopeTargetIds(
  gateway: ActionContractGateway,
  params: {
    libraryID: number;
    collectionId: number;
    collectionPath: string;
    targetKind: AgentActionIntent["targetKind"];
    includeDescendants: boolean;
  },
): Promise<number[]> {
  const summaries = listCurrentCollectionSummaries(gateway, params.libraryID);
  const rootPath = normalizePath(params.collectionPath);
  const collectionIds = params.includeDescendants
    ? summaries
        .filter((summary) => {
          const path = normalizePath(summary.path || summary.name);
          return path === rootPath || path.startsWith(`${rootPath}/`);
        })
        .map((summary) => summary.collectionId)
    : [params.collectionId];
  const targetIds: number[] = [];
  for (const collectionId of collectionIds) {
    if (gateway.listCurrentCollectionTargetIds) {
      targetIds.push(
        ...gateway.listCurrentCollectionTargetIds({
          libraryID: params.libraryID,
          collectionId,
          targetKind: params.targetKind,
        }),
      );
      continue;
    }
    if (params.targetKind === "papers") {
      const result = await gateway.listCollectionPaperTargets({
        libraryID: params.libraryID,
        collectionId,
      });
      targetIds.push(...result.papers.map((paper) => paper.itemId));
    } else {
      const result = await gateway.listCollectionItemTargets({
        libraryID: params.libraryID,
        collectionId,
      });
      targetIds.push(...result.items.map((item) => item.itemId));
    }
  }
  return uniqueNumbers(targetIds);
}

export async function listCurrentLibraryTargetIds(
  gateway: ActionContractGateway,
  params: {
    libraryID: number;
    targetKind: AgentActionIntent["targetKind"];
  },
): Promise<number[]> {
  if (gateway.listCurrentLibraryTargetIds) {
    return uniqueNumbers(await gateway.listCurrentLibraryTargetIds(params));
  }
  if (params.targetKind === "papers") {
    if (!gateway.listLibraryPaperTargets) return [];
    const result = await gateway.listLibraryPaperTargets({
      libraryID: params.libraryID,
    });
    return uniqueNumbers(result.papers.map((paper) => paper.itemId));
  }
  if (!gateway.listLibraryItemTargets) return [];
  const result = await gateway.listLibraryItemTargets({
    libraryID: params.libraryID,
  });
  return uniqueNumbers(result.items.map((item) => item.itemId));
}

type ItemRequirement =
  | "attachment"
  | "regular"
  | "top_level"
  | "concrete"
  | "note";

function itemSatisfiesRequirement(
  item: Zotero.Item,
  requirement: ItemRequirement,
): boolean {
  if (requirement === "note") return item.isNote?.() === true;
  if (requirement === "attachment") return item.isAttachment?.() === true;
  if (requirement === "regular") return item.isRegularItem?.() === true;
  if (requirement === "top_level") {
    return !item.parentID && item.isAnnotation?.() !== true;
  }
  return true;
}

function operationRequirement(
  operation: LibraryMutationOperationType,
): ItemRequirement {
  switch (operation) {
    case "delete_attachment":
    case "rename_attachment":
    case "relink_attachment":
      return "attachment";
    case "move_to_collection":
    case "remove_from_collection":
    case "set_item_collections":
      return "top_level";
    case "update_metadata":
    case "save_notes_batch":
    case "merge_items":
      return "regular";
    case "apply_tags":
    case "remove_tags":
    case "set_item_tags":
    case "trash_items":
    case "restore_from_trash":
    case "reparent_items":
    case "relate_items":
      return "concrete";
    default:
      throw new ActionReferenceResolutionError(
        `Registered item-scoped operation ${operation} has no unscoped target category.`,
      );
  }
}

function validTargetItem(
  gateway: ActionContractGateway,
  itemId: number,
  libraryID: number,
  requirement: ItemRequirement,
): Zotero.Item | null {
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const item = gateway.getItem(itemId);
  if (!item || Math.floor(Number(item.libraryID)) !== libraryID) return null;
  return itemSatisfiesRequirement(item, requirement) ? item : null;
}

function requirementLabel(requirement: ItemRequirement): string {
  if (requirement === "attachment") return "attachment";
  if (requirement === "regular") return "regular bibliographic item";
  if (requirement === "top_level") return "top-level collection member";
  return "concrete Zotero item";
}

function resolveValidatedCandidates(params: {
  gateway: ActionContractGateway;
  libraryID: number;
  requirement: ItemRequirement;
  explicitItemId?: number;
  implicitItemIds: number[];
}): number[] {
  const explicitItemId = Number(params.explicitItemId);
  if (Number.isInteger(explicitItemId) && explicitItemId > 0) {
    const explicitItem = params.gateway.getItem(explicitItemId);
    if (!explicitItem) {
      throw new ActionReferenceResolutionError(
        `Explicit target item ${explicitItemId} does not exist.`,
      );
    }
    if (Math.floor(Number(explicitItem.libraryID)) !== params.libraryID) {
      throw new ActionReferenceResolutionError(
        `Explicit target item ${explicitItemId} belongs to a different Zotero library.`,
      );
    }
    if (!itemSatisfiesRequirement(explicitItem, params.requirement)) {
      throw new ActionReferenceResolutionError(
        `Explicit target item ${explicitItemId} is not a valid ${requirementLabel(params.requirement)}.`,
      );
    }
  }
  return uniqueNumbers([
    ...(Number.isInteger(explicitItemId) && explicitItemId > 0
      ? [explicitItemId]
      : []),
    ...params.implicitItemIds.filter((itemId) =>
      Boolean(
        validTargetItem(
          params.gateway,
          itemId,
          params.libraryID,
          params.requirement,
        ),
      ),
    ),
  ]);
}

async function resolveExplicitTargets(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
  libraryID: number,
): Promise<number[] | undefined> {
  if (!intent.targetSelectors?.length) return undefined;
  const requirement: ItemRequirement | undefined =
    intent.operation === "note_edit" || intent.operation === "note_append"
      ? "note"
      : isLibraryMutationOperationType(intent.operation) &&
          libraryMutationTargetsItems(intent.operation)
        ? intent.targetKind === "papers"
          ? "regular"
          : operationRequirement(intent.operation)
        : undefined;
  if (!requirement) return undefined;
  let libraryItems: Zotero.Item[] | undefined;
  const ids: number[] = [];
  for (const selector of intent.targetSelectors) {
    const literal = String(selector.value);
    let item: Zotero.Item | null;
    if (selector.kind === "item_id") item = gateway.getItem(selector.value);
    else if (selector.kind === "item_key")
      item =
        gateway.getItemByLibraryAndKey?.(
          libraryID,
          selector.value.toUpperCase(),
        ) || null;
    else {
      libraryItems ||= (
        await listCurrentLibraryTargetIds(gateway, {
          libraryID,
          targetKind: intent.targetKind,
        })
      )
        .map((id) => gateway.getItem(id))
        .filter((entry): entry is Zotero.Item => Boolean(entry));
      const matches = libraryItems.filter(
        (entry) =>
          itemSatisfiesRequirement(entry, requirement) &&
          String(entry.getField("title") || "").trim() ===
            selector.value.trim(),
      );
      if (matches.length > 1)
        throw new ActionReferenceResolutionError(
          `Explicit target title "${selector.value}" is ambiguous (${matches.length} matches).`,
        );
      item = matches[0] || null;
    }
    if (
      !item ||
      Number(item.libraryID) !== libraryID ||
      !itemSatisfiesRequirement(item, requirement)
    ) {
      throw new ActionReferenceResolutionError(
        `Explicit target ${literal} was not found in library ${libraryID} or is not valid for ${intent.operation}.`,
      );
    }
    ids.push(item.id);
  }
  return uniqueNumbers(ids);
}

async function resolveUnscopedBoundary(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
): Promise<AgentActionObligation["targetBoundary"]> {
  if (intent.operation === "note_edit" || intent.operation === "note_append") {
    const libraryID = Number(request.libraryID);
    const ids = intent.targetSelectors?.length
      ? await resolveExplicitTargets(gateway, request, intent, libraryID)
      : [intent.parameters?.targetNoteId || request.activeNoteContext?.noteId];
    const frozenTargetIds = uniqueNumbers(
      (ids || []).filter((id): id is number => Boolean(id)),
    );
    if (!frozenTargetIds.length) return undefined;
    for (const id of frozenTargetIds) {
      const note = gateway.getItem(id);
      if (
        !note ||
        note.deleted ||
        note.libraryID !== libraryID ||
        !note.isNote?.()
      )
        throw new ActionReferenceResolutionError(
          `The destination ${id} is not a live note in library ${libraryID}.`,
        );
    }
    return {
      kind: "selection",
      libraryID,
      frozenTargetIds,
      scopeDigest: [
        "v1",
        "selection",
        libraryID,
        ...frozenTargetIds.slice().sort((a, b) => a - b),
      ].join(":"),
    };
  }
  if (
    intent.operation === "note_create" &&
    (intent.parameters?.targetItemId ||
      intent.targetSelectors?.length ||
      ["active", "added", "all_visible"].includes(
        request.classifiedIntent?.paperTargetIntent || "",
      ))
  ) {
    // A child note targets its parent paper. Reuse the native paper resolver.
    return resolveUnscopedBoundary(gateway, request, {
      ...intent,
      operation: "move_to_collection",
      targetKind: "papers",
    });
  }
  if (
    !isLibraryMutationOperationType(intent.operation) ||
    !libraryMutationTargetsItems(intent.operation)
  ) {
    return undefined;
  }
  const libraryID = Math.floor(Number(request.libraryID));
  if (!Number.isInteger(libraryID) || libraryID <= 0) return undefined;
  const explicitTargets = await resolveExplicitTargets(
    gateway,
    request,
    intent,
    libraryID,
  );
  const interpretedPapers = getInterpretedTurnPapers(
    request.turnPaperScope,
    request.classifiedIntent?.paperTargetIntent,
  );
  let frozenTargetIds: number[];
  let kind: "library" | "selection";
  if (explicitTargets) {
    kind = "selection";
    frozenTargetIds = explicitTargets;
  } else if (intent.coverage === "all" && interpretedPapers === undefined) {
    kind = "library";
    frozenTargetIds = await listCurrentLibraryTargetIds(gateway, {
      libraryID,
      targetKind: intent.targetKind,
    });
  } else {
    kind = "selection";
    const explicitItemId = Number(intent.parameters?.targetItemId);
    const activePaper = getActiveTurnPaper(request.turnPaperScope);
    const selectedPaperIds = request.turnPaperScope.papers
      .filter((entry) => entry.roles.includes("selected"))
      .map((entry) => entry.paper.itemId);
    if (
      intent.targetKind === "papers" ||
      (interpretedPapers !== undefined &&
        operationRequirement(intent.operation) !== "attachment")
    ) {
      const implicitPaperIds = interpretedPapers?.map((paper) => paper.itemId);
      if (
        implicitPaperIds &&
        !implicitPaperIds.length &&
        request.classifiedIntent?.paperTargetIntent === "active"
      )
        implicitPaperIds.push(Number(request.activeItemId));
      frozenTargetIds = resolveValidatedCandidates({
        gateway,
        libraryID,
        requirement: "regular",
        explicitItemId,
        implicitItemIds: implicitPaperIds || [
          Number(activePaper?.itemId),
          Number(request.activeItemId),
          ...selectedPaperIds,
        ],
      });
    } else {
      const operation = intent.operation;
      const requirement = operationRequirement(operation);
      const rawActiveItemId = Number(request.activeItemId);
      const rawActiveIsValid = Boolean(
        validTargetItem(gateway, rawActiveItemId, libraryID, requirement),
      );
      const canonicalActiveItemId = Number(activePaper?.itemId);
      const canonicalRegularIsValid = Boolean(
        validTargetItem(gateway, canonicalActiveItemId, libraryID, "regular"),
      );
      let implicitItemIds: number[];
      if (requirement === "attachment") {
        implicitItemIds = [Number(activePaper?.contextItemId), rawActiveItemId];
      } else if (requirement === "top_level") {
        implicitItemIds = [
          ...(rawActiveIsValid ? [rawActiveItemId] : [canonicalActiveItemId]),
          ...selectedPaperIds,
        ];
      } else if (requirement === "regular") {
        implicitItemIds = [
          ...(canonicalRegularIsValid
            ? [canonicalActiveItemId]
            : [rawActiveItemId]),
          ...selectedPaperIds,
        ];
      } else {
        implicitItemIds = [
          rawActiveItemId,
          ...(!rawActiveIsValid ? [Number(activePaper?.itemId)] : []),
          ...(intent.coverage === "one" ? [] : selectedPaperIds),
        ];
      }
      frozenTargetIds = resolveValidatedCandidates({
        gateway,
        libraryID,
        requirement,
        explicitItemId,
        implicitItemIds,
      });
    }
    frozenTargetIds = frozenTargetIds.slice(
      0,
      intent.coverage === "one" ? 1 : undefined,
    );
    if (!frozenTargetIds.length) return undefined;
  }
  return {
    kind,
    libraryID,
    frozenTargetIds,
    scopeDigest: [
      "v1",
      kind,
      libraryID,
      ...frozenTargetIds.slice().sort((left, right) => left - right),
    ].join(":"),
  };
}

/** Resolve filing references and the product's collection-membership defaults.
 * Names here are typed references; this owner never examines request wording.
 */
export async function resolveScope(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
  collectionCreations: readonly AgentActionObligation[] = [],
  resolver?: SemanticReferenceResolver,
  sourceActionIndex = 0,
): Promise<AgentActionObligation[]> {
  if (intent.operation !== "move_to_collection")
    return resolveScopeReferences(
      gateway,
      request,
      intent,
      collectionCreations,
      resolver,
    );
  let filing = {
    ...intent,
    parameters: { ...intent.parameters },
    constraints: { ...intent.constraints },
  };
  const destinationName = filing.parameters.collectionName;
  const earlierCreations = collectionCreations.filter(
    (creation) => (creation.sourceActionIndex ?? -1) < sourceActionIndex,
  );
  let future =
    intent.destinationFrom === undefined
      ? undefined
      : earlierCreations.find(
          (creation) => creation.sourceActionIndex === intent.destinationFrom,
        );
  if (
    intent.destinationFrom !== undefined &&
    (!future || filing.parameters.destinationCollectionId)
  )
    throw new ActionReferenceResolutionError(
      "The destination reference must identify one earlier requested collection creation.",
    );
  if (
    !future &&
    destinationName &&
    !filing.parameters.destinationCollectionId &&
    filing.scopeRole === "source"
  ) {
    const named = earlierCreations.filter(
      (creation) =>
        normalizePath(creation.parameters?.collectionName) ===
        normalizePath(destinationName),
    );
    const existing = listCurrentCollectionSummaries(
      gateway,
      Number(request.libraryID),
    ).some(
      (collection) =>
        normalizePath(collection.name) === normalizePath(destinationName) ||
        normalizePath(collection.path) === normalizePath(destinationName),
    );
    if (!existing && named.length === 1) future = named[0];
  }
  if (future) {
    if (
      destinationName &&
      normalizePath(destinationName) !==
        normalizePath(future.parameters?.collectionName)
    )
      throw new ActionReferenceResolutionError(
        "The destination name conflicts with its referenced collection creation.",
      );
    delete filing.parameters.collectionName;
    if (filing.scopeRole === "destination")
      filing = { ...filing, scope: undefined, scopeRole: "source" };
  }
  if (
    !future &&
    destinationName &&
    !filing.parameters.destinationCollectionId
  ) {
    if (filing.scope && filing.scopeRole === "source") {
      const matches = await resolveCollectionReference(
        gateway,
        request,
        destinationName,
        resolver,
      );
      if (matches.length !== 1)
        throw new ActionReferenceResolutionError(
          `Destination collection "${destinationName}" ${matches.length ? "is ambiguous" : "was not found"}.`,
        );
      filing.parameters.destinationCollectionId = matches[0].collectionId;
    } else {
      filing = {
        ...filing,
        scopeRole: "destination",
        scope: {
          kind: "collection",
          path: destinationName,
          includeDescendants: false,
        },
      };
    }
    delete filing.parameters.collectionName;
  }
  const obligations = await resolveScopeReferences(
    gateway,
    request,
    filing,
    collectionCreations,
    resolver,
  );
  for (const obligation of obligations) {
    if (future)
      obligation.destinationCreation = {
        obligationId: future.id,
        libraryID: Number(request.libraryID),
      };
    const parameters = { ...obligation.parameters };
    const constraints = { ...obligation.constraints };
    if (obligation.scopeRole === "destination" && obligation.scope)
      parameters.destinationCollectionId = obligation.scope.collectionId;
    if (
      constraints.collectionMode === "move" &&
      !parameters.sourceCollectionId
    ) {
      if (obligation.scopeRole === "source" && obligation.scope)
        parameters.sourceCollectionId = obligation.scope.collectionId;
      else if (request.scopeType === "folder" && request.scopeId) {
        const source = gateway.getCollectionSummary(Number(request.scopeId));
        if (!source || source.libraryID !== Number(request.libraryID))
          throw new ActionReferenceResolutionError(
            "The current source collection is unavailable.",
          );
        parameters.sourceCollectionId = source.collectionId;
      } else {
        const subjects = obligation.targetBoundary?.frozenTargetIds || [];
        const sources = subjects.map((id) => {
          const item = gateway.getItem(id);
          if (!item?.getCollections)
            throw new ActionReferenceResolutionError(
              "The paper's source collection memberships could not be read.",
            );
          return uniqueNumbers(item.getCollections()).filter(
            (id) => id !== parameters.destinationCollectionId,
          );
        });
        const candidates = uniqueNumbers(sources.flat());
        if (
          !subjects.length ||
          sources.some((ids) => ids.length > 1) ||
          candidates.length > 1
        ) {
          const choices = candidates.map((id) => {
            const collection = gateway.getCollectionSummary(id);
            return {
              id,
              name: collection?.name || String(id),
              path: collection?.path || collection?.name || String(id),
            };
          });
          const question =
            "Which source collection should this action remove? All other memberships will be preserved.";
          throw new ActionReferenceResolutionError(question, {
            actionIndex: sourceActionIndex,
            question,
            candidates: choices,
          });
        }
        if (candidates.length === 1)
          parameters.sourceCollectionId = candidates[0];
        else {
          // Native read proves there is no membership to remove: the paper is
          // unfiled or already only in the destination. No removal is granted.
          delete constraints.collectionMode;
        }
      }
    }
    if (!parameters.destinationCollectionId && !obligation.destinationCreation)
      throw new ActionReferenceResolutionError(
        "A destination collection must be resolved before filing papers.",
      );
    if (parameters.destinationCollectionId && gateway.getCollectionSummary) {
      const destination = gateway.getCollectionSummary(
        parameters.destinationCollectionId,
      );
      if (!destination || destination.libraryID !== Number(request.libraryID))
        throw new ActionReferenceResolutionError(
          "The destination collection is unavailable in the current library.",
        );
    }
    obligation.parameters = parameters;
    obligation.constraints = Object.keys(constraints).length
      ? constraints
      : undefined;
  }
  return obligations;
}

async function resolveScopeReferences(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
  collectionCreations: readonly AgentActionObligation[] = [],
  resolver?: SemanticReferenceResolver,
): Promise<AgentActionObligation[]> {
  const collectionLifecycle =
    intent.operation === "update_collection" ||
    intent.operation === "delete_collection";
  if (collectionLifecycle && !intent.scope) {
    const requestedId = intent.parameters?.collectionId;
    const selected = request.turnPaperScope.collections;
    const selectedId =
      selected.length === 1 ? selected[0].collectionId : undefined;
    const collectionId = requestedId || selectedId;
    if (!collectionId) {
      throw new ActionReferenceResolutionError(
        `The ${intent.operation} action requires one exact collection target. Select one collection or provide its ID.`,
      );
    }
    const summary = gateway.getCollectionSummary(collectionId);
    if (!summary) {
      throw new ActionReferenceResolutionError(
        `Collection ${collectionId} is no longer available.`,
      );
    }
    const { scope: _scope, ...unscoped } = intent;
    return [
      {
        ...unscoped,
        id: `${intent.capability}:collection:${collectionId}`,
        parameters: { ...(intent.parameters || {}), collectionId },
      },
    ];
  }
  if (intent.operation === "create_collection") {
    const requestedParentId = intent.parameters?.parentCollectionId;
    if (requestedParentId === null || (!requestedParentId && !intent.scope)) {
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:unscoped`,
          parameters: {
            ...(intent.parameters || {}),
            parentCollectionId: intent.parameters?.parentCollectionId ?? null,
          },
        },
      ];
    }
    if (typeof requestedParentId === "number" && requestedParentId > 0) {
      if (!gateway.getCollectionSummary(requestedParentId)) {
        throw new ActionReferenceResolutionError(
          `Parent collection ${requestedParentId} is no longer available.`,
        );
      }
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:collection-parent:${requestedParentId}`,
        },
      ];
    }
    if (!intent.scope) {
      const selected = request.turnPaperScope.collections;
      if (selected.length !== 1) {
        throw new ActionReferenceResolutionError(
          "A nested collection creation requires one exact parent collection.",
        );
      }
      const parentId = selected[0].collectionId;
      if (!gateway.getCollectionSummary(parentId)) {
        throw new ActionReferenceResolutionError(
          `Parent collection ${parentId} is no longer available.`,
        );
      }
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:collection-parent:${parentId}`,
          parameters: {
            ...(intent.parameters || {}),
            parentCollectionId: parentId,
          },
        },
      ];
    }
  }
  if (!intent.scope) {
    const { scope: _scope, ...unscoped } = intent;
    const targetBoundary = await resolveUnscopedBoundary(
      gateway,
      request,
      intent,
    );
    if (
      isLibraryMutationOperationType(intent.operation) &&
      libraryMutationTargetsItems(intent.operation) &&
      !targetBoundary
    ) {
      throw new ActionReferenceResolutionError(
        `The ${intent.operation} action has no resolvable frozen target boundary. Select the exact target items or state a concrete library scope.`,
      );
    }
    return [
      {
        ...unscoped,
        id: `${intent.capability}:unscoped`,
        targetBoundary,
      },
    ];
  }
  const selected = request.turnPaperScope.collections;
  const requestedPath = normalizePath(intent.scope.path);
  let summaries: CollectionSummary[];
  if (requestedPath) {
    const libraryIDs = uniqueNumbers([
      ...selected.map((entry) => entry.libraryID),
      Number(request.libraryID),
    ]);
    summaries = libraryIDs.flatMap((libraryID) =>
      listCurrentCollectionSummaries(gateway, libraryID).filter((summary) => {
        const path = normalizePath(summary.path || summary.name);
        return (
          path === requestedPath ||
          normalizePath(summary.name) === requestedPath
        );
      }),
    );
    if (!summaries.length && intent.scopeRole === "destination") {
      const creations = collectionCreations.filter((creation) => {
        const name = normalizePath(creation.parameters?.collectionName);
        if (!name) return false;
        const parentId = creation.parameters?.parentCollectionId;
        const parent = parentId ? gateway.getCollectionSummary(parentId) : null;
        const path = parent
          ? `${normalizePath(parent.path || parent.name)}/${name}`
          : name;
        return requestedPath === name || requestedPath === path;
      });
      if (creations.length === 1) {
        const { scope: _scope, scopeRole: _role, ...sourceIntent } = intent;
        const sourceObligations = await resolveScopeReferences(
          gateway,
          request,
          sourceIntent,
        );
        return sourceObligations.map((obligation) => ({
          ...obligation,
          scopeRole: "destination",
          destinationCreation: {
            obligationId: creations[0].id,
            libraryID: Number(request.libraryID),
          },
        }));
      }
    }
    if (!summaries.length && resolver)
      summaries = await resolveCollectionReference(
        gateway,
        request,
        intent.scope.path || "",
        resolver,
        intent.scope.referenceKind || "literal",
      );
    if (summaries.length !== 1) {
      throw new ActionReferenceResolutionError(
        summaries.length
          ? `Collection scope "${intent.scope.path}" is ambiguous (${summaries.length} matches).`
          : `Collection scope "${intent.scope.path}" was not found.`,
      );
    }
  } else {
    summaries = selected
      .map((entry) => gateway.getCollectionSummary(entry.collectionId))
      .filter((entry): entry is CollectionSummary => Boolean(entry));
    if (!summaries.length) {
      throw new ActionReferenceResolutionError(
        "The requested collection scope is no longer available.",
      );
    }
  }
  const obligations: AgentActionObligation[] = [];
  for (const summary of summaries) {
    const collectionPath = summary.path || summary.name;
    if (intent.operation === "create_collection") {
      obligations.push({
        ...intent,
        id: `${intent.capability}:collection-parent:${summary.collectionId}`,
        parameters: {
          ...(intent.parameters || {}),
          parentCollectionId: summary.collectionId,
        },
        scope: undefined,
      });
      continue;
    }
    if (collectionLifecycle) {
      obligations.push({
        ...intent,
        id: `${intent.capability}:collection:${summary.collectionId}`,
        parameters: {
          ...(intent.parameters || {}),
          collectionId: summary.collectionId,
        },
        scope: {
          ...intent.scope,
          libraryID: summary.libraryID,
          collectionId: summary.collectionId,
          collectionPath,
        },
      });
      continue;
    }
    if (intent.scopeRole === "destination") {
      const targetBoundary = await resolveUnscopedBoundary(
        gateway,
        request,
        intent,
      );
      if (
        isLibraryMutationOperationType(intent.operation) &&
        libraryMutationTargetsItems(intent.operation) &&
        !targetBoundary
      ) {
        throw new ActionReferenceResolutionError(
          "The requested papers could not be resolved in the current library.",
        );
      }
      obligations.push({
        ...intent,
        id: `${intent.capability}:destination:${summary.collectionId}`,
        scope: {
          ...intent.scope,
          libraryID: summary.libraryID,
          collectionId: summary.collectionId,
          collectionPath,
        },
        targetBoundary,
      });
      continue;
    }
    let frozenTargetIds = await listScopeTargetIds(gateway, {
      libraryID: summary.libraryID,
      collectionId: summary.collectionId,
      collectionPath,
      targetKind: intent.targetKind,
      includeDescendants: intent.scope.includeDescendants,
    });
    const explicitTargets =
      (await resolveExplicitTargets(
        gateway,
        request,
        intent,
        summary.libraryID,
      )) ||
      (["active", "added", "all_visible"].includes(
        request.classifiedIntent?.paperTargetIntent || "",
      )
        ? (
            await resolveUnscopedBoundary(gateway, request, {
              ...intent,
              coverage: intent.coverage === "all" ? "some" : intent.coverage,
            })
          )?.frozenTargetIds
        : undefined);
    if (explicitTargets) {
      if (explicitTargets.some((id) => !frozenTargetIds.includes(id))) {
        throw new ActionReferenceResolutionError(
          "An explicit target is outside the requested source collection.",
        );
      }
      frozenTargetIds = explicitTargets;
    }
    obligations.push({
      ...intent,
      id: `${intent.capability}:collection:${summary.collectionId}`,
      scope: {
        ...intent.scope,
        libraryID: summary.libraryID,
        collectionId: summary.collectionId,
        collectionPath,
      },
      targetBoundary: {
        kind: explicitTargets ? "selection" : "collection",
        libraryID: summary.libraryID,
        frozenTargetIds,
        scopeDigest: [
          "v1",
          summary.libraryID,
          summary.collectionId,
          intent.scope.includeDescendants ? "recursive" : "direct",
          ...frozenTargetIds.slice().sort((left, right) => left - right),
        ].join(":"),
      },
    });
  }
  return obligations;
}

/** Resolve creation dependencies without changing the immutable user contract. */
export function resolveCreatedDestinations(
  gateway: ActionContractGateway,
  contract: AgentActionContract,
  progress: AgentActionProgressLedger | undefined,
): AgentActionContract {
  if (progress?.contractId !== contract.id) return contract;
  return {
    ...contract,
    obligations: contract.obligations.map((obligation) => {
      const dependency = obligation.destinationCreation;
      if (!dependency) return obligation;
      const creation = contract.obligations.find(
        (entry) => entry.id === dependency.obligationId,
      );
      const proof = progress.obligations.find(
        (entry) => entry.obligationId === dependency.obligationId,
      );
      if (
        creation?.operation !== "create_collection" ||
        !proof ||
        !["fulfilled", "already_satisfied"].includes(proof.status) ||
        proof.verifiedTargetIds.length !== 1
      )
        return obligation;
      const collectionId = Number(
        proof.verifiedTargetIds[0].match(/^collection:(\d+)$/)?.[1],
      );
      const summary = collectionId
        ? gateway.getCollectionSummary(collectionId)
        : null;
      const state = collectionId
        ? gateway.getCollectionNativeState?.(collectionId)
        : null;
      if (
        summary?.libraryID !== dependency.libraryID ||
        !state?.exists ||
        state.deleted ||
        state.name !== creation.parameters?.collectionName ||
        state.parentCollectionId !==
          (creation.parameters?.parentCollectionId ?? null)
      )
        return obligation;
      const { destinationCreation: _dependency, ...resolved } = obligation;
      if (resolved.scopeRole === "destination") delete resolved.scopeRole;
      return {
        ...resolved,
        parameters: {
          ...resolved.parameters,
          destinationCollectionId: collectionId,
        },
      };
    }),
  };
}

/** Resolve a descriptive reference using metadata inside a host-frozen source. */
export async function resolveDescriptiveTargets(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
  resolver?: SemanticReferenceResolver,
): Promise<AgentActionIntent> {
  const discovery = intent.discovery;
  if (!discovery) return intent;
  if (!resolver)
    throw new Error("Semantic reference interpretation is unavailable.");
  const libraryID = request.libraryID;
  if (!libraryID)
    throw new ActionReferenceResolutionError("Choose a library for discovery.");
  const invocationPlan = readOnlyInvocationPlan({
    domains: ["zotero_library", "network"],
    reason: "Resolve the requested references using native metadata.",
  });
  const violation = proposalViolatesConstraints(
    {
      operation: "library_search",
      domains: invocationPlan.domains,
      effects: ["read", "egress"],
      invocationPlan,
    },
    request.classifiedIntent?.semantic?.constraints || [],
  );
  if (violation)
    throw new ActionReferenceResolutionError(
      violation.description,
      undefined,
      "hard_constraint",
    );
  let sourceIds: number[];
  if (discovery.source === "library")
    sourceIds = await listCurrentLibraryTargetIds(gateway, {
      libraryID,
      targetKind: intent.targetKind,
    });
  else if (discovery.source === "context")
    sourceIds = uniqueNumbers(
      request.turnPaperScope.papers.map((entry) => entry.paper.itemId),
    );
  else {
    const path = normalizePath(discovery.collectionPath);
    const matches = listCurrentCollectionSummaries(gateway, libraryID).filter(
      (entry) =>
        normalizePath(entry.path || entry.name) === path ||
        normalizePath(entry.name) === path,
    );
    if (matches.length !== 1)
      throw new ActionReferenceResolutionError(
        `Discovery source "${discovery.collectionPath}" has ${matches.length} matches; choose one exact collection.`,
      );
    const source = matches[0];
    sourceIds = await listScopeTargetIds(gateway, {
      libraryID,
      collectionId: source.collectionId,
      collectionPath: source.path || source.name,
      targetKind: intent.targetKind,
      includeDescendants: intent.scope?.includeDescendants || false,
    });
  }
  const candidates = sourceIds
    .map((id) => gateway.getItem(id))
    .filter((item): item is Zotero.Item =>
      Boolean(
        item &&
        item.libraryID === libraryID &&
        itemSatisfiesRequirement(
          item,
          intent.targetKind === "papers"
            ? "regular"
            : isLibraryMutationOperationType(intent.operation)
              ? operationRequirement(intent.operation)
              : "concrete",
        ),
      ),
    )
    .map((item) => ({
      id: item.id,
      libraryID,
      label: String(item.getField("title") || ""),
      details: String(item.getField("abstractNote") || ""),
    }));
  const selected: number[] = [];
  // Bounded evidence per utility completion; all frozen candidates are covered.
  for (let start = 0; start < candidates.length; start += 50) {
    const batch = candidates.slice(start, start + 50);
    const result = await resolver.resolve({
      request,
      entity: "item",
      description: discovery.description,
      candidates: batch,
    });
    if (result.state === "needs_input")
      throw new ActionReferenceResolutionError(result.question);
    if (result.state === "unavailable") throw new Error(result.reason);
    if (
      result.ids.some((id) => !batch.some((candidate) => candidate.id === id))
    )
      throw new Error(
        "Semantic reference returned an item outside the frozen source.",
      );
    selected.push(...result.ids);
  }
  const ids = uniqueNumbers(selected);
  if (!ids.length)
    throw new ActionReferenceResolutionError(
      "No matching targets were established in the requested source. Clarify the reference or revise the discovery criteria.",
    );
  if (intent.coverage === "one" && ids.length !== 1)
    throw new ActionReferenceResolutionError(
      `The reference matches ${ids.length} papers; choose one.`,
    );
  return {
    ...intent,
    targetSelectors: ids.map((value) => ({ kind: "item_id" as const, value })),
  };
}

/** Exact names are deterministic; unmatched descriptions are resolved by the shared semantic owner. */
async function resolveCollectionReference(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  description: string,
  resolver?: SemanticReferenceResolver,
  referenceKind: "literal" | "descriptive" = "literal",
): Promise<CollectionSummary[]> {
  const candidates = listCurrentCollectionSummaries(
    gateway,
    Number(request.libraryID),
  ).filter((c) => c.libraryID === Number(request.libraryID));
  const name = normalizePath(description);
  const exact = candidates.filter(
    (c) =>
      normalizePath(c.path || c.name) === name ||
      normalizePath(c.name) === name,
  );
  if (exact.length || !resolver || !candidates.length) return exact;
  const invocationPlan = readOnlyInvocationPlan({
    domains: ["zotero_library", "network"],
    reason:
      "Resolve a descriptive collection reference from its native catalog.",
  });
  const violation = proposalViolatesConstraints(
    {
      operation: "library_search",
      domains: invocationPlan.domains,
      effects: ["read", "egress"],
      invocationPlan,
    },
    request.classifiedIntent?.semantic?.constraints || [],
  );
  if (violation)
    throw new ActionReferenceResolutionError(
      violation.description,
      undefined,
      "hard_constraint",
    );
  const result = await resolver.resolve({
    request,
    entity: "collection",
    description,
    referenceKind,
    candidates: candidates.map((c) => ({
      id: c.collectionId,
      libraryID: c.libraryID,
      label: c.name,
      details: c.path || c.name,
    })),
  });
  if (result.state === "needs_input")
    throw new ActionReferenceResolutionError(result.question);
  if (result.state === "unavailable") throw new Error(result.reason);
  if (result.ids.some((id) => !candidates.some((c) => c.collectionId === id)))
    throw new Error(
      "Semantic collection reference escaped the applicable library catalog.",
    );
  if (referenceKind === "literal") {
    // This validates provenance, not intent: only the semantic owner selects a
    // candidate, and its literal evidence must quote a complete native identity.
    const verified = candidates.filter(
      (candidate) =>
        result.ids.includes(candidate.collectionId) &&
        result.literalEvidence?.some(
          (evidence) =>
            evidence.id === candidate.collectionId &&
            Boolean(evidence.quote) &&
            normalizePath(
              [
                request.userText,
                ...(request.clarificationHistory || []).map(
                  (entry) => entry.answer,
                ),
              ].join("\n"),
            ).includes(normalizePath(evidence.quote)) &&
            [candidate.name, candidate.path || candidate.name].some(
              (name) => normalizePath(name) === normalizePath(evidence.quote),
            ),
        ),
    );
    if (verified.length !== result.ids.length) return [];
    for (const evidence of result.literalEvidence || []) {
      const matches = candidates.filter((candidate) =>
        [candidate.name, candidate.path || candidate.name].some(
          (name) => normalizePath(name) === normalizePath(evidence.quote),
        ),
      );
      if (matches.length > 1) return matches;
    }
    return verified;
  }
  return candidates.filter((c) => result.ids.includes(c.collectionId));
}
