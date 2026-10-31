/**
 * Focused facade tool for updating metadata fields on one or more Zotero items.
 *
 * Supports two input modes:
 * - Single item: `{ itemId?, metadata: {...} }` — used by the LLM directly
 * - Batch: `{ operations: [{ itemId, metadata, paperContext? }, ...] }` — used
 *   internally by review cards
 */
import type { PaperContextRef } from "../../../shared/types";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import type { AgentWriteToolDefinition } from "../../types";
import {
  buildPagedReviewActionConfig,
  buildPageSizeSelectField,
  readPagedOperationLabel,
  readPagedOperationMeta,
} from "../../actions/pagedWorkflow";
import {
  LibraryMutationService,
  type ChangeItemTypeOperation,
  type UpdateMetadataOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  ok,
  fail,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
  normalizePositiveInt,
  normalizeToolPaperContext,
} from "../shared";
import {
  buildItemTypeChangeReviewField,
  buildUpdateMetadataReviewField,
  executeAndRecordUndo,
  executeAndRecordUndoBatch,
  normalizeMetadataPatch,
  planLibraryMutations,
  prepareItemTypeChange,
  resolveMetadataWriteItem,
} from "./mutateLibraryShared";

type UpdateMetadataInput = {
  operations: UpdateMetadataOperation[] | [ChangeItemTypeOperation];
};

