import type { AgentToolDefinition } from "../../types";
import type { PdfPageService } from "../../services/pdfPageService";
import {
  buildPdfToolSchemaProperties,
  parsePdfTargetArgs,
  requireQuestionOrPages,
  type PdfTargetArgs,
} from "./pdfToolShared";
import { classifyRequest } from "../../model/requestClassifier";

export function createSearchPdfPagesTool(
  pdfPageService: PdfPageService,
): AgentToolDefinition<PdfTargetArgs, unknown> {
  return {
    spec: {
      name: "search_pdf_pages",
      description:
        "Locate the most relevant PDF pages for a question, figure, equation, or explicit page request. Use this before sending PDF pages to the model.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: buildPdfToolSchemaProperties(),
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isPdfVisualQuery,
      instruction: [
        "When the user asks about a figure, equation, table, page layout, or any PDF-specific visual detail, use the PDF tools instead of guessing from text alone.",
        "If the user names a specific numbered equation, figure, or table (e.g. 'explain equation 3', 'what is Figure 2', 'eq. 4') OR refers to something visible in the reader ('this equation', 'explain this', 'what I see'), call capture_reader_view — it captures exactly the page open in the reader, so it cannot pick the wrong page the way keyword search can. It handles its own confirmation; after the result returns, the page text and image are in the follow-up message — read them and answer directly.",
        "Only use search_pdf_pages when the user does NOT have a PDF open in the reader and is asking a general question that requires locating a page (e.g. 'find the section about plasticity').",
        "If the user explicitly names page numbers, call prepare_pdf_pages_for_model directly without search.",
        "Only use prepare_pdf_file_for_model when the user explicitly asks to inspect the entire PDF or whole document.",
      ].join("\n"),
    },
    presentation: {
      label: "Search PDF Pages",
      summaries: {
        onCall: "Locating the most relevant PDF pages",
        onSuccess: ({ content }) => {
          const pages =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { pages?: unknown }).pages)
              ? (content as { pages: unknown[] }).pages
              : [];
          return pages.length > 0
            ? `Located ${pages.length} relevant PDF page${
                pages.length === 1 ? "" : "s"
              }`
            : "Could not find relevant PDF pages";
        },
      },
    },
    validate: (args) => {
      const parsed = parsePdfTargetArgs(args);
      if (!parsed.ok) return parsed;
      return requireQuestionOrPages(parsed.value);
    },
    execute: async (input, context) => {
      const result = await pdfPageService.searchPages({
        request: context.request,
        paperContext: input.paperContext,
        itemId: input.itemId,
        contextItemId: input.contextItemId,
        attachmentId: input.attachmentId,
        name: input.name,
        question: input.question || input.reason || context.request.userText,
        pages: input.pages,
        mode: input.mode,
        topK: input.topK,
      });
      return {
        target: {
          source: result.target.source,
          title: result.target.title,
          paperContext: result.target.paperContext,
          contextItemId: result.target.contextItemId,
          itemId: result.target.itemId,
          attachmentId: result.target.attachmentId,
        },
        explicitSelection: result.explicitSelection,
        pages: result.pages.map((page) => ({
          pageIndex: page.pageIndex,
          pageLabel: page.pageLabel,
          score: page.score,
          reason: page.reason,
          excerpt: page.excerpt,
        })),
      };
    },
  };
}
