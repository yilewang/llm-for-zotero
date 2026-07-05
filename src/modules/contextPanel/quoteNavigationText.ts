import type { QuoteCitation } from "../../shared/types";
import { sanitizeText } from "./textUtils";

function normalizeQuoteNavigationKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeQuoteCitationNavigationText(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const stripped = stripLeadingQuoteNavigationHeading(sanitizeText(raw));
  return stripped
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingQuoteNavigationHeading(value: string): string {
  const text = value.trim();
  const markdownHeading = text.match(/^\s{0,3}#{1,6}\s+[^\n]+\n+([\s\S]+)$/);
  if (markdownHeading?.[1]?.trim()) return markdownHeading[1].trim();
  const lines = text.split(/\n+/);
  const firstLine = (lines[0] || "").trim();
  const rest = lines.slice(1).join("\n").trim();
  if (!rest || rest.length < 80) return text;
  const sectionHeadingLike =
    /^(?:\d+(?:\.\d+)*\.?\s+)?[A-Z][\p{L}\p{N}\s:,&/()'-]{1,80}$/u.test(
      firstLine,
    ) && !/[.!?。！？]$/.test(firstLine);
  return sectionHeadingLike ? rest : text;
}

function normalizeQuoteNavigationComparisonKey(value: string): string {
  return normalizeQuoteNavigationKey(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasShortPrefixBeforeQuoteLookupText(
  sourceMatchText: string,
  quoteText: string,
): boolean {
  const source = normalizeQuoteNavigationComparisonKey(sourceMatchText);
  const quote = normalizeQuoteNavigationComparisonKey(quoteText);
  if (!source || !quote || source === quote) return false;
  if (!source.endsWith(quote)) return false;
  const prefix = source.slice(0, source.length - quote.length).trim();
  const prefixWords = prefix.split(/\s+/).filter(Boolean);
  return prefixWords.length > 0 && prefixWords.length <= 8;
}

function isLowCoverageQuoteLocator(
  locatorText: string,
  quoteText: string,
): boolean {
  const locator = normalizeQuoteNavigationComparisonKey(locatorText);
  const quote = normalizeQuoteNavigationComparisonKey(quoteText);
  if (!locator || !quote || locator === quote) return false;
  if (!quote.includes(locator)) return false;
  const locatorWords = locator.split(/\s+/).filter(Boolean).length;
  const quoteWords = quote.split(/\s+/).filter(Boolean).length;
  return (
    locator.length < quote.length * 0.45 ||
    locatorWords < Math.max(8, Math.floor(quoteWords * 0.45))
  );
}

export function resolveQuoteCitationLookupText(
  citation: QuoteCitation,
): string {
  const quoteText = normalizeQuoteCitationNavigationText(citation.quoteText);
  const sourceMatchText = normalizeQuoteCitationNavigationText(
    citation.sourceMatchText,
  );
  if (!sourceMatchText) return quoteText;
  if (!quoteText) return sourceMatchText;
  if (hasShortPrefixBeforeQuoteLookupText(sourceMatchText, quoteText)) {
    return quoteText;
  }
  return isLowCoverageQuoteLocator(sourceMatchText, quoteText)
    ? quoteText
    : sourceMatchText;
}
