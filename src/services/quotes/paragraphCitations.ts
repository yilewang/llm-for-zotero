import { isQuoteTokenId } from "./quoteTokenIds";
import { closedSentenceBefore, quoteAroundOffset } from "./answerSentence";

/** Paragraph support and reading recommendations share IDs, not presentation. */
const CITATION_RUN = /\[\[cite:[^\]\n]*\]\](?:[ \t]*\[\[cite:[^\]\n]*\]\])*/g;
/**
 * Models separate the ids of one footer with commas, semicolons or spaces;
 * none of those can occur inside an id, so each one ends an id.
 */
const CITATION_ID_SEPARATOR = /[,;\s]+/;

/** One run of adjacent `[[cite:…]]` tokens, by offset in its markdown. */
export type CitationRun = {
  start: number;
  end: number;
  /** The well-formed ids of the run, deduplicated, in order. */
  ids: string[];
};

type ScannedCitationRun = CitationRun & {
  /** Where the spaces before the run begin (the run goes with them). */
  spaceStart: number;
  malformed: string[];
};

/**
 * Every citation run outside code: fenced and indented code, inline code
 * (including code delimited by multiple backticks) and escaped markers stay
 * literal.
 */
function scanCitationRuns(markdown: string): ScannedCitationRun[] {
  const runs: ScannedCitationRun[] = [];
  let fence: { char: string; length: number } | undefined;
  let lineStart = 0;
  for (const line of markdown.split("\n")) {
    const lineOffset = lineStart;
    lineStart += line.length + 1;
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = { char: delimiter[0], length: delimiter.length };
      else if (delimiter[0] === fence.char && delimiter.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;
    let partOffset = lineOffset;
    for (const part of line.split(/(`+[^`]*(?:`(?!`)[^`]*)*?`+)/g)) {
      const offset = partOffset;
      partOffset += part.length;
      if (part.startsWith("`")) continue;
      for (const match of part.matchAll(CITATION_RUN)) {
        const index = match.index || 0;
        if (index > 0 && part[index - 1] === "\\") continue;
        let space = index;
        while (space > 0 && /[ \t]/.test(part[space - 1])) space -= 1;
        const entries = [
          ...match[0].matchAll(/\[\[cite:([^\]]+)\]\]/g),
        ].flatMap((entry) =>
          entry[1].split(CITATION_ID_SEPARATOR).filter(Boolean),
        );
        runs.push({
          start: offset + index,
          end: offset + index + match[0].length,
          spaceStart: offset + space,
          ids: [...new Set(entries.filter(isQuoteTokenId))],
          malformed: [
            ...new Set(entries.filter((entry) => !isQuoteTokenId(entry))),
          ],
        });
      }
    }
  }
  return runs;
}

/** Each citation run of an answer with its well-formed ids. */
export function iterateCitationRuns(markdown: string): CitationRun[] {
  return scanCitationRuns(markdown).map(({ start, end, ids }) => ({
    start,
    end,
    ids,
  }));
}

/**
 * `replace` receives the well-formed ids of each citation run, deduplicated,
 * and the entries that are not ids at all (`malformed`), which the run loses.
 * A run replaced by nothing takes the spaces before it ("0.46 [[cite:x]]."
 * becomes "0.46.").
 */
export function transformParagraphCitations(
  markdown: string,
  replace: (ids: string[], malformed: string[]) => string,
): string {
  let out = "";
  let cursor = 0;
  for (const run of scanCitationRuns(markdown)) {
    const replacement = replace(run.ids, run.malformed);
    out += markdown.slice(cursor, replacement ? run.start : run.spaceStart);
    out += replacement;
    cursor = run.end;
  }
  return out + markdown.slice(cursor);
}

export function paragraphCitationIds(markdown: string): Set<string> {
  return new Set(iterateCitationRuns(markdown).flatMap((run) => run.ids));
}

/** One cited passage of an answer and the sentences that cite it. */
export type AnswerCitationIndexEntry = {
  id: string;
  /** 1..N across the answer, by first appearance. */
  number: number;
  /** The plain sentences the passage's runs close, deduplicated. */
  sentences: string[];
};

/**
 * The sentence a run closes, as plain words. A run right after a sentence's
 * period closes that sentence; any other run closes the sentence it sits in.
 */
function citationRunSentence(markdown: string, run: CitationRun): string {
  const closed = closedSentenceBefore(markdown, run.start);
  const sentence = closed
    ? quoteAroundOffset(markdown.slice(0, closed.end), closed.start)
    : quoteAroundOffset(markdown, run.start);
  return sentence.replace(/\s+(?=[.,;:!?。！？，；：])/g, "");
}

/** A web answer's source markers and render tokens: no words of the answer. */
const WEB_SOURCE_MARKUP =
  /<!--\s*llm-web-source\s*:[^<>]*?-->|LLMWEBSOURCEANCHOR\d+END/gi;

/**
 * The answer with its web markup blanked to spaces: offsets stay, and a
 * marker after a period still ends the sentence.
 */
function blankWebSourceMarkup(markdown: string): string {
  return markdown.replace(WEB_SOURCE_MARKUP, (markup) =>
    markup.replace(/[^\n]/g, " "),
  );
}

/**
 * The answer's cited passages, numbered by first appearance of an id with a
 * record (`validIds`); the same numbers the answer's marks show.
 */
export function indexAnswerCitations(
  markdown: string,
  validIds: ReadonlySet<string>,
): AnswerCitationIndexEntry[] {
  const byId = new Map<string, AnswerCitationIndexEntry>();
  const words = blankWebSourceMarkup(markdown);
  for (const run of iterateCitationRuns(markdown)) {
    const ids = run.ids.filter((id) => validIds.has(id));
    if (!ids.length) continue;
    const sentence = citationRunSentence(words, run);
    for (const id of ids) {
      let entry = byId.get(id);
      if (!entry) {
        entry = { id, number: byId.size + 1, sentences: [] };
        byId.set(id, entry);
      }
      if (sentence && !entry.sentences.includes(sentence))
        entry.sentences.push(sentence);
    }
  }
  return [...byId.values()];
}

/**
 * A citation or quote token still being written at the end of streamed text
 * ("… [[cite:Q_1", "… [[quo"), with the spaces before it.
 */
const PARTIAL_TRAILING_TOKEN =
  /[ \t]*\[\[(?:c(?:i(?:t(?:e(?::[^\]\n]*\]?)?)?)?)?|q(?:u(?:o(?:t(?:e(?::[^\]\n]*\]?)?)?)?)?)?)?$/;

export function stripPartialTrailingCitationToken(text: string): string {
  return text.replace(PARTIAL_TRAILING_TOKEN, "");
}

/**
 * Keep only citations with a record. Removed ids, unknown or malformed, are
 * reported through `onDroppedIds` so a caller can log what the reader lost.
 */
export function normalizeParagraphCitations(
  markdown: string,
  validIds: ReadonlySet<string>,
  onDroppedIds?: (ids: string[]) => void,
): string {
  return transformParagraphCitations(markdown, (ids, malformed) => {
    const known = ids.filter((id) => validIds.has(id));
    const dropped = [...ids.filter((id) => !validIds.has(id)), ...malformed];
    if (dropped.length) onDroppedIds?.(dropped);
    return known.length ? `[[cite:${known.join(",")}]]` : "";
  });
}
