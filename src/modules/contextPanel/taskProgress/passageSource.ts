/**
 * Opening a passage the Task progress card lists in its paper: which reads
 * can be opened, the text to look for in the PDF, and the page to fall back
 * to. Pure, so the view and the reader navigation share one definition.
 */
import type {
  TaskPaperReadEvent,
  TaskPaperReadGranularity,
} from "../../../agent/context/taskPaperLedger";
import { stripBoundaryEllipsis } from "../../../services/quotes/quoteTextSearch";

/** What the card hands the panel when "Source" is clicked on a passage. */
export type TaskPaperPassageTarget = {
  itemId: number;
  /** The attachment the passage was read from, when the ledger knows it. */
  contextItemId?: number;
  libraryID: number;
  /** The snippet as the ledger stored it (clipped, possibly Markdown). */
  rawSnippet: string;
  /** The snippet as the card shows it. */
  cleanedSnippet: string;
  /** For display; a page is found by it only when `pageIndex` is absent. */
  label: string;
  /**
   * The printed page the passage names when `label` does not (a citation's
   * recorded page): a bare label such as "7" or "iv". Used as a page named
   * by `label` is, only when `pageIndex` is absent.
   */
  pageLabel?: string;
  /** The page index the read came from, when the ledger recorded one. */
  pageIndex?: number;
  granularity: TaskPaperReadGranularity;
};

const ELLIPSIS_AT_END = /(?:\.{2,}|…)\s*$/u;
const ELLIPSIS_AT_START = /^\s*(?:\.{2,}|…)/u;

/**
 * The printed page a read names in its label: "p. 4" → "4", "p. 4, p. 5" →
 * "4", "pp. 12–13" → "12". Empty when the label names no page.
 */
export function taskPaperPassagePageLabel(label: string | undefined): string {
  const match = /^\s*pp?\.\s*([^\s,;–—-]+)/iu.exec(label || "");
  return match ? match[1] : "";
}

/**
 * The printed page a target falls back to: the one it names outright, else
 * the one its label names. Empty when neither names a page.
 */
export function taskPaperPassageTargetPageLabel(
  target: Pick<TaskPaperPassageTarget, "label" | "pageLabel">,
): string {
  return (
    (target.pageLabel || "").trim() || taskPaperPassagePageLabel(target.label)
  );
}

/**
 * A read the card offers to open: a whole-paper read (opens the paper), some
 * text to find, or a page to go to. Never a host digest: its summary is not
 * the paper's text (its evidence passages are, and open).
 *
 * A paper_read that stopped short is not a host digest; it records its reach
 * with the same `digest` granularity, and it opens the paper.
 */
export function canOpenTaskPaperPassage(read: TaskPaperReadEvent): boolean {
  // A paper_read that stopped short opens the paper, as a full one does.
  if (read.granularity === "digest") return Boolean(taskPaperReadReach(read));
  if (read.granularity === "full") return true;
  if ((read.snippet || "").trim()) return true;
  return (
    read.granularity === "page" &&
    Boolean(taskPaperPassagePageLabel(read.label))
  );
}

/**
 * How far one paper_read went into the paper: all of its text, or part.
 * `counts` is the read's own tally ("30/32 chunks"), empty when it recorded
 * none.
 */
export type TaskPaperReach = {
  part: boolean;
  counts: string;
  /** Chunks reached over chunks in the paper; -1 when no tally was kept. */
  fraction: number;
};

const CHUNK_COUNTS = /^(\d+)\/(\d+) chunks$/u;

/**
 * The reach of a paper_read that took the paper as a whole: a `full` read, or
 * one that stopped short (recorded with `digest` granularity, which no host
 * digest shares with this tool). A `full` record that carries a partial tally
 * was saved before the read told the two apart, and counts as part. Null for
 * every other read, so other tools keep their own wording.
 */
export function taskPaperReadReach(
  read: Pick<TaskPaperReadEvent, "toolName" | "granularity" | "label">,
): TaskPaperReach | null {
  if (read.toolName !== "paper_read") return null;
  if (read.granularity !== "full" && read.granularity !== "digest") return null;
  const counts = (read.label || "").trim();
  const match = CHUNK_COUNTS.exec(counts);
  const reached = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  const tallied = Boolean(match) && total > 0;
  return {
    part: read.granularity === "digest" || (tallied && reached < total),
    counts: tallied ? counts : "",
    fraction: tallied ? reached / total : -1,
  };
}

/**
 * The one reach a paper shows for a question: the whole read first, then the
 * partial read that got furthest; a tally beats none. The first of equals.
 */
export function bestTaskPaperReach<T extends TaskPaperReadEvent>(
  reads: readonly T[],
): { read: T; reach: TaskPaperReach } | null {
  let best: { read: T; reach: TaskPaperReach } | null = null;
  const score = (reach: TaskPaperReach) => [
    reach.part ? 0 : 1,
    reach.fraction,
    reach.counts ? 1 : 0,
  ];
  for (const read of reads) {
    const reach = taskPaperReadReach(read);
    if (!reach) continue;
    if (best) {
      const now = score(reach);
      const was = score(best.reach);
      const better = now.findIndex((value, index) => value !== was[index]);
      if (better < 0 || now[better] < was[better]) continue;
    }
    best = { read, reach };
  }
  return best;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Sentences short enough to be coincidental are not worth a search. */
const MIN_FRAGMENT_WORDS = 6;
const MAX_FRAGMENTS = 3;

/**
 * The texts to look for, best first. The ledger clips a snippet with a
 * trailing "…", often mid-word, so each form is tried without its boundary
 * ellipsis, and a clipped end (or start) also without the word it may have
 * cut. The shown (cleaned) text leads; the stored text follows, since
 * cleaning drops TeX the PDF may still carry; the shown text's longest
 * sentences come last.
 */
export function buildTaskPaperPassageSearchTexts(
  cleanedSnippet: string,
  rawSnippet: string,
): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const text = oneLine(value);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const source of [cleanedSnippet, rawSnippet]) {
    const text = oneLine(source || "");
    if (!text) continue;
    const clippedEnd = ELLIPSIS_AT_END.test(text);
    const clippedStart = ELLIPSIS_AT_START.test(text);
    const stripped = stripBoundaryEllipsis(text);
    if (!stripped) continue;
    let whole = stripped;
    if (clippedEnd) whole = whole.replace(/\s*\S+$/u, "");
    if (clippedStart) whole = whole.replace(/^\S+\s*/u, "");
    // Whole words first: a cut word would not match the PDF's full word.
    if (whole && whole !== stripped && whole.split(" ").length >= 3) {
      add(whole);
    }
    add(stripped);
  }
  // Then the shown text's longest whole sentences, in case one part of the
  // passage (a formula, a table cell) keeps the rest from aligning. The
  // locator's own largest-unique-span fallback runs on each of these too.
  const shown = out[0] || "";
  const sentences = shown
    .split(/(?<=[.!?;:])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(" ").length >= MIN_FRAGMENT_WORDS);
  if (sentences.length > 1) {
    sentences
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_FRAGMENTS)
      .forEach(add);
  }
  return out;
}
