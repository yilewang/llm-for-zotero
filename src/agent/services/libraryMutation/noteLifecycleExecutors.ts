import {
  createdNoteOutcome,
  executeNoteCreation,
  readReservedNote,
  RESERVED_NOTE_MISMATCH,
} from "../noteCreation";
import { MutationNoEffectError } from "../externalMutationCoordinator";
import { renderRawNoteHtml } from "../../../services/notes/noteRendering";
import { verifyNativeNoteHtml } from "../../../services/notePersistence";
import { canonicalNoteHtml, noteHtmlMatches } from "../../../utils/noteHtml";
import {
  readRecoveryText,
  sha256Text,
  type RecoveryPayload,
} from "../../store/journalRecoveryBlobStore";
import {
  inJournalTransaction,
  listJournalSteps,
  registerJournalRecoveryPayloads,
  updateJournalStep,
  type JournalStep,
} from "../../store/changeJournal";
import { executePreparedNoteChange } from "../../tools/write/preparedNoteChange";
import type { AgentJournalActionScope, AgentToolContext } from "../../types";
import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import type {
  NativeNoteWriteEvidence,
  SaveNotesBatchOperation,
} from "./contracts";
import { buildSaveNoteInverse } from "./forwardExecutionSupport";
import type { AgentBatchBinding } from "../../types";
import { loadPlanDocument } from "../../documents/store";
import { documentNoteParts } from "../../documents/actions";
import { mergeNoteCitationItems } from "../../../utils/noteCitations";
import { assertMaterialRefMatches } from "../../documents/workflowMaterial";
import { advanceBatchJob } from "../../store/batchJobStore";
import {
  linkBatchItemsToAction,
  listBatchItems,
  markBatchItemFailed,
  markBatchItemSaved,
  type BatchItemRecord,
} from "../../store/batchItemStore";

/**
 * The exact HTML one batch item writes.
 *
 * A finalized item writes its stored document, re-checked against the frozen
 * reference, so a retry after a crash cannot write text that drifted from the
 * material the user approved. Without material — the operation executed
 * outside a durable batch — the supplied body is rendered as before.
 *
 * Either way the HTML is the one a single finalized document would store:
 * each `{{cite item=…}}` becomes a citation chip registered in the note
 * root, and a request that cannot be cited throws, so it becomes this
 * item's failure before anything is written.
 */
async function noteHtmlForBatchItem(params: {
  bound?: AgentBatchBinding["items"][number];
  content: string;
  libraryID: number;
}): Promise<string> {
  const parts = await noteBodyPartsForBatchItem(params);
  return mergeNoteCitationItems(parts.html, parts.citationItems);
}

/**
 * The same body with its cited works kept apart from a root, for an append.
 * The works are registered in the target note's own root, so the note keeps
 * one root; see `documentNoteParts`.
 */
async function noteBodyPartsForBatchItem(params: {
  bound?: AgentBatchBinding["items"][number];
  content: string;
  libraryID: number;
}): Promise<ReturnType<typeof documentNoteParts>> {
  if (!params.bound)
    return documentNoteParts(
      renderRawNoteHtml(params.content),
      params.libraryID,
    );
  // A bound item whose body could not be finalized has nothing the user
  // approved, so it is recorded as this item's failure instead of falling
  // back to the unfinalized text.
  if (!params.bound.material)
    throw new Error(params.bound.failure || "The note body was not finalized");
  const document = await loadPlanDocument(params.bound.material.documentId);
  if (!document)
    throw new Error(
      `The finalized note material ${params.bound.material.documentId} is no longer stored`,
    );
  assertMaterialRefMatches(document, params.bound.material);
  return documentNoteParts(document.visibleHtml, params.libraryID);
}

/**
 * Append one batch item's body to its note, once.
 *
 * The note's checksum is read first. The after-checksum frozen before the
 * batch means an earlier attempt's append landed and only its checkpoint
 * was lost, so nothing is written again. Any value other than the
 * before-checksum means someone changed the note since the user approved
 * the batch, and the item fails without a write.
 */
