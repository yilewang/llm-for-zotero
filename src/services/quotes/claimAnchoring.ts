import type { QuoteCitation } from "../../shared/types";
import { tokenizeRetrievalText } from "../retrieval/retrievalTokenizer";
import { buildQuoteCitation } from "./quoteCitations";
import {
  collectProseLines,
  splitSentences,
  type SentenceSpan,
} from "./sentenceSplit";

export const QUOTE_ANCHOR_MIN_CHARS = 40;
export const QUOTE_ANCHOR_MAX_CHARS = 360;
export const QUOTE_TOKEN_PATTERN = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;
const LEADING_QUOTE_TOKEN_RUN = /^(?:\s*\[\[quote:[A-Za-z0-9._:-]+\]\])+/;
const MIN_CLAIM_TOKENS = 3;
/** A token that is only digits, separators or punctuation — a year or a page
 * number, never the substance of a claim. */
const NUMERIC_TOKEN = /^[\d.,]+$/;
const MIN_SHARED_TOKENS = 2;
const MIN_OVERLAP = 0.34;
const CHUNK_MARKER = /^\s*\[chunk\s+\d+\]\s*$/gim;
/** Front-matter lines a quote must never land on, as paperRead's own
 * overview-candidate split already excludes them. */
const METADATA_LINE = /^(?:title|authors?|date|publication|doi|abstract):/i;

export type ClaimAnchorMatch = "claim" | "passage";
export type ClaimAnchorDecision = {
  id: string;
  match: ClaimAnchorMatch;
  score: number;
  claimSentence: string;
};

