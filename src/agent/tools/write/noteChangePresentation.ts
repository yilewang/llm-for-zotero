import { noteHtmlMatches } from "../../../utils/noteHtml";
import { findMissingNoteEmbeds } from "../../../utils/noteEmbeds";
import { ToolExecutionFailure } from "../execution/failure";
import { innermostToolResult } from "../../contracts/toolResultEnvelope";
import { storeRecoveryText } from "../../store/journalRecoveryBlobStore";
import type { AgentNoteChangeResultCard } from "../../types";

/** Called only after native persistence has reloaded and verified the note. */
export async function captureNoteChange(
  note: Zotero.Item,
  beforeHtml: string,
  conversationKey: number,
): Promise<Omit<AgentNoteChangeResultCard, "kind" | "actionId"> | undefined> {
  if (!note.id || !note.key || !note.libraryID) return undefined;
  const afterHtml = note.getNote();
  const [before, after] = await Promise.all([
    storeRecoveryText(beforeHtml),
    storeRecoveryText(afterHtml),
  ]);
  // Counted from the verified native note, so an item the user deleted in
  // the review box is reported as surely as one the model was asked to remove.
  const deleted = findMissingNoteEmbeds(beforeHtml, afterHtml).length;
  return {
    title: note.getNoteTitle?.() || "Note",
    note: { itemId: note.id, libraryID: note.libraryID, key: note.key },
    conversationKey,
    state: noteHtmlMatches(beforeHtml, afterHtml) ? "no_op" : "applied",
    before,
    after,
    description: noteHtmlMatches(beforeHtml, afterHtml)
      ? "No changes were needed."
      : `The note was updated and verified in Zotero.${
          deleted
            ? ` This edit deleted ${deleted} embedded item${deleted === 1 ? "" : "s"}.`
            : ""
        }`,
  };
}

export function buildNoteChangeResultCards(
  content: unknown,
): AgentNoteChangeResultCard[] | null {
  const result = innermostToolResult(content);
  const change = result?.noteChange as
    | Omit<AgentNoteChangeResultCard, "kind" | "actionId">
    | undefined;
  if (
    !change ||
    typeof result.actionId !== "string" ||
    !["updated", "appended", "failed"].includes(String(result.status)) ||
    !change.note?.key ||
    !change.before?.checksum ||
    !change.after?.checksum
  )
    return null;
  return [{ ...change, kind: "note_change", actionId: result.actionId }];
}

/** Failed is not applied: reload native state only to retain a diagnostic before/after pair. */
export async function failedNoteChange(
  error: unknown,
  note: Zotero.Item | null,
  beforeHtml: string,
  conversationKey: number,
): Promise<Record<string, unknown> | null> {
  const actionId = (error as { journalActionId?: unknown })?.journalActionId;
  if (typeof actionId !== "string" || !note?.key) return null;
  const reason = error instanceof Error ? error.message : String(error);
  let verified = true;
  try {
    await note.reload(["note"], true);
  } catch {
    verified = false;
  }
  const before = await storeRecoveryText(beforeHtml);
  const after = verified ? await storeRecoveryText(note.getNote()) : before;
  const state = !verified
    ? "unverified"
    : noteHtmlMatches(beforeHtml, note.getNote())
      ? "failed"
      : "mismatch";
  return {
    error: reason,
    status: "failed",
    actionId,
    noteChange: {
      title: note.getNoteTitle?.() || "Note",
      note: { itemId: note.id, libraryID: note.libraryID, key: note.key },
      conversationKey,
      state,
      before,
      after,
      afterVerified: verified,
      description:
        state === "unverified"
          ? `The note may have changed, but native verification is unavailable. ${reason}`
          : state === "mismatch"
            ? `The note changed, but completion of the requested change is unverified. Inspect the recorded difference. ${reason}`
            : `The requested change was not applied; native readback matches the original note. ${reason}`,
    },
  };
}

export async function presentNoteChangeFailure(
  error: unknown,
  note: Zotero.Item | null,
  beforeHtml: string | undefined,
  conversationKey: number,
): Promise<never> {
  const content =
    beforeHtml === undefined
      ? null
      : await failedNoteChange(error, note, beforeHtml, conversationKey);
  throw content ? new ToolExecutionFailure(error, content) : error;
}
