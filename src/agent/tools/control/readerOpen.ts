import type { AgentToolDefinition } from "../../types";
import {
  getPdfAttachmentPageCount,
  openReaderForItem,
  waitForReaderPageLabel,
  type ReaderOpenLocation,
} from "../../services/pdfPageService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";

/**
 * reader_open: opens a PDF in a Zotero reader tab at a page or an annotation.
 *
 * It changes what the user sees, not the library, so it is a control tool with
 * a read-only invocation plan and no card. The reader API takes an annotation
 * by its key, so an annotation item resolves to its parent attachment plus
 * its key.
 */

type ReaderOpenInput = {
  itemId?: number;
  attachmentId?: number;
  annotationId?: number;
  pageIndex?: number;
  pageLabel?: string;
};

function describeLocation(input: ReaderOpenInput): Record<string, unknown> {
  if (input.annotationId) return { annotationId: input.annotationId };
  if (input.pageIndex !== undefined) {
    return {
      pageIndex: input.pageIndex,
      ...(input.pageLabel ? { pageLabel: input.pageLabel } : {}),
    };
  }
  return input.pageLabel ? { pageLabel: input.pageLabel } : {};
}

/** The PDF a paper opens to: Zotero's best attachment if it is a PDF, else the first PDF. */
async function pickPdfAttachment(
  zoteroGateway: ZoteroGateway,
  paper: Zotero.Item,
): Promise<Zotero.Item | null> {
  const pdfs = paper
    .getAttachments()
    .map((id) => zoteroGateway.getItem(id))
    .filter(
      (attachment): attachment is Zotero.Item =>
        Boolean(attachment) &&
        !attachment!.deleted &&
        Boolean(attachment!.isPDFAttachment?.()),
    );
  const best = await paper.getBestAttachment?.();
  return (
    (best && pdfs.find((entry) => entry.id === best.id)) || pdfs[0] || null
  );
}

/** How long to wait for the reader to show a requested page label. */
const PAGE_LABEL_WAIT_MS = 3000;

