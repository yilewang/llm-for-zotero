import { createAbortController } from "../utils/apiHelpers";
import { DEEPSEEK_SEARCH_ORIGIN } from "./deepseekSearchKey";
import { WebAccessError } from "./errors";
import {
  isolatedJsonTransport,
  type IsolatedJsonTransport,
} from "./isolatedJsonTransport";
import { buildWebSourceId, normalizePublicWebUrl } from "./tavilyClient";
import type {
  WebAccessProvider,
  WebAccessUsageSnapshot,
  WebReadFailure,
  WebReadRequest,
  WebReadResponse,
  WebSearchRequest,
  WebSearchResponse,
  WebSourceRecord,
} from "./types";
import { normalizePageText } from "./pageText";

const TIMEOUT_MS = 60_000;
const CONTENT_LIMIT = 12_000;
/** DeepSeek counts Unicode characters, as JSON Schema maxLength does. */
export const DEEPSEEK_QUERY_LIMIT = 128;
/** Each site: clause costs query characters, so keep the lists short. */
export const DEEPSEEK_DOMAIN_LIMIT = 3;

export type DeepSeekSearchTransport = IsolatedJsonTransport;

type Endpoint = "search" | "fetch";

export type DeepSeekQueryInput = Pick<
  WebSearchRequest,
  "query" | "includeDomains" | "excludeDomains" | "startDate" | "endDate"
>;

/**
 * DeepSeek has no filter fields; filters are query operators. Several
 * included sites are joined with OR, as the DeepSeek guide describes.
 */
