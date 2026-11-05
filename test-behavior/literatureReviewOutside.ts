import { loadPlanDocument } from "../src/agent/documents/store";
import { outsidePaperUri } from "../src/agent/documents/outsidePaperCitations";
import {
  isOutsideBibliographyEntry,
  isOutsideCitationSource,
  type DocumentArtifact,
  type DocumentArtifactV2,
} from "../src/agent/documents/types";
import type { AgentEvent, AgentPendingAction } from "../src/agent/types";
import {
  assertExact,
  check,
  paperCardAnswer,
  type CardAnswer,
  type StepOutcome,
} from "./core";
import { catalog } from "./catalog";
import type { Turn } from "./driver";
import type { JourneyContext } from "./journeys";
import {
  assertLibraryScopeReached,
  calls,
  papersRead,
  record,
  results,
} from "./literatureReviewDigest";
import { diff, snapshot, onlyChanges } from "./native";

declare const Zotero: any;

/**
 * Topics the fixture library does not cover. The fixtures hold neural
 * population coding, representational drift and a turbine sentinel; each
 * journey also checks the run's own library for its topic before it starts.
 */
export const OUTSIDE_CITE_TOPIC = {
  name: "perovskite solar cell degradation",
  pattern: /perovskite|solar cell/i,
};
export const OUTSIDE_IMPORT_TOPIC = {
  name: "green roofs and urban heat island mitigation",
  pattern: /green roof|heat island/i,
};
export const OUTSIDE_CHAT_TOPIC = {
  name: "intermittent fasting and gut microbiota",
  pattern: /fasting|microbiota|microbiome/i,
};

export const OUTSIDE_CITE_PROMPT = `Write a short literature review on ${OUTSIDE_CITE_TOPIC.name}, with citations. My library has no papers on this, so use the published literature.`;
export const OUTSIDE_IMPORT_PROMPT = `Write a short literature review on ${OUTSIDE_IMPORT_TOPIC.name}, with citations. My library has no papers on this, so use the published literature.`;
export const OUTSIDE_LATER_IMPORT_PROMPT =
  "Import the papers this review cites.";
export const OUTSIDE_CHAT_PROMPT = `What do papers say about ${OUTSIDE_CHAT_TOPIC.name}? Give me a short answer.`;

type Topic = { name: string; pattern: RegExp };

/** The mode the catalog row declares, so a journey never drifts from it. */
function modeOf(id: string) {
  const row = catalog.find((entry) => entry.id === id);
  check(row, `No catalog row ${id}`);
  return row.mode;
}

/** The titles in the run's library that match a topic's pattern. */
async function libraryTitlesOn(
  ctx: JourneyContext,
  topic: Topic,
): Promise<string[]> {
  const items: any[] = await Zotero.Items.getAll(ctx.fixtures.libraryID, true);
  return items
    .filter((item) => item.isRegularItem())
    .map((item) => String(item.getField("title") || ""))
    .filter((title) => topic.pattern.test(title));
}

/** A BLOCKED outcome when the library already covers the topic. */
async function blockedWhenLibraryCovers(
  ctx: JourneyContext,
  topic: Topic,
): Promise<StepOutcome | undefined> {
  const titles = await libraryTitlesOn(ctx, topic);
  return titles.length
    ? {
        status: "BLOCKED",
        detail: `The library holds ${titles.length} paper(s) on "${topic.name}" (${titles.slice(0, 3).join("; ")}); the review would not need outside papers.`,
      }
    : undefined;
}

// ---------------------------------------------------------------------------
// Card answers

type CardLog = { actionId: string; rowIds: string[] };

/**
 * Answers the paper selection card (`literature_review`) with one of its
 * buttons and its ticked rows, as the card sends them. Any other card stays
 * unanswered, so the driver fails the turn on it.
 */