async function appendBatchNote(params: {
  note: Zotero.Item;
  bound?: AgentBatchBinding["items"][number];
  content: string;
  context: AgentToolContext;
}) {
  const { note, bound, context } = params;
  if (!note.isNote?.() || note.deleted)
    throw new Error(`Item ${note.id} is not a live note to append to`);
  const body = await noteBodyPartsForBatchItem({
    bound,
    content: params.content,
    libraryID: note.libraryID,
  });
  const current = await verifyNativeNoteHtml(note, note.getNote());
  const checksum = await sha256Text(canonicalNoteHtml(current.html));
  if (bound?.append) {
    if (checksum === bound.append.afterChecksum)
      return { alreadyApplied: true as const };
    if (checksum !== bound.append.beforeChecksum)
      throw new MutationNoEffectError(
        `Note ${note.id} changed after the batch was approved; nothing was appended to it`,
      );
  }
  const execution = await executePreparedNoteChange({
    context,
    note,
    mode: "append",
    html: body.html,
    expectedOriginalHtml: current.html,
    // The cited works are registered in the target note's root; a root in the
    // appended body would be a second one inside the note.
    citationItems: body.citationItems,
  });
  return {
    alreadyApplied: false as const,
    verification: execution.content.noteVerification,
    journalStep: execution.journalStep,
  };
}

/**
 * The batch rows this operation's notes belong to, position by position.
 *
 * A binding that does not line up with the notes would write one paper's
 * approved material onto another paper, durably, so a mismatch stops the
 * batch before its first write rather than being repaired per item.
 */
function batchBindingFor(
  binding: AgentBatchBinding | undefined,
  notes: ReadonlyArray<{ targetItemId: number }>,
): AgentBatchBinding | undefined {
  if (!binding) return undefined;
  const alignedToNotes =
    binding.items.length === notes.length &&
    binding.items.every(
      (item, index) => item.targetItemId === notes[index].targetItemId,
    );
  if (!alignedToNotes)
    throw new Error("The batch rows do not describe these notes");
  return binding;
}

/** What a resume found for a row whose note an interrupted attempt began. */
type InterruptedCreation =
  | {
      kind: "saved";
      noteId: number;
      evidence: NativeNoteWriteEvidence;
    }
  | {
      kind: "blocked";
      reason: string;
      journalStep: { actionId: string; sequence: number };
    };

type CreateNoteForward = {
  key?: unknown;
  libraryID?: unknown;
  parentItemId?: unknown;
  collections?: unknown;
  html?: unknown;
};

function sameCollections(left: unknown, right: readonly number[]): boolean {
  const ids = Array.isArray(left) ? left.map(Number) : [];
  return ids.length === right.length && ids.every((id) => right.includes(id));
}

/**
 * Settle, from native Zotero state, the note creations an interrupted
 * attempt of this batch left `uncertain`, before any note is written again.
 *
 * The process can end after a note was saved and before its journal step
 * recorded that. The step reserved the note's key, so the key says what
 * happened:
 * - a live note at the key, on the intended parent, with the finalized
 *   content: the step is recorded as applied, exactly as a creation that had
 *   finished would have recorded it, and its row as saved;
 * - nothing at the key: the creation never landed; the step fails and the
 *   row is written as usual;
 * - anything else (trashed, moved, edited): the step stays `uncertain` and
 *   the row is refused with the reason. A replacement would be the second
 *   note on that paper, and a failed step would let a later resume write it.
 *
 * It runs inside the action the resume reopened, which holds the claim, so
 * no other resume can settle the same steps at the same time.
 */
