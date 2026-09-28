import type { PDFPageProxy } from "pdfjs-dist";
import {
  findCaptionNear,
  groupTextLines,
  toPageTextItems,
  type TextLine,
} from "./captions";
import { EMBEDDED_IMAGE_LIMITS } from "./filters";
import { analyzeOperatorList, type Rect } from "./geometry";
import {
  imageObjectToCanvas,
  thumbnailHash,
  type PdfjsImageObject,
} from "./imageObject";
import {
  loadPdfjs,
  PDFJS_DOCUMENT_OPTIONS,
  resolvePdfjsImageObject,
} from "./pdfjsLoader";
import { collectStructFigures, findVectorRegions } from "./vectorRegions";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_RENDER_SIDE_PX = 1344;
const MAX_RENDER_SCALE = 4;
const MAX_CAPTION_CHARS = 300;
/** pdf.js `AnnotationMode.DISABLE`: render page content only. */
const ANNOTATIONS_DISABLED = 0;

export type ExtractedImageSource = "embedded" | "vector";

export type ExtractedImageCandidate = {
  source: ExtractedImageSource;
  pageIndex: number;
  rect: Rect;
  /** Pixels: the bitmap's own size, or the rendered region's canvas size. */
  width: number;
  height: number;
  contentHash: string;
  label?: string;
  caption?: string;
  /** PNG data URL; only on the first occurrence of each contentHash. */
  dataUrl?: string;
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pageRect(page: PDFPageProxy): Rect {
  const [x1, y1, x2, y2] = page.view;
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

/**
 * Renders just `rect` of the page into a white canvas. This is the plugin's
 * own pdf.js document in memory; no reader tab is opened or scrolled.
 */
async function renderRegion(
  page: PDFPageProxy,
  rect: Rect,
  doc: Document,
): Promise<HTMLCanvasElement | null> {
  const longSide = Math.max(rect[2] - rect[0], rect[3] - rect[1]);
  if (!(longSide > 0)) return null;
  const scale = Math.min(MAX_RENDER_SCALE, MAX_RENDER_SIDE_PX / longSide);
  const viewport = page.getViewport({ scale });
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(1, Math.ceil(Math.abs(x2 - x1)));
  const height = Math.max(1, Math.ceil(Math.abs(y2 - y1)));
  const canvas = doc.createElementNS(HTML_NS, "canvas") as HTMLCanvasElement;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: [1, 0, 0, 1, -left, -top],
    annotationMode: ANNOTATIONS_DISABLED,
  }).promise;
  return canvas;
}

/**
 * Pulls embedded raster images and rendered vector figure regions out of a
 * PDF with the bundled pdf.js. Pages are processed one by one with a yield
 * in between so the UI stays responsive. Filtering happens in the caller.
 */
export async function extractEmbeddedImages(params: {
  bytes: Uint8Array;
  doc: Document;
}): Promise<ExtractedImageCandidate[]> {
  const { pdfjs } = await loadPdfjs();
  const pdf = await pdfjs.getDocument({
    data: params.bytes,
    ...PDFJS_DOCUMENT_OPTIONS,
  }).promise;
  const out: ExtractedImageCandidate[] = [];
  const encoded = new Set<string>();

  const push = (
    candidate: Omit<ExtractedImageCandidate, "dataUrl">,
    canvas: HTMLCanvasElement,
  ) => {
    const entry: ExtractedImageCandidate = { ...candidate };
    if (!encoded.has(candidate.contentHash)) {
      encoded.add(candidate.contentHash);
      entry.dataUrl = canvas.toDataURL("image/png");
    }
    out.push(entry);
    canvas.width = 0;
    canvas.height = 0;
  };

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const graphics = analyzeOperatorList(
          await page.getOperatorList(),
          pdfjs.OPS,
          pdfjs.Util,
        );
        let tree: unknown = null;
        try {
          tree = await page.getStructTree();
        } catch {
          tree = null;
        }
        const regions = findVectorRegions({
          graphics,
          figures: collectStructFigures(tree),
          page: pageRect(page),
          util: pdfjs.Util,
        });
        if (!graphics.images.length && !regions.length) continue;

        let lines: TextLine[] | null = null;
        const captionFor = async (rect: Rect) => {
          if (!lines) {
            const text = await page.getTextContent();
            lines = groupTextLines(
              toPageTextItems(
                text.items as Parameters<typeof toPageTextItems>[0],
              ),
            );
          }
          return findCaptionNear(rect, lines);
        };

        for (const draw of graphics.images) {
          const obj = resolvePdfjsImageObject(
            page,
            draw.objId,
          ) as PdfjsImageObject | null;
          if (!obj) continue;
          if (Math.min(obj.width, obj.height) < EMBEDDED_IMAGE_LIMITS.minSide) {
            continue;
          }
          const canvas = imageObjectToCanvas(params.doc, obj);
          if (!canvas) continue;
          const caption = await captionFor(draw.rect);
          push(
            {
              source: "embedded",
              pageIndex: pageNumber - 1,
              rect: draw.rect,
              width: obj.width,
              height: obj.height,
              contentHash: thumbnailHash(params.doc, canvas),
              ...(caption
                ? { label: caption.label, caption: caption.caption }
                : {}),
            },
            canvas,
          );
        }

        for (const region of regions) {
          const canvas = await renderRegion(
            page,
            region.rect,
            params.doc,
          ).catch(() => null);
          if (!canvas) continue;
          const caption = await captionFor(region.rect);
          push(
            {
              source: "vector",
              pageIndex: pageNumber - 1,
              rect: region.rect,
              width: canvas.width,
              height: canvas.height,
              contentHash: `v-${thumbnailHash(params.doc, canvas)}`,
              ...(caption
                ? { label: caption.label, caption: caption.caption }
                : region.alt
                  ? { caption: region.alt.slice(0, MAX_CAPTION_CHARS) }
                  : {}),
            },
            canvas,
          );
        }
      } finally {
        page.cleanup();
      }
      await yieldToEventLoop();
    }
  } finally {
    await pdf.destroy();
  }
  return out;
}
