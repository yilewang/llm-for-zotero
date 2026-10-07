/**
 * When the Task progress row shows, how it gets there, and what scope a turn
 * covers.
 *
 * The row shows only when it has something to show: the papers, folders and
 * tags the context bar holds (in library chat any of them; in a paper chat a
 * folder, a tag or five papers or more), or a run's steps, which keep it for
 * the rest of the conversation, or, in library chat, a paper the agent read
 * in depth (with nothing attached the agent chose it, steps or not). A
 * run's steps are what `planSeen` records: a built-in action's, a plan's,
 * Codex's own checklist, or the outcomes a run declares (a long job's paged
 * parts among them), live or finished, rebuilt from history after a
 * restart. A plain question over the whole library that reads no paper in
 * depth adds nothing to show. With the Task progress button the user can
 * show or hide the row for the conversation on screen; that choice beats the
 * rule above until the panel shows another conversation. The row never shows in
 * WebChat or in a note chat, whatever the user chose. Everything here is
 * pure.
 */
import type { TaskPaperScopeContexts } from "../../../agent/context/taskPaperScopeListing";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../../../shared/types";

/** A paper chat shows the row from this many papers (its own included). */
export const TASK_PROGRESS_PAPER_THRESHOLD = 5;

/** What the user asked of the row with the Task progress button. */
export type TaskProgressUserChoice = "shown" | "hidden";

export type TaskProgressVisibilityInput = {
  conversationKind: "global" | "paper" | "";
  isWebChat: boolean;
  isNoteSession: boolean;
  collectionCount: number;
  tagCount: number;
  paperCount: number;
  /**
   * A run's steps were seen in this conversation: an action, a plan, a Codex
   * checklist or a run's outcomes.
   */
  planSeen: boolean;
  /**
   * A paper was read in depth in this conversation (`taskReadInDepth`). In a
   * Library chat with nothing attached the agent chooses its papers, so the
   * papers it reads are what the row has to show, steps or not.
   */
  readInDepth?: boolean;
  /**
   * The user showed or hid the row for this conversation in this window;
   * absent, the rule above decides.
   */
  userChoice?: TaskProgressUserChoice;
};

/**
 * Whether the context bar holds something the row lists: in library chat any
 * paper, folder or tag; in a paper chat a folder, a tag or five papers (its
 * own included).
 */
export function taskProgressContextApplies(
  input: Pick<
    TaskProgressVisibilityInput,
    "conversationKind" | "collectionCount" | "tagCount" | "paperCount"
  >,
): boolean {
  if (input.collectionCount > 0 || input.tagCount > 0) return true;
  return input.conversationKind === "global"
    ? input.paperCount > 0
    : input.paperCount >= TASK_PROGRESS_PAPER_THRESHOLD;
}

export function shouldShowTaskProgress(
  input: TaskProgressVisibilityInput,
): boolean {
  if (input.isWebChat || input.isNoteSession) return false;
  if (input.conversationKind !== "global" && input.conversationKind !== "paper")
    return false;
  if (input.userChoice) return input.userChoice === "shown";
  return (
    input.planSeen ||
    taskProgressContextApplies(input) ||
    (input.conversationKind === "global" && Boolean(input.readInDepth))
  );
}

/** What one paint of the row stood on, for deciding how the next change moves. */
export type TaskProgressRowFrame = {
  /** The conversation and mode shown; another one is a switch. */
  identity: string;
  shown: boolean;
  /** `taskProgressContextApplies` held. */
  contextApplies: boolean;
  /** A run's steps were seen (`planSeen`). */
  runSteps: boolean;
  /** The context bar was the conversation's own, not yet a stand-in. */
  composerReady: boolean;
  /** A run was working, answering or waiting on the user. */
  runLive: boolean;
  /** The user's choice for the row, if any (`userChoice`). */
  userChoice?: TaskProgressUserChoice;
};

/**
 * Whether the row lowers or raises with motion. Only a change made in the
 * conversation on screen moves: the user adding or removing context, the
 * user showing or hiding the row, or a live run declaring its steps.
 * Everything else puts the row in its state at once: a mount, a conversation
 * switch, a mode change, and the conversation's own state arriving as it
 * loads (its context bar set up from history, its steps rebuilt from
 * history, its record cleared).
 */
export function shouldAnimateTaskProgressRow(
  previous: TaskProgressRowFrame | null,
  next: TaskProgressRowFrame,
): boolean {
  if (!previous || previous.identity !== next.identity) return false;
  if (previous.shown === next.shown) return false;
  if (previous.userChoice !== next.userChoice) return true;
  if (
    previous.contextApplies !== next.contextApplies &&
    !previous.composerReady
  )
    return false;
  if (previous.runSteps !== next.runSteps && !next.runLive) return false;
  return true;
}