async function settleInterruptedNoteCreations(params: {
  operation: SaveNotesBatchOperation;
  binding: AgentBatchBinding;
  priorRows: ReadonlyMap<string, BatchItemRecord>;
  scope: AgentJournalActionScope;
  libraryIdOf: (targetItemId: number) => number | undefined;
}): Promise<Map<string, InterruptedCreation>> {
  const { operation, binding, scope } = params;
  const settled = new Map<string, InterruptedCreation>();
  const open = (await listJournalSteps(scope.actionId)).filter(
    (step) => step.operation === "create_note" && step.status === "uncertain",
  );
  if (!open.length) return settled;
  const standalone = operation.target === "standalone";
  for (const [index, entry] of operation.notes.entries()) {
    if (!open.length) break;
    const bound = binding.items[index];
    if (!bound || params.priorRows.get(bound.itemKey)?.status === "saved")
      continue;
    const libraryID = params.libraryIdOf(entry.targetItemId);
    if (libraryID === undefined) continue;
    const collections = standalone ? entry.collections || [] : [];
    // Only a standalone note needs the rebuilt body, to tell which row a step
    // belongs to; a child note is told apart by its parent.
    let rebuilt: string | undefined;
    if (standalone) {
      try {
        rebuilt = await noteHtmlForBatchItem({
          bound,
          content: entry.content,
          libraryID,
        });
      } catch {
        // The row cannot be written either; the write loop reports why.
        continue;
      }
    }
    const findMatch = async () => {
      for (const step of open) {
        let forward: CreateNoteForward;
        try {
          forward = JSON.parse(step.forwardJson) as CreateNoteForward;
        } catch {
          continue;
        }
        if (!forward || typeof forward.key !== "string") continue;
        if (!standalone) {
          if (forward.parentItemId === entry.targetItemId)
            return { step, forward };
          continue;
        }
        // A standalone note names no paper: its step belongs to this row when
        // it was filed into the same collections with the same intended body.
        if (forward.parentItemId !== undefined && forward.parentItemId !== null)
          continue;
        if (!sameCollections(forward.collections, collections)) continue;
        let intended: string;
        try {
          intended = await readRecoveryText(forward.html as RecoveryPayload);
        } catch {
          continue;
        }
        if (noteHtmlMatches(intended, rebuilt as string))
          return { step, forward };
      }
      return undefined;
    };
    // A row may have more than one open step (older data): a step whose note
    // never landed says nothing about the others, so matching goes on.
    for (;;) {
      const match = await findMatch();
      if (!match) break;
      open.splice(open.indexOf(match.step), 1);
      const { step, forward } = match;
      const journalStep = { actionId: step.actionId, sequence: step.sequence };
      const block = async (reason: string) => {
        await inJournalTransaction(() =>
          updateJournalStep({
            stepId: step.stepId,
            status: "uncertain",
            error: reason,
          }),
        );
        settled.set(bound.itemKey, { kind: "blocked", reason, journalStep });
      };
      try {
        const parentItemId =
          typeof forward.parentItemId === "number"
            ? forward.parentItemId
            : undefined;
        const reserved = readReservedNote({
          libraryID: Number(forward.libraryID),
          key: forward.key as string,
          parentItemId,
        });
        if (reserved.kind === "absent") {
          await inJournalTransaction(() =>
            updateJournalStep({
              stepId: step.stepId,
              status: "failed",
              reversibility: "full",
              error: "Interrupted before the change landed.",
            }),
          );
          continue;
        }
        if (reserved.kind === "changed") {
          await block(`${reserved.reason} (note ${reserved.note.id})`);
          break;
        }
        const note = reserved.note;
        // The content the step reserved, as a creation checks it: the rebuilt
        // body can differ after a cited work's metadata was edited.
        const html = await readRecoveryText(forward.html as RecoveryPayload);
        const verification = await verifyNativeNoteHtml(note, html);
        if (!verification.matches) {
          await block(`${RESERVED_NOTE_MISMATCH} (note ${note.id})`);
          break;
        }
        const outcome = await createdNoteOutcome({
          note,
          expectedHtml: html,
          verification,
          parentItemId,
          collections: standalone ? collections : undefined,
          warnings: [],
        });
        await inJournalTransaction(async () => {
          await registerJournalRecoveryPayloads({
            actionId: step.actionId,
            stepId: step.stepId,
            value: outcome.inverse,
          });
          await updateJournalStep({
            stepId: step.stepId,
            status: "applied",
            inverse: outcome.inverse,
            expectedPostcondition: outcome.expectedPostcondition,
            result: outcome.result,
            reversibility: "full",
          });
        });
        scope.recordStep({
          effect: "applied",
          status: "applied",
          reversibility: "full",
          affectedCount: 1,
        });
        // Saved now, not when the write loop reaches the row: a process that
        // ends in between must not find an applied step beside a pending row.
        await markBatchItemSaved(binding.batchId, bound.itemKey, {
          actionId: step.actionId,
          stepSequence: step.sequence,
          noteId: note.id,
        });
        settled.set(bound.itemKey, {
          kind: "saved",
          noteId: note.id,
          evidence: {
            noteId: note.id,
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(standalone && collections.length ? { collections } : {}),
            verification,
          },
        });
        break;
      } catch (error) {
        await block(error instanceof Error ? error.message : String(error));
        break;
      }
    }
  }
  return settled;
}

