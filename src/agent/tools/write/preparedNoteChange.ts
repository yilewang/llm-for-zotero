import { noteHtmlMatches, canonicalNoteHtml } from "../../../utils/noteHtml";
import {
  persistVerifiedNoteHtml,
  verifyNativeNoteHtml,
} from "../../../modules/contextPanel/notePersistence";
import {
  appendNoteHtml,
  normalizeNoteSourceText,
} from "../../../modules/contextPanel/notes";
import { invalidateCachedContextText } from "../../../modules/contextPanel/pdfContext";
import {
  executeExternalMutation,
  MutationNoEffectError,
  type ExternalMutationOutcome,
} from "../../services/externalMutationCoordinator";
import {
  isAgentChangeJournalAvailable,
  updateJournalStep,
  registerJournalRecoveryPayloads,
  listJournalActions,
} from "../../store/changeJournal";
import {
  readRecoveryText,
  sha256Text,
  storeRecoveryText,
  type RecoveryPayload,
} from "../../store/journalRecoveryBlobStore";
import type { AgentToolContext } from "../../types";
import {
  captureNoteChange,
  presentNoteChangeFailure,
} from "./noteChangePresentation";

type PreparedNoteChange = {
  version: 1;
  noteId: number;
  libraryID: number;
  key: string;
  mode: "edit" | "append";
  before: RecoveryPayload;
  after: RecoveryPayload;
};

const pending = new Map<number, Promise<unknown>>();

/** Serialize the complete read/prepare/write/verify interval for this native note. */
export async function executePreparedNoteChange(params: {
  context: AgentToolContext;
  note: Zotero.Item;
  mode: "edit" | "append";
  html: string;
  expectedOriginalHtml?: string;
  finalizeHtml?: () => Promise<string>;
}) {
  const previous = pending.get(params.note.id) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => execute(params));
  pending.set(params.note.id, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(params.note.id) === operation)
      pending.delete(params.note.id);
  }
}

