import { resolveMineruFigureImages } from "../mineru/mineruFigureImages";
import type { MineruManifest } from "../mineru/mineruCache";
import { filterExtractedImages } from "../pdf/embeddedImages/filters";
import type { ExtractedImageCandidate } from "../pdf/embeddedImages/extractor";
import type { PdfFigureCropCache } from "../pdf/pdfFigureCropCache";

/** One image on its way into the index, whatever produced it. */
export type PaperImageCandidate = {
  source: "embedded" | "vector" | "mineru";
  /** 0-based. */
  pageIndex: number;
  /** Stable per image; also the image's id in the index. */
  contentHash: string;
  dataUrl: string;
  label?: string;
  caption?: string;
  /** pdf.js extraction only: where the image sits on the page, in points. */
  rect?: [number, number, number, number];
  width?: number;
  height?: number;
};

export type PaperImageSource = {
  kind: "mineru" | "pdf";
  /** Rebuild trigger: the index is stale as soon as this changes. */
  fingerprint: string;
  collect: () => Promise<PaperImageCandidate[]>;
};

export type PaperImageSourceDeps = {
  loadMineruManifest: (attachmentId: number) => Promise<MineruManifest | null>;
  mineruItemDir: (attachmentId: number) => string;
  fileExists: (path: string) => Promise<boolean>;
  readCropCache: (itemDir: string) => Promise<PdfFigureCropCache | null>;
  readImageAsDataUrl: (path: string) => Promise<string | null>;
  resolvePdfPath: (attachmentId: number) => Promise<string | null>;
  statFile: (
    path: string,
  ) => Promise<{ size: number; lastModified: number } | null>;
  readFile: (path: string) => Promise<Uint8Array | null>;
  extractFromPdf: (bytes: Uint8Array) => Promise<ExtractedImageCandidate[]>;
};

async function resolveMineruSource(
  attachmentId: number,
  deps: PaperImageSourceDeps,
): Promise<PaperImageSource | null> {
  const manifest = await deps.loadMineruManifest(attachmentId);
  if (!manifest) return null;
  const itemDir = deps.mineruItemDir(attachmentId);
  const { fingerprint, figures } = await resolveMineruFigureImages({
    itemDir,
    manifest,
    fileExists: deps.fileExists,
    readCropCache: () => deps.readCropCache(itemDir),
  });
  // No usable figure file: pdf.js extraction still has something to offer.
  if (!figures.length) return null;
  return {
    kind: "mineru",
    fingerprint: `mineru:${fingerprint}`,
    collect: async () => {
      const candidates: PaperImageCandidate[] = [];
      for (const figure of figures) {
        const dataUrl = await deps.readImageAsDataUrl(figure.path);
        if (!dataUrl) continue;
        candidates.push({
          source: "mineru",
          pageIndex: figure.pageIndex,
          contentHash: figure.imageId,
          dataUrl,
          ...(figure.label ? { label: figure.label } : {}),
          ...(figure.caption ? { caption: figure.caption } : {}),
        });
      }
      return candidates;
    },
  };
}

async function resolvePdfSource(
  attachmentId: number,
  deps: PaperImageSourceDeps,
): Promise<PaperImageSource | null> {
  const path = await deps.resolvePdfPath(attachmentId);
  if (!path) return null;
  const stat = await deps.statFile(path);
  if (!stat) return null;
  return {
    kind: "pdf",
    fingerprint: `pdf:${stat.size}:${stat.lastModified}`,
    collect: async () => {
      const bytes = await deps.readFile(path);
      if (!bytes) return [];
      const extracted = await deps.extractFromPdf(bytes);
      return filterExtractedImages(extracted).flatMap((candidate) =>
        candidate.dataUrl
          ? [
              {
                source: candidate.source,
                pageIndex: candidate.pageIndex,
                rect: candidate.rect,
                width: candidate.width,
                height: candidate.height,
                contentHash: candidate.contentHash,
                dataUrl: candidate.dataUrl,
                ...(candidate.label ? { label: candidate.label } : {}),
                ...(candidate.caption ? { caption: candidate.caption } : {}),
              },
            ]
          : [],
      );
    },
  };
}

/**
 * Where a paper's images come from. MinerU-backed papers use the figures
 * MinerU already detected; everything else has them extracted from the PDF
 * with pdf.js.
 */
export function resolvePaperImageSource(params: {
  attachmentId: number;
  useMineru: boolean;
  deps: PaperImageSourceDeps;
}): Promise<PaperImageSource | null> {
  const { attachmentId, deps } = params;
  if (!params.useMineru) return resolvePdfSource(attachmentId, deps);
  return resolveMineruSource(attachmentId, deps).then(
    (source) => source ?? resolvePdfSource(attachmentId, deps),
  );
}