/** The contexts a user message attached, as the turn scope reads them. */
export type TaskProgressTurnContexts = {
  paperContexts?: readonly PaperContextRef[];
  fullTextPaperContexts?: readonly PaperContextRef[];
  pdfPaperContexts?: readonly PaperContextRef[];
  selectedCollectionContexts?: readonly CollectionContextRef[];
  selectedTagContexts?: readonly TagContextRef[];
};

export type TaskProgressTurnScope = {
  libraryID: number;
  contexts: TaskPaperScopeContexts;
  /** Distinct papers named, the paper chat's own paper included. */
  paperCount: number;
  collectionCount: number;
  tagCount: number;
  /** Folder and tag names, "Drift + Learning"; empty when none. */
  label: string;
  /** Identity of the contexts, stable across re-renders of the same turn. */
  signature: string;
};

/**
 * The scope of a turn: the paper chat's own paper first, then the papers,
 * folders and tags the user message attached. Library chat with nothing
 * attached is the whole library (empty contexts).
 */
export function resolveTaskProgressTurnScope(params: {
  message: TaskProgressTurnContexts | null | undefined;
  conversationKind: "global" | "paper" | "";
  libraryID: number;
  basePaperItemId?: number;
}): TaskProgressTurnScope {
  const message = params.message || {};
  const papers: Array<{ itemId: number; libraryID?: number }> = [];
  const seenPapers = new Set<number>();
  const addPaper = (itemId: unknown, libraryID?: number) => {
    const id = Math.floor(Number(itemId));
    if (!Number.isFinite(id) || id <= 0 || seenPapers.has(id)) return;
    seenPapers.add(id);
    papers.push(libraryID ? { itemId: id, libraryID } : { itemId: id });
  };
  if (params.conversationKind === "paper") {
    addPaper(params.basePaperItemId, params.libraryID);
  }
  for (const list of [
    message.paperContexts,
    message.fullTextPaperContexts,
    message.pdfPaperContexts,
  ]) {
    for (const paper of list || []) addPaper(paper.itemId, paper.libraryID);
  }
  const collections: Array<{ collectionId: number; libraryID?: number }> = [];
  const names: string[] = [];
  const seenCollections = new Set<number>();
  for (const collection of message.selectedCollectionContexts || []) {
    const id = Math.floor(Number(collection.collectionId));
    if (!Number.isFinite(id) || id <= 0 || seenCollections.has(id)) continue;
    seenCollections.add(id);
    collections.push({ collectionId: id, libraryID: collection.libraryID });
    if (collection.name) names.push(collection.name);
  }
  const tags: Array<NonNullable<TaskPaperScopeContexts["tags"]>[number]> = [];
  const seenTags = new Set<string>();
  for (const tag of message.selectedTagContexts || []) {
    const identity = `${tag.scope || ""}\u0000${tag.normalizedName || tag.name}`;
    if (seenTags.has(identity)) continue;
    seenTags.add(identity);
    tags.push({
      name: tag.name,
      normalizedName: tag.normalizedName,
      libraryID: tag.libraryID,
      scope: tag.scope,
      includeAutomatic: tag.includeAutomatic,
    });
    if (tag.name) names.push(`#${tag.name}`);
  }
  const excludedItemIds = [
    ...new Set(
      [
        ...(message.selectedCollectionContexts || []),
        ...(message.selectedTagContexts || []),
      ].flatMap((context) => context.excludedItemIds || []),
    ),
  ].sort((a, b) => a - b);
  const contexts: TaskPaperScopeContexts = {};
  if (excludedItemIds.length) contexts.excludedItemIds = excludedItemIds;
  if (papers.length) contexts.papers = papers;
  if (collections.length) contexts.collections = collections;
  if (tags.length) contexts.tags = tags;
  return {
    libraryID: params.libraryID,
    contexts,
    paperCount: papers.length,
    collectionCount: collections.length,
    tagCount: tags.length,
    label: names.join(" + "),
    signature: JSON.stringify([
      params.libraryID,
      papers.map((paper) => paper.itemId),
      collections.map((collection) => collection.collectionId),
      tags.map((tag) => [
        tag.scope || "",
        tag.normalizedName || tag.name,
        tag.includeAutomatic === true,
      ]),
      excludedItemIds,
    ]),
  };
}
