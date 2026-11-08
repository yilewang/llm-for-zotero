/**
 * Outside papers in a document's citations: the CSL-JSON item each cited
 * outside paper is formatted from, and the link its citations and its
 * References entry open.
 *
 * The CSL item is built from the run's record of the paper (a search row or
 * a literature_read result). A paper with a DOI may gain its venue, volume,
 * issue, pages, date, authors and type from a metadata lookup: started when
 * the run read the paper, or at submit time. Any failure, or a lookup that
 * has not answered by the submission's deadline, leaves the record's own
 * fields. The lookup only reads: it never writes to the library.
 */
import {
  lookUpOutsidePaperDoi,
  normalizedDoi,
  type OutsidePaperLookupCache,
  type OutsidePaperMetadataLookup,
  type OutsidePaperRecord,
} from "../context/outsidePaperRecords";
import type {
  CslName,
  OutsidePaperCslEnrichment,
  OutsidePaperCslItem,
  OutsidePaperSnapshot,
} from "./types";

export { normalizedDoi, type OutsidePaperMetadataLookup };

/**
 * The most time every lookup of one submission takes together. The run's
 * lookups go one at a time, so this covers about ten cited papers that the
 * run did not look up while reading them.
 */
export const OUTSIDE_PAPER_LOOKUP_TIMEOUT_MS = 10000;

/** Lowercase name particles that belong to the family name ("van Gogh"). */
const NAME_PARTICLES = new Set([
  "al",
  "bin",
  "da",
  "das",
  "de",
  "del",
  "della",
  "der",
  "di",
  "do",
  "dos",
  "du",
  "el",
  "la",
  "le",
  "ten",
  "ter",
  "van",
  "von",
]);
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;
/** A group author, which has no family or given name to split. */
const GROUP_AUTHOR =
  /\b(?:collaboration|consortium|group|team|initiative|network|committee|society|association|investigators|project)\b/i;

/**
 * One display name as a CSL name: "Given Family", or "Family, Given", split
 * at the family name (with any lowercase particles before it). A
 * single-token name or a group author stays whole as `literal`.
 */
export function cslNameOf(displayName: string): CslName | null {
  const name = displayName.replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (GROUP_AUTHOR.test(name)) return { literal: name };
  const parts = name
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && !NAME_SUFFIX.test(parts[1])) {
    const suffix = parts[2] && NAME_SUFFIX.test(parts[2]) ? parts[2] : "";
    return {
      family: parts[0],
      given: parts[1],
      ...(suffix ? { suffix } : {}),
    };
  }
  const tokens = parts[0].split(" ");
  let suffix = parts.length >= 2 ? parts[1] : "";
  if (
    !suffix &&
    tokens.length > 2 &&
    NAME_SUFFIX.test(tokens[tokens.length - 1])
  )
    suffix = tokens.pop() || "";
  if (tokens.length === 1) {
    return suffix ? { family: tokens[0], suffix } : { literal: name };
  }
  let start = tokens.length - 1;
  while (start > 1 && NAME_PARTICLES.has(tokens[start - 1])) start -= 1;
  return {
    family: tokens.slice(start).join(" "),
    given: tokens.slice(0, start).join(" "),
    ...(suffix ? { suffix } : {}),
  };
}

/** An arXiv preprint: an arXiv id without a journal DOI, or arXiv's DOI. */
function isArxivOnly(paper: Pick<OutsidePaperRecord, "doi" | "arxivId">) {
  return paper.doi ? /^10\.48550\//i.test(paper.doi) : Boolean(paper.arxivId);
}

/**
 * The paper's own page: arXiv's abstract page, PubMed, Europe PMC, else the
 * page the record carries. Undefined when the paper has none of them.
 */
