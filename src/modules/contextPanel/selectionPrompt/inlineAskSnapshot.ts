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

/** Zotero's selection draft as Save writes it (annotate_pdf's `selection`). */
export type InlineAskSelectionDraft = {
  pageIndex: number;
  rects: number[][];
  sortIndex: string;
  pageLabel: string;
  text: string;
};

/** Why Save cannot run now. */
export type InlineAskSaveBlock =
  | "not_pdf"
  | "trashed"
  | "read_only"
  | "cross_page"
  | "no_position"
  | "no_conversation";

export type InlineAskSelectionDraftRead =
  | { ok: true; selection: InlineAskSelectionDraft }
  | { ok: false; block: "cross_page" | "no_position" };

function isRect(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * The selection Save writes, read from the popup draft copy. Values stay as
 * Zotero computed them (no rounding), so the written annotation and a retry
 * compare equal.
 */
export function readInlineAskSelectionDraft(
  annotation: unknown,
  selectedText: string,
  fallbackPageLabel?: string,
): InlineAskSelectionDraftRead {
  const draft = annotation as {
    text?: unknown;
    sortIndex?: unknown;
    pageLabel?: unknown;
    position?: {
      pageIndex?: unknown;
      rects?: unknown;
      nextPageRects?: unknown;
    } | null;
  } | null;
  const position = draft?.position;
  if (position?.nextPageRects !== undefined && position?.nextPageRects !== null)
    return { ok: false, block: "cross_page" };
  const pageIndex = position?.pageIndex;
  const rects = position?.rects;
  const text =
    (typeof draft?.text === "string" ? draft.text.trim() : "") ||
    selectedText.trim();
  if (
    typeof pageIndex !== "number" ||
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    !Array.isArray(rects) ||
    !rects.length ||
    !rects.every(isRect) ||
    typeof draft?.sortIndex !== "string" ||
    !draft.sortIndex ||
    !text
  )
    return { ok: false, block: "no_position" };
  return {
    ok: true,
    selection: {
      pageIndex,
      rects: rects as number[][],
      sortIndex: draft.sortIndex,
      pageLabel:
        typeof draft.pageLabel === "string"
          ? draft.pageLabel
          : fallbackPageLabel || "",
      text,
    },
  };
}

/** The first reason Save cannot run, or null when it can. */
export function checkInlineAskSave(facts: {
  isPdf: boolean;
  trashed: boolean;
  editable: boolean;
  conversationKey: number | null;
  draft: InlineAskSelectionDraftRead;
}): InlineAskSaveBlock | null {
  if (!facts.isPdf) return "not_pdf";
  if (facts.trashed) return "trashed";
  if (!facts.editable) return "read_only";
  if (!facts.draft.ok) return facts.draft.block;
  const key = Number(facts.conversationKey);
  if (!Number.isFinite(key) || key <= 0) return "no_conversation";
  return null;
}
