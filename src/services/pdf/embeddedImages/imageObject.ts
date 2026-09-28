import { fnv1a32 } from "../../../utils/fnv1a";

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Skip bitmaps whose canvas would need more than ~144 MB of RGBA. */
const MAX_CANVAS_PIXELS = 36_000_000;
const THUMBNAIL_SIDE = 16;

/** pdf.js `ImageKind` values for raw image data sent from the worker. */
export const PDFJS_IMAGE_KIND = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3,
} as const;

export type PdfjsImageObject = {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  /** Present when pdf.js decoded the image to an ImageBitmap. */
  bitmap?: CanvasImageSource;
};

/** Raw pdf.js image data → RGBA, or null when the data is short or unknown. */
export function toRgba(obj: PdfjsImageObject): Uint8ClampedArray | null {
  const { width, height, kind, data } = obj;
  if (!data || !(width > 0) || !(height > 0)) return null;
  const pixels = width * height;
  const out = new Uint8ClampedArray(pixels * 4);
  if (kind === PDFJS_IMAGE_KIND.RGBA_32BPP) {
    if (data.length < pixels * 4) return null;
    out.set(data.subarray(0, pixels * 4));
    return out;
  }
  if (kind === PDFJS_IMAGE_KIND.RGB_24BPP) {
    if (data.length < pixels * 3) return null;
    for (let i = 0; i < pixels; i += 1) {
      out[i * 4] = data[i * 3];
      out[i * 4 + 1] = data[i * 3 + 1];
      out[i * 4 + 2] = data[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (kind === PDFJS_IMAGE_KIND.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const value = bit ? 255 : 0;
        const offset = (y * width + x) * 4;
        out[offset] = value;
        out[offset + 1] = value;
        out[offset + 2] = value;
        out[offset + 3] = 255;
      }
    }
    return out;
  }
  return null;
}

/** Draws a pdf.js image object onto a new canvas in `doc`. */
export function imageObjectToCanvas(
  doc: Document,
  obj: PdfjsImageObject,
): HTMLCanvasElement | null {
  if (!(obj.width > 0) || !(obj.height > 0)) return null;
  if (obj.width * obj.height > MAX_CANVAS_PIXELS) return null;
  const canvas = doc.createElementNS(HTML_NS, "canvas") as HTMLCanvasElement;
  canvas.width = obj.width;
  canvas.height = obj.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0);
    return canvas;
  }
  const rgba = toRgba(obj);
  if (!rgba) return null;
  const imageData = ctx.createImageData(obj.width, obj.height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Content fingerprint that survives re-encoding: a 16×16 grayscale
 * thumbnail plus the source size. Used to spot the same logo on many pages.
 */
export function thumbnailHash(
  doc: Document,
  canvas: HTMLCanvasElement,
): string {
  const thumb = doc.createElementNS(HTML_NS, "canvas") as HTMLCanvasElement;
  thumb.width = THUMBNAIL_SIDE;
  thumb.height = THUMBNAIL_SIDE;
  const ctx = thumb.getContext("2d");
  if (!ctx) return `${canvas.width}x${canvas.height}`;
  ctx.drawImage(canvas, 0, 0, THUMBNAIL_SIDE, THUMBNAIL_SIDE);
  const pixels = ctx.getImageData(0, 0, THUMBNAIL_SIDE, THUMBNAIL_SIDE).data;
  let gray = "";
  for (let i = 0; i < pixels.length; i += 4) {
    const value = Math.round(
      (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 16,
    );
    gray += value.toString(16);
  }
  return `${canvas.width}x${canvas.height}-${fnv1a32(gray)}`;
}
