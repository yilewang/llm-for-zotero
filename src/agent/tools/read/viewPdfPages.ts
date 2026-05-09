import type { AgentToolDefinition } from "../../types";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import {
  normalizeTarget,
  inferPdfMode,
  setPreparedCache,
  setCapturedCache,
  buildCaptureFollowupMessage,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";

type ViewPdfPagesInput = {
  target?: PdfTarget;
  question?: string;
  pages?: number[];
  capture?: boolean;
  neighborPages?: number;
  scope?: "whole_document";
};

function normalizePages(value: unknown): number[] | undefined {
  const parsed = parsePageSelectionValue(value);
  return parsed?.pageIndexes;
}

export function createViewPdfPagesTool(
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ViewPdfPagesInput, unknown> {
  return {
    spec: {
      name: "view_pdf_pages",
      description:
        "Find and render PDF pages as images for visual analysis. " +
        "Provide a question to search for relevant pages, specific page " +
        "numbers to render, or set capture to true to screenshot the " +
        "currently visible page in the reader. If mineruCacheDir is available, do not use this for ordinary summaries or text Q&A; use file_io on MinerU markdown first. Use view_pdf_pages only when visual page layout/image inspection is needed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: {
            type: "object",
            description: "Target paper.",
            properties: {
              contextItemId: {
                type: "number",
                description: "Zotero attachment item ID",
              },
              itemId: {
                type: "number",
                description: "Zotero parent item ID",
              },
              paperContext: PAPER_CONTEXT_REF_SCHEMA,
              attachmentId: {
                type: "string",
                description: "Uploaded attachment ID",
              },
              name: {
                type: "string",
                description: "Uploaded attachment name",
              },
            },
            additionalProperties: false,
          },
          question: {
            type: "string",
            description: "Search for relevant pages matching this question.",
          },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "array", items: { type: "number" } },
            ],
            description: "Specific page numbers to render.",
          },
          capture: {
            type: "boolean",
            description: "Capture the currently visible page in the reader.",
          },
          neighborPages: {
            type: "number",
            description: "Include adjacent pages (0 or 1).",
          },
          scope: {
            type: "string",
            enum: ["whole_document"],
            description: "Render all pages in the document.",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    presentation: {
      label: "View PDF Pages",
      summaries: {
        onCall: ({ args }) => {
          const a = args as Record<string, unknown> | null;
          if (a?.capture) return "Capturing current reader page";
          if (a?.question) return "Searching for relevant pages";
          return "Preparing PDF pages";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "PDF page viewing cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          if (c?.capturedPageIndex !== undefined)
            return "Captured the current reader page";
          const count = typeof c?.pageCount === "number" ? c.pageCount : 0;
          return count > 0
            ? `Prepared ${count} PDF page image${count === 1 ? "" : "s"}`
            : "Prepared PDF pages";
        },
      },
    },
    shouldRequireConfirmation: async () => false,
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const input: ViewPdfPagesInput = {
        target: normalizeTarget(args.target),
        question:
          typeof args.question === "string" && args.question.trim()
            ? args.question.trim()
            : undefined,
        pages: normalizePages(args.pages),
        capture: args.capture === true,
        neighborPages: normalizePositiveInt(args.neighborPages),
        scope: args.scope === "whole_document" ? "whole_document" : undefined,
      };
      if (
        !input.capture &&
        !input.pages?.length &&
        !input.question &&
        input.scope !== "whole_document"
      ) {
        return fail(
          "Provide at least one of: question (to search pages), pages (to render), " +
            "capture (to screenshot active view), or scope:'whole_document'.",
        );
      }
      return ok(input);
    },
    createPendingAction: async (input, context) => {
      // Capture active view → show page preview
      if (input.capture) {
        const preview = await pdfPageService.captureActiveView({
          request: context.request,
          neighborPages: input.neighborPages,
        });
        const previewImages = preview.artifacts
          .filter(
            (
              artifact,
            ): artifact is Extract<typeof artifact, { kind: "image" }> =>
              artifact.kind === "image",
          )
          .map((artifact) => ({
            label: `Page ${
              artifact.pageLabel ||
              (artifact.pageIndex !== undefined
                ? `${artifact.pageIndex + 1}`
                : "?")
            }`,
            storedPath: artifact.storedPath,
            mimeType: "image/png",
            title: artifact.title || preview.target.title,
          }));
        return {
          toolName: "view_pdf_pages",
          title: `${preview.target.title} - page ${preview.capturedPage.pageLabel}`,
          description:
            'Review the captured page below. Click "Send to model" to let the model inspect it.',
          confirmLabel: "Send to model",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "image_gallery",
              id: "previewImages",
              items: previewImages,
            },
          ],
        };
      }

      // Render pages → show page gallery with editable selection
      let pages = input.pages || [];
      let previewPages = pages;
      let description =
        'Review the selected pages below, then click "Send to model" to send them for inspection.';
      if (input.scope === "whole_document" && !pages.length) {
        const pageCount = await pdfPageService.getPageCountForTarget({
          request: context.request,
          paperContext: input.target?.paperContext,
          itemId: input.target?.itemId,
          contextItemId: input.target?.contextItemId,
          attachmentId: input.target?.attachmentId,
          name: input.target?.name,
        });
        pages = Array.from({ length: pageCount }, (_value, index) => index);
        previewPages = pages.slice(0, 12);
        description =
          pageCount > previewPages.length
            ? `This will send all ${pageCount} pages. Previewing the first ${previewPages.length} pages below.`
            : `This will send all ${pageCount} pages for inspection.`;
      }

      // If only question provided (no pages), search first
      if (!pages.length && input.question) {
        const searchResult = await pdfPageService.searchPages({
          request: context.request,
          paperContext: input.target?.paperContext,
          itemId: input.target?.itemId,
          contextItemId: input.target?.contextItemId,
          attachmentId: input.target?.attachmentId,
          name: input.target?.name,
          question: input.question,
          mode: inferPdfMode(input.question),
          topK: 3,
        });
        pages = searchResult.pages.map((p) => p.pageIndex);
        previewPages = pages;
        description =
          `Found ${pages.length} relevant page${pages.length === 1 ? "" : "s"} for your question. ` +
          'Review below, then click "Send to model".';
      }

      if (!previewPages.length) {
        return {
          toolName: "view_pdf_pages",
          title: "No pages to render",
          description: "No matching pages found.",
          confirmLabel: "OK",
          cancelLabel: "Cancel",
          fields: [],
        };
      }

      const preview = await pdfPageService.preparePagesForModel({
        request: context.request,
        paperContext: input.target?.paperContext,
        itemId: input.target?.itemId,
        contextItemId: input.target?.contextItemId,
        attachmentId: input.target?.attachmentId,
        name: input.target?.name,
        pages: previewPages,
        neighborPages: 0,
      });
      return {
        toolName: "view_pdf_pages",
        title:
          pages.length === 1
            ? `${preview.target.title} - p${pages[0] + 1}`
            : `${preview.target.title} - ${previewPages.length} page preview`,
        description,
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "pageSelection",
            label: "Pages to send",
            value:
              pages.length > 0
                ? `p${pages.map((page) => page + 1).join(", p")}`
                : undefined,
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
      if (input.capture) return ok(input);
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      if (
        Object.prototype.hasOwnProperty.call(resolutionData, "pageSelection")
      ) {
        const selection = parsePageSelectionValue(resolutionData.pageSelection);
        if (!selection?.pageIndexes.length) {
          return fail("At least one page is required");
        }
        return ok({ ...input, pages: selection.pageIndexes });
      }
      return ok(input);
    },
    execute: async (input, context) => {
      // Capture active view
      if (input.capture) {
        const captured = await pdfPageService.captureActiveView({
          request: context.request,
          neighborPages: input.neighborPages,
        });
        setCapturedCache(
          context.request.conversationKey,
          captured.capturedPage.pageIndex,
          captured.target.contextItemId,
        );
        return {
          content: {
            target: {
              source: captured.target.source,
              title: captured.target.title,
              paperContext: captured.target.paperContext,
              contextItemId: captured.target.contextItemId,
              itemId: captured.target.itemId,
            },
            capturedPageIndex: captured.capturedPage.pageIndex,
            pageLabel: captured.capturedPage.pageLabel,
            pageCount: captured.artifacts.length,
            pageText: captured.pageText || undefined,
          },
          artifacts: captured.artifacts,
        };
      }

      // Search for relevant pages if only question provided
      let pages = input.pages || [];
      if (!pages.length && input.question) {
        const searchResult = await pdfPageService.searchPages({
          request: context.request,
          paperContext: input.target?.paperContext,
          itemId: input.target?.itemId,
          contextItemId: input.target?.contextItemId,
          attachmentId: input.target?.attachmentId,
          name: input.target?.name,
          question: input.question,
          mode: inferPdfMode(input.question),
          topK: 3,
        });
        pages = searchResult.pages.map((p) => p.pageIndex);
      }

      // Resolve whole document
      if (input.scope === "whole_document" && !pages.length) {
        const pageCount = await pdfPageService.getPageCountForTarget({
          request: context.request,
          paperContext: input.target?.paperContext,
          itemId: input.target?.itemId,
          contextItemId: input.target?.contextItemId,
          attachmentId: input.target?.attachmentId,
          name: input.target?.name,
        });
        pages = Array.from({ length: pageCount }, (_value, index) => index);
      }

      // Render pages
      const prepared = await pdfPageService.preparePagesForModel({
        request: context.request,
        paperContext: input.target?.paperContext,
        itemId: input.target?.itemId,
        contextItemId: input.target?.contextItemId,
        attachmentId: input.target?.attachmentId,
        name: input.target?.name,
        pages,
        neighborPages: input.neighborPages,
      });
      setPreparedCache(
        context.request.conversationKey,
        prepared.pages.map((page) => page.pageIndex),
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
          results: prepared.pages.map((page) => ({
            pageIndex: page.pageIndex,
            pageLabel: page.pageLabel,
          })),
          pageTexts: prepared.pageTexts,
        },
        artifacts: prepared.artifacts,
      };
    },
    buildFollowupMessage: async (result) => {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as { capturedPageIndex?: unknown })
          : null;
      if (content?.capturedPageIndex !== undefined) {
        return buildCaptureFollowupMessage(result);
      }
      return null;
    },
  };
}
