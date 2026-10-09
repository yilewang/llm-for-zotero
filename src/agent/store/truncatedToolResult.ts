/**
 * The persisted form of a big tool result.
 *
 * A successful tool result whose content serializes above
 * `PERSISTED_TOOL_RESULT_MAX_BYTES` (and that carries no action receipts) is
 * stored in the run's trace as this marker; its content lives under `handle`
 * in the tool-result handle store. Events persisted before the marker existed
 * keep their content whole.
 */
export const PERSISTED_TOOL_RESULT_MAX_BYTES = 32 * 1024;

export type TruncatedToolResultContent = {
  truncated: true;
  /** The trh_ handle holding the whole content, when one was stored. */
  handle?: string;
  /** Length of the content's JSON, in UTF-16 code units. */
  bytes: number;
  /**
   * A bounded copy of the content for the trace row (`buildToolResultPreview`):
   * its JSON fits `PREVIEW_MAX_BYTES`. Absent on markers written before it
   * existed, or when no copy fits.
   */
  preview?: unknown;
};

export const PREVIEW_STRING_MAX_CHARS = 200;
/** The shorter cut taken when shortening the leaf arrays was not enough. */
export const PREVIEW_SHORT_STRING_MAX_CHARS = 60;
export const PREVIEW_ARRAY_MIN_ENTRIES = 3;
/** Leaves room for the marker's own fields under 8 KB. */
export const PREVIEW_MAX_BYTES = 8 * 1024 - 256;
const PREVIEW_MAX_DEPTH = 32;
const PREVIEW_STRING_MEASUREMENT_CACHE_LIMIT = 256;

function measuredStringLength(
  text: string,
  cache: Map<string, number>,
): number {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const size = JSON.stringify(text).length;
  if (cache.size < PREVIEW_STRING_MEASUREMENT_CACHE_LIMIT)
    cache.set(text, size);
  return size;
}

/**
 * An array of the copy and its JSON length; `leaf` when it holds no array,
 * `outer` when no array holds it.
 */
type MeasuredArray = {
  array: unknown[];
  size: number;
  leaf: boolean;
  outer: boolean;
};

/** A shortened copy of a value, with the length of its JSON. */
type Measured = { value: unknown; size: number; hasArray: boolean };

/**
 * Copies `value` with every string cut to `maxChars`, and measures the
 * copy's JSON as it goes, in one walk: the copy's length, and each array
 * longer than the minimum with its own length. A value JSON leaves out
 * (undefined, a function) measures as JSON would place it.
 */
function shortenAndMeasure(
  value: unknown,
  maxChars: number,
  depth: number,
  arrays: MeasuredArray[],
  stringLengths: Map<string, number>,
  shortenedStrings: Map<string, Measured>,
  withinArray = false,
): Measured | undefined {
  if (typeof value === "string") {
    // Do not hash arbitrarily large source passages just to reuse a tiny
    // prefix. Modest repeated row values can share the immutable measurement.
    const cacheable = value.length <= PREVIEW_STRING_MAX_CHARS * 2;
    const cached = cacheable ? shortenedStrings.get(value) : undefined;
    if (cached) return cached;
    const text =
      value.length > maxChars ? `${value.slice(0, maxChars)}\u2026` : value;
    const measured = {
      value: text,
      size: measuredStringLength(text, stringLengths),
      hasArray: false,
    };
    if (
      cacheable &&
      shortenedStrings.size < PREVIEW_STRING_MEASUREMENT_CACHE_LIMIT
    ) {
      shortenedStrings.set(value, measured);
    }
    return measured;
  }
  if (value === null) return { value, size: 4, hasArray: false };
  if (typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined
      ? undefined
      : { value, size: json.length, hasArray: false };
  }
  if (depth > PREVIEW_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let size = 2 + Math.max(0, value.length - 1);
    let hasArray = false;
    for (const entry of value) {
      const measured = shortenAndMeasure(
        entry,
        maxChars,
        depth + 1,
        arrays,
        stringLengths,
        shortenedStrings,
        true,
      );
      out.push(measured ? measured.value : null);
      size += measured ? measured.size : 4;
      hasArray ||= Boolean(measured?.hasArray);
    }
    if (out.length > PREVIEW_ARRAY_MIN_ENTRIES)
      arrays.push({
        array: out,
        size,
        leaf: !hasArray,
        outer: !withinArray,
      });
    return { value: out, size, hasArray: true };
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function")
    return shortenAndMeasure(
      (value as { toJSON: () => unknown }).toJSON(),
      maxChars,
      depth,
      arrays,
      stringLengths,
      shortenedStrings,
      withinArray,
    );
  const out: Record<string, unknown> = {};
  let size = 2;
  let fields = 0;
  let hasArray = false;
  for (const [key, entry] of Object.entries(value)) {
    const measured = shortenAndMeasure(
      entry,
      maxChars,
      depth + 1,
      arrays,
      stringLengths,
      shortenedStrings,
      withinArray,
    );
    if (!measured) continue;
    out[key] = measured.value;
    size += measuredStringLength(key, stringLengths) + 1 + measured.size;
    fields += 1;
    hasArray ||= measured.hasArray;
  }
  size += Math.max(0, fields - 1);
  return { value: out, size, hasArray };
}

/**
 * The fraction of their entries the given arrays keep so that, entries
 * being alike in size, they give up `excess` characters of JSON.
 */
function keptFraction(arrays: readonly MeasuredArray[], excess: number) {
  const total = arrays.reduce((sum, entry) => sum + entry.size, 0);
  return total ? Math.max(0, (total - excess) / total) : 1;
}

/** Cuts arrays of a copy in place to `keep` of their entries, never below three. */
function cutArrays(arrays: readonly MeasuredArray[], keep: number): void {
  for (const { array } of arrays) {
    array.length = Math.max(
      PREVIEW_ARRAY_MIN_ENTRIES,
      Math.min(array.length, Math.floor(array.length * keep)),
    );
  }
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value ?? null).length;
}

