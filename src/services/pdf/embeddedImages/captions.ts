import { parseDocumentReferences } from "../../../shared/documentReferences";
import type { Rect } from "./geometry";

export type PageTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TextLine = {
  text: string;
  left: number;
  right: number;
  /** Baseline, PDF user space. */
  y: number;
  height: number;
};

export type CaptionMatch = { label: string; caption: string };

const CAPTION_START = /^(?:fig(?:ure)?s?\.?|tables?)\s*S?\d+/i;
const MAX_CAPTION_CHARS = 300;
const MAX_CAPTION_CONTINUATION_LINES = 3;

/** pdf.js `getTextContent()` items → positioned text runs. */
export function toPageTextItems(
  items: Array<{
    str?: string;
    transform?: ArrayLike<number>;
    width?: number;
    height?: number;
  }>,
): PageTextItem[] {
  const out: PageTextItem[] = [];
  for (const entry of items) {
    const str = (entry.str || "").trim();
    const transform = entry.transform;
    if (!str || !transform || transform.length < 6) continue;
    const height =
      Number(entry.height) > 0
        ? Number(entry.height)
        : Math.abs(transform[3]) || 10;
    out.push({
      str,
      x: transform[4],
      y: transform[5],
      width: Number(entry.width) > 0 ? Number(entry.width) : 0,
      height,
    });
  }
  return out;
}

/** Runs whose baselines lie within half a line height form one line. */
export function groupTextLines(items: PageTextItem[]): TextLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<TextLine & { parts: PageTextItem[] }> = [];
  for (const entry of sorted) {
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.y - entry.y) <=
        0.5 * Math.max(candidate.height, entry.height),
    );
    if (line) {
      line.parts.push(entry);
      line.left = Math.min(line.left, entry.x);
      line.right = Math.max(line.right, entry.x + entry.width);
      line.height = Math.max(line.height, entry.height);
    } else {
      lines.push({
        text: "",
        left: entry.x,
        right: entry.x + entry.width,
        y: entry.y,
        height: entry.height,
        parts: [entry],
      });
    }
  }
  return lines
    .map(({ parts, ...line }) => ({
      ...line,
      text: parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .sort((a, b) => b.y - a.y);
}

function overlapsHorizontally(line: TextLine, rect: Rect): boolean {
  return line.left < rect[2] && line.right > rect[0];
}

/** Distance from the image to the caption line, or null when too far. */
function captionDistance(line: TextLine, rect: Rect): number | null {
  const maxGap = Math.max(3 * line.height, 36);
  const gapBelow = rect[1] - (line.y + line.height);
  if (gapBelow >= -0.5 * line.height && gapBelow <= maxGap) {
    return Math.max(0, gapBelow);
  }
  const gapAbove = line.y - rect[3];
  if (gapAbove >= 0 && gapAbove <= maxGap) return gapAbove;
  return null;
}

function labelFor(text: string): string | null {
  const reference = parseDocumentReferences(text)[0];
  if (!reference) return null;
  return `${reference.kind === "table" ? "Table" : "Figure"} ${reference.id}`;
}

/** Nearest "Figure N"/"Table N" line just above or below the rect. */
export function findCaptionNear(
  rect: Rect,
  lines: TextLine[],
): CaptionMatch | null {
  let best: { line: TextLine; distance: number } | null = null;
  for (const line of lines) {
    if (!CAPTION_START.test(line.text)) continue;
    if (!overlapsHorizontally(line, rect)) continue;
    const distance = captionDistance(line, rect);
    if (distance === null) continue;
    if (!best || distance < best.distance) best = { line, distance };
  }
  if (!best) return null;
  const label = labelFor(best.line.text);
  if (!label) return null;

  const parts = [best.line.text];
  let previous = best.line;
  for (const line of lines) {
    if (parts.length > MAX_CAPTION_CONTINUATION_LINES) break;
    if (line.y >= previous.y) continue;
    if (previous.y - line.y > 1.6 * previous.height) break;
    if (!overlapsHorizontally(line, rect)) break;
    parts.push(line.text);
    previous = line;
  }
  return { label, caption: parts.join(" ").slice(0, MAX_CAPTION_CHARS) };
}
