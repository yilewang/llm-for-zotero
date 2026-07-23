import type {
  PaperContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "../../shared/types";
import { isBodyEvidenceSection } from "../../shared/libraryChatEvidencePolicy";
import { formatPaperSourceLabel } from "./paperAttribution";
import {
  extractLocatorTokens,
  findLargestQuoteTextAnchorMatch,
  findLargestUniqueQuoteTextAnchorMatch,
  normalizeLocatorText,
  splitQuoteAtEllipsisInOrder,
  stripBoundaryEllipsis,
  type QuoteTextAnchorMatch,
} from "./quoteTextSearch";
import {
  buildQuoteTextIndex,
  findCanonicalTextMatchStart,
  findQuoteSourceSpansAllowingLayoutArtifacts,
  normalizeQuoteTextCanonical,
  stripLikelyLayoutNumberArtifacts,
  type QuoteTextIndex,
} from "./quoteTextNormalization";
import { stripLeadingCitationSeparators } from "./citationText";
import {
  isCanonicalSourceCitationLabel,
  isNonSourceCitationLabel,
  normalizeCitationLabelForMatch,
  normalizeWrappedCitationLabel as normalizeCitationLabel,
  parseStandaloneCitationLabel as parseStandaloneSourceCitationLabel,
} from "./citationLabelParser";

export const QUOTE_CITATION_PATTERN = /\[\[quote:([A-Za-z0-9_-]+)\]\]/g;
const BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN =
  /^[ \t]*(?:>[ \t]*)+\[\[quote:([A-Za-z0-9_-]+)\]\][ \t]*$/gm;
const BLOCKQUOTE_WRAPPED_QUOTE_CITATION_LINE_PATTERN =
  /^[ \t]*(?:>[ \t]*)+\[\[quote:([A-Za-z0-9_-]+)\]\][ \t]*$/;
const STRUCTURED_SOURCE_MARKER_PATTERN =
  /\[\[\s*source\s*=\s*([^\]]+?)\s*\]\]/gi;
