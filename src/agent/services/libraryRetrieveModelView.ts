import type { QuoteCitation } from "../../shared/types";
import { DEEP_SYNTHESIS_MAX_PAPERS } from "../../shared/libraryChatReadStrategy";
import { estimateTextTokens } from "../../utils/modelInputCap";
import type {
  LibraryRetrieveInput,
  LibraryRetrievePaperMatch,
  LibraryRetrieveResult,
  LibraryRetrieveSnippet,
} from "./libraryRetrieveService";

/**
 * What the model reads of a library_retrieve result, sized to the question.
 *
 * The service reads comprehensively; the answer needs only part of it. The
 * intent says which part:
 * - verify: every exact passage, and the papers it comes from;
 * - enumerate: every matching paper by id and title, with its best passage;
 * - summarize: the top papers read in depth (all their passages), as many
 *   as a bounded synthesis reads (DEEP_SYNTHESIS_MAX_PAPERS).
 * Verify and summarize also list, after those, up to NOT_READ_PAPER_ROWS
 * matching papers that show no passage, each with its passageStatus (cut by
 * the budget, or no full text), so the answer can name what it did not read.
 * The caller's own perPaperTopK and maxSnippetPapers override the per-paper
 * and paper counts. The model's room caps the whole: past it, passages leave
 * one at a time from the paper showing the most (the lowest-ranked of equals),
 * so a paper loses its last passage only once every paper is down to one;
 * then ledger rows without a passage leave.
 *
 * Rows keep the fields an answer uses; the chunk text, scores and match
 * diagnostics, the candidate shortlist, the query plan and the text
 * renderings of the ledger stay in the stored result, whose row arrays list
 * the rows shown first. `omitted` counts the rows left out, and the papers
 * the synthesis digest covers: it restates the ledger and passages shown,
 * one line per shortlisted paper.
 */

const PAPER_FIELDS = [
  "itemId",
  "title",
  "matchStatus",
  "returnedSnippetCount",
  "passageStatus",
  "workGroupId",
] as const;
/**
 * At most this many matching papers without a passage (cut by the budget, or
 * without full text) are listed in a verify or summarize view, after the
 * papers with passages, so the answer can name the papers it did not read.
 */
const NOT_READ_PAPER_ROWS = 25;
// contextItemId names the attachment a passage came from: paper_read's
// target, and the source its evidence ref covers.
const PASSAGE_FIELDS = [
  "snippetId",
  "itemId",
  "contextItemId",
  "citationLabel",
  "sectionLabel",
  "pageLabel",
  "snippet",
  "quoteCitationId",
  "leadingPassage",
] as const;

type Row = Record<string, unknown>;

export type LibraryRetrieveModelView = {
  content: Row;
  stored: Row;
};

