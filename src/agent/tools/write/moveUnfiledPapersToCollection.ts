import type { AgentToolDefinition } from "../../types";
import type {
  BatchMoveAssignment,
  CollectionSummary,
  LibraryPaperTarget,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  validateObject,
} from "../shared";
import { classifyRequest } from "../../model/requestClassifier";
import { pushUndoEntry } from "../../store/undoStore";

type MoveUnfiledPapersToCollectionInput = {
  assignments?: Array<{
    itemId: number;
    targetCollectionId?: number;
    reason?: string;
  }>;
  itemIds?: number[];
  targetCollectionId?: number;
  libraryID?: number;
};


function describeMoveTarget(target: LibraryPaperTarget): string {
  return [target.firstCreator, target.year].filter(Boolean).join(" • ");
}

function buildMoveTargetDescription(
  target: LibraryPaperTarget,
  suggestion?: {
    reason?: string;
  },
): string {
  const lines = [describeMoveTarget(target)].filter(Boolean);
  if (suggestion?.reason) {
    lines.push(`Why: ${suggestion.reason}`);
  } else {
    lines.push("Choose a destination collection or leave this paper skipped.");
  }
  return lines.join("\n");
}

function normalizeSuggestedAssignments(
  value: unknown,
): MoveUnfiledPapersToCollectionInput["assignments"] {
  if (!Array.isArray(value)) return undefined;
  const normalized: NonNullable<MoveUnfiledPapersToCollectionInput["assignments"]> =
    [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const itemId = normalizePositiveInt(entry.itemId);
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const reason =
      typeof entry.reason === "string" && entry.reason.trim()
        ? entry.reason.trim()
        : undefined;
    normalized.push({
      itemId,
      targetCollectionId: normalizePositiveInt(entry.targetCollectionId),
      reason,
    });
  }
  return normalized.length ? normalized : undefined;
}

function parseConfirmedAssignments(
  value: unknown,
): BatchMoveAssignment[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: BatchMoveAssignment[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const itemId = normalizePositiveInt(entry.id ?? entry.itemId);
    if (!itemId || seen.has(itemId)) continue;
    const isChecked = entry.checked !== false;
    const rawTarget =
      typeof entry.value === "string" || typeof entry.value === "number"
        ? entry.value
        : entry.targetCollectionId;
    if (!isChecked || rawTarget === "__skip__") continue;
    const targetCollectionId = normalizePositiveInt(rawTarget);
    if (!targetCollectionId) continue;
    seen.add(itemId);
    normalized.push({
      itemId,
      targetCollectionId,
    });
  }
  return normalized;
}

function buildDirectAssignments(
  input: MoveUnfiledPapersToCollectionInput,
): BatchMoveAssignment[] {
  if (input.assignments?.length) {
    return input.assignments
      .filter(
        (entry): entry is { itemId: number; targetCollectionId: number } =>
          Boolean(entry.targetCollectionId),
      )
      .map((entry) => ({
        itemId: entry.itemId,
        targetCollectionId: entry.targetCollectionId,
      }));
  }
  if (!input.itemIds?.length || !input.targetCollectionId) {
    return [];
  }
  return input.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: input.targetCollectionId as number,
  }));
}

function resolveCandidateTargets(
  input: MoveUnfiledPapersToCollectionInput,
  context: Parameters<
    AgentToolDefinition<MoveUnfiledPapersToCollectionInput, unknown>["execute"]
  >[1],
  zoteroGateway: ZoteroGateway,
): Promise<{
  libraryID: number;
  collections: CollectionSummary[];
  targets: LibraryPaperTarget[];
}> {
  const libraryID = zoteroGateway.resolveLibraryID({
    request: context.request,
    item: context.item,
    libraryID: input.libraryID,
  });
  if (!libraryID) {
    throw new Error("No active library available for moving unfiled papers");
  }
  const collections = zoteroGateway.listCollectionSummaries(libraryID);
  const assignmentItemIds = input.assignments?.map((entry) => entry.itemId) || [];
  const candidateItemIds = assignmentItemIds.length
    ? assignmentItemIds
    : input.itemIds || [];
  if (candidateItemIds.length) {
    const targets = zoteroGateway
      .getPaperTargetsByItemIds(candidateItemIds)
      .filter((target) => target.collectionIds.length === 0);
    return Promise.resolve({
      libraryID,
      collections,
      targets,
    });
  }
  return zoteroGateway.listUnfiledPaperTargets({ libraryID }).then((result) => ({
    libraryID,
    collections,
    targets: result.papers,
  }));
}

function buildCollectionOptions(collections: CollectionSummary[]) {
  return [
    {
      id: "__skip__",
      label: "Skip for now",
    },
    ...collections.map((collection) => ({
      id: `${collection.collectionId}`,
      label: collection.path || collection.name,
    })),
  ];
}

function buildSuggestedAssignmentMap(
  input: MoveUnfiledPapersToCollectionInput,
): Map<
  number,
  {
    targetCollectionId?: number;
    reason?: string;
  }
> {
  const out = new Map<
    number,
    {
      targetCollectionId?: number;
      reason?: string;
    }
  >();
  for (const assignment of input.assignments || []) {
    out.set(assignment.itemId, {
      targetCollectionId: assignment.targetCollectionId,
      reason: assignment.reason,
    });
  }
  if (input.itemIds?.length && input.targetCollectionId) {
    for (const itemId of input.itemIds) {
      if (out.has(itemId)) continue;
      out.set(itemId, {
        targetCollectionId: input.targetCollectionId,
      });
    }
  }
  return out;
}

export function createMoveUnfiledPapersToCollectionTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<MoveUnfiledPapersToCollectionInput, unknown> {
  return {
    spec: {
      name: "move_unfiled_papers_to_collection",
      description:
        "Move one or more currently unfiled Zotero papers into existing collections after a single user approval. Supports per-paper collection suggestions that the user can review and override in one confirmation card.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          assignments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                itemId: { type: "number" },
                targetCollectionId: { type: "number" },
                reason: { type: "string" },
              },
              required: ["itemId"],
            },
          },
          itemIds: {
            type: "array",
            items: { type: "number" },
          },
          targetCollectionId: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isMoveToCollectionQuery,
      instruction: [
        "When the user asks to move or organize unfiled papers into collections, use browse/list tools if needed, then call move_unfiled_papers_to_collection with per-paper assignments so the confirmation card opens with one paper per row and a suggested destination for each paper.",
        "Do not stop after listing papers and collections in chat, and do not ask the user to choose destinations in plain text.",
        "If you are unsure about a paper, omit targetCollectionId for that paper so the row defaults to Skip for now in the confirmation card.",
      ].join("\n"),
    },
    presentation: {
      label: "Move Unfiled Papers",
      summaries: {
        onCall: "Preparing suggested collection assignments for unfiled papers",
        onPending: "Waiting for your approval on the suggested collection moves",
        onApproved: "Approval received - moving the papers",
        onDenied: "Collection move cancelled",
        onSuccess: ({ content }) => {
          const movedCount =
            content && typeof content === "object"
              ? Number((content as { movedCount?: unknown }).movedCount || 0)
              : 0;
          return movedCount > 0
            ? `Moved ${movedCount} paper${movedCount === 1 ? "" : "s"}`
            : "No papers were moved";
        },
      },
    },
    validate: (args) => {
      if (args === undefined) {
        return ok<MoveUnfiledPapersToCollectionInput>({});
      }
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      return ok<MoveUnfiledPapersToCollectionInput>({
        assignments: normalizeSuggestedAssignments(args.assignments),
        itemIds: normalizePositiveIntArray(args.itemIds) || undefined,
        targetCollectionId: normalizePositiveInt(args.targetCollectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    shouldRequireConfirmation: async (input, context) => {
      const { targets, collections } = await resolveCandidateTargets(
        input,
        context,
        zoteroGateway,
      );
      return targets.length > 0 && collections.length > 0;
    },
    createPendingAction: async (input, context) => {
      const { collections, targets } = await resolveCandidateTargets(
        input,
        context,
        zoteroGateway,
      );
      const suggestedAssignments = buildSuggestedAssignmentMap(input);
      const collectionOptions = buildCollectionOptions(collections);
      const suggestedCount = Array.from(suggestedAssignments.values()).filter(
        (entry) => entry.targetCollectionId,
      ).length;
      return {
        toolName: "move_unfiled_papers_to_collection",
        title:
          suggestedCount > 0
            ? "Review suggested collection moves"
            : "Review collection moves for unfiled papers",
        description:
          "Each paper has its own destination selector. Review or change any suggestion before approval. Rows set to Skip for now will not be moved.",
        confirmLabel: "Move papers",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "assignment_table",
            id: "assignments",
            label: "Review each paper",
            options: collectionOptions,
            rows: targets.map((target) => {
              const suggestion = suggestedAssignments.get(target.itemId);
              const suggestedCollectionId =
                suggestion?.targetCollectionId &&
                collectionOptions.some(
                  (option) => option.id === `${suggestion.targetCollectionId}`,
                )
                  ? `${suggestion.targetCollectionId}`
                  : "__skip__";
              return {
                id: `${target.itemId}`,
                label: target.title,
                description: buildMoveTargetDescription(target, suggestion),
                value: suggestedCollectionId,
                checked: suggestedCollectionId !== "__skip__",
              };
            }),
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      let assignments = buildDirectAssignments(input);
      if (validateObject<Record<string, unknown>>(resolutionData)) {
        const confirmedAssignments = parseConfirmedAssignments(
          resolutionData.assignments,
        );
        if (confirmedAssignments) {
          assignments = confirmedAssignments;
        }
      }
      if (!assignments.length) {
        return fail("Select at least one paper with a destination collection");
      }
      return ok({
        ...input,
        assignments,
      });
    },
    execute: async (input, context) => {
      const assignments = buildDirectAssignments(input);
      const effectiveAssignments = assignments.length
        ? assignments
        : (() => {
            throw new Error("No paper-to-collection assignments were selected");
          })();
      const result = await zoteroGateway.moveUnfiledItemsToCollections({
        assignments: effectiveAssignments,
      });
      const movedItems = result.items
        .filter((item) => item.status === "moved" && item.targetCollectionId)
        .map((item) => ({
          itemId: item.itemId,
          collectionId: item.targetCollectionId as number,
        }));
      if (movedItems.length > 0) {
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-move-unfiled-${Date.now()}`,
          toolName: "move_unfiled_papers_to_collection",
          description: `Undo move of ${movedItems.length} paper${movedItems.length === 1 ? "" : "s"} to collections`,
          revert: async () => {
            for (const { itemId, collectionId } of movedItems) {
              await zoteroGateway.removeItemFromCollection({
                itemId,
                collectionId,
              });
            }
          },
        });
      }
      return result;
    },
  };
}
