import { normalizePaperContextRefs } from "../../normalizers";
import { sanitizeText } from "../../textUtils";
import { resolvePaperContextDisplayMetadata as resolvePaperContextDisplayMetadataShared } from "../../paperAttribution";
import type { PaperContextRef } from "../../types";

export function normalizePaperContextEntries(value: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(value, { sanitizeText });
}

export function resolvePaperContextDisplayMetadata(paperContext: PaperContextRef): {
  firstCreator?: string;
  year?: string;
} {
  return resolvePaperContextDisplayMetadataShared(paperContext);
}

function extractPaperYear(paperContext: PaperContextRef): string | null {
  return resolvePaperContextDisplayMetadata(paperContext).year || null;
}

function resolvePaperContextAttachmentItem(
  paperContext: PaperContextRef,
): Zotero.Item | null {
  const attachment = Zotero.Items.get(paperContext.contextItemId) || null;
  if (!attachment?.isAttachment?.()) return null;
  return attachment;
}

function resolvePaperContextParentItem(
  paperContext: PaperContextRef,
): Zotero.Item | null {
  const item = Zotero.Items.get(paperContext.itemId) || null;
  if (item?.isRegularItem?.()) return item;
  const contextAttachment = resolvePaperContextAttachmentItem(paperContext);
  if (contextAttachment?.parentID) {
    const parent = Zotero.Items.get(contextAttachment.parentID) || null;
    if (parent?.isRegularItem?.()) return parent;
  }
  return null;
}

function resolveMultiPdfAttachmentTitle(paperContext: PaperContextRef): string {
  const parentItem = resolvePaperContextParentItem(paperContext);
  if (!parentItem) return "";
  const attachmentIds = parentItem.getAttachments?.() || [];
  let pdfCount = 0;
  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId);
    if (
      attachment?.isAttachment?.() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      pdfCount += 1;
    }
  }
  if (pdfCount <= 1) return "";
  const contextAttachment = resolvePaperContextAttachmentItem(paperContext);
  if (!contextAttachment) return "";
  return sanitizeText(String(contextAttachment.getField("title") || ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function formatPaperContextChipLabel(paperContext: PaperContextRef): string {
  const metadata = resolvePaperContextDisplayMetadata(paperContext);
  const creator = sanitizeText(metadata.firstCreator || "").trim();
  const year = extractPaperYear(paperContext);
  const label = creator
    ? (year ? `${creator}, ${year}` : creator)
    : "Paper";
  const base = `📚 ${label}`;
  const attachmentTitle = resolveMultiPdfAttachmentTitle(paperContext);
  return attachmentTitle ? `${base} - ${attachmentTitle}` : base;
}

export function formatPaperContextChipTitle(paperContext: PaperContextRef): string {
  const metadata = resolvePaperContextDisplayMetadata(paperContext);
  const meta = [metadata.firstCreator || "", metadata.year || ""]
    .filter(Boolean)
    .join(" · ");
  const attachmentTitle = resolveMultiPdfAttachmentTitle(paperContext);
  return [
    paperContext.title,
    meta,
    attachmentTitle ? `Attachment: ${attachmentTitle}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
