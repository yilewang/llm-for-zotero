const SEARCH_BOUNDARY_PUNCTUATION_RE =
  /^[\s"'`“”‘’([{<]+|[\s"'`“”‘’)\]}>.,;:!?]+$/g;
const SEARCH_WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const PLAIN_ASCII_WORD_PATTERN = /^[a-z]+$/;
const NUMERIC_TOKEN_PATTERN = /^\p{N}+$/u;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const COMMON_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "with",
]);

const ELLIPSIS_RE = /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/;
const ELLIPSIS_RE_G = /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/g;
const NORMALIZED_QUERY_LENGTHS = [100, 80, 60, 40, 30, 25, 20, 15];
const FIND_CONTROLLER_HYPHEN_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const FIND_CONTROLLER_TOKEN_RE =
  /[A-Za-z0-9]+(?:[-\u2010-\u2015][A-Za-z0-9]+)*/g;
const FIND_CONTROLLER_COMPOUND_SECOND_WORDS = new Set([
  "based",
  "computer",
  "decay",
  "dimensional",
  "guided",
  "manifold",
  "participant",
  "regularized",
  "time",
  "voxel",
]);

function sanitizeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i];
  }
  return out;
}

export type QuoteTextSearchQueryKind =
  | "exact"
  | "ellipsis-segment"
  | "raw-prefix"
  | "raw-suffix"
  | "raw-middle"
  | "progressive";

export type QuoteTextSearchQuery = {
  query: string;
  kind: QuoteTextSearchQueryKind;
  confidence: "high" | "medium";
};

export type QuoteTextSearchEntry = {
  id: string;
  text: string;
  normalizedText?: string;
  debugLabel?: string;
};

export type QuoteTextSearchMatch = {
  entryId: string;
  query: string;
  normalizedQuery: string;
  matchKind: QuoteTextSearchQueryKind;
  confidence: "high" | "medium";
  totalOccurrences: number;
  matchedEntryIds: string[];
  debugSummary: string[];
};

type NormalizedQuoteTextSearchEntry = {
  id: string;
  normalizedText: string;
  debugLabel: string;
};

export type QuoteTextSearchOptions = {
  minQueryLength?: number;
  maxSameEntryOccurrences?: number;
  rejectWeakQueries?: boolean;
  includeProgressiveQueries?: boolean;
  debugLabel?: string;
};

function normalizeLocatorSourceVariants(value: string): string {
  return value
    .replace(
      /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol)\b/g,
      " ",
    )
    .replace(/\{\s*([A-Za-z])\s*\}\s*\^\s*\{\s*([0-9]+)\s*\}/g, "$1$2")
    .replace(/\b([A-Za-z])\s*\^\s*\{\s*([0-9]+)\s*\}/g, "$1$2")
    .replace(/\b([A-Za-z])\s*\^\s*([0-9]+)\b/g, "$1$2")
    .replace(/\bcrossvalidated\b/gi, "cross validated")
    .replace(/\bcrosssession\b/gi, "cross session")
    .replace(/\bgoodnessof\b/gi, "goodness of");
}

