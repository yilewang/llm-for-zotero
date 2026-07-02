import type {
  PaperContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "../../shared/types";
import { formatPaperSourceLabel } from "./paperAttribution";
import {
  extractLocatorTokens,
  findUniqueQuoteTextSearchMatch,
  isLocatorQueryLongEnough,
  normalizeLocatorText,
  type QuoteTextSearchMatch,
} from "./quoteTextSearch";
import {
  buildQuoteTextIndex,
  countCanonicalTextMatches,
  findCanonicalQuoteSourceSpan,
} from "./quoteTextNormalization";
import { stripLeadingCitationSeparators } from "./citationText";
import {
  citationLabelsCompatible,
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
const SOURCE_QUOTE_ELLIPSIS_PATTERN =
  /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/;
const SOURCE_QUOTE_ELLIPSIS_PATTERN_G =
  /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/g;
const SOURCE_QUOTE_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const NON_SOURCE_TRAILING_LABEL_PATTERN =
  /^([\s\S]*?)\s*(\([^()\n]{1,240}\))\s*([.!?。！？]*)$/;

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

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
}

function normalizeQuoteMatchSource(
  value: unknown,
): QuoteCitation["sourceMatchSource"] | undefined {
  return value === "context-text" || value === "pdf-page-text"
    ? value
    : undefined;
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

export function isQuoteWorthySourceText(value: unknown): boolean {
  const text = normalizeQuoteTextForMatch(value);
  if (!text) return false;
  const strippedOuter = text.replace(/^["“”]+|["“”]+$/g, "").trim();
  if (!strippedOuter) return false;
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
  if (!hasUrlOrDoi) return true;

  const withoutLocators = text
    .replace(URL_TEXT_PATTERN, " ")
    .replace(DOI_TEXT_PATTERN, " ")
    .replace(DOI_DOMAIN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const locatorChars = mergedRangeLength(locatorRanges);
  if (withoutLocators.length < 80) return false;
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

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]?)+/, "");
}

