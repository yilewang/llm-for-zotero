const INVALID_TEXT_CONTROL_CODE_RANGES = [
  [0x00, 0x08],
  [0x0e, 0x1f],
] as const;
const INVALID_TEXT_CONTROL_CODES = new Set([0x0b, 0x0c, 0x7f]);
const STYLE_COMMAND_PATTERN =
  /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|text|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol|hat|bar|vec|tilde|overline|underline|left|right|quad|qquad|cdot|times|div|le|leq|ge|geq|ne|neq|pm|mp|approx|sim)\b|\\[,;!]/g;
const PRESENTATIONAL_HTML_TAG_PATTERN =
  /<\/?(?:b|em|i|span|strong|sub|sup)\b[^>]*>/gi;
const GREEK_TOKEN_TRANSLITERATIONS: Record<string, string> = {
  α: "alpha",
  β: "beta",
  γ: "gamma",
  δ: "delta",
  ε: "epsilon",
  ϵ: "epsilon",
  ζ: "zeta",
  η: "eta",
  θ: "theta",
  ϑ: "theta",
  ι: "iota",
  κ: "kappa",
  λ: "lambda",
  μ: "mu",
  ν: "nu",
  ξ: "xi",
  ο: "omicron",
  π: "pi",
  ϖ: "pi",
  ρ: "rho",
  ϱ: "rho",
  σ: "sigma",
  ς: "sigma",
  τ: "tau",
  υ: "upsilon",
  φ: "phi",
  ϕ: "phi",
  χ: "chi",
  ψ: "psi",
  ω: "omega",
};
// Keep letters and numbers as separate tokens. PDF.js can concatenate a
// margin line-number item directly with the first word on the line (for
// example, "\n151The net drive"). Splitting the letter/number transition
// preserves offsets while allowing that injected number to be ignored.
const QUOTE_WORD_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|\p{N}+|\p{L}[\p{L}\p{M}\p{N}]*/gu;
const LETTER_TOKEN_PATTERN = /^\p{L}+$/u;
const ATTACHED_CITATION_TOKEN_PATTERN = /^(\p{L}{2,})(\p{N}{1,3})$/u;
const ATTACHED_CITATION_BOUNDARY_PATTERN =
  /^[\s\u0003]*[.,;:!?()[\]{}。！？、，；：]/u;
