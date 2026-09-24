import { version } from "../../package.json";
import { createAbortController } from "../utils/apiHelpers";
import { WebAccessError } from "./errors";
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

const ORIGIN = "https://api.anysearch.com";
const TIMEOUT_MS = 60_000;
const CONTENT_LIMIT = 12_000;
const RESPONSE_LIMIT = 1_048_576;

export type AnysearchTransport = (request: {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebAccessError(
      "AnySearch returned an invalid response.",
      "service",
    );
  }
  return value as Record<string, unknown>;
}

function parseBody(text: string): unknown {
  if (
    text.length > RESPONSE_LIMIT ||
    new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT
  ) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readLimitedResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > RESPONSE_LIMIT
  ) {
    await response.body?.cancel();
    throw new Error("Response size limit exceeded.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response streaming unavailable.");
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Response size limit exceeded.");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parseBody(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

/** Never parse or propagate error bodies: quota messages can contain credentials. */
async function defaultTransport(
  request: Parameters<AnysearchTransport>[0],
): ReturnType<AnysearchTransport> {
  const zotero =
    typeof Zotero !== "undefined"
      ? Zotero
      : (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero;
  // The runtime HTTP API is newer than the bundled type declarations.
  type CookieContext = { id: number; dispose: () => void };
  const http = zotero?.HTTP as
    | (typeof Zotero.HTTP & { newCookieContext?: () => CookieContext })
    | undefined;
  if (http?.request) {
    let cookieContext: CookieContext | undefined;
    let cancel: (() => void) | undefined;
    let tooLarge = false;
    let observedStatus = 0;
    let removeObservers: (() => void) | undefined;
    const abort = () => cancel?.();
    try {
      // Modern Zotero has no CookieSandbox constructor. Always create a fresh
      // context, and never fall back to ambient cookies if its setup fails.
      let isolation:
        | { userContextId: number }
        | { cookieSandbox: Zotero.CookieSandbox };
      if (typeof http.newCookieContext === "function") {
        cookieContext = http.newCookieContext();
        if (
          !cookieContext ||
          !Number.isSafeInteger(cookieContext.id) ||
          cookieContext.id <= 0 ||
          typeof cookieContext.dispose !== "function"
        ) {
          throw new Error("Cookie isolation unavailable.");
        }
        isolation = { userContextId: cookieContext.id };
      } else {
        const CookieSandbox = (
          zotero as unknown as { CookieSandbox?: Zotero.CookieSandbox }
        ).CookieSandbox;
        if (!CookieSandbox) throw new Error("Cookie isolation unavailable.");
        isolation = { cookieSandbox: new CookieSandbox(null, ORIGIN, "", "") };
      }
      const components =
        typeof Components !== "undefined"
          ? Components
          : (
              globalThis as unknown as {
                Components?: {
                  interfaces?: { nsIRequest?: { LOAD_ANONYMOUS?: number } };
                };
              }
            ).Components;
      const anonymousFlag = components?.interfaces?.nsIRequest?.LOAD_ANONYMOUS;
      if (typeof anonymousFlag !== "number" || anonymousFlag <= 0) {
        throw new Error("Anonymous channel isolation unavailable.");
      }
      request.signal.addEventListener("abort", abort, { once: true });
      const options = {
        // Zotero 10 supports anon. The explicit channel flag below also
        // enforces no cached HTTP authentication on older supported runtimes.
        anon: true,
        headers: request.headers,
        body: request.body,
        responseType: "text",
        timeout: TIMEOUT_MS,
        successCodes: false as const,
        errorDelayMax: 0,
        followRedirects: false,
        debug: false,
        foreground: false,
        ...isolation,
        logBodyLength: 0,
        requestObserver: (xhr: XMLHttpRequest) => {
          const channel = (
            xhr as XMLHttpRequest & { channel?: { loadFlags: number } }
          ).channel;
          if (!channel || typeof channel.loadFlags !== "number") {
            throw new Error("Anonymous channel isolation unavailable.");
          }
          channel.loadFlags |= anonymousFlag;
          if ((channel.loadFlags & anonymousFlag) !== anonymousFlag) {
            throw new Error("Anonymous channel isolation failed.");
          }
          const stopOversize = () => {
            tooLarge = true;
            observedStatus = Number(xhr.status) || 0;
            xhr.abort();
          };
          const onHeaders = () => {
            if (xhr.readyState !== 2) return;
            const length = xhr.getResponseHeader("content-length");
            if (
              length &&
              /^\d+$/.test(length) &&
              Number(length) > RESPONSE_LIMIT
            ) {
              stopOversize();
            }
          };
          const onProgress = (event: ProgressEvent) => {
            if (event.loaded > RESPONSE_LIMIT) stopOversize();
          };
          xhr.addEventListener("readystatechange", onHeaders);
          xhr.addEventListener("progress", onProgress);
          removeObservers = () => {
            xhr.removeEventListener("readystatechange", onHeaders);
            xhr.removeEventListener("progress", onProgress);
          };
        },
        cancellerReceiver: (fn: () => void) => {
          cancel = fn;
          if (request.signal.aborted) fn();
        },
      };
      let xhr: XMLHttpRequest;
      try {
        xhr = await http.request(request.method, request.url, options);
      } catch {
        if (tooLarge) return { status: observedStatus || 200, body: undefined };
        throw new Error("Native transport failed.");
      }
      const status = Number(xhr.status) || 0;
      return {
        status,
        body:
          !tooLarge && status >= 200 && status < 300
            ? parseBody(xhr.responseText || "")
            : undefined,
      };
    } finally {
      try {
        removeObservers?.();
      } finally {
        try {
          request.signal.removeEventListener("abort", abort);
        } finally {
          if (typeof cookieContext?.dispose === "function") {
            cookieContext.dispose();
          }
        }
      }
    }
  }
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  return { status: response.status, body: await readLimitedResponse(response) };
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

function source(value: unknown, extracted: boolean): WebSourceRecord {
  const entry = record(value);
  const url = normalizePublicWebUrl(entry.url);
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const content =
    typeof entry.content === "string"
      ? entry.content
      : !extracted && typeof entry.snippet === "string"
        ? entry.snippet
        : undefined;
  if (typeof entry.title !== "string" || content === undefined) {
    throw new WebAccessError(
      "AnySearch returned incomplete result fields.",
      "service",
    );
  }
  return {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: hostname,
    title: entry.title.replace(/\s+/g, " ").trim().slice(0, 500) || hostname,
    ...(extracted
      ? { content: content.slice(0, CONTENT_LIMIT) }
      : { snippet: content.slice(0, CONTENT_LIMIT) }),
    ...(content.length > CONTENT_LIMIT ? { truncated: true } : {}),
  };
}

export class AnysearchClient implements WebAccessProvider {
  private readonly apiKey: string;

  constructor(
    apiKey = "",
    private readonly transport: AnysearchTransport = defaultTransport,
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
          const page = source(result.data, true);
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