type DomainOperation =
  | "save_notes_batch"
  | "create_items"
  | "save_note"
  | "trash_items"
  | "restore_from_trash"
  | "merge_items";

export const noteLifecycleExecutors = {
  save_notes_batch: async (operation, context, zoteroGateway) => {
    const rows: Array<{
      targetItemId: number;
      /** The durable row this note belongs to, when it runs inside a batch. */
      itemKey?: string;
      noteId?: number;
      actionId?: string;
      title: string;
      status: "created" | "appended" | "already_saved" | "error";
      reason?: string;
    }> = [];
    // The read-back each creation already forced, kept for the receipt owner.
    // Only a note this call physically created contributes one: an item the
    // batch skipped as already saved was written by an earlier call and is
    // that call's receipt to prove, not this one's.
    const noteWrites: NativeNoteWriteEvidence[] = [];
    const binding = batchBindingFor(context.batchBinding, operation.notes);
    const batchId = binding?.batchId;
    // What this batch has already written. A note is written once: inside a
    // batch action `executeNoteCreation` has no journal action of its own to
    // recover, so nothing downstream would recognise the second attempt.
    const priorRows = new Map(
      (batchId ? await listBatchItems(batchId) : []).map((row) => [
        row.itemKey,
        row,
      ]),
    );
    let appliedCount = [...priorRows.values()].filter(
      (row) => row.status === "saved",
    ).length;
    const scope = context.journalActionScope;
    // Every row this call may write names the action before the first note
    // starts, so a resume after a crash during that note finds its step.
    if (binding && scope)
      await linkBatchItemsToAction(
        binding.batchId,
        binding.items.map((item) => item.itemKey),
        scope.actionId,
      );
    const interrupted =
      binding && scope && operation.mode !== "append"
        ? await settleInterruptedNoteCreations({
            operation,
            binding,
            priorRows,
            scope,
            libraryIdOf: (targetItemId) =>
              zoteroGateway.getItem(targetItemId)?.libraryID,
          })
        : new Map<string, InterruptedCreation>();
    for (const found of interrupted.values())
      if (found.kind === "saved") appliedCount += 1;
    // Progress is written after each note lands, never before: a cursor ahead
    // of the library would skip an unwritten note on resume.
    const recordProgress = async (params: {
      itemKey?: string;
      position: number;
      journalStep?: { actionId: string; sequence: number };
      noteId?: number;
      error?: string;
      alreadySaved?: boolean;
    }) => {
      if (!batchId || !params.itemKey) return;
      const now = Date.now();
      if (params.alreadySaved) {
        // The row already names the note this item wrote; rewriting it would
        // replace that note's id with a second note's.
      } else if (params.noteId !== undefined) {
        appliedCount += 1;
        await markBatchItemSaved(batchId, params.itemKey, {
          actionId: params.journalStep?.actionId,
          stepSequence: params.journalStep?.sequence,
          noteId: params.noteId,
          now,
        });
      } else {
        await markBatchItemFailed(batchId, params.itemKey, {
          actionId: params.journalStep?.actionId,
          stepSequence: params.journalStep?.sequence,
          error: params.error || "The note was not written",
          now,
        });
      }
      await advanceBatchJob({
        jobId: batchId,
        cursor: params.position,
        appliedCount,
        now,
      });
    };
    // Where the user's Stop ended the batch: the notes before this index
    // were reached, the rest were never started.
    let stoppedAt: number | undefined;
    for (const [index, entry] of operation.notes.entries()) {
      // Stop takes effect between notes. The note in flight has landed, or
      // failed, on its own terms; no further note starts, and each one left
      // keeps its pending row for a resume.
      if (context.signal?.aborted) {
        stoppedAt = index;
        break;
      }
      const bound = binding?.items[index];
      // The durable row's own place in the batch, not this call's: a resume
      // writes a subset, and a cursor renumbered from it would report the
      // batch as further behind than it is.
      const position = bound?.position ?? index + 1;
      const target = zoteroGateway.getItem(entry.targetItemId);
      const title = target
        ? String(target.getDisplayTitle?.() || `Item ${entry.targetItemId}`)
        : `Item ${entry.targetItemId}`;
      const prior = bound ? priorRows.get(bound.itemKey) : undefined;
      if (prior?.status === "saved") {
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: prior.noteId,
          title,
          status: "already_saved",
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          alreadySaved: true,
        });
        continue;
      }
      const found = bound ? interrupted.get(bound.itemKey) : undefined;
      if (found?.kind === "saved") {
        // The interrupted attempt's note, recorded by this call: it is this
        // call's to prove, since no earlier receipt ever named it.
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: found.noteId,
          title,
          status: "created",
        });
        noteWrites.push(found.evidence);
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          alreadySaved: true,
        });
        continue;
      }
      if (found?.kind === "blocked") {
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          title,
          status: "error",
          reason: found.reason,
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          journalStep: found.journalStep,
          error: found.reason,
        });
        continue;
      }
      if (!target) {
        const reason = `No item with ID ${entry.targetItemId} exists in this library`;
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          title,
          status: "error",
          reason,
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          error: reason,
        });
        continue;
      }
      if (operation.mode === "append") {
        try {
          const appended = await appendBatchNote({
            note: target,
            bound,
            content: entry.content,
            context,
          });
          rows.push({
            targetItemId: entry.targetItemId,
            itemKey: bound?.itemKey,
            noteId: target.id,
            title,
            status: appended.alreadyApplied ? "already_saved" : "appended",
          });
          if (!appended.alreadyApplied)
            noteWrites.push({
              noteId: target.id,
              mode: "append",
              verification: appended.verification,
            });
          // A landed append whose row still reads pending is saved now.
          await recordProgress({
            itemKey: bound?.itemKey,
            position,
            journalStep: appended.alreadyApplied
              ? undefined
              : appended.journalStep,
            noteId: target.id,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          rows.push({
            targetItemId: entry.targetItemId,
            itemKey: bound?.itemKey,
            title,
            status: "error",
            reason,
          });
          await recordProgress({
            itemKey: bound?.itemKey,
            position,
            error: reason,
          });
        }
        continue;
      }
      try {
        const execution = await executeNoteCreation({
          context,
          libraryID: target.libraryID,
          parentItemId:
            operation.target === "standalone" ? undefined : target.id,
          collections:
            operation.target === "standalone" ? entry.collections : undefined,
          html: await noteHtmlForBatchItem({
            bound,
            content: entry.content,
            libraryID: target.libraryID,
          }),
        });
        const saved = execution.content;
        // A standalone note has no parent to check the read-back against, so
        // the verifier is told which collections it was filed into instead;
        // a child note is checked against the paper it was written onto.
        const standalone = operation.target === "standalone";
        // Unconditional on purpose: `executeNoteCreation` throws unless the
        // note it created read back as the finalized content, so a success
        // always carries both the id and that read-back. Guarding here would
        // turn a future divergence into a silently missing receipt fact; this
        // way the verifier sees the write and rejects it out loud.
        noteWrites.push({
          noteId: saved.noteId,
          ...(standalone ? {} : { parentItemId: target.id }),
          ...(standalone && entry.collections?.length
            ? { collections: entry.collections }
            : {}),
          verification: saved.noteVerification,
        });
        const childActionId = (
          execution.content as unknown as { actionId?: unknown }
        ).actionId;
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: saved.noteId,
          actionId:
            typeof childActionId === "string" ? childActionId : undefined,
          title,
          status: "created",
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          journalStep: execution.journalStep,
          noteId: saved.noteId,
        });
      } catch (error) {
        // One bad target must not lose the other forty-nine notes.
        const reason = error instanceof Error ? error.message : String(error);
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          title,
          status: "error",
          reason,
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          error: reason,
        });
      }
    }
    // A Stop before the loop reached a row the settler already saved leaves
    // that note landed and recorded; it still gets its result row and its
    // evidence this turn, or the receipt would miss a note that exists.
    if (stoppedAt !== undefined)
      for (const [index, entry] of operation.notes.entries()) {
        if (index < stoppedAt) continue;
        const bound = binding?.items[index];
        const found = bound ? interrupted.get(bound.itemKey) : undefined;
        if (found?.kind !== "saved") continue;
        const target = zoteroGateway.getItem(entry.targetItemId);
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: found.noteId,
          title: target
            ? String(target.getDisplayTitle?.() || `Item ${entry.targetItemId}`)
            : `Item ${entry.targetItemId}`,
          status: "created",
        });
        noteWrites.push(found.evidence);
      }
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          createdCount: rows.filter((row) => row.status === "created").length,
          ...(operation.mode === "append"
            ? {
                appendedCount: rows.filter((row) => row.status === "appended")
                  .length,
              }
            : {}),
          alreadySavedCount: rows.filter(
            (row) => row.status === "already_saved",
          ).length,
          failedCount: rows.filter((row) => row.status === "error").length,
          actionIds: [
            ...new Set(
              rows.flatMap((row) => (row.actionId ? [row.actionId] : [])),
            ),
          ],
          notes: rows,
          // The notes it reached, of all it was given; the receipt owner
          // judges a stopped batch on those alone.
          ...(stoppedAt === undefined
            ? {}
            : { stopped: { after: stoppedAt, of: operation.notes.length } }),
        },
      },
      // Each note is a durable step of the owning action and records its own
      // `trash_items` inverse. A whole-batch inverse here would trash the
      // same notes a second time during an undo.
      inverse: null,
      noteWrites,
    };
  },
  create_items: async (operation, context, zoteroGateway) => {
    const libraryID = zoteroGateway.resolveLibraryID({
      request: context.request,
      item: context.item,
      libraryID: operation.libraryID,
    });
    if (!libraryID) {
      throw new Error("No active library available for item creation");
    }
    const result = await zoteroGateway.createItems({
      libraryID,
      items: operation.items as never,
    });
    const createdIds = result.items
      .filter((row) => row.status === "created" && row.itemId)
      .map((row) => row.itemId as number);
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Trash rather than erase, matching every other delete here: the
      // user may want the item back after undoing by mistake.
      inverse: createdIds.length
        ? {
            inverseOperations: [{ type: "trash_items", itemIds: createdIds }],
            description: `Trash ${createdIds.length} newly created item${
              createdIds.length === 1 ? "" : "s"
            }`,
          }
        : null,
    };
  },
  save_note: async (operation, context, zoteroGateway) => {
    const item =
      (operation.targetItemId
        ? zoteroGateway.getItem(operation.targetItemId)
        : null) ||
      zoteroGateway.getItem(context.request.activeItemId) ||
      context.item;
    const saved = await zoteroGateway.saveAnswerToNote({
      item,
      libraryID: context.request.libraryID,
      content: operation.content,
      modelName: operation.modelName || context.modelName,
      target: operation.target,
      appendToTrackedNote: operation.appendToTrackedNote,
      generatedImages: operation.generatedImages,
      collections: operation.collections,
    });
    // The note id and the collections it landed in are returned so the
    // caller can verify and follow up; previously only a status string
    // came back and any next step was impossible to express.
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: saved.status,
          noteId: saved.noteId,
          collections: saved.collections,
          ...(saved.createdNoteReceipt
            ? { createdNoteReceipt: saved.createdNoteReceipt }
            : {}),
        },
      },
      inverse:
        saved.noteId && saved.noteId > 0
          ? buildSaveNoteInverse(saved.noteId)
          : undefined,
    };
  },
  trash_items: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.trashItems({
      itemIds: operation.itemIds,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.trashedCount > 0
          ? {
              inverseOperations: [
                {
                  type: "restore_from_trash" as const,
                  itemIds: result.items
                    .filter((item) => item.status === "trashed")
                    .map((item) => item.itemId),
                },
              ],
              description: `Restore ${result.trashedCount} trashed item${
                result.trashedCount === 1 ? "" : "s"
              }`,
            }
          : null,
    };
  },
  restore_from_trash: async (operation, context, zoteroGateway) => {
    const itemIds = operation.itemIds || [];
    const collectionIds = operation.collectionIds || [];
    const savedSearchIds = operation.savedSearchIds || [];
    const restoredItems = itemIds.length
      ? await zoteroGateway.restoreItems({ itemIds })
      : { restoredCount: 0, itemIds: [] as number[] };
    const restoredCollections = collectionIds.length
      ? await zoteroGateway.restoreCollections({ collectionIds })
      : { restoredCount: 0, collectionIds: [] as number[] };
    const restoredSearches = savedSearchIds.length
      ? await zoteroGateway.restoreSavedSearches({ savedSearchIds })
      : { restoredCount: 0, savedSearchIds: [] as number[] };
    const restoredCollectionIds = Array.isArray(
      restoredCollections.collectionIds,
    )
      ? restoredCollections.collectionIds
      : [];
    const restoredSavedSearchIds = Array.isArray(
      restoredSearches.savedSearchIds,
    )
      ? restoredSearches.savedSearchIds
      : [];
    const incompleteRestoreIdentity =
      restoredCollectionIds.length < restoredCollections.restoredCount ||
      restoredSavedSearchIds.length < restoredSearches.restoredCount;
    const total =
      restoredItems.restoredCount +
      restoredCollections.restoredCount +
      restoredSearches.restoredCount;
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          restoredItemCount: restoredItems.restoredCount,
          restoredCollectionCount: restoredCollections.restoredCount,
          restoredSavedSearchCount: restoredSearches.restoredCount,
          restoredCollectionIds,
          restoredSavedSearchIds,
          restoredCount: total,
        },
      },
      // The inverse re-trashes only what this call actually restored, so
      // undoing a partial restore cannot sweep up untouched siblings.
      inverse: total
        ? {
            inverseOperations: [
              ...(restoredItems.itemIds.length
                ? [
                    {
                      type: "trash_items" as const,
                      itemIds: restoredItems.itemIds,
                    },
                  ]
                : []),
              ...restoredCollectionIds.map((collectionId) => ({
                type: "delete_collection" as const,
                collectionId,
              })),
              ...restoredSavedSearchIds.map((savedSearchId) => ({
                type: "delete_saved_search" as const,
                savedSearchId,
              })),
            ],
            description: `Move ${total} restored object${total === 1 ? "" : "s"} back to the trash`,
            ...(incompleteRestoreIdentity
              ? {
                  irreversibleReason:
                    "Some restored collection or saved-search IDs were not reported by Zotero, so only the identified objects can be returned to the trash safely.",
                }
              : {}),
          }
        : null,
    };
  },
  merge_items: async (operation, context, zoteroGateway) => {
    // Re-checked at the group's own turn: in a batch of groups an earlier
    // merge, or the user, may have trashed or erased one of these items since
    // the card. Nothing has been written, so the refusal is proof of no effect.
    const refusal = zoteroGateway.mergeRefusal([operation]);
    if (refusal) throw new MutationNoEffectError(refusal);
    const result = await zoteroGateway.mergeItems({
      masterItemId: operation.masterItemId,
      otherItemIds: operation.otherItemIds,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // A merge is not fully reversible: Zotero moves children onto the
      // survivor and deduplicates identical attachments by hash, so the
      // originals no longer exist to give back. Bringing the duplicates
      // out of the trash returns records stripped of their attachments,
      // notes and tags -- so the description says exactly that rather
      // than promising a restore it cannot perform.
      inverse:
        result.mergedCount > 0
          ? {
              description: `Bring ${result.mergedCount} merged item${
                result.mergedCount === 1 ? "" : "s"
              } back from the trash (their attachments, notes and tags stay with the surviving item, so this does not fully un-merge them)`,
              irreversibleReason:
                "A Zotero merge cannot be safely undone because child records may be deduplicated or moved onto the surviving item.",
            }
          : null,
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;
