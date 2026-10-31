import type {
  PdfHighlightPosition,
  ResolvedPdfHighlight,
} from "./pdfAnnotationResolver";

/** The annotation types a quoted passage can anchor. */
export type PdfPassageAnnotationType = "highlight" | "underline" | "note";

export type PdfHighlightPayload = ResolvedPdfHighlight & {
  color: string;
  comment: string;
  /** Absent on payloads written before underlines and notes: a highlight. */
  type?: PdfPassageAnnotationType;
};

/** The side of Zotero's sticky note, in PDF points. */
export const PDF_NOTE_SIZE = 22;

/**
 * Where a sticky note at a passage goes: one note-sized square whose origin
 * is the origin of the passage's first rectangle.
 */
export function stickyNotePosition(
  position: PdfHighlightPosition,
): PdfHighlightPosition {
  const [x, y] = position.rects[0];
  return {
    pageIndex: position.pageIndex,
    rects: [[x, y, x + PDF_NOTE_SIZE, y + PDF_NOTE_SIZE]],
  };
}

/** Read native fields, never a tool's success flag or a truncated library summary. */
export function annotationMatchesPayload(
  item: any,
  attachmentId: number,
  expected: PdfHighlightPayload,
): boolean {
  const type = expected.type || "highlight";
  try {
    const position =
      typeof item?.annotationPosition === "string"
        ? JSON.parse(item.annotationPosition)
        : item?.annotationPosition;
    return Boolean(
      item?.isAnnotation?.() &&
      !item.deleted &&
      Number(item.parentID) === attachmentId &&
      item.annotationType === type &&
      // A note carries no text; the passage it marks is its position.
      (type === "note"
        ? !item.annotationText
        : item.annotationText === expected.text) &&
      (item.annotationComment || "") === expected.comment &&
      item.annotationColor === expected.color &&
      item.annotationPageLabel === expected.pageLabel &&
      item.annotationSortIndex === expected.sortIndex &&
      position?.pageIndex === expected.position.pageIndex &&
      JSON.stringify(position?.rects) ===
        JSON.stringify(expected.position.rects) &&
      !position?.nextPageRects,
    );
  } catch {
    return false;
  }
}
