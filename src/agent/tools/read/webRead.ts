import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import type {
  WebAccessDepth,
  WebReadMode,
  WebReadResponse,
  WebSourceRecord,
} from "../../../webAccess/types";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import { getWebAccessProvider } from "../../../webAccess/prefs";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  applyRunSourceIds,
  assertWebReadUrlsFromSearch,
} from "../../../webAccess/runSources";
import {
  getStoredWebPage,
  readWebPageRange,
  readWebPageSections,
  storeWebPage,
  webPageOutline,
} from "../../../webAccess/webPageStore";
import { fail, ok, validateObject } from "../shared";
import { skillGuidance } from "../guidance";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebReadInput = {
  urls: string[];
  /** Set by validation: the default is passages (Tavily) or full. */
  mode?: WebReadMode;
  query?: string;
  depth?: WebAccessDepth;
  chunksPerSource?: number;
  sections?: string[];
  offset?: number;
  maxChars?: number;
};

export type WebReadToolResult = WebReadResponse & {
  mode?: WebReadMode;
  /** What the agent can do next with the page (outline, sections, full). */
  note?: string;
  citation: ReturnType<typeof webCitationInstruction>;
};

const READ_MODES: readonly WebReadMode[] = [
  "passages",
  "outline",
  "sections",
  "full",
];
/** One outline lists at most this many headings. */
const OUTLINE_MAX_ENTRIES = 150;
export const WEB_READ_DEFAULT_MAX_CHARS = 12_000;
const WEB_READ_MIN_MAX_CHARS = 2_000;
const WEB_READ_MAX_MAX_CHARS = 40_000;

/** Tavily alone extracts the passages that match a query. */
function readsPassages(): boolean {
  const provider = getWebAccessProvider();
  return (
    provider !== "anysearch" &&
    provider !== "deepseek" &&
    provider !== "keenable"
  );
}

export function validateWebReadInput(
  args: unknown,
): AgentToolInputValidation<WebReadInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("web_read expects an object input");
  }
  if (
    !Array.isArray(args.urls) ||
    args.urls.length < 1 ||
    args.urls.length > 5
  ) {
    return fail("urls must contain between 1 and 5 public HTTP(S) URLs");
  }
  const urls: string[] = [];
  try {
    for (const value of args.urls) urls.push(normalizePublicWebUrl(value));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const uniqueUrls = Array.from(new Set(urls));
  const provider = getWebAccessProvider();
  const passages = readsPassages();
  const mode = (args.mode ?? (passages ? "passages" : "full")) as WebReadMode;
  if (!READ_MODES.includes(mode)) {
    return fail("mode must be one of: passages, outline, sections, full");
  }
  if (!passages) {
    const name =
      provider === "deepseek"
        ? "DeepSeek fetch"
        : provider === "keenable"
          ? "Keenable fetch"
          : "AnySearch";
    if (mode === "passages") {
      return fail(
        `${name} cannot pick passages by query; use mode outline, sections or full.`,
      );
    }
    if (
      ["query", "depth", "chunksPerSource"].some(
        (key) => args[key] !== undefined,
      )
    ) {
      return fail(
        provider === "deepseek" || provider === "keenable"
          ? `${name} accepts only urls, mode, sections, offset and maxChars; query, depth and chunksPerSource are not supported.`
          : "AnySearch extraction accepts only urls, mode, sections, offset and maxChars; query, depth and chunksPerSource are not supported.",
      );
    }
  }
  const value: WebReadInput = { urls: uniqueUrls, mode };
  if (passages) {
    if (args.depth !== "basic" && args.depth !== "advanced") {
      return fail("depth must be one of: basic, advanced");
    }
    value.depth = args.depth;
  }
  if (mode !== "sections" && args.sections !== undefined) {
    return fail("sections belongs to mode 'sections'");
  }
  if (mode !== "full" && args.offset !== undefined) {
    return fail("offset belongs to mode 'full'");
  }
  if (mode === "passages") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return fail("query is required");
    if (query.length > 2_000)
      return fail("query must be 2,000 characters or less");
    const chunksRaw = args.chunksPerSource ?? 3;
    const chunksPerSource = Number(chunksRaw);
    if (
      !Number.isInteger(chunksPerSource) ||
      chunksPerSource < 1 ||
      chunksPerSource > 5
    ) {
      return fail("chunksPerSource must be an integer from 1 to 5");
    }
    return ok({ ...value, query, chunksPerSource });
  }
  if (args.chunksPerSource !== undefined) {
    return fail("chunksPerSource belongs to mode 'passages'");
  }
  if (mode === "sections") {
    if (uniqueUrls.length !== 1) {
      return fail("mode 'sections' reads one page: pass exactly one URL");
    }
    if (
      !Array.isArray(args.sections) ||
      !args.sections.length ||
      args.sections.length > 50 ||
      args.sections.some((id) => typeof id !== "string" || !id.trim())
    ) {
      return fail(
        "sections must list 1 to 50 section ids from an outline read of the page",
      );
    }
    value.sections = (args.sections as string[]).map((id) => id.trim());
  }
  if (mode === "full" && args.offset !== undefined) {
    const offset = Number(args.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      return fail("offset must be a whole number from 0");
    }
    if (offset > 0 && uniqueUrls.length !== 1) {
      return fail("offset continues one page: pass exactly one URL");
    }
    value.offset = offset;
  }
  if (args.maxChars !== undefined && mode !== "outline") {
    const maxChars = Number(args.maxChars);
    if (
      !Number.isInteger(maxChars) ||
      maxChars < WEB_READ_MIN_MAX_CHARS ||
      maxChars > WEB_READ_MAX_MAX_CHARS
    ) {
      return fail(
        `maxChars must be a whole number from ${WEB_READ_MIN_MAX_CHARS} to ${WEB_READ_MAX_MAX_CHARS}`,
      );
    }
    value.maxChars = maxChars;
  }
  return ok(value);
}

