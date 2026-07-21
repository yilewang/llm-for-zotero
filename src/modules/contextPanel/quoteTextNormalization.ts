const INVALID_TEXT_CONTROL_CODE_RANGES = [
  [0x00, 0x08],
  [0x0e, 0x1f],
] as const;
const INVALID_TEXT_CONTROL_CODES = new Set([0x0b, 0x0c, 0x7f]);
const STYLE_COMMAND_PATTERN =
  /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol|left|right|quad|qquad|cdot|times)\b|\\[,;!]/g;
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
const SINGLE_LETTER_TOKEN_PATTERN = /^\p{L}$/u;
const NUMERIC_TOKEN_PATTERN = /^\p{N}+$/u;
const ATTACHED_CITATION_TOKEN_PATTERN = /^(\p{L}{6,})(\p{N}{1,3})$/u;
const ATTACHED_CITATION_TAIL_GAP_PATTERN = /^[\s\u0003]*[,;–—−-][\s\u0003]*$/u;
const SEMANTIC_NUMERIC_SUFFIX_WORDS = new Set([
  "channel",
  "condition",
  "equation",
  "figure",
  "group",
  "layer",
  "level",
  "model",
  "phase",
  "session",
  "table",
  "timepoint",
  "trial",
  "type",
  "week",
  "year",
]);
const LINE_BREAK_HYPHEN_GAP_PATTERN = /^[\u00ad\s]*[-‐‑‒–—][\u00ad\s]*$/u;
const SOFT_HYPHEN_GAP_PATTERN = /^[\u00ad\s]+$/u;
const SOURCE_SPAN_LEADING_BOUNDARY_CHARS = "\"'“‘([";
const SOURCE_SPAN_TRAILING_BOUNDARY_PATTERN = /[.,;:!?"'”’)\]}。！？、，；：]/;
const TERMINAL_SENTENCE_PUNCTUATION_PATTERN = /[.!?。！？]/u;
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

function shouldMergeLatexExponent(
  left: QuoteTextToken,
  right: QuoteTextToken,
  sourceText: string,
): boolean {
  if (
    !SINGLE_LETTER_TOKEN_PATTERN.test(left.text) ||
    !NUMERIC_TOKEN_PATTERN.test(right.text)
  ) {
    return false;
  }
  const gap = sourceText.slice(left.sourceEnd, right.sourceStart);
  return gap.includes("^") && /^[\s{}^]*$/.test(gap);
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
        shouldMergeLatexExponent(previous, token, sourceText))
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

export function buildQuoteTextIndex(value: string): QuoteTextIndex {
  const sourceText = typeof value === "string" ? value : "";
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

function expandSourceSpanEnd(sourceText: string, sourceEnd: number): number {
  let cursor = sourceEnd;
  while (
    cursor < sourceText.length &&
    SOURCE_SPAN_TRAILING_BOUNDARY_PATTERN.test(sourceText[cursor])
  ) {
    cursor += 1;
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
  const adjacentEnd = expandSourceSpanEnd(
    params.sourceText,
    params.lastTokenEnd,
  );
  if (!queryRequiresTerminalSentenceBoundary(params.queryIndex)) {
    return adjacentEnd;
  }
  if (
    TERMINAL_SENTENCE_PUNCTUATION_PATTERN.test(
      params.sourceText.slice(params.lastTokenEnd, adjacentEnd),
    )
  ) {
    return adjacentEnd;
  }

  // PDF.js commonly emits a superscript reference range as separate text
  // items between the last prose word and its sentence-final punctuation,
  // for example "spines\u000347,50\u0003–\u000353\u0003.". The displayed
  // quotation normally omits that reference. Preserve the complete literal
  // PDF.js source sentence so FindController can search its native item
  // stream instead of rejecting otherwise exact prose.
  const sourceTail = params.sourceText.slice(params.lastTokenEnd);
  const citationSuffixMatch = sourceTail.match(
    OMITTED_TRAILING_CITATION_SUFFIX_PATTERN,
  );
  if (citationSuffixMatch) {
    const citationText = citationSuffixMatch[2] || "";
    const hasStrongCitationMarker =
      /^[\s]*[[(]/u.test(citationText) || /[,;‐‑‒–—−-]/u.test(citationText);
    if (hasStrongCitationMarker) {
      return params.lastTokenEnd + (citationSuffixMatch[0]?.length || 0);
    }
  }

  // Historical model quotes sometimes omit a trailing in-source locator such
  // as "(Fig. 3B)." while retaining the sentence-final period. Recover the
  // complete literal source sentence only for a recognized locator. Any other
  // missing terminal boundary is incomplete grounding and must fail closed.
  const locatorMatch = params.sourceText
    .slice(params.lastTokenEnd)
    .match(OMITTED_TRAILING_SOURCE_LOCATOR_PATTERN);
  return locatorMatch
    ? params.lastTokenEnd + (locatorMatch[0]?.length || 0)
    : null;
}

export function findCanonicalQuoteSourceSpan(
  index: QuoteTextIndex,
  queryText: string,
): QuoteTextSourceSpan | null {
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
  return (
    (beforeHasLineBreak &&
      (afterHasLineBreak || /^[ \t]/.test(after) || after === "")) ||
    (afterHasLineBreak && !/[ \t]$/.test(before))
  );
}

/**
 * Remove only numeric tokens that are separated from surrounding source text
 * by a line boundary. This must run before callers flatten whitespace; after
 * flattening, manuscript line numbers are indistinguishable from real data.
 */
export function stripLikelyLayoutNumberArtifacts(value: string): string {
  const index = buildQuoteTextIndex(value);
  let cursor = 0;
  let out = "";
  for (let tokenIndex = 0; tokenIndex < index.tokens.length; tokenIndex += 1) {
    if (!isLikelyLayoutNumberToken(index, tokenIndex)) continue;
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

function matchAttachedCitationSuffix(params: {
  sourceIndex: QuoteTextIndex;
  sourceTokenIndex: number;
  queryToken: QuoteTextToken;
}): TokenAlignmentStep | null {
  const sourceTokens = params.sourceIndex.tokens;
  const sourceToken = sourceTokens[params.sourceTokenIndex];
  const attached = sourceToken?.text.match(ATTACHED_CITATION_TOKEN_PATTERN);
  const sourceWord = attached?.[1] || "";
  if (
    !sourceToken ||
    !sourceWord ||
    sourceWord !== params.queryToken.text ||
    SEMANTIC_NUMERIC_SUFFIX_WORDS.has(sourceWord)
  ) {
    return null;
  }

  let lastMatchedSourceIndex = params.sourceTokenIndex;
  let nextSourceIndex = params.sourceTokenIndex + 1;
  while (nextSourceIndex < sourceTokens.length) {
    const nextToken = sourceTokens[nextSourceIndex];
    if (!nextToken || !/^\p{N}{1,3}$/u.test(nextToken.text)) break;
    const previousToken = sourceTokens[nextSourceIndex - 1];
    const gap = params.sourceIndex.sourceText.slice(
      previousToken.sourceEnd,
      nextToken.sourceStart,
    );
    if (!ATTACHED_CITATION_TAIL_GAP_PATTERN.test(gap)) break;
    lastMatchedSourceIndex = nextSourceIndex;
    nextSourceIndex += 1;
  }

  return {
    nextSourceIndex,
    nextQueryIndex: 0,
    lastMatchedSourceIndex,
  };
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

  if (sourceToken.text === queryToken.text) {
    return {
      nextSourceIndex: params.sourceTokenIndex + 1,
      nextQueryIndex: params.queryTokenIndex + 1,
      lastMatchedSourceIndex: params.sourceTokenIndex,
    };
  }

  let sourceText = "";
  let lastMatchedSourceIndex = params.sourceTokenIndex - 1;
  for (
    let sourceCursor = params.sourceTokenIndex;
    sourceCursor < sourceTokens.length &&
    sourceCursor < params.sourceTokenIndex + 32;
    sourceCursor += 1
  ) {
    if (isLikelyLayoutNumberToken(params.sourceIndex, sourceCursor)) continue;
    sourceText += sourceTokens[sourceCursor].text;
    lastMatchedSourceIndex = sourceCursor;
    if (sourceText === queryToken.text) {
      return {
        nextSourceIndex: sourceCursor + 1,
        nextQueryIndex: params.queryTokenIndex + 1,
        lastMatchedSourceIndex,
      };
    }
    if (sourceText.length >= queryToken.text.length) break;
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

  const attachedCitation = matchAttachedCitationSuffix({
    sourceIndex: params.sourceIndex,
    sourceTokenIndex: params.sourceTokenIndex,
    queryToken,
  });
  if (attachedCitation) {
    return {
      ...attachedCitation,
      nextQueryIndex: params.queryTokenIndex + 1,
    };
  }

  return null;
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
  const queryIndex = buildQuoteTextIndex(queryText);
  if (!index.tokens.length || !queryIndex.tokens.length) return [];

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
