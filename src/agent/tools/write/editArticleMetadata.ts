import type { PaperContextRef } from "../../../modules/contextPanel/types";
import type { AgentToolDefinition } from "../../types";
import type {
  EditableArticleCreator,
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import { pushUndoEntry } from "../../store/undoStore";

type EditArticleMetadataInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
  metadata: EditableArticleMetadataPatch;
};

type RawMetadataContainer = Record<string, unknown>;

function buildMetadataFieldSchemaProperties(): Record<string, unknown> {
  return Object.fromEntries(
    EDITABLE_ARTICLE_METADATA_FIELDS.map((fieldName) => [
      fieldName,
      { type: ["string", "number", "boolean"] },
    ]),
  );
}

function normalizeStringMetadataValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return null;
}

function normalizeCreator(
  value: unknown,
): EditableArticleCreator | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const creatorType =
    typeof value.creatorType === "string" && value.creatorType.trim()
      ? value.creatorType.trim()
      : "author";
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : undefined;
  const firstName =
    typeof value.firstName === "string" && value.firstName.trim()
      ? value.firstName.trim()
      : undefined;
  const lastName =
    typeof value.lastName === "string" && value.lastName.trim()
      ? value.lastName.trim()
      : undefined;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode: name ? 1 : 0,
  };
}

function normalizeMetadataPatch(
  value: unknown,
): EditableArticleMetadataPatch | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const metadata: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, fieldName)) continue;
    const normalized = normalizeStringMetadataValue(value[fieldName]);
    if (normalized === null) return null;
    metadata[fieldName as EditableArticleMetadataField] = normalized;
  }
  if (Object.prototype.hasOwnProperty.call(value, "creators")) {
    if (!Array.isArray(value.creators)) return null;
    const creators = value.creators
      .map((entry) => normalizeCreator(entry))
      .filter((entry): entry is EditableArticleCreator => Boolean(entry));
    metadata.creators = creators;
  }
  const hasFields = Object.keys(metadata).length > 0;
  return hasFields ? metadata : null;
}

function parseMetadataContainer(value: unknown): EditableArticleMetadataPatch | null {
  if (typeof value === "string" && value.trim()) {
    try {
      return normalizeMetadataPatch(JSON.parse(value));
    } catch (_error) {
      return null;
    }
  }
  return normalizeMetadataPatch(value);
}

function extractMetadataPatchFromArgs(
  args: RawMetadataContainer,
): EditableArticleMetadataPatch | null {
  const containers: unknown[] = [
    args.metadata,
    args.fields,
    args.changes,
    args.updates,
    args.patch,
    args.suggestedPatch,
  ];
  for (const container of containers) {
    const parsed = parseMetadataContainer(container);
    if (parsed) return parsed;
  }

  const topLevelCandidate: Record<string, unknown> = {};
  let hasTopLevelMetadata = false;
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(args, fieldName)) continue;
    topLevelCandidate[fieldName] = args[fieldName];
    hasTopLevelMetadata = true;
  }
  if (Object.prototype.hasOwnProperty.call(args, "creators")) {
    topLevelCandidate.creators = args.creators;
    hasTopLevelMetadata = true;
  }
  return hasTopLevelMetadata ? normalizeMetadataPatch(topLevelCandidate) : null;
}

function formatMetadataPatch(
  metadata: EditableArticleMetadataPatch,
): string {
  return JSON.stringify(metadata, null, 2);
}

function truncateTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 72) return trimmed;
  return `${trimmed.slice(0, 69).trimEnd()}...`;
}

function formatFieldLabel(fieldName: string): string {
  switch (fieldName) {
    case "abstractNote":
      return "Abstract";
    case "publicationTitle":
      return "Publication title";
    case "journalAbbreviation":
      return "Journal abbreviation";
    case "proceedingsTitle":
      return "Proceedings title";
    case "shortTitle":
      return "Short title";
    default:
      return fieldName
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\bdoi\b/gi, "DOI")
        .replace(/\bissn\b/gi, "ISSN")
        .replace(/\bisbn\b/gi, "ISBN")
        .replace(/^./, (char) => char.toUpperCase());
  }
}

