import { getActiveReaderForSelectedTab } from "./contextResolution";

export const PDF_PAGE_MODEL_RENDER_SCALE = 2.6;
const PDF_PAGE_MODEL_RETRY_SCALE = 2.0;

export function getPdfPageRenderScaleForCount(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return PDF_PAGE_MODEL_RENDER_SCALE;
  if (total >= 24) return 2.0;
  if (total >= 12) return 2.2;
  if (total >= 6) return 2.4;
  return PDF_PAGE_MODEL_RENDER_SCALE;
}

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
  view?: number[];
  rotate?: number;
  userUnit?: number;
  pageInfo?: { view?: number[] };
  _pageInfo?: { view?: number[] };
  getViewport: (...args: unknown[]) => unknown;
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }) => unknown;
  cleanup?: () => void;
};

type ViewportLike = {
  viewBox?: number[];
  scale?: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  transform?: number[];
  width?: number;
  height?: number;
  rawDims?: {
    pageWidth: number;
    pageHeight: number;
    pageX: number;
    pageY: number;
  };
  userUnit?: number;
  dontFlip?: boolean;
};

type CloneIntoFn = <T extends object>(
  value: T,
  targetScope: unknown,
  options?: {
    cloneFunctions?: boolean;
    wrapReflectors?: boolean;
  },
) => T;

