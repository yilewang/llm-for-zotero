/**
 * The files a user attached to a turn, as prompt text for a model that
 * reads them inline: a list of the files, then the text of those that have
 * text. A PDF sent to the model as a file (a `pdf-paper-` or `pdf-page-`
 * attachment) is left out.
 *
 * Used by the plain chat prompt (textUtils.ts) and the Codex turn
 * (codexAppServer/nativeClient.ts), which both send attached files inline.
 */

export type PromptAttachedFile = {
  id?: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  textContent?: string;
};

/** The blocks that follow the user's words; none when nothing applies. */
export function renderAttachedFilesPromptBlocks(
  fileAttachments: readonly PromptAttachedFile[],
): string[] {
  const textBlocks: string[] = [];
  const metaBlocks: string[] = [];
  for (const attachment of fileAttachments) {
    // PDF-paper attachments are sent as binary file_ref — skip text metadata
    if (
      typeof attachment.id === "string" &&
      (attachment.id.startsWith("pdf-paper-") ||
        attachment.id.startsWith("pdf-page-"))
    )
      continue;
    metaBlocks.push(
      `- ${attachment.name} (${attachment.mimeType || "application/octet-stream"}, ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
    );
    if (attachment.textContent) {
      const clipped = attachment.textContent.slice(0, 12000);
      textBlocks.push(`### ${attachment.name}\n${clipped}`);
    }
  }
  const blocks: string[] = [];
  if (metaBlocks.length) {
    blocks.push(`\nAttached files:\n${metaBlocks.join("\n")}`);
  }
  if (textBlocks.length) {
    blocks.push(`\nAttached file contents:\n${textBlocks.join("\n\n")}`);
  }
  return blocks;
}
