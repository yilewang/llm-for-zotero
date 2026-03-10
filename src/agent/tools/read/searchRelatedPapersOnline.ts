import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import type { PaperContextRef } from "../../../modules/contextPanel/types";

export type SearchMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search";

type SearchRelatedPapersOnlineInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  query?: string;
  mode?: SearchMode;
  limit?: number;
  libraryID?: number;
};

export type OnlinePaperResult = {
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  doi?: string;
  arxivId?: string;
  citationCount?: number;
  openAccessUrl?: string;
  s2Url?: string;
};

const S2_FIELDS =
  "title,authors,year,abstract,externalIds,citationCount,openAccessPdf";

const USER_AGENT =
  "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)";

async function s2Fetch(url: string): Promise<unknown> {
  const response = await (
    globalThis as typeof globalThis & {
      fetch?: (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    }
  ).fetch!(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Semantic Scholar HTTP ${response.status}`);
  }
  return response.json();
}

function normStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normPaper(raw: unknown): OnlinePaperResult | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const title = normStr(p.title);
  if (!title) return null;
  const authorArr = Array.isArray(p.authors)
    ? (p.authors as Array<{ name?: string }>)
    : [];
  const authors = authorArr.map((a) => normStr(a.name)).filter(Boolean);
  const year =
    typeof p.year === "number" && p.year > 0 ? p.year : undefined;
  const abstractRaw = normStr(p.abstract);
  const abstract = abstractRaw
    ? abstractRaw.slice(0, 400) + (abstractRaw.length > 400 ? "\u2026" : "")
    : undefined;
  const extIds = (p.externalIds || {}) as Record<string, string>;
  const doi = normStr(extIds.DOI || extIds.doi) || undefined;
  const arxivId = normStr(extIds.ArXiv || extIds.arxiv) || undefined;
  const citationCount =
    typeof p.citationCount === "number" ? p.citationCount : undefined;
  const openAccess = p.openAccessPdf as
    | { url?: string }
    | string
    | null
    | undefined;
  const openAccessUrl =
    (typeof openAccess === "object" && openAccess
      ? normStr(openAccess.url)
      : normStr(openAccess)) || undefined;
  const paperId = normStr(p.paperId) || undefined;
  const s2Url = paperId
    ? `https://www.semanticscholar.org/paper/${paperId}`
    : undefined;
  return { title, authors, year, abstract, doi, arxivId, citationCount, openAccessUrl, s2Url };
}

/** Look up a paper's S2 paperId via its DOI. Returns null on failure. */
async function resolveS2Id(doi: string): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(doi);
    const raw = (await s2Fetch(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encoded}?fields=paperId`,
    )) as { paperId?: unknown };
    const id = normStr(raw?.paperId);
    return id || null;
  } catch {
    return null;
  }
}

/** Get AI-powered recommendations for a paper. */
async function fetchRecommendations(
  s2Id: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2Fetch(
    `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(s2Id)}?fields=${S2_FIELDS}&limit=${limit}`,
  )) as { recommendedPapers?: unknown[] };
  return (raw.recommendedPapers || [])
    .map(normPaper)
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

/** Get papers that this paper cites (its reference list). */
async function fetchReferences(
  s2Id: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2Fetch(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Id)}/references?fields=${S2_FIELDS}&limit=${limit}`,
  )) as { data?: Array<{ citedPaper?: unknown }> };
  return (raw.data || [])
    .map((entry) => normPaper(entry.citedPaper))
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

/** Get papers that cite this paper. Sorted by citation count descending. */
async function fetchCitations(
  s2Id: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2Fetch(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Id)}/citations?fields=${S2_FIELDS}&limit=${limit}`,
  )) as { data?: Array<{ citingPaper?: unknown }> };
  const results = (raw.data || [])
    .map((entry) => normPaper(entry.citingPaper))
    .filter((p): p is OnlinePaperResult => Boolean(p));
  return results.sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
}

/** Keyword / full-text search across Semantic Scholar. */
async function fetchKeywordSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const encoded = encodeURIComponent(query);
  const raw = (await s2Fetch(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&fields=${S2_FIELDS}&limit=${limit}`,
  )) as { data?: unknown[] };
  return (raw.data || [])
    .map(normPaper)
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

function modeLabel(mode: SearchMode): string {
  switch (mode) {
    case "recommendations":
      return "recommended similar papers";
    case "references":
      return "papers referenced by this paper";
    case "citations":
      return "papers that cite this paper";
    case "search":
      return "keyword search results";
  }
}

export function createSearchRelatedPapersOnlineTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchRelatedPapersOnlineInput, unknown> {
  return {
    spec: {
      name: "search_related_papers_online",
      description:
        "Find related or similar papers on the internet using Semantic Scholar. " +
        "Supports four modes: " +
        "'recommendations' (AI-recommended papers similar to the given paper), " +
        "'references' (papers this paper cites — its reference list), " +
        "'citations' (papers that cite this paper, sorted by citation count), " +
        "'search' (free-text keyword search). " +
        "Resolves the active paper's DOI automatically when no explicit doi or query is given.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: {
            type: "number",
            description: "Zotero item ID to look up DOI from; defaults to active paper",
          },
          paperContext: {
            type: "object",
            additionalProperties: true,
            required: ["itemId", "contextItemId"],
            properties: {
              itemId: { type: "number" },
              contextItemId: { type: "number" },
              title: { type: "string" },
            },
          },
          doi: {
            type: "string",
            description: "Explicit DOI to use instead of resolving from Zotero",
          },
          query: {
            type: "string",
            description:
              "Free-text search query (required when mode is 'search', or as fallback when DOI is unavailable)",
          },
          mode: {
            type: "string",
            enum: ["recommendations", "references", "citations", "search"],
            description:
              "Which Semantic Scholar API to call. Defaults to 'recommendations'.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10, max 25)",
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) => {
        const text = (request.userText || "").toLowerCase();
        return (
          /\b(related|similar|recommend|find papers?|search papers?|literature|who cites|citing|cite this|references? of|based on|inspired by|follow.?up|follow up)\b/.test(
            text,
          ) ||
          /\b(papers? (about|on|similar|related)|more (papers?|research|work|studies)|find (more|new) papers?)\b/.test(
            text,
          )
        );
      },
      instruction: [
        "When the user asks to find related papers, similar papers, recommendations, papers that cite this work, or papers referenced by this work, use search_related_papers_online.",
        "Use mode='recommendations' for general 'find related/similar papers' requests.",
        "Use mode='citations' to answer 'who cites this paper' or 'how influential is this paper'.",
        "Use mode='references' to answer 'what papers does this cite' or 'what is in the reference list'.",
        "Use mode='search' for free-text topic searches not tied to a specific paper.",
        "When the active paper has a DOI, pass it via the doi field for accurate results; otherwise rely on the query field.",
      ].join("\n"),
    },
    presentation: {
      label: "Search Related Papers Online",
      summaries: {
        onCall: ({ args }) => {
          const mode = (args as { mode?: string })?.mode || "recommendations";
          return `Searching Semantic Scholar for ${modeLabel(mode as SearchMode)}`;
        },
        onSuccess: ({ content }) => {
          const results = content && typeof content === "object"
            ? ((content as { results?: unknown[] }).results?.length ?? 0)
            : 0;
          return results > 0
            ? `Found ${results} related paper${results === 1 ? "" : "s"} online`
            : "No results found online";
        },
        onEmpty: "No results found on Semantic Scholar",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const paperContext = validateObject<Record<string, unknown>>(
        args.paperContext,
      )
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      const rawMode = typeof args.mode === "string" ? args.mode.trim() : "";
      const mode: SearchMode =
        rawMode === "references" ||
        rawMode === "citations" ||
        rawMode === "search" ||
        rawMode === "recommendations"
          ? (rawMode as SearchMode)
          : "recommendations";
      const rawLimit = normalizePositiveInt(args.limit);
      const limit =
        rawLimit !== undefined ? Math.min(rawLimit, 25) : 10;
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : undefined;
      if (mode === "search" && !doi && !query) {
        return fail("query is required when mode is 'search'");
      }
      return ok<SearchRelatedPapersOnlineInput>({
        itemId: normalizePositiveInt(args.itemId),
        paperContext,
        doi,
        query,
        mode,
        limit,
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    execute: async (input, context) => {
      const mode = input.mode ?? "recommendations";
      const limit = input.limit ?? 10;

      // Resolve DOI: explicit > Zotero item > active paper
      let doi = input.doi;
      let titleFallback = input.query;

      if (!doi) {
        const metadataItem = zoteroGateway.resolveMetadataItem({
          request: context.request,
          item: context.item,
          itemId: input.itemId ?? input.paperContext?.itemId,
          paperContext: input.paperContext,
        });
        if (metadataItem) {
          const snapshot = zoteroGateway.getEditableArticleMetadata(metadataItem);
          if (snapshot?.fields.DOI) {
            doi = snapshot.fields.DOI.trim();
          }
          if (!titleFallback && snapshot?.title) {
            titleFallback = snapshot.title.trim();
          }
        }
      }

      // Keyword search path — no DOI needed
      if (mode === "search") {
        const q = input.query || titleFallback;
        if (!q) {
          return { results: [], message: "No search query available." };
        }
        const results = await fetchKeywordSearch(q, limit);
        return {
          mode,
          query: q,
          results,
          total: results.length,
          source: "Semantic Scholar",
        };
      }

      // For recommendations / references / citations we need an S2 paper ID
      if (!doi) {
        // Fall back to keyword search using the paper title
        if (titleFallback) {
          const results = await fetchKeywordSearch(titleFallback, limit);
          return {
            mode: "search",
            query: titleFallback,
            results,
            total: results.length,
            source: "Semantic Scholar",
            note: "DOI unavailable — returned keyword search results instead.",
          };
        }
        throw new Error(
          "No DOI found for the active paper. Provide a doi or query explicitly.",
        );
      }

      const s2Id = await resolveS2Id(doi);
      if (!s2Id) {
        // DOI not in S2 — fall back to title search
        if (titleFallback) {
          const results = await fetchKeywordSearch(titleFallback, limit);
          return {
            mode: "search",
            query: titleFallback,
            results,
            total: results.length,
            source: "Semantic Scholar",
            note: "Paper not found in Semantic Scholar by DOI — returned keyword search results instead.",
          };
        }
        throw new Error(
          `Paper with DOI "${doi}" was not found on Semantic Scholar.`,
        );
      }

      let results: OnlinePaperResult[] = [];
      if (mode === "recommendations") {
        results = await fetchRecommendations(s2Id, limit);
      } else if (mode === "references") {
        results = await fetchReferences(s2Id, limit);
      } else {
        results = await fetchCitations(s2Id, limit);
      }

      return {
        mode,
        doi,
        s2Id,
        results,
        total: results.length,
        source: "Semantic Scholar",
        s2PaperUrl: `https://www.semanticscholar.org/paper/${s2Id}`,
      };
    },
  };
}
