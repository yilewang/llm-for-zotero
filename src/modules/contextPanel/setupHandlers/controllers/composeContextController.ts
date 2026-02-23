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

function extractFirstAuthorLastName(paperContext: PaperContextRef): string {
  const metadata = resolvePaperContextDisplayMetadata(paperContext);
  let creator = sanitizeText(metadata.firstCreator || "").trim();
  if (!creator) return "Paper";
  creator = creator
    .replace(/\s+et\s+al\.?$/i, "")
    .replace(/\s+al\.?$/i, "")
    .replace(/[;,.]+$/g, "")
    .trim();
  if (!creator) return "Paper";
  const primaryAuthor =
    creator.split(/\s+(?:and|&)\s+/i).find((part) => part.trim()) || creator;
  const normalizedPrimary = primaryAuthor.replace(/[;,.]+$/g, "").trim();
  if (!normalizedPrimary) return "Paper";
  if (normalizedPrimary.includes(",")) {
    const commaSeparated = normalizedPrimary.split(",")[0]?.trim();
    if (commaSeparated) return commaSeparated;
  }
  const parts = normalizedPrimary.split(/\s+/g).filter(Boolean);
  if (!parts.length) return "Paper";
  if (parts.length === 1) return parts[0];
  const trailingToken = parts[parts.length - 1];
  if (/^[A-Z](?:\.[A-Z])?\.?$/i.test(trailingToken)) {
    return parts[parts.length - 2] || parts[0];
  }
  return trailingToken;
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
  const authorLastName = extractFirstAuthorLastName(paperContext);
  const year = extractPaperYear(paperContext);
  const base = year
    ? `📝 ${authorLastName} et al., ${year}`
    : `📝 ${authorLastName} et al.`;
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