function isBlockquoteWrappedQuoteCitationLine(line: string): boolean {
  return BLOCKQUOTE_WRAPPED_QUOTE_CITATION_LINE_PATTERN.test(line);
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

function splitTrailingCitationFromQuoteText(value: string): {
  quoteText: string;
  citationLabel: string;
} | null {
  const text = normalizeMultilineText(value);
  const match = text.match(/^([\s\S]*?)\s+(\([^()\n]{2,240}\))$/);
  if (!match) return null;
  const citationLabel = parseStandaloneCitationLabel(match[2] || "");
  const quoteText = normalizeMultilineText(match[1] || "");
  if (!citationLabel || !quoteText) return null;
  return { quoteText, citationLabel };
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
    const quoteText = normalizeMultilineText(quoteLines.join("\n"));
    let cursor = index;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;

    const citationLabel =
      cursor < lines.length
        ? parseStandaloneCitationLabel(lines[cursor])
        : null;
    if (citationLabel) {
      const replacement = replacementForSourceBackedQuote({
        quoteText,
        citationLabel,
        quoteCitations,
      });
      if (replacement) out.push(replacement);
      index = cursor;
      continue;
    }

    const tail = splitTrailingCitationFromQuoteText(quoteText);
    if (tail) {
      const replacement = replacementForSourceBackedQuote({
        quoteText: tail.quoteText,
        citationLabel: tail.citationLabel,
        quoteCitations,
      });
      if (replacement) out.push(replacement);
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
  contextItemId?: unknown;
  itemId?: unknown;
  id?: unknown;
}): QuoteCitation | undefined {
  const quoteText = normalizeMultilineText(input.quoteText);
  const citationLabel = normalizeCitationLabel(
    input.sourceLabel || input.citationLabel,
  );
  if (
    !quoteText ||
    !citationLabel ||
    !isQuoteWorthySourceText(quoteText) ||
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
  const displayQuoteText = normalizeMultilineText(input.displayQuoteText);
  const sourceMatchText = normalizeText(input.sourceMatchText);
  const sourceMatchKind = normalizeText(input.sourceMatchKind);
  const normalizedSourceMatchKind = [
    "trusted",
    "exact",
    "ellipsis-segment",
    "raw-prefix",
    "raw-suffix",
    "raw-middle",
    "progressive",
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
    displayQuoteText: displayQuoteText || undefined,
    citationLabel,
    sourceMatchText: sourceMatchText || undefined,
    sourceMatchKind: normalizedSourceMatchKind,
    sourceMatchSource: normalizeQuoteMatchSource(input.sourceMatchSource),
    contextItemId,
    itemId,
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
  const seen = new Set<string>();
  for (const group of groups) {
    for (const citation of normalizeQuoteCitations(group)) {
      if (seen.has(citation.id)) continue;
      seen.add(citation.id);
      out.push(citation);
    }
  }
  return out;
}

export type QuoteSourceText = {
  text?: unknown;
  sourceText?: unknown;
  citationLabel?: unknown;
  sourceLabel?: unknown;
  metadataTexts?: unknown;
  sourceMatchSource?: unknown;
  contextItemId?: unknown;
  itemId?: unknown;
};

export type QuoteSourceIndexEntry = {
  sourceText: string;
  citationLabel: string;
  sourceMatchSource?: QuoteCitation["sourceMatchSource"];
  contextItemId?: number;
  itemId?: number;
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
      (source) => !unverifiedSourceKeys.has(quoteSourceKey(source)),
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
    normalizeQuoteTextForMatch(source.sourceText).toLowerCase(),
  ].join("\u241f");
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
  const seen = new Set<string>();
  const pushSource = (entry: QuoteSourceIndexEntry | undefined) => {
    if (
      !entry?.sourceText ||
      !isCanonicalQuoteSourceLabel(entry.citationLabel)
    ) {
      return;
    }
    const key = quoteSourceKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(entry);
  };
  for (const citation of quoteCitations) {
    pushSource({
      sourceText: citation.quoteText,
      citationLabel: citation.citationLabel,
      sourceMatchSource: citation.sourceMatchSource,
      contextItemId: citation.contextItemId,
      itemId: citation.itemId,
    });
  }
  for (const source of sourceTexts) {
    const sourceText = normalizeMultilineText(source.sourceText || source.text);
    const citationLabel = normalizeCitationLabel(
      source.sourceLabel || source.citationLabel,
    );
    if (!sourceText || !citationLabel) continue;
    pushSource({
      sourceText,
      citationLabel,
      sourceMatchSource: normalizeQuoteMatchSource(source.sourceMatchSource),
      contextItemId: normalizePositiveInt(source.contextItemId),
      itemId: normalizePositiveInt(source.itemId),
    });
  }
  return { quoteCitations, sources, metadataTexts: [...metadataTextSet] };
}

export function stripTrailingNonSourceQuoteLabelFromQuoteText(
  value: string,
): string {
  const normalized = normalizeMultilineText(value);
  const match = normalized.match(NON_SOURCE_TRAILING_LABEL_PATTERN);
  if (!match) return normalized;
  const label = match[2] || "";
  if (!isNonSourceQuoteLabel(label)) return normalized;
  return normalizeMultilineText(match[1] || "");
}

function stripOuterQuoteDelimiters(value: string): string {
  return normalizeMultilineText(value)
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

function countNormalizedSourceOccurrences(text: string, query: string): number {
  return countCanonicalTextMatches(text, query);
}

function findNormalizedSourceSpanMatch(params: {
  quoteText: string;
  sourceText: string;
}):
  | {
      quoteText: string;
      normalizedQuery: string;
      sourceQuoteText?: string;
    }
  | undefined {
  const quoteText = stripOuterQuoteDelimiters(params.quoteText);
  const normalizedQuery = normalizeLocatorText(quoteText);
  if (!isLocatorQueryLongEnough(normalizedQuery, 24)) return undefined;
  const sourceIndex = buildQuoteTextIndex(params.sourceText);
  if (
    countNormalizedSourceOccurrences(
      sourceIndex.canonicalText,
      normalizedQuery,
    ) < 1
  ) {
    return undefined;
  }
  const sourceText = normalizeMultilineText(params.sourceText);
  if (sourceText.includes(quoteText)) return undefined;
  const sourceSpan = findCanonicalQuoteSourceSpan(sourceIndex, quoteText);
  return { quoteText, normalizedQuery, sourceQuoteText: sourceSpan?.text };
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

type QuoteSourceSearchMatch = {
  source: QuoteSourceIndexEntry;
  sourceText: string;
  match: QuoteTextSearchMatch;
};

type SourceQuoteTokenSpan = {
  token: string;
  start: number;
  end: number;
};

function locatorTokens(value: string): string[] {
  return extractLocatorTokens(value);
}

function buildSourceQuoteTokenSpans(value: string): SourceQuoteTokenSpan[] {
  const text = normalizeMultilineText(value);
  return Array.from(text.matchAll(SOURCE_QUOTE_TOKEN_PATTERN))
    .map((match) => {
      const token = locatorTokens(match[0] || "")[0] || "";
      const start = match.index || 0;
      return {
        token,
        start,
        end: start + (match[0] || "").length,
      };
    })
    .filter((span) => Boolean(span.token));
}

function findTokenSequenceOccurrences(
  spans: SourceQuoteTokenSpan[],
  queryTokens: string[],
): number[] {
  if (
    !spans.length ||
    !queryTokens.length ||
    queryTokens.length > spans.length
  ) {
    return [];
  }
  const starts: number[] = [];
  const firstToken = queryTokens[0];
  for (let start = 0; start <= spans.length - queryTokens.length; start += 1) {
    if (spans[start].token !== firstToken) continue;
    let matched = true;
    for (let offset = 1; offset < queryTokens.length; offset += 1) {
      if (spans[start + offset].token !== queryTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) starts.push(start);
  }
  return starts;
}

function expandSourceQuoteSpanStart(sourceText: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && "\"'“‘([".includes(sourceText[cursor - 1])) {
    cursor -= 1;
  }
  return cursor;
}

function expandSourceQuoteSpanEnd(sourceText: string, end: number): number {
  let cursor = end;
  while (
    cursor < sourceText.length &&
    /[.,;:!?"'”’)\]}。！？、，；：]/.test(sourceText[cursor])
  ) {
    cursor += 1;
  }
  return cursor;
}

function expandSourceQuoteSpanToSentenceStart(
  sourceText: string,
  start: number,
): number {
  let cursor = start;
  while (
    cursor > 0 &&
    !/[.!?。！？]\s/.test(sourceText.slice(cursor - 1, cursor + 1))
  ) {
    cursor -= 1;
  }
  while (cursor < sourceText.length && /\s/.test(sourceText[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function expandSourceQuoteSpanToSentenceEnd(
  sourceText: string,
  end: number,
): number {
  let cursor = end;
  while (
    cursor < sourceText.length &&
    !/[.!?。！？]/.test(sourceText[cursor])
  ) {
    cursor += 1;
  }
  if (cursor < sourceText.length) cursor += 1;
  return cursor;
}

function findBestSourceQuoteSpan(params: {
  quoteText: string;
  sourceText: string;
  queryText: string;
  expandToSentence?: boolean;
}): string {
  const queryTokens = locatorTokens(params.queryText);
  if (!queryTokens.length) return "";
  const quoteText = normalizeMultilineText(params.quoteText);
  const sourceText = normalizeMultilineText(params.sourceText);
  const quoteSpans = buildSourceQuoteTokenSpans(quoteText);
  const sourceSpans = buildSourceQuoteTokenSpans(sourceText);
  const quoteStarts = findTokenSequenceOccurrences(quoteSpans, queryTokens);
  const sourceStarts = findTokenSequenceOccurrences(sourceSpans, queryTokens);
  if (!quoteStarts.length || !sourceStarts.length) return "";

  let best:
    | {
        tokenCount: number;
        charLength: number;
        text: string;
      }
    | undefined;
  for (const quoteStart of quoteStarts) {
    for (const sourceStart of sourceStarts) {
      let left = 0;
      while (
        quoteStart - left - 1 >= 0 &&
        sourceStart - left - 1 >= 0 &&
        quoteSpans[quoteStart - left - 1].token ===
          sourceSpans[sourceStart - left - 1].token
      ) {
        left += 1;
      }

      let right = queryTokens.length;
      while (
        quoteStart + right < quoteSpans.length &&
        sourceStart + right < sourceSpans.length &&
        quoteSpans[quoteStart + right].token ===
          sourceSpans[sourceStart + right].token
      ) {
        right += 1;
      }

      const firstSourceToken = sourceSpans[sourceStart - left];
      const lastSourceToken = sourceSpans[sourceStart + right - 1];
      const sourceStartIndex = expandSourceQuoteSpanStart(
        sourceText,
        firstSourceToken.start,
      );
      const sourceEndIndex = expandSourceQuoteSpanEnd(
        sourceText,
        lastSourceToken.end,
      );
      const expandedStart = params.expandToSentence
        ? expandSourceQuoteSpanToSentenceStart(sourceText, sourceStartIndex)
        : sourceStartIndex;
      const expandedEnd = params.expandToSentence
        ? expandSourceQuoteSpanToSentenceEnd(sourceText, sourceEndIndex)
        : sourceEndIndex;
      const text = normalizeMultilineText(
        sourceText.slice(expandedStart, expandedEnd),
      );
      if (!text) continue;
      const tokenCount = left + right;
      const charLength = normalizeLocatorText(text).length;
      if (
        !best ||
        tokenCount > best.tokenCount ||
        (tokenCount === best.tokenCount && charLength > best.charLength)
      ) {
        best = { tokenCount, charLength, text };
      }
    }
  }
  return best?.text || "";
}

function stripSourceQuoteBoundaryEllipsis(value: string): string {
  return normalizeMultilineText(value)
    .replace(
      new RegExp("^\\s*" + SOURCE_QUOTE_ELLIPSIS_PATTERN.source + "\\s*"),
      "",
    )
    .replace(
      new RegExp("\\s*" + SOURCE_QUOTE_ELLIPSIS_PATTERN.source + "\\s*$"),
      "",
    )
    .trim();
}

function splitSourceQuoteEllipsisSegments(value: string): string[] {
  const cleaned = stripSourceQuoteBoundaryEllipsis(value);
  if (!SOURCE_QUOTE_ELLIPSIS_PATTERN.test(cleaned)) return [];
  return cleaned
    .split(SOURCE_QUOTE_ELLIPSIS_PATTERN_G)
    .map((segment) => normalizeMultilineText(segment))
    .filter((segment) => isLocatorQueryLongEnough(segment, 24));
}

function reconstructSourceConfirmedQuoteText(params: {
  quoteText: string;
  sourceText: string;
  match?: QuoteTextSearchMatch;
}): string {
  const ellipsisSegments = splitSourceQuoteEllipsisSegments(params.quoteText);
  if (ellipsisSegments.length) {
    const confirmedSegments = ellipsisSegments
      .map((segment) =>
        findBestSourceQuoteSpan({
          quoteText: segment,
          sourceText: params.sourceText,
          queryText: segment,
          expandToSentence: true,
        }),
      )
      .filter(Boolean);
    if (confirmedSegments.length) {
      return normalizeMultilineText(confirmedSegments.join(" ... "));
    }
  }

  return findBestSourceQuoteSpan({
    quoteText: params.quoteText,
    sourceText: params.sourceText,
    queryText: params.match?.query || params.quoteText,
    expandToSentence:
      params.match?.matchKind === "raw-middle" ||
      params.match?.matchKind === "progressive",
  });
}

function quoteSourceIdentityKey(
  source: QuoteSourceIndexEntry,
  ordinal: number,
): string {
  const contextItemId = normalizePositiveInt(source.contextItemId);
  const itemId = normalizePositiveInt(source.itemId);
  const identitySuffix =
    contextItemId || itemId
      ? `${contextItemId || ""}\u241f${itemId || ""}`
      : `anon:${ordinal}:${hashBase36(
          normalizeQuoteTextForMatch(source.sourceText).toLowerCase(),
        )}`;
  return [
    normalizeCitationLabelForMatch(source.citationLabel),
    identitySuffix,
  ].join("\u241f");
}

function quoteSourceMatchesRequestedLabel(
  source: QuoteSourceIndexEntry,
  requestedLabel: string,
): boolean {
  return citationLabelsCompatible(source.citationLabel, requestedLabel);
}

function findUniqueQuoteSourceMatch(params: {
  quoteText: string;
  citationLabel?: string | null;
  sourceIndex: QuoteSourceIndex;
}): QuoteSourceSearchMatch | undefined {
  const citationLabel = params.citationLabel
    ? normalizeCitationLabel(params.citationLabel)
    : "";
  const searchSources = (
    sources: QuoteSourceIndexEntry[],
  ): QuoteSourceSearchMatch | undefined => {
    const groupedSources = new Map<
      string,
      { source: QuoteSourceIndexEntry; texts: string[] }
    >();
    sources.forEach((source, ordinal) => {
      const key = quoteSourceIdentityKey(source, ordinal);
      const existing = groupedSources.get(key);
      if (existing) {
        existing.texts.push(source.sourceText);
        return;
      }
      groupedSources.set(key, { source, texts: [source.sourceText] });
    });
    const entries = Array.from(groupedSources.entries()).map(([id, group]) => ({
      id,
      text: group.texts.join("\n\n"),
      debugLabel: group.source.citationLabel,
    }));
    const match = findUniqueQuoteTextSearchMatch(entries, params.quoteText, {
      minQueryLength: 24,
      maxSameEntryOccurrences: 8,
      rejectWeakQueries: true,
      includeProgressiveQueries: true,
      debugLabel: "Quote source",
    });
    if (!match) return undefined;
    const group = groupedSources.get(match.entryId);
    return group
      ? { source: group.source, sourceText: group.texts.join("\n\n"), match }
      : undefined;
  };

  if (citationLabel) {
    const labelCompatibleSources = params.sourceIndex.sources.filter((source) =>
      quoteSourceMatchesRequestedLabel(source, citationLabel),
    );
    const labelCompatibleMatch = searchSources(labelCompatibleSources);
    if (labelCompatibleMatch) return labelCompatibleMatch;
  }

  return searchSources(params.sourceIndex.sources);
}

function buildTrustedQuoteCitationFromSource(params: {
  quoteText: string;
  source: QuoteSourceIndexEntry;
  sourceText: string;
  match?: QuoteTextSearchMatch;
}): QuoteCitation | undefined {
  const inputQuoteText = stripTrailingNonSourceQuoteLabelFromQuoteText(
    params.quoteText,
  );
  const normalizedSpanMatch = findNormalizedSourceSpanMatch({
    quoteText: inputQuoteText,
    sourceText: params.sourceText,
  });
  if (normalizedSpanMatch) {
    if (
      params.source.sourceMatchSource === "pdf-page-text" &&
      params.match?.matchKind === "exact"
    ) {
      return buildQuoteCitation({
        quoteText: normalizeMultilineText(inputQuoteText),
        citationLabel: params.source.citationLabel,
        sourceMatchText: normalizedSpanMatch.normalizedQuery,
        sourceMatchKind: "normalized-span",
        sourceMatchSource: "pdf-page-text",
        contextItemId: params.source.contextItemId,
        itemId: params.source.itemId,
      });
    }
    const sourceQuoteText =
      normalizedSpanMatch.sourceQuoteText ||
      findBestSourceQuoteSpan({
        quoteText: normalizedSpanMatch.quoteText,
        sourceText: params.sourceText,
        queryText: normalizedSpanMatch.normalizedQuery,
      });
    const normalizedDisplayQuote = normalizeLocatorText(
      normalizedSpanMatch.quoteText,
    );
    const normalizedSourceQuote = normalizeLocatorText(sourceQuoteText);
    const quoteText =
      sourceQuoteText &&
      normalizedSourceQuote.length >= normalizedDisplayQuote.length * 0.75
        ? sourceQuoteText
        : normalizedSpanMatch.quoteText;
    return buildQuoteCitation({
      quoteText,
      displayQuoteText:
        quoteText !== normalizedSpanMatch.quoteText
          ? normalizedSpanMatch.quoteText
          : undefined,
      citationLabel: params.source.citationLabel,
      sourceMatchText: normalizedSpanMatch.normalizedQuery,
      sourceMatchKind: "normalized-span",
      sourceMatchSource: params.source.sourceMatchSource || "context-text",
      contextItemId: params.source.contextItemId,
      itemId: params.source.itemId,
    });
  }
  const quoteText =
    params.source.sourceMatchSource === "pdf-page-text" &&
    params.match?.matchKind === "exact"
      ? normalizeMultilineText(inputQuoteText)
      : reconstructSourceConfirmedQuoteText({
          quoteText: inputQuoteText,
          sourceText: params.sourceText,
          match: params.match,
        });
  if (!quoteText) return undefined;
  const normalizedSourceMatchText = normalizeLocatorText(quoteText);
  const normalizedOriginalMatchText = normalizeLocatorText(
    params.match?.query || "",
  );
  return buildQuoteCitation({
    quoteText,
    displayQuoteText:
      params.source.sourceMatchSource === "pdf-page-text" &&
      normalizeMultilineText(inputQuoteText) !== quoteText
        ? inputQuoteText
        : undefined,
    citationLabel: params.source.citationLabel,
    sourceMatchText:
      normalizedSourceMatchText.length > normalizedOriginalMatchText.length
        ? normalizedSourceMatchText
        : params.match?.query,
    sourceMatchKind: params.match?.matchKind,
    sourceMatchSource: params.source.sourceMatchSource || "context-text",
    contextItemId: params.source.contextItemId,
    itemId: params.source.itemId,
  });
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

function resolveQuoteCitationForFinalizer(params: {
  quoteText: string;
  citationLabel: string;
  quoteCitations: QuoteCitation[];
  sourceIndex: QuoteSourceIndex;
}): QuoteCitation | undefined {
  const quoteText = stripTrailingNonSourceQuoteLabelFromQuoteText(
    params.quoteText,
  );
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return undefined;
  }
  if (!isNonSourceQuoteLabel(params.citationLabel)) {
    const trusted = findMatchingTrustedQuoteCitation({
      quoteText,
      citationLabel: params.citationLabel,
      quoteCitations: params.quoteCitations,
    });
    if (trusted && isCanonicalQuoteSourceLabel(trusted.citationLabel)) {
      return trusted;
    }
  }
  const sourceMatch = findUniqueQuoteSourceMatch({
    quoteText,
    citationLabel: isNonSourceQuoteLabel(params.citationLabel)
      ? null
      : params.citationLabel,
    sourceIndex: params.sourceIndex,
  });
  return sourceMatch
    ? buildTrustedQuoteCitationFromSource({
        quoteText,
        source: sourceMatch.source,
        sourceText: sourceMatch.sourceText,
        match: sourceMatch.match,
      })
    : undefined;
}

function resolveUnlabeledQuoteCitationForFinalizer(params: {
  quoteText: string;
  sourceIndex: QuoteSourceIndex;
}): QuoteCitation | undefined {
  const quoteText = stripTrailingNonSourceQuoteLabelFromQuoteText(
    params.quoteText,
  );
  if (isKnownQuoteMetadataText(quoteText, params.sourceIndex.metadataTexts)) {
    return undefined;
  }
  const sourceMatch = findUniqueQuoteSourceMatch({
    quoteText,
    sourceIndex: params.sourceIndex,
  });
  return sourceMatch
    ? buildTrustedQuoteCitationFromSource({
        quoteText,
        source: sourceMatch.source,
        sourceText: sourceMatch.sourceText,
        match: sourceMatch.match,
      })
    : undefined;
}

function finalizeSourceBackedQuoteBlock(params: {
  quoteText: string;
  citationLabel: string;
  citationRemainder?: string;
  quoteCitations: QuoteCitation[];
  sourceIndex: QuoteSourceIndex;
}): {
  markdown: string;
  quoteCitation?: QuoteCitation;
  consumedCitation: boolean;
} {
  const quoteText = stripTrailingNonSourceQuoteLabelFromQuoteText(
    params.quoteText,
  );
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
        hasCanonicalSourceLabel
          ? formatPlainQuoteWithCitationMarkdown(
              quoteText,
              params.citationLabel,
            )
          : formatPlainQuoteMarkdown(quoteText)
      }${citationRemainder ? `\n\n${citationRemainder}` : ""}`,
      consumedCitation: true,
    };
  }
  const quoteCitation = resolveQuoteCitationForFinalizer(params);
  if (quoteCitation) {
    return {
      markdown: `[[quote:${quoteCitation.id}]]${
        citationRemainder ? `\n\n${citationRemainder}` : ""
      }`,
      quoteCitation,
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

export function finalizeAssistantQuoteCitations(params: {
  markdown: string;
  quoteCitations?: QuoteCitation[] | undefined | null;
  sourceIndex?: QuoteSourceIndex | undefined | null;
  requireVerifiedQuoteCitations?: boolean;
}): { markdown: string; quoteCitations: QuoteCitation[] } {
  const sourceIndex =
    params.sourceIndex ||
    buildQuoteSourceIndex({ quoteCitations: params.quoteCitations });
  const inputQuoteCitations = mergeQuoteCitations(
    params.quoteCitations,
    sourceIndex.quoteCitations,
  );
  const finalizedSourceIndex = params.requireVerifiedQuoteCitations
    ? filterUnverifiedQuoteCitationSources({
        sourceIndex,
        quoteCitations: inputQuoteCitations,
      })
    : sourceIndex;
  const mergedQuoteCitations = params.requireVerifiedQuoteCitations
    ? filterVerifiedQuoteCitations(inputQuoteCitations)
    : mergeQuoteCitations(
        params.quoteCitations,
        finalizedSourceIndex.quoteCitations,
      );
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
    const originalQuoteText = normalizeMultilineText(quoteLines.join("\n"));
    let quoteText =
      stripTrailingNonSourceQuoteLabelFromQuoteText(originalQuoteText);

    const trailingLabel = quoteLines.length
      ? extractLeadingParentheticalLabel(quoteLines[quoteLines.length - 1])
      : null;
    if (
      trailingLabel &&
      !trailingLabel.remainder &&
      (isNonSourceQuoteLabel(trailingLabel.label) ||
        isCanonicalQuoteSourceLabel(trailingLabel.label))
    ) {
      quoteText = stripTrailingNonSourceQuoteLabelFromQuoteText(
        normalizeMultilineText(quoteLines.slice(0, -1).join("\n")),
      );
      if (quoteText) {
        const finalized = finalizeSourceBackedQuoteBlock({
          quoteText,
          citationLabel: trailingLabel.label,
          quoteCitations,
          sourceIndex: finalizedSourceIndex,
        });
        if (finalized.quoteCitation) {
          quoteCitations = mergeQuoteCitations(quoteCitations, [
            finalized.quoteCitation,
          ]);
        }
        out.push(finalized.markdown);
        continue;
      }
    }

    let cursor = index;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    const leadingLabel =
      cursor < lines.length
        ? extractLeadingParentheticalLabel(lines[cursor])
        : null;
    if (
      leadingLabel &&
      (isNonSourceQuoteLabel(leadingLabel.label) ||
        isCanonicalQuoteSourceLabel(leadingLabel.label))
    ) {
      const finalized = finalizeSourceBackedQuoteBlock({
        quoteText,
        citationLabel: leadingLabel.label,
        citationRemainder: leadingLabel.remainder,
        quoteCitations,
        sourceIndex: finalizedSourceIndex,
      });
      if (finalized.quoteCitation) {
        quoteCitations = mergeQuoteCitations(quoteCitations, [
          finalized.quoteCitation,
        ]);
      }
      out.push(finalized.markdown);
      index = cursor;
      continue;
    }

    if (
      isKnownQuoteMetadataText(quoteText, finalizedSourceIndex.metadataTexts)
    ) {
      out.push("");
      index -= 1;
      continue;
    }

    const unlabeledQuoteCitation = resolveUnlabeledQuoteCitationForFinalizer({
      quoteText,
      sourceIndex: finalizedSourceIndex,
    });
    if (unlabeledQuoteCitation) {
      quoteCitations = mergeQuoteCitations(quoteCitations, [
        unlabeledQuoteCitation,
      ]);
      out.push(`[[quote:${unlabeledQuoteCitation.id}]]`);
      index -= 1;
      continue;
    }
    const unverifiedQuoteMarkdown = formatUnverifiedQuoteWithBestSourceLabel({
      quoteText,
      sourceIndex: finalizedSourceIndex,
    });
    if (unverifiedQuoteMarkdown) {
      out.push(unverifiedQuoteMarkdown);
      index -= 1;
      continue;
    }
    if (quoteText && quoteText !== originalQuoteText) {
      out.push(formatPlainQuoteMarkdown(quoteText));
      index -= 1;
      continue;
    }

    out.push(...lines.slice(blockStart, index));
    index -= 1;
  }
  const finalizedMarkdown = replaceQuoteCitationPlaceholdersForMarkdown(
    collapseAdjacentDuplicateQuoteCitationPlaceholders(
      normalizeSanitizedMarkdown(out.join("\n")),
    ),
    quoteCitations,
    { resolved: "preserve", unresolved: "omit" },
  );
  return {
    markdown: cleanupRemovedMetadataQuoteArtifacts(
      cleanupEmptyCitationParentheticals(finalizedMarkdown),
    ),
    quoteCitations: filterMetadataQuoteCitations(
      mergeQuoteCitations(quoteCitations),
      finalizedSourceIndex.metadataTexts,
    ),
  };
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
  } = {},
): string {
  const safeMarkdown = sanitizeUntrustedSourceBackedQuoteBlocks(
    sanitizeInvalidStructuredSourceMarkers(markdown),
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
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
      contextItemId: paperContext.contextItemId,
      itemId: paperContext.itemId,
    });
    if (citation) out.push(citation);
  }
  return mergeQuoteCitations(out);
}
