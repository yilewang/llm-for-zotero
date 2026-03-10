import type { AgentToolDefinition } from "../../types";
import type {
  BatchTagAssignment,
  LibraryPaperTarget,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  normalizeStringArray,
  ok,
  validateObject,
} from "../shared";
import { classifyRequest } from "../../model/requestClassifier";
import { pushUndoEntry } from "../../store/undoStore";

type ApplyTagsInput = {
  assignments?: Array<{
    itemId: number;
    tags?: string[];
    reason?: string;
  }>;
  itemIds?: number[];
  tags?: string[];
  libraryID?: number;
};


function formatTagList(tags: string[]): string {
  return tags.join(", ");
}

function parseTagText(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .split(/\r?\n|,/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!normalized.length) return null;
  return Array.from(new Set(normalized));
}

function normalizeTagList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = normalizeStringArray(value);
    return normalized?.length ? normalized : undefined;
  }
  return parseTagText(value) || undefined;
}

function describeTarget(target: LibraryPaperTarget): string {
  const creatorYear = [target.firstCreator, target.year].filter(Boolean).join(" • ");
  const currentTags = target.tags.length
    ? `Current tags: ${target.tags.join(", ")}`
    : "Current tags: none";
  return [creatorYear, currentTags].filter(Boolean).join("\n");
}

function buildTagTargetDescription(
  target: LibraryPaperTarget,
  suggestion?: {
    reason?: string;
  },
): string {
  const lines = [describeTarget(target)].filter(Boolean);
  if (suggestion?.reason) {
    lines.push(`Why: ${suggestion.reason}`);
  } else {
    lines.push("Edit the suggested tags or leave the row empty to skip it.");
  }
  return lines.join("\n");
}

function normalizeSuggestedAssignments(
  value: unknown,
): ApplyTagsInput["assignments"] {
  if (!Array.isArray(value)) return undefined;
  const normalized: NonNullable<ApplyTagsInput["assignments"]> = [];
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
      tags: normalizeTagList(entry.tags),
      reason,
    });
  }
  return normalized.length ? normalized : undefined;
}

function parseConfirmedAssignments(
  value: unknown,
): BatchTagAssignment[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: BatchTagAssignment[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const itemId = normalizePositiveInt(entry.id ?? entry.itemId);
    if (!itemId || seen.has(itemId)) continue;
    const tags = normalizeTagList(entry.value ?? entry.tags);
    if (!tags?.length) continue;
    seen.add(itemId);
    normalized.push({
      itemId,
      tags,
    });
  }
  return normalized;
}

function buildDirectAssignments(input: ApplyTagsInput): BatchTagAssignment[] {
  if (input.assignments?.length) {
    return input.assignments
      .map((entry) => ({
        itemId: entry.itemId,
        tags: entry.tags || [],
      }))
      .filter((entry) => entry.tags.length > 0);
  }
  if (!input.itemIds?.length || !input.tags?.length) {
    return [];
  }
  return input.itemIds.map((itemId) => ({
    itemId,
    tags: input.tags as string[],
  }));
}

function buildSuggestedAssignmentMap(
  input: ApplyTagsInput,
): Map<
  number,
  {
    tags?: string[];
    reason?: string;
  }
> {
  const out = new Map<
    number,
    {
      tags?: string[];
      reason?: string;
    }
  >();
  for (const assignment of input.assignments || []) {
    out.set(assignment.itemId, {
      tags: assignment.tags,
      reason: assignment.reason,
    });
  }
  if (input.itemIds?.length && input.tags?.length) {
    for (const itemId of input.itemIds) {
      if (out.has(itemId)) continue;
      out.set(itemId, {
        tags: input.tags,
      });
    }
  }
  return out;
}

function resolveCandidateTargets(
  input: ApplyTagsInput,
  context: Parameters<AgentToolDefinition<ApplyTagsInput, unknown>["execute"]>[1],
  zoteroGateway: ZoteroGateway,
): Promise<{
  libraryID: number;
  targets: LibraryPaperTarget[];
}> {
  const libraryID = zoteroGateway.resolveLibraryID({
    request: context.request,
    item: context.item,
    libraryID: input.libraryID,
  });
  if (!libraryID) {
    throw new Error("No active library available for applying tags");
  }
  const assignmentItemIds = input.assignments?.map((entry) => entry.itemId) || [];
  const candidateItemIds = assignmentItemIds.length
    ? assignmentItemIds
    : input.itemIds || [];
  if (candidateItemIds.length) {
    return Promise.resolve({
      libraryID,
      targets: zoteroGateway.getPaperTargetsByItemIds(candidateItemIds),
    });
  }
  return zoteroGateway.listUntaggedPaperTargets({ libraryID }).then((result) => ({
    libraryID,
    targets: result.papers,
  }));
}

