/**
 * The run's outside papers: the scholarly papers literature_search and
 * literature_read returned in this run, which a document may cite by
 * paperId. The host writes the record after each successful call; the model
 * never supplies it. A paper's id is its paper source id (paperSources.ts),
 * the id its chat chip carries. Records that share an identifier (DOI, arXiv
 * id, PMID, PMCID) and hold no different value of another are one paper and
 * keep the id of the first one seen, so a paper has one id for the run
 * whatever the tool that returned it knew of it.
 *
 * Web pages (web_search, web_read) are never recorded: they are not citable.
 */
import { paperSourceIdentity } from "../../webAccess/paperSources";
import { normalizeArxivId, normalizeDoi } from "../services/paperWorkIdentity";
import type { OutsidePaperCslEnrichment } from "../documents/types";

/** How far the run read an outside paper. */
export type OutsidePaperDepth = "metadata" | "abstract" | "body";

export type OutsidePaperRecord = Readonly<{
  paperId: string;
  /** The ids of duplicate records merged into this one. */
  aliasIds?: readonly string[];
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  /** The paper's own page (landing page or open copy), not the DOI resolver. */
  url?: string;
  title?: string;
  authors: readonly string[];
  year?: number;
  abstract?: string;
  depth: OutsidePaperDepth;
}>;

/**
 * The run's DOI lookups for citing outside papers, by normalized DOI: what
 * each added, or null when it added nothing (it failed or ran out of time).
 * One answer per DOI per run, so a retried submission formats the same
 * document.
 */
export type OutsidePaperLookupCache = Record<
  string,
  OutsidePaperCslEnrichment | null
>;

/** Finds the CSL fields of the paper with this DOI; null when none. */
export type OutsidePaperMetadataLookup = (
  doi: string,
) => Promise<OutsidePaperCslEnrichment | null>;

/**
 * Where a run keeps its outside papers: the native run's request, or the MCP
 * scope of a connected runtime. `outsidePaperSelection`, once set, names the
 * only outside papers the user chose to cite (the review card sets it).
 * `outsidePaperLookupCache` is created with the first record and shared by
 * reference, so every request built from the holder sees one cache.
 */
export type OutsidePaperHolder = {
  outsidePaperRecords?: readonly OutsidePaperRecord[];
  outsidePaperSelection?: readonly string[];
  outsidePaperLookupCache?: OutsidePaperLookupCache;
};

const DEPTH_RANK: Record<OutsidePaperDepth, number> = {
  metadata: 0,
  abstract: 1,
  body: 2,
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function webUrl(value: unknown): string | undefined {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * Every identifier that names the paper, normalized. An arXiv DOI and the
 * arXiv id it holds are one identifier. The id itself is the last resort for
 * a paper known only by its link.
 */
function identifierKeys(
  record: Pick<
    OutsidePaperRecord,
    "paperId" | "aliasIds" | "doi" | "arxivId" | "pmid" | "pmcid"
  >,
): string[] {
  const keys = new Set<string>();
  const doi = normalizeDoi(record.doi);
  if (doi) {
    keys.add(`doi:${doi}`);
    const arxiv = normalizeArxivId(doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1]);
    if (arxiv) keys.add(`arxiv:${arxiv}`);
  }
  const arxiv = normalizeArxivId(record.arxivId);
  if (arxiv) keys.add(`arxiv:${arxiv}`);
  if (record.pmid) keys.add(`pmid:${record.pmid}`);
  if (record.pmcid) keys.add(`pmcid:${record.pmcid.toUpperCase()}`);
  for (const id of [record.paperId, ...(record.aliasIds || [])])
    keys.add(`id:${id}`);
  return [...keys];
}

/**
 * The identifiers a record holds, by kind. An arXiv DOI counts as the arXiv
 * id it holds, not as a DOI. Two values of one kind are two papers.
 */
function identifiersByKind(
  record: Pick<OutsidePaperRecord, "doi" | "arxivId" | "pmid" | "pmcid">,
): Record<"doi" | "arxiv" | "pmid" | "pmcid", string | undefined> {
  const doi = normalizeDoi(record.doi);
  const arxivDoi = normalizeArxivId(doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1]);
  return {
    doi: doi && !arxivDoi ? doi : undefined,
    arxiv: normalizeArxivId(record.arxivId) || arxivDoi || undefined,
    pmid: record.pmid?.trim() || undefined,
    pmcid: record.pmcid?.trim().toUpperCase() || undefined,
  };
}

