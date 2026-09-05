/**
 * Focused facade tool for updating metadata fields on one or more Zotero items.
 *
 * Supports two input modes:
 * - Single item: `{ itemId?, metadata: {...} }` — used by the LLM directly
 * - Batch: `{ operations: [{ itemId, metadata, paperContext? }, ...] }` — used
 *   internally by review cards
 */
import type { PaperContextRef } from "../../../shared/types";
import type { AgentWriteToolDefinition } from "../../types";
import {
  buildPagedReviewActionConfig,
  buildPageSizeSelectField,
  readPagedOperationLabel,
  readPagedOperationMeta,
} from "../../actions/pagedWorkflow";
import {
  LibraryMutationService,
  type UpdateMetadataOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import {
  ok,
  fail,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
  normalizePositiveInt,
  normalizeToolPaperContext,
} from "../shared";
import {
  buildUpdateMetadataReviewField,
  executeAndRecordUndo,
  executeAndRecordUndoBatch,
  normalizeMetadataPatch,
  planLibraryMutations,
} from "./mutateLibraryShared";

type UpdateMetadataInput = {
  operations: UpdateMetadataOperation[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(fix|correct|update|enrich|complete|sync)\b.*\b(metadata|fields?|title|authors?|doi|year|date|abstract)\b/i.test(
          request.userText,
        ),
      instruction:
        "When the user asks to fix, correct, or enrich metadata from external sources, " +
        "use literature_search with workflow:'review' and mode:'metadata' first to fetch canonical data, " +
        "then let the review card handle the update. " +
        "Only call update_metadata directly when the user provides specific field values to set " +
        "(e.g. 'change the title to XYZ').",
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
          "metadata must be an object with at least one recognized field. " +
            "Example: { metadata: { title: 'Updated Title', DOI: '10.1234/example' } } " +
            "Supported fields: " +
            EDITABLE_ARTICLE_METADATA_FIELDS.join(", ") +
            ", creators.",
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
      const isBatch = input.operations.length > 1;
      const pageMeta = readPagedOperationMeta(input.operations[0]?.id);
      const pageLabel = readPagedOperationLabel(input.operations[0]?.id);
      const reviewFields = input.operations
        .map((operation) => {
          const item = zoteroGateway.resolveMetadataItem({
            itemId: operation.itemId,
            paperContext: operation.paperContext,
            request: context.request,
            item: context.item,
          });
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
        })
        .filter((f): f is NonNullable<typeof f> => Boolean(f));

      const title = isBatch
        ? `${pageLabel ? `${pageLabel}: ` : ""}${pageLabel ? "Fix" : "Update"} metadata for ${input.operations.length} items`
        : `${pageLabel ? `${pageLabel}: ` : ""}${pageLabel ? "Fix" : "Update"} metadata for ${(() => {
            const op = input.operations[0];
            const item = zoteroGateway.resolveMetadataItem({
              itemId: op.itemId,
              paperContext: op.paperContext,
              request: context.request,
              item: context.item,
            });
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

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, input.operations, context),

    async execute(input, context) {
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
