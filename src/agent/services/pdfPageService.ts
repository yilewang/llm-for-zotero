import {
  ensureAttachmentBlobFromPath,
  persistAttachmentBlob,
} from "../../modules/contextPanel/attachmentStorage";
import {
  getActiveReaderForSelectedTab,
  getLastKnownSelectedTabId,
  selectZoteroTab,
} from "../../modules/contextPanel/contextResolution";
import type { ChatAttachment, PaperContextRef } from "../../shared/types";
import {
  warmPageTextCache,
  warmPageTextCacheForAttachment,
} from "../../modules/contextPanel/livePdfSelectionLocator";
import type {
  PdfFigureBox,
  PdfFigureCandidateSource,
  PdfFigureRect,
} from "../../modules/contextPanel/pdfFigureGeometry";
import {
  getPdfFigureCropImageDirForCacheDir,
  type ExtractedPdfFigure,
  type ExpectedPdfFigure,
} from "../../modules/contextPanel/pdfFigureCropCache";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";
import { PdfService, resolveContextItemFromPaperContext } from "./pdfService";
import { ZoteroGateway } from "./zoteroGateway";
import { findAttachment } from "../tools/shared";
import { joinLocalPath } from "../../utils/localPath";

export type PdfVisualMode = "general" | "figure" | "equation";

export type ParsedPageSelection = {
  pageIndexes: number[];
  displayValue: string;
};

export type ResolvedPdfTarget = {
  source: "library" | "upload";
  title: string;
  mimeType: string;
  storedPath: string;
  paperContext?: PaperContextRef;
  contextItemId?: number;
  itemId?: number;
  attachmentId?: string;
  attachmentName?: string;
};

export type PdfPageCandidate = {
  pageIndex: number;
  pageLabel: string;
  score: number;
  reason: string;
  excerpt?: string;
};

type ResolvePdfTargetInput = {
  paperContext?: PaperContextRef;
  itemId?: number;
  contextItemId?: number;
  attachmentId?: string;
  name?: string;
};

type SearchPdfPagesParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
  question: string;
  pages?: number[];
  mode?: PdfVisualMode;
  topK?: number;
};

type PreparePdfPagesParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
  pages: number[];
  neighborPages?: number;
};

type PreparePdfFigurePagesParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
  pages: number[];
  renderScale?: number;
};

type PreparePdfFileParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
};

export type SourcePdfFigureExtractionParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
  paperContext?: PaperContextRef;
  mineruCacheDir: string;
  query: string;
  pages?: number[];
  dpi?: number;
};

export type SourcePdfFigureExtractionResult = {
  figures: ExtractedPdfFigure[];
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
  warnings: string[];
};

type RenderablePdfPage = {
  getViewport: (params: { scale: number }) => {
    width: number;
    height: number;
  };
  getTextContent?: () => Promise<{
    items?: Array<{
      str?: unknown;
      transform?: unknown;
      width?: unknown;
      height?: unknown;
    }>;
  }>;
  render: (params: { canvasContext: unknown; viewport: unknown }) =>
    | Promise<unknown>
    | {
        promise?: Promise<unknown>;
      };
};

export type PdfFigurePageRender = {
  pageIndex: number;
  pageLabel: string;
  width: number;
  height: number;
  pdfWidth?: number;
  pdfHeight?: number;
  textBoxes: PdfFigureBox[];
  imageBoxes: PdfFigureBox[];
  inkBoxes: PdfFigureBox[];
  cropToPngBytes: (rect: PdfFigureRect) => Promise<Uint8Array>;
};

export type PdfFigureHeadlessCropResult = {
  bytes: Uint8Array;
  rect: PdfFigureRect;
  dpi: number;
  warnings: string[];
};

type PdfFigurePageSize = {
  width: number;
  height: number;
};

type CropPdfFigureRegionParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
  pageIndex: number;
  rect: PdfFigureRect;
  dpi?: number;
  sourcePageSize?: PdfFigurePageSize;
};

const HEADLESS_FIGURE_CROP_DPI = 216;
const PDFTOPPM_CANDIDATE_PATHS = [
  "/Users/yat-lok/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm",
  "/opt/homebrew/bin/pdftoppm",
  "/usr/local/bin/pdftoppm",
  "/usr/bin/pdftoppm",
];
const PDFTOHTML_CANDIDATE_PATHS = PDFTOPPM_CANDIDATE_PATHS.map((path) =>
  path.replace(/pdftoppm$/, "pdftohtml"),
);
const PYTHON3_CANDIDATE_PATHS = [
  "/Users/yat-lok/miniconda3/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];

function sanitizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number(code) || 0),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16) || 0),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function rectFromPdfXmlAttributes(
  attrs: Record<string, string>,
): PdfFigureRect | null {
  const left = Number(attrs.left);
  const top = Number(attrs.top);
  const width = Number(attrs.width);
  const height = Number(attrs.height);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { left, top, width, height };
}

function unwrapWrappedJsObject<T>(value: T): T {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  try {
    return (value as T & { wrappedJSObject?: T }).wrappedJSObject || value;
  } catch (_error) {
    return value;
  }
}

export function resolveRenderablePdfPage(
  value: unknown,
): RenderablePdfPage | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const candidate = unwrapWrappedJsObject(current as Record<string, unknown>);
    if (
      typeof (candidate as Partial<RenderablePdfPage>).getViewport ===
        "function" &&
      typeof (candidate as Partial<RenderablePdfPage>).render === "function"
    ) {
      return candidate as RenderablePdfPage;
    }
    if (typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      queue.push(
        record.pdfPage,
        record._pdfPage,
        record.page,
        record.pageProxy,
      );
    }
  }
  return null;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function extractNumericPageRanges(text: string): number[] {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  const patterns = [
    /\bpages?\s+([0-9][0-9,\s\-–toand]*)/gi,
    /\bpp?\.?\s*([0-9][0-9,\s\-–toand]*)/gi,
    /\bp\s*([0-9]+)\b/gi,
  ];
  const pushPage = (pageNumber: number) => {
    const normalizedPage = Math.max(1, Math.floor(pageNumber));
    if (seen.has(normalizedPage)) return;
    seen.add(normalizedPage);
    out.push(normalizedPage - 1);
  };
  const expandToken = (token: string) => {
    const rangeMatch = token.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/i);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const lower = Math.max(1, Math.min(start, end));
        const upper = Math.max(lower, Math.max(start, end));
        for (let page = lower; page <= upper && page - lower < 12; page += 1) {
          pushPage(page);
        }
      }
      return;
    }
    const single = Number.parseInt(token, 10);
    if (Number.isFinite(single)) pushPage(single);
  };
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized))) {
      const raw = match[1] || "";
      raw
        .split(/\s*(?:,|and)\s*/i)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach(expandToken);
    }
  }
  return out.sort((left, right) => left - right);
}

export function parsePageSelectionText(
  text: string | undefined,
): ParsedPageSelection | null {
  const pageIndexes = extractNumericPageRanges(text || "");
  if (!pageIndexes.length) return null;
  return {
    pageIndexes,
    displayValue: formatPageSelectionValue(pageIndexes),
  };
}

export function parsePageSelectionValue(
  value: unknown,
): ParsedPageSelection | null {
  if (Array.isArray(value)) {
    const pageIndexes = value
      .map((entry) => normalizePositiveInt(entry))
      .filter((entry): entry is number => Number.isFinite(entry))
      .map((entry) => Math.max(0, entry - 1));
    if (!pageIndexes.length) return null;
    const unique = Array.from(new Set(pageIndexes)).sort(
      (left, right) => left - right,
    );
    return {
      pageIndexes: unique,
      displayValue: formatPageSelectionValue(unique),
    };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      pageIndexes: [Math.max(0, Math.floor(value) - 1)],
      displayValue: `p${Math.max(1, Math.floor(value))}`,
    };
  }
  if (typeof value !== "string") return null;
  return parsePageSelectionText(value);
}

export function formatPageSelectionValue(pageIndexes: number[]): string {
  const normalized = Array.from(new Set(pageIndexes))
    .filter((entry) => Number.isFinite(entry) && entry >= 0)
    .sort((left, right) => left - right);
  if (!normalized.length) return "";
  const segments: string[] = [];
  let rangeStart = normalized[0];
  let previous = normalized[0];
  const flush = () => {
    if (rangeStart === previous) {
      segments.push(`${rangeStart + 1}`);
      return;
    }
    segments.push(`${rangeStart + 1}-${previous + 1}`);
  };
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    flush();
    rangeStart = current;
    previous = current;
  }
  flush();
  return `p${segments.join(", p")}`;
}

function extractSearchTokens(text: string): string[] {
  return sanitizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3);
}

function getPageLabel(pageIndex: number, pageLabel?: string): string {
  const trimmed = sanitizeText(pageLabel);
  return trimmed || `${pageIndex + 1}`;
}

function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return Boolean(
    item &&
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf",
  );
}

function getPdfPath(item: Zotero.Item | null | undefined): string {
  if (!item) return "";
  const directPath =
    typeof (item as { getFilePath?: () => string | undefined }).getFilePath ===
    "function"
      ? sanitizeText(
          (item as { getFilePath?: () => string | undefined }).getFilePath?.(),
        )
      : "";
  if (directPath) return directPath;
  const fallbackPath = sanitizeText(
    (item as unknown as { attachmentPath?: string }).attachmentPath,
  );
  return fallbackPath;
}

function getFirstPdfAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const candidate = item || null;
  if (isPdfAttachment(candidate)) return candidate;
  if (!candidate || !candidate.isRegularItem?.()) return null;
  const attachmentIds = candidate.getAttachments?.() || [];
  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    if (isPdfAttachment(attachment)) return attachment;
  }
  return null;
}

