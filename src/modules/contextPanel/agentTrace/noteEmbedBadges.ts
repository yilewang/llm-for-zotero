import { NOTE_EMBED_TOKEN_PATTERN } from "../../../utils/noteEmbeds";
import {
  NEW_CITATION_TOKEN_PATTERN,
  parseNewCitationToken,
} from "../../../utils/noteCitations";

/**
 * Note placeholders, shown as badges in a note review preview.
 *
 * The review editor keeps placeholders such as
 * `{{citation:3fa9c1 ("Smith", 2020, p. 42)}}`, because they are what is
 * saved. The preview is for reading, so each placeholder appears there as a
 * small badge with what the item shows in the note.
 */

export type NoteEmbedBadge = {
  kind: "citation" | "highlight" | "image" | "embed";
  text: string;
  title: string;
};

const KIND_NAMES: Record<NoteEmbedBadge["kind"], string> = {
  citation: "Zotero citation",
  highlight: "PDF highlight",
  image: "Image",
  embed: "Embedded item",
};

const BADGE_PATTERN = new RegExp(
  `${NOTE_EMBED_TOKEN_PATTERN.source}|${NEW_CITATION_TOKEN_PATTERN.source}`,
  "g",
);

function badgeFor(match: RegExpMatchArray): NoteEmbedBadge {
  // Groups: 1 kind and 2 id of a placeholder, 3 body of a new citation.
  if (match[3] !== undefined) {
    const requests = parseNewCitationToken(match[3]) || [];
    return {
      kind: "citation",
      text: requests.length
        ? `New citation: ${requests
            .map(
              (request) =>
                `item ${request.itemRef}${request.locator ? `, p. ${request.locator}` : ""}`,
            )
            .join("; ")}`
        : match[0],
      title: "A Zotero citation this change adds",
    };
  }
  const kind = match[1] as NoteEmbedBadge["kind"];
  const token = match[0];
  const space = token.search(/[ \t]/);
  const label = space < 0 ? "" : token.slice(space + 1, -2).trim();
  return {
    kind,
    text: label || KIND_NAMES[kind],
    title: `${KIND_NAMES[kind]}, kept exactly as it is in the note`,
  };
}

/** Text split into plain runs and the badges of its placeholders. */
export function splitNoteEmbedBadges(
  text: string,
): Array<string | NoteEmbedBadge> {
  const parts: Array<string | NoteEmbedBadge> = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(BADGE_PATTERN.source, "g"))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(badgeFor(match));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

const TEXT_NODE = 3;

/** Replace placeholders in a rendered preview by badges. Code stays as is. */
export function decorateNoteEmbedBadges(root: Element, doc: Document): void {
  const texts: Text[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      texts.push(node as Text);
      return;
    }
    const tag = (node as Element).tagName?.toLowerCase();
    if (tag === "code" || tag === "pre" || tag === "textarea") return;
    node.childNodes.forEach(visit);
  };
  visit(root);
  for (const node of texts) {
    const parts = splitNoteEmbedBadges(node.nodeValue || "");
    if (parts.every((part) => typeof part === "string")) continue;
    const fragment = doc.createDocumentFragment();
    for (const part of parts) {
      if (typeof part === "string") {
        fragment.append(doc.createTextNode(part));
        continue;
      }
      const badge = doc.createElement("span");
      badge.className = "llm-note-embed-badge";
      badge.dataset.kind = part.kind;
      badge.textContent = part.text;
      badge.title = part.title;
      fragment.append(badge);
    }
    node.replaceWith(fragment);
  }
}
