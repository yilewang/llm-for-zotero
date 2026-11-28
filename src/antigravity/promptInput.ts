/**
 * What an Antigravity turn sends agy: the prompt's content blocks, and the
 * files the user attached, which agy may read without a review card.
 *
 * Observed on agy 1.5.10 (2026-11-18):
 * - an `image` block is seen by the model;
 * - for a `resource_link` (or an embedded `resource` with a `file://`
 *   address) agy reads the file with its own read tool, which asks for
 *   permission; once allowed, the model sees the file.
 *
 * So images go inline, other files go as links to their saved copies, and
 * the permission handler allows reads of exactly those files.
 */

import type { AcpContentBlock } from "../shared/acpProtocol";
import type { AgentRuntimeRequest } from "../agent/types";
import { buildExternalRuntimeUserText } from "../agent/externalBackendBridge";
import { requestLocalDocuments } from "../agent/externalRuntimeTurnHost";
import { isSlashCommandText } from "../services/pastConversations/pastConversationText";
import { parseDataUrl } from "../shared/dataUrl";
import { readFileBytes } from "../utils/geckoFs";
import { fileUrlToPath } from "../utils/localPath";

export type AntigravityPromptInput = {
  blocks: AcpContentBlock[];
  /** Files the user attached this turn; agy may read these. */
  attachedPaths: string[];
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary);
}

function mimeTypeOfImagePath(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function imageBlockFromFile(
  path: string,
  mimeType: string,
): Promise<AcpContentBlock | null> {
  const bytes = await readFileBytes(path);
  if (!bytes?.length) return null;
  return { type: "image", mimeType, data: encodeBase64(bytes) };
}

/** An image block for a screenshot (a data URL or a file URL). */
async function imageBlockFromUrl(url: string): Promise<AcpContentBlock | null> {
  const parsed = parseDataUrl(url);
  if (parsed) {
    if (!/^image\//i.test(parsed.mimeType)) return null;
    return {
      type: "image",
      mimeType: parsed.mimeType,
      data: parsed.data.replace(/\s+/g, ""),
    };
  }
  const path = fileUrlToPath(url);
  return path ? imageBlockFromFile(path, mimeTypeOfImagePath(path)) : null;
}

function fileUri(path: string): string {
  return `file://${path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

/**
 * The turn's content blocks. A slash message goes alone, so agy reads it as
 * a command; otherwise the prompt's turn blocks (renderExternalRuntimePrompt:
 * the turn context, the material the user attached, the instructions that
 * can change between turns) come before the user's text.
 */
export async function buildAntigravityPromptInput(
  request: AgentRuntimeRequest,
  turnContext: string,
): Promise<AntigravityPromptInput> {
  if (isSlashCommandText(request.userText)) {
    return {
      blocks: [
        { type: "text", text: await buildExternalRuntimeUserText(request) },
      ],
      attachedPaths: [],
    };
  }
  const userText = await buildExternalRuntimeUserText(request);
  const blocks: AcpContentBlock[] = [
    {
      type: "text",
      text: [turnContext, userText].filter(Boolean).join("\n\n"),
    },
  ];
  const attachedPaths: string[] = [];

  for (const screenshot of request.screenshots || []) {
    if (typeof screenshot !== "string" || !screenshot.trim()) continue;
    const block = await imageBlockFromUrl(screenshot);
    if (block) blocks.push(block);
  }
  for (const attachment of request.attachments || []) {
    if (!attachment) continue;
    const storedPath = attachment.storedPath?.trim();
    if (attachment.category === "image") {
      const block = attachment.imageDataUrl
        ? await imageBlockFromUrl(attachment.imageDataUrl)
        : storedPath
          ? await imageBlockFromFile(storedPath, attachment.mimeType)
          : null;
      if (block) blocks.push(block);
      continue;
    }
    if (storedPath) {
      blocks.push({
        type: "resource_link",
        uri: fileUri(storedPath),
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      attachedPaths.push(storedPath);
    } else if (attachment.textContent) {
      // Text with no saved copy goes inline under a non-file address, which
      // agy reads as given instead of opening a file.
      blocks.push({
        type: "resource",
        resource: {
          uri: `zotero-attachment:${encodeURIComponent(attachment.id)}`,
          mimeType: attachment.mimeType || "text/plain",
          text: attachment.textContent,
        },
      });
    }
  }
  for (const document of requestLocalDocuments(request)) {
    attachedPaths.push(document.absolutePath);
  }
  return { blocks, attachedPaths };
}
