import {
  isPdfContextAttachment,
  resolveContextAttachmentSupport,
} from "./contextAttachmentSupport";
import { BALANCED_EVIDENCE_GUIDANCE } from "../../shared/quoteGuidance";
import { formatContextAttachmentSourceType } from "./contextSourceModes";
import type { TextAttachmentSourceMode } from "./contextAttachmentTypes";
import type { PaperContentSourceMode, PaperContextRef } from "./types";

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAttachmentDisplayTitle(
  contextItem: Zotero.Item | null | undefined,
): string {
  if (!contextItem?.isAttachment?.()) return "";
  const title = normalizeText(String(contextItem.getField("title") || ""));
  if (title) return title;
  return getAttachmentFilename(contextItem);
}

function getAttachmentFilename(
  contextItem: Zotero.Item | null | undefined,
): string {
  if (!contextItem?.isAttachment?.()) return "";
  return normalizeText(
    String(
      (contextItem as unknown as { attachmentFilename?: string })
        .attachmentFilename || "",
    ),
  );
}

function getZoteroItemsApi(): {
  get?: (itemId: number) => Zotero.Item | null | undefined;
} | null {
  if (typeof Zotero === "undefined") return null;
  return (
    (
      Zotero as unknown as {
        Items?: { get?: (itemId: number) => Zotero.Item | null | undefined };
      }
    ).Items || null
  );
}

function getItemFieldText(
  item: Zotero.Item | null | undefined,
  field: string,
): string {
  if (!item) return "";
  try {
    return normalizeText(String(item.getField(field) || ""));
  } catch (_err) {
    return "";
  }
}

function getFirstCreatorText(item: Zotero.Item | null | undefined): string {
  if (!item) return "";
  return normalizeText(
    String(
      getItemFieldText(item, "firstCreator") ||
        (item as Zotero.Item).firstCreator ||
        "",
    ),
  );
}

function getYearText(item: Zotero.Item | null | undefined): string {
  if (!item) return "";
  const rawYear = normalizeText(
    String(
      getItemFieldText(item, "year") ||
        getItemFieldText(item, "date") ||
        getItemFieldText(item, "issued") ||
        "",
    ),
  );
  return extractYearValue(rawYear) || rawYear;
}

type PaperContextDisplayFields = {
  title: string;
  attachmentTitle?: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
};

export type PaperContextDisplayCache = Map<
  string,
  PaperContextDisplayFields | null
>;

function getPaperContextDisplayCacheKey(
  paperContext: Pick<PaperContextRef, "itemId" | "contextItemId">,
): string | null {
  const itemId = Math.floor(Number(paperContext.itemId));
  const contextItemId = Math.floor(Number(paperContext.contextItemId));
  if (
    !Number.isFinite(itemId) ||
    itemId <= 0 ||
    !Number.isFinite(contextItemId) ||
    contextItemId <= 0
  ) {
    return null;
  }
  return `${itemId}:${contextItemId}`;
}

function resolveLivePaperContextDisplayFields(
  paperContext: PaperContextRef,
): PaperContextDisplayFields | null {
  const itemId = Math.floor(Number(paperContext.itemId));
  const contextItemId = Math.floor(Number(paperContext.contextItemId));
  if (
    !Number.isFinite(itemId) ||
    itemId <= 0 ||
    !Number.isFinite(contextItemId) ||
    contextItemId <= 0
  ) {
    return null;
  }

  const items = getZoteroItemsApi();
  const item = items?.get?.(itemId) || null;
  const contextItem = items?.get?.(contextItemId) || null;
  const contextIsSameItem = itemId === contextItemId;
  if (!item?.isRegularItem?.()) return null;
  if (!contextIsSameItem && !contextItem?.isAttachment?.()) return null;
  if (
    contextItem?.isAttachment?.() &&
    Math.floor(Number(contextItem.parentID || 0)) !== itemId
  ) {
    return null;
  }

  const title = getItemFieldText(item, "title") || `Paper ${itemId}`;
  const attachmentTitle = contextItem?.isAttachment?.()
    ? getAttachmentDisplayTitle(contextItem)
    : "";
  return {
    title,
    attachmentTitle: attachmentTitle || undefined,
    citationKey: getItemFieldText(item, "citationKey") || undefined,
    firstCreator: getFirstCreatorText(item) || undefined,
    year: getYearText(item) || undefined,
  };
}

export function isTextLikeAttachmentSourceMode(
  mode: PaperContentSourceMode | undefined | null,
): mode is TextAttachmentSourceMode {
  return (
    mode === "markdown" || mode === "html" || mode === "txt" || mode === "docx"
  );
}

