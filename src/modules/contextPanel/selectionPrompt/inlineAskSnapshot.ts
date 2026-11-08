/**
 * What an Inline Ask card keeps from the moment Zotero showed the selection
 * popup. Save as annotation (M2) works from this snapshot, not from the
 * reader's state at save time.
 */
import type { PaperContextRef } from "../../../shared/types";

export type InlineAskPopupSnapshot = {
  /** A JSON copy of the popup's annotation draft, or null. */
  annotation: Record<string, unknown> | null;
  /** The reader's attachment item. */
  readerItemId: number;
  paperContext: PaperContextRef | null;
  selectedText: string;
  pageIndex: number | null;
  pageLabel?: string;
};

/** Inline Ask is offered in PDF readers only (EPUB and snapshots: later). */
export function isInlineAskReader(
  reader: { type?: unknown } | null | undefined,
  item: { isPDFAttachment?: () => boolean } | null | undefined,
): boolean {
  if (reader && typeof reader.type === "string") return reader.type === "pdf";
  try {
    return Boolean(item?.isPDFAttachment?.());
  } catch {
    return false;
  }
}

/** A detached JSON copy of the popup's annotation draft. */
export function cloneInlineAskAnnotation(
  annotation: unknown,
): Record<string, unknown> | null {
  if (!annotation || typeof annotation !== "object") return null;
  try {
    const copy = JSON.parse(JSON.stringify(annotation)) as unknown;
    return copy && typeof copy === "object"
      ? (copy as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
