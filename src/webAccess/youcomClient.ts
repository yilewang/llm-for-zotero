import type {
  WebAccessProvider,
  WebAccessUsage,
  WebAccessUsageSnapshot,
  WebReadFailure,
  WebReadRequest,
  WebReadResponse,
  WebSearchRequest,
  WebSearchResponse,
  WebSourceRecord,
} from "./types";
import { WebAccessError } from "./errors";
import { buildWebSourceId, normalizePublicWebUrl } from "./tavilyClient";

const YOUCOM_API_ORIGIN = "https://api.ydc-index.io";
const YOUCOM_SEARCH_URL = `${YOUCOM_API_ORIGIN}/v1/search`;
const YOUCOM_CONTENTS_URL = `${YOUCOM_API_ORIGIN}/v1/contents`;
const YOUCOM_BALANCE_URL = "https://api.you.com/v1/billing/account_balance";

export type YoucomTransport = typeof defaultYoucomTransport;

type YoucomTransportResponse = {
  status: number;
  body: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readNonNegativeNumber(value: unknown): number {
  const number = readFiniteNumber(value);
  return number === undefined ? 0 : Math.max(0, number);
}

function parseJsonBody(text: string): unknown {
  const clean = text.trim();
  if (!clean) return {};
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return { detail: clean.slice(0, 500) };
  }
}

async function defaultYoucomTransport(params: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<YoucomTransportResponse> {
  const zoteroHttp = (
    globalThis as typeof globalThis & {
      Zotero?: typeof Zotero;
    }
  ).Zotero?.HTTP;
  if (zoteroHttp?.request) {
    let cancelRequest: (() => void) | undefined;
    const abort = () => cancelRequest?.();
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      const xhr = await zoteroHttp.request(params.method, params.url, {
        headers: params.headers,
        body: params.body,
        responseType: "text",
        timeout: 60_000,
        successCodes: false,
        errorDelayMax: 0,
        logBodyLength: 0,
        cancellerReceiver: (cancel: () => void) => {
          cancelRequest = cancel;
          if (params.signal?.aborted) cancel();
        },
      });
      return {
        status: Number(xhr.status) || 0,
        body: parseJsonBody(xhr.responseText || ""),
      };
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  }

  const response = await fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: params.body,
    signal: params.signal,
  });
  return {
    status: response.status,
    body: parseJsonBody(await response.text()),
  };
}

function hostnameForUrl(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

function normalizeDisplayText(value: unknown, maxLength: number): string {
  return readString(value).replace(/\s+/g, " ").slice(0, maxLength).trim();
}

function normalizeOptionalPublicWebUrl(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    return normalizePublicWebUrl(raw);
  } catch {
    return undefined;
  }
}

function searchResultSnippet(result: Record<string, unknown>): string {
  const snippets = Array.isArray(result.snippets)
    ? result.snippets.map((entry) => readString(entry)).filter(Boolean)
    : [];
  if (snippets.length) return normalizeDisplayText(snippets.join(" "), 2_000);
  return normalizeDisplayText(result.description, 2_000);
}

function normalizeSearchSource(value: unknown): WebSourceRecord {
  const result = asRecord(value);
  const url = normalizePublicWebUrl(result.url);
  const hostname = hostnameForUrl(url);
  const title = normalizeDisplayText(result.title, 500) || hostname;
  const source: WebSourceRecord = {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: hostname,
    title,
    snippet: searchResultSnippet(result),
  };
  const faviconUrl = normalizeOptionalPublicWebUrl(result.favicon_url);
  if (faviconUrl) source.faviconUrl = faviconUrl;
  const publishedDate = normalizeDisplayText(result.page_age, 80);
  if (publishedDate) source.publishedDate = publishedDate;
  return source;
}

function contentsPageMarkdown(page: Record<string, unknown>): string {
  const contents = asRecord(page.contents);
  return normalizeDisplayText(
    readString(page.markdown) || contents.markdown,
    12_000,
  );
}

function normalizeContentsPage(value: unknown): WebSourceRecord {
  const page = asRecord(value);
  const url = normalizePublicWebUrl(page.url);
  const hostname = hostnameForUrl(url);
  const metadata = asRecord(page.metadata);
  const title =
    normalizeDisplayText(page.title, 500) ||
    normalizeDisplayText(metadata.site_name, 160) ||
    hostname;
  const source: WebSourceRecord = {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: normalizeDisplayText(metadata.site_name, 160) || hostname,
    title,
    content: contentsPageMarkdown(page),
  };
  const faviconUrl = normalizeOptionalPublicWebUrl(
    metadata.favicon_url ?? page.favicon_url,
  );
  if (faviconUrl) source.faviconUrl = faviconUrl;
  return source;
}

function readErrorDetail(body: unknown): string {
  const record = asRecord(body);
  const detail = record.detail;
  if (typeof detail === "string") return detail.trim();
  const nested = asRecord(detail);
  return readString(nested.error) || readString(record.error);
}

export class YoucomApiError extends WebAccessError {
  constructor(
    message: string,
    code: ConstructorParameters<typeof WebAccessError>[1],
    status: number,
    requestId?: string,
  ) {
    super(message, code, status, requestId);
    this.name = "YoucomApiError";
  }
}