function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function getPdfViewerApplication(reader: any): any | null {
  const candidates = [
    reader?._internalReader?._lastView,
    reader?._internalReader?._primaryView,
    reader?._internalReader?._secondaryView,
    reader,
  ];
  for (const candidate of candidates) {
    const direct =
      candidate?._iframeWindow?.PDFViewerApplication ||
      candidate?._iframe?.contentWindow?.PDFViewerApplication ||
      candidate?._window?.PDFViewerApplication;
    if (direct?.pdfDocument) return direct;
    try {
      const wrapped =
        candidate?._iframeWindow?.wrappedJSObject?.PDFViewerApplication ||
        candidate?._iframe?.contentWindow?.wrappedJSObject
          ?.PDFViewerApplication ||
        candidate?._window?.wrappedJSObject?.PDFViewerApplication;
      if (wrapped?.pdfDocument) return wrapped;
    } catch (_error) {
      void _error;
    }
  }
  return null;
}

async function waitForReaderForItem(targetItemId: number): Promise<any | null> {
  const normalizedTargetItemId = Math.floor(targetItemId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2200) {
    const activeReader = getActiveReaderForSelectedTab();
    if (getReaderItemId(activeReader) === normalizedTargetItemId) {
      return activeReader;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

async function navigateReaderToPage(
  reader: any,
  pageIndex: number,
  pageLabel?: string,
): Promise<boolean> {
  if (typeof reader?.navigate !== "function") return false;
  const normalizedPageIndex = Math.max(0, Math.floor(pageIndex));
  const normalizedPageLabel = sanitizeText(pageLabel);
  try {
    await reader.navigate(
      normalizedPageLabel
        ? { pageIndex: normalizedPageIndex, pageLabel: normalizedPageLabel }
        : { pageIndex: normalizedPageIndex },
    );
    return true;
  } catch (_error) {
    try {
      await reader.navigate({ pageIndex: normalizedPageIndex });
      return true;
    } catch (_nextError) {
      void _nextError;
      return false;
    }
  }
}

async function openReaderForItem(
  targetItemId: number,
  location?: { pageIndex: number; pageLabel?: string },
): Promise<any | null> {
  const activeReader = getActiveReaderForSelectedTab();
  if (getReaderItemId(activeReader) === Math.floor(targetItemId)) {
    if (location) {
      await navigateReaderToPage(
        activeReader,
        location.pageIndex,
        location.pageLabel,
      );
    }
    return activeReader;
  }
  const readerApi = Zotero.Reader as
    | {
        open?: (
          itemID: number,
          location?: _ZoteroTypes.Reader.Location,
        ) => Promise<void | _ZoteroTypes.ReaderInstance>;
      }
    | undefined;
  if (typeof readerApi?.open === "function") {
    const opened = await readerApi.open(
      Math.floor(targetItemId),
      location
        ? {
            pageIndex: Math.floor(location.pageIndex),
            ...(location.pageLabel
              ? { pageLabel: sanitizeText(location.pageLabel) }
              : {}),
          }
        : undefined,
    );
    if (opened) return opened;
  }
  const waited = await waitForReaderForItem(targetItemId);
  if (waited && location) {
    await navigateReaderToPage(waited, location.pageIndex, location.pageLabel);
  }
  return waited;
}

/**
 * Switch back to the library/note tab after a PDF inspection.
 *
 * Uses selectZoteroTab from contextResolution which has robust fallback
 * discovery for the Zotero.Tabs object (the same mechanism that powers
 * getActiveReaderForSelectedTab).
 *
 * Zotero's reader lifecycle fires markAsLoaded → Tabs.select async after
 * Reader.open() resolves. We schedule retries to win the race.
 */
function restoreNonReaderTab(savedTabId: string | number | null): void {
  // savedTabId is captured before the PDF operation opens a reader tab.
  // Falls back to "zotero-pane" (library tab) if no ID was available.
  const targetTabId = savedTabId || "zotero-pane";
  ztoolkit.log(
    `[LLM] restoreNonReaderTab: target="${targetTabId}" (saved=${savedTabId ?? "null"})`,
  );
  const doRestore = (label: string) => {
    const ok = selectZoteroTab(targetTabId);
    if (!ok) {
      ztoolkit.log(
        `[LLM] restoreNonReaderTab(${label}): selectZoteroTab("${targetTabId}") failed`,
      );
    }
  };
  doRestore("immediate");
  setTimeout(() => doRestore("deferred-500ms"), 500);
  setTimeout(() => doRestore("deferred-1500ms"), 1500);
  setTimeout(() => doRestore("deferred-3000ms"), 3000);
}

async function waitForPdfDocument(
  reader: any,
  timeoutMs = 2200,
): Promise<any | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const app = getPdfViewerApplication(reader);
    if (app?.pdfDocument) return app;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

function getReaderDocument(reader: any): Document | null {
  return (
    reader?._iframeWindow?.document ||
    reader?._iframe?.contentDocument ||
    reader?._internalReader?._lastView?._iframeWindow?.document ||
    null
  );
}

function isCanvasElement(value: unknown): value is HTMLCanvasElement {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { getContext?: unknown }).getContext === "function" &&
    ((value as { nodeName?: unknown }).nodeName === "CANVAS" ||
      (value as { tagName?: unknown }).tagName === "CANVAS"),
  );
}

function pickLargestCanvas(
  canvases: Iterable<HTMLCanvasElement>,
): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const canvas of canvases) {
    const width = Number(canvas?.width) || 0;
    const height = Number(canvas?.height) || 0;
    const area = width * height;
    if (area > bestArea) {
      best = canvas;
      bestArea = area;
    }
  }
  return best;
}

function getPageViewCanvas(
  app: any,
  pageIndex: number,
): HTMLCanvasElement | null {
  const pageView = unwrapWrappedJsObject(
    app?.pdfViewer?.getPageView?.(pageIndex) ||
      app?.pdfViewer?._pages?.[pageIndex] ||
      null,
  ) as {
    canvas?: unknown;
    div?: Element | null;
  } | null;
  if (!pageView) return null;
  const directCanvas = unwrapWrappedJsObject(pageView.canvas);
  if (isCanvasElement(directCanvas)) {
    return directCanvas;
  }
  if (pageView.div) {
    const canvases = Array.from(
      pageView.div.querySelectorAll("canvas"),
    ) as HTMLCanvasElement[];
    return pickLargestCanvas(canvases);
  }
  return null;
}

function findRenderedPageCanvas(
  doc: Document,
  pageNumber: number,
): HTMLCanvasElement | null {
  const selectors = [
    `.page[data-page-number="${pageNumber}"] canvas`,
    `.page[data-page-number="${pageNumber}"] .canvasWrapper canvas`,
    `[data-page-number="${pageNumber}"] canvas`,
  ];
  for (const selector of selectors) {
    const canvases = Array.from(
      doc.querySelectorAll(selector),
    ) as HTMLCanvasElement[];
    const match = pickLargestCanvas(canvases);
    if (match) return match;
  }
  return null;
}

async function waitForRenderedPageCanvas(
  app: any,
  reader: any,
  pageNumber: number,
  timeoutMs = 1800,
): Promise<HTMLCanvasElement | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pageViewCanvas = getPageViewCanvas(app, pageNumber - 1);
    if (
      pageViewCanvas &&
      pageViewCanvas.width > 0 &&
      pageViewCanvas.height > 0
    ) {
      return pageViewCanvas;
    }
    const doc = getReaderDocument(reader);
    if (doc) {
      const canvas = findRenderedPageCanvas(doc, pageNumber);
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        return canvas;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

async function captureRenderedReaderPage(
  app: any,
  reader: any,
  pageIndex: number,
): Promise<Uint8Array | null> {
  const sourceCanvas = await waitForRenderedPageCanvas(
    app,
    reader,
    pageIndex + 1,
  );
  if (!sourceCanvas) return null;
  try {
    return await canvasToBytes(sourceCanvas);
  } catch (_error) {
    const doc = sourceCanvas.ownerDocument || getReaderDocument(reader);
    if (!doc) return null;
    const tempCanvas = doc.createElement("canvas") as HTMLCanvasElement;
    tempCanvas.width = Math.max(1, sourceCanvas.width);
    tempCanvas.height = Math.max(1, sourceCanvas.height);
    const context = tempCanvas.getContext(
      "2d",
    ) as CanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(sourceCanvas, 0, 0);
    return canvasToBytes(tempCanvas);
  }
}

async function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), "image/png");
    });
    if (blob) {
      return new Uint8Array(await blob.arrayBuffer());
    }
  }
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function extractTextBoxesFromPdfTextContent(params: {
  textContent: Awaited<
    ReturnType<NonNullable<RenderablePdfPage["getTextContent"]>>
  >;
  scale: number;
  scaleX?: number;
  scaleY?: number;
  pageHeight: number;
}): PdfFigureBox[] {
  const boxes: PdfFigureBox[] = [];
  const scaleX = Number.isFinite(params.scaleX) ? params.scaleX! : params.scale;
  const scaleY = Number.isFinite(params.scaleY) ? params.scaleY! : params.scale;
  for (const item of params.textContent.items || []) {
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const text = sanitizeText(item.str);
    if (!text || transform.length < 6) continue;
    const rawX = Number(transform[4]);
    const rawY = Number(transform[5]);
    const rawWidth = Number(item.width);
    const rawHeight = Number(item.height);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
    const width = Math.max(
      1,
      Number.isFinite(rawWidth) ? rawWidth * scaleX : text.length * 4,
    );
    const height = Math.max(
      1,
      Number.isFinite(rawHeight) ? rawHeight * scaleY : 10,
    );
    boxes.push({
      left: rawX * scaleX,
      top: params.pageHeight - rawY * scaleY - height,
      width,
      height,
      role: "text",
      text,
    });
  }
  return boxes;
}

