/**
 * Papers from the scholarly search (literature_search, literature_read) as
 * answer sources: a link the answer gives to one of them becomes a source
 * marker, as a link to a web page does. A paper is known by its DOI, else its
 * arXiv, PubMed or PMC id, else its link, and every link it was given under
 * (the DOI resolver, its landing page, its open copy) points to it.
 */
import { fnv1a32Raw } from "../utils/fnv1a";
import { looseWebUrlKey } from "./sourceLinks";
import { normalizePublicWebUrl } from "./tavilyClient";
import type { WebSourceDisplay } from "./types";

export type PaperSourceRecord = {
  name: string;
  ok: boolean;
  content?: unknown;
};

/** Publishers and servers named by a DOI prefix, for the source card. */
const DOI_PREFIX_NAMES: Record<string, string> = {
  "10.1101": "bioRxiv",
  "10.64898": "bioRxiv",
  "10.1038": "Nature",
  "10.1016": "Elsevier",
  "10.1126": "Science",
  "10.1073": "PNAS",
  "10.1371": "PLOS",
  "10.7554": "eLife",
  "10.1523": "J Neurosci",
  "10.1152": "J Neurophysiol",
  "10.1093": "Oxford Academic",
  "10.1002": "Wiley",
  "10.1007": "Springer",
  "10.3389": "Frontiers",
  "10.48550": "arXiv",
};

const PAPER_SOURCE_ID_PATTERN = /^paper_[a-z0-9]+$/;

