import { appLogger } from "../../core/logging";
import {
  htmlFragmentToText,
  parseArxivAtom,
  parseArxivHtml,
  parseJatsArticle,
  type ParsedJatsArticle,
  type ParsedPaperSection,
} from "./literatureReadParser";

/**
 * literature_read's resolution ladder: one outside paper's full abstract and,
 * when it is open access, its full text, in at most four requests.
 *
 * arXiv ID: export API (abstract), then arxiv.org/html (LaTeXML text).
 * DOI, PMID, PMCID: one Europe PMC search (abstract, PMCID, open-access
 * flag), then Europe PMC fullTextXML when open access, then NCBI efetch when
 * a PMCID exists; a DOI Europe PMC does not know gets one OpenAlex single-work
 * lookup. OpenAlex list and content endpoints are never called.
 *
 * Parsed papers are cached at module level (TTL and entry cap), so section,
 * query and textOffset follow-ups, including MCP calls without an agent run,
 * make no request. Per-host spacing is module level too, so parallel calls
 * cannot defeat arXiv's one request per three seconds.
 */

export type LiteratureReadIdentifierKind = "doi" | "pmid" | "pmcid" | "arxivId";

export type LiteratureReadIdentifier = {
  kind: LiteratureReadIdentifierKind;
  value: string;
};

export type LiteratureReadFullTextStatus =
  | "open_access"
  | "abstract_only"
  | "pdf_only"
  | "unavailable";

export type LiteratureReadReason =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network_error"
  | "not_found"
  | "not_open_access"
  | "no_html"
  | "request_failed";

export type LiteratureReadPaper = {
  title?: string;
  authors: string[];
  year?: number;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  url?: string;
  license?: string;
};

export type LiteratureReadRecord = {
  identifier: LiteratureReadIdentifier;
  source: "europepmc" | "pmc" | "arxiv" | "openalex";
  paper: LiteratureReadPaper;
  /** Zotero-style first creator: "Smith", "Smith and Lee", "Smith et al.". */
  firstCreator?: string;
  abstract: string;
  fullText: {
    status: LiteratureReadFullTextStatus;
    reason?: LiteratureReadReason;
    pdfUrl?: string;
    landingUrl?: string;
  };
  sections: ParsedPaperSection[];
};

const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const NCBI_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const OPENALEX_WORKS = "https://api.openalex.org/works";
/** Fixed project contact, like literature_search's OpenAlex mailto. */
const PROJECT_CONTACT = "llm-for-zotero@github.com";
const NCBI_TOOL = "llm-for-zotero";
const OPENALEX_SELECT =
  "id,doi,display_name,authorships,publication_year,abstract_inverted_index,ids,open_access,best_oa_location";
const USER_AGENT =
  "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)";
const REQUEST_TIMEOUT_MS = 15_000;
export const LITERATURE_READ_MAX_REQUESTS = 4;
const CACHE_TTL_MS = 30 * 60 * 1000;
/** Each parsed paper can hold about 100k characters. */
const CACHE_MAX_ENTRIES = 8;
const HOST_SPACING_MS: Record<string, number> = {
  arxiv: 3_000,
  ncbi: 350,
};
const TRANSIENT_REASONS = new Set<LiteratureReadReason>([
  "rate_limited",
  "server_error",
  "timeout",
  "network_error",
]);

// --- identifiers ---------------------------------------------------------

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
const NEW_ARXIV_PATTERN = /^\d{4}\.\d{4,5}$/;
const OLD_ARXIV_PATTERN = /^[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}$/i;

