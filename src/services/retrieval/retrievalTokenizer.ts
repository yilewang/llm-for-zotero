import { porterStem } from "./porterStemmer";
import { STOPWORDS } from "./stopwords";

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

/**
 * Maths operators a reader can type but a word tokenizer cannot see: they are
 * symbols, not letters, so `WORD_PATTERN` drops them and a question about
 * "∇π" can never meet a paper that spells the same operator `\nabla`. Mapping
 * both sides onto the operator's LaTeX name is what makes them match.
 *
 * The keys are the post-NFKC lowercase forms, which is why `Δ` appears here as
 * `δ`; U+2206 INCREMENT is a different character that NFKC does not fold, and
 * PDF extraction emits it often. Plain Greek letters (σ, π, ω …) are *not*
 * listed: they are ordinary symbols in prose and keep their own token.
 */
export const MATH_SYMBOL_TOKENS: Record<string, string> = {
  "∇": "nabla",
  "∂": "partial",
  δ: "delta",
  "∆": "delta",
  "∑": "sum",
  "∫": "integral",
  "∞": "infinity",
};

/**
 * LaTeX commands that only style their argument. Their names would otherwise
 * become high-frequency tokens ("mathbf", "quad") that dilute BM25 for every
 * equation-dense chunk. Semantic commands (`\nabla`, `\frac`, `\dot`, …) are
 * deliberately absent: their names are the content.
 */
export const LATEX_FORMATTING_COMMANDS = new Set([
  "mathbf",
  "mathrm",
  "mathcal",
  "mathbb",
  "boldsymbol",
  "operatorname",
  "left",
  "right",
  "quad",
  "qquad",
  "text",
  "textbf",
  "textit",
  "label",
  "tag",
  "begin",
  "end",
  "displaystyle",
]);

/**
 * Plain words the stemmer leaves whole. The tokenizer's own operator names
 * come first; the rest are LaTeX command names a paper's source text keeps as
 * words (`\infty` segments as "infty"). They are notation, not English:
 * stemming would truncate them ("infty" → "infti") or merge them with an
 * unrelated word ("times" → "time", "integral" → "integr", as "integrity").
 */
export const RETRIEVAL_STEM_EXCLUSIONS = new Set([
  ...Object.values(MATH_SYMBOL_TOKENS),
  "infty",
  "times",
  "cdot",
  "cdots",
  "ldots",
  "vdots",
  "ddots",
  "otimes",
  "oplus",
  "odot",
  "wedge",
  "langle",
  "rangle",
  "lfloor",
  "rfloor",
  "lceil",
  "rceil",
  "forall",
  "propto",
  "approx",
  "equiv",
  "simeq",
  "subseteq",
  "supseteq",
  "setminus",
  "emptyset",
  "mapsto",
  "rightarrow",
  "leftarrow",
  "leftrightarrow",
  "argmax",
  "argmin",
  "limsup",
  "liminf",
  "sinh",
  "cosh",
  "tanh",
  "arcsin",
  "arccos",
  "arctan",
  "hbar",
  "frac",
  "sqrt",
  "prod",
  "coprod",
  "oint",
  "iint",
  "overline",
  "underline",
  "widehat",
  "widetilde",
  "alpha",
  "beta",
  "gamma",
  "epsilon",
  "varepsilon",
  "zeta",
  "theta",
  "vartheta",
  "iota",
  "kappa",
  "lambda",
  "sigma",
  "varsigma",
  "upsilon",
  "varphi",
  "varrho",
  "omega",
]);

const MATH_SYMBOL_PATTERN = new RegExp(
  `[${Object.keys(MATH_SYMBOL_TOKENS).join("")}]`,
  "gu",
);