export function outsidePaperPageUrl(
  paper: Pick<OutsidePaperSnapshot, "arxivId" | "pmid" | "pmcid" | "url">,
): string | undefined {
  if (paper.arxivId) return `https://arxiv.org/abs/${paper.arxivId}`;
  if (paper.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`;
  if (paper.pmcid) return `https://europepmc.org/article/PMC/${paper.pmcid}`;
  return paper.url;
}

/**
 * A URL as a Markdown link target: spaces, parentheses and angle brackets
 * (DOIs often hold parentheses) are percent-encoded, so the target ends
 * where the link does. Existing escapes are kept as they are.
 */
export function markdownLinkTarget(url: string): string {
  return url.replace(
    /[\s()<>]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * The link an outside paper's citations open: its DOI at doi.org, else its
 * own page. Undefined when the paper has neither.
 */
export function outsidePaperUri(
  paper: Pick<
    OutsidePaperSnapshot,
    "doi" | "arxivId" | "pmid" | "pmcid" | "url"
  >,
): string | undefined {
  const page = paper.doi
    ? `https://doi.org/${paper.doi.split("/").map(encodeURIComponent).join("/")}`
    : outsidePaperPageUrl(paper);
  return page ? markdownLinkTarget(page) : undefined;
}

/** The CSL item for one outside paper, from the run's record of it. */
export function outsidePaperCslItem(
  paper: OutsidePaperRecord,
  id: string,
  enrichment: OutsidePaperCslEnrichment = {},
): OutsidePaperCslItem {
  const authors = paper.authors.flatMap((name) => cslNameOf(name) || []);
  const url = outsidePaperPageUrl(paper);
  return {
    id,
    type: isArxivOnly(paper) ? "article" : "article-journal",
    ...(paper.title ? { title: paper.title } : {}),
    ...(authors.length ? { author: authors } : {}),
    ...(paper.year !== undefined
      ? { issued: { "date-parts": [[paper.year]] } }
      : {}),
    ...(paper.doi ? { DOI: paper.doi } : {}),
    ...(url ? { URL: url } : {}),
    ...enrichment,
  };
}

/**
 * The answer for every DOI, within one shared deadline. A DOI the run
 * already looked up is answered from the cache; one under way (a prefetch)
 * is awaited; the rest are queued on the run's lookups, one at a time. A DOI
 * still unanswered at the deadline is cached as null, and an answer that
 * arrives later is not used, so a retried submission formats identically.
 * Without a cache, the lookups of this submission alone share one.
 */
async function lookUpEnrichments(
  papers: readonly OutsidePaperRecord[],
  lookup: OutsidePaperMetadataLookup | undefined,
  timeoutMs: number,
  runCache: OutsidePaperLookupCache | undefined,
): Promise<OutsidePaperCslEnrichment[]> {
  if (!lookup || !papers.some((paper) => paper.doi))
    return papers.map(() => ({}));
  const cache = runCache ?? {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    const dois = papers.flatMap((paper) => (paper.doi ? [paper.doi] : []));
    await Promise.race([
      Promise.all(
        dois.map((doi) =>
          lookUpOutsidePaperDoi(cache, doi, lookup).catch(() => null),
        ),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // Read in one pass after the deadline: what is cached now is what this
  // submission, and any retry of it, cites.
  return papers.map((paper) => {
    if (!paper.doi) return {};
    const key = normalizedDoi(paper.doi);
    if (!Object.prototype.hasOwnProperty.call(cache, key)) cache[key] = null;
    return cache[key] || {};
  });
}

/**
 * The snapshots of the outside papers a document cites, in the order given.
 * Their CSL ids are provisional; the citation formatter numbers the papers
 * the document uses.
 */
export async function buildOutsidePaperSnapshots(params: {
  papers: readonly OutsidePaperRecord[];
  lookup?: OutsidePaperMetadataLookup;
  timeoutMs?: number;
  /** The run's earlier lookups; new answers are added to it. */
  cache?: OutsidePaperLookupCache;
}): Promise<OutsidePaperSnapshot[]> {
  const enrichments = await lookUpEnrichments(
    params.papers,
    params.lookup,
    params.timeoutMs ?? OUTSIDE_PAPER_LOOKUP_TIMEOUT_MS,
    params.cache,
  );
  return params.papers.map((paper, index) => ({
    paperId: paper.paperId,
    ...(paper.doi ? { doi: paper.doi } : {}),
    ...(paper.arxivId ? { arxivId: paper.arxivId } : {}),
    ...(paper.pmid ? { pmid: paper.pmid } : {}),
    ...(paper.pmcid ? { pmcid: paper.pmcid } : {}),
    ...(paper.url ? { url: paper.url } : {}),
    csl: outsidePaperCslItem(paper, `ext-${index + 1}`, enrichments[index]),
  }));
}