export function buildDeepSeekQuery(input: DeepSeekQueryInput): string {
  const include = (input.includeDomains || []).map(
    (domain) => `site:${domain}`,
  );
  return [
    input.query.trim(),
    include.join(" OR "),
    ...(input.excludeDomains || []).map((domain) => `-site:${domain}`),
    input.startDate ? `after:${input.startDate}` : "",
    input.endDate ? `before:${input.endDate}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function countQueryCharacters(query: string): number {
  return Array.from(query).length;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebAccessError(
      "DeepSeek returned an invalid response.",
      "service",
    );
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").slice(0, maxLength).trim()
    : "";
}

function optionalPublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizePublicWebUrl(value);
  } catch {
    return undefined;
  }
}

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** Fixed messages only: error bodies are never read or echoed. */
function serviceError(status: number, endpoint: Endpoint): WebAccessError {
  switch (status) {
    case 400:
    case 413:
      return new WebAccessError(
        endpoint === "fetch"
          ? "DeepSeek rejected this page URL."
          : "DeepSeek rejected the search request parameters.",
        "validation",
        status,
      );
    case 401:
      return new WebAccessError(
        "DeepSeek rejected the API key. Check the key in your DeepSeek model profile.",
        "authentication",
        status,
      );
    case 402:
      return new WebAccessError(
        "DeepSeek balance is insufficient. Top up at platform.deepseek.com.",
        "quota",
        status,
      );
    case 403:
      // Search has no documented 403; Fetch uses it for its security policy.
      return new WebAccessError(
        endpoint === "fetch"
          ? "DeepSeek refused to fetch this page under its security policy."
          : "DeepSeek refused the search request.",
        "service",
        status,
      );
    case 404:
      return new WebAccessError(
        endpoint === "fetch"
          ? "DeepSeek could not get usable content from this page."
          : "DeepSeek request failed.",
        "service",
        status,
      );
    case 408:
      return new WebAccessError(
        "DeepSeek request timed out.",
        "timeout",
        status,
      );
    case 429:
      return new WebAccessError(
        endpoint === "fetch"
          ? "DeepSeek fetch rate limit reached for this site. Try again later."
          : "DeepSeek search rate limit reached. Try again later.",
        "rate_limit",
        status,
      );
    default:
      return new WebAccessError(
        status >= 500
          ? "DeepSeek search is temporarily unavailable. Try again later."
          : "DeepSeek request failed.",
        "service",
        status,
      );
  }
}

/** Results with a missing or unsafe URL are dropped, not reported. */
function searchSource(value: unknown): WebSourceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const url = optionalPublicUrl(entry.url);
  if (!url) return undefined;
  const hostname = hostnameOf(url);
  // summary is DeepSeek's model-facing text; snippet is meant for a UI.
  const snippet =
    text(entry.summary, CONTENT_LIMIT) || text(entry.snippet, CONTENT_LIMIT);
  const faviconUrl = optionalPublicUrl(entry.site_icon);
  const publishedDate = text(entry.date, 80);
  const score = entry.rerank_score;
  return {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: text(entry.site_name, 160) || hostname,
    title: text(entry.title, 500) || hostname,
    ...(faviconUrl ? { faviconUrl } : {}),
    ...(snippet ? { snippet } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
  };
}

export class DeepSeekSearchClient implements WebAccessProvider {
  private readonly apiKey: string;

  constructor(
    apiKey: string,
    private readonly transport: DeepSeekSearchTransport = isolatedJsonTransport,
  ) {
    this.apiKey = apiKey.trim();
    if (!this.apiKey) {
      throw new WebAccessError(
        "DeepSeek search needs the API key of an official DeepSeek model profile.",
        "authentication",
      );
    }
  }

  private async request(
    endpoint: Endpoint,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new WebAccessError("DeepSeek request was cancelled.", "cancelled");
    }
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch {
      throw new WebAccessError(
        "DeepSeek request failed or returned an invalid response.",
        "service",
      );
    }
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(
          new WebAccessError(
            timedOut
              ? "DeepSeek request timed out."
              : "DeepSeek request was cancelled.",
            timedOut ? "timeout" : "cancelled",
          ),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    let response: Awaited<ReturnType<DeepSeekSearchTransport>>;
    try {
      response = await Promise.race([
        this.transport({
          method: "POST",
          url: `${DEEPSEEK_SEARCH_ORIGIN}/v1/tools/${endpoint}`,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch {
      // Do not retain transport exceptions, response bodies, or their causes.
      if (timedOut)
        throw new WebAccessError("DeepSeek request timed out.", "timeout");
      if (signal?.aborted)
        throw new WebAccessError(
          "DeepSeek request was cancelled.",
          "cancelled",
        );
      throw new WebAccessError(
        "DeepSeek request failed or returned an invalid response.",
        "network",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort)
        controller.signal.removeEventListener("abort", rejectAbort);
    }
    if (response.status < 200 || response.status >= 300) {
      throw serviceError(response.status, endpoint);
    }
    return record(response.body);
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (
      [request.depth, request.topic, request.timeRange].some(
        (value) => value !== undefined,
      )
    ) {
      throw new WebAccessError(
        "DeepSeek search does not support Tavily depth, topic, or time range.",
        "validation",
      );
    }
    if (
      (request.includeDomains?.length || 0) > DEEPSEEK_DOMAIN_LIMIT ||
      (request.excludeDomains?.length || 0) > DEEPSEEK_DOMAIN_LIMIT
    ) {
      throw new WebAccessError(
        `DeepSeek search accepts at most ${DEEPSEEK_DOMAIN_LIMIT} included and ${DEEPSEEK_DOMAIN_LIMIT} excluded domains.`,
        "validation",
      );
    }
    const query = buildDeepSeekQuery(request);
    const length = countQueryCharacters(query);
    if (
      !request.query?.trim() ||
      length > DEEPSEEK_QUERY_LIMIT ||
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > 10
    ) {
      throw new WebAccessError(
        `DeepSeek search requires a query of at most ${DEEPSEEK_QUERY_LIMIT} characters including filters (this one uses ${length}) and 1–10 results.`,
        "validation",
      );
    }
    // No ori_question or localization: the user's question and IP stay local.
    const data = await this.request(
      "search",
      { query, count: request.maxResults, need_content: false },
      request.signal,
    );
    if (!Array.isArray(data.results)) {
      throw new WebAccessError(
        "DeepSeek returned an invalid results list.",
        "service",
      );
    }
    return {
      provider: "deepseek",
      query: request.query,
      results: data.results
        .map(searchSource)
        .filter((source): source is WebSourceRecord => Boolean(source))
        .slice(0, request.maxResults),
    };
  }

  private async fetchPage(
    url: string,
    signal?: AbortSignal,
    wholePage = false,
  ): Promise<WebSourceRecord> {
    const data = await this.request("fetch", { url }, signal);
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new WebAccessError("DeepSeek returned no page content.", "service");
    }
    // Fetch returns no URL, so the requested URL keeps its searched source ID.
    const hostname = hostnameOf(url);
    if (wholePage) {
      const page = normalizePageText(data.content);
      return {
        sourceId: buildWebSourceId(url),
        url,
        hostname,
        organization: hostname,
        title: text(data.title, 500) || hostname,
        content: page.text,
        ...(page.truncated ? { truncated: true } : {}),
      };
    }
    return {
      sourceId: buildWebSourceId(url),
      url,
      hostname,
      organization: hostname,
      title: text(data.title, 500) || hostname,
      content: data.content.slice(0, CONTENT_LIMIT),
      ...(data.content.length > CONTENT_LIMIT ? { truncated: true } : {}),
    };
  }

  async read(request: WebReadRequest): Promise<WebReadResponse> {
    if (
      !Array.isArray(request.urls) ||
      !request.urls.length ||
      request.urls.length > 5
    ) {
      throw new WebAccessError(
        "DeepSeek reads require 1–5 public URLs.",
        "validation",
      );
    }
    if (
      [request.query, request.depth, request.chunksPerSource].some(
        (value) => value !== undefined,
      )
    ) {
      throw new WebAccessError(
        "DeepSeek fetch does not support query, depth, or chunksPerSource.",
        "validation",
      );
    }
    const urls = [...new Set(request.urls.map(normalizePublicWebUrl))];
    const pages: (WebSourceRecord | undefined)[] = new Array(urls.length);
    const failures: (WebReadFailure | undefined)[] = new Array(urls.length);
    let next = 0;
    let stopped: string | undefined;
    const worker = async () => {
      while (next < urls.length) {
        if (request.signal?.aborted) {
          throw new WebAccessError(
            "DeepSeek request was cancelled.",
            "cancelled",
          );
        }
        const index = next++;
        const url = urls[index];
        if (stopped) {
          failures[index] = { url, error: stopped };
          continue;
        }
        try {
          pages[index] = await this.fetchPage(
            url,
            request.signal,
            request.wholePage,
          );
        } catch (error) {
          if (request.signal?.aborted)
            throw new WebAccessError(
              "DeepSeek request was cancelled.",
              "cancelled",
            );
          failures[index] = {
            url,
            error:
              error instanceof WebAccessError
                ? error.message
                : "DeepSeek could not fetch this page.",
          };
          // A rate limit can be per site, so only key and balance errors stop
          // the batch.
          if (
            error instanceof WebAccessError &&
            ["authentication", "quota"].includes(error.code)
          ) {
            stopped =
              "Remaining DeepSeek reads were not attempted after a key or balance error.";
          }
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return {
      provider: "deepseek",
      pages: pages.filter((page): page is WebSourceRecord => Boolean(page)),
      failedResults: failures.filter((failure): failure is WebReadFailure =>
        Boolean(failure),
      ),
    };
  }

  async getUsage(): Promise<WebAccessUsageSnapshot> {
    throw new WebAccessError(
      "DeepSeek search usage is not available in this integration.",
      "validation",
    );
  }
}