const BRACKETED_SOURCE_METADATA_PATTERN = /\[\s*source\s*=\s*([^\]]+?)\s*\]/gi;
const FENCED_CODE_PATTERN = /^[ \t]*(```|~~~)/;
const MIN_AUTO_TRUSTED_QUOTE_NORMALIZED_CHARS = 36;
const MIN_AUTO_TRUSTED_QUOTE_TOKENS = 6;
const MIN_AUTO_TRUSTED_NON_ASCII_QUOTE_CHARS = 16;
const MIN_COMPLETE_LAYOUT_ARTIFACT_SUPPORT_COVERAGE = 0.7;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]*\]\([^)\n]+\)/g;
const COMPLETE_TRAILING_SOURCE_LOCATOR_PATTERN =
  /(\((?:(?:supplementary|supp\.?)\s+)?(?:fig(?:ure)?|table|eq(?:uation)?|appendix)\b[^()\n]{0,120}\)[.!?。！？]+["'”’]?)$/iu;

function isInvalidTextControlCode(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}

function stripInvalidTextControlChars(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (isInvalidTextControlCode(char.charCodeAt(0))) {
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripInvalidTextControlChars(value).replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripInvalidTextControlChars(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripQuoteCitationAnchorsFromDisplaySegment(segment: string): string {
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const withoutAnchors = segment.replace(QUOTE_CITATION_PATTERN, "");
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return withoutAnchors
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;:!?。，；：！？])/g, "$1")
        .trimEnd(),
    )
    .join("\n");
}

export function stripQuoteCitationAnchorsFromDisplayText(
  value: unknown,
): string {
  const normalized = normalizeMultilineText(value);
  if (!normalized) return "";
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const hasQuoteAnchor = QUOTE_CITATION_PATTERN.test(normalized);
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  if (!hasQuoteAnchor) return normalized;
  return normalizeMultilineText(
    transformMarkdownOutsideFencedCode(
      normalized,
      stripQuoteCitationAnchorsFromDisplaySegment,
    ),
  );
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
}

function normalizePageHintIndex(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized >= 0 ? normalized : undefined;
}

function normalizeZeroBasedIndex(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized >= 0 ? normalized : undefined;
}

function normalizePageHintLabel(value: unknown): string | undefined {
  return normalizeText(value) || undefined;
}

function normalizeQuoteMatchSource(
  value: unknown,
): QuoteCitation["sourceMatchSource"] | undefined {
  return value === "context-text" || value === "pdf-page-text"
    ? value
    : undefined;
}

function normalizeQuoteChunkKind(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function truncateForPrompt(value: string, maxLength = 360): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function jsonEscape(value: string): string {
  return JSON.stringify(value);
}

function extractSourceMarkerCitationLabel(value: string): string {
  const match =
    value.match(/(?:^|,\s*)source\s*=\s*(\([^)]{1,180}\))/i) ||
    value.match(/^(\([^)]{1,180}\))/);
  return match?.[1] ? normalizeCitationLabel(match[1]) : "";
}

function normalizeLeakedQuoteText(value: string): string {
  let text = normalizeText(value.replace(/^>\s*/, ""));
  text = text.replace(/^["“”]+|["“”]+$/g, "").trim();
  return text;
}

function normalizeQuoteTextForMatch(value: unknown): string {
  return normalizeMultilineText(value).replace(/\s+/g, " ").trim();
}

function normalizeQuoteMetadataText(value: unknown): string {
  const text = normalizeQuoteTextForMatch(value)
    .replace(/^["“”]+|["“”]+$/g, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return text.length >= 12 ? text : "";
}

function collectQuoteMetadataTexts(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const normalized = normalizeQuoteMetadataText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isKnownQuoteMetadataText(
  quoteText: unknown,
  metadataTexts: Iterable<string> | undefined | null,
): boolean {
  const normalized = normalizeQuoteMetadataText(quoteText);
  if (!normalized) return false;
  for (const metadataText of metadataTexts || []) {
    if (metadataText === normalized) return true;
  }
  return false;
}

const URL_TEXT_PATTERN = /\bhttps?:\/\/\S+/gi;
const DOI_TEXT_PATTERN = /\b(?:doi\s*:?\s*)?10\.\d{4,9}\/\S+/gi;
const DOI_DOMAIN_PATTERN = /\bdoi\.org\b/i;
const STANDALONE_SOURCE_LABEL_TEXT_PATTERN =
  /^\(?[\p{L}'’.-]+(?:\s+(?:and|&)\s+[\p{L}'’.-]+|\s+et\s+al\.?)?,?\s+(?:19|20)\d{2}[a-z]?\)?$/iu;
const JOURNAL_LABEL_TEXT_PATTERN =
  /^(?:science|nature|cell|pnas|nejm|lancet|elife|plos\s+one|current\s+biology|journal\s+of\s+neuroscience)$/i;
const PUBLISHER_METADATA_PATTERNS = [
  /^(?:highlights?|in brief|graphical abstract|author summary|summary|keywords?)\b/i,
  /\bfull\s+article\b/i,
  /\bauthor\s+affiliations?\b/i,
  /\barticle\s+information\b/i,
  /\bpublication\s+history\b/i,
  /\bpublished\s+by\b/i,
  /\bpublished\s+online\b/i,
  /\bcopyright\b/i,
  /\ball\s+rights\s+reserved\b/i,
  /\bcreative\s+commons\b/i,
  /\bopen\s+access\b/i,
  /\bsupplementary\s+(?:materials?|information)\b/i,
  /^(?:references?|bibliography)(?:\s+and\s+notes?)?\b/i,
];
const AFFILIATION_OR_ADDRESS_PATTERN =
  /\b(?:department|university|institute|school|faculty|center|centre|college|laborator(?:y|ies)|hospital|clinic|campus)\b/i;
const LOCATION_OR_POSTAL_PATTERN =
  /\b(?:united kingdom|united states|usa|canada|china|japan|germany|france|australia|netherlands|switzerland|italy|spain|cambridge|boston|new york|california|massachusetts|[A-Z]{2}\s*\d[A-Z0-9]?\s*\d[A-Z]{2}|\d{5}(?:-\d{4})?)\b/i;
const CORRESPONDENCE_METADATA_PATTERN =
  /^(?:correspondence|corresponding author|contact)\b|(?:correspondence\s+should\s+be\s+addressed|addressed\s+to|e-?mail|email|@)/i;
const AUTHOR_BYLINE_FRAGMENT_PATTERN =
  /\b[A-Z][\p{L}'’.-]+[0-9*†‡§]*,\s+[A-Z][\p{L}'’.-]+(?:\s+[A-Z]\.?)?/u;
const MULTI_AUTHOR_BYLINE_PATTERN =
  /\b[A-Z][\p{L}'’.-]+(?:[0-9*†‡§]+)?(?:,\s+[A-Z][\p{L}'’.-]+(?:[0-9*†‡§]+)?){2,}/u;

function collectMatchedRanges(
  value: string,
  patterns: RegExp[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(value)) !== null) {
      const matchedText = match[0] || "";
      if (!matchedText) {
        matcher.lastIndex += 1;
        continue;
      }
      ranges.push({
        start: match.index,
        end: match.index + matchedText.length,
      });
    }
  }
  return ranges;
}

function mergedRangeLength(
  ranges: Array<{ start: number; end: number }>,
): number {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let current: { start: number; end: number } | null = null;
  for (const range of sorted) {
    if (!current) {
      current = { ...range };
      continue;
    }
    if (range.start <= current.end) {
      current.end = Math.max(current.end, range.end);
      continue;
    }
    total += current.end - current.start;
    current = { ...range };
  }
  if (current) total += current.end - current.start;
  return total;
}

function hasNonAsciiText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

function isSubstantiveAutoTrustedQuoteText(value: string): boolean {
  const normalized = normalizeLocatorText(value);
  if (!normalized) return false;
  const tokens = extractLocatorTokens(value);
  if (hasNonAsciiText(normalized)) {
    return normalized.length >= MIN_AUTO_TRUSTED_NON_ASCII_QUOTE_CHARS;
  }
  return (
    normalized.length >= MIN_AUTO_TRUSTED_QUOTE_NORMALIZED_CHARS &&
    tokens.length >= MIN_AUTO_TRUSTED_QUOTE_TOKENS
  );
}

export function isQuoteWorthySourceText(
  value: unknown,
  options?: { allowShortQuoteText?: boolean },
): boolean {
  const text = normalizeQuoteTextForMatch(value);
  if (!text) return false;
  const strippedOuter = text.replace(/^["“”]+|["“”]+$/g, "").trim();
  if (!strippedOuter) return false;
  const withoutMarkdownImages = strippedOuter
    .replace(MARKDOWN_IMAGE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    withoutMarkdownImages !== strippedOuter &&
    !isSubstantiveAutoTrustedQuoteText(withoutMarkdownImages)
  ) {
    return false;
  }
  if (STANDALONE_SOURCE_LABEL_TEXT_PATTERN.test(strippedOuter)) return false;
  if (JOURNAL_LABEL_TEXT_PATTERN.test(strippedOuter)) return false;
  if (PUBLISHER_METADATA_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  const commaCount = (strippedOuter.match(/,/g) || []).length;
  if (
    AFFILIATION_OR_ADDRESS_PATTERN.test(strippedOuter) &&
    (LOCATION_OR_POSTAL_PATTERN.test(strippedOuter) || commaCount >= 2)
  ) {
    return false;
  }
  if (CORRESPONDENCE_METADATA_PATTERN.test(strippedOuter)) return false;
  if (
    strippedOuter.length <= 220 &&
    (AUTHOR_BYLINE_FRAGMENT_PATTERN.test(strippedOuter) ||
      MULTI_AUTHOR_BYLINE_PATTERN.test(strippedOuter))
  ) {
    return false;
  }

  const locatorRanges = collectMatchedRanges(text, [
    URL_TEXT_PATTERN,
    DOI_TEXT_PATTERN,
    DOI_DOMAIN_PATTERN,
  ]);
  const hasUrlOrDoi = locatorRanges.length > 0;
  if (!hasUrlOrDoi) {
    return (
      Boolean(options?.allowShortQuoteText) ||
      isSubstantiveAutoTrustedQuoteText(strippedOuter)
    );
  }

  const withoutLocators = text
    .replace(URL_TEXT_PATTERN, " ")
    .replace(DOI_TEXT_PATTERN, " ")
    .replace(DOI_DOMAIN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const locatorChars = mergedRangeLength(locatorRanges);
  if (withoutLocators.length < 80) return false;
  if (
    !options?.allowShortQuoteText &&
    !isSubstantiveAutoTrustedQuoteText(withoutLocators)
  ) {
    return false;
  }
  if (locatorChars > 0 && locatorChars / Math.max(text.length, 1) > 0.35) {
    return false;
  }
  return true;
}

export function isNonSourceQuoteLabel(value: string): boolean {
  return isNonSourceCitationLabel(value);
}

export function isSectionOnlyCitationLabel(value: string): boolean {
  return isNonSourceQuoteLabel(value);
}

export function isCanonicalQuoteSourceLabel(value: string): boolean {
  return isCanonicalSourceCitationLabel(value);
}

function parseStandaloneCitationLabel(value: string): string | null {
  const parsed = parseStandaloneSourceCitationLabel(value);
  if (!parsed) return null;
  const normalized = normalizeText(value);
  return normalized.startsWith("(") && normalized.endsWith(")")
    ? normalizeCitationLabel(normalized)
    : parsed.sourceLabel;
}

function parseCitationOnlyLine(value: string): string | null {
  const standalone = parseStandaloneCitationLabel(value);
  if (standalone) return standalone;
  const parenthetical = extractLeadingParentheticalLabel(value);
  if (
    parenthetical &&
    !parenthetical.remainder &&
    (isNonSourceQuoteLabel(parenthetical.label) ||
      isCanonicalQuoteSourceLabel(parenthetical.label))
  ) {
    return parenthetical.label;
  }
  return null;
}

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]?)+/, "");
}

function isBlockquoteWrappedQuoteCitationLine(line: string): boolean {
  return BLOCKQUOTE_WRAPPED_QUOTE_CITATION_LINE_PATTERN.test(line);
}

function findAdjacentStandaloneQuoteCitation(params: {
  markdownLines: string[];
  followingLineStartIndex: number;
}): { quoteCitationId: string; lineIndex: number } | null {
  let lineIndex = params.followingLineStartIndex;
  while (
    lineIndex < params.markdownLines.length &&
    !params.markdownLines[lineIndex].trim()
  ) {
    lineIndex += 1;
  }
  if (lineIndex >= params.markdownLines.length) return null;
  const line = params.markdownLines[lineIndex];
  const candidate = /^[ \t]*>/.test(line) ? stripBlockquoteMarker(line) : line;
  const match = candidate.match(/^[ \t]*\[\[quote:([A-Za-z0-9_-]+)\]\][ \t]*$/);
  return match?.[1]
    ? {
        quoteCitationId: match[1],
        lineIndex,
      }
    : null;
}

function unwrapBlockquoteWrappedQuoteCitationPlaceholders(
  markdown: string,
): string {
  BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN.lastIndex = 0;
  const unwrapped = markdown.replace(
    BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN,
    (_token, id: string) => `[[quote:${id}]]`,
  );
  BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN.lastIndex = 0;
  return unwrapped;
}

export type StructuredBlockquoteQuoteBinding = {
  quoteCitationId: string;
  quoteText: string;
  citationLabel?: string;
};

export function parseStructuredBlockquoteQuoteBinding(
  quoteLines: string[],
): StructuredBlockquoteQuoteBinding | null {
  const blockText = quoteLines.join("\n");
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const anchors = Array.from(blockText.matchAll(QUOTE_CITATION_PATTERN));
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  if (anchors.length !== 1 || !anchors[0][1]) return null;

  const visibleLines: string[] = [];
  let citationLabel = "";
  for (const line of quoteLines) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    const containsAnchor = QUOTE_CITATION_PATTERN.test(line);
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    if (!containsAnchor) {
      visibleLines.push(line);
      continue;
    }
    const remainder = normalizeMultilineText(
      line.replace(QUOTE_CITATION_PATTERN, ""),
    );
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    if (!remainder) continue;
    const parsedLabel = parseStandaloneCitationLabel(remainder);
    if (parsedLabel) {
      citationLabel = parsedLabel;
    } else {
      visibleLines.push(remainder);
    }
  }

  return {
    quoteCitationId: anchors[0][1],
    quoteText: normalizeMultilineText(visibleLines.join("\n")),
    citationLabel: citationLabel || undefined,
  };
}

function splitTrailingCitationFromQuoteText(value: string): {
  quoteText: string;
  citationLabel: string;
} | null {
  const text = normalizeMultilineText(value);
  const match = text.match(
    /^([\s\S]*?)\s+(\([^()\n]{2,240}\)(?:\s+\[[^\]\n]{1,160}\])?)$/,
  );
  if (!match) return null;
  const citationLabel = parseStandaloneCitationLabel(match[2] || "");
  const quoteText = normalizeMultilineText(match[1] || "");
  if (!citationLabel || !quoteText) return null;
  return { quoteText, citationLabel };
}

type ParsedSourceBackedBlockquoteCandidate = {
  quoteText: string;
  citationLabel?: string;
  citationRemainder?: string;
  consumedFollowingLineIndex?: number;
  trailingCitation?: {
    quoteText: string;
    citationLabel: string;
  };
  hasAmbiguousCitationDecoration: boolean;
};

function hasAmbiguousTrailingCitationDecoration(value: string): boolean {
  const text = normalizeMultilineText(value);
  return /^(?:[\u201c"])[\s\S]*(?:[\u201d"])[ \t]+(?:\([^()\n]{2,240}\)|\[[^\]\n]{2,240}\])$/u.test(
    text,
  );
}

/**
 * Canonicalize the supported source-backed blockquote layouts before quote
 * provenance is evaluated. Presentation-only citation text must never become
 * part of the semantic quote search query.
 */
function parseSourceBackedBlockquoteCandidate(params: {
  quoteLines: string[];
  markdownLines: string[];
  followingLineStartIndex: number;
}): ParsedSourceBackedBlockquoteCandidate {
  const originalQuoteText = normalizeMultilineText(
    params.quoteLines.join("\n"),
  );
  const trailingCitation =
    splitTrailingCitationFromQuoteText(originalQuoteText);
  if (trailingCitation) {
    return {
      quoteText: originalQuoteText,
      trailingCitation,
      hasAmbiguousCitationDecoration: false,
    };
  }

  const trailingLabel = params.quoteLines.length
    ? parseCitationOnlyLine(params.quoteLines[params.quoteLines.length - 1])
    : null;
  if (trailingLabel) {
    const quoteText = normalizeMultilineText(
      params.quoteLines.slice(0, -1).join("\n"),
    );
    if (quoteText) {
      return {
        quoteText,
        citationLabel: trailingLabel,
        hasAmbiguousCitationDecoration: false,
      };
    }
  }

  let cursor = params.followingLineStartIndex;
  while (
    cursor < params.markdownLines.length &&
    !params.markdownLines[cursor].trim()
  ) {
    cursor += 1;
  }
  const standaloneLeadingLabel =
    cursor < params.markdownLines.length
      ? parseCitationOnlyLine(params.markdownLines[cursor])
      : null;
  if (standaloneLeadingLabel) {
    return {
      quoteText: originalQuoteText,
      citationLabel: standaloneLeadingLabel,
      consumedFollowingLineIndex: cursor,
      hasAmbiguousCitationDecoration: false,
    };
  }

  return {
    quoteText: originalQuoteText,
    hasAmbiguousCitationDecoration:
      hasAmbiguousTrailingCitationDecoration(originalQuoteText),
  };
}

/**
 * The display sanitizer may collapse only a citation layout that is already
 * bound to an exact trusted quote. Shape alone is not enough: a following
 * prose line can legitimately begin with citation-shaped text.
 */
function parseSanitizableSourceBackedBlockquoteCandidate(params: {
  quoteLines: string[];
  markdownLines: string[];
  followingLineStartIndex: number;
  quoteCitations: QuoteCitation[] | undefined | null;
}): ParsedSourceBackedBlockquoteCandidate | null {
  const originalQuoteText = normalizeMultilineText(
    params.quoteLines.join("\n"),
  );
  const bindTrustedCandidate = (
    quoteText: string,
    citationLabel: string,
    consumedFollowingLineIndex?: number,
  ): ParsedSourceBackedBlockquoteCandidate | null => {
    if (
      !findMatchingTrustedQuoteCitation({
        quoteText,
        citationLabel,
        quoteCitations: params.quoteCitations,
      })
    ) {
      return null;
    }
    return {
      quoteText,
      citationLabel,
      consumedFollowingLineIndex,
      hasAmbiguousCitationDecoration: false,
    };
  };

  const sameLine = splitTrailingCitationFromQuoteText(originalQuoteText);
  if (sameLine) {
    return bindTrustedCandidate(sameLine.quoteText, sameLine.citationLabel);
  }

  const blockquoteCitation = params.quoteLines.length
    ? parseCitationOnlyLine(params.quoteLines[params.quoteLines.length - 1])
    : null;
  if (blockquoteCitation) {
    const quoteText = normalizeMultilineText(
      params.quoteLines.slice(0, -1).join("\n"),
    );
    const candidate = bindTrustedCandidate(quoteText, blockquoteCitation);
    if (candidate) return candidate;
  }

  let cursor = params.followingLineStartIndex;
  while (
    cursor < params.markdownLines.length &&
    !params.markdownLines[cursor].trim()
  ) {
    cursor += 1;
  }
  const followingCitation =
    cursor < params.markdownLines.length
      ? parseCitationOnlyLine(params.markdownLines[cursor])
      : null;
  return followingCitation
    ? bindTrustedCandidate(originalQuoteText, followingCitation, cursor)
    : null;
}

export function findMatchingTrustedQuoteCitation(input: {
  quoteText: string;
  citationLabel: string;
  quoteCitations: QuoteCitation[] | undefined | null;
}): QuoteCitation | undefined {
  const quoteText = normalizeQuoteTextForMatch(input.quoteText);
  const citationLabel = normalizeCitationLabelForMatch(input.citationLabel);
  if (!quoteText || !citationLabel) return undefined;
  return normalizeQuoteCitations(input.quoteCitations).find((citation) => {
    return (
      normalizeQuoteTextForMatch(citation.quoteText) === quoteText &&
      normalizeCitationLabelForMatch(citation.citationLabel) === citationLabel
    );
  });
}

function replaceInvalidSourceMarkerLine(line: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  const match = pattern.exec(line);
  pattern.lastIndex = 0;
  if (!match) return line;
  const citationLabel = extractSourceMarkerCitationLabel(match[1] || "");
  const rawBefore = line.slice(0, match.index);
  const before = rawBefore.trim();
  const after = line.slice(match.index + match[0].length).trim();
  const beforeLooksLikeQuote =
    /^>\s*/.test(before) ||
    /^["“]/.test(before) ||
    (/^[ \t]{4,}/.test(rawBefore) && /^["“]/.test(before));
  if (citationLabel && before && !after && beforeLooksLikeQuote) {
    const quoteText = normalizeLeakedQuoteText(before);
    if (quoteText) return `> ${quoteText}\n\n${citationLabel}`;
  }
  const replacement = citationLabel || "";
  pattern.lastIndex = 0;
  return line
    .replace(pattern, replacement)
    .replace(/[ \t]{2,}/g, " ")
    .trimEnd();
}

export function sanitizeInvalidStructuredSourceMarkers(
  markdown: string,
): string {
  if (!markdown) return markdown;
  const lines = markdown.split("\n");
  return lines
    .map((line) => {
      let next = replaceInvalidSourceMarkerLine(
        line,
        STRUCTURED_SOURCE_MARKER_PATTERN,
      );
      next = replaceInvalidSourceMarkerLine(
        next,
        BRACKETED_SOURCE_METADATA_PATTERN,
      );
      return next;
    })
    .join("\n");
}

function normalizeSanitizedMarkdown(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n");
}

function replacementForSourceBackedQuote(params: {
  quoteText: string;
  citationLabel: string;
  quoteCitations: QuoteCitation[] | undefined | null;
}): string {
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  if (QUOTE_CITATION_PATTERN.test(params.quoteText)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return params.quoteText;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const trusted = findMatchingTrustedQuoteCitation(params);
  return trusted
    ? `[[quote:${trusted.id}]]`
    : formatPlainSourceBackedQuoteMarkdown(
        params.quoteText,
        params.citationLabel,
      );
}

function formatPlainSourceBackedQuoteMarkdown(
  quoteText: string,
  citationLabel: string,
): string {
  return formatQuoteWithCitationInsideBlockquoteMarkdown(
    quoteText,
    citationLabel,
  );
}

export function sanitizeUntrustedSourceBackedQuoteBlocks(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined | null,
): string {
  if (!markdown) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCED_CODE_PATTERN.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || !/^[ \t]*>/.test(line)) {
      out.push(line);
      continue;
    }

    const blockStart = index;
    const quoteLines: string[] = [];
    if (isBlockquoteWrappedQuoteCitationLine(line)) {
      out.push(line);
      continue;
    }

    while (
      index < lines.length &&
      /^[ \t]*>/.test(lines[index]) &&
      !isBlockquoteWrappedQuoteCitationLine(lines[index])
    ) {
      quoteLines.push(stripBlockquoteMarker(lines[index]));
      index += 1;
    }
    const candidate = parseSanitizableSourceBackedBlockquoteCandidate({
      quoteLines,
      markdownLines: lines,
      followingLineStartIndex: index,
      quoteCitations,
    });
    if (candidate?.citationLabel) {
      const replacement = replacementForSourceBackedQuote({
        quoteText: candidate.quoteText,
        citationLabel: candidate.citationLabel,
        quoteCitations,
      });
      if (replacement) {
        out.push(
          `${replacement}${
            candidate.citationRemainder
              ? `\n\n${candidate.citationRemainder}`
              : ""
          }`,
        );
      }
      index = candidate.consumedFollowingLineIndex ?? index - 1;
      continue;
    }

    out.push(...lines.slice(blockStart, index));
    index -= 1;
  }
  return normalizeSanitizedMarkdown(out.join("\n"));
}

function hashBase36(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 8);
}

export function buildQuoteCitationId(input: {
  quoteText: string;
  citationLabel: string;
  contextItemId?: number;
}): string {
  const key = [
    normalizeText(input.quoteText).toLowerCase(),
    normalizeCitationLabel(input.citationLabel).toLowerCase(),
    normalizePositiveInt(input.contextItemId) || "",
  ].join("\n");
  return `Q_${hashBase36(key)}`;
}

export function buildQuoteCitation(input: {
  quoteText?: unknown;
  displayQuoteText?: unknown;
  citationLabel?: unknown;
  sourceLabel?: unknown;
  metadataTexts?: unknown;
  sourceMatchText?: unknown;
  sourceMatchKind?: unknown;
  sourceMatchSource?: unknown;
  sourceSectionLabel?: unknown;
  sourceChunkKind?: unknown;
  sectionLabel?: unknown;
  chunkKind?: unknown;
  contextItemId?: unknown;
  itemId?: unknown;
  sourceFingerprint?: unknown;
  sourceMatchPageOccurrence?: unknown;
  pageHintIndex?: unknown;
  pageHintLabel?: unknown;
  id?: unknown;
  allowShortQuoteText?: unknown;
}): QuoteCitation | undefined {
  const quoteText = normalizeMultilineText(input.quoteText);
  const citationLabel = normalizeCitationLabel(
    input.sourceLabel || input.citationLabel,
  );
  const sourceMatchKind = normalizeText(input.sourceMatchKind);
  const sourceMatchSource = normalizeQuoteMatchSource(input.sourceMatchSource);
  const sourceMatchText = normalizeText(input.sourceMatchText);
  const hasAuthoritativePdfPage =
    sourceMatchSource === "pdf-page-text" &&
    normalizePageHintIndex(input.pageHintIndex) !== undefined;
  const allowsShortQuoteText =
    Boolean(input.allowShortQuoteText) ||
    sourceMatchKind === "selected-text" ||
    (hasAuthoritativePdfPage &&
      ["exact", "normalized-span", "trusted"].includes(sourceMatchKind)) ||
    (!sourceMatchKind && !sourceMatchSource);
  const allowsVerifiedSourceText =
    hasAuthoritativePdfPage &&
    Boolean(sourceMatchText) &&
    [
      "exact",
      "ellipsis-segment",
      "raw-prefix",
      "raw-suffix",
      "raw-middle",
      "progressive",
      "normalized-span",
      "trusted",
    ].includes(sourceMatchKind) &&
    isSubstantiveAutoTrustedQuoteText(sourceMatchText) &&
    collectMatchedRanges(quoteText, [
      URL_TEXT_PATTERN,
      DOI_TEXT_PATTERN,
      DOI_DOMAIN_PATTERN,
    ]).length === 0;
  if (
    !quoteText ||
    !citationLabel ||
    (!allowsVerifiedSourceText &&
      !isQuoteWorthySourceText(quoteText, {
        allowShortQuoteText: allowsShortQuoteText,
      })) ||
    isKnownQuoteMetadataText(
      quoteText,
      collectQuoteMetadataTexts(input.metadataTexts),
    ) ||
    !isCanonicalQuoteSourceLabel(citationLabel)
  ) {
    return undefined;
  }
  const contextItemId = normalizePositiveInt(input.contextItemId);
  const itemId = normalizePositiveInt(input.itemId);
  const id = normalizeText(input.id).replace(/[^A-Za-z0-9_-]/g, "");
  const displayQuoteText = stripQuoteCitationAnchorsFromDisplayText(
    input.displayQuoteText,
  );
  const sourceSectionLabel = normalizeText(
    input.sourceSectionLabel || input.sectionLabel,
  );
  const sourceChunkKind = normalizeText(
    input.sourceChunkKind || input.chunkKind,
  );
  const sourceFingerprint = normalizeText(input.sourceFingerprint);
  const sourceMatchPageOccurrence = normalizeZeroBasedIndex(
    input.sourceMatchPageOccurrence,
  );
  const pageHintIndex = normalizePageHintIndex(input.pageHintIndex);
  const pageHintLabel = normalizePageHintLabel(input.pageHintLabel);
  const normalizedSourceMatchKind = [
    "trusted",
    "exact",
    "ellipsis-segment",
    "raw-prefix",
    "raw-suffix",
    "raw-middle",
    "progressive",
    "selected-text",
    "normalized-span",
  ].includes(sourceMatchKind)
    ? (sourceMatchKind as QuoteCitation["sourceMatchKind"])
    : undefined;
  return {
    id:
      id ||
      buildQuoteCitationId({
        quoteText,
        citationLabel,
        contextItemId,
      }),
    quoteText,
    displayQuoteText:
      displayQuoteText && displayQuoteText !== quoteText
        ? displayQuoteText
        : undefined,
    citationLabel,
    sourceMatchText: sourceMatchText || undefined,
    sourceMatchKind: normalizedSourceMatchKind,
    sourceMatchSource,
    sourceSectionLabel: sourceSectionLabel || undefined,
    sourceChunkKind: sourceChunkKind || undefined,
    contextItemId,
    itemId,
    sourceFingerprint: sourceFingerprint || undefined,
    sourceMatchPageOccurrence,
    pageHintIndex,
    pageHintLabel,
  };
}

export function normalizeQuoteCitations(value: unknown): QuoteCitation[] {
  const raw = Array.isArray(value) ? value : [];
  const out: QuoteCitation[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const citation = buildQuoteCitation(entry as Record<string, unknown>);
    if (!citation || seen.has(citation.id)) continue;
    seen.add(citation.id);
    out.push(citation);
  }
  return out;
}

function normalizeDisplayedQuoteForExactBinding(value: unknown): {
  displayText: string;
  quoteText: string;
} | null {
  const displayText = stripQuoteCitationAnchorsFromDisplayText(value);
  const quoteText = stripBoundaryEllipsis(
    stripOuterQuoteDelimiters(displayText),
  ).trim();
  if (!quoteText) return null;
  if (splitQuoteAtEllipsisInOrder(quoteText).length > 1) return null;
  return { displayText, quoteText };
}

/**
 * Keep the model-visible wording after it has been completely source-verified.
 * The only source-only text copied into the stored quote is a proven trailing
 * locator that the model omitted, such as "(Fig. 3B).".
 *
 * PDF punctuation, ligatures, and hyphenation are reconstructed later from
 * the live PDF.js page, so replacing the displayed typography here would
 * violate the quote-text contract without improving navigation.
 */
function buildCompleteDisplayedSourceQuoteText(
  displayedQuoteText: string,
  matchedSourceText: string,
): string {
  const displayed = normalizeMultilineText(
    stripLikelyLayoutNumberArtifacts(displayedQuoteText),
  );
  const source = normalizeMultilineText(
    stripLikelyLayoutNumberArtifacts(matchedSourceText),
  );
  if (!displayed || !source) return "";

  const locatorMatch = source.match(COMPLETE_TRAILING_SOURCE_LOCATOR_PATTERN);
  const locatorText = locatorMatch?.[1] || "";
  if (!locatorText || locatorMatch?.index === undefined) {
    if (/[.,;:!?。！？、，；：]["'”’]?$/u.test(displayed)) {
      return displayed;
    }
    const punctuationMatch = source.match(/([.,;:!?。！？、，；：]+["'”’]?)$/u);
    if (!punctuationMatch || punctuationMatch.index === undefined) {
      return displayed;
    }
    const sourceStem = source.slice(0, punctuationMatch.index).trimEnd();
    if (
      normalizeQuoteTextCanonical(displayed) !==
      normalizeQuoteTextCanonical(sourceStem)
    ) {
      return displayed;
    }
    return `${displayed}${punctuationMatch[1]}`;
  }

  const displayedCanonical = normalizeQuoteTextCanonical(displayed);
  const locatorCanonical = normalizeQuoteTextCanonical(locatorText);
  if (locatorCanonical && displayedCanonical.endsWith(locatorCanonical)) {
    return displayed;
  }

  const sourceStem = source.slice(0, locatorMatch.index).trimEnd();
  const displayedStem = displayed
    .replace(/[.!?。！？]+["'”’]?$/u, "")
    .trimEnd();
  if (
    !displayedStem ||
    normalizeQuoteTextCanonical(displayedStem) !==
      normalizeQuoteTextCanonical(sourceStem)
  ) {
    return displayed;
  }
  return `${displayedStem} ${locatorText}`.trim();
}

const MAX_LAZY_QUOTE_REPAIR_CACHE_ENTRIES = 1000;
const lazyQuoteRepairCache = new Map<string, QuoteCitation>();

function buildLazyQuoteRepairCacheKey(
  citation: QuoteCitation,
  displayedQuoteText: string,
): string {
  const value = [
    citation.sourceFingerprint ||
      `attachment-${citation.contextItemId || citation.itemId || "unknown"}`,
    citation.pageHintIndex ?? "",
    citation.id,
    normalizeQuoteTextForMatch(displayedQuoteText),
  ].join("\u241f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `quote-repair-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function rememberLazyQuoteRepair(key: string, citation: QuoteCitation): void {
  lazyQuoteRepairCache.delete(key);
  lazyQuoteRepairCache.set(key, citation);
  while (lazyQuoteRepairCache.size > MAX_LAZY_QUOTE_REPAIR_CACHE_ENTRIES) {
    const oldestKey = lazyQuoteRepairCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    lazyQuoteRepairCache.delete(oldestKey);
  }
}

/**
 * Rebind a historical chunk-backed citation to the exact quote that was
 * visibly written next to its anchor. The evidence chunk is used only to
 * verify the full token sequence; it never becomes the navigation query.
 */
export function bindQuoteCitationToDisplayedText(
  citation: QuoteCitation,
  displayedQuoteText: string,
): QuoteCitation | undefined {
  const cacheKey = buildLazyQuoteRepairCacheKey(citation, displayedQuoteText);
  const cached = lazyQuoteRepairCache.get(cacheKey);
  if (cached) {
    lazyQuoteRepairCache.delete(cacheKey);
    lazyQuoteRepairCache.set(cacheKey, cached);
    return cached;
  }
  const displayed = normalizeDisplayedQuoteForExactBinding(displayedQuoteText);
  if (!displayed) return undefined;

  const evidenceTexts = Array.from(
    new Set(
      [citation.sourceMatchText, citation.quoteText]
        .map((value) => normalizeMultilineText(value))
        .filter(Boolean),
    ),
  );
  let matchedSpan:
    | {
        text: string;
        occurrenceIndex: number;
      }
    | undefined;
  for (const evidenceText of evidenceTexts) {
    const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
      buildQuoteTextIndex(evidenceText),
      displayed.quoteText,
    );
    if (spans.length > 1) return undefined;
    if (spans.length === 1) {
      matchedSpan = spans[0];
      break;
    }
  }
  const matchedSourceText = normalizeMultilineText(
    stripLikelyLayoutNumberArtifacts(matchedSpan?.text || ""),
  );
  if (!matchedSpan || !matchedSourceText) return undefined;
  const sourceQuoteText = buildCompleteDisplayedSourceQuoteText(
    displayed.quoteText,
    matchedSourceText,
  );
  if (!sourceQuoteText) return undefined;

  const rebound = buildQuoteCitation({
    ...citation,
    id: citation.id,
    quoteText: sourceQuoteText,
    displayQuoteText:
      displayed.displayText !== sourceQuoteText
        ? displayed.displayText
        : undefined,
    sourceMatchText: sourceQuoteText,
    sourceMatchKind:
      matchedSourceText === sourceQuoteText ? "exact" : "normalized-span",
    sourceMatchSource: citation.sourceMatchSource || "context-text",
    sourceMatchPageOccurrence:
      citation.sourceMatchPageOccurrence ??
      (citation.sourceMatchSource === "pdf-page-text" ||
      citation.pageHintIndex !== undefined
        ? matchedSpan.occurrenceIndex
        : undefined),
    allowShortQuoteText: true,
  });
  if (rebound) rememberLazyQuoteRepair(cacheKey, rebound);
  return rebound;
}

function collectInvalidQuoteCitationIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeText(record.id).replace(/[^A-Za-z0-9_-]/g, "");
    if (!id) continue;
    if (!buildQuoteCitation(record)) ids.add(id);
  }
  return ids;
}

export function mergeQuoteCitations(
  ...groups: Array<QuoteCitation[] | undefined | null>
): QuoteCitation[] {
  const out: QuoteCitation[] = [];
  const byId = new Map<string, QuoteCitation>();
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (!entry || typeof entry !== "object") continue;
      const citation = buildQuoteCitation(entry as Record<string, unknown>);
      if (!citation) continue;
      const existing = byId.get(citation.id);
      if (existing) {
        if (
          existing.pageHintIndex === undefined &&
          citation.pageHintIndex !== undefined
        ) {
          existing.pageHintIndex = citation.pageHintIndex;
        }
        if (!existing.pageHintLabel && citation.pageHintLabel) {
          existing.pageHintLabel = citation.pageHintLabel;
        }
        if (!existing.sourceSectionLabel && citation.sourceSectionLabel) {
          existing.sourceSectionLabel = citation.sourceSectionLabel;
        }
        if (!existing.sourceChunkKind && citation.sourceChunkKind) {
          existing.sourceChunkKind = citation.sourceChunkKind;
        }
        if (!existing.sourceFingerprint && citation.sourceFingerprint) {
          existing.sourceFingerprint = citation.sourceFingerprint;
        }
        if (
          existing.sourceMatchPageOccurrence === undefined &&
          citation.sourceMatchPageOccurrence !== undefined
        ) {
          existing.sourceMatchPageOccurrence =
            citation.sourceMatchPageOccurrence;
        }
        continue;
      }
      byId.set(citation.id, citation);
      out.push(citation);
    }
  }
  return out;
}

export type QuoteSourceText = {
  text?: unknown;
  sourceText?: unknown;
  /** Precomputed index from the attachment page-text cache. */
  textIndex?: QuoteTextIndex;
  citationLabel?: unknown;
  sourceLabel?: unknown;
  metadataTexts?: unknown;
  sourceMatchSource?: unknown;
  sectionLabel?: unknown;
  chunkKind?: unknown;
  contextItemId?: unknown;
  itemId?: unknown;
  sourceFingerprint?: unknown;
  requiresPageHint?: unknown;
  pageHintIndex?: unknown;
  pageHintLabel?: unknown;
};

