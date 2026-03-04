import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { sanitizeText } from "../../textUtils";
import type { AgentToolCall, AgentToolExecutionContext, AgentToolExecutionResult } from "./types";

const SEMANTIC_SCHOLAR_SEARCH_URL =
  "https://api.semanticscholar.org/graph/v1/paper/search";
const SEMANTIC_SCHOLAR_FIELDS =
  "title,authors,year,abstract,externalIds,openAccessPdf";
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;
const ABSTRACT_PREVIEW_CHARS = 300;
const FETCH_TIMEOUT_MS = 10_000;

type SemanticScholarPaper = {
  paperId?: string;
  title?: string;
  year?: number | null;
  authors?: { name?: string }[];
  abstract?: string | null;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  openAccessPdf?: { url?: string } | null;
};

type SemanticScholarResponse = {
  total?: number;
  data?: SemanticScholarPaper[];
};

export function validateSearchInternetCall(call: AgentToolCall): AgentToolCall | null {
  if (call.name !== "search_internet") return null;
  const query = sanitizeText(call.query || "").trim();
  if (!query) return null;
  const rawLimit = Number(call.limit || 0);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
      : DEFAULT_LIMIT;
  return { name: "search_internet", query, limit };
}

function formatAuthors(authors: { name?: string }[] | undefined): string {
  if (!authors?.length) return "Unknown authors";
  const names = authors
    .slice(0, 3)
    .map((a) => a.name || "")
    .filter(Boolean);
  const suffix = authors.length > 3 ? ` et al.` : "";
  return names.join(", ") + suffix;
}

function formatPaperEntry(paper: SemanticScholarPaper, index: number): string {
  const title = sanitizeText(paper.title || "(untitled)").trim();
  const authors = formatAuthors(paper.authors);
  const year = paper.year ? String(paper.year) : "n.d.";
  const doi = paper.externalIds?.DOI;
  const arxiv = paper.externalIds?.ArXiv;
  const pdfUrl = paper.openAccessPdf?.url;
  const rawAbstract = sanitizeText(paper.abstract || "").trim();
  const abstract = rawAbstract.length > ABSTRACT_PREVIEW_CHARS
    ? rawAbstract.slice(0, ABSTRACT_PREVIEW_CHARS) + "\u2026"
    : rawAbstract;

  const urlParts: string[] = [];
  if (doi) urlParts.push(`DOI: ${doi}`);
  else if (arxiv) urlParts.push(`arXiv: ${arxiv}`);
  else if (pdfUrl) urlParts.push(`PDF: ${pdfUrl}`);

  const lines = [
    `[${index + 1}] ${title} (${year})`,
    `    Authors: ${authors}`,
    abstract ? `    Abstract: ${abstract}` : null,
    urlParts.length ? `    ${urlParts.join(" | ")}` : null,
  ].filter((l): l is string => l !== null);

  return lines.join("\n");
}

export async function executeSearchInternetCall(
  call: AgentToolCall,
  ctx: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const query = sanitizeText(call.query || "").trim();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(call.limit || DEFAULT_LIMIT))));

  const errorResult = (message: string): AgentToolExecutionResult => ({
    name: "search_internet",
    targetLabel: `internet: "${query}"`,
    ok: false,
    traceLines: [message],
    groundingText: "",
    addedPaperContexts: [],
    estimatedTokens: 0,
    truncated: false,
  });

  if (!query) return errorResult("Search skipped because query was empty.");

  ctx.onStatus?.(`Searching Semantic Scholar for "${query}"\u2026`);

  const url = new URL(SEMANTIC_SCHOLAR_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", SEMANTIC_SCHOLAR_FIELDS);

  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const AbortControllerCtor = ztoolkit.getGlobal("AbortController") as
    | (new () => AbortController)
    | undefined;

  let data: SemanticScholarResponse;
  try {
    let response: Response;
    if (AbortControllerCtor) {
      const controller = new AbortControllerCtor();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      response = await fetchFn(url.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
    } else {
      response = await fetchFn(url.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
    }
    if (!response.ok) {
      return errorResult(`Semantic Scholar returned HTTP ${response.status}.`);
    }
    data = (await response.json()) as SemanticScholarResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Internet search failed: ${msg}`);
  }

  const papers = (data.data || []).slice(0, limit);

  if (!papers.length) {
    const groundingText = [
      "Agent Tool Result",
      "- Tool: search_internet",
      `- Query: ${query}`,
      "- Results: 0",
      "",
      `No results were found on Semantic Scholar for the query "${query}".`,
    ].join("\n");
    return {
      name: "search_internet",
      targetLabel: `internet: "${query}"`,
      ok: true,
      traceLines: [`No results found for "${query}" on Semantic Scholar.`],
      groundingText,
      addedPaperContexts: [],
      estimatedTokens: estimateTextTokens(groundingText),
      truncated: false,
    };
  }

  const total = data.total ?? papers.length;
  const paperEntries = papers.map((p, i) => formatPaperEntry(p, i));

  const groundingLines = [
    "Agent Tool Result",
    "- Tool: search_internet",
    `- Query: ${query}`,
    `- Results returned: ${papers.length} (total matches: ${total})`,
    "",
    `Semantic Scholar search results for "${query}":`,
    "",
    ...paperEntries.flatMap((entry) => [entry, ""]),
  ];

  const groundingText = groundingLines.join("\n");
  const estimatedTokens = estimateTextTokens(groundingText);

  return {
    name: "search_internet",
    targetLabel: `internet: "${query}"`,
    ok: true,
    traceLines: [
      `Found ${papers.length} result${papers.length !== 1 ? "s" : ""} for "${query}" on Semantic Scholar.`,
    ],
    groundingText,
    addedPaperContexts: [],
    estimatedTokens,
    truncated: papers.length < total,
  };
}