export function formatAttachmentSourceType(
  mode: PaperContentSourceMode | undefined | null,
): string {
  return formatContextAttachmentSourceType(mode);
}

export function resolvePaperContextDisplayRef(
  paperContext: PaperContextRef,
  cache?: PaperContextDisplayCache,
): PaperContextRef {
  const displayRef: PaperContextRef = { ...paperContext };
  const cacheKey = getPaperContextDisplayCacheKey(paperContext);
  let displayFields: PaperContextDisplayFields | null | undefined;
  if (cacheKey && cache?.has(cacheKey)) {
    displayFields = cache.get(cacheKey) || null;
  } else {
    displayFields = resolveLivePaperContextDisplayFields(paperContext);
    if (cacheKey && cache) {
      cache.set(cacheKey, displayFields);
    }
  }
  if (!displayFields) return displayRef;
  return {
    ...displayRef,
    ...displayFields,
  };
}

export function formatPaperAttachmentTitle(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "selected attachment";
  let filename = "";
  if (typeof Zotero !== "undefined") {
    const attachment = (
      Zotero as unknown as {
        Items?: { get?: (itemId: number) => Zotero.Item | null | undefined };
      }
    ).Items?.get?.(paperContext.contextItemId);
    filename = getAttachmentFilename(attachment || null);
  }
  return (
    filename ||
    normalizeText(paperContext.attachmentTitle || "") ||
    `Attachment ${Math.floor(Number(paperContext.contextItemId || 0)) || ""}`.trim()
  );
}

function extractYearValue(value: unknown): string | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match?.[0];
}

export function resolvePaperContextDisplayMetadata(
  paperContext: PaperContextRef,
): {
  firstCreator?: string;
  year?: string;
} {
  let firstCreator = normalizeText(paperContext.firstCreator || "");
  let year = extractYearValue(paperContext.year);
  if ((!firstCreator || !year) && typeof Zotero !== "undefined") {
    const zoteroItem = (
      Zotero as unknown as {
        Items?: { get?: (itemId: number) => Zotero.Item | null | undefined };
      }
    ).Items?.get?.(paperContext.itemId);
    if (zoteroItem?.isRegularItem?.()) {
      if (!firstCreator) {
        firstCreator = normalizeText(
          String(
            zoteroItem.getField("firstCreator") ||
              (zoteroItem as Zotero.Item).firstCreator ||
              "",
          ),
        );
      }
      if (!year) {
        year =
          extractYearValue(zoteroItem.getField("year")) ||
          extractYearValue(zoteroItem.getField("date")) ||
          extractYearValue(zoteroItem.getField("issued"));
      }
    }
  }
  return {
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}

export function formatPaperCitationLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "Paper";
  const metadata = resolvePaperContextDisplayMetadata(paperContext);
  const creator = metadata.firstCreator;
  const year = metadata.year;
  if (creator) {
    return year ? `${creator}, ${year}` : creator;
  }
  const fallbackId =
    Number.isFinite(paperContext.itemId) && paperContext.itemId > 0
      ? Math.floor(paperContext.itemId)
      : Number.isFinite(paperContext.contextItemId) &&
          paperContext.contextItemId > 0
        ? Math.floor(paperContext.contextItemId)
        : 0;
  return fallbackId > 0 ? `Paper ${fallbackId}` : "Paper";
}

export function formatPaperSourceLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (isTextLikeAttachmentSourceMode(paperContext?.contentSourceMode)) {
    const attachmentTitle = formatPaperAttachmentTitle(paperContext);
    const parentLabel = formatPaperCitationLabel(paperContext);
    return `(${attachmentTitle}, attachment under ${parentLabel})`;
  }
  return `(${formatPaperCitationLabel(paperContext)})`;
}

