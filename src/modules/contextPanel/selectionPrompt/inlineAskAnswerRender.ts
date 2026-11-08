/**
 * Renders an Inline Ask answer in a reader document: paragraphs, soft line
 * breaks, bullet and numbered lists, bold, italic, inline code, and fenced
 * code, all with inline styles (plugin CSS does not reach reader documents).
 * Math stays as text. Text goes in through text nodes only, never as markup.
 *
 * Code sizes are relative (0.88em of the 12.5px answer text = 11px), so the
 * card scales the answer by setting one font size on the container.
 *
 * The card asks for no citation markers; any `[[cite:…]]` or `[[quote:…]]`
 * token the model writes anyway is removed before rendering.
 */
import { XHTML_NS, type ReaderOverlayPalette } from "./readerOverlayShared";

export type InlineAskInline = {
  kind: "text" | "strong" | "em" | "code";
  text: string;
};

export type InlineAskBlock =
  | { kind: "paragraph"; lines: InlineAskInline[][] }
  | { kind: "list"; ordered: boolean; items: InlineAskInline[][] }
  | { kind: "code"; text: string };

const CITATION_TOKEN = /[ \t]*\[\[(?:cite|quote):[^\]\n]*\]\]/giu;

export function stripInlineAskCitationTokens(text: string): string {
  return text.replace(CITATION_TOKEN, "");
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch) && WORD_CHAR.test(ch as string);
}

/** Index of the closing single `marker`, or -1. */
function findSingleClose(text: string, start: number, marker: string): number {
  for (let j = start; j < text.length; j++) {
    if (text[j] === "\n") return -1;
    if (text[j] !== marker) continue;
    if (text[j + 1] === marker || text[j - 1] === marker) continue;
    if (j === start || /\s/u.test(text[j - 1])) continue;
    if (marker === "_" && isWordChar(text[j + 1])) continue;
    return j;
  }
  return -1;
}

export function parseInlineAskInlines(text: string): InlineAskInline[] {
  const out: InlineAskInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "$") {
      // Math stays as text: no emphasis inside $…$.
      const end = text.indexOf("$", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        buffer += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (
      (ch === "*" || ch === "_") &&
      (ch === "*" || !isWordChar(text[i - 1]))
    ) {
      if (text[i + 1] === ch) {
        const marker = ch + ch;
        const end = text.indexOf(marker, i + 2);
        if (
          end > i + 2 &&
          !text.slice(i + 2, end).includes("\n") &&
          !/\s/u.test(text[i + 2])
        ) {
          flush();
          out.push({ kind: "strong", text: text.slice(i + 2, end) });
          i = end + 2;
          continue;
        }
      } else if (!/\s/u.test(text[i + 1] ?? " ")) {
        const end = findSingleClose(text, i + 1, ch);
        if (end > i + 1) {
          flush();
          out.push({ kind: "em", text: text.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const HEADING = /^\s*#{1,6}\s+(.*)$/u;
const FENCE = /^\s*```/u;

export function parseInlineAskAnswer(text: string): InlineAskBlock[] {
  const lines = stripInlineAskCitationTokens(text)
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const blocks: InlineAskBlock[] = [];
  let current: InlineAskBlock | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) {
      close();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({
        kind: "paragraph",
        lines: [[{ kind: "strong", text: heading[1].trim() }]],
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const itemText = (bullet || numbered)![1];
      const open = current as InlineAskBlock | null;
      if (open?.kind !== "list" || open.ordered !== ordered) {
        close();
        current = { kind: "list", ordered, items: [] };
      }
      (current as Extract<InlineAskBlock, { kind: "list" }>).items.push(
        parseInlineAskInlines(itemText),
      );
      continue;
    }
    const open = current as InlineAskBlock | null;
    if (open?.kind !== "paragraph") {
      close();
      current = { kind: "paragraph", lines: [] };
    }
    (current as Extract<InlineAskBlock, { kind: "paragraph" }>).lines.push(
      parseInlineAskInlines(line.trim()),
    );
  }
  close();
  return blocks;
}

const MONO =
  'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

function appendInlines(
  doc: Document,
  parent: HTMLElement,
  inlines: InlineAskInline[],
  palette: ReaderOverlayPalette,
): void {
  for (const inline of inlines) {
    if (inline.kind === "text") {
      parent.appendChild(doc.createTextNode(inline.text));
      continue;
    }
    const tag =
      inline.kind === "strong"
        ? "strong"
        : inline.kind === "em"
          ? "em"
          : "code";
    const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
    if (inline.kind === "strong") node.style.cssText = "font-weight:600";
    if (inline.kind === "em") node.style.cssText = "font-style:italic";
    if (inline.kind === "code") {
      node.style.cssText = [
        `font-family:${MONO}`,
        "font-size:0.88em",
        `background:${palette.fieldBg}`,
        "border-radius:4px",
        "padding:0 3px",
      ].join(";");
    }
    node.textContent = inline.text;
    parent.appendChild(node);
  }
}

/** Replaces `container`'s children with the rendered answer. */
export function renderInlineAskAnswer(
  doc: Document,
  container: HTMLElement,
  text: string,
  palette: ReaderOverlayPalette,
): void {
  container.textContent = "";
  const blocks = parseInlineAskAnswer(text);
  blocks.forEach((block, index) => {
    const margin = index === blocks.length - 1 ? "0" : "0 0 0.5em";
    let node: HTMLElement;
    if (block.kind === "paragraph") {
      node = doc.createElementNS(XHTML_NS, "p") as HTMLElement;
      node.style.cssText = `margin:${margin}`;
      block.lines.forEach((line, lineIndex) => {
        if (lineIndex > 0)
          node.appendChild(doc.createElementNS(XHTML_NS, "br"));
        appendInlines(doc, node, line, palette);
      });
    } else if (block.kind === "list") {
      node = doc.createElementNS(
        XHTML_NS,
        block.ordered ? "ol" : "ul",
      ) as HTMLElement;
      node.style.cssText = `margin:${margin};padding-left:18px`;
      for (const item of block.items) {
        const li = doc.createElementNS(XHTML_NS, "li") as HTMLElement;
        li.style.cssText = "margin:0 0 2px";
        appendInlines(doc, li, item, palette);
        node.appendChild(li);
      }
    } else {
      node = doc.createElementNS(XHTML_NS, "pre") as HTMLElement;
      node.style.cssText = [
        `margin:${margin}`,
        "padding:6px 8px",
        `background:${palette.fieldBg}`,
        "border-radius:6px",
        `font-family:${MONO}`,
        "font-size:0.88em",
        "white-space:pre-wrap",
        "overflow-wrap:anywhere",
      ].join(";");
      node.textContent = block.text;
    }
    container.appendChild(node);
  });
}

function inlinesToText(inlines: InlineAskInline[]): string {
  return inlines.map((inline) => inline.text).join("");
}

/**
 * The answer as plain text for an annotation comment: the words the card
 * shows, without the Markdown markers it interprets (emphasis, code ticks,
 * headings, fences, citation tokens). Bullets become "•", numbered items
 * keep their numbers, and blocks are separated by a blank line.
 */
export function inlineAskAnswerToPlainText(text: string): string {
  return parseInlineAskAnswer(text)
    .map((block) => {
      if (block.kind === "paragraph")
        return block.lines.map(inlinesToText).join("\n");
      if (block.kind === "list")
        return block.items
          .map(
            (item, index) =>
              `${block.ordered ? `${index + 1}.` : "•"} ${inlinesToText(item)}`,
          )
          .join("\n");
      return block.text;
    })
    .join("\n\n")
    .trim();
}