function pick(row: object, fields: readonly string[]): Row {
  const source = row as Row;
  const out: Row = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** `rows` with `shown` first, in the order shown, then the rest in order. */
function shownFirst<T>(rows: readonly T[], shown: readonly T[]): T[] {
  const inView = new Set(shown);
  return [...shown, ...rows.filter((row) => !inView.has(row))];
}

/**
 * The index of the passage to trim first: the last passage of the paper
 * showing the most passages, the lowest-ranked such paper on a tie. Passages
 * are grouped by paper in rank order, so later means lower-ranked.
 */
function deepestPaperLastPassage(
  passages: readonly LibraryRetrieveSnippet[],
): number {
  const counts = new Map<string, number>();
  for (const passage of passages)
    counts.set(passage.itemId, (counts.get(passage.itemId) || 0) + 1);
  let chosen = passages.length - 1;
  let deepest = 0;
  for (let index = passages.length - 1; index >= 0; index -= 1) {
    const count = counts.get(passages[index].itemId) || 0;
    if (count > deepest) {
      deepest = count;
      chosen = index;
    }
    // Skip the rest of this paper: its last passage is already considered.
    counts.set(passages[index].itemId, -1);
  }
  return chosen;
}

function tokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function buildLibraryRetrieveModelView(params: {
  input: Pick<
    LibraryRetrieveInput,
    "perPaperTopK" | "maxSnippetPapers" | "maxFullTextPapers"
  >;
  result: LibraryRetrieveResult & { guidance?: string };
  /** The largest view, in tokens, the model's input budget makes room for. */
  roomTokens: number;
}): LibraryRetrieveModelView | null {
  const { input, result } = params;
  if (!Array.isArray(result?.paperMatches) || !Array.isArray(result.snippets))
    return null;
  const passagesByPaper = new Map<string, LibraryRetrieveSnippet[]>();
  for (const snippet of result.snippets) {
    const list = passagesByPaper.get(snippet.itemId) || [];
    list.push(snippet);
    passagesByPaper.set(snippet.itemId, list);
  }
  const hasPassages = (paper: LibraryRetrievePaperMatch) =>
    passagesByPaper.has(paper.itemId);
  const matched = (paper: LibraryRetrievePaperMatch) =>
    paper.matchStatus !== "not_enough_evidence";
  const perPaperOverride = input.perPaperTopK;
  const paperCountOverride = input.maxSnippetPapers ?? input.maxFullTextPapers;
  // A matching paper no passage was read for, with the reason on its row.
  const notRead = (paper: LibraryRetrievePaperMatch) =>
    !hasPassages(paper) && Boolean(paper.passageStatus);
  const notReadRows = (
    inScope: (paper: LibraryRetrievePaperMatch) => boolean,
  ) =>
    result.paperMatches
      .filter((paper) => notRead(paper) && inScope(paper))
      .slice(0, NOT_READ_PAPER_ROWS);
  let papers: LibraryRetrievePaperMatch[];
  let perPaper: number;
  if (result.intent === "verify") {
    papers = [
      ...result.paperMatches.filter(hasPassages),
      ...notReadRows(matched),
    ];
    perPaper = perPaperOverride ?? Number.POSITIVE_INFINITY;
  } else if (result.intent === "summarize") {
    // A bounded synthesis plans every paper in scope, so a paper nothing
    // matched is still read; elsewhere such a paper is a fallback lead.
    const planned =
      result.answerContract?.resolvedStrategy === "deep_synthesis";
    const inScope = (paper: LibraryRetrievePaperMatch) =>
      planned || matched(paper);
    papers = [
      ...result.paperMatches
        .filter((paper) => hasPassages(paper) && inScope(paper))
        .slice(0, paperCountOverride ?? DEEP_SYNTHESIS_MAX_PAPERS),
      ...notReadRows(inScope),
    ];
    perPaper = perPaperOverride ?? Number.POSITIVE_INFINITY;
  } else {
    papers = result.paperMatches.filter(matched);
    perPaper = perPaperOverride ?? 1;
  }
  const passages = papers.flatMap((paper) =>
    [...(passagesByPaper.get(paper.itemId) || [])]
      // A passage that matched comes before the paper's leading passage.
      .sort(
        (left, right) =>
          Number(Boolean(left.leadingPassage)) -
          Number(Boolean(right.leadingPassage)),
      )
      .slice(0, perPaper),
  );

  const paperRow = (paper: LibraryRetrievePaperMatch) =>
    pick(paper, PAPER_FIELDS);
  const passageRow = (passage: LibraryRetrieveSnippet) =>
    // sourceKind marks a passage from a paper without full text; PDF passages omit it.
    ({
      ...pick(passage, PASSAGE_FIELDS),
      ...(passage.sourceKind === "abstract" || passage.sourceKind === "metadata"
        ? { sourceKind: passage.sourceKind }
        : {}),
    });
  const { unreadableReasons, coverageFrontier, ...answerContract } =
    result.answerContract || ({} as LibraryRetrieveResult["answerContract"]);
  void unreadableReasons;
  void coverageFrontier;
  const build = () => {
    const quoteIds = new Set(
      passages.map((passage) => passage.quoteCitationId).filter(Boolean),
    );
    const quoteCitations = (result.quoteCitations || []).filter(
      (citation: QuoteCitation) => quoteIds.has(citation.id),
    );
    const omitted: Record<string, number> = {
      paperMatches: result.paperMatches.length - papers.length,
      snippets: result.snippets.length - passages.length,
      candidates: result.candidates?.length || 0,
      synthesisDigest: (result.synthesisDigest?.match(/^- Paper /gm) || [])
        .length,
    };
    for (const key of Object.keys(omitted)) {
      if (!omitted[key]) delete omitted[key];
    }
    return {
      ...(result.guidance ? { guidance: result.guidance } : {}),
      intent: result.intent,
      depth: result.depth,
      methodsUsed: result.methodsUsed,
      resourcePool: result.resourcePool,
      answerContract,
      frontier: result.frontier,
      warnings: result.warnings,
      paperMatches: papers.map(paperRow),
      snippets: passages.map(passageRow),
      ...(quoteCitations.length ? { quoteCitations } : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
    };
  };

  // Past the room, passages leave round-robin from the deepest papers (the
  // best passage stays), then ledger rows whose paper shows no passage.
  let total = tokens(build());
  while (total > params.roomTokens && passages.length > 1) {
    const removed = passages.splice(deepestPaperLastPassage(passages), 1)[0];
    total -= tokens(passageRow(removed));
  }
  const withPassage = new Set(passages.map((passage) => passage.itemId));
  for (
    let index = papers.length - 1;
    index >= 0 && total > params.roomTokens && papers.length > 1;
    index -= 1
  ) {
    if (withPassage.has(papers[index].itemId)) continue;
    total -= tokens(paperRow(papers[index]));
    papers.splice(index, 1);
  }

  return {
    content: build(),
    stored: {
      ...result,
      paperMatches: shownFirst(result.paperMatches, papers),
      snippets: shownFirst(result.snippets, passages),
    },
  };
}
