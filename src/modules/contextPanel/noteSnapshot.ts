import {
  resolveNoteParentItem,
  resolveNoteTitle,
} from "./portalScope";

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

export function stripNoteHtml(html: string): string {
  if (!html) return "";
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function readNoteSnapshot(
  item: Zotero.Item | null | undefined,
): NoteSnapshot | null {
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