export function isPaperSourceId(id: string): boolean {
  return PAPER_SOURCE_ID_PATTERN.test(id);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function publicUrl(value: unknown): string | undefined {
  const raw = readText(value);
  if (!raw) return undefined;
  try {
    return normalizePublicWebUrl(raw);
  } catch {
    return undefined;
  }
}

function bareDoi(value: unknown): string {
  return readText(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

export type PaperFields = {
  title: string;
  authors: string[];
  year?: number;
  doi: string;
  arxivId: string;
  pmid: string;
  pmcid: string;
  urls: string[];
};

function paperFields(raw: Record<string, unknown>, extra: unknown[] = []) {
  const urls = [raw.url, raw.sourceUrl, raw.openAccessUrl, ...extra].flatMap(
    (value) => publicUrl(value) || [],
  );
  const fields: PaperFields = {
    title: readText(raw.title) || readText(raw.displayTitle),
    authors: Array.isArray(raw.authors)
      ? raw.authors.map(readText).filter(Boolean)
      : [],
    ...(typeof raw.year === "number" ? { year: raw.year } : {}),
    doi: bareDoi(raw.doi),
    arxivId: readText(raw.arxivId),
    pmid: readText(raw.pmid),
    pmcid: readText(raw.pmcid).toUpperCase(),
    urls,
  };
  if (fields.doi) fields.urls.unshift(`https://doi.org/${fields.doi}`);
  if (fields.arxivId) {
    fields.urls.push(
      `https://arxiv.org/abs/${fields.arxivId}`,
      `https://arxiv.org/pdf/${fields.arxivId}`,
    );
  }
  if (fields.pmid) {
    fields.urls.push(
      `https://pubmed.ncbi.nlm.nih.gov/${fields.pmid}`,
      `https://europepmc.org/article/MED/${fields.pmid}`,
    );
  }
  if (fields.pmcid) {
    fields.urls.push(`https://europepmc.org/article/PMC/${fields.pmcid}`);
  }
  return fields;
}

function identityOf(fields: PaperFields): string {
  if (fields.doi) return `doi:${fields.doi}`;
  if (fields.arxivId) return `arxiv:${fields.arxivId.toLowerCase()}`;
  if (fields.pmid) return `pmid:${fields.pmid}`;
  if (fields.pmcid) return `pmcid:${fields.pmcid}`;
  const key = fields.urls.length ? looseWebUrlKey(fields.urls[0]) : undefined;
  return key ? `url:${key}` : "";
}

/** The paper's id as a source: stable for one paper across runs. */
export function paperSourceId(identity: string): string {
  return `paper_${fnv1a32Raw(identity).toString(36)}`;
}

function citeLabel(fields: PaperFields): string {
  const first = fields.authors[0]?.split(/\s+/).pop() || "";
  const who = first
    ? `${first}${fields.authors.length > 1 ? " et al." : ""}`
    : "";
  return [who, fields.year ? String(fields.year) : ""]
    .filter(Boolean)
    .join(", ");
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** The paper's page icon: its landing or open copy's site, not the resolver. */
function paperFavicon(urls: readonly string[]): string | undefined {
  const page = urls.find((url) => !/^(?:dx\.)?doi\.org$/.test(hostOf(url)));
  return page ? `https://${new URL(page).host}/favicon.ico` : undefined;
}

function display(fields: PaperFields, id: string): WebSourceDisplay | null {
  const url = fields.urls[0];
  if (!url) return null;
  const hostname = hostOf(url);
  const faviconUrl = paperFavicon(fields.urls);
  const prefix = fields.doi.split("/")[0];
  const venue =
    DOI_PREFIX_NAMES[prefix] ||
    (fields.arxivId ? "arXiv" : "") ||
    (fields.pmid || fields.pmcid ? "Europe PMC" : "") ||
    hostname;
  const label = citeLabel(fields);
  return {
    sourceId: id,
    url,
    hostname,
    organization: label ? `${venue} · ${label}` : venue,
    title: fields.title || label || hostname,
    ...(faviconUrl ? { faviconUrl } : {}),
    kind: "paper",
  };
}

/**
 * One paper as a source: a literature_search result or literature_read's
 * paper (with its full-text links in `extraUrls`); null without an identity
 * or a link.
 */
export function describePaperSource(
  raw: Record<string, unknown>,
  extraUrls: unknown[] = [],
): WebSourceDisplay | null {
  const fields = paperFields(raw, extraUrls);
  const identity = identityOf(fields);
  return identity ? display(fields, paperSourceId(identity)) : null;
}

/**
 * One paper's normalized fields and its source id, read the way
 * describePaperSource reads them; null without an identity.
 */
export function paperSourceIdentity(
  raw: Record<string, unknown>,
  extraUrls: unknown[] = [],
): (PaperFields & { paperId: string }) | null {
  const fields = paperFields(raw, extraUrls);
  const identity = identityOf(fields);
  return identity ? { ...fields, paperId: paperSourceId(identity) } : null;
}

/**
 * The run's scholarly papers, and every link that names one of them (by
 * looseWebUrlKey). literature_search results and literature_read papers.
 */
export function collectPaperSources(records: readonly PaperSourceRecord[]): {
  sources: Map<string, WebSourceDisplay>;
  linkIds: Map<string, string>;
} {
  const sources = new Map<string, WebSourceDisplay>();
  const linkIds = new Map<string, string>();
  const add = (fields: PaperFields) => {
    const identity = identityOf(fields);
    if (!identity) return;
    const id = paperSourceId(identity);
    const current = sources.get(id);
    const next = display(fields, id);
    if (!next) return;
    if (!current || (current.title === current.hostname && next.title)) {
      sources.set(id, current ? { ...next, url: current.url } : next);
    }
    for (const url of fields.urls) {
      const key = looseWebUrlKey(url);
      if (key && !linkIds.has(key)) linkIds.set(key, id);
    }
  };
  for (const record of records) {
    if (!record.ok) continue;
    const content = asObject(record.content);
    if (!content) continue;
    if (record.name === "literature_search" && Array.isArray(content.results)) {
      for (const entry of content.results) {
        const raw = asObject(entry);
        if (raw) add(paperFields(raw));
      }
    } else if (record.name === "literature_read") {
      const paper = asObject(content.paper);
      const fullText = asObject(content.fullText);
      if (paper) {
        add(paperFields(paper, [fullText?.landingUrl, fullText?.pdfUrl]));
      }
    }
  }
  return { sources, linkIds };
}
