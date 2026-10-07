/**
 * The one rule for the ids inside quote and citation tokens: `[[quote:ID]]`,
 * `[[quote-occurrence:ID]]` and `[[cite:ID]]`. An id is letters, digits and
 * `. _ : -`. Host-minted ids (`Q_` and `QO_` plus base36) fit it, and so do
 * the ids a model writes for a plan document, such as `Q1.a` or `p:1`.
 *
 * Every parser, stripper and validator of these ids builds its pattern from
 * this rule, so an id one surface accepts is never cut short by another.
 */
export const QUOTE_ID_CHARSET = "A-Za-z0-9._:-";

/** Regex source for one id, for use inside a larger pattern. */
export const QUOTE_ID_SOURCE = `[${QUOTE_ID_CHARSET}]+`;

const QUOTE_ID_EXACT = new RegExp(`^${QUOTE_ID_SOURCE}$`);
const NOT_QUOTE_ID_CHARACTER = new RegExp(`[^${QUOTE_ID_CHARSET}]`, "g");

export type QuoteTokenKind = "quote" | "quote-occurrence" | "cite";

/** Whether `value` is a whole id under the rule. */
export function isQuoteTokenId(value: string): boolean {
  return QUOTE_ID_EXACT.test(value);
}

/** `value` with every character outside the rule removed. */
export function normalizeQuoteTokenId(value: string): string {
  return value.replace(NOT_QUOTE_ID_CHARACTER, "");
}

/**
 * Regex source for one `[[kind:ID]]` token. With `capture`, group 1 is the
 * id. Use it to build a larger pattern; use {@link quoteTokenPattern} for the
 * token alone.
 */
export function quoteTokenSource(
  kind: QuoteTokenKind,
  options: { capture?: boolean } = {},
): string {
  const id =
    options.capture === false ? QUOTE_ID_SOURCE : `(${QUOTE_ID_SOURCE})`;
  return `\\[\\[${kind}:${id}\\]\\]`;
}

/** A fresh `[[kind:ID]]` pattern whose group 1 is the id. */
export function quoteTokenPattern(kind: QuoteTokenKind, flags = "g"): RegExp {
  return new RegExp(quoteTokenSource(kind), flags);
}
