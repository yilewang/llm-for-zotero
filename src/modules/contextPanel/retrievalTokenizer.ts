import { STOPWORDS } from "./constants";

type SegmenterSegment = {
  segment: string;
  isWordLike?: boolean;
};

type SegmenterLike = {
  segment: (input: string) => Iterable<SegmenterSegment>;
};

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: "word" },
  ) => SegmenterLike;
};

const PROTECTED_TERM_PATTERN =
  /[\p{L}\p{N}]+(?:[-‐‑‒–—_./:+#][\p{L}\p{N}]+)+/gu;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const WORD_LIKE_PATTERN = /[\p{L}\p{N}]/u;
const PROTECTED_SPLIT_PATTERN = /[\p{L}\p{N}]+/gu;
const CJK_PATTERN = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
const KANA_PATTERN = /[\u3040-\u309F\u30A0-\u30FF]/g;
const HANGUL_PATTERN = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g;
const PLAIN_ASCII_WORD_PATTERN = /^[a-z]+$/;
const GREEK_SINGLE_LETTER_PATTERN = /^[\u0370-\u03FF]$/u;

let cachedWordSegmenter: SegmenterLike | null | undefined;

function getWordSegmenter(): SegmenterLike | null {
  if (cachedWordSegmenter !== undefined) return cachedWordSegmenter;
  const segmenterCtor = (Intl as IntlWithSegmenter).Segmenter;
  if (!segmenterCtor) {
    cachedWordSegmenter = null;
    return cachedWordSegmenter;
  }
  try {
    cachedWordSegmenter = new segmenterCtor(undefined, {
      granularity: "word",
    });
  } catch {
    cachedWordSegmenter = null;
  }
  return cachedWordSegmenter;
}

export function normalizeRetrievalText(text: string): string {
  return (text || "").normalize("NFKC").toLowerCase();
}

function isPlainAsciiStopword(token: string): boolean {
  return PLAIN_ASCII_WORD_PATTERN.test(token) && STOPWORDS.has(token);
}

function shouldKeepToken(
  token: string,
  options: { filterStopwords: boolean },
): boolean {
  if (!token) return false;
  if (token.length < 2 && !GREEK_SINGLE_LETTER_PATTERN.test(token)) {
    return false;
  }
  if (options.filterStopwords && isPlainAsciiStopword(token)) return false;
  return true;
}

function collectProtectedTerms(text: string): {
  tokens: string[];
  maskedText: string;
} {
  const tokens: string[] = [];
  let maskedText = "";
  let lastIndex = 0;

  for (const match of text.matchAll(PROTECTED_TERM_PATTERN)) {
    const protectedToken = match[0];
    const start = match.index || 0;
    const end = start + protectedToken.length;

    maskedText += text.slice(lastIndex, start);
    maskedText += " ".repeat(end - start);
    lastIndex = end;

    tokens.push(protectedToken);
    const parts = protectedToken.match(PROTECTED_SPLIT_PATTERN) || [];
    tokens.push(...parts);
  }

  maskedText += text.slice(lastIndex);
  return { tokens, maskedText };
}

function segmentWordTokens(text: string): string[] {
  if (!text) return [];
  const segmenter = getWordSegmenter();
  if (!segmenter) return text.match(WORD_PATTERN) || [];

  const tokens: string[] = [];
  for (const entry of segmenter.segment(text)) {
    if (entry.isWordLike === false) continue;
    const segment = entry.segment.trim();
    if (!segment) continue;
    if (WORD_LIKE_PATTERN.test(segment)) {
      tokens.push(segment);
    }
  }
  return tokens;
}

function buildAdjacentBigrams(chars: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

function collectScriptBigrams(text: string): string[] {
  const cjkChars = text.match(CJK_PATTERN) || [];
  const kanaChars = text.match(KANA_PATTERN) || [];
  const hangulChars = text.match(HANGUL_PATTERN) || [];
  return [
    ...buildAdjacentBigrams(cjkChars),
    ...buildAdjacentBigrams(kanaChars),
    ...buildAdjacentBigrams(hangulChars),
  ];
}

export function tokenizeRetrievalText(
  text: string,
  options?: {
    filterStopwords?: boolean;
    fallbackToUnfilteredIfEmpty?: boolean;
    maxTokens?: number;
  },
): string[] {
  const normalized = normalizeRetrievalText(text);
  if (!normalized) return [];

  const filterStopwords = options?.filterStopwords !== false;
  const { tokens: protectedTokens, maskedText } =
    collectProtectedTerms(normalized);
  const rawTokens = [
    ...protectedTokens,
    ...segmentWordTokens(maskedText),
    ...collectScriptBigrams(normalized),
  ];
  const filtered = rawTokens.filter((token) =>
    shouldKeepToken(token, { filterStopwords }),
  );
  const tokens =
    filtered.length || !options?.fallbackToUnfilteredIfEmpty
      ? filtered
      : rawTokens.filter((token) => token);
  const maxTokens = Number.isFinite(options?.maxTokens)
    ? Math.max(1, Math.floor(options?.maxTokens as number))
    : 0;
  return maxTokens > 0 ? tokens.slice(0, maxTokens) : tokens;
}

export function tokenizeRetrievalQuery(query: string): string[] {
  return Array.from(
    new Set(
      tokenizeRetrievalText(query, {
        fallbackToUnfilteredIfEmpty: true,
      }),
    ),
  );
}

const TERMINAL_PUNCTUATION_PATTERN = /[\s?？!！。．.;；:：,，、]+$/u;
const PROTECTED_TERM_EXACT_PATTERN =
  /^[\p{L}\p{N}]+(?:[-‐‑‒–—_./:+#][\p{L}\p{N}]+)+$/u;
const ASCII_COMPOUND_CORE_PATTERN = /[0-9a-z]+(?:[-‐‑‒–—_./:+#][0-9a-z]+)+/g;

export function stripTerminalPunctuation(text: string): string {
  return (text || "").trim().replace(TERMINAL_PUNCTUATION_PATTERN, "");
}

function countPatternChars(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

export function isCjkDominantText(text: string): boolean {
  const value = text || "";
  const nonSpaceLength = value.replace(/\s+/g, "").length;
  if (!nonSpaceLength) return false;
  const scriptChars =
    countPatternChars(value, CJK_PATTERN) +
    countPatternChars(value, KANA_PATTERN) +
    countPatternChars(value, HANGUL_PATTERN);
  return scriptChars / nonSpaceLength >= 0.3;
}

// Interrogative/deictic and document-scope words that carry no search signal
// when a CJK question is turned into keyword probes ("哪些论文讨论了X" should
// probe for X's terms, not for 哪些/论文).
const CJK_PROBE_STOPWORDS = new Set([
  "这个",
  "那个",
  "这些",
  "那些",
  "哪些",
  "哪个",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "多少",
  "是否",
  "文件夹",
  "文件",
  "论文",
  "文章",
  "これら",
  "それら",
  "どれ",
  "どの",
  "なに",
  "について",
  "とは",
  "論文",
  "어떤",
  "무엇",
  "어느",
  "어떻게",
  "논문",
]);

export function extractCjkKeywordProbes(text: string, maxProbes = 6): string[] {
  const normalized = normalizeRetrievalText(stripTerminalPunctuation(text));
  if (!normalized) return [];
  const { tokens: protectedTokens } = collectProtectedTerms(normalized);
  const probes: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const trimmed = token.trim();
    if (!trimmed || trimmed.length < 2) return;
    if (isPlainAsciiStopword(trimmed)) return;
    if (CJK_PROBE_STOPWORDS.has(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    probes.push(trimmed);
  };
  // Protected compounds (e.g. "gpt-4", "il-6") are the strongest probes; the
  // split parts collected alongside them are too weak to search on their own.
  // In CJK text the protected pattern absorbs adjacent CJK letters
  // ("使用gpt-4的…" matches as one token), so recover the latin/numeric
  // compound core in that case instead of pushing the merged run.
  for (const token of protectedTokens) {
    if (!PROTECTED_TERM_EXACT_PATTERN.test(token)) continue;
    const containsCjkScript =
      countPatternChars(token, CJK_PATTERN) +
        countPatternChars(token, KANA_PATTERN) +
        countPatternChars(token, HANGUL_PATTERN) >
      0;
    if (!containsCjkScript) {
      push(token);
      continue;
    }
    for (const core of token.match(ASCII_COMPOUND_CORE_PATTERN) || []) {
      push(core);
    }
  }
  if (getWordSegmenter()) {
    // Segment the unmasked text: CJK words absorbed into protected spans
    // still need to surface as probes.
    for (const token of segmentWordTokens(normalized)) push(token);
  } else {
    // Without Intl.Segmenter the word fallback lumps a whole CJK run into one
    // giant token; adjacent bigrams are what keep the probes matchable.
    for (const bigram of collectScriptBigrams(normalized)) push(bigram);
  }
  const limit = Number.isFinite(maxProbes)
    ? Math.max(1, Math.floor(maxProbes))
    : 6;
  return probes.slice(0, limit);
}

export function tokenizeRetrievalDiversity(text: string): Set<string> {
  return new Set(tokenizeRetrievalText(text, { maxTokens: 256 }));
}
