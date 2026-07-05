const INVALID_TEXT_CONTROL_CODE_RANGES = [
  [0x00, 0x08],
  [0x0e, 0x1f],
] as const;
const INVALID_TEXT_CONTROL_CODES = new Set([0x0b, 0x0c, 0x7f]);
const STYLE_COMMAND_PATTERN =
  /\\(?:textstyle|displaystyle|scriptstyle|scriptscriptstyle|mathbf|mathrm|mathit|mathsf|mathbb|mathcal|pmb|boldsymbol)\b/g;
const QUOTE_WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const LETTER_TOKEN_PATTERN = /^\p{L}+$/u;
const SINGLE_LETTER_TOKEN_PATTERN = /^\p{L}$/u;
const NUMERIC_TOKEN_PATTERN = /^\p{N}+$/u;
const LINE_BREAK_HYPHEN_GAP_PATTERN = /^[\u00ad\s]*[-‐‑‒–—][\u00ad\s]*$/u;
const SOFT_HYPHEN_GAP_PATTERN = /^[\u00ad\s]+$/u;
const SOURCE_SPAN_LEADING_BOUNDARY_CHARS = "\"'“‘([";
const SOURCE_SPAN_TRAILING_BOUNDARY_PATTERN =
  /[.,;:!?"'”’)\]}。！？、，；：]/;

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
  return value.replace(STYLE_COMMAND_PATTERN, (match) =>
    " ".repeat(match.length),
  );
}

function normalizeQuoteToken(value: string): string {
  return value.normalize("NFKC").toLowerCase();
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
    (canonicalEnd >= canonicalText.length || canonicalText[canonicalEnd] === " ")
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

function expandSourceSpanStart(sourceText: string, sourceStart: number): number {
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
