import { withConversationWriteLock } from "../../shared/conversationWriteFence";
import { buildActionCallDigest } from "../authorization/proposal";
import { resolveAgentRuntimeRequest } from "../context/resolvedAgentRequest";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { listJournalActions } from "../store/changeJournal";
import type { AgentToolRegistry } from "../tools/registry";
import type { AgentNoteChangeResultCard } from "../types";

/** The clicked card approves exactly its recorded inverse, never a newer action. */
export async function undoNoteChange(
  registry: AgentToolRegistry,
  gateway: ZoteroGateway,
  card: AgentNoteChangeResultCard,
) {
  const note = gateway.getItem(card.note.itemId);
  if (
    !note?.isNote() ||
    note.deleted ||
    note.key !== card.note.key ||
    note.libraryID !== card.note.libraryID
  )
    throw new Error("The original note is unavailable.");
  const [action] = await listJournalActions({
    actionId: card.actionId,
    conversationKey: card.conversationKey,
    limit: 1,
    pendingOnly: true,
  });
  if (
    !action ||
    action.steps.some((step) => {
      const inverse = (
        step.inverseJson ? JSON.parse(step.inverseJson) : undefined
      ) as { kind?: string; noteId?: number } | undefined;
      return (
        inverse?.kind !== "note_html" || inverse.noteId !== card.note.itemId
      );
    })
  )
    throw new Error(
      "This note change cannot be safely reversed as a single note action. Inspect its recorded history.",
    );
  const args = { actionId: card.actionId };
  const prepared = await registry.prepareExecution(
    { id: `undo:${card.actionId}`, name: "undo_last_action", arguments: args },
    {
      request: resolveAgentRuntimeRequest({
        conversationKey: card.conversationKey,
        mode: "agent",
        userText: `Undo the recorded change to ${card.title}`,
        libraryID: card.note.libraryID,
        actionEntryPoint: "conversation",
      }),
      item: note,
      currentAnswerText: "",
      modelName: "action",
    },
    {
      callerKind: "action",
      inheritedApproval: {
        sourceToolName: "note_change",
        sourceActionId: card.actionId,
        sourceMode: "approval",
        approvedCallDigest: buildActionCallDigest("undo_last_action", args),
      },
      executeWithLock: (task) =>
        withConversationWriteLock(card.conversationKey, task),
    },
  );
  if (prepared.kind !== "result")
    throw new Error(
      "The recorded inverse needs a new review; no changes were made.",
    );
  if (!prepared.execution.result.ok)
    throw new Error(
      String(
        (prepared.execution.result.content as { error?: unknown })?.error ||
          "The note could not be safely restored.",
      ),
    );
  return prepared.execution.result;
}
