import { createAbortController } from "../utils/apiHelpers";
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

const ORIGIN = "https://api.keenable.ai";
const TIMEOUT_MS = 60_000;
const CONTENT_LIMIT = 12_000;
/** Keyless requests must name the app; the key only lifts rate limits. */
const APP_TITLE = "llm-for-zotero";

export type KeenableTransport = IsolatedJsonTransport;

type Endpoint = "search" | "fetch";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebAccessError(
      "Keenable returned an invalid response.",
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

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** Fixed messages only: error bodies are never read or echoed. */
function serviceError(status: number): WebAccessError {
  switch (status) {
    case 400:
    case 422:
      return new WebAccessError(
        "Keenable rejected the request parameters.",
        "validation",
        status,
      );
    case 401:
    case 403:
      return new WebAccessError(
        "Keenable rejected the API key. Check the key, or leave it blank for keyless access.",
        "authentication",
        status,
      );
    case 402:
      return new WebAccessError(
        "Keenable quota exhausted. No retry was made.",
        "quota",
        status,
      );
    case 429:
      return new WebAccessError(
        "Keenable rate limit reached. Try again later, or add an API key for higher limits.",
        "rate_limit",
        status,
      );
    default:
      return new WebAccessError("Keenable request failed.", "service", status);
  }
}

/** Results with a missing or unsafe URL are dropped, not reported. */
function searchSource(value: unknown): WebSourceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  let url: string;
  try {
    url = normalizePublicWebUrl(entry.url);
  } catch {
    return undefined;
  }
  const hostname = hostnameOf(url);
  // Keenable leaves description empty; snippet holds the page text.
  const snippet =
    typeof entry.snippet === "string" ? entry.snippet.trim() : undefined;
  return {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: hostname,
    title: text(entry.title, 500) || hostname,
    ...(snippet ? { snippet: snippet.slice(0, CONTENT_LIMIT) } : {}),
    ...(snippet && snippet.length > CONTENT_LIMIT ? { truncated: true } : {}),
  };
}

export class KeenableClient implements WebAccessProvider {
  private readonly apiKey: string;

  constructor(
    apiKey = "",
    private readonly transport: KeenableTransport = isolatedJsonTransport,
  ) {
    this.apiKey = apiKey.trim();
  }

  /** Without a key the public routes are used; they ignore any key. */
  private endpointUrl(endpoint: Endpoint, pageUrl?: string): string {
    const path = `/v1/${endpoint}${this.apiKey ? "" : "/public"}`;
    return pageUrl
      ? `${ORIGIN}${path}?url=${encodeURIComponent(pageUrl)}`
      : `${ORIGIN}${path}`;
  }

  private async request(
    endpoint: Endpoint,
    options: { body?: Record<string, unknown>; pageUrl?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new WebAccessError("Keenable request was cancelled.", "cancelled");
    }
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch {
      throw new WebAccessError(
        "Keenable request failed or returned an invalid response.",
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
              ? "Keenable request timed out."
              : "Keenable request was cancelled.",
            timedOut ? "timeout" : "cancelled",
          ),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    let response: Awaited<ReturnType<KeenableTransport>>;
    try {
      response = await Promise.race([
        this.transport({
          method: options.body ? "POST" : "GET",
          url: this.endpointUrl(endpoint, options.pageUrl),
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            "X-Keenable-Title": APP_TITLE,
            ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch {
      // Do not retain transport exceptions, response bodies, or their causes.
      if (timedOut)
        throw new WebAccessError("Keenable request timed out.", "timeout");
      if (signal?.aborted)
        throw new WebAccessError(
          "Keenable request was cancelled.",
          "cancelled",
        );
      throw new WebAccessError(
        "Keenable request failed or returned an invalid response.",
        "network",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort)
        controller.signal.removeEventListener("abort", rejectAbort);
    }
    if (response.status < 200 || response.status >= 300) {
      throw serviceError(response.status);
    }
    return record(response.body);
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (
      !request.query?.trim() ||
      request.query.length > 2_000 ||
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > 10
    )
      throw new WebAccessError(
        "Keenable requires a query and 1–10 results.",
        "validation",
      );
    if (
      [
        request.depth,
        request.topic,
        request.timeRange,
        request.startDate,
        request.endDate,
        request.includeDomains,
        request.excludeDomains,
      ].some((value) => value !== undefined)
    ) {
      throw new WebAccessError(
        "Keenable does not support Tavily depth, topic, date, or domain filters.",
        "validation",
      );
    }
    const data = await this.request(
      "search",
      { body: { query: request.query, max_results: request.maxResults } },
      request.signal,
    );
    if (!Array.isArray(data.results)) {
      throw new WebAccessError(
        "Keenable returned an invalid results list.",
        "service",
      );
    }
    return {
      provider: "keenable",
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
    const data = await this.request("fetch", { pageUrl: url }, signal);
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new WebAccessError("Keenable returned no page content.", "service");
    }
    // The requested URL keeps its searched source ID, even if Keenable
    // reports a normalized or redirected one.
    const hostname = hostnameOf(url);
    const title = text(data.title, 500) || hostname;
    if (wholePage) {
      const page = normalizePageText(data.content);
      return {
        sourceId: buildWebSourceId(url),
        url,
        hostname,
        organization: hostname,
        title,
        content: page.text,
        ...(page.truncated ? { truncated: true } : {}),
      };
    }
    return {
      sourceId: buildWebSourceId(url),
      url,
      hostname,
      organization: hostname,
      title,
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
        "Keenable reads require 1–5 public URLs.",
        "validation",
      );
    }
    if (
      [request.query, request.depth, request.chunksPerSource].some(
        (value) => value !== undefined,
      )
    ) {
      throw new WebAccessError(
        "Keenable fetch does not support query, depth, or chunksPerSource.",
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
            "Keenable request was cancelled.",
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
              "Keenable request was cancelled.",
              "cancelled",
            );
          failures[index] = {
            url,
            error:
              error instanceof WebAccessError
                ? error.message
                : "Keenable could not fetch this page.",
          };
          // Keyless limits are per IP, so a rate limit also stops the batch.
          if (
            error instanceof WebAccessError &&
            ["authentication", "quota", "rate_limit"].includes(error.code)
          ) {
            stopped =
              "Remaining Keenable reads were not attempted after an access or rate limit error.";
          }
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return {
      provider: "keenable",
      pages: pages.filter((page): page is WebSourceRecord => Boolean(page)),
      failedResults: failures.filter((failure): failure is WebReadFailure =>
        Boolean(failure),
      ),
    };
  }

  async getUsage(): Promise<WebAccessUsageSnapshot> {
    throw new WebAccessError(
      "Keenable usage metrics are not available in this integration.",
      "validation",
    );
  }
}
