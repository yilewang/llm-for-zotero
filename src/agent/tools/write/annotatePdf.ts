import type { AgentWriteToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  buildAnnotationSortIndex,
  mergeRectsByLine,
  resolveHighlightColor,
  type PdfRect,
} from "../../services/pdfAnnotationGeometry";
import { executeExternalMutation } from "../../services/mutationCoordinator";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type AnnotateInput = {
  attachmentId: number;
  pageIndex: number;
  rects: PdfRect[];
  color: string;
  text?: string;
  comment?: string;
  pageLabel?: string;
  charOffset?: number;
  pageHeightPoints: number;
};

/**
 * Creates a highlight annotation on a PDF attachment.
 *
 * Zotero's write path is headless — `saveFromJSON` touches only the database
 * and the notifier, and Zotero's own PDF-worker import calls it in a loop —
 * so the reader does not need to be open.
 *
 * The contract has several sharp edges that throw rather than degrade, so
 * they are enforced here instead of being discovered at save time:
 *   - `annotationType` must be set FIRST; setting any other annotation field
 *     before it throws.
 *   - the colour is validated against a case-sensitive lowercase hex regex.
 *   - `sortIndex` is format-checked as `NNNNN|NNNNNN|NNNNN`.
 *   - rects are PDF user space, origin bottom-left, y-up, in points — which
 *     is the opposite convention to both of this plugin's geometry producers.
 *     `pdfAnnotationGeometry` converts; this tool takes the converted values.
 */
export function createAnnotatePdfTool(
  zoteroGateway: ZoteroGateway,
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
        },
        requestedTargets: [`item:${input.attachmentId}`],
        destinationCollectionIds: [],
      },
    ],
    spec: {
      name: "annotate_pdf",
      description:
        "Add a highlight annotation with an optional comment to a PDF attachment. Rects must be in PDF user space (origin bottom-left, y increasing upward, in points).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "pageIndex", "rects", "pageHeightPoints"],
        properties: {
          attachmentId: {
            type: "number",
            description:
              "The PDF attachment item ID. Not the parent paper — annotations belong to the attachment.",
          },
          pageIndex: {
            type: "number",
            description: "Zero-based page index.",
          },
          rects: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description:
              "Highlight rectangles as [x1, y1, x2, y2] in PDF points, origin bottom-left. One per line of text.",
          },
          pageHeightPoints: {
            type: "number",
            description:
              "The page height in points, used to compute the sort index.",
          },
          color: {
            type: "string",
            description:
              "A Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a lowercase hex like '#ff6666'. Default yellow.",
          },
          text: {
            type: "string",
            description: "The highlighted text itself.",
          },
          comment: {
            type: "string",
            description: "A note attached to the highlight.",
          },
          pageLabel: { type: "string" },
          charOffset: {
            type: "number",
            description:
              "Character offset of the highlight within the page text. Affects sidebar ordering only; an approximation is fine.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Annotate PDF",
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
      const pageIndex = Number(args.pageIndex);
      if (!Number.isFinite(pageIndex) || pageIndex < 0) {
        return fail("pageIndex must be a zero-based page number.");
      }
      const pageHeightPoints = Number(args.pageHeightPoints);
      if (!Number.isFinite(pageHeightPoints) || pageHeightPoints <= 0) {
        return fail(
          "pageHeightPoints must be the page height in points, used to place the highlight.",
        );
      }
      const rects = normalizeRects(args.rects);
      if (!rects.length) {
        return fail(
          "rects must contain at least one [x1, y1, x2, y2] rectangle in PDF points.",
        );
      }
      const color = resolveHighlightColor(args.color ?? "yellow");
      if (!color) {
        return fail(
          "color must be a Zotero palette name (yellow, red, green, blue, purple, magenta, orange, gray) or a hex like '#ff6666'.",
        );
      }
      return ok({
        attachmentId,
        pageIndex: Math.floor(pageIndex),
        rects: mergeRectsByLine(rects),
        color,
        text: readString(args.text),
        comment: readString(args.comment),
        pageLabel: readString(args.pageLabel),
        charOffset: normalizePositiveInt(args.charOffset) ?? 0,
        pageHeightPoints,
      });
    },

    createPendingAction(input) {
      const summary = input.comment
        ? `Highlight and comment on page ${input.pageIndex + 1}`
        : `Highlight on page ${input.pageIndex + 1}`;
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
      return ok(edited === undefined ? input : { ...input, comment: edited });
    },

    planMutation() {
      return {
        effect: "write",
        reversibility: "partial",
        reason:
          "The annotation ID needed by the inverse is assigned only after Zotero commits.",
      };
    },

    async execute(input, context) {
      const sortIndex = buildAnnotationSortIndex({
        pageIndex: input.pageIndex,
        charOffset: input.charOffset,
        topY: Math.max(...input.rects.map((rect) => rect[3])),
        pageHeightPoints: input.pageHeightPoints,
      });

      const json: Record<string, unknown> = {
        key: generateAnnotationKey(),
        // Type first: Zotero throws if any other annotation field is set
        // before it.
        type: "highlight",
        color: input.color,
        sortIndex,
        position: { pageIndex: input.pageIndex, rects: input.rects },
      };
      if (input.text) json.text = input.text;
      if (input.comment) json.comment = input.comment;
      if (input.pageLabel) json.pageLabel = input.pageLabel;
      let attachment: Zotero.Item | null = null;

      return executeExternalMutation({
        context,
        toolName: "annotate_pdf",
        plan: async () => {
          const currentAttachment = zoteroGateway.getItem(input.attachmentId);
          if (!currentAttachment?.isAttachment?.()) {
            throw new Error(
              `Item ${input.attachmentId} is not an attachment. Annotations belong to the PDF attachment, not to the parent paper — use library_read with sections:['attachments'] to find it.`,
            );
          }
          attachment = currentAttachment;
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
          if (!attachment) {
            throw new Error("The annotation target was not prepared");
          }
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
            pageIndex: input.pageIndex,
            rectCount: input.rects.length,
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

function normalizeRects(value: unknown): PdfRect[] {
  if (!Array.isArray(value)) return [];
  const rects: PdfRect[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const nums = entry.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    // Normalize orientation so a caller that swapped the y values still gets
    // a usable rect rather than an invisible zero-height highlight.
    const [x1, y1, x2, y2] = nums;
    rects.push([
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ]);
  }
  return rects;
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