/** Whether two records hold different values of one identifier kind. */
function identifiersConflict(
  a: Pick<OutsidePaperRecord, "doi" | "arxivId" | "pmid" | "pmcid">,
  b: Pick<OutsidePaperRecord, "doi" | "arxivId" | "pmid" | "pmcid">,
): boolean {
  const left = identifiersByKind(a);
  const right = identifiersByKind(b);
  return (["doi", "arxiv", "pmid", "pmcid"] as const).some(
    (kind) => left[kind] && right[kind] && left[kind] !== right[kind],
  );
}

function isSelected(
  record: Pick<OutsidePaperRecord, "paperId" | "aliasIds">,
  selection: readonly string[],
): boolean {
  return [record.paperId, ...(record.aliasIds || [])].some((id) =>
    selection.includes(id),
  );
}

/**
 * The held records this one joins. A record that carries the id of a held
 * record (or one of its aliases) is that paper: it joins that record and no
 * other, whatever the identifiers or the selection say, so no id is ever held
 * by two records. Otherwise it joins the held records that share an identifier
 * with it and are not a different paper: none that holds another value of an
 * identifier kind it holds. Once a selection is set, a record that reaches
 * both chosen and unchosen papers joins the chosen ones only, so a merge never
 * pulls an unchosen paper into a chosen one. If the records it would join
 * conflict with each other, it joins none and stays its own paper.
 */
function sameRecordIndexes(
  records: readonly OutsidePaperRecord[],
  record: OutsidePaperRecord,
  selection?: readonly string[],
): number[] {
  const ids = new Set([record.paperId, ...(record.aliasIds || [])]);
  const byId = records.findIndex((held) =>
    [held.paperId, ...(held.aliasIds || [])].some((id) => ids.has(id)),
  );
  if (byId >= 0) return [byId];
  const keys = new Set(identifierKeys(record));
  let joins = records.flatMap((held, index) => {
    if (!identifierKeys(held).some((key) => keys.has(key))) return [];
    return identifiersConflict(held, record) ? [] : [index];
  });
  if (selection) {
    const chosen = joins.filter((index) =>
      isSelected(records[index], selection),
    );
    if (chosen.length) joins = chosen;
  }
  const ambiguous = joins.some((a, i) =>
    joins.slice(i + 1).some((b) => identifiersConflict(records[a], records[b])),
  );
  return ambiguous ? [] : joins;
}

/**
 * The paper's id, when it has an identity. With the run's holder, the id the
 * run already knows the paper by, when a recorded paper shares an identifier.
 */
export function outsidePaperId(
  raw: Record<string, unknown>,
  extraUrls: unknown[] = [],
  holder?: OutsidePaperHolder,
): string | undefined {
  const identity = paperSourceIdentity(raw, extraUrls);
  if (!identity) return undefined;
  const held = holder?.outsidePaperRecords;
  if (!held?.length) return identity.paperId;
  const match = sameRecordIndexes(
    held,
    { ...identity, authors: [], depth: "metadata" },
    holder?.outsidePaperSelection,
  )[0];
  return match === undefined ? identity.paperId : held[match].paperId;
}

/** The run's record of this paper, by its id or the id of a duplicate merged into it. */
export function findOutsidePaperRecord(
  holder: OutsidePaperHolder,
  paperId: string,
): OutsidePaperRecord | undefined {
  return (holder.outsidePaperRecords || []).find(
    (record) =>
      record.paperId === paperId || record.aliasIds?.includes(paperId),
  );
}