/** The normalized identifier, or null when the value is not one. */
export function normalizeLiteratureReadIdentifier(
  kind: LiteratureReadIdentifierKind,
  raw: unknown,
): LiteratureReadIdentifier | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (kind === "doi") {
    value = value
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .trim();
    return DOI_PATTERN.test(value) ? { kind, value } : null;
  }
  if (kind === "pmid") {
    value = value
      .replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, "")
      .replace(/^pmid:\s*/i, "")
      .replace(/\/$/, "");
    return /^\d{1,9}$/.test(value) ? { kind, value } : null;
  }
  if (kind === "pmcid") {
    value = value
      .replace(/^pmcid:\s*/i, "")
      .replace(/^pmc/i, "")
      .replace(/\.\d+$/, "");
    return /^\d{1,9}$/.test(value) ? { kind, value: `PMC${value}` } : null;
  }
  value = value
    .replace(
      /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\//i,
      "",
    )
    .replace(/^arxiv:\s*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
  return NEW_ARXIV_PATTERN.test(value) || OLD_ARXIV_PATTERN.test(value)
    ? { kind, value }
    : null;
}

export function literatureReadIdentifierKey(
  identifier: LiteratureReadIdentifier,
): string {
  return `${identifier.kind}:${identifier.value.toLowerCase()}`;
}

// --- module state: clock, spacing, cache ---------------------------------

type LiteratureReadClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaultClock: LiteratureReadClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let clock = defaultClock;
const nextRequestAt = new Map<string, number>();
const cache = new Map<
  string,
  { expiresAt: number; record: LiteratureReadRecord }
>();
const inflight = new Map<string, Promise<LiteratureReadRecord>>();

export const literatureReadTesting = {
  reset(): void {
    clock = defaultClock;
    nextRequestAt.clear();
    cache.clear();
    inflight.clear();
  },
  setClock(next: Partial<LiteratureReadClock>): void {
    clock = { ...defaultClock, ...next };
  },
  cacheSize: () => cache.size,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
};

function hostGroup(url: string): string {
  const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1]?.toLowerCase() || "";
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) return "arxiv";
  if (host.endsWith("ncbi.nlm.nih.gov")) return "ncbi";
  return host;
}

/** Reserves the host's next slot synchronously, then waits for it. */
async function waitForHostSlot(url: string): Promise<void> {
  const group = hostGroup(url);
  const spacing = HOST_SPACING_MS[group] || 0;
  if (!spacing) return;
  const now = clock.now();
  const slot = Math.max(now, nextRequestAt.get(group) || 0);
  nextRequestAt.set(group, slot + spacing);
  if (slot > now) await clock.sleep(slot - now);
}

function readCache(key: string): LiteratureReadRecord | null {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  if (entry.expiresAt <= clock.now()) return null;
  cache.set(key, entry);
  return entry.record;
}

/** Only definitive outcomes are cached: a text, an abstract, or not_found. */
function writeCache(key: string, record: LiteratureReadRecord): void {
  const reason = record.fullText.reason;
  if (reason && (TRANSIENT_REASONS.has(reason) || reason === "request_failed"))
    return;
  cache.delete(key);
  cache.set(key, { expiresAt: clock.now() + CACHE_TTL_MS, record });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// --- HTTP ----------------------------------------------------------------

type HttpOutcome =
  | { status: number; text: string }
  | { status: 0; text: ""; failure: "timeout" | "network_error" };

type ZoteroHttpLike = {
  request: (
    method: string,
    url: string,
    options: Record<string, unknown>,
  ) => Promise<{ status: number; responseText?: string | null }>;
};

async function httpGet(url: string, accept: string): Promise<HttpOutcome> {
  await waitForHostSlot(url);
  const http = (globalThis as { Zotero?: { HTTP?: ZoteroHttpLike } }).Zotero
    ?.HTTP;
  if (!http?.request) return { status: 0, text: "", failure: "network_error" };
  try {
    const xhr = await http.request("GET", url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      responseType: "text",
      timeout: REQUEST_TIMEOUT_MS,
      successCodes: false,
      errorDelayMax: 0,
      logBodyLength: 0,
    });
    const status = Number(xhr.status) || 0;
    // A resolved status 0 is a connection failure, not an answer.
    if (!status) return { status: 0, text: "", failure: "network_error" };
    return { status, text: xhr.responseText ?? "" };
  } catch (error) {
    // Zotero.HTTP throws on non-2xx when successCodes is not honored, with
    // the status on the error or its xmlhttp.
    const record = (error || {}) as {
      status?: number;
      xmlhttp?: { status?: number; responseText?: string };
      name?: string;
      message?: string;
    };
    const status = Number(record.status || record.xmlhttp?.status) || 0;
    if (status) return { status, text: record.xmlhttp?.responseText ?? "" };
    const text = `${record.name || ""} ${record.message || ""}`;
    appLogger.warn(`[llm-for-zotero] literature_read request failed: ${text}`);
    return {
      status: 0,
      text: "",
      failure: /timeout|timed out/i.test(text) ? "timeout" : "network_error",
    };
  }
}