export type QuoteSourceIndexEntry = {
  sourceText: string;
  textIndex?: QuoteTextIndex;
  citationLabel: string;
  origin?: "quote-citation" | "source-text";
  sourceMatchSource?: QuoteCitation["sourceMatchSource"];
  sectionLabel?: string;
  chunkKind?: string;
  contextItemId?: number;
  itemId?: number;
  sourceFingerprint?: string;
  requiresPageHint?: boolean;
  pageHintIndex?: number;
  pageHintLabel?: string;
};

export type QuoteSourceIndex = {
  quoteCitations: QuoteCitation[];
  sources: QuoteSourceIndexEntry[];
  metadataTexts: string[];
};

function filterMetadataQuoteCitations(
  quoteCitations: QuoteCitation[] | undefined | null,
  metadataTexts: Iterable<string> | undefined | null,
): QuoteCitation[] {
  return normalizeQuoteCitations(quoteCitations).filter(
    (citation) => !isKnownQuoteMetadataText(citation.quoteText, metadataTexts),
  );
}

function isVerifiedQuoteCitation(citation: QuoteCitation): boolean {
  return Boolean(citation.sourceMatchKind || citation.sourceMatchSource);
}

function filterVerifiedQuoteCitations(
  quoteCitations: QuoteCitation[] | undefined | null,
): QuoteCitation[] {
  return normalizeQuoteCitations(quoteCitations).filter(
    isVerifiedQuoteCitation,
  );
}

function quoteSourceKeyForCitation(citation: QuoteCitation): string {
  return quoteSourceKey({
    sourceText: citation.quoteText,
    citationLabel: citation.citationLabel,
    sourceMatchSource: citation.sourceMatchSource,
    contextItemId: citation.contextItemId,
    itemId: citation.itemId,
  });
}

function filterUnverifiedQuoteCitationSources(params: {
  sourceIndex: QuoteSourceIndex;
  quoteCitations: QuoteCitation[] | undefined | null;
}): QuoteSourceIndex {
  const unverifiedSourceKeys = new Set(
    normalizeQuoteCitations(params.quoteCitations)
      .filter((citation) => !isVerifiedQuoteCitation(citation))
      .map(quoteSourceKeyForCitation),
  );
  if (!unverifiedSourceKeys.size) {
    return {
      ...params.sourceIndex,
      quoteCitations: filterVerifiedQuoteCitations(
        params.sourceIndex.quoteCitations,
      ),
    };
  }
  return {
    ...params.sourceIndex,
    quoteCitations: filterVerifiedQuoteCitations(
      params.sourceIndex.quoteCitations,
    ),
    sources: params.sourceIndex.sources.filter(
      (source) =>
        source.origin !== "quote-citation" ||
        !unverifiedSourceKeys.has(quoteSourceKey(source)),
    ),
  };
}

function collectMetadataQuoteCitationIds(
  quoteCitations: QuoteCitation[] | undefined | null,
  metadataTexts: Iterable<string> | undefined | null,
): Set<string> {
  const ids = new Set<string>();
  for (const citation of normalizeQuoteCitations(quoteCitations)) {
    if (!isKnownQuoteMetadataText(citation.quoteText, metadataTexts)) {
      continue;
    }
    ids.add(citation.id);
  }
  return ids;
}

function quoteSourceKey(source: QuoteSourceIndexEntry): string {
  return [
    normalizeCitationLabelForMatch(source.citationLabel),
    normalizePositiveInt(source.contextItemId) || "",
    normalizePositiveInt(source.itemId) || "",
    normalizeText(source.sourceFingerprint),
    normalizePageHintIndex(source.pageHintIndex) ?? "",
    normalizePageHintLabel(source.pageHintLabel) || "",
    normalizeQuoteTextForMatch(source.sourceText).toLowerCase(),
  ].join("\u241f");
}

function quoteEvidenceScopeKey(input: {
  citationLabel: string;
  contextItemId?: unknown;
  itemId?: unknown;
}): string {
  return [
    normalizeCitationLabelForMatch(input.citationLabel),
    normalizePositiveInt(input.contextItemId) || "",
    normalizePositiveInt(input.itemId) || "",
  ].join("\u241f");
}

function quoteEvidenceLabelScopeKey(input: { citationLabel: string }): string {
  return [normalizeCitationLabelForMatch(input.citationLabel), "", ""].join(
    "\u241f",
  );
}

function hasStableQuoteEvidenceScope(input: {
  contextItemId?: unknown;
  itemId?: unknown;
}): boolean {
  return Boolean(
    normalizePositiveInt(input.contextItemId) ||
    normalizePositiveInt(input.itemId),
  );
}

function isStrictBodyEvidenceQuoteSource(input: {
  sectionLabel?: string;
  chunkKind?: string;
}): boolean {
  const chunkKind = normalizeQuoteChunkKind(input.chunkKind);
  if (
    [
      "introduction",
      "methods",
      "results",
      "discussion",
      "conclusion",
      "figure-caption",
      "table-caption",
      "appendix",
      "body",
    ].includes(chunkKind)
  ) {
    return true;
  }
  if (
    chunkKind === "abstract" ||
    chunkKind === "references" ||
    chunkKind === "unknown" ||
    chunkKind === "page"
  ) {
    return false;
  }
  const sectionLabel = normalizeText(input.sectionLabel);
  if (!sectionLabel || /^page\s+\S+$/i.test(sectionLabel)) return false;
  return isBodyEvidenceSection(input.sectionLabel);
}

function isBodyQuoteSource(source: QuoteSourceIndexEntry): boolean {
  if (source.sourceMatchSource === "pdf-page-text") return true;
  return isStrictBodyEvidenceQuoteSource({
    sectionLabel: source.sectionLabel,
    chunkKind: source.chunkKind,
  });
}

function isBodyQuoteCitation(citation: QuoteCitation): boolean {
  return isStrictBodyEvidenceQuoteSource({
    sectionLabel: citation.sourceSectionLabel,
    chunkKind: citation.sourceChunkKind,
  });
}

function filterSourceIndexForBodyEvidenceQuotes(
  sourceIndex: QuoteSourceIndex,
): QuoteSourceIndex {
  const bodyScopeKeys = new Set<string>();
  const addBodyScopeKey = (input: {
    citationLabel: string;
    contextItemId?: unknown;
    itemId?: unknown;
  }) => {
    if (hasStableQuoteEvidenceScope(input)) {
      bodyScopeKeys.add(quoteEvidenceScopeKey(input));
      return;
    }
    bodyScopeKeys.add(quoteEvidenceLabelScopeKey(input));
  };
  const shouldKeepEvidence = (
    input: {
      citationLabel: string;
      contextItemId?: unknown;
      itemId?: unknown;
    },
    isBody: boolean,
  ): boolean => {
    const key = quoteEvidenceScopeKey(input);
    const labelKey = quoteEvidenceLabelScopeKey(input);
    const blocked = hasStableQuoteEvidenceScope(input)
      ? bodyScopeKeys.has(key)
      : bodyScopeKeys.has(key) || bodyScopeKeys.has(labelKey);
    return !blocked || isBody;
  };
  for (const source of sourceIndex.sources) {
    if (!isBodyQuoteSource(source)) continue;
    addBodyScopeKey(source);
  }
  for (const citation of sourceIndex.quoteCitations) {
    if (!isBodyQuoteCitation(citation)) continue;
    addBodyScopeKey(citation);
  }
  if (!bodyScopeKeys.size) return sourceIndex;
  return {
    ...sourceIndex,
    quoteCitations: sourceIndex.quoteCitations.filter((citation) => {
      return shouldKeepEvidence(citation, isBodyQuoteCitation(citation));
    }),
    sources: sourceIndex.sources.filter((source) => {
      return shouldKeepEvidence(source, isBodyQuoteSource(source));
    }),
  };
}

export function buildQuoteSourceIndex(params: {
  quoteCitations?: QuoteCitation[] | undefined | null;
  sourceTexts?: QuoteSourceText[] | undefined | null;
}): QuoteSourceIndex {
  const metadataTextSet = new Set<string>();
  const sourceTexts = params.sourceTexts || [];
  for (const source of sourceTexts) {
    for (const metadataText of collectQuoteMetadataTexts(
      source.metadataTexts,
    )) {
      metadataTextSet.add(metadataText);
    }
  }
  const quoteCitations = filterMetadataQuoteCitations(
    params.quoteCitations,
    metadataTextSet,
  );
  const sources: QuoteSourceIndexEntry[] = [];
  const seen = new Map<string, number>();
  const pushSource = (entry: QuoteSourceIndexEntry | undefined) => {
    if (
      !entry?.sourceText ||
      !isCanonicalQuoteSourceLabel(entry.citationLabel)
    ) {
      return;
    }
    const key = quoteSourceKey(entry);
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (
        quoteSourceProvenanceScore(entry) >
          quoteSourceProvenanceScore(sources[existingIndex]) ||
        (entry.origin === "source-text" &&
          sources[existingIndex].origin === "quote-citation")
      ) {
        sources[existingIndex] = entry;
      }
      return;
    }
    seen.set(key, sources.length);
    sources.push(entry);
  };
  for (const citation of quoteCitations) {
    pushSource({
      sourceText: citation.quoteText,
      textIndex: buildQuoteTextIndex(citation.quoteText),
      citationLabel: citation.citationLabel,
      origin: "quote-citation",
      sourceMatchSource: citation.sourceMatchSource,
      sectionLabel: citation.sourceSectionLabel,
      chunkKind: citation.sourceChunkKind,
      contextItemId: citation.contextItemId,
      itemId: citation.itemId,
      sourceFingerprint: citation.sourceFingerprint,
      requiresPageHint: citation.sourceMatchSource === "pdf-page-text",
      pageHintIndex: citation.pageHintIndex,
      pageHintLabel: citation.pageHintLabel,
    });
  }
  for (const source of sourceTexts) {
    const normalizedSourceText = normalizeMultilineText(
      source.sourceText || source.text,
    );
    const reusableTextIndex =
      source.textIndex &&
      (source.textIndex.sourceText === normalizedSourceText ||
        normalizeMultilineText(source.textIndex.sourceText) ===
          normalizedSourceText)
        ? source.textIndex
        : undefined;
    const sourceText = reusableTextIndex?.sourceText || normalizedSourceText;
    const citationLabel = normalizeCitationLabel(
      source.sourceLabel || source.citationLabel,
    );
    if (!sourceText || !citationLabel) continue;
    pushSource({
      sourceText,
      textIndex: reusableTextIndex || buildQuoteTextIndex(sourceText),
      citationLabel,
      origin: "source-text",
      sourceMatchSource: normalizeQuoteMatchSource(source.sourceMatchSource),
      sectionLabel: normalizeText(source.sectionLabel) || undefined,
      chunkKind: normalizeQuoteChunkKind(source.chunkKind) || undefined,
      contextItemId: normalizePositiveInt(source.contextItemId),
      itemId: normalizePositiveInt(source.itemId),
      sourceFingerprint: normalizeText(source.sourceFingerprint) || undefined,
      requiresPageHint:
        Boolean(source.requiresPageHint) ||
        normalizeQuoteMatchSource(source.sourceMatchSource) === "pdf-page-text",
      pageHintIndex: normalizePageHintIndex(source.pageHintIndex),
      pageHintLabel: normalizePageHintLabel(source.pageHintLabel),
    });
  }
  return { quoteCitations, sources, metadataTexts: [...metadataTextSet] };
}