export function createReaderOpenTool(
  zoteroGateway: ZoteroGateway,
  pageLabelWaitMs = PAGE_LABEL_WAIT_MS,
): AgentToolDefinition<ReaderOpenInput, unknown> {
  return {
    spec: {
      name: "reader_open",
      description:
        "When the user asks to open or show a PDF, open it in Zotero's reader at a page (pageIndex is 0-based) or annotation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "number", description: "A paper; opens its PDF." },
          attachmentId: { type: "number", description: "A PDF attachment." },
          annotationId: {
            type: "number",
            description: "An annotation item; opens its PDF at it.",
          },
          pageIndex: {
            type: "number",
            description: "Zero-based page number.",
          },
          pageLabel: {
            type: "string",
            description: "A page label, such as 'iv' or '12'.",
          },
        },
      },
      executionClass: "control",
      workCategory: "retrieval",
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const itemId = normalizePositiveInt(args.itemId);
      const attachmentId = normalizePositiveInt(args.attachmentId);
      const annotationId = normalizePositiveInt(args.annotationId);
      const pageLabel =
        typeof args.pageLabel === "string" && args.pageLabel.trim()
          ? args.pageLabel.trim()
          : undefined;
      const pageIndex =
        args.pageIndex === undefined || args.pageIndex === null
          ? undefined
          : Number(args.pageIndex);
      if (
        pageIndex !== undefined &&
        !(Number.isInteger(pageIndex) && pageIndex >= 0)
      ) {
        return fail("pageIndex must be a whole number from 0");
      }
      if (annotationId) {
        if (itemId || attachmentId) {
          return fail(
            "annotationId already names its PDF; do not pass itemId or attachmentId",
          );
        }
        if (pageIndex !== undefined || pageLabel) {
          return fail("Pass annotationId or a page, not both");
        }
      } else if (Boolean(itemId) === Boolean(attachmentId)) {
        return fail("Pass exactly one of itemId, attachmentId or annotationId");
      } else if (pageIndex !== undefined && pageLabel) {
        // A label is a name for a page, and the two can disagree.
        return fail("Pass pageIndex or pageLabel, not both");
      }
      return ok<ReaderOpenInput>({
        itemId,
        attachmentId,
        annotationId,
        pageIndex,
        pageLabel,
      });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason: "Opens a reader tab for the user; the library is unchanged.",
      }),
    execute: async (input) => {
      const refuse = (error: string) => ({ ok: false, error });
      let attachment: Zotero.Item | null = null;
      const location: ReaderOpenLocation = {};
      if (input.annotationId) {
        const annotation = zoteroGateway.getItem(input.annotationId);
        if (!annotation?.isAnnotation?.() || annotation.deleted) {
          return refuse(`Item ${input.annotationId} is not an annotation`);
        }
        attachment = annotation.parentID
          ? zoteroGateway.getItem(annotation.parentID)
          : null;
        location.annotationKey = annotation.key;
      } else {
        const target = zoteroGateway.getItem(
          input.attachmentId || input.itemId,
        );
        if (!target || target.deleted) {
          return refuse(`Item ${input.attachmentId || input.itemId} not found`);
        }
        if (target.isAttachment?.()) {
          if (input.itemId) {
            return refuse(
              `Item ${input.itemId} is an attachment; pass it as attachmentId`,
            );
          }
          attachment = target;
        } else if (target.isRegularItem?.()) {
          if (input.attachmentId) {
            return refuse(
              `Item ${input.attachmentId} is not an attachment; pass it as itemId`,
            );
          }
          attachment = await pickPdfAttachment(zoteroGateway, target);
          if (!attachment) return refuse("This paper has no PDF attachment");
        } else {
          return refuse("Only a paper or a PDF attachment can be opened");
        }
        if (input.pageIndex !== undefined) {
          location.pageIndex = input.pageIndex;
        }
        if (input.pageLabel) location.pageLabel = input.pageLabel;
      }
      if (!attachment?.isPDFAttachment?.() || attachment.deleted) {
        return refuse("The reader tool opens PDF attachments only");
      }
      if (!(await attachment.fileExists())) {
        return refuse("The PDF file is not on disk");
      }
      if (location.pageIndex !== undefined) {
        // The reader ignores a page index past the last page and would still
        // open the tab, so refuse before it opens anything.
        const pageCount = await getPdfAttachmentPageCount(attachment.id);
        if (pageCount !== null && location.pageIndex >= pageCount) {
          return refuse(
            `pageIndex ${location.pageIndex} is past the last page: this PDF has ${pageCount} pages, so pageIndex runs from 0 to ${pageCount - 1}`,
          );
        }
      }
      const reader = await openReaderForItem(
        attachment.id,
        location.annotationKey ||
          location.pageIndex !== undefined ||
          location.pageLabel
          ? location
          : undefined,
      );
      if (!reader) {
        return refuse("Zotero did not open a reader tab for this PDF");
      }
      // The reader ignores a label the PDF does not have, so read the page it
      // shows back instead of reporting the label as reached.
      const labelCheck = location.pageLabel
        ? await waitForReaderPageLabel(
            reader,
            location.pageLabel,
            pageLabelWaitMs,
          )
        : null;
      const parentId = attachment.parentID || undefined;
      return {
        ok: true,
        attachmentId: attachment.id,
        ...(parentId ? { itemId: parentId } : {}),
        title: attachment.getDisplayTitle?.() || `Attachment ${attachment.id}`,
        location: {
          ...describeLocation(input),
          ...(labelCheck ? { pageLabelVerified: labelCheck.verified } : {}),
        },
        ...(labelCheck && !labelCheck.verified
          ? {
              note: `pageLabel requested, not verified: the reader shows ${
                labelCheck.shown
                  ? `page label "${labelCheck.shown}"`
                  : "no page yet"
              }`,
            }
          : {}),
      };
    },
    presentation: {
      label: "Open in Reader",
      summaries: {
        onCall: "Opening the PDF in the reader",
        onSuccess: ({ content }) =>
          content &&
          typeof content === "object" &&
          (content as { ok?: unknown }).ok === true
            ? "Opened the PDF in the reader"
            : "Could not open the reader",
      },
    },
  };
}