function itemTypeChangeOf(
  input: UpdateMetadataInput,
): ChangeItemTypeOperation | undefined {
  const [operation] = input.operations;
  return operation?.type === "change_item_type" ? operation : undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ITEM_TYPE_ROUTE =
  "To change the item type, call library_update({ kind:'metadata', itemId, itemType:'<type>' }) without metadata, then set the new type's fields in a second call.";

/** Whether a patch, or the .fields it flattens, carries itemType. */
function patchHasItemType(patch: unknown): boolean {
  if (!validateObject<Record<string, unknown>>(patch)) return false;
  return (
    patch.itemType !== undefined ||
    (validateObject<Record<string, unknown>>(patch.fields) &&
      patch.fields.itemType !== undefined)
  );
}

/**
 * Whether a metadata patch carries itemType: in metadata or patch, or in
 * the .fields object `normalizeMetadataPatch` flattens into either.
 */
function hasNestedItemType(value: Record<string, unknown>): boolean {
  return [value.metadata, value.patch].some(patchHasItemType);
}

function normalizeOperationEntry(
  value: unknown,
  index: number,
): UpdateMetadataOperation | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const metadata =
    normalizeMetadataPatch(value.metadata) ||
    normalizeMetadataPatch(value.patch) ||
    normalizeMetadataPatch(value);
  if (!metadata) return null;
  const paperContext = validateObject<Record<string, unknown>>(
    value.paperContext,
  )
    ? (normalizeToolPaperContext(
        value.paperContext as Record<string, unknown>,
      ) as PaperContextRef | undefined) || undefined
    : undefined;
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : `op-${index + 1}`,
    type: "update_metadata",
    itemId: normalizePositiveInt(value.itemId),
    paperContext,
    metadata,
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createUpdateMetadataTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<UpdateMetadataInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: ["update_metadata", "change_item_type"],
    spec: {
      name: "update_metadata",
      description:
        "Update metadata fields (title, authors, DOI, etc.) on a Zotero item.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: {
            type: "number",
            description: "Zotero item ID. If omitted, targets the active item.",
          },
          paperContext: PAPER_CONTEXT_REF_SCHEMA,
          metadata: {
            type: "object",
            additionalProperties: true,
            properties: {
              title: { type: "string" },
              shortTitle: { type: "string" },
              abstractNote: { type: "string" },
              publicationTitle: { type: "string" },
              journalAbbreviation: { type: "string" },
              proceedingsTitle: { type: "string" },
              date: { type: "string" },
              volume: { type: "string" },
              issue: { type: "string" },
              pages: { type: "string" },
              DOI: { type: "string" },
              url: { type: "string" },
              language: { type: "string" },
              extra: { type: "string" },
              ISSN: { type: "string" },
              ISBN: { type: "string" },
              publisher: { type: "string" },
              place: { type: "string" },
              creators: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    firstName: { type: "string" },
                    lastName: { type: "string" },
                    name: { type: "string" },
                    creatorType: { type: "string" },
                  },
                  additionalProperties: false,
                },
                description:
                  "Author list. Use 'creators' not 'authors'. Each needs firstName+lastName or name. creatorType defaults to 'author'.",
              },
            },
            description:
              "Metadata fields to update. At least one field must be provided.",
          },
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                itemId: { type: "number" },
                paperContext: PAPER_CONTEXT_REF_SCHEMA,
                metadata: {
                  type: "object",
                  additionalProperties: true,
                  description: "Metadata fields to update.",
                },
                patch: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Deprecated alias for metadata in batch operations.",
                },
              },
            },
            description:
              "Batch metadata operations. Each entry accepts itemId, paperContext, and metadata.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Update Metadata",
      summaries: {
        onCall: "Preparing metadata update",
        onPending: "Waiting for confirmation on metadata changes",
        onApproved: "Applying metadata changes",
        onDenied: "Metadata update cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const count = Number(result.appliedCount || 1);
          return count > 1
            ? `Updated metadata for ${count} items`
            : "Metadata updated";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with metadata. Example: { metadata: { title: 'New Title' } }",
        );
      }

      // A type change stands alone: the new type's fields are set after it.
      if (args.itemType !== undefined) {
        const itemType =
          typeof args.itemType === "string" ? args.itemType.trim() : "";
        const itemId = normalizePositiveInt(args.itemId);
        if (
          !itemType ||
          !itemId ||
          args.metadata !== undefined ||
          args.operations !== undefined
        )
          return fail(
            "itemType needs exactly one itemId and no metadata. Change the type first, then set the new type's fields in a second call.",
          );
        return ok({
          operations: [{ type: "change_item_type", itemId, itemType }],
        });
      }

      // The type is not a metadata field: one route changes it, and the
      // model is told that route instead of having a second spelling of it.
      if (
        hasNestedItemType(args) ||
        (Array.isArray(args.operations) &&
          args.operations.some(
            (entry) =>
              validateObject<Record<string, unknown>>(entry) &&
              // An entry is itself a patch when it names no metadata.
              (patchHasItemType(entry) || hasNestedItemType(entry)),
          ))
      ) {
        return fail(ITEM_TYPE_ROUTE);
      }

      // Batch mode: { operations: [...] }
      if (
        Object.prototype.hasOwnProperty.call(args, "operations") &&
        !Array.isArray(args.operations)
      ) {
        return fail(
          "operations must be an array of metadata updates. Example: { operations: [{ itemId: 123, metadata: { title: 'New Title' } }] }",
        );
      }
      if (Array.isArray(args.operations)) {
        const operations = args.operations
          .map((entry, index) => normalizeOperationEntry(entry, index))
          .filter((entry): entry is UpdateMetadataOperation => Boolean(entry));
        if (!operations.length) {
          return fail(
            "operations must contain at least one entry with valid metadata fields.",
          );
        }
        return ok({ operations });
      }

      // Single mode: { itemId?, metadata: {...} }
      const metadata = normalizeMetadataPatch(args.metadata);
      if (!metadata) {
        return fail(
          "metadata must be an object with at least one field. " +
            "Example: { metadata: { title: 'Updated Title', DOI: '10.1234/example' } } " +
            "Any Zotero field the item's type has can be set (for a book, " +
            "e.g. edition, series, numPages), plus creators; library_search with " +
            "entity:'itemTypes' lists the fields of a type.",
        );
      }

      const paperContext = validateObject<Record<string, unknown>>(
        args.paperContext,
      )
        ? (normalizeToolPaperContext(
            args.paperContext as Record<string, unknown>,
          ) as PaperContextRef | undefined) || undefined
        : undefined;
      const operation: UpdateMetadataOperation = {
        type: "update_metadata",
        itemId: normalizePositiveInt(args.itemId),
        paperContext,
        metadata,
      };

      return ok({ operations: [operation] });
    },

    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from literature_search review cards.
      return (
        approval.sourceMode === "review" &&
        (approval.sourceActionId === "apply_direct" ||
          approval.sourceActionId === "review_changes")
      );
    },

    createPendingAction(input, context) {
      const typeChange = itemTypeChangeOf(input);
      if (typeChange) {
        const field = buildItemTypeChangeReviewField(typeChange, zoteroGateway);
        const item = zoteroGateway.getItem(typeChange.itemId);
        const dropped = field.rows.slice(1).map((row) => row.label);
        return {
          toolName: "update_metadata",
          mode: "review",
          title: `Change item type for ${
            zoteroGateway.getEditableArticleMetadata(item)?.title ||
            `Item ${typeChange.itemId}`
          }`,
          description: dropped.length
            ? `Changing the type drops ${dropped.length} field${dropped.length === 1 ? "" : "s"}: ${dropped.join(", ")}. Undo restores them.`
            : "Changing the type drops no fields.",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [field],
        };
      }
      const operations = input.operations as UpdateMetadataOperation[];
      const isBatch = operations.length > 1;
      const pageMeta = readPagedOperationMeta(operations[0]?.id);
      const pageLabel = readPagedOperationLabel(operations[0]?.id);
      const reviewFields = operations.map((operation) => {
        const item = resolveMetadataWriteItem(
          operation,
          zoteroGateway,
          context,
        );
        const title =
          zoteroGateway.getEditableArticleMetadata(item)?.title ||
          operation.paperContext?.title ||
          `Item ${operation.itemId ?? "active item"}`;
        return buildUpdateMetadataReviewField(
          operation,
          zoteroGateway,
          context,
          title,
          isBatch,
        );
      });

      const title = isBatch
        ? `${pageLabel ? `${pageLabel}: ` : ""}${pageLabel ? "Fix" : "Update"} metadata for ${operations.length} items`
        : `${pageLabel ? `${pageLabel}: ` : ""}${pageLabel ? "Fix" : "Update"} metadata for ${(() => {
            const op = operations[0];
            const item = resolveMetadataWriteItem(op, zoteroGateway, context);
            return (
              zoteroGateway.getEditableArticleMetadata(item)?.title ||
              op.paperContext?.title ||
              `Item ${op.itemId ?? "active item"}`
            );
          })()}`;

      return {
        toolName: "update_metadata",
        mode: "review",
        title,
        description: isBatch
          ? "Review the proposed metadata changes below."
          : "Review the proposed field changes below.",
        confirmLabel: "Apply",
        cancelLabel: pageLabel ? "Stop" : "Cancel",
        fields: [
          ...reviewFields,
          ...(pageMeta ? [buildPageSizeSelectField(pageMeta.pageSize)] : []),
        ],
        ...(pageMeta
          ? buildPagedReviewActionConfig(pageMeta, { includeRefresh: true })
          : {}),
      };
    },

    applyConfirmation(input, _resolutionData) {
      // review_table is read-only; pass through unchanged
      return ok(input);
    },

    planInvocation: (input, context) => {
      const typeChange = itemTypeChangeOf(input);
      if (typeChange) prepareItemTypeChange(typeChange, zoteroGateway);
      return planLibraryMutations(mutationService, input.operations, context);
    },

    async execute(input, context) {
      const typeChange = itemTypeChangeOf(input);
      if (typeChange) prepareItemTypeChange(typeChange, zoteroGateway);
      if (input.operations.length === 1) {
        return executeAndRecordUndo(
          mutationService,
          input.operations[0],
          context,
          "update_metadata",
        );
      }
      return executeAndRecordUndoBatch(
        mutationService,
        input.operations,
        context,
        "update_metadata",
      );
    },
  };
}
