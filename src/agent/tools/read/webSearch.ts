import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import type {
  WebAccessDepth,
  WebSearchResponse,
  WebSearchTimeRange,
  WebSearchTopic,
} from "../../../webAccess/types";
import { registerWebSearchSources } from "../../../webAccess/runSources";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import { fail, ok, validateObject } from "../shared";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebSearchInput = {
  query: string;
  depth: WebAccessDepth;
  topic: WebSearchTopic;
  maxResults: number;
  timeRange?: WebSearchTimeRange;
  startDate?: string;
  endDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchToolResult = WebSearchResponse & {
  citation: ReturnType<typeof webCitationInstruction>;
};

const EXPLICIT_WEB_SEARCH_FALLBACK_PATTERNS = [
  /\b(?:web search|search (?:the )?(?:web|internet)|search online|online search|browse (?:the )?web|look up online|verify online|check online)\b/i,
  /\b(?:search|browse|look up|find|verify|check|provide|cite|give)\b.{0,80}\b(?:website|online sources?|official sources?|official website|official documentation)\b/i,
];

const TIME_SENSITIVE_WEB_FALLBACK_PATTERN =
  /\b(?:latest (?:version|release|news|price|status|schedule)|today(?:'s)?|news|weather|forecast|breaking news|release notes?|current (?:price|version|release|status|schedule|weather|officeholder|president|ceo)|currently (?:serves|serving|holds|available)|price of|as of)\b/i;

export function matchesWebSearchGuidance(
  request: Pick<AgentRuntimeRequest, "userText" | "classifiedIntent">,
): boolean {
  const intent = request.classifiedIntent?.externalSearchIntent;
  if (intent !== undefined) return intent === "web" || intent === "both";
  const userText = request.userText || "";
  return (
    EXPLICIT_WEB_SEARCH_FALLBACK_PATTERNS.some((pattern) =>
      pattern.test(userText),
    ) || TIME_SENSITIVE_WEB_FALLBACK_PATTERN.test(userText)
  );
}

function normalizeTopic(value: unknown): WebSearchTopic {
  return value === "news" || value === "finance" ? value : "general";
}

function normalizeTimeRange(value: unknown): WebSearchTimeRange | undefined {
  return value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "year"
    ? value
    : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function normalizeDomains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const domains = value.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : "",
  );
  if (
    domains.some(
      (domain) =>
        !domain ||
        domain.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          domain,
        ),
    )
  ) {
    return undefined;
  }
  try {
    for (const domain of domains) normalizePublicWebUrl(`https://${domain}/`);
  } catch {
    return undefined;
  }
  return Array.from(new Set(domains));
}

export function validateWebSearchInput(
  args: unknown,
): AgentToolInputValidation<WebSearchInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("web_search expects an object input");
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("query is required");
  if (query.length > 2_000)
    return fail("query must be 2,000 characters or less");
  if (args.depth !== "basic" && args.depth !== "advanced") {
    return fail("depth must be one of: basic, advanced");
  }
  if (
    args.topic !== undefined &&
    args.topic !== "general" &&
    args.topic !== "news" &&
    args.topic !== "finance"
  ) {
    return fail("topic must be one of: general, news, finance");
  }
  const maxResultsRaw = args.maxResults ?? 5;
  const maxResults = Number(maxResultsRaw);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    return fail("maxResults must be an integer from 1 to 10");
  }
  const timeRange = normalizeTimeRange(args.timeRange);
  if (args.timeRange !== undefined && !timeRange) {
    return fail("timeRange must be one of: day, week, month, year");
  }
  const startDate = normalizeDate(args.startDate);
  const endDate = normalizeDate(args.endDate);
  if (args.startDate !== undefined && !startDate) {
    return fail("startDate must use YYYY-MM-DD");
  }
  if (args.endDate !== undefined && !endDate) {
    return fail("endDate must use YYYY-MM-DD");
  }
  if (timeRange && (startDate || endDate)) {
    return fail("timeRange cannot be combined with startDate or endDate");
  }
  if (startDate && endDate && startDate > endDate) {
    return fail("startDate must not be after endDate");
  }
  const includeDomains = normalizeDomains(args.includeDomains);
  const excludeDomains = normalizeDomains(args.excludeDomains);
  if (args.includeDomains !== undefined && !includeDomains) {
    return fail("includeDomains must contain at most 10 valid domain names");
  }
  if (args.excludeDomains !== undefined && !excludeDomains) {
    return fail("excludeDomains must contain at most 10 valid domain names");
  }
  return ok({
    query,
    depth: args.depth,
    topic: normalizeTopic(args.topic),
    maxResults,
    timeRange,
    startDate,
    endDate,
    includeDomains,
    excludeDomains,
  });
}

function buildSearchTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input = validateWebSearchInput(args);
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebSearchToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  if (input.ok) {
    details.push({ label: "Query", value: input.value.query });
  }
  for (const source of result.results || []) {
    details.push({
      label: "URL",
      value: source.url,
      kind: "url",
      timeline: {
        icon: "website",
        href: source.url,
        ...(source.faviconUrl ? { faviconUrl: source.faviconUrl } : {}),
      },
    });
  }
  return details;
}

export function createWebSearchTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebSearchInput, WebSearchToolResult> {
  return {
    spec: {
      name: "web_search",
      description:
        "Search the current public web with Tavily when the answer materially needs current facts or concrete general-web evidence. Use literature_search for scholarly discovery; a request may use both for distinct evidence needs.",
      inputSchema: {
        type: "object",
        required: ["query", "depth"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "The focused web search query.",
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "Required search depth for this call. Follow an explicit user depth request; an unscoped preference applies to both web_search and web_read, while a preference scoped to search or page reading applies only there. Treat an explicit request for deep search as advanced. Otherwise infer depth from the current retrieval need: use basic for a focused lookup with a clear target and limited evidence scope; use advanced for exploratory or ambiguous discovery, comparison or synthesis, multiple sources, entities, or subquestions, or deeper technical coverage. Do not choose advanced solely because the query is long, non-English, or scholarly. basic costs 1 credit; advanced costs 2 credits.",
          },
          topic: {
            type: "string",
            enum: ["general", "news", "finance"],
          },
          maxResults: { type: "integer", minimum: 1, maximum: 10 },
          timeRange: {
            type: "string",
            enum: ["day", "week", "month", "year"],
          },
          startDate: { type: "string", description: "YYYY-MM-DD" },
          endDate: { type: "string", description: "YYYY-MM-DD" },
          includeDomains: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
          },
          excludeDomains: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    guidance: {
      matches: matchesWebSearchGuidance,
      instruction:
        "Use web_search when the request needs current or general public evidence. A mixed request may also use literature_search for distinct scholarly evidence. Preserve the user's language by default, explicitly choose basic or advanced from the current retrieval need, and use web_read when search snippets are insufficient. Every final-answer paragraph that uses web results must end with the exact hidden source marker described in the tool result, using only returned sourceId values. Do not add a references footer.",
    },
    presentation: {
      label: "Search Web",
      traceIcon: "web",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const input = validateWebSearchInput(args);
        const result = content as Partial<WebSearchToolResult> | undefined;
        if (!input.ok || !result) return null;
        return `Searched web · Depth: ${input.value.depth}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const validated = validateWebSearchInput(args);
          return validated.ok
            ? `Searching the web for “${validated.value.query}”`
            : "Searching the web";
        },
        onSuccess: "Web search complete",
        onEmpty: "No web results found",
        onError: "Web search failed",
      },
      buildTraceDetails: ({ args, content }) =>
        buildSearchTraceDetails(args, content),
    },
    validate: validateWebSearchInput,
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_search requires an active local agent run.");
      }
      const result = await providerFactory().search({
        ...input,
        signal: context.signal,
      });
      const results = registerWebSearchSources(context.runId, result.results);
      return {
        ...result,
        results,
        citation: webCitationInstruction(
          results.map((source) => source.sourceId),
        ),
      };
    },
  };
}