export function resolveExactDisplayedQuoteCitation(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredId?: string;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
}): QuoteCitation | undefined {
  const displayed = normalizeDisplayedQuoteForExactBinding(params.quoteText);
  if (!displayed) return undefined;
  const preferredContextItemId = normalizePositiveInt(
    params.preferredContextItemId,
  );
  const preferredItemId = normalizePositiveInt(params.preferredItemId);
  const preferredSourceFingerprint = normalizeText(
    params.preferredSourceFingerprint,
  );
  const matches: Array<{
    source: QuoteSourceIndexEntry;
    occurrenceIndex: number;
    sourceQuoteText: string;
  }> = [];

  for (const source of params.sourceIndex.sources) {
    if (source.requiresPageHint && source.pageHintIndex === undefined) {
      continue;
    }
    if (
      (preferredContextItemId &&
        source.contextItemId !== preferredContextItemId) ||
      (preferredItemId &&
        source.itemId !== undefined &&
        source.itemId !== preferredItemId) ||
      (preferredSourceFingerprint &&
        source.sourceFingerprint !== preferredSourceFingerprint)
    ) {
      continue;
    }
    const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
      source.textIndex || buildQuoteTextIndex(source.sourceText),
      displayed.quoteText,
    );
    for (const span of spans) {
      const sourceQuoteText = normalizeMultilineText(
        stripLikelyLayoutNumberArtifacts(span.text),
      );
      if (!sourceQuoteText) continue;
      matches.push({
        source,
        occurrenceIndex: span.occurrenceIndex,
        sourceQuoteText,
      });
    }
  }

  const pageMatches = matches.filter(
    (match) =>
      match.source.sourceMatchSource === "pdf-page-text" &&
      match.source.pageHintIndex !== undefined,
  );
  const eligible = pageMatches.length ? pageMatches : matches;
  const byLocation = new Map<
    string,
    Array<{
      source: QuoteSourceIndexEntry;
      occurrenceIndex: number;
      sourceQuoteText: string;
    }>
  >();
  for (const match of eligible) {
    const anonymousSourceIdentity =
      !match.source.contextItemId &&
      !match.source.itemId &&
      !match.source.sourceFingerprint
        ? hashBase36(
            `${match.source.citationLabel}\u241f${match.source.sourceText}`,
          )
        : "";
    const key = [
      match.source.contextItemId || "",
      match.source.itemId || "",
      match.source.sourceFingerprint || anonymousSourceIdentity,
      match.source.pageHintIndex ?? "",
      match.occurrenceIndex,
    ].join("\u241f");
    const group = byLocation.get(key) || [];
    group.push(match);
    byLocation.set(key, group);
  }
  let group: Array<{
    source: QuoteSourceIndexEntry;
    occurrenceIndex: number;
    sourceQuoteText: string;
  }>;
  if (byLocation.size === 1) {
    group = Array.from(byLocation.values())[0];
  } else {
    const locationGroups = Array.from(byLocation.values());
    const representativeMatches = locationGroups
      .map((matchesAtLocation) => matchesAtLocation[0])
      .filter(Boolean);
    const sourceIdentities = new Set(
      representativeMatches.map((match) =>
        match.source.contextItemId
          ? `context:${match.source.contextItemId}`
          : match.source.sourceFingerprint
            ? `fingerprint:${match.source.sourceFingerprint}`
            : match.source.itemId
              ? `item:${match.source.itemId}`
              : "",
      ),
    );
    const pageLocations = new Set(
      representativeMatches.map((match) =>
        [
          match.source.pageHintIndex ?? "",
          match.source.pageHintLabel || "",
        ].join("\u241f"),
      ),
    );
    const repeatedOnlyAcrossPages =
      representativeMatches.length === locationGroups.length &&
      representativeMatches.every(
        (match) =>
          match.source.sourceMatchSource === "pdf-page-text" &&
          match.source.pageHintIndex !== undefined,
      ) &&
      sourceIdentities.size === 1 &&
      !sourceIdentities.has("") &&
      pageLocations.size === locationGroups.length;
    if (!repeatedOnlyAcrossPages) return undefined;
    group = locationGroups.slice().sort((left, right) => {
      const leftPage = left[0]?.source.pageHintIndex ?? Number.MAX_SAFE_INTEGER;
      const rightPage =
        right[0]?.source.pageHintIndex ?? Number.MAX_SAFE_INTEGER;
      return leftPage - rightPage;
    })[0];
  }

  if (!group?.length) return undefined;
  const selected = group
    .slice()
    .sort(
      (left, right) =>
        quoteSourceProvenanceScore(right.source) -
        quoteSourceProvenanceScore(left.source),
    )[0];
  if (!selected) return undefined;
  const sourceQuoteText = selected.sourceQuoteText;
  const completeDisplayedSourceQuoteText =
    buildCompleteDisplayedSourceQuoteText(displayed.quoteText, sourceQuoteText);
  if (!completeDisplayedSourceQuoteText) return undefined;
  const hasAuthoritativePage = selected.source.pageHintIndex !== undefined;
  if (
    !hasAuthoritativePage &&
    !isQuoteWorthySourceText(completeDisplayedSourceQuoteText)
  ) {
    return undefined;
  }

  return buildQuoteCitation({
    id: params.preferredId,
    quoteText: completeDisplayedSourceQuoteText,
    displayQuoteText:
      displayed.displayText !== completeDisplayedSourceQuoteText
        ? displayed.displayText
        : undefined,
    citationLabel: selected.source.citationLabel,
    sourceMatchText: completeDisplayedSourceQuoteText,
    sourceMatchKind:
      sourceQuoteText === completeDisplayedSourceQuoteText
        ? "exact"
        : "normalized-span",
    sourceMatchSource:
      selected.source.sourceMatchSource ||
      (selected.source.pageHintIndex !== undefined
        ? "pdf-page-text"
        : "context-text"),
    sourceSectionLabel: selected.source.sectionLabel,
    sourceChunkKind: selected.source.chunkKind,
    contextItemId: selected.source.contextItemId,
    itemId: selected.source.itemId,
    sourceFingerprint: selected.source.sourceFingerprint,
    sourceMatchPageOccurrence: selected.occurrenceIndex,
    pageHintIndex: selected.source.pageHintIndex,
    pageHintLabel: selected.source.pageHintLabel,
    allowShortQuoteText: hasAuthoritativePage,
  });
}

function splitDisplayedQuoteIntoSentenceSegments(value: string): string[] {
  const text = stripOuterQuoteDelimiters(normalizeMultilineText(value));
  const segments =
    text.match(/[^.!?。！？]+(?:[.!?。！？]+(?=\s|$)|$)/gu) || [];
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Resolve one visible quote into one or more complete, page-bounded source
 * spans. Ellipsized quotes are split at the omitted text. Quotes that
 * genuinely cross a page boundary are split at sentence boundaries only
 * after every sentence can be grounded and at least two pages are involved.
 */
export function resolvePageBoundedDisplayedQuoteCitations(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredId?: string;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
}): QuoteCitation[] {
  const direct = resolveExactDisplayedQuoteCitation(params);
  if (direct) return [direct];

  const quoteWithoutDelimiters = stripOuterQuoteDelimiters(params.quoteText);
  const ellipsisSegments = splitQuoteAtEllipsisInOrder(quoteWithoutDelimiters);
  if (ellipsisSegments.length > 1) {
    const resolved = ellipsisSegments.map((quoteText) =>
      resolveExactDisplayedQuoteCitation({
        ...params,
        preferredId: undefined,
        quoteText,
      }),
    );
    if (
      resolved.every((citation): citation is QuoteCitation =>
        Boolean(citation && citation.pageHintIndex !== undefined),
      )
    ) {
      return resolved;
    }
    return [];
  }

  const sentenceSegments = splitDisplayedQuoteIntoSentenceSegments(
    quoteWithoutDelimiters,
  );
  if (sentenceSegments.length < 2) return [];
  const resolved = sentenceSegments.map((quoteText) =>
    resolveExactDisplayedQuoteCitation({
      ...params,
      preferredId: undefined,
      quoteText,
    }),
  );
  if (
    !resolved.every((citation): citation is QuoteCitation =>
      Boolean(citation && citation.pageHintIndex !== undefined),
    )
  ) {
    return [];
  }
  const pageIndexes = new Set(
    resolved.map((citation) => citation.pageHintIndex),
  );
  if (pageIndexes.size < 2) return [];
  for (let index = 1; index < resolved.length; index += 1) {
    if (
      Number(resolved[index].pageHintIndex) <
      Number(resolved[index - 1].pageHintIndex)
    ) {
      return [];
    }
  }
  return resolved;
}

function quoteContainsLayoutArtifactHazards(value: string): boolean {
  const text = normalizeMultilineText(value);
  if (!text) return false;
  if (splitQuoteAtEllipsisInOrder(stripOuterQuoteDelimiters(text)).length > 1) {
    return true;
  }
  if (
    /(?:\\\(|\\\)|\\\[|\\\]|\${1,2}|\\[A-Za-z]+|\u00ad|\u2061)/u.test(text) ||
    /[\p{Sm}\p{Sk}\u0370-\u03ff\u1f00-\u1fff]/u.test(text)
  ) {
    return true;
  }
  const semanticNonAscii = text.replace(/[\p{P}\p{Z}\p{N}]/gu, "");
  return /[^\x00-\x7f]/u.test(semanticNonAscii);
}

/**
 * Treat distributed source support as a complete match only when PDF layout
 * artifacts explain the gaps and both ends of the displayed quote are present.
 * A normal prose overlap, added prefix, or added tail is never sufficient.
 */
function hasCompleteDisplayedQuoteSupport(
  match: QuoteTextAnchorMatch,
  quoteText: string,
): boolean {
  if (match.matchKind === "exact") return true;
  return (
    quoteContainsLayoutArtifactHazards(quoteText) &&
    match.quoteStartTokenSupported &&
    match.quoteEndTokenSupported &&
    match.quoteTokenSupportCoverage >=
      MIN_COMPLETE_LAYOUT_ARTIFACT_SUPPORT_COVERAGE
  );
}

function filterQuoteAnchorSources(params: {
  sourceIndex: QuoteSourceIndex;
  citationLabel?: string;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
}): Array<{ source: QuoteSourceIndexEntry; ordinal: number }> {
  const preferredContextItemId = normalizePositiveInt(
    params.preferredContextItemId,
  );
  const preferredItemId = normalizePositiveInt(params.preferredItemId);
  const preferredSourceFingerprint = normalizeText(
    params.preferredSourceFingerprint,
  );
  let sources = params.sourceIndex.sources
    .map((source, ordinal) => ({ source, ordinal }))
    .filter(({ source }) => {
      if (source.requiresPageHint && source.pageHintIndex === undefined) {
        return false;
      }
      return !(
        (preferredContextItemId &&
          source.contextItemId !== preferredContextItemId) ||
        (preferredItemId &&
          source.itemId !== undefined &&
          source.itemId !== preferredItemId) ||
        (preferredSourceFingerprint &&
          source.sourceFingerprint !== preferredSourceFingerprint)
      );
    });
  const pageSources = sources.filter(
    ({ source }) =>
      source.sourceMatchSource === "pdf-page-text" &&
      source.pageHintIndex !== undefined,
  );
  if (pageSources.length) sources = pageSources;

  return sources;
}

function findDisplayedQuoteAnchorMatch(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
  requireUnique: boolean;
}): {
  match: QuoteTextAnchorMatch;
  source: QuoteSourceIndexEntry;
} | null {
  const sources = filterQuoteAnchorSources(params);
  if (!sources.length) return null;
  const entries = sources.map(({ source, ordinal }) => ({
    id: `source-${ordinal}`,
    text: source.sourceText,
    textIndex: source.textIndex,
    debugLabel: source.citationLabel,
  }));
  const match = params.requireUnique
    ? findLargestUniqueQuoteTextAnchorMatch(entries, params.quoteText, {
        minQueryLength: 20,
        rejectWeakQueries: true,
      })
    : findLargestQuoteTextAnchorMatch(entries, params.quoteText, {
        minQueryLength: 20,
        rejectWeakQueries: true,
      });
  if (!match) return null;
  const matchedOrdinal = Number(match.entryId.replace(/^source-/, ""));
  const source = params.sourceIndex.sources[matchedOrdinal];
  return source ? { match, source } : null;
}

function resolveUniqueDisplayedQuoteAnchorCitation(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredId?: string;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
}): QuoteCitation | undefined {
  const displayedQuoteText = stripOuterQuoteDelimiters(
    normalizeMultilineText(params.quoteText),
  );
  if (!displayedQuoteText) return undefined;
  const resolved = findDisplayedQuoteAnchorMatch({
    ...params,
    quoteText: displayedQuoteText,
    requireUnique: true,
  });
  if (
    !resolved ||
    !hasCompleteDisplayedQuoteSupport(resolved.match, displayedQuoteText)
  ) {
    return undefined;
  }
  const sourceMatchText = normalizeMultilineText(resolved.match.query);
  if (!sourceMatchText) return undefined;
  return buildQuoteCitation({
    id: params.preferredId,
    quoteText: displayedQuoteText,
    citationLabel: resolved.source.citationLabel,
    sourceMatchText,
    sourceMatchKind: resolved.match.matchKind,
    sourceMatchSource:
      resolved.source.sourceMatchSource ||
      (resolved.source.pageHintIndex !== undefined
        ? "pdf-page-text"
        : "context-text"),
    sourceSectionLabel: resolved.source.sectionLabel,
    sourceChunkKind: resolved.source.chunkKind,
    contextItemId: resolved.source.contextItemId,
    itemId: resolved.source.itemId,
    sourceFingerprint: resolved.source.sourceFingerprint,
    sourceMatchPageOccurrence: 0,
    pageHintIndex: resolved.source.pageHintIndex,
    pageHintLabel: resolved.source.pageHintLabel,
    allowShortQuoteText: true,
  });
}

function resolveDisplayedQuoteCitations(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredId?: string;
  preferredContextItemId?: number;
  preferredItemId?: number;
  preferredSourceFingerprint?: string;
}): QuoteCitation[] {
  const complete = resolvePageBoundedDisplayedQuoteCitations(params);
  if (complete.length) return complete;
  const layoutArtifactMatch = resolveUniqueDisplayedQuoteAnchorCitation(params);
  return layoutArtifactMatch ? [layoutArtifactMatch] : [];
}

function stripOuterQuoteDelimiters(value: string): string {
  const text = normalizeMultilineText(value).trim();
  const hasPairedOuterQuotes =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”")) ||
    (text.startsWith("”") && text.endsWith("”"));
  return hasPairedOuterQuotes ? text.slice(1, -1).trim() : text;
}

function inferSingleSourceCitationLabel(
  sourceIndex: QuoteSourceIndex,
): string | undefined {
  const labels = new Map<string, string>();
  for (const source of sourceIndex.sources) {
    const label = normalizeCitationLabel(source.citationLabel);
    if (!label || !isCanonicalQuoteSourceLabel(label)) continue;
    labels.set(normalizeCitationLabelForMatch(label), label);
  }
  return labels.size === 1 ? Array.from(labels.values())[0] : undefined;
}

function isObviousNonSourceBlockquoteText(value: string): boolean {
  const text = normalizeQuoteTextForMatch(value);
  if (!text) return false;
  return (
    /^(?:my\s+)?(?:interpretation|takeaway|summary|note|commentary|explanation)\s*[:：]/i.test(
      text,
    ) || /\b(?:i think|i would say|in other words)\b/i.test(text)
  );
}

