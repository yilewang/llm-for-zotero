import { fnv1a32 } from "../../utils/fnv1a";
import { joinLocalPath } from "../../utils/localPath";
import type { PaperContextRef } from "../../shared/types";
import type {
  PdfFigureCandidateSource,
  PdfFigureRect,
} from "./pdfFigureGeometry";

export const PDF_FIGURE_CROP_CACHE_VERSION = 2;
export const PDF_FIGURE_CROP_ALGORITHM_VERSION = 13;
export const PDF_FIGURE_CROP_DIR = "figure_crops";
export const PDF_FIGURE_CROP_METADATA_FILE = "figure_geometry.json";
export const PDF_FIGURE_CROP_STANDALONE_ROOT_DIR =
  "llm-for-zotero-pdf-figure-crops";

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

export type PdfFigureCropFreshnessReason =
  | "missing"
  | "invalid"
  | "version"
  | "algorithm"
  | "manifest"
  | "attachment";

export type PdfFigureCropFreshness =
  | { ok: true }
  | { ok: false; reason: PdfFigureCropFreshnessReason };

type PdfFigureCropFingerprintInput = Pick<
  PaperContextRef,
  "itemId" | "contextItemId" | "attachmentTitle" | "title"
>;

function normalizePositiveInt(value: unknown): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function getBaseWritableDir(): string {
  const zotero = (
    globalThis as unknown as {
      Zotero?: {
        DataDirectory?: { dir?: string };
        Profile?: { dir?: string };
        getTempDirectory?: () => { path?: string } | null;
      };
    }
  ).Zotero;
  const dataDir = zotero?.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) {
    return dataDir.trim();
  }
  const profileDir = zotero?.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return profileDir.trim();
  }
  const tempDirObj = zotero?.getTempDirectory?.();
  if (typeof tempDirObj?.path === "string" && tempDirObj.path.trim()) {
    return tempDirObj.path.trim();
  }
  throw new Error(
    "Cannot resolve writable data directory for PDF figure crops",
  );
}

export function getStandalonePdfFigureCropCacheDirForAttachmentId(
  attachmentId: number,
): string {
  const normalizedAttachmentId = normalizePositiveInt(attachmentId);
  if (!normalizedAttachmentId) {
    throw new Error("Cannot resolve PDF figure cache without an attachment ID");
  }
  return joinLocalPath(
    getBaseWritableDir(),
    PDF_FIGURE_CROP_STANDALONE_ROOT_DIR,
    `${normalizedAttachmentId}`,
  );
}

export function buildPdfFigureCropStableHash(value: string): string {
  return `fnv1a32-${fnv1a32(value)}`;
}

/** The manifest fields a figure crop actually depends on. */
type FigureCropRelevantManifest = {
  figureBlocks?: unknown;
  allFigures?: unknown;
  allTables?: unknown;
  totalPages?: unknown;
  sections?: unknown;
};

/**
 * Freshness key for a paper's figure crops: the figure inventory the crop
 * pipeline reads, and nothing else. Section levels, heading paths and the
 * parse-health block describe prose structure, so a manifest rebuild that adds
 * or reshapes them must not throw away every crop of every paper.
 */
export function buildPdfFigureCropManifestHash(manifest: unknown): string {
  const source = (manifest || {}) as FigureCropRelevantManifest;
  const sections = Array.isArray(source.sections) ? source.sections : [];
  return buildPdfFigureCropStableHash(
    JSON.stringify({
      figureBlocks: source.figureBlocks ?? null,
      allFigures: source.allFigures ?? null,
      allTables: source.allTables ?? null,
      totalPages: source.totalPages ?? null,
      sections: sections.map((section) => {
        const entry = (section || {}) as {
          figures?: unknown;
          tables?: unknown;
        };
        return {
          figures: entry.figures ?? null,
          tables: entry.tables ?? null,
        };
      }),
    }),
  );
}

export function buildPdfFigureCropPdfFingerprint(
  paperContext: PdfFigureCropFingerprintInput,
): string {
  return buildPdfFigureCropStableHash(
    [
      paperContext.itemId,
      paperContext.contextItemId,
      paperContext.attachmentTitle,
      paperContext.title,
    ].join("|"),
  );
}

export function getPdfFigureCropCacheFreshness(
  cache: PdfFigureCropCache | null | undefined,
  params: {
    manifest?: unknown;
    paperContext?: PdfFigureCropFingerprintInput;
  } = {},
): PdfFigureCropFreshness {
  if (!cache) return { ok: false, reason: "missing" };
  if (!Array.isArray(cache.entries)) return { ok: false, reason: "invalid" };
  if (cache.version !== PDF_FIGURE_CROP_CACHE_VERSION) {
    return { ok: false, reason: "version" };
  }
  if (cache.algorithmVersion !== PDF_FIGURE_CROP_ALGORITHM_VERSION) {
    return { ok: false, reason: "algorithm" };
  }
  if (cache.manifestHash !== buildPdfFigureCropManifestHash(params.manifest)) {
    return { ok: false, reason: "manifest" };
  }
  const contextItemId = normalizePositiveInt(
    params.paperContext?.contextItemId,
  );
  if (contextItemId && cache.attachmentId !== contextItemId) {
    return { ok: false, reason: "attachment" };
  }
  // Do not hard-reject on pdfFingerprint mismatch here. The fingerprint
  // includes display metadata such as title/attachmentTitle, which can drift
  // between extraction and later reads even when the stable attachment id and
  // MinerU manifest still match.
  return { ok: true };
}

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

export async function removePdfFigureCropCacheDir(
  cacheDir: string,
): Promise<void> {
  const path = getPdfFigureCropDirForCacheDir(cacheDir);
  const io = getIOUtils();
  if (io?.remove) {
    try {
      await io.remove(path, { recursive: true, ignoreAbsent: true });
    } catch {
      /* best-effort cache cleanup */
    }
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    try {
      await osFile.removeDir(path, {
        ignoreAbsent: true,
        ignorePermissions: false,
      });
    } catch {
      /* best-effort cache cleanup */
    }
    return;
  }
  if (osFile?.remove) {
    try {
      await osFile.remove(path, { ignoreAbsent: true });
    } catch {
      /* best-effort cache cleanup */
    }
  }
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

export async function pdfFigureCropFileExists(path: string): Promise<boolean> {
  const normalized = `${path || ""}`.trim();
  if (!normalized) return false;
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(normalized));
    } catch {
      // Fall through to read-based probing.
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(normalized));
    } catch {
      // Fall through to read-based probing.
    }
  }
  return Boolean(await readFileBytes(normalized));
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
