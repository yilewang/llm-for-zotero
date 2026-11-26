import {
  getManifestFigureBaseLabel,
  pruneMineruSourceImagesWhenFigureCropsReady,
  type MineruManifest,
} from "../../services/mineru/mineruCache";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  buildPdfFigureCropManifestHash,
  buildPdfFigureCropPdfFingerprint,
  getPdfFigureCropCacheFreshness,
  getStandalonePdfFigureCropCacheDirForAttachmentId,
  pdfFigureCropFileExists,
  readPdfFigureCropCacheFromDir,
  removePdfFigureCropCacheDir,
  writePdfFigureCropCacheToDir,
  type ExpectedPdfFigure,
  type ExtractedPdfFigure,
  type PdfFigureCropCache,
} from "../../services/pdf/pdfFigureCropCache";
import { joinLocalPath } from "../../utils/localPath";
import type { PaperReadFigureExtractionResult } from "../tools/read/paperRead";
import type { PdfTarget } from "../tools/read/pdfToolUtils";
import type { AgentToolArtifact, AgentToolContext } from "../types";
import type { PdfFigureSelection, PdfPageService } from "./pdfPageService";
import { sha256Bytes } from "../store/journalRecoveryBlobStore";
import type { PlanDocumentAsset } from "../documents/types";
import { collapseWhitespace, positiveIntOrZero } from "../../core/values";

const FIGURE_EXTRACTION_RENDER_SCALE = 1.8;

type FigureExtractionInput = {
  query?: string;
  figureLabels?: string[];
  includeSupplementary?: boolean;
  pages?: number[];
  target?: PdfTarget;
};

type FigureExtractionParams = {
  input: FigureExtractionInput;
  /** Host-owned selectors; free-text tool queries cannot change them. */
  selection?: PdfFigureSelection;
  context: AgentToolContext;
  paperContexts: NonNullable<PdfTarget["paperContext"]>[];
  /**
   * Host-only. Plain chat sends figure crops as images and never publishes a
   * document, so it skips the source-PDF hash that document assets need.
   */
  documentAssets?: false;
};

type FigureCropPageService = PdfPageService & {
  extractFiguresFromSourcePdf?: (params: {
    request: AgentToolContext["request"];
    paperContext?: NonNullable<PdfTarget["paperContext"]>;
    figureCacheDir: string;
    mineruCacheDir?: string;
    query: string;
    selection: PdfFigureSelection;
    pages?: number[];
    dpi?: number;
  }) => Promise<
    | ExtractedPdfFigure[]
    | {
        figures: ExtractedPdfFigure[];
        expectedFigures?: ExpectedPdfFigure[];
        missingFigures?: ExpectedPdfFigure[];
        warnings?: string[];
      }
  >;
};

/**
 * Ordinary Agent and MCP calls use the same concrete read selectors. A
 * host-owned selection (normal chat's figure references) is used instead
 * when the caller supplies one. Queries remain supported for existing
 * clients; no preliminary classifier is required to read a figure.
 */
function resolveDirectFigureSelection(
  input: FigureExtractionInput,
  context: AgentToolContext,
): PdfFigureSelection | undefined {
  if (input.figureLabels) {
    return {
      labels: input.figureLabels,
      kind: "figures",
      includeSupplementary:
        input.includeSupplementary ??
        input.figureLabels.some((label) =>
          /supplement|extended\s+data|\bS\d/i.test(label),
        ),
    };
  }
  const userText = collapseWhitespace(input.query || context.request.userText);
  if (!/\b(?:fig(?:ure)?s?|images?)\b/i.test(userText)) return undefined;

  const labels = new Set<string>();
  const labelPattern =
    /\b((?:extended\s+data\s+|supplement(?:ary|al)\s+)?fig(?:ure)?\.?)\s*(S?\d+[A-Za-z]?)/gi;
  for (const match of userText.matchAll(labelPattern)) {
    const prefix = collapseWhitespace(match[1]).toLowerCase();
    const number = collapseWhitespace(match[2]);
    if (!number) continue;
    labels.add(
      prefix.startsWith("extended data")
        ? `Extended Data Figure ${number}`
        : prefix.startsWith("supplement")
          ? `Supplementary Figure ${number}`
          : `Figure ${number}`,
    );
  }
  return {
    labels: [...labels],
    kind: "figures",
    includeSupplementary:
      input.includeSupplementary ??
      /\b(?:supplement(?:ary|al)|extended\s+data|S\d)\b/i.test(userText),
  };
}

