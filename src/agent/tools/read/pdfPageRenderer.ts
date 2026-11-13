import type {
  AgentPendingAction,
  AgentToolContext,
  AgentToolExecutionOutput,
  AgentToolInputValidation,
} from "../../types";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import {
  normalizeTarget,
  setPreparedCache,
  setCapturedCache,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";

export type PdfPageRenderInput = {
  target?: PdfTarget;
  question?: string;
  pages?: number[];
  capture?: boolean;
  neighborPages?: number;
};

/** Pages rendered at most: each one is an image the user reviews. */
const MAX_RENDERED_PAGES = 12;

/** The pages to render, the first `MAX_RENDERED_PAGES` of those named. */
function normalizePages(value: unknown): number[] | undefined {
  return parsePageSelectionValue(value)?.pageIndexes.slice(
    0,
    MAX_RENDERED_PAGES,
  );
}

/**
 * Page rendering behind paper_read's `visual` and `capture` modes.
 *
 * Not a registered tool: paper_read owns the spec, presentation, invocation
 * plan, and follow-up message, and delegates these four steps here.
 */
export type PdfPageRenderer = {
  validate: (args: unknown) => AgentToolInputValidation<PdfPageRenderInput>;
  execute: (
    input: PdfPageRenderInput,
    context: AgentToolContext,
  ) => Promise<AgentToolExecutionOutput<unknown>>;
  createPendingAction: (
    input: PdfPageRenderInput,
    context: AgentToolContext,
  ) => Promise<AgentPendingAction>;
  applyConfirmation: (
    input: PdfPageRenderInput,
    resolutionData: unknown,
  ) => AgentToolInputValidation<PdfPageRenderInput>;
};

export function createPdfPageRenderer(
  pdfPageService: PdfPageService,
): PdfPageRenderer {
  return {
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const input: PdfPageRenderInput = {
        target: normalizeTarget(args.target),
        question:
          typeof args.question === "string" && args.question.trim()
            ? args.question.trim()
            : undefined,
        pages: normalizePages(args.pages),
        capture: args.capture === true,
        neighborPages: normalizePositiveInt(args.neighborPages),
      };
      if (!input.capture && !input.pages?.length && !input.question) {
        return fail(
          "Provide at least one of: question (to search pages), pages (to render), " +
            "or capture (to screenshot active view).",
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
          toolName: "paper_read",
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
          mode: "general",
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
          toolName: "paper_read",
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
        toolName: "paper_read",
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
        const pages = normalizePages(resolutionData.pageSelection);
        if (!pages?.length) {
          return fail("At least one page is required");
        }
        return ok({ ...input, pages });
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
          mode: "general",
          topK: 3,
        });
        pages = searchResult.pages.map((p) => p.pageIndex);
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
  };
}