export function buildPaperQuoteCitationGuidance(
  paperContext?: PaperContextRef | null,
): string[] {
  if (paperContext) {
    if (isTextLikeAttachmentSourceMode(paperContext.contentSourceMode)) {
      return [
        "Answer format when quoting this selected attachment:",
        BALANCED_EVIDENCE_GUIDANCE,
        "- If quote anchors are provided, use the exact [[quote:<id>]] token for direct quotes.",
        "- Use `>` only for text copied from the selected attachment.",
        "> quoted text copied from the selected attachment",
        "",
        formatPaperSourceLabel(paperContext),
        "",
        "- If exact passages are available, include short direct-source blockquotes when useful for grounding the answer.",
        "- Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language.",
        "- Put any translation outside the blockquote as explanation, not as the source quote.",
        "- Put the source label on the next non-empty line after the blockquote, before any commentary.",
        "- Never put headings, bullets, interpretation, or other prose between a quoted passage and its source label; clickable quote citations depend on this adjacency.",
        "- Copy the Source label string exactly as provided for this attachment.",
        "- Do not invent author/year/page/section labels.",
        "- Use the EXACT source label above. Do NOT translate or romanize author names.",
        "- Do not write [[source=...]], section=..., or chunk=... metadata in the final answer.",
      ];
    }
    return [
      "Answer format when quoting this paper:",
      BALANCED_EVIDENCE_GUIDANCE,
      "- If quote anchors are provided, use the exact [[quote:<id>]] token for direct quotes.",
      "- Use `>` only for text copied from the paper.",
      "> quoted text copied from the paper",
      "",
      formatPaperSourceLabel(paperContext),
      "",
      "- If exact passages are available, include short direct-source blockquotes when useful for grounding the answer.",
      "- Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language.",
      "- Put any translation outside the blockquote as explanation, not as the source quote.",
      "- Put the source label on the next non-empty line after the blockquote, before any commentary.",
      "- Never put headings, bullets, interpretation, or other prose between a quoted passage and its source label; clickable quote citations depend on this adjacency.",
      "- Copy the Source label string exactly as provided for this paper.",
      "- Do not invent author/year/page/section labels.",
      "- Use the EXACT source label above. Do NOT translate or romanize author names.",
      "- Do not write [[source=...]], section=..., or chunk=... metadata in the final answer.",
    ];
  }
  return [
    "Paper-grounded citation format for the final answer:",
    BALANCED_EVIDENCE_GUIDANCE,
    "- If quote anchors are provided, use the exact [[quote:<id>]] token for direct quotes.",
    "- Use `>` only for text copied from the paper.",
    "> quoted text copied from the paper",
    "",
    "the exact sourceLabel shown for the relevant paper, for example (Author, Year)",
    "",
    "- If exact passages are available, include short direct-source blockquotes when useful for grounding the answer.",
    "- Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language.",
    "- Put any translation outside the blockquote as explanation, not as the source quote.",
    "- Put the source label on the next non-empty line after the blockquote, before any commentary.",
    "- Never put headings, bullets, interpretation, or other prose between a quoted passage and its source label; clickable quote citations depend on this adjacency.",
    "- Copy the Source label string exactly as provided for the relevant paper.",
    "- Do not invent author/year/page/section labels.",
    "- Use the EXACT source label provided for each paper. Do NOT translate or romanize author names.",
    "- Do not cite raw chunk ids, citation keys, or invented page numbers.",
    "- Do not write [[source=...]], section=..., or chunk=... metadata in the final answer.",
  ];
}

export function buildGenericSourceQuoteCitationGuidance(): string[] {
  return [
    "Source-grounded citation format for the final answer:",
    BALANCED_EVIDENCE_GUIDANCE,
    "- If quote anchors are provided, use the exact [[quote:<id>]] token for direct quotes.",
    "- Use `>` only for text copied from the selected source.",
    "> quoted text copied from the selected source",
    "",
    "the exact sourceLabel shown for the selected source",
    "",
    "- If exact passages are available, include short direct-source blockquotes when useful for grounding the answer.",
    "- Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language.",
    "- Put any translation outside the blockquote as explanation, not as the source quote.",
    "- Put the source label on the next non-empty line after the blockquote, before any commentary.",
    "- Never put headings, bullets, interpretation, or other prose between a quoted passage and its source label; clickable quote citations depend on this adjacency.",
    "- Copy the Source label string exactly as provided for the selected source.",
    "- Do not invent author/year/page/section labels.",
    "- Use the EXACT source label provided for each source. Do NOT translate or romanize author names.",
    "- Do not cite raw chunk ids, citation keys, or invented page numbers.",
    "- Do not write [[source=...]], section=..., or chunk=... metadata in the final answer.",
  ];
}

export function formatPaperContextReferenceLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "Paper";
  const citation = formatPaperCitationLabel(paperContext);
  const attachmentTitle = normalizeText(paperContext.attachmentTitle || "");
  const paperTitle = normalizeText(paperContext.title || "");
  const parts = [citation];
  if (paperTitle) parts.push(paperTitle);
  if (attachmentTitle) parts.push(`Attachment: ${attachmentTitle}`);
  return parts.join(" - ");
}