export function normalizeLocatorText(value: string): string {
  return normalizeLocatorSourceVariants(
    sanitizeText(value || "").normalize("NFKC"),
  )
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2")
    .replace(/\bcrossvalidated\b/gi, "cross validated")
    .replace(/\bcrosssession\b/gi, "cross session")
    .replace(/\bgoodnessof\b/gi, "goodness of")
    .replace(/[“”‘’]/g, " ")
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasNonAsciiToken(token: string): boolean {
  return NON_ASCII_PATTERN.test(token);
}

function tokenCharLength(token: string): number {
  return Array.from(token).length;
}

function locatorTokensFromNormalizedText(value: string): string[] {
  return value.match(SEARCH_WORD_PATTERN) || [];
}

export function extractLocatorTokens(value: string): string[] {
  return locatorTokensFromNormalizedText(normalizeLocatorText(value));
}

export function isLocatorQueryLongEnough(
  value: string,
  minQueryLength: number,
): boolean {
  const normalized = normalizeLocatorText(value);
  if (!normalized) return false;
  if (normalized.length >= minQueryLength) return true;
  const tokens = locatorTokensFromNormalizedText(normalized);
  if (!tokens.some(hasNonAsciiToken)) return false;
  const nonAsciiTokenChars = tokens
    .filter(hasNonAsciiToken)
    .reduce((sum, token) => sum + tokenCharLength(token), 0);
  const nonAsciiMinLength = Math.min(
    12,
    Math.max(6, Math.ceil(minQueryLength / 2)),
  );
  return nonAsciiTokenChars >= nonAsciiMinLength;
}

/**
 * Strip leading and trailing ellipsis from a quote while preserving the
 * interior. Returns the trimmed string.
 */
export function stripBoundaryEllipsis(text: string): string {
  return text
    .replace(new RegExp("^\\s*" + ELLIPSIS_RE.source + "\\s*"), "")
    .replace(new RegExp("\\s*" + ELLIPSIS_RE.source + "\\s*$"), "")
    .trim();
}

/**
 * Split a quote at internal ellipsis markers, returning the segments sorted by
 * descending length. Segments shorter than 30 chars are too weak for reliable
 * reader or citation matching.
 */
export function splitQuoteAtEllipsis(text: string): string[] {
  const cleaned = stripBoundaryEllipsis(text);
  if (!ELLIPSIS_RE.test(cleaned)) return [cleaned];
  return cleaned
    .split(ELLIPSIS_RE_G)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30)
    .sort((a, b) => b.length - a.length);
}

export function stripInlineLocatorNoise(value: string): string {
  const cleaned = sanitizeText(value || "");
  return cleaned
    .replace(/\(([^)]{0,160})\)/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    )
    .replace(/\[([^\]]{0,160})\]/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    );
}

export function extractSearchTokens(value: string): string[] {
  return extractLocatorTokens(stripInlineLocatorNoise(value));
}

export function scoreSearchToken(token: string): number {
  if (!token) return Number.NEGATIVE_INFINITY;
  const length = tokenCharLength(token);
  if (
    PLAIN_ASCII_WORD_PATTERN.test(token) &&
    COMMON_SEARCH_STOP_WORDS.has(token)
  ) {
    return 0.5;
  }
  if (NUMERIC_TOKEN_PATTERN.test(token)) return 0.2;
  if (hasNonAsciiToken(token)) return Math.min(16, length * 2);
  if (length <= 2) return 0.2;
  if (length === 3) return 1.5;
  return Math.min(8, length + (/[a-z]/.test(token) ? 1 : 0));
}

export function formatQuoteSearchQuerySnippet(
  query: string,
  maxLength = 72,
): string {
  if (query.length <= maxLength) return query;
  return `${query.slice(0, maxLength - 3)}...`;
}

export function getProgressiveStartOffsets(tokens: string[]): number[] {
  const offsets = [0];
  if (tokens.length > 6 && scoreSearchToken(tokens[0]) < 2) {
    offsets.push(1);
  }
  if (
    tokens.length > 8 &&
    scoreSearchToken(tokens[0]) < 1 &&
    scoreSearchToken(tokens[1]) < 2
  ) {
    offsets.push(2);
  }
  if (tokens.length >= 10) {
    offsets.push(Math.floor(tokens.length / 2));
  }
  if (tokens.length >= 16) {
    offsets.push(Math.floor(tokens.length / 3));
    offsets.push(Math.floor((tokens.length * 2) / 3));
  }
  return Array.from(new Set(offsets));
}