/**
 * Whether a literature_read result found its paper: a read that came back
 * with nothing (not found, or every source failed before a title) names no
 * paper anyone can cite.
 */
export function literatureReadFoundPaper(
  paper: Record<string, unknown>,
  fullText: Record<string, unknown> | null | undefined,
): boolean {
  return fullText?.status !== "unavailable" || Boolean(text(paper.title));
}

function recordOf(
  raw: Record<string, unknown>,
  depth: OutsidePaperDepth,
  options: { abstract?: unknown; extraUrls?: unknown[] } = {},
): OutsidePaperRecord | null {
  const extraUrls = options.extraUrls || [];
  const identity = paperSourceIdentity(raw, extraUrls);
  if (!identity) return null;
  // Landing pages first: an open copy is often the PDF itself.
  const url = [raw.url, raw.sourceUrl, ...extraUrls, raw.openAccessUrl]
    .map(webUrl)
    .find(Boolean);
  const abstract = text(options.abstract);
  return {
    paperId: identity.paperId,
    ...(identity.doi ? { doi: identity.doi } : {}),
    ...(identity.arxivId ? { arxivId: identity.arxivId } : {}),
    ...(identity.pmid ? { pmid: identity.pmid } : {}),
    ...(identity.pmcid ? { pmcid: identity.pmcid } : {}),
    ...(url ? { url } : {}),
    ...(identity.title ? { title: identity.title } : {}),
    authors: identity.authors,
    ...(identity.year !== undefined ? { year: identity.year } : {}),
    ...(abstract ? { abstract } : {}),
    depth,
  };
}

/** How deep a literature_read result went: body only when text came back. */
function literatureReadDepth(
  content: Record<string, unknown>,
): OutsidePaperDepth {
  const passages = Array.isArray(content.passages) ? content.passages : [];
  if (passages.length || text(content.text)) return "body";
  return text(content.abstract) ? "abstract" : "metadata";
}

/**
 * The outside papers one successful tool result returned: every
 * literature_search row (metadata), or literature_read's paper at the depth
 * the read reached. Other tools, and a metadata lookup of a library item,
 * return none.
 */
export function outsidePaperRecordsFromToolResult(
  toolName: string,
  content: unknown,
): OutsidePaperRecord[] {
  const result = asObject(content);
  if (!result) return [];
  if (toolName === "literature_search") {
    if (result.mode === "metadata" || !Array.isArray(result.results)) return [];
    return result.results.flatMap((entry) => {
      const raw = asObject(entry);
      const record = raw
        ? recordOf(raw, "metadata", { abstract: raw.abstract })
        : null;
      return record ? [record] : [];
    });
  }
  if (toolName === "literature_read") {
    const paper = asObject(result.paper);
    const fullText = asObject(result.fullText);
    if (!paper || !literatureReadFoundPaper(paper, fullText)) return [];
    const record = recordOf(paper, literatureReadDepth(result), {
      abstract: result.abstract,
      extraUrls: [fullText?.landingUrl, fullText?.pdfUrl],
    });
    return record ? [record] : [];
  }
  return [];
}

/**
 * One paper's two records as one: the deeper record's fields (its abstract
 * is the fuller one; search rows are cut), the other's where it has none.
 * The first-seen record's id stays; the other's id becomes an alias.
 */
function mergeRecord(
  current: OutsidePaperRecord,
  next: OutsidePaperRecord,
): OutsidePaperRecord {
  const deeper =
    DEPTH_RANK[next.depth] > DEPTH_RANK[current.depth] ? next : current;
  const other = deeper === next ? current : next;
  const { aliasIds: _aliases, ...fields } = { ...other, ...deeper };
  const aliasIds = [
    ...new Set([
      ...(current.aliasIds || []),
      ...(next.aliasIds || []),
      next.paperId,
    ]),
  ].filter((id) => id !== current.paperId);
  return {
    ...fields,
    paperId: current.paperId,
    authors: deeper.authors.length ? deeper.authors : other.authors,
    ...(aliasIds.length ? { aliasIds } : {}),
  };
}

