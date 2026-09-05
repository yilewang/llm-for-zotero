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

const TAVILY_API_ORIGIN = "https://api.tavily.com";
const TAVILY_SEARCH_URL = `${TAVILY_API_ORIGIN}/search`;
const TAVILY_EXTRACT_URL = `${TAVILY_API_ORIGIN}/extract`;
const TAVILY_USAGE_URL = `${TAVILY_API_ORIGIN}/usage`;

type TavilyTransportResponse = {
  status: number;
  body: unknown;
};

export type TavilyTransport = (params: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<TavilyTransportResponse>;

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

async function defaultTavilyTransport(
  params: Parameters<TavilyTransport>[0],
): Promise<TavilyTransportResponse> {
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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const mappedIpv4 = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedIpv4) {
    const high = Number.parseInt(mappedIpv4[1], 16);
    const low = Number.parseInt(mappedIpv4[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value)
  );
}

export function normalizePublicWebUrl(value: unknown): string {
  const raw = readString(value);
  if (!raw) throw new WebAccessError("A web URL is required.", "unsafe_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebAccessError(
      "Web URLs must be valid absolute HTTP(S) URLs.",
      "unsafe_url",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebAccessError("Web URLs must use HTTP or HTTPS.", "unsafe_url");
  }
  if (url.username || url.password) {
    throw new WebAccessError(
      "Web URLs must not contain embedded credentials.",
      "unsafe_url",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    isPrivateIpv4(hostname) ||
    (hostname.includes(":") && isPrivateIpv6(hostname))
  ) {
    throw new WebAccessError(
      "Local and private-network web URLs are not allowed.",
      "unsafe_url",
    );
  }
  url.hash = "";
  return url.toString();
}

export function buildWebSourceId(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `web_${(hash >>> 0).toString(36).padStart(7, "0")}`;
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

function normalizeSource(
  value: unknown,
  contentField: "content" | "raw_content",
) {
  const record = asRecord(value);
  const url = normalizePublicWebUrl(record.url);
  const hostname = hostnameForUrl(url);
  const siteName =
    normalizeDisplayText(record.site_name, 160) ||
    normalizeDisplayText(record.siteName, 160);
  const title = normalizeDisplayText(record.title, 500) || hostname;
  const content = normalizeDisplayText(record[contentField], 12_000);
  const source: WebSourceRecord = {
    sourceId: buildWebSourceId(url),
    url,
    hostname,
    organization: siteName || hostname,
    title,
  };
  const faviconUrl = normalizeOptionalPublicWebUrl(record.favicon);
  if (faviconUrl) source.faviconUrl = faviconUrl;
  if (contentField === "content" && content) source.snippet = content;
  if (contentField === "raw_content" && content) source.content = content;
  const score = readFiniteNumber(record.score);
  if (score !== undefined) source.score = score;
  const publishedDate = normalizeDisplayText(record.published_date, 80);
  if (publishedDate) source.publishedDate = publishedDate;
  return source;
}

function normalizeUsage(value: unknown): WebAccessUsage {
  return { credits: readNonNegativeNumber(asRecord(value).credits) };
}

function readErrorDetail(body: unknown): string {
  const record = asRecord(body);
  const detail = record.detail;
  if (typeof detail === "string") return detail.trim();
  const nested = asRecord(detail);
  return readString(nested.error) || readString(record.error);
}

export class TavilyApiError extends WebAccessError {
  constructor(
    message: string,
    code: ConstructorParameters<typeof WebAccessError>[1],
    status: number,
    requestId?: string,
  ) {
    super(message, code, status, requestId);
    this.name = "TavilyApiError";
  }
}

function mapTavilyError(
  status: number,
  body: unknown,
  apiKey: string,
): TavilyApiError {
  const record = asRecord(body);
  const requestId = readString(record.request_id) || undefined;
  const detail = readErrorDetail(body).split(apiKey).join("[redacted]");
  let message: string;
  let code: ConstructorParameters<typeof WebAccessError>[1];
  switch (status) {
    case 400:
    case 422:
      code = "validation";
      message = `Tavily rejected the request${detail ? `: ${detail}` : "."}`;
      break;
    case 401:
      code = "authentication";
      message = "Tavily rejected the API key. Check it in Preferences → Agent.";
      break;
    case 429:
      code = "rate_limit";
      message = "Tavily rate-limited the request. Try again later.";
      break;
    case 432:
      code = "quota";
      message = "The Tavily plan credit limit has been reached.";
      break;
    case 433:
      code = "plan_limit";
      message = "The Tavily pay-as-you-go limit has been reached.";
      break;
    default:
      code = "service";
      message =
        status >= 500
          ? "Tavily is temporarily unavailable. Try again later."
          : `Tavily request failed with HTTP ${status}${detail ? `: ${detail}` : "."}`;
  }
  return new TavilyApiError(message, code, status, requestId);
}

function numberField(record: Record<string, unknown>, key: string): number {
  return readNonNegativeNumber(record[key]);
}

export class TavilyClient implements WebAccessProvider {
  private readonly apiKey: string;
  private readonly transport: TavilyTransport;

  constructor(
    apiKey: string,
    transport: TavilyTransport = defaultTavilyTransport,
  ) {
    this.apiKey = apiKey.trim();
    this.transport = transport;
    if (!this.apiKey) {
      throw new WebAccessError(
        "A Tavily API key is required.",
        "authentication",
      );
    }
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: TavilyTransportResponse;
    try {
      response = await this.transport({
        method,
        url,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal,
      });
    } catch {
      if (signal?.aborted) {
        throw new WebAccessError("Tavily request was cancelled.", "cancelled");
      }
      throw new WebAccessError(
        "Could not reach Tavily. Check the network connection.",
        "network",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapTavilyError(response.status, response.body, this.apiKey);
    }
    return asRecord(response.body);
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const body = await this.request(
      "POST",
      TAVILY_SEARCH_URL,
      {
        query: request.query,
        search_depth: request.depth,
        topic: request.topic,
        max_results: request.maxResults,
        ...(request.timeRange ? { time_range: request.timeRange } : {}),
        ...(request.startDate ? { start_date: request.startDate } : {}),
        ...(request.endDate ? { end_date: request.endDate } : {}),
        ...(request.includeDomains?.length
          ? { include_domains: request.includeDomains }
          : {}),
        ...(request.excludeDomains?.length
          ? { exclude_domains: request.excludeDomains }
          : {}),
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: true,
        include_usage: true,
      },
      request.signal,
    );
    const results = Array.isArray(body.results)
      ? body.results.flatMap((entry) => {
          try {
            return [normalizeSource(entry, "content")];
          } catch {
            return [];
          }
        })
      : [];
    return {
      provider: "tavily",
      query: readString(body.query) || request.query,
      depth: request.depth,
      topic: request.topic,
      results,
      usage: normalizeUsage(body.usage),
      ...(readString(body.request_id)
        ? { requestId: readString(body.request_id) }
        : {}),
    };
  }

  async read(request: WebReadRequest): Promise<WebReadResponse> {
    const urls = request.urls.map(normalizePublicWebUrl);
    const body = await this.request(
      "POST",
      TAVILY_EXTRACT_URL,
      {
        urls,
        query: request.query,
        chunks_per_source: request.chunksPerSource,
        extract_depth: request.depth,
        include_images: false,
        include_favicon: true,
        include_usage: true,
        format: "text",
      },
      request.signal,
    );
    const pages = Array.isArray(body.results)
      ? body.results.flatMap((entry) => {
          try {
            return [normalizeSource(entry, "raw_content")];
          } catch {
            return [];
          }
        })
      : [];
    const failedResults: WebReadFailure[] = Array.isArray(body.failed_results)
      ? body.failed_results.flatMap((entry) => {
          const record = asRecord(entry);
          try {
            return [
              {
                url: normalizePublicWebUrl(record.url),
                error:
                  normalizeDisplayText(record.error, 500) ||
                  "Tavily could not extract this page.",
              },
            ];
          } catch {
            return [];
          }
        })
      : [];
    return {
      provider: "tavily",
      query: request.query,
      depth: request.depth,
      pages,
      failedResults,
      usage: normalizeUsage(body.usage),
      ...(readString(body.request_id)
        ? { requestId: readString(body.request_id) }
        : {}),
    };
  }

  async getUsage(signal?: AbortSignal): Promise<WebAccessUsageSnapshot> {
    const body = await this.request("GET", TAVILY_USAGE_URL, undefined, signal);
    const key = asRecord(body.key);
    const account = asRecord(body.account);
    return {
      provider: "tavily",
      plan: readString(account.current_plan) || "Unknown",
      credential: {
        usage: numberField(key, "usage"),
        limit: numberField(key, "limit"),
      },
      monthly: {
        usage: numberField(account, "plan_usage"),
        limit: numberField(account, "plan_limit"),
      },
      breakdown: {
        searchCredits: numberField(key, "search_usage"),
        readCredits: numberField(key, "extract_usage"),
      },
      payAsYouGo: {
        usage: numberField(account, "paygo_usage"),
        limit: numberField(account, "paygo_limit"),
      },
    };
  }
}
