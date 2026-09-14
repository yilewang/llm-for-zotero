import { getNoteConversation } from "./noteEditing/conversationItem";
import { resolveNoteParentItem, resolveNoteTitle } from "./portalScope";
import { stripNoteHtml } from "../../utils/noteText";
export {
  decodeNoteHtmlEntities,
  stripNoteMarkup,
  stripNoteHtml,
} from "../../utils/noteText";

export type NoteSnapshot = {
  noteId: number;
  noteItemKey?: string;
  title: string;
  html: string;
  text: string;
  libraryID: number;
  parentItemId?: number;
  parentItemKey?: string;
  noteKind: "item" | "standalone";
};

export function readNoteSnapshot(
  item: Zotero.Item | null | undefined,
): NoteSnapshot | null {
  item = getNoteConversation(item)?.note || item;
  if (!(item as any)?.isNote?.()) return null;
  const noteId = Number(item?.id);
  if (!Number.isFinite(noteId) || noteId <= 0) return null;
  const html = String((item as any).getNote?.() || "");
  const parentItem = resolveNoteParentItem(item);
  return {
    noteId: Math.floor(noteId),
    noteItemKey:
      typeof (item as any)?.key === "string" && (item as any).key.trim()
        ? (item as any).key.trim().toUpperCase()
        : undefined,
    title: resolveNoteTitle(item),
    html,
    text: stripNoteHtml(html),
    libraryID: Number(item?.libraryID) || 0,
    parentItemId: parentItem?.id,
    parentItemKey:
      typeof (parentItem as any)?.key === "string" &&
      (parentItem as any).key.trim()
        ? (parentItem as any).key.trim().toUpperCase()
        : undefined,
    noteKind: parentItem ? "item" : "standalone",
  };
}
