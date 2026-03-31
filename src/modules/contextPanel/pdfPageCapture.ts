import { getActiveReaderForSelectedTab } from "./contextResolution";

// ── Zotero reader introspection helpers ──────────────────────────────────────
// These mirror the equivalent private helpers in agent/services/pdfPageService
// but live here so contextPanel code can use them without importing agent code.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapWrappedJsObject<T>(value: T): T {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  try {
    return (value as T & { wrappedJSObject?: T }).wrappedJSObject || value;
  } catch {
    return value;
  }
}

type RenderablePdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }) => unknown;
};

function resolveRenderablePdfPage(value: unknown): RenderablePdfPage | null {
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
      const rec = candidate as Record<string, unknown>;
      queue.push(rec.pdfPage, rec._pdfPage, rec.page, rec.pageProxy);
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    } catch {
      // cross-origin access may throw — ignore
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  canvases: HTMLCanvasElement[],
): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const canvas of canvases) {
    const area = (Number(canvas?.width) || 0) * (Number(canvas?.height) || 0);
    if (area > bestArea) {
      best = canvas;
      bestArea = area;
    }
  }
  return best;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPageViewCanvas(app: any, pageIndex: number): HTMLCanvasElement | null {
  const pageView = unwrapWrappedJsObject(
    app?.pdfViewer?.getPageView?.(pageIndex) ||
      app?.pdfViewer?._pages?.[pageIndex] ||
      null,
  ) as { canvas?: unknown; div?: Element | null } | null;
  if (!pageView) return null;
  const directCanvas = unwrapWrappedJsObject(pageView.canvas);
  if (isCanvasElement(directCanvas)) return directCanvas;
  if (pageView.div) {
    return pickLargestCanvas(
      Array.from(pageView.div.querySelectorAll("canvas")) as HTMLCanvasElement[],
    );
  }
  return null;
}

function findRenderedPageCanvas(
  doc: Document,
  pageNumber: number,
): HTMLCanvasElement | null {
  for (const selector of [
    `.page[data-page-number="${pageNumber}"] canvas`,
    `.page[data-page-number="${pageNumber}"] .canvasWrapper canvas`,
    `[data-page-number="${pageNumber}"] canvas`,
  ]) {
    const match = pickLargestCanvas(
      Array.from(doc.querySelectorAll(selector)) as HTMLCanvasElement[],
    );
    if (match) return match;
  }
  return null;
}

