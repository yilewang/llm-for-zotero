import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import {
  decodeNoteHtmlEntities,
  NOTE_TEXT_BREAK_PATTERN,
  stripNoteHtml,
} from "./noteText";

function escapeNoteHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NOTE_TEXT_BREAK_TAG = new RegExp(
  `^(?:${NOTE_TEXT_BREAK_PATTERN.source})$`,
  "i",
);

/**
 * Map visible UTF-16 text, including synthetic block boundaries, onto native
 * source spans. Selection edits require a unique match; precise text patches
 * retain their documented first-occurrence semantics.
 */
function locateText(html: string, find: string, unique: boolean) {
  if (!find) return null;

  // Match only text tokens, never attributes. Keep the source markup intact
  // rather than serializing a parsed document or replacing an HTML range that
  // may contain just one side of an inline element.
  const textChars: string[] = [];
  type TextSpan = { start: number; end: number };
  const spans: TextSpan[][] = [];
  const append = (character: string, span?: TextSpan) => {
    const normalized = character === "\r" ? "\n" : character;
    if (normalized === "\n" && textChars.at(-1) === "\n") {
      if (span) spans[spans.length - 1].push(span);
      return;
    }
    textChars.push(normalized);
    // Synthetic separators match visible boundaries but never consume markup.
    spans.push(span ? [span] : []);
  };
  const tokens =
    /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-z][a-z\d:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*\s*\/?\s*>|&(?:#x[0-9a-f]+|#\d+|[a-z]+);|[\s\S]/gi;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (token.length > 1 && token.startsWith("<")) {
      if (NOTE_TEXT_BREAK_TAG.test(token)) append("\n");
      continue;
    }
    const decoded = decodeNoteHtmlEntities(token);
    // String.indexOf uses UTF-16 offsets, including both halves of an astral
    // character. The mapping must use the same units.
    for (let offset = 0; offset < decoded.length; offset++) {
      const isEntity = decoded !== token;
      append(decoded[offset], {
        start: match.index + (isEntity ? 0 : offset),
        end: match.index + (isEntity ? token.length : offset + 1),
      });
    }
  }

  const text = textChars.join("");
  const normalizedFind = find.replace(/[\r\n]+/g, "\n");
  const findIdx = text.indexOf(normalizedFind);
  if (findIdx < 0 || (unique && text.indexOf(normalizedFind, findIdx + 1) >= 0))
    return null;

  const matched = spans.slice(findIdx, findIdx + normalizedFind.length).flat();
  if (!matched.length) return null;
  return { matched, start: matched[0].start, end: matched.at(-1)!.end };
}

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
const blockNames = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
]);
const flowNames = new Set(["div", "blockquote", "li", "td", "th"]);
const atomNames = new Set(["img", "hr", "math", "svg", "video", "audio"]);
function isAtom(node: Node): boolean {
  return (
    "tagName" in node &&
    (atomNames.has(node.tagName) ||
      node.attrs.some(
        (a) =>
          a.name.startsWith("data-citation") || a.name === "data-annotation",
      ))
  );
}
function hasContent(html: string): boolean {
  return (
    Boolean(stripNoteHtml(html).trim()) ||
    /<(?:img|hr|math|svg|video|audio)\b|data-(?:citation|annotation)/i.test(
      html,
    )
  );
}

/** Replace a visible selection in the native tree. Complete selected blocks
 * are replaced as blocks; partial inline selections stay inside their block.
 * Source slices preserve every untouched element and attachment attribute. */