function isOk(outcome: HttpOutcome): boolean {
  return outcome.status >= 200 && outcome.status < 300;
}

function failureReason(outcome: HttpOutcome): LiteratureReadReason {
  if ("failure" in outcome) return outcome.failure;
  if (outcome.status === 429) return "rate_limited";
  if (outcome.status >= 500) return "server_error";
  if (outcome.status === 404 || outcome.status === 410) return "not_found";
  return "request_failed";
}

/** One read's requests, capped at LITERATURE_READ_MAX_REQUESTS. */
class RequestBudget {
  private used = 0;

  get remaining(): number {
    return LITERATURE_READ_MAX_REQUESTS - this.used;
  }

  async get(url: string, accept: string): Promise<HttpOutcome | null> {
    if (this.remaining <= 0) return null;
    this.used += 1;
    return httpGet(url, accept);
  }
}

// --- metadata helpers ----------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

function firstCreatorOf(surnames: string[]): string | undefined {
  const names = surnames.filter(Boolean);
  if (!names.length) return undefined;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

function doiUrl(doi: string | undefined): string | undefined {
  return doi ? `https://doi.org/${doi}` : undefined;
}

function reconstructAbstract(invertedIndex: unknown): string {
  const words: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(record(invertedIndex))) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number") words.push([word, position]);
    }
  }
  words.sort((left, right) => left[1] - right[1]);
  return words
    .map(([word]) => word)
    .join(" ")
    .trim();
}

type Draft = Omit<LiteratureReadRecord, "fullText" | "sections"> & {
  pdfUrl?: string;
  landingUrl?: string;
};

function finish(
  draft: Draft,
  status: LiteratureReadFullTextStatus,
  reason?: LiteratureReadReason,
  sections: ParsedPaperSection[] = [],
): LiteratureReadRecord {
  const { pdfUrl, landingUrl, ...rest } = draft;
  // Abstract-only without an abstract is nothing readable.
  const finalStatus =
    status === "abstract_only" && !draft.abstract ? "unavailable" : status;
  return {
    ...rest,
    fullText: {
      status: finalStatus,
      ...(reason ? { reason } : {}),
      ...(pdfUrl ? { pdfUrl } : {}),
      ...(landingUrl ? { landingUrl } : {}),
    },
    sections,
  };
}

/** No full text: a PDF link if there is one, else the abstract alone. */
function finishWithoutText(
  draft: Draft,
  reason: LiteratureReadReason,
): LiteratureReadRecord {
  return finish(draft, draft.pdfUrl ? "pdf_only" : "abstract_only", reason);
}

function mergeJatsMetadata(draft: Draft, parsed: ParsedJatsArticle): void {
  const paper = draft.paper;
  paper.title ||= parsed.title;
  if (!paper.authors.length) paper.authors = parsed.authors;
  paper.year ??= parsed.year;
  paper.doi ||= parsed.doi;
  paper.pmid ||= parsed.pmid;
  paper.pmcid ||= parsed.pmcid;
  paper.license ||= parsed.license;
  if (!draft.abstract) draft.abstract = parsed.abstract;
  if (!draft.firstCreator) {
    draft.firstCreator = firstCreatorOf(parsed.authors.map(lastNameOf));
  }
}

// --- arXiv ---------------------------------------------------------------