// Stored args come from past calls; do not validate them against today's provider.
function storedReadArgs(args: unknown): {
  urls: string[];
  query: string;
  mode?: WebReadMode;
  sections: string[];
  offset?: number;
} {
  if (!validateObject<Record<string, unknown>>(args)) {
    return { urls: [], query: "", sections: [] };
  }
  const urls: string[] = [];
  if (Array.isArray(args.urls)) {
    for (const value of args.urls) {
      try {
        const url = normalizePublicWebUrl(value);
        if (!urls.includes(url)) urls.push(url);
      } catch {
        // Skip a URL that no longer normalizes.
      }
    }
  }
  const mode = READ_MODES.includes(args.mode as WebReadMode)
    ? (args.mode as WebReadMode)
    : undefined;
  const offset = Number(args.offset);
  return {
    urls,
    query: typeof args.query === "string" ? args.query.trim() : "",
    ...(mode ? { mode } : {}),
    sections: Array.isArray(args.sections)
      ? args.sections.filter((id): id is string => typeof id === "string")
      : [],
    ...(Number.isInteger(offset) && offset > 0 ? { offset } : {}),
  };
}

const MODE_SUMMARIES: Record<Exclude<WebReadMode, "passages">, string> = {
  outline: "Read web page outline",
  sections: "Read web page sections",
  full: "Read whole web page",
};

function buildReadTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input = storedReadArgs(args);
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebReadToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  if (input.query) {
    details.push({ label: "Query", value: input.query });
  }
  if (input.sections.length) {
    details.push({ label: "Sections", value: input.sections.join(", ") });
  }
  if (input.offset) {
    details.push({
      label: "From character",
      value: input.offset.toLocaleString("en-US"),
    });
  }
  for (const url of input.urls) {
    const source = (result.pages || []).find((page) => page.url === url);
    details.push({
      label: "URL",
      value: url,
      kind: "url",
      timeline: {
        icon: "website",
        href: url,
        ...(source?.faviconUrl ? { faviconUrl: source.faviconUrl } : {}),
      },
    });
  }
  return details;
}

