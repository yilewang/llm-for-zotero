/**
 * The papers a task's scope covers, as the Task progress view lists them, and
 * as the agent's turn states them and a part declared over them freezes them.
 *
 * Computed from the turn's attached papers, folders and tags plus the library
 * index snapshot, with the union `ZoteroGateway.resolveLibraryScopeItemIds`
 * gives retrieval (`services/libraryIndex/paperScope`): explicit papers
 * first, then each collection's direct items (subcollections are not
 * expanded, exactly as retrieval does not), then each tag's items; only live
 * regular items; each paper once, in first-seen order.
 * With nothing attached the whole library is listed, capped; the agent's set
 * of the whole library is not.
 *
 * Pure: reads only the snapshot object it is given.
 */
import type { LibraryIndexSnapshot } from "../../services/libraryIndex/contracts";
import {
  isPaperScopeItem,
  resolvePaperScope,
} from "../../services/libraryIndex/paperScope";
import { taskPaperKey } from "./taskPaperLedger";
import type { TurnPaperScope } from "./turnPaperScope";

/** The snapshot fields scope listing reads. */
export type TaskPaperScopeSnapshot = Pick<
  LibraryIndexSnapshot,
  | "libraryID"
  | "itemById"
  | "topLevelItemOrder"
  | "collectionById"
  | "directItemIdsByCollectionId"
  | "collectionPathById"
  | "tagByNormalizedName"
  | "childAttachmentIdsByItemId"
  | "attachmentById"
  | "pdfCapableItemIds"
>;

export type TaskPaperScopeContexts = {
  /** Papers the user removed from the task: left out of the listing. */
  excludedItemIds?: readonly number[];
  papers?: ReadonlyArray<{ itemId: number; libraryID?: number }>;
  collections?: ReadonlyArray<{ collectionId: number; libraryID?: number }>;
  tags?: ReadonlyArray<{
    name: string;
    normalizedName?: string;
    libraryID?: number;
    scope?: "allTagged" | "untagged";
    includeAutomatic?: boolean;
  }>;
};

export type TaskPaperScopeTextHint = "pdf" | "none" | "unknown";

export type TaskPaperScopeEntry = {
  key: string;
  libraryID: number;
  itemId: number;
  title: string;
  year: string;
  firstCreator: string;
  collectionPaths: string[];
  /** Manual tags first, at most `TASK_PAPER_SCOPE_MAX_TAGS`. */
  tags: string[];
  text: TaskPaperScopeTextHint;
};

export type TaskPaperScopeListing = {
  libraryID: number;
  /** True when nothing was attached and the whole library is listed. */
  wholeLibrary: boolean;
  entries: TaskPaperScopeEntry[];
  /** Papers the scope covers, before any cap. */
  totalItems: number;
  listedItems: number;
  truncated: boolean;
};

/** The papers a turn's scope covers, as the host resolved them. */
export type TaskPaperScopeSet = {
  /** Nothing was attached: the scope is the whole library. */
  wholeLibrary: boolean;
  /** Every paper of the scope, in scope order, uncapped. */
  itemIds: number[];
  /** How many of them have a PDF to read their text from. */
  withText: number;
  /** Each paper's title and text hint, for naming a page and sizing it. */
  papers?: Readonly<
    Record<number, Readonly<{ title: string; text: TaskPaperScopeTextHint }>>
  >;
};

export const TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP = 2000;
export const TASK_PAPER_SCOPE_MAX_TAGS = 6;

function liveRegularItemIds(snapshot: TaskPaperScopeSnapshot): number[] {
  return snapshot.topLevelItemOrder.filter((itemId) =>
    isPaperScopeItem(snapshot.itemById.get(itemId)),
  );
}

