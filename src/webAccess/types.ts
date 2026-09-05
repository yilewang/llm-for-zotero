export type WebAccessDepth = "basic" | "advanced";

export type WebAccessErrorCode =
  | "authentication"
  | "quota"
  | "plan_limit"
  | "rate_limit"
  | "validation"
  | "service"
  | "network"
  | "cancelled"
  | "unsafe_url";

export type WebSearchTopic = "general" | "news" | "finance";

export type WebSearchTimeRange = "day" | "week" | "month" | "year";

export type WebSourceRecord = {
  sourceId: string;
  url: string;
  hostname: string;
  organization: string;
  title: string;
  faviconUrl?: string;
  snippet?: string;
  content?: string;
  score?: number;
  publishedDate?: string;
};

export type WebSourceDisplay = Pick<
  WebSourceRecord,
  "sourceId" | "url" | "hostname" | "organization" | "title" | "faviconUrl"
>;

/**
 * A clean-Markdown insertion point for the sources used by one paragraph.
 * The offset is measured after hidden model markers have been removed.
 */
export type WebSourceAnchor = {
  offset: number;
  sources: WebSourceDisplay[];
};

export type WebAccessUsage = {
  credits: number;
};

export type WebSearchRequest = {
  query: string;
  depth: WebAccessDepth;
  topic: WebSearchTopic;
  maxResults: number;
  timeRange?: WebSearchTimeRange;
  startDate?: string;
  endDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  signal?: AbortSignal;
};

export type WebSearchResponse = {
  provider: string;
  query: string;
  depth: WebAccessDepth;
  topic: WebSearchTopic;
  results: WebSourceRecord[];
  usage: WebAccessUsage;
  requestId?: string;
};

export type WebReadRequest = {
  urls: string[];
  query: string;
  depth: WebAccessDepth;
  chunksPerSource: number;
  signal?: AbortSignal;
};

export type WebReadFailure = {
  url: string;
  error: string;
};

export type WebReadResponse = {
  provider: string;
  query: string;
  depth: WebAccessDepth;
  pages: WebSourceRecord[];
  failedResults: WebReadFailure[];
  usage: WebAccessUsage;
  requestId?: string;
};

export type WebAccessUsageSnapshot = {
  provider: string;
  plan: string;
  credential: {
    usage: number;
    limit: number;
  };
  monthly: {
    usage: number;
    limit: number;
  };
  breakdown: {
    searchCredits: number;
    readCredits: number;
  };
  payAsYouGo: {
    usage: number;
    limit: number;
  };
};

export interface WebAccessProvider {
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
  read(request: WebReadRequest): Promise<WebReadResponse>;
  getUsage(signal?: AbortSignal): Promise<WebAccessUsageSnapshot>;
}