async function execute(
  params: Parameters<typeof executePreparedNoteChange>[0],
) {
  const { note, context, mode, html } = params;
  if (
    !note.id ||
    !note.key ||
    !note.libraryID ||
    note.deleted ||
    !note.isNote() ||
    (context.request.libraryID && note.libraryID !== context.request.libraryID)
  ) {
    throw new Error(
      "The bound destination is not a live note in the requested library",
    );
  }
  const scope = context.request.actionContract?.id || context.runId;
  const actionId =
    scope && !context.journalActionScope && isAgentChangeJournalAvailable()
      ? `note-${await sha256Text(JSON.stringify([context.request.conversationKey, scope, note.libraryID, note.key, mode, canonicalNoteHtml(html)]))}`
      : undefined;
  const existing = actionId
    ? (
        await listJournalActions({
          actionId,
          conversationKey: context.request.conversationKey,
          limit: 1,
        })
      )[0]
    : undefined;
  if (
    existing &&
    ["reverted", "reverting", "revert_failed"].includes(existing.status)
  ) {
    throw new Error(
      "This note action was undone; a new user request is required to apply it again",
    );
  }
  let prepared: PreparedNoteChange;
  if (existing) {
    prepared = JSON.parse(existing.steps[0]?.forwardJson || "null");
    if (
      prepared?.version !== 1 ||
      prepared.noteId !== note.id ||
      prepared.libraryID !== note.libraryID ||
      prepared.key !== note.key ||
      prepared.mode !== mode ||
      !prepared.before ||
      !prepared.after
    ) {
      throw new Error(
        "The saved note action has no matching prepared payload; inspect it before retrying",
      );
    }
  } else {
    const current = await verifyNativeNoteHtml(
      note,
      params.expectedOriginalHtml ?? note.getNote(),
    );
    if (params.expectedOriginalHtml !== undefined && !current.matches) {
      throw new Error(
        "The target note changed after preparation. Read it again before proposing a new change.",
      );
    }
    prepared = {
      version: 1,
      noteId: note.id,
      libraryID: note.libraryID,
      key: note.key,
      mode,
      before: await storeRecoveryText(current.html),
      after: await storeRecoveryText(
        mode === "append" ? appendNoteHtml(current.html, html) : html,
      ),
    };
  }
  const before = await readRecoveryText(prepared.before);
  const checkpoint = existing?.steps[0]?.resultJson
    ? JSON.parse(existing.steps[0].resultJson)
    : null;
  let expected = await readRecoveryText(
    checkpoint?.preparedAfter || prepared.after,
  );
  let finalized = !params.finalizeHtml || Boolean(checkpoint?.preparedAfter);
  let finalizationStarted = false;
  const result = async () => {
    const verification = await verifyNativeNoteHtml(note, expected);
    if (!verification.matches)
      throw new Error(
        "The stored note differs from the prepared change; no additional write was attempted",
      );
    invalidateCachedContextText(note.id);
    const changed = !noteHtmlMatches(before, verification.html);
    return {
      result: {
        status: mode === "append" ? "appended" : "updated",
        noteId: note.id,
        title: note.getNoteTitle?.() || "Note",
        noteText: normalizeNoteSourceText(verification.html),
        preparedAfter: await storeRecoveryText(expected),
        noteVerification: verification,
        noteChange: await captureNoteChange(
          note,
          before,
          context.request.conversationKey,
        ),
      },
      expectedPostcondition: {
        kind: "note_html",
        noteId: note.id,
        canonicalChecksum: await sha256Text(
          canonicalNoteHtml(verification.html),
        ),
      },
      effect: changed ? ("applied" as const) : ("none" as const),
      affectedCount: changed ? 1 : 0,
    };
  };
  const write = async () => {
    const current = await verifyNativeNoteHtml(note, expected);
    if (finalized && current.matches) return result();
    if (!noteHtmlMatches(current.html, before))
      throw new Error(
        "The note contains another change; recovery cannot overwrite it",
      );
    if (!finalized) {
      if (existing || finalizationStarted)
        throw new Error(
          "Note assets are incomplete; inspect the retained action before importing again",
        );
      finalizationStarted = true;
      const html = await params.finalizeHtml!();
      expected = mode === "append" ? appendNoteHtml(before, html) : html;
      const preparedAfter = await storeRecoveryText(expected);
      if (actionId) {
        await registerJournalRecoveryPayloads({
          actionId,
          stepId: `${actionId}:1`,
          value: preparedAfter,
        });
        await updateJournalStep({
          stepId: `${actionId}:1`,
          status: "applying",
          result: { preparedAfter },
        });
      }
      finalized = true;
      const afterFinalization = await verifyNativeNoteHtml(note, before);
      if (!afterFinalization.matches)
        throw new Error(
          "The note changed during asset finalization; the new content was preserved",
        );
    }
    try {
      await persistVerifiedNoteHtml(note, expected);
    } catch (error) {
      const observed = await verifyNativeNoteHtml(note, expected);
      if (observed.matches) return result();
      if (noteHtmlMatches(observed.html, before))
        throw new MutationNoEffectError(
          "The requested note change was not applied; native readback matches the original",
        );
      throw error;
    }
    return result();
  };
  return executeExternalMutation({
    context,
    toolName: "note_write",
    recovery: actionId ? { actionId, resume: Boolean(existing) } : undefined,
    plan: {
      operation: mode === "append" ? "append_note_html" : "replace_note_html",
      description: `${mode === "append" ? "Append to" : "Edit"} note: ${note.getNoteTitle?.() || note.id}`,
      forward: prepared,
      inverse: {
        version: 1,
        kind: "note_html",
        noteId: note.id,
        payload: prepared.before,
      },
      precondition: {
        kind: "note_html",
        noteId: note.id,
        checksum: prepared.before.checksum,
      },
      reversibility: params.finalizeHtml ? "partial" : "full",
      reason: params.finalizeHtml
        ? "Imported image attachments may remain after restoring the original note"
        : undefined,
    },
    execute: write,
    reconcileAfterError: async (): Promise<ExternalMutationOutcome<
      Awaited<ReturnType<typeof result>>["result"]
    > | null> => {
      if (!finalized) return null;
      const current = await verifyNativeNoteHtml(note, expected);
      if (current.matches) return result();
      // A single bounded retry is permitted only after proving no native effect.
      if (!existing && noteHtmlMatches(current.html, before)) return write();
      return null;
    },
  }).catch((error) =>
    presentNoteChangeFailure(
      error,
      note,
      before,
      context.request.conversationKey,
    ),
  );
}
