import { readAttachmentBytes } from "../../modules/contextPanel/attachmentStorage";
import type { ZoteroGateway } from "./zoteroGateway";

export type AttachmentContentCategory = "text" | "image" | "pdf" | "binary";

export type AttachmentReadResult = {
  attachmentId: number;
  title: string;
  contentType: string;
  category: AttachmentContentCategory;
  textContent?: string;
  imageDataUrl?: string;
  wordCount?: number;
  note?: string;
};

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
  "application/x-httpd-php",
]);
const IMAGE_MIME_PREFIXES = ["image/"];

function categorizeContentType(contentType: string): AttachmentContentCategory {
  const ct = contentType.toLowerCase().trim();
  if (ct === "application/pdf") return "pdf";
  if (IMAGE_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix))) return "image";
  if (TEXT_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix))) return "text";
  if (TEXT_MIME_EXACT.has(ct)) return "text";
  return "binary";
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_error) {
    void _error;
    return Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join("");
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class AttachmentReadService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  async readAttachmentContent(params: {
    attachmentId: number;
    maxChars?: number;
  }): Promise<AttachmentReadResult> {
    const info = this.zoteroGateway.getAttachmentInfo({
      attachmentId: params.attachmentId,
    });
    if (!info) {
      throw new Error(`Attachment ${params.attachmentId} not found`);
    }

    const category = categorizeContentType(info.contentType);
    const baseResult = {
      attachmentId: info.attachmentId,
      title: info.title,
      contentType: info.contentType,
      category,
    };

    if (category === "pdf") {
      return {
        ...baseResult,
        note: "Use inspect_pdf operations (front_matter, retrieve_evidence, render_pages, etc.) to read PDF content.",
      };
    }

    if (!info.hasFile) {
      return {
        ...baseResult,
        note: `File not available locally (linkMode: ${info.linkMode}). Sync the item to download it first.`,
      };
    }

    // Resolve file path
    const attachmentItem = this.zoteroGateway.getItem(params.attachmentId);
    const filePath: string | undefined = (attachmentItem as any)?.getFilePath?.() || undefined;
    if (!filePath) {
      return {
        ...baseResult,
        note: "Could not resolve file path for this attachment.",
      };
    }

    try {
      const bytes = await readAttachmentBytes(filePath);

      if (category === "image") {
        const base64 = encodeBase64(bytes);
        return {
          ...baseResult,
          imageDataUrl: `data:${info.contentType};base64,${base64}`,
        };
      }

      // text category
      const rawText = decodeUtf8(bytes);
      const isHtml =
        info.contentType.includes("html") ||
        rawText.trimStart().startsWith("<!DOCTYPE") ||
        rawText.trimStart().startsWith("<html");
      const text = isHtml ? stripHtml(rawText) : rawText;
      const maxChars =
        Number.isFinite(params.maxChars) && (params.maxChars as number) > 0
          ? Math.floor(params.maxChars as number)
          : 50000;
      const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\u2026` : text;
      return {
        ...baseResult,
        textContent: truncated,
        wordCount: truncated.split(/\s+/).filter(Boolean).length,
      };
    } catch (error) {
      return {
        ...baseResult,
        category: "binary",
        note: `Could not read file content: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