function normalizeClaim(text: string): string {
  return text
    .replace(QUOTE_TOKEN_PATTERN, "")
    .replace(/\s+([.!?。！？,;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentence spans of a line where a citation token that sits outside the
 * sentence it supports is folded back into it: a token written after the
 * terminal punctuation ("…day 10. [[quote:q1]]") belongs to the sentence
 * before it, whether it stands alone or opens the next sentence. */
function claimSpans(lineText: string): SentenceSpan[] {
  const spans = splitSentences(lineText);
  const folded: SentenceSpan[] = [];
  for (const span of spans) {
    const bare = span.text.replace(QUOTE_TOKEN_PATTERN, "").trim();
    const previous = folded[folded.length - 1];
    if (!bare && previous) {
      previous.end = span.end;
      previous.text = lineText.slice(previous.start, span.end);
      continue;
    }
    const opening = previous ? LEADING_QUOTE_TOKEN_RUN.exec(span.text) : null;
    if (previous && opening) {
      const rest = span.text.slice(opening[0].length);
      const restStart =
        span.start +
        opening[0].length +
        (rest.length - rest.trimStart().length);
      previous.end = span.start + opening[0].length;
      previous.text = lineText.slice(previous.start, previous.end);
      folded.push({
        text: lineText.slice(restStart, span.end),
        start: restStart,
        end: span.end,
      });
      continue;
    }
    folded.push({ ...span });
  }
  return folded;
}

type RawLine = {
  start: number;
  end: number;
  blank: boolean;
  /** Index into `blockTexts`, or -1 when the line is not a blockquote line. */
  blockIndex: number;
};

type BlockquoteScan = { lines: RawLine[]; blockTexts: string[] };

/** Every line of the answer with the blockquote block it belongs to. Prose
 * anchoring skips blockquotes (`collectProseLines`), but a citation token is
 * routinely written inside or beside one, so the quoted line has to stay
 * reachable. A ">" inside a fenced code block is code, not a quote. */
function scanBlockquotes(markdown: string): BlockquoteScan {
  const lines: RawLine[] = [];
  const blockLines: string[][] = [];
  let offset = 0;
  let inFence = false;
  let openBlock = -1;
  for (const raw of markdown.split("\n")) {
    const start = offset;
    const end = offset + raw.length;
    offset = end + 1;
    const fence = /^\s*```/.test(raw);
    if (fence) inFence = !inFence;
    const quoted = !fence && !inFence && /^\s*>/.test(raw);
    if (quoted) {
      if (openBlock < 0) {
        openBlock = blockLines.length;
        blockLines.push([]);
      }
      blockLines[openBlock].push(raw.replace(/^\s*(?:>\s?)+/, ""));
    } else {
      openBlock = -1;
    }
    lines.push({
      start,
      end,
      blank: !raw.trim(),
      blockIndex: quoted ? openBlock : -1,
    });
  }
  return {
    lines,
    blockTexts: blockLines.map((block) => normalizeClaim(block.join(" "))),
  };
}

/** Text of the blockquote block that follows line `index`, ignoring blank
 * lines. Undefined when the next line with content is not a blockquote. */
function blockquoteAfter(scan: BlockquoteScan, index: number) {
  for (let i = index + 1; i < scan.lines.length; i++) {
    if (scan.lines[i].blank) continue;
    const blockIndex = scan.lines[i].blockIndex;
    return blockIndex >= 0 ? scan.blockTexts[blockIndex] : undefined;
  }
  return undefined;
}

/** Text of the blockquote block that precedes line `index`, ignoring blank
 * lines. Undefined when the previous line with content is not a blockquote. */
function blockquoteBefore(scan: BlockquoteScan, index: number) {
  for (let i = index - 1; i >= 0; i--) {
    if (scan.lines[i].blank) continue;
    const blockIndex = scan.lines[i].blockIndex;
    return blockIndex >= 0 ? scan.blockTexts[blockIndex] : undefined;
  }
  return undefined;
}

/** Content tokens of a claim, years and page numbers excluded. An attribution
 * line states nothing of its own: "(Orion, 2025)" counts 1 and
 * "Source: (Orion, 2025)" counts 2, while "Accuracy stayed stable" counts 3
 * and is a claim the scorer can use. */
function countContentTokens(claim: string): number {
  let count = 0;
  for (const token of tokenSet(claim)) {
    if (!NUMERIC_TOKEN.test(token)) count++;
  }
  return count;
}

/** First claim sentence per citation id: the sentence of a prose line that
 * contains the token, with all tokens removed. Blockquoted evidence is the
 * claim whenever the token sits inside the quote, on a lead-in sentence that
 * ends with a colon in front of it, on a line that follows the quote and says
 * too little to be a claim (a bare attribution line), or on a token-only line
 * right after it. A token-only line with no blockquote above it binds to the
 * last sentence of the previous prose line. */
export function extractClaimSentences(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const scan = scanBlockquotes(text);
  const prose = collectProseLines(text);
  let proseIndex = 0;
  let lastSentence = "";
  for (let index = 0; index < scan.lines.length; index++) {
    const rawLine = scan.lines[index];
    if (rawLine.blockIndex >= 0) {
      const quoted = scan.blockTexts[rawLine.blockIndex];
      const source = text.slice(rawLine.start, rawLine.end);
      for (const match of source.matchAll(QUOTE_TOKEN_PATTERN)) {
        if (!out.has(match[1]) && quoted) out.set(match[1], quoted);
      }
      continue;
    }
    const next = prose[proseIndex];
    if (!next || next.offset < rawLine.start || next.offset > rawLine.end) {
      continue;
    }
    proseIndex++;
    const line = next;
    const bareLine = line.text.replace(QUOTE_TOKEN_PATTERN, "").trim();
    if (!bareLine) {
      const claim = blockquoteBefore(scan, index) || lastSentence;
      for (const match of line.text.matchAll(QUOTE_TOKEN_PATTERN)) {
        if (!out.has(match[1]) && claim) out.set(match[1], claim);
      }
      continue;
    }
    const sentences = claimSpans(line.text);
    const quotedBelow = blockquoteAfter(scan, index);
    const quotedAbove = blockquoteBefore(scan, index);
    for (const match of line.text.matchAll(QUOTE_TOKEN_PATTERN)) {
      const id = match[1];
      if (out.has(id)) continue;
      const position = match.index || 0;
      const inside = sentences.find(
        (s) => position >= s.start && position < s.end,
      );
      const before = sentences.filter((s) => s.end <= position).pop();
      const claim = inside || before || sentences[0];
      const normalized = normalizeClaim(claim ? claim.text : line.text);
      if (quotedBelow && /[:：]$/.test(normalized)) {
        out.set(id, quotedBelow);
        continue;
      }
      if (quotedAbove && countContentTokens(normalized) < MIN_CLAIM_TOKENS) {
        out.set(id, quotedAbove);
        continue;
      }
      if (normalized) out.set(id, normalized);
    }
    const last = sentences[sentences.length - 1];
    if (last) lastSentence = normalizeClaim(last.text) || lastSentence;
  }
  return out;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    tokenizeRetrievalText(text, {
      filterStopwords: true,
      fallbackToUnfilteredIfEmpty: true,
    }),
  );
}

type Candidate = { text: string; position: number; chunk: number };

/** The retrieved chunks a passage is made of, as `paper_read` delimits them
 * with `[chunk N]` markers when a read spans more than one chunk. */
function splitPassageChunks(passageText: string): string[] {
  return passageText.split(CHUNK_MARKER).filter((chunk) => chunk.trim());
}

function flattenPassageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Index of the one chunk holding `quoteText`, or -1 when no chunk contains it
 * or more than one does: a citation carries no chunk identity of its own. */
function findSourceChunkIndex(
  chunks: readonly string[],
  quoteText: string,
): number {
  const needle = flattenPassageText(quoteText);
  if (!needle) return -1;
  let found = -1;
  for (let chunk = 0; chunk < chunks.length; chunk++) {
    if (!flattenPassageText(chunks[chunk]).includes(needle)) continue;
    if (found >= 0) return -1;
    found = chunk;
  }
  return found;
}

/** Passage sentences, each extended forward to the anchor length bounds. */
function passageCandidates(chunks: readonly string[]): Candidate[] {
  const candidates: Candidate[] = [];
  let position = 0;
  for (let chunk = 0; chunk < chunks.length; chunk++) {
    for (const block of chunks[chunk].split(/\n{2,}/)) {
      const flat = block
        .split("\n")
        .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!flat) continue;
      const sentences = splitSentences(flat);
      for (let i = 0; i < sentences.length; i++) {
        let text = sentences[i].text;
        let j = i + 1;
        while (text.length < QUOTE_ANCHOR_MIN_CHARS && j < sentences.length) {
          const next = `${text} ${sentences[j].text}`;
          if (next.length > QUOTE_ANCHOR_MAX_CHARS) break;
          text = next;
          j++;
        }
        if (
          text.length >= QUOTE_ANCHOR_MIN_CHARS &&
          text.length <= QUOTE_ANCHOR_MAX_CHARS &&
          !METADATA_LINE.test(text)
        ) {
          candidates.push({ text, position: position + i, chunk });
        }
      }
      position += sentences.length;
    }
  }
  return candidates;
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

/** Ids the answer cites, including tokens written where no claim sentence can
 * be read: a heading, a table row, a line of HTML. */
function citedTokenIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(QUOTE_TOKEN_PATTERN)) ids.add(match[1]);
  return ids;
}

/** Re-anchor every cited citation to the passage sentence that best matches
 * the sentence citing it. Citations without a token or without passage text
 * are returned unchanged. Ids, labels and page hints are preserved. */
export function reanchorQuoteCitationsToClaims(params: {
  text: string;
  quoteCitations: readonly QuoteCitation[];
  passageTextByCitationId: ReadonlyMap<string, string>;
}): { quoteCitations: QuoteCitation[]; decisions: ClaimAnchorDecision[] } {
  const claims = extractClaimSentences(params.text);
  const cited = citedTokenIds(params.text);
  const decisions: ClaimAnchorDecision[] = [];
  const quoteCitations = params.quoteCitations.map(
    (citation): QuoteCitation => {
      const claim = claims.get(citation.id);
      const passage = params.passageTextByCitationId.get(citation.id);
      if (!claim) {
        // The answer cites this id from a heading, a table row or a line of
        // HTML, so there is no claim sentence to anchor against. The citation
        // still stands on the retrieved passage, and says so.
        if (!cited.has(citation.id)) return citation;
        decisions.push({
          id: citation.id,
          match: "passage",
          score: 0,
          claimSentence: "",
        });
        return { ...citation, anchorMatch: "passage" };
      }
      if (!passage) return citation;
      const chunks = splitPassageChunks(passage);
      const claimTokens = tokenSet(claim);
      let best:
        | { candidate: Candidate; shared: number; score: number }
        | undefined;
      if (claimTokens.size >= MIN_CLAIM_TOKENS) {
        for (const candidate of passageCandidates(chunks)) {
          const tokens = tokenSet(candidate.text);
          let shared = 0;
          for (const token of claimTokens) if (tokens.has(token)) shared++;
          const score = shared / claimTokens.size;
          if (shared < MIN_SHARED_TOKENS || score < MIN_OVERLAP) continue;
          if (
            !best ||
            score > best.score ||
            (score === best.score && shared > best.shared)
          ) {
            best = { candidate, shared, score };
          }
        }
      }
      if (!best || sameText(best.candidate.text, citation.quoteText)) {
        decisions.push({
          id: citation.id,
          match: best ? "claim" : "passage",
          score: best?.score || 0,
          claimSentence: claim,
        });
        return { ...citation, anchorMatch: best ? "claim" : "passage" };
      }
      const leavesSourceChunk =
        chunks.length > 1 &&
        best.candidate.chunk !==
          findSourceChunkIndex(chunks, citation.quoteText);
      const rebuilt = buildQuoteCitation({
        ...citation,
        id: citation.id,
        quoteText: best.candidate.text,
        sourceMatchText: best.candidate.text,
        displayQuoteText: undefined,
        sourceMatchPageOccurrence: undefined,
        ...(leavesSourceChunk
          ? {
              sourceSectionLabel: undefined,
              sourceChunkKind: undefined,
              sourceMatchSource: citation.sourceMatchSource
                ? "context-text"
                : undefined,
              pageHintIndex: undefined,
              pageHintLabel: undefined,
            }
          : {}),
        anchorMatch: "claim",
      });
      if (!rebuilt) {
        decisions.push({
          id: citation.id,
          match: "passage",
          score: best.score,
          claimSentence: claim,
        });
        return { ...citation, anchorMatch: "passage" };
      }
      decisions.push({
        id: citation.id,
        match: "claim",
        score: best.score,
        claimSentence: claim,
      });
      return rebuilt;
    },
  );
  return { quoteCitations, decisions };
}
