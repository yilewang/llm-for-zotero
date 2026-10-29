import type { AgentWriteToolDefinition } from "../../types";
import { stateChangeInvocationPlan } from "../../authorization/invocationPlan";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { resolveHighlightColor } from "../../services/pdfAnnotationGeometry";
import { resolvePdfHighlight } from "../../../services/pdf/pdfAnnotationResolver";
import {
  annotationMatchesPayload,
  type PdfHighlightPayload,
} from "../../../services/pdf/pdfAnnotationState";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type AnnotateInput = {
  attachmentId: number;
  text: string;
  pageIndex?: number;
  occurrence?: number;
  color: string;
  comment: string;
};

/** The model chooses a passage; native PDF text determines its placement. */
export function createAnnotatePdfTool(
  zoteroGateway: ZoteroGateway,
  resolveHighlight = resolvePdfHighlight,
): AgentWriteToolDefinition<AnnotateInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  return {
    describeAction: (input) => [
      {
        id: `annotation_write:${input.attachmentId}:${input.pageIndex}`,
        proofDomain: "zotero_state",
        capability: "zotero.annotations",
        operation: "annotation_write",
        source: "zotero_native",
        parameters: {
          targetItemId: input.attachmentId,
          pageIndex: input.pageIndex,
          expectedText: input.text,
          annotationComment: input.comment,
          annotationColor: input.color,
        },
        requestedTargets: [`item:${input.attachmentId}`],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["annotation_write"],
    spec: {
      name: "annotate_pdf",
      description:
        "Highlight an exact quoted passage in a PDF attachment and optionally add a comment. Zotero locates the text and computes the highlight. Supply text from paper_read; no coordinates, scripts, or external PDF utilities are needed. For multiple matches specify pageIndex and occurrence. If native text is unavailable, report the limitation instead of estimating coordinates or using scripts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "text"],
        properties: {
          attachmentId: {
            type: "number",
            description:
              "The PDF attachment item ID. Not the parent paper — annotations belong to the attachment.",
          },
          pageIndex: {
            type: "number",
            description:
              "Optional zero-based page index restricting the search to that page.",
          },
          occurrence: {
            type: "number",
            description:
              "One-based occurrence on the specified page, only to disambiguate repeated text. Requires pageIndex.",
          },
          color: {
            type: "string",
            description:
              "A Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a lowercase hex like '#ff6666'. Default yellow.",
          },
          text: {
            type: "string",
            description:
              "The complete exact passage to highlight, quoted from the attachment. Line wrapping and PDF hyphenation are handled internally.",
          },
          comment: {
            type: "string",
            description: "A note attached to the highlight.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Annotate PDF",
      traceIcon: "edit",
      summaries: {
        onCall: "Preparing a PDF highlight",
        onPending: "Waiting for confirmation on a PDF highlight",
        onApproved: "Adding the highlight",
        onDenied: "Highlight cancelled",
        onSuccess: "Added a highlight",
      },
    },

    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object describing the highlight.");
      }
      const attachmentId = normalizePositiveInt(args.attachmentId);
      if (!attachmentId) {
        return fail(
          "attachmentId is required and must be the PDF attachment's item ID, not the parent paper's.",
        );
      }
      const text = readString(args.text);
      if (!text)
        return fail("text must be the complete quoted passage to highlight.");
      if (
        Object.keys(args).some(
          (key) =>
            ![
              "attachmentId",
              "text",
              "comment",
              "color",
              "pageIndex",
              "occurrence",
            ].includes(key),
        )
      ) {
        return fail(
          "Supply attachmentId and text, with optional comment, color, pageIndex and occurrence. Zotero computes the coordinates; do not supply rects or page dimensions.",
        );
      }
      const pageIndex =
        args.pageIndex === undefined ? undefined : Number(args.pageIndex);
      if (
        pageIndex !== undefined &&
        (!Number.isInteger(pageIndex) || pageIndex < 0)
      )
        return fail("pageIndex must be a zero-based integer page number.");
      const occurrence =
        args.occurrence === undefined ? undefined : Number(args.occurrence);
      if (
        occurrence !== undefined &&
        (pageIndex === undefined ||
          !Number.isInteger(occurrence) ||
          occurrence < 1)
      )
        return fail(
          "occurrence must be a one-based integer and requires pageIndex.",
        );
      const color = resolveHighlightColor(args.color ?? "yellow");
      if (!color) {
        return fail(
          "color must be a Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a hex like '#ff6666'.",
        );
      }
      return ok({
        attachmentId,
        pageIndex,
        occurrence,
        color,
        text,
        comment: readString(args.comment) || "",
      });
    },

    createPendingAction(input) {
      const summary = `Highlight${input.comment ? " and comment" : ""}${input.pageIndex === undefined ? " in the PDF" : ` on page ${input.pageIndex + 1}`}`;
      return {
        toolName: "annotate_pdf",
        title: "Add a PDF highlight",
        description: summary,
        confirmLabel: "Add highlight",
        cancelLabel: "Cancel",
        fields: [
          ...(input.text
            ? [
                {
                  type: "text" as const,
                  id: "text",
                  label: "Highlighted text",
                  value: input.text,
                },
              ]
            : []),
          ...(input.comment
            ? [
                {
                  type: "textarea" as const,
                  id: "comment",
                  label: "Comment",
                  value: input.comment,
                },
              ]
            : []),
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      // The comment is editable, so an edit must reach the annotation.
      const data =
        resolutionData && typeof resolutionData === "object"
          ? (resolutionData as Record<string, unknown>)
          : undefined;
      const edited =
        data && typeof data.comment === "string" ? data.comment : undefined;
      const text =
        data?.text === undefined ? input.text : readString(data.text);
      if (!text) return fail("The highlighted quotation cannot be empty.");
      return ok({
        ...input,
        text,
        comment: edited === undefined ? input.comment : edited.trim(),
      });
    },

    planInvocation() {
      return stateChangeInvocationPlan({
        effects: ["create"],
        reversibility: "partial",
        reason:
          "The annotation ID needed by the inverse is assigned only after Zotero commits.",
      });
    },

    async execute(input, context) {
      const attachment = zoteroGateway.getItem(input.attachmentId);
      if (!attachment?.isAttachment?.() || !attachment.isPDFAttachment?.()) {
        throw new Error(
          `Item ${input.attachmentId} is not a PDF attachment. Use library_read with sections:['attachments'] to find the PDF attachment ID.`,
        );
      }
      const resolved = await resolveHighlight(input, context.signal);
      if (context.signal?.aborted)
        throw new Error("Annotation creation was cancelled.");
      const expectedAnnotation: PdfHighlightPayload = {
        ...resolved,
        color: input.color,
        comment: input.comment,
      };
      const existing = attachment
        .getAnnotations()
        .find((item) =>
          annotationMatchesPayload(
            item,
            input.attachmentId,
            expectedAnnotation,
          ),
        );
      if (existing)
        return {
          content: {
            annotationId: existing.id,
            attachmentId: input.attachmentId,
            pageIndex: resolved.position.pageIndex,
            status: "already_exists",
            expectedAnnotation,
          },
          effect: "none" as const,
        };
      const json: Record<string, unknown> = {
        key: generateAnnotationKey(),
        type: "highlight",
        color: input.color,
        text: resolved.text,
        comment: input.comment,
        pageLabel: resolved.pageLabel,
        sortIndex: resolved.sortIndex,
        position: resolved.position,
      };

      return executeExternalMutation({
        context,
        toolName: "annotate_pdf",
        plan: async () => {
          return {
            operation: "create_pdf_annotation",
            description: "Create a PDF highlight annotation",
            forward: { attachmentId: input.attachmentId, json },
            reversibility: "partial" as const,
            deferredInverse: true,
            reason: "The annotation ID is assigned only after Zotero commits.",
          };
        },
        execute: async () => {
          if (context.signal?.aborted)
            throw new Error("Annotation creation was cancelled.");
          const saved = await (
            Zotero as unknown as {
              Annotations: {
                saveFromJSON: (
                  attachment: unknown,
                  json: unknown,
                ) => Promise<{ id?: number }>;
              };
            }
          ).Annotations.saveFromJSON(attachment, json);
          const annotationId = Number(saved?.id) || 0;
          const inverseOperation = annotationId
            ? {
                type: "trash_items" as const,
                itemIds: [annotationId],
              }
            : undefined;
          const expectedPostcondition = inverseOperation
            ? await mutationService.captureOperationState(
                inverseOperation,
                context,
              )
            : undefined;
          const result = {
            annotationId: annotationId || undefined,
            attachmentId: input.attachmentId,
            pageIndex: resolved.position.pageIndex,
            rectCount: resolved.position.rects.length,
            expectedAnnotation,
            status: "created",
          };
          return {
            result,
            inverse: annotationId
              ? {
                  version: 1,
                  kind: "library_operations",
                  operations: [inverseOperation],
                }
              : undefined,
            expectedPostcondition,
            reversibility: annotationId ? ("full" as const) : ("none" as const),
            affectedCount: annotationId ? 1 : 0,
            effect: annotationId > 0 ? "applied" : "none",
          };
        },
      });
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function generateAnnotationKey(): string {
  const utils = (
    Zotero as unknown as {
      DataObjectUtilities?: { generateKey?: () => string };
    }
  ).DataObjectUtilities;
  const generated = utils?.generateKey?.();
  if (typeof generated === "string" && generated) return generated;
  // Zotero keys are 8 chars from a restricted alphabet.
  const alphabet = "23456789ABCDEFGHIJKMNPQRSTUVWXYZ";
  let key = "";
  for (let i = 0; i < 8; i += 1) {
    key += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return key;
}