// Restates `services/zotero/internal/libraryIndex` `indexItemHasGatewayPdf`
// (the facade rule keeps agent/context from importing it).
function hasPdfAttachment(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): boolean {
  return (snapshot.childAttachmentIdsByItemId.get(itemId) || []).some(
    (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
  );
}

/** Item ids in the scope, in the order retrieval's union produces them. */
export function resolveTaskPaperScopeItemIds(
  snapshot: TaskPaperScopeSnapshot,
  contexts: TaskPaperScopeContexts,
): number[] {
  return resolvePaperScope(snapshot, {
    libraryID: snapshot.libraryID,
    itemIds: (contexts.papers || []).map((paper) => paper.itemId),
    collectionIds: (contexts.collections || []).map(
      (collection) => collection.collectionId,
    ),
    tagContexts: contexts.tags,
    excludedItemIds: contexts.excludedItemIds,
  }).itemIds;
}

/**
 * A turn's papers, folders, tags and the papers removed from them, as the
 * listing reads them: the same scope Task progress lists for the turn.
 */
export function taskPaperScopeContextsOf(
  scope: TurnPaperScope,
): TaskPaperScopeContexts {
  const excludedItemIds = [
    ...new Set(
      [...scope.collections, ...scope.tags].flatMap(
        (context) => context.excludedItemIds || [],
      ),
    ),
  ].sort((a, b) => a - b);
  const contexts: TaskPaperScopeContexts = {};
  if (excludedItemIds.length) contexts.excludedItemIds = excludedItemIds;
  if (scope.papers.length) {
    contexts.papers = scope.papers.map(({ paper }) => ({
      itemId: paper.itemId,
      libraryID: paper.libraryID,
    }));
  }
  if (scope.collections.length) {
    contexts.collections = scope.collections.map((collection) => ({
      collectionId: collection.collectionId,
      libraryID: collection.libraryID,
    }));
  }
  if (scope.tags.length) {
    contexts.tags = scope.tags.map((tag) => ({
      name: tag.name,
      normalizedName: tag.normalizedName,
      libraryID: tag.libraryID,
      scope: tag.scope,
      includeAutomatic: tag.includeAutomatic,
    }));
  }
  return contexts;
}

/**
 * Whether a turn states its scope and freezes parts over it: a folder, a tag,
 * the whole library (nothing attached), or two papers or more. A one-paper
 * chat needs neither the line nor the wait for the library index.
 */
export function statesTurnPaperScope(scope: TurnPaperScope): boolean {
  if (scope.collections.length || scope.tags.length) return true;
  return new Set(scope.papers.map(({ paper }) => paper.itemId)).size !== 1;
}

function hasScopeContexts(contexts: TaskPaperScopeContexts): boolean {
  return Boolean(
    contexts.papers?.length ||
    contexts.collections?.length ||
    contexts.tags?.length,
  );
}

function textHint(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): TaskPaperScopeTextHint {
  if (
    snapshot.pdfCapableItemIds.has(itemId) ||
    hasPdfAttachment(snapshot, itemId)
  ) {
    return "pdf";
  }
  return "none";
}

function scopeEntry(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): TaskPaperScopeEntry | null {
  const item = snapshot.itemById.get(itemId);
  if (!item) return null;
  const tags = [...item.tags, ...item.automaticTags];
  return {
    key: taskPaperKey(snapshot.libraryID, itemId),
    libraryID: snapshot.libraryID,
    itemId,
    title: item.title,
    year: item.year,
    firstCreator: item.firstCreator,
    collectionPaths: item.collectionIds.flatMap((collectionId) => {
      const path =
        snapshot.collectionPathById.get(collectionId) ||
        snapshot.collectionById.get(collectionId)?.name;
      return path ? [path] : [];
    }),
    tags: [...new Set(tags)].slice(0, TASK_PAPER_SCOPE_MAX_TAGS),
    text: textHint(snapshot, itemId),
  };
}

/**
 * Every paper of a scope, uncapped (the whole library when nothing is
 * attached), and how many have a PDF: what the turn context states and what
 * a part declared over the scope freezes.
 */
export function resolveTaskPaperScopeSet(
  snapshot: TaskPaperScopeSnapshot,
  contexts: TaskPaperScopeContexts,
): TaskPaperScopeSet {
  const wholeLibrary = !hasScopeContexts(contexts);
  const itemIds = wholeLibrary
    ? liveRegularItemIds(snapshot)
    : resolveTaskPaperScopeItemIds(snapshot, contexts);
  const papers: Record<
    number,
    { title: string; text: TaskPaperScopeTextHint }
  > = {};
  let withText = 0;
  for (const itemId of itemIds) {
    const text = textHint(snapshot, itemId);
    if (text === "pdf") withText += 1;
    papers[itemId] = {
      title: snapshot.itemById.get(itemId)?.title || "",
      text,
    };
  }
  return { wholeLibrary, itemIds, withText, papers };
}

/**
 * The ordered papers in a turn's scope. `wholeLibraryCap` bounds only the
 * whole-library listing; an attached scope is always listed in full.
 */
export function listTaskPaperScope(
  snapshot: TaskPaperScopeSnapshot,
  contexts: TaskPaperScopeContexts,
  options: { wholeLibraryCap?: number } = {},
): TaskPaperScopeListing {
  const wholeLibrary = !hasScopeContexts(contexts);
  const ids = wholeLibrary
    ? liveRegularItemIds(snapshot)
    : resolveTaskPaperScopeItemIds(snapshot, contexts);
  const cap = wholeLibrary
    ? Math.max(
        0,
        Math.floor(
          options.wholeLibraryCap ?? TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP,
        ),
      )
    : ids.length;
  const entries = ids
    .slice(0, cap)
    .map((itemId) => scopeEntry(snapshot, itemId))
    .filter((entry): entry is TaskPaperScopeEntry => Boolean(entry));
  return {
    libraryID: snapshot.libraryID,
    wholeLibrary,
    entries,
    totalItems: ids.length,
    listedItems: entries.length,
    truncated: entries.length < ids.length,
  };
}