function formatFencedTextMarkdown(value: string): string {
  const text = normalizeMultilineText(value).replace(/```/g, "'''");
  return text ? `\`\`\`text\n${text}\n\`\`\`` : "";
}

function formatUnverifiedQuoteWithBestSourceLabel(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
}): string | undefined {
  const quoteText = normalizeMultilineText(params.quoteText);
  if (!quoteText) return undefined;
  if (isObviousNonSourceBlockquoteText(quoteText)) {
    return formatFencedTextMarkdown(quoteText);
  }
  const inferredCitationLabel = inferSingleSourceCitationLabel(
    params.sourceIndex,
  );
  if (inferredCitationLabel && isQuoteWorthySourceText(quoteText)) {
    return formatPlainQuoteWithCitationMarkdown(
      quoteText,
      inferredCitationLabel,
    );
  }
  return undefined;
}

function quoteSourceProvenanceScore(source: QuoteSourceIndexEntry): number {
  let score = 0;
  if (source.sourceMatchSource === "pdf-page-text") score += 260;
  else if (source.sourceMatchSource === "context-text") score += 80;
  if (isBodyQuoteSource(source)) score += 80;
  if (source.chunkKind === "abstract" || source.chunkKind === "front-matter") {
    score -= 120;
  }
  if (source.pageHintIndex !== undefined || source.pageHintLabel) score += 20;
  return score;
}

export type QuoteSourceResolution =
  | { kind: "matched"; quoteCitations: QuoteCitation[] }
  | { kind: "absent" }
  | { kind: "defer" };

function resolveExactDisplayedQuoteCitationsWithLabelFallback(params: {
  quoteText: string;
  citationLabel?: string;
  sourceIndex: QuoteSourceIndex;
  preferredId?: string;
}): QuoteCitation[] {
  return resolveDisplayedQuoteCitations(params);
}

function hasCompleteDisplayedQuoteSourceMatch(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
}): boolean {
  const resolved = findDisplayedQuoteAnchorMatch({
    quoteText: params.quoteText,
    sourceIndex: params.sourceIndex,
    requireUnique: false,
  });
  return Boolean(
    resolved &&
    hasCompleteDisplayedQuoteSupport(resolved.match, params.quoteText),
  );
}

function isHighConfidenceNonSourceQuote(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
  sourceEvidenceComplete: boolean;
}): boolean {
  if (!params.sourceEvidenceComplete) return false;
  if (isObviousNonSourceBlockquoteText(params.quoteText)) return true;
  return !hasCompleteDisplayedQuoteSourceMatch({
    quoteText: params.quoteText,
    sourceIndex: params.sourceIndex,
  });
}

export function classifyDisplayedQuoteSource(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
  sourceEvidenceComplete: boolean;
}): QuoteSourceResolution {
  const quoteText = normalizeMultilineText(params.quoteText);
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return { kind: "defer" };
  }
  const quoteCitations = resolveExactDisplayedQuoteCitationsWithLabelFallback({
    quoteText,
    sourceIndex: params.sourceIndex,
  });
  if (quoteCitations.length) {
    return { kind: "matched", quoteCitations };
  }
  if (
    hasCompleteDisplayedQuoteSourceMatch({
      quoteText,
      sourceIndex: params.sourceIndex,
    })
  ) {
    return { kind: "defer" };
  }
  return isHighConfidenceNonSourceQuote({
    quoteText,
    sourceIndex: params.sourceIndex,
    sourceEvidenceComplete: params.sourceEvidenceComplete,
  })
    ? { kind: "absent" }
    : { kind: "defer" };
}

function formatPlainQuoteMarkdown(quoteText: string): string {
  const normalizedQuote = normalizeMultilineText(quoteText);
  if (!normalizedQuote) return "";
  return normalizedQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatPlainQuoteWithCitationMarkdown(
  quoteText: string,
  citationLabel: string,
): string {
  return formatQuoteWithCitationInsideBlockquoteMarkdown(
    quoteText,
    citationLabel,
  );
}

function extractLeadingParentheticalLabel(value: string): {
  label: string;
  remainder: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(")) return null;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        const label = normalizeCitationLabel(trimmed.slice(0, index + 1));
        const remainder = trimmed.slice(index + 1).trim();
        return label ? { label, remainder } : null;
      }
    }
  }
  return null;
}

