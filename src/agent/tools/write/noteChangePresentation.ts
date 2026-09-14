import { noteHtmlMatches } from "../../../utils/noteHtml";
import { ToolExecutionFailure } from "../execution/failure";
import { innermostToolResult } from "../../contracts/toolResultEnvelope";
import { storeRecoveryText } from "../../store/journalRecoveryBlobStore";
import type {
  AgentNoteChangeResultCard,
  AgentToolContext,
  AgentToolResult,
} from "../../types";

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
  return {
    title: note.getNoteTitle?.() || "Note",
    note: { itemId: note.id, libraryID: note.libraryID, key: note.key },
    conversationKey,
    state: noteHtmlMatches(beforeHtml, afterHtml) ? "no_op" : "applied",
    before,
    after,
    description: noteHtmlMatches(beforeHtml, afterHtml)
      ? "No changes were needed."
      : "The note was updated and verified in Zotero.",
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

/** A receipt is the final artifact only when semantic intent requests no further
 * answer and the one frozen action has a matching native verification. */
export function resolveVerifiedNoteEditCompletion(
  result: AgentToolResult,
  context: AgentToolContext,
) {
  const { request } = context;
  const semantic = request.classifiedIntent?.semantic;
  const obligations = request.actionContract?.obligations;
  if (
    semantic?.responseIntent !== "receipt" ||
    semantic.reading.source !== "provided_context" ||
    semantic.materialOutputs?.length ||
    request.planContext ||
    request.documentOutcomePolicy?.required ||
    obligations?.length !== 1 ||
    obligations[0].operation !== "note_edit"
  )
    return null;
  const card = buildNoteChangeResultCards(result.content)?.[0];
  const native = innermostToolResult(result.content)?.noteVerification as
    | { noteId?: number; matches?: boolean }
    | undefined;
  if (
    !result.ok ||
    !card ||
    !["applied", "no_op"].includes(card.state) ||
    native?.matches !== true ||
    native.noteId !== card.note.itemId
  )
    return null;
  const frozenTargets = obligations[0].targetBoundary?.frozenTargetIds;
  if (frozenTargets?.length !== 1 || frozenTargets[0] !== card.note.itemId)
    return null;
  const target = `item:${card.note.itemId}`;
  const receipt = result.actionReceipts.find(
    (r) =>
      r.obligationId === obligations[0].id &&
      r.operation === "note_edit" &&
      r.verification === "verified" &&
      ["applied", "already_satisfied"].includes(r.status) &&
      !r.rejectedTargets.length &&
      [...r.appliedTargets, ...r.alreadySatisfiedTargets].includes(target),
  );
  if (!receipt) return null;
  return {
    finalText: `${card.title}: ${card.description}`,
    providerTranscript: "tool_only" as const,
  };
}
