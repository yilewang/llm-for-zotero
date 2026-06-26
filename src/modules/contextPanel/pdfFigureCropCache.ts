import { joinLocalPath } from "../../utils/localPath";
import type {
  PdfFigureCandidateSource,
  PdfFigureRect,
} from "./pdfFigureGeometry";

export const PDF_FIGURE_CROP_CACHE_VERSION = 2;
export const PDF_FIGURE_CROP_DIR = "figure_crops";
export const PDF_FIGURE_CROP_METADATA_FILE = "figure_geometry.json";

export type ExtractedPdfFigure = {
  id: string;
  label: string;
  baseLabel: string;
  pageNumber: number;
  captionPageNumber?: number;
  cropPath: string;
  captionText?: string;
  panelHint?: string;
  rect: PdfFigureRect;
  confidence: number;
  source: PdfFigureCandidateSource;
  warnings: string[];
  mineruBlockId?: string;
  mineruImagePaths: string[];
};

export type ExpectedPdfFigure = {
  label: string;
  baseLabel: string;
  pageNumber?: number;
  captionPageNumber?: number;
  status?: string;
  cropPath?: string;
  source?: string;
  confidence?: number;
};

export type PdfFigureCropCache = {
  version: number;
  attachmentId: number;
  manifestHash: string;
  pdfFingerprint: string;
  renderScale: number;
  algorithmVersion: number;
  generatedAt: number;
  expectedFigures?: ExpectedPdfFigure[];
  missingFigures?: ExpectedPdfFigure[];
  entries: ExtractedPdfFigure[];
};

function getIOUtils(): any {
  return (globalThis as any).IOUtils;
}

function getOSFile(): any {
  return (globalThis as any).OS?.File;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, { ignoreExisting: true });
  }
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      const data = await osFile.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
  }
}

export function getPdfFigureCropDirForCacheDir(cacheDir: string): string {
  return joinLocalPath(cacheDir, PDF_FIGURE_CROP_DIR);
}

export function getPdfFigureCropImageDirForCacheDir(cacheDir: string): string {
  return joinLocalPath(getPdfFigureCropDirForCacheDir(cacheDir), "crops");
}

export function getPdfFigureCropCachePathForCacheDir(cacheDir: string): string {
  return joinLocalPath(
    getPdfFigureCropDirForCacheDir(cacheDir),
    PDF_FIGURE_CROP_METADATA_FILE,
  );
}

export function getPdfFigureCropPathForCacheDir(
  cacheDir: string,
  figureId: string,
): string {
  const safeId =
    figureId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "figure";
  return joinLocalPath(
    getPdfFigureCropImageDirForCacheDir(cacheDir),
    `${safeId}.png`,
  );
}

export async function readPdfFigureCropCacheFromDir(
  cacheDir: string,
): Promise<PdfFigureCropCache | null> {
  const bytes = await readFileBytes(
    getPdfFigureCropCachePathForCacheDir(cacheDir),
  );
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8").decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<PdfFigureCropCache>;
    if (!Array.isArray(record.entries)) return null;
    return record as PdfFigureCropCache;
  } catch {
    return null;
  }
}

export async function writePdfFigureCropCacheToDir(
  cacheDir: string,
  cache: PdfFigureCropCache,
): Promise<void> {
  await ensureDir(getPdfFigureCropDirForCacheDir(cacheDir));
  await writeFileBytes(
    getPdfFigureCropCachePathForCacheDir(cacheDir),
    new TextEncoder().encode(JSON.stringify(cache)),
  );
}

export async function writePdfFigureCropBytesToDir(
  cacheDir: string,
  figureId: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureDir(getPdfFigureCropImageDirForCacheDir(cacheDir));
  const path = getPdfFigureCropPathForCacheDir(cacheDir, figureId);
  await writeFileBytes(path, bytes);
  return path;
}

export function isPdfFigureCropPath(
  path: string | undefined,
  cache: PdfFigureCropCache | null,
): boolean {
  const normalized = (path || "").replace(/\\/g, "/");
  if (!normalized || !cache?.entries?.length) return false;
  return cache.entries.some(
    (entry) => entry.cropPath.replace(/\\/g, "/") === normalized,
  );
}
