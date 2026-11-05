/**
 * "Show in answer" from Task progress: find the answer's sentence that uses
 * a source and light it, a soft highlight that pulses once, until the next
 * click in the chat or the next sentence shown.
 *
 * The sentence is found by its words in the rendered answer (markers,
 * citation chips, maths and buttons left out), and lit by wrapping each
 * piece of text it covers in a span; clearing unwraps them. What the answer
 * draws in place of the quote's own words (a citation chip, typeset maths)
 * may stand between them.
 */

import { extractInlineCitationMentions } from "./assistantCitationLinks";

const HIGHLIGHT_CLASS = "llm-answer-quote-highlight";
const PULSE_CLASS = "llm-answer-quote-pulse";
const ROW_HIGHLIGHT_CLASS = "llm-answer-quote-row";
/** A chip inside a lit sentence: lit with it, never unwrapped. */
const CHIP_HIGHLIGHT_CLASS = "llm-answer-quote-chip";
/** A quoted passage drawn as a card: the card is lit whole. */
const CARD_HIGHLIGHT_CLASS = "llm-answer-quote-card";

/** Whatever "Show in answer" lit, of every kind. */
export const ANSWER_LIGHT_SELECTOR = [
  HIGHLIGHT_CLASS,
  CHIP_HIGHLIGHT_CLASS,
  CARD_HIGHLIGHT_CLASS,
  ROW_HIGHLIGHT_CLASS,
]
  .map((name) => `.${name}`)
  .join(", ");

/** Text inside these is not the answer's own words. */
const SKIPPED =
  ".llm-web-source-indicator, .llm-citation-row, .llm-citation-inline-wrap, .llm-quote-card, .katex, button, svg, style, script";
/** Chips a sentence's light takes in when they sit inside it. */
const CHIPS =
  ".llm-web-source-indicator, .llm-citation-row, .llm-citation-inline-wrap";
/**
 * Where an answer's text is drawn: its answer, a document it wrote (a
 * literature review, drawn as a card in place of the answer), or its trace's
 * own text.
 */
const ANSWERS =
  ".llm-assistant-answer, .llm-plan-document-card .llm-plan-document-content, .llm-agent-inline-text";

type Piece = { node: Text; start: number; end: number };

/**
 * Words as compared: one space between them, plain quotes and dashes, no
 * invisible breaks. One character in, at most one out.
 */
