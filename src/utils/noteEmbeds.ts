import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { canonicalNoteHtml } from "./noteHtml";
import { stripNoteHtml } from "./noteText";
import { escapeNoteHtml } from "./textSanitization";

/**
 * Embedded note items: the parts of a Zotero note that are objects rather
 * than text. A citation chip, a highlight dragged in from the PDF, a picture.
 * Their meaning lives in hidden attributes (`data-citation`,
 * `data-annotation`, `data-attachment-key`) that no text view can carry.
 *
 * The model reads a note as text, so every embedded item is shown to it as a
 * placeholder such as `{{citation:3fa9c1 ("Smith", 2020, p. 42)}}`. Whatever
 * the model writes back, each placeholder is turned into the item's exact
 * original HTML again, so an edit can move an item but never damage it. The
 * text after the id is a read-only label; only the kind and id are read back.
 *
 * Ids are derived from the item's own content, not from its position, so a
 * placeholder still names the same item after the note around it changes.
 */

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

export type NoteEmbedKind = "citation" | "highlight" | "image" | "embed";

export type NoteEmbed = {
  id: string;
  kind: NoteEmbedKind;
  /** Identity of the item: equal for two copies of the same item. */
  key: string;
  /** The item's exact source HTML. */
  html: string;
  /** Read-only description shown to the model inside the placeholder. */
  label: string;
  start: number;
  end: number;
};

const MEDIA_TAGS = new Set(["img", "math", "svg", "video", "audio"]);
const MAX_LABEL_LENGTH = 300;

/** The kinds a placeholder may name, in the order the pattern lists them. */
const KIND_PATTERN = "citation|highlight|image|embed";

/** A placeholder in plain text or Markdown. The label never spans lines. */
export const NOTE_EMBED_TOKEN_PATTERN = new RegExp(
  `\\{\\{(${KIND_PATTERN}):([0-9a-f]{6,8})(?:[ \\t][^\\n]*?)?\\}\\}`,
  "g",
);

/** A placeholder inside serialized HTML text, which cannot contain a tag. */
const HTML_TOKEN_PATTERN = new RegExp(
  `\\{\\{(${KIND_PATTERN}):([0-9a-f]{6,8})(?:[ \\t][^\\n<>]*?)?\\}\\}`,
  "g",
);

function isEmbedElement(node: Node): node is Element {
  return (
    "tagName" in node &&
    (MEDIA_TAGS.has(node.tagName) ||
      node.attrs.some(
        (attr) =>
          attr.name === "data-citation" || attr.name === "data-annotation",
      ))
  );
}

function embedKind(element: Element): NoteEmbedKind {
  if (element.tagName === "img") return "image";
  if (element.attrs.some((attr) => attr.name === "data-citation"))
    return "citation";
  if (element.attrs.some((attr) => attr.name === "data-annotation"))
    return "highlight";
  return "embed";
}

function embedLabel(element: Element, html: string, kind: NoteEmbedKind) {
  let label =
    kind === "image"
      ? element.attrs.find((attr) => attr.name === "alt")?.value || ""
      : kind === "embed"
        ? element.tagName
        : stripNoteHtml(html);
  label = label.replace(/\s+/g, " ").replace(/\{/g, "(").replace(/\}/g, ")");
  label = label.trim();
  return label.length > MAX_LABEL_LENGTH
    ? `${label.slice(0, MAX_LABEL_LENGTH).trimEnd()}…`
    : label;
}

