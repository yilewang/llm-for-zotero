import type { AgentToolDefinition } from "../../types";
import type { PdfService } from "../../services/pdfService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import { normalizeTarget, normalizeTargets, resolveDefaultTargets } from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";

type SearchPaperInput = {
  target?: PdfTarget;
  targets?: PdfTarget[];
  question?: string;
  topK?: number;
  perPaperTopK?: number;
};

const MAX_TARGETS = 10;

export function createSearchPaperTool(
  retrievalService: RetrievalService,
  pdfService: PdfService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchPaperInput, unknown> {
  return {
    spec: {
      name: "search_paper",
      description:
        "Search for specific evidence within papers using a question. " +
        "Returns the most relevant passages ranked by relevance. " +
        "Supports up to 10 papers per call. Automatically indexes PDFs if needed. If mineruCacheDir is available, first use file_io on MinerU manifest.json/full.md for summaries or section reads; use search_paper only for targeted evidence that MinerU did not already answer.",
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
            },
            additionalProperties: false,
          },
          targets: {
            type: "array",
            description: `Multiple target papers (max ${MAX_TARGETS}).`,
            items: {
              type: "object",
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
              },
              additionalProperties: false,
            },
          },
          question: {
            type: "string",
            description: "What to search for in the paper(s).",
          },
          topK: {
            type: "number",
            description: "Max total results to return (default 6).",
          },
          perPaperTopK: {
            type: "number",
            description: "Max results per paper (default 4).",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Search Paper",
      summaries: {
        onCall: "Searching for evidence in paper(s)",
        onSuccess: ({ content }) => {
          const c = content as { results?: unknown[] } | null;
          const count = Array.isArray(c?.results) ? c.results.length : 0;
          return count > 0
            ? `Retrieved ${count} evidence passage${count === 1 ? "" : "s"}`
            : "No matching evidence found";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const input: SearchPaperInput = {
        target: normalizeTarget(args.target),
        targets: normalizeTargets(args.targets, MAX_TARGETS),
        question:
          typeof args.question === "string" && args.question.trim()
            ? args.question.trim()
            : undefined,
        topK: normalizePositiveInt(args.topK),
        perPaperTopK: normalizePositiveInt(args.perPaperTopK),
      };
      if (input.targets && input.targets.length > MAX_TARGETS) {
        return fail(`targets supports at most ${MAX_TARGETS} papers`);
      }
      return ok(input);
    },
    execute: async (input, context) => {
      const papers = resolveDefaultTargets(
        input.target,
        input.targets,
        context,
        zoteroGateway,
        MAX_TARGETS,
      );
      if (!papers.length) {
        throw new Error("No paper context available for evidence retrieval");
      }

      // Auto-index any papers that need it
      for (const paper of papers) {
        try {
          await pdfService.ensurePaperContext(paper);
        } catch {
          // Best-effort: try indexing via gateway if text cache fails
          if (paper.contextItemId) {
            try {
              await zoteroGateway.indexPdfAttachment({
                attachmentId: paper.contextItemId,
              });
            } catch {
              // Indexing may fail for non-PDF items; continue with other papers
            }
          }
        }
      }

      return {
        results: await retrievalService.retrieveEvidence({
          papers,
          question: input.question || context.request.userText,
          apiBase: context.request.apiBase,
          apiKey: context.request.apiKey,
          topK: input.topK,
          perPaperTopK: input.perPaperTopK,
        }),
      };
    },
  };
}
