import { appLogger } from "../core/logging";

export function estimateDataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return dataUrl.length;
  const payloadLength = dataUrl.length - commaIndex - 1;
  return Math.max(0, Math.floor((payloadLength * 3) / 4));
}

export type ImageOptimizationMode = "screenshot" | "pdf-page" | "embedding";

type ImageOptimizationProfile = {
  maxDimension: number;
  maxLosslessBytes: number;
  maxPassthroughBytes: number;
  jpegQuality: number;
};

export const IMAGE_OPTIMIZATION_PROFILES: Record<
  ImageOptimizationMode,
  ImageOptimizationProfile
> = {
  screenshot: {
    maxDimension: 2048,
    maxLosslessBytes: 2 * 1024 * 1024,
    maxPassthroughBytes: 4 * 1024 * 1024,
    jpegQuality: 0.88,
  },
  "pdf-page": {
    maxDimension: 3072,
    maxLosslessBytes: 8 * 1024 * 1024,
    maxPassthroughBytes: 12 * 1024 * 1024,
    jpegQuality: 0.95,
  },
  // Embedding endpoints: 1344² stays under Qwen3-VL-Embedding's max_pixels
  // (1,843,200) and 4 MB under DashScope's 5 MB per-image cap.
  embedding: {
    maxDimension: 1344,
    maxLosslessBytes: 4 * 1024 * 1024,
    maxPassthroughBytes: 4 * 1024 * 1024,
    jpegQuality: 0.9,
  },
};

export async function optimizeImageDataUrl(
  win: Window,
  dataUrl: string,
  options: { mode?: ImageOptimizationMode } = {},
): Promise<string> {
  const { maxDimension, maxLosslessBytes, maxPassthroughBytes, jpegQuality } =
    IMAGE_OPTIMIZATION_PROFILES[options.mode || "screenshot"];

  try {
    const ImageCtor = win.Image as typeof Image;
    const img = new ImageCtor();
    img.src = dataUrl;
    await img.decode();

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return dataUrl;

    const sourceBytes = estimateDataUrlByteLength(dataUrl);
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const needsResize = targetWidth !== width || targetHeight !== height;

    // Keep already-small images untouched to avoid unnecessary quality loss.
    if (!needsResize && sourceBytes <= maxLosslessBytes) {
      return dataUrl;
    }

    const canvas = win.document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return dataUrl;

    ctx.imageSmoothingEnabled = true;
    (
      ctx as CanvasRenderingContext2D & {
        imageSmoothingQuality?: "low" | "medium" | "high";
      }
    ).imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    // Prefer lossless encoding for charts/figures when the payload is manageable.
    const pngDataUrl = canvas.toDataURL("image/png");
    if (estimateDataUrlByteLength(pngDataUrl) <= maxLosslessBytes) {
      return pngDataUrl;
    }
    if (!needsResize && sourceBytes <= maxPassthroughBytes) {
      return dataUrl;
    }
    return canvas.toDataURL("image/jpeg", jpegQuality);
  } catch (err) {
    appLogger.debug("Screenshot optimize failed:", err);
    return dataUrl;
  }
}