export function formatOpenChatTextContextLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  return `${formatPaperCitationLabel(paperContext)} - Text Context`;
}

export function resolvePaperContextRefFromNote(
  noteItem: Zotero.Item | null | undefined,
): PaperContextRef | null {
  if (!noteItem || !(noteItem as any).isNote?.()) return null;
  const noteItemId = Math.floor(Number(noteItem.id));
  if (!noteItemId || noteItemId <= 0) return null;
  let title = "";
  try {
    title = normalizeText((noteItem as any).getNoteTitle?.() || "");
  } catch (_err) {
    void _err;
  }
  if (!title) title = `Note ${noteItemId}`;
  return {
    itemId: noteItemId,
    contextItemId: noteItemId,
    title,
  };
}

export function resolvePaperContextRefFromAttachment(
  contextItem: Zotero.Item | null | undefined,
): PaperContextRef | null {
  if (!contextItem?.isAttachment?.()) {
    return null;
  }
  const attachmentSupport = resolveContextAttachmentSupport(contextItem);
  if (!attachmentSupport) return null;
  const textSourceMode =
    attachmentSupport.kind === "text"
      ? attachmentSupport.contentSourceMode
      : null;

  const parentItem = contextItem.parentID
    ? Zotero.Items.get(contextItem.parentID) || null
    : null;
  const paperItem = parentItem || contextItem;
  const paperItemId = Number(paperItem.id);
  const contextItemId = Number(contextItem.id);
  if (!Number.isFinite(paperItemId) || !Number.isFinite(contextItemId)) {
    return null;
  }
  const normalizedPaperItemId = Math.floor(paperItemId);
  const normalizedContextItemId = Math.floor(contextItemId);
  if (normalizedPaperItemId <= 0 || normalizedContextItemId <= 0) {
    return null;
  }

  const title = normalizeText(
    String(
      paperItem.getField("title") ||
        contextItem.getField("title") ||
        `Paper ${normalizedPaperItemId}`,
    ),
  );
  const citationKey = normalizeText(
    String(paperItem.getField("citationKey") || ""),
  );
  const attachmentTitle = getAttachmentDisplayTitle(contextItem);
  const firstCreator = normalizeText(
    String(
      paperItem.getField("firstCreator") ||
        (paperItem as Zotero.Item).firstCreator ||
        "",
    ),
  );
  const year = normalizeText(
    String(
      paperItem.getField("year") ||
        paperItem.getField("date") ||
        paperItem.getField("issued") ||
        "",
    ),
  );

  return {
    itemId: normalizedPaperItemId,
    contextItemId: normalizedContextItemId,
    title: title || `Paper ${normalizedPaperItemId}`,
    attachmentTitle: attachmentTitle || undefined,
    citationKey: citationKey || undefined,
    firstCreator: firstCreator || undefined,
    year: year || undefined,
    contentSourceMode: textSourceMode || undefined,
  };
}

export function resolvePaperContextRefFromItem(
  item: Zotero.Item | null | undefined,
): PaperContextRef | null {
  if (!item) return null;
  if (item.isAttachment?.()) {
    return resolvePaperContextRefFromAttachment(item);
  }
  if (!(item as any).isRegularItem?.()) return null;
  const itemId = Number(item.id);
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  const normalizedItemId = Math.floor(itemId);

  // Try to resolve contextItemId to a PDF child attachment so that
  // openReaderForItem receives an attachment ID rather than a parent item ID.
  // Passing a parent item ID can cause "Unsupported attachment type" errors
  // when Zotero's Reader picks a non-PDF attachment as the best match.
  let contextItemId = normalizedItemId;
  const childAttachmentIds = item.getAttachments?.() || [];
  for (const attachmentId of childAttachmentIds) {
    const attachment = Zotero.Items.get(attachmentId);
    if (isPdfContextAttachment(attachment)) {
      contextItemId = Math.floor(attachment.id);
      break;
    }
  }

  const title = normalizeText(
    String(item.getField("title") || `Paper ${normalizedItemId}`),
  );
  const citationKey = normalizeText(String(item.getField("citationKey") || ""));
  const firstCreator = normalizeText(
    String(
      item.getField("firstCreator") || (item as Zotero.Item).firstCreator || "",
    ),
  );
  const year = normalizeText(
    String(
      item.getField("year") ||
        item.getField("date") ||
        item.getField("issued") ||
        "",
    ),
  );
  return {
    itemId: normalizedItemId,
    contextItemId,
    title: title || `Paper ${normalizedItemId}`,
    citationKey: citationKey || undefined,
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}
