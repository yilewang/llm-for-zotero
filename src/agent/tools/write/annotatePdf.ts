import type { AgentToolContext, AgentWriteToolDefinition } from "../../types";
import { stateChangeInvocationPlan } from "../../authorization/invocationPlan";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { resolveHighlightColor } from "../../services/pdfAnnotationGeometry";
import {
  readOpenReaderDocumentFingerprint,
  resolvePdfHighlight,
  type ResolvedPdfHighlight,
} from "../../../services/pdf/pdfAnnotationResolver";
import {
  annotationMatchesPayload,
  stickyNotePosition,
  type PdfHighlightPayload,
  type PdfPassageAnnotationType,
} from "../../../services/pdf/pdfAnnotationState";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

/**
 * A reader selection the host (Inline Ask's Save) froze from Zotero's own
 * popup draft. Host-only: it is not in the model's input schema, and a call
 * that carries it is refused unless the host built the call.
 */
export type AnnotateSelection = {
  pageIndex: number;
  rects: number[][];
  sortIndex: string;
  pageLabel: string;
  text: string;
};

type AnnotateInput = {
  attachmentId: number;
  text: string;
  pageIndex?: number;
  occurrence?: number;
  color: string;
  comment: string;
  annotationType: PdfPassageAnnotationType;
  selection?: AnnotateSelection;
};

const HOST_ONLY_SELECTION =
  "annotate_pdf refused the selection input: only the plugin's own reader actions may pass selection coordinates. Supply the quoted text instead.";

const SELECTION_NEEDS_OPEN_READER =
  "The highlight was not saved: the PDF must be open in Zotero's reader so the saved highlight can be checked against it. Open the PDF and try again.";

/**
 * A selection comes only from the plugin's own reader UI: an action's code
 * built the call (hostAction) from the action UI entry point. An action run
 * inside a model turn (entry point "conversation") does not qualify.
 */
function isHostSelectionCaller(context: AgentToolContext): boolean {
  return Boolean(
    context.hostAction && context.request?.actionEntryPoint === "action_ui",
  );
}

/** Checks the host selection's shape; the error names the bad part. */
function readSelection(
  value: unknown,
  text: string,
): { ok: true; selection: AnnotateSelection } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "selection must be an object." };
  const raw = value as Record<string, unknown>;
  const pageIndex = raw.pageIndex;
  if (
    typeof pageIndex !== "number" ||
    !Number.isInteger(pageIndex) ||
    pageIndex < 0
  )
    return {
      ok: false,
      error: "selection.pageIndex must be a zero-based integer.",
    };
  const rects = raw.rects;
  if (
    !Array.isArray(rects) ||
    !rects.length ||
    !rects.every(
      (rect) =>
        Array.isArray(rect) &&
        rect.length === 4 &&
        rect.every((n) => typeof n === "number" && Number.isFinite(n)),
    )
  )
    return {
      ok: false,
      error: "selection.rects must be a non-empty list of four finite numbers.",
    };
  if (typeof raw.sortIndex !== "string" || !raw.sortIndex)
    return { ok: false, error: "selection.sortIndex must be a string." };
  if (raw.pageLabel !== undefined && typeof raw.pageLabel !== "string")
    return { ok: false, error: "selection.pageLabel must be a string." };
  if (raw.text !== text)
    return { ok: false, error: "selection.text must equal text." };
  if (raw.nextPageRects !== undefined)
    return {
      ok: false,
      error: "A selection that continues on the next page is not supported.",
    };
  return {
    ok: true,
    selection: {
      pageIndex,
      rects: rects as number[][],
      sortIndex: raw.sortIndex,
      pageLabel: (raw.pageLabel as string | undefined) ?? "",
      text,
    },
  };
}

const ANNOTATION_TYPES: readonly PdfPassageAnnotationType[] = [
  "highlight",
  "underline",
  "note",
];

