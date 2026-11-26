import { collapseWhitespace } from "../core/values";
/**
 * A tokenizer-free estimate of how many tokens a piece of text is worth.
 *
 * WHY THIS EXISTS
 *
 * The usage ledger reconstructs turns from before it shipped
 * (`./usageHistoryBackfill.ts`). Those turns stored the assistant's answer as
 * text but never stored an output-token count, so the only honest way to show
 * anything at all is to estimate from the text that IS stored -- and say so.
 *
 * WHAT IT IS, AND WHAT IT IS NOT
 *
 * This is a HEURISTIC, not a tokenizer. Every provider tokenizes differently,
 * the plugin ships no BPE tables, and running one inside Zotero chrome for a
 * year of chat history would be slow. The rule is deliberately crude:
 *
 *   - A CJK character (Han, Hiragana, Katakana, Hangul) counts as ~1 token.
 *     Real tokenizers land near 1-1.5 tokens per character for these scripts.
 *   - Every other character counts as ~1/4 token, the familiar
 *     four-characters-per-token rule of thumb for English prose, which also
 *     lands in the right neighbourhood for code and markdown.
 *   - Whitespace-only or empty text is worth 0 tokens; anything with content
 *     is worth at least 1, because no answer costs nothing.
 *
 * Expect it to be within a few tens of percent of the billed count, not
 * exact. Every number derived from it must be labelled an estimate in the UI.
 * Nothing here ever overwrites a count a provider actually reported.
 *
 * WHAT COUNTS AS OUTPUT
 *
 * A reasoning model's hidden thinking is billed as output, so the estimate
 * covers the answer text AND the stored reasoning (`collectAssistantOutputTexts`
 * below). Leaving it out would under-report a thinking-heavy year by the
 * largest part of its real cost.
 */

/**
 * One CJK character. `u` (not `g`) on the single-character form so `.test()`
 * carries no `lastIndex`; the `g` form below is used only for counting.
 */
const CJK_CHARACTERS_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * A UTF-16 surrogate pair: two code units that are ONE character. Counting
 * `text.length` alone would charge an emoji or an astral Han character twice.
 */
const SURROGATE_PAIR_PATTERN = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/** Characters per token for everything that is not CJK. */
const CHARACTERS_PER_TOKEN = 4;

function countMatches(text: string, pattern: RegExp): number {
  // A fresh scan each time: the shared `g` patterns must not carry state
  // between calls, so `lastIndex` is reset before use.
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  pattern.lastIndex = 0;
  return count;
}

/**
 * Estimate the token cost of a single piece of text.
 *
 * Heuristic; see the module comment. Always a non-negative integer.
 */
export function estimateTokensFromText(text: string): number {
  if (typeof text !== "string" || !text.trim()) return 0;
  const surrogatePairs = countMatches(text, SURROGATE_PAIR_PATTERN);
  // Code points, not UTF-16 units: an astral character is one character.
  const characters = text.length - surrogatePairs;
  const cjk = countMatches(text, CJK_CHARACTERS_PATTERN);
  const other = Math.max(0, characters - cjk);
  const estimate = cjk + other / CHARACTERS_PER_TOKEN;
  // Text that has content is never free, so a very short answer still costs a
  // token instead of rounding down to nothing.
  return Math.max(1, Math.round(estimate));
}

/**
 * Estimate a group of texts -- typically every assistant message in one turn.
 *
 * Summed per message rather than estimated over the joined text: each message
 * was a separate generation, and joining them would invent characters at the
 * seams. Non-string and blank entries contribute nothing.
 */
export function estimateTokensFromTexts(texts: readonly string[]): number {
  let total = 0;
  for (const text of texts || []) total += estimateTokensFromText(text);
  return total;
}

/**
 * The three pieces of one stored assistant message that the provider billed as
 * output: the answer, the reasoning summary, and the reasoning details.
 */
export type AssistantOutputParts = {
  text?: string | null;
  reasoningSummary?: string | null;
  reasoningDetails?: string | null;
};

function nonBlank(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

/**
 * The billed output of ONE stored assistant message, as separate generations.
 *
 * Hidden reasoning is output: a thinking model charges for the tokens it spent
 * reasoning even though the user only ever saw the answer, so an estimate that
 * counted the answer alone would understate those turns badly.
 *
 * The two reasoning fields are separate channels (a summary stream and a raw
 * thinking stream), but not every provider keeps them separate -- some send the
 * same text down both, and one provider's summary is literally a prefix of its
 * details. Charging that text twice would inflate the estimate, so when one
 * field contains the other, only the longer one is kept. Words merely shared
 * between the two are not a repeat and both survive.
 *
 * Returns the pieces rather than a number so the caller can sum a whole turn
 * with `estimateTokensFromTexts`: each piece was its own generation and joining
 * them would invent characters at the seams.
 */
export function collectAssistantOutputTexts(
  parts: AssistantOutputParts,
): string[] {
  const pieces: string[] = [];
  const answer = nonBlank(parts?.text);
  if (answer) pieces.push(answer);
  const summary = nonBlank(parts?.reasoningSummary);
  const details = nonBlank(parts?.reasoningDetails);
  if (summary && details) {
    const flatSummary = collapseWhitespace(summary);
    const flatDetails = collapseWhitespace(details);
    if (flatDetails.includes(flatSummary)) pieces.push(details);
    else if (flatSummary.includes(flatDetails)) pieces.push(summary);
    else pieces.push(summary, details);
  } else if (summary) pieces.push(summary);
  else if (details) pieces.push(details);
  return pieces;
}
