import type { PaperContextRef } from "../../../shared/types";
import type { AgentToolDefinition } from "../../types";
import type { PdfService } from "../../services/pdfService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import {
  normalizeTarget,
  normalizeTargets,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";

type ReadPaperInput = {
  target?: PdfTarget;
  targets?: PdfTarget[];
  chunkIndexes?: number[];
  maxChunks?: number;
  maxChars?: number;
};

const MAX_TARGETS = 20;

export function createReadPaperTool(
  pdfService: PdfService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ReadPaperInput, unknown> {
  return {
    spec: {
      name: "read_paper",
      description:
        "Read text content from a PDF. By default reads the opening sections " +
        "(abstract and introduction). Use chunkIndexes to read specific sections " +
        "by index. Supports up to 20 papers per call.",
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
                description:
                  "Zotero attachment item ID (from paper context or query results)",
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
            description: `Multiple target papers (max ${MAX_TARGETS}). Same shape as target.`,
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
          chunkIndexes: {
            type: "array",
            items: { type: "number" },
            description: "Read specific chunks by index (single paper only).",
          },
          maxChunks: {
            type: "number",
            description: "Max chunks to read per paper (default 2).",
          },
          maxChars: {
            type: "number",
            description: "Max chars to read per paper (default 4000).",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Read Paper",
      summaries: {
        onCall: ({ args }) => {
          const a = args as Record<string, unknown> | null;
          if (a?.chunkIndexes) return "Reading specific paper chunks";
          const count = Array.isArray(a?.targets) ? a.targets.length : 1;
          return count > 1 ? `Reading ${count} papers` : "Reading paper";
        },
        onSuccess: ({ content }) => {
          const c = content as { results?: unknown[] } | null;
          const count = Array.isArray(c?.results) ? c.results.length : 1;
          return count > 1 ? `Read ${count} papers` : "Read paper content";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const input: ReadPaperInput = {
        target: normalizeTarget(args.target),
        targets: normalizeTargets(args.targets, MAX_TARGETS),
        chunkIndexes: normalizePositiveIntArray(args.chunkIndexes) || undefined,
        maxChunks: normalizePositiveInt(args.maxChunks),
        maxChars: normalizePositiveInt(args.maxChars),
      };
      if (input.targets && input.targets.length > MAX_TARGETS) {
        return fail(`targets supports at most ${MAX_TARGETS} papers`);
      }
      if (
        input.chunkIndexes?.length &&
        input.targets &&
        input.targets.length > 1
      ) {
        return fail("chunkIndexes can only be used with a single paper target");
      }
      return ok(input);
    },
    execute: async (input, context) => {
      if (input.chunkIndexes?.length) {
        // Read specific chunks from a single paper
        const paperContext =
          input.target?.paperContext ||
          resolveDefaultTargets(
            input.target,
            input.targets,
            context,
            zoteroGateway,
            1,
          )[0];
        if (!paperContext) {
          throw new Error("No paper context available for chunk reading");
        }
        return {
          results: await Promise.all(
            input.chunkIndexes.map((chunkIndex) =>
              pdfService.getChunkExcerpt({ paperContext, chunkIndex }),
            ),
          ),
        };
      }

      // Read opening sections (front matter) for one or more papers
      const papers = resolveDefaultTargets(
        input.target,
        input.targets,
        context,
        zoteroGateway,
        MAX_TARGETS,
      );
      if (!papers.length) {
        throw new Error("No paper context available for reading");
      }
      const results = [];
      for (const paperContext of papers) {
        results.push(
          await pdfService.getFrontMatterExcerpt({
            paperContext,
            maxChunks: input.maxChunks,
            maxChars: input.maxChars,
          }),
        );
      }
      return { results };
    },
  };
}