function formatCreatorList(creators: EditableArticleCreator[] | undefined): string {
  if (!Array.isArray(creators) || !creators.length) return "";
  return creators
    .map((creator) => {
      const name =
        creator.fieldMode === 1 || creator.name
          ? creator.name || ""
          : [creator.firstName || "", creator.lastName || ""]
              .filter(Boolean)
              .join(" ")
              .trim();
      const creatorType = creator.creatorType?.trim() || "author";
      return name ? `${name} (${creatorType})` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createEditArticleMetadataTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<EditArticleMetadataInput, unknown> {
  const metadataFieldSchemaProperties = buildMetadataFieldSchemaProperties();
  return {
    spec: {
      name: "edit_article_metadata",
      description:
        "Edit or complete bibliographic metadata for a single Zotero article after user confirmation. Pass the proposed changes either in metadata, fields, changes, updates, patch, suggestedPatch, or as top-level metadata fields. Supports common fields such as title, abstractNote, publicationTitle, date, DOI, url, pages, volume, issue, extra, and creators.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "integer" },
          paperContext: {
            type: "object",
            additionalProperties: true,
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
          fields: {
            type: "object",
            additionalProperties: true,
          },
          changes: {
            type: "object",
            additionalProperties: true,
          },
          updates: {
            type: "object",
            additionalProperties: true,
          },
          patch: {
            type: "object",
            additionalProperties: true,
          },
          suggestedPatch: {
            type: "object",
            additionalProperties: true,
          },
          creators: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
            },
          },
          ...metadataFieldSchemaProperties,
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Edit Metadata",
      summaries: {
        onCall: "Preparing metadata updates for the article",
        onPending:
          "Waiting for your approval before applying the metadata changes",
        onApproved: "Approval received - applying the metadata changes",
        onDenied: "Metadata changes cancelled",
        onSuccess: ({ content }) => {
          const changedFields =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { changedFields?: unknown }).changedFields)
              ? (content as { changedFields: unknown[] }).changedFields
              : [];
          return changedFields.length > 0
            ? `Applied ${changedFields.length} metadata change${
                changedFields.length === 1 ? "" : "s"
              }`
            : "Applied the metadata changes";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const metadata = extractMetadataPatchFromArgs(args);
      if (!metadata) {
        return fail(
          "metadata must include at least one supported field in metadata, fields, changes, updates, patch, suggestedPatch, or top-level field form",
        );
      }
      let paperContext: PaperContextRef | undefined;
      if (validateObject<Record<string, unknown>>(args.paperContext)) {
        paperContext = normalizeToolPaperContext(args.paperContext) || undefined;
      }
      const itemId = normalizePositiveInt(args.itemId);
      return ok({
        itemId,
        paperContext,
        metadata,
      });
    },
    createPendingAction: (input, context) => {
      const targetItem = zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: input.itemId,
        paperContext: input.paperContext,
      });
      const currentMetadata = zoteroGateway.getEditableArticleMetadata(targetItem);
      const targetLabel =
        truncateTitle(
          input.paperContext?.title ||
            currentMetadata?.title ||
            "",
        ) || "the selected article";
      const reviewItems = [
        ...Object.entries(input.metadata)
          .filter(([fieldName]) => fieldName !== "creators")
          .map(([fieldName, value]) => ({
            key: fieldName,
            label: formatFieldLabel(fieldName),
            before:
              currentMetadata?.fields[
                fieldName as EditableArticleMetadataField
              ] || "",
            after: `${value ?? ""}`.trim(),
            multiline:
              fieldName === "abstractNote" ||
              fieldName === "extra" ||
              `${value ?? ""}`.includes("\n"),
          })),
        ...(Array.isArray(input.metadata.creators)
          ? [
              {
                key: "creators",
                label: "Creators",
                before: formatCreatorList(currentMetadata?.creators),
                after: formatCreatorList(input.metadata.creators),
                multiline: true,
              },
            ]
          : []),
      ];
      return {
        toolName: "edit_article_metadata",
        title: `Review metadata updates for ${targetLabel}`,
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "review_table",
            id: "review",
            rows: reviewItems,
          },
          {
            type: "textarea",
            id: "content",
            label: "Metadata updates",
            value: formatMetadataPatch(input.metadata),
            editorMode: "json",
            spellcheck: false,
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      if (
        Object.prototype.hasOwnProperty.call(resolutionData, "content") &&
        typeof resolutionData.content === "string"
      ) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(resolutionData.content);
        } catch (_error) {
          return fail("content must be valid JSON");
        }
        const metadata = normalizeMetadataPatch(parsed);
        if (!metadata) {
          return fail("content must contain at least one supported metadata field");
        }
        return ok({
          ...input,
          metadata,
        });
      }
      return ok(input);
    },
    execute: async (input, context) => {
      const targetItem = zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: input.itemId,
        paperContext: input.paperContext,
      });
      const previousSnapshot = zoteroGateway.getEditableArticleMetadata(targetItem);
      const result = await zoteroGateway.updateArticleMetadata({
        item: targetItem,
        metadata: input.metadata,
      });
      if (previousSnapshot) {
        const { itemId, fields, creators } = previousSnapshot;
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-edit-metadata-${Date.now()}`,
          toolName: "edit_article_metadata",
          description: `Undo metadata edit for "${previousSnapshot.title}"`,
          revert: async () => {
            const item = zoteroGateway.getItem(itemId);
            if (!item) return;
            await zoteroGateway.updateArticleMetadata({
              item,
              metadata: { ...fields, creators },
            });
          },
        });
      }
      return result;
    },
  };
}