const MIN_UNCORROBORATED_ATTACHED_CITATION_STEM_LENGTH = 6;
const SEMANTIC_NUMERIC_SUFFIX_WORDS = new Set([
  "area",
  "axis",
  "block",
  "cell",
  "class",
  "day",
  "eq",
  "channel",
  "condition",
  "equation",
  "fig",
  "figure",
  "gene",
  "group",
  "layer",
  "level",
  "model",
  "mouse",
  "neuron",
  "phase",
  "protein",
  "receptor",
  "interleukin",
  "range",
  "ref",
  "refs",
  "sample",
  "session",
  "stage",
  "subject",
  "table",
  "timepoint",
  "trial",
  "type",
  "unit",
  "week",
  "year",
]);
const LINE_BREAK_HYPHEN_GAP_PATTERN = /^[\u00ad\s]*[-‐‑‒–—][\u00ad\s]*$/u;
const SOFT_HYPHEN_GAP_PATTERN = /^[\u00ad\s]+$/u;
const SOURCE_SPAN_LEADING_BOUNDARY_CHARS = "\"'“‘([";
const SOURCE_SPAN_TRAILING_BOUNDARY_PATTERN = /[.,;:!?"'”’)\]}。！？、，；：]/;
const TERMINAL_SENTENCE_PUNCTUATION_PATTERN = /[.!?。！？]/u;
const PDF_ITEM_SEPARATED_TERMINAL_PUNCTUATION_PATTERN =
  /^[\s\u0003]+[.!?。！？]+["'”’]?(?=$|[\s\u0003]|["'“‘([\p{Lu}])/u;
const OMITTED_TRAILING_SOURCE_LOCATOR_PATTERN =
  /^[\s\u0003]*(\((?:(?:supplementary|supp\.?)\s+)?(?:fig(?:ure)?|table|eq(?:uation)?|appendix)\b[^()\n]{0,120}\))[.!?。！？]+["'”’]?/iu;
const OMITTED_TRAILING_CITATION_SUFFIX_PATTERN =
  /^([\s\u0003]*)([[(]?\s*\p{N}{1,3}(?:[\s\u0003]*(?:[,;]|[‐‑‒–—−-])[\s\u0003]*\p{N}{1,3})*\s*[\])]?)([\s\u0003]*[.!?。！？]+["'”’]?)/u;

export type QuoteTextToken = {
  text: string;
  canonicalStart: number;
  canonicalEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

export type QuoteTextSourceSpan = {
  sourceStart: number;
  sourceEnd: number;
  text: string;
};

export type QuoteTextAlignedSourceSpan = QuoteTextSourceSpan & {
  occurrenceIndex: number;
};

export type QuoteTextIndex = {
  sourceText: string;
  canonicalText: string;
  tokens: QuoteTextToken[];
};

type QuoteTextLayoutView = {
  index: QuoteTextIndex;
  /** One original UTF-16 offset for each character in the matching view. */
  sourceOffsets: number[];
};

const quoteTextLayoutViews = new WeakMap<QuoteTextIndex, QuoteTextLayoutView>();

function mapLayoutSpan(
  view: QuoteTextLayoutView,
  start: number,
  end: number,
): { sourceStart: number; sourceEnd: number } {
  return {
    sourceStart: view.sourceOffsets[start],
    sourceEnd: view.sourceOffsets[end - 1] + 1,
  };
}

export type AcademicQuoteTokenKind =
  | "prose"
  | "number"
  | "operator"
  | "math-identifier"
  | "formatting-syntax"
  | "extraction-artifact";

export type AcademicQuoteAlignmentToken = {
  text: string;
  kind: AcademicQuoteTokenKind;
  supported: boolean;
  sourceStart: number;
  sourceEnd: number;
};

export type AcademicQuoteAlignmentAssessment = {
  displayedTokens: AcademicQuoteAlignmentToken[];
  transformations: string[];
  allMeaningfulTokensSupported: boolean;
  hasUnexplainedSemanticHardDifference: boolean;
  extractionSensitive: boolean;
};

function isInvalidTextControlCode(code: number): boolean {
  if (INVALID_TEXT_CONTROL_CODES.has(code)) return true;
  return INVALID_TEXT_CONTROL_CODE_RANGES.some(
    ([start, end]) => code >= start && code <= end,
  );
}

function sanitizeForQuoteScan(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isInvalidTextControlCode(code)) {
      out += " ";
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += " ";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += " ";
      continue;
    }
    out += value[index];
  }
  return out;
}

function maskIgnoredSourceSyntax(value: string): string {
  return value
    .replace(STYLE_COMMAND_PATTERN, (match) => " ".repeat(match.length))
    .replace(PRESENTATIONAL_HTML_TAG_PATTERN, (match) =>
      " ".repeat(match.length),
    );
}

function normalizeQuoteToken(value: string): string {
  return Array.from(value.normalize("NFKC").toLowerCase())
    .map((character) => GREEK_TOKEN_TRANSLITERATIONS[character] || character)
    .join("");
}

function rawTokensFromSource(value: string): QuoteTextToken[] {
  const sourceText = typeof value === "string" ? value : "";
  const scanText = maskIgnoredSourceSyntax(sanitizeForQuoteScan(sourceText));
  return Array.from(scanText.matchAll(QUOTE_WORD_PATTERN)).map((match) => {
    const start = match.index || 0;
    const rawText = match[0] || "";
    return {
      text: normalizeQuoteToken(rawText),
      canonicalStart: 0,
      canonicalEnd: 0,
      sourceStart: start,
      sourceEnd: start + rawText.length,
    };
  });
}

function shouldMergeLineBreakHyphenation(
  left: QuoteTextToken,
  right: QuoteTextToken,
  sourceText: string,
): boolean {
  if (
    !LETTER_TOKEN_PATTERN.test(left.text) ||
    !LETTER_TOKEN_PATTERN.test(right.text)
  ) {
    return false;
  }
  const gap = sourceText.slice(left.sourceEnd, right.sourceStart);
  if (gap.includes("\u00ad") && SOFT_HYPHEN_GAP_PATTERN.test(gap)) {
    return true;
  }
  return (
    (gap.includes("\n") || gap.includes("\u00ad")) &&
    LINE_BREAK_HYPHEN_GAP_PATTERN.test(gap)
  );
}

function shouldMergeLatexScript(
  left: QuoteTextToken,
  right: QuoteTextToken,
  sourceText: string,
): boolean {
  if (
    !/^[\p{L}\p{N}]+$/u.test(left.text) ||
    !/^[\p{L}\p{N}]+$/u.test(right.text)
  ) {
    return false;
  }
  const gap = sourceText.slice(left.sourceEnd, right.sourceStart);
  return /[_^]/.test(gap) && /^[\s{}_^]*$/.test(gap);
}

function mergeSourceTokens(
  tokens: QuoteTextToken[],
  sourceText: string,
): QuoteTextToken[] {
  const merged: QuoteTextToken[] = [];
  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      (shouldMergeLineBreakHyphenation(previous, token, sourceText) ||
        shouldMergeLatexScript(previous, token, sourceText))
    ) {
      merged[merged.length - 1] = {
        text: previous.text + token.text,
        canonicalStart: 0,
        canonicalEnd: 0,
        sourceStart: previous.sourceStart,
        sourceEnd: token.sourceEnd,
      };
      continue;
    }
    merged.push(token);
  }
  return merged;
}

function assignCanonicalOffsets(tokens: QuoteTextToken[]): QuoteTextToken[] {
  let cursor = 0;
  return tokens.map((token, index) => {
    const start = cursor + (index === 0 ? 0 : 1);
    const end = start + token.text.length;
    cursor = end;
    return {
      ...token,
      canonicalStart: start,
      canonicalEnd: end,
    };
  });
}

/** Join PDF text items without inventing whitespace inside words or formulae. */
export function stripPdfTextItemBoundaries(value: string): string {
  return value.replaceAll("\u0003", "");
}

export function buildQuoteTextIndex(value: string): QuoteTextIndex {
  const sourceText = typeof value === "string" ? value : "";
  // PDF item boundaries describe segmentation, not characters in the paper.
  // Every lexical and boundary check uses the same joined view. Keep a map
  // back to the untouched source so navigation still receives its exact span.
  if (sourceText.includes("\u0003")) {
    const characters: string[] = [];
    const sourceOffsets: number[] = [];
    for (let offset = 0; offset < sourceText.length; offset += 1) {
      if (sourceText[offset] === "\u0003") continue;
      characters.push(sourceText[offset]);
      sourceOffsets.push(offset);
    }
    const index = buildQuoteTextIndex(characters.join(""));
    const view = { index, sourceOffsets };
    const mappedIndex = {
      sourceText,
      canonicalText: index.canonicalText,
      tokens: index.tokens.map((token) => ({
        ...token,
        ...mapLayoutSpan(view, token.sourceStart, token.sourceEnd),
      })),
    };
    quoteTextLayoutViews.set(mappedIndex, view);
    return mappedIndex;
  }
  const tokens = assignCanonicalOffsets(
    mergeSourceTokens(rawTokensFromSource(sourceText), sourceText),
  );
  return {
    sourceText,
    canonicalText: tokens.map((token) => token.text).join(" "),
    tokens,
  };
}

export function normalizeQuoteTextCanonical(value: string): string {
  return buildQuoteTextIndex(value).canonicalText;
}

export function extractQuoteTextTokens(value: string): string[] {
  return buildQuoteTextIndex(value).tokens.map((token) => token.text);
}

function isCanonicalMatchBoundary(
  canonicalText: string,
  canonicalStart: number,
  canonicalEnd: number,
): boolean {
  return (
    (canonicalStart <= 0 || canonicalText[canonicalStart - 1] === " ") &&
    (canonicalEnd >= canonicalText.length ||
      canonicalText[canonicalEnd] === " ")
  );
}

export function findCanonicalTextMatchStart(
  canonicalText: string,
  canonicalQuery: string,
): number {
  if (!canonicalText || !canonicalQuery) return -1;
  let cursor = 0;
  while (cursor <= canonicalText.length - canonicalQuery.length) {
    const canonicalStart = canonicalText.indexOf(canonicalQuery, cursor);
    if (canonicalStart < 0) return -1;
    const canonicalEnd = canonicalStart + canonicalQuery.length;
    if (isCanonicalMatchBoundary(canonicalText, canonicalStart, canonicalEnd)) {
      return canonicalStart;
    }
    cursor = canonicalStart + 1;
  }
  return -1;
}

export function countCanonicalTextMatches(
  canonicalText: string,
  canonicalQuery: string,
): number {
  if (!canonicalText || !canonicalQuery) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= canonicalText.length - canonicalQuery.length) {
    const canonicalStart = canonicalText.indexOf(canonicalQuery, cursor);
    if (canonicalStart < 0) break;
    const canonicalEnd = canonicalStart + canonicalQuery.length;
    if (isCanonicalMatchBoundary(canonicalText, canonicalStart, canonicalEnd)) {
      count += 1;
    }
    cursor = canonicalStart + 1;
  }
  return count;
}

function expandSourceSpanStart(
  sourceText: string,
  sourceStart: number,
): number {
  let cursor = sourceStart;
  while (
    cursor > 0 &&
    SOURCE_SPAN_LEADING_BOUNDARY_CHARS.includes(sourceText[cursor - 1])
  ) {
    cursor -= 1;
  }
  return cursor;
}

/**
 * True when `offset` lies inside a `$...$` formula on its line: an odd number
 * of unescaped single dollars precede it. Inline math never spans a line.
 */
function isInsideInlineMathOnLine(sourceText: string, offset: number): boolean {
  const lineStart = sourceText.lastIndexOf("\n", offset - 1) + 1;
  let dollars = 0;
  for (let index = lineStart; index < offset; index += 1) {
    if (sourceText[index] !== "$" || sourceText[index - 1] === "\\") continue;
    if (sourceText[index + 1] === "$") {
      index += 1;
      continue;
    }
    dollars += 1;
  }
  return dollars % 2 === 1;
}

/**
 * MinerU writes a formula's closing syntax with spaces: "^ { 2 }$ .", "5 \\%$",
 * "( x )$". A bounded run of spaces, closing braces/brackets and spacing or
 * percent commands up to the closing dollar belongs to the formula.
 */
const INLINE_MATH_CLOSING_RUN_PATTERN =
  /^(?:[ \t\u0003]|[}\])]|\\[%,;:! ]){1,24}?\$/u;

function expandSourceSpanEnd(sourceText: string, sourceEnd: number): number {
  let cursor = sourceEnd;
  while (cursor < sourceText.length) {
    if (
      SOURCE_SPAN_TRAILING_BOUNDARY_PATTERN.test(sourceText[cursor]) ||
      sourceText[cursor] === "$"
    ) {
      cursor += 1;
      continue;
    }
    const closingSyntax = sourceText
      .slice(cursor)
      .match(/^(?:<\/(?:sup|sub|span|b|em|i|strong)>|\\[)\]])/iu)?.[0];
    if (closingSyntax) {
      cursor += closingSyntax.length;
      continue;
    }
    const mathClosingRun = sourceText
      .slice(cursor, cursor + 32)
      .match(INLINE_MATH_CLOSING_RUN_PATTERN)?.[0];
    // A run of spaces followed by "$" that opens the next formula
    // ("neurons $x$") is not the closing syntax of the current one.
    const opensNextMath =
      /^[ \t\u0003]+\$$/u.test(mathClosingRun || "") &&
      !/^(?:[ \t\u0003]|$)/u.test(
        sourceText.slice(cursor + (mathClosingRun || "").length)[0] || "",
      ) &&
      sourceText[cursor + (mathClosingRun || "").length] !== "\n";
    if (
      mathClosingRun &&
      !opensNextMath &&
      isInsideInlineMathOnLine(sourceText, cursor)
    ) {
      cursor += mathClosingRun.length;
      continue;
    }
    break;
  }
  return cursor;
}

function queryRequiresTerminalSentenceBoundary(
  queryIndex: QuoteTextIndex,
): boolean {
  const lastToken = queryIndex.tokens[queryIndex.tokens.length - 1];
  if (!lastToken) return false;
  return TERMINAL_SENTENCE_PUNCTUATION_PATTERN.test(
    queryIndex.sourceText.slice(lastToken.sourceEnd),
  );
}