/** 32-bit FNV-1a, as eight hex digits. Stable across sessions and builds. */
function hashKey(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Every outermost embedded item in document order. */
export function collectNoteEmbeds(html: string): NoteEmbed[] {
  if (
    !html ||
    !/<(?:img|math|svg|video|audio)\b|data-(?:citation|annotation)\b/i.test(
      html,
    )
  )
    return [];
  const found: Omit<NoteEmbed, "id">[] = [];
  const visit = (node: Node) => {
    if (!("tagName" in node)) return;
    const loc = node.sourceCodeLocation;
    if (isEmbedElement(node) && loc) {
      const source = html.slice(loc.startOffset, loc.endOffset);
      const kind = embedKind(node);
      found.push({
        kind,
        key: canonicalNoteHtml(source),
        html: source,
        label: embedLabel(node, source, kind),
        start: loc.startOffset,
        end: loc.endOffset,
      });
      return;
    }
    node.childNodes.forEach(visit);
  };
  parseFragment(html, { sourceCodeLocationInfo: true }).childNodes.forEach(
    visit,
  );
  // Six hex digits is enough to tell a note's items apart; two different
  // items that still collide are named by all eight.
  const longIds = new Map<string, string>();
  const shortOwners = new Map<string, Set<string>>();
  for (const embed of found) {
    const long = hashKey(embed.key);
    longIds.set(embed.key, long);
    const owners = shortOwners.get(long.slice(0, 6)) || new Set<string>();
    owners.add(embed.key);
    shortOwners.set(long.slice(0, 6), owners);
  }
  return found.map((embed) => {
    const long = longIds.get(embed.key)!;
    const id =
      shortOwners.get(long.slice(0, 6))!.size > 1 ? long : long.slice(0, 6);
    return { ...embed, id };
  });
}

export function formatNoteEmbedToken(
  embed: Pick<NoteEmbed, "kind" | "id" | "label">,
  options: { label?: boolean } = {},
): string {
  const label = options.label === false ? "" : embed.label;
  return `{{${embed.kind}:${embed.id}${label ? ` ${label}` : ""}}}`;
}

/** The note's items by id, one entry per distinct item. */
export function noteEmbedRegistry(html: string): Map<string, NoteEmbed> {
  const registry = new Map<string, NoteEmbed>();
  for (const embed of collectNoteEmbeds(html))
    if (!registry.has(embed.id)) registry.set(embed.id, embed);
  return registry;
}

export const NOTE_EMBED_PLACEHOLDER_GUIDANCE =
  "Embedded note items: {{citation:id …}}, {{highlight:id …}}, {{image:id …}} and {{embed:id …}} stand for a clickable Zotero citation, a highlight linked to the PDF, a picture, or other media in this note. The text after the id is a read-only label. When you edit the note, keep every placeholder in the text you write, where its item belongs; moving it moves the item, and {{kind:id}} without the label is enough. Never change a label, never write the label as plain text instead of the placeholder, and never invent a placeholder. Delete an item only when the user asks: list its id in note_write removeEmbeds and omit its placeholder. To add a new citation, write {{cite item=<regular item's itemId> page=<pageLabel from paper_read>}}.";

/**
 * Placeholders of the note text whose items a selected passage shows. A
 * selection is visible editor text, so an item is found by its label.
 */
export function findNoteEmbedTokensInSelection(
  noteText: string,
  selectedText: string,
): string[] {
  const selected = selectedText.replace(/\s+/g, " ");
  const found: string[] = [];
  for (const match of noteText.matchAll(NOTE_EMBED_TOKEN_PATTERN)) {
    const token = match[0];
    const space = token.search(/[ \t]/);
    const label =
      space < 0
        ? ""
        : token
            .slice(space + 1, -2)
            .replace(/…$/, "")
            .trim();
    if (label && selected.includes(label) && !found.includes(token))
      found.push(token);
  }
  return found;
}

export function hasNoteEmbedTokens(text: string): boolean {
  return new RegExp(NOTE_EMBED_TOKEN_PATTERN.source).test(text);
}

/** The ids named by placeholders in text, in order, repeats included. */
export function findNoteEmbedTokenIds(text: string): string[] {
  return Array.from(
    text.matchAll(NOTE_EMBED_TOKEN_PATTERN),
    (match) => match[2],
  );
}

/** What an item shows as text, e.g. "(Smith, 2020, p. 42)". */
export function noteEmbedVisibleText(embed: Pick<NoteEmbed, "html">): string {
  return stripNoteHtml(embed.html).replace(/\s+/g, " ").trim();
}

/**
 * Swap a plain-text copy of an item's label for the item's placeholder.
 *
 * The model sometimes retypes a citation's label, "(Smith, 2020, p. 42)",
 * instead of keeping its placeholder. Left alone, that label is saved as
 * plain words beside the real chip, or the chip is lost. Each given item
 * not already named by a placeholder claims the first plain copy of its
 * label, outside any placeholder. Images and media have no label to match.
 */
export function adoptRetypedNoteEmbedLabels(
  text: string,
  embeds: readonly NoteEmbed[],
): string {
  const claimed = new Map<string, number>();
  for (const id of findNoteEmbedTokenIds(text))
    claimed.set(id, (claimed.get(id) || 0) + 1);
  let out = text;
  for (const embed of embeds) {
    const count = claimed.get(embed.id) || 0;
    if (count) {
      claimed.set(embed.id, count - 1);
      continue;
    }
    if (embed.kind !== "citation" && embed.kind !== "highlight") continue;
    const visible = noteEmbedVisibleText(embed);
    if (visible.length < 3) continue;
    const token = formatNoteEmbedToken(embed, { label: false });
    // Only text between placeholders is searched, never a label inside one.
    const tokens = Array.from(
      out.matchAll(new RegExp(NOTE_EMBED_TOKEN_PATTERN.source, "g")),
      (match) => [match.index, match.index + match[0].length],
    );
    let at = out.indexOf(visible);
    while (
      at >= 0 &&
      tokens.some(([start, end]) => at < end && at + visible.length > start)
    )
      at = out.indexOf(visible, at + 1);
    if (at >= 0)
      out = out.slice(0, at) + token + out.slice(at + visible.length);
  }
  return out;
}

/**
 * The distinct items, by id, that show each text. Copies of one item share
 * an id, so they count once; two different works that both show
 * "(Smith, 2020)" count twice, and retyped text cannot tell them apart.
 */
export function noteEmbedsByVisibleText(
  embeds: readonly NoteEmbed[],
): Map<string, NoteEmbed[]> {
  const owners = new Map<string, NoteEmbed[]>();
  for (const embed of embeds) {
    const visible = noteEmbedVisibleText(embed);
    const ids = owners.get(visible) || [];
    if (!ids.some((entry) => entry.id === embed.id)) ids.push(embed);
    owners.set(visible, ids);
  }
  return owners;
}

/** Replace each item in note HTML by its placeholder, escaped as HTML text. */
export function replaceNoteEmbedsWithTokens(html: string): string {
  const embeds = collectNoteEmbeds(html);
  if (!embeds.length) return html;
  let out = "";
  let cursor = 0;
  for (const embed of embeds) {
    out +=
      html.slice(cursor, embed.start) +
      escapeNoteHtml(formatNoteEmbedToken(embed));
    cursor = embed.end;
  }
  return out + html.slice(cursor);
}

/** Text with each placeholder replaced by its label, for places that have no
 * note to restore the item from. The label is what the item displays. */
export function replaceNoteEmbedTokensWithLabels(text: string): string {
  return text.replace(NOTE_EMBED_TOKEN_PATTERN, (token) => {
    const space = token.search(/[ \t]/);
    return space < 0 ? "" : token.slice(space + 1, -2).trim();
  });
}

/** Replace placeholders in serialized HTML text (never inside a tag) by the
 * items' HTML. Ids the registry does not hold are reported, not guessed. */
export function restoreNoteEmbedTokensInHtml(
  html: string,
  registry: Map<string, NoteEmbed>,
): { html: string; unknown: string[] } {
  const unknown: string[] = [];
  const restored = html.replace(/(<[^>]*>)|([^<]+)/g, (part, tag, text) => {
    if (tag) return tag;
    return (text as string).replace(HTML_TOKEN_PATTERN, (token, _kind, id) => {
      const embed = registry.get(id);
      if (embed) return embed.html;
      unknown.push(token);
      return token;
    });
  });
  return { html: restored, unknown };
}

/**
 * Hand an item in a replaced range to the replacement that names it. Each
 * placeholder in the replacement can carry one existing copy of its item;
 * an item that is carried is removed from its old place, so a moved item is
 * never doubled. Call once per item, in document order.
 */
export function createNoteEmbedCarrier(
  replacementHtml: string,
): (itemHtml: string) => boolean {
  const available = new Map<string, number>();
  for (const embed of collectNoteEmbeds(replacementHtml))
    available.set(embed.key, (available.get(embed.key) || 0) + 1);
  return (itemHtml) => {
    const key = canonicalNoteHtml(itemHtml);
    const count = available.get(key) || 0;
    if (!count) return false;
    available.set(key, count - 1);
    return true;
  };
}

/** Copies of items the original note holds and the next version lacks: one
 * entry per lost copy, so two lost copies of one item count twice. */
export function findMissingNoteEmbeds(
  originalHtml: string,
  nextHtml: string,
): NoteEmbed[] {
  const have = new Map<string, number>();
  for (const embed of collectNoteEmbeds(nextHtml))
    have.set(embed.key, (have.get(embed.key) || 0) + 1);
  const missing: NoteEmbed[] = [];
  for (const embed of collectNoteEmbeds(originalHtml)) {
    const count = have.get(embed.key) || 0;
    if (count > 0) have.set(embed.key, count - 1);
    else missing.push(embed);
  }
  return missing;
}

/** The opening tag of Zotero's root note container, when the note has one. */
function noteRootOpeningTag(html: string): string | null {
  const nodes = parseFragment(html, {
    sourceCodeLocationInfo: true,
  }).childNodes.filter(
    (node) =>
      node.nodeName !== "#text" ||
      (node as DefaultTreeAdapterTypes.TextNode).value.trim(),
  );
  const root = nodes.length === 1 ? nodes[0] : undefined;
  if (
    !root ||
    !("tagName" in root) ||
    root.tagName !== "div" ||
    !root.attrs.some((attr) => attr.name === "data-schema-version") ||
    !root.sourceCodeLocation?.startTag
  )
    return null;
  return html.slice(
    root.sourceCodeLocation.startOffset,
    root.sourceCodeLocation.startTag.endOffset,
  );
}

/**
 * Keep the original note's root container on a rebuilt note. The root holds
 * the note's citation registry (`data-citation-items`), which Zotero uses to
 * display the citations inside it.
 */
export function preserveNoteRoot(
  originalHtml: string,
  nextHtml: string,
): string {
  const root = noteRootOpeningTag(originalHtml);
  if (!root || noteRootOpeningTag(nextHtml)) return nextHtml;
  return `${root}${nextHtml}</div>`;
}