export function replaceNoteSelectionHtml(
  html: string,
  find: string,
  replacementHtml: string,
): string | null {
  const range = locateText(html, find, true);
  if (!range) return null;
  const { start: rangeStart, end: rangeEnd } = range;
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  const elements: Element[] = [];
  const visit = (node: Node) => {
    if (!("tagName" in node)) return;
    elements.push(node);
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  const encloses = (node: Element) => {
    const loc = node.sourceCodeLocation;
    return loc && loc.startOffset <= range.start && loc.endOffset >= range.end;
  };
  const cells = elements.filter(
    (n) => n.tagName === "td" || n.tagName === "th",
  );
  if (
    cells.some(
      (n) =>
        n.sourceCodeLocation &&
        n.sourceCodeLocation.startOffset < rangeEnd &&
        n.sourceCodeLocation.endOffset > rangeStart,
    ) &&
    !cells.some(encloses)
  )
    throw new Error(
      "A structural replacement cannot span table cells. Select text within one cell; no content was changed.",
    );
  const block = elements
    .filter((n) => blockNames.has(n.tagName) && encloses(n))
    .at(-1);
  if (block) {
    const loc = block.sourceCodeLocation!;
    const start = loc.startTag!.endOffset,
      end = loc.endTag?.startOffset ?? loc.endOffset;
    // A partial sentence replacement retains its current inline formatting.
    const crossesBlocks = elements.some(
      (n) =>
        n !== block &&
        blockNames.has(n.tagName) &&
        n.sourceCodeLocation &&
        n.sourceCodeLocation.startOffset > loc.startOffset &&
        n.sourceCodeLocation.startOffset < rangeEnd &&
        n.sourceCodeLocation.endOffset > rangeStart,
    );
    if (
      !crossesBlocks &&
      (hasContent(html.slice(start, range.start)) ||
        hasContent(html.slice(range.end, end)))
    ) {
      const replacement = parseFragment(replacementHtml).childNodes.filter(
        (n) =>
          n.nodeName !== "#text" ||
          (n as DefaultTreeAdapterTypes.TextNode).value.trim(),
      );
      if (
        replacement.length === 1 &&
        "tagName" in replacement[0] &&
        replacement[0].tagName === "p"
      ) {
        return replaceMappedText(
          html,
          range.matched,
          serialize(replacement[0]),
        );
      }
    }
  }
  // Keep the enclosing flow container (including Zotero's native root).
  // A completely selected list item belongs to its list, not to itself.
  const flow = elements
    .filter((n) => flowNames.has(n.tagName) && encloses(n) && n !== block)
    .at(-1);
  const nodes = flow?.childNodes || root.childNodes;
  const flowLoc = flow?.sourceCodeLocation;
  const scopeStart = flowLoc?.startTag?.endOffset ?? 0;
  const scopeEnd = flowLoc?.endTag?.startOffset ?? html.length;
  function slice(node: Node, side: "before" | "after"): string {
    const loc = node.sourceCodeLocation;
    if (!loc)
      return "childNodes" in node
        ? node.childNodes.map((n) => slice(n, side)).join("")
        : "";
    const raw = html.slice(loc.startOffset, loc.endOffset);
    if (side === "before" && loc.endOffset <= rangeStart) return raw;
    if (side === "after" && loc.startOffset >= rangeEnd) return raw;
    if (side === "before" && loc.startOffset >= rangeEnd) return "";
    if (side === "after" && loc.endOffset <= rangeStart) return "";
    // A text selection never authorizes deleting embedded media/provenance.
    if (isAtom(node)) return side === "before" ? raw : "";
    if (node.nodeName === "#text") {
      return side === "before"
        ? html.slice(loc.startOffset, Math.max(loc.startOffset, rangeStart))
        : html.slice(Math.min(loc.endOffset, rangeEnd), loc.endOffset);
    }
    if (!("tagName" in node)) return "";
    const elementLoc = node.sourceCodeLocation!;
    const children = node.childNodes.map((n) => slice(n, side)).join("");
    if (!hasContent(children)) return "";
    let opening = html.slice(loc.startOffset, elementLoc.startTag!.endOffset);
    if (side === "after" && node.tagName === "ol") {
      const preceding = node.childNodes.filter(
        (n) =>
          "tagName" in n &&
          n.tagName === "li" &&
          n.sourceCodeLocation &&
          (n.sourceCodeLocation.endTag?.startOffset ??
            n.sourceCodeLocation.endOffset) <= rangeEnd,
      ).length;
      const start =
        Number(node.attrs.find((a) => a.name === "start")?.value || 1) +
        preceding;
      if (preceding)
        opening = opening
          .replace(/\sstart\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
          .replace(/>$/, ` start="${start}">`);
    }
    return (
      opening +
      children +
      html.slice(elementLoc.endTag?.startOffset ?? loc.endOffset, loc.endOffset)
    );
  }
  const before = nodes.map((n) => slice(n, "before")).join("");
  const after = nodes.map((n) => slice(n, "after")).join("");
  return (
    html.slice(0, scopeStart) +
    before +
    replacementHtml +
    after +
    html.slice(scopeEnd)
  );
}

/** Precise patches preserve the first matching text's native markup and
 * remove fully consumed blocks. A selection replacement instead supplies its
 * own block structure through replaceNoteSelectionHtml. */
export function replaceTextContentInHtml(
  html: string,
  find: string,
  replace: string,
): string | null {
  const range = locateText(html, find, false);
  if (!range) return null;
  // Remove fully consumed blocks after the insertion point, while retaining
  // the first block's formatting and every embedded image or citation.
  const deletions = [...range.matched];
  const visit = (node: Node) => {
    if (!("tagName" in node)) return;
    const loc = node.sourceCodeLocation;
    if (
      loc &&
      blockNames.has(node.tagName) &&
      loc.startOffset > range.start &&
      (loc.endTag?.startOffset ?? loc.endOffset) <= range.end &&
      !/<(?:img|hr|math|svg|video|audio)\b|data-(?:citation|annotation)/i.test(
        html.slice(loc.startOffset, loc.endOffset),
      )
    ) {
      deletions.push({ start: loc.startOffset, end: loc.endOffset });
      return;
    }
    node.childNodes.forEach(visit);
  };
  parseFragment(html, { sourceCodeLocationInfo: true }).childNodes.forEach(
    visit,
  );
  deletions.sort((a, b) => a.start - b.start || b.end - a.end);
  return replaceMappedText(html, deletions, escapeNoteHtml(replace));
}

function replaceMappedText(
  html: string,
  matched: { start: number; end: number }[],
  replacementHtml: string,
): string {
  const parts = [html.slice(0, matched[0].start), replacementHtml];
  let cursor = matched[0].end;
  for (const span of matched.slice(1)) {
    if (span.start >= cursor) parts.push(html.slice(cursor, span.start));
    cursor = Math.max(cursor, span.end);
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}