function normalizeCitationRemainder(value: string | undefined): string {
  return stripLeadingCitationSeparators(normalizeMultilineText(value || ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMetadataQuoteCitationPlaceholders(
  markdown: string,
  metadataQuoteIds: Set<string>,
): string {
  if (!markdown || !metadataQuoteIds.size) return markdown;
  let out = markdown;
  for (const quoteId of metadataQuoteIds) {
    const escaped = escapeRegExp(quoteId);
    out = out.replace(
      new RegExp(
        `^[ \\t]*(?:>[ \\t]*)+\\[\\[quote:${escaped}\\]\\][ \\t]*(?:\\n|$)`,
        "gm",
      ),
      "",
    );
    out = out.replace(
      new RegExp(`[ \\t]*\\[\\[quote:${escaped}\\]\\][ \\t]*`, "g"),
      " ",
    );
  }
  return out.replace(/[ \t]{2,}/g, " ");
}

function cleanupRemovedMetadataQuoteArtifacts(markdown: string): string {
  if (!markdown) return markdown;
  let out = markdown;
  out = out.replace(
    /[ \t]+as\s+(?:the\s+)?(?:paper(?:['’]s)?\s+)?title\s+(?:puts\s+it|states|says),?[ \t]*(?=(?:\n{2,}|$))/gi,
    "",
  );
  out = out.replace(
    /(^|\n)[ \t]*as\s+(?:the\s+)?(?:paper(?:['’]s)?\s+)?title\s+(?:puts\s+it|states|says),?[ \t]*(?=(?:\n{2,}|$))/gi,
    "$1",
  );
  return normalizeSanitizedMarkdown(out)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function resolveQuoteCitationsForFinalizer(params: {
  quoteText: string;
  citationLabel: string;
  quoteCitations: QuoteCitation[];
  sourceIndex: QuoteSourceIndex;
}): QuoteCitation[] {
  const quoteText = normalizeMultilineText(params.quoteText);
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return [];
  }
  const exact = resolveExactDisplayedQuoteCitationsWithLabelFallback({
    quoteText,
    citationLabel: isNonSourceQuoteLabel(params.citationLabel)
      ? undefined
      : params.citationLabel,
    sourceIndex: params.sourceIndex,
  });
  if (exact.length) {
    return exact;
  }
  if (!isNonSourceQuoteLabel(params.citationLabel)) {
    const trusted = findMatchingTrustedQuoteCitation({
      quoteText,
      citationLabel: params.citationLabel,
      quoteCitations: params.quoteCitations,
    });
    if (trusted && isCanonicalQuoteSourceLabel(trusted.citationLabel)) {
      const rebound = bindQuoteCitationToDisplayedText(trusted, quoteText);
      if (
        rebound &&
        (rebound.sourceMatchSource !== "pdf-page-text" ||
          rebound.pageHintIndex !== undefined)
      ) {
        return [rebound];
      }
    }
  }
  return [];
}

function resolveUnlabeledQuoteCitationsForFinalizer(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
}): QuoteCitation[] {
  const quoteText = normalizeMultilineText(params.quoteText);
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return [];
  }
  if (!isQuoteWorthySourceText(quoteText)) return [];
  return resolveExactDisplayedQuoteCitationsWithLabelFallback({
    quoteText,
    sourceIndex: params.sourceIndex,
  });
}

function finalizeSourceBackedQuoteBlock(params: {
  quoteText: string;
  citationLabel: string;
  citationRemainder?: string;
  quoteCitations: QuoteCitation[];
  sourceIndex: QuoteSourceIndex;
  fenceUnverifiedBlockquotes?: boolean;
}): {
  markdown: string;
  quoteCitations?: QuoteCitation[];
  consumedCitation: boolean;
} {
  const quoteText = normalizeMultilineText(params.quoteText);
  const citationRemainder = normalizeCitationRemainder(
    params.citationRemainder,
  );
  const hasCanonicalSourceLabel = isCanonicalQuoteSourceLabel(
    params.citationLabel,
  );
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return {
      markdown: citationRemainder,
      consumedCitation: true,
    };
  }
  const unverifiedQuoteMarkdown = formatUnverifiedQuoteWithBestSourceLabel({
    quoteText,
    sourceIndex: params.sourceIndex,
  });
  if (isObviousNonSourceBlockquoteText(quoteText)) {
    return {
      markdown: `${
        unverifiedQuoteMarkdown || formatFencedTextMarkdown(quoteText)
      }${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      consumedCitation: true,
    };
  }
  if (!isQuoteWorthySourceText(quoteText)) {
    return {
      markdown: `${
        params.fenceUnverifiedBlockquotes
          ? formatFencedTextMarkdown(quoteText)
          : hasCanonicalSourceLabel
            ? formatPlainQuoteWithCitationMarkdown(
                quoteText,
                params.citationLabel,
              )
            : formatPlainQuoteMarkdown(quoteText)
      }${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      consumedCitation: true,
    };
  }
  const quoteCitations = resolveQuoteCitationsForFinalizer(params);
  if (quoteCitations.length) {
    return {
      markdown: `${quoteCitations
        .map((citation) => `[[quote:${citation.id}]]`)
        .join("\n")}${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      quoteCitations,
      consumedCitation: true,
    };
  }
  if (params.fenceUnverifiedBlockquotes) {
    return {
      markdown: `${formatFencedTextMarkdown(quoteText)}${
        citationRemainder ? `\n\n${citationRemainder}` : ""
      }`,
      consumedCitation: true,
    };
  }
  if (isNonSourceQuoteLabel(params.citationLabel)) {
    return {
      markdown: `${unverifiedQuoteMarkdown || formatPlainQuoteMarkdown(quoteText)}${
        citationRemainder ? `\n\n${citationRemainder}` : ""
      }`,
      consumedCitation: true,
    };
  }
  if (hasCanonicalSourceLabel) {
    return {
      markdown: `${formatPlainQuoteWithCitationMarkdown(
        quoteText,
        params.citationLabel,
      )}${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      consumedCitation: true,
    };
  }
  return {
    markdown: `${formatPlainQuoteMarkdown(quoteText)}${
      citationRemainder ? `\n\n${citationRemainder}` : ""
    }`,
    consumedCitation: true,
  };
}

function finalizeQuoteSourceCandidate(params: {
  quoteText: string;
  citationRemainder?: string;
  sourceIndex: QuoteSourceIndex;
  sourceEvidenceComplete: boolean;
}): {
  kind: QuoteSourceResolution["kind"];
  markdown?: string;
  quoteCitations?: QuoteCitation[];
} {
  const quoteText = normalizeMultilineText(params.quoteText);
  const citationRemainder = normalizeCitationRemainder(
    params.citationRemainder,
  );
  const resolution = classifyDisplayedQuoteSource({
    quoteText,
    sourceIndex: params.sourceIndex,
    sourceEvidenceComplete: params.sourceEvidenceComplete,
  });
  if (resolution.kind === "matched") {
    return {
      kind: "matched",
      markdown: `${resolution.quoteCitations
        .map((citation) => `[[quote:${citation.id}]]`)
        .join("\n")}${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      quoteCitations: resolution.quoteCitations,
    };
  }
  if (resolution.kind === "absent") {
    return {
      kind: "absent",
      markdown: `${formatPlainQuoteMarkdown(quoteText)}
>
> Not a source quote${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
    };
  }
  return { kind: "defer" };
}

function collapseAdjacentDuplicateQuoteCitationPlaceholders(
  markdown: string,
): string {
  if (!markdown || !QUOTE_CITATION_PATTERN.test(markdown)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return markdown;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;

  let result = "";
  let cursor = 0;
  let lastEmittedQuoteId = "";
  for (const match of markdown.matchAll(QUOTE_CITATION_PATTERN)) {
    const start = match.index || 0;
    const token = match[0];
    const quoteId = match[1] || "";
    const between = markdown.slice(cursor, start);
    if (quoteId && quoteId === lastEmittedQuoteId && !between.trim()) {
      cursor = start + token.length;
      continue;
    }
    result += between;
    result += token;
    lastEmittedQuoteId = quoteId;
    cursor = start + token.length;
  }
  result += markdown.slice(cursor);
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return result;
}

function quoteCitationSharesSourceIdentity(
  left: QuoteCitation,
  right: QuoteCitation,
): boolean {
  const leftContextItemId = normalizePositiveInt(left.contextItemId);
  const rightContextItemId = normalizePositiveInt(right.contextItemId);
  if (leftContextItemId && rightContextItemId) {
    const leftItemId = normalizePositiveInt(left.itemId);
    const rightItemId = normalizePositiveInt(right.itemId);
    return (
      leftContextItemId === rightContextItemId &&
      (!leftItemId || !rightItemId || leftItemId === rightItemId)
    );
  }

  const leftItemId = normalizePositiveInt(left.itemId);
  const rightItemId = normalizePositiveInt(right.itemId);
  if (leftItemId && rightItemId) {
    return leftItemId === rightItemId;
  }

  const leftFingerprint = normalizeText(left.sourceFingerprint);
  const rightFingerprint = normalizeText(right.sourceFingerprint);
  return Boolean(
    leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint,
  );
}

function resolveAdjacentManualQuoteAnchor(params: {
  quoteText: string;
  quoteCitationId: string;
  quoteCitations: QuoteCitation[];
  sourceIndex: QuoteSourceIndex;
}): QuoteCitation[] {
  const existingCitation = params.quoteCitations.find(
    (citation) => citation.id === params.quoteCitationId,
  );
  if (!existingCitation || !isVerifiedQuoteCitation(existingCitation)) {
    return [];
  }

  const displayedQuote = normalizeQuoteTextCanonical(
    stripOuterQuoteDelimiters(params.quoteText),
  );
  const anchoredQuote = normalizeQuoteTextCanonical(
    stripOuterQuoteDelimiters(
      existingCitation.displayQuoteText || existingCitation.quoteText,
    ),
  );
  if (
    !displayedQuote ||
    !anchoredQuote ||
    findCanonicalTextMatchStart(displayedQuote, anchoredQuote) < 0
  ) {
    return [];
  }

  const resolutionParams = {
    quoteText: params.quoteText,
    citationLabel: existingCitation.citationLabel,
    sourceIndex: params.sourceIndex,
    preferredContextItemId: existingCitation.contextItemId,
    preferredItemId: existingCitation.itemId,
  };
  let reboundCitations = resolveDisplayedQuoteCitations({
    ...resolutionParams,
    preferredSourceFingerprint: existingCitation.sourceFingerprint,
  });
  if (
    !reboundCitations.length &&
    (normalizePositiveInt(existingCitation.contextItemId) ||
      normalizePositiveInt(existingCitation.itemId))
  ) {
    // A historical anchor can carry a MinerU fingerprint while the current
    // authoritative evidence comes from PDF.js page text (or vice versa).
    // Retry within the same stable Zotero item scope, then independently
    // require the complete displayed quote and source identity below.
    reboundCitations = resolveDisplayedQuoteCitations(resolutionParams);
  }
  return reboundCitations.length &&
    reboundCitations.every(
      (citation) =>
        isVerifiedQuoteCitation(citation) &&
        quoteCitationSharesSourceIdentity(existingCitation, citation),
    )
    ? reboundCitations
    : [];
}

function cleanupEmptyCitationParentheticals(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .replace(/[ \t]*\(\s*\)[ \t]*,?/g, (match) =>
      match.includes(",") ? "," : "",
    )
    .replace(/[ \t]+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\n{3,}/g, "\n\n");
}

export type AssistantQuoteCitationFinalizationParams = {
  markdown: string;
  quoteCitations?: QuoteCitation[] | undefined | null;
  sourceIndex?: QuoteSourceIndex | undefined | null;
  requireVerifiedQuoteCitations?: boolean;
  requireBodyEvidenceQuotes?: boolean;
  fenceUnverifiedBlockquotes?: boolean;
  quoteSourceReview?: {
    sourceEvidenceComplete: boolean;
  };
};

export type AssistantQuoteCitationFinalizationResult = {
  markdown: string;
  quoteCitations: QuoteCitation[];
};

function* finalizeAssistantQuoteCitationSteps(
  params: AssistantQuoteCitationFinalizationParams,
): Generator<void, AssistantQuoteCitationFinalizationResult, void> {
  const sourceIndex =
    params.sourceIndex ||
    buildQuoteSourceIndex({ quoteCitations: params.quoteCitations });
  const inputQuoteCitations = mergeQuoteCitations(
    params.quoteCitations,
    sourceIndex.quoteCitations,
  );
  const filterQuoteSources =
    params.requireVerifiedQuoteCitations || Boolean(params.quoteSourceReview);
  const bodyFilteredSourceIndex = params.requireBodyEvidenceQuotes
    ? filterSourceIndexForBodyEvidenceQuotes({
        ...sourceIndex,
        quoteCitations: mergeQuoteCitations(
          sourceIndex.quoteCitations,
          inputQuoteCitations,
        ),
      })
    : {
        ...sourceIndex,
        quoteCitations: mergeQuoteCitations(
          sourceIndex.quoteCitations,
          inputQuoteCitations,
        ),
      };
  const finalizedSourceIndex = filterQuoteSources
    ? filterUnverifiedQuoteCitationSources({
        sourceIndex: bodyFilteredSourceIndex,
        quoteCitations: bodyFilteredSourceIndex.quoteCitations,
      })
    : bodyFilteredSourceIndex;
  const mergedQuoteCitations = params.quoteSourceReview
    ? mergeQuoteCitations(inputQuoteCitations)
    : params.requireVerifiedQuoteCitations
      ? filterVerifiedQuoteCitations(finalizedSourceIndex.quoteCitations)
      : mergeQuoteCitations(finalizedSourceIndex.quoteCitations);
  const metadataQuoteIds = collectMetadataQuoteCitationIds(
    mergedQuoteCitations,
    finalizedSourceIndex.metadataTexts,
  );
  let quoteCitations = filterMetadataQuoteCitations(
    mergedQuoteCitations,
    finalizedSourceIndex.metadataTexts,
  );
  const markdown = stripMetadataQuoteCitationPlaceholders(
    sanitizeInvalidStructuredSourceMarkers(params.markdown || ""),
    metadataQuoteIds,
  );
  if (!markdown) return { markdown, quoteCitations };
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    // The cooperative UI path advances this generator within a bounded slice.
    // A step covers at most one ordinary line or one complete blockquote.
    yield;
    const line = lines[index];
    if (FENCED_CODE_PATTERN.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || !/^[ \t]*>/.test(line)) {
      out.push(line);
      continue;
    }

    const blockStart = index;
    const quoteLines: string[] = [];
    if (isBlockquoteWrappedQuoteCitationLine(line)) {
      out.push(line);
      continue;
    }

    while (
      index < lines.length &&
      /^[ \t]*>/.test(lines[index]) &&
      !isBlockquoteWrappedQuoteCitationLine(lines[index])
    ) {
      quoteLines.push(stripBlockquoteMarker(lines[index]));
      index += 1;
    }
    const structuredBinding = parseStructuredBlockquoteQuoteBinding(quoteLines);
    if (structuredBinding) {
      const existingCitation = quoteCitations.find(
        (citation) => citation.id === structuredBinding.quoteCitationId,
      );
      if (!structuredBinding.quoteText) {
        if (existingCitation) {
          out.push(`[[quote:${existingCitation.id}]]`);
        }
        index -= 1;
        continue;
      }
      let reboundCitations = resolveDisplayedQuoteCitations({
        quoteText: structuredBinding.quoteText,
        citationLabel:
          existingCitation?.citationLabel ||
          structuredBinding.citationLabel ||
          "",
        sourceIndex: finalizedSourceIndex,
        preferredContextItemId: existingCitation?.contextItemId,
        preferredItemId: existingCitation?.itemId,
        preferredSourceFingerprint: existingCitation?.sourceFingerprint,
      });
      if (!reboundCitations.length && existingCitation) {
        const displayedSegments = splitQuoteAtEllipsisInOrder(
          stripOuterQuoteDelimiters(structuredBinding.quoteText),
        );
        const segments =
          displayedSegments.length > 1
            ? displayedSegments
            : [structuredBinding.quoteText];
        const reboundSegments = segments
          .map((quoteText) =>
            bindQuoteCitationToDisplayedText(existingCitation, quoteText),
          )
          .map((rebound) =>
            rebound
              ? buildQuoteCitation({
                  ...rebound,
                  id: undefined,
                  allowShortQuoteText: true,
                })
              : undefined,
          );
        const mayRepairWithoutPage =
          existingCitation.pageHintIndex !== undefined ||
          (!existingCitation.sourceMatchText &&
            !existingCitation.sourceMatchKind);
        if (
          mayRepairWithoutPage &&
          reboundSegments.every((citation): citation is QuoteCitation =>
            Boolean(citation),
          )
        ) {
          reboundCitations = reboundSegments;
        }
      }
      if (reboundCitations.length) {
        quoteCitations = mergeQuoteCitations(quoteCitations, reboundCitations);
        out.push(
          ...reboundCitations.map((citation) => `[[quote:${citation.id}]]`),
        );
      } else {
        const citationLabel =
          existingCitation?.citationLabel ||
          structuredBinding.citationLabel ||
          "";
        out.push(
          citationLabel
            ? formatPlainQuoteWithCitationMarkdown(
                structuredBinding.quoteText,
                citationLabel,
              )
            : formatPlainQuoteMarkdown(structuredBinding.quoteText),
        );
      }
      index -= 1;
      continue;
    }
    const candidate = parseSourceBackedBlockquoteCandidate({
      quoteLines,
      markdownLines: lines,
      followingLineStartIndex: index,
    });
    let quoteText = candidate.quoteText;
    let citationLabel = candidate.citationLabel;
    const adjacentQuoteCitation = findAdjacentStandaloneQuoteCitation({
      markdownLines: lines,
      followingLineStartIndex: index,
    });
    const adjacentReboundCitations = adjacentQuoteCitation
      ? resolveAdjacentManualQuoteAnchor({
          quoteText,
          quoteCitationId: adjacentQuoteCitation.quoteCitationId,
          quoteCitations,
          sourceIndex: finalizedSourceIndex,
        })
      : [];
    if (adjacentQuoteCitation && adjacentReboundCitations.length) {
      quoteCitations = mergeQuoteCitations(
        quoteCitations,
        adjacentReboundCitations,
      );
      out.push(
        ...adjacentReboundCitations.map(
          (citation) => `[[quote:${citation.id}]]`,
        ),
      );
      index = adjacentQuoteCitation.lineIndex;
      continue;
    }
    if (candidate.trailingCitation) {
      if (params.quoteSourceReview) {
        const fullQuote = finalizeQuoteSourceCandidate({
          quoteText,
          sourceIndex: finalizedSourceIndex,
          sourceEvidenceComplete:
            params.quoteSourceReview.sourceEvidenceComplete,
        });
        if (fullQuote.kind !== "absent") {
          if (fullQuote.quoteCitations?.length) {
            quoteCitations = mergeQuoteCitations(
              quoteCitations,
              fullQuote.quoteCitations,
            );
          }
          if (fullQuote.kind === "defer") {
            out.push(...lines.slice(blockStart, index));
          } else if (fullQuote.markdown) {
            out.push(fullQuote.markdown);
          }
          index -= 1;
          continue;
        }
      }
      quoteText = candidate.trailingCitation.quoteText;
      citationLabel = candidate.trailingCitation.citationLabel;
    }
    if (citationLabel) {
      if (params.quoteSourceReview) {
        const finalized = finalizeQuoteSourceCandidate({
          quoteText,
          citationRemainder: candidate.citationRemainder,
          sourceIndex: finalizedSourceIndex,
          sourceEvidenceComplete:
            params.quoteSourceReview.sourceEvidenceComplete,
        });
        if (finalized.quoteCitations?.length) {
          quoteCitations = mergeQuoteCitations(
            quoteCitations,
            finalized.quoteCitations,
          );
        }
        if (finalized.kind === "defer") {
          const rawEnd =
            candidate.consumedFollowingLineIndex !== undefined
              ? candidate.consumedFollowingLineIndex + 1
              : index;
          out.push(...lines.slice(blockStart, rawEnd));
        } else if (finalized.markdown) {
          out.push(finalized.markdown);
        }
        index = candidate.consumedFollowingLineIndex ?? index - 1;
        continue;
      }
      const finalized = finalizeSourceBackedQuoteBlock({
        quoteText,
        citationLabel,
        citationRemainder: candidate.citationRemainder,
        quoteCitations,
        sourceIndex: finalizedSourceIndex,
        fenceUnverifiedBlockquotes: params.fenceUnverifiedBlockquotes,
      });
      if (finalized.quoteCitations?.length) {
        quoteCitations = mergeQuoteCitations(
          quoteCitations,
          finalized.quoteCitations,
        );
      }
      out.push(finalized.markdown);
      index = candidate.consumedFollowingLineIndex ?? index - 1;
      continue;
    }

    if (params.quoteSourceReview && candidate.hasAmbiguousCitationDecoration) {
      out.push(...lines.slice(blockStart, index));
      index -= 1;
      continue;
    }

    if (
      isKnownQuoteMetadataText(quoteText, finalizedSourceIndex.metadataTexts)
    ) {
      out.push("");
      index -= 1;
      continue;
    }

    if (params.quoteSourceReview) {
      const finalized = finalizeQuoteSourceCandidate({
        quoteText,
        sourceIndex: finalizedSourceIndex,
        sourceEvidenceComplete: params.quoteSourceReview.sourceEvidenceComplete,
      });
      if (finalized.quoteCitations?.length) {
        quoteCitations = mergeQuoteCitations(
          quoteCitations,
          finalized.quoteCitations,
        );
      }
      if (finalized.kind === "defer") {
        out.push(...lines.slice(blockStart, index));
      } else if (finalized.markdown) {
        out.push(finalized.markdown);
      }
      index -= 1;
      continue;
    }

    const unlabeledQuoteCitations = resolveUnlabeledQuoteCitationsForFinalizer({
      quoteText,
      sourceIndex: finalizedSourceIndex,
    });
    if (unlabeledQuoteCitations.length) {
      quoteCitations = mergeQuoteCitations(
        quoteCitations,
        unlabeledQuoteCitations,
      );
      out.push(
        ...unlabeledQuoteCitations.map(
          (citation) => `[[quote:${citation.id}]]`,
        ),
      );
      index -= 1;
      continue;
    }
    const unverifiedQuoteMarkdown = formatUnverifiedQuoteWithBestSourceLabel({
      quoteText,
      sourceIndex: finalizedSourceIndex,
    });
    if (unverifiedQuoteMarkdown) {
      out.push(
        params.fenceUnverifiedBlockquotes
          ? formatFencedTextMarkdown(quoteText)
          : unverifiedQuoteMarkdown,
      );
      index -= 1;
      continue;
    }
    if (params.fenceUnverifiedBlockquotes && quoteText) {
      out.push(formatFencedTextMarkdown(quoteText));
    } else {
      out.push(...lines.slice(blockStart, index));
    }
    index -= 1;
  }
  const finalizedMarkdown = replaceQuoteCitationPlaceholdersForMarkdown(
    collapseAdjacentDuplicateQuoteCitationPlaceholders(
      normalizeSanitizedMarkdown(out.join("\n")),
    ),
    quoteCitations,
    {
      resolved: "preserve",
      unresolved: "omit",
      sanitizeSourceBackedBlocks: !params.quoteSourceReview,
    },
  );
  const cleanedMarkdown = cleanupRemovedMetadataQuoteArtifacts(
    cleanupEmptyCitationParentheticals(finalizedMarkdown),
  );
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const referencedCitationIds = new Set(
    Array.from(cleanedMarkdown.matchAll(QUOTE_CITATION_PATTERN)).map(
      (match) => match[1],
    ),
  );
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return {
    markdown: cleanedMarkdown,
    quoteCitations: filterMetadataQuoteCitations(
      mergeQuoteCitations(quoteCitations).filter((citation) =>
        referencedCitationIds.has(citation.id),
      ),
      finalizedSourceIndex.metadataTexts,
    ),
  };
}

export function finalizeAssistantQuoteCitations(
  params: AssistantQuoteCitationFinalizationParams,
): AssistantQuoteCitationFinalizationResult {
  const steps = finalizeAssistantQuoteCitationSteps(params);
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

const COOPERATIVE_QUOTE_VALIDATION_SLICE_MS = 6;

function quoteValidationNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

export async function finalizeAssistantQuoteCitationsCooperatively(
  params: AssistantQuoteCitationFinalizationParams,
  options: {
    yieldToMain: () => Promise<void>;
    shouldContinue?: () => boolean;
    now?: () => number;
    onSliceComplete?: (elapsedMs: number) => void;
  },
): Promise<AssistantQuoteCitationFinalizationResult | null> {
  const steps = finalizeAssistantQuoteCitationSteps(params);
  const now = options.now || quoteValidationNow;
  let sliceStartedAt = now();
  while (true) {
    if (options.shouldContinue?.() === false) return null;
    const step = steps.next();
    const elapsedMs = now() - sliceStartedAt;
    if (step.done) {
      options.onSliceComplete?.(elapsedMs);
      return step.value;
    }
    if (elapsedMs >= COOPERATIVE_QUOTE_VALIDATION_SLICE_MS) {
      options.onSliceComplete?.(elapsedMs);
      await options.yieldToMain();
      sliceStartedAt = now();
    }
  }
}

export function buildQuoteAnchorPromptBlock(
  quoteCitations: QuoteCitation[] | undefined | null,
): string[] {
  const normalized = normalizeQuoteCitations(quoteCitations);
  if (!normalized.length) return [];
  const lines = [
    "Verified quote anchors:",
    "- Use a quote anchor only when exact wording is useful for the answer; otherwise cite the paper in normal prose.",
    "- When you need to include one of these exact quotes, write only the matching token, e.g. [[quote:Q_x7a2]].",
    "- Do not manually copy the quote or sourceLabel when a quote anchor is available; the app will render the quote and clickable citation.",
    "- Quote text is provenance-locked source text: never translate or paraphrase it to match the user's language.",
    "- Use `>` blockquotes only for direct original source text.",
    "- If a translation, interpretation, emphasis, example, or opinion is useful, write it outside the quote block as explanation or in a fenced `text` block, not as the quoted source passage.",
    "- Use verified quote anchors only for direct article evidence; do not use them for publication metadata, DOI links, journal names, or source labels alone.",
    "- Do not write source/section/chunk metadata such as [[source=...]] in the final answer; those fields are internal context only.",
  ];
  for (const citation of normalized) {
    lines.push(
      `- Quote anchor ${citation.id}:`,
      `  quoteText: ${jsonEscape(truncateForPrompt(citation.quoteText))}`,
      `  sourceLabel: ${jsonEscape(citation.citationLabel)}`,
      `  To include this quote, write: [[quote:${citation.id}]]`,
    );
  }
  return lines;
}

export function formatQuoteCitationMarkdown(citation: QuoteCitation): string {
  return formatQuoteWithCitationInsideBlockquoteMarkdown(
    citation.displayQuoteText || citation.quoteText,
    citation.citationLabel,
  );
}

function formatQuoteWithCitationInsideBlockquoteMarkdown(
  quoteText: string,
  citationLabel: string,
): string {
  const normalizedQuote = normalizeMultilineText(quoteText);
  const normalizedCitation = normalizeCitationLabel(citationLabel);
  if (!normalizedQuote || !normalizedCitation) return "";
  const quoteLines = normalizedQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoteLines}\n>\n> ${normalizedCitation}\n\n`;
}

export type UnresolvedQuoteCitationPlaceholderMode =
  | "preserve"
  | "unavailable"
  | "omit";

function formatUnresolvedQuoteCitationPlaceholder(
  mode: UnresolvedQuoteCitationPlaceholderMode,
): string {
  if (mode === "unavailable" || mode === "omit") return "";
  return "";
}

function endsWithBlankLine(value: string): boolean {
  return /\n[ \t]*\n[ \t]*$/.test(value);
}

function endsWithLineBreak(value: string): boolean {
  return /\n[ \t]*$/.test(value);
}

function normalizeQuoteCitationPlaceholderBoundariesInSegment(
  markdown: string,
): string {
  const unwrappedMarkdown =
    unwrapBlockquoteWrappedQuoteCitationPlaceholders(markdown);
  if (!unwrappedMarkdown || !QUOTE_CITATION_PATTERN.test(unwrappedMarkdown)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return unwrappedMarkdown;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;

  let result = "";
  let cursor = 0;
  let appendedQuoteAnchor = false;
  const appendText = (text: string): void => {
    if (!text) return;
    if (!appendedQuoteAnchor) {
      result += text;
      return;
    }

    const withoutLeadingHorizontalSpace = text.replace(/^[ \t]+/, "");
    if (!withoutLeadingHorizontalSpace.trim()) {
      return;
    }
    if (/^\r?\n[ \t]*\r?\n/.test(withoutLeadingHorizontalSpace)) {
      result += withoutLeadingHorizontalSpace;
    } else if (/^\r?\n/.test(withoutLeadingHorizontalSpace)) {
      result += `\n\n${withoutLeadingHorizontalSpace.replace(/^\r?\n/, "")}`;
    } else {
      result += `\n\n${withoutLeadingHorizontalSpace}`;
    }
    appendedQuoteAnchor = false;
  };

  for (const match of unwrappedMarkdown.matchAll(QUOTE_CITATION_PATTERN)) {
    const start = match.index || 0;
    const token = match[0];
    appendText(unwrappedMarkdown.slice(cursor, start));
    result = result.replace(/[ \t]+$/, "");
    if (result.trim() && !endsWithBlankLine(result)) {
      result += endsWithLineBreak(result) ? "\n" : "\n\n";
    }
    result += token;
    appendedQuoteAnchor = true;
    cursor = start + token.length;
  }
  appendText(unwrappedMarkdown.slice(cursor));
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return result;
}

function transformMarkdownOutsideFencedCode(
  markdown: string,
  transformSegment: (segment: string) => string,
): string {
  const lines = markdown.split("\n");
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let currentIsFence = false;

  const flush = () => {
    if (!current.length) return;
    const segment = current.join("\n");
    segments.push(currentIsFence ? segment : transformSegment(segment));
    current = [];
  };

  for (const line of lines) {
    const fenceLine = FENCED_CODE_PATTERN.test(line);
    if (inFence) {
      current.push(line);
      if (fenceLine) {
        inFence = false;
        flush();
        currentIsFence = false;
      }
      continue;
    }

    if (fenceLine) {
      flush();
      currentIsFence = true;
      current.push(line);
      inFence = true;
      continue;
    }

    current.push(line);
  }
  flush();
  return segments.join("\n");
}

export function normalizeQuoteCitationPlaceholdersForDisplay(
  markdown: string,
): string {
  if (!markdown || !QUOTE_CITATION_PATTERN.test(markdown)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return markdown;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;

  return transformMarkdownOutsideFencedCode(
    markdown,
    normalizeQuoteCitationPlaceholderBoundariesInSegment,
  );
}

export function findUnresolvedQuoteCitationPlaceholderIds(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined | null,
): string[] {
  if (!markdown) return [];
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const matches = Array.from(markdown.matchAll(QUOTE_CITATION_PATTERN));
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  if (!matches.length) return [];
  const byId = new Set(
    normalizeQuoteCitations(quoteCitations).map((citation) => citation.id),
  );
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const id = match[1] || "";
    if (!id || byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    unresolved.push(id);
  }
  return unresolved;
}

export function replaceQuoteCitationPlaceholdersForMarkdown(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined | null,
  options: {
    resolved?: "markdown" | "preserve";
    unresolved?: UnresolvedQuoteCitationPlaceholderMode;
    sanitizeSourceBackedBlocks?: boolean;
  } = {},
): string {
  const sanitizedMarkdown = sanitizeInvalidStructuredSourceMarkers(markdown);
  const safeMarkdown =
    options.sanitizeSourceBackedBlocks === false
      ? sanitizedMarkdown
      : sanitizeUntrustedSourceBackedQuoteBlocks(
          sanitizedMarkdown,
          quoteCitations,
        );
  if (!safeMarkdown || !QUOTE_CITATION_PATTERN.test(safeMarkdown)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return safeMarkdown;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const byId = new Map(
    normalizeQuoteCitations(quoteCitations).map((citation) => [
      citation.id,
      citation,
    ]),
  );
  const invalidIds = collectInvalidQuoteCitationIds(quoteCitations);
  const resolved = options.resolved || "markdown";
  const unresolved = options.unresolved || "preserve";
  const shouldOmitToken = (id: string): boolean => {
    if (invalidIds.has(id)) return true;
    return !byId.has(id) && unresolved !== "preserve";
  };
  const omissionFilteredMarkdown = transformMarkdownOutsideFencedCode(
    safeMarkdown,
    (segment) => {
      BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN.lastIndex = 0;
      const withoutWrappedOmissions = segment.replace(
        BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN,
        (token, id: string) => (shouldOmitToken(id) ? "" : token),
      );
      BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN.lastIndex = 0;
      QUOTE_CITATION_PATTERN.lastIndex = 0;
      const withoutOmissions = withoutWrappedOmissions.replace(
        QUOTE_CITATION_PATTERN,
        (token, id: string) => (shouldOmitToken(id) ? "" : token),
      );
      QUOTE_CITATION_PATTERN.lastIndex = 0;
      return withoutOmissions;
    },
  );
  const replaceToken = (token: string, id: string): string => {
    const citation = byId.get(id);
    if (citation) {
      return resolved === "preserve"
        ? `[[quote:${citation.id}]]`
        : formatQuoteCitationMarkdown(citation);
    }
    if (invalidIds.has(id)) return "";
    return unresolved === "preserve"
      ? token
      : formatUnresolvedQuoteCitationPlaceholder(unresolved);
  };
  const normalizedMarkdown = normalizeQuoteCitationPlaceholdersForDisplay(
    omissionFilteredMarkdown,
  );
  const replacedMarkdown = transformMarkdownOutsideFencedCode(
    normalizedMarkdown,
    (segment) => {
      QUOTE_CITATION_PATTERN.lastIndex = 0;
      const replacedSegment = segment.replace(
        QUOTE_CITATION_PATTERN,
        replaceToken,
      );
      QUOTE_CITATION_PATTERN.lastIndex = 0;
      return replacedSegment;
    },
  );
  return cleanupEmptyCitationParentheticals(replacedMarkdown);
}

function extractFromUnknown(
  content: unknown,
  out: QuoteCitation[],
  seenObjects: WeakSet<object>,
): void {
  if (!content) return;
  if (typeof content === "string") {
    const text = content.trim();
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return;
    try {
      extractFromUnknown(JSON.parse(text), out, seenObjects);
    } catch (_err) {
      void _err;
    }
    return;
  }
  if (Array.isArray(content)) {
    for (const entry of content) extractFromUnknown(entry, out, seenObjects);
    return;
  }
  if (typeof content !== "object") return;
  if (seenObjects.has(content)) return;
  seenObjects.add(content);
  const record = content as Record<string, unknown>;
  const ownCitation = buildQuoteCitation(record);
  if (ownCitation) out.push(ownCitation);
  if (Array.isArray(record.quoteCitations)) {
    out.push(...normalizeQuoteCitations(record.quoteCitations));
  }
  for (const value of Object.values(record)) {
    extractFromUnknown(value, out, seenObjects);
  }
}

export function extractQuoteCitationsFromToolContent(
  content: unknown,
): QuoteCitation[] {
  const out: QuoteCitation[] = [];
  extractFromUnknown(content, out, new WeakSet<object>());
  return mergeQuoteCitations(out);
}

export function buildSelectedTextQuoteCitations(
  selectedTexts: readonly string[] | undefined,
  selectedTextSources: readonly SelectedTextSource[] | undefined,
  selectedTextPaperContexts:
    | readonly (PaperContextRef | undefined)[]
    | undefined,
): QuoteCitation[] {
  if (!Array.isArray(selectedTexts) || !selectedTexts.length) return [];
  const out: QuoteCitation[] = [];
  for (let index = 0; index < selectedTexts.length; index++) {
    if (selectedTextSources?.[index] !== "pdf") continue;
    const paperContext = selectedTextPaperContexts?.[index];
    if (!paperContext) continue;
    const citation = buildQuoteCitation({
      quoteText: selectedTexts[index],
      citationLabel: formatPaperSourceLabel(paperContext),
      sourceMatchKind: "selected-text",
      sourceMatchSource: "pdf-page-text",
      contextItemId: paperContext.contextItemId,
      itemId: paperContext.itemId,
    });
    if (citation) out.push(citation);
  }
  return mergeQuoteCitations(out);
}