/** Count all overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) break;
    count++;
    cursor = idx + 1;
  }
  return count;
}

function pushUniqueQuery(
  queries: QuoteTextSearchQuery[],
  seen: Set<string>,
  query: string,
  kind: QuoteTextSearchQueryKind,
  confidence: "high" | "medium",
  minQueryLength: number,
): void {
  const normalized = normalizeLocatorText(query);
  if (
    !isLocatorQueryLongEnough(normalized, minQueryLength) ||
    seen.has(normalized)
  )
    return;
  seen.add(normalized);
  queries.push({ query: normalized, kind, confidence });
}

function pushNormalizedWindowQueries(params: {
  queries: QuoteTextSearchQuery[];
  seen: Set<string>;
  normalized: string;
  kind: "raw-prefix" | "raw-suffix" | "raw-middle";
  minQueryLength: number;
}): void {
  const { queries, seen, normalized, kind, minQueryLength } = params;
  for (const len of NORMALIZED_QUERY_LENGTHS) {
    if (normalized.length <= len) continue;
    const query =
      kind === "raw-prefix"
        ? normalized
            .slice(0, len)
            .replace(/\s\S*$/, "")
            .trim()
        : normalized
            .slice(-len)
            .replace(/^\S*\s/, "")
            .trim();
    pushUniqueQuery(
      queries,
      seen,
      query,
      kind,
      len >= 25 ? "high" : "medium",
      minQueryLength,
    );
  }
}

function pushNormalizedMiddleQueries(params: {
  queries: QuoteTextSearchQuery[];
  seen: Set<string>;
  normalized: string;
  minQueryLength: number;
}): void {
  const { queries, seen, normalized, minQueryLength } = params;
  if (normalized.length < 40) return;
  for (const fraction of [1 / 3, 1 / 2]) {
    const midStart = Math.floor(normalized.length * fraction);
    for (const len of [60, 40, 30, 20]) {
      if (midStart + len > normalized.length) continue;
      const query = normalized
        .slice(midStart, midStart + len)
        .replace(/^\S*\s/, "")
        .replace(/\s\S*$/, "")
        .trim();
      pushUniqueQuery(
        queries,
        seen,
        query,
        "raw-middle",
        len >= 30 ? "high" : "medium",
        minQueryLength,
      );
    }
  }
}

export function buildQuoteTextSearchQueries(
  quoteText: string,
  options?: { minQueryLength?: number; includeProgressiveQueries?: boolean },
): QuoteTextSearchQuery[] {
  const minQueryLength = Math.max(1, options?.minQueryLength ?? 10);
  const includeProgressiveQueries = options?.includeProgressiveQueries ?? true;
  const clean = stripBoundaryEllipsis(sanitizeText(quoteText || "").trim());
  const queries: QuoteTextSearchQuery[] = [];
  const seen = new Set<string>();
  const normalized = normalizeLocatorText(clean);
  if (!normalized) return queries;

  pushUniqueQuery(queries, seen, normalized, "exact", "high", minQueryLength);

  const segments = splitQuoteAtEllipsis(clean);
  for (const segment of segments) {
    const normalizedSegment = normalizeLocatorText(segment);
    if (!normalizedSegment || normalizedSegment === normalized) continue;
    pushUniqueQuery(
      queries,
      seen,
      normalizedSegment,
      "ellipsis-segment",
      "high",
      minQueryLength,
    );
    for (const charLen of [120, 80, 50]) {
      if (normalizedSegment.length <= charLen) continue;
      const prefix = normalizedSegment
        .slice(0, charLen)
        .replace(/\s\S*$/, "")
        .trim();
      pushUniqueQuery(
        queries,
        seen,
        prefix,
        "ellipsis-segment",
        "high",
        minQueryLength,
      );
    }
  }

  if (normalized.length <= 200) {
    pushUniqueQuery(
      queries,
      seen,
      normalized,
      "raw-prefix",
      "high",
      minQueryLength,
    );
  }
  pushNormalizedWindowQueries({
    queries,
    seen,
    normalized,
    kind: "raw-prefix",
    minQueryLength,
  });
  pushNormalizedWindowQueries({
    queries,
    seen,
    normalized,
    kind: "raw-suffix",
    minQueryLength,
  });
  pushNormalizedMiddleQueries({ queries, seen, normalized, minQueryLength });

  if (includeProgressiveQueries) {
    const tokens = extractSearchTokens(clean);
    const minTokenQueryLength = tokens.length >= 12 ? 4 : 3;
    const maxTokenQueryLength = Math.min(tokens.length, 14);
    for (const offset of getProgressiveStartOffsets(tokens)) {
      for (
        let queryLength = minTokenQueryLength;
        queryLength <= maxTokenQueryLength &&
        offset + queryLength <= tokens.length;
        queryLength += 1
      ) {
        pushUniqueQuery(
          queries,
          seen,
          tokens.slice(offset, offset + queryLength).join(" "),
          "progressive",
          queryLength >= 6 ? "high" : "medium",
          minQueryLength,
        );
      }
    }
  }

  return queries;
}

/**
 * Build raw-text prefix queries from the original quote, trimmed at word
 * boundaries. These are passed to PDF.js FindController as-is.
 */
