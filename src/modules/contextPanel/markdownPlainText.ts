import { stripWebSourceMarkersForDisplay } from "../../webAccess/attribution";
import { stripQuoteCitationAnchorsFromDisplayText } from "../../services/quotes/quoteCitations";
import { sanitizeText } from "../../utils/textSanitization";

/**
 * Project markdown to plain text. Line breaks are kept and nothing is cut,
 * so callers can pick lines or truncate as they need.
 */
export function projectMarkdownToPlainLines(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return stripQuoteCitationAnchorsFromDisplayText(
    stripWebSourceMarkersForDisplay(sanitizeText(value)),
  )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/```|~~~/g, " ")
    .replace(/[*_~`]+/g, " ");
}
