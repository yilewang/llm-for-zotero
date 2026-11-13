/**
 * An answer's sentences as plain words, shared by the answer's citation
 * index and Task progress.
 */

/**
 * The sentence-closing punctuation that starts `text`, with its closing quote
 * mark or bracket: "." or "?!" or an ellipsis ("..." or "…") is one run.
 */
export function leadingSentenceClose(text: string): string {
  return /^[.!?。！？…]+["”’)\]]*/.exec(text)?.[0] || "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The answer's sentence around a marker: from the sentence's start to its
 * end, as plain words.
 */
export function quoteAroundOffset(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  let start = lineStart;
  // A sentence ends at . ! or ?, not after "et al." or a short abbreviation.
  const ends =
    /(?<!\bet al|\b(?:e\.g|i\.e|vs|cf|Fig|fig|Eq|eq|No|no|ca))[.!?。！？](?:["”’)\]]*)\s+/g;
  let match: RegExpExecArray | null;
  const head = text.slice(lineStart, Math.max(lineStart, at - 1));
  while ((match = ends.exec(head)))
    start = lineStart + match.index + match[0].length;
  const rest = text.slice(at);
  // The sentence keeps its closing quote mark or bracket.
  const endMatch =
    /(?<!\bet al|\b(?:e\.g|i\.e|vs|cf|Fig|fig|Eq|eq|No|no|ca))[.!?。！？]["”’)\]]*(?=\s|$)|\n/.exec(
      rest,
    );
  const end = endMatch ? at + endMatch.index + endMatch[0].length : text.length;
  const sentence = text
    .slice(start, end)
    // An escaped token goes with its backslash.
    .replace(/\s*\\?\[\[(?:cite|quote):[^\]]*\]\]/g, "")
    // A bare "link" adds no words: it goes, with its parentheses if empty.
    .replace(/[;,]?\s*\[(?:link|source|here|pdf|doi|\d{1,3})\]\([^)]*\)/gi, "")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // A heading's or a quoted line's marks, not a ">90%" in the words.
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    // Emphasis and code marks, not a word's own "_" (as in "J_ij").
    .replace(/\*+|`+/g, "")
    .replace(
      /(^|[^\p{L}\p{N}\\])_+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}.!?,;:)])_+(?![\p{L}\p{N}{])/gu,
      "$1",
    )
    .replace(/^\s*(?:[-+]|\d{1,9}[.)])\s+/, "");
  return oneLine(sentence, 600);
}

/**
 * Where the sentence ends that text before `offset` already closes: the end
 * of its closing punctuation, with `start` at that punctuation. Undefined
 * when the text before is not a finished sentence ("et al." is not).
 */
export function closedSentenceBefore(
  text: string,
  offset: number,
): { start: number; end: number } | undefined {
  // A run on its own line after a soft break still closes the sentence above.
  const before = text.slice(0, offset).replace(/[ \t]*\n?[ \t]*$/, "");
  const match =
    /(?<!\bet al|\b(?:e\.g|i\.e|vs|cf|Fig|fig|Eq|eq|No|no|ca))[.!?。！？]["”’)\]]*$/.exec(
      before,
    );
  return match ? { start: match.index, end: before.length } : undefined;
}
