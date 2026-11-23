import type { NoteContextRef } from "../../shared/types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { AgentToolRegistry } from "../tools/registry";
import type { AgentToolResult } from "../types";
import { callTool } from "./executor";

export type ReplaceNoteSelectionInput = {
  /** The note the text was selected in, as the selection recorded it. */
  noteContext: NoteContextRef;
  /** The conversation the change is filed under, for its undo. */
  conversationKey: number;
  /** The selected text, exactly as the note editor showed it. */
  selectedText: string;
  /** The replacement, as Markdown. */
  replacement: string;
};

export type ReplaceNoteSelectionOutcome =
  | { ok: true; result: AgentToolResult }
  | { ok: false; error: string; result?: AgentToolResult };

function failureText(result: AgentToolResult): string {
  const content = result.content as { error?: unknown } | null | undefined;
  if (typeof content?.error === "string" && content.error.trim())
    return content.error.trim();
  const reason = result.actionReceipts?.[0]?.reasons?.find((text) =>
    String(text || "").trim(),
  );
  return reason ? String(reason) : "The note change could not be verified.";
}

/**
 * Replaces the text the user selected in a note with an inline answer (the
 * note editor's inline card).
 *
 * It takes the action route of note_write's bound selection: the selected
 * text must still occur exactly once in the note, the change keeps the
 * selection's structure and embeds, an open editor's unsaved typing is saved
 * first, and the change journal records it for undo. The card shows the
 * replacement, so its Replace click is the user's confirmation: the review
 * is resolved here, and a second review is refused.
 */
export async function replaceNoteSelection(
  registry: AgentToolRegistry,
  gateway: ZoteroGateway,
  input: ReplaceNoteSelectionInput,
): Promise<ReplaceNoteSelectionOutcome> {
  const conversationKey = Math.floor(Number(input.conversationKey));
  const noteId = Math.floor(Number(input.noteContext.noteItemId));
  if (!(conversationKey > 0) || !(noteId > 0))
    throw new Error("Replacing note text needs its note and conversation.");
  let confirmations = 0;
  const result = await callTool(
    "note_write",
    {
      mode: "edit",
      targetNoteId: noteId,
      selection: { index: 1, replacement: input.replacement },
    },
    {
      registry,
      zoteroGateway: gateway,
      libraryID: input.noteContext.libraryID,
      conversationKey,
      confirmationMode: "native_ui",
      onProgress: () => undefined,
      requestConfirmation: async (_requestId, action) => {
        confirmations += 1;
        return {
          approved: confirmations === 1 && action.toolName === "note_write",
        };
      },
      requestContext: {
        actionEntryPoint: "action_ui",
        activeItemId: noteId,
        selectedTextContexts: [
          {
            text: input.selectedText,
            source: "note-edit",
            noteContext: input.noteContext,
            contextItemId: noteId,
          },
        ],
      },
    },
    "Replace the selected note text",
  );
  if (result.ok && result.actionReceipts?.[0]?.status === "applied")
    return { ok: true, result };
  return { ok: false, error: failureText(result), result };
}
