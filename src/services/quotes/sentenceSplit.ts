export type SentenceSpan = { text: string; start: number; end: number };
export type ProseLine = { text: string; offset: number };

const ABBREVIATION_TAIL =
  /(?:\b(?:fig|figs|eq|eqs|et al|e\.g|i\.e|vs|cf|ref|refs|approx|dr|prof)|\b[A-Z])\.$/i;
/** "No." abbreviates a number ("No. 5") but is also a whole answer ("No."), so
 * it only keeps the sentence open when a number follows it. */
const NUMBER_ABBREVIATION_TAIL = /\bno\.$/i;
const TERMINATORS = new Set([".", "!", "?", "。", "！", "？"]);
/** Characters that may close a sentence after its terminator and still belong
 * to it: a quoted or parenthesised sentence ends at the closing mark, not at
 * the full stop inside it. */
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "」", "』", "》"]);
/** A citation token written with no space in front of it still follows a
 * finished sentence, so it ends one the way whitespace does. */
const TOKEN_OPENER = "[[quote:";

export type MathSpan = { start: number; end: number };

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Index of the next unescaped `$` (or `$$` when `double`) at or after
 * `from`; an inline span may not cross a line break. An inline closing `$`
 * is not followed by a digit (the Pandoc rule), so two prices ("$5 … $10")
 * are not a formula. */
function closingDollar(text: string, from: number, double: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (!double && text[i] === "\n") return -1;
    if (text[i] !== "$" || isEscaped(text, i)) continue;
    if (double) {
      if (text[i + 1] === "$") return i;
      continue;
    }
    if (text[i + 1] === "$") return -1;
    if (/\d/.test(text[i + 1] || "")) continue;
    return i;
  }
  return -1;
}

/**
 * The paired math spans of `text` (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), each
 * with its delimiters. When any delimiter is unpaired or empty the math is
 * unclear, and no span is returned.
 */
export function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      if (isEscaped(text, i)) {
        i += 2;
        continue;
      }
      const closer = text[i + 1] === "(" ? "\\)" : "\\]";
      const close = text.indexOf(closer, i + 2);
      if (close <= i + 2) return [];
      spans.push({ start: i, end: close + 2 });
      i = close + 2;
      continue;
    }
    if (
      ch === "\\" &&
      (text[i + 1] === ")" || text[i + 1] === "]") &&
      !isEscaped(text, i)
    ) {
      return [];
    }
    if (ch === "$" && !isEscaped(text, i)) {
      const double = text[i + 1] === "$";
      const open = i + (double ? 2 : 1);
      const close = closingDollar(text, open, double);
      if (close <= open) return [];
      const end = close + (double ? 2 : 1);
      spans.push({ start: i, end });
      i = end;
      continue;
    }
    i++;
  }
  return spans;
}

/** `text` with every character of each math span replaced by a filler that
 * is neither a terminator, a closer nor whitespace, so the same offsets
 * index both. */
function maskMath(text: string): string {
  const spans = findMathSpans(text);
  if (!spans.length) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + "_".repeat(span.end - span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** Sentence spans with offsets into the input. Decimal points and common
 * abbreviations do not end a sentence; CJK terminators always do. A run of
 * closing quotes or brackets after the terminator is part of the sentence,
 * and a citation token right after it starts the next one. A terminator
 * inside paired math (`$1 . 5$`) does not end a sentence; unclear math is
 * split as prose. */
export function splitSentences(input: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  // Decisions read the masked text; spans are cut from the input.
  const text = maskMath(input);
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;
    const prev = text[i - 1] || "";
    if (ch === "." && /\d/.test(prev) && /\d/.test(text[i + 1] || "")) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.has(text[end])) end++;
    const next = text[end];
    const cjk = ch === "。" || ch === "！" || ch === "？";
    const breaks =
      next === undefined ||
      /\s/.test(next) ||
      text.startsWith(TOKEN_OPENER, end);
    if (!cjk && !breaks) continue;
    const candidate = text.slice(start, i + 1).trim();
    if (ch === "." && ABBREVIATION_TAIL.test(candidate)) continue;
    if (
      ch === "." &&
      NUMBER_ABBREVIATION_TAIL.test(candidate) &&
      /^\s*\d/.test(text.slice(end))
    ) {
      continue;
    }
    push(out, input, start, end);
    start = end;
    i = end - 1;
  }
  push(out, input, start, text.length);
  return out;
}

