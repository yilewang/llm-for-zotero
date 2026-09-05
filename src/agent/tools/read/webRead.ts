import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import type { WebAccessDepth, WebReadResponse } from "../../../webAccess/types";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import {
  applyRunSourceIds,
  assertWebReadUrlsFromSearch,
} from "../../../webAccess/runSources";
import { fail, ok, validateObject } from "../shared";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebReadInput = {
  urls: string[];
  query: string;
  depth: WebAccessDepth;
  chunksPerSource: number;
};

export type WebReadToolResult = WebReadResponse & {
  citation: ReturnType<typeof webCitationInstruction>;
};

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
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("query is required");
  if (query.length > 2_000)
    return fail("query must be 2,000 characters or less");
  if (args.depth !== "basic" && args.depth !== "advanced") {
    return fail("depth must be one of: basic, advanced");
  }
  const chunksRaw = args.chunksPerSource ?? 3;
  const chunksPerSource = Number(chunksRaw);
  if (
    !Number.isInteger(chunksPerSource) ||
    chunksPerSource < 1 ||
    chunksPerSource > 5
  ) {
    return fail("chunksPerSource must be an integer from 1 to 5");
  }
  return ok({
    urls: uniqueUrls,
    query,
    depth: args.depth,
    chunksPerSource,
  });
}

function buildReadTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input = validateWebReadInput(args);
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebReadToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  if (input.ok) {
    details.push({
      label: "Query",
      value: input.value.query,
    });
    for (const url of input.value.urls) {
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
  }
  return details;
}

export function createWebReadTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebReadInput, WebReadToolResult> {
  return {
    spec: {
      name: "web_read",
      description:
        "Read query-relevant passages from one to five public web pages with Tavily. Use URLs returned by web_search when their snippets are not sufficient for the answer.",
      inputSchema: {
        type: "object",
        required: ["urls", "query", "depth"],
        additionalProperties: false,
        properties: {
          urls: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          query: {
            type: "string",
            description: "What information to extract from the pages.",
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "Required extraction depth for this call. Follow an explicit user depth request; an unscoped preference applies to both web_search and web_read, while a preference scoped to search or page reading applies only there. Treat an explicit request for deep page reading as advanced. Otherwise infer depth from the current retrieval need: use basic for a few direct facts or passages with limited evidence scope; use advanced for long or technical pages, multiple sources or subquestions, comparison or synthesis, or deeper technical coverage. Do not choose advanced solely because the query is long, non-English, or scholarly.",
          },
          chunksPerSource: {
            type: "integer",
            minimum: 1,
            maximum: 5,
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    presentation: {
      label: "Read Web Pages",
      traceIcon: "web",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const input = validateWebReadInput(args);
        const result = content as Partial<WebReadToolResult> | undefined;
        if (!input.ok || !result) return null;
        return `Read web pages · Depth: ${input.value.depth}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const validated = validateWebReadInput(args);
          if (!validated.ok) return "Reading web pages";
          const count = validated.value.urls.length;
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
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_read requires an active local agent run.");
      }
      assertWebReadUrlsFromSearch(context.runId, input.urls);
      const result = await providerFactory().read({
        ...input,
        signal: context.signal,
      });
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
}
