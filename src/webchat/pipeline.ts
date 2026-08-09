/**
 * [webchat] Dedicated send pipeline for WebChat providers.
 *
 * Unlike the normal LLM pipeline, this:
 *   - Attaches the exact selected PDF when `sendPdf` is true (controlled by chip state)
 *   - Sends only the raw question text (no system messages, no history)
 *   - Submits via the embedded Zotero relay → Chrome extension → ChatGPT.com
 */

import { readLocalFileBytes } from "../utils/llmClient";
import { isAbsoluteLocalPath } from "../utils/localPath";
import type { PaperContextRef } from "../modules/contextPanel/types";
import {
  getZoteroAttachmentFilename,
  isZoteroPdfAttachmentCandidate,
} from "../modules/contextPanel/setupHandlers/controllers/pdfAttachmentPolicy";
import {
  submitQuery,
  pollForResponse,
  waitForRemoteReadyIfNavigating,
  bytesToBase64,
  type WebChatAnswerSnapshot,
  type WebChatPollResult,
  type WebChatThinkingSnapshot,
} from "./client";

// ---------------------------------------------------------------------------
// PDF resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the exact Zotero attachment identities selected by the user.
 *
 * Do not search parents or siblings here. A WebChat PDF request must either use
 * the selected attachment or fail before anything is submitted to the relay.
 */
export async function resolveSelectedWebChatPdfBatch(
  paperContexts: readonly PaperContextRef[],
): Promise<ReadonlyArray<{ path: string; filename: string }>> {
  if (!paperContexts.length) {
    throw new Error("No selected PDF attachment was provided for WebChat.");
  }

  const seen = new Set<string>();
  const resolved: Array<{ path: string; filename: string }> = [];

  for (const paperContext of paperContexts) {
    const itemId = paperContext?.itemId;
    const contextItemId = paperContext?.contextItemId;
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(contextItemId) ||
      contextItemId <= 0
    ) {
      throw new Error("The selected WebChat PDF identity is invalid.");
    }

    const sourceKey = `${itemId}:${contextItemId}`;
    if (seen.has(sourceKey)) {
      throw new Error("The selected WebChat PDF list contains a duplicate.");
    }
    seen.add(sourceKey);

    const attachment = Zotero.Items.get(contextItemId);
    if (!isZoteroPdfAttachmentCandidate(attachment)) {
      throw new Error("The selected WebChat PDF attachment is unavailable.");
    }
    if ((attachment as unknown as { deleted?: unknown }).deleted) {
      throw new Error("The selected WebChat PDF attachment is in the trash.");
    }

    const parentId = Number(attachment.parentID || 0);
    if (parentId) {
      const parent = Zotero.Items.get(itemId);
      if (parentId !== itemId || !parent?.isRegularItem?.()) {
        throw new Error(
          "The selected WebChat PDF attachment identity changed.",
        );
      }
      if ((parent as unknown as { deleted?: unknown }).deleted) {
        throw new Error("The selected WebChat PDF parent is in the trash.");
      }
    } else if (itemId !== contextItemId) {
      throw new Error("The selected WebChat PDF attachment identity changed.");
    }

    let path: string | null;
    try {
      path = await getFilePath(attachment);
    } catch {
      throw new Error("The selected WebChat PDF file is unavailable.");
    }
    if (!path || !isAbsoluteLocalPath(path)) {
      throw new Error("The selected WebChat PDF file is unavailable.");
    }
    resolved.push({
      path,
      filename:
        getZoteroAttachmentFilename(attachment) || extractFilename(path),
    });
  }

  return resolved;
}

