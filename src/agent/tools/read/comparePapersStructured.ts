import type { PaperContextRef } from "../../../modules/contextPanel/types";
import type { PdfService } from "../../services/pdfService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import {
  fail,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import { classifyRequest } from "../../model/requestClassifier";

type ComparePapersStructuredInput = {
  paperContexts?: PaperContextRef[];
  question?: string;
};

type ComparisonRowConfig = {
  id:
    | "research_question"
    | "main_claim"
    | "method"
    | "dataset_or_materials"
    | "results"
    | "limitations";
  label: string;
  query: string;
  keywords: string[];
  allowFrontMatterFallback?: boolean;
};

type ComparisonEvidence = {
  source: "retrieval" | "front_matter" | "metadata";
  excerpt: string;
  chunkIndex?: number;
  sectionLabel?: string;
  score?: number;
};

const COMPARISON_ROWS: ComparisonRowConfig[] = [
  {
    id: "research_question",
    label: "Research question",
    query: "What research question, objective, or problem does this paper address?",
    keywords: ["objective", "question", "problem", "we study", "we investigate"],
    allowFrontMatterFallback: true,
  },
  {
    id: "main_claim",
    label: "Main claim",
    query: "What is the main claim, contribution, or conclusion of this paper?",
    keywords: ["we show", "we find", "conclude", "contribution", "this paper"],
    allowFrontMatterFallback: true,
  },
  {
    id: "method",
    label: "Method",
    query: "What method, approach, model, or experimental setup does this paper use?",
    keywords: ["method", "approach", "model", "framework", "we propose"],
    allowFrontMatterFallback: true,
  },
  {
    id: "dataset_or_materials",
    label: "Dataset or materials",
    query: "What dataset, corpus, benchmark, samples, or materials does this paper use?",
    keywords: ["dataset", "corpus", "benchmark", "sample", "participants", "materials"],
    allowFrontMatterFallback: true,
  },
  {
    id: "results",
    label: "Results",
    query: "What are the main results, findings, or performance outcomes of this paper?",
    keywords: ["result", "finding", "outperform", "accuracy", "improve"],
  },
  {
    id: "limitations",
    label: "Limitations",
    query: "What limitations, caveats, or future work does this paper mention?",
    keywords: ["limitation", "future work", "however", "caveat", "restricted"],
  },
];

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function normalizeExcerpt(value: unknown, max = 320): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function normalizeSummary(value: unknown, max = 220): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

function pickSentence(
  text: string,
  keywords: string[],
): string {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return "";
  const lowerKeywords = keywords.map((entry) => entry.toLowerCase());
  const keywordMatch = sentences.find((sentence) => {
    const normalized = sentence.toLowerCase();
    return lowerKeywords.some((keyword) => normalized.includes(keyword));
  });
  return keywordMatch || sentences[0] || "";
}

function normalizePaperContextsInput(value: unknown): PaperContextRef[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) =>
      validateObject<Record<string, unknown>>(entry)
        ? normalizeToolPaperContext(entry)
        : null,
    )
    .filter((entry): entry is PaperContextRef => Boolean(entry));
  return out.length ? out : null;
}