function push(out: SentenceSpan[], text: string, start: number, end: number) {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  if (!trimmed) return;
  out.push({
    text: trimmed,
    start: start + leading,
    end: start + leading + trimmed.length,
  });
}

const HEADING_LINE = /^\s*#{1,6}\s/;

/**
 * A text's body blocks, each on one line with its whitespace collapsed. A
 * blank-line run and a Markdown heading line both end a block, and the
 * heading line itself is dropped: a heading names a section, is never a
 * sentence to quote, and must not join the text above it to the text below.
 */
export function splitBodyBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    let lines: string[] = [];
    const flush = () => {
      const flat = flattenText(lines.join(" "));
      if (flat) blocks.push(flat);
      lines = [];
    };
    for (const line of block.split("\n")) {
      if (HEADING_LINE.test(line)) flush();
      else lines.push(line.trim());
    }
    flush();
  }
  return blocks;
}

export type TextRange = { start: number; end: number };

/** `text` on one line with its whitespace runs collapsed: the form a
 * flattened snippet or body block takes, and the one window ranges index. */
export function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The quotable body text of a window of `source`, as ranges of
 * `flattenText(source)`. When the source has a heading line, the window
 * keeps only its body runs: the shared body blocks, with blocks that only a
 * blank line separates joined, so a range never starts with or crosses a
 * heading, and a window of heading text alone has none. A range edge that
 * falls inside a paired math span moves to the nearest sentence boundary
 * outside the span, inward; a range left empty is dropped. A window with no
 * heading and no cut formula comes back unchanged.
 */
export function windowBodyRanges(
  source: string,
  window: TextRange,
): TextRange[] {
  const flat = flattenText(source);
  const runs = hasHeadingLine(source)
    ? bodyRuns(source, flat)
        .map((run) => ({
          start: Math.max(run.start, window.start),
          end: Math.min(run.end, window.end),
        }))
        .filter((run) => run.end > run.start)
    : [window];
  const spans = findMathSpans(flat);
  if (!spans.length) return runs;
  const sentences = splitSentences(flat);
  const inside = (at: number) =>
    spans.find((span) => span.start < at && at < span.end);
  const out: TextRange[] = [];
  for (const run of runs) {
    let { start, end } = run;
    const cutEnd = inside(end);
    if (cutEnd) {
      end = start;
      for (const sentence of sentences) {
        if (sentence.end > start && sentence.end <= cutEnd.start) {
          end = sentence.end;
        }
      }
    }
    const cutStart = inside(start);
    if (cutStart) {
      const next = sentences.find(
        (sentence) => sentence.start >= cutStart.end && sentence.start < end,
      );
      start = next ? next.start : end;
    }
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** True when a line of `text` is a Markdown heading. */
export function hasHeadingLine(text: string): boolean {
  return text.split("\n").some((line) => HEADING_LINE.test(line));
}

/** The source's body blocks as ranges of its flattened text, with blocks
 * that only a blank line separates joined into one run. */
function bodyRuns(source: string, flat: string): TextRange[] {
  const runs: TextRange[] = [];
  let cursor = 0;
  for (const block of splitBodyBlocks(source)) {
    const start = flat.indexOf(block, cursor);
    if (start < 0) continue;
    const end = start + block.length;
    const last = runs[runs.length - 1];
    if (last && start <= last.end + 1) last.end = end;
    else runs.push({ start, end });
    cursor = end;
  }
  return runs;
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NON_PROSE = /^\s*(?:#{1,6}\s|>|\||<)/;

/** Lines that hold prose: fenced code, headings, blockquotes, table rows and
 * HTML lines are skipped; list markers are stripped. `offset` is the index of
 * the returned text inside the input. */
export function collectProseLines(markdown: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || NON_PROSE.test(line)) continue;
    const stripped = line.replace(LIST_MARKER, "");
    if (!stripped.trim()) continue;
    lines.push({
      text: stripped,
      offset: lineStart + (line.length - stripped.length),
    });
  }
  return lines;
}