export function answerPaperCard(
  actionId: "cite" | "import",
  log: CardLog[],
): (action: AgentPendingAction) => CardAnswer | undefined {
  return (action) => {
    if (action.toolName !== "literature_review") return undefined;
    const answer = paperCardAnswer(action, actionId);
    log.push({
      actionId,
      rowIds: (answer.data?.selectedPaperIds as string[]) || [],
    });
    return { ...answer, effect: actionId === "import" };
  };
}

/** The paper selection cards the turn showed. */
function paperCards(events: AgentEvent[]): AgentPendingAction[] {
  return events.flatMap((event) =>
    event.type === "confirmation_required" &&
    event.action.toolName === "literature_review"
      ? [event.action]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Turn checks (pure, over the recorded events)

/** The review search opened the selection card for a literature review. */
export function assertReviewSearch(turn: Turn): void {
  check(
    calls(turn.events, "literature_search").some((event) => {
      const args = record(event.args);
      return args.workflow === "review" && args.forLiteratureReview === true;
    }),
    "literature_search was never called with workflow 'review' and forLiteratureReview true",
  );
}

/**
 * The first selection card offers both choices of a literature review: cite
 * without importing, and import and cite.
 */
export function assertReviewCardButtons(turn: Turn): void {
  const [card] = paperCards(turn.events);
  check(card, "No literature_review card was shown");
  const label = (id: string) =>
    (card.actions || []).find((action) => action.id === id)?.label;
  check(
    /without importing/i.test(label("cite") || ""),
    `The card has no "without importing" cite button (cite label: ${label("cite")})`,
  );
  check(
    /Import and cite/i.test(label("import") || ""),
    `The card has no "Import and cite" button (import label: ${label("import")})`,
  );
}

/** The one successful submit_document: its call and the document it made. */
export function successfulSubmission(turn: Turn): {
  args: Record<string, any>;
  documentId: string;
} {
  const succeeded = results(turn.events, "submit_document").filter(
    (event) => event.ok,
  );
  check(
    succeeded.length === 1,
    `Expected one successful submit_document, saw ${succeeded.length}`,
  );
  const call = calls(turn.events, "submit_document").find(
    (event) => event.callId === succeeded[0].callId,
  );
  check(call, "The successful submit_document has no matching call");
  const documentId = String(record(succeeded[0].content).documentId || "");
  check(documentId, "submit_document returned no documentId");
  return { args: record(call.args), documentId };
}

/** Every source of every citation a submit_document call passes. */
export function submittedSources(
  args: Record<string, any>,
): Record<string, any>[] {
  return (Array.isArray(args.citations) ? args.citations : []).flatMap(
    (citation: unknown) => {
      const sources = record(citation).sources;
      return (Array.isArray(sources) ? sources : []).map(record);
    },
  );
}

const hasPaperId = (source: Record<string, any>) =>
  typeof source.paperId === "string" && source.paperId.trim() !== "";
const isZoteroSource = (source: Record<string, any>) =>
  !hasPaperId(source) &&
  source.libraryID !== undefined &&
  typeof source.itemKey === "string";

/** The distinct paperIds the sources name. */
export function citedPaperIds(sources: Record<string, any>[]): string[] {
  return [...new Set(sources.filter(hasPaperId).map((s) => s.paperId))];
}

/**
 * A review of outside papers cited without importing: at least one source
 * names a paperId, and every source is a paperId or a Zotero item, never a
 * web address.
 */
export function assertOutsideSources(sources: Record<string, any>[]): void {
  check(
    citedPaperIds(sources).length > 0,
    "No citation source names a paperId",
  );
  const web = sources.filter(
    (source) =>
      "url" in source ||
      "URL" in source ||
      !(hasPaperId(source) || isZoteroSource(source)),
  );
  check(
    !web.length,
    `Citation sources that are neither a paperId nor a Zotero item: ${JSON.stringify(web)}`,
  );
}

/** A review of imported papers cites Zotero items only. */
export function assertZoteroOnlySources(sources: Record<string, any>[]): void {
  check(sources.length > 0, "submit_document cites no source");
  const outside = citedPaperIds(sources);
  check(
    !outside.length,
    `The review cites outside papers (${outside.join(", ")}) after the user chose to import`,
  );
  check(
    sources.every(isZoteroSource),
    `A citation source is not a Zotero item: ${JSON.stringify(sources.find((s) => !isZoteroSource(s)))}`,
  );
}

/** Zotero item keys a set of Zotero sources names. */
function zoteroKeys(sources: Record<string, any>[]): string[] {
  return [
    ...new Set(sources.filter(isZoteroSource).map((s) => String(s.itemKey))),
  ];
}

// ---------------------------------------------------------------------------
// Stored document checks (pure, over a loaded document)

function documentV2(
  document: DocumentArtifact | null | undefined,
  what: string,
): DocumentArtifactV2 {
  check(document, `${what} is not stored`);
  check(document.version === 2, `${what} is not a version 2 document`);
  return document;
}

/**
 * The stored document of a review that cites outside papers: they are listed
 * in the citation bundle, each cited paperId has a snapshot, each snapshot
 * has a bibliography entry, the References list links each to its DOI or
 * paper page, and the citation draft is kept for a later import.
 */
export function assertOutsideDocument(
  stored: DocumentArtifact | null | undefined,
  paperIds: string[],
): DocumentArtifactV2 {
  const document = documentV2(stored, "The review document");
  const snapshots = document.citationBundle.outsidePapers || [];
  check(snapshots.length > 0, "citationBundle.outsidePapers is empty");
  const snapshotIds = snapshots.map((paper) => paper.paperId);
  const missing = paperIds.filter((id) => !snapshotIds.includes(id));
  check(
    !missing.length,
    `Cited paperIds without an outside-paper snapshot: ${missing.join(", ")}`,
  );
  const entryIds = document.citationBundle.bibliographyEntries
    .filter(isOutsideBibliographyEntry)
    .map((entry) => entry.paperId);
  const unlisted = snapshotIds.filter((id) => !entryIds.includes(id));
  check(
    !unlisted.length,
    `Outside papers without a bibliography entry: ${unlisted.join(", ")}`,
  );
  const references = document.visibleMarkdown.split(/^## References\s*$/m);
  check(references.length > 1, "The document has no References section");
  const list = references[references.length - 1];
  for (const paper of snapshots) {
    const uri = outsidePaperUri(paper);
    check(uri, `Outside paper ${paper.paperId} has no DOI or page link`);
    check(
      list.includes(`](${uri})`),
      `References does not link outside paper ${paper.paperId} to ${uri}`,
    );
  }
  check(
    document.citationDraft,
    "The document keeps no citationDraft, so a later import cannot revise it",
  );
  return document;
}

/** The stored document of a review that cites Zotero items only. */
export function assertNoOutsideDocument(
  stored: DocumentArtifact | null | undefined,
): DocumentArtifactV2 {
  const document = documentV2(stored, "The review document");
  check(
    !(document.citationBundle.outsidePapers || []).length,
    "citationBundle.outsidePapers is not empty after the user chose to import",
  );
  check(
    !document.citationBundle.clusters.some((cluster) =>
      cluster.sources.some(isOutsideCitationSource),
    ),
    "A citation cluster cites an outside paper after the user chose to import",
  );
  return document;
}

// ---------------------------------------------------------------------------
// Later import

/** What journey 1 leaves for the later-import journey. */
type OutsideReviewRecord = {
  conversationKey: number;
  documentId: string;
  documentVersion: number;
  title: string;
  /** The stored document as JSON, to show the import leaves it unchanged. */
  stored: string;
  paperIds: string[];
};
const outsideReviews = new Map<string, OutsideReviewRecord>();

/** The result of the library_import call that imported a document's papers. */
/** The failure when the Agent imports a document's papers by their DOIs. */
const IMPORTED_BY_IDENTIFIERS =
  "The Agent imported by identifiers instead of document_citations";

/**
 * The later import's approval: it must import the review's citations, so an
 * identifiers card is named as that failure, and a document_citations card
 * must name the review. Other cards are left to the driver.
 */
export function laterImportApproval(
  action: AgentPendingAction,
  reviewTitle: string,
): CardAnswer | undefined {
  if (action.toolName !== "library_import") return undefined;
  check(
    !action.fields.some((field) => field.id === "identifiersChecklist"),
    IMPORTED_BY_IDENTIFIERS,
  );
  check(
    action.description?.includes(reviewTitle),
    `The import approval does not name the review "${reviewTitle}"`,
  );
  return { effect: true };
}

export function laterImportResult(
  turn: Turn,
  documentId: string,
): Record<string, any> {
  check(
    !calls(turn.events, "library_import").some(
      (event) => record(event.args).kind === "identifiers",
    ),
    IMPORTED_BY_IDENTIFIERS,
  );
  const imports = calls(turn.events, "library_import").filter(
    (event) => record(event.args).kind === "document_citations",
  );
  check(
    imports.length,
    "library_import was never called with kind 'document_citations'",
  );
  const wrong = imports.filter(
    (event) => record(event.args).documentId !== documentId,
  );
  check(
    !wrong.length,
    `library_import named document ${record(wrong[0]?.args).documentId}, not ${documentId}`,
  );
  const done = results(turn.events, "library_import").find(
    (event) =>
      event.ok &&
      imports.some((call) => call.callId === event.callId) &&
      record(event.content).revisionOf,
  );
  check(
    done,
    "No library_import of the document's citations published a new version",
  );
  return record(done.content);
}

function importedPaperRows(content: Record<string, any>) {
  return (Array.isArray(content.papers) ? content.papers : []).map(record);
}

/** The key of the library item with this id, from the live library. */
function liveItemKey(itemId: number): string | undefined {
  const item = Zotero.Items.get(itemId);
  return item ? String(item.key) : undefined;
}

/** The Zotero item keys of the papers an import imported or found. */
function resolvedItemKeys(
  content: Record<string, any>,
  itemKeyOf: (itemId: number) => string | undefined,
): string[] {
  return importedPaperRows(content)
    .filter((row) => ["imported", "found_existing"].includes(row.outcome))
    .map((row) => {
      const key = itemKeyOf(Number(row.itemId));
      check(
        key,
        `Paper ${row.paperId} names item ${row.itemId}, which is gone`,
      );
      return key;
    });
}

/**
 * The new version: it revises the old document, is version 2, and cites a
 * Zotero item for every paper the import imported or found. An outside source
 * remains only for a paper the import could not turn into an item.
 */
export function assertLaterVersion(
  stored: DocumentArtifact | null | undefined,
  content: Record<string, any>,
  prior: Pick<OutsideReviewRecord, "documentId" | "documentVersion">,
  itemKeyOf: (itemId: number) => string | undefined = liveItemKey,
): DocumentArtifactV2 {
  const document = documentV2(stored, "The new document version");
  assertExact(
    document.documentVersion,
    prior.documentVersion + 1,
    "documentVersion",
  );
  assertExact(
    document.revisionOf?.documentId,
    prior.documentId,
    "revisionOf.documentId",
  );
  check(
    document.documentId !== prior.documentId,
    "The new version reused the old documentId",
  );
  const cited = new Set(
    document.citationBundle.clusters.flatMap((cluster) =>
      cluster.sources.flatMap((source) =>
        isOutsideCitationSource(source) ? [] : [source.itemKey],
      ),
    ),
  );
  const notCited = resolvedItemKeys(content, itemKeyOf).filter(
    (key) => !cited.has(key),
  );
  check(
    !notCited.length,
    `The new version does not cite the Zotero item(s) ${notCited.join(", ")}`,
  );
  const unresolved = new Set(
    importedPaperRows(content)
      .filter((row) => !["imported", "found_existing"].includes(row.outcome))
      .map((row) => row.paperId),
  );
  const stillOutside = document.citationBundle.clusters.flatMap((cluster) =>
    cluster.sources.flatMap((source) =>
      isOutsideCitationSource(source) && !unresolved.has(source.paperId)
        ? [source.paperId]
        : [],
    ),
  );
  check(
    !stillOutside.length,
    `The new version still cites imported paper(s) as outside: ${stillOutside.join(", ")}`,
  );
  return document;
}

// ---------------------------------------------------------------------------
// Journeys

/** The items a run added to the library, top level only (no attachments). */
function addedPapers(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: typeof before,
) {
  return diff(before, after).filter(
    (change) =>
      !change.before &&
      change.after &&
      !["attachment", "note", "annotation"].includes(change.after.itemType),
  );
}

/** Only new items (and their attachments or notes) may appear in the library. */
function onlyNewItems(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: typeof before,
) {
  onlyChanges(
    before,
    after,
    (change) => !change.before && String(change.key).startsWith("item:"),
  );
}

/**
 * A review of a topic the library lacks, nothing attached. The user ticks the
 * papers and chooses "Cite without importing": nothing is imported, the
 * papers are read with literature_read and cited by paperId, and the stored
 * document lists them as outside papers.
 */
export async function literatureReviewOutsideCiteJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const blocked = await blockedWhenLibraryCovers(ctx, OUTSIDE_CITE_TOPIC);
  if (blocked) return blocked;
  const before = await snapshot();
  const conversationKey = Date.now() + 100003;
  const log: CardLog[] = [];
  const turn = await ctx.driver.turn(
    id,
    OUTSIDE_CITE_PROMPT,
    modeOf(id),
    { conversationKind: "global", conversationKey },
    "none",
    undefined,
    undefined,
    answerPaperCard("cite", log),
  );
  assertLibraryScopeReached(turn);
  assertReviewSearch(turn);
  check(log.length > 0, "The paper selection card was never answered");
  assertReviewCardButtons(turn);
  assertExact(
    await snapshot(),
    before,
    "Cite without importing must not change the library",
  );
  check(
    results(turn.events, "literature_read").some((event) => event.ok),
    "No literature_read call succeeded",
  );
  const { args, documentId } = successfulSubmission(turn);
  const sources = submittedSources(args);
  assertOutsideSources(sources);
  const paperIds = citedPaperIds(sources);
  const stored = await loadPlanDocument(documentId);
  const document = assertOutsideDocument(stored, paperIds);
  outsideReviews.set(ctx.fixtures.marker, {
    conversationKey,
    documentId,
    documentVersion: document.documentVersion,
    title: document.title,
    stored: JSON.stringify(document),
    paperIds,
  });
  return {
    detail: `Cited ${paperIds.length} outside paper(s) without importing; ${log.map((entry) => `${entry.rowIds.length} ticked`).join(", ")}; document ${documentId}.`,
  };
}

/**
 * The same kind of review on another topic, where the user chooses "Import
 * and cite": the ticked papers become items, the run goes on, the model reads
 * them with paper_read and cites them as Zotero items, and no outside paper
 * is cited.
 */
export async function literatureReviewOutsideImportJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const blocked = await blockedWhenLibraryCovers(ctx, OUTSIDE_IMPORT_TOPIC);
  if (blocked) return blocked;
  const before = await snapshot();
  const log: CardLog[] = [];
  const turn = await ctx.driver.turn(
    id,
    OUTSIDE_IMPORT_PROMPT,
    modeOf(id),
    { conversationKind: "global" },
    "none",
    undefined,
    undefined,
    answerPaperCard("import", log),
  );
  assertLibraryScopeReached(turn);
  assertReviewSearch(turn);
  check(log.length > 0, "The paper selection card was never answered");
  assertReviewCardButtons(turn);
  const ticked = new Set(log.flatMap((entry) => entry.rowIds)).size;
  const after = await snapshot();
  onlyNewItems(before, after);
  const added = addedPapers(before, after);
  check(added.length > 0, "The import added no item to the library");
  check(
    added.length <= ticked,
    `The import added ${added.length} items for ${ticked} ticked papers`,
  );
  const addedIds = added.map((change) => Number(change.after?.id));
  check(
    papersRead(turn.events).some((itemId) => addedIds.includes(itemId)),
    "paper_read never read an imported item",
  );
  const { args, documentId } = successfulSubmission(turn);
  const sources = submittedSources(args);
  assertZoteroOnlySources(sources);
  const addedKeys = added.map((change) => String(change.after?.key));
  check(
    zoteroKeys(sources).some((key) => addedKeys.includes(key)),
    "The review cites none of the imported items",
  );
  assertNoOutsideDocument(await loadPlanDocument(documentId));
  return {
    detail: `Imported ${added.length} of ${ticked} ticked paper(s); the review cites ${zoteroKeys(sources).length} Zotero item(s) and no outside paper; document ${documentId}.`,
  };
}

/**
 * In a later turn of journey 1's conversation the user asks to import the
 * papers the review cites. library_import with kind 'document_citations'
 * asks for approval, imports them, and publishes version 2 of the document
 * citing the Zotero items. The first document stays as it was.
 */
export async function literatureReviewOutsideLaterImportJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const prior = outsideReviews.get(ctx.fixtures.marker);
  if (!prior)
    return {
      status: "BLOCKED",
      detail: "The cite journey recorded no review document to import.",
    };
  const before = await snapshot();
  const turn = await ctx.driver.turn(
    id,
    OUTSIDE_LATER_IMPORT_PROMPT,
    modeOf(id),
    { conversationKind: "global", conversationKey: prior.conversationKey },
    "approval",
    undefined,
    undefined,
    // This card has no fields to show, so the generic field check does not
    // apply; the journey checks that it names the tool and the document.
    (action) => laterImportApproval(action, prior.title),
  );
  const content = laterImportResult(turn, prior.documentId);
  const imported = Number(content.importedCount);
  check(
    imported >= 1,
    `The import made ${imported} items; expected at least one`,
  );
  const after = await snapshot();
  onlyNewItems(before, after);
  assertExact(
    addedPapers(before, after).length,
    imported,
    "New library items against importedCount",
  );
  const next = assertLaterVersion(
    await loadPlanDocument(String(content.documentId || "")),
    content,
    prior,
  );
  assertExact(
    JSON.stringify(await loadPlanDocument(prior.documentId)),
    prior.stored,
    "The first review document after the import",
  );
  return {
    detail: `Imported ${imported} paper(s) after approval; ${next.documentId} is version ${next.documentVersion} of ${prior.documentId}, citing Zotero items.`,
  };
}

/**
 * A question about a topic the library lacks, not a request for a review: the
 * Agent answers in chat. It may search outside, but delivers no document,
 * imports nothing, and shows no card.
 */
export async function literatureReviewAmbiguousChatJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const blocked = await blockedWhenLibraryCovers(ctx, OUTSIDE_CHAT_TOPIC);
  if (blocked) return blocked;
  const before = await snapshot();
  const turn = await ctx.driver.turn(id, OUTSIDE_CHAT_PROMPT, modeOf(id), {
    conversationKind: "global",
  });
  assertLibraryScopeReached(turn);
  check(
    !calls(turn.events, "submit_document").length,
    "The Agent called submit_document for a question that is not a review request",
  );
  check(
    String(turn.result.text || "").trim().length > 0,
    "The answer is empty",
  );
  assertExact(
    await snapshot(),
    before,
    "A chat answer must not change the library",
  );
  return {
    detail: `Answered in chat (${String(turn.result.text).length} characters) with ${calls(turn.events, "literature_search").length} literature_search call(s) and no document.`,
  };
}
