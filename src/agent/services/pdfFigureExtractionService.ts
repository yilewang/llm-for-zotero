import {
  getManifestFigureBaseLabel,
  type MineruManifest,
} from "../../modules/contextPanel/mineruCache";
import { joinLocalPath } from "../../utils/localPath";
import {
  loadMineruFigureBlocksFromCacheDir,
  toAbsoluteMineruPath,
} from "../../modules/contextPanel/mineruFigureBlockCache";
import {
  resolveMineruFigureBlocksForQuery,
  type MineruFigureBlock,
} from "../../modules/contextPanel/mineruFigureBlocks";
import {
  readPdfFigureCropCacheFromDir,
  writePdfFigureCropBytesToDir,
  writePdfFigureCropCacheToDir,
  PDF_FIGURE_CROP_CACHE_VERSION,
  type ExtractedPdfFigure,
  type ExpectedPdfFigure,
  type PdfFigureCropCache,
} from "../../modules/contextPanel/pdfFigureCropCache";
import {
  resolveFigureCropForTarget,
  type PdfFigureBox,
  type PdfFigureRect,
} from "../../modules/contextPanel/pdfFigureGeometry";
import type { PdfTarget } from "../tools/read/pdfToolUtils";
import type { PaperReadFigureExtractionResult } from "../tools/read/paperRead";
import type { AgentToolArtifact, AgentToolContext } from "../types";
import type {
  PdfFigureHeadlessCropResult,
  PdfPageService,
} from "./pdfPageService";

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

type FigureTarget = {
  id: string;
  label: string;
  baseLabel: string;
  pageIndex: number;
  captionText?: string;
  visualBox?: PdfFigureRect;
  visualAspectRatio?: number;
  block?: MineruFigureBlock;
};

type FigureQueryRef = {
  baseLabel: string;
  panelHint?: string;
  captionIndex?: number;
  captionText?: string;
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
  prepareSourcePdfPagesForFigureExtraction?: (params: {
    request: AgentToolContext["request"];
    paperContext?: NonNullable<PdfTarget["paperContext"]>;
    pages: number[];
    renderScale?: number;
  }) => Promise<{
    pages: Array<{
      pageIndex: number;
      pageLabel: string;
      width: number;
      height: number;
      pdfWidth?: number;
      pdfHeight?: number;
      textBoxes: PdfFigureBox[];
      imageBoxes: PdfFigureBox[];
      inkBoxes: PdfFigureBox[];
    }>;
  }>;
  cropFigureRegionFromPdf?: (params: {
    request: AgentToolContext["request"];
    paperContext?: NonNullable<PdfTarget["paperContext"]>;
    pageIndex: number;
    rect: PdfFigureRect;
    sourcePageSize?: { width: number; height: number };
  }) => Promise<PdfFigureHeadlessCropResult | null>;
};

type ManifestFigureLayoutEntry = {
  label?: string;
  baseLabel?: string;
  path?: string;
  caption?: string;
  page?: number;
  section?: string;
  range?: unknown;
  pdfCropRange?: unknown;
  panelPaths?: unknown;
  canonicalPanelPaths?: unknown;
  preferredPath?: string;
  reconstructedPath?: string;
  visualAspectRatio?: unknown;
  aspectRatio?: unknown;
  width?: unknown;
  height?: unknown;
  imageWidth?: unknown;
  imageHeight?: unknown;
};

type MineruLayoutBlock = {
  type?: unknown;
  bbox?: unknown;
  lines?: unknown;
  content?: unknown;
};

