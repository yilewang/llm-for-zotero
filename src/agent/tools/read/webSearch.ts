import type { AgentToolDefinition } from "../../types";
import {
  fail,
  normalizePositiveInt,
  ok,
  validateObject,
} from "../shared";

type WebSearchMode = "general" | "news" | "docs";

type WebSearchInput = {
  query: string;
  mode?: WebSearchMode;
  limit?: number;
};

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
};

const USER_AGENT =
  "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value);
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : value;
  } catch {
    return value;
  }
}

async function fetchText(url: string): Promise<string> {
  const ZoteroHttp = (globalThis as any).Zotero?.HTTP;
  if (ZoteroHttp?.request) {
    const xhr = await ZoteroHttp.request("GET", url, {
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      timeout: 15000,
    });
    return String(xhr.responseText || "");
  }
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function parseDuckDuckGoResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockPattern =
    /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  for (const blockMatch of html.matchAll(blockPattern)) {
    const block = blockMatch[0];
    const linkMatch =
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block,
      ) ||
      /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const rawUrl = decodeHtml(linkMatch[1]);
    const title = decodeHtml(linkMatch[2]);
    const snippetMatch =
      /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block,
      ) ||
      /<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
        block,
      );
    const url = extractDuckDuckGoUrl(rawUrl);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({
      title,
      url,
      snippet: snippetMatch ? decodeHtml(snippetMatch[1]) : "",
      source: (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return undefined;
        }
      })(),
    });
    if (results.length >= limit) break;
  }
  return results;
}

function buildSearchQuery(input: WebSearchInput): string {
  if (input.mode === "news") return `${input.query} news`;
  if (input.mode === "docs") return `${input.query} documentation`;
  return input.query;
}

export function createWebSearchTool(): AgentToolDefinition<WebSearchInput, unknown> {
  return {
    spec: {
      name: "web_search",
      description:
        "Search the public web for current general information. Use this for non-Zotero, non-paper-library web lookup. Do not use it for Zotero library questions, active paper content, or scholarly import/reference/citation workflows; use library_search, paper_read, or literature_search instead.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Search query.",
          },
          mode: {
            type: "string",
            enum: ["general", "news", "docs"],
            description:
              "Search mode. general is default, news biases toward recent/news results, docs biases toward documentation pages.",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default 5, max 10).",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      exposure: "model",
      tier: "normal",
    },
    guidance: {
      matches: (request) =>
        /\b(web|online|internet|current|latest|today|recent|documentation|docs|news)\b/i.test(
          request.userText || "",
        ),
      instruction:
        "Use web_search for general online lookup. Do not use it for papers already in Zotero or scholarly import/reference/citation workflows; use paper_read or literature_search there.",
    },
    presentation: {
      label: "Web Search",
      summaries: {
        onCall: ({ args }) => {
          const query =
            args && typeof args === "object"
              ? String((args as Record<string, unknown>).query || "")
              : "";
          return query ? `Searching the web for "${query}"` : "Searching the web";
        },
        onSuccess: ({ content }) => {
          const count =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { results?: unknown[] }).results)
              ? (content as { results: unknown[] }).results.length
              : 0;
          return count > 0
            ? `Found ${count} web result${count === 1 ? "" : "s"}`
            : "No web results found";
        },
      },
    },
    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with query");
      }
      const query = normalizeText(args.query);
      if (!query) return fail("query is required");
      const mode =
        args.mode === "news" || args.mode === "docs" || args.mode === "general"
          ? args.mode
          : undefined;
      return ok({
        query,
        mode,
        limit: normalizePositiveInt(args.limit),
      });
    },
    async execute(input) {
      const limit = Math.max(1, Math.min(10, input.limit || 5));
      const query = buildSearchQuery(input);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const warnings: string[] = [];
      const html = await fetchText(url);
      const results = parseDuckDuckGoResults(html, limit);
      if (!results.length) {
        warnings.push("No parseable results were returned by the web search backend.");
      }
      return {
        query: input.query,
        mode: input.mode || "general",
        backend: "duckduckgo_html",
        results,
        warnings,
      };
    },
  };
}
