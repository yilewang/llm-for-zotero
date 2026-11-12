/**
 * The stored form of a quote location saved by the display gate's
 * write-back: the record fields that name a PDF page, the attachment file
 * state saved with them, and the JSON merge each conversation store applies
 * to one row's `quote_citations_json`.
 *
 * Pure helpers with no service imports, so the stores in `src/utils/` and
 * `src/services/` can share them. Which locations qualify for saving is
 * decided in `src/services/quotes/quoteLocationPersistence.ts`.
 */
import type { QuoteCitation } from "./types";

/** The attachment file a location was found in, as a stat reports it. */
export type QuoteSourceFileState = { size: number; mtime: number };

/**
 * A citation record that may carry `sourceFileState`. The field is written
 * only by the location write-back; `normalizeQuoteCitations` does not keep
 * it, so loads restore it with `restoreQuoteSourceFileStates`.
 */
export type QuoteCitationWithFileState = QuoteCitation & {
  sourceFileState?: QuoteSourceFileState;
};

/** The record fields that say where on a PDF page a quote was found. */
export const QUOTE_LOCATION_FIELDS = [
  "sourceMatchSource",
  "sourceMatchText",
  "sourceMatchKind",
  "sourceFingerprint",
  "pageHintIndex",
  "pageHintLabel",
  "sourceMatchPageOccurrence",
] as const;

export type QuoteLocationFields = Pick<
  QuoteCitation,
  (typeof QUOTE_LOCATION_FIELDS)[number]
>;

/** One stored record's new location, keyed by record id and attachment. */
export type QuoteLocationWrite = {
  id: string;
  contextItemId: number;
  location: QuoteLocationFields;
  sourceFileState: QuoteSourceFileState;
};

export function normalizeQuoteSourceFileState(
  value: unknown,
): QuoteSourceFileState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { size, mtime } = value as { size?: unknown; mtime?: unknown };
  if (
    typeof size !== "number" ||
    typeof mtime !== "number" ||
    !Number.isFinite(size) ||
    !Number.isFinite(mtime) ||
    size < 0
  ) {
    return undefined;
  }
  return { size, mtime };
}

export function quoteSourceFileStatesEqual(
  left: QuoteSourceFileState | undefined | null,
  right: QuoteSourceFileState | undefined | null,
): boolean {
  return Boolean(
    left && right && left.size === right.size && left.mtime === right.mtime,
  );
}

/**
 * `record` with the write's location fields and file state. A location field
 * the write does not carry is removed, so a stale page label cannot survive
 * next to a new page. Returns a new object; `record` is not changed.
 */
export function mergeQuoteLocationWrite<T extends Record<string, unknown>>(
  record: T,
  write: QuoteLocationWrite,
): T {
  const next: Record<string, unknown> = { ...record };
  for (const field of QUOTE_LOCATION_FIELDS) {
    const value = write.location[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  next.sourceFileState = { ...write.sourceFileState };
  return next as T;
}

export function recordMatchesWrite(
  record: { id?: unknown; contextItemId?: unknown },
  write: QuoteLocationWrite,
): boolean {
  return (
    record.id === write.id &&
    Math.floor(Number(record.contextItemId)) === write.contextItemId
  );
}

/**
 * The stored `quote_citations_json` with `writes` merged in, or null when
 * nothing changes (no matching record, unreadable JSON, or the same values).
 * Records the writes do not name are written back exactly as parsed.
 */
export function mergeQuoteLocationWritesIntoStoredJson(
  json: unknown,
  writes: readonly QuoteLocationWrite[],
): string | null {
  if (typeof json !== "string" || !json || !writes.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  const next = parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    const write = writes.find((candidate) =>
      recordMatchesWrite(record, candidate),
    );
    if (!write) return entry;
    const merged = mergeQuoteLocationWrite(record, write);
    if (JSON.stringify(merged) === JSON.stringify(record)) return entry;
    changed = true;
    return merged;
  });
  return changed ? JSON.stringify(next) : null;
}

/**
 * Re-attach the stored `sourceFileState` that `normalizeQuoteCitations`
 * drops, matching records by id. `raw` is the parsed stored JSON.
 */
export function restoreQuoteSourceFileStates(
  raw: unknown,
  normalized: QuoteCitation[],
): QuoteCitation[] {
  if (!Array.isArray(raw) || !normalized.length) return normalized;
  const states = new Map<string, QuoteSourceFileState>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, sourceFileState } = entry as {
      id?: unknown;
      sourceFileState?: unknown;
    };
    const state = normalizeQuoteSourceFileState(sourceFileState);
    if (typeof id === "string" && state && !states.has(id)) {
      states.set(id, state);
    }
  }
  if (!states.size) return normalized;
  return normalized.map((citation) => {
    const state = states.get(citation.id);
    return state ? { ...citation, sourceFileState: state } : citation;
  });
}
