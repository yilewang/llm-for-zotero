import type { AgentToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";

type LookupExternalMetadataInput = {
  doi?: string;
  title?: string;
  arxivId?: string;
};

type ExternalMetadataResult = {
  source: string;
  doi?: string;
  title?: string;
  authors?: string[];
  year?: string | number;
  abstract?: string;
  venue?: string;
  citationCount?: number;
  url?: string;
  type?: string;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await (
    globalThis as typeof globalThis & {
      fetch?: (
        url: string,
        init?: { headers?: Record<string, string>; signal?: AbortSignal },
      ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    }
  ).fetch!(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function lookupCrossRefByDoi(
  doi: string,
): Promise<ExternalMetadataResult | null> {
  try {
    const encodedDoi = encodeURIComponent(doi);
    const data = (await fetchJson(
      `https://api.crossref.org/works/${encodedDoi}`,
    )) as { message?: Record<string, unknown> };
    const msg = data?.message;
    if (!msg) return null;
    const titleArr = Array.isArray(msg.title) ? (msg.title as string[]) : [];
    const title = titleArr[0] ? stripHtmlTags(titleArr[0]) : undefined;
    const authorArr = Array.isArray(msg.author)
      ? (msg.author as Array<{ given?: string; family?: string; name?: string }>)
      : [];
    const authors = authorArr
      .map((a) =>
        a.name
          ? a.name
          : [a.given, a.family].filter(Boolean).join(" "),
      )
      .filter(Boolean);
    const publishedParts = (
      msg["published-print"] ||
      msg["published-online"] ||
      msg.published
    ) as { "date-parts"?: number[][] } | undefined;
    const year = publishedParts?.["date-parts"]?.[0]?.[0];
    const containerArr = Array.isArray(msg["container-title"])
      ? (msg["container-title"] as string[])
      : [];
    const venue = containerArr[0]
      ? stripHtmlTags(containerArr[0])
      : undefined;
    const abstractRaw = normalizeString(msg.abstract);
    return {
      source: "CrossRef",
      doi: normalizeString(msg.DOI) || doi,
      title,
      authors,
      year: year ?? undefined,
      abstract: abstractRaw ? stripHtmlTags(abstractRaw).slice(0, 600) : undefined,
      venue,
      type: normalizeString(msg.type) || undefined,
      url: normalizeString(msg.URL) || undefined,
    };
  } catch (_error) {
    void _error;
    return null;
  }
}

async function searchCrossRef(
  query: string,
): Promise<ExternalMetadataResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const data = (await fetchJson(
      `https://api.crossref.org/works?query.bibliographic=${encoded}&rows=3&select=DOI,title,author,published-print,published-online,abstract,container-title,type,URL`,
    )) as {
      message?: { items?: unknown[] };
    };
    const items = data?.message?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const msg = item as Record<string, unknown>;
        const titleArr = Array.isArray(msg.title) ? (msg.title as string[]) : [];
        const title = titleArr[0] ? stripHtmlTags(titleArr[0]) : undefined;
        const authorArr = Array.isArray(msg.author)
          ? (msg.author as Array<{
              given?: string;
              family?: string;
              name?: string;
            }>)
          : [];
        const authors = authorArr
          .map((a) =>
            a.name ? a.name : [a.given, a.family].filter(Boolean).join(" "),
          )
          .filter(Boolean);
        const publishedParts = (
          msg["published-print"] ||
          msg["published-online"] ||
          msg.published
        ) as { "date-parts"?: number[][] } | undefined;
        const year = publishedParts?.["date-parts"]?.[0]?.[0];
        const containerArr = Array.isArray(msg["container-title"])
          ? (msg["container-title"] as string[])
          : [];
        const venue = containerArr[0]
          ? stripHtmlTags(containerArr[0])
          : undefined;
        const doi = normalizeString(msg.DOI);
        const abstractRaw = normalizeString(msg.abstract);
        return {
          source: "CrossRef",
          doi: doi || undefined,
          title,
          authors,
          year: year ?? undefined,
          abstract: abstractRaw
            ? stripHtmlTags(abstractRaw).slice(0, 600)
            : undefined,
          venue,
          type: normalizeString(msg.type) || undefined,
          url: normalizeString(msg.URL) || undefined,
        } satisfies ExternalMetadataResult;
      })
      .filter((r) => r.title || r.doi);
  } catch (_error) {
    void _error;
    return [];
  }
}

