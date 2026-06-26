import { type MineruManifest } from "../../modules/contextPanel/mineruCache";
import {
  PDF_FIGURE_CROP_CACHE_VERSION,
  writePdfFigureCropCacheToDir,
  type ExpectedPdfFigure,
  type ExtractedPdfFigure,
} from "../../modules/contextPanel/pdfFigureCropCache";
import { joinLocalPath } from "../../utils/localPath";
import type { PaperReadFigureExtractionResult } from "../tools/read/paperRead";
import type { PdfTarget } from "../tools/read/pdfToolUtils";
import type { AgentToolArtifact, AgentToolContext } from "../types";
import type { PdfPageService } from "./pdfPageService";

const FIGURE_EXTRACTION_ALGORITHM_VERSION = 9;
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
    mineruCacheDir: string;
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

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
      if (!attachmentId || !mineruCacheDir) {
        warnings.push(`${paperContext.title || "Paper"} is not MinerU-ready.`);
        continue;
      }

      const manifest = await readMineruManifestFromDir(mineruCacheDir);
      const manifestHash = simpleHash(JSON.stringify(manifest || {}));
      const pdfFingerprint = simpleHash(
        [
          paperContext.itemId,
          paperContext.contextItemId,
          paperContext.attachmentTitle,
          paperContext.title,
        ].join("|"),
      );
      const pageService = this.pdfPageService as FigureCropPageService;
      const rawSourcePdfExtractor = pageService.extractFiguresFromSourcePdf;
      if (typeof rawSourcePdfExtractor !== "function") {
        warnings.push(
          "Source-PDF figure extraction is unavailable; MinerU geometry fallback is disabled for figure crops.",
        );
        continue;
      }

      try {
        const rawResult = await rawSourcePdfExtractor.call(this.pdfPageService, {
          request: params.context.request,
          paperContext,
          mineruCacheDir,
          query,
          pages: params.input.pages,
          dpi: 216,
        });
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
        expectedFigures.push(...rawExpectedFigures);
        missingFigures.push(...rawMissingFigures);
        if (!Array.isArray(rawResult) && rawResult.warnings?.length) {
          warnings.push(...rawResult.warnings);
        }
        if (rawFigures.length) {
          for (const figure of rawFigures) {
            figures.push(figure);
            artifacts.push(artifactForFigure(figure, paperContext));
          }
          await writePdfFigureCropCacheToDir(mineruCacheDir, {
            version: PDF_FIGURE_CROP_CACHE_VERSION,
            attachmentId,
            manifestHash,
            pdfFingerprint,
            renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
            algorithmVersion: FIGURE_EXTRACTION_ALGORITHM_VERSION,
            generatedAt: Date.now(),
            expectedFigures: rawExpectedFigures,
            missingFigures: rawMissingFigures,
            entries: rawFigures,
          });
        } else {
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
          ? "Figure extraction returned partial results. Do not write an all-figures note unless the user explicitly accepts a partial note; embed only returned PDF crop paths and do not embed MinerU source image paths."
          : "Figure extraction succeeded. For figure notes, call note_write next and embed the returned cropPath with file:///; do not call paper_read again for the same figure and do not embed MinerU source image paths."
        : "No extracted figure crop was produced. Do not call note_write for a figure note, do not create a text-only substitute figure note, and do not embed MinerU source images.",
      figures,
      artifacts,
      expectedFigures,
      missingFigures,
      warnings,
    };
  }
}