export function buildRawPrefixQueries(text: string): string[] {
  const clean = sanitizeText(text || "").trim();
  if (clean.length < 12) return [];
  const queries: string[] = [];
  const pushQuery = (query: string) => {
    const normalizedQuery = sanitizeText(query || "").trim();
    if (normalizedQuery.length < 12 || queries.includes(normalizedQuery))
      return;
    queries.push(normalizedQuery);
  };

  for (const segment of splitQuoteAtEllipsis(clean)) {
    if (segment === clean) continue;
    if (segment.length <= 220) {
      pushQuery(segment);
    }
    for (const charLen of [120, 80, 50]) {
      if (segment.length <= charLen) continue;
      const prefix = segment
        .slice(0, charLen)
        .replace(/\s\S*$/, "")
        .trim();
      pushQuery(prefix);
    }
  }

  const stripped = clean.replace(SEARCH_BOUNDARY_PUNCTUATION_RE, "").trim();
  const bases = Array.from(
    new Set(
      [stripped || clean, stripped === clean ? clean : ""].filter(
        (value) => value.length >= 12,
      ),
    ),
  );

  for (const base of bases) {
    if (base.length <= 220) {
      pushQuery(base);
    }
    for (const charLen of [50, 30, 18]) {
      if (base.length <= charLen) continue;
      const prefix = base
        .slice(0, charLen)
        .replace(/\s\S*$/, "")
        .trim();
      pushQuery(prefix);
    }
    for (const charLen of [50, 30, 18]) {
      if (base.length <= charLen) continue;
      const suffix = base
        .slice(-charLen)
        .replace(/^\S*\s/, "")
        .trim();
      pushQuery(suffix);
    }
  }
  return queries;
}