function mapYoucomError(
  status: number,
  body: unknown,
  apiKey: string,
): YoucomApiError {
  const record = asRecord(body);
  const requestId = readString(record.request_id) || undefined;
  const detail = readErrorDetail(body).split(apiKey).join("[redacted]");
  let message: string;
  let code: ConstructorParameters<typeof WebAccessError>[1];
  switch (status) {
    case 400:
    case 422:
      code = "validation";
      message = `You.com rejected the request${detail ? `: ${detail}` : "."}`;
      break;
    case 401:
    case 403:
      code = "authentication";
      message =
        "You.com rejected the API key. Check it in Preferences → Agent.";
      break;
    case 429:
      code = "rate_limit";
      message = "You.com rate-limited the request. Try again later.";
      break;
    case 402:
      code = "quota";
      message =
        "The You.com account credit balance could not cover the request.";
      break;
    default:
      code = "service";
      message =
        status >= 500
          ? "You.com is temporarily unavailable. Try again later."
          : `You.com request failed with HTTP ${status}${detail ? `: ${detail}` : "."}`;
  }
  return new YoucomApiError(message, code, status, requestId);
}

function normalizeUsage(): WebAccessUsage {
  // You.com bills per request/page rather than exposing per-request credit
  // counts, so search and read report zero incremental credits.
  return { credits: 0 };
}

export class YoucomClient implements WebAccessProvider {
  private readonly apiKey: string;
  private readonly transport: YoucomTransport;

  constructor(
    apiKey: string,
    transport: YoucomTransport = defaultYoucomTransport,
  ) {
    this.apiKey = apiKey.trim();
    this.transport = transport;
    if (!this.apiKey) {
      throw new WebAccessError(
        "A You.com API key is required.",
        "authentication",
      );
    }
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: YoucomTransportResponse;
    try {
      response = await this.transport({
        method,
        url,
        headers: {
          Accept: "application/json",
          "X-API-Key": this.apiKey,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal,
      });
    } catch {
      if (signal?.aborted) {
        throw new WebAccessError("You.com request was cancelled.", "cancelled");
      }
      throw new WebAccessError(
        "Could not reach You.com. Check the network connection.",
        "network",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapYoucomError(response.status, response.body, this.apiKey);
    }
    return response.body;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const body = asRecord(
      await this.request(
        "POST",
        YOUCOM_SEARCH_URL,
        {
          query: request.query,
          count: Math.min(Math.max(request.maxResults, 1), 10),
          ...(request.timeRange ? { freshness: request.timeRange } : {}),
          ...(request.startDate && request.endDate
            ? { freshness: `${request.startDate}to${request.endDate}` }
            : {}),
          ...(request.includeDomains?.length
            ? { include_domains: request.includeDomains }
            : {}),
          ...(request.excludeDomains?.length
            ? { exclude_domains: request.excludeDomains }
            : {}),
          ...(request.topic === "news" ? { country: "US" } : {}),
        },
        request.signal,
      ),
    );
    const results = asRecord(body.results);
    const web = Array.isArray(results.web) ? results.web : [];
    const news = Array.isArray(results.news) ? results.news : [];
    const sources = [...web, ...news].flatMap((entry) => {
      try {
        return [normalizeSearchSource(entry)];
      } catch {
        return [];
      }
    });
    const metadata = asRecord(body.metadata);
    return {
      provider: "youcom",
      query: readString(metadata.query) || request.query,
      depth: request.depth,
      topic: request.topic,
      results: sources.slice(0, request.maxResults),
      usage: normalizeUsage(),
      ...(readString(metadata.search_uuid)
        ? { requestId: readString(metadata.search_uuid) }
        : {}),
    };
  }

  async read(request: WebReadRequest): Promise<WebReadResponse> {
    const urls = request.urls.map(normalizePublicWebUrl);
    const raw = await this.request(
      "POST",
      YOUCOM_CONTENTS_URL,
      {
        urls,
        formats: ["markdown"],
        ...(request.depth === "advanced" ? { crawl_timeout: 30 } : {}),
      },
      request.signal,
    );
    const pages: unknown[] = Array.isArray(raw) ? raw : [];
    const readPages: WebSourceRecord[] = [];
    const succeededUrls = new Set<string>();
    const failedResults: WebReadFailure[] = [];
    for (const entry of pages) {
      const page = asRecord(entry);
      // You.com returns null markdown/html when a URL fails (404, login
      // wall), so route those to failedResults like Tavily's failed_results.
      if (!readString(page.markdown)) {
        try {
          failedResults.push({
            url: normalizePublicWebUrl(page.url),
            error: "You.com could not extract this page.",
          });
        } catch {
          // Skip entries whose URL cannot be normalized.
        }
        continue;
      }
      try {
        const source = normalizeContentsPage(entry);
        readPages.push(source);
        succeededUrls.add(source.url);
      } catch {
        // Skip entries whose URL cannot be normalized.
      }
    }
    const requestedButUnreturned = urls.filter(
      (url) =>
        !succeededUrls.has(url) &&
        !failedResults.some((failure) => failure.url === url),
    );
    for (const url of requestedButUnreturned) {
      failedResults.push({
        url,
        error: "You.com did not return content for this page.",
      });
    }
    return {
      provider: "youcom",
      query: request.query,
      depth: request.depth,
      pages: readPages,
      failedResults,
      usage: normalizeUsage(),
    };
  }

  async getUsage(signal?: AbortSignal): Promise<WebAccessUsageSnapshot> {
    const body = asRecord(
      await this.request("GET", YOUCOM_BALANCE_URL, undefined, signal),
    );
    const data = asRecord(body.data);
    const attributes = asRecord(data.attributes);
    const balanceCents = readFiniteNumber(attributes.balance) ?? 0;
    const balanceDollars = balanceCents / 100;
    return {
      provider: "youcom",
      plan: "You.com credits",
      credential: {
        usage: 0,
        limit: balanceDollars,
      },
      monthly: {
        usage: 0,
        limit: balanceDollars,
      },
      breakdown: {
        searchCredits: 0,
        readCredits: 0,
      },
      payAsYouGo: {
        usage: 0,
        limit: balanceDollars,
      },
    };
  }
}