async function lookupSemanticScholar(params: {
  doi?: string;
  title?: string;
  arxivId?: string;
}): Promise<ExternalMetadataResult | null> {
  try {
    const fields =
      "title,authors,year,abstract,externalIds,citationCount,venue,publicationTypes,openAccessPdf";
    let url: string;
    if (params.doi) {
      url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(params.doi)}?fields=${fields}`;
    } else if (params.arxivId) {
      const cleaned = params.arxivId.replace(/^arxiv:/i, "");
      url = `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${encodeURIComponent(cleaned)}?fields=${fields}`;
    } else if (params.title) {
      const encoded = encodeURIComponent(params.title);
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&fields=${fields}&limit=1`;
    } else {
      return null;
    }
    const raw = (await fetchJson(url)) as Record<string, unknown>;
    const paper =
      params.doi || params.arxivId
        ? raw
        : (raw as { data?: unknown[] }).data?.[0];
    if (!paper || typeof paper !== "object") return null;
    const p = paper as Record<string, unknown>;
    const authorArr = Array.isArray(p.authors)
      ? (p.authors as Array<{ name?: string }>)
      : [];
    const authors = authorArr.map((a) => normalizeString(a.name)).filter(Boolean);
    const externalIds = (p.externalIds || {}) as Record<string, string>;
    const doi =
      externalIds.DOI ||
      externalIds.doi ||
      (params.doi ? params.doi : undefined);
    const publicationTypes = Array.isArray(p.publicationTypes)
      ? (p.publicationTypes as string[]).join(", ")
      : undefined;
    return {
      source: "Semantic Scholar",
      doi,
      title: normalizeString(p.title) || undefined,
      authors,
      year: typeof p.year === "number" ? p.year : undefined,
      abstract: normalizeString(p.abstract).slice(0, 600) || undefined,
      venue: normalizeString(p.venue) || undefined,
      citationCount:
        typeof p.citationCount === "number" ? p.citationCount : undefined,
      type: publicationTypes || undefined,
    };
  } catch (_error) {
    void _error;
    return null;
  }
}

export function createLookupExternalMetadataTool(): AgentToolDefinition<
  LookupExternalMetadataInput,
  unknown
> {
  return {
    spec: {
      name: "lookup_external_metadata",
      description:
        "Fetch canonical bibliographic metadata for a paper from CrossRef and Semantic Scholar using its DOI, title, or arXiv ID. Useful for filling missing metadata fields, checking citation counts, or verifying author/venue information.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          doi: {
            type: "string",
            description: "The DOI of the paper, e.g. 10.1234/example",
          },
          title: {
            type: "string",
            description: "Title to search for when DOI is not available",
          },
          arxivId: {
            type: "string",
            description: "arXiv identifier, e.g. 2301.07041 or arxiv:2301.07041",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Lookup External Metadata",
      summaries: {
        onCall: "Fetching metadata from CrossRef and Semantic Scholar",
        onSuccess: "Retrieved external metadata",
        onEmpty: "No external metadata found",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const title =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : undefined;
      const arxivId =
        typeof args.arxivId === "string" && args.arxivId.trim()
          ? args.arxivId.trim()
          : undefined;
      if (!doi && !title && !arxivId) {
        return fail("At least one of doi, title, or arxivId is required");
      }
      return ok<LookupExternalMetadataInput>({ doi, title, arxivId });
    },
    execute: async (input) => {
      const results: ExternalMetadataResult[] = [];
      if (input.doi) {
        const crossRef = await lookupCrossRefByDoi(input.doi);
        if (crossRef) results.push(crossRef);
      } else if (input.title) {
        const crossRefResults = await searchCrossRef(input.title);
        results.push(...crossRefResults.slice(0, 2));
      }
      const s2 = await lookupSemanticScholar({
        doi: input.doi,
        title: input.title,
        arxivId: input.arxivId,
      });
      if (s2) results.push(s2);
      if (!results.length) {
        return {
          results: [],
          message: "No metadata found for the given identifier.",
        };
      }
      return { results };
    },
  };
}
