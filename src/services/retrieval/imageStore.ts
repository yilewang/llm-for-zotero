import { joinLocalPath } from "../../utils/localPath";
import {
  ensureDir,
  getImageCacheDir,
  getImageVectorsPath,
  readFileBytes,
  writeFileBytes,
} from "./embeddingCache";

export const IMAGE_MANIFEST_VERSION = 1;
/** Bump when extraction output changes so stale manifests are rebuilt. */
export const IMAGE_EXTRACTION_ALGORITHM_VERSION = 2;
export const IMAGE_VECTORS_VERSION = 1;

export type EmbeddedImageRecord = {
  imageId: string;
  /** 0-based. */
  pageIndex: number;
  label?: string;
  caption?: string;
  fileName: string;
  mimeType: string;
  /** Absent means "embedded" (a raster image object). */
  source?: "embedded" | "vector" | "mineru";
  /** pdf.js order: [minX, minY, maxX, maxY] in PDF points; pdf.js only. */
  rect?: [number, number, number, number];
  /** Pixel size of the extracted image; pdf.js only. */
  width?: number;
  height?: number;
};

export type EmbeddedImageManifest = {
  version: number;
  algorithmVersion: number;
  pdfFingerprint: string;
  images: EmbeddedImageRecord[];
};

export type EmbeddedImageVectors = {
  version: number;
  cacheKey: string;
  imageIds: string[];
  vectors: number[][];
};

const MANIFEST_FILE = "manifest.json";

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is EmbeddedImageRecord {
  const row = value as Partial<EmbeddedImageRecord> | null;
  return Boolean(
    row &&
    typeof row.imageId === "string" &&
    isFiniteNumber(row.pageIndex) &&
    (row.rect === undefined ||
      (Array.isArray(row.rect) &&
        row.rect.length === 4 &&
        row.rect.every(isFiniteNumber))) &&
    (row.width === undefined || isFiniteNumber(row.width)) &&
    (row.height === undefined || isFiniteNumber(row.height)) &&
    typeof row.fileName === "string" &&
    typeof row.mimeType === "string" &&
    (row.label === undefined || typeof row.label === "string") &&
    (row.caption === undefined || typeof row.caption === "string") &&
    (row.source === undefined ||
      row.source === "embedded" ||
      row.source === "vector" ||
      row.source === "mineru"),
  );
}

export function parseImageManifest(raw: unknown): EmbeddedImageManifest | null {
  const data = parseJson(raw) as Partial<EmbeddedImageManifest> | null;
  if (!data || data.version !== IMAGE_MANIFEST_VERSION) return null;
  if (!isFiniteNumber(data.algorithmVersion)) return null;
  if (typeof data.pdfFingerprint !== "string") return null;
  if (!Array.isArray(data.images) || !data.images.every(isRecord)) return null;
  return data as EmbeddedImageManifest;
}

export function parseImageVectors(raw: unknown): EmbeddedImageVectors | null {
  const data = parseJson(raw) as Partial<EmbeddedImageVectors> | null;
  if (!data || data.version !== IMAGE_VECTORS_VERSION) return null;
  if (typeof data.cacheKey !== "string") return null;
  if (!Array.isArray(data.imageIds) || !Array.isArray(data.vectors)) {
    return null;
  }
  if (data.imageIds.length !== data.vectors.length) return null;
  const dimension = data.vectors[0]?.length ?? 0;
  const vectorsOk = data.vectors.every(
    (vector) =>
      Array.isArray(vector) &&
      vector.length === dimension &&
      vector.every(isFiniteNumber),
  );
  return vectorsOk ? (data as EmbeddedImageVectors) : null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function getImageFilePath(itemId: number, fileName: string): string {
  return joinLocalPath(getImageCacheDir(itemId), fileName);
}

export async function loadImageManifest(
  itemId: number,
): Promise<EmbeddedImageManifest | null> {
  const bytes = await readFileBytes(
    joinLocalPath(getImageCacheDir(itemId), MANIFEST_FILE),
  );
  return bytes ? parseImageManifest(decoder.decode(bytes)) : null;
}

export async function saveImageManifest(
  itemId: number,
  manifest: EmbeddedImageManifest,
): Promise<void> {
  await ensureDir(getImageCacheDir(itemId));
  await writeFileBytes(
    joinLocalPath(getImageCacheDir(itemId), MANIFEST_FILE),
    encoder.encode(JSON.stringify(manifest)),
  );
}

export async function writeImageFile(
  itemId: number,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  await ensureDir(getImageCacheDir(itemId));
  await writeFileBytes(getImageFilePath(itemId, fileName), bytes);
}

export async function readImageFile(
  itemId: number,
  fileName: string,
): Promise<Uint8Array | null> {
  return readFileBytes(getImageFilePath(itemId, fileName));
}

/** Vectors for exactly these image ids under this cacheKey, else null. */
export async function loadImageVectors(
  itemId: number,
  cacheKey: string,
  imageIds: string[],
): Promise<number[][] | null> {
  const bytes = await readFileBytes(getImageVectorsPath(itemId));
  const data = bytes ? parseImageVectors(decoder.decode(bytes)) : null;
  if (!data || data.cacheKey !== cacheKey) return null;
  if (data.imageIds.join("\n") !== imageIds.join("\n")) return null;
  return data.vectors;
}

export async function saveImageVectors(
  itemId: number,
  data: Omit<EmbeddedImageVectors, "version">,
): Promise<void> {
  await ensureDir(getImageCacheDir(itemId));
  await writeFileBytes(
    getImageVectorsPath(itemId),
    encoder.encode(JSON.stringify({ version: IMAGE_VECTORS_VERSION, ...data })),
  );
}
