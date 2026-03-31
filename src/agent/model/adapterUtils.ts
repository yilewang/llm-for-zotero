/**
 * Shared utilities for model adapters.
 *
 * Extracts duplicated logic from anthropicMessages.ts, geminiNative.ts,
 * and openaiCompatible.ts into reusable functions.
 */

import type { AgentModelMessage } from "../types";
import { parseDataUrl, readFileRefAsBase64 } from "./shared";

// ── Resolved content parts ──────────────────────────────────────────────────

export type ResolvedTextPart = { type: "text"; text: string };
export type ResolvedImagePart = { type: "image"; mimeType: string; base64: string };
export type ResolvedPdfPart = { type: "pdf"; base64: string; filename?: string };
export type ResolvedFilePlaceholder = { type: "file_placeholder"; name: string };

export type ResolvedContentPart =
  | ResolvedTextPart
  | ResolvedImagePart
  | ResolvedPdfPart
  | ResolvedFilePlaceholder;

/**
 * Resolves an AgentModelMessage's content into normalized parts.
 * Reads file_ref data from disk and parses data URLs — shared across all adapters.
 *
 * Each adapter then maps these resolved parts to its provider-specific format.
 */
export async function resolveContentParts(
  message: AgentModelMessage,
): Promise<ResolvedContentPart[]> {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  const parts: ResolvedContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        parts.push({ type: "image", mimeType: parsed.mimeType, base64: parsed.data });
      } else {
        parts.push({ type: "text", text: "[image]" });
      }
      continue;
    }
    // file_ref
    if (part.file_ref.mimeType === "application/pdf") {
      const base64 = await readFileRefAsBase64(part.file_ref.storedPath);
      parts.push({ type: "pdf", base64, filename: part.file_ref.name });
    } else {
      parts.push({ type: "file_placeholder", name: part.file_ref.name });
    }
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

// ── Message partitioning ────────────────────────────────────────────────────

/**
 * Separates system messages from conversation messages.
 * System messages are extracted as text strings; conversation messages
 * retain their original structure.
 */
export function partitionMessages(messages: AgentModelMessage[]): {
  systemTexts: string[];
  conversationMessages: AgentModelMessage[];
} {
  const systemTexts: string[] = [];
  const conversationMessages: AgentModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text.trim()) systemTexts.push(text);
    } else {
      conversationMessages.push(message);
    }
  }
  return { systemTexts, conversationMessages };
}