async function readArxiv(
  identifier: LiteratureReadIdentifier,
  budget: RequestBudget,
): Promise<LiteratureReadRecord> {
  const id = identifier.value;
  const draft: Draft = {
    identifier,
    source: "arxiv",
    paper: { authors: [], arxivId: id, url: `https://arxiv.org/abs/${id}` },
    abstract: "",
    landingUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
  };
  const atom = await budget.get(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    "application/atom+xml",
  );
  if (!atom || !isOk(atom)) {
    return finish(
      draft,
      "unavailable",
      atom ? failureReason(atom) : "request_failed",
    );
  }
  const entry = parseArxivAtom(atom.text);
  if (!entry) return finish(draft, "unavailable", "not_found");
  draft.paper = {
    ...draft.paper,
    title: entry.title,
    authors: entry.authors,
    year: entry.year,
    ...(entry.doi ? { doi: entry.doi } : {}),
  };
  draft.firstCreator = firstCreatorOf(entry.authors.map(lastNameOf));
  draft.abstract = entry.abstract;
  if (entry.pdfUrl) draft.pdfUrl = entry.pdfUrl;
  const html = await budget.get(`https://arxiv.org/html/${id}`, "text/html");
  if (!html) return finish(draft, "abstract_only", "request_failed");
  if (isOk(html)) {
    const parsed = parseArxivHtml(html.text);
    if (parsed?.sections.length) {
      draft.abstract ||= parsed.abstract;
      return finish(draft, "open_access", undefined, parsed.sections);
    }
    return finish(draft, "abstract_only", "no_html");
  }
  if (html.status === 404) return finish(draft, "abstract_only", "no_html");
  return finish(draft, "unavailable", failureReason(html));
}

// --- Europe PMC, PMC, OpenAlex -------------------------------------------

type EuropePmcHit = {
  item: Record<string, unknown>;
  openAccess: boolean;
};

function europePmcQuery(identifier: LiteratureReadIdentifier): string {
  if (identifier.kind === "doi") return `DOI:"${identifier.value}"`;
  if (identifier.kind === "pmid")
    return `EXT_ID:${identifier.value} AND SRC:MED`;
  return `PMCID:${identifier.value}`;
}

async function searchEuropePmc(
  identifier: LiteratureReadIdentifier,
  budget: RequestBudget,
): Promise<{ hit: EuropePmcHit | null; failure?: LiteratureReadReason }> {
  const outcome = await budget.get(
    `${EPMC_BASE}/search?query=${encodeURIComponent(europePmcQuery(identifier))}&resultType=core&format=json&pageSize=1`,
    "application/json",
  );
  if (!outcome) return { hit: null, failure: "request_failed" };
  if (!isOk(outcome)) return { hit: null, failure: failureReason(outcome) };
  const body = parseJson(outcome.text);
  if (!body) return { hit: null, failure: "request_failed" };
  const results = record(body.resultList).result;
  const item = Array.isArray(results) ? record(results[0]) : {};
  if (!str(item.id) && !str(item.title)) return { hit: null };
  return { hit: { item, openAccess: str(item.isOpenAccess) === "Y" } };
}

