import type { ChatAttachment, ChatAttachmentCategory } from "./types";

const BLOCKED_CATEGORIES = new Set<ChatAttachmentCategory>(["pdf", "file"]);

function isGeneratedPdfPaperAttachment(attachment: ChatAttachment): boolean {
  return (
    typeof attachment.id === "string" &&
    /^pdf-(?:paper|page)-\d+-/.test(attachment.id)
  );
}

function normalizeRelevantAttachments(
  attachments?: ChatAttachment[],
): ChatAttachment[] {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments.filter(
    (attachment): attachment is ChatAttachment =>
      Boolean(attachment) &&
      typeof attachment === "object" &&
      attachment.category !== "image" &&
      !isGeneratedPdfPaperAttachment(attachment) &&
      typeof attachment.name === "string" &&
      attachment.name.trim().length > 0,
  );
}

export function shouldApplyCodexAppServerNativeAttachmentPolicy(params: {
  authMode?: string;
}): boolean {
  return params.authMode === "codex_app_server";
}

export function getBlockedCodexAppServerNativeAttachments(
  attachments?: ChatAttachment[],
): ChatAttachment[] {
  return normalizeRelevantAttachments(attachments).filter((attachment) =>
    BLOCKED_CATEGORIES.has(attachment.category),
  );
}

export function buildCodexAppServerNativeAttachmentBlockMessage(
  attachments?: ChatAttachment[],
): string {
  const blocked = getBlockedCodexAppServerNativeAttachments(attachments);
  if (!blocked.length) {
    return "Codex native app-server does not support pinned PDF or binary file attachments directly.";
  }
  const names = blocked.map((attachment) => attachment.name.trim()).slice(0, 2);
  const suffix = blocked.length > names.length ? ", ..." : "";
  return `Codex native app-server does not support pinned PDF or binary file attachments directly (${names.join(", ")}${suffix}). Remove them and try again.`;
}
