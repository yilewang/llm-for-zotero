import type { ZoteroGateway } from "../services/zoteroGateway";

/**
 * A standing description of the library the agent is operating on.
 *
 * The system prompt described the user's *computer* in concrete detail —
 * platform, shell, native path separator, a worked `ls` example, where the
 * notes directory lives — and said nothing whatsoever about the Zotero
 * library. The agent knew the machine better than the workspace, so every
 * request started with a guess: which folders exist, what they are called,
 * how big the library is.
 *
 * This is the cheap always-on half of perception. Depth still comes from
 * `library_search`; the point here is that the agent never starts blind, and
 * never has to ask the user for a collection ID that Zotero itself never
 * displays.
 */

const MAX_LISTED_COLLECTIONS = 40;

type OverviewGateway = Pick<
  ZoteroGateway,
  "listAllLibraries" | "listCollectionSummaries"
>;

/**
 * The gateway is pushed in at subsystem init rather than imported.
 *
 * Reaching for the shared singleton from the prompt builder created two
 * import cycles (messageBuilder -> index -> runtime -> messageBuilder), which
 * the repo's cycle guard rejects. Inverting it keeps the prompt layer
 * dependent only on this module.
 */
let overviewGateway: OverviewGateway | null = null;

export function setLibraryOverviewGateway(
  gateway: OverviewGateway | null,
): void {
  overviewGateway = gateway;
}

/**
 * Renders the section for the active library, or an empty string when no
 * gateway has been registered yet. A missing enhancement must never be able
 * to fail a turn.
 */
export function renderLibraryOverviewSection(
  libraryID: number | undefined,
): string {
  if (!overviewGateway) return "";
  try {
    return buildLibraryOverviewSection(overviewGateway, libraryID);
  } catch {
    return "";
  }
}

export function buildLibraryOverviewSection(
  zoteroGateway: OverviewGateway,
  libraryID: number | undefined,
): string {
  const activeLibraryID =
    Number.isFinite(libraryID) && Number(libraryID) > 0
      ? Math.floor(Number(libraryID))
      : 1;

  const lines: string[] = ["Zotero library:"];

  try {
    const libraries = zoteroGateway.listAllLibraries?.() || [];
    const active = libraries.find(
      (entry) => entry.libraryID === activeLibraryID,
    );
    if (active) {
      lines.push(
        `- Active library: "${active.name}" (libraryID=${active.libraryID}${
          active.editable === false ? ", READ-ONLY" : ""
        })`,
      );
    } else {
      lines.push(`- Active library: libraryID=${activeLibraryID}`);
    }
    const others = libraries.filter(
      (entry) => entry.libraryID !== activeLibraryID,
    );
    if (others.length) {
      lines.push(
        `- Other libraries: ${others
          .map((entry) => `"${entry.name}" (libraryID=${entry.libraryID})`)
          .join(", ")}`,
      );
    }
  } catch {
    lines.push(`- Active library: libraryID=${activeLibraryID}`);
  }

  try {
    const collections =
      zoteroGateway.listCollectionSummaries?.(activeLibraryID) || [];
    if (!collections.length) {
      lines.push("- Collections: none yet");
    } else {
      // Top-level only: the whole tree can be large, and the tree tool exists
      // for depth. Names with IDs are what stops the agent asking the user
      // for a number Zotero never shows them.
      const topLevel = collections.filter(
        (entry) => !entry.path || entry.path === entry.name,
      );
      const listed = (topLevel.length ? topLevel : collections).slice(
        0,
        MAX_LISTED_COLLECTIONS,
      );
      const rendered = listed
        .map((entry) => `${entry.name} (id=${entry.collectionId})`)
        .join(", ");
      const omitted = collections.length - listed.length;
      lines.push(
        `- Collections (${collections.length} total, top-level shown): ${rendered}${
          omitted > 0
            ? `, … ${omitted} more — use library_search({ entity:'collections', mode:'list', view:'tree' })`
            : ""
        }`,
      );
    }
  } catch {
    /* a missing collection list is not worth failing the turn over */
  }

  // A tag count is deliberately absent: `listLibraryTags` is async and this
  // section is built synchronously alongside the other prompt sections.
  // `library_search({ entity:'tags' })` covers it on demand.

  lines.push(
    "- Resolve any other name to an ID with library_search({ entity:'collections', mode:'list' }) rather than asking the user for one.",
  );

  return lines.join("\n");
}
