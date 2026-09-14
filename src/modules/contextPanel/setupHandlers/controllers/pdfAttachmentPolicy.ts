import { readAttachmentFilename } from "../../../../utils/attachmentFilename";
export function getZoteroAttachmentFilename(item: unknown): string {
  const attachment = item as {
    attachmentFilename?: unknown;
    getFilename?: () => unknown;
    getField?: (field: string) => unknown;
  };
  const candidates = [
    () => readAttachmentFilename(attachment),
    () =>
      typeof attachment?.getFilename === "function"
        ? attachment.getFilename()
        : undefined,
    () =>
      typeof attachment?.getField === "function"
        ? attachment.getField("filename")
        : undefined,
  ];
  for (const read of candidates) {
    try {
      const filename = read();
      if (typeof filename === "string" && filename.trim())
        return filename.trim();
    } catch {
      // A legacy accessor can fail even when another metadata source is usable.
    }
  }
  return "";
}

/** Metadata prefilter only; every transport still verifies the %PDF signature. */
export function isZoteroPdfAttachmentCandidate(item: unknown): boolean {
  const attachment = item as {
    isAttachment?: () => boolean;
    attachmentContentType?: unknown;
  };
  if (!attachment?.isAttachment?.()) return false;
  const contentType = String(attachment.attachmentContentType || "")
    .trim()
    .toLowerCase();
  return (
    contentType === "application/pdf" ||
    getZoteroAttachmentFilename(attachment).toLowerCase().endsWith(".pdf")
  );
}