export function createApplyTagsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ApplyTagsInput, unknown> {
  return {
    spec: {
      name: "apply_tags",
      description:
        "Append manual tags to one or more Zotero papers after a single user approval. Supports per-paper tag suggestions that the user can review and edit in one confirmation card.",
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
                tags: {
                  anyOf: [
                    {
                      type: "array",
                      items: { type: "string" },
                    },
                    { type: "string" },
                  ],
                },
                reason: { type: "string" },
              },
              required: ["itemId"],
            },
          },
          itemIds: {
            type: "array",
            items: { type: "number" },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isTaggingQuery,
      instruction: [
        "When the user asks to add, apply, or suggest tags for papers, use apply_tags as the write tool.",
        "If the request is broad or about papers without tags, inspect candidates first with list_untagged_papers or other paper read tools, then call apply_tags with per-paper tag assignments so the confirmation card opens with one paper per row and editable suggested tags.",
        "Do not stop after listing candidate papers in chat, and do not ask the user to type the tag choices back in plain text.",
        "If you are unsure about a paper, omit tags for that paper so its row starts empty in the confirmation card.",
      ].join("\n"),
    },
    presentation: {
      label: "Apply Tags",
      summaries: {
        onCall: "Preparing suggested tag updates for papers",
        onPending: "Waiting for your approval on the suggested tag updates",
        onApproved: "Approval received - applying the tags",
        onDenied: "Tag updates cancelled",
        onSuccess: ({ content }) => {
          const updatedCount =
            content && typeof content === "object"
              ? Number((content as { updatedCount?: unknown }).updatedCount || 0)
              : 0;
          return updatedCount > 0
            ? `Applied tags to ${updatedCount} paper${
                updatedCount === 1 ? "" : "s"
              }`
            : "No tag updates were needed";
        },
      },
    },
    validate: (args) => {
      if (args === undefined) {
        return ok<ApplyTagsInput>({});
      }
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      return ok<ApplyTagsInput>({
        assignments: normalizeSuggestedAssignments(args.assignments),
        itemIds: normalizePositiveIntArray(args.itemIds) || undefined,
        tags: normalizeStringArray(args.tags) || undefined,
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    shouldRequireConfirmation: async (input, context) => {
      const { targets } = await resolveCandidateTargets(input, context, zoteroGateway);
      return targets.length > 0;
    },
    createPendingAction: async (input, context) => {
      const { targets } = await resolveCandidateTargets(input, context, zoteroGateway);
      const suggestedAssignments = buildSuggestedAssignmentMap(input);
      const suggestedCount = Array.from(suggestedAssignments.values()).filter(
        (entry) => entry.tags?.length,
      ).length;
      return {
        toolName: "apply_tags",
        title:
          suggestedCount > 0
            ? "Review suggested tags"
            : `Review tag updates for ${targets.length} paper${
                targets.length === 1 ? "" : "s"
              }`,
        description:
          "Each paper has its own editable tag field. Existing tags will stay unchanged. Leave a row empty to skip that paper.",
        confirmLabel: "Apply tags",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "tag_assignment_table",
            id: "assignments",
            label: "Review each paper",
            rows: targets.map((target) => {
              const suggestion = suggestedAssignments.get(target.itemId);
              return {
                id: `${target.itemId}`,
                label: target.title,
                description: buildTagTargetDescription(target, suggestion),
                value: suggestion?.tags?.length
                  ? formatTagList(suggestion.tags)
                  : "",
                placeholder: "tag-one, tag-two",
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
        return fail("Enter tags for at least one paper");
      }
      const resolved: ApplyTagsInput = {
        assignments,
      };
      if (input.libraryID) {
        resolved.libraryID = input.libraryID;
      }
      return ok(resolved);
    },
    execute: async (input, context) => {
      const assignments = buildDirectAssignments(input);
      if (!assignments.length) {
        throw new Error("No tag assignments were selected");
      }
      const result = await zoteroGateway.applyTagAssignments({ assignments });
      const undoItems = result.items
        .filter((item) => item.status === "updated" && item.addedTags.length > 0)
        .map((item) => ({ itemId: item.itemId, addedTags: item.addedTags }));
      if (undoItems.length > 0) {
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-apply-tags-${Date.now()}`,
          toolName: "apply_tags",
          description: `Undo tags applied to ${undoItems.length} paper${undoItems.length === 1 ? "" : "s"}`,
          revert: async () => {
            for (const { itemId, addedTags } of undoItems) {
              await zoteroGateway.removeTagsFromItem({ itemId, tags: addedTags });
            }
          },
        });
      }
      return result;
    },
  };
}
