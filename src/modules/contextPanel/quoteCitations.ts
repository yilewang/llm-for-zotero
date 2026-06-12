import type {
  PaperContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "../../shared/types";
import { formatPaperSourceLabel } from "./paperAttribution";

export const QUOTE_CITATION_PATTERN = /\[\[quote:([A-Za-z0-9_-]+)\]\]/g;
const BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN =
  /^[ \t]*(?:>[ \t]*)+\[\[quote:([A-Za-z0-9_-]+)\]\][ \t]*$/gm;
const STRUCTURED_SOURCE_MARKER_PATTERN =
  /\[\[\s*source\s*=\s*([^\]]+?)\s*\]\]/gi;
const BRACKETED_SOURCE_METADATA_PATTERN = /\[\s*source\s*=\s*([^\]]+?)\s*\]/gi;
const FENCED_CODE_PATTERN = /^[ \t]*(```|~~~)/;

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
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

function normalizeCitationLabel(value: unknown): string {
  const label = normalizeText(value);
  if (!label) return "";
  if (label.startsWith("(") && label.endsWith(")")) return label;
  return `(${label.replace(/^\(+|\)+$/g, "")})`;
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

function stripPageSuffixFromCitationLabel(value: string): string {
  const label = normalizeCitationLabel(value);
  const inner = label.replace(/^\(|\)$/g, "").trim();
  const withoutPage = inner
    .replace(/,\s*(?:p\.?|pp\.?|page|pages)\s+[^,)]+$/i, "")
    .trim();
  return normalizeCitationLabel(withoutPage || inner);
}

function normalizeCitationLabelForMatch(value: unknown): string {
  return stripPageSuffixFromCitationLabel(normalizeCitationLabel(value))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSourceCitationLabel(value: string): boolean {
  const label = normalizeCitationLabel(value);
  const inner = label.replace(/^\(|\)$/g, "").trim();
  if (!inner) return false;
  if (/\b(?:19|20)\d{2}\b/.test(inner)) return true;
  if (/\bet\s+al\.?\b/i.test(inner)) return true;
  if (/\battachment\s+under\b/i.test(inner)) return true;
  return /^[\p{L}][^()]{1,160}$/u.test(inner) && /[,;&]/.test(inner);
}

function parseStandaloneCitationLabel(value: string): string | null {
  const trimmed = normalizeText(value);
  if (!/^\([^()]{2,240}\)$/.test(trimmed)) return null;
  if (!looksLikeSourceCitationLabel(trimmed)) return null;
  return normalizeCitationLabel(trimmed);
}

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]?)+/, "");
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
  return trusted ? `[[quote:${trusted.id}]]` : "";
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
    while (index < lines.length && /^[ \t]*>/.test(lines[index])) {
      quoteLines.push(stripBlockquoteMarker(lines[index]));
      index += 1;
    }
    const quoteText = normalizeMultilineText(quoteLines.join("\n"));
    let cursor = index;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;

    const citationLabel =
      cursor < lines.length ? parseStandaloneCitationLabel(lines[cursor]) : null;
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
  citationLabel?: unknown;
  contextItemId?: unknown;
  itemId?: unknown;
  id?: unknown;
}): QuoteCitation | undefined {
  const quoteText = normalizeMultilineText(input.quoteText);
  const citationLabel = normalizeCitationLabel(input.citationLabel);
  if (!quoteText || !citationLabel) return undefined;
  const contextItemId = normalizePositiveInt(input.contextItemId);
  const itemId = normalizePositiveInt(input.itemId);
  const id = normalizeText(input.id).replace(/[^A-Za-z0-9_-]/g, "");
  return {
    id:
      id ||
      buildQuoteCitationId({
        quoteText,
        citationLabel,
        contextItemId,
      }),
    quoteText,
    citationLabel,
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

export function buildQuoteAnchorPromptBlock(
  quoteCitations: QuoteCitation[] | undefined | null,
): string[] {
  const normalized = normalizeQuoteCitations(quoteCitations);
  if (!normalized.length) return [];
  const lines = [
    "Quote anchors for direct evidence:",
    "- When you need to include one of these exact quotes, write only the matching token, e.g. [[quote:Q_x7a2]].",
    "- Do not manually copy the quote or citation label when a quote anchor is available; the app will render the quote and clickable citation.",
    "- Quote text is provenance-locked source text: never translate or paraphrase it to match the user's language.",
    "- If a translation is useful, write it outside the quote block as explanation, not as the quoted source passage.",
    "- Do not write source/section/chunk metadata such as [[source=...]] in the final answer; those fields are internal context only.",
  ];
  for (const citation of normalized) {
    lines.push(
      `- Quote anchor ${citation.id}:`,
      `  quoteText: ${jsonEscape(truncateForPrompt(citation.quoteText))}`,
      `  citationLabel: ${jsonEscape(citation.citationLabel)}`,
      `  To include this quote, write: [[quote:${citation.id}]]`,
    );
  }
  return lines;
}

export function formatQuoteCitationMarkdown(citation: QuoteCitation): string {
  const quoteLines = normalizeMultilineText(citation.quoteText)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoteLines}\n\n${citation.citationLabel}`;
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
  const resolved = options.resolved || "markdown";
  const unresolved = options.unresolved || "preserve";
  const replaceToken = (token: string, id: string): string => {
    const citation = byId.get(id);
    if (citation) {
      return resolved === "preserve"
        ? `[[quote:${citation.id}]]`
        : formatQuoteCitationMarkdown(citation);
    }
    return unresolved === "preserve"
      ? token
      : formatUnresolvedQuoteCitationPlaceholder(unresolved);
  };
  const normalizedMarkdown = safeMarkdown.replace(
    BLOCKQUOTE_WRAPPED_QUOTE_CITATION_PATTERN,
    (token, id: string) => replaceToken(token, id),
  );
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return normalizedMarkdown.replace(QUOTE_CITATION_PATTERN, replaceToken);
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
      contextItemId: paperContext.contextItemId,
      itemId: paperContext.itemId,
    });
    if (citation) out.push(citation);
  }
  return mergeQuoteCitations(out);
}