type WindowConstructors = {
  Object?: ObjectConstructor;
  Array?: ArrayConstructor;
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
export function getPdfViewerApplication(reader: any): any | null {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPdfApplicationDocument(app: any, reader: any): Document | null {
  const candidates = [
    app?.pdfViewer?.container?.ownerDocument,
    app?.pdfViewer?._container?.ownerDocument,
    app?.pdfViewer?.viewer?.ownerDocument,
    app?.appConfig?.mainContainer?.ownerDocument,
    app?.appConfig?.viewerContainer?.ownerDocument,
    app?.appConfig?.viewer?.ownerDocument,
    reader?._iframeWindow?.document,
    reader?._iframe?.contentDocument,
    reader?._internalReader?._lastView?._iframeWindow?.document,
  ];

  for (const candidate of candidates) {
    const doc = unwrapWrappedJsObject(candidate) as Document | null;
    if (doc?.createElement && doc?.defaultView) return doc;
  }
  return null;
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
function getPageViewCanvas(
  app: any,
  pageIndex: number,
): HTMLCanvasElement | null {
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
      Array.from(
        pageView.div.querySelectorAll("canvas"),
      ) as HTMLCanvasElement[],
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

function getCloneInto(): CloneIntoFn | undefined {
  const globalWithClone = globalThis as unknown as {
    cloneInto?: CloneIntoFn;
    Components?: { utils?: { cloneInto?: CloneIntoFn } };
  };
  return (
    globalWithClone.cloneInto || globalWithClone.Components?.utils?.cloneInto
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPdfRenderWindow(canvasDoc: Document, reader: any): Window | null {
  try {
    const canvasWindow = unwrapWrappedJsObject(
      canvasDoc.defaultView || null,
    ) as Window | null;
    const iframeWindow = unwrapWrappedJsObject(
      reader?._iframeWindow || null,
    ) as Window | null;
    return canvasWindow || iframeWindow || null;
  } catch {
    return null;
  }
}

function getWindowConstructors(
  win: Window | null | undefined,
): WindowConstructors {
  return (win || null) as unknown as WindowConstructors;
}

function canvasToDataUrl(canvas: HTMLCanvasElement | null): string | null {
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    return canvas.toDataURL("image/png");
  } catch {
    const doc = canvas.ownerDocument || document;
    const temp = doc?.createElement?.("canvas") as HTMLCanvasElement | null;
    if (!temp) return null;
    temp.width = Math.max(1, canvas.width);
    temp.height = Math.max(1, canvas.height);
    const ctx = temp.getContext("2d");
    if (!ctx) {
      temp.width = 0;
      temp.height = 0;
      return null;
    }
    ctx.drawImage(canvas, 0, 0);
    let dataUrl: string | null = null;
    try {
      dataUrl = temp.toDataURL("image/png");
    } catch {
      dataUrl = null;
    }
    temp.width = 0;
    temp.height = 0;
    return dataUrl;
  }
}

function isCanvasLikelyBlank(canvas: HTMLCanvasElement | null): boolean {
  if (!canvas || !canvas.width || !canvas.height) return true;
  try {
    const doc = canvas.ownerDocument || document;
    const sample = doc?.createElement?.("canvas") as HTMLCanvasElement | null;
    if (!sample) return false;
    sample.width = 128;
    sample.height = 128;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      sample.width = 0;
      sample.height = 0;
      return false;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sample.width, sample.height);
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const imageData = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let nonBlankPixels = 0;
    for (let index = 0; index < imageData.length; index += 4) {
      const alpha = imageData[index + 3];
      const red = imageData[index];
      const green = imageData[index + 1];
      const blue = imageData[index + 2];
      if (alpha > 8 && (red < 250 || green < 250 || blue < 250)) {
        nonBlankPixels += 1;
        if (nonBlankPixels > 24) break;
      }
    }
    sample.width = 0;
    sample.height = 0;
    return nonBlankPixels <= 24;
  } catch {
    return false;
  }
}

function isValidViewport(viewport: unknown): viewport is ViewportLike {
  const width = Number((viewport as ViewportLike | null)?.width);
  const height = Number((viewport as ViewportLike | null)?.height);
  return Boolean(
    viewport &&
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0,
  );
}

function getSafeViewport(
  targetLabel: string,
  pdfPage: RenderablePdfPage,
  scale: number,
  renderWindow?: Window | null,
):
  | {
      ok: true;
      viewport: ViewportLike;
      width: number;
      height: number;
      scaleUsed: number;
      mode: string;
    }
  | {
      ok: false;
    } {
  const safeScale =
    Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1.5;
  const safeRotation = Number.isFinite(Number(pdfPage?.rotate))
    ? Number(pdfPage.rotate)
    : 0;
  const cloneIntoFn = getCloneInto();
  const makeViewportOptions = (nextScale: number) => {
    let viewportOptions = {
      scale: nextScale,
      rotation: safeRotation,
      offsetX: 0,
      offsetY: 0,
      dontFlip: false,
    };
    if (renderWindow && typeof cloneIntoFn === "function") {
      try {
        viewportOptions = cloneIntoFn(viewportOptions, renderWindow, {
          cloneFunctions: false,
          wrapReflectors: true,
        });
      } catch {
        // fall back to local options
      }
    }
    return viewportOptions;
  };

  const attempts = [
    {
      scale: safeScale,
      run: (target: RenderablePdfPage, nextScale: number) =>
        target.getViewport(makeViewportOptions(nextScale)),
      suffix: "object",
    },
    {
      scale: safeScale,
      run: (target: RenderablePdfPage, nextScale: number) =>
        target.getViewport(nextScale, safeRotation, false),
      suffix: "legacy",
    },
  ];

  if (Math.abs(safeScale - 1.5) > 1e-3) {
    attempts.push(
      {
        scale: 1.5,
        run: (target: RenderablePdfPage, nextScale: number) =>
          target.getViewport(makeViewportOptions(nextScale)),
        suffix: "object-fallback",
      },
      {
        scale: 1.5,
        run: (target: RenderablePdfPage, nextScale: number) =>
          target.getViewport(nextScale, safeRotation, false),
        suffix: "legacy-fallback",
      },
    );
  }

  for (const attempt of attempts) {
    try {
      const viewport = unwrapWrappedJsObject(
        attempt.run(pdfPage, attempt.scale),
      ) as ViewportLike;
      if (isValidViewport(viewport)) {
        return {
          ok: true,
          viewport,
          width: Number(viewport.width),
          height: Number(viewport.height),
          scaleUsed: attempt.scale,
          mode: `${targetLabel}.${attempt.suffix}`,
        };
      }
    } catch {
      // fall through to the next signature
    }
  }

  return { ok: false };
}

function buildManualViewport(
  pageLike: RenderablePdfPage,
  scale: number,
):
  | {
      ok: true;
      viewport: ViewportLike;
      width: number;
      height: number;
      scaleUsed: number;
      mode: string;
    }
  | {
      ok: false;
    } {
  const sourceView = Array.isArray(pageLike?.view)
    ? pageLike.view
    : Array.isArray(pageLike?._pageInfo?.view)
      ? pageLike._pageInfo.view
      : Array.isArray(pageLike?.pageInfo?.view)
        ? pageLike.pageInfo.view
        : null;
  if (!Array.isArray(sourceView) || sourceView.length !== 4) {
    return { ok: false };
  }
  const viewBox = sourceView.map((value) => Number(value));
  if (viewBox.some((value) => !Number.isFinite(value))) {
    return { ok: false };
  }
  const safeScale =
    Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1.5;
  const safeRotation = Number.isFinite(Number(pageLike?.rotate))
    ? Number(pageLike.rotate)
    : 0;
  const safeUserUnit =
    Number.isFinite(Number(pageLike?.userUnit)) && Number(pageLike.userUnit) > 0
      ? Number(pageLike.userUnit)
      : 1;
  const [x1, y1, x2, y2] = viewBox;
  const pageWidth = x2 - x1;
  const pageHeight = y2 - y1;
  if (
    !Number.isFinite(pageWidth) ||
    pageWidth <= 0 ||
    !Number.isFinite(pageHeight) ||
    pageHeight <= 0
  ) {
    return { ok: false };
  }

  const normalizedRotation = ((safeRotation % 360) + 360) % 360;
  let rotateA = 1;
  let rotateB = 0;
  let rotateC = 0;
  let rotateD = -1;
  switch (normalizedRotation) {
    case 0:
      break;
    case 90:
      rotateA = 0;
      rotateB = 1;
      rotateC = 1;
      rotateD = 0;
      break;
    case 180:
      rotateA = -1;
      rotateB = 0;
      rotateC = 0;
      rotateD = 1;
      break;
    case 270:
      rotateA = 0;
      rotateB = -1;
      rotateC = -1;
      rotateD = 0;
      break;
    default:
      return { ok: false };
  }

  const totalScale = safeScale * safeUserUnit;
  const centerX = (x2 + x1) / 2;
  const centerY = (y2 + y1) / 2;
  let width = pageWidth * totalScale;
  let height = pageHeight * totalScale;
  let offsetCanvasX: number;
  let offsetCanvasY: number;
  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY - y1) * totalScale;
    offsetCanvasY = Math.abs(centerX - x1) * totalScale;
    width = pageHeight * totalScale;
    height = pageWidth * totalScale;
  } else {
    offsetCanvasX = Math.abs(centerX - x1) * totalScale;
    offsetCanvasY = Math.abs(centerY - y1) * totalScale;
  }

  const viewport: ViewportLike = {
    viewBox,
    scale: totalScale,
    rotation: normalizedRotation,
    offsetX: 0,
    offsetY: 0,
    transform: [
      rotateA * totalScale,
      rotateB * totalScale,
      rotateC * totalScale,
      rotateD * totalScale,
      offsetCanvasX -
        rotateA * totalScale * centerX -
        rotateC * totalScale * centerY,
      offsetCanvasY -
        rotateB * totalScale * centerX -
        rotateD * totalScale * centerY,
    ],
    width,
    height,
    rawDims: {
      pageWidth,
      pageHeight,
      pageX: x1,
      pageY: y1,
    },
    userUnit: safeUserUnit,
    dontFlip: false,
  };

  return {
    ok: true,
    viewport,
    width,
    height,
    scaleUsed: safeScale,
    mode: "manual.viewbox",
  };
}

function scopeViewportForRender(
  viewport: ViewportLike,
  canvasDoc: Document,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
): ViewportLike {
  try {
    const renderWindow = getPdfRenderWindow(canvasDoc, reader);
    const cloneIntoFn = getCloneInto();
    const payload = {
      viewBox: Array.isArray(viewport.viewBox)
        ? [...viewport.viewBox]
        : viewport.viewBox,
      scale: viewport.scale,
      rotation: viewport.rotation,
      offsetX: viewport.offsetX,
      offsetY: viewport.offsetY,
      transform: Array.isArray(viewport.transform)
        ? [...viewport.transform]
        : viewport.transform,
      width: viewport.width,
      height: viewport.height,
      rawDims: viewport.rawDims
        ? {
            pageWidth: viewport.rawDims.pageWidth,
            pageHeight: viewport.rawDims.pageHeight,
            pageX: viewport.rawDims.pageX,
            pageY: viewport.rawDims.pageY,
          }
        : viewport.rawDims,
      userUnit: viewport.userUnit,
      dontFlip: viewport.dontFlip,
    };

    if (renderWindow && typeof cloneIntoFn === "function") {
      try {
        return cloneIntoFn(payload, renderWindow, {
          cloneFunctions: false,
          wrapReflectors: true,
        }) as unknown as ViewportLike;
      } catch {
        // fall through to manual scoping below
      }
    }

    const renderConstructors = getWindowConstructors(renderWindow);
    const canvasConstructors = getWindowConstructors(canvasDoc.defaultView);
    const ScopedObject = renderConstructors.Object || canvasConstructors.Object;
    const ScopedArray = renderConstructors.Array || canvasConstructors.Array;
    if (
      typeof ScopedObject !== "function" ||
      typeof ScopedArray !== "function"
    ) {
      return viewport;
    }
    const scopedViewport = new ScopedObject() as ViewportLike;
    scopedViewport.viewBox = Array.isArray(payload.viewBox)
      ? ScopedArray.from(payload.viewBox)
      : payload.viewBox;
    scopedViewport.scale = payload.scale;
    scopedViewport.rotation = payload.rotation;
    scopedViewport.offsetX = payload.offsetX;
    scopedViewport.offsetY = payload.offsetY;
    scopedViewport.transform = Array.isArray(payload.transform)
      ? ScopedArray.from(payload.transform)
      : payload.transform;
    scopedViewport.width = payload.width;
    scopedViewport.height = payload.height;
    scopedViewport.rawDims = payload.rawDims
      ? ({
          pageWidth: payload.rawDims.pageWidth,
          pageHeight: payload.rawDims.pageHeight,
          pageX: payload.rawDims.pageX,
          pageY: payload.rawDims.pageY,
        } as ViewportLike["rawDims"])
      : payload.rawDims;
    scopedViewport.userUnit = payload.userUnit;
    scopedViewport.dontFlip = payload.dontFlip;
    return scopedViewport;
  } catch {
    return viewport;
  }
}

function resolvePdfViewport(
  rawPage: unknown,
  pdfPage: RenderablePdfPage,
  scale: number,
  renderWindow?: Window | null,
): {
  viewport: ViewportLike;
  width: number;
  height: number;
  scaleUsed: number;
  mode: string;
} | null {
  const candidates: Array<[string, RenderablePdfPage]> = [];
  const addCandidate = (label: string, value: unknown) => {
    const candidate = resolveRenderablePdfPage(value);
    if (!candidate) return;
    if (candidates.some((entry) => entry[1] === candidate)) return;
    candidates.push([label, candidate]);
  };

  addCandidate("resolved", pdfPage);
  addCandidate("raw", rawPage);
  if (rawPage && typeof rawPage === "object") {
    const rec = rawPage as Record<string, unknown>;
    addCandidate("raw.pdfPage", rec.pdfPage);
    addCandidate("raw._pdfPage", rec._pdfPage);
    addCandidate("raw.page", rec.page);
    addCandidate("raw.pageProxy", rec.pageProxy);
  }

  for (const [label, candidate] of candidates) {
    const safeViewport = getSafeViewport(label, candidate, scale, renderWindow);
    if (safeViewport.ok) {
      return safeViewport;
    }
  }

  const manualViewport = buildManualViewport(pdfPage, scale);
  return manualViewport.ok ? manualViewport : null;
}

function getFontFaceSetStatus(renderDoc: Document): string {
  try {
    const status = renderDoc.fonts?.status;
    return typeof status === "string" ? status : "unknown";
  } catch {
    return "unknown";
  }
}

async function waitForRenderFontsReady(
  renderDoc: Document,
  timeoutMs = 1600,
): Promise<{ waited: boolean; timedOut: boolean; status: string }> {
  try {
    const ready = renderDoc.fonts?.ready;
    if (!ready || typeof ready.then !== "function") {
      return { waited: false, timedOut: false, status: "unsupported" };
    }

    const beforeStatus = getFontFaceSetStatus(renderDoc);
    if (beforeStatus !== "loading") {
      return { waited: false, timedOut: false, status: beforeStatus };
    }

    let timedOut = false;
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);

    const view = renderDoc.defaultView;
    if (!timedOut && typeof view?.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => {
        view.requestAnimationFrame(() => resolve());
      });
    }

    return { waited: true, timedOut, status: getFontFaceSetStatus(renderDoc) };
  } catch {
    return { waited: false, timedOut: false, status: "unknown" };
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
  } else if (
    renderTask &&
    (typeof renderTask === "object" || typeof renderTask === "function") &&
    "then" in renderTask &&
    typeof (renderTask as { then?: unknown }).then === "function"
  ) {
    await renderTask;
  }
}

