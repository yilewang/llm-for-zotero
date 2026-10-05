import { fnv1a32 } from "../../utils/fnv1a";
import { sanitizeText } from "../../utils/textSanitization";

/**
 * The form two quotes are compared in: sanitized, whitespace collapsed to one
 * space, trimmed, and lowercased. Stored keys are built from it, so keep it
 * as it is.
 */
export function quoteComparisonKey(text: string): string {
  return sanitizeText(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Eight hex characters of FNV-1a over the comparison key, or "" when the key
 * is empty. The citation navigation cache stores pages under this hash.
 */
export function quoteKeyHash(text: string): string {
  const key = quoteComparisonKey(text);
  if (!key) return "";
  return fnv1a32(key);
}