function detectInkBoxesFromCanvas(canvas: HTMLCanvasElement): PdfFigureBox[] {
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) return [];
  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return [];
  }
  const step = Math.max(
    1,
    Math.ceil(Math.max(canvas.width, canvas.height) / 900),
  );
  const minRun = Math.max(3, Math.ceil(18 / step));
  const rowHasInk: boolean[] = [];
  const colHasInk: boolean[] = [];
  for (let y = 0; y < canvas.height; y += step) {
    let rowInk = false;
    for (let x = 0; x < canvas.width; x += step) {
      const offset = (y * canvas.width + x) * 4;
      const r = imageData.data[offset] || 255;
      const g = imageData.data[offset + 1] || 255;
      const b = imageData.data[offset + 2] || 255;
      const a = imageData.data[offset + 3] || 255;
      const darkness = 255 - Math.max(r, g, b);
      const colorfulness = Math.max(r, g, b) - Math.min(r, g, b);
      if (a > 12 && (darkness > 28 || colorfulness > 24)) {
        rowInk = true;
        colHasInk[Math.floor(x / step)] = true;
      }
    }
    rowHasInk[Math.floor(y / step)] = rowInk;
  }

  const ranges = (values: boolean[], max: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let start = -1;
    for (let index = 0; index <= values.length; index += 1) {
      if (values[index]) {
        if (start < 0) start = index;
        continue;
      }
      if (start >= 0 && index - start >= minRun) {
        out.push([start * step, Math.min(max, index * step)]);
      }
      start = -1;
    }
    return out;
  };
  const yRanges = ranges(rowHasInk, canvas.height);
  const xRanges = ranges(colHasInk, canvas.width);
  if (!xRanges.length || !yRanges.length) return [];
  const left = Math.min(...xRanges.map((range) => range[0]));
  const right = Math.max(...xRanges.map((range) => range[1]));
  const top = Math.min(...yRanges.map((range) => range[0]));
  const bottom = Math.max(...yRanges.map((range) => range[1]));
  if (right - left < 18 || bottom - top < 18) return [];
  return [
    {
      left,
      top,
      width: right - left,
      height: bottom - top,
      role: "ink",
    },
  ];
}

function cropCanvasToBytes(
  sourceCanvas: HTMLCanvasElement,
  rect: PdfFigureRect,
): Promise<Uint8Array> {
  const doc = sourceCanvas.ownerDocument || Zotero.getMainWindow?.()?.document;
  if (!doc) throw new Error("No document is available for figure cropping");
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const right = Math.min(sourceCanvas.width, Math.ceil(rect.left + rect.width));
  const bottom = Math.min(
    sourceCanvas.height,
    Math.ceil(rect.top + rect.height),
  );
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Could not create a canvas for figure cropping");
  context.drawImage(
    sourceCanvas,
    left,
    top,
    width,
    height,
    0,
    0,
    width,
    height,
  );
  return canvasToBytes(canvas);
}

function normalizeCropRectForPdf(rect: PdfFigureRect): PdfFigureRect | null {
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width,
    height,
  };
}

export function buildPdftoppmCropArguments(params: {
  pdfPath: string;
  outputPrefix: string;
  pageIndex: number;
  rect: PdfFigureRect;
  dpi?: number;
  sourcePageSize?: PdfFigurePageSize;
  renderedPageSize?: PdfFigurePageSize;
}): { dpi: number; args: string[]; rect: PdfFigureRect } {
  const rect = normalizeCropRectForPdf(params.rect);
  if (!rect) throw new Error("Invalid PDF figure crop rectangle");
  const dpi = Number.isFinite(params.dpi)
    ? Math.max(72, Math.min(600, Math.floor(params.dpi as number)))
    : HEADLESS_FIGURE_CROP_DPI;
  const sourceWidth = Number(params.sourcePageSize?.width);
  const sourceHeight = Number(params.sourcePageSize?.height);
  const renderedWidth = Number(params.renderedPageSize?.width);
  const renderedHeight = Number(params.renderedPageSize?.height);
  const scaleX =
    Number.isFinite(sourceWidth) &&
    sourceWidth > 0 &&
    Number.isFinite(renderedWidth) &&
    renderedWidth > 0
      ? renderedWidth / sourceWidth
      : dpi / 72;
  const scaleY =
    Number.isFinite(sourceHeight) &&
    sourceHeight > 0 &&
    Number.isFinite(renderedHeight) &&
    renderedHeight > 0
      ? renderedHeight / sourceHeight
      : dpi / 72;
  const x = Math.max(0, Math.floor(rect.left * scaleX));
  const y = Math.max(0, Math.floor(rect.top * scaleY));
  const width = Math.max(1, Math.ceil(rect.width * scaleX));
  const height = Math.max(1, Math.ceil(rect.height * scaleY));
  const pageNumber = Math.max(1, Math.floor(params.pageIndex) + 1);
  return {
    dpi,
    rect,
    args: [
      "-png",
      "-r",
      `${dpi}`,
      "-f",
      `${pageNumber}`,
      "-l",
      `${pageNumber}`,
      "-x",
      `${x}`,
      "-y",
      `${y}`,
      "-W",
      `${width}`,
      "-H",
      `${height}`,
      params.pdfPath,
      params.outputPrefix,
    ],
  };
}

