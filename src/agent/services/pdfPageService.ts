import {
  ensureAttachmentBlobFromPath,
  persistAttachmentBlob,
} from "../../modules/contextPanel/attachmentStorage";
import { getActiveReaderForSelectedTab } from "../../modules/contextPanel/contextResolution";
import type {
  ChatAttachment,
  PaperContextRef,
} from "../../modules/contextPanel/types";
import { warmPageTextCache } from "../../modules/contextPanel/livePdfSelectionLocator";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";
import { PdfService, resolveContextItemFromPaperContext } from "./pdfService";
import { ZoteroGateway } from "./zoteroGateway";
import { findAttachment } from "../tools/shared";

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

type PreparePdfFileParams = ResolvePdfTargetInput & {
  request: AgentRuntimeRequest;
};

type RenderablePdfPage = {
  getViewport: (params: { scale: number }) => {
    width: number;
    height: number;
  };
  render: (params: {
    canvasContext: unknown;
    viewport: unknown;
  }) =>
    | Promise<unknown>
    | {
        promise?: Promise<unknown>;
      };
};

function sanitizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function unwrapWrappedJsObject<T>(value: T): T {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  try {
    return (
      (value as T & { wrappedJSObject?: T }).wrappedJSObject || value
    );
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
      typeof (candidate as Partial<RenderablePdfPage>).getViewport === "function" &&
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
    const unique = Array.from(new Set(pageIndexes)).sort((left, right) => left - right);
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

function isPdfAttachment(
  item: Zotero.Item | null | undefined,
): boolean {
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
        candidate?._iframe?.contentWindow?.wrappedJSObject?.PDFViewerApplication ||
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
      await navigateReaderToPage(activeReader, location.pageIndex, location.pageLabel);
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
            ...(location.pageLabel ? { pageLabel: sanitizeText(location.pageLabel) } : {}),
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
  ) as
    | {
        canvas?: unknown;
        div?: Element | null;
      }
    | null;
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
    if (pageViewCanvas && pageViewCanvas.width > 0 && pageViewCanvas.height > 0) {
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
    const context = tempCanvas.getContext("2d") as CanvasRenderingContext2D | null;
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

export function isExplicitWholeDocumentRequest(text: string | undefined): boolean {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return false;
  return /\b(entire|whole|full)\s+(pdf|paper|document)\b/.test(normalized);
}

export class PdfPageService {
  constructor(
    private readonly pdfService: PdfService,
    private readonly zoteroGateway: ZoteroGateway,
  ) {}

  getUserExplicitPageSelection(
    request: AgentRuntimeRequest,
  ): ParsedPageSelection | null {
    return parsePageSelectionText(request.userText);
  }

  async resolveTarget(
    params: ResolvePdfTargetInput & { request: AgentRuntimeRequest },
  ): Promise<ResolvedPdfTarget> {
    if (params.paperContext) {
      const contextItem = resolveContextItemFromPaperContext(params.paperContext);
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
      const paperContext = this.pdfService.getPaperContextForItem(contextItemById);
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
      const paperContext =
        this.pdfService.getPaperContextForItem(bibliographicAttachment);
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
            (bibliographicAttachment as unknown as { attachmentFilename?: string })
              .attachmentFilename,
          ) || undefined,
      };
    }

    const uploadedAttachment = findAttachment(params.request.attachments, {
      attachmentId: params.attachmentId,
      name: params.name,
    });
    if (uploadedAttachment?.storedPath && uploadedAttachment.category === "pdf") {
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
    const activeContextItem = this.zoteroGateway.getActiveContextItem(activeItem);
    if (isPdfAttachment(activeContextItem)) {
      const activePdfItem = activeContextItem as Zotero.Item;
      const paperContext = this.pdfService.getPaperContextForItem(activeContextItem);
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
      throw new Error("Could not open the Zotero PDF reader for this attachment");
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
        if (mode === "figure" && /\b(fig|figure|panel|diagram|plot|chart)\b/.test(text)) {
          score += 3;
        }
        if (mode === "equation" && /\b(eq|equation|theorem|proof|formula)\b/.test(text)) {
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
      .sort((left, right) => right.score - left.score || left.pageIndex - right.pageIndex);
    const topK = Math.max(1, Math.min(6, Math.floor(params.topK || 3)));
    return {
      target,
      pages: scored.slice(0, topK),
      explicitSelection: false,
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
    const orderedPages = Array.from(allPages).sort((left, right) => left - right);
    const reader = await openReaderForItem(target.contextItemId, {
      pageIndex: orderedPages[0],
      pageLabel: `${orderedPages[0] + 1}`,
    });
    if (!reader) {
      throw new Error("Could not open the Zotero PDF reader for this attachment");
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
          getReaderDocument(reader) ||
          Zotero.getMainWindow?.()?.document;
        if (!canvasDoc) {
          throw new Error("No document is available for PDF page rendering");
        }
        const pdfDocument = unwrapWrappedJsObject(
          app.pdfDocument as { getPage?: (pageNumber: number) => Promise<unknown> },
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
          (typeof renderTask === "object" || typeof renderTask === "function") &&
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

    return {
      target,
      pages: preparedPages,
      artifacts,
    };
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
