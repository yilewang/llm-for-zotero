/**
 * The passages an answer cites, as Task progress lists them: one entry per
 * passage, with the number its mark shows in the answer, the sentences that
 * cite it, and the passage itself. Pure: built from the answer's rendered
 * inputs (`getAssistantRenderDisplay`), so the list and the marks agree.
 *
 * Each library paper lists the entries of its own passages under "Cited"
 * (`isTaskAnswerCitationOf`); the view folds the reads that match none.
 */
import { indexAnswerCitations } from "../../../services/quotes/paragraphCitations";
import { normalizeQuoteCitations } from "../../../services/quotes/quoteCitations";
import { findMathSpans } from "../../../services/quotes/sentenceSplit";
import type { QuoteCitation } from "../../../shared/types";
import {
  buildQuoteRenderPlan,
  getAssistantRenderDisplay,
  paragraphCitationNumbers,
} from "../quoteRenderPlan";
import type { Message } from "../types";

/** Characters of a cited passage the list shows. */
export const TASK_ANSWER_CITATION_QUOTE_MAX_CHARS = 600;

/** One passage the answer cites. */
export type TaskAnswerCitation = {
  id: string;
  /**
   * The number its marks show (1..N across the answer, by first appearance);
   * absent for a passage the answer only quotes as a card (`[[quote:ID]]`).
   */
  number?: number;
  /** The plain sentences that cite it, in answer order. */
  sentences: string[];
  /** The passage, at most `TASK_ANSWER_CITATION_QUOTE_MAX_CHARS` characters. */
  quote: string;
  /** The printed page it was found on. */
  pageLabel?: string;
  /** The zero-based page index it was found on. */
  pageIndex?: number;
  /** The paper's section it sits in. */
  section?: string;
  itemId?: number;
  contextItemId?: number;
  kind: "cite" | "quote";
};

/** The fewest characters a cut moved back to a math span's start may keep. */
const MIN_CLIPPED_CHARS = 20;

/** `text` on one line, cut to `max` characters with an ellipsis. A cut that
 * would fall inside a math span moves to the span's start, so the passage
 * renders no half formula; when that would leave next to nothing (the span
 * opens the passage), the cut stays where it was. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const limit = max - 1;
  let cut = limit;
  for (const span of findMathSpans(flat)) {
    if (span.start >= cut) break;
    if (span.end > cut) {
      if (span.start >= MIN_CLIPPED_CHARS) cut = span.start;
      break;
    }
  }
  return `${flat.slice(0, cut).trimEnd()}…`;
}

/**
 * A cited passage as the list renders it: a Markdown heading marker at its
 * start (a quote saved before minted quotes skipped headings) is dropped, so
 * the passage is not drawn as a heading. The entry's own `quote` stays raw
 * for "Source" and matching.
 */
export function taskAnswerCitationDisplayQuote(quote: string): string {
  return quote.replace(/^\s*#{1,6}\s+/, "");
}

function entryOf(
  citation: QuoteCitation,
  kind: TaskAnswerCitation["kind"],
  number: number | undefined,
  sentences: readonly string[],
): TaskAnswerCitation {
  const page = `${citation.pageHintLabel || ""}`.trim();
  const section = `${citation.sourceSectionLabel || ""}`.trim();
  const pageIndex = Number(citation.pageHintIndex);
  const itemId = Number(citation.itemId);
  const contextItemId = Number(citation.contextItemId);
  return {
    id: citation.id,
    ...(number ? { number } : {}),
    sentences: [...sentences],
    quote: clip(
      citation.displayQuoteText || citation.quoteText || "",
      TASK_ANSWER_CITATION_QUOTE_MAX_CHARS,
    ),
    ...(page ? { pageLabel: page } : {}),
    ...(Number.isInteger(pageIndex) && pageIndex >= 0 ? { pageIndex } : {}),
    ...(section ? { section } : {}),
    ...(itemId > 0 ? { itemId } : {}),
    ...(contextItemId > 0 ? { contextItemId } : {}),
    kind,
  };
}

/**
 * Every passage the answer cites: the numbered ones (`[[cite:…]]`) in
 * number order, then those it only quotes as a card. An id the answer both
 * cites and quotes is listed once, with its number.
 */
export function buildTaskAnswerCitations(
  message: Pick<Message, "text" | "quoteCitations" | "quoteDisplayOverride">,
  options: { hasWebSources?: boolean } = {},
): TaskAnswerCitation[] {
  // The answer's marks are drawn from this text (a web answer: its own).
  const display = getAssistantRenderDisplay(message, options);
  const citations = normalizeQuoteCitations(display.quoteCitations);
  if (!citations.length || !display.markdown) return [];
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  // The plan the answer's marks and cards are drawn from: a web answer's
  // quoted lines stay quotes, as it renders them.
  const plan = buildQuoteRenderPlan({
    ...display,
    allowLegacyInference: !options.hasWebSources,
  });
  const sentences = new Map(
    indexAnswerCitations(display.markdown, new Set(byId.keys())).map(
      (entry) => [entry.id, entry.sentences],
    ),
  );
  const out: TaskAnswerCitation[] = [];
  for (const [id, number] of paragraphCitationNumbers(plan)) {
    const citation = byId.get(id);
    if (citation)
      out.push(entryOf(citation, "cite", number, sentences.get(id) || []));
  }
  const listed = new Set(out.map((entry) => entry.id));
  for (const occurrence of plan.occurrences) {
    const id = occurrence.quoteCitationId;
    const citation = id ? byId.get(id) : undefined;
    if (!id || !citation || listed.has(id)) continue;
    listed.add(id);
    out.push(entryOf(citation, "quote", undefined, []));
  }
  return out;
}

/** Whether an entry is one of a paper's passages. */
export function isTaskAnswerCitationOf(
  citation: Pick<TaskAnswerCitation, "itemId" | "contextItemId">,
  paper: { itemId: number; contextItemIds?: readonly number[] },
): boolean {
  if (citation.itemId) return citation.itemId === paper.itemId;
  return Boolean(
    citation.contextItemId &&
    paper.contextItemIds?.includes(citation.contextItemId),
  );
}