/**
 * The records with the new ones merged in, one per paper, in first-seen
 * order. Records sharing an identifier are one paper, under the id of the
 * first seen, unless they hold different values of another identifier (two
 * DOIs, two PMIDs: two papers). Once a selection is set, a merge never joins
 * an unchosen paper into a chosen one.
 */
export function mergeOutsidePaperRecords(
  current: readonly OutsidePaperRecord[],
  incoming: readonly OutsidePaperRecord[],
  selection?: readonly string[],
): OutsidePaperRecord[] {
  let records = [...current];
  for (const record of incoming) {
    const matches = sameRecordIndexes(records, record, selection);
    if (!matches.length) {
      records.push(record);
      continue;
    }
    const merged = [
      ...matches.slice(1).map((index) => records[index]),
      record,
    ].reduce(mergeRecord, records[matches[0]]);
    records[matches[0]] = merged;
    const dropped = new Set(matches.slice(1));
    records = records.filter((_, index) => !dropped.has(index));
  }
  return records;
}

/** Adds a tool result's outside papers to the run's record. */
export function rememberOutsidePapers(
  holder: OutsidePaperHolder,
  records: readonly OutsidePaperRecord[],
): void {
  if (!records.length) return;
  holder.outsidePaperLookupCache ??= {};
  holder.outsidePaperRecords = mergeOutsidePaperRecords(
    holder.outsidePaperRecords || [],
    records,
    holder.outsidePaperSelection,
  );
}

/**
 * Limits the citable outside papers to the ones the user chose; undefined
 * lifts the limit. Every recorded paper is citable until a choice is set.
 */
export function setOutsidePaperSelection(
  holder: OutsidePaperHolder,
  paperIds: readonly string[] | undefined,
): void {
  holder.outsidePaperSelection = paperIds ? [...new Set(paperIds)] : undefined;
}

/** Why a document may not cite this outside paper; undefined when it may. */
export function outsidePaperCitationRefusal(
  holder: OutsidePaperHolder,
  paperId: string,
): string | undefined {
  const recorded = findOutsidePaperRecord(holder, paperId);
  if (!recorded) {
    return `Outside paper ${paperId} was not returned by literature_search or literature_read in this run; only papers those tools returned in this run can be cited by paperId.`;
  }
  if (
    holder.outsidePaperSelection &&
    ![recorded.paperId, ...(recorded.aliasIds || [])].some((id) =>
      holder.outsidePaperSelection?.includes(id),
    )
  ) {
    return `Outside paper ${paperId} is not one of the papers the user chose to cite.`;
  }
  return undefined;
}

/** The outside papers a document of this run may cite. */
export function citableOutsidePapers(
  holder: OutsidePaperHolder,
): OutsidePaperRecord[] {
  return (holder.outsidePaperRecords || []).filter(
    (record) => !outsidePaperCitationRefusal(holder, record.paperId),
  );
}

/** A DOI as the run's lookup cache keys it. */
export function normalizedDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

/**
 * The longest one lookup holds the run's queue. A request that has not
 * answered by then adds nothing, and the next lookup starts; there is no
 * way to cancel the request itself.
 */
export const OUTSIDE_PAPER_LOOKUP_REQUEST_TIMEOUT_MS = 6000;

/** A run's lookups: the last one queued, and the DOIs still waiting for an answer. */
type LookupQueue = {
  tail: Promise<unknown>;
  pending: Map<string, Promise<OutsidePaperCslEnrichment | null>>;
};

/**
 * The queue of each run, by its lookup cache: the cache is the one object
 * every request and scope update of a run shares, and it stays plain data.
 */