function foldChar(char: string): string {
  if (/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(char))
    return "";
  if (/\s/.test(char)) return " ";
  if (/[“”„‟"]/.test(char)) return '"';
  if (/[‘’‚‛']/.test(char)) return "'";
  if (/[‐‑‒–—−]/.test(char)) return "-";
  const lower = char.toLowerCase();
  return lower.length === char.length ? lower : char;
}

export function foldAnswerWords(text: string): string {
  let out = "";
  for (const char of text) {
    const folded = foldChar(char);
    if (!folded) continue;
    if (folded === " " && (out === "" || out.endsWith(" "))) continue;
    out += folded;
  }
  return out.trimEnd();
}

/**
 * The answer element of a run, else none: another answer with the same words
 * is never the one meant. Without a run, every answer in the chat. A run
 * whose text is drawn in its trace (between tool calls) has no answer
 * element: its trace's text counts.
 */
export function findAnswerRoots(
  body: ParentNode,
  runId?: string,
): HTMLElement[] {
  const all = Array.from(body.querySelectorAll(ANSWERS)) as HTMLElement[];
  const own = runId
    ? all.filter(
        (node) =>
          node.dataset.agentRunId === runId ||
          (node.closest("[data-agent-run-id]") as HTMLElement | null)?.dataset
            .agentRunId === runId,
      )
    : all;
  // The answer's own words (or its document) before a copy of them in its
  // trace.
  const isAnswer = (node: HTMLElement) =>
    node.matches(".llm-assistant-answer, .llm-plan-document-content");
  return [...own.filter(isAnswer), ...own.filter((node) => !isAnswer(node))];
}

/** A link whose words say nothing ("link", "pdf", "3"): quotes leave it out. */
const BARE_LINK = /^(?:link|source|here|pdf|doi|\d{1,3})$/i;
/** Stands in the compared text for a bare link while its marks go. */
const BARE = "\u0000";

/**
 * Leaves out of `text` (and `map`) what matches `pattern`: a bare link with
 * the "; " before it, or with its parentheses when alone in them, as quotes
 * are written.
 */
function dropMatches(
  text: string,
  map: Piece[],
  pattern: RegExp,
): { text: string; map: Piece[] } {
  const drop = new Set<number>();
  for (const match of text.matchAll(pattern))
    for (let at = match.index!; at < match.index! + match[0].length; at += 1)
      drop.add(at);
  if (!drop.size) return { text, map };
  let out = "";
  const kept: Piece[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (drop.has(at)) continue;
    if (text[at] === " " && (out === "" || out.endsWith(" "))) continue;
    out += text[at];
    kept.push(map[at]);
  }
  return { text: out, map: kept };
}

/** The text of `root` as compared, and where each character came from. */
function textMap(root: Element): { text: string; map: Piece[] } {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);
  let text = "";
  const map: Piece[] = [];
  let bareLink: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(SKIPPED)) continue;
    const link = node.parentElement?.closest("a");
    if (link && BARE_LINK.test((link.textContent || "").trim())) {
      // "(link)" after a sentence's citation: as a quote has it, gone.
      if (link !== bareLink) {
        text += BARE;
        map.push({ node, start: 0, end: 0 });
      }
      bareLink = link;
      continue;
    }
    const value = node.nodeValue || "";
    for (let index = 0; index < value.length; index += 1) {
      const folded = foldChar(value[index]);
      if (!folded) continue;
      if (folded === " " && (text === "" || text.endsWith(" "))) continue;
      text += folded;
      map.push({ node, start: index, end: index + 1 });
    }
  }
  if (!text.includes(BARE)) return { text, map };
  return dropMatches(
    text,
    map,
    new RegExp(` ?\\( ?${BARE} ?\\)|[;,]? ?${BARE}`, "g"),
  );
}

/** The quote as searched: its words, without the quote marks or a cut "…". */
function searchWords(quote: string): string[] {
  const clean = foldAnswerWords(
    quote
      .replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "")
      .replace(/…$/, "")
      .trim(),
  );
  if (!clean) return [];
  const tries = [clean];
  // A long sentence may have been cut or reflowed: try its start too.
  if (clean.length > 80) tries.push(clean.slice(0, 80).trimEnd());
  return tries;
}

function wrapPieces(pieces: Piece[]): HTMLElement[] {
  const byNode = new Map<Text, { start: number; end: number }>();
  for (const piece of pieces) {
    const known = byNode.get(piece.node);
    if (known) known.end = Math.max(known.end, piece.end);
    else byNode.set(piece.node, { start: piece.start, end: piece.end });
  }
  const spans: HTMLElement[] = [];
  for (const [node, range] of byNode) {
    const doc = node.ownerDocument;
    let target = node;
    if (range.start > 0) target = target.splitText(range.start);
    if (range.end - range.start < (target.nodeValue || "").length)
      target.splitText(range.end - range.start);
    const span = doc.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    target.parentNode?.replaceChild(span, target);
    span.appendChild(target);
    spans.push(span);
  }
  return spans;
}