const MODE_PROPERTY = {
  type: "string",
  description:
    "How to read: outline = each page's headings with section ids and sizes; sections = the chosen sections of one page in full; full = the whole page in pieces of maxChars, continued with offset (the result's nextOffset).",
};

const PAGE_READ_PROPERTIES = {
  sections: {
    type: "array",
    maxItems: 50,
    items: { type: "string" },
    description:
      "For mode 'sections': section ids from an outline read of this page (one URL).",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description:
      "For mode 'full': where to continue, the nextOffset of the previous read of this page (one URL).",
  },
  maxChars: {
    type: "integer",
    minimum: WEB_READ_MIN_MAX_CHARS,
    maximum: WEB_READ_MAX_MAX_CHARS,
    description: `For modes 'sections' and 'full': how much text to return per page (default ${WEB_READ_DEFAULT_MAX_CHARS}).`,
  },
};

const PAGE_ONLY_SCHEMA = {
  type: "object",
  required: ["urls"],
  additionalProperties: false,
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string" },
    },
    mode: { ...MODE_PROPERTY, enum: ["outline", "sections", "full"] },
    ...PAGE_READ_PROPERTIES,
  },
};

const READING_STRATEGY =
  "Read as deep as the page deserves: a page that looks central to the question deserves its outline and sections, or a full read; a page read once in this answer is kept, so later outline, sections and full reads of it make no new web request.";

function pageNote(
  mode: WebReadMode,
  pages: readonly WebSourceRecord[],
): string | undefined {
  const more = pages.filter((page) => page.nextOffset !== undefined);
  if (mode === "outline") {
    return "Read chosen parts with mode 'sections' and their ids, or the whole page with mode 'full'. Reading this page again costs no web request.";
  }
  if (more.length) {
    return `More of ${more.length === 1 ? "this page" : "these pages"} remains: continue with mode 'full' and offset set to nextOffset, if the answer needs it.`;
  }
  return undefined;
}

/**
 * The import skill's page step. MCP hides web_read, so the skill body says
 * only "open the page" and the tool name lives here (#541).
 */
export const IMPORT_TO_LIBRARY_PAGE_GUIDANCE = skillGuidance(
  "import-to-library",
  "Import references: never pass a page URL to `library_import`: open the page with `web_read` if needed, take its DOI or arXiv ID, and import that identifier.",
);