function normalizeFindControllerQueryText(value: string): string {
  return sanitizeText(value || "")
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(FIND_CONTROLLER_HYPHEN_RE, "-")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFindControllerQueryBoundary(value: string): string {
  return value
    .replace(/^[\s"'`“”‘’([{<.,;:!?-]+/, "")
    .replace(/[\s"'`“”‘’)\]}>.,;:!?-]+$/, "")
    .trim();
}

function pushFindControllerQuery(
  queries: string[],
  seen: Set<string>,
  query: string,
): void {
  const normalizedQuery = stripFindControllerQueryBoundary(
    normalizeFindControllerQueryText(query),
  );
  if (normalizedQuery.length < 12) return;
  if (isWeakQuoteSearchQuery(normalizeLocatorText(normalizedQuery))) return;
  const key = normalizedQuery.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  queries.push(normalizedQuery);
}

function hyphenateLikelyCompoundPairs(query: string): string[] {
  const variants = new Set<string>();
  const words = Array.from(query.matchAll(/\b[A-Za-z0-9]+\b/g));
  for (let index = 0; index < words.length - 1; index += 1) {
    const first = words[index][0];
    const second = words[index + 1][0];
    const firstLower = first.toLowerCase();
    const secondLower = second.toLowerCase();
    const shouldHyphenate =
      FIND_CONTROLLER_COMPOUND_SECOND_WORDS.has(secondLower) ||
      (firstLower === "t" && secondLower === "phate") ||
      (firstLower === "bci" && secondLower === "learning");
    if (!shouldHyphenate) continue;
    const firstEnd = (words[index].index || 0) + first.length;
    const secondStart = words[index + 1].index || 0;
    if (!/^\s+$/.test(query.slice(firstEnd, secondStart))) continue;
    variants.add(`${query.slice(0, firstEnd)}-${query.slice(secondStart)}`);
  }
  return Array.from(variants);
}

function hyphenateAllLikelyCompoundPairs(query: string): string {
  return query
    .replace(/\b([Tt])\s+(PHATE|phate)\b/g, "$1-$2")
    .replace(
      new RegExp(
        `\\b([A-Za-z0-9]+)\\s+(${Array.from(
          FIND_CONTROLLER_COMPOUND_SECOND_WORDS,
        ).join("|")})\\b`,
        "gi",
      ),
      "$1-$2",
    );
}

function pushFindControllerQueryVariants(
  queries: string[],
  seen: Set<string>,
  query: string,
): void {
  const normalized = normalizeFindControllerQueryText(query);
  pushFindControllerQuery(queries, seen, normalized);
  const asciiHyphen = normalized.replace(FIND_CONTROLLER_HYPHEN_RE, "-");
  pushFindControllerQuery(queries, seen, asciiHyphen);
  const spacedHyphen = asciiHyphen.replace(
    /([A-Za-z0-9])-([A-Za-z0-9])/g,
    "$1 $2",
  );
  pushFindControllerQuery(queries, seen, spacedHyphen);
  pushFindControllerQuery(
    queries,
    seen,
    hyphenateAllLikelyCompoundPairs(spacedHyphen),
  );
  for (const variant of hyphenateLikelyCompoundPairs(asciiHyphen)) {
    pushFindControllerQuery(queries, seen, variant);
  }
  for (const variant of hyphenateLikelyCompoundPairs(spacedHyphen)) {
    pushFindControllerQuery(queries, seen, variant);
  }
}

function findControllerTokenSpans(text: string): Array<{
  start: number;
  end: number;
  text: string;
}> {
  return Array.from(text.matchAll(FIND_CONTROLLER_TOKEN_RE)).map((match) => ({
    start: match.index || 0,
    end: (match.index || 0) + match[0].length,
    text: match[0],
  }));
}

function scoreFindControllerWindow(tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    const normalized = normalizeLocatorText(token);
    const parts = normalized.match(SEARCH_WORD_PATTERN) || [];
    for (const part of parts) score += scoreSearchToken(part);
    if (/[-\u2010-\u2015]/.test(token)) score += 4;
  }
  return score;
}

function buildFindControllerWindowQueries(text: string): string[] {
  const clean = stripBoundaryEllipsis(sanitizeText(text || "").trim());
  const spans = findControllerTokenSpans(clean);
  if (spans.length < 4) return [];
  const candidates: Array<{ query: string; score: number; index: number }> = [];
  for (const windowSize of [10, 8, 6, 5, 4]) {
    if (spans.length < windowSize) continue;
    for (let start = 0; start <= spans.length - windowSize; start += 1) {
      const end = start + windowSize - 1;
      const query = stripFindControllerQueryBoundary(
        clean.slice(spans[start].start, spans[end].end),
      );
      if (query.length < 24 || query.length > 140) continue;
      const tokens = spans
        .slice(start, start + windowSize)
        .map((span) => span.text);
      const score =
        scoreFindControllerWindow(tokens) -
        (start === 0 ? 3 : 0) +
        (start > 0 && start < spans.length - windowSize ? 2 : 0);
      candidates.push({ query, score, index: start });
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 16)
    .map((candidate) => candidate.query);
}

function buildFindControllerMiddleQueries(text: string): string[] {
  const clean = stripBoundaryEllipsis(sanitizeText(text || "").trim());
  if (clean.length < 48) return [];
  const queries: string[] = [];
  for (const fraction of [1 / 3, 1 / 2, 2 / 3]) {
    const midStart = Math.floor(clean.length * fraction);
    for (const len of [90, 70, 50, 36]) {
      if (midStart + len > clean.length) continue;
      const query = clean
        .slice(midStart, midStart + len)
        .replace(/^\S*\s/, "")
        .replace(/\s\S*$/, "")
        .trim();
      if (query.length >= 24) queries.push(query);
    }
  }
  return queries;
}

export function buildFindControllerQuoteQueries(
  text: string,
  options?: { maxQueries?: number },
): string[] {
  const maxQueries = Math.max(4, options?.maxQueries ?? 28);
  const queries: string[] = [];
  const seen = new Set<string>();
  const pushGroup = (group: string[]) => {
    for (const query of group) {
      if (queries.length >= maxQueries) return;
      pushFindControllerQueryVariants(queries, seen, query);
      if (queries.length >= maxQueries) return;
    }
  };

  pushGroup(buildRawPrefixQueries(text));
  pushGroup(buildFindControllerMiddleQueries(text));
  pushGroup(buildFindControllerWindowQueries(text));
  return queries.slice(0, maxQueries);
}

function isWeakQuoteSearchQuery(normalizedQuery: string): boolean {
  const tokens = locatorTokensFromNormalizedText(normalizedQuery);
  if (!tokens.length) return true;
  const hasNonAscii = tokens.some(hasNonAsciiToken);
  if (!hasNonAscii && tokens.length < 3) return true;
  const informativeTokens = tokens.filter(
    (token) =>
      tokenCharLength(token) >= 4 &&
      !(
        PLAIN_ASCII_WORD_PATTERN.test(token) &&
        COMMON_SEARCH_STOP_WORDS.has(token)
      ) &&
      !NUMERIC_TOKEN_PATTERN.test(token),
  );
  const score = tokens.reduce((sum, token) => sum + scoreSearchToken(token), 0);
  if (
    !hasNonAscii &&
    informativeTokens.length < 2 &&
    normalizedQuery.length < 36
  )
    return true;
  return score < 9;
}

function normalizeEntries(
  entries: QuoteTextSearchEntry[],
): NormalizedQuoteTextSearchEntry[] {
  return entries
    .map((entry) => ({
      id: String(entry.id || ""),
      normalizedText:
        entry.normalizedText !== undefined
          ? normalizeLocatorText(entry.normalizedText)
          : normalizeLocatorText(entry.text),
      debugLabel: entry.debugLabel || String(entry.id || ""),
    }))
    .filter((entry) => entry.id && entry.normalizedText);
}

export function findUniqueQuoteTextSearchMatch(
  entries: QuoteTextSearchEntry[],
  quoteText: string,
  options?: QuoteTextSearchOptions,
): QuoteTextSearchMatch | null {
  const minQueryLength = Math.max(1, options?.minQueryLength ?? 24);
  const maxSameEntryOccurrences = Math.max(
    1,
    options?.maxSameEntryOccurrences ?? 6,
  );
  const rejectWeakQueries = options?.rejectWeakQueries ?? true;
  const normalizedEntries = normalizeEntries(entries);
  if (!normalizedEntries.length) return null;

  const queries = buildQuoteTextSearchQueries(quoteText, {
    minQueryLength,
    includeProgressiveQueries: options?.includeProgressiveQueries ?? true,
  });
  const debugSummary: string[] = [];
  let bestMatch: QuoteTextSearchMatch | null = null;

  for (const query of queries) {
    const normalizedQuery = normalizeLocatorText(query.query);
    if (!isLocatorQueryLongEnough(normalizedQuery, minQueryLength)) continue;
    if (rejectWeakQueries && isWeakQuoteSearchQuery(normalizedQuery)) {
      debugSummary.push(
        `${options?.debugLabel || "Quote"} ${query.kind} "${formatQuoteSearchQuerySnippet(
          normalizedQuery,
        )}" -> skipped weak query`,
      );
      continue;
    }
    const matchedEntryIds: string[] = [];
    let totalOccurrences = 0;
    for (const entry of normalizedEntries) {
      const occurrences = countOccurrences(
        entry.normalizedText,
        normalizedQuery,
      );
      if (occurrences <= 0) continue;
      matchedEntryIds.push(entry.id);
      totalOccurrences += occurrences;
    }
    debugSummary.push(
      `${options?.debugLabel || "Quote"} ${query.kind} "${formatQuoteSearchQuerySnippet(
        normalizedQuery,
      )}" -> ${matchedEntryIds.length ? matchedEntryIds.join(", ") : "none"} (${totalOccurrences} total)`,
    );
    if (matchedEntryIds.length !== 1) continue;
    if (totalOccurrences === 1) {
      return {
        entryId: matchedEntryIds[0],
        query: query.query,
        normalizedQuery,
        matchKind: query.kind,
        confidence: query.confidence,
        totalOccurrences,
        matchedEntryIds,
        debugSummary,
      };
    }
    if (totalOccurrences > maxSameEntryOccurrences) continue;
    if (
      !bestMatch ||
      normalizedQuery.length > bestMatch.normalizedQuery.length
    ) {
      bestMatch = {
        entryId: matchedEntryIds[0],
        query: query.query,
        normalizedQuery,
        matchKind: query.kind,
        confidence: "medium",
        totalOccurrences,
        matchedEntryIds,
        debugSummary: debugSummary.slice(),
      };
    }
  }

  return bestMatch
    ? {
        ...bestMatch,
        debugSummary,
      }
    : null;
}
