import { buildSafeSvgMarkup } from "../../utils/markdown";
import { escapeNoteHtml } from "./textUtils";
import { importNoteImageAsset, type NoteImageImporter } from "./noteImages";

export type SvgRasterizer = (
  doc: Document,
  svgMarkup: string,
) => Promise<Uint8Array | null>;

export type MermaidSvgRenderer = (
  source: string,
  doc: Document,
  anchor?: HTMLElement,
) => Promise<string | null>;

export type NoteFigureRenderOptions = {
  doc?: Document | null;
  importer?: NoteImageImporter;
  omitUnconvertedVisualFences?: boolean;
  rasterizeSvgToPngBytes?: SvgRasterizer;
  renderMermaidSvg?: MermaidSvgRenderer;
};

const FIGURE_EXPORT_MAX_DIMENSION = 4096;
const FIGURE_EXPORT_MIN_DIMENSION = 1;
const FIGURE_EXPORT_MIN_LONG_EDGE = 1600;
const FIGURE_EXPORT_BASE_SCALE = 2;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function decodeBase64Bytes(base64: string): Uint8Array | null {
  try {
    const normalized = base64.replace(/\s+/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function pngDataUrlToBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return null;
  return decodeBase64Bytes(dataUrl.slice(PNG_DATA_URL_PREFIX.length));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function clampFigureDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return FIGURE_EXPORT_MIN_DIMENSION;
  return Math.max(
    FIGURE_EXPORT_MIN_DIMENSION,
    Math.min(FIGURE_EXPORT_MAX_DIMENSION, Math.ceil(value)),
  );
}

function parseSvgLength(value: string | null | undefined): number | null {
  const raw = (value || "").trim();
  if (!raw || /%$/.test(raw)) return null;
  const parsed = Number.parseFloat(raw.replace(/[a-z]+$/i, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSvgIntrinsicSize(svgMarkup: string): {
  width: number;
  height: number;
} {
  const openingTag = svgMarkup.match(/^<svg\b[^>]*>/i)?.[0] || "";
  const width = parseSvgLength(
    openingTag.match(/\bwidth\s*=\s*(["'])([\s\S]*?)\1/i)?.[2],
  );
  const height = parseSvgLength(
    openingTag.match(/\bheight\s*=\s*(["'])([\s\S]*?)\1/i)?.[2],
  );
  if (width && height) {
    return {
      width: clampFigureDimension(width),
      height: clampFigureDimension(height),
    };
  }

  const viewBox = openingTag.match(/\bviewBox\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
  const parts = viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (parts?.length === 4 && parts.every(Number.isFinite)) {
    return {
      width: clampFigureDimension(parts[2]),
      height: clampFigureDimension(parts[3]),
    };
  }

  return { width: 800, height: 480 };
}

export function resolveSvgFigureRasterSize(svgMarkup: string): {
  width: number;
  height: number;
} {
  const baseSize = parseSvgIntrinsicSize(svgMarkup);
  const longEdge = Math.max(baseSize.width, baseSize.height);
  const readabilityScale =
    longEdge > 0 ? FIGURE_EXPORT_MIN_LONG_EDGE / longEdge : 1;
  let scale = Math.max(FIGURE_EXPORT_BASE_SCALE, readabilityScale);
  const scaledLongEdge = longEdge * scale;
  if (scaledLongEdge > FIGURE_EXPORT_MAX_DIMENSION) {
    scale *= FIGURE_EXPORT_MAX_DIMENSION / scaledLongEdge;
  }
  return {
    width: clampFigureDimension(baseSize.width * scale),
    height: clampFigureDimension(baseSize.height * scale),
  };
}

function waitForImageLoad(image: HTMLImageElement): Promise<boolean> {
  return new Promise((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
}

function createSvgDataUrl(svgMarkup: string): string {
  return `data:image/svg+xml;base64,${encodeBase64Utf8(svgMarkup)}`;
}

export async function defaultRasterizeSvgToPngBytes(
  doc: Document,
  svgMarkup: string,
): Promise<Uint8Array | null> {
  const safeSvg = svgMarkup.trim();
  if (!safeSvg || !/^<svg\b[\s\S]*(?:<\/svg>|\/>)\s*$/i.test(safeSvg)) {
    return null;
  }
  const canvas = doc.createElement("canvas") as HTMLCanvasElement | null;
  const image = doc.createElement("img") as HTMLImageElement | null;
  if (!canvas || !image || typeof canvas.getContext !== "function") return null;

  const rasterSize = resolveSvgFigureRasterSize(safeSvg);
  const loaded = waitForImageLoad(image);
  image.src = createSvgDataUrl(safeSvg);
  if (!(await loaded)) return null;

  const width = rasterSize.width;
  const height = rasterSize.height;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  try {
    return pngDataUrlToBytes(canvas.toDataURL("image/png"));
  } catch {
    return null;
  }
}

export async function copySvgFigureAsPngToClipboard(
  doc: Document,
  svgMarkup: string,
  rasterizeSvgToPngBytes: SvgRasterizer = defaultRasterizeSvgToPngBytes,
): Promise<boolean> {
  const bytes = await rasterizeSvgToPngBytes(doc, svgMarkup);
  if (!bytes?.length) return false;
  const win = doc.defaultView as
    | (Window & {
        navigator?: Navigator;
        ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
      })
    | null
    | undefined;
  const ClipboardItemCtor = win?.ClipboardItem || globalThis.ClipboardItem;
  if (!win?.navigator?.clipboard?.write || !ClipboardItemCtor) return false;
  const blob = new Blob([bytesToArrayBuffer(bytes)], { type: "image/png" });
  await win.navigator.clipboard.write([
    new ClipboardItemCtor({ "image/png": blob }),
  ]);
  return true;
}

export function normalizeFigureFenceLanguage(lang: string): string {
  return (lang || "").trim().toLowerCase();
}

export function isMermaidFigureFenceLanguage(lang: string): boolean {
  const normalized = normalizeFigureFenceLanguage(lang);
  return normalized === "mermaid" || normalized === "mmd";
}

export function isVisualFigureFenceLanguage(lang: string): boolean {
  const normalized = normalizeFigureFenceLanguage(lang);
  return normalized === "svg" || isMermaidFigureFenceLanguage(normalized);
}

async function resolveFigureFenceSvgMarkup(params: {
  lang: string;
  source: string;
  options: NoteFigureRenderOptions;
}): Promise<string | null> {
  const lang = normalizeFigureFenceLanguage(params.lang);
  if (lang === "svg") {
    return buildSafeSvgMarkup(params.source);
  }
  if (!isMermaidFigureFenceLanguage(lang)) return null;
  const doc = params.options.doc || null;
  const renderMermaidSvg = params.options.renderMermaidSvg;
  if (!doc || !renderMermaidSvg) return null;
  try {
    return await renderMermaidSvg(params.source.trim(), doc);
  } catch {
    return null;
  }
}

export async function buildSvgFigureHtmlForNote(params: {
  noteItemId: number;
  doc: Document;
  svgMarkup: string;
  alt: string;
  importer?: NoteImageImporter;
  rasterizeSvgToPngBytes?: SvgRasterizer;
}): Promise<string> {
  const rasterizeSvgToPngBytes =
    params.rasterizeSvgToPngBytes || defaultRasterizeSvgToPngBytes;
  const bytes = await rasterizeSvgToPngBytes(params.doc, params.svgMarkup);
  if (!bytes?.length) return "";
  const importer = params.importer || { importNoteImage: importNoteImageAsset };
  const imported = await importer.importNoteImage({
    noteItemId: params.noteItemId,
    bytes,
    mimeType: "image/png",
  });
  if (!imported?.key) return "";
  return `<p><img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(params.alt)}" /></p>`;
}

export async function replaceVisualFigureFencesWithNoteImages(
  markdown: string,
  noteItemId: number,
  options: NoteFigureRenderOptions,
): Promise<string> {
  const doc = options.doc || null;
  if (!doc || !noteItemId || noteItemId <= 0) return markdown;

  const codeBlockRegex = /```[ \t]*([^\s`]*)[^\n`]*\n?([\s\S]*?)```/g;
  let result = "";
  let lastEnd = 0;
  let figureIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    result += markdown.slice(lastEnd, match.index);
    const rawBlock = match[0];
    const lang = normalizeFigureFenceLanguage(match[1] || "");
    const source = match[2] || "";
    if (!isVisualFigureFenceLanguage(lang)) {
      result += rawBlock;
      lastEnd = codeBlockRegex.lastIndex;
      continue;
    }

    const svgMarkup = await resolveFigureFenceSvgMarkup({
      lang,
      source,
      options,
    });
    if (!svgMarkup) {
      result += options.omitUnconvertedVisualFences
        ? `<p><em>${escapeNoteHtml(
            isMermaidFigureFenceLanguage(lang)
              ? "Mermaid diagram could not be saved as an image."
              : "SVG figure could not be saved as an image.",
          )}</em></p>`
        : rawBlock;
      lastEnd = codeBlockRegex.lastIndex;
      continue;
    }

    figureIndex += 1;
    const alt = isMermaidFigureFenceLanguage(lang)
      ? `Mermaid diagram ${figureIndex}`
      : `SVG figure ${figureIndex}`;
    const imageHtml = await buildSvgFigureHtmlForNote({
      noteItemId,
      doc,
      svgMarkup,
      alt,
      importer: options.importer,
      rasterizeSvgToPngBytes: options.rasterizeSvgToPngBytes,
    });
    result +=
      imageHtml ||
      (options.omitUnconvertedVisualFences
        ? `<p><em>${escapeNoteHtml(
            isMermaidFigureFenceLanguage(lang)
              ? "Mermaid diagram could not be saved as an image."
              : "SVG figure could not be saved as an image.",
          )}</em></p>`
        : rawBlock);
    lastEnd = codeBlockRegex.lastIndex;
  }

  return result + markdown.slice(lastEnd);
}