function dedupePaperContexts(papers: PaperContextRef[]): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const paper of papers) {
    const key = `${paper.itemId}:${paper.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(paper);
  }
  return out;
}

function collectDefaultPaperContexts(
  context: Parameters<
    AgentToolDefinition<ComparePapersStructuredInput, unknown>["execute"]
  >[1],
  pdfService: PdfService,
  zoteroGateway: ZoteroGateway,
): PaperContextRef[] {
  const out = dedupePaperContexts([
    ...(Array.isArray(context.request.selectedPaperContexts)
      ? context.request.selectedPaperContexts
      : []),
    ...(Array.isArray(context.request.pinnedPaperContexts)
      ? context.request.pinnedPaperContexts
      : []),
  ]);
  const activeItem =
    zoteroGateway.getItem(context.request.activeItemId) || context.item || null;
  const metadataItem = zoteroGateway.resolveMetadataItem({
    request: context.request,
    item: activeItem,
  });
  const activePaperContext = pdfService.getPaperContextForItem(metadataItem);
  if (!activePaperContext) return out;
  return dedupePaperContexts([...out, activePaperContext]);
}

async function readFrontMatterText(
  pdfService: PdfService,
  paperContext: PaperContextRef,
): Promise<string> {
  try {
    const result = await pdfService.getFrontMatterExcerpt({
      paperContext,
      maxChunks: 2,
      maxChars: 1600,
    });
    return normalizeText(result.text);
  } catch (_error) {
    void _error;
    return "";
  }
}

function buildMetadataFallback(
  row: ComparisonRowConfig,
  paperContext: PaperContextRef,
): string {
  if (row.id === "research_question") {
    return normalizeSummary(paperContext.title);
  }
  return "";
}

function buildSummaryFromEvidence(params: {
  row: ComparisonRowConfig;
  evidence: ComparisonEvidence[];
  frontMatterText: string;
  metadataFallback: string;
}): string {
  for (const entry of params.evidence) {
    const sentence = pickSentence(entry.excerpt, params.row.keywords);
    if (sentence) return normalizeSummary(sentence);
  }
  if (params.row.allowFrontMatterFallback && params.frontMatterText) {
    const sentence = pickSentence(params.frontMatterText, params.row.keywords);
    if (sentence) return normalizeSummary(sentence);
  }
  if (params.metadataFallback) {
    return normalizeSummary(params.metadataFallback);
  }
  return "";
}

function buildCrossPaperSummary(params: {
  rows: Array<{
    id: ComparisonRowConfig["id"];
    label: string;
    cells: Array<{ summary: string }>;
  }>;
  papers: PaperContextRef[];
}): {
  similarities: string[];
  differences: string[];
  openQuestions: string[];
} {
  const similarities: string[] = [];
  const differences: string[] = [];
  const openQuestions: string[] = [];
  for (const row of params.rows) {
    const populated = row.cells.filter((cell) => Boolean(cell.summary));
    if (populated.length === params.papers.length && populated.length >= 2) {
      similarities.push(
        `All selected papers include grounded material for ${row.label.toLowerCase()}.`,
      );
    }
    if (populated.length >= 2) {
      const unique = new Set(
        populated.map((cell) => cell.summary.toLowerCase().replace(/[^\w\s]/g, "")),
      );
      if (unique.size > 1) {
        differences.push(`${row.label} differs across the selected papers.`);
      }
    }
    const sparseTitles = row.cells
      .map((cell, index) =>
        cell.summary ? "" : params.papers[index]?.title || `Paper ${index + 1}`,
      )
      .filter(Boolean);
    if (sparseTitles.length) {
      openQuestions.push(
        `Need stronger evidence for ${row.label.toLowerCase()} in ${sparseTitles.join(", ")}.`,
      );
    }
  }
  return {
    similarities: similarities.slice(0, 3),
    differences: differences.slice(0, 3),
    openQuestions: openQuestions.slice(0, 3),
  };
}

function buildEvidenceEntry(
  value: {
    text: string;
    chunkIndex?: number;
    sectionLabel?: string;
    score?: number;
  },
  source: ComparisonEvidence["source"],
): ComparisonEvidence {
  return {
    source,
    excerpt: normalizeExcerpt(value.text),
    ...(value.chunkIndex !== undefined ? { chunkIndex: value.chunkIndex } : {}),
    ...(value.sectionLabel ? { sectionLabel: value.sectionLabel } : {}),
    ...(value.score !== undefined ? { score: value.score } : {}),
  };
}


export function createComparePapersStructuredTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ComparePapersStructuredInput, unknown> {
  return {
    spec: {
      name: "compare_papers_structured",
      description:
        "Build a fixed, evidence-backed comparison table across 2-6 papers using retrieval and front-matter fallbacks.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          paperContexts: {
            type: "array",
            items: {
              type: "object",
              required: ["itemId", "contextItemId"],
              additionalProperties: true,
              properties: {
                itemId: { type: "number" },
                contextItemId: { type: "number" },
                title: { type: "string" },
              },
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) => {
        const intent = classifyRequest(request);
        return intent.isComparisonQuery && intent.hasMultiplePaperContexts;
      },
      instruction:
        "When the user asks to compare multiple papers, prefer compare_papers_structured so the evidence is organized into fixed comparison rows.",
    },
    presentation: {
      label: "Compare Papers",
      summaries: {
        onCall: "Building a structured comparison across the selected papers",
        onSuccess: ({ content }) => {
          const paperCount =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { papers?: unknown }).papers)
              ? (content as { papers: unknown[] }).papers.length
              : 0;
          return paperCount > 0
            ? `Built a structured comparison for ${paperCount} paper${
                paperCount === 1 ? "" : "s"
              }`
            : "Built the structured comparison";
        },
      },
      buildChips: ({ args }) => {
        const record = validateObject<Record<string, unknown>>(args) ? args : null;
        const paperContexts = normalizePaperContextsInput(record?.paperContexts);
        return paperContexts && paperContexts.length
          ? [
              {
                icon: "📚",
                label: `${paperContexts.length} papers`,
              },
            ]
          : [];
      },
    },
    validate: (args) => {
      if (args === undefined) {
        return ok<ComparePapersStructuredInput>({});
      }
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const question =
        typeof args.question === "string" && args.question.trim()
          ? args.question.trim()
          : undefined;
      const paperContexts = normalizePaperContextsInput(args.paperContexts) || undefined;
      return ok<ComparePapersStructuredInput>({
        question,
        paperContexts,
      });
    },
    execute: async (input, context) => {
      const papers = dedupePaperContexts(
        input.paperContexts?.length
          ? input.paperContexts
          : collectDefaultPaperContexts(context, pdfService, zoteroGateway),
      );
      if (papers.length < 2) {
        throw new Error("compare_papers_structured requires at least 2 papers");
      }
      if (papers.length > 6) {
        throw new Error("compare_papers_structured supports at most 6 papers");
      }

      const question =
        normalizeText(input.question) || normalizeText(context.request.userText);
      const frontMatterByPaperKey = new Map<string, string>();
      for (const paper of papers) {
        frontMatterByPaperKey.set(
          `${paper.itemId}:${paper.contextItemId}`,
          await readFrontMatterText(pdfService, paper),
        );
      }

      const rows = [];
      for (const row of COMPARISON_ROWS) {
        const cells = [];
        for (const paper of papers) {
          const paperKey = `${paper.itemId}:${paper.contextItemId}`;
          let retrievalEvidence: ComparisonEvidence[] = [];
          try {
            const evidence = await retrievalService.retrieveEvidence({
              papers: [paper],
              question: question
                ? `${question}\n\nFocus: ${row.query}`
                : row.query,
              apiBase: context.request.apiBase,
              apiKey: context.request.apiKey,
              topK: 2,
              perPaperTopK: 2,
            });
            retrievalEvidence = evidence.slice(0, 2).map((entry) =>
              buildEvidenceEntry(
                {
                  text: entry.text,
                  chunkIndex: entry.chunkIndex,
                  sectionLabel: entry.sectionLabel,
                  score: entry.score,
                },
                "retrieval",
              ),
            );
          } catch (_error) {
            void _error;
          }
          const frontMatterText = frontMatterByPaperKey.get(paperKey) || "";
          let evidence = retrievalEvidence.slice();
          let status: "grounded" | "fallback" | "empty" = evidence.length
            ? "grounded"
            : "empty";
          if (!evidence.length && row.allowFrontMatterFallback && frontMatterText) {
            evidence = [buildEvidenceEntry({ text: frontMatterText }, "front_matter")];
            status = "fallback";
          }
          const metadataFallback = buildMetadataFallback(row, paper);
          if (!evidence.length && metadataFallback) {
            evidence = [buildEvidenceEntry({ text: metadataFallback }, "metadata")];
            status = "fallback";
          }
          const summary = buildSummaryFromEvidence({
            row,
            evidence,
            frontMatterText,
            metadataFallback,
          });
          if (!summary) {
            status = "empty";
          }
          cells.push({
            itemId: paper.itemId,
            contextItemId: paper.contextItemId,
            summary,
            status,
            evidence,
          });
        }
        rows.push({
          id: row.id,
          label: row.label,
          cells,
        });
      }

      return {
        question,
        papers,
        rows,
        crossPaperSummary: buildCrossPaperSummary({
          rows,
          papers,
        }),
      };
    },
  };
}