/**
 * The bounded copy of a tool result a truncated marker keeps, or undefined
 * when even the shortest copy does not fit. Keys and scalar fields survive
 * (a result's `mode`, receipts, labels, counts). Until the JSON fits: every
 * string is cut to 200 characters; then the arrays that hold no array
 * (passage ids, citation lists, listed rows) lose their last entries, all by
 * one fraction; then strings are cut to 60 characters and every array loses
 * its last entries by one fraction. No array is cut below its first three
 * entries.
 *
 * Cost is linear in the result: each step is one walk that copies and
 * measures, and the cuts are sized from those measures instead of being
 * measured entry by entry. A result that fits after the first cut is walked
 * twice; the shortest copy takes two more walks.
 */
export function buildToolResultPreview(content: unknown): unknown {
  try {
    // Repeated row fields and strings need the same JSON escaping calculation.
    // Keep the memo bounded and local to this preview; never retain result data.
    const stringLengths = new Map<string, number>();
    let arrays: MeasuredArray[] = [];
    let measured = shortenAndMeasure(
      content,
      PREVIEW_STRING_MAX_CHARS,
      0,
      arrays,
      stringLengths,
      new Map(),
    );
    if (!measured) return undefined;
    if (measured.size <= PREVIEW_MAX_BYTES) return measured.value;
    // Arrays that hold no array never hold one another, so their sizes add.
    const leaves = arrays.filter((entry) => entry.leaf);
    cutArrays(leaves, keptFraction(leaves, measured.size - PREVIEW_MAX_BYTES));
    let size = jsonLength(measured.value);
    if (size <= PREVIEW_MAX_BYTES) return measured.value;
    arrays = [];
    measured = shortenAndMeasure(
      measured.value,
      PREVIEW_SHORT_STRING_MAX_CHARS,
      0,
      arrays,
      stringLengths,
      new Map(),
    );
    if (!measured) return undefined;
    if (measured.size <= PREVIEW_MAX_BYTES) return measured.value;
    // An array's size includes the arrays it holds, so the fraction is sized
    // on the outermost arrays; the arrays they hold are cut by it too.
    cutArrays(
      arrays,
      keptFraction(
        arrays.filter((entry) => entry.outer),
        measured.size - PREVIEW_MAX_BYTES,
      ),
    );
    size = jsonLength(measured.value);
    return size <= PREVIEW_MAX_BYTES ? measured.value : undefined;
  } catch {
    return undefined;
  }
}

/** The content a trace row reads: a stored result's preview, else the content. */
export function toolResultContentForDisplay(content: unknown): unknown {
  return isTruncatedToolResultContent(content) ? content.preview : content;
}

export function isTruncatedToolResultContent(
  value: unknown,
): value is TruncatedToolResultContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.truncated === true &&
    typeof record.bytes === "number" &&
    Number.isFinite(record.bytes) &&
    (record.handle === undefined || typeof record.handle === "string")
  );
}