const lookupQueues = new WeakMap<OutsidePaperLookupCache, LookupQueue>();

function hasAnswer(cache: OutsidePaperLookupCache, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(cache, key);
}

/** The lookup's answer, or null when it fails or outlasts the cap. */
function cappedLookup(
  lookup: OutsidePaperMetadataLookup,
  doi: string,
  timeoutMs: number,
): Promise<OutsidePaperCslEnrichment | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    // Node's timers (the unit tests) would keep the process alive for a
    // request nobody waits for; Gecko's timer ids have no unref.
    (timer as { unref?: () => void } | undefined)?.unref?.();
  });
  return Promise.race([
    Promise.resolve()
      .then(() => lookup(doi))
      .catch(() => null),
    capped,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The run's answer for this DOI: the cached one, the lookup already under
 * way, or a new lookup queued behind the run's others. Lookups run one at a
 * time, because Crossref's public pool throttles parallel requests. An
 * answer is cached only when no answer is there yet, so an answer that
 * arrives after a submission recorded nothing for the DOI never changes
 * what the run cites. A failure, a refusal (HTTP 429 included) and a
 * request that outlasts the cap are all cached as null and never retried.
 */
export function lookUpOutsidePaperDoi(
  cache: OutsidePaperLookupCache,
  doi: string,
  lookup: OutsidePaperMetadataLookup,
  options: { requestTimeoutMs?: number } = {},
): Promise<OutsidePaperCslEnrichment | null> {
  const key = normalizedDoi(doi);
  if (hasAnswer(cache, key)) return Promise.resolve(cache[key]);
  // arXiv's DOIs are registered with DataCite, not Crossref: asking would
  // only hold the queue.
  if (key.startsWith("10.48550/")) {
    cache[key] = null;
    return Promise.resolve(null);
  }
  let queue = lookupQueues.get(cache);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: new Map() };
    lookupQueues.set(cache, queue);
  }
  const running = queue.pending.get(key);
  if (running) return running;
  const owner = queue;
  const answer = owner.tail
    .then(() =>
      // A submission may have recorded nothing for it while it waited.
      hasAnswer(cache, key)
        ? cache[key]
        : cappedLookup(
            lookup,
            doi,
            options.requestTimeoutMs ?? OUTSIDE_PAPER_LOOKUP_REQUEST_TIMEOUT_MS,
          ),
    )
    .then((found) => {
      if (!hasAnswer(cache, key)) cache[key] = found || null;
      owner.pending.delete(key);
      return cache[key];
    });
  owner.pending.set(key, answer);
  owner.tail = answer.catch(() => undefined);
  return answer;
}

/** The lookup a run's reads start in the background; none until the agent installs it. */
let prefetchLookup: OutsidePaperMetadataLookup | null = null;

/**
 * Installs the background lookup, or removes it with null. The agent
 * subsystem installs it at start; without it, recording a paper looks
 * nothing up.
 */
export function setOutsidePaperPrefetchLookup(
  lookup: OutsidePaperMetadataLookup | null,
): void {
  prefetchLookup = lookup;
}

/**
 * Starts, on the run's queue, the DOI lookups of papers the run read at
 * abstract or body depth: the papers a document is likely to cite. The
 * caller does not wait, and nothing is thrown into the call that recorded
 * them.
 */
export function prefetchOutsidePaperLookups(
  holder: OutsidePaperHolder,
  records: readonly OutsidePaperRecord[],
): void {
  const lookup = prefetchLookup;
  if (!lookup) return;
  try {
    for (const record of records) {
      if (record.depth === "metadata" || !record.doi) continue;
      const cache = (holder.outsidePaperLookupCache ??= {});
      void lookUpOutsidePaperDoi(cache, record.doi, lookup).catch(
        () => undefined,
      );
    }
  } catch {
    // A prefetch only saves time at submission; it never fails a read.
  }
}
