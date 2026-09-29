import { fnv1a32 } from "../../utils/fnv1a";
import { joinLocalPath } from "../../utils/localPath";
import { PDF_FIGURE_CROP_DIR } from "../pdf/pdfFigureCropCache";
import type { PdfFigureCropCache } from "../pdf/pdfFigureCropCache";
import type { ManifestFigure, MineruManifest } from "./mineruCache";

/** Upper bound on figures taken from one paper. */
const MAX_FIGURES = 200;

/** MinerU names an uncaptioned figure `image-3`; that is not a label. */
const PLACEHOLDER_LABEL = /^(?:image|table)-\d+$/i;

export type MineruFigureImage = {
  imageId: string;
  /** Absolute path of the image file on disk. */
  path: string;
  /** 0-based, as MinerU's `page_idx` records it. */
  pageIndex: number;
  label?: string;
  caption?: string;
  /** A figure crop stands in because MinerU's own image was pruned. */
  fromCrop: boolean;
};

export type MineruFigureImageSet = {
  /** Changes whenever the resolved files, labels or pages change. */
  fingerprint: string;
  figures: MineruFigureImage[];
};

type CropEntry = {
  label?: unknown;
  baseLabel?: unknown;
  cropPath?: unknown;
  pageNumber?: unknown;
};

function pathParts(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:|[\\/]{2}|[\\/])/.test(value);
}

function resolveInItemDir(itemDir: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (isAbsolutePath(trimmed)) return trimmed;
  return joinLocalPath(itemDir, ...pathParts(trimmed));
}

function normalizeLabel(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function collectManifestFigures(manifest: MineruManifest): ManifestFigure[] {
  const figures: ManifestFigure[] = [
    ...(Array.isArray(manifest.allFigures) ? manifest.allFigures : []),
    ...(Array.isArray(manifest.sections)
      ? manifest.sections.flatMap((section) =>
          Array.isArray(section.figures) ? section.figures : [],
        )
      : []),
  ];
  const byPath = new Map<string, ManifestFigure>();
  for (const figure of figures) {
    const key = pathParts(`${figure?.path ?? ""}`)
      .join("/")
      .toLowerCase();
    if (!key || byPath.has(key)) continue;
    byPath.set(key, figure);
  }
  return [...byPath.values()].slice(0, MAX_FIGURES);
}

/** Crops that exist on disk, keyed by the figure label they cover. */
async function loadCropsByLabel(params: {
  itemDir: string;
  readCropCache: () => Promise<PdfFigureCropCache | null>;
  fileExists: (path: string) => Promise<boolean>;
}): Promise<Map<string, { path: string; pageNumber?: number }>> {
  const byLabel = new Map<string, { path: string; pageNumber?: number }>();
  const cache = await params.readCropCache().catch(() => null);
  const entries: CropEntry[] = Array.isArray(cache?.entries)
    ? (cache.entries as CropEntry[])
    : [];
  for (const entry of entries) {
    const cropPath =
      typeof entry.cropPath === "string" ? entry.cropPath.trim() : "";
    if (!cropPath) continue;
    const resolved = resolveCropPath(params.itemDir, cropPath);
    if (!(await params.fileExists(resolved))) continue;
    const pageNumber =
      typeof entry.pageNumber === "number" && Number.isFinite(entry.pageNumber)
        ? entry.pageNumber
        : undefined;
    for (const label of [entry.label, entry.baseLabel]) {
      const key = normalizeLabel(label);
      if (key && !byLabel.has(key))
        byLabel.set(key, { path: resolved, pageNumber });
    }
  }
  return byLabel;
}

function resolveCropPath(itemDir: string, cropPath: string): string {
  const parts = pathParts(cropPath);
  if (isAbsolutePath(cropPath)) return cropPath.trim();
  // Crop paths are recorded relative to the MinerU item directory.
  return parts[0] === PDF_FIGURE_CROP_DIR
    ? joinLocalPath(itemDir, ...parts)
    : joinLocalPath(itemDir, PDF_FIGURE_CROP_DIR, ...parts);
}

/**
 * The paper's figures as image files: MinerU's own images, falling back to a
 * figure crop for figures whose image the crop pipeline has pruned. Figures
 * that have no file, or no page anywhere, are left out.
 */
export async function resolveMineruFigureImages(params: {
  itemDir: string;
  manifest: MineruManifest;
  fileExists: (path: string) => Promise<boolean>;
  readCropCache: () => Promise<PdfFigureCropCache | null>;
}): Promise<MineruFigureImageSet> {
  const candidates = collectManifestFigures(params.manifest);
  const resolved: Array<{ figure: ManifestFigure; path: string }> = [];
  const missing: ManifestFigure[] = [];
  for (const figure of candidates) {
    const path = resolveInItemDir(params.itemDir, `${figure.path ?? ""}`);
    if (path && (await params.fileExists(path))) {
      resolved.push({ figure, path });
    } else {
      missing.push(figure);
    }
  }

  const figures: MineruFigureImage[] = [];
  const addFigure = (
    figure: ManifestFigure,
    path: string,
    fromCrop: boolean,
    cropPageNumber?: number,
  ) => {
    const pageIndex = Number.isInteger(figure.page)
      ? (figure.page as number)
      : cropPageNumber !== undefined
        ? cropPageNumber - 1
        : undefined;
    if (pageIndex === undefined || pageIndex < 0) return;
    const label = `${figure.label ?? ""}`.trim();
    const caption = `${figure.caption ?? ""}`.trim();
    figures.push({
      imageId: `m-${fnv1a32(path)}`,
      path,
      pageIndex,
      ...(label && !PLACEHOLDER_LABEL.test(label) ? { label } : {}),
      ...(caption ? { caption } : {}),
      fromCrop,
    });
  };

  for (const entry of resolved) addFigure(entry.figure, entry.path, false);
  if (missing.length) {
    const crops = await loadCropsByLabel(params);
    for (const figure of missing) {
      const crop =
        crops.get(normalizeLabel(figure.label)) ||
        crops.get(normalizeLabel(figure.baseLabel));
      if (crop) addFigure(figure, crop.path, true, crop.pageNumber);
    }
  }
  figures.sort((a, b) => a.pageIndex - b.pageIndex);

  return {
    fingerprint: `${fnv1a32(
      JSON.stringify(
        figures.map((entry) => [
          entry.imageId,
          entry.pageIndex,
          entry.label ?? "",
          entry.fromCrop,
        ]),
      ),
    )}`,
    figures,
  };
}
