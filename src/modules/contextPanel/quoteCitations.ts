import type {
  PaperContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "../../shared/types";
import { formatPaperSourceLabel } from "./paperAttribution";

export const QUOTE_CITATION_PATTERN = /\[\[quote:([A-Za-z0-9_-]+)\]\]/g;

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

export function formatQuoteCitationMarkdown(
  citation: QuoteCitation,
): string {
  const quoteLines = normalizeMultilineText(citation.quoteText)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoteLines}\n\n${citation.citationLabel}`;
}

export function replaceQuoteCitationPlaceholdersForMarkdown(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined | null,
): string {
  if (!markdown || !QUOTE_CITATION_PATTERN.test(markdown)) {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return markdown;
  }
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const byId = new Map(
    normalizeQuoteCitations(quoteCitations).map((citation) => [
      citation.id,
      citation,
    ]),
  );
  return markdown.replace(QUOTE_CITATION_PATTERN, (token, id: string) => {
    const citation = byId.get(id);
    return citation ? formatQuoteCitationMarkdown(citation) : token;
  });
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