function clearRenderCanvas(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  try {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.restore();
  } catch {
    // A failed clear should not block the existing fallback path.
  }
}

export type PdfJsPageRenderOptions = {
  scale?: number;
  allowVisibleCanvasFallback?: boolean;
};

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(",")[1] || "";
  if (!base64) return null;
  const atobFn = (globalThis as unknown as { atob?: (value: string) => string })
    .atob;
  if (typeof atobFn === "function") {
    const binary = atobFn(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  const bufferCtor = (
    globalThis as unknown as {
      Buffer?: { from?: (value: string, encoding: "base64") => Uint8Array };
    }
  ).Buffer;
  if (typeof bufferCtor?.from === "function") {
    return new Uint8Array(bufferCtor.from(base64, "base64"));
  }
  return null;
}

export async function renderPdfPageToDataUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
  options: PdfJsPageRenderOptions = {},
): Promise<string | null> {
  const canvasDoc =
    getPdfApplicationDocument(app, reader) ||
    Zotero.getMainWindow?.()?.document;
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

    const requestedScale = Number(options.scale);
    const preferredScale =
      Number.isFinite(requestedScale) && requestedScale > 0
        ? requestedScale
        : PDF_PAGE_MODEL_RENDER_SCALE;
    const renderWindow = getPdfRenderWindow(canvasDoc, reader);
    const viewportResult = resolvePdfViewport(
      rawPage,
      pdfPage,
      preferredScale,
      renderWindow,
    );
    if (!viewportResult) return null;

    const renderDoc = renderWindow?.document || canvasDoc;
    const offscreen = renderDoc.createElement("canvas") as HTMLCanvasElement;
    offscreen.width = Math.max(1, Math.ceil(viewportResult.width));
    offscreen.height = Math.max(1, Math.ceil(viewportResult.height));
    offscreen.style.width = `${offscreen.width}px`;
    offscreen.style.height = `${offscreen.height}px`;

    let dataUrl: string | null = null;
    try {
      const context = offscreen.getContext(
        "2d",
      ) as CanvasRenderingContext2D | null;
      if (!context) return null;

      const rawContext = unwrapWrappedJsObject(
        context,
      ) as CanvasRenderingContext2D;
      const rawViewport = unwrapWrappedJsObject(
        viewportResult.viewport,
      ) as ViewportLike;
      const renderViewport = scopeViewportForRender(
        rawViewport,
        canvasDoc,
        reader,
      );

      let renderParams:
        | { canvasContext: CanvasRenderingContext2D; viewport: unknown }
        | unknown = {
        canvasContext: rawContext,
        viewport: renderViewport,
      };
      const cloneIntoFn = getCloneInto();
      if (renderWindow && typeof cloneIntoFn === "function") {
        try {
          renderParams = cloneIntoFn(
            {
              canvasContext: rawContext,
              viewport: renderViewport,
            },
            renderWindow,
            {
              cloneFunctions: false,
              wrapReflectors: true,
            },
          );
        } catch {
          // fall back to plain params
        }
      }

      const renderArgs = renderParams as {
        canvasContext: CanvasRenderingContext2D;
        viewport: unknown;
      };
      const fontStatusBeforeRender = getFontFaceSetStatus(renderDoc);
      await awaitPdfRenderTask(pdfPage.render(renderArgs));

      const fontWait = await waitForRenderFontsReady(renderDoc);
      if (fontWait.timedOut && fontWait.status === "loading") {
        return null;
      }

      if (
        (fontStatusBeforeRender === "loading" || fontWait.waited) &&
        fontWait.status !== "loading"
      ) {
        clearRenderCanvas(rawContext, offscreen.width, offscreen.height);
        await awaitPdfRenderTask(pdfPage.render(renderArgs));
      }

      const exported = canvasToDataUrl(offscreen);
      dataUrl = exported && !isCanvasLikelyBlank(offscreen) ? exported : null;
    } finally {
      try {
        pdfPage.cleanup?.();
      } catch {
        // cleanup is best-effort
      }
      offscreen.width = 0;
      offscreen.height = 0;
    }

    return dataUrl;
  } catch {
    return null;
  }
}

