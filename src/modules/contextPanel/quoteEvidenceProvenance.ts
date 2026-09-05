/**
 * Ask the answer where a quote came from, instead of searching for it.
 *
 * When an agent answers a library question it reads passages from papers and
 * is shown each one together with the item and attachment it came from.  That
 * pairing is persisted verbatim in the run's tool results, so the source of a
 * displayed quote is already recorded — there is no need to re-derive it at
 * click time from a citation label the model may have written incorrectly.
 *
 * This resolves a quote against those recorded passages.  It is exact, costs
 * no PDF read and no library search, and works on conversations recorded long
 * before the click is made.
 */

import { listAgentRunEvents } from "../../agent/store/traceStore";
import { MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE } from "./quoteCitations";
import { summarizeQuoteTextSupport } from "./quoteTextSearch";
import { sanitizeText } from "./textUtils";

export type QuoteEvidenceProvenance = {
  itemId: number;
  contextItemId: number;
  /** Fraction of the quote the recorded passages account for, 0..1. */
  coverage: number;
};

type EvidencePassage = {
  itemId: number;
  contextItemId: number;
  text: string;
};

/** Depth bound for walking an arbitrary tool result. */
const MAX_TOOL_CONTENT_DEPTH = 8;

/**
 * Passages beyond this are ignored.  A single retrieval returns at most a few
 * hundred; this only guards against a pathological run.
 */
const MAX_EVIDENCE_PASSAGES = 1000;

/** Runs kept in memory at once; passage text is not small. */
const MAX_CACHED_RUNS = 8;

const runEvidenceCache = new Map<string, EvidencePassage[]>();

function normalizePositiveInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Every recorded rendering of a passage, not just the first: a tool often
 * stores both a trimmed excerpt and the surrounding text it was cut from, and
 * a quote can straddle the trim point.  They are pooled per paper anyway, so
 * keeping all of them can only improve what the paper is credited with.
 */
function readPassageTexts(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ["snippet", "text", "surroundingText", "textContent"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(value);
  }
  return out;
}

/**
 * Collect every recorded passage that can name the paper and attachment it
 * came from.
 *
 * Tools disagree about where those ids live.  `library_retrieve` puts them on
 * the snippet itself; `paper_read` puts them on a `paperContext` beside the
 * text, or on a parent whose children carry the passages.  So an id pair found
 * at any level is inherited by everything below it until a nearer pair
 * overrides it, rather than requiring ids and text on one record.
 */
function collectEvidencePassages(content: unknown): EvidencePassage[] {
  const out: EvidencePassage[] = [];
  const seen = new WeakSet<object>();
  const visit = (
    value: unknown,
    depth: number,
    inherited: { itemId: number; contextItemId: number } | null,
  ) => {
    if (depth > MAX_TOOL_CONTENT_DEPTH || !value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1, inherited);
      return;
    }
    const record = value as Record<string, unknown>;
    const own = readIdPair(record) || readIdPair(record.paperContext);
    const scope = own || inherited;
    if (scope) {
      for (const text of readPassageTexts(record)) {
        out.push({ ...scope, text });
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1, scope);
  };
  visit(content, 0, null);
  return out;
}

function readIdPair(
  value: unknown,
): { itemId: number; contextItemId: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const itemId = normalizePositiveInt(record.itemId);
  const contextItemId = normalizePositiveInt(record.contextItemId);
  return itemId && contextItemId ? { itemId, contextItemId } : null;
}

async function loadRunEvidencePassages(
  agentRunId: string,
): Promise<EvidencePassage[] | null> {
  const cached = runEvidenceCache.get(agentRunId);
  if (cached) return cached;
  const passages: EvidencePassage[] = [];
  try {
    const events = await listAgentRunEvents(agentRunId);
    for (const event of events) {
      if (event.eventType !== "tool_result") continue;
      const record = event.payload as Record<string, unknown> | null;
      // A failed tool call proves nothing about where a quote came from.
      if (!record || record.ok === false) continue;
      passages.push(...collectEvidencePassages(record.content));
      passages.push(...collectEvidencePassages(record.artifacts));
    }
  } catch (error) {
    // A locked or busy database is transient.  Caching the empty result would
    // silently disable provenance for the rest of the session, so this stays
    // uncached and the next click tries again.
    ztoolkit.log("LLM quote provenance: could not read agent run trace", error);
    return null;
  }
  // The quote is likelier to have come from a later round than an earlier one,
  // so an over-long run keeps its most recent evidence.
  const bounded =
    passages.length > MAX_EVIDENCE_PASSAGES
      ? passages.slice(-MAX_EVIDENCE_PASSAGES)
      : passages;
  if (runEvidenceCache.size >= MAX_CACHED_RUNS) {
    const oldest = runEvidenceCache.keys().next();
    if (!oldest.done) runEvidenceCache.delete(oldest.value);
  }
  runEvidenceCache.set(agentRunId, bounded);
  return bounded;
}

export function clearQuoteEvidenceProvenanceCacheForTests(): void {
  runEvidenceCache.clear();
}

/**
 * Every paper whose recorded passages account for the quote, best first.
 *
 * More than one is unusual but real — a library holding both a preprint and
 * its published version records the same text twice.  Returning all of them
 * lets the caller break the tie with the citation label instead of taking
 * whichever the retrieval happened to return first.
 *
 * Passages are pooled per paper before judging, so a quote stitched from two
 * passages of one paper is recognised as fully accounted for by it.
 */
export async function resolveQuoteEvidenceProvenance(params: {
  agentRunId: string | undefined | null;
  quoteText: string;
}): Promise<QuoteEvidenceProvenance[]> {
  const agentRunId = sanitizeText(params.agentRunId || "").trim();
  const quoteText = sanitizeText(params.quoteText || "").trim();
  if (!agentRunId || !quoteText) return [];

  const passages = await loadRunEvidencePassages(agentRunId);
  if (!passages?.length) return [];

  const byPaper = new Map<string, EvidencePassage[]>();
  for (const passage of passages) {
    const key = `${passage.itemId}:${passage.contextItemId}`;
    const group = byPaper.get(key);
    if (group) group.push(passage);
    else byPaper.set(key, [passage]);
  }

  const out: QuoteEvidenceProvenance[] = [];
  for (const group of byPaper.values()) {
    const support = summarizeQuoteTextSupport(
      group.map((passage, index) => ({
        id: `passage-${index}`,
        text: passage.text,
      })),
      quoteText,
    );
    if (support.coverage < MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE) continue;
    out.push({
      itemId: group[0].itemId,
      contextItemId: group[0].contextItemId,
      coverage: support.coverage,
    });
  }
  return out.sort((left, right) => right.coverage - left.coverage);
}