async function pathExists(path: string): Promise<boolean> {
  const io = (globalThis as any).IOUtils;
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  if (io?.stat) {
    try {
      await io.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function readPopplerPreference(): string {
  const zotero = (globalThis as any).Zotero;
  const preferenceKeys = [
    "extensions.zotero.llmforzotero.pdftoppmPath",
    "extensions.zotero.llmforzotero.popplerPdftoppmPath",
    "llmforzotero.pdftoppmPath",
  ];
  for (const key of preferenceKeys) {
    try {
      const value = sanitizeText(zotero?.Prefs?.get?.(key));
      if (value) return value;
    } catch {
      // Ignore missing preference namespaces.
    }
  }
  return "";
}

async function resolvePdftoppmPath(): Promise<string | null> {
  const preferencePath = readPopplerPreference();
  const candidates = [
    ...(preferencePath ? [preferencePath] : []),
    ...PDFTOPPM_CANDIDATE_PATHS,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function resolvePdftohtmlPath(): Promise<string | null> {
  const preferencePath = readPopplerPreference();
  const preferenceSibling = preferencePath
    ? preferencePath.replace(/pdftoppm$/, "pdftohtml")
    : "";
  const candidates = [
    ...(preferenceSibling ? [preferenceSibling] : []),
    ...PDFTOHTML_CANDIDATE_PATHS,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function readPythonPreference(): string {
  const zotero = (globalThis as any).Zotero;
  const preferenceKeys = [
    "extensions.zotero.llmforzotero.pythonPath",
    "extensions.zotero.llmforzotero.figureExtractionPythonPath",
    "llmforzotero.pythonPath",
  ];
  for (const key of preferenceKeys) {
    try {
      const value = sanitizeText(zotero?.Prefs?.get?.(key));
      if (value) return value;
    } catch {
      // Ignore missing preference namespaces.
    }
  }
  return "";
}

async function resolvePython3Path(): Promise<string | null> {
  const preferencePath = readPythonPreference();
  const candidates = [
    ...(preferencePath ? [preferencePath] : []),
    ...PYTHON3_CANDIDATE_PATHS,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

async function loadSubprocessModule(): Promise<any | null> {
  const CU = (globalThis as any).ChromeUtils;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      return mod.Subprocess || mod.default || mod;
    } catch {
      // Try the legacy module next.
    }
  }
  if (CU?.import) {
    try {
      const mod = CU.import("resource://gre/modules/Subprocess.jsm");
      return mod.Subprocess || mod;
    } catch {
      return null;
    }
  }
  return null;
}

async function drainSubprocessPipe(pipe: any): Promise<string> {
  if (!pipe?.readString) return "";
  let result = "";
  try {
    while (true) {
      const chunk = await pipe.readString();
      if (!chunk) break;
      result += chunk;
    }
  } catch {
    // Pipe closed.
  }
  return result;
}

function getTempRoot(): string {
  const pathUtils = (globalThis as any).PathUtils;
  const fromPathUtils = sanitizeText(pathUtils?.tempDir);
  if (fromPathUtils) return fromPathUtils;
  const components = (globalThis as any).Components;
  try {
    const tempDir = (globalThis as any).Services?.dirsvc?.get(
      "TmpD",
      components?.interfaces?.nsIFile,
    )?.path;
    const normalized = sanitizeText(tempDir);
    if (normalized) return normalized;
  } catch {
    // Fall through to POSIX temp.
  }
  return "/tmp";
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const io = (globalThis as any).IOUtils;
  if (!io?.makeDirectory) {
    throw new Error("IOUtils.makeDirectory is not available");
  }
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = joinLocalPath(getTempRoot(), `${prefix}-${suffix}`);
  await io.makeDirectory(dir, {
    createAncestors: true,
    ignoreExisting: false,
  });
  return dir;
}

async function readHeadlessCropOutput(
  tempDir: string,
  outputPrefix: string,
): Promise<Uint8Array> {
  const io = (globalThis as any).IOUtils;
  if (!io?.getChildren || !io?.read) {
    throw new Error("IOUtils file reading is not available");
  }
  const children = await io.getChildren(tempDir);
  const pngPath = (children as string[])
    .filter(
      (path) =>
        sanitizeText(path).startsWith(outputPrefix) && /\.png$/i.test(path),
    )
    .sort()[0];
  if (!pngPath) {
    throw new Error("pdftoppm did not produce a PNG crop");
  }
  const data = await io.read(pngPath);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function readPngDimensions(bytes: Uint8Array): PdfFigurePageSize | null {
  if (bytes.length < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  const width =
    bytes[16] * 0x1000000 + bytes[17] * 0x10000 + bytes[18] * 0x100 + bytes[19];
  const height =
    bytes[20] * 0x1000000 + bytes[21] * 0x10000 + bytes[22] * 0x100 + bytes[23];
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { width, height };
}

async function readUtf8File(path: string): Promise<string> {
  const io = (globalThis as any).IOUtils;
  if (!io?.read) {
    throw new Error("IOUtils file reading is not available");
  }
  const data = await io.read(path);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder("utf-8").decode(bytes);
}

async function writeUtf8File(path: string, text: string): Promise<void> {
  const io = (globalThis as any).IOUtils;
  if (!io?.write) {
    throw new Error("IOUtils file writing is not available");
  }
  await io.write(path, new TextEncoder().encode(text));
}

function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "file:") {
      return decodeURIComponent(url.pathname);
    }
  } catch {
    // Fall through to a simple file:// decode.
  }
  return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
}

export function resolveAddonRootUri(): string {
  const direct = sanitizeText((globalThis as any).rootURI);
  if (direct) return direct;
  const sandboxObject = sanitizeText((globalThis as any)._globalThis?.rootURI);
  if (sandboxObject) return sandboxObject;
  try {
    if (typeof _globalThis !== "undefined") {
      const sandboxGlobal = sanitizeText(_globalThis?.rootURI);
      if (sandboxGlobal) return sandboxGlobal;
    }
  } catch {
    // Fall through to the rootURI global.
  }
  try {
    if (typeof rootURI !== "undefined") {
      const rootGlobal = sanitizeText(rootURI);
      if (rootGlobal) return rootGlobal;
    }
  } catch {
    // The rootURI global is only present in Zotero's plugin sandbox.
  }
  return "";
}

function getAddonRootUri(): string {
  return resolveAddonRootUri();
}

async function materializePackagedFigureExtractorScript(): Promise<{
  scriptPath: string;
  cleanupDir?: string;
}> {
  const rootUri = getAddonRootUri();
  if (rootUri && /^file:/i.test(rootUri)) {
    const rootPath = fileUriToPath(rootUri);
    const scriptPath = joinLocalPath(
      rootPath,
      "scripts",
      "pdf_figure_extract.py",
    );
    if (await pathExists(scriptPath)) {
      return { scriptPath };
    }
  }
  if (!rootUri) {
    throw new Error("Could not locate the addon root URI");
  }
  const resourceUri = `${rootUri.replace(/\/?$/, "/")}scripts/pdf_figure_extract.py`;
  const fetcher = (globalThis as any).fetch;
  if (typeof fetcher !== "function") {
    throw new Error("fetch is not available to load the packaged extractor");
  }
  const response = await fetcher(resourceUri);
  if (!response?.ok) {
    throw new Error(`Could not read packaged extractor from ${resourceUri}`);
  }
  const scriptText = await response.text();
  const cleanupDir = await makeTempDirectory("llm-for-zotero-figure-extractor");
  const scriptPath = joinLocalPath(cleanupDir, "pdf_figure_extract.py");
  await writeUtf8File(scriptPath, scriptText);
  return { scriptPath, cleanupDir };
}

function isPdfFigureCandidateSource(
  value: unknown,
): value is PdfFigureCandidateSource {
  return (
    value === "pdf-image-object" ||
    value === "mineru-layout-region" ||
    value === "caption-bounded-region" ||
    value === "rendered-ink" ||
    value === "pdf-vector-object"
  );
}

function rectFromRawFigure(value: unknown): PdfFigureRect {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const left = Number(record.left);
  const top = Number(record.top);
  const width = Number(record.width);
  const height = Number(record.height);
  return {
    left: Number.isFinite(left) ? left : 0,
    top: Number.isFinite(top) ? top : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

function normalizeRawExpectedFigures(value: unknown): ExpectedPdfFigure[] {
  const rawFigures = Array.isArray(value) ? value : [];
  const figures: ExpectedPdfFigure[] = [];
  for (const raw of rawFigures) {
    if (!raw || typeof raw !== "object") continue;
    const figure = raw as Record<string, unknown>;
    const label = sanitizeText(figure.label);
    if (!label) continue;
    const pageNumber = Math.floor(Number(figure.pageNumber));
    const captionPageNumber = Math.floor(Number(figure.captionPageNumber));
    const confidence = Number(figure.confidence);
    figures.push({
      label,
      baseLabel: sanitizeText(figure.baseLabel) || label,
      pageNumber: Number.isFinite(pageNumber) ? pageNumber : undefined,
      captionPageNumber: Number.isFinite(captionPageNumber)
        ? captionPageNumber
        : undefined,
      status: sanitizeText(figure.status) || undefined,
      cropPath: sanitizeText(figure.cropPath) || undefined,
      source: sanitizeText(figure.source) || undefined,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
    });
  }
  return figures;
}

function normalizeRawFigureExtractionResult(
  value: unknown,
): SourcePdfFigureExtractionResult {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rawFigures = Array.isArray(record.figures) ? record.figures : [];
  const figures: ExtractedPdfFigure[] = [];
  for (const raw of rawFigures) {
    if (!raw || typeof raw !== "object") continue;
    const figure = raw as Record<string, unknown>;
    const id = sanitizeText(figure.id);
    const label = sanitizeText(figure.label);
    const cropPath = sanitizeText(figure.cropPath);
    const pageNumber = Math.floor(Number(figure.pageNumber));
    const confidence = Number(figure.confidence);
    if (!id || !label || !cropPath || !Number.isFinite(pageNumber)) continue;
    const source = isPdfFigureCandidateSource(figure.source)
      ? figure.source
      : "rendered-ink";
    figures.push({
      id,
      label,
      baseLabel: sanitizeText(figure.baseLabel) || label,
      pageNumber,
      captionPageNumber:
        Math.floor(Number(figure.captionPageNumber)) || undefined,
      cropPath,
      captionText: sanitizeText(figure.captionText) || undefined,
      panelHint: sanitizeText(figure.panelHint) || undefined,
      rect: rectFromRawFigure(figure.rect),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      source,
      warnings: Array.isArray(figure.warnings)
        ? figure.warnings.map((warning) => sanitizeText(warning)).filter(Boolean)
        : [],
      mineruImagePaths: [],
    });
  }
  return {
    figures,
    expectedFigures: normalizeRawExpectedFigures(record.expectedFigures),
    missingFigures: normalizeRawExpectedFigures(record.missingFigures),
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((warning) => sanitizeText(warning)).filter(Boolean)
      : [],
  };
}

async function removeTempDirectory(path: string): Promise<void> {
  const io = (globalThis as any).IOUtils;
  try {
    await io?.remove?.(path, {
      recursive: true,
      ignoreAbsent: true,
    });
  } catch {
    // Temporary cleanup failure should not invalidate the crop.
  }
}

async function cropPdfRegionWithPdftoppm(params: {
  pdfPath: string;
  pageIndex: number;
  rect: PdfFigureRect;
  dpi?: number;
  sourcePageSize?: PdfFigurePageSize;
}): Promise<PdfFigureHeadlessCropResult | null> {
  const command = await resolvePdftoppmPath();
  if (!command) return null;
  const Subprocess = await loadSubprocessModule();
  if (!Subprocess?.call) return null;
  const tempDir = await makeTempDirectory("llm-for-zotero-figure-crop");
  try {
    const dpi = Number.isFinite(params.dpi)
      ? Math.max(72, Math.min(600, Math.floor(params.dpi as number)))
      : HEADLESS_FIGURE_CROP_DPI;
    let renderedPageSize: PdfFigurePageSize | undefined;
    if (params.sourcePageSize) {
      const pageNumber = Math.max(1, Math.floor(params.pageIndex) + 1);
      const pagePrefix = joinLocalPath(tempDir, "page-size");
      const pageProc = await Subprocess.call({
        command,
        arguments: [
          "-png",
          "-r",
          `${dpi}`,
          "-f",
          `${pageNumber}`,
          "-l",
          `${pageNumber}`,
          params.pdfPath,
          pagePrefix,
        ],
        stdout: "pipe",
        stderr: "pipe",
        environment: {
          XDG_CACHE_HOME: tempDir,
        },
        environmentAppend: true,
      });
      const [pageStdout, pageStderr] = await Promise.all([
        drainSubprocessPipe(pageProc.stdout),
        drainSubprocessPipe(pageProc.stderr),
      ]);
      const { exitCode: pageExitCode } = await pageProc.wait();
      if (pageExitCode !== 0) {
        const message =
          sanitizeText(pageStderr || pageStdout) || `exit code ${pageExitCode}`;
        throw new Error(`pdftoppm page-size render failed: ${message}`);
      }
      renderedPageSize =
        readPngDimensions(await readHeadlessCropOutput(tempDir, pagePrefix)) ||
        undefined;
    }
    const outputPrefix = joinLocalPath(tempDir, "figure");
    const built = buildPdftoppmCropArguments({
      pdfPath: params.pdfPath,
      outputPrefix,
      pageIndex: params.pageIndex,
      rect: params.rect,
      dpi,
      sourcePageSize: params.sourcePageSize,
      renderedPageSize,
    });
    const proc = await Subprocess.call({
      command,
      arguments: built.args,
      stdout: "pipe",
      stderr: "pipe",
      environment: {
        XDG_CACHE_HOME: tempDir,
      },
      environmentAppend: true,
    });
    const [stdout, stderr] = await Promise.all([
      drainSubprocessPipe(proc.stdout),
      drainSubprocessPipe(proc.stderr),
    ]);
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      const message = sanitizeText(stderr || stdout) || `exit code ${exitCode}`;
      throw new Error(`pdftoppm crop failed: ${message}`);
    }
    const bytes = await readHeadlessCropOutput(tempDir, outputPrefix);
    return {
      bytes,
      rect: built.rect,
      dpi: built.dpi,
      warnings: [],
    };
  } finally {
    await removeTempDirectory(tempDir);
  }
}

function parsePdfToHtmlXmlPages(
  xmlText: string,
  requestedPages: Set<number>,
  cropper: (
    pageIndex: number,
    rect: PdfFigureRect,
    sourcePageSize: PdfFigurePageSize,
  ) => Promise<Uint8Array>,
): PdfFigurePageRender[] {
  const pages: PdfFigurePageRender[] = [];
  const pagePattern = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pagePattern.exec(xmlText)) !== null) {
    const attrs = parseXmlAttributes(pageMatch[1]);
    const pageNumber = Number(attrs.number);
    const pageIndex = pageNumber - 1;
    if (!Number.isFinite(pageNumber) || !requestedPages.has(pageIndex)) {
      continue;
    }
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    const body = pageMatch[2];
    const textBoxes: PdfFigureBox[] = [];
    const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textPattern.exec(body)) !== null) {
      const rect = rectFromPdfXmlAttributes(parseXmlAttributes(textMatch[1]));
      const text = decodeXmlText(textMatch[2]);
      if (!rect || !text) continue;
      textBoxes.push({
        ...rect,
        role: "text",
        text,
      });
    }
    const imageBoxes: PdfFigureBox[] = [];
    const imagePattern = /<image\b([^>]*?)(?:\/>|>[\s\S]*?<\/image>)/g;
    let imageMatch: RegExpExecArray | null;
    while ((imageMatch = imagePattern.exec(body)) !== null) {
      const rect = rectFromPdfXmlAttributes(parseXmlAttributes(imageMatch[1]));
      if (!rect) continue;
      imageBoxes.push({
        ...rect,
        role: "image",
      });
    }
    pages.push({
      pageIndex,
      pageLabel: `${pageNumber}`,
      width,
      height,
      pdfWidth: width,
      pdfHeight: height,
      textBoxes,
      imageBoxes,
      inkBoxes: [],
      cropToPngBytes: (rect) => cropper(pageIndex, rect, { width, height }),
    });
  }
  return pages;
}

async function extractPdfFigureGeometryWithPdftohtml(params: {
  pdfPath: string;
  pages: number[];
}): Promise<PdfFigurePageRender[] | null> {
  const command = await resolvePdftohtmlPath();
  if (!command) return null;
  const Subprocess = await loadSubprocessModule();
  if (!Subprocess?.call) return null;
  const requestedPages = Array.from(new Set(params.pages))
    .filter((page) => Number.isFinite(page) && page >= 0)
    .map((page) => Math.floor(page))
    .sort((left, right) => left - right);
  if (!requestedPages.length) return [];
  const tempDir = await makeTempDirectory("llm-for-zotero-figure-xml");
  try {
    const outputPrefix = joinLocalPath(tempDir, "out");
    const proc = await Subprocess.call({
      command,
      arguments: [
        "-xml",
        "-hidden",
        "-f",
        `${requestedPages[0] + 1}`,
        "-l",
        `${requestedPages[requestedPages.length - 1] + 1}`,
        params.pdfPath,
        outputPrefix,
      ],
      stdout: "pipe",
      stderr: "pipe",
      environment: {
        XDG_CACHE_HOME: tempDir,
      },
      environmentAppend: true,
    });
    const [stdout, stderr] = await Promise.all([
      drainSubprocessPipe(proc.stdout),
      drainSubprocessPipe(proc.stderr),
    ]);
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      const message = sanitizeText(stderr || stdout) || `exit code ${exitCode}`;
      throw new Error(`pdftohtml XML extraction failed: ${message}`);
    }
    const xmlText = await readUtf8File(`${outputPrefix}.xml`);
    const requested = new Set(requestedPages);
    return parsePdfToHtmlXmlPages(
      xmlText,
      requested,
      async (pageIndex, rect, sourcePageSize) => {
        const crop = await cropPdfRegionWithPdftoppm({
          pdfPath: params.pdfPath,
          pageIndex,
          rect,
          sourcePageSize,
        });
        if (!crop?.bytes?.length) {
          throw new Error("pdftoppm did not produce a PNG crop");
        }
        return crop.bytes;
      },
    );
  } finally {
    await removeTempDirectory(tempDir);
  }
}

async function awaitPdfRenderTask(renderTask: unknown): Promise<void> {
  if (
    renderTask &&
    typeof renderTask === "object" &&
    "promise" in renderTask &&
    (renderTask as { promise?: Promise<unknown> }).promise
  ) {
    await (renderTask as { promise: Promise<unknown> }).promise;
    return;
  }
  if (
    renderTask &&
    (typeof renderTask === "object" || typeof renderTask === "function") &&
    "then" in renderTask &&
    typeof (renderTask as Promise<unknown>).then === "function"
  ) {
    await renderTask;
  }
}

function viewportDimension(
  viewport: ReturnType<RenderablePdfPage["getViewport"]>,
  key: "width" | "height",
): number | undefined {
  const value = Number(viewport?.[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function renderPdfFigurePageToCanvas(params: {
  pdfPage: RenderablePdfPage;
  canvasDoc: Document;
  pageIndex: number;
  pageLabel: string;
  scale: number;
}): Promise<PdfFigurePageRender> {
  const pdfViewport = params.pdfPage.getViewport({ scale: 1 });
  const viewport = params.pdfPage.getViewport({ scale: params.scale });
  const canvas = params.canvasDoc.createElement("canvas") as HTMLCanvasElement;
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas for PDF figure extraction");
  }
  await awaitPdfRenderTask(
    params.pdfPage.render({
      canvasContext: context,
      viewport,
    }),
  );
  const textContent =
    typeof params.pdfPage.getTextContent === "function"
      ? await params.pdfPage.getTextContent()
      : { items: [] };
  const textBoxes = extractTextBoxesFromPdfTextContent({
    textContent,
    scale: params.scale,
    pageHeight: canvas.height,
  });
  const inkBoxes = detectInkBoxesFromCanvas(canvas);
  return {
    pageIndex: params.pageIndex,
    pageLabel: params.pageLabel,
    width: canvas.width,
    height: canvas.height,
    pdfWidth: viewportDimension(pdfViewport, "width"),
    pdfHeight: viewportDimension(pdfViewport, "height"),
    textBoxes,
    imageBoxes: [],
    inkBoxes,
    cropToPngBytes: (rect) => cropCanvasToBytes(canvas, rect),
  };
}

export function isExplicitWholeDocumentRequest(
  text: string | undefined,
): boolean {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return false;
  return /\b(entire|whole|full)\s+(pdf|paper|document)\b/.test(normalized);
}

export class PdfPageService {
  constructor(
    private readonly pdfService: PdfService,
    private readonly zoteroGateway: ZoteroGateway,
  ) {}

  async extractFiguresFromSourcePdf(
    params: SourcePdfFigureExtractionParams,
  ): Promise<SourcePdfFigureExtractionResult> {
    const target = await this.resolveTarget(params);
    if (target.source !== "library" || !target.contextItemId) {
      throw new Error(
        "Figure extraction is currently supported for Zotero library PDFs.",
      );
    }
    if (!target.storedPath) {
      throw new Error("Could not resolve the source PDF file path");
    }
    const pythonPath = await resolvePython3Path();
    if (!pythonPath) {
      throw new Error(
        "Could not find python3 for raw source-PDF figure extraction",
      );
    }
    const pdftoppmPath = await resolvePdftoppmPath();
    if (!pdftoppmPath) {
      throw new Error(
        "Could not find Poppler pdftoppm for raw source-PDF figure extraction",
      );
    }
    const Subprocess = await loadSubprocessModule();
    if (!Subprocess?.call) {
      throw new Error("Subprocess is not available for figure extraction");
    }
    const materialized = await materializePackagedFigureExtractorScript();
    const workDir = await makeTempDirectory("llm-for-zotero-raw-figures");
    const jsonOut = joinLocalPath(workDir, "figures.json");
    const cropDir = getPdfFigureCropImageDirForCacheDir(params.mineruCacheDir);
    const pages = Array.isArray(params.pages)
      ? params.pages
          .filter((page) => Number.isFinite(page) && page >= 0)
          .map((page) => `${Math.floor(page) + 1}`)
          .join(",")
      : "";
    try {
      const args = [
        materialized.scriptPath,
        "--pdf",
        target.storedPath,
        "--mineru-dir",
        params.mineruCacheDir,
        "--query",
        params.query || "",
        "--crop-dir",
        cropDir,
        "--out",
        joinLocalPath(workDir, "work"),
        "--json-out",
        jsonOut,
        "--dpi",
        `${Math.max(72, Math.min(600, Math.floor(params.dpi || 216)))}`,
        "--attachment-id",
        `${target.contextItemId}`,
        "--source-filename",
        target.attachmentName || target.title || "paper.pdf",
        "--clean-out",
      ];
      if (pages) {
        args.push("--pages", pages);
      }
      const proc = await Subprocess.call({
        command: pythonPath,
        arguments: args,
        stdout: "pipe",
        stderr: "pipe",
        environment: {
          PATH: `${parentDirectory(pdftoppmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          XDG_CACHE_HOME: workDir,
        },
        environmentAppend: true,
      });
      const [stdout, stderr] = await Promise.all([
        drainSubprocessPipe(proc.stdout),
        drainSubprocessPipe(proc.stderr),
      ]);
      const { exitCode } = await proc.wait();
      if (exitCode !== 0) {
        const message = sanitizeText(stderr || stdout) || `exit code ${exitCode}`;
        throw new Error(`raw source-PDF figure extraction failed: ${message}`);
      }
      const jsonText = await readUtf8File(jsonOut);
      return normalizeRawFigureExtractionResult(JSON.parse(jsonText));
    } finally {
      await removeTempDirectory(workDir);
      if (materialized.cleanupDir) {
        await removeTempDirectory(materialized.cleanupDir);
      }
    }
  }

  async cropFigureRegionFromPdf(
    params: CropPdfFigureRegionParams,
  ): Promise<PdfFigureHeadlessCropResult | null> {
    const target = await this.resolveTarget(params);
    if (!target.storedPath) {
      throw new Error("Could not resolve the source PDF file path");
    }
    return cropPdfRegionWithPdftoppm({
      pdfPath: target.storedPath,
      pageIndex: params.pageIndex,
      rect: params.rect,
      dpi: params.dpi,
    });
  }

  async prepareSourcePdfPagesForFigureExtraction(
    params: PreparePdfFigurePagesParams,
  ): Promise<{
    target: ResolvedPdfTarget;
    pages: PdfFigurePageRender[];
  }> {
    const target = await this.resolveTarget(params);
    if (target.source !== "library" || !target.contextItemId) {
      throw new Error(
        "Figure extraction is currently supported for Zotero library PDFs.",
      );
    }
    if (!target.storedPath) {
      throw new Error("Could not resolve the source PDF file path");
    }
    const pages = await extractPdfFigureGeometryWithPdftohtml({
      pdfPath: target.storedPath,
      pages: params.pages,
    });
    if (!pages) {
      throw new Error("pdftohtml is not available for source-PDF geometry");
    }
    return { target, pages };
  }

  async getPageCountForTarget(
    params: ResolvePdfTargetInput & {
      request: AgentRuntimeRequest;
    },
  ): Promise<number> {
    const savedTabId = getLastKnownSelectedTabId();
    try {
      const target = await this.resolveTarget(params);
      if (target.source !== "library" || !target.contextItemId) {
        throw new Error(
          "Page-count inspection is currently supported for Zotero library PDFs.",
        );
      }
      const reader = await openReaderForItem(target.contextItemId, {
        pageIndex: 0,
        pageLabel: "1",
      });
      if (!reader) {
        throw new Error(
          "Could not open the Zotero PDF reader for this attachment",
        );
      }
      const app = await waitForPdfDocument(reader);
      const pdfDocument = unwrapWrappedJsObject(
        app?.pdfDocument as { numPages?: number } | null | undefined,
      );
      const rawCount = Number(
        (pdfDocument && (pdfDocument as { numPages?: number }).numPages) ??
          (app as { pdfDocument?: { numPages?: number } })?.pdfDocument
            ?.numPages ??
          0,
      );
      if (!Number.isFinite(rawCount) || rawCount <= 0) {
        throw new Error("Could not determine the total number of PDF pages");
      }
      return Math.floor(rawCount);
    } finally {
      restoreNonReaderTab(savedTabId);
    }
  }

  getUserExplicitPageSelection(
    request: AgentRuntimeRequest,
  ): ParsedPageSelection | null {
    return parsePageSelectionText(request.userText);
  }

  getActivePageIndex(): number | null {
    const reader = getActiveReaderForSelectedTab();
    if (!reader) return null;
    const app = getPdfViewerApplication(reader);
    if (!app?.pdfDocument) return null;
    const rawPageNumber = Number(
      app?.pdfViewer?.currentPageNumber ||
        app?.pdfViewer?.currentPageLabel ||
        app?.page ||
        1,
    );
    return Number.isFinite(rawPageNumber)
      ? Math.max(0, Math.floor(rawPageNumber) - 1)
      : null;
  }

  async resolveTarget(
    params: ResolvePdfTargetInput & { request: AgentRuntimeRequest },
  ): Promise<ResolvedPdfTarget> {
    if (params.paperContext) {
      const contextItem = resolveContextItemFromPaperContext(
        params.paperContext,
      );
      const storedPath = getPdfPath(contextItem);
      if (!contextItem || !storedPath) {
        throw new Error("Could not resolve the PDF attachment for that paper");
      }
      return {
        source: "library",
        title: params.paperContext.attachmentTitle || params.paperContext.title,
        mimeType: "application/pdf",
        storedPath,
        paperContext: params.paperContext,
        contextItemId: contextItem.id,
        itemId: params.paperContext.itemId,
        attachmentName:
          sanitizeText(
            (contextItem as unknown as { attachmentFilename?: string })
              .attachmentFilename,
          ) || undefined,
      };
    }

    const contextItemById = isPdfAttachment(
      this.zoteroGateway.getItem(params.contextItemId),
    )
      ? (this.zoteroGateway.getItem(params.contextItemId) as Zotero.Item)
      : null;
    if (contextItemById) {
      const paperContext =
        this.pdfService.getPaperContextForItem(contextItemById);
      const storedPath = getPdfPath(contextItemById);
      if (!storedPath) {
        throw new Error("Could not access the Zotero PDF file path");
      }
      return {
        source: "library",
        title:
          paperContext?.attachmentTitle ||
          paperContext?.title ||
          contextItemById.getDisplayTitle?.() ||
          `PDF ${contextItemById.id}`,
        mimeType: "application/pdf",
        storedPath,
        paperContext: paperContext || undefined,
        contextItemId: contextItemById.id,
        itemId: paperContext?.itemId,
        attachmentName:
          sanitizeText(
            (contextItemById as unknown as { attachmentFilename?: string })
              .attachmentFilename,
          ) || undefined,
      };
    }

    const bibliographicItem = this.zoteroGateway.resolveMetadataItem({
      request: params.request,
      item: this.zoteroGateway.getItem(params.itemId),
      itemId: params.itemId,
    });
    const bibliographicAttachment = getFirstPdfAttachment(bibliographicItem);
    if (bibliographicAttachment) {
      const paperContext = this.pdfService.getPaperContextForItem(
        bibliographicAttachment,
      );
      const storedPath = getPdfPath(bibliographicAttachment);
      if (!storedPath) {
        throw new Error("Could not access the Zotero PDF file path");
      }
      return {
        source: "library",
        title:
          paperContext?.attachmentTitle ||
          paperContext?.title ||
          bibliographicAttachment.getDisplayTitle?.() ||
          `PDF ${bibliographicAttachment.id}`,
        mimeType: "application/pdf",
        storedPath,
        paperContext: paperContext || undefined,
        contextItemId: bibliographicAttachment.id,
        itemId: paperContext?.itemId || bibliographicItem?.id,
        attachmentName:
          sanitizeText(
            (
              bibliographicAttachment as unknown as {
                attachmentFilename?: string;
              }
            ).attachmentFilename,
          ) || undefined,
      };
    }

    const uploadedAttachment = findAttachment(params.request.attachments, {
      attachmentId: params.attachmentId,
      name: params.name,
    });
    if (
      uploadedAttachment?.storedPath &&
      uploadedAttachment.category === "pdf"
    ) {
      return {
        source: "upload",
        title: uploadedAttachment.name,
        mimeType: uploadedAttachment.mimeType || "application/pdf",
        storedPath: uploadedAttachment.storedPath,
        attachmentId: uploadedAttachment.id,
        attachmentName: uploadedAttachment.name,
      };
    }

    const activeItem =
      this.zoteroGateway.getItem(params.request.activeItemId) || null;
    const activeContextItem =
      this.zoteroGateway.getActiveContextItem(activeItem);
    if (isPdfAttachment(activeContextItem)) {
      const activePdfItem = activeContextItem as Zotero.Item;
      const paperContext =
        this.pdfService.getPaperContextForItem(activeContextItem);
      const storedPath = getPdfPath(activeContextItem);
      if (!storedPath) {
        throw new Error("Could not access the active Zotero PDF file path");
      }
      return {
        source: "library",
        title:
          paperContext?.attachmentTitle ||
          paperContext?.title ||
          activePdfItem.getDisplayTitle?.() ||
          `PDF ${activePdfItem.id}`,
        mimeType: "application/pdf",
        storedPath,
        paperContext: paperContext || undefined,
        contextItemId: activePdfItem.id,
        itemId: paperContext?.itemId,
        attachmentName:
          sanitizeText(
            (activePdfItem as unknown as { attachmentFilename?: string })
              .attachmentFilename,
          ) || undefined,
      };
    }

    throw new Error(
      "Could not resolve a PDF target from the current request. Provide a paper context, PDF attachment, or active Zotero PDF.",
    );
  }

  async searchPages(params: SearchPdfPagesParams): Promise<{
    target: ResolvedPdfTarget;
    pages: PdfPageCandidate[];
    explicitSelection: boolean;
  }> {
    const savedTabId = getLastKnownSelectedTabId();
    try {
      const target = await this.resolveTarget(params);
      const explicitPages =
        Array.isArray(params.pages) && params.pages.length
          ? Array.from(new Set(params.pages))
              .filter((entry) => Number.isFinite(entry) && entry >= 0)
              .map((entry) => Math.floor(entry))
              .sort((left, right) => left - right)
          : [];
      if (explicitPages.length) {
        return {
          target,
          pages: explicitPages.map((pageIndex) => ({
            pageIndex,
            pageLabel: `${pageIndex + 1}`,
            score: 1,
            reason: "User requested this page explicitly.",
          })),
          explicitSelection: true,
        };
      }
      if (target.source !== "library" || !target.contextItemId) {
        throw new Error(
          "Automatic page search currently works with Zotero library PDFs. For uploaded PDFs, use whole-document PDF input on a Responses-capable model or ask for explicit pages.",
        );
      }
      const reader = await openReaderForItem(target.contextItemId);
      if (!reader) {
        throw new Error(
          "Could not open the Zotero PDF reader for this attachment",
        );
      }
      const cache = await warmPageTextCache(reader);
      const pages = cache?.pages || [];
      if (!pages.length) {
        throw new Error("Could not read page text from this PDF");
      }
      const tokens = extractSearchTokens(params.question);
      const mode = params.mode || "general";
      const scored = pages
        .map((page) => {
          const text = sanitizeText(page.text).toLowerCase();
          let score = 0;
          for (const token of tokens) {
            if (!token) continue;
            if (text.includes(token)) score += 2;
          }
          if (
            mode === "figure" &&
            /\b(fig|figure|panel|diagram|plot|chart)\b/.test(text)
          ) {
            score += 3;
          }
          if (
            mode === "equation" &&
            /\b(eq|equation|theorem|proof|formula)\b/.test(text)
          ) {
            score += 3;
          }
          if (score <= 0 && page.pageIndex < 2) {
            score += 0.5;
          }
          return {
            pageIndex: page.pageIndex,
            pageLabel: getPageLabel(page.pageIndex, page.pageLabel),
            score,
            reason:
              score > 0
                ? `Matched ${Math.max(1, Math.floor(score / 2))} relevant signal${
                    score < 3 ? "" : "s"
                  } from the question.`
                : "Fallback page because no strong match was found.",
            excerpt: sanitizeText(page.text).slice(0, 220),
          };
        })
        .sort(
          (left, right) =>
            right.score - left.score || left.pageIndex - right.pageIndex,
        );
      const topK = Math.max(1, Math.min(6, Math.floor(params.topK || 3)));
      return {
        target,
        pages: scored.slice(0, topK),
        explicitSelection: false,
      };
    } finally {
      restoreNonReaderTab(savedTabId);
    }
  }

  async readPageTexts(params: PreparePdfPagesParams): Promise<{
    target: ResolvedPdfTarget;
    pages: Array<{
      pageIndex: number;
      pageLabel: string;
      text: string;
    }>;
  }> {
    const target = await this.resolveTarget(params);
    if (target.source !== "library" || !target.contextItemId) {
      throw new Error(
        "Text-only page reads are currently supported for Zotero library PDFs.",
      );
    }
    const basePages = Array.from(new Set(params.pages))
      .filter((entry) => Number.isFinite(entry) && entry >= 0)
      .map((entry) => Math.floor(entry))
      .sort((left, right) => left - right);
    if (!basePages.length) {
      throw new Error("At least one PDF page is required");
    }
    const neighborPages = Number.isFinite(params.neighborPages)
      ? Math.max(0, Math.min(1, Math.floor(params.neighborPages as number)))
      : 0;
    const allPages = new Set<number>();
    for (const pageIndex of basePages) {
      allPages.add(pageIndex);
      for (let offset = 1; offset <= neighborPages; offset += 1) {
        allPages.add(Math.max(0, pageIndex - offset));
        allPages.add(pageIndex + offset);
      }
    }
    const orderedPages = Array.from(allPages).sort(
      (left, right) => left - right,
    );
    const textCache = await warmPageTextCacheForAttachment(
      target.contextItemId,
    );
    const textPages = textCache?.pages || [];
    if (!textPages.length) {
      throw new Error("Could not read page text from this PDF");
    }
    const textByPageIndex = new Map(
      textPages.map((page) => [page.pageIndex, page]),
    );
    return {
      target,
      pages: orderedPages.map((pageIndex) => {
        const entry = textByPageIndex.get(pageIndex);
        return {
          pageIndex,
          pageLabel: getPageLabel(pageIndex, entry?.pageLabel),
          text: sanitizeText(entry?.text),
        };
      }),
    };
  }

  async preparePagesForModel(params: PreparePdfPagesParams): Promise<{
    target: ResolvedPdfTarget;
    pages: Array<{
      pageIndex: number;
      pageLabel: string;
      imagePath: string;
      contentHash: string;
    }>;
    artifacts: AgentToolArtifact[];
    pageTexts: Record<number, string>;
  }> {
    const savedTabId = getLastKnownSelectedTabId();
    try {
      return await this._preparePagesForModelInner(params);
    } finally {
      restoreNonReaderTab(savedTabId);
    }
  }

  async preparePagesForFigureExtraction(
    params: PreparePdfFigurePagesParams,
  ): Promise<{
    target: ResolvedPdfTarget;
    pages: PdfFigurePageRender[];
  }> {
    const savedTabId = getLastKnownSelectedTabId();
    try {
      const target = await this.resolveTarget(params);
      if (target.source !== "library" || !target.contextItemId) {
        throw new Error(
          "Figure extraction is currently supported for Zotero library PDFs.",
        );
      }
      const pages = Array.from(new Set(params.pages))
        .filter((entry) => Number.isFinite(entry) && entry >= 0)
        .map((entry) => Math.floor(entry))
        .sort((left, right) => left - right);
      if (!pages.length) throw new Error("At least one PDF page is required");
      const reader = await openReaderForItem(target.contextItemId, {
        pageIndex: pages[0],
        pageLabel: `${pages[0] + 1}`,
      });
      if (!reader) {
        throw new Error(
          "Could not open the Zotero PDF reader for this attachment",
        );
      }
      const app = await waitForPdfDocument(reader);
      if (!app?.pdfDocument) {
        throw new Error(
          "Could not access the PDF document for figure extraction",
        );
      }
      const canvasDoc =
        getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
      if (!canvasDoc) {
        throw new Error("No document is available for PDF figure extraction");
      }
      const pdfDocument = unwrapWrappedJsObject(
        app.pdfDocument as {
          getPage?: (pageNumber: number) => Promise<unknown>;
        },
      );
      if (typeof pdfDocument?.getPage !== "function") {
        throw new Error("Could not access the PDF document page loader");
      }
      const scale = Number.isFinite(params.renderScale)
        ? Math.max(0.5, Math.min(3, params.renderScale as number))
        : 1.8;
      const renderedPages: PdfFigurePageRender[] = [];
      for (const pageIndex of pages) {
        const pageLabel = `${pageIndex + 1}`;
        await navigateReaderToPage(reader, pageIndex, pageLabel);
        const pdfPage = resolveRenderablePdfPage(
          await pdfDocument.getPage(pageIndex + 1),
        );
        if (!pdfPage) {
          throw new Error(
            `Could not access a renderable PDF.js page for page ${pageIndex + 1}`,
          );
        }
        let renderedPage: PdfFigurePageRender | null = null;
        let renderError = "";
        try {
          renderedPage = await renderPdfFigurePageToCanvas({
            pdfPage,
            canvasDoc,
            pageIndex,
            pageLabel,
            scale,
          });
        } catch (error) {
          renderError = error instanceof Error ? error.message : String(error);
        }
        if (!renderedPage) {
          throw new Error(
            `Could not render page ${pageIndex + 1} for figure extraction${
              renderError ? `: ${renderError}` : ""
            }`,
          );
        }
        renderedPages.push(renderedPage);
      }
      return { target, pages: renderedPages };
    } finally {
      restoreNonReaderTab(savedTabId);
    }
  }

  private async _preparePagesForModelInner(
    params: PreparePdfPagesParams,
  ): Promise<{
    target: ResolvedPdfTarget;
    pages: Array<{
      pageIndex: number;
      pageLabel: string;
      imagePath: string;
      contentHash: string;
    }>;
    artifacts: AgentToolArtifact[];
    pageTexts: Record<number, string>;
  }> {
    const target = await this.resolveTarget(params);
    if (target.source !== "library" || !target.contextItemId) {
      throw new Error(
        "Rendering PDF pages is currently supported for Zotero library PDFs. Uploaded PDFs can be sent as whole files on supported models instead.",
      );
    }
    const basePages = Array.from(new Set(params.pages))
      .filter((entry) => Number.isFinite(entry) && entry >= 0)
      .map((entry) => Math.floor(entry))
      .sort((left, right) => left - right);
    if (!basePages.length) {
      throw new Error("At least one PDF page is required");
    }
    const neighborPages = Number.isFinite(params.neighborPages)
      ? Math.max(0, Math.min(1, Math.floor(params.neighborPages as number)))
      : 0;
    const allPages = new Set<number>();
    for (const pageIndex of basePages) {
      allPages.add(pageIndex);
      for (let offset = 1; offset <= neighborPages; offset += 1) {
        allPages.add(Math.max(0, pageIndex - offset));
        allPages.add(pageIndex + offset);
      }
    }
    const orderedPages = Array.from(allPages).sort(
      (left, right) => left - right,
    );
    const reader = await openReaderForItem(target.contextItemId, {
      pageIndex: orderedPages[0],
      pageLabel: `${orderedPages[0] + 1}`,
    });
    if (!reader) {
      throw new Error(
        "Could not open the Zotero PDF reader for this attachment",
      );
    }
    const app = await waitForPdfDocument(reader);
    if (!app?.pdfDocument) {
      throw new Error("Could not access the PDF document for page rendering");
    }
    const preparedPages: Array<{
      pageIndex: number;
      pageLabel: string;
      imagePath: string;
      contentHash: string;
    }> = [];
    const artifacts: AgentToolArtifact[] = [];

    for (const pageIndex of orderedPages) {
      const pageLabel = `${pageIndex + 1}`;
      await navigateReaderToPage(reader, pageIndex, pageLabel);
      let bytes = await captureRenderedReaderPage(app, reader, pageIndex);
      if (!bytes) {
        const canvasDoc =
          getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
        if (!canvasDoc) {
          throw new Error("No document is available for PDF page rendering");
        }
        const pdfDocument = unwrapWrappedJsObject(
          app.pdfDocument as {
            getPage?: (pageNumber: number) => Promise<unknown>;
          },
        );
        if (typeof pdfDocument?.getPage !== "function") {
          throw new Error("Could not access the PDF document page loader");
        }
        const pdfPage = resolveRenderablePdfPage(
          await pdfDocument.getPage(pageIndex + 1),
        );
        if (!pdfPage) {
          throw new Error(
            `Could not access a renderable PDF.js page for page ${pageIndex + 1}`,
          );
        }
        const viewport = pdfPage.getViewport({ scale: 1.8 });
        const canvas = canvasDoc.createElement("canvas") as HTMLCanvasElement;
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not create a canvas for PDF rendering");
        }
        const renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
        });
        if (
          renderTask &&
          typeof renderTask === "object" &&
          "promise" in renderTask &&
          renderTask.promise
        ) {
          await renderTask.promise;
        } else if (
          renderTask &&
          (typeof renderTask === "object" ||
            typeof renderTask === "function") &&
          "then" in renderTask &&
          typeof renderTask.then === "function"
        ) {
          await renderTask;
        }
        bytes = await canvasToBytes(canvas);
      }
      const persisted = await persistAttachmentBlob(
        `${sanitizeText(target.attachmentName || target.title || "pdf")}-page-${pageIndex + 1}.png`,
        bytes,
      );
      preparedPages.push({
        pageIndex,
        pageLabel,
        imagePath: persisted.storedPath,
        contentHash: persisted.contentHash,
      });
      artifacts.push({
        kind: "image",
        mimeType: "image/png",
        storedPath: persisted.storedPath,
        contentHash: persisted.contentHash,
        title: `${target.title} — page ${pageLabel}`,
        pageIndex,
        pageLabel,
        paperContext: target.paperContext,
      });
    }

    const pageTexts: Record<number, string> = {};
    try {
      const textCache = await warmPageTextCache(reader);
      const textPages = textCache?.pages || [];
      for (const pageIndex of orderedPages) {
        const entry = textPages.find(
          (p: { pageIndex: number; text: string }) => p.pageIndex === pageIndex,
        );
        if (entry?.text) {
          pageTexts[pageIndex] = sanitizeText(entry.text);
        }
      }
    } catch {
      // non-fatal — images are the primary source
    }

    return {
      target,
      pages: preparedPages,
      artifacts,
      pageTexts,
    };
  }

  async captureActiveView(params: {
    request: AgentRuntimeRequest;
    neighborPages?: number;
  }): Promise<{
    target: ResolvedPdfTarget;
    capturedPage: {
      pageIndex: number;
      pageLabel: string;
      imagePath: string;
      contentHash: string;
    };
    artifacts: AgentToolArtifact[];
    pageText: string;
  }> {
    const reader = getActiveReaderForSelectedTab();
    if (!reader) {
      throw new Error(
        "No active PDF reader is open. Please open a PDF in the Zotero reader first.",
      );
    }
    const app = await waitForPdfDocument(reader, 1500);
    if (!app?.pdfDocument) {
      throw new Error(
        "Could not access the PDF document in the active reader.",
      );
    }

    const rawPageNumber = Number(
      app?.pdfViewer?.currentPageNumber ||
        app?.pdfViewer?.currentPageLabel ||
        app?.page ||
        1,
    );
    const currentPageIndex = Math.max(
      0,
      Number.isFinite(rawPageNumber) ? Math.floor(rawPageNumber) - 1 : 0,
    );

    const readerItemId = getReaderItemId(reader);
    if (!readerItemId) {
      throw new Error(
        "Could not identify the active PDF item from the reader.",
      );
    }
    const target = await this.resolveTarget({
      request: params.request,
      contextItemId: readerItemId,
    });

    const neighborPages = Number.isFinite(params.neighborPages)
      ? Math.max(0, Math.min(1, Math.floor(params.neighborPages as number)))
      : 0;
    const allPages = new Set<number>();
    allPages.add(currentPageIndex);
    for (let offset = 1; offset <= neighborPages; offset += 1) {
      allPages.add(Math.max(0, currentPageIndex - offset));
      allPages.add(currentPageIndex + offset);
    }
    const orderedPages = Array.from(allPages).sort(
      (left, right) => left - right,
    );

    const preparedPages: Array<{
      pageIndex: number;
      pageLabel: string;
      imagePath: string;
      contentHash: string;
    }> = [];
    const artifacts: AgentToolArtifact[] = [];

    for (const pageIndex of orderedPages) {
      const pageLabel = `${pageIndex + 1}`;
      await navigateReaderToPage(reader, pageIndex, pageLabel);
      let bytes = await captureRenderedReaderPage(app, reader, pageIndex);
      if (!bytes) {
        const canvasDoc =
          getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
        if (!canvasDoc) {
          throw new Error("No document available for PDF page rendering");
        }
        const pdfDocument = unwrapWrappedJsObject(
          app.pdfDocument as {
            getPage?: (pageNumber: number) => Promise<unknown>;
          },
        );
        if (typeof pdfDocument?.getPage !== "function") {
          throw new Error("Could not access the PDF document page loader");
        }
        const pdfPage = resolveRenderablePdfPage(
          await pdfDocument.getPage(pageIndex + 1),
        );
        if (!pdfPage) {
          throw new Error(
            `Could not access a renderable PDF.js page for page ${pageIndex + 1}`,
          );
        }
        const viewport = pdfPage.getViewport({ scale: 1.8 });
        const canvas = canvasDoc.createElement("canvas") as HTMLCanvasElement;
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not create a canvas for PDF rendering");
        }
        const renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
        });
        if (
          renderTask &&
          typeof renderTask === "object" &&
          "promise" in renderTask &&
          renderTask.promise
        ) {
          await renderTask.promise;
        } else if (
          renderTask &&
          (typeof renderTask === "object" ||
            typeof renderTask === "function") &&
          "then" in renderTask &&
          typeof renderTask.then === "function"
        ) {
          await renderTask;
        }
        bytes = await canvasToBytes(canvas);
      }
      const persisted = await persistAttachmentBlob(
        `${sanitizeText(target.attachmentName || target.title || "pdf")}-page-${pageIndex + 1}.png`,
        bytes,
      );
      preparedPages.push({
        pageIndex,
        pageLabel,
        imagePath: persisted.storedPath,
        contentHash: persisted.contentHash,
      });
      artifacts.push({
        kind: "image",
        mimeType: "image/png",
        storedPath: persisted.storedPath,
        contentHash: persisted.contentHash,
        title: `${target.title} — page ${pageLabel}`,
        pageIndex,
        pageLabel,
        paperContext: target.paperContext,
      });
    }

    // Extract text layer for current page so callers can ground the model
    // even when the image isn't rendered by the model provider.
    let pageText = "";
    try {
      const textCache = await warmPageTextCache(reader);
      const entry = textCache?.pages.find(
        (p: { pageIndex: number; text: string }) =>
          p.pageIndex === currentPageIndex,
      );
      pageText = sanitizeText(entry?.text ?? "");
    } catch {
      // non-fatal — image is the primary source
    }

    const capturedPage =
      preparedPages.find((page) => page.pageIndex === currentPageIndex) ||
      preparedPages[0];
    return { target, capturedPage, artifacts, pageText };
  }

  async preparePdfFileForModel(params: PreparePdfFileParams): Promise<{
    target: ResolvedPdfTarget;
    artifact: AgentToolArtifact;
  }> {
    const target = await this.resolveTarget(params);
    const stored = await ensureAttachmentBlobFromPath(
      target.storedPath,
      target.attachmentName || `${target.title}.pdf`,
    );
    return {
      target: {
        ...target,
        storedPath: stored.storedPath,
      },
      artifact: {
        kind: "file_ref",
        mimeType: target.mimeType || "application/pdf",
        storedPath: stored.storedPath,
        contentHash: stored.contentHash,
        name: target.attachmentName || `${target.title}.pdf`,
        title: target.title,
        paperContext: target.paperContext,
      },
    };
  }
}

/**
 * Render all pages of a Zotero PDF attachment as PNG images.
 * Opens the PDF in a reader tab, renders up to maxPages, persists each as a
 * blob, then restores the previous tab. Intended for sending PDF content to
 * vision-only models that lack native PDF support.
 */
export async function renderAllPdfPages(
  contextItemId: number,
  opts?: { maxPages?: number },
): Promise<{ storedPath: string; contentHash: string; pageIndex: number }[]> {
  const maxPages = opts?.maxPages ?? 200;
  const savedTabId = getLastKnownSelectedTabId();
  try {
    const reader = await openReaderForItem(contextItemId, {
      pageIndex: 0,
      pageLabel: "1",
    });
    if (!reader) throw new Error("Could not open PDF reader");
    const app = await waitForPdfDocument(reader);
    if (!app?.pdfDocument) throw new Error("Could not load PDF document");
    const pdfDocument = unwrapWrappedJsObject(
      app.pdfDocument as {
        numPages?: number;
        getPage?: (n: number) => Promise<unknown>;
      },
    );
    const rawCount = Number(
      pdfDocument?.numPages ??
        (app as { pdfDocument?: { numPages?: number } })?.pdfDocument
          ?.numPages ??
        0,
    );
    const numPages = Math.min(
      maxPages,
      Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0,
    );
    if (numPages <= 0) throw new Error("PDF has no pages");

    const results: {
      storedPath: string;
      contentHash: string;
      pageIndex: number;
    }[] = [];
    for (let i = 0; i < numPages; i++) {
      await navigateReaderToPage(reader, i, `${i + 1}`);
      let bytes = await captureRenderedReaderPage(app, reader, i);
      if (!bytes) {
        // Fallback: render via PDF.js API directly
        const canvasDoc =
          getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
        if (canvasDoc && typeof pdfDocument?.getPage === "function") {
          const pdfPage = resolveRenderablePdfPage(
            await pdfDocument.getPage(i + 1),
          );
          if (pdfPage) {
            const viewport = pdfPage.getViewport({ scale: 1.8 });
            const canvas = canvasDoc.createElement(
              "canvas",
            ) as HTMLCanvasElement;
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext("2d");
            if (context) {
              const renderTask = pdfPage.render({
                canvasContext: context,
                viewport,
              });
              if (
                renderTask &&
                typeof renderTask === "object" &&
                "promise" in renderTask &&
                renderTask.promise
              ) {
                await renderTask.promise;
              } else if (
                renderTask &&
                (typeof renderTask === "object" ||
                  typeof renderTask === "function") &&
                "then" in renderTask &&
                typeof renderTask.then === "function"
              ) {
                await renderTask;
              }
              bytes = await canvasToBytes(canvas);
            }
          }
        }
      }
      if (!bytes) continue; // skip unrenderable pages
      const persisted = await persistAttachmentBlob(`page-${i + 1}.png`, bytes);
      results.push({
        storedPath: persisted.storedPath,
        contentHash: persisted.contentHash,
        pageIndex: i,
      });
    }
    return results;
  } finally {
    restoreNonReaderTab(savedTabId);
  }
}