export async function renderPdfPageToBytes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
  options: PdfJsPageRenderOptions = {},
): Promise<Uint8Array | null> {
  const dataUrl = await renderPdfPageToDataUrl(app, reader, pageNumber, options);
  return dataUrl ? dataUrlToBytes(dataUrl) : null;
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

  const renderedOffscreen = await renderPdfPageToDataUrl(
    app,
    reader,
    pageNumber,
    { scale: PDF_PAGE_MODEL_RENDER_SCALE },
  );
  if (renderedOffscreen) return renderedOffscreen;

  // Fallback: grab the already-rendered canvas from the reader.
  const rendered = await waitForRenderedPageCanvas(app, reader, pageNumber);
  if (rendered && !isCanvasLikelyBlank(rendered)) {
    return canvasToDataUrl(rendered);
  }
  return null;
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
async function navigateReaderToPage(
  reader: any,
  pageIndex: number,
): Promise<boolean> {
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
 * Prefers off-screen PDF.js rendering and only falls back to the visible reader
 * canvas after off-screen attempts fail.
 */
export async function capturePdfPageToDataUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
  options: PdfJsPageRenderOptions = {},
): Promise<string | null> {
  const primary = await renderPdfPageToDataUrl(app, reader, pageNumber, {
    scale: options.scale,
  });
  if (primary) return primary;

  await new Promise((resolve) => setTimeout(resolve, 120));
  const retryScale =
    Number.isFinite(options.scale) && (options.scale as number) > 1
      ? Math.max(PDF_PAGE_MODEL_RETRY_SCALE, (options.scale as number) - 0.6)
      : PDF_PAGE_MODEL_RETRY_SCALE;
  const retry = await renderPdfPageToDataUrl(app, reader, pageNumber, {
    scale: retryScale,
  });
  if (retry) return retry;

  if (options.allowVisibleCanvasFallback === false) return null;

  await navigateReaderToPage(reader, pageNumber - 1);
  const rendered = await waitForRenderedPageCanvas(
    app,
    reader,
    pageNumber,
    3000,
  );
  if (rendered && rendered.width > 0 && rendered.height > 0) {
    const visibleUrl = canvasToDataUrl(rendered);
    if (visibleUrl && !isCanvasLikelyBlank(rendered)) {
      return visibleUrl;
    }
  }

  return null;
}

export async function capturePdfPageToBytes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageNumber: number,
  options: PdfJsPageRenderOptions = {},
): Promise<Uint8Array | null> {
  const dataUrl = await capturePdfPageToDataUrl(
    app,
    reader,
    pageNumber,
    options,
  );
  return dataUrl ? dataUrlToBytes(dataUrl) : null;
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
  const renderScale = getPdfPageRenderScaleForCount(total);
  try {
    for (let idx = 0; idx < total; idx++) {
      opts?.onProgress?.(idx + 1, total);
      const dataUrl = await capturePdfPageToDataUrl(
        app,
        reader,
        pageNumbers[idx],
        { scale: renderScale },
      );
      if (dataUrl) {
        results.push(dataUrl);
      }
      await new Promise((resolve) => setTimeout(resolve, total >= 10 ? 25 : 0));
    }
  } finally {
    // Restore original page position
    const restoreIndex = Math.max(0, Math.floor(originalPageNumber) - 1);
    await navigateReaderToPage(reader, restoreIndex);
  }
  return results;
}
