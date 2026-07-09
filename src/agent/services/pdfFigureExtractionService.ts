import {
  getManifestFigureBaseLabel,
  pruneMineruSourceImagesWhenFigureCropsReady,
  type MineruManifest,
} from "../../modules/contextPanel/mineruCache";
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
} from "../../modules/contextPanel/pdfFigureCropCache";
import { joinLocalPath } from "../../utils/localPath";
import type { PaperReadFigureExtractionResult } from "../tools/read/paperRead";
import type { PdfTarget } from "../tools/read/pdfToolUtils";
import type { AgentToolArtifact, AgentToolContext } from "../types";
import type { PdfPageService } from "./pdfPageService";

const FIGURE_EXTRACTION_RENDER_SCALE = 1.8;

type FigureExtractionInput = {
  query?: string;
  pages?: number[];
  target?: PdfTarget;
};

type FigureExtractionParams = {
  input: FigureExtractionInput;
  context: AgentToolContext;
  paperContexts: NonNullable<PdfTarget["paperContext"]>[];
};

type FigureCropPageService = PdfPageService & {
  extractFiguresFromSourcePdf?: (params: {
    request: AgentToolContext["request"];
    paperContext?: NonNullable<PdfTarget["paperContext"]>;
    figureCacheDir: string;
    mineruCacheDir?: string;
    query: string;
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

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function normalizePositiveInt(value: unknown): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
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

function cropPathByFigureLabel(
  figures: ExtractedPdfFigure[],
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const figure of figures) {
    for (const label of [figure.label, figure.baseLabel]) {
      const normalized = normalizeText(label).toLowerCase();
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
      cropPaths.get(normalizeText(figure.label).toLowerCase()) ||
      cropPaths.get(normalizeText(figure.baseLabel).toLowerCase());
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
  const text = normalizeText(value);
  if (!text) return "";
  return normalizeText(getManifestFigureBaseLabel(text)).toLowerCase();
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

function queryRequestsAllFigures(query: string): boolean {
  const text = normalizeText(query).toLowerCase();
  if (!text) return true;
  return (
    /\b(all|every|each)\s+(?:of\s+the\s+)?fig(?:ure)?s?\b/i.test(text) ||
    /\bfig(?:ure)?s?\s+(?:all|overview|summary)\b/i.test(text)
  );
}

function queryRequestsExtendedOrSupplementary(query: string): boolean {
  return (
    /\bextended\s+data\b/i.test(query) ||
    /\bsupp(?:lementary|lemental)?\b/i.test(query) ||
    /\bfig(?:ure)?\.?\s*S\d+\b/i.test(query)
  );
}

function queryRequestsTable(query: string): boolean {
  return /\btables?\s+(?:S?\d+|[IVX]+)\b/i.test(query);
}

function labelAllowedForAllQuery(label: string, query: string): boolean {
  const normalized = normalizeText(label);
  if (/^Extended Data Figure\s+\d+/i.test(normalized)) {
    return queryRequestsExtendedOrSupplementary(query);
  }
  if (
    /^Supplementary Figure\s+/i.test(normalized) ||
    /^Figure\s+S\d+/i.test(normalized)
  ) {
    return queryRequestsExtendedOrSupplementary(query);
  }
  return true;
}

const FIGURE_LABEL_LIST_PATTERN =
  /\b(?:fig(?:ure)?s?\.?|figs?\.?)\s+(S?\d+[A-Za-z]?(?:\s*(?:(?:,\s*(?:and\s+)?)|(?:&|\band\b|[-\u2013\u2014]|\bto\b)\s*)S?\d+[A-Za-z]?)*)(?![A-Za-z0-9])/gi;

function extractRequestedFigureLabels(query: string): Set<string> {
  const labels = new Set<string>();
  const extendedNumbers = new Set<string>();
  const supplementaryNumbers = new Set<string>();

  for (const match of query.matchAll(
    /\bExtended\s+Data\s+Fig(?:ure)?\.?\s*(\d+)\b/gi,
  )) {
    const number = match[1];
    if (!number) continue;
    extendedNumbers.add(number);
    addFigureLabelKey(labels, `Extended Data Figure ${number}`);
  }

  for (const match of query.matchAll(
    /\bSupplementary\s+Fig(?:ure)?\.?\s*(S?\d+)\b/gi,
  )) {
    const number = match[1]?.toUpperCase();
    if (!number) continue;
    supplementaryNumbers.add(number);
    addFigureLabelKey(labels, `Supplementary Figure ${number}`);
  }

  for (const match of query.matchAll(FIGURE_LABEL_LIST_PATTERN)) {
    const rawSegment = match[1] || "";
    const numbers = Array.from(rawSegment.matchAll(/\bS?\d+[A-Za-z]?\b/gi)).map(
      (item) => item[0].toUpperCase(),
    );
    if (!numbers.length) continue;
    if (
      numbers.length === 2 &&
      /[-\u2013\u2014]|\bto\b/i.test(rawSegment) &&
      !numbers[0].startsWith("S") &&
      !numbers[1].startsWith("S") &&
      /^\d+$/.test(numbers[0]) &&
      /^\d+$/.test(numbers[1])
    ) {
      const start = Number.parseInt(numbers[0], 10);
      const end = Number.parseInt(numbers[1], 10);
      if (start <= end && end - start <= 80) {
        for (let number = start; number <= end; number += 1) {
          addFigureLabelKey(labels, `Figure ${number}`);
        }
        continue;
      }
    }
    for (const number of numbers) {
      addFigureLabelKey(labels, `Figure ${number}`);
    }
  }

  for (const match of query.matchAll(/\bpanel\s+(\d+)\s*([a-z])\b/gi)) {
    if (match[1]) addFigureLabelKey(labels, `Figure ${match[1]}`);
  }

  for (const number of extendedNumbers) {
    labels.delete(normalizeFigureLabelKey(`Figure ${number}`));
  }
  for (const number of supplementaryNumbers) {
    labels.delete(normalizeFigureLabelKey(`Figure ${number}`));
  }

  return labels;
}

function buildCachedFigureRequest(
  query: string,
  pages: number[] | undefined,
): CachedFigureRequest {
  const requestedLabels = extractRequestedFigureLabels(query);
  const tableRequested = queryRequestsTable(query);
  return {
    requestedLabels,
    oneBasedPages: normalizeRequestedPages(pages),
    allFigures:
      queryRequestsAllFigures(query) ||
      (!requestedLabels.size && !tableRequested),
    tableRequested,
  };
}

function figureMatchesPages(
  figure: Pick<ExpectedPdfFigure, "pageNumber" | "captionPageNumber">,
  pages: Set<number>,
): boolean {
  if (!pages.size) return true;
  const pageNumber = normalizePositiveInt(figure.pageNumber);
  const captionPageNumber = normalizePositiveInt(figure.captionPageNumber);
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
  query: string,
): boolean {
  if (!figureMatchesPages(figure, request.oneBasedPages)) return false;
  const labels = new Set<string>();
  addFigureRecordLabelKeys(labels, figure);
  if (request.allFigures) {
    return [...labels].some((label) => labelAllowedForAllQuery(label, query));
  }
  for (const label of labels) {
    if (request.requestedLabels.has(label)) return true;
  }
  return false;
}

function expectedFigureIsKnownMissing(figure: ExpectedPdfFigure): boolean {
  const status = normalizeText(figure.status).toLowerCase();
  return Boolean(status && status !== "ok") || !normalizeText(figure.cropPath);
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
  query: string,
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
      ![...recordLabels].some((label) => labelAllowedForAllQuery(label, query))
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
  query: string;
  pages?: number[];
}): {
  figures: ExtractedPdfFigure[];
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
} | null {
  const request = buildCachedFigureRequest(params.query, params.pages);
  const figures = params.figures.filter((figure) =>
    figureMatchesRequest(figure, request, params.query),
  );
  const expectedFigures = params.expectedFigures.filter((figure) =>
    figureMatchesRequest(figure, request, params.query),
  );
  const missingFigures = params.missingFigures.filter((figure) =>
    figureMatchesRequest(figure, request, params.query),
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
      params.query,
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
  query: string;
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
    normalizePositiveInt(cache.attachmentId) === params.attachmentId;
  if (!attachmentMatches) return null;

  const figures: ExtractedPdfFigure[] = [];
  for (const figure of cache.entries) {
    if (
      normalizeText(figure.cropPath) &&
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
    query: params.query,
    pages: params.pages,
  });
}

export class PdfFigureExtractionService {
  constructor(private readonly pdfPageService: PdfPageService) {}

  async extractFigures(
    params: FigureExtractionParams,
  ): Promise<PaperReadFigureExtractionResult> {
    const query = params.input.query || params.context.request.userText || "";
    const figures: ExtractedPdfFigure[] = [];
    const artifacts: AgentToolArtifact[] = [];
    const warnings: string[] = [];
    const expectedFigures: ExpectedPdfFigure[] = [];
    const missingFigures: ExpectedPdfFigure[] = [];

    for (const paperContext of params.paperContexts) {
      const attachmentId = Math.floor(Number(paperContext.contextItemId || 0));
      const mineruCacheDir = normalizeText(paperContext.mineruCacheDir);
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
      const cached = await readVerifiedCachedFigures({
        cacheDir: figureCacheDir,
        attachmentId,
        manifest,
        manifestHash,
        pdfFingerprint,
        paperContext,
        query,
        pages: params.input.pages,
      });
      if (cached) {
        expectedFigures.push(...cached.expectedFigures);
        missingFigures.push(...cached.missingFigures);
        for (const figure of cached.figures) {
          figures.push(figure);
          artifacts.push(artifactForFigure(figure, paperContext));
        }
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
        for (const figure of rawFigures) {
          figures.push(figure);
          artifacts.push(artifactForFigure(figure, paperContext));
        }
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
          : "Figure extraction succeeded. Use the returned cropPath values for figure analysis and figure notes; do not call paper_read again for the same figure and do not embed MinerU source image paths."
        : "No extracted figure crop was produced; switch to text-only mode for analysis, note taking, and follow-up artifacts: do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders. Explicitly state that figure extraction failed or no extracted crops are available, and that explanations are based on captions, figure legends, and surrounding paper text. User-provided image inputs are unaffected.",
      figures,
      artifacts,
      expectedFigures,
      missingFigures,
      warnings,
    };
  }
}