async function getFilePath(att: Zotero.Item): Promise<string | null> {
  // Zotero 7+: getFilePathAsync
  const asyncPath = await (
    att as unknown as { getFilePathAsync?: () => Promise<string | false> }
  ).getFilePathAsync?.();
  if (asyncPath) return asyncPath as string;

  // Fallback: getFilePath (sync)
  if (
    typeof (att as unknown as { getFilePath?: () => string | undefined })
      .getFilePath === "function"
  ) {
    const syncPath = (
      att as unknown as { getFilePath: () => string | undefined }
    ).getFilePath();
    if (syncPath) return syncPath;
  }

  // Fallback: attachmentPath property
  const rawPath = (att as unknown as { attachmentPath?: string })
    .attachmentPath;
  return rawPath || null;
}

function extractFilename(path: string): string {
  return path.split(/[\\/]/).pop() || "document.pdf";
}

// ---------------------------------------------------------------------------
// Main send function
// ---------------------------------------------------------------------------

export type WebChatSendOptions = {
  item: Zotero.Item;
  question: string;
  host: string;
  /** When true, attach the paper PDF to the query. */
  sendPdf?: boolean;
  /** Exact PDF attachment identities selected in the composer, in UI order. */
  pdfPaperContexts?: readonly PaperContextRef[];
  /** When true, force the next query into a fresh conversation. */
  forceNewChat?: boolean;
  /** Screenshot images as base64 data URLs to attach. */
  images?: string[];
  /** ChatGPT mode: "instant", "thinking_standard", or "thinking_extended". */
  chatgptMode?: string;
  /** Which webchat target to use: "chatgpt" | "deepseek" | "gemini". */
  target?: string;
  signal?: AbortSignal;
  onAnswerSnapshot: (text: string, snapshot: WebChatAnswerSnapshot) => void;
  onThinkingSnapshot?: (
    text: string,
    snapshot: WebChatThinkingSnapshot,
  ) => void;
};

/**
 * Send a question to ChatGPT via the embedded Zotero relay.
 * Attaches the exact selected paper PDF only when `sendPdf` is true.
 * The caller determines whether to send PDF based on the paper chip state.
 *
 * Returns the final response text.
 */
export async function sendWebChatQuestion(
  opts: WebChatSendOptions,
): Promise<WebChatPollResult> {
  const {
    question,
    host,
    sendPdf,
    pdfPaperContexts,
    forceNewChat,
    images,
    chatgptMode,
    target,
    signal,
    onAnswerSnapshot,
    onThinkingSnapshot,
  } = opts;

  ztoolkit.log(`[webchat] sendWebChatQuestion: sendPdf=${sendPdf}`);

  // --- Resolve and read the current paper's PDF (only when explicitly requested) ---
  let pdfBase64: string | null = null;
  let pdfFilename: string | null = null;

  if (sendPdf) {
    const pdfs = await resolveSelectedWebChatPdfBatch(pdfPaperContexts || []);
    if (pdfs.length !== 1) {
      throw new Error(
        "WebChat supports exactly one selected PDF attachment per send.",
      );
    }
    const pdf = pdfs[0]!;
    let bytes: Uint8Array;
    try {
      bytes = await readLocalFileBytes(pdf.path);
    } catch {
      throw new Error("The selected WebChat PDF file could not be read.");
    }
    if (!bytes.byteLength) {
      throw new Error("The selected WebChat PDF file is empty.");
    }
    if (
      bytes.byteLength < 5 ||
      String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-"
    ) {
      throw new Error("The selected WebChat file is not a valid PDF.");
    }
    pdfBase64 = bytesToBase64(bytes);
    pdfFilename = pdf.filename;
  }

  // If the extension is still navigating to a loaded history item or a fresh
  // chat, wait for the remote composer/transcript to settle before submitting.
  await waitForRemoteReadyIfNavigating(host, signal);

  // --- Submit to the embedded relay ---
  const { seq } = await submitQuery(
    host,
    question,
    pdfBase64,
    pdfFilename,
    signal,
    images,
    chatgptMode,
    forceNewChat,
    target,
  );

  // --- Poll for streaming response ---
  return pollForResponse(
    host,
    seq,
    onAnswerSnapshot,
    onThinkingSnapshot,
    signal,
  );
}
