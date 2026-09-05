import type { GeneratedChatImage } from "../../shared/types";
import { normalizeGeneratedChatImages } from "../../shared/generatedImages";
import { fileUrlToPath } from "../../utils/localPath";
import { escapeNoteHtml } from "./textUtils";
import {
  isEmbeddableGeneratedImage,
  resolveGeneratedImageAsset,
} from "./generatedImageAssets";

export type NoteImageImportInput = {
  noteItemId: number;
  imagePath?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  saveOptions?: {
    notifierQueue?: unknown;
  };
};

export type NoteImageImporter = {
  importNoteImage: (
    params: NoteImageImportInput,
  ) => Promise<{ key: string } | null>;
};

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function inferMimeType(path: string | undefined, fallback: string): string {
  const lower = (path || "").trim().toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  return fallback || "image/png";
}

async function readImageBytes(path: string): Promise<Uint8Array | null> {
  const IOUtils = (globalThis as any).IOUtils;
  try {
    if (IOUtils?.read) {
      const result = await IOUtils.read(path);
      if (result instanceof Uint8Array) return result;
      if (result instanceof ArrayBuffer) return new Uint8Array(result);
      if (ArrayBuffer.isView(result)) {
        const view = result as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
    }
  } catch (_err) {
    void _err;
  }

  const OSFile = (globalThis as any).OS?.File;
  try {
    if (OSFile?.read) {
      const result = await OSFile.read(path);
      if (result instanceof Uint8Array) return result;
      if (result instanceof ArrayBuffer) return new Uint8Array(result);
      if (ArrayBuffer.isView(result)) {
        const view = result as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
    }
  } catch (_err) {
    void _err;
  }
  return null;
}

export async function importNoteImageAsset(
  params: NoteImageImportInput,
): Promise<{ key: string } | null> {
  try {
    const bytes =
      params.bytes ||
      (params.imagePath ? await readImageBytes(params.imagePath) : null);
    if (!bytes) return null;

    const mimeType =
      params.mimeType || inferMimeType(params.imagePath, "image/png");
    const blob = new Blob([bytesToArrayBuffer(bytes)], { type: mimeType });
    const Attachments = (Zotero as any).Attachments;
    if (!Attachments?.importEmbeddedImage) return null;
    const attachment = await Attachments.importEmbeddedImage({
      blob,
      parentItemID: params.noteItemId,
      saveOptions: params.saveOptions,
    });
    return attachment?.key ? { key: String(attachment.key) } : null;
  } catch (error) {
    Zotero.debug?.(
      `[llm-for-zotero] importNoteImageAsset failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function importLocalImagesIntoNote(
  content: string,
  noteItemId: number,
  importer: NoteImageImporter,
  saveOptions?: NoteImageImportInput["saveOptions"],
): Promise<string> {
  const markdownPattern = /!\[([^\]]*)\]\((file:\/\/\/?[^)]+)\)/g;
  const htmlPattern = /<img\s+[^>]*src\s*=\s*"(file:\/\/\/?[^"]+)"[^>]*\/?>/gi;
  let result = content;

  const mdMatches = [...content.matchAll(markdownPattern)];
  for (const match of mdMatches) {
    const fullMatch = match[0];
    const alt = match[1];
    const imagePath = fileUrlToPath(match[2]);
    if (!imagePath) continue;
    try {
      const imported = await importer.importNoteImage({
        imagePath,
        noteItemId,
        saveOptions,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(alt)}" />`,
        );
      }
    } catch (_err) {
      void _err;
    }
  }

  const htmlMatches = [...result.matchAll(htmlPattern)];
  for (const match of htmlMatches) {
    const fullMatch = match[0];
    const imagePath = fileUrlToPath(match[1]);
    if (!imagePath) continue;
    const altMatch = fullMatch.match(/alt\s*=\s*"([^"]*)"/i);
    const alt = altMatch?.[1] || "";
    try {
      const imported = await importer.importNoteImage({
        imagePath,
        noteItemId,
        saveOptions,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(alt)}" />`,
        );
      }
    } catch (_err) {
      void _err;
    }
  }

  return result;
}

export function normalizeEmbeddableGeneratedImages(
  images: unknown,
): GeneratedChatImage[] {
  return normalizeGeneratedChatImages(images).filter(
    isEmbeddableGeneratedImage,
  );
}

export function formatGeneratedImagesEmbeddedLabel(count: number): string {
  return count === 1
    ? "Generated image embedded"
    : `Generated images embedded (${count})`;
}

export function formatGeneratedImagesMarkdownForNote(
  images: GeneratedChatImage[],
): string {
  const normalized = normalizeGeneratedChatImages(images);
  if (!normalized.length) return "";
  return formatGeneratedImagesEmbeddedLabel(normalized.length);
}

export async function buildGeneratedImagesHtmlForNote(
  images: unknown,
  noteItemId: number,
  importer: NoteImageImporter = { importNoteImage: importNoteImageAsset },
  saveOptions?: NoteImageImportInput["saveOptions"],
): Promise<string> {
  const normalized = normalizeEmbeddableGeneratedImages(images);
  if (!normalized.length) return "";

  const blocks: string[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const image = normalized[index]!;
    try {
      const asset = await resolveGeneratedImageAsset(image);
      if (!asset) continue;
      const imported = await importer.importNoteImage({
        noteItemId,
        imagePath: asset.path,
        bytes: asset.bytes,
        mimeType: asset.mimeType,
        saveOptions,
      });
      if (!imported?.key) continue;
      const alt = image.label || `Generated image ${index + 1}`;
      blocks.push(
        `<p><img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(alt)}" /></p>`,
      );
    } catch (error) {
      Zotero.debug?.(
        `[llm-for-zotero] Generated image note import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!blocks.length) return "";
  return `<div>${blocks.join("")}</div>`;
}
