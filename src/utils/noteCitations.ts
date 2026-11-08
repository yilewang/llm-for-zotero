import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { escapeNoteHtml } from "./textSanitization";

/**
 * New Zotero citations written by the model.
 *
 * The model asks for a citation with `{{cite item=123 page=42}}` (several:
 * `{{cite item=123 page=42; item=456 page=7}}`). The host turns it into the
 * same chip Zotero's note editor makes with Insert Citation, so clicking it
 * opens the cited paper's PDF at that page.
 *
 * The chip shape, the root registry and the label format follow Zotero's
 * own EditorInstanceUtilities (chrome/content/zotero/xpcom/editorInstance.js):
 * the chip carries only the item URI and page; the item's CSL data lives once
 * in the note root's `data-citation-items`, which Zotero reads only from a
 * top-level `div[data-schema-version]`.
 */

/** A citation request in model text. The body never spans lines, and it
 * starts with item=, so other templates such as {{cite web|…}} are text. */
export const NEW_CITATION_TOKEN_PATTERN =
  /\{\{cite\s+(item\s*=[^{}\n]*?)\s*\}\}/g;

/** Text that looks like a citation request, well formed or not. */
const CITATION_REQUEST_LIKE = /\{\{\s*cite\s*[:=]?\s*item\b[^}\n]*\}?\}?/gi;

/** Schema version Zotero writes when a note uses no newer features. */
const NOTE_SCHEMA_VERSION = "9";

export type NewCitationRequest = {
  /** A Zotero item id or item key, as the model wrote it. */
  itemRef: string;
  /** Page label, e.g. "42" or "42-45"; omitted cites the whole work. */
  locator?: string;
};

/** One cited work, as Zotero stores it in the note's root registry. */
export type NoteCitationItem = {
  uris: string[];
  itemData: Record<string, unknown>;
};

/** Parse a `{{cite …}}` body; null when it is malformed. */
export function parseNewCitationToken(
  body: string,
): NewCitationRequest[] | null {
  const parts = body.split(";").map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) return null;
  const requests: NewCitationRequest[] = [];
  for (const part of parts) {
    const match =
      /^item\s*=\s*([A-Za-z0-9]+)(?:\s*,?\s+pages?\s*=\s*(\S(?:.*\S)?))?$/i.exec(
        part,
      );
    if (!match) return null;
    requests.push({ itemRef: match[1], locator: match[2] || undefined });
  }
  return requests;
}

export function hasNewCitationTokens(text: string): boolean {
  return new RegExp(CITATION_REQUEST_LIKE.source, "i").test(text);
}

/** Citation-request look-alikes left in text after the real ones were read,
 * such as {{cite:item=12}}: they would otherwise be saved as raw text. */
export function findMalformedCitationRequests(text: string): string[] {
  return text.match(new RegExp(CITATION_REQUEST_LIKE.source, "gi")) || [];
}

type CslName = { family?: string; given?: string; literal?: string };

/**
 * Zotero's citation label, for hosts without Zotero's own formatter:
 * "Smith, 2020, p. 42", "Smith and Lee, 2020", "Smith et al., 2020, pp. 4-9",
 * or the quoted title when there are no authors.
 */
export function formatCitationItemPreview(citationItem: {
  itemData: Record<string, unknown>;
  locator?: string;
}): string {
  const { itemData } = citationItem;
  const authors = (itemData.author as CslName[] | undefined) || [];
  const name = (author: CslName) => author.family || author.literal || "";
  let text =
    authors.length === 1
      ? name(authors[0])
      : authors.length === 2
        ? `${name(authors[0])} and ${name(authors[1])}`
        : authors.length >= 3
          ? `${name(authors[0])} et al.`
          : "";
  if (!text && typeof itemData.title === "string" && itemData.title)
    text = `“${itemData.title}”`;
  const issued = itemData.issued as { "date-parts"?: unknown[][] } | undefined;
  const year = issued?.["date-parts"]?.[0]?.[0];
  if (year && String(year) !== "0000") text += `, ${year}`;
  if (citationItem.locator)
    text += `, ${/[-–,]/.test(citationItem.locator) ? "pp." : "p."} ${citationItem.locator}`;
  return text;
}

/** Zotero's formatted chip content: `(<span class="citation-item">…</span>; …)`. */
export function formatCitationFallback(citation: {
  citationItems: Array<{ itemData: Record<string, unknown>; locator?: string }>;
}): string {
  return `(${citation.citationItems
    .map(
      (item) =>
        `<span class="citation-item">${escapeNoteHtml(formatCitationItemPreview(item))}</span>`,
    )
    .join("; ")})`;
}

/** A citation chip, exactly as Zotero's note editor serializes one. */
export function buildCitationChipHtml(
  items: Array<{
    uri: string;
    locator?: string;
    itemData: Record<string, unknown>;
  }>,
  format: (citation: {
    citationItems: Array<{
      uris: string[];
      locator?: string;
      itemData: Record<string, unknown>;
    }>;
    properties: Record<string, never>;
  }) => string = formatCitationFallback,
): string {
  const citationItems = items.map((item) => ({
    uris: [item.uri],
    ...(item.locator ? { locator: item.locator } : {}),
  }));
  const citation = { citationItems, properties: {} };
  const withData = {
    citationItems: items.map((item, index) => ({
      ...citationItems[index],
      itemData: item.itemData,
    })),
    properties: {} as Record<string, never>,
  };
  return `<span class="citation" data-citation="${encodeURIComponent(
    JSON.stringify(citation),
  )}">${format(withData)}</span>`;
}

function topLevelRoot(html: string) {
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
  return root;
}

/**
 * Register cited works in the note's root `data-citation-items`, adding a
 * Zotero root container when the note has none. A work already registered
 * under one of the same URIs is kept as it is.
 */
export function mergeNoteCitationItems(
  html: string,
  items: readonly NoteCitationItem[],
): string {
  if (!items.length) return html;
  const root = topLevelRoot(html);
  let registered: NoteCitationItem[] = [];
  const existing = root?.attrs.find(
    (attr) => attr.name === "data-citation-items",
  )?.value;
  if (existing) {
    try {
      const parsed = JSON.parse(decodeURIComponent(existing));
      if (Array.isArray(parsed)) registered = parsed;
    } catch {
      registered = [];
    }
  }
  const merged = [...registered];
  for (const item of items)
    if (
      !merged.some((entry) =>
        entry.uris?.some((uri) => item.uris.includes(uri)),
      )
    )
      merged.push(item);
  const encoded = encodeURIComponent(JSON.stringify(merged));
  if (!root)
    return `<div data-citation-items="${encoded}" data-schema-version="${NOTE_SCHEMA_VERSION}">${html}</div>`;
  if (merged.length === registered.length && existing) return html;
  const loc = root.sourceCodeLocation!.startTag!;
  const opening = html.slice(loc.startOffset, loc.endOffset);
  const nextOpening = /\sdata-citation-items\s*=/i.test(opening)
    ? opening.replace(
        /(\sdata-citation-items\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        `$1"${encoded}"`,
      )
    : opening.replace(/^<div\b/i, `<div data-citation-items="${encoded}"`);
  return (
    html.slice(0, loc.startOffset) + nextOpening + html.slice(loc.endOffset)
  );
}