function applyEuropePmcItem(draft: Draft, item: Record<string, unknown>): void {
  const authorList = record(item.authorList).author;
  const authors: string[] = [];
  const surnames: string[] = [];
  for (const entry of Array.isArray(authorList) ? authorList : []) {
    const author = record(entry);
    const last = str(author.lastName);
    const name =
      [str(author.firstName), last].filter(Boolean).join(" ") ||
      str(author.fullName) ||
      str(author.collectiveName);
    if (!name) continue;
    authors.push(name);
    surnames.push(last || str(author.collectiveName) || lastNameOf(name));
  }
  if (!authors.length) {
    for (const name of str(item.authorString).replace(/\.$/, "").split(",")) {
      if (!name.trim()) continue;
      authors.push(name.trim());
      surnames.push(name.trim().split(/\s+/)[0]);
    }
  }
  const year = parseInt(str(item.pubYear), 10);
  const doi = str(item.doi) || draft.paper.doi;
  const pmid = str(item.pmid) || draft.paper.pmid;
  const pmcid = str(item.pmcid) || draft.paper.pmcid;
  const source = str(item.source) || "MED";
  const id = str(item.id);
  const europePmcUrl = id
    ? `https://europepmc.org/article/${source}/${id}`
    : undefined;
  draft.paper = {
    ...draft.paper,
    title: str(item.title).replace(/\.$/, "") || draft.paper.title,
    authors: authors.length ? authors : draft.paper.authors,
    ...(Number.isFinite(year) ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    url: doiUrl(doi) || europePmcUrl || draft.paper.url,
    ...(str(item.license) ? { license: str(item.license) } : {}),
  };
  if (surnames.length) draft.firstCreator = firstCreatorOf(surnames);
  const abstract = htmlFragmentToText(str(item.abstractText));
  if (abstract) draft.abstract = abstract;
  draft.landingUrl = doiUrl(doi) || europePmcUrl || draft.landingUrl;
  const urls = record(item.fullTextUrlList).fullTextUrl;
  for (const entry of Array.isArray(urls) ? urls : []) {
    const link = record(entry);
    const code = str(link.availabilityCode);
    if (
      str(link.documentStyle) === "pdf" &&
      (code === "OA" || code === "F") &&
      str(link.url)
    ) {
      draft.pdfUrl ||= str(link.url);
      break;
    }
  }
}

/** Europe PMC fullTextXML when open access, then NCBI efetch by PMCID. */
async function readFullText(
  draft: Draft,
  openAccess: boolean,
  budget: RequestBudget,
): Promise<LiteratureReadRecord> {
  const pmcid = draft.paper.pmcid;
  if (!pmcid) return finishWithoutText(draft, "not_open_access");
  if (openAccess) {
    const outcome = await budget.get(
      `${EPMC_BASE}/${pmcid}/fullTextXML`,
      "application/xml",
    );
    if (!outcome) return finishWithoutText(draft, "request_failed");
    if (isOk(outcome)) {
      const parsed = parseJatsArticle(outcome.text);
      if (parsed?.sections.length) {
        mergeJatsMetadata(draft, parsed);
        return finish(
          { ...draft, source: "europepmc" },
          "open_access",
          undefined,
          parsed.sections,
        );
      }
    } else if (
      outcome.status === 429 ||
      ("failure" in outcome && outcome.failure === "timeout")
    ) {
      // Europe PMC answers a paper it cannot serve with HTTP 500, which falls
      // through to efetch; rate limits and timeouts stop the read.
      return finish(draft, "unavailable", failureReason(outcome));
    }
  }
  const outcome = await budget.get(
    `${NCBI_EFETCH}?db=pmc&id=${pmcid.replace(/^PMC/i, "")}&tool=${NCBI_TOOL}&email=${encodeURIComponent(PROJECT_CONTACT)}`,
    "application/xml",
  );
  if (!outcome) return finishWithoutText(draft, "request_failed");
  if (!isOk(outcome)) {
    return finish(draft, "unavailable", failureReason(outcome));
  }
  const parsed = parseJatsArticle(outcome.text);
  if (!parsed) return finishWithoutText(draft, "not_open_access");
  mergeJatsMetadata(draft, parsed);
  if (parsed.sections.length) {
    return finish(
      { ...draft, source: "pmc" },
      "open_access",
      undefined,
      parsed.sections,
    );
  }
  return finishWithoutText(draft, "not_open_access");
}

/** A DOI Europe PMC does not know: one OpenAlex single-work lookup. */
async function readOpenAlex(
  draft: Draft,
  budget: RequestBudget,
): Promise<LiteratureReadRecord> {
  const doi = draft.paper.doi!;
  const outcome = await budget.get(
    `${OPENALEX_WORKS}/${encodeURIComponent(`https://doi.org/${doi}`)}?select=${OPENALEX_SELECT}&mailto=${encodeURIComponent(PROJECT_CONTACT)}`,
    "application/json",
  );
  if (!outcome) return finish(draft, "unavailable", "request_failed");
  if (!isOk(outcome)) {
    return finish(draft, "unavailable", failureReason(outcome));
  }
  const work = parseJson(outcome.text);
  if (!work) return finish(draft, "unavailable", "request_failed");
  const authors: string[] = [];
  for (const entry of Array.isArray(work.authorships) ? work.authorships : []) {
    const name = str(record(record(entry).author).display_name);
    if (name) authors.push(name);
  }
  const ids = record(work.ids);
  const pmid = str(ids.pmid).replace(/^.*\//, "");
  const pmcid = str(ids.pmcid).replace(/^.*\//, "");
  const year = Number(work.publication_year);
  const best = record(work.best_oa_location);
  draft.source = "openalex";
  draft.paper = {
    ...draft.paper,
    title: str(work.display_name) || undefined,
    authors,
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    ...(/^\d+$/.test(pmid) ? { pmid } : {}),
    ...(/^PMC\d+$/i.test(pmcid) ? { pmcid: pmcid.toUpperCase() } : {}),
    url: doiUrl(doi),
  };
  draft.firstCreator = firstCreatorOf(authors.map(lastNameOf));
  draft.abstract = reconstructAbstract(work.abstract_inverted_index);
  draft.pdfUrl = str(best.pdf_url) || undefined;
  draft.landingUrl =
    str(best.landing_page_url) ||
    str(record(work.open_access).oa_url) ||
    doiUrl(doi);
  if (draft.paper.pmcid) return readFullText(draft, false, budget);
  if (draft.paper.pmid) {
    const { hit } = await searchEuropePmc(
      { kind: "pmid", value: draft.paper.pmid },
      budget,
    );
    if (hit) {
      const abstract = draft.abstract;
      applyEuropePmcItem(draft, hit.item);
      draft.abstract ||= abstract;
      return readFullText(draft, hit.openAccess, budget);
    }
  }
  return finishWithoutText(draft, "not_open_access");
}

async function readBiomedical(
  identifier: LiteratureReadIdentifier,
  budget: RequestBudget,
): Promise<LiteratureReadRecord> {
  const draft: Draft = {
    identifier,
    source: "europepmc",
    paper: {
      authors: [],
      ...(identifier.kind === "doi" ? { doi: identifier.value } : {}),
      ...(identifier.kind === "pmid" ? { pmid: identifier.value } : {}),
      ...(identifier.kind === "pmcid" ? { pmcid: identifier.value } : {}),
    },
    abstract: "",
  };
  if (identifier.kind === "doi") draft.landingUrl = doiUrl(identifier.value);
  const { hit, failure } = await searchEuropePmc(identifier, budget);
  if (failure) return finish(draft, "unavailable", failure);
  if (hit) {
    applyEuropePmcItem(draft, hit.item);
    return readFullText(draft, hit.openAccess, budget);
  }
  if (identifier.kind === "doi") return readOpenAlex(draft, budget);
  if (identifier.kind === "pmcid") {
    draft.source = "pmc";
    const result = await readFullText(draft, false, budget);
    const transient =
      result.fullText.reason && TRANSIENT_REASONS.has(result.fullText.reason);
    return result.paper.title || transient
      ? result
      : finish(draft, "unavailable", "not_found");
  }
  return finish(draft, "unavailable", "not_found");
}

/**
 * Loads one outside paper through the ladder, or from the module cache.
 * Never throws for a provider failure: the record states it.
 */
export async function loadLiteraturePaper(
  identifier: LiteratureReadIdentifier,
): Promise<LiteratureReadRecord> {
  const key = literatureReadIdentifierKey(identifier);
  const cached = readCache(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const load = (async () => {
    const budget = new RequestBudget();
    const result =
      identifier.kind === "arxivId"
        ? await readArxiv(identifier, budget)
        : await readBiomedical(identifier, budget);
    writeCache(key, result);
    return result;
  })();
  inflight.set(key, load);
  try {
    return await load;
  } finally {
    inflight.delete(key);
  }
}