async function waitForRenderedPageCanvas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
  timeoutMs = 1800,
): Promise<HTMLCanvasElement | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fromView = getPageViewCanvas(app, pageNumber - 1);
    if (fromView && fromView.width > 0 && fromView.height > 0) return fromView;
    const doc = getReaderDocument(reader);
    if (doc) {
      const fromDom = findRenderedPageCanvas(doc, pageNumber);
      if (fromDom && fromDom.width > 0 && fromDom.height > 0) return fromDom;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

/**
 * Captures the currently visible PDF page in the active Zotero reader as a
 * PNG data URL, or returns null if no PDF is open / rendering fails.
 *
 * The result is the same format as screenshots and can be pushed directly into
 * `selectedImageCache` to be sent with the next message.
 */
export async function captureCurrentPdfPage(): Promise<string | null> {
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
  const pageIndex = Math.max(
    0,
    Number.isFinite(rawPageNumber) ? Math.floor(rawPageNumber) - 1 : 0,
  );
  const pageNumber = pageIndex + 1;

  // Fast path: grab the already-rendered canvas.
  const rendered = await waitForRenderedPageCanvas(app, reader, pageNumber);
  if (rendered && rendered.width > 0 && rendered.height > 0) {
    try {
      return rendered.toDataURL("image/png");
    } catch {
      // Canvas may be tainted — fall through to PDF.js re-render.
    }
  }

  // Fallback: render the page off-screen via the PDF.js API.
  const canvasDoc =
    getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
  if (!canvasDoc) return null;

  const pdfDocument = unwrapWrappedJsObject(
    app.pdfDocument as { getPage?: (n: number) => Promise<unknown> },
  );
  if (
    typeof (pdfDocument as { getPage?: unknown }).getPage !== "function"
  ) {
    return null;
  }
  const rawPage = await (
    pdfDocument as { getPage: (n: number) => Promise<unknown> }
  ).getPage(pageNumber);
  const pdfPage = resolveRenderablePdfPage(rawPage);
  if (!pdfPage) return null;

  const viewport = pdfPage.getViewport({ scale: 1.8 });
  const offscreen = canvasDoc.createElement("canvas") as HTMLCanvasElement;
  offscreen.width = Math.max(1, Math.ceil(viewport.width));
  offscreen.height = Math.max(1, Math.ceil(viewport.height));
  const context = offscreen.getContext("2d") as CanvasRenderingContext2D | null;
  if (!context) return null;

  const renderTask = pdfPage.render({ canvasContext: context, viewport });
  if (
    renderTask &&
    typeof renderTask === "object" &&
    "promise" in renderTask &&
    (renderTask as { promise: Promise<unknown> }).promise
  ) {
    await (renderTask as { promise: Promise<unknown> }).promise;
  } else if (
    renderTask &&
    typeof (renderTask as { then?: unknown }).then === "function"
  ) {
    await renderTask;
  }

  return offscreen.toDataURL("image/png");
}

/**
 * Returns the total number of pages in the active PDF, or 0 if no PDF is open.
 */
export function getPdfPageCount(): number {
  const reader = getActiveReaderForSelectedTab();
  if (!reader) return 0;

  const app = getPdfViewerApplication(reader);
  if (!app?.pdfDocument) return 0;

  const pdfDocument = unwrapWrappedJsObject(
    app.pdfDocument as { numPages?: number },
  );
  const rawCount = Number(
    pdfDocument?.numPages ??
      (app as { pdfDocument?: { numPages?: number } })?.pdfDocument?.numPages ??
      0,
  );
  return Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
}

/**
 * Parses a page range string like "1-5, 8, 12-15" into a sorted, deduplicated
 * array of 1-indexed page numbers, clamped to [1, maxPage].
 */
export function parsePageRanges(input: string, maxPage: number): number[] {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeParts = trimmed.split("-").map((s) => s.trim());
    if (rangeParts.length === 2) {
      const start = parseInt(rangeParts[0], 10);
      const end = parseInt(rangeParts[1], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const lo = Math.max(1, Math.min(start, end));
      const hi = Math.min(maxPage, Math.max(start, end));
      for (let i = lo; i <= hi; i++) pages.add(i);
    } else {
      const num = parseInt(trimmed, 10);
      if (Number.isFinite(num) && num >= 1 && num <= maxPage) pages.add(num);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Navigates the reader to a specific page index (0-based).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function navigateReaderToPage(reader: any, pageIndex: number): Promise<boolean> {
  if (typeof reader?.navigate !== "function") return false;
  const idx = Math.max(0, Math.floor(pageIndex));
  try {
    await reader.navigate({ pageIndex: idx, pageLabel: `${idx + 1}` });
    return true;
  } catch {
    try {
      await reader.navigate({ pageIndex: idx });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Captures the rendered canvas for a given page (1-indexed) as a PNG data URL.
 * Navigates the reader to that page, waits for the canvas to render, and grabs it.
 * Falls back to off-screen PDF.js rendering if the canvas grab fails.
 */
async function capturePageByNavigation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
): Promise<string | null> {
  const pageIndex = pageNumber - 1;
  await navigateReaderToPage(reader, pageIndex);

  // Fast path: grab the rendered canvas
  const rendered = await waitForRenderedPageCanvas(app, reader, pageNumber);
  if (rendered && rendered.width > 0 && rendered.height > 0) {
    try {
      return rendered.toDataURL("image/png");
    } catch {
      // Canvas may be tainted — try copying to a temp canvas
      const doc = rendered.ownerDocument || getReaderDocument(reader);
      if (doc) {
        const temp = doc.createElement("canvas") as HTMLCanvasElement;
        temp.width = rendered.width;
        temp.height = rendered.height;
        const ctx = temp.getContext("2d") as CanvasRenderingContext2D | null;
        if (ctx) {
          ctx.drawImage(rendered, 0, 0);
          try {
            return temp.toDataURL("image/png");
          } catch {
            // fall through to PDF.js fallback
          }
        }
      }
    }
  }

  // Fallback: render off-screen via PDF.js API
  const canvasDoc =
    getReaderDocument(reader) || Zotero.getMainWindow?.()?.document;
  if (!canvasDoc) return null;

  const pdfDocument = unwrapWrappedJsObject(
    app.pdfDocument as { getPage?: (n: number) => Promise<unknown> },
  );
  if (typeof (pdfDocument as { getPage?: unknown }).getPage !== "function") {
    return null;
  }
  try {
    const rawPage = await (
      pdfDocument as { getPage: (n: number) => Promise<unknown> }
    ).getPage(pageNumber);
    const pdfPage = resolveRenderablePdfPage(rawPage);
    if (!pdfPage) return null;

    const viewport = pdfPage.getViewport({ scale: 1.8 });
    const offscreen = canvasDoc.createElement("canvas") as HTMLCanvasElement;
    offscreen.width = Math.max(1, Math.ceil(viewport.width));
    offscreen.height = Math.max(1, Math.ceil(viewport.height));
    const context = offscreen.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) return null;

    const renderTask = pdfPage.render({ canvasContext: context, viewport });
    if (
      renderTask &&
      typeof renderTask === "object" &&
      "promise" in renderTask &&
      (renderTask as { promise: Promise<unknown> }).promise
    ) {
      await (renderTask as { promise: Promise<unknown> }).promise;
    } else if (
      renderTask &&
      typeof (renderTask as { then?: unknown }).then === "function"
    ) {
      await renderTask;
    }

    return offscreen.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Captures specific PDF pages (1-indexed) as high-quality PNG data URLs.
 * Navigates the reader to each page and captures the rendered canvas,
 * then restores the original page position.
 */
export async function capturePdfPages(
  pageNumbers: number[],
  opts?: { onProgress?: (current: number, total: number) => void },
): Promise<string[]> {
  if (!pageNumbers.length) return [];

  const reader = getActiveReaderForSelectedTab();
  if (!reader) return [];

  const app = getPdfViewerApplication(reader);
  if (!app?.pdfDocument) return [];

  // Remember original page so we can restore it after
  const originalPageNumber = Number(
    app?.pdfViewer?.currentPageNumber ||
      app?.pdfViewer?.currentPageLabel ||
      app?.page ||
      1,
  );

  const results: string[] = [];
  const total = pageNumbers.length;
  try {
    for (let idx = 0; idx < total; idx++) {
      opts?.onProgress?.(idx + 1, total);
      const dataUrl = await capturePageByNavigation(app, reader, pageNumbers[idx]);
      if (dataUrl) {
        results.push(dataUrl);
      }
    }
  } finally {
    // Restore original page position
    const restoreIndex = Math.max(0, Math.floor(originalPageNumber) - 1);
    await navigateReaderToPage(reader, restoreIndex);
  }
  return results;
}
