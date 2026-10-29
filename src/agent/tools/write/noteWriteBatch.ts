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
} from "../../types";
import type { MaterialRef } from "../../documents/materialRef";
import {
  LibraryMutationService,
  type SaveNotesBatchOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { DirectDocumentFinalizer } from "../../documents/directFinalization";
import { loadPlanDocument } from "../../documents/store";
import {
  assertMaterialRefMatches,
  materialRefFromDocument,
} from "../../documents/workflowMaterial";
import {
  createBatchJob,
  finishBatchJob,
  getBatchJob,
} from "../../store/batchJobStore";
import {
  createBatchItems,
  listBatchItems,
  markBatchItemFailed,
  type BatchItemRecord,
  type NewBatchItem,
} from "../../store/batchItemStore";
import { sha256Text } from "../../store/journalRecoveryBlobStore";
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
};

/** One row a resume has to correct, once the call is authorized to run. */
type ResumeRowCorrection = {
  itemKey: string;
  actionId?: string;
  stepSequence?: number;
  error: string;
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

/** One item as the batch's job row remembers it, so a resume needs no model. */
type StoredBatchNote = {
  itemKey: string;
  targetItemId: number;
  collections?: number[];
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
    const notes = resolvedOperation(input).notes;
    const keys = batchItemKeys(notes);
    const items: PreparedBatchItem[] = [];
    for (const [index, note] of notes.entries()) {
      const base = {
        itemKey: keys[index],
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
    for (const row of rows) {
      const descriptor = stored.get(row.itemKey);
      if (!descriptor)
        throw new Error(
          `Note batch "${batchId}" predates per-item resume records and cannot be continued safely. Write the remaining notes with a new note_write_batch call instead.`,
        );
      if (row.status === "saved") {
        if (noteStillExists(row.noteId)) {
          resume.skippedItemKeys.push(row.itemKey);
          continue;
        }
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
      });
      notes.push({
        targetItemId: descriptor.targetItemId,
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
    if (!(await getBatchJob(batchId)))
      await createBatchJob({
        jobId: batchId,
        conversationKey: context.request.conversationKey,
        action: "note_write_batch",
        input: {
          target: resolvedOperation(input).target,
          // Stored once, so continuing the batch never has to ask the model
          // which paper an item belonged to or where its note should be filed.
          notes: items.map((item, index) => ({
            itemKey: item.itemKey,
            targetItemId: item.targetItemId,
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
              required: ["targetItemId", "content"],
              properties: {
                targetItemId: {
                  type: "number",
                  description: "The item the note is attached to.",
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
          const created = Number(innermost.createdCount || 0);
          const alreadySaved = Number(innermost.alreadySavedCount || 0);
          const failed = Number(innermost.failedCount || 0);
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
      const notes: SaveNotesBatchOperation["notes"] = [];
      for (const raw of args.notes) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const targetItemId = normalizePositiveInt(raw.targetItemId);
        const content = typeof raw.content === "string" ? raw.content : "";
        if (!targetItemId || !content.trim()) continue;
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
          "Every note needs a targetItemId and non-empty content. Nothing valid was provided.",
        );
      }
      return ok({
        operation: {
          type: "save_notes_batch" as const,
          notes,
          target: args.target === "standalone" ? "standalone" : "item",
        },
      });
    },

    createPendingAction(input) {
      const notes = notesOf(input);
      const continuing = Boolean(input._resume);
      return {
        toolName: "note_write_batch",
        title: `Write ${notes.length} note${notes.length === 1 ? "" : "s"}`,
        description: continuing
          ? `Continue an interrupted batch by writing its remaining ${notes.length} note${notes.length === 1 ? "" : "s"}. These are the bodies the batch already prepared; nothing was written again. Uncheck any you do not want. This can be undone.`
          : `Write a note onto ${notes.length} item${notes.length === 1 ? "" : "s"}. Uncheck any you do not want. This can be undone.`,
        confirmLabel: "Write notes",
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
          reason:
            "Every item of this batch is already written, so continuing it changes nothing.",
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
      const batchBinding = await openBatch(input, context);
      const resume = input._resume;
      // The first durable change of an authorized resume. Preparation only
      // decided these; writing them there would have flipped rows under a
      // confirmation card the user can still cancel. They land before the
      // write because the executor skips a row that still reads `saved`.
      for (const correction of resume?.corrections || [])
        await markBatchItemFailed(resume!.batchId, correction.itemKey, {
          actionId: correction.actionId,
          stepSequence: correction.stepSequence,
          error: correction.error,
        });
      const result = notesOf(input).length
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
        ...(result.content as Record<string, unknown>),
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
        batchItems,
        ...(stopped || resume ? { content } : {}),
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
      note.status === "created" &&
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
  notes: StoredBatchNote[];
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
    notes: notes.flatMap((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) return [];
      const targetItemId = normalizePositiveInt(entry.targetItemId);
      const itemKey = typeof entry.itemKey === "string" ? entry.itemKey : "";
      if (!targetItemId || !itemKey) return [];
      return [
        {
          itemKey,
          targetItemId,
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
