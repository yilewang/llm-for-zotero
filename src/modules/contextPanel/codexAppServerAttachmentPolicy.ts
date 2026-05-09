import type {
  ChatAttachment,
  ChatAttachmentCategory,
  ChatRuntimeMode,
} from "./types";

const BLOCKED_CATEGORIES = new Set<ChatAttachmentCategory>(["pdf", "file"]);

function normalizeRelevantAttachments(
  attachments?: ChatAttachment[],
): ChatAttachment[] {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments.filter(
    (attachment): attachment is ChatAttachment =>
      Boolean(attachment) &&
      typeof attachment === "object" &&
      attachment.category !== "image" &&
      typeof attachment.name === "string" &&
      attachment.name.trim().length > 0,
  );
}

export function shouldApplyCodexAppServerChatAttachmentPolicy(params: {
  authMode?: string;
  runtimeMode?: ChatRuntimeMode;
}): boolean {
  return (
    params.authMode === "codex_app_server" && params.runtimeMode === "chat"
  );
}

export function getBlockedCodexAppServerChatAttachments(
  attachments?: ChatAttachment[],
): ChatAttachment[] {
  return normalizeRelevantAttachments(attachments).filter((attachment) =>
    BLOCKED_CATEGORIES.has(attachment.category),
  );
}

export function buildCodexAppServerAttachmentBlockMessage(
  attachments?: ChatAttachment[],
): string {
  const blocked = getBlockedCodexAppServerChatAttachments(attachments);
  if (!blocked.length) {
    return "Codex App Server chat does not support pinned PDF or binary file attachments.";
  }
  const names = blocked.map((attachment) => attachment.name.trim()).slice(0, 2);
  const suffix =
    blocked.length > names.length ? ", ..." : "";
  return `Codex App Server chat does not support pinned PDF or binary file attachments (${names.join(", ")}${suffix}). Remove them and try again.`;
}