function findByEnds(text: string, words: string): [number, number] | null {
  if (words.length < 60) return null;
  const head = words.slice(0, 40);
  const tail = words.slice(-30).replace(/[\s.!?;,"')\]]+$/, "");
  if (tail.length < 15) return null;
  for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
    const end = text.indexOf(tail, at + head.length);
    if (end < 0) return null;
    let stop = end + tail.length;
    if (stop - at > words.length + 24) continue;
    // With the sentence's own closing marks.
    while (stop < text.length && /[.!?;,"')\]]/.test(text[stop])) stop += 1;
    return [at, stop];
  }
  return null;
}

/** Maths as written: $…$, $$…$$, \\(…\\) or \\[…\\]. */
const MATH =
  /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?=\S)[^$\n]+?(?<=\S)\$(?![\w$])/g;

/**
 * The quote around what the answer draws in place of its words: "Bexley &
 * Corwin (2025)" shows as a citation chip, "$J_{ij}$" as typeset maths,
 * neither of which is compared. Each such part may stand for a gap of up to
 * its own length (a chip may show another label). The span from the first
 * piece to the last, or null when the quote has no such part or its pieces
 * are not there in order.
 */
export function findQuoteAroundGaps(
  text: string,
  quote: string,
  options: { whole?: boolean; anchored?: boolean } = {},
): [number, number] | null {
  const trimmed = quote.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "");
  const cut = /…$/.test(trimmed);
  let clean = trimmed.replace(/…$/, "").trim();
  // A long quote cut inside its last citation: that part is drawn whole.
  if (cut) clean = clean.replace(/\s*[([][^)\]]*$/, "").trim();
  const gapsAt: Array<{ start: number; end: number }> = [];
  for (const match of clean.matchAll(MATH))
    gapsAt.push({ start: match.index!, end: match.index! + match[0].length });
  for (const mention of extractInlineCitationMentions(clean))
    if (
      !gapsAt.some((gap) => mention.start < gap.end && mention.end > gap.start)
    )
      gapsAt.push({ start: mention.start, end: mention.end });
  if (!gapsAt.length && !cut) return null;
  gapsAt.sort((left, right) => left.start - right.start);
  const pieces: string[] = [];
  const gaps: number[] = [];
  let last = 0;
  let gap = 0;
  const push = (raw: string) => {
    const piece = foldAnswerWords(raw).trim();
    if (!/[\p{L}\p{N}]/u.test(piece)) {
      // Punctuation alone ("," or ".") joins the gap around it.
      gap += piece.length;
      return;
    }
    if (pieces.length) gaps.push(gap);
    pieces.push(piece);
    gap = 0;
  };
  for (const part of gapsAt) {
    push(clean.slice(last, part.start));
    gap += part.end - part.start + 12;
    last = part.end;
  }
  push(clean.slice(last));
  // A whole block (a heading, a list item) may be short; within running
  // text a few words could be anywhere.
  const enough = (list: string[]) =>
    list.length > 0 &&
    list.join("").length >= (options.whole ? (options.anchored ? 6 : 12) : 20);
  const find = (list: string[]): [number, number] | null => {
    if (!enough(list)) return null;
    const [first, ...rest] = list;
    for (
      let at = text.indexOf(first);
      at >= 0;
      at = text.indexOf(first, at + 1)
    ) {
      if (options.whole && at > 2) return null;
      let end = at + first.length;
      let found = true;
      for (let index = 0; index < rest.length; index += 1) {
        const next = text.indexOf(rest[index], end);
        if (next < 0) return null;
        if (next - end > gaps[index]) {
          found = false;
          break;
        }
        end = next + rest[index].length;
      }
      if (!found) continue;
      if (options.whole && text.length - end > (gap || 2) + 2) return null;
      return [at, end];
    }
    return null;
  };
  // Cut inside a name the answer draws as a chip ("…replotted from
  // Kirkpatrick et al.,…"): the cut words are not there, the rest is.
  const found = find(pieces);
  if (found || !cut || !pieces.length) return found;
  const head = pieces.slice(0, -1);
  const words = pieces[pieces.length - 1].split(" ");
  for (let drop = 1; drop <= 4 && drop < words.length; drop += 1) {
    const shorter = find([...head, words.slice(0, -drop).join(" ")]);
    if (shorter) return shorter;
  }
  return head.length ? find(head) : null;
}

/**
 * Chips that sit inside the lit sentence, between its first and last lit
 * piece or right against either end ("Bexley & Corwin (2025) show…",
 * "…at all [chip]."): lit too.
 */
function lightChipsBetween(
  scope: Element,
  lit: readonly HTMLElement[],
): HTMLElement[] {
  const chips: HTMLElement[] = [];
  if (!lit.length) return chips;
  const first = lit[0];
  const last = lit[lit.length - 1];
  const take = (chip: Element | null) => {
    if (!chip || chips.includes(chip as HTMLElement)) return;
    chip.classList.add(CHIP_HIGHLIGHT_CLASS);
    chips.push(chip as HTMLElement);
  };
  /**
   * The chip next to a lit end, across nothing but spaces, also when the
   * lit words sit inside bold or a link and the chip outside it.
   */
  const against = (node: Node, step: "previousSibling" | "nextSibling") => {
    let at: Node | null = node;
    while (at && at !== scope) {
      let next: Node | null = at[step];
      while (next && next.nodeType === 3 && !(next.nodeValue || "").trim())
        next = next[step];
      if (next)
        return next.nodeType === 1 && (next as Element).matches(CHIPS)
          ? (next as Element)
          : null;
      const parent: Element | null = at.parentElement;
      if (!parent || parent === scope || parent.matches(BLOCKS)) return null;
      at = parent;
    }
    return null;
  };
  take(against(first, "previousSibling"));
  if (lit.length > 1) {
    for (const chip of Array.from(
      scope.querySelectorAll(CHIPS),
    ) as HTMLElement[]) {
      if (chip.parentElement?.closest(CHIPS)) continue;
      const afterFirst = first.compareDocumentPosition(chip) & 4;
      const beforeLast = chip.compareDocumentPosition(last) & 4;
      if (afterFirst && beforeLast) take(chip);
    }
  }
  take(against(last, "nextSibling"));
  return chips;
}

const BLOCKS = "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6";

/**
 * A quote cut short ("…show drift arising fr…") lights on to its
 * sentence's end, within the same block.
 */
function toSentenceEnd(text: string, map: Piece[], end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const blockOf = (index: number) =>
    map[index]?.node.parentElement?.closest(BLOCKS) || null;
  const block = blockOf(end - 1);
  let stop = end;
  while (stop < text.length && stop - end < 400 && blockOf(stop) === block) {
    const char = text[stop];
    stop += 1;
    if (
      /[.!?。！？]/.test(char) &&
      (stop >= text.length || text[stop] === " " || blockOf(stop) !== block)
    )
      break;
  }
  return stop;
}

/** The row's cells as one line, as a named table row is quoted. */
function rowWords(row: Element): string {
  return (Array.from(row.children) as Element[])
    .filter((cell) => /^(td|th)$/i.test(cell.tagName))
    .map((cell) => textMap(cell).text.trim())
    .join(" - ")
    .trim();
}

/**
 * Light the quote's words in the first root that holds them; `near` (its
 * marker) narrows the search to the marker's block first. Returns the lit
 * elements, or an empty list when the words are not there.
 */
export function highlightAnswerQuote(
  roots: readonly Element[],
  quote: string,
  near?: Element | null,
): HTMLElement[] {
  const block = near?.closest(BLOCKS);
  const scopes = [...(block ? [block] : []), ...roots];
  const tries = searchWords(quote);
  // A table row named as "cell — cell": the row whose cells read so.
  if (quote.includes(" — ") && tries[0]) {
    for (const root of roots) {
      for (const row of Array.from(
        root.querySelectorAll("tr"),
      ) as HTMLElement[]) {
        const words = rowWords(row);
        if (
          words &&
          (words.startsWith(tries[0]) ||
            (findQuoteAroundGaps(words, quote)?.[0] ?? 3) <= 2)
        ) {
          row.classList.add(ROW_HIGHLIGHT_CLASS);
          return [row];
        }
      }
    }
  }
  const cut = /…["”']?\s*$/.test(quote);
  const light = (
    scope: Element,
    text: string,
    map: Piece[],
    span: [number, number],
  ) => {
    const end = cut ? toSentenceEnd(text, map, span[1]) : span[1];
    const lit = wrapPieces(map.slice(span[0], end));
    // In reading order: the first is what the chat scrolls to.
    return [...lit, ...lightChipsBetween(scope, lit)].sort((left, right) =>
      left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
  };
  // The whole sentence, then around what the answer draws in place of its
  // words, then its two ends; only then its start alone.
  for (const scope of scopes) {
    const { text, map } = textMap(scope);
    const [whole] = tries;
    const at = whole ? text.indexOf(whole) : -1;
    if (at >= 0) return light(scope, text, map, [at, at + whole.length]);
    const around = findQuoteAroundGaps(text, quote);
    if (around) return light(scope, text, map, around);
    // The sentence as quoted leaves out a bare "(link)": find its start and
    // its end, close together, and light from one to the other.
    const span = findByEnds(text, whole || "");
    if (span) return light(scope, text, map, span);
  }
  for (const scope of scopes) {
    const { text, map } = textMap(scope);
    const start = tries[1];
    const at = start ? text.indexOf(start) : -1;
    if (at >= 0) return light(scope, text, map, [at, at + start.length]);
  }
  // A short heading or list item drawn around a chip: the block that is
  // all of it; a very short one only in the block of the paper's own chip.
  if (block) {
    const { text, map } = textMap(block);
    const span = findQuoteAroundGaps(text, quote, {
      whole: true,
      anchored: true,
    });
    if (span) return light(block, text, map, span);
  }
  for (const root of roots) {
    for (const node of Array.from(
      root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, th"),
    ) as HTMLElement[]) {
      const { text, map } = textMap(node);
      const span = findQuoteAroundGaps(text, quote, { whole: true });
      if (span) return light(node, text, map, span);
    }
  }
  // A table row named as "cell — cell": light the row that has its first
  // cell.
  const cells = quote.split(" — ");
  if (cells.length > 1) {
    const first = foldAnswerWords(cells[0]);
    for (const root of roots) {
      for (const cell of Array.from(
        root.querySelectorAll("td, th"),
      ) as HTMLElement[]) {
        if (textMap(cell).text.trim() !== first) continue;
        const row = cell.closest("tr") as HTMLElement | null;
        if (!row) continue;
        row.classList.add(ROW_HIGHLIGHT_CLASS);
        return [row];
      }
    }
  }
  const card = findQuoteCard([...scopes, ...roots], quote);
  if (card) {
    card.classList.add(CARD_HIGHLIGHT_CLASS);
    return [card];
  }
  return [];
}

/**
 * A passage the answer quotes with its citation on the line below is drawn
 * as a quote card, whose words are not the answer's text: the card whose
 * passage has the quote's words, citations left out. Of two, the one whose
 * own citation the quote names.
 */
function findQuoteCard(
  scopes: readonly Element[],
  quote: string,
): HTMLElement | null {
  let clean = quote.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "");
  const cut = /…$/.test(clean);
  clean = clean.replace(/…$/, "");
  if (cut) clean = clean.replace(/\s*[([][^)\]]*$/, "");
  // Its citations and maths are gaps: the card draws them otherwise, or not.
  const mentions = extractInlineCitationMentions(clean);
  const named = mentions.map((mention) => bareWords(mention.rawText));
  for (const mention of [...mentions].reverse())
    clean = `${clean.slice(0, mention.start)}\u0001${clean.slice(mention.end)}`;
  const pieces = clean
    .replace(MATH, "\u0001")
    .replace(/\([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*\)/g, "\u0001")
    .split("\u0001")
    .map(bareWords)
    .filter(Boolean);
  const size = pieces.join("").length;
  if (size < 12) return null;
  // A long passage may be reflowed or cut inside: its two ends.
  const ends =
    size > 120
      ? [pieces[0].slice(0, 50), pieces[pieces.length - 1].slice(-30)]
      : pieces;
  const holds = (words: string) => {
    let at = 0;
    for (const piece of ends) {
      const next = words.indexOf(piece, at);
      if (next < 0) return false;
      at = next + piece.length;
    }
    return true;
  };
  const found: HTMLElement[] = [];
  for (const scope of scopes) {
    const cards = [
      ...(scope.matches(".llm-quote-card") ? [scope] : []),
      ...Array.from(scope.querySelectorAll(".llm-quote-card")),
    ] as HTMLElement[];
    for (const card of cards) {
      if (found.includes(card)) continue;
      const passage =
        card.querySelector(".llm-quote-card-preview") ||
        card.querySelector(".llm-quote-card-body");
      if (passage && holds(cardWords(passage))) found.push(card);
    }
  }
  if (found.length < 2) return found[0] || null;
  return (
    found.find((card) => {
      const cited = bareWords(
        card.querySelector(".llm-quote-card-citation")?.textContent || "",
      );
      return (
        cited &&
        named.some((name) => name.includes(cited) || cited.includes(name))
      );
    }) || found[0]
  );
}

/** Letters and digits only, folded: how a card's passage is compared. */
function bareWords(text: string): string {
  return foldAnswerWords(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A card's passage as words, its maths and buttons left out. */
function cardWords(passage: Element): string {
  let text = "";
  const walker = passage.ownerDocument.createTreeWalker(passage, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".katex, button, svg, style, script"))
      continue;
    text += ` ${node.nodeValue || ""}`;
  }
  return bareWords(text);
}

/**
 * The sentence a paragraph-citation mark sits in: its block, and where in
 * the block's text the sentence starts and the mark is.
 */
function sentenceBeforeMark(mark: Element) {
  const block = mark.closest(BLOCKS);
  if (!block) return null;
  const { text, map } = textMap(block);
  let end = 0;
  // Characters of the block before the mark (4: the mark follows).
  while (end < map.length && map[end].node.compareDocumentPosition(mark) & 4)
    end += 1;
  while (end > 0 && text[end - 1] === " ") end -= 1;
  if (!end) return null;
  const head = text.slice(0, Math.max(0, end - 1));
  let start = 0;
  // A sentence ends at . ! or ?, not after "et al." or a short abbreviation.
  const ends =
    /(?<!\bet al|\b(?:e\.g|i\.e|vs|cf|fig|eq|no|ca))[.!?。！？](?:["')\]]*)\s+/g;
  let match: RegExpExecArray | null;
  while ((match = ends.exec(head))) start = match.index + match[0].length;
  return { block, map, start, end };
}

/**
 * Of marks in reading order, the indexes of those that close a sentence:
 * the last of each run of marks that share a sentence (`keys`, one per
 * mark; null for a mark in no sentence, which closes its own).
 */
export function sentenceClosingIndexes(
  keys: readonly (string | null)[],
): number[] {
  const out: number[] = [];
  keys.forEach((key, index) => {
    if (key === null || key !== keys[index + 1]) out.push(index);
  });
  return out;
}

/**
 * The marks that close each sentence citing a passage, in reading order:
 * "A [1] and B [1]. C [1]." gives the second and third marks, one per
 * sentence, as the passage lists its citing sentences.
 */
export function sentenceClosingMarks<T extends Element>(
  marks: readonly T[],
): T[] {
  const blocks: Element[] = [];
  const keys = marks.map((mark) => {
    const sentence = sentenceBeforeMark(mark);
    if (!sentence) return null;
    let index = blocks.indexOf(sentence.block);
    if (index < 0) index = blocks.push(sentence.block) - 1;
    return `${index}:${sentence.start}`;
  });
  return sentenceClosingIndexes(keys).map((index) => marks[index]);
}

/**
 * The sentence a paragraph-citation mark closes, lit: the words of its block
 * from the sentence's start to the mark, as the mark's own sentence. For a
 * passage whose citing sentence's words are not found.
 */
export function highlightSentenceBeforeMark(mark: Element): HTMLElement[] {
  const sentence = sentenceBeforeMark(mark);
  if (!sentence) return [];
  const { block, map, start, end } = sentence;
  const lit = wrapPieces(map.slice(start, end));
  return [...lit, ...lightChipsBetween(block, lit)].sort((left, right) =>
    left.compareDocumentPosition(right) & 4 ? -1 : 1,
  );
}

/**
 * A passage the answer quotes as a card (`[[quote:ID]]`): its card, lit
 * whole; never a copy inside a citation mark's popover.
 */
export function highlightAnswerQuoteCard(
  roots: readonly Element[],
  citationId: string,
): HTMLElement[] {
  for (const root of roots) {
    for (const card of Array.from(
      root.querySelectorAll(".llm-quote-card[data-quote-citation-id]"),
    ) as HTMLElement[]) {
      if (card.dataset.quoteCitationId !== citationId) continue;
      if (
        card.parentElement?.closest(
          ".llm-web-source-indicator, .llm-web-source-popover",
        )
      )
        continue;
      card.classList.add(CARD_HIGHLIGHT_CLASS);
      return [card];
    }
  }
  return [];
}

/** Take every highlight out of the chat. */
export function clearAnswerQuoteHighlights(body: ParentNode): void {
  for (const span of Array.from(
    body.querySelectorAll(`.${HIGHLIGHT_CLASS}`),
  ) as HTMLElement[]) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize?.();
  }
  for (const row of Array.from(
    body.querySelectorAll(`.${ROW_HIGHLIGHT_CLASS}`),
  ) as HTMLElement[]) {
    row.classList.remove(ROW_HIGHLIGHT_CLASS, PULSE_CLASS);
  }
  for (const chip of Array.from(
    body.querySelectorAll(`.${CHIP_HIGHLIGHT_CLASS}`),
  ) as HTMLElement[]) {
    chip.classList.remove(CHIP_HIGHLIGHT_CLASS, PULSE_CLASS);
  }
  for (const card of Array.from(
    body.querySelectorAll(`.${CARD_HIGHLIGHT_CLASS}`),
  ) as HTMLElement[]) {
    card.classList.remove(CARD_HIGHLIGHT_CLASS, PULSE_CLASS);
  }
}

/** The pulse that says "here", once, on lit elements. */
export function pulseAnswerQuote(lit: readonly HTMLElement[]): void {
  for (const node of lit) {
    node.classList.remove(PULSE_CLASS);
    void node.getBoundingClientRect();
    node.classList.add(PULSE_CLASS);
  }
}