export function createWebReadTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebReadInput, WebReadToolResult> {
  const readWholePages = async (
    input: WebReadInput,
    runId: string,
    signal?: AbortSignal,
  ): Promise<WebReadToolResult> => {
    const mode = input.mode || "full";
    const missing = input.urls.filter((url) => !getStoredWebPage(runId, url));
    let fetched: WebReadResponse | null = null;
    if (missing.length) {
      fetched = await providerFactory().read({
        urls: missing,
        wholePage: true,
        ...(input.depth ? { depth: input.depth } : {}),
        signal,
      });
      for (const page of fetched.pages) storeWebPage(runId, page);
      // A provider that answers one page under another URL (a redirect)
      // still answers the URL asked for.
      const unanswered = missing.filter((url) => !getStoredWebPage(runId, url));
      if (unanswered.length === 1 && fetched.pages.length === 1) {
        storeWebPage(runId, { ...fetched.pages[0], url: unanswered[0] });
      }
    }
    const maxChars = input.maxChars || WEB_READ_DEFAULT_MAX_CHARS;
    const failedResults = [...(fetched?.failedResults || [])];
    const pages: WebSourceRecord[] = [];
    for (const url of input.urls) {
      const page = getStoredWebPage(runId, url);
      if (!page) {
        if (!failedResults.some((failure) => failure.url === url)) {
          failedResults.push({ url, error: "The page returned no text." });
        }
        continue;
      }
      const base: WebSourceRecord = {
        ...page.source,
        url,
        readMode: mode,
        totalChars: page.text.length,
        ...(page.truncated ? { truncated: true } : {}),
      };
      if (mode === "outline") {
        pages.push({
          ...base,
          outline: webPageOutline(page).slice(0, OUTLINE_MAX_ENTRIES),
        });
      } else if (mode === "sections") {
        const read = readWebPageSections(page, input.sections || [], maxChars);
        if (!read.sectionIds.length) {
          throw new Error(
            `This page has no section ${read.unknownIds.join(", ")}; read its outline (mode 'outline') for the section ids.`,
          );
        }
        pages.push({
          ...base,
          content: read.content,
          sectionIds: read.sectionIds,
          range: read.range,
          ...(read.nextOffset !== undefined
            ? { nextOffset: read.nextOffset }
            : {}),
        });
      } else {
        const read = readWebPageRange(page, input.offset || 0, maxChars);
        pages.push({
          ...base,
          content: read.content,
          range: read.range,
          ...(read.nextOffset !== undefined
            ? { nextOffset: read.nextOffset }
            : {}),
        });
      }
    }
    const note = pageNote(mode, pages);
    return {
      provider: fetched?.provider || getWebAccessProvider(),
      mode,
      ...(input.depth ? { depth: input.depth } : {}),
      pages,
      failedResults,
      ...(fetched?.usage ? { usage: fetched.usage } : {}),
      ...(fetched?.requestId ? { requestId: fetched.requestId } : {}),
      ...(fetched?.requestIds ? { requestIds: fetched.requestIds } : {}),
      ...(note ? { note } : {}),
      citation: webCitationInstruction([]),
    };
  };

  const tool: AgentToolDefinition<WebReadInput, WebReadToolResult> = {
    spec: {
      name: "web_read",
      description:
        "Read public web pages returned by web_search in this run, with Tavily. mode 'passages' (default) returns the passages of one to five pages that match a query: enough for a quick fact. mode 'outline' returns a page's headings with section ids and sizes; mode 'sections' reads the chosen sections of one page; mode 'full' reads a whole page in pieces, continued with offset. " +
        READING_STRATEGY,
      inputSchema: {
        type: "object",
        required: ["urls", "depth"],
        additionalProperties: false,
        properties: {
          urls: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          mode: {
            ...MODE_PROPERTY,
            enum: [...READ_MODES],
            description: `passages = the parts of each page that match query (default); ${MODE_PROPERTY.description}`,
          },
          query: {
            type: "string",
            description:
              "For mode 'passages' (required there): what information to extract from the pages.",
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "Required extraction depth for this call. Follow an explicit user depth request; an unscoped preference applies to both web_search and web_read, while a preference scoped to search or page reading applies only there. Treat an explicit request for deep page reading as advanced. Otherwise infer depth from the current retrieval need: use basic for a few direct facts or passages with limited evidence scope; use advanced for long or technical pages, multiple sources or subquestions, comparison or synthesis, or deeper technical coverage. Do not choose advanced solely because the query is long, non-English, or scholarly. A page already read in this answer is not fetched again.",
          },
          chunksPerSource: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "For mode 'passages': passages per page (default 3).",
          },
          ...PAGE_READ_PROPERTIES,
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    guidance: [IMPORT_TO_LIBRARY_PAGE_GUIDANCE],
    presentation: {
      label: "Read Web Pages",
      traceIcon: "web",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const result = content as Partial<WebReadToolResult> | undefined;
        if (!result) return null;
        const mode = storedReadArgs(args).mode;
        const label =
          mode && mode !== "passages" ? MODE_SUMMARIES[mode] : "Read web pages";
        if (result.provider === "anysearch") return `${label} · AnySearch`;
        if (result.provider === "deepseek") return `${label} · DeepSeek`;
        if (result.provider === "keenable") return `${label} · Keenable`;
        const depth = validateObject<Record<string, unknown>>(args)
          ? args.depth
          : undefined;
        if (depth !== "basic" && depth !== "advanced") {
          return mode && mode !== "passages" ? label : null;
        }
        return `${label} · Depth: ${depth}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const input = storedReadArgs(args);
          const count = input.urls.length;
          if (input.mode === "outline") return "Reading the page outline";
          if (input.mode === "sections") return "Reading page sections";
          if (input.mode === "full") {
            return input.offset
              ? "Reading more of the page"
              : `Reading the whole page${count > 1 ? "s" : ""}`;
          }
          if (!count) return "Reading web pages";
          return `Reading ${count} web page${count === 1 ? "" : "s"}`;
        },
        onSuccess: "Web page reading complete",
        onEmpty: "No web pages could be read",
        onError: "Web page reading failed",
      },
      buildTraceDetails: ({ args, content }) =>
        buildReadTraceDetails(args, content),
    },
    validate: validateWebReadInput,
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        targets: [...input.urls],
        reason:
          "The configured web provider fetches the requested public URLs without changing local state.",
      }),
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_read requires an active local agent run.");
      }
      const validated = validateWebReadInput(input);
      if (!validated.ok) throw new Error(validated.error);
      assertWebReadUrlsFromSearch(context.runId, input.urls);
      const value = validated.value;
      const result =
        value.mode === "passages"
          ? await providerFactory()
              .read({
                urls: value.urls,
                query: value.query,
                depth: value.depth,
                chunksPerSource: value.chunksPerSource,
                signal: context.signal,
              })
              .then(
                (response): WebReadToolResult => ({
                  ...response,
                  pages: response.pages.map((page) => ({
                    ...page,
                    readMode: "passages",
                  })),
                  note: "These are only the passages that matched the query. If a page looks central to the question, read its outline (mode 'outline') and the sections that matter, or the whole page (mode 'full').",
                  citation: webCitationInstruction([]),
                }),
              )
          : await readWholePages(value, context.runId, context.signal);
      const pages = applyRunSourceIds(context.runId, result.pages);
      return {
        ...result,
        pages,
        citation: webCitationInstruction(
          pages.map((source) => source.sourceId),
        ),
      };
    },
  };
  return {
    ...tool,
    get spec() {
      const provider = getWebAccessProvider();
      if (provider === "deepseek") {
        return {
          ...tool.spec,
          description:
            "Read public URLs returned by web_search in this run with DeepSeek Fetch, which returns each page as Markdown. mode 'full' (default) reads one to five whole pages in pieces, continued with offset; mode 'outline' returns a page's headings with section ids and sizes; mode 'sections' reads the chosen sections of one page. No query-focused extraction or depth. " +
            READING_STRATEGY,
          inputSchema: PAGE_ONLY_SCHEMA,
        };
      }
      if (provider === "keenable") {
        return {
          ...tool.spec,
          description:
            "Read public URLs returned by web_search in this run with Keenable Fetch, which returns each page as Markdown (PDFs as text). mode 'full' (default) reads one to five whole pages in pieces, continued with offset; mode 'outline' returns a page's headings with section ids and sizes; mode 'sections' reads the chosen sections of one page. No query-focused extraction or depth. " +
            READING_STRATEGY,
          inputSchema: PAGE_ONLY_SCHEMA,
        };
      }
      if (provider !== "anysearch") return tool.spec;
      return {
        ...tool.spec,
        description:
          "Read text from public URLs returned by web_search in this run using AnySearch. Supports HTML/XHTML, text, JSON and Markdown, not PDF, Office or media binaries. mode 'full' (default) reads one to five whole pages in pieces, continued with offset; mode 'outline' returns a page's headings with section ids and sizes; mode 'sections' reads the chosen sections of one page. No query-focused extraction or depth. " +
          READING_STRATEGY,
        inputSchema: PAGE_ONLY_SCHEMA,
      };
    },
  };
}
