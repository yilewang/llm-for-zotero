/**
 * The annotation delegate of library_update (kind:'annotation'): edit an
 * annotation's comment or color. Creating an annotation is annotate_pdf, and
 * deleting one is library_delete. Not registered on its own.
 */
import type { AgentWriteToolDefinition } from "../../types";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import {
  LibraryMutationService,
  type UpdateAnnotationOperation,
} from "../../services/libraryMutationService";
import { resolveHighlightColor } from "../../services/pdfAnnotationGeometry";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type AnnotationUpdateInput = { operation: UpdateAnnotationOperation };

const EXCERPT_LENGTH = 120;

function excerpt(text: string): string {
  return text.length > EXCERPT_LENGTH
    ? `${text.slice(0, EXCERPT_LENGTH - 1)}…`
    : text;
}

export function createAnnotationUpdateTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<AnnotationUpdateInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: ["update_annotation"],
    spec: {
      name: "annotation_update",
      description: "Edit a PDF annotation's comment or color.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotationId"],
        properties: {
          annotationId: {
            type: "number",
            description: "The annotation's item ID.",
          },
          comment: {
            type: "string",
            description: "The new comment; an empty string clears it.",
          },
          color: {
            type: "string",
            description:
              "A Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a hex like '#ff6666'.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Edit Annotation",
      summaries: {
        onCall: "Preparing an annotation edit",
        onPending: "Waiting for confirmation on an annotation edit",
        onApproved: "Editing the annotation",
        onDenied: "Annotation edit cancelled",
        onSuccess: ({ effect }) =>
          effect === "none" ? "Annotation unchanged" : "Annotation edited",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args))
        return fail("Expected an object with annotationId.");
      const annotationId = normalizePositiveInt(args.annotationId);
      if (!annotationId)
        return fail(
          "annotationId is required: the annotation's item ID, from library_read with sections:['annotations'].",
        );
      if (args.comment !== undefined && typeof args.comment !== "string")
        return fail("comment must be a string.");
      const comment =
        typeof args.comment === "string"
          ? args.comment.trim().normalize()
          : undefined;
      let color: string | undefined;
      if (args.color !== undefined) {
        color = resolveHighlightColor(args.color) || undefined;
        if (!color)
          return fail(
            "color must be a Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a hex like '#ff6666'.",
          );
      }
      if (comment === undefined && color === undefined)
        return fail("Give comment or color, the fields to edit.");
      const operation: UpdateAnnotationOperation = {
        type: "update_annotation",
        annotationId,
        ...(comment === undefined ? {} : { comment }),
        ...(color === undefined ? {} : { color }),
      };
      return ok({ operation });
    },

    createPendingAction(input) {
      const { operation } = input;
      const annotation = zoteroGateway.getItem(operation.annotationId);
      const type = String(annotation?.annotationType || "annotation");
      const page = String(annotation?.annotationPageLabel || "");
      const text = String(annotation?.annotationText || "");
      return {
        toolName: "annotation_update",
        title: "Edit annotation",
        description: `Edit the ${type}${page ? ` on page ${page}` : ""}${
          text ? `: "${excerpt(text)}"` : ""
        }. This can be undone.`,
        confirmLabel: "Save",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "review_table" as const,
            id: `annotationReview:${operation.annotationId}`,
            rows: [
              ...(operation.comment === undefined
                ? []
                : [
                    {
                      key: "comment",
                      label: "Comment",
                      before: String(annotation?.annotationComment || ""),
                      after: operation.comment,
                      multiline: true,
                    },
                  ]),
              ...(operation.color === undefined
                ? []
                : [
                    {
                      key: "color",
                      label: "Color",
                      before: String(annotation?.annotationColor || ""),
                      after: operation.color,
                    },
                  ]),
            ],
          },
        ],
      };
    },

    // review_table is read-only; the approved values are the planned ones.
    applyConfirmation: (input) => ok(input),

    planInvocation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    execute: (input, context) =>
      executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "annotation_update",
      ),
  };
}
