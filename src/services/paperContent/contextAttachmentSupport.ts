import { resolveTextAttachmentSourceModeFromMetadata } from "./textAttachmentExtraction";
import type { ContextAttachmentSupport } from "./contextAttachmentTypes";
import { lowerTrimmedString } from "../../core/values";

function getAttachmentFilename(item: Zotero.Item | null | undefined): string {
  if (!item?.isAttachment?.()) return "";
  return lowerTrimmedString(
    (item as unknown as { attachmentFilename?: unknown }).attachmentFilename,
  );
}

function getAttachmentContentType(
  item: Zotero.Item | null | undefined,
): string {
  if (!item?.isAttachment?.()) return "";
  return lowerTrimmedString(
    (item as unknown as { attachmentContentType?: unknown })
      .attachmentContentType,
  );
}

export function resolveContextAttachmentSupportFromMetadata(input: {
  contentType?: unknown;
  filename?: unknown;
}): ContextAttachmentSupport | null {
  const contentType = lowerTrimmedString(input.contentType);
  const filename = lowerTrimmedString(input.filename);
  if (contentType === "application/pdf" || filename.endsWith(".pdf")) {
    return {
      kind: "pdf",
      attachmentType: "pdf",
      readableVia: "paper_read",
    };
  }

  const textMode = resolveTextAttachmentSourceModeFromMetadata({
    contentType,
    filename,
  });
  if (!textMode) return null;
  return {
    kind: "text",
    attachmentType: textMode,
    contentSourceMode: textMode,
    readableVia: "read_attachment",
  };
}

export function resolveContextAttachmentSupport(
  item: Zotero.Item | null | undefined,
): ContextAttachmentSupport | null {
  if (!item?.isAttachment?.()) return null;
  return resolveContextAttachmentSupportFromMetadata({
    contentType: getAttachmentContentType(item),
    filename: getAttachmentFilename(item),
  });
}

export function isSupportedContextAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  return Boolean(resolveContextAttachmentSupport(item));
}

export function isPdfContextAttachment(
  item: Zotero.Item | null | undefined,
): boolean {
  return resolveContextAttachmentSupport(item)?.kind === "pdf";
}
