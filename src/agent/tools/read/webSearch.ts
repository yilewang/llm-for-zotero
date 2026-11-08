import type {
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
import { getWebAccessProvider } from "../../../webAccess/prefs";
import {
  buildDeepSeekQuery,
  countQueryCharacters,
  DEEPSEEK_DOMAIN_LIMIT,
  DEEPSEEK_QUERY_LIMIT,
} from "../../../webAccess/deepseekSearchClient";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { neverSelected } from "../guidance";
import { fail, ok, validateObject } from "../shared";
import { WebAccessError } from "../../../webAccess/errors";
import {
  buildOutsideSearchReasonDetail,
  OUTSIDE_SEARCH_NEED_PROPERTIES,
  OUTSIDE_SEARCH_NEED_SENTENCE,
  OUTSIDE_SEARCH_STOP_NOTE,
  outsideSearchNeedError,
} from "./outsideSearchNeed";
import {
  buildOutsideSearchNote,
  latchOutsideSearch,
  outsideSearchLatch,
  recordOutsideSearch,
  tracksOutsideSearchTurn,
  webSearchUnavailableMessage,
} from "./outsideSearchLedger";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebSearchInput = {
  query: string;
  depth?: WebAccessDepth;
  topic?: WebSearchTopic;
  maxResults: number;
  timeRange?: WebSearchTimeRange;
  startDate?: string;
  endDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchToolResult = WebSearchResponse & {
  citation: ReturnType<typeof webCitationInstruction>;
  /**
   * The turn's web-search ledger and stop note; last, so the model reads
   * it after the results.
   */
  nextStep: string;
  /** Set when the web latch refused the call; no provider was reached. */
  unavailable?: "latched";
  message?: string;
};

/**
 * Why web search cannot work again this turn, or undefined: an exhausted
 * quota or a rejected key does not recover by retrying. A rate limit or a
 * service failure may, so it does not latch.
 */
function webSearchLatchReason(error: unknown): string | undefined {
  if (!(error instanceof WebAccessError)) return undefined;
  if (error.code === "quota" || error.code === "plan_limit")
    return "quota exhausted";
  if (error.code === "authentication") return "authentication rejected";
  return undefined;
}

function webProviderLabel(): string {
  const provider = getWebAccessProvider();
  if (provider === "anysearch") return "AnySearch";
  if (provider === "deepseek") return "DeepSeek";
  return "Tavily";
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

function normalizeDomains(value: unknown, maxItems = 10): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
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

const DEEPSEEK_SEARCH_FIELDS = [
  "query",
  "maxResults",
  "includeDomains",
  "excludeDomains",
  "startDate",
  "endDate",
  // The outside-search need; validateWebSearchCall checks it, and it never
  // reaches the provider or the query limit.
  "need",
  "gap",
];

/** DeepSeek filters become query operators, so they share the query limit. */
function validateDeepSeekSearch(
  args: Record<string, unknown>,
  query: string,
): AgentToolInputValidation<WebSearchInput> {
  if (
    Object.keys(args).some(
      (key) => !DEEPSEEK_SEARCH_FIELDS.includes(key) && args[key] !== undefined,
    )
  ) {
    return fail(
      "DeepSeek search supports query, maxResults, includeDomains, excludeDomains, startDate and endDate; depth, topic and timeRange are not supported.",
    );
  }
  const maxResults = args.maxResults ?? 5;
  if (
    typeof maxResults !== "number" ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 10
  ) {
    return fail("maxResults must be an integer from 1 to 10");
  }
  const startDate = normalizeDate(args.startDate);
  const endDate = normalizeDate(args.endDate);
  if (args.startDate !== undefined && !startDate) {
    return fail("startDate must use YYYY-MM-DD");
  }
  if (args.endDate !== undefined && !endDate) {
    return fail("endDate must use YYYY-MM-DD");
  }
  if (startDate && endDate && startDate > endDate) {
    return fail("startDate must not be after endDate");
  }
  const includeDomains = normalizeDomains(
    args.includeDomains,
    DEEPSEEK_DOMAIN_LIMIT,
  );
  const excludeDomains = normalizeDomains(
    args.excludeDomains,
    DEEPSEEK_DOMAIN_LIMIT,
  );
  if (args.includeDomains !== undefined && !includeDomains) {
    return fail(
      `includeDomains must contain at most ${DEEPSEEK_DOMAIN_LIMIT} valid domain names`,
    );
  }
  if (args.excludeDomains !== undefined && !excludeDomains) {
    return fail(
      `excludeDomains must contain at most ${DEEPSEEK_DOMAIN_LIMIT} valid domain names`,
    );
  }
  const value: WebSearchInput = {
    query,
    maxResults,
    ...(includeDomains ? { includeDomains } : {}),
    ...(excludeDomains ? { excludeDomains } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
  const length = countQueryCharacters(buildDeepSeekQuery(value));
  if (length > DEEPSEEK_QUERY_LIMIT) {
    return fail(
      `query with filters uses ${length} of ${DEEPSEEK_QUERY_LIMIT} characters; shorten the query or drop filters`,
    );
  }
  return ok(value);
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
  const provider = getWebAccessProvider();
  if (provider === "anysearch") {
    if (
      Object.keys(args).some(
        (key) =>
          !["query", "maxResults", "need", "gap"].includes(key) &&
          args[key] !== undefined,
      )
    ) {
      return fail(
        "AnySearch supports only query and maxResults; Tavily-only fields and vertical filters are not supported.",
      );
    }
    const maxResults = args.maxResults ?? 5;
    if (
      typeof maxResults !== "number" ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 10
    ) {
      return fail("maxResults must be an integer from 1 to 10");
    }
    return ok({ query, maxResults });
  }
  if (provider === "deepseek") return validateDeepSeekSearch(args, query);
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

/**
 * The model's call: the search parameters plus the need that sends it
 * outside the turn's papers and the library. The need stays out of the
 * validated input, so the provider never receives it.
 */
export function validateWebSearchCall(
  args: unknown,
): AgentToolInputValidation<WebSearchInput> {
  const validated = validateWebSearchInput(args);
  if (!validated.ok) return validated;
  const needError = outsideSearchNeedError(args as Record<string, unknown>);
  return needError ? fail(needError) : validated;
}

function storedQuery(args: unknown): string {
  const query = validateObject<Record<string, unknown>>(args)
    ? args.query
    : undefined;
  return typeof query === "string" ? query.trim() : "";
}

function buildSearchTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebSearchToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  // Stored args come from past calls; do not validate them against today's provider.
  const query = storedQuery(args);
  if (query) details.push({ label: "Query", value: query });
  const reason = buildOutsideSearchReasonDetail(args);
  if (reason) details.push(reason);
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

const DEEPSEEK_SEARCH_SPEC = {
  description:
    `Search the current public web with DeepSeek Search; write the query in the user's language by default. The query may use at most ${DEEPSEEK_QUERY_LIMIT} characters, including the site and date filters built from includeDomains, excludeDomains, startDate and endDate. No depth, topic or time range. Returns ranked results with summaries; web_read reads a result's page text. ` +
    OUTSIDE_SEARCH_NEED_SENTENCE +
    ".",
  inputSchema: {
    type: "object",
    required: ["query", "need"],
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: DEEPSEEK_QUERY_LIMIT,
        description: `The focused web search query. At most ${DEEPSEEK_QUERY_LIMIT} characters, including any filters.`,
      },
      maxResults: { type: "integer", minimum: 1, maximum: 10 },
      includeDomains: {
        type: "array",
        maxItems: DEEPSEEK_DOMAIN_LIMIT,
        items: { type: "string" },
        description: "Search only these sites.",
      },
      excludeDomains: {
        type: "array",
        maxItems: DEEPSEEK_DOMAIN_LIMIT,
        items: { type: "string" },
        description: "Leave out these sites.",
      },
      startDate: {
        type: "string",
        description: "YYYY-MM-DD. Only pages published after this date.",
      },
      endDate: {
        type: "string",
        description: "YYYY-MM-DD. Only pages published before this date.",
      },
      ...OUTSIDE_SEARCH_NEED_PROPERTIES,
    },
  },
};

const DEEPSEEK_SEARCH_GUIDANCE = {
  matches: neverSelected,
  instruction: `DeepSeek Search accepts query, maxResults, includeDomains, excludeDomains, startDate and endDate; do not send depth, topic or timeRange. Keep the query within ${DEEPSEEK_QUERY_LIMIT} characters including filters. Use web_read with searched URLs only when search summaries are insufficient. Every final-answer paragraph that uses web results must end with the exact hidden source marker described in the tool result, using only returned sourceId values. Do not add a references footer.`,
};

export function createWebSearchTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebSearchInput, WebSearchToolResult> {
  const tool: AgentToolDefinition<WebSearchInput, WebSearchToolResult> = {
    spec: {
      name: "web_search",
      description:
        "Search the current public web with Tavily; write the query in the user's language by default. Returns ranked results with snippets; web_read reads a result's page text. " +
        OUTSIDE_SEARCH_NEED_SENTENCE +
        ".",
      inputSchema: {
        type: "object",
        required: ["query", "depth", "need"],
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
          ...OUTSIDE_SEARCH_NEED_PROPERTIES,
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    guidance: {
      matches: neverSelected,
      instruction:
        "Always explicitly choose basic or advanced from the current retrieval need, and use web_read when search snippets are insufficient. Every final-answer paragraph that uses web results must end with the exact hidden source marker described in the tool result, using only returned sourceId values. Do not add a references footer.",
    },
    presentation: {
      label: "Search Web",
      traceIcon: "web",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const result = content as Partial<WebSearchToolResult> | undefined;
        if (!result) return null;
        if (result.provider === "anysearch") return "Searched web · AnySearch";
        if (result.provider === "deepseek") return "Searched web · DeepSeek";
        const depth = validateObject<Record<string, unknown>>(args)
          ? args.depth
          : undefined;
        if (depth !== "basic" && depth !== "advanced") return null;
        return `Searched web · Depth: ${depth}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const query = storedQuery(args);
          return query
            ? `Searching the web for “${query}”`
            : "Searching the web";
        },
        onSuccess: "Web search complete",
        onEmpty: ({ content }) =>
          (content as { unavailable?: unknown } | undefined)?.unavailable
            ? "Web search unavailable this turn"
            : "No web results found",
        onError: "Web search failed",
      },
      buildTraceDetails: ({ args, content }) =>
        buildSearchTraceDetails(args, content),
    },
    validate: validateWebSearchCall,
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        targets: [input.query],
        reason:
          "The configured web provider receives the search query and returns public results.",
      }),
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_search requires an active local agent run.");
      }
      // Revalidate against the current saved provider if preferences changed
      // after the model received its schema. Never drop unsupported fields.
      const validated = validateWebSearchInput(input);
      if (!validated.ok) throw new Error(validated.error);
      // The turn's outside-search ledger; untracked run ids keep no state.
      const turn = tracksOutsideSearchTurn(context.runId)
        ? context.runId
        : undefined;
      const latched = turn ? outsideSearchLatch(turn, "web") : undefined;
      if (latched)
        return {
          provider: webProviderLabel(),
          query: validated.value.query,
          results: [],
          citation: webCitationInstruction([]),
          unavailable: "latched",
          message: latched,
          nextStep: latched,
        };
      const provider = providerFactory();
      if (turn) recordOutsideSearch(turn, "web", validated.value.query);
      let result: WebSearchResponse;
      try {
        result = await provider.search({
          ...validated.value,
          signal: context.signal,
        });
      } catch (error) {
        const reason = webSearchLatchReason(error);
        if (!turn || !reason) throw error;
        const message = webSearchUnavailableMessage(webProviderLabel(), reason);
        latchOutsideSearch(turn, "web", message);
        // The model reads the latch message; the code and status stay.
        const failure = error as WebAccessError;
        throw new WebAccessError(message, failure.code, failure.status);
      }
      const results = registerWebSearchSources(context.runId, result.results);
      return {
        ...result,
        results,
        citation: webCitationInstruction(
          results.map((source) => source.sourceId),
        ),
        nextStep: turn
          ? buildOutsideSearchNote(turn, "web")
          : OUTSIDE_SEARCH_STOP_NOTE,
      };
    },
  };
  return {
    ...tool,
    get spec() {
      const provider = getWebAccessProvider();
      if (provider === "deepseek")
        return { ...tool.spec, ...DEEPSEEK_SEARCH_SPEC };
      if (provider !== "anysearch") return tool.spec;
      return {
        ...tool.spec,
        description:
          "Search the public web with AnySearch. Supports query and result count only, not depth, topic, date/domain filters or vertical selection. Write the query in the user's language by default; use web_read for page text. " +
          OUTSIDE_SEARCH_NEED_SENTENCE +
          ".",
        inputSchema: {
          type: "object",
          required: ["query", "need"],
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 2000 },
            maxResults: { type: "integer", minimum: 1, maximum: 10 },
            ...OUTSIDE_SEARCH_NEED_PROPERTIES,
          },
        },
      };
    },
    get guidance() {
      const provider = getWebAccessProvider();
      if (provider === "deepseek") return DEEPSEEK_SEARCH_GUIDANCE;
      if (provider !== "anysearch") return tool.guidance;
      return {
        matches: neverSelected,
        instruction:
          "AnySearch accepts query and maxResults only; do not invent depth, topic, date/domain filters or vertical options. Use web_read with searched URLs only when snippets are insufficient. Every final-answer paragraph using web information must end with the hidden source marker described in the result, using only returned sourceId values. Do not add a references footer.",
      };
    },
  };
}
