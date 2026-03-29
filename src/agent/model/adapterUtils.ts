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
  // Kick off all file reads in parallel, then assemble results in order.
  const resolvers: Promise<ResolvedContentPart>[] = message.content.map(
    (part) => {
      if (part.type === "text") {
        return Promise.resolve({ type: "text" as const, text: part.text });
      }
      if (part.type === "image_url") {
        const parsed = parseDataUrl(part.image_url.url);
        return Promise.resolve(
          parsed
            ? { type: "image" as const, mimeType: parsed.mimeType, base64: parsed.data }
            : { type: "text" as const, text: "[image]" },
        );
      }
      // file_ref
      if (part.file_ref.mimeType === "application/pdf") {
        return readFileRefAsBase64(part.file_ref.storedPath).then(
          (base64) => ({ type: "pdf" as const, base64, filename: part.file_ref.name }),
        );
      }
      return Promise.resolve({
        type: "file_placeholder" as const,
        name: part.file_ref.name,
      });
    },
  );
  const parts = await Promise.all(resolvers);
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