// Longest name first so `\textbf` cannot be consumed as `\text` + "bf".
const LATEX_FORMATTING_PATTERN = new RegExp(
  `\\\\(?:${[...LATEX_FORMATTING_COMMANDS]
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "g",
);

/**
 * Rewrite text so maths reads as words: operators become their LaTeX names,
 * styling commands disappear and leave their argument behind. Tokens are
 * space-padded, so "∇δh" segments as "nabla delta h".
 *
 * Callers pass the *masked* text, the one whose protected compounds have
 * already been lifted out: "δ-opioid" is a name, not an operator, and must keep
 * its compound token.
 */
function applyMathRewrites(text: string): string {
  return text
    .replace(MATH_SYMBOL_PATTERN, (symbol) => ` ${MATH_SYMBOL_TOKENS[symbol]} `)
    .replace(LATEX_FORMATTING_PATTERN, " ");
}

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

const STEM_CACHE_LIMIT = 50_000;
const stemCache = new Map<string, string>();

/**
 * The BM25 / index term of one surface token: its Porter stem for a plain
 * English word (`PLAIN_ASCII_WORD_PATTERN`), the token itself for everything
 * else — protected compounds ("il-6"), digits, Greek, CJK bigrams, and the
 * notation names in `RETRIEVAL_STEM_EXCLUSIONS`. A compound's plain-word
 * parts are separate tokens and are stemmed like any word.
 *
 * Pass surface tokens only: the stemmer is not idempotent ("agreed" →
 * "agre", but "agre" → "agr"), so a stem must never be stemmed again.
 */
export function toRetrievalIndexTerm(token: string): string {
  if (!PLAIN_ASCII_WORD_PATTERN.test(token)) return token;
  if (RETRIEVAL_STEM_EXCLUSIONS.has(token)) return token;
  const cached = stemCache.get(token);
  if (cached !== undefined) return cached;
  const stem = porterStem(token);
  if (stemCache.size >= STEM_CACHE_LIMIT) stemCache.clear();
  stemCache.set(token, stem);
  return stem;
}

/** Surface query terms → their distinct index terms, in first-seen order. */
export function toRetrievalIndexTerms(terms: readonly string[]): string[] {
  return Array.from(new Set(terms.map(toRetrievalIndexTerm)));
}

const SURFACE_WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * The first word of `text` that shares an index term with one of `terms`
 * ("error" in the text for the query term "errors"), as offsets into `text`.
 * Only plain English words take part; a compound or CJK term is found by the
 * caller's own substring search. Offsets index `text.toLowerCase()`, the
 * same convention as the callers' `indexOf` searches.
 */
export function findFirstIndexTermMatch(
  text: string,
  terms: readonly string[],
): { start: number; end: number } | null {
  const wanted = new Set<string>();
  for (const term of terms) {
    const normalized = normalizeRetrievalText(term).trim();
    if (PLAIN_ASCII_WORD_PATTERN.test(normalized))
      wanted.add(toRetrievalIndexTerm(normalized));
  }
  if (!wanted.size || !text) return null;
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(SURFACE_WORD_PATTERN)) {
    const word = match[0];
    if (!PLAIN_ASCII_WORD_PATTERN.test(word)) continue;
    if (wanted.has(toRetrievalIndexTerm(word))) {
      const start = match.index || 0;
      return { start, end: start + word.length };
    }
  }
  return null;
}

export function tokenizeRetrievalText(
  text: string,
  options?: {
    filterStopwords?: boolean;
    fallbackToUnfilteredIfEmpty?: boolean;
    maxTokens?: number;
    /**
     * Emit index terms (`toRetrievalIndexTerm`) instead of surface tokens.
     * On for BM25 term statistics and the library text index only; every
     * caller that shows, matches or compares surface words leaves it off.
     * Stopwords and short tokens are filtered on the surface form first.
     */
    stem?: boolean;
  },
): string[] {
  const normalized = normalizeRetrievalText(text);
  if (!normalized) return [];

  const filterStopwords = options?.filterStopwords !== false;
  const { tokens: protectedTokens, maskedText } =
    collectProtectedTerms(normalized);
  // Rewrite maths only outside the protected compounds, which are already
  // masked out here: "m/h" and "δ-opioid" keep their own tokens.
  const rawTokens = [
    ...protectedTokens,
    ...segmentWordTokens(applyMathRewrites(maskedText)),
    ...collectScriptBigrams(normalized),
  ];
  const filtered = rawTokens.filter((token) =>
    shouldKeepToken(token, { filterStopwords }),
  );
  const surface =
    filtered.length || !options?.fallbackToUnfilteredIfEmpty
      ? filtered
      : rawTokens.filter((token) => token);
  const tokens = options?.stem ? surface.map(toRetrievalIndexTerm) : surface;
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
