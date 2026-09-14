type AttachmentFilenameMetadata = {
  attachmentFilename?: unknown;
  attachmentPath?: unknown;
};

/**
 * Read filename metadata without requiring a path valid on the current OS.
 * Zotero's getter can throw for linked paths synced from another platform.
 * The fallback is only a display/classification name, not proof that a file
 * exists or can be opened; callers must still verify the actual file path.
 */
export function readAttachmentFilename(item: unknown): string {
  const attachment = item as AttachmentFilenameMetadata | null | undefined;
  try {
    const filename = attachment?.attachmentFilename;
    if (typeof filename === "string" && filename) return filename;
  } catch {
    // Legacy Windows or relative paths can throw NS_ERROR_FILE_UNRECOGNIZED_PATH.
  }

  try {
    const path = attachment?.attachmentPath;
    if (typeof path !== "string") return "";
    return (
      path
        .replace(/^(?:storage|attachments):/, "")
        .split(/[\\/]/)
        .pop() || ""
    );
  } catch {
    return "";
  }
}
