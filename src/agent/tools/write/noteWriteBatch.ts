/**
 * Writes a note onto each of many items under the central interaction policy.
 *
 * `note_write` takes a single `targetItemId` and every `mode:'create'` call
 * returns its own review card, so "write a summary note on each of my 50 most
 * recent papers" meant 50 tool calls and 50 human approvals. The round budget
 * was never the binding constraint — consent was.
 */
import type {
  AgentBatchBinding,
  AgentBatchItemOutcome,
  AgentToolContext,
  AgentWriteToolDefinition,
  NoteAppendGuard,
} from "../../types";
import type { MaterialRef } from "../../documents/materialRef";
import {
  LibraryMutationService,
  type SaveNotesBatchOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { DirectDocumentFinalizer } from "../../documents/directFinalization";
import { documentNoteParts } from "../../documents/actions";
import type { PlanDocument } from "../../documents/types";
import { composeNoteAppend } from "./preparedNoteChange";
import { canonicalNoteHtml } from "../../../utils/noteHtml";
import { loadPlanDocument } from "../../documents/store";
import {
  assertMaterialRefMatches,
  materialRefFromDocument,
} from "../../documents/workflowMaterial";
import {
  createBatchJob,
  finishBatchJob,
  getBatchJob,
  listConversationBatchJobs,
} from "../../store/batchJobStore";
import {
  createBatchItems,
  listBatchItems,
  listResumableBatches,
  markBatchItemFailed,
  markBatchItemSettled,
  type BatchItemRecord,
  type NewBatchItem,
} from "../../store/batchItemStore";
import { sha256Text } from "../../store/journalRecoveryBlobStore";
import {
  listJournalActions,
  type JournalActionWithSteps,
} from "../../store/changeJournal";
import { findNoteHeldForRow } from "../../services/noteCreation";
import { RESUMABLE_BATCH_ACTION_STATUSES } from "../../services/mutationCoordinator";
import { describeLibraryMutationActions } from "../../contracts/actionOperationEvidence";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  normalizeChecklistItemIdsFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const NOTES_CHECKLIST_FIELD_ID = "writeNotesChecklist";

/**
 * One prepared item: its durable row key, the material frozen for it, and the
 * preview the user approves. Host-only, set during preparation.
 */
type PreparedBatchItem = {
  itemKey: string;
  targetItemId: number;
  /** Place in the durable batch; a resume writes a subset and keeps these. */
  position: number;
  material?: MaterialRef;
  /** Exactly what the confirmation card shows for this item. */
  preview: string;
  /** Why this item has no material; it is recorded failed and never written. */
  failure?: string;
  /** For an append: the note and its checksums around the write. */
  targetNoteId?: number;
  append?: NoteAppendGuard;
};

/** One row a resume has to correct, once the call is authorized to run. */
type ResumeRowCorrection =
  | {
      itemKey: string;
      actionId?: string;
      stepSequence?: number;
      error: string;
    }
  | {
      itemKey: string;
      /** A related batch already wrote this item's note; the row names it. */
      settledByNoteId: number;
    };

/**
 * What continuing a batch worked out, before anything was written.
 *
 * Resolution runs during preparation, which the user may still cancel, so it
 * decides everything and changes nothing: the row corrections it discovers
 * travel here and are applied by `execute`.
 */
type ResumeResolution = {
  batchId: string;
  /**
   * This resume's own identity. It continues the journal action the batch
   * opened, so a receipt named after that action would take the identity of
   * the call that opened it, and a ledger that already holds that receipt
   * would take this call's as a repeat; the resume's proposal names this.
   */
  attempt: string;
  /** The journal action the batch's rows already name, if any. */
  actionId?: string;
  /** Items already written; this call does not touch them. */
  skippedItemKeys: string[];
  /** Saved items whose note is gone from the library, written again here. */
  rewrittenItemKeys: string[];
  /** Items no stored material can write, with the reason they stay failed. */
  blocked: Array<{ itemKey: string; reason: string }>;
  /** Row writes this resume owes; applied by `execute`, never by preparation. */
  corrections: ResumeRowCorrection[];
  /**
   * Items this resume offered to write, as the confirmation card listed them.
   * The user may uncheck any of them, and what is left decides whether the
   * action this call continues still owes work when it finishes.
   */
  offeredItemKeys: string[];
};

/**
 * A paper whose note an earlier, unfinished batch of this conversation
 * already saved, so a new call over it writes no second note.
 *
 * A Zotero restart starts a new run, and a batch's identity includes its run,
 * so the model's retry after a restart opens a new batch. Its own rows know
 * nothing of the notes the earlier batch wrote.
 */
type AlreadySavedNote = {
  itemKey: string;
  targetItemId: number;
  title: string;
  /** The earlier batch whose row holds the note. */
  batchId: string;
  noteId: number;
  materialRef?: MaterialRef;
};

/** One item as the batch's job row remembers it, so a resume needs no model. */
type StoredBatchNote = {
  itemKey: string;
  targetItemId: number;
  collections?: number[];
  /** For an append: the note, and its checksums frozen before the write. */
  targetNoteId?: number;
  append?: NoteAppendGuard;
};

type NoteWriteBatchInput = {
  /**
   * Continue the durable batch with this id. The bodies are already frozen,
   * so the call carries no notes and regenerates nothing.
   */
  resumeBatchId?: string;
  /**
   * The notes this call writes. Model-supplied for a new batch; on resume it
   * is resolved from the batch's durable rows during preparation, which is
   * why it can be absent until then.
   */
  operation?: SaveNotesBatchOperation;
  /** Host-prepared per-item material, frozen before the user is asked. */
  _items?: PreparedBatchItem[];
  /** Host-resolved resume state, set during preparation. */
  _resume?: ResumeResolution;
  /**
   * Papers of a new call that an earlier unfinished batch already wrote.
   * Set during preparation; they are left out of `operation`, so the card,
   * the proposal and the write never include them.
   */
  _alreadySaved?: AlreadySavedNote[];
  /**
   * The earlier batches this new call is a retry of, decided during
   * preparation and recorded on the job it opens.
   */
  _retryOf?: string[];
};

/** The notes a prepared call will write; empty before a resume is resolved. */
function notesOf(input: NoteWriteBatchInput): SaveNotesBatchOperation["notes"] {
  return input.operation?.notes || [];
}

function resolvedOperation(
  input: NoteWriteBatchInput,
): SaveNotesBatchOperation {
  if (!input.operation)
    throw new Error("The note batch was used before it was prepared");
  return input.operation;
}

/**
 * A durable row key for one item of this batch.
 *
 * The target item identifies the note in every user-visible surface, so it is
 * the key; a batch that writes two notes onto the same paper distinguishes
 * them by occurrence so the batch's rows stay one per note.
 */
function batchItemKeys(notes: SaveNotesBatchOperation["notes"]): string[] {
  const seen = new Map<number, number>();
  return notes.map((note) => {
    const occurrence = (seen.get(note.targetItemId) || 0) + 1;
    seen.set(note.targetItemId, occurrence);
    return occurrence === 1
      ? `item:${note.targetItemId}`
      : `item:${note.targetItemId}#${occurrence}`;
  });
}

export function createNoteWriteBatchTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<NoteWriteBatchInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  const finalizer = new DirectDocumentFinalizer(zoteroGateway);

  function itemTitle(targetItemId: number): string {
    const item = zoteroGateway.getItem(targetItemId);
    return item
      ? String(item.getDisplayTitle?.() || `Item ${targetItemId}`)
      : `Item ${targetItemId}`;
  }

  /**
   * The checksums of a note before and after its append, from the native
   * note as the user approves it. The executor composes the same HTML.
   */
  async function appendGuardFor(
    noteId: number,
    document: PlanDocument,
    context: AgentToolContext,
  ): Promise<NoteAppendGuard> {
    const note = zoteroGateway.getItem(noteId);
    if (!note?.isNote?.() || note.deleted)
      throw new Error(`Note ${noteId} was not found, or is not a live note`);
    if (
      context.request.libraryID &&
      note.libraryID !== context.request.libraryID
    )
      throw new Error(`Note ${noteId} is in another library`);
    const before = note.getNote();
    // The executor composes the same way: the body carries no root, and the
    // cited works are registered in the note's own root.
    const body = documentNoteParts(document.visibleHtml, note.libraryID);
    const after = composeNoteAppend(before, body.html, body.citationItems);
    return {
      beforeChecksum: await sha256Text(canonicalNoteHtml(before)),
      afterChecksum: await sha256Text(canonicalNoteHtml(after)),
    };
  }

  /**
   * Freeze every body as its own durable document before the user is asked.
   *
   * Preparation, not execution, is where this belongs: the confirmation card
   * must preview the text that will actually be written, and the material has
   * to be frozen before approval for the approval to mean anything. It writes
   * nothing durable of its own, so a denied batch leaves no rows behind.
   *
   * Identical content in the same run keeps the identity it already
   * published, so preparing the same batch again mints no second copy.
   */
  async function prepareBatchMaterial(
    input: NoteWriteBatchInput,
    context: AgentToolContext,
  ): Promise<PreparedBatchItem[]> {
    if (input._items) return input._items;
    if (input.resumeBatchId) return resolveResume(input, context);
    const runId = context.runId;
    if (!runId) throw new Error("The note batch has no run identity");
    const now = Date.now();
    const operation = resolvedOperation(input);
    const append = operation.mode === "append";
    const allKeys = batchItemKeys(operation.notes);
    // A paper an earlier unfinished batch already wrote is left out before
    // anything is finalized for it: this call neither shows nor writes it.
    const retried = await batchesRetriedBy(operation, allKeys, context);
    const alreadySaved = findAlreadySavedNotes(operation, allKeys, retried);
    if (retried.length) input._retryOf = retried.map((batch) => batch.batchId);
    const skippedKeys = new Set(alreadySaved.map((entry) => entry.itemKey));
    const kept = operation.notes.flatMap((note, index) =>
      skippedKeys.has(allKeys[index]) ? [] : [{ note, key: allKeys[index] }],
    );
    if (alreadySaved.length) {
      input.operation = { ...operation, notes: kept.map(({ note }) => note) };
      input._alreadySaved = alreadySaved;
    }
    const items: PreparedBatchItem[] = [];
    for (const [index, { note, key }] of kept.entries()) {
      const base = {
        // Keyed as in the full call, so the keys line up with the earlier
        // batch's rows for the same papers.
        itemKey: key,
        targetItemId: note.targetItemId,
        position: index + 1,
      };
      try {
        const { document } = await finalizer.finalizeNoteBody({
          request: context.request,
          runId,
          title: itemTitle(note.targetItemId),
          markdown: note.content,
          now,
        });
        items.push({
          ...base,
          material: materialRefFromDocument(document),
          preview: previewOf(document.visibleMarkdown),
          ...(append && note.targetNoteId
            ? {
                targetNoteId: note.targetNoteId,
                append: await appendGuardFor(
                  note.targetNoteId,
                  document,
                  context,
                ),
              }
            : {}),
        });
      } catch (error) {
        // One body the host cannot finalize must not cost the other
        // forty-nine notes; this item is recorded failed and never written.
        items.push({
          ...base,
          preview: previewOf(note.content),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    }
    input._items = items;
    return items;
  }

  /**
   * Whether a note is this item's note in Zotero right now.
   *
   * The note must be out of the trash, in the item's library, and placed as
   * the batch writes it: a child of the item, or standalone. A row only
   * remembers the note id; the user may since have trashed the note or moved
   * it onto another paper, and then this item has no note.
   *
   * Stricter than `noteStillExists` on purpose. A resume continues one batch
   * and must not overrule a trash the user chose for that batch's own note.
   */
  function noteBelongsTo(
    noteId: number | undefined,
    targetItemId: number,
    target: SaveNotesBatchOperation["target"],
  ): noteId is number {
    if (!noteId) return false;
    try {
      const note = zoteroGateway.getItem(noteId);
      if (!note?.isNote?.() || note.deleted) return false;
      const item = zoteroGateway.getItem(targetItemId);
      if (!item || note.libraryID !== item.libraryID) return false;
      const placed = note as unknown as {
        parentID?: number | false;
        parentItemID?: number | false;
      };
      const parent = Number(placed.parentID || placed.parentItemID) || 0;
      return target === "standalone" ? !parent : parent === targetItemId;
    } catch {
      return false;
    }
  }

  /** A stored note batch: its job's input and its rows. */
  type StoredNoteBatch = {
    batchId: string;
    stored: ReturnType<typeof parseStoredBatchInput>;
    rows: BatchItemRecord[];
  };

  async function loadNoteBatch(
    batchId: string,
  ): Promise<StoredNoteBatch | undefined> {
    const job = await getBatchJob(batchId);
    if (!job || job.action !== "note_write_batch") return undefined;
    return {
      batchId,
      stored: parseStoredBatchInput(job.inputJson),
      rows: await listBatchItems(batchId),
    };
  }

  /** Whether a batch creates notes of this kind: child or standalone. */
  function createsNotesLike(
    batch: StoredNoteBatch,
    target: SaveNotesBatchOperation["target"],
  ): boolean {
    return batch.stored.mode === "create" && batch.stored.target === target;
  }

  /** The note a batch's row holds for this item, if it is still the item's. */
  function heldNote(
    batch: StoredNoteBatch,
    itemKey: string,
  ): number | undefined {
    const row = batch.rows.find((entry) => entry.itemKey === itemKey);
    const descriptor = batch.stored.notes.find(
      (entry) => entry.itemKey === itemKey,
    );
    if (row?.status !== "saved" || !descriptor) return undefined;
    return noteBelongsTo(
      row.noteId,
      descriptor.targetItemId,
      batch.stored.target,
    )
      ? row.noteId
      : undefined;
  }

  /**
   * The earlier batches a new call is a retry of.
   *
   * A batch counts only while resume still offers it and the call names at
   * least one item that batch still owes and could write. Otherwise the call
   * is a new request: a batch that ended with one paper it can never write
   * must not swallow a later, different note on the papers it did write.
   *
   * Empty for an append, which writes into a note rather than creating one,
   * and in conversation 0, which every standalone MCP client shares: a batch
   * there may be another client's work. Reads only, because preparation may
   * still be cancelled.
   */
  async function batchesRetriedBy(
    operation: SaveNotesBatchOperation,
    keys: readonly string[],
    context: AgentToolContext,
  ): Promise<StoredNoteBatch[]> {
    const conversationKey = context.request.conversationKey;
    if (!conversationKey || operation.mode === "append") return [];
    const named = new Set(keys);
    const retried: StoredNoteBatch[] = [];
    for (const offered of await listResumableBatches(conversationKey)) {
      const batch = await loadNoteBatch(offered.batchId);
      if (!batch || !createsNotesLike(batch, operation.target)) continue;
      for (const row of batch.rows) {
        if (!named.has(row.itemKey) || row.status === "saved") continue;
        // The same test a resume applies before it offers a row.
        if ("body" in (await storedBodyFor(row))) {
          retried.push(batch);
          break;
        }
      }
    }
    return retried;
  }

  /**
   * The papers of a retry whose note a retried batch saved, and that note is
   * still the paper's own in Zotero. Newest batch first, as resume offers them.
   */
  function findAlreadySavedNotes(
    operation: SaveNotesBatchOperation,
    keys: readonly string[],
    retried: readonly StoredNoteBatch[],
  ): AlreadySavedNote[] {
    return operation.notes.flatMap((note, index) => {
      for (const batch of retried) {
        const noteId = heldNote(batch, keys[index]);
        if (noteId === undefined) continue;
        const row = batch.rows.find((entry) => entry.itemKey === keys[index]);
        return [
          {
            itemKey: keys[index],
            targetItemId: note.targetItemId,
            title: itemTitle(note.targetItemId),
            batchId: batch.batchId,
            noteId,
            ...(row?.materialRef ? { materialRef: row.materialRef } : {}),
          },
        ];
      }
      return [];
    });
  }

  /**
   * The batches a batch is a retry of, and the batches that are retries of
   * it, followed through every step of the chain, as their jobs recorded when
   * each retry was opened.
   *
   * The relation is recorded rather than re-derived: after the retry has
   * written, the earlier batch may no longer owe the papers that made it one,
   * and an unrelated later request over the same papers must not join it.
   */
  async function relatedBatches(
    batch: StoredNoteBatch,
    context: AgentToolContext,
  ): Promise<StoredNoteBatch[]> {
    const conversationKey = context.request.conversationKey;
    if (!conversationKey || batch.stored.mode !== "create") return [];
    // The whole chain, not one step: a retry of a retry holds the first
    // batch's papers too, and an explicit resume of any link must see it.
    const links = new Map<string, Set<string>>();
    const link = (from: string, to: string) => {
      if (!links.has(from)) links.set(from, new Set());
      links.get(from)!.add(to);
    };
    for (const id of batch.stored.retryOf) {
      link(batch.batchId, id);
      link(id, batch.batchId);
    }
    for (const job of await listConversationBatchJobs(
      conversationKey,
      "note_write_batch",
    ))
      for (const id of parseStoredBatchInput(job.inputJson).retryOf) {
        link(job.jobId, id);
        link(id, job.jobId);
      }
    const ids = new Set<string>([batch.batchId]);
    const queue = [batch.batchId];
    for (let next = queue.shift(); next !== undefined; next = queue.shift())
      for (const id of links.get(next) || [])
        if (!ids.has(id)) {
          ids.add(id);
          queue.push(id);
        }
    ids.delete(batch.batchId);
    const related: StoredNoteBatch[] = [];
    for (const id of ids) {
      const other = await loadNoteBatch(id);
      if (other && createsNotesLike(other, batch.stored.target))
        related.push(other);
    }
    return related;
  }

  /**
   * Settle the related batches over the papers this batch now holds notes for.
   *
   * Once this call wrote a paper's note, or found one saved, a related batch
   * whose row for that paper still reads pending or failed would offer the
   * paper for resume and write it a second time. Its row is marked saved with
   * this note instead, and a batch with no work left is closed. Runs after
   * the write, and after a write that threw, because a note that landed
   * before the throw is just as written.
   */
  async function settleRelatedBatches(
    ownBatchId: string,
    alreadySaved: readonly AlreadySavedNote[],
    context: AgentToolContext,
  ): Promise<void> {
    const own = await loadNoteBatch(ownBatchId);
    if (!own) return;
    const holders = new Map<string, number>();
    for (const entry of alreadySaved) holders.set(entry.itemKey, entry.noteId);
    for (const row of own.rows) {
      const noteId = heldNote(own, row.itemKey);
      if (noteId !== undefined) holders.set(row.itemKey, noteId);
    }
    if (!holders.size) return;
    const now = Date.now();
    for (const batch of await relatedBatches(own, context)) {
      const settled = new Set<string>();
      for (const row of batch.rows) {
        const noteId = holders.get(row.itemKey);
        if (noteId === undefined) continue;
        if (heldNote(batch, row.itemKey) !== undefined) continue;
        await markBatchItemSettled(batch.batchId, row.itemKey, {
          noteId,
          now,
        });
        settled.add(row.itemKey);
      }
      if (
        settled.size &&
        batch.rows.every(
          (row) => row.status === "saved" || settled.has(row.itemKey),
        )
      )
        await finishBatchJob({
          jobId: batch.batchId,
          status: "completed",
          now,
        });
    }
  }

  /** Whether the note a row claims to have written is still in the library. */
  function noteStillExists(noteId: number | undefined): boolean {
    if (!noteId) return false;
    try {
      // A trashed note still exists: the user trashed it, or an undo did, and
      // writing it again would overrule that. Only a note that is gone from
      // the library leaves the row's promise unkept.
      return Boolean(zoteroGateway.getItem(noteId));
    } catch {
      return false;
    }
  }

  /**
   * Continue a batch from its durable rows instead of from a model's memory.
   *
   * Nothing here is regenerated: every body was frozen as a document before
   * the first write, so resuming loads those documents, re-checks each against
   * the reference the user approved, and writes exactly them. An item whose
   * material is missing or has moved is left failed and named in the result
   * rather than written from something else.
   *
   * This runs inside preparation, which the user may still cancel, so it is
   * pure: the row corrections it finds are carried on the input and written by
   * `execute`. A cancelled resume must leave the batch exactly as it was.
   */
  async function resolveResume(
    input: NoteWriteBatchInput,
    context: AgentToolContext,
  ): Promise<PreparedBatchItem[]> {
    const batchId = input.resumeBatchId as string;
    const job = await getBatchJob(batchId);
    if (!job) throw new Error(`Note batch "${batchId}" was not found`);
    if (job.conversationKey !== context.request.conversationKey)
      throw new Error(
        `Note batch "${batchId}" belongs to another conversation`,
      );
    if (job.action !== "note_write_batch")
      throw new Error(
        `Batch "${batchId}" is a "${job.action}" job, not a note batch`,
      );
    const storedInput = parseStoredBatchInput(job.inputJson);
    const stored = new Map(
      storedInput.notes.map((note) => [note.itemKey, note]),
    );
    const rows = await listBatchItems(batchId);
    if (!rows.length)
      throw new Error(`Note batch "${batchId}" has no items to continue`);
    // A retry of this batch, or the batch this one retried, may already hold
    // a note this batch's row still owes: its settling never ran, because
    // the process stopped between that write and the settling.
    const related = await relatedBatches(
      { batchId, stored: storedInput, rows },
      context,
    );

    const resume: ResumeResolution = {
      batchId,
      attempt: `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`,
      actionId: latestActionId(rows),
      skippedItemKeys: [],
      rewrittenItemKeys: [],
      blocked: [],
      corrections: [],
      offeredItemKeys: [],
    };
    const items: PreparedBatchItem[] = [];
    const notes: SaveNotesBatchOperation["notes"] = [];
    // Each action once per preparation, however many rows name it.
    const actions = new Map<
      string,
      Promise<JournalActionWithSteps | undefined>
    >();
    const actionOf = (actionId: string) => {
      let action = actions.get(actionId);
      if (!action) {
        action = listJournalActions({ actionId, limit: 1 }).then(
          ([found]) => found,
        );
        actions.set(actionId, action);
      }
      return action;
    };
    // The action this resume reopens settles its own open note steps from
    // native state when it runs. One that another run holds (`applying`)
    // is refused at execution instead, before anything is written.
    const settledByThisResume = (
      actionId: string,
      action: JournalActionWithSteps | undefined,
    ) =>
      actionId === resume.actionId &&
      Boolean(
        action &&
        (RESUMABLE_BATCH_ACTION_STATUSES.includes(action.status) ||
          action.status === "applying"),
      );
    for (const row of rows) {
      const descriptor = stored.get(row.itemKey);
      if (!descriptor)
        throw new Error(
          `Note batch "${batchId}" predates per-item resume records and cannot be continued safely. Write the remaining notes with a new note_write_batch call instead.`,
        );
      if (row.status === "saved" && noteStillExists(row.noteId)) {
        resume.skippedItemKeys.push(row.itemKey);
        continue;
      }
      const elsewhere = related
        .map((batch) => heldNote(batch, row.itemKey))
        .find((noteId) => noteId !== undefined);
      if (elsewhere !== undefined) {
        resume.skippedItemKeys.push(row.itemKey);
        resume.corrections.push({
          itemKey: row.itemKey,
          settledByNoteId: elsewhere,
        });
        continue;
      }
      // A note an earlier attempt reserved for this row may still be held
      // by its action. The action this resume reopens settles it from native
      // state (and keeps a note the user restored). Any other action -- one
      // an undo ended, or one the resume does not continue -- is settled by
      // nothing, so the row would be written a second time beside that
      // note: it is refused, and named. A row written before rows named
      // their action while in flight is held by the action the resume
      // continues.
      const heldBy = row.actionId || resume.actionId;
      if (row.status !== "saved" && heldBy) {
        const action = await actionOf(heldBy);
        if (action && !settledByThisResume(heldBy, action)) {
          // An older step, which does not record its row, is not matched by
          // its body here (that needs the body rebuilt); while a note is at
          // its key, the row is refused if it could be the row's.
          const held = await findNoteHeldForRow(action.steps, {
            batchId,
            itemKey: row.itemKey,
            targetItemId: descriptor.targetItemId,
            standalone: storedInput.target === "standalone",
            collections: descriptor.collections || [],
            actionId: row.actionId,
            stepSequence: row.stepSequence,
          });
          if (held) {
            resume.blocked.push({ itemKey: row.itemKey, reason: held.reason });
            continue;
          }
        }
      }
      if (row.status === "saved") {
        // The row names a note the library no longer has. It is retryable
        // work again, and the row has to say so or the executor would skip it
        // as already written.
        resume.rewrittenItemKeys.push(row.itemKey);
        resume.corrections.push({
          itemKey: row.itemKey,
          actionId: row.actionId,
          stepSequence: row.stepSequence,
          error: `The note this item wrote (${row.noteId}) is no longer in the library`,
        });
      }
      const resolved = await storedBodyFor(row);
      if ("blocked" in resolved) {
        resume.blocked.push({ itemKey: row.itemKey, reason: resolved.blocked });
        if (row.status !== "failed" || row.error !== resolved.blocked)
          resume.corrections.push({
            itemKey: row.itemKey,
            actionId: row.actionId,
            stepSequence: row.stepSequence,
            error: resolved.blocked,
          });
        continue;
      }
      resume.offeredItemKeys.push(row.itemKey);
      items.push({
        itemKey: row.itemKey,
        targetItemId: descriptor.targetItemId,
        position: row.position,
        material: row.materialRef,
        preview: previewOf(resolved.body),
        ...(descriptor.targetNoteId
          ? { targetNoteId: descriptor.targetNoteId, append: descriptor.append }
          : {}),
      });
      notes.push({
        targetItemId: descriptor.targetItemId,
        ...(descriptor.targetNoteId
          ? { targetNoteId: descriptor.targetNoteId }
          : {}),
        content: resolved.body,
        ...(descriptor.collections?.length
          ? { collections: descriptor.collections }
          : {}),
      });
    }
    input.operation = {
      type: "save_notes_batch",
      notes,
      target: storedInput.target,
      ...(storedInput.mode === "append" ? { mode: "append" as const } : {}),
    };
    input._items = items;
    input._resume = resume;
    return items;
  }

  /**
   * The item's frozen body, or the reason nothing can write it.
   *
   * A `pending` row with no material is checked here and not only inside the
   * executor: the row promises a body the batch never froze, and a resume
   * that handed it on would be asking the write path to invent one.
   */
  async function storedBodyFor(
    row: BatchItemRecord,
  ): Promise<{ body: string } | { blocked: string }> {
    if (!row.materialRef)
      return {
        blocked:
          row.status === "pending"
            ? "This item is waiting to be written but has no finalized note body, so nothing can write it"
            : row.error || "This item has no finalized note body",
      };
    const document = await loadPlanDocument(row.materialRef.documentId);
    if (!document)
      return {
        blocked: `The finalized note material ${row.materialRef.documentId} is no longer stored`,
      };
    try {
      assertMaterialRefMatches(document, row.materialRef);
    } catch (error) {
      return {
        blocked: error instanceof Error ? error.message : String(error),
      };
    }
    return { body: document.visibleMarkdown };
  }

  /**
   * The durable identity of this exact batch.
   *
   * A fresh id per call would orphan the rows of an interrupted attempt: they
   * would stay resumable for ever while the retry wrote every note again
   * under a new batch. Deriving it from the run and the frozen material means
   * a retry of the same work lands on the same rows.
   */
  async function batchIdentity(
    runId: string,
    items: readonly PreparedBatchItem[],
  ): Promise<string> {
    const canonical = JSON.stringify([
      runId,
      items.map((item) => [
        item.itemKey,
        item.material?.documentId ?? null,
        item.material?.documentVersion ?? null,
        item.material?.contentHash ?? null,
      ]),
    ]);
    return `batch-note_write_batch-${await sha256Text(canonical)}`;
  }

  function bindingFor(
    batchId: string,
    items: readonly PreparedBatchItem[],
  ): AgentBatchBinding {
    return {
      batchId,
      items: items.map((item) => ({
        itemKey: item.itemKey,
        targetItemId: item.targetItemId,
        position: item.position,
        material: item.material,
        failure: item.failure,
        ...(item.append ? { append: item.append } : {}),
      })),
    };
  }

  /** Seeds the durable rows for an approved batch, reusing any it already has. */
  async function openBatch(
    input: NoteWriteBatchInput,
    context: AgentToolContext,
  ): Promise<AgentBatchBinding> {
    const items = await prepareBatchMaterial(input, context);
    // A resume writes rows that already exist; seeding them again under a new
    // identity is exactly the duplicate work the durable rows prevent.
    if (input._resume) return bindingFor(input._resume.batchId, items);
    const batchId = await batchIdentity(context.runId || "", items);
    const now = Date.now();
    const retryOf = (input._retryOf || []).filter((id) => id !== batchId);
    if (!(await getBatchJob(batchId)))
      await createBatchJob({
        jobId: batchId,
        conversationKey: context.request.conversationKey,
        action: "note_write_batch",
        input: {
          target: resolvedOperation(input).target,
          ...(resolvedOperation(input).mode === "append"
            ? { mode: "append" }
            : {}),
          ...(retryOf.length ? { retryOf } : {}),
          // Stored once, so continuing the batch never has to ask the model
          // which paper an item belonged to or where its note should be filed.
          notes: items.map((item, index) => ({
            itemKey: item.itemKey,
            targetItemId: item.targetItemId,
            ...(item.targetNoteId
              ? { targetNoteId: item.targetNoteId, append: item.append }
              : {}),
            ...(resolvedOperation(input).notes[index]?.collections?.length
              ? {
                  collections:
                    resolvedOperation(input).notes[index].collections,
                }
              : {}),
          })),
        },
        totalCount: items.length,
        now,
      });
    const rows: NewBatchItem[] = items.map((item) => ({
      itemKey: item.itemKey,
      position: item.position,
      materialRef: item.material,
      // A row with no material has nothing a resume could write, so it opens
      // as the failure it already is rather than as pending work.
      ...(item.material
        ? {}
        : {
            status: "failed" as const,
            error: item.failure || "The note body was not finalized",
          }),
    }));
    await createBatchItems(batchId, rows, now);
    return bindingFor(batchId, items);
  }

  return {
    effectOperations: ["save_notes_batch"],
    spec: {
      name: "note_write_batch",
      description:
        "Write a note onto each of many explicitly identified items in one checkpointed batch operation. To continue an interrupted batch, pass resumeBatchId alone: written items are skipped and the rest are written from the bodies already prepared, so no note is written again or regenerated.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          resumeBatchId: {
            type: "string",
            description:
              "Continue one interrupted note batch from its durable per-item records. Pass this alone: items already written are skipped, the remaining notes are written from the bodies the batch already froze, and nothing is regenerated.",
          },
          notes: {
            type: "array",
            description:
              "One entry per item. Write the actual note content for each — this tool does not generate it.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                targetItemId: {
                  type: "number",
                  description: "The item the note is attached to.",
                },
                targetNoteId: {
                  type: "number",
                  description: "For mode:'append': the note to append to.",
                },
                content: {
                  type: "string",
                  description: "Note content, in Markdown.",
                },
                collections: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Only for target:'standalone': collections to file the note into. A child note belongs to its parent and cannot be a collection member.",
                },
              },
            },
          },
          mode: {
            type: "string",
            enum: ["create", "append"],
            description:
              "'append' adds each entry's content to its targetNoteId once.",
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            default: "item",
            description:
              "'item' attaches each note to its target as a child note; 'standalone' creates free-standing notes.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Write Notes",
      traceIcon: "edit",
      summaries: {
        onCall: "Preparing notes",
        onPending: "Waiting for confirmation to write notes",
        onApproved: "Writing notes",
        onDenied: "Note writing cancelled",
        onSuccess: ({ content }) => {
          const outer =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            outer.result && typeof outer.result === "object"
              ? (outer.result as Record<string, unknown>)
              : {};
          const innermost =
            inner.result && typeof inner.result === "object"
              ? (inner.result as Record<string, unknown>)
              : {};
          const appended = Number(innermost.appendedCount || 0);
          const created = Number(innermost.createdCount || 0);
          const alreadySaved = Number(innermost.alreadySavedCount || 0);
          const failed = Number(innermost.failedCount || 0);
          if (appended)
            return `Appended to ${appended} note${appended === 1 ? "" : "s"}${
              failed ? ` (${failed} failed)` : ""
            }`;
          if (!created)
            return alreadySaved
              ? `${alreadySaved} note${alreadySaved === 1 ? " was" : "s were"} already written`
              : "No notes written";
          return `Wrote ${created} note${created === 1 ? "" : "s"}${
            alreadySaved ? ` (${alreadySaved} already written)` : ""
          }${failed ? ` (${failed} failed)` : ""}`;
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with notes. Example: { notes: [{ targetItemId: 101, content: "## Summary\\n..." }] }',
        );
      }
      const resumeBatchId =
        typeof args.resumeBatchId === "string" ? args.resumeBatchId.trim() : "";
      if (resumeBatchId) {
        // Refusing rather than quietly dropping the bodies: a resume writes
        // only what the batch already froze, so notes passed alongside it
        // would be authored text that silently never reached a note.
        if (Array.isArray(args.notes) && args.notes.length)
          return fail(
            "Pass either notes or resumeBatchId, not both. Continuing a batch writes the bodies it already froze.",
          );
        return ok({ resumeBatchId });
      }
      if (!Array.isArray(args.notes) || !args.notes.length) {
        return fail(
          "notes must be a non-empty array of { targetItemId, content }.",
        );
      }
      const append = args.mode === "append";
      const notes: SaveNotesBatchOperation["notes"] = [];
      for (const [index, raw] of args.notes.entries()) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const content = typeof raw.content === "string" ? raw.content : "";
        // The schema requires only `content`, so a strict-schema provider
        // does not enforce the id. An entry without the id its mode needs
        // fails the whole call; dropping it would write the other entries
        // and leave this one unwritten without a word.
        const idName = append ? "targetNoteId" : "targetItemId";
        const entryId = normalizePositiveInt(raw[idName]);
        if (!entryId)
          return fail(
            `Note entry ${index + 1} has no ${idName}. ${
              append
                ? "Each entry of an append names the note to append to as targetNoteId."
                : "Each entry names the item to write onto as targetItemId."
            } Nothing was written.`,
          );
        if (append) {
          // The item an append writes onto is the note itself.
          const targetNoteId = entryId;
          if (!content.trim()) continue;
          if (notes.some((note) => note.targetNoteId === targetNoteId))
            return fail(
              `Note ${targetNoteId} appears twice; give each note one entry with all its content.`,
            );
          notes.push({ targetItemId: targetNoteId, targetNoteId, content });
          continue;
        }
        const targetItemId = entryId;
        if (!content.trim()) continue;
        notes.push({
          targetItemId,
          content,
          collections: Array.isArray(raw.collections)
            ? (raw.collections
                .map((id) => normalizePositiveInt(id))
                .filter(Boolean) as number[])
            : undefined,
        });
      }
      if (!notes.length) {
        return fail(
          `Every note needs a ${append ? "targetNoteId" : "targetItemId"} and non-empty content. Nothing valid was provided.`,
        );
      }
      return ok({
        operation: {
          type: "save_notes_batch" as const,
          notes,
          target: args.target === "standalone" ? "standalone" : "item",
          ...(append ? { mode: "append" as const } : {}),
        },
      });
    },

    createPendingAction(input) {
      const notes = notesOf(input);
      const continuing = Boolean(input._resume);
      const append = input.operation?.mode === "append";
      const count = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
      return {
        toolName: "note_write_batch",
        title: append ? `Append to ${count}` : `Write ${count}`,
        description: continuing
          ? `Continue an interrupted batch by ${append ? "appending to" : "writing"} its remaining ${count}. These are the bodies the batch already prepared; nothing was written again. Uncheck any you do not want. This can be undone.`
          : append
            ? `Append to ${count}. Uncheck any you do not want. This can be undone.`
            : `Write a note onto ${notes.length} item${notes.length === 1 ? "" : "s"}.${alreadySavedSentence(
                input._alreadySaved?.length || 0,
              )} Uncheck any you do not want. This can be undone.`,
        confirmLabel: append ? "Append" : "Write notes",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: NOTES_CHECKLIST_FIELD_ID,
            label: "Notes to write",
            items: notes.map((note, index) => ({
              id: `${note.targetItemId}`,
              label: itemTitle(note.targetItemId),
              // A preview matters here: the user is approving fifty pieces
              // of generated text at once, and an unreviewable card is
              // consent in name only. It shows the finalized text, which is
              // what the write will actually store.
              description:
                input._items?.[index]?.preview ?? previewOf(note.content),
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      const keep = normalizeChecklistItemIdsFromResolution(
        resolutionData,
        NOTES_CHECKLIST_FIELD_ID,
      );
      if (!keep) return ok(input);
      const operation = resolvedOperation(input);
      const kept = new Set(keep);
      const keptIndexes = operation.notes.flatMap((note, index) =>
        kept.has(note.targetItemId) ? [index] : [],
      );
      if (!keptIndexes.length) {
        return fail("Every note was unchecked, so there is nothing to write.");
      }
      // The prepared material is positional, so it is filtered with the notes
      // it describes rather than re-derived from the survivors.
      return ok({
        ...input,
        operation: {
          ...operation,
          notes: keptIndexes.map((index) => operation.notes[index]),
        },
        ...(input._items
          ? { _items: keptIndexes.map((index) => input._items![index]) }
          : {}),
      });
    },

    async planInvocation(input, context) {
      await prepareBatchMaterial(input, context);
      // A resume with nothing left to write changes the library in no way, so
      // it asks for no confirmation: the card would show an empty checklist.
      if (!notesOf(input).length)
        return readOnlyInvocationPlan({
          domains: [],
          reason: input._alreadySaved?.length
            ? "An earlier batch already wrote every one of these notes, so this call changes nothing."
            : "Every item of this batch is already written, so continuing it changes nothing.",
        });
      return planLibraryMutations(
        mutationService,
        [resolvedOperation(input)],
        context,
      );
    },

    describeAction: (input) =>
      notesOf(input).length
        ? describeLibraryMutationActions(input).map((descriptor) => ({
            ...descriptor,
            ...(input._resume
              ? { id: `${descriptor.id}:resume:${input._resume.attempt}` }
              : {}),
            parameters: {
              ...descriptor.parameters,
              // The proposal names the exact material each item will write, so
              // approval is bound to it and not to text that could still change.
              materialRefs: (input._items || []).flatMap((item) =>
                item.material ? [item.material] : [],
              ),
            },
          }))
        : [],

    async execute(input, context) {
      await prepareBatchMaterial(input, context);
      // Read again now: the user may have trashed or moved a note while the
      // card was pending. That paper was not offered for writing, so this
      // call cannot write it either; it is reported, not called saved.
      const target = resolvedOperation(input).target;
      const alreadySaved: AlreadySavedNote[] = [];
      const lapsed: AlreadySavedNote[] = [];
      for (const entry of input._alreadySaved || [])
        (noteBelongsTo(entry.noteId, entry.targetItemId, target)
          ? alreadySaved
          : lapsed
        ).push(entry);
      // Every paper of a new call already has its note from an earlier
      // batch: there is nothing to write, and no batch of its own to open.
      // It writes no row either, since it runs outside the write lock.
      if (!input._resume && !notesOf(input).length) {
        const settled = settledBatchResult(undefined);
        return {
          ...settled,
          content: withAlreadySavedNotes(settled.content, alreadySaved, lapsed),
          batchItems: alreadySaved.map(alreadySavedOutcome),
        };
      }
      const batchBinding = await openBatch(input, context);
      const resume = input._resume;
      // The first durable change of an authorized resume. Preparation only
      // decided these; writing them there would have flipped rows under a
      // confirmation card the user can still cancel. They land before the
      // write because the executor skips a row that still reads `saved`.
      for (const correction of resume?.corrections || [])
        if ("settledByNoteId" in correction)
          await markBatchItemSettled(resume!.batchId, correction.itemKey, {
            noteId: correction.settledByNoteId,
          });
        else
          await markBatchItemFailed(resume!.batchId, correction.itemKey, {
            actionId: correction.actionId,
            stepSequence: correction.stepSequence,
            error: correction.error,
          });
      let result: Awaited<ReturnType<typeof executeAndRecordUndo>>;
      try {
        result = notesOf(input).length
          ? await executeAndRecordUndo(
              mutationService,
              resolvedOperation(input),
              {
                ...context,
                batchBinding,
                // Continue the action the batch already opened, so one undo
                // still reverts every note of it.
                ...(resume?.actionId
                  ? {
                      resumeJournalAction: {
                        actionId: resume.actionId,
                        unfinishedWork: resumeLeavesUnfinishedWork(
                          resume,
                          batchBinding.items,
                        ),
                      },
                    }
                  : {}),
              },
              "note_write_batch",
            )
          : settledBatchResult(resume);
      } catch (error) {
        // The notes that landed before the throw are written all the same.
        // Settling is bookkeeping; its own failure must not hide the error.
        await settleRelatedBatches(
          batchBinding.batchId,
          alreadySaved,
          context,
        ).catch(logSettleFailure);
        throw error;
      }
      // The notes are written; a settling that fails costs only the earlier
      // batch's bookkeeping, and a resume of it re-checks the related notes.
      await settleRelatedBatches(
        batchBinding.batchId,
        alreadySaved,
        context,
      ).catch(logSettleFailure);
      const batchItems = await readBatchOutcomes(
        batchBinding.batchId,
        writtenItemKeys(result),
      );
      const stopped = stoppedReach(result);
      // The rows are the authority on what still needs writing, so the job is
      // closed only once every item of it has landed. A throw above leaves it
      // open on purpose: the startup sweep will mark it interrupted and its
      // pending rows stay resumable. A batch the user stopped is cancelled,
      // and its unstarted rows stay pending just the same.
      await finishBatchJob({
        jobId: batchBinding.batchId,
        status: batchItems.every((item) => item.status === "saved")
          ? "completed"
          : stopped
            ? "cancelled"
            : "failed",
        now: Date.now(),
      });
      const content = {
        ...(withAlreadySavedNotes(
          result.content,
          alreadySaved,
          lapsed,
        ) as Record<string, unknown>),
        ...(stopped
          ? {
              stopped: `The user stopped this batch after ${stopped.after} of ${stopped.of} notes. The ${
                stopped.of - stopped.after
              } not started stay pending in batch ${batchBinding.batchId}; continue it with resumeBatchId.`,
            }
          : {}),
        ...(resume
          ? {
              resume: {
                batchId: resume.batchId,
                continuedActionId: resume.actionId,
                skippedItemKeys: resume.skippedItemKeys,
                rewrittenItemKeys: resume.rewrittenItemKeys,
                blocked: resume.blocked,
              },
            }
          : {}),
      };
      return {
        ...result,
        batchItems: [...alreadySaved.map(alreadySavedOutcome), ...batchItems],
        ...(stopped || resume || alreadySaved.length || lapsed.length
          ? { content }
          : {}),
      };
    },
  };
}

/**
 * Whether the action this resume continues still owes work once it finishes.
 *
 * An item no stored material can write is one source: it will never reach a
 * journal step, so nothing else in the action can speak for it. The
 * confirmation is the other. The card lists every outstanding item and the
 * user may uncheck any of them; an item dropped there stays `pending` in the
 * batch's rows and still owes a note. Reading only what preparation decided
 * would record the action as fully applied while the batch was still
 * resumable.
 */
function resumeLeavesUnfinishedWork(
  resume: ResumeResolution,
  confirmed: AgentBatchBinding["items"],
): boolean {
  if (resume.blocked.length > 0) return true;
  const keptItemKeys = new Set(confirmed.map((item) => item.itemKey));
  return resume.offeredItemKeys.some((itemKey) => !keptItemKeys.has(itemKey));
}

/**
 * What a resume returns when the batch has nothing left to write.
 *
 * It reports in the same shape a write does, because the answer the model
 * needs is the same one -- how many notes this call created, and how many
 * items it found already written.
 */
function settledBatchResult(resume: ResumeResolution | undefined): {
  content: { result: unknown };
  effect: "none";
} {
  return {
    content: {
      result: {
        operation: "save_notes_batch",
        result: {
          createdCount: 0,
          alreadySavedCount: resume?.skippedItemKeys.length || 0,
          failedCount: resume?.blocked.length || 0,
          actionIds: [],
          notes: [],
        },
      },
    },
    effect: "none",
  };
}

/** The card's sentence about papers an earlier batch already wrote. */
function alreadySavedSentence(count: number): string {
  if (!count) return "";
  return count === 1
    ? " 1 item already has its note from an earlier batch and is skipped."
    : ` ${count} items already have their notes from an earlier batch and are skipped.`;
}

/**
 * The result with the papers an earlier batch already wrote, in the row
 * shape the executor gives an `already_saved` note, plus the batch that
 * holds it.
 */
function withAlreadySavedNotes(
  content: unknown,
  alreadySaved: readonly AlreadySavedNote[],
  lapsed: readonly AlreadySavedNote[],
): unknown {
  if (!alreadySaved.length && !lapsed.length) return content;
  const outer = validateObject<Record<string, unknown>>(content) ? content : {};
  const inner = validateObject<Record<string, unknown>>(outer.result)
    ? outer.result
    : {};
  const payload = validateObject<Record<string, unknown>>(inner.result)
    ? inner.result
    : {};
  const notes = Array.isArray(payload.notes) ? payload.notes : [];
  return {
    ...outer,
    ...(alreadySaved.length
      ? {
          alreadySavedNotice: `${alreadySaved.length} ${
            alreadySaved.length === 1
              ? "item already had a note"
              : "items already had notes"
          } from an earlier unfinished batch; none was written for ${
            alreadySaved.length === 1 ? "it" : "them"
          }. A later request writes new notes unless it also names items that batch still owes.`,
        }
      : {}),
    result: {
      ...inner,
      result: {
        ...payload,
        alreadySavedCount:
          Number(payload.alreadySavedCount || 0) + alreadySaved.length,
        failedCount: Number(payload.failedCount || 0) + lapsed.length,
        notes: [
          ...alreadySaved.map((entry) => ({
            targetItemId: entry.targetItemId,
            itemKey: entry.itemKey,
            noteId: entry.noteId,
            title: entry.title,
            status: "already_saved" as const,
            batchId: entry.batchId,
          })),
          ...lapsed.map((entry) => ({
            targetItemId: entry.targetItemId,
            itemKey: entry.itemKey,
            title: entry.title,
            status: "error" as const,
            reason: `The note an earlier batch saved for this item (${entry.noteId}) was moved to the trash or to another item while this call awaited confirmation, so this call wrote nothing for it. Call note_write_batch again to write it.`,
          })),
          ...notes,
        ],
      },
    },
  };
}

function logSettleFailure(error: unknown): void {
  globalThis.Zotero?.debug?.(
    `[llm-for-zotero] Could not settle related note batches: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/** The host's announcement of a note an earlier batch wrote. */
function alreadySavedOutcome(entry: AlreadySavedNote): AgentBatchItemOutcome {
  return {
    batchId: entry.batchId,
    itemKey: entry.itemKey,
    ...(entry.materialRef ? { materialRef: entry.materialRef } : {}),
    status: "saved",
    written: false,
    noteId: entry.noteId,
  };
}

/**
 * The item keys this call actually wrote a note for.
 *
 * The executor reports one row per note it handled and distinguishes a note
 * it created from one an earlier call had already written, so the answer
 * comes from there rather than from the batch's durable rows, which say only
 * that a note exists.
 */
function writtenItemKeys(result: { content: unknown }): Set<string> {
  const outer =
    result.content && typeof result.content === "object"
      ? (result.content as Record<string, unknown>)
      : {};
  const inner =
    outer.result && typeof outer.result === "object"
      ? (outer.result as Record<string, unknown>)
      : {};
  const payload =
    inner.result && typeof inner.result === "object"
      ? (inner.result as Record<string, unknown>)
      : {};
  const notes = Array.isArray(payload.notes) ? payload.notes : [];
  return new Set(
    notes.flatMap((note) =>
      validateObject<Record<string, unknown>>(note) &&
      (note.status === "created" || note.status === "appended") &&
      typeof note.itemKey === "string"
        ? [note.itemKey]
        : [],
    ),
  );
}

/**
 * How far a batch the user stopped got: the notes it reached, of all it was
 * given. Undefined for a batch that ran to its end.
 */
function stoppedReach(result: {
  content: unknown;
}): { after: number; of: number } | undefined {
  const outer =
    result.content && typeof result.content === "object"
      ? (result.content as Record<string, unknown>)
      : {};
  const inner =
    outer.result && typeof outer.result === "object"
      ? (outer.result as Record<string, unknown>)
      : {};
  const payload =
    inner.result && typeof inner.result === "object"
      ? (inner.result as Record<string, unknown>)
      : {};
  const stopped =
    payload.stopped && typeof payload.stopped === "object"
      ? (payload.stopped as Record<string, unknown>)
      : undefined;
  const after = Number(stopped?.after);
  const of = Number(stopped?.of);
  return stopped && Number.isInteger(after) && Number.isInteger(of)
    ? { after, of }
    : undefined;
}

/** What the host announces for each item, read back from the durable rows. */
async function readBatchOutcomes(
  batchId: string,
  writtenKeys: ReadonlySet<string>,
): Promise<AgentBatchItemOutcome[]> {
  return (await listBatchItems(batchId)).map((row) => ({
    batchId: row.batchId,
    itemKey: row.itemKey,
    materialRef: row.materialRef,
    status: row.status,
    written: writtenKeys.has(row.itemKey),
    ...(row.noteId === undefined ? {} : { noteId: row.noteId }),
    ...(row.error === undefined ? {} : { error: row.error }),
  }));
}

function previewOf(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 160 ? `${flattened.slice(0, 160)}…` : flattened;
}

/**
 * What the batch's job row remembers about its notes.
 *
 * The rows carry the frozen body of each item; everything else the write
 * needs -- which paper, which collections, whether the notes are standalone --
 * is the operation's own shape, and it is stored once with the job so a resume
 * never has to ask the model for it again.
 */
function parseStoredBatchInput(inputJson: string | undefined): {
  target: SaveNotesBatchOperation["target"];
  /** A job stored before appends existed has no mode: it created notes. */
  mode: NonNullable<SaveNotesBatchOperation["mode"]>;
  notes: StoredBatchNote[];
  /** The earlier batches this batch was opened as a retry of. */
  retryOf: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson || "{}");
  } catch {
    parsed = {};
  }
  const record = validateObject<Record<string, unknown>>(parsed) ? parsed : {};
  const notes = Array.isArray(record.notes) ? record.notes : [];
  return {
    target: record.target === "standalone" ? "standalone" : "item",
    mode: record.mode === "append" ? "append" : "create",
    retryOf: Array.isArray(record.retryOf)
      ? record.retryOf.filter((id): id is string => typeof id === "string")
      : [],
    notes: notes.flatMap((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) return [];
      const targetItemId = normalizePositiveInt(entry.targetItemId);
      const itemKey = typeof entry.itemKey === "string" ? entry.itemKey : "";
      if (!targetItemId || !itemKey) return [];
      const targetNoteId = normalizePositiveInt(entry.targetNoteId);
      const guard = validateObject<Record<string, unknown>>(entry.append)
        ? entry.append
        : undefined;
      return [
        {
          itemKey,
          targetItemId,
          ...(targetNoteId ? { targetNoteId } : {}),
          ...(typeof guard?.beforeChecksum === "string" &&
          typeof guard.afterChecksum === "string"
            ? {
                append: {
                  beforeChecksum: guard.beforeChecksum,
                  afterChecksum: guard.afterChecksum,
                },
              }
            : {}),
          ...(Array.isArray(entry.collections)
            ? {
                collections: entry.collections
                  .map((id) => normalizePositiveInt(id))
                  .filter((id): id is number => Boolean(id)),
              }
            : {}),
        },
      ];
    }),
  };
}

/**
 * The action this batch most recently wrote under.
 *
 * A batch resumed twice has rows from more than one action; the newest is the
 * one a further resume can still be a part of.
 */
function latestActionId(rows: readonly BatchItemRecord[]): string | undefined {
  return [...rows]
    .filter((row) => row.actionId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.actionId;
}