async function readTextFile(filePath: string): Promise<string | null> {
  const io = (globalThis as any).IOUtils;
  if (!io?.read) return null;
  try {
    const data = await io.read(filePath);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const text = await readTextFile(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readMineruManifestFromDir(
  cacheDir: string,
): Promise<MineruManifest | null> {
  return readJsonFile<MineruManifest>(joinLocalPath(cacheDir, "manifest.json"));
}

function artifactForFigure(
  figure: ExtractedPdfFigure,
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): AgentToolArtifact {
  return {
    kind: "image",
    mimeType: "image/png",
    storedPath: figure.cropPath,
    title: figure.label,
    pageIndex: figure.pageNumber - 1,
    pageLabel: `${figure.pageNumber}`,
    paperContext,
  };
}

/** Crops are host-produced PNGs. Read their bytes instead of asking the model
 * to invent hashes, dimensions, or native source identity for a document. */
async function describeDocumentFigure(
  figure: ExtractedPdfFigure,
  paperContext: NonNullable<PdfTarget["paperContext"]>,
  sourceFingerprint: string,
): Promise<PlanDocumentAsset> {
  const io = (
    globalThis as unknown as {
      IOUtils: { read: (path: string) => Promise<Uint8Array> };
    }
  ).IOUtils;
  const bytes = await io.read(figure.cropPath);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) {
    throw new Error(`Extracted figure ${figure.label} is not a valid PNG`);
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const item = Zotero.Items.get(paperContext.itemId);
  const attachment = Zotero.Items.get(paperContext.contextItemId);
  if (!item?.key || !attachment?.key) {
    throw new Error(
      `Native source identity is unavailable for ${figure.label}`,
    );
  }
  return {
    assetId: `${attachment.key}-${figure.id}`,
    contentHash: `sha256:${await sha256Bytes(bytes)}`,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width: header.getUint32(16),
    height: header.getUint32(20),
    caption: figure.captionText?.trim() || figure.label,
    durablePath: figure.cropPath,
    provenance: {
      origin: "extracted",
      libraryID: item.libraryID,
      itemKey: item.key,
      attachmentItemKey: attachment.key,
      sourceFingerprint,
      pageIndex: figure.pageNumber - 1,
      extractionToolVersion: `pdf-figure-crop:${PDF_FIGURE_CROP_ALGORITHM_VERSION}`,
    },
  };
}

function cropPathByFigureLabel(
  figures: ExtractedPdfFigure[],
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const figure of figures) {
    for (const label of [figure.label, figure.baseLabel]) {
      const normalized = collapseWhitespace(label).toLowerCase();
      if (normalized && !paths.has(normalized)) {
        paths.set(normalized, figure.cropPath);
      }
    }
  }
  return paths;
}

function refreshExpectedFigureCropPaths(
  expectedFigures: ExpectedPdfFigure[],
  figures: ExtractedPdfFigure[],
): ExpectedPdfFigure[] {
  if (!expectedFigures.length) return expectedFigures;
  const cropPaths = cropPathByFigureLabel(figures);
  return expectedFigures.map((figure) => {
    const cropPath =
      cropPaths.get(collapseWhitespace(figure.label).toLowerCase()) ||
      cropPaths.get(collapseWhitespace(figure.baseLabel).toLowerCase());
    return cropPath ? { ...figure, cropPath } : figure;
  });
}

type CachedFigureRequest = {
  requestedLabels: Set<string>;
  oneBasedPages: Set<number>;
  allFigures: boolean;
  tableRequested: boolean;
};

function normalizeFigureLabelKey(value: unknown): string {
  const text = collapseWhitespace(value);
  if (!text) return "";
  return collapseWhitespace(getManifestFigureBaseLabel(text)).toLowerCase();
}

function addFigureLabelKey(labels: Set<string>, value: unknown): void {
  const label = normalizeFigureLabelKey(value);
  if (label) labels.add(label);
}

function addFigureRecordLabelKeys(
  labels: Set<string>,
  figure: Pick<ExpectedPdfFigure, "label" | "baseLabel">,
): void {
  addFigureLabelKey(labels, figure.label);
  addFigureLabelKey(labels, figure.baseLabel);
}

function normalizeRequestedPages(pages: number[] | undefined): Set<number> {
  const normalized = new Set<number>();
  if (!Array.isArray(pages)) return normalized;
  for (const page of pages) {
    if (!Number.isFinite(page) || page < 0) continue;
    normalized.add(Math.floor(page) + 1);
  }
  return normalized;
}

function labelAllowedForAllQuery(
  label: string,
  includeSupplementary: boolean,
): boolean {
  const normalized = collapseWhitespace(label);
  if (/^Extended Data Figure\s+\d+/i.test(normalized)) {
    return includeSupplementary;
  }
  if (
    /^Supplementary Figure\s+/i.test(normalized) ||
    /^Figure\s+S\d+/i.test(normalized)
  ) {
    return includeSupplementary;
  }
  return true;
}

function buildCachedFigureRequest(
  selection: PdfFigureSelection,
  pages: number[] | undefined,
): CachedFigureRequest {
  const requestedLabels = new Set<string>();
  for (const label of selection.labels)
    addFigureLabelKey(requestedLabels, label);
  return {
    requestedLabels,
    oneBasedPages: normalizeRequestedPages(pages),
    allFigures: !requestedLabels.size && selection.kind !== "tables",
    tableRequested: selection.kind !== "figures",
  };
}

function figureMatchesPages(
  figure: Pick<ExpectedPdfFigure, "pageNumber" | "captionPageNumber">,
  pages: Set<number>,
): boolean {
  if (!pages.size) return true;
  const pageNumber = positiveIntOrZero(figure.pageNumber);
  const captionPageNumber = positiveIntOrZero(figure.captionPageNumber);
  return (
    (pageNumber > 0 && pages.has(pageNumber)) ||
    (captionPageNumber > 0 && pages.has(captionPageNumber))
  );
}

function figureMatchesRequest(
  figure: Pick<
    ExpectedPdfFigure,
    "label" | "baseLabel" | "pageNumber" | "captionPageNumber"
  >,
  request: CachedFigureRequest,
  includeSupplementary: boolean,
): boolean {
  if (!figureMatchesPages(figure, request.oneBasedPages)) return false;
  const labels = new Set<string>();
  addFigureRecordLabelKeys(labels, figure);
  if (request.allFigures) {
    return [...labels].some((label) =>
      labelAllowedForAllQuery(label, includeSupplementary),
    );
  }
  for (const label of labels) {
    if (request.requestedLabels.has(label)) return true;
  }
  return false;
}

function expectedFigureIsKnownMissing(figure: ExpectedPdfFigure): boolean {
  const status = collapseWhitespace(figure.status).toLowerCase();
  return (
    Boolean(status && status !== "ok") || !collapseWhitespace(figure.cropPath)
  );
}

function cachedCoverageLabels(
  figures: ExtractedPdfFigure[],
  expectedFigures: ExpectedPdfFigure[],
  missingFigures: ExpectedPdfFigure[],
): Set<string> {
  const labels = new Set<string>();
  for (const figure of figures) addFigureRecordLabelKeys(labels, figure);
  for (const figure of missingFigures) addFigureRecordLabelKeys(labels, figure);
  for (const figure of expectedFigures) {
    if (expectedFigureIsKnownMissing(figure)) {
      addFigureRecordLabelKeys(labels, figure);
    }
  }
  return labels;
}

function manifestFigureLabelsForAllRequest(
  manifest: MineruManifest | null,
  includeSupplementary: boolean,
): Set<string> {
  const labels = new Set<string>();
  if (!manifest) return labels;
  const figures: Array<Pick<ExpectedPdfFigure, "label" | "baseLabel">> = [];
  if (Array.isArray(manifest.allFigures)) figures.push(...manifest.allFigures);
  if (Array.isArray(manifest.sections)) {
    for (const section of manifest.sections) {
      if (Array.isArray(section.figures)) figures.push(...section.figures);
    }
  }
  for (const figure of figures) {
    const recordLabels = new Set<string>();
    addFigureRecordLabelKeys(recordLabels, figure);
    if (
      ![...recordLabels].some((label) =>
        labelAllowedForAllQuery(label, includeSupplementary),
      )
    ) {
      continue;
    }
    for (const label of recordLabels) labels.add(label);
  }
  return labels;
}

function selectCachedFiguresForRequest(params: {
  figures: ExtractedPdfFigure[];
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
  manifest: MineruManifest | null;
  selection: PdfFigureSelection;
  includeSupplementary?: boolean;
  pages?: number[];
}): {
  figures: ExtractedPdfFigure[];
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
} | null {
  const request = buildCachedFigureRequest(params.selection, params.pages);
  const figures = params.figures.filter((figure) =>
    figureMatchesRequest(figure, request, params.includeSupplementary === true),
  );
  const expectedFigures = params.expectedFigures.filter((figure) =>
    figureMatchesRequest(figure, request, params.includeSupplementary === true),
  );
  const missingFigures = params.missingFigures.filter((figure) =>
    figureMatchesRequest(figure, request, params.includeSupplementary === true),
  );
  const coverage = cachedCoverageLabels(
    figures,
    expectedFigures,
    missingFigures,
  );

  if (request.oneBasedPages.size && !request.requestedLabels.size) return null;
  if (request.allFigures && !request.tableRequested) {
    if (request.oneBasedPages.size) return null;
    const manifestLabels = manifestFigureLabelsForAllRequest(
      params.manifest,
      params.includeSupplementary === true,
    );
    if (!manifestLabels.size) return null;
    for (const label of manifestLabels) {
      if (!coverage.has(label)) return null;
    }
    return { figures, expectedFigures, missingFigures };
  }

  if (request.requestedLabels.size) {
    for (const label of request.requestedLabels) {
      if (!coverage.has(label)) return null;
    }
    return { figures, expectedFigures, missingFigures };
  }

  return null;
}

async function readVerifiedCachedFigures(params: {
  cacheDir: string;
  attachmentId: number;
  manifest: MineruManifest | null;
  manifestHash: string;
  pdfFingerprint: string;
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  selection: PdfFigureSelection;
  includeSupplementary?: boolean;
  pages?: number[];
}): Promise<{
  figures: ExtractedPdfFigure[];
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
} | null> {
  const cache = await readPdfFigureCropCacheFromDir(params.cacheDir);
  if (!cache) return null;

  const freshness = getPdfFigureCropCacheFreshness(cache, {
    manifest: params.manifest,
    paperContext: params.paperContext,
  });
  if (!freshness.ok) {
    if (freshness.reason === "version" || freshness.reason === "algorithm") {
      await removePdfFigureCropCacheDir(params.cacheDir);
    }
    return null;
  }

  if (!cache.entries.length) return null;

  const attachmentMatches =
    positiveIntOrZero(cache.attachmentId) === params.attachmentId;
  if (!attachmentMatches) return null;

  const figures: ExtractedPdfFigure[] = [];
  for (const figure of cache.entries) {
    if (
      collapseWhitespace(figure.cropPath) &&
      (await pdfFigureCropFileExists(figure.cropPath))
    ) {
      figures.push(figure);
    }
  }
  if (!figures.length) return null;

  const expectedFigures = refreshExpectedFigureCropPaths(
    cache.expectedFigures || [],
    figures,
  );
  const missingFigures = cache.missingFigures || [];
  const shouldRewrite =
    figures.length !== cache.entries.length ||
    expectedFigures.some(
      (figure, index) =>
        figure.cropPath !== cache.expectedFigures?.[index]?.cropPath,
    );

  if (shouldRewrite) {
    const rewritten: PdfFigureCropCache = {
      ...cache,
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: params.attachmentId,
      manifestHash: params.manifestHash,
      pdfFingerprint: params.pdfFingerprint,
      renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: Date.now(),
      expectedFigures,
      missingFigures,
      entries: figures,
    };
    try {
      await writePdfFigureCropCacheToDir(params.cacheDir, rewritten);
    } catch {
      // A metadata repair failure should not block already verified crop files.
    }
  }

  return selectCachedFiguresForRequest({
    figures,
    expectedFigures,
    missingFigures,
    manifest: params.manifest,
    selection: params.selection,
    includeSupplementary: params.includeSupplementary,
    pages: params.pages,
  });
}

export class PdfFigureExtractionService {
  constructor(private readonly pdfPageService: PdfPageService) {}

  async extractFigures(
    params: FigureExtractionParams,
  ): Promise<PaperReadFigureExtractionResult> {
    const selection =
      params.selection ||
      resolveDirectFigureSelection(params.input, params.context);
    const query = params.input.query || selection?.labels.join(", ") || "";
    if (!selection)
      return {
        mode: "figures",
        status: "no_figures",
        query,
        guidance:
          "No figure was selected, so no extraction ran. Call paper_read mode:'figures' again with figureLabels (for example ['Figure 1'], or [] for all figures).",
        figures: [],
        artifacts: [],
        warnings: [
          "Figure selection is unresolved. Supply figureLabels (for example ['Figure 1'], or [] for all figures) or name the figure in query.",
        ],
      };
    const figures: Array<
      ExtractedPdfFigure & {
        paperContext: NonNullable<PdfTarget["paperContext"]>;
        pageIndex: number;
        sourceFingerprint: string;
        documentAsset?: PlanDocumentAsset;
      }
    > = [];
    const artifacts: AgentToolArtifact[] = [];
    const warnings: string[] = [];
    const expectedFigures: ExpectedPdfFigure[] = [];
    const missingFigures: ExpectedPdfFigure[] = [];
    // A document asset names its source PDF by content, so each attachment's
    // PDF is read and hashed once in this call; nothing outlives the call.
    const sourcePdfDigests = new Map<number, Promise<string>>();
    const sourcePdfDigest = (attachmentId: number): Promise<string> => {
      let digest = sourcePdfDigests.get(attachmentId);
      if (!digest) {
        digest = (async () => {
          const sourcePath =
            await Zotero.Items.get(attachmentId)?.getFilePathAsync();
          if (!sourcePath)
            throw new Error("The figure source PDF is unavailable");
          const io = (
            globalThis as unknown as {
              IOUtils: { read: (path: string) => Promise<Uint8Array> };
            }
          ).IOUtils;
          return `sha256:${await sha256Bytes(await io.read(sourcePath))}`;
        })();
        sourcePdfDigests.set(attachmentId, digest);
      }
      return digest;
    };

    for (const paperContext of params.paperContexts) {
      const attachmentId = Math.floor(Number(paperContext.contextItemId || 0));
      const mineruCacheDir = collapseWhitespace(paperContext.mineruCacheDir);
      if (!attachmentId) {
        warnings.push(
          `${paperContext.title || "Paper"} does not have a Zotero PDF attachment ID.`,
        );
        continue;
      }
      const figureCacheDir =
        mineruCacheDir ||
        getStandalonePdfFigureCropCacheDirForAttachmentId(attachmentId);

      const manifest = mineruCacheDir
        ? await readMineruManifestFromDir(mineruCacheDir)
        : null;
      const manifestHash = buildPdfFigureCropManifestHash(manifest);
      const pdfFingerprint = buildPdfFigureCropPdfFingerprint(paperContext);
      // Every figure carries the asset a submitted document needs. When the
      // asset cannot be described, the figure stays readable without one.
      const recordFigures = async (rows: ExtractedPdfFigure[]) => {
        let sourceFingerprint = pdfFingerprint;
        let documentAssets: PlanDocumentAsset[] = [];
        if (rows.length && params.documentAssets !== false) {
          try {
            const digest = await sourcePdfDigest(attachmentId);
            for (const figure of rows) {
              documentAssets.push(
                await describeDocumentFigure(figure, paperContext, digest),
              );
            }
            sourceFingerprint = digest;
          } catch (error) {
            documentAssets = [];
            warnings.push(
              `Figures from ${paperContext.title || "this paper"} have no documentAsset, so submit_document cannot include them: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        for (const [index, figure] of rows.entries()) {
          const documentAsset = documentAssets[index];
          figures.push({
            ...figure,
            paperContext,
            pageIndex: figure.pageNumber - 1,
            sourceFingerprint,
            ...(documentAsset ? { documentAsset } : {}),
          });
          artifacts.push({
            ...artifactForFigure(figure, paperContext),
            ...(documentAsset
              ? { contentHash: documentAsset.contentHash }
              : {}),
          });
        }
      };
      const cached = await readVerifiedCachedFigures({
        cacheDir: figureCacheDir,
        attachmentId,
        manifest,
        manifestHash,
        pdfFingerprint,
        paperContext,
        selection,
        includeSupplementary: selection.includeSupplementary,
        pages: params.input.pages,
      });
      if (cached) {
        expectedFigures.push(...cached.expectedFigures);
        missingFigures.push(...cached.missingFigures);
        await recordFigures(cached.figures);
        continue;
      }
      const pageService = this.pdfPageService as FigureCropPageService;
      const rawSourcePdfExtractor = pageService.extractFiguresFromSourcePdf;
      const recordExtractionResult = async (result: {
        figures: ExtractedPdfFigure[];
        expectedFigures?: ExpectedPdfFigure[];
        missingFigures?: ExpectedPdfFigure[];
        warnings?: string[];
      }): Promise<boolean> => {
        const rawFigures = result.figures || [];
        const rawExpectedFigures = result.expectedFigures || [];
        const rawMissingFigures = result.missingFigures || [];
        expectedFigures.push(...rawExpectedFigures);
        missingFigures.push(...rawMissingFigures);
        if (result.warnings?.length) warnings.push(...result.warnings);
        if (!rawFigures.length) return false;
        await recordFigures(rawFigures);
        await writePdfFigureCropCacheToDir(figureCacheDir, {
          version: PDF_FIGURE_CROP_CACHE_VERSION,
          attachmentId,
          manifestHash,
          pdfFingerprint,
          renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
          algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
          generatedAt: Date.now(),
          expectedFigures: rawExpectedFigures,
          missingFigures: rawMissingFigures,
          entries: rawFigures,
        });
        if (mineruCacheDir) {
          try {
            await pruneMineruSourceImagesWhenFigureCropsReady(
              mineruCacheDir,
              manifest,
            );
          } catch (error) {
            warnings.push(
              `Could not remove MinerU source images after figure extraction: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        return true;
      };
      if (typeof rawSourcePdfExtractor !== "function") {
        warnings.push("Source-PDF figure extraction is unavailable.");
        continue;
      }

      try {
        const rawResult = await rawSourcePdfExtractor.call(
          this.pdfPageService,
          {
            request: params.context.request,
            paperContext,
            figureCacheDir,
            ...(mineruCacheDir ? { mineruCacheDir } : {}),
            selection,
            query,
            pages: params.input.pages,
            dpi: 216,
          },
        );
        const rawFigures = Array.isArray(rawResult)
          ? rawResult
          : rawResult.figures || [];
        const rawExpectedFigures = Array.isArray(rawResult)
          ? rawFigures.map((figure) => ({
              label: figure.label,
              baseLabel: figure.baseLabel,
              pageNumber: figure.pageNumber,
              captionPageNumber: figure.captionPageNumber,
              status: "ok",
              cropPath: figure.cropPath,
              source: figure.source,
              confidence: figure.confidence,
            }))
          : rawResult.expectedFigures || [];
        const rawMissingFigures = Array.isArray(rawResult)
          ? []
          : rawResult.missingFigures || [];
        const recorded = await recordExtractionResult({
          figures: rawFigures,
          expectedFigures: rawExpectedFigures,
          missingFigures: rawMissingFigures,
          warnings: Array.isArray(rawResult) ? [] : rawResult.warnings || [],
        });
        if (!recorded) {
          warnings.push(
            `No requested source-PDF figure crops were produced for ${query}.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Could not run source-PDF figure extraction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      mode: "figures",
      status: figures.length ? "ok" : "no_figures",
      query,
      guidance: figures.length
        ? missingFigures.length
          ? "Figure extraction returned partial results. Use the returned PDF crop paths only, state any missing crops plainly, and do not embed MinerU source image paths."
          : "Figure extraction succeeded. Use the returned cropPath values for figure analysis and figure notes; do not call paper_read again for the same figure and do not embed MinerU source image paths. For submit_document, copy each chosen figure's documentAsset object into assets; the host displays those figures and captions. Do not put image paths in the document Markdown."
        : "No extracted figure crop was produced; switch to text-only mode for analysis, note taking, and follow-up artifacts: do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders. Explicitly state that figure extraction failed or no extracted crops are available, and that explanations are based on captions, figure legends, and surrounding paper text. User-provided image inputs are unaffected.",
      figures,
      artifacts,
      expectedFigures,
      missingFigures,
      warnings,
    };
  }
}
