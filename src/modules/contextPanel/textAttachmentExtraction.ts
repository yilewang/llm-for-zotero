import { unzipSync } from "fflate";

import type { PaperContentSourceMode } from "./types";

export type TextAttachmentSourceMode = Extract<
  PaperContentSourceMode,
  "markdown" | "html" | "txt" | "docx"
>;

function normalizeMetadataText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveTextAttachmentSourceModeFromMetadata(input: {
  contentType?: unknown;
  filename?: unknown;
}): TextAttachmentSourceMode | null {
  const contentType = normalizeMetadataText(input.contentType);
  const filename = normalizeMetadataText(input.filename);
  if (
    contentType === "text/markdown" ||
    contentType === "text/x-markdown" ||
    /\.(md|markdown)$/i.test(filename)
  ) {
    return "markdown";
  }
  if (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    /\.html?$/i.test(filename)
  ) {
    return "html";
  }
  if (contentType === "text/plain" || /\.txt$/i.test(filename)) {
    return "txt";
  }
  if (
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(filename)
  ) {
    return "docx";
  }
  return null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return Array.from(bytes)
      .map((byte) => String.fromCharCode(byte))
      .join("");
  }
}

export function decodeXmlEntities(text: string): string {
  let result = text;
  for (const [entity, value] of Object.entries(HTML_ENTITY_MAP)) {
    result = result.split(entity).join(value);
  }
  result = result.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code)),
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return result;
}

export function stripHtmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

export function extractDocxPlainText(bytes: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return "";
  }
  const documentXml = entries["word/document.xml"];
  if (!documentXml) return "";
  const xml = decodeUtf8(documentXml);
  const paragraphMatches = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  const paragraphs: string[] = [];
  const textNodePattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

  for (const paragraphXml of paragraphMatches) {
    const normalizedParagraph = paragraphXml
      .replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>")
      .replace(/<w:br\b[^>]*\/>/g, "<w:t>\n</w:t>");
    const pieces: string[] = [];
    let match: RegExpExecArray | null;
    const nodePattern = new RegExp(
      textNodePattern.source,
      textNodePattern.flags,
    );
    while ((match = nodePattern.exec(normalizedParagraph)) !== null) {
      pieces.push(decodeXmlEntities(match[1]));
    }
    const paragraph = pieces
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    if (paragraph) paragraphs.push(paragraph);
  }

  if (paragraphs.length) return paragraphs.join("\n");

  const pieces: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = textNodePattern.exec(xml)) !== null) {
    pieces.push(decodeXmlEntities(match[1]));
  }
  return pieces.join("").trim();
}

export function extractTextAttachmentContent(
  bytes: Uint8Array,
  sourceMode: TextAttachmentSourceMode,
): string {
  if (sourceMode === "docx") return extractDocxPlainText(bytes);
  const text = decodeUtf8(bytes);
  if (sourceMode === "html") return stripHtmlToText(text);
  return text.trim();
}
