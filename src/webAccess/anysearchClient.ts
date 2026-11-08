import { version } from "../../package.json";
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

const ORIGIN = "https://api.anysearch.com";
const TIMEOUT_MS = 60_000;
const CONTENT_LIMIT = 12_000;

export type AnysearchTransport = IsolatedJsonTransport;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebAccessError(
      "AnySearch returned an invalid response.",
      "service",
    );
  }
  return value as Record<string, unknown>;
}

function serviceError(status: number): WebAccessError {
  switch (status) {
    case 400:
    case 422:
      return new WebAccessError(
        "AnySearch rejected the request parameters.",
        "validation",
        status,
      );
    case 401:
    case 403:
      return new WebAccessError(
        "AnySearch rejected authentication or access. Check the configured key and permissions.",
        "authentication",
        status,
      );
    case 402:
      return new WebAccessError(
        "AnySearch quota exhausted. No credentials were adopted and no retry was made.",
        "quota",
        status,
      );
    case 429:
      return new WebAccessError(
        "AnySearch rate limit reached. Try again later.",
        "rate_limit",
        status,
      );
    default:
      return new WebAccessError("AnySearch request failed.", "service", status);
  }
}

function source(
  value: unknown,
  extracted: boolean,
  wholePage = false,
): WebSourceRecord {
  const entry = record(value);
  const url = normalizePublicWebUrl(entry.url);
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const content =
    typeof entry.content === "string"
      ? entry.content
      : !extracted && typeof entry.snippet === "string"
        ? entry.snippet
        : undefined;
  if (typeof entry.title !== "string" || (extracted && content === undefined)) {
    throw new WebAccessError(
      "AnySearch returned incomplete result fields.",
      "service",
    );
  }
  if (extracted && wholePage && content !== undefined) {
    const page = normalizePageText(content);
    return {
      sourceId: buildWebSourceId(url),
      url,
      hostname,
      organization: hostname,
      title: entry.title.replace(/\s+/g, " ").trim().slice(0, 500) || hostname,
      content: page.text,
      ...(page.truncated ? { truncated: true } : {}),
    };
  }
  return {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: hostname,
    title: entry.title.replace(/\s+/g, " ").trim().slice(0, 500) || hostname,
    ...(content === undefined
      ? {}
      : extracted
        ? { content: content.slice(0, CONTENT_LIMIT) }
        : { snippet: content.slice(0, CONTENT_LIMIT) }),
    ...(content !== undefined && content.length > CONTENT_LIMIT
      ? { truncated: true }
      : {}),
  };
}

export class AnysearchClient implements WebAccessProvider {
  private readonly apiKey: string;

  constructor(
    apiKey = "",
    private readonly transport: AnysearchTransport = isolatedJsonTransport,
  ) {
    this.apiKey = apiKey.trim();
  }

