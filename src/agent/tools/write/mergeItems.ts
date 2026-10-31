/**
 * Tool for merging duplicate Zotero items.
 * Keeps one master item and merges children (attachments, notes, tags,
 * collections, related links) from duplicates into it, then trashes the rest.
 * Several duplicate groups can be merged under one approval; each group is
 * its own merge, with its own receipt.
 */
import {
  LibraryMutationService,
  type MergeItemsOperation,
} from "../../services/libraryMutationService";
import { executeLibraryMutationAction } from "../../services/mutationCoordinator";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentPendingField, AgentWriteToolDefinition } from "../../types";
import { ToolExecutionFailure, ToolInputRejection } from "../execution/failure";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  validateObject,
} from "../shared";
import {
  executeAndRecordUndo,
  normalizeChecklistItemIdsFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const MASTER_INFO_FIELD_ID = "masterInfo";
const DUPLICATES_CHECKLIST_FIELD_ID = "duplicatesChecklist";

const MERGE_EFFECT_TEXT =
  "Attachments, notes, tags and collections move to the master, identical PDFs are deduplicated, and citations in your documents that point at the duplicates are repointed to the master.";
const MERGE_IRREVERSIBLE_TEXT =
  "The duplicates go to the trash, but merging is not fully reversible: restoring them returns records without their attachments, notes or tags.";

type MergeItemsInput = {
  /** One operation per duplicate group, run in this order. */
  operations: MergeItemsOperation[];
};

type MergeGroupOutcome = {
  masterItemId: number;
  otherItemIds: number[];
} & (
  | { status: "merged"; mergedCount: number; trashedIds: number[] }
  | { status: "failed"; error: string; mayHaveApplied?: true }
  | { status: "not_run" }
);

/** A checklist field id: the original id for one group, indexed for several. */
function groupFieldId(base: string, index: number, groupCount: number) {
  return groupCount === 1 ? base : `${base}:${index}`;
}

/**
 * One group from model arguments, or why it is malformed. `label` names the
 * entry of `groups` an error is about; the single-group form has none.
 */
function readGroup(
  value: Record<string, unknown>,
  label?: string,
): { group: MergeItemsOperation } | { error: string } {
  const prefix = label ? `${label}: ` : "";
  const masterItemId = normalizePositiveInt(value.masterItemId);
  if (!masterItemId) {
    return {
      error: `${prefix}masterItemId is required: the item ID to keep as the surviving record`,
    };
  }
  const otherItemIds = normalizePositiveIntArray(value.otherItemIds);
  if (!otherItemIds?.length) {
    return {
      error: `${prefix}otherItemIds must be a non-empty array of item IDs to merge and trash`,
    };
  }
  if (otherItemIds.includes(masterItemId)) {
    return {
      error: `${prefix}item ${masterItemId} is the master, so it cannot also be one of its own duplicates`,
    };
  }
  return { group: { type: "merge_items", masterItemId, otherItemIds } };
}

/** Each merge group's result, read from the coordinated result entry. */
function readMergeResult(entry: unknown): {
  mergedCount: number;
  trashedIds: number[];
} {
  const result =
    entry && typeof entry === "object"
      ? ((entry as { result?: unknown }).result as Record<string, unknown>)
      : undefined;
  return {
    mergedCount: Number(result?.mergedCount) || 0,
    trashedIds: Array.isArray(result?.trashedIds)
      ? (result.trashedIds as unknown[]).map(Number)
      : [],
  };
}

export function createMergeItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<MergeItemsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  const titleOf = (id: number) => {
    const item = zoteroGateway.getItem(id);
    return item
      ? String(item.getField?.("title") || `Item ${id}`)
      : `Item ${id}`;
  };

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: ["merge_items"],
    spec: {
      name: "merge_items",
      description:
        "Merge duplicate Zotero items. Keeps the master item and moves all attachments, notes, tags, and collections from the other items into it, then trashes the duplicates. For several duplicate groups pass groups, so one approval merges them all.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          masterItemId: {
            type: "number",
            description: "The item ID to keep as the surviving master record.",
          },
          otherItemIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Item IDs of duplicates to merge into the master and then trash.",
          },
          groups: {
            type: "array",
            description:
              "Several duplicate groups at once, instead of masterItemId and otherItemIds: one card, one approval, each group merged in turn.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["masterItemId", "otherItemIds"],
              properties: {
                masterItemId: { type: "number" },
                otherItemIds: { type: "array", items: { type: "number" } },
              },
            },
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Merge Items",
      summaries: {
        onCall: "Preparing to merge duplicates",
        onPending: "Waiting for confirmation to merge items",
        onApproved: "Merging items",
        onDenied: "Merge cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            r.result && typeof r.result === "object"
              ? (r.result as Record<string, unknown>)
              : {};
          const count = Number(inner.mergedCount || r.mergedCount || 0);
          return count > 0
            ? `Merged ${count} duplicate${count === 1 ? "" : "s"}`
            : "Items merged";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with masterItemId and otherItemIds, or groups",
        );
      }
      if (args.groups !== undefined) {
        if (
          args.masterItemId !== undefined ||
          args.otherItemIds !== undefined
        ) {
          return fail(
            "Pass either groups or masterItemId with otherItemIds, not both",
          );
        }
        if (!Array.isArray(args.groups) || !args.groups.length) {
          return fail(
            "groups must be a non-empty array of { masterItemId, otherItemIds }",
          );
        }
        const operations: MergeItemsOperation[] = [];
        const seen = new Map<number, number>();
        for (const [index, value] of args.groups.entries()) {
          if (!validateObject<Record<string, unknown>>(value)) {
            return fail(
              `groups[${index}] must be an object with masterItemId and otherItemIds`,
            );
          }
          const read = readGroup(value, `groups[${index}]`);
          if ("error" in read) return fail(read.error);
          for (const itemId of [
            read.group.masterItemId,
            ...read.group.otherItemIds,
          ]) {
            const earlier = seen.get(itemId);
            if (earlier !== undefined) {
              return fail(
                `Item ${itemId} is in more than one group (groups[${earlier}] and groups[${index}]); each item belongs to one group`,
              );
            }
            seen.set(itemId, index);
          }
          operations.push(read.group);
        }
        return ok({ operations });
      }
      const read = readGroup(args);
      if ("error" in read) return fail(read.error);
      return ok({ operations: [read.group] });
    },

    createPendingAction(input) {
      const { operations } = input;
      const groupCount = operations.length;
      const fields: AgentPendingField[] = operations.flatMap(
        (operation, index): AgentPendingField[] => [
          {
            type: "text",
            id: groupFieldId(MASTER_INFO_FIELD_ID, index, groupCount),
            label: "Master (kept)",
            value: titleOf(operation.masterItemId),
          },
          {
            type: "checklist",
            id: groupFieldId(DUPLICATES_CHECKLIST_FIELD_ID, index, groupCount),
            label: "Duplicates to merge & trash",
            items: operation.otherItemIds.map((id) => ({
              id: `${id}`,
              label: titleOf(id),
              checked: true,
            })),
            // With several groups, unchecking every row of one group skips
            // that group; the card is still valid for the others.
            ...(groupCount > 1 ? { requiredForActionIds: [] } : {}),
          },
        ],
      );
      if (groupCount === 1) {
        const [operation] = operations;
        const count = operation.otherItemIds.length;
        return {
          toolName: "merge_items",
          title: `Merge ${count + 1} items`,
          description: `Keep "${titleOf(operation.masterItemId)}" as the master and merge ${count} duplicate${count === 1 ? "" : "s"} into it. ${MERGE_EFFECT_TEXT} ${MERGE_IRREVERSIBLE_TEXT}`,
          confirmLabel: "Merge",
          cancelLabel: "Cancel",
          fields,
        };
      }
      const duplicateCount = operations.reduce(
        (total, operation) => total + operation.otherItemIds.length,
        0,
      );
      return {
        toolName: "merge_items",
        title: `Merge ${groupCount} duplicate groups`,
        description: `Keep each master and merge its duplicates into it: ${duplicateCount} duplicates in ${groupCount} groups. ${MERGE_EFFECT_TEXT} ${MERGE_IRREVERSIBLE_TEXT}`,
        confirmLabel: "Merge",
        cancelLabel: "Cancel",
        fields,
      };
    },

    applyConfirmation(input, resolutionData) {
      const groupCount = input.operations.length;
      const selections = input.operations.map((_operation, index) =>
        normalizeChecklistItemIdsFromResolution(
          resolutionData,
          groupFieldId(DUPLICATES_CHECKLIST_FIELD_ID, index, groupCount),
        ),
      );
      // No resolution — automatic / non-HITL path.
      if (selections.every((selected) => selected === undefined)) {
        return ok(input);
      }
      // Every duplicate unchecked means "merge nothing". The master is not on
      // the checklist, so falling through here would merge and trash the full
      // duplicate list the user just rejected.
      if (selections.every((selected) => !selected?.length)) {
        return fail(
          "No duplicates were left checked, so nothing was merged. Check the duplicates you want merged into the master, or cancel the operation.",
        );
      }
      const operations = input.operations.flatMap((operation, index) => {
        const selected = selections[index];
        // A group the resolution does not mention keeps its duplicates.
        if (selected === undefined) return [operation];
        const chosen = new Set(selected);
        const otherItemIds = operation.otherItemIds.filter((id) =>
          chosen.has(id),
        );
        // A group whose duplicates are all unchecked merges nothing.
        return otherItemIds.length ? [{ ...operation, otherItemIds }] : [];
      });
      if (!operations.length) {
        return fail(
          "The confirmed selection did not match any of the duplicates in this request. Nothing was merged.",
        );
      }
      return ok({ operations });
    },

    planInvocation: (input, context) => {
      // Checked before any card or policy: an item that is gone, not a
      // regular item, already trashed (as a merged duplicate is), or in
      // another library is refused with its id, so a retry of a partly
      // merged batch names exactly what to leave out.
      const refusal = zoteroGateway.mergeRefusal(input.operations);
      if (refusal) throw new ToolInputRejection(refusal);
      return planLibraryMutations(mutationService, input.operations, context);
    },

    async execute(input, context) {
      if (input.operations.length === 1) {
        return executeAndRecordUndo(
          mutationService,
          input.operations[0],
          context,
          "merge_items",
        );
      }
      // One action, one group at a time. A group that fails stops the batch:
      // the groups before it stay merged and keep their receipts, and the
      // rest are reported as not run so a retry names only those.
      const coordinated = await executeLibraryMutationAction({
        service: mutationService,
        operations: input.operations,
        context,
        facadeToolName: "merge_items",
        reportFailure: true,
      });
      const failure = coordinated.failure;
      const groups: MergeGroupOutcome[] = input.operations.map(
        (operation, index): MergeGroupOutcome => {
          const ids = {
            masterItemId: operation.masterItemId,
            otherItemIds: operation.otherItemIds,
          };
          if (!failure || index < failure.index) {
            return {
              ...ids,
              status: "merged",
              ...readMergeResult(coordinated.results[index]),
            };
          }
          if (index === failure.index) {
            return {
              ...ids,
              status: "failed",
              error: failure.message,
              ...(failure.uncertain ? { mayHaveApplied: true as const } : {}),
            };
          }
          return { ...ids, status: "not_run" };
        },
      );
      const merged = groups.filter((group) => group.status === "merged");
      const mergedCount = merged.reduce(
        (total, group) =>
          total + (group.status === "merged" ? group.mergedCount : 0),
        0,
      );
      const remainingGroups = groups
        .filter((group) => group.status !== "merged")
        .map(({ masterItemId, otherItemIds }) => ({
          masterItemId,
          otherItemIds,
        }));
      const content = {
        actionId: coordinated.actionId,
        mergedGroupCount: merged.length,
        mergedCount,
        groups,
        ...(failure
          ? {
              remainingGroups,
              nextStep: `${merged.length} of ${groups.length} groups merged. Group ${failure.index + 1} failed: ${failure.message}${
                failure.uncertain
                  ? " It may have partly applied; read its items before retrying."
                  : ""
              } To finish, merge only remainingGroups after fixing or dropping the failed group; merged groups are already done.`,
            }
          : {}),
      };
      if (failure && !merged.length) {
        throw new ToolExecutionFailure(failure.message, content);
      }
      return {
        content,
        effect: failure ? "partial" : coordinated.effect,
        actionEvidence: coordinated.actionEvidence,
      };
    },
  };
}
