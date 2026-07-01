import { readAttachmentBytes } from "../../modules/contextPanel/attachmentStorage";
import { extractTextAttachmentContent } from "../../modules/contextPanel/textAttachmentExtraction";
import type { TextAttachmentSourceMode } from "../../modules/contextPanel/contextAttachmentTypes";
import { resolveContextAttachmentSupportFromMetadata } from "../../modules/contextPanel/contextAttachmentSupport";
import {
  formatAttachmentSourceType,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import type { ZoteroGateway } from "./zoteroGateway";

export type AttachmentContentCategory = "text" | "image" | "pdf" | "binary";

export type AttachmentReadResult = {
  attachmentId: number;
  title: string;
  contentType: string;
  category: AttachmentContentCategory;
  filePath?: string;
  textContent?: string;
  imageDataUrl?: string;
  wordCount?: number;
  sourceMode?: TextAttachmentSourceMode;
  sourceType?: string;
  sourceLabel?: string;
  citationLabel?: string;
  parentItem?: {
    itemId: number;
    title: string;
    firstCreator?: string;
    year?: string;
  };
  attachmentTitle?: string;
  relationship?: string;
  readingGuidance?: string[];
  paperContext?: PaperContextRef;
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
  if (IMAGE_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix)))
    return "image";
  if (TEXT_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix))) return "text";
  if (TEXT_MIME_EXACT.has(ct)) return "text";
  return "binary";
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  private buildPaperContextForAttachment(
    info: NonNullable<ReturnType<ZoteroGateway["getAttachmentInfo"]>>,
    sourceMode: TextAttachmentSourceMode,
  ): PaperContextRef | null {
    if (!info.parentItemId) return null;
    const parentItem = this.zoteroGateway.getItem(info.parentItemId);
    if (!parentItem?.isRegularItem?.()) return null;
    const title =
      normalizeText(parentItem.getField?.("title")) ||
      normalizeText(parentItem.getDisplayTitle?.()) ||
      `Item ${parentItem.id}`;
    const firstCreator =
      normalizeText(parentItem.getField?.("firstCreator")) ||
      normalizeText((parentItem as Zotero.Item).firstCreator) ||
      undefined;
    const year =
      normalizeText(parentItem.getField?.("year")) ||
      normalizeText(parentItem.getField?.("date")) ||
      normalizeText(parentItem.getField?.("issued")) ||
      undefined;
    return {
      itemId: parentItem.id,
      contextItemId: info.attachmentId,
      title,
      attachmentTitle: info.filename || info.title || undefined,
      citationKey:
        normalizeText(parentItem.getField?.("citationKey")) || undefined,
      firstCreator,
      year,
      contentSourceMode: sourceMode,
    };
  }

  private buildAttachmentAttribution(
    info: NonNullable<ReturnType<ZoteroGateway["getAttachmentInfo"]>>,
    sourceMode: TextAttachmentSourceMode | null,
  ): Partial<AttachmentReadResult> {
    if (!sourceMode) return {};
    const paperContext = this.buildPaperContextForAttachment(info, sourceMode);
    if (!paperContext)
      return { sourceMode, sourceType: formatAttachmentSourceType(sourceMode) };
    return {
      sourceMode,
      sourceType: formatAttachmentSourceType(sourceMode),
      sourceLabel: formatPaperSourceLabel(paperContext),
      citationLabel: formatPaperCitationLabel(paperContext),
      parentItem: {
        itemId: paperContext.itemId,
        title: paperContext.title,
        firstCreator: paperContext.firstCreator,
        year: paperContext.year,
      },
      attachmentTitle: paperContext.attachmentTitle || info.title,
      relationship:
        "Child attachment under the parent item; it may be user OCR, a translated file, supplement, notes, or another related file.",
      readingGuidance: [
        "Answer primarily from this selected attachment content.",
        "Use parent metadata only for bibliographic or contextual grounding.",
        "If quoting, use `>` blockquotes only for direct original attachment text copied verbatim in its source language.",
        "Put translation, interpretation, emphasis, examples, or opinion in normal prose or fenced `text` blocks, not in `>` blockquotes.",
        "Do not infer attachment loading failed just because the attachment text differs from the parent title.",
      ],
      paperContext,
    };
  }

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

    const attachmentSupport = resolveContextAttachmentSupportFromMetadata({
      contentType: info.contentType,
      filename: info.filename || info.title,
    });
    const sourceMode =
      attachmentSupport?.kind === "text"
        ? attachmentSupport.contentSourceMode
        : null;
    const category =
      attachmentSupport?.kind === "pdf"
        ? "pdf"
        : sourceMode
          ? "text"
          : categorizeContentType(info.contentType);
    const attribution = this.buildAttachmentAttribution(info, sourceMode);
    const baseResult = {
      attachmentId: info.attachmentId,
      title: info.title,
      contentType: info.contentType,
      category,
      ...attribution,
    };

    if (category === "pdf") {
      return {
        ...baseResult,
        note: "Use read_paper, search_paper, or view_pdf_pages to read PDF content.",
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
    const filePath: string | undefined =
      (attachmentItem as any)?.getFilePath?.() || undefined;
    if (!filePath) {
      return {
        ...baseResult,
        note: "Could not resolve file path for this attachment.",
      };
    }

    // Include filePath in all results from here on so the agent can use
    // run_command as a fallback for unsupported content types.
    const baseWithPath = { ...baseResult, filePath };

    try {
      const bytes = await readAttachmentBytes(filePath);

      if (category === "image") {
        const base64 = encodeBase64(bytes);
        return {
          ...baseWithPath,
          imageDataUrl: `data:${info.contentType};base64,${base64}`,
        };
      }

      const rawText = sourceMode
        ? extractTextAttachmentContent(bytes, sourceMode)
        : decodeUtf8(bytes);
      const isHtml =
        !sourceMode &&
        (info.contentType.includes("html") ||
          rawText.trimStart().startsWith("<!DOCTYPE") ||
          rawText.trimStart().startsWith("<html"));
      const text = isHtml ? stripHtml(rawText) : rawText;
      const maxChars =
        Number.isFinite(params.maxChars) && (params.maxChars as number) > 0
          ? Math.floor(params.maxChars as number)
          : 50000;
      const truncated =
        text.length > maxChars ? `${text.slice(0, maxChars)}\u2026` : text;
      return {
        ...baseWithPath,
        textContent: truncated,
        wordCount: truncated.split(/\s+/).filter(Boolean).length,
        ...(sourceMode === "docx" && !truncated.trim()
          ? {
              note: "No plain text could be extracted from this DOCX attachment.",
            }
          : {}),
      };
    } catch (error) {
      return {
        ...baseWithPath,
        category: "binary",
        note: `Could not read file content: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
