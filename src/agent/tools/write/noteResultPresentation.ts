import type { AgentSavedNoteResultCard } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { innermostToolResult } from "../../contracts/toolResultEnvelope";
import type { CreatedZoteroNoteReceipt } from "../../../modules/contextPanel/notePersistence";

/** Project a verified creation onto a read-only result, never a proposed draft. */
export function buildSavedNoteResultCards(
  gateway: ZoteroGateway,
  content: unknown,
): AgentSavedNoteResultCard[] | null {
  const result = innermostToolResult(content);
  const receipt = result?.createdNoteReceipt as
    | CreatedZoteroNoteReceipt
    | undefined;
  if (receipt?.schemaVersion !== 1 || receipt.operation !== "created")
    return null;
  const identity = receipt.note;
  if (!identity?.key || result?.noteId !== identity.itemId) return null;
  const note = gateway.getItem(identity.itemId);
  if (
    !note?.isNote() ||
    note.deleted ||
    note.libraryID !== identity.libraryID ||
    note.key !== identity.key
  )
    return null;
  const libraryRecord = Zotero.Libraries?.get?.(note.libraryID);
  const library = (libraryRecord && libraryRecord.name) || "Zotero";
  const parent = note.parentID ? gateway.getItem(note.parentID) : null;
  const location = parent
    ? parent.getDisplayTitle?.() || parent.getField?.("title") || "Paper"
    : (note.getCollections?.() || [])
        .map((id) => {
          const collection = gateway.getCollectionSummary(id);
          return collection?.path || collection?.name || "";
        })
        .filter(Boolean)
        .join(", ") || "Standalone notes";
  return [
    {
      kind: "saved_note",
      actionId:
        typeof result.actionId === "string" ? result.actionId : undefined,
      title: note.getNoteTitle?.() || note.getDisplayTitle?.() || "Saved note",
      destination: `${library} › ${location}`,
      bodyHtml: note.getNote(),
      note: { itemId: note.id, libraryID: note.libraryID, key: note.key },
    },
  ];
}