  private async request(
    path: "/v1/search" | "/v1/extract",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: Record<string, unknown>; requestId?: string }> {
    if (signal?.aborted) {
      throw new WebAccessError("AnySearch request was cancelled.", "cancelled");
    }
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch {
      throw new WebAccessError(
        "AnySearch request failed or returned an invalid response.",
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
              ? "AnySearch request timed out."
              : "AnySearch request was cancelled.",
            timedOut ? "timeout" : "cancelled",
          ),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    let response: Awaited<ReturnType<AnysearchTransport>>;
    try {
      response = await Promise.race([
        this.transport({
          method: "POST",
          url: `${ORIGIN}${path}`,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Anysearch-Client": `llm-for-zotero/${version}`,
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch {
      // Do not retain transport exceptions, response bodies, or their causes.
      if (timedOut)
        throw new WebAccessError("AnySearch request timed out.", "timeout");
      if (signal?.aborted)
        throw new WebAccessError(
          "AnySearch request was cancelled.",
          "cancelled",
        );
      throw new WebAccessError(
        "AnySearch request failed or returned an invalid response.",
        "network",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort)
        controller.signal.removeEventListener("abort", rejectAbort);
    }
    if (response.status < 200 || response.status >= 300) {
      // Do not even inspect a returned error body's fields.
      throw serviceError(response.status);
    }
    const envelope = record(response.body);
    if (envelope.code !== 0) {
      // Business failures can also contain sensitive messages, even on HTTP 200.
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        const error = serviceError(envelope.code);
        throw new WebAccessError(error.message, error.code, response.status);
      }
      throw new WebAccessError(
        "AnySearch returned an invalid business status.",
        "service",
      );
    }
    const requestId =
      typeof envelope.request_id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(envelope.request_id) &&
      (!this.apiKey || !envelope.request_id.includes(this.apiKey))
        ? envelope.request_id
        : undefined;
    return { data: record(envelope.data), ...(requestId ? { requestId } : {}) };
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
        "AnySearch requires a query and 1–10 results.",
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
        "AnySearch does not support Tavily depth, topic, date, or domain filters.",
        "validation",
      );
    }
    const result = await this.request(
      "/v1/search",
      {
        query: request.query,
        max_results: request.maxResults,
      },
      request.signal,
    );
    if (!Array.isArray(result.data.results)) {
      throw new WebAccessError(
        "AnySearch returned an invalid results list.",
        "service",
      );
    }
    return {
      provider: "anysearch",
      query: request.query,
      results: result.data.results
        .slice(0, request.maxResults)
        .map((entry) => source(entry, false)),
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  async read(request: WebReadRequest): Promise<WebReadResponse> {
    if (
      !Array.isArray(request.urls) ||
      !request.urls.length ||
      request.urls.length > 5
    ) {
      throw new WebAccessError(
        "AnySearch reads require 1–5 public URLs.",
        "validation",
      );
    }
    if (
      [request.query, request.depth, request.chunksPerSource].some(
        (value) => value !== undefined,
      )
    ) {
      throw new WebAccessError(
        "AnySearch extraction does not support query, depth, or chunksPerSource.",
        "validation",
      );
    }
    const urls = [...new Set(request.urls.map(normalizePublicWebUrl))];
    const pages: (WebSourceRecord | undefined)[] = new Array(urls.length);
    const failures: (WebReadFailure | undefined)[] = new Array(urls.length);
    const requestIds: (string | undefined)[] = new Array(urls.length);
    let next = 0;
    let stopped: string | undefined;
    const worker = async () => {
      while (next < urls.length) {
        if (request.signal?.aborted) {
          throw new WebAccessError(
            "AnySearch request was cancelled.",
            "cancelled",
          );
        }
        const index = next++;
        const url = urls[index];
        try {
          if (stopped) {
            failures[index] = { url, error: stopped };
            continue;
          }
          if (
            /\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|mp[34]|zip)(?:$|[?])/i.test(
              new URL(url).pathname,
            )
          ) {
            throw new WebAccessError(
              "AnySearch extraction does not support PDF, Office, or media binaries.",
              "validation",
            );
          }
          const result = await this.request(
            "/v1/extract",
            { url },
            request.signal,
          );
          const page = source(result.data, true, request.wholePage);
          // Do not let an unexpected response URL acquire a searched source ID.
          if (page.url !== url) {
            throw new WebAccessError(
              "AnySearch returned a different extraction URL.",
              "service",
            );
          }
          pages[index] = page;
          requestIds[index] = result.requestId;
        } catch (error) {
          if (request.signal?.aborted)
            throw new WebAccessError(
              "AnySearch request was cancelled.",
              "cancelled",
            );
          failures[index] = {
            url,
            error:
              error instanceof WebAccessError
                ? error.message
                : "AnySearch could not extract this page.",
          };
          if (
            error instanceof WebAccessError &&
            ["authentication", "quota", "rate_limit"].includes(error.code)
          ) {
            stopped =
              "Remaining AnySearch reads were not attempted after an access or quota error.";
          }
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return {
      provider: "anysearch",
      pages: pages.filter((page): page is WebSourceRecord => Boolean(page)),
      failedResults: failures.filter((failure): failure is WebReadFailure =>
        Boolean(failure),
      ),
      requestIds: requestIds.filter((id): id is string => Boolean(id)),
    };
  }

  async getUsage(): Promise<WebAccessUsageSnapshot> {
    throw new WebAccessError(
      "AnySearch usage metrics are not available in this integration.",
      "validation",
    );
  }
}
