export type WebAccessDepth = "basic" | "advanced";

/** The saved choice, and the provider that web_search and web_read call. */
export type WebAccessProviderId = "tavily" | "anysearch" | "deepseek";

export type WebAccessErrorCode =
  | "authentication"
  | "quota"
  | "plan_limit"
  | "rate_limit"
  | "validation"
  | "service"
  | "network"
  | "timeout"
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
  /** Local output limit was applied; does not imply server-side completeness. */
  truncated?: boolean;
  /** How web_read read the page (web_read results only). */
  readMode?: WebReadMode;
  /** The whole page's length in characters (outline, sections, full). */
  totalChars?: number;
  /** The page's headings, for a later sections read (outline). */
  outline?: WebPageOutlineEntry[];
  /** The ids of the sections read (sections). */
  sectionIds?: string[];
  /** Where `content` sits in the whole page (sections, full). */
  range?: { start: number; end: number };
  /** Where to continue with mode 'full'; absent once the page is read. */
  nextOffset?: number;
};

/**
 * How web_read reads a page: the passages matching a query (Tavily), the
 * page's outline, chosen sections, or the whole page in pieces.
 */
export type WebReadMode = "passages" | "outline" | "sections" | "full";

export type WebPageOutlineEntry = {
  id: string;
  heading: string;
  level: number;
  /** The section's length, its subsections included. */
  chars: number;
};

export type WebSourceDisplay = Pick<
  WebSourceRecord,
  "sourceId" | "url" | "hostname" | "organization" | "title" | "faviconUrl"
> & {
  /** A paper from the scholarly search (literature_search/literature_read). */
  kind?: "paper";
};

/**
 * A clean-Markdown insertion point for the sources used by one paragraph.
 * The offset is measured after hidden model markers have been removed.
 * An "end" anchor is the answer's one fallback chip, shown on its own
 * paragraph after the answer.
 */
export type WebSourceAnchor = {
  offset: number;
  sources: WebSourceDisplay[];
  /**
   * "end": the answer's fallback chip, on its own paragraph after it.
   * "inline": a link the answer gave, shown as a small marker where it was.
   */
  placement?: "end" | "inline";
  /**
   * The exact words the answer took from a source, by source id, as the
   * agent gave them; "What the agent read" highlights them where they match.
   */
  phrases?: Record<string, string>;
};

export type WebAccessUsage = {
  credits: number;
};

export type WebSearchRequest = {
  query: string;
  depth?: WebAccessDepth;
  topic?: WebSearchTopic;
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
  depth?: WebAccessDepth;
  topic?: WebSearchTopic;
  results: WebSourceRecord[];
  usage?: WebAccessUsage;
  requestId?: string;
};

export type WebReadRequest = {
  urls: string[];
  query?: string;
  depth?: WebAccessDepth;
  chunksPerSource?: number;
  /**
   * Whole pages with their line breaks, up to WEB_PAGE_MAX_CHARS each, for
   * the outline, sections and whole-page reads; no query or chunks.
   */
  wholePage?: boolean;
  signal?: AbortSignal;
};

export type WebReadFailure = {
  url: string;
  error: string;
};

export type WebReadResponse = {
  provider: string;
  query?: string;
  depth?: WebAccessDepth;
  pages: WebSourceRecord[];
  failedResults: WebReadFailure[];
  usage?: WebAccessUsage;
  requestIds?: string[];
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
