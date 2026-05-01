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

export function tokenizeRetrievalDiversity(text: string): Set<string> {
  return new Set(tokenizeRetrievalText(text, { maxTokens: 256 }));
}