/** The annotation a call makes, as a person reads it. */
const TYPE_NOUN: Record<PdfPassageAnnotationType, string> = {
  highlight: "highlight",
  underline: "underline",
  note: "sticky note",
};

function nounFor(args: unknown): string {
  const type = (args as { annotationType?: unknown } | null)?.annotationType;
  return TYPE_NOUN[type as PdfPassageAnnotationType] || "highlight";
}

/** The model chooses a passage; native PDF text determines its placement. */
export function createAnnotatePdfTool(
  zoteroGateway: ZoteroGateway,
  resolveHighlight = resolvePdfHighlight,
  readDocumentFingerprint = readOpenReaderDocumentFingerprint,
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
          annotationType: input.annotationType,
          ...(input.selection ? { expectedRects: input.selection.rects } : {}),
        },
        requestedTargets: [`item:${input.attachmentId}`],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["annotation_write"],
    spec: {
      name: "annotate_pdf",
      description:
        "Highlight or underline an exact quoted passage in a PDF attachment and optionally add a comment, or put a sticky note at it (annotationType:'note'; comment is its text). Zotero locates the text and computes the position. Supply text from paper_read; no coordinates, scripts, or external PDF utilities are needed. For multiple matches specify pageIndex and occurrence. If native text is unavailable, report the limitation instead of estimating coordinates or using scripts.",
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
            description:
              "A note attached to the highlight or underline; the text of a sticky note.",
          },
          annotationType: {
            type: "string",
            enum: ["highlight", "underline", "note"],
            description: "Default highlight.",
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
        onCall: ({ args }) => `Preparing a PDF ${nounFor(args)}`,
        onPending: ({ args }) =>
          `Waiting for confirmation on a PDF ${nounFor(args)}`,
        onApproved: ({ args }) => `Adding the ${nounFor(args)}`,
        onDenied: ({ args }) => {
          const noun = nounFor(args);
          return `${noun[0].toUpperCase()}${noun.slice(1)} cancelled`;
        },
        onSuccess: ({ args }) => `Added a ${nounFor(args)}`,
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
              "annotationType",
              // Host-only; planInvocation and execute refuse it from a model.
              "selection",
            ].includes(key),
        )
      ) {
        return fail(
          "Supply attachmentId and text, with optional comment, color, pageIndex, occurrence and annotationType. Zotero computes the coordinates; do not supply rects or page dimensions.",
        );
      }
      const annotationType = (args.annotationType ??
        "highlight") as PdfPassageAnnotationType;
      if (!ANNOTATION_TYPES.includes(annotationType))
        return fail(
          "annotationType must be 'highlight', 'underline' or 'note'. Image and ink annotations are not offered.",
        );
      const comment = readString(args.comment) || "";
      if (annotationType === "note" && !comment)
        return fail("A sticky note needs a comment: the text it shows.");
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
      if (args.selection !== undefined) {
        const read = readSelection(args.selection, text);
        if (!read.ok) return fail(read.error);
        if (annotationType === "note")
          return fail(
            "A selection is highlighted or underlined; a sticky note does not cover it.",
          );
        if (occurrence !== undefined)
          return fail("occurrence does not apply to a selection.");
        if (pageIndex !== undefined && pageIndex !== read.selection.pageIndex)
          return fail("pageIndex must match selection.pageIndex.");
        return ok({
          attachmentId,
          pageIndex: read.selection.pageIndex,
          color,
          text,
          comment,
          annotationType,
          selection: read.selection,
        });
      }
      return ok({
        attachmentId,
        pageIndex,
        occurrence,
        color,
        text,
        comment,
        annotationType,
      });
    },

    createPendingAction(input) {
      const noun = TYPE_NOUN[input.annotationType];
      const where =
        input.pageIndex === undefined
          ? " in the PDF"
          : ` on page ${input.pageIndex + 1}`;
      const summary =
        input.annotationType === "note"
          ? `Sticky note at the passage${where}`
          : `${noun[0].toUpperCase()}${noun.slice(1)}${input.comment ? " and comment" : ""}${where}`;
      return {
        toolName: "annotate_pdf",
        title: `Add a ${input.annotationType === "note" ? "" : "PDF "}${noun}`,
        description: summary,
        confirmLabel: `Add ${noun}`,
        cancelLabel: "Cancel",
        fields: [
          ...(input.text
            ? [
                {
                  type: "text" as const,
                  id: "text",
                  label:
                    input.annotationType === "highlight"
                      ? "Highlighted text"
                      : input.annotationType === "underline"
                        ? "Underlined text"
                        : "Passage",
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
      // A host selection's text is bound to its rects.
      if (input.selection && text !== input.text)
        return fail("The selected text cannot be changed.");
      return ok({
        ...input,
        text,
        comment: edited === undefined ? input.comment : edited.trim(),
      });
    },

    planInvocation(input, context) {
      // Runs before authorization; validate has no context to check this.
      if (input.selection && !isHostSelectionCaller(context))
        throw new Error(HOST_ONLY_SELECTION);
      return stateChangeInvocationPlan({
        effects: ["create"],
        reversibility: "partial",
        reason:
          "The annotation ID needed by the inverse is assigned only after Zotero commits.",
      });
    },

    async execute(input, context) {
      if (input.selection && !isHostSelectionCaller(context))
        throw new Error(HOST_ONLY_SELECTION);
      // The receipt checks a selection's highlight against the open reader's
      // document; without one the write could never be verified, so nothing
      // is written.
      const selectionFingerprint = input.selection
        ? readDocumentFingerprint(input.attachmentId)
        : "";
      if (input.selection && !selectionFingerprint)
        throw new Error(SELECTION_NEEDS_OPEN_READER);
      const attachment = zoteroGateway.getItem(input.attachmentId);
      if (!attachment?.isAttachment?.() || !attachment.isPDFAttachment?.()) {
        throw new Error(
          `Item ${input.attachmentId} is not a PDF attachment. Use library_read with sections:['attachments'] to find the PDF attachment ID.`,
        );
      }
      // A host selection is Zotero's own draft: written verbatim, never
      // re-resolved or rounded, so the native-state match and an idempotent
      // retry compare the exact values the user saw.
      const resolved: ResolvedPdfHighlight = input.selection
        ? {
            text: input.selection.text,
            pageLabel: input.selection.pageLabel,
            sortIndex: input.selection.sortIndex,
            position: {
              pageIndex: input.selection.pageIndex,
              rects: input.selection.rects,
            },
            source: { documentFingerprint: selectionFingerprint },
          }
        : await resolveHighlight(input, context.signal);
      if (context.signal?.aborted)
        throw new Error("Annotation creation was cancelled.");
      // A note marks the passage with Zotero's note square at its first
      // line; a highlight or an underline covers the passage's lines.
      const expectedAnnotation: PdfHighlightPayload = {
        ...resolved,
        ...(input.annotationType === "note"
          ? { position: stickyNotePosition(resolved.position) }
          : {}),
        color: input.color,
        comment: input.comment,
        type: input.annotationType,
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
      // Zotero refuses text on a note annotation.
      const json: Record<string, unknown> = {
        key: generateAnnotationKey(),
        type: input.annotationType,
        color: input.color,
        ...(input.annotationType === "note" ? {} : { text: resolved.text }),
        comment: input.comment,
        pageLabel: resolved.pageLabel,
        sortIndex: resolved.sortIndex,
        position: expectedAnnotation.position,
      };

      return executeExternalMutation({
        context,
        toolName: "annotate_pdf",
        plan: async () => {
          return {
            operation: "create_pdf_annotation",
            description: `Create a PDF ${TYPE_NOUN[input.annotationType]} annotation`,
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
            annotationType: input.annotationType,
            rectCount: expectedAnnotation.position.rects.length,
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
