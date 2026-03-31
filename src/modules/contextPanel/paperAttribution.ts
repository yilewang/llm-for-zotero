import type { PaperContextRef } from "./types";

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
  const filename = normalizeText(
    String(
      (contextItem as unknown as { attachmentFilename?: string })
        .attachmentFilename || "",
    ),
  );
  return filename;
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
    const zoteroItem = Zotero.Items.get(paperContext.itemId);
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
      : Number.isFinite(paperContext.contextItemId) && paperContext.contextItemId > 0
        ? Math.floor(paperContext.contextItemId)
        : 0;
  return fallbackId > 0 ? `Paper ${fallbackId}` : "Paper";
}

export function formatPaperSourceLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  return `(${formatPaperCitationLabel(paperContext)})`;
}

export function buildPaperQuoteCitationGuidance(
  paperContext?: PaperContextRef | null,
): string[] {
  if (paperContext) {
    return [
      "Answer format when quoting this paper:",
      "> quoted text from the paper",
      formatPaperSourceLabel(paperContext),
      "- Use the EXACT source label above. Do NOT translate or romanize author names.",
    ];
  }
  return [
    "Paper-grounded citation format for the final answer:",
    "> quoted text from the paper",
    "(Author, Year, page N)",
    "- Put the source label on the line immediately after the quote.",
    "- Use the EXACT source label provided for each paper. Do NOT translate or romanize author names.",
    "- Do not cite raw chunk ids, citation keys, or invented page numbers unless they are explicitly provided.",
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
  if (
    !contextItem ||
    !contextItem.isAttachment?.() ||
    contextItem.attachmentContentType !== "application/pdf"
  ) {
    return null;
  }
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
  const citationKey = normalizeText(String(paperItem.getField("citationKey") || ""));
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
    if (
      attachment?.isAttachment?.() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      contextItemId = Math.floor(attachment.id);
      break;
    }
  }

  const title = normalizeText(
    String(item.getField("title") || `Paper ${normalizedItemId}`),
  );
  const citationKey = normalizeText(String(item.getField("citationKey") || ""));
  const firstCreator = normalizeText(
    String(item.getField("firstCreator") || (item as Zotero.Item).firstCreator || ""),
  );
  const year = normalizeText(
    String(
      item.getField("year") || item.getField("date") || item.getField("issued") || "",
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
