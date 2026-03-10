import type { AgentModelContentPart, AgentToolDefinition } from "../../types";
import {
  formatPageSelectionValue,
  type PdfPageService,
} from "../../services/pdfPageService";
import {
  buildPdfToolSchemaProperties,
  getUserEditablePageSelection,
  parsePdfTargetArgs,
  resolvePageSelectionFromResolution,
  type PdfTargetArgs,
} from "./pdfToolShared";
import { fail, ok } from "../shared";
import { readAttachmentBytes } from "../../../modules/contextPanel/attachmentStorage";

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    out += String.fromCharCode(...chunk);
  }
  const btoaFn = (globalThis as typeof globalThis & { btoa?: (s: string) => string }).btoa;
  if (typeof btoaFn !== "function") throw new Error("btoa unavailable");
  return btoaFn(out);
}

function samePageSet(left: number[] | undefined, right: number[] | undefined): boolean {
  const normalizedLeft = Array.from(new Set(left || [])).sort((a, b) => a - b);
  const normalizedRight = Array.from(new Set(right || [])).sort((a, b) => a - b);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

type PreparedPagesCache = {
  pageIndexes: number[];
  contextItemId?: number;
  expiresAt: number;
};

const pagesCache = new Map<number, PreparedPagesCache>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedPages(conversationKey: number): PreparedPagesCache | null {
  const entry = pagesCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    pagesCache.delete(conversationKey);
    return null;
  }
  return entry;
}

function setCachedPages(
  conversationKey: number,
  pageIndexes: number[],
  contextItemId?: number,
): void {
  pagesCache.set(conversationKey, {
    pageIndexes,
    contextItemId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function clearPreparePdfPagesCache(conversationKey: number): void {
  pagesCache.delete(conversationKey);
}

export function createPreparePdfPagesForModelTool(
  pdfPageService: PdfPageService,
): AgentToolDefinition<PdfTargetArgs, unknown> {
  return {
    spec: {
      name: "prepare_pdf_pages_for_model",
      description:
        "Render specific PDF pages into model-visible page images so the model can inspect figures, equations, tables, or page layout. Prefer this over sending a whole PDF.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: buildPdfToolSchemaProperties(),
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Prepare PDF Pages",
      summaries: {
        onCall: "Preparing PDF pages for visual inspection",
        onPending:
          "Waiting for your approval before sending the selected PDF pages",
        onApproved: "Approval received - sending the selected PDF pages",
        onDenied: "PDF page send cancelled",
        onSuccess: ({ content }) => {
          const pages =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { pages?: unknown }).pages)
              ? (content as { pages: unknown[] }).pages
              : [];
          return pages.length > 0
            ? `Prepared ${pages.length} PDF page image${
                pages.length === 1 ? "" : "s"
              } for inspection`
            : "Could not prepare PDF page images";
        },
      },
    },
    validate: (args) => {
      const parsed = parsePdfTargetArgs(args);
      if (!parsed.ok) return parsed;
      if (!parsed.value.pages?.length) {
        return fail("pages is required");
      }
      return ok(parsed.value);
    },
    shouldRequireConfirmation: async (input, context) => {
      // Same page set already confirmed earlier in this conversation — skip
      const cached = getCachedPages(context.request.conversationKey);
      if (cached && samePageSet(input.pages, cached.pageIndexes)) return false;
      return true;
    },
    createPendingAction: async (input, context) => {
      const preview = await pdfPageService.preparePagesForModel({
        request: context.request,
        paperContext: input.paperContext,
        itemId: input.itemId,
        contextItemId: input.contextItemId,
        attachmentId: input.attachmentId,
        name: input.name,
        pages: input.pages || [],
        neighborPages: 0,
      });
      return {
        toolName: "prepare_pdf_pages_for_model",
        title: `${preview.target.title} — ${formatPageSelectionValue(input.pages || [])}`,
        description:
          "Review the pages below, then click \"Send to model\" to send them for visual inspection.",
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "pageSelection",
            label: "Pages to send",
            value: getUserEditablePageSelection(input.pages),
            placeholder: "e.g. p3 or p3-5",
          },
          {
            type: "image_gallery",
            id: "previewImages",
            items: preview.pages.map((page) => ({
              label: `Page ${page.pageLabel}`,
              storedPath: page.imagePath,
              mimeType: "image/png",
              title: `${preview.target.title} - page ${page.pageLabel}`,
            })),
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      const selection = resolvePageSelectionFromResolution(
        resolutionData,
        input.pages,
      );
      if (!selection?.pageIndexes.length) {
        return fail("At least one page is required");
      }
      return ok({
        ...input,
        pages: selection.pageIndexes,
      });
    },
    execute: async (input, context) => {
      const prepared = await pdfPageService.preparePagesForModel({
        request: context.request,
        paperContext: input.paperContext,
        itemId: input.itemId,
        contextItemId: input.contextItemId,
        attachmentId: input.attachmentId,
        name: input.name,
        pages: input.pages || [],
        neighborPages: input.neighborPages,
      });
      setCachedPages(
        context.request.conversationKey,
        prepared.pages.map((p) => p.pageIndex),
        prepared.target.contextItemId,
      );
      return {
        content: {
          target: {
            source: prepared.target.source,
            title: prepared.target.title,
            paperContext: prepared.target.paperContext,
            contextItemId: prepared.target.contextItemId,
            itemId: prepared.target.itemId,
          },
          pageCount: prepared.pages.length,
          pages: prepared.pages.map((page) => ({
            pageIndex: page.pageIndex,
            pageLabel: page.pageLabel,
          })),
          pageTexts: prepared.pageTexts,
        },
        artifacts: prepared.artifacts,
      };
    },
    buildFollowupMessage: async (result) => {
      if (!result.ok) return null;
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      if (!artifacts.length) return null;

      const content = result.content as {
        pages?: Array<{ pageIndex: number; pageLabel: string }>;
        pageTexts?: Record<number, string>;
      } | null;
      const pages = Array.isArray(content?.pages) ? content.pages : [];
      const pageTexts: Record<number, string> = content?.pageTexts ?? {};

      const pageLabels = pages.map((p) => `page ${p.pageLabel}`).join(", ");
      const header = pageLabels
        ? `[PDF ${pageLabels} — extracted text and image${pages.length !== 1 ? "s" : ""} below]`
        : "[PDF pages — extracted text and images below]";

      const combinedText = pages
        .map((p) => {
          const text = pageTexts[p.pageIndex]?.trim();
          return text
            ? pages.length > 1
              ? `--- Page ${p.pageLabel} ---\n${text}`
              : text
            : null;
        })
        .filter((entry): entry is string => entry !== null)
        .join("\n\n");

      const textSection = combinedText
        ? `\n\nExtracted page text:\n"""\n${combinedText}\n"""`
        : "";

      const parts: AgentModelContentPart[] = [
        {
          type: "text",
          text:
            [
              header,
              "Answer the user's question using ONLY the content shown below.",
              "Do not use prior knowledge or training data about this paper.",
            ].join(" ") + textSection,
        },
      ];

      for (const artifact of artifacts) {
        if (artifact.kind !== "image" || !artifact.storedPath || !artifact.mimeType) {
          continue;
        }
        try {
          const bytes = await readAttachmentBytes(artifact.storedPath);
          const base64 = encodeBase64(bytes);
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${artifact.mimeType};base64,${base64}`,
              detail: "high",
            },
          });
        } catch {
          // image load failed — extracted text still provides grounding
        }
      }

      return { role: "user", content: parts };
    },
  };
}