type MineruContentImageEntry = {
  type?: unknown;
  img_path?: unknown;
  page_idx?: unknown;
  bbox?: unknown;
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
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizePathKey(path: unknown): string {
  return `${path || ""}`
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replace(/^<|>$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizeLabelKey(label: unknown): string {
  return getManifestFigureBaseLabel(`${label || ""}`)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function finiteRect(rect: PdfFigureRect): PdfFigureRect | undefined {
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { left, top, width, height };
}

function rectFromLayoutRange(range: unknown): PdfFigureRect | undefined {
  if (Array.isArray(range) && range.length >= 4) {
    const left = Number(range[0]);
    const top = Number(range[1]);
    const right = Number(range[2]);
    const bottom = Number(range[3]);
    return finiteRect({
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
  }
  if (!range || typeof range !== "object") return undefined;
  const record = range as Record<string, unknown>;
  const left = Number(record.left ?? record.x);
  const top = Number(record.top ?? record.y);
  const width = Number(record.width ?? record.w);
  const height = Number(record.height ?? record.h);
  const explicit = finiteRect({ left, top, width, height });
  if (explicit) return explicit;
  const x0 = Number(record.x0 ?? record.left);
  const y0 = Number(record.y0 ?? record.top);
  const x1 = Number(record.x1 ?? record.right);
  const y1 = Number(record.y1 ?? record.bottom);
  return finiteRect({
    left: x0,
    top: y0,
    width: x1 - x0,
    height: y1 - y0,
  });
}

function manifestLayoutRect(
  entry: ManifestFigureLayoutEntry,
): PdfFigureRect | undefined {
  return (
    rectFromLayoutRange(entry.pdfCropRange) || rectFromLayoutRange(entry.range)
  );
}

function numericValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function manifestLayoutAspectRatio(
  entry: ManifestFigureLayoutEntry,
  rect: PdfFigureRect,
): number | undefined {
  const direct =
    numericValue(entry.visualAspectRatio) || numericValue(entry.aspectRatio);
  if (direct) return direct;
  const imageWidth =
    numericValue(entry.imageWidth) || numericValue(entry.width);
  const imageHeight =
    numericValue(entry.imageHeight) || numericValue(entry.height);
  if (imageWidth && imageHeight) return imageWidth / imageHeight;
  return rect.width / rect.height;
}

function collectManifestLayoutEntries(
  manifest: MineruManifest | null,
): ManifestFigureLayoutEntry[] {
  const entries = [
    ...(manifest?.allFigures || []),
    ...(manifest?.sections || []).flatMap((section) => section.figures || []),
  ] as ManifestFigureLayoutEntry[];
  const seen = new Set<string>();
  const unique: ManifestFigureLayoutEntry[] = [];
  for (const entry of entries) {
    const key = [
      normalizeLabelKey(entry.baseLabel || entry.label),
      normalizePathKey(entry.path),
      Number.isFinite(Number(entry.page)) ? Math.floor(Number(entry.page)) : "",
      JSON.stringify(entry.pdfCropRange || entry.range || null),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((left, right) => {
    const leftHasCrop = rectFromLayoutRange(left.pdfCropRange) ? 1 : 0;
    const rightHasCrop = rectFromLayoutRange(right.pdfCropRange) ? 1 : 0;
    return rightHasCrop - leftHasCrop;
  });
}

function manifestEntryPaths(entry: ManifestFigureLayoutEntry): string[] {
  const arrays = [entry.panelPaths, entry.canonicalPanelPaths].flatMap(
    (value) => (Array.isArray(value) ? value : []),
  );
  return [entry.path, entry.preferredPath, entry.reconstructedPath, ...arrays]
    .map(normalizePathKey)
    .filter(Boolean);
}

function pathsOverlap(leftPaths: string[], rightPaths: string[]): boolean {
  for (const leftRaw of leftPaths) {
    const left = normalizePathKey(leftRaw);
    if (!left) continue;
    for (const rightRaw of rightPaths) {
      const right = normalizePathKey(rightRaw);
      if (!right) continue;
      if (
        left === right ||
        left.endsWith(`/${right}`) ||
        right.endsWith(`/${left}`)
      ) {
        return true;
      }
    }
  }
  return false;
}

function manifestEntryMatchesTarget(
  entry: ManifestFigureLayoutEntry,
  target: FigureTarget,
): boolean {
  const entryLabel = normalizeLabelKey(entry.baseLabel || entry.label);
  const targetLabel = normalizeLabelKey(target.baseLabel || target.label);
  if (entryLabel && targetLabel && entryLabel === targetLabel) return true;
  if (
    target.block?.imagePaths?.length &&
    pathsOverlap(manifestEntryPaths(entry), target.block.imagePaths)
  ) {
    return true;
  }
  return false;
}

function attachManifestGeometry(
  target: FigureTarget,
  manifest: MineruManifest | null,
): FigureTarget {
  if (target.visualBox) return target;
  const entry = collectManifestLayoutEntries(manifest).find((candidate) => {
    if (!manifestLayoutRect(candidate)) return false;
    return manifestEntryMatchesTarget(candidate, target);
  });
  if (!entry) return target;
  const visualBox = manifestLayoutRect(entry);
  if (!visualBox) return target;
  return {
    ...target,
    visualBox,
    visualAspectRatio: manifestLayoutAspectRatio(entry, visualBox),
  };
}

function flattenUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    Array.isArray(entry) ? flattenUnknownArray(entry) : [entry],
  );
}

async function readMineruContentImageEntries(
  cacheDir: string,
): Promise<MineruContentImageEntry[]> {
  const entries = await readJsonFile<unknown[]>(
    joinLocalPath(cacheDir, "content_list.json"),
  );
  return flattenUnknownArray(entries)
    .filter((entry): entry is MineruContentImageEntry =>
      Boolean(entry && typeof entry === "object"),
    )
    .filter((entry) => {
      const type = normalizeText(entry.type).toLowerCase();
      return Boolean(entry.img_path) && /image|chart|table/.test(type);
    });
}

function layoutBlocksForPage(
  layout: unknown,
  pageIndex: number,
): MineruLayoutBlock[] {
  const record = layout && typeof layout === "object" ? (layout as any) : null;
  const page =
    Array.isArray(record?.pdf_info) && record.pdf_info[pageIndex]
      ? record.pdf_info[pageIndex]
      : Array.isArray(layout)
        ? (layout as unknown[])[pageIndex]
        : null;
  if (Array.isArray(page)) {
    return page.filter((entry): entry is MineruLayoutBlock =>
      Boolean(entry && typeof entry === "object"),
    );
  }
  if (!page || typeof page !== "object") return [];
  const pageRecord = page as Record<string, unknown>;
  const blocks =
    pageRecord.preproc_blocks || pageRecord.para_blocks || pageRecord.blocks;
  return Array.isArray(blocks)
    ? blocks.filter((entry): entry is MineruLayoutBlock =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
}

function isLayoutImageBlock(block: MineruLayoutBlock): boolean {
  const type = normalizeText(block.type).toLowerCase();
  return /image|chart|table/.test(type);
}

function isLayoutCaptionBlock(block: MineruLayoutBlock): boolean {
  const type = normalizeText(block.type).toLowerCase();
  return /caption|text|paragraph/.test(type);
}

function collectTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(collectTextFromUnknown).filter(Boolean).join(" ");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.content,
    record.text,
    record.lines,
    record.spans,
    record.paragraph_content,
    record.image_caption,
    record.title_content,
  ]
    .map(collectTextFromUnknown)
    .filter(Boolean)
    .join(" ");
}

function layoutBlockText(block: MineruLayoutBlock): string {
  return collectTextFromUnknown(block).replace(/\s+/g, " ").trim();
}

function bboxRect(value: unknown): PdfFigureRect | undefined {
  return rectFromLayoutRange(value);
}

function pageContentImagesForTarget(
  contentImages: MineruContentImageEntry[],
  target: FigureTarget,
): MineruContentImageEntry[] {
  return contentImages.filter((entry) => {
    const page = Number(entry.page_idx);
    return Number.isFinite(page) && Math.floor(page) === target.pageIndex;
  });
}

function imageOrderIndexesForTarget(
  pageImages: MineruContentImageEntry[],
  target: FigureTarget,
): number[] {
  const paths = target.block?.imagePaths || [];
  const indexes = paths
    .map((path) =>
      pageImages.findIndex((entry) =>
        pathsOverlap([normalizePathKey(entry.img_path)], [path]),
      ),
    )
    .filter((index) => index >= 0);
  return Array.from(new Set(indexes)).sort((left, right) => left - right);
}

function expandLayoutRect(rect: PdfFigureRect): PdfFigureRect {
  const xPad = Math.max(5, rect.width * 0.01);
  const topPad = Math.max(10, rect.height * 0.06);
  const bottomPad = Math.max(6, rect.height * 0.04);
  return {
    left: Math.max(0, rect.left - xPad),
    top: Math.max(0, rect.top - topPad),
    width: rect.width + xPad * 2,
    height: rect.height + topPad + bottomPad,
  };
}

async function attachLayoutGeometry(
  target: FigureTarget,
  cacheDir: string,
): Promise<FigureTarget> {
  if (target.visualBox) return target;
  const layout = await readJsonFile<unknown>(
    joinLocalPath(cacheDir, "layout.json"),
  );
  if (!layout) return target;
  const blocks = layoutBlocksForPage(layout, target.pageIndex);
  if (!blocks.length) return target;
  const contentImages = await readMineruContentImageEntries(cacheDir);
  const pageImages = pageContentImagesForTarget(contentImages, target);
  const imageIndexes = imageOrderIndexesForTarget(pageImages, target);
  if (!imageIndexes.length) return target;
  const layoutImages = blocks.filter(isLayoutImageBlock);
  const imageRects = imageIndexes
    .map((index) => bboxRect(layoutImages[index]?.bbox))
    .filter((rect): rect is PdfFigureRect => Boolean(rect));
  if (!imageRects.length) return target;
  const visualBox = expandLayoutRect(rectUnion(imageRects) || imageRects[0]);
  return {
    ...target,
    visualBox,
    visualAspectRatio: visualBox.width / visualBox.height,
  };
}

function scaleRectForRenderedPage(
  rect: PdfFigureRect | undefined,
  page: {
    width: number;
    height: number;
    pdfWidth?: number;
    pdfHeight?: number;
  },
): PdfFigureRect | undefined {
  if (!rect) return undefined;
  const pdfWidth = Number(page.pdfWidth);
  const pdfHeight = Number(page.pdfHeight);
  if (
    !Number.isFinite(pdfWidth) ||
    !Number.isFinite(pdfHeight) ||
    pdfWidth <= 0 ||
    pdfHeight <= 0
  ) {
    return rect;
  }
  const scaleX = page.width / pdfWidth;
  const scaleY = page.height / pdfHeight;
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0 ||
    (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001)
  ) {
    return rect;
  }
  return {
    left: rect.left * scaleX,
    top: rect.top * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function figureId(label: string, pageIndex: number): string {
  const normalized =
    label
      .trim()
      .toLowerCase()
      .replace(/\bfig(?:ure)?\.?/g, "figure")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "figure";
  return `${normalized}-p${pageIndex + 1}`;
}

function queryRequestsAllFigures(query: string): boolean {
  return /\b(all|every|each)\s+(?:the\s+)?(?:figures?|images?|plots?)\b/i.test(
    query,
  );
}

function extractFigureQueryRefs(query: string): FigureQueryRef[] {
  const refs: FigureQueryRef[] = [];
  const pattern =
    /\b(Supplementary\s+)?(Fig(?:ure)?s?\.?|Tables?)\s*([sS]?\d+)([a-z])?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const kind = /^table/i.test(match[2]) ? "Table" : "Figure";
    const prefix = match[1] ? "Supplementary " : "";
    refs.push({
      baseLabel: `${prefix}${kind} ${match[3].toUpperCase()}`,
      ...(match[4] ? { panelHint: match[4].toLowerCase() } : {}),
    });
    const tail = query.slice(pattern.lastIndex);
    const tailPattern = /^\s*(?:,|and|&)\s*([sS]?\d+)([a-z])?/i;
    let tailMatch = tail.match(tailPattern);
    let consumed = 0;
    while (tailMatch) {
      refs.push({
        baseLabel: `${prefix}${kind} ${tailMatch[1].toUpperCase()}`,
        ...(tailMatch[2] ? { panelHint: tailMatch[2].toLowerCase() } : {}),
      });
      consumed += tailMatch[0].length;
      tailMatch = tail.slice(consumed).match(tailPattern);
    }
  }
  return refs;
}

function extractFigureCaptionRefs(fullMd: string): FigureQueryRef[] {
  const refs: FigureQueryRef[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(Supplementary\s+)?(Fig(?:ure)?\.?|Table)\s*([sS]?\d+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fullMd)) !== null) {
    const lineOffset = match[0].startsWith("\n") ? 1 : 0;
    const captionIndex = match.index + lineOffset;
    const kind = /^table/i.test(match[2]) ? "Table" : "Figure";
    const prefix = match[1] ? "Supplementary " : "";
    const baseLabel = `${prefix}${kind} ${match[3].toUpperCase()}`;
    const key = normalizeLabelKey(baseLabel);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push({
      baseLabel,
      captionIndex,
      captionText: captionLineAt(fullMd, captionIndex),
    });
  }
  return refs;
}

function captionRegexForBaseLabel(baseLabel: string): RegExp | null {
  const match = baseLabel.match(
    /^(Supplementary\s+)?(Figure|Table)\s+([sS]?\d+)$/i,
  );
  if (!match) return null;
  const supplementary = match[1]
    ? "Supplementary\\s+"
    : "(?:Supplementary\\s+)?";
  const kind = /^table$/i.test(match[2]) ? "Table" : "Fig(?:ure)?\\.?";
  const number = match[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${supplementary}${kind}\\s*${number}\\b`, "i");
}

function captionLineAt(fullMd: string, index: number): string {
  const start = Math.max(0, fullMd.lastIndexOf("\n", index) + 1);
  const nextBreak = fullMd.indexOf("\n", index);
  const end = nextBreak >= 0 ? nextBreak : fullMd.length;
  return fullMd.slice(start, end).trim();
}

function pageMatches(block: MineruFigureBlock, pages?: number[]): boolean {
  if (!pages?.length) return true;
  const start = Number.isFinite(block.pageStart) ? block.pageStart : undefined;
  const end = Number.isFinite(block.pageEnd) ? block.pageEnd : start;
  if (start === undefined || end === undefined) return true;
  return pages.some((page) => page >= start && page <= end);
}

function inferBlockPage(
  block: MineruFigureBlock,
  fallbackPage?: number,
): number {
  const start = Number(block.pageStart);
  if (Number.isFinite(start) && start >= 0) return Math.floor(start);
  const end = Number(block.pageEnd);
  if (Number.isFinite(end) && end >= 0) return Math.floor(end);
  if (Number.isFinite(fallbackPage) && (fallbackPage as number) >= 0) {
    return Math.floor(fallbackPage as number);
  }
  return 0;
}

function blockLabel(block: MineruFigureBlock, index: number): string {
  const rawLabel =
    block.labelHints.find((label) => /^fig(?:ure)?\.?\s*\w+/i.test(label)) ||
    block.labelHints[0] ||
    `Figure ${index + 1}`;
  return getManifestFigureBaseLabel(rawLabel);
}

function targetsFromBlocks(params: {
  blocks: MineruFigureBlock[];
  query: string;
  pages?: number[];
}): { targets: FigureTarget[]; panelHint?: string } {
  const allFigures = queryRequestsAllFigures(params.query);
  const resolution = allFigures
    ? { blocks: params.blocks, panelHint: undefined }
    : resolveMineruFigureBlocksForQuery(params.query, params.blocks);
  const selected = resolution.blocks
    .filter((block) => ["figure", "image", "mixed"].includes(block.kind))
    .filter((block) => pageMatches(block, params.pages));
  return {
    panelHint: resolution.panelHint,
    targets: selected.map((block, index) => {
      const pageIndex = inferBlockPage(block, params.pages?.[0]);
      const label = blockLabel(block, index);
      return {
        id: block.blockId || figureId(label, pageIndex),
        label,
        baseLabel: getManifestFigureBaseLabel(label),
        pageIndex,
        captionText: block.captionHints[0],
        block,
      };
    }),
  };
}

function targetsFromManifest(params: {
  manifest: MineruManifest | null;
  query: string;
  pages?: number[];
}): FigureTarget[] {
  const figures = params.manifest?.allFigures || [];
  if (!figures.length) return [];
  const allFigures = queryRequestsAllFigures(params.query);
  const normalizedQuery = params.query.toLowerCase();
  return figures
    .filter((figure) => {
      const page = Number(figure.page);
      if (
        params.pages?.length &&
        Number.isFinite(page) &&
        !params.pages.includes(Math.floor(page))
      ) {
        return false;
      }
      if (allFigures) return true;
      const labels = [
        figure.label,
        figure.baseLabel,
        getManifestFigureBaseLabel(figure.label),
      ].filter(Boolean);
      return labels.some((label) =>
        normalizedQuery.includes(label.toLowerCase()),
      );
    })
    .map((figure, index) => {
      const pageIndex = Number.isFinite(Number(figure.page))
        ? Math.floor(Number(figure.page))
        : params.pages?.[0] || 0;
      const label = getManifestFigureBaseLabel(
        figure.label || `Figure ${index + 1}`,
      );
      return {
        id: figureId(label, pageIndex),
        label,
        baseLabel: getManifestFigureBaseLabel(figure.baseLabel || label),
        pageIndex,
        captionText: figure.caption,
      };
    });
}

function samePageAs(
  left: MineruFigureBlock,
  right: MineruFigureBlock,
): boolean {
  const leftStart = Number(left.pageStart);
  const rightStart = Number(right.pageStart);
  if (Number.isFinite(leftStart) && Number.isFinite(rightStart)) {
    return Math.floor(leftStart) === Math.floor(rightStart);
  }
  const leftEnd = Number(left.pageEnd);
  const rightEnd = Number(right.pageEnd);
  if (Number.isFinite(leftEnd) && Number.isFinite(rightEnd)) {
    return Math.floor(leftEnd) === Math.floor(rightEnd);
  }
  return true;
}

function mergeBlocksForCaption(
  blocks: MineruFigureBlock[],
  baseLabel: string,
  captionText: string,
): MineruFigureBlock {
  const ordered = [...blocks].sort(
    (left, right) => left.markdownStart - right.markdownStart,
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1] || first;
  return {
    ...first,
    blockId: `caption:${baseLabel}`,
    kind: ordered.some((block) => block.kind === "mixed") ? "mixed" : "figure",
    imagePaths: ordered.flatMap((block) => block.imagePaths),
    markdownStart: Math.min(...ordered.map((block) => block.markdownStart)),
    markdownEnd: Math.max(...ordered.map((block) => block.markdownEnd)),
    contextStart: Math.min(...ordered.map((block) => block.contextStart)),
    contextEnd: Math.max(...ordered.map((block) => block.contextEnd)),
    labelHints: [baseLabel, ...ordered.flatMap((block) => block.labelHints)],
    captionHints: [
      captionText,
      ...ordered.flatMap((block) => block.captionHints),
    ],
    pageStart: first.pageStart,
    pageEnd: last.pageEnd ?? first.pageEnd,
    confidence: ordered.some((block) => block.confidence === "low")
      ? "low"
      : "high",
    ambiguous: ordered.some((block) => block.ambiguous),
  };
}

function targetsFromCaptionProximity(params: {
  blocks: MineruFigureBlock[];
  fullMd: string;
  query: string;
  pages?: number[];
  refs?: FigureQueryRef[];
}): { targets: FigureTarget[]; panelHint?: string } {
  if (!params.fullMd.trim()) return { targets: [] };
  const refs = params.refs || extractFigureQueryRefs(params.query);
  const targets: FigureTarget[] = [];
  let panelHint: string | undefined;
  for (const ref of refs) {
    if (!panelHint && ref.panelHint) panelHint = ref.panelHint;
    const pattern = captionRegexForBaseLabel(ref.baseLabel);
    if (!pattern) continue;
    const match =
      ref.captionIndex === undefined ? pattern.exec(params.fullMd) : null;
    if (ref.captionIndex === undefined && !match) continue;
    const captionIndex =
      ref.captionIndex === undefined
        ? (match as RegExpExecArray).index
        : ref.captionIndex;
    const eligibleBlocks = params.blocks
      .filter((block) => ["figure", "image", "mixed"].includes(block.kind))
      .filter((block) => pageMatches(block, params.pages))
      .sort((left, right) => left.markdownStart - right.markdownStart);
    const labeledBlocks = eligibleBlocks.filter((block) => {
      const labels = [...block.labelHints, ...block.captionHints].map((label) =>
        normalizeLabelKey(label),
      );
      return labels.includes(normalizeLabelKey(ref.baseLabel));
    });
    const candidateBlocks = eligibleBlocks.filter(
      (block) => block.markdownEnd <= captionIndex,
    );
    const nearest = candidateBlocks[candidateBlocks.length - 1];
    const anchor = labeledBlocks[0] || nearest;
    if (!anchor) continue;
    const samePageBlocks = labeledBlocks.length
      ? labeledBlocks
      : candidateBlocks.filter((block) => samePageAs(block, anchor)).slice(-6);
    const captionText =
      ref.captionText ||
      captionLineAt(params.fullMd, captionIndex) ||
      ref.baseLabel;
    const merged = mergeBlocksForCaption(
      samePageBlocks.length ? samePageBlocks : [anchor],
      ref.baseLabel,
      captionText,
    );
    const pageIndex = inferBlockPage(merged, params.pages?.[0]);
    targets.push({
      id: figureId(ref.baseLabel, pageIndex),
      label: ref.baseLabel,
      baseLabel: ref.baseLabel,
      pageIndex,
      captionText,
      block: merged,
    });
  }
  return {
    targets,
    ...(panelHint ? { panelHint } : {}),
  };
}

function rectUnion(rects: PdfFigureRect[]): PdfFigureRect | null {
  const valid = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!valid.length) return null;
  const left = Math.min(...valid.map((rect) => rect.left));
  const top = Math.min(...valid.map((rect) => rect.top));
  const right = Math.max(...valid.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...valid.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function findCaptionBox(
  textBoxes: PdfFigureBox[],
  label: string,
): PdfFigureRect | undefined {
  const normalizedLabel = label
    .replace(/\bfig(?:ure)?\.?/i, "fig")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const seed = textBoxes.find((box) => {
    const text = normalizeText(box.text)
      .replace(/\bfig(?:ure)?\.?/i, "fig")
      .replace(/\s+/g, " ")
      .toLowerCase();
    return text.includes(normalizedLabel);
  });
  if (!seed) return undefined;
  const captionTop = seed.top;
  const captionBoxes = textBoxes.filter((box) => {
    const sameParagraph =
      Math.abs(box.top - captionTop) <= 34 ||
      (box.top >= captionTop && box.top <= captionTop + 115);
    const horizontal =
      Math.min(seed.left + seed.width, box.left + box.width) -
      Math.max(seed.left, box.left);
    return sameParagraph && horizontal > -80;
  });
  return rectUnion(captionBoxes) || undefined;
}

function captionBoundedRegion(params: {
  pageWidth: number;
  pageHeight: number;
  captionBox?: PdfFigureRect;
  inkBoxes: PdfFigureBox[];
}): PdfFigureRect | null {
  const ink = rectUnion(params.inkBoxes);
  if (!ink) return null;
  if (!params.captionBox) return ink;
  const captionTop = params.captionBox.top;
  const top = Math.max(
    0,
    Math.min(ink.top, captionTop - params.pageHeight * 0.65),
  );
  const bottom = Math.max(
    top + 24,
    Math.min(captionTop - 4, ink.top + ink.height),
  );
  if (bottom <= top) return ink;
  return {
    left: Math.max(0, Math.min(ink.left, params.captionBox.left) - 12),
    top,
    width:
      Math.min(
        params.pageWidth,
        Math.max(
          ink.left + ink.width,
          params.captionBox.left + params.captionBox.width,
        ) + 12,
      ) - Math.max(0, Math.min(ink.left, params.captionBox.left) - 12),
    height: bottom - top,
  };
}

function cacheMatches(params: {
  cache: PdfFigureCropCache | null;
  attachmentId: number;
  manifestHash: string;
  pdfFingerprint: string;
}): boolean {
  return Boolean(
    params.cache &&
    params.cache.version === PDF_FIGURE_CROP_CACHE_VERSION &&
    params.cache.attachmentId === params.attachmentId &&
    params.cache.manifestHash === params.manifestHash &&
    params.cache.pdfFingerprint === params.pdfFingerprint &&
    params.cache.renderScale === FIGURE_EXTRACTION_RENDER_SCALE &&
    params.cache.algorithmVersion === FIGURE_EXTRACTION_ALGORITHM_VERSION,
  );
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

function appendMissingExpectedFigures(params: {
  expectedFigures: ExpectedPdfFigure[];
  missingFigures: ExpectedPdfFigure[];
  entries: Iterable<ExtractedPdfFigure>;
}): void {
  const extractedLabels = new Set(
    Array.from(params.entries).map((entry) =>
      normalizeLabelKey(entry.baseLabel || entry.label),
    ),
  );
  const knownMissing = new Set(
    params.missingFigures.map((entry) =>
      normalizeLabelKey(entry.baseLabel || entry.label),
    ),
  );
  for (const expected of params.expectedFigures) {
    const key = normalizeLabelKey(expected.baseLabel || expected.label);
    if (!key || extractedLabels.has(key) || knownMissing.has(key)) continue;
    params.missingFigures.push({
      ...expected,
      status: expected.status === "ok" ? "missing" : expected.status || "missing",
      cropPath: "",
    });
    knownMissing.add(key);
  }
}

function resolveCropCandidateForPage(
  target: FigureTarget,
  page: {
    pageIndex: number;
    width: number;
    height: number;
    pdfWidth?: number;
    pdfHeight?: number;
    textBoxes: PdfFigureBox[];
    imageBoxes: PdfFigureBox[];
    inkBoxes: PdfFigureBox[];
  },
) {
  const captionBox = findCaptionBox(page.textBoxes, target.label);
  const visualBox = scaleRectForRenderedPage(target.visualBox, page);
  const region = captionBoundedRegion({
    pageWidth: page.width,
    pageHeight: page.height,
    captionBox,
    inkBoxes: page.inkBoxes,
  });
  return resolveFigureCropForTarget({
    target: {
      label: target.label,
      pageNumber: target.pageIndex + 1,
      captionText: target.captionText,
      captionBox,
      visualBox,
      visualAspectRatio: target.visualAspectRatio,
    },
    page: {
      pageNumber: target.pageIndex + 1,
      width: page.width,
      height: page.height,
      textBoxes: page.textBoxes,
      imageBoxes: page.imageBoxes,
      inkBoxes: page.inkBoxes,
      regionBoxes: region ? [region] : page.inkBoxes,
    },
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
      if (typeof rawSourcePdfExtractor === "function") {
        try {
          const rawResult = await rawSourcePdfExtractor.call(
            this.pdfPageService,
            {
              request: params.context.request,
              paperContext,
              mineruCacheDir,
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
        continue;
      }
      let blocks: MineruFigureBlock[] = [];
      try {
        blocks = await loadMineruFigureBlocksFromCacheDir(mineruCacheDir);
      } catch (error) {
        warnings.push(
          `Could not load MinerU figure blocks: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const fullMd = await readTextFile(
        joinLocalPath(mineruCacheDir, "full.md"),
      );
      const allFiguresQuery = queryRequestsAllFigures(query);
      const blockTargets = allFiguresQuery
        ? { targets: [] }
        : targetsFromBlocks({
            blocks,
            query,
            pages: params.input.pages,
          });
      const manifestTargets =
        blockTargets.targets.length && !allFiguresQuery
          ? { targets: [] }
          : {
              targets: targetsFromManifest({
                manifest,
                query,
                pages: params.input.pages,
              }),
            };
      const captionTargets =
        blockTargets.targets.length || manifestTargets.targets.length
          ? { targets: [] }
          : targetsFromCaptionProximity({
              blocks,
              fullMd: fullMd || "",
              query,
              pages: params.input.pages,
              refs: allFiguresQuery
                ? extractFigureCaptionRefs(fullMd || "")
                : undefined,
            });
      const fallbackBlockTargets =
        allFiguresQuery &&
        !manifestTargets.targets.length &&
        !captionTargets.targets.length
          ? targetsFromBlocks({
              blocks,
              query,
              pages: params.input.pages,
            })
          : { targets: [] };
      const resolvedTargets = blockTargets.targets.length
        ? blockTargets.targets
        : manifestTargets.targets.length
          ? manifestTargets.targets
          : captionTargets.targets.length
            ? captionTargets.targets
            : fallbackBlockTargets.targets;
      const targets: FigureTarget[] = [];
      for (const target of resolvedTargets) {
        const manifestTarget = attachManifestGeometry(target, manifest);
        const layoutTarget = target.block?.imagePaths?.length
          ? await attachLayoutGeometry(target, mineruCacheDir)
          : target;
        targets.push(layoutTarget.visualBox ? layoutTarget : manifestTarget);
      }
      const targetExpectedFigures = targets.map((target) => ({
        label: target.label,
        baseLabel: target.baseLabel,
        pageNumber: target.pageIndex + 1,
        captionPageNumber: target.pageIndex + 1,
        status: "pending",
      }));
      expectedFigures.push(...targetExpectedFigures);
      const panelHint = blockTargets.panelHint || captionTargets.panelHint;
      if (!targets.length) {
        warnings.push(`No matching MinerU figure targets found for ${query}.`);
        continue;
      }

      const cache = await readPdfFigureCropCacheFromDir(mineruCacheDir);
      const cacheIsCurrent = cacheMatches({
        cache,
        attachmentId,
        manifestHash,
        pdfFingerprint,
      });
      const currentEntries = cacheIsCurrent ? cache?.entries || [] : [];
      const existingById = new Map(
        currentEntries.map((entry) => [entry.id, entry] as const),
      );
      const nextEntries = new Map(
        currentEntries.map((entry) => [entry.id, entry] as const),
      );

      const missingTargets = targets.filter((target) => {
        const existing = existingById.get(target.id);
        if (!existing) return true;
        figures.push({
          ...existing,
          panelHint: panelHint || existing.panelHint,
        });
        artifacts.push(artifactForFigure(existing, paperContext));
        return false;
      });
      if (!missingTargets.length) continue;

      const cropper = pageService.cropFigureRegionFromPdf;
      const sourceGeometryProvider =
        pageService.prepareSourcePdfPagesForFigureExtraction;
      const remainingAfterSourceGeometry: FigureTarget[] = [];
      if (typeof cropper === "function" && sourceGeometryProvider) {
        const sourcePages = Array.from(
          new Set(missingTargets.map((target) => target.pageIndex)),
        );
        try {
          const sourceGeometry = await sourceGeometryProvider.call(
            this.pdfPageService,
            {
              request: params.context.request,
              paperContext,
              pages: sourcePages,
              renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
            },
          );
          const sourceByPage = new Map(
            sourceGeometry.pages.map((page) => [page.pageIndex, page] as const),
          );
          for (const target of missingTargets) {
            const page = sourceByPage.get(target.pageIndex);
            if (!page) {
              remainingAfterSourceGeometry.push(target);
              continue;
            }
            const cropResult = resolveCropCandidateForPage(target, page);
            if (!cropResult.best) {
              remainingAfterSourceGeometry.push(target);
              continue;
            }
            const crop = await cropper.call(this.pdfPageService, {
              request: params.context.request,
              paperContext,
              pageIndex: target.pageIndex,
              rect: cropResult.best.rect,
              sourcePageSize: {
                width: page.width,
                height: page.height,
              },
            });
            if (!crop?.bytes?.length) {
              remainingAfterSourceGeometry.push(target);
              continue;
            }
            const cropPath = await writePdfFigureCropBytesToDir(
              mineruCacheDir,
              target.id,
              crop.bytes,
            );
            const figure: ExtractedPdfFigure = {
              id: target.id,
              label: target.label,
              baseLabel: target.baseLabel,
              pageNumber: target.pageIndex + 1,
              captionPageNumber: target.pageIndex + 1,
              cropPath,
              captionText: target.captionText,
              panelHint,
              rect: crop.rect || cropResult.best.rect,
              confidence: cropResult.best.confidence,
              source: cropResult.best.source,
              warnings: [...cropResult.best.warnings, ...(crop.warnings || [])],
              mineruBlockId: target.block?.blockId,
              mineruImagePaths: (target.block?.imagePaths || []).map((path) =>
                toAbsoluteMineruPath(mineruCacheDir, path),
              ),
            };
            figures.push(figure);
            artifacts.push(artifactForFigure(figure, paperContext));
            nextEntries.set(figure.id, figure);
          }
        } catch (error) {
          warnings.push(
            `Could not read source-PDF figure geometry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          remainingAfterSourceGeometry.push(...missingTargets);
        }
      } else {
        remainingAfterSourceGeometry.push(...missingTargets);
      }

      const remainingTargets: FigureTarget[] = [];
      for (const target of missingTargets) {
        if (!remainingAfterSourceGeometry.includes(target)) continue;
        if (!target.visualBox || typeof cropper !== "function") {
          remainingTargets.push(target);
          continue;
        }
        try {
          const crop = await cropper.call(this.pdfPageService, {
            request: params.context.request,
            paperContext,
            pageIndex: target.pageIndex,
            rect: target.visualBox,
          });
          if (!crop?.bytes?.length) {
            warnings.push(
              `Could not headlessly crop ${target.label} from the source PDF.`,
            );
            continue;
          }
          const cropPath = await writePdfFigureCropBytesToDir(
            mineruCacheDir,
            target.id,
            crop.bytes,
          );
          const figure: ExtractedPdfFigure = {
            id: target.id,
            label: target.label,
            baseLabel: target.baseLabel,
            pageNumber: target.pageIndex + 1,
            captionPageNumber: target.pageIndex + 1,
            cropPath,
            captionText: target.captionText,
            panelHint,
            rect: crop.rect || target.visualBox,
            confidence: 0.95,
            source: "mineru-layout-region",
            warnings: crop.warnings || [],
            mineruBlockId: target.block?.blockId,
            mineruImagePaths: (target.block?.imagePaths || []).map((path) =>
              toAbsoluteMineruPath(mineruCacheDir, path),
            ),
          };
          figures.push(figure);
          artifacts.push(artifactForFigure(figure, paperContext));
          nextEntries.set(figure.id, figure);
        } catch (error) {
          warnings.push(
            `Could not headlessly crop ${target.label} from the source PDF: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!remainingTargets.length) {
        appendMissingExpectedFigures({
          expectedFigures,
          missingFigures,
          entries: nextEntries.values(),
        });
        await writePdfFigureCropCacheToDir(mineruCacheDir, {
          version: PDF_FIGURE_CROP_CACHE_VERSION,
          attachmentId,
          manifestHash,
          pdfFingerprint,
          renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
          algorithmVersion: FIGURE_EXTRACTION_ALGORITHM_VERSION,
          generatedAt: Date.now(),
          expectedFigures,
          missingFigures,
          entries: Array.from(nextEntries.values()),
        });
        continue;
      }

      const pages = Array.from(
        new Set(remainingTargets.map((target) => target.pageIndex)),
      );
      let rendered;
      try {
        rendered = await this.pdfPageService.preparePagesForFigureExtraction({
          request: params.context.request,
          paperContext,
          pages,
          renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
        });
      } catch (error) {
        warnings.push(
          `Could not render PDF pages for figure extraction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const renderedByPage = new Map(
        rendered.pages.map((page) => [page.pageIndex, page] as const),
      );
      for (const target of remainingTargets) {
        const page = renderedByPage.get(target.pageIndex);
        if (!page) continue;
        const cropResult = resolveCropCandidateForPage(target, page);
        if (!cropResult.best) {
          warnings.push(`No confident figure crop found for ${target.label}.`);
          continue;
        }
        const bytes = await page.cropToPngBytes(cropResult.best.rect);
        const cropPath = await writePdfFigureCropBytesToDir(
          mineruCacheDir,
          target.id,
          bytes,
        );
        const figure: ExtractedPdfFigure = {
          id: target.id,
          label: target.label,
          baseLabel: target.baseLabel,
          pageNumber: target.pageIndex + 1,
          captionPageNumber: target.pageIndex + 1,
          cropPath,
          captionText: target.captionText,
          panelHint,
          rect: cropResult.best.rect,
          confidence: cropResult.best.confidence,
          source: cropResult.best.source,
          warnings: cropResult.best.warnings,
          mineruBlockId: target.block?.blockId,
          mineruImagePaths: (target.block?.imagePaths || []).map((path) =>
            toAbsoluteMineruPath(mineruCacheDir, path),
          ),
        };
        figures.push(figure);
        artifacts.push(artifactForFigure(figure, paperContext));
        nextEntries.set(figure.id, figure);
      }
      appendMissingExpectedFigures({
        expectedFigures,
        missingFigures,
        entries: nextEntries.values(),
      });
      await writePdfFigureCropCacheToDir(mineruCacheDir, {
        version: PDF_FIGURE_CROP_CACHE_VERSION,
        attachmentId,
        manifestHash,
        pdfFingerprint,
        renderScale: FIGURE_EXTRACTION_RENDER_SCALE,
        algorithmVersion: FIGURE_EXTRACTION_ALGORITHM_VERSION,
        generatedAt: Date.now(),
        expectedFigures,
        missingFigures,
        entries: Array.from(nextEntries.values()),
      });
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
      expectedFigures,
      missingFigures,
      figures,
      artifacts,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}
