import {
  buildCitationChipHtml,
  findMalformedCitationRequests,
  formatCitationFallback,
  hasNewCitationTokens,
  NEW_CITATION_TOKEN_PATTERN,
  parseNewCitationToken,
  type NoteCitationItem,
} from "../../utils/noteCitations";
import { collectNoteEmbeds, type NoteEmbed } from "../../utils/noteEmbeds";
import { stripNoteHtml } from "../../utils/noteText";

/** Find the Zotero item a `{{cite item=…}}` names: an item id or item key. */
export type CitationItemLookup = (
  itemRef: string,
) => Zotero.Item | null | undefined;

export type ExpandedNewCitations = {
  /** The text with each `{{cite …}}` replaced by its chip's placeholder. */
  text: string;
  /** The new chips, by placeholder id. */
  registry: Map<string, NoteEmbed>;
  /** The cited works, for the note's root registry. */
  citationItems: NoteCitationItem[];
};

/** The work a citation points at: a regular item, or the parent of the
 * attachment or annotation the model named. Notes cannot be cited. */
function citableItem(item: Zotero.Item | null | undefined): Zotero.Item | null {
  let current = item || null;
  for (let depth = 0; current && depth < 3; depth++) {
    if (current.isRegularItem?.()) return current;
    if (current.isNote?.()) return null;
    current = (current.parentItem as Zotero.Item | undefined) || null;
  }
  return null;
}

function zoteroCitationFormatter() {
  if (typeof Zotero === "undefined") return formatCitationFallback;
  const utilities = (
    Zotero as unknown as {
      EditorInstanceUtilities?: {
        formatCitation?: (citation: object) => string;
      };
    }
  ).EditorInstanceUtilities;
  if (typeof utilities?.formatCitation !== "function")
    return formatCitationFallback;
  return (citation: Parameters<typeof formatCitationFallback>[0]) => {
    try {
      return (
        utilities.formatCitation!(citation) || formatCitationFallback(citation)
      );
    } catch {
      return formatCitationFallback(citation);
    }
  };
}

/**
 * Turn the model's `{{cite item=… page=…}}` requests into Zotero citation
 * chips. Each request becomes an ordinary `{{citation:id}}` placeholder of a
 * new chip, so placing, moving and preserving it work like any existing
 * citation. A request for an item that cannot be cited is refused.
 */
export function expandNewCitationTokens(
  text: string,
  lookup: CitationItemLookup,
): ExpandedNewCitations {
  const registry = new Map<string, NoteEmbed>();
  const citationItems: NoteCitationItem[] = [];
  const problems: string[] = [];
  if (!text || !hasNewCitationTokens(text))
    return { text, registry, citationItems };
  const format = zoteroCitationFormatter();
  const expanded = text.replace(NEW_CITATION_TOKEN_PATTERN, (token, body) => {
    const requests = parseNewCitationToken(body);
    if (!requests) {
      problems.push(
        `${token} is not a citation request; write {{cite item=<itemId> page=<page label>}}.`,
      );
      return token;
    }
    const parts: Parameters<typeof buildCitationChipHtml>[0] = [];
    for (const request of requests) {
      const item = citableItem(lookup(request.itemRef));
      if (!item) {
        problems.push(
          `${token}: ${request.itemRef} is not a Zotero paper or book that can be cited (use the regular item's itemId).`,
        );
        return token;
      }
      const uri = Zotero.URI.getItemURI(item);
      const itemData = Zotero.Utilities.Item.itemToCSLJSON(item) as Record<
        string,
        unknown
      >;
      parts.push({ uri, locator: request.locator, itemData });
      if (!citationItems.some((entry) => entry.uris.includes(uri)))
        citationItems.push({ uris: [uri], itemData });
    }
    const chip = collectNoteEmbeds(buildCitationChipHtml(parts, format))[0];
    registry.set(chip.id, chip);
    return `{{citation:${chip.id}}}`;
  });
  // A near miss such as {{cite:item=12}} would be saved as raw text.
  for (const token of findMalformedCitationRequests(expanded))
    problems.push(
      `${token} is not a citation request; write {{cite item=<itemId> page=<page label>}}.`,
    );
  if (problems.length)
    throw new Error(`${problems.join(" ")} No content was changed.`);
  return { text: expanded, registry, citationItems };
}

/** The items and locators one chip cites, as a comparable string. */
function citationSignature(
  citation: {
    citationItems?: Array<{ uris?: string[]; locator?: string }>;
  } | null,
): string {
  return JSON.stringify(
    (citation?.citationItems || []).map((item) => [
      item.uris || [],
      item.locator || "",
    ]),
  );
}

/** What each chip in the HTML cites: its item URIs and locators, in order. */
export function citationSignatures(html: string): string[] {
  const signatures: string[] = [];
  for (const match of html.matchAll(
    /\bdata-citation=(?:"([^"]*)"|'([^']*)')/g,
  )) {
    try {
      signatures.push(
        citationSignature(
          JSON.parse(decodeURIComponent(match[1] ?? match[2] ?? "")),
        ),
      );
    } catch {
      signatures.push("");
    }
  }
  return signatures;
}

/**
 * What a note holds for a body that has `{{cite …}}` requests: the text it
 * shows, with each request replaced by the text of the chip it becomes, and
 * the items and locators those chips cite. A stored note holds the chips and
 * not the requests, so it is compared with this. Two works can share a
 * label, so the cited items are compared as well as the text. A request that
 * cannot be expanded throws, as it does when the note is built.
 */
export function newCitationRequestsExpected(
  text: string,
  lookup: CitationItemLookup,
): { text: string; citations: string[] } {
  if (!hasNewCitationTokens(text)) return { text, citations: [] };
  const expanded = expandNewCitationTokens(text, lookup);
  const citations: string[] = [];
  const shown = expanded.text.replace(
    /\{\{citation:([0-9a-f]{6,8})\}\}/g,
    (token, id) => {
      const chip = expanded.registry.get(id);
      if (!chip) return token;
      citations.push(...citationSignatures(chip.html));
      return stripNoteHtml(chip.html);
    },
  );
  return { text: shown, citations };
}
