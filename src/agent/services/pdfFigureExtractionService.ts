import {
  getManifestFigureBaseLabel,
  type MineruManifest,
} from "../../modules/contextPanel/mineruCache";
import {
  resolveMineruFigureBlocksForQuery,
  type MineruFigureBlock,
} from "../../modules/contextPanel/mineruFigureBlocks";
import { parseDocumentReferences } from "../../shared/documentReferences";
import { joinLocalPath } from "../../utils/localPath";
import type { PaperReadFigureExtractionResult } from "../tools/read/paperRead";
import type { PdfTarget } from "../tools/read/pdfToolUtils";
import type { AgentToolArtifact, AgentToolContext } from "../types";
import type { PdfPageService } from "./pdfPageService";

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

type MineruFigure = {
  id: string;
  label: string;
  baseLabel: string;
  pageNumber: number;
  imagePath: string;
  captionText?: string;
  panelHint?: string;
  confidence: number;
  source: "mineru";
  warnings: string[];
  mineruBlockId: string;
};

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

async function readFileBytes(filePath: string): Promise<Uint8Array | null> {
  const io = (globalThis as any).IOUtils;
  if (!io?.read) return null;
  try {
    const data = await io.read(filePath);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const bytes = await readFileBytes(filePath);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as T;
  } catch {
    return null;
  }
}

function safeMineruImagePath(cacheDir: string, relativePath: unknown): string {
  const normalized = `${relativePath ?? ""}`.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    /^(?:[A-Za-z]:|\/|\\\\)/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return "";
  }
  return joinLocalPath(cacheDir, ...normalized.split("/").filter(Boolean));
}

function mimeTypeForImagePath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  return "image/png";
}

function legacyManifestBlocks(manifest: MineruManifest): MineruFigureBlock[] {
  return (manifest.allFigures || []).map((figure, index) => ({
    blockId: `manifest:${index}:${figure.path}`,
    kind: "figure",
    imagePaths: [figure.path],
    markdownStart: 0,
    markdownEnd: 0,
    contextStart: 0,
    contextEnd: 0,
    labelHints: [figure.label, figure.baseLabel].filter(Boolean),
    captionHints: figure.caption ? [figure.caption] : [],
    sectionHeading: figure.section || null,
    ...(figure.page !== undefined ? { pageStart: figure.page + 1 } : {}),
    ...(figure.page !== undefined ? { pageEnd: figure.page + 1 } : {}),
    confidence: "high",
    ambiguous: false,
  }));
}

function manifestFigureBlocks(manifest: MineruManifest): MineruFigureBlock[] {
  if (Array.isArray(manifest.figureBlocks) && manifest.figureBlocks.length) {
    return manifest.figureBlocks;
  }
  return legacyManifestBlocks(manifest);
}

function queryRequestsAllFigures(query: string): boolean {
  if (!normalizeText(query)) return true;
  if (parseDocumentReferences(query).some((ref) => ref.kind === "figure")) {
    return false;
  }
  return /\b(all|every|each)\b.*\bfig(?:ure)?s?\b/i.test(query);
}

function selectFigureBlocks(
  query: string,
  blocks: MineruFigureBlock[],
): {
  blocks: MineruFigureBlock[];
  panelHint?: string;
} {
  const figureBlocks = blocks.filter((block) => block.kind !== "table");
  const resolved = resolveMineruFigureBlocksForQuery(query, figureBlocks);
  if (resolved.blocks.length) return resolved;
  return queryRequestsAllFigures(query) ? { blocks: figureBlocks } : resolved;
}

function figureLabel(block: MineruFigureBlock, fallbackIndex: number): string {
  return (
    block.labelHints.find((label) => /\bfig(?:ure)?\b/i.test(label)) ||
    block.labelHints[0] ||
    `Figure ${fallbackIndex + 1}`
  );
}