function resolveAlignedSourceEnd(params: {
  sourceText: string;
  lastTokenEnd: number;
  queryIndex: QuoteTextIndex;
}): number | null {
  const lastTokenEnd = params.lastTokenEnd;
  const adjacentEnd = expandSourceSpanEnd(params.sourceText, lastTokenEnd);
  if (!queryRequiresTerminalSentenceBoundary(params.queryIndex)) {
    return adjacentEnd;
  }
  if (
    TERMINAL_SENTENCE_PUNCTUATION_PATTERN.test(
      params.sourceText.slice(lastTokenEnd, adjacentEnd),
    )
  ) {
    return adjacentEnd;
  }

  // PDF.js can split a sentence-final period into the following text item,
  // whose next prose then appears as ".We" in the flattened item stream.
  // Accept only the bounded item-boundary form; ordinary fused prose such as
  // "afterward.during" remains an incomplete source match.
  const itemSeparatedTerminal = params.sourceText
    .slice(adjacentEnd)
    .match(PDF_ITEM_SEPARATED_TERMINAL_PUNCTUATION_PATTERN);
  if (itemSeparatedTerminal) {
    return adjacentEnd + (itemSeparatedTerminal[0]?.length || 0);
  }

  // PDF.js commonly emits a superscript reference range as separate text
  // items between the last prose word and its sentence-final punctuation,
  // for example "spines\u000347,50\u0003–\u000353\u0003.". The displayed
  // quotation normally omits that reference. Preserve the complete literal
  // PDF.js source sentence so FindController can search its native item
  // stream instead of rejecting otherwise exact prose.
  const sourceTail = params.sourceText.slice(lastTokenEnd);
  const citationSuffixMatch = sourceTail.match(
    OMITTED_TRAILING_CITATION_SUFFIX_PATTERN,
  );
  if (citationSuffixMatch) {
    const citationText = citationSuffixMatch[2] || "";
    const hasStrongCitationMarker =
      /^[\s]*[[(]/u.test(citationText) || /[,;‐‑‒–—−-]/u.test(citationText);
    if (hasStrongCitationMarker) {
      return lastTokenEnd + (citationSuffixMatch[0]?.length || 0);
    }
  }

  // Historical model quotes sometimes omit a trailing in-source locator such
  // as "(Fig. 3B)." while retaining the sentence-final period. Recover the
  // complete literal source sentence only for a recognized locator. Any other
  // missing terminal boundary is incomplete grounding and must fail closed.
  const locatorMatch = params.sourceText
    .slice(lastTokenEnd)
    .match(OMITTED_TRAILING_SOURCE_LOCATOR_PATTERN);
  return locatorMatch ? lastTokenEnd + (locatorMatch[0]?.length || 0) : null;
}

export function findCanonicalQuoteSourceSpan(
  index: QuoteTextIndex,
  queryText: string,
): QuoteTextSourceSpan | null {
  const view = quoteTextLayoutViews.get(index);
  if (view) {
    const span = findCanonicalQuoteSourceSpan(view.index, queryText);
    if (!span) return null;
    const mapped = mapLayoutSpan(view, span.sourceStart, span.sourceEnd);
    return {
      ...mapped,
      text: index.sourceText.slice(mapped.sourceStart, mapped.sourceEnd),
    };
  }
  const canonicalQuery = normalizeQuoteTextCanonical(queryText);
  if (!index.canonicalText || !canonicalQuery) return null;
  const canonicalStart = findCanonicalTextMatchStart(
    index.canonicalText,
    canonicalQuery,
  );
  if (canonicalStart < 0) return null;
  const canonicalEnd = canonicalStart + canonicalQuery.length;
  const firstToken = index.tokens.find(
    (token) => token.canonicalEnd > canonicalStart,
  );
  const lastToken = [...index.tokens]
    .reverse()
    .find((token) => token.canonicalStart < canonicalEnd);
  if (!firstToken || !lastToken) return null;
  const sourceStart = expandSourceSpanStart(
    index.sourceText,
    firstToken.sourceStart,
  );
  const sourceEnd = expandSourceSpanEnd(index.sourceText, lastToken.sourceEnd);
  return {
    sourceStart,
    sourceEnd,
    text: index.sourceText.slice(sourceStart, sourceEnd),
  };
}

function isLikelyLayoutNumberToken(
  index: QuoteTextIndex,
  tokenIndex: number,
): boolean {
  const token = index.tokens[tokenIndex];
  if (!token || !/^\p{N}{1,4}$/u.test(token.text)) return false;
  const previous = index.tokens[tokenIndex - 1];
  const next = index.tokens[tokenIndex + 1];
  const before = index.sourceText.slice(
    previous?.sourceEnd ?? Math.max(0, token.sourceStart - 2),
    token.sourceStart,
  );
  const after = index.sourceText.slice(
    token.sourceEnd,
    next?.sourceStart ?? Math.min(index.sourceText.length, token.sourceEnd + 2),
  );
  const beforeHasLineBreak = /[\r\n]/.test(before);
  const afterHasLineBreak = /[\r\n]/.test(after);
  if (
    (beforeHasLineBreak &&
      (afterHasLineBreak || /^[ \t]/.test(after) || after === "")) ||
    (afterHasLineBreak && !/[ \t]$/.test(before))
  ) {
    return true;
  }
  return sequentialManuscriptLineNumberTokenIndexes(index).has(tokenIndex);
}

const sequentialManuscriptLineNumberCache = new WeakMap<
  QuoteTextIndex,
  Set<number>
>();

function hasPlainWhitespaceTokenBoundaries(
  index: QuoteTextIndex,
  tokenIndex: number,
): boolean {
  const token = index.tokens[tokenIndex];
  if (!token || !/^\p{N}{2,4}$/u.test(token.text)) return false;
  const previous = index.tokens[tokenIndex - 1];
  const next = index.tokens[tokenIndex + 1];
  const before = index.sourceText.slice(
    previous?.sourceEnd ?? 0,
    token.sourceStart,
  );
  const after = index.sourceText.slice(
    token.sourceEnd,
    next?.sourceStart ?? index.sourceText.length,
  );
  const flattenedLineBoundary = /^[\s\u0003.,;:!?()[\]{}。！？、，；：]+$/u;
  return (
    flattenedLineBoundary.test(before) && flattenedLineBoundary.test(after)
  );
}

function sequentialManuscriptLineNumberTokenIndexes(
  index: QuoteTextIndex,
): Set<number> {
  const cached = sequentialManuscriptLineNumberCache.get(index);
  if (cached) return cached;

  const candidates = index.tokens
    .map((token, tokenIndex) => ({
      tokenIndex,
      value: Number(token.text),
    }))
    .filter(
      (candidate) =>
        Number.isFinite(candidate.value) &&
        hasPlainWhitespaceTokenBoundaries(index, candidate.tokenIndex),
    );
  const byValue = new Map<number, number[]>();
  for (const candidate of candidates) {
    const indexes = byValue.get(candidate.value) || [];
    indexes.push(candidate.tokenIndex);
    byValue.set(candidate.value, indexes);
  }
  const withinTokenDistance = (
    tokenIndex: number,
    candidateValue: number,
    maxDistance = 80,
  ): boolean =>
    (byValue.get(candidateValue) || []).some(
      (candidateIndex) => Math.abs(candidateIndex - tokenIndex) <= maxDistance,
    );
  const out = new Set<number>();
  for (const candidate of candidates) {
    const hasPreviousAndNext =
      withinTokenDistance(candidate.tokenIndex, candidate.value - 1) &&
      withinTokenDistance(candidate.tokenIndex, candidate.value + 1);
    const hasTwoPrevious =
      withinTokenDistance(candidate.tokenIndex, candidate.value - 1) &&
      withinTokenDistance(candidate.tokenIndex, candidate.value - 2);
    const hasTwoNext =
      withinTokenDistance(candidate.tokenIndex, candidate.value + 1) &&
      withinTokenDistance(candidate.tokenIndex, candidate.value + 2);
    if (hasPreviousAndNext || hasTwoPrevious || hasTwoNext) {
      out.add(candidate.tokenIndex);
    }
  }
  sequentialManuscriptLineNumberCache.set(index, out);
  return out;
}

/**
 * Remove only numeric tokens that are separated from surrounding source text
 * by a line boundary. This must run before callers flatten whitespace; after
 * flattening, manuscript line numbers are indistinguishable from real data.
 */
export function stripLikelyLayoutNumberArtifacts(value: string): string {
  const index = buildQuoteTextIndex(value);
  const matchingIndex = quoteTextLayoutViews.get(index)?.index || index;
  let cursor = 0;
  let out = "";
  for (let tokenIndex = 0; tokenIndex < index.tokens.length; tokenIndex += 1) {
    if (!isLikelyLayoutNumberToken(matchingIndex, tokenIndex)) continue;
    const token = index.tokens[tokenIndex];
    out += index.sourceText.slice(cursor, token.sourceStart);
    cursor = token.sourceEnd;
  }
  return out + index.sourceText.slice(cursor);
}

type TokenAlignmentStep = {
  nextSourceIndex: number;
  nextQueryIndex: number;
  lastMatchedSourceIndex: number;
};

export type QuoteTextAlignmentRun = {
  sourceTokenStart: number;
  sourceTokenEnd: number;
  queryTokenStart: number;
  queryTokenEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

const MAX_QUOTE_ALIGNMENT_STATES = 200_000;

type CitationSuffix = {
  sourceWord: string;
  lastCitationTokenIndex: number;
  explicit: boolean;
  terminal: boolean;
};

const citationSuffixCache = new WeakMap<
  QuoteTextIndex,
  Map<number, CitationSuffix | null>
>();
const citationStyleCache = new WeakMap<QuoteTextIndex, boolean>();
const citationMathRangesCache = new WeakMap<
  QuoteTextIndex,
  InlineMathRange[]
>();
const CITATION_NUMBER_GROUP = String.raw`[0-9]{1,3}(?:[\s\u0003]*[,;–—−-][\s\u0003]*[0-9]{1,3})*`;
const CITATION_SUFFIX_PATTERN = new RegExp(
  String.raw`^(?:[ \t\u0003]*<sup\b[^>]*>[ \t]*${CITATION_NUMBER_GROUP}[ \t]*</sup>|[ \t\u0003]*\[${CITATION_NUMBER_GROUP}\]|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|\u0003[ \t]*${CITATION_NUMBER_GROUP}|${CITATION_NUMBER_GROUP})`,
  "iu",
);

function isSemanticNumericStem(word: string): boolean {
  return (
    SEMANTIC_NUMERIC_SUFFIX_WORDS.has(word) ||
    (word.endsWith("s") && SEMANTIC_NUMERIC_SUFFIX_WORDS.has(word.slice(0, -1)))
  );
}

/** Identify citation syntax without deleting any source text or numeric tokens. */
function parseCitationSuffix(
  index: QuoteTextIndex,
  tokenIndex: number,
): CitationSuffix | null {
  let cache = citationSuffixCache.get(index);
  if (!cache) {
    cache = new Map();
    citationSuffixCache.set(index, cache);
  }
  if (cache.has(tokenIndex)) return cache.get(tokenIndex)!;
  const remember = (value: CitationSuffix | null) => {
    cache!.set(tokenIndex, value);
    return value;
  };
  const token = index.tokens[tokenIndex];
  if (!token) return remember(null);
  const attached = token.text.match(ATTACHED_CITATION_TOKEN_PATTERN);
  const sourceWord = attached?.[1] || token.text;
  if (!/^\p{L}{2,}$/u.test(sourceWord)) return remember(null);
  const rawToken = index.sourceText.slice(token.sourceStart, token.sourceEnd);
  const rawDigits = attached ? rawToken.match(/\p{N}+$/u)?.[0] : "";
  if (attached && !rawDigits) return remember(null);
  const markerStart = token.sourceEnd - (rawDigits?.length || 0);
  const marker = index.sourceText
    .slice(markerStart, markerStart + 200)
    .match(CITATION_SUFFIX_PATTERN)?.[0];
  if (!marker) return remember(null);
  // Short unit/symbol powers (cm², ms³, or HTML equivalents) carry meaning.
  // Superscript styling alone does not turn them into references.
  if (
    sourceWord.length <= 3 &&
    /^(?:<sup\b[^>]*>[0-9]<\/sup>|[¹²³⁴⁵⁶⁷⁸⁹⁰])$/iu.test(marker.trim())
  )
    return remember(null);
  // Explicit HTML superscripts after prose also mark references on words
  // such as "cells". The identifier guard applies to flattened numeric
  // suffixes and brackets, where "cell12"/"condition[12]" can name a value.
  if (isSemanticNumericStem(sourceWord) && !/<sup\b/iu.test(marker))
    return remember(null);
  // Check paired math only for a candidate marker and cache it per text index.
  let mathRanges = citationMathRangesCache.get(index);
  if (!mathRanges) {
    mathRanges = collectPairedInlineMathRanges(index.sourceText);
    citationMathRangesCache.set(index, mathRanges);
  }
  if (isInsideInlineMathRange(token.sourceStart, mathRanges))
    return remember(null);
  const explicit = /<sup|\[|[¹²³⁴⁵⁶⁷⁸⁹⁰]|\u0003/iu.test(marker);
  const markerEnd = markerStart + marker.length;
  let lastCitationTokenIndex = tokenIndex;
  while (
    lastCitationTokenIndex + 1 < index.tokens.length &&
    index.tokens[lastCitationTokenIndex + 1].sourceEnd <= markerEnd
  ) {
    lastCitationTokenIndex += 1;
  }
  const next = index.tokens[lastCitationTokenIndex + 1];
  const after = index.sourceText.slice(
    markerEnd,
    next?.sourceStart ?? index.sourceText.length,
  );
  // Never consume part of a decimal, identifier, exponent, or measurement.
  if (
    !/^[\s\u0003.,;:!?"'”’()[\]]*$/u.test(after) ||
    (next && /^\p{N}/u.test(next.text) && !/[.!?]/u.test(after)) ||
    (next && !after && !explicit)
  )
    return remember(null);
  return remember({
    sourceWord,
    lastCitationTokenIndex,
    explicit,
    terminal: ATTACHED_CITATION_BOUNDARY_PATTERN.test(after),
  });
}

function hasCorroboratingCitationStyle(
  index: QuoteTextIndex,
  excludedTokenIndex: number,
): boolean {
  // Citation numbers following punctuation also occur in the PDF worker text.
  let punctuationStyle = citationStyleCache.get(index);
  if (punctuationStyle === undefined) {
    punctuationStyle =
      /[.)][\u0003]*[0-9]{1,3}(?:[,–-][0-9]{1,3})*(?:[\s\u0003]+\p{Lu}|$)/u.test(
        index.sourceText,
      );
    citationStyleCache.set(index, punctuationStyle);
  }
  if (punctuationStyle) return true;
  return index.tokens.some((_token, tokenIndex) => {
    if (tokenIndex === excludedTokenIndex) return false;
    const candidate = parseCitationSuffix(index, tokenIndex);
    return Boolean(
      candidate &&
      (candidate.explicit || candidate.terminal) &&
      Array.from(candidate.sourceWord).length >=
        MIN_UNCORROBORATED_ATTACHED_CITATION_STEM_LENGTH,
    );
  });
}

function matchCitationSuffix(params: {
  sourceIndex: QuoteTextIndex;
  sourceTokenIndex: number;
  queryIndex: QuoteTextIndex;
  queryTokenIndex: number;
  queryToken: QuoteTextToken;
}): TokenAlignmentStep | null {
  const suffix = parseCitationSuffix(
    params.sourceIndex,
    params.sourceTokenIndex,
  );
  if (!suffix || suffix.sourceWord !== params.queryToken.text) return null;
  const nextQuery = params.queryIndex.tokens[params.queryTokenIndex + 1];
  const queryGap = params.queryIndex.sourceText.slice(
    params.queryToken.sourceEnd,
    nextQuery?.sourceStart ?? params.queryIndex.sourceText.length,
  );
  // A displayed number must still match; reference tolerance cannot excuse it.
  if (
    (nextQuery && /^\p{N}/u.test(nextQuery.text)) ||
    /[=+*/^_$<>≤≥]/u.test(queryGap)
  )
    return null;
  if (
    !suffix.explicit &&
    (!suffix.terminal ||
      Array.from(suffix.sourceWord).length <
        MIN_UNCORROBORATED_ATTACHED_CITATION_STEM_LENGTH) &&
    !hasCorroboratingCitationStyle(params.sourceIndex, params.sourceTokenIndex)
  )
    return null;
  return {
    nextSourceIndex: suffix.lastCitationTokenIndex + 1,
    nextQueryIndex: params.queryTokenIndex + 1,
    lastMatchedSourceIndex: suffix.lastCitationTokenIndex,
  };
}

const LOST_LIGATURE_LETTERS = ["ff", "fi", "fl", "ffi", "ffl"];

/** A one-character non-letter gap inside a word, where a ligature glyph was. */
function isLigatureLossGap(gap: string, left: string, right: string): boolean {
  return (
    /^[!"#$%&'*+ \u00a0]$/u.test(gap) &&
    /\p{L}$/u.test(left) &&
    /^\p{L}/u.test(right)
  );
}

function matchTokenAlignmentStep(params: {
  sourceIndex: QuoteTextIndex;
  queryIndex: QuoteTextIndex;
  sourceTokenIndex: number;
  queryTokenIndex: number;
}): TokenAlignmentStep | null {
  const sourceTokens = params.sourceIndex.tokens;
  const queryTokens = params.queryIndex.tokens;
  const sourceToken = sourceTokens[params.sourceTokenIndex];
  const queryToken = queryTokens[params.queryTokenIndex];
  if (!sourceToken || !queryToken) return null;

  // Optional source references are consumed at their preceding prose word.
  // Both full-span verification and partial-evidence collection use this step.
  const citationSuffix = matchCitationSuffix({ ...params, queryToken });
  if (citationSuffix) return citationSuffix;

  if (sourceToken.text === queryToken.text) {
    return {
      nextSourceIndex: params.sourceTokenIndex + 1,
      nextQueryIndex: params.queryTokenIndex + 1,
      lastMatchedSourceIndex: params.sourceTokenIndex,
    };
  }

  // Every way the source fragments so far can spell a prefix of the query
  // word. A lost ligature glyph leaves a one-character gap ("di!erent",
  // 'su"cient', "su cient"); the gap may stand for ff/fi/fl/ffi/ffl only when
  // the letters around it then spell the displayed word exactly.
  // A word-initial ligature leaves its glyph before the word ("!ring").
  const firstSourceStart = sourceToken.sourceStart;
  const sourceBeforeFirst = params.sourceIndex.sourceText.slice(
    Math.max(0, firstSourceStart - 2),
    firstSourceStart,
  );
  let sourceSpellings = /(?:^|\s)!$/u.test(sourceBeforeFirst)
    ? ["", ...LOST_LIGATURE_LETTERS]
    : [""];
  let previousSourceToken: QuoteTextToken | undefined;
  let lastMatchedSourceIndex = params.sourceTokenIndex - 1;
  for (
    let sourceCursor = params.sourceTokenIndex;
    sourceCursor < sourceTokens.length &&
    sourceCursor < params.sourceTokenIndex + 32;
    sourceCursor += 1
  ) {
    if (isLikelyLayoutNumberToken(params.sourceIndex, sourceCursor)) continue;
    const token = sourceTokens[sourceCursor];
    const ligatureGap =
      previousSourceToken !== undefined &&
      isLigatureLossGap(
        params.sourceIndex.sourceText.slice(
          previousSourceToken.sourceEnd,
          token.sourceStart,
        ),
        previousSourceToken.text,
        token.text,
      );
    const nextSpellings: string[] = [];
    for (const spelling of sourceSpellings) {
      nextSpellings.push(spelling + token.text);
      if (!ligatureGap) continue;
      for (const ligature of LOST_LIGATURE_LETTERS) {
        nextSpellings.push(spelling + ligature + token.text);
      }
    }
    sourceSpellings = nextSpellings.filter((spelling) =>
      queryToken.text.startsWith(spelling),
    );
    previousSourceToken = token;
    lastMatchedSourceIndex = sourceCursor;
    if (sourceSpellings.includes(queryToken.text)) {
      return {
        nextSourceIndex: sourceCursor + 1,
        nextQueryIndex: params.queryTokenIndex + 1,
        lastMatchedSourceIndex,
      };
    }
    if (!sourceSpellings.length) break;
  }

  let queryText = "";
  for (
    let queryCursor = params.queryTokenIndex;
    queryCursor < queryTokens.length &&
    queryCursor < params.queryTokenIndex + 32;
    queryCursor += 1
  ) {
    queryText += queryTokens[queryCursor].text;
    if (queryText === sourceToken.text) {
      return {
        nextSourceIndex: params.sourceTokenIndex + 1,
        nextQueryIndex: queryCursor + 1,
        lastMatchedSourceIndex: params.sourceTokenIndex,
      };
    }
    if (queryText.length >= sourceToken.text.length) break;
  }

  return null;
}

function tokensCanStartAlignmentRun(
  sourceToken: QuoteTextToken | undefined,
  queryToken: QuoteTextToken | undefined,
): boolean {
  if (!sourceToken || !queryToken) return false;
  return (
    sourceToken.text === queryToken.text ||
    sourceToken.text.startsWith(queryToken.text) ||
    queryToken.text.startsWith(sourceToken.text)
  );
}

/**
 * True when a source/query pair is too large for the alignment collector's
 * state budget, in which case it returns no runs at all. Callers that need
 * partial support above the budget must use a cheaper collector instead.
 */
export function quoteTextAlignmentBudgetExceeded(
  sourceIndex: QuoteTextIndex,
  queryIndex: QuoteTextIndex,
): boolean {
  const sourceTokenCount = sourceIndex.tokens.length;
  const queryTokenCount = queryIndex.tokens.length;
  return (
    sourceTokenCount > 0 &&
    queryTokenCount > 0 &&
    sourceTokenCount > Math.floor(MAX_QUOTE_ALIGNMENT_STATES / queryTokenCount)
  );
}

/**
 * Collect maximal ordered runs that use the same character-preserving layout
 * fragment rules as complete quote matching. A semantic mismatch ends a run;
 * callers may combine the resulting query-token ranges as partial support,
 * but no mismatch is ever treated as a match.
 */
export function collectQuoteTextAlignmentRunsAllowingLayoutFragments(
  sourceIndex: QuoteTextIndex,
  queryIndex: QuoteTextIndex,
): QuoteTextAlignmentRun[] {
  const sourceView = quoteTextLayoutViews.get(sourceIndex);
  const queryView = quoteTextLayoutViews.get(queryIndex);
  if (sourceView || queryView) {
    return collectQuoteTextAlignmentRunsAllowingLayoutFragments(
      sourceView?.index || sourceIndex,
      queryView?.index || queryIndex,
    ).map((run) =>
      sourceView
        ? {
            ...run,
            ...mapLayoutSpan(sourceView, run.sourceStart, run.sourceEnd),
          }
        : run,
    );
  }
  if (!sourceIndex.tokens.length || !queryIndex.tokens.length) return [];
  const sourceTokenCount = sourceIndex.tokens.length;
  const queryTokenCount = queryIndex.tokens.length;
  if (
    sourceTokenCount > Math.floor(MAX_QUOTE_ALIGNMENT_STATES / queryTokenCount)
  ) {
    return [];
  }

  type AlignmentSuffix = {
    sourceTokenEnd: number;
    queryTokenEnd: number;
    lastMatchedSourceIndex: number | null;
  };
  type AlignmentTransition = {
    stateKey: number;
    lastMatchedSourceIndex: number | null;
  };

  const sourceLayoutTokens = sourceIndex.tokens.map((_token, tokenIndex) =>
    isLikelyLayoutNumberToken(sourceIndex, tokenIndex),
  );
  const queryLayoutTokens = queryIndex.tokens.map((_token, tokenIndex) =>
    isLikelyLayoutNumberToken(queryIndex, tokenIndex),
  );
  const suffixes = new Map<number, AlignmentSuffix>();
  const continuationStates = new Set<number>();
  const stateKeyFor = (sourceTokenIndex: number, queryTokenIndex: number) =>
    sourceTokenIndex * queryTokenCount + queryTokenIndex;

  const resolveSuffix = (
    sourceTokenStart: number,
    queryTokenStart: number,
  ): AlignmentSuffix => {
    let sourceCursor = sourceTokenStart;
    let queryCursor = queryTokenStart;
    const path: AlignmentTransition[] = [];
    let suffix: AlignmentSuffix | undefined;

    while (sourceCursor < sourceTokenCount && queryCursor < queryTokenCount) {
      const stateKey = stateKeyFor(sourceCursor, queryCursor);
      if (path.length) continuationStates.add(stateKey);
      const cached = suffixes.get(stateKey);
      if (cached) {
        suffix = cached;
        break;
      }

      if (
        queryLayoutTokens[queryCursor] &&
        queryIndex.tokens[queryCursor]?.text !==
          sourceIndex.tokens[sourceCursor]?.text
      ) {
        path.push({ stateKey, lastMatchedSourceIndex: null });
        queryCursor += 1;
        continue;
      }
      if (
        sourceLayoutTokens[sourceCursor] &&
        sourceIndex.tokens[sourceCursor]?.text !==
          queryIndex.tokens[queryCursor]?.text
      ) {
        path.push({ stateKey, lastMatchedSourceIndex: null });
        sourceCursor += 1;
        continue;
      }

      const step = matchTokenAlignmentStep({
        sourceIndex,
        queryIndex,
        sourceTokenIndex: sourceCursor,
        queryTokenIndex: queryCursor,
      });
      if (!step) {
        suffix = {
          sourceTokenEnd: sourceCursor,
          queryTokenEnd: queryCursor,
          lastMatchedSourceIndex: null,
        };
        suffixes.set(stateKey, suffix);
        break;
      }
      path.push({
        stateKey,
        lastMatchedSourceIndex: step.lastMatchedSourceIndex,
      });
      sourceCursor = step.nextSourceIndex;
      queryCursor = step.nextQueryIndex;
    }

    suffix ||= {
      sourceTokenEnd: sourceCursor,
      queryTokenEnd: queryCursor,
      lastMatchedSourceIndex: null,
    };
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const transition = path[index];
      suffix = {
        ...suffix,
        lastMatchedSourceIndex:
          suffix.lastMatchedSourceIndex ?? transition.lastMatchedSourceIndex,
      };
      suffixes.set(transition.stateKey, suffix);
    }
    return suffix;
  };

  const candidates: QuoteTextAlignmentRun[] = [];
  for (
    let sourceTokenStart = 0;
    sourceTokenStart < sourceTokenCount;
    sourceTokenStart += 1
  ) {
    if (sourceLayoutTokens[sourceTokenStart]) continue;
    for (
      let queryTokenStart = 0;
      queryTokenStart < queryTokenCount;
      queryTokenStart += 1
    ) {
      if (queryLayoutTokens[queryTokenStart]) continue;
      const stateKey = stateKeyFor(sourceTokenStart, queryTokenStart);
      if (continuationStates.has(stateKey)) continue;
      if (
        !tokensCanStartAlignmentRun(
          sourceIndex.tokens[sourceTokenStart],
          queryIndex.tokens[queryTokenStart],
        )
      ) {
        continue;
      }
      const suffix = resolveSuffix(sourceTokenStart, queryTokenStart);
      if (
        suffix.queryTokenEnd <= queryTokenStart ||
        suffix.lastMatchedSourceIndex === null
      ) {
        continue;
      }
      const firstSourceToken = sourceIndex.tokens[sourceTokenStart];
      const lastSourceToken = sourceIndex.tokens[suffix.lastMatchedSourceIndex];
      candidates.push({
        sourceTokenStart,
        sourceTokenEnd: suffix.sourceTokenEnd,
        queryTokenStart,
        queryTokenEnd: suffix.queryTokenEnd,
        sourceStart: firstSourceToken.sourceStart,
        sourceEnd: lastSourceToken.sourceEnd,
      });
    }
  }

  return candidates;
}

/**
 * Locate complete quote spans while tolerating PDF layout-only line/page
 * numbers. Every semantic query token must still match, in order. Returned
 * text remains the literal source substring so it can be passed directly to
 * PDF.js FindController.
 */
export function findQuoteSourceSpansAllowingLayoutArtifacts(
  index: QuoteTextIndex,
  queryText: string,
): QuoteTextAlignedSourceSpan[] {
  return findQuoteSourceSpansAllowingLayoutArtifactsFromIndex(
    index,
    buildQuoteTextIndex(queryText),
  );
}

/**
 * The displayed text without the one sentence-final mark after its last word,
 * or null when it has none. "…sensory cortex." becomes "…sensory cortex".
 */
function withoutTrailingTerminalMark(
  queryIndex: QuoteTextIndex,
): string | null {
  const lastToken = queryIndex.tokens[queryIndex.tokens.length - 1];
  if (!lastToken) return null;
  const tail = queryIndex.sourceText.slice(lastToken.sourceEnd);
  const strippedTail = tail.replace(/[.!?。！？](?=[^.!?。！？]*$)/u, "");
  if (strippedTail === tail) return null;
  return queryIndex.sourceText.slice(0, lastToken.sourceEnd) + strippedTail;
}

export function findQuoteSourceSpansAllowingLayoutArtifactsFromIndex(
  index: QuoteTextIndex,
  queryIndex: QuoteTextIndex,
): QuoteTextAlignedSourceSpan[] {
  const spans = findStrictQuoteSourceSpansFromIndex(index, queryIndex);
  if (spans.length || !queryRequiresTerminalSentenceBoundary(queryIndex)) {
    return spans;
  }
  // A quote cut at a clause boundary often gets a period the source does not
  // have there ("…sensory cortex." for "…sensory cortex, and …"). Retry once
  // without that one mark. Every word must still match in order, and the
  // source must end a clause there (comma, semicolon, colon, dash or closing
  // bracket): "…increased." never matches "…increased during the trials".
  // Callers see a span text that differs from the displayed quote, so the
  // match is recorded as a normalized span, not an exact one.
  const relaxedQuery = withoutTrailingTerminalMark(queryIndex);
  if (relaxedQuery === null) return spans;
  return findStrictQuoteSourceSpansFromIndex(
    index,
    buildQuoteTextIndex(relaxedQuery),
  )
    .filter(
      (span) =>
        /[,;:)\]]["'”’]?$/u.test(span.text) ||
        /^[\s\u0003]*[—–]/u.test(index.sourceText.slice(span.sourceEnd)),
    )
    .map((span, occurrenceIndex) => ({ ...span, occurrenceIndex }));
}

function findStrictQuoteSourceSpansFromIndex(
  index: QuoteTextIndex,
  queryIndex: QuoteTextIndex,
): QuoteTextAlignedSourceSpan[] {
  const sourceView = quoteTextLayoutViews.get(index);
  const queryView = quoteTextLayoutViews.get(queryIndex);
  if (sourceView || queryView) {
    return findStrictQuoteSourceSpansFromIndex(
      sourceView?.index || index,
      queryView?.index || queryIndex,
    ).map((span) => {
      if (!sourceView) return span;
      const mapped = mapLayoutSpan(
        sourceView,
        span.sourceStart,
        span.sourceEnd,
      );
      return {
        ...span,
        ...mapped,
        text: index.sourceText.slice(mapped.sourceStart, mapped.sourceEnd),
      };
    });
  }
  if (!index.tokens.length || !queryIndex.tokens.length) return [];
  const firstQueryToken = queryIndex.tokens[0];
  const canFilterCandidateStarts = !isLikelyLayoutNumberToken(queryIndex, 0);

  const spans: QuoteTextAlignedSourceSpan[] = [];
  const seen = new Set<string>();
  for (
    let candidateStart = 0;
    candidateStart < index.tokens.length;
    candidateStart += 1
  ) {
    if (
      isLikelyLayoutNumberToken(index, candidateStart) &&
      index.tokens[candidateStart]?.text !== queryIndex.tokens[0]?.text
    ) {
      continue;
    }
    const firstSourceToken = index.tokens[candidateStart];
    if (
      canFilterCandidateStarts &&
      firstSourceToken &&
      firstQueryToken &&
      firstSourceToken.text !== firstQueryToken.text &&
      !firstQueryToken.text.startsWith(firstSourceToken.text) &&
      !firstSourceToken.text.startsWith(firstQueryToken.text)
    ) {
      continue;
    }
    let sourceCursor = candidateStart;
    let queryCursor = 0;
    let lastMatchedSourceIndex = candidateStart - 1;

    while (
      sourceCursor < index.tokens.length &&
      queryCursor < queryIndex.tokens.length
    ) {
      if (
        isLikelyLayoutNumberToken(queryIndex, queryCursor) &&
        queryIndex.tokens[queryCursor]?.text !==
          index.tokens[sourceCursor]?.text
      ) {
        queryCursor += 1;
        continue;
      }
      if (
        isLikelyLayoutNumberToken(index, sourceCursor) &&
        index.tokens[sourceCursor]?.text !==
          queryIndex.tokens[queryCursor]?.text
      ) {
        sourceCursor += 1;
        continue;
      }
      const step = matchTokenAlignmentStep({
        sourceIndex: index,
        queryIndex,
        sourceTokenIndex: sourceCursor,
        queryTokenIndex: queryCursor,
      });
      if (!step) break;
      sourceCursor = step.nextSourceIndex;
      queryCursor = step.nextQueryIndex;
      lastMatchedSourceIndex = step.lastMatchedSourceIndex;
    }

    if (
      queryCursor !== queryIndex.tokens.length ||
      lastMatchedSourceIndex < candidateStart
    ) {
      continue;
    }
    const firstToken = index.tokens[candidateStart];
    const lastToken = index.tokens[lastMatchedSourceIndex];
    const sourceStart = expandSourceSpanStart(
      index.sourceText,
      firstToken.sourceStart,
    );
    const sourceEnd = resolveAlignedSourceEnd({
      sourceText: index.sourceText,
      lastTokenEnd: lastToken.sourceEnd,
      queryIndex,
    });
    if (sourceEnd === null) continue;
    const key = `${sourceStart}:${sourceEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({
      sourceStart,
      sourceEnd,
      text: index.sourceText.slice(sourceStart, sourceEnd),
      occurrenceIndex: spans.length,
    });
  }
  return spans;
}

type InlineMathRange = {
  start: number;
  end: number;
  content: string;
};

const ACADEMIC_MATH_FORMAT_COMMAND_PATTERN =
  /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|text|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol|hat|bar|vec|tilde|overline|underline|left|right|quad|qquad)\b/g;
const ACADEMIC_MATH_OPERATOR_COMMANDS: Record<string, string> = {
  cdot: "*",
  times: "*",
  div: "/",
  le: "<=",
  leq: "<=",
  ge: ">=",
  geq: ">=",
  ne: "!=",
  neq: "!=",
  pm: "+-",
  mp: "-+",
  approx: "~",
  sim: "~",
};
const UNICODE_SUPERSCRIPT_TO_ASCII: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁺": "+",
  "⁻": "-",
};

function collectPairedInlineMathRanges(value: string): InlineMathRange[] {
  const ranges: InlineMathRange[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value.startsWith("\\(", cursor)) {
      const close = value.indexOf("\\)", cursor + 2);
      if (close < 0) return [];
      ranges.push({
        start: cursor,
        end: close + 2,
        content: value.slice(cursor + 2, close),
      });
      cursor = close + 2;
      continue;
    }
    if (value[cursor] === "$" && value[cursor - 1] !== "\\") {
      if (value[cursor + 1] === "$") return [];
      let close = cursor + 1;
      while (close < value.length) {
        if (
          value[close] === "$" &&
          value[close - 1] !== "\\" &&
          value[close + 1] !== "$"
        ) {
          break;
        }
        if (value[close] === "\n") return [];
        close += 1;
      }
      if (close >= value.length) return [];
      ranges.push({
        start: cursor,
        end: close + 1,
        content: value.slice(cursor + 1, close),
      });
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return ranges;
}

function isInsideInlineMathRange(
  sourceStart: number,
  ranges: readonly InlineMathRange[],
): boolean {
  return ranges.some(
    (range) => sourceStart >= range.start && sourceStart < range.end,
  );
}

export function normalizeAcademicMathContent(value: string): string {
  let normalized = Array.from(stripPdfTextItemBoundaries(value))
    .map((character) => UNICODE_SUPERSCRIPT_TO_ASCII[character] || character)
    .join("")
    .normalize("NFKC")
    .toLowerCase()
    .replace(ACADEMIC_MATH_FORMAT_COMMAND_PATTERN, "")
    .replace(/\\([A-Za-z]+)/g, (_match, command: string) => {
      const operator = ACADEMIC_MATH_OPERATOR_COMMANDS[command];
      return operator ?? command;
    })
    .replace(/[≤⩽]/g, "<=")
    .replace(/[≥⩾]/g, ">=")
    .replace(/[≠]/g, "!=")
    .replace(/[×·⋅]/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/[≈∼]/g, "~");
  normalized = Array.from(normalized)
    .map((character) => GREEK_TOKEN_TRANSLITERATIONS[character] || character)
    .join("");
  return normalized.replace(/[\s{}_^]/g, "");
}

function extractAcademicMathOperators(value: string): string[] {
  const normalized = normalizeAcademicMathContent(
    value.replace(
      /(?<=\p{L})[-‐‑‒–—]\s*\n\s*(?:\p{N}{1,4}\s*)?(?=\p{L})/gu,
      "",
    ),
  );
  return Array.from(
    normalized.matchAll(/<=|>=|!=|\+-|-\+|[=+*/<>~()-]/g),
    (match) => match[0],
  );
}

function academicMathAtomSignature(value: string): string[] {
  const normalized = normalizeAcademicMathContent(value).replace(
    /[^\p{L}\p{N}=+*/<>~().!-]/gu,
    "",
  );
  return Array.from(
    normalized.matchAll(/<=|>=|!=|\+-|-\+|[=+*/<>~()-]|[\p{L}\p{N}.]+/gu),
    (match) => match[0],
  );
}

function compareBoundedInlineMathAgainstSource(
  sourceText: string,
  displayedText: string,
  displayedRanges: readonly InlineMathRange[],
): { supported: boolean; hardMismatch: boolean } | null {
  const proseSegments: string[] = [];
  let cursor = 0;
  for (const range of displayedRanges) {
    proseSegments.push(displayedText.slice(cursor, range.start));
    cursor = range.end;
  }
  proseSegments.push(displayedText.slice(cursor));

  const sourceIndex = buildQuoteTextIndex(sourceText);
  const proseSpans = proseSegments.map((segment) => {
    if (!buildQuoteTextIndex(segment).tokens.length) return null;
    const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
      sourceIndex,
      segment,
    );
    return spans.length === 1 ? spans[0] : null;
  });
  let compared = 0;
  let allMatched = true;
  let hardMismatch = false;
  for (let mathIndex = 0; mathIndex < displayedRanges.length; mathIndex += 1) {
    const left = proseSpans[mathIndex];
    const right = proseSpans[mathIndex + 1];
    if (!left || !right || right.sourceStart < left.sourceEnd) continue;
    const sourceGap = sourceText.slice(left.sourceEnd, right.sourceStart);
    const sourceAtoms = academicMathAtomSignature(sourceGap);
    const displayedAtoms = academicMathAtomSignature(
      displayedRanges[mathIndex].content,
    );
    if (!sourceAtoms.length || !displayedAtoms.length) continue;
    compared += 1;
    if (
      sourceAtoms.length === displayedAtoms.length &&
      sourceAtoms.every((atom, index) => atom === displayedAtoms[index])
    ) {
      continue;
    }
    allMatched = false;
    const sourceHasUnrecoverableMathExtraction =
      /[ðÞ�]/u.test(sourceGap) ||
      /\|\s*\\(?:text|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol)\b/u.test(
        sourceGap,
      );
    if (sourceHasUnrecoverableMathExtraction) continue;
    const sourceOperators = extractAcademicMathOperators(sourceGap);
    const displayedOperators = extractAcademicMathOperators(
      displayedRanges[mathIndex].content,
    );
    if (
      sourceOperators.length &&
      displayedOperators.length &&
      (sourceOperators.length !== displayedOperators.length ||
        sourceOperators.some(
          (operator, index) => operator !== displayedOperators[index],
        ))
    ) {
      hardMismatch = true;
      continue;
    }
    const sourceNumbers =
      normalizeAcademicMathContent(sourceGap).match(/\p{N}+(?:\.\p{N}+)?/gu);
    const displayedNumbers = normalizeAcademicMathContent(
      displayedRanges[mathIndex].content,
    ).match(/\p{N}+(?:\.\p{N}+)?/gu);
    if (
      sourceNumbers?.length &&
      displayedNumbers?.length &&
      (sourceNumbers.length !== displayedNumbers.length ||
        sourceNumbers.some(
          (number, index) => number !== displayedNumbers[index],
        ))
    ) {
      hardMismatch = true;
      continue;
    }
    const sourceCompact = sourceAtoms.join("");
    const displayedCompact = displayedAtoms.join("");
    const sourceWithoutOperators = sourceAtoms
      .filter((atom) => !sourceOperators.includes(atom))
      .join("");
    const displayedWithoutOperators = displayedAtoms
      .filter((atom) => !displayedOperators.includes(atom))
      .join("");
    const couldBeDroppedGlyphs =
      sourceCompact.includes(displayedCompact) ||
      displayedCompact.includes(sourceCompact) ||
      (sourceWithoutOperators === displayedWithoutOperators &&
        sourceOperators.length !== displayedOperators.length);
    if (!couldBeDroppedGlyphs) hardMismatch = true;
  }
  if (!compared) return null;
  return {
    supported: compared === displayedRanges.length && allMatched,
    hardMismatch,
  };
}

function academicMathSegmentsAgree(
  sourceText: string,
  displayedText: string,
): { supported: boolean; hardMismatch: boolean } {
  sourceText = stripPdfTextItemBoundaries(sourceText);
  displayedText = stripPdfTextItemBoundaries(displayedText);
  const displayedRanges = collectPairedInlineMathRanges(displayedText);
  if (!displayedRanges.length) {
    return { supported: true, hardMismatch: false };
  }
  const sourceRanges = collectPairedInlineMathRanges(sourceText);
  if (sourceRanges.length === displayedRanges.length && sourceRanges.length) {
    const sourceMath = sourceRanges.map((range) =>
      normalizeAcademicMathContent(range.content),
    );
    const displayedMath = displayedRanges.map((range) =>
      normalizeAcademicMathContent(range.content),
    );
    const supported = sourceMath.every(
      (segment, index) => segment === displayedMath[index],
    );
    return { supported, hardMismatch: !supported };
  }

  const boundedComparison = compareBoundedInlineMathAgainstSource(
    sourceText,
    displayedText,
    displayedRanges,
  );
  if (boundedComparison) return boundedComparison;

  const displayedOperators = displayedRanges.flatMap((range) =>
    extractAcademicMathOperators(range.content),
  );
  if (!displayedOperators.length) {
    return { supported: true, hardMismatch: false };
  }
  const sourceOperators = extractAcademicMathOperators(sourceText);
  if (!sourceOperators.length) {
    return { supported: false, hardMismatch: false };
  }
  const supported =
    sourceOperators.length === displayedOperators.length &&
    sourceOperators.every(
      (operator, index) => operator === displayedOperators[index],
    );
  return {
    supported,
    hardMismatch:
      sourceOperators.length === displayedOperators.length && !supported,
  };
}

function collectAcademicQuoteTransformations(
  sourceText: string,
  displayedText: string,
): string[] {
  const transformations = new Set<string>();
  if (ACADEMIC_MATH_FORMAT_COMMAND_PATTERN.test(displayedText)) {
    transformations.add("latex-presentation");
  }
  ACADEMIC_MATH_FORMAT_COMMAND_PATTERN.lastIndex = 0;
  if (/[_^]\s*\{|[⁰¹²³⁴⁵⁶⁷⁸⁹]/u.test(displayedText)) {
    transformations.add("script-form");
  }
  if (
    /\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|phi|psi|omega)\b/u.test(
      displayedText,
    )
  ) {
    transformations.add("greek-name");
  }
  if (/\\(?:cdot|times|leq?|geq?|neq?)\b|[≤≥≠×·⋅−]/u.test(displayedText)) {
    transformations.add("operator-glyph");
  }
  if (/[ﬀ-ﬆ]/u.test(sourceText) || /[ﬀ-ﬆ]/u.test(displayedText)) {
    transformations.add("ligature");
  }
  if (/\p{L}[‐‑‒–—-]\s*\n\s*(?:\p{N}{1,4}\s*)?\p{L}/u.test(sourceText)) {
    transformations.add("line-wrap-hyphenation");
  }
  if (/\s/u.test(sourceText) || /\s/u.test(displayedText)) {
    transformations.add("whitespace");
  }
  return Array.from(transformations);
}

/**
 * Describe why displayed academic wording does or does not align with one
 * candidate source span. This assessment never authenticates a paraphrase:
 * only bounded extraction and presentation changes can satisfy a token.
 */
export function assessAcademicQuoteAlignment(
  sourceText: string,
  displayedText: string,
): AcademicQuoteAlignmentAssessment {
  const sourceIndex = buildQuoteTextIndex(sourceText);
  const displayedIndex = buildQuoteTextIndex(displayedText);
  const displayedMathRanges = collectPairedInlineMathRanges(displayedText);
  const supportedTokenIndexes = new Set<number>();
  for (const run of collectQuoteTextAlignmentRunsAllowingLayoutFragments(
    sourceIndex,
    displayedIndex,
  )) {
    for (
      let tokenIndex = run.queryTokenStart;
      tokenIndex < run.queryTokenEnd;
      tokenIndex += 1
    ) {
      supportedTokenIndexes.add(tokenIndex);
    }
  }

  const displayedTokens: AcademicQuoteAlignmentToken[] =
    displayedIndex.tokens.map((token, index) => ({
      text: token.text,
      kind: /^\p{N}+$/u.test(token.text)
        ? "number"
        : isInsideInlineMathRange(token.sourceStart, displayedMathRanges)
          ? "math-identifier"
          : "prose",
      supported: supportedTokenIndexes.has(index),
      sourceStart: token.sourceStart,
      sourceEnd: token.sourceEnd,
    }));

  for (const match of displayedText.matchAll(
    /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|text|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol|hat|bar|vec|tilde|overline|underline|left|right|quad|qquad)\b|[{}$]/g,
  )) {
    const sourceStart = match.index || 0;
    displayedTokens.push({
      text: match[0],
      kind: "formatting-syntax",
      supported: true,
      sourceStart,
      sourceEnd: sourceStart + match[0].length,
    });
  }
  for (const match of displayedText.matchAll(/[\u00ad\u0003]/g)) {
    const sourceStart = match.index || 0;
    displayedTokens.push({
      text: match[0],
      kind: "extraction-artifact",
      supported: true,
      sourceStart,
      sourceEnd: sourceStart + match[0].length,
    });
  }

  const mathAgreement = academicMathSegmentsAgree(sourceText, displayedText);
  for (const range of displayedMathRanges) {
    for (const operator of extractAcademicMathOperators(range.content)) {
      displayedTokens.push({
        text: operator,
        kind: "operator",
        supported: mathAgreement.supported,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
    }
  }

  const unsupportedMeaningful = displayedTokens.filter(
    (token) =>
      !token.supported &&
      token.kind !== "formatting-syntax" &&
      token.kind !== "extraction-artifact",
  );
  const sourceHasLikelyOcrFragmentation =
    /[ðÞ]|(?:\b\p{L}\b[ \t]+){2,}\b\p{L}\b/u.test(sourceText);
  const hasHardUnsupportedToken = unsupportedMeaningful.some(
    (token) =>
      !sourceHasLikelyOcrFragmentation &&
      (token.kind === "prose" ||
        (token.kind === "number" &&
          !isInsideInlineMathRange(token.sourceStart, displayedMathRanges))),
  );
  const transformations = collectAcademicQuoteTransformations(
    sourceText,
    displayedText,
  );
  return {
    displayedTokens,
    transformations,
    allMeaningfulTokensSupported: unsupportedMeaningful.length === 0,
    hasUnexplainedSemanticHardDifference:
      hasHardUnsupportedToken || mathAgreement.hardMismatch,
    extractionSensitive:
      displayedMathRanges.length > 0 || transformations.length > 1,
  };
}