function artifactForFigure(
  figure: MineruFigure,
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): AgentToolArtifact {
  return {
    kind: "image",
    mimeType: mimeTypeForImagePath(figure.imagePath),
    storedPath: figure.imagePath,
    title: figure.label,
    pageIndex: Math.max(0, figure.pageNumber - 1),
    pageLabel: `${figure.pageNumber}`,
    paperContext,
  };
}

export class PdfFigureExtractionService {
  constructor(_pdfPageService: PdfPageService) {}

  async extractFigures(
    params: FigureExtractionParams,
  ): Promise<PaperReadFigureExtractionResult> {
    const query = params.input.query || params.context.request.userText || "";
    const figures: MineruFigure[] = [];
    const artifacts: AgentToolArtifact[] = [];
    const expectedFigures: Array<Record<string, unknown>> = [];
    const missingFigures: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    let mineruTargetCount = 0;

    for (const paperContext of params.paperContexts) {
      const mineruCacheDir = normalizeText(paperContext.mineruCacheDir);
      if (!mineruCacheDir) {
        warnings.push(
          `${paperContext.title || "Paper"} does not have a MinerU cache.`,
        );
        continue;
      }
      mineruTargetCount += 1;
      const manifest = await readJsonFile<MineruManifest>(
        joinLocalPath(mineruCacheDir, "manifest.json"),
      );
      if (!manifest) {
        warnings.push(
          `${paperContext.title || "Paper"} has no readable MinerU manifest.`,
        );
        continue;
      }

      const selected = selectFigureBlocks(
        query,
        manifestFigureBlocks(manifest),
      );
      for (const [blockIndex, block] of selected.blocks.entries()) {
        const label = figureLabel(block, blockIndex);
        const baseLabel = getManifestFigureBaseLabel(label);
        const pageNumber = Math.max(1, Math.floor(block.pageStart || 1));
        const captionText = block.captionHints[0];
        const validImagePaths: string[] = [];

        for (const imagePath of block.imagePaths || []) {
          const absolutePath = safeMineruImagePath(mineruCacheDir, imagePath);
          if (!absolutePath || !(await readFileBytes(absolutePath))) {
            warnings.push(
              `MinerU image is missing for ${label}: ${imagePath || "(empty path)"}.`,
            );
            continue;
          }
          validImagePaths.push(absolutePath);
        }

        if (!validImagePaths.length) {
          missingFigures.push({
            label,
            baseLabel,
            pageNumber,
            status: "missing_image",
            source: "mineru",
          });
          continue;
        }

        for (const [imageIndex, imagePath] of validImagePaths.entries()) {
          const figure: MineruFigure = {
            id: `${block.blockId}:${imageIndex}`,
            label,
            baseLabel,
            pageNumber,
            imagePath,
            ...(captionText ? { captionText } : {}),
            ...(selected.panelHint ? { panelHint: selected.panelHint } : {}),
            confidence: block.confidence === "high" ? 1 : 0.5,
            source: "mineru",
            warnings: block.ambiguous
              ? ["MinerU mapped this figure block ambiguously."]
              : [],
            mineruBlockId: block.blockId,
          };
          figures.push(figure);
          artifacts.push(artifactForFigure(figure, paperContext));
        }
        expectedFigures.push({
          label,
          baseLabel,
          pageNumber,
          status: "ok",
          imagePaths: validImagePaths,
          source: "mineru",
          confidence: block.confidence === "high" ? 1 : 0.5,
        });
      }
    }

    const status = figures.length
      ? "ok"
      : mineruTargetCount
        ? "no_figures"
        : "mineru_required";

    return {
      mode: "figures",
      status,
      query,
      guidance: figures.length
        ? "Figure images were read directly from the MinerU cache using its figure-label and caption mapping. Use the returned imagePath values and image artifacts as-is; no PDF recropping was performed."
        : mineruTargetCount
          ? "No MinerU image matched the requested figure. Use captions and surrounding text only, and report the missing image mapping."
          : "MinerU cache is required for figure images.",
      figures,
      artifacts,
      expectedFigures,
      missingFigures,
      warnings,
    };
  }
}
