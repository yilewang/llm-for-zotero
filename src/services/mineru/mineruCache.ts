import { fnv1a32 } from "../../utils/fnv1a";
import { appLogger } from "../../core/logging";
import { deleteMineruCheckpoint, hashMineruBytes } from "./mineruCheckpoint";
import {
  ensureDir,
  getIOUtils,
  pathExists,
  readFileBytes,
  removePathQuietly,
  writeFileBytes,
} from "../../utils/geckoFs";
import { MineruCancelledError } from "../../utils/mineruClient";
import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  PDF_FIGURE_CROP_METADATA_FILE,
  buildPdfFigureCropManifestHash,
} from "../pdf/pdfFigureCropCache";
import {
  buildMineruFigureBlocks,
  extractFigureLabel,
  getManifestFigureBaseLabel,
  type MineruContentListEntry,
  type MineruFigureBlock,
} from "./mineruFigureBlocks";

export { getManifestFigureBaseLabel } from "./mineruFigureBlocks";
export type ContentListEntry = MineruContentListEntry;

const MINERU_CACHE_DIR_NAME = "llm-for-zotero-mineru";
export const MINERU_SOURCE_PROVENANCE_FILE = "_llm_source.json";

export type MineruCacheFile = {
  relativePath: string;
  data: Uint8Array;
};

export const MINERU_SOURCE_PROVENANCE_KIND =
  "llm-for-zotero/mineru-cache-source";
export const MINERU_SOURCE_PROVENANCE_VERSION = 2;

export type MineruSourceOrigin = "parsed" | "restored";

export type MineruSourceProvenance = {
  kind: typeof MINERU_SOURCE_PROVENANCE_KIND;
  version: typeof MINERU_SOURCE_PROVENANCE_VERSION;
  attachmentId: number;
  attachmentKey?: string;
  parentItemKey?: string;
  sourceFilename?: string;
  origin: MineruSourceOrigin;
  recordedAt: string;
  parsedAt?: string;
  restoredAt?: string;
  packageAttachmentId?: number;
  cacheContentHash?: string;
};

export type MineruSourceProvenanceWriteOptions = {
  origin?: MineruSourceOrigin;
  recordedAt?: string;
  parsedAt?: string;
  restoredAt?: string;
  packageAttachmentId?: number;
  cacheContentHash?: string;
};

type NormalizedMineruCacheFile = MineruCacheFile & {
  originalRelativePath: string;
};

export type NormalizedMineruCacheFiles = {
  mdContent: string;
  files: NormalizedMineruCacheFile[];
  pathMap: Map<string, string>;
};

export type FinalizedMineruCacheFiles = {
  mdContent: string;
  sourceMdContent: string;
  files: NormalizedMineruCacheFile[];
  pathMap: Map<string, string>;
  manifest: MineruManifest;
};

type FinalizeMineruCacheFilesOptions = {
  keepSourceImages?: boolean;
  pageCount?: number;
};

function getBaseDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim())
    return profileDir.trim();
  throw new Error("Cannot resolve data directory for MinerU cache");
}

export function getMineruCacheDir(): string {
  return joinLocalPath(getBaseDir(), MINERU_CACHE_DIR_NAME);
}

export function getMineruItemDir(id: number): string {
  return joinLocalPath(getMineruCacheDir(), String(id));
}

// The md content is stored at a well-known path for quick access
function getMineruMdPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "full.md");
}

// Legacy path (pre-full.md, used _content.md as the well-known name)
function getLegacyContentMdPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "_content.md");
}

// Legacy path (pre-directory cache)
function getLegacyMdPath(id: number): string {
  return joinLocalPath(getMineruCacheDir(), `${id}.md`);
}

// ── MinerU archive path normalization ────────────────────────────────────────

const CONTENT_LIST_FILE_NAME = "content_list.json";
const MANIFEST_FILE_NAME = "manifest.json";
const FULL_MARKDOWN_FILE_NAME = "full.md";
const PDF_FIGURE_CROP_DIR = "figure_crops";
const MINERU_LOCAL_SYNC_STATE_FILE = "_llm_sync_state.json";
const MAX_CACHE_PATH_SEGMENT_LENGTH = 80;
const MAX_CACHE_RELATIVE_PATH_LENGTH = 160;

function stableHash(value: string): string {
  return fnv1a32(value);
}

function splitFileName(fileName: string): { stem: string; ext: string } {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return { stem: fileName, ext: "" };
  return {
    stem: fileName.slice(0, dotIndex),
    ext: fileName.slice(dotIndex),
  };
}

function shortenPathSegment(segment: string, sourcePath: string): string {
  if (segment.length <= MAX_CACHE_PATH_SEGMENT_LENGTH) return segment;
  const { stem, ext } = splitFileName(segment);
  const hash = stableHash(sourcePath).slice(0, 8);
  const maxStemLength = Math.max(
    12,
    MAX_CACHE_PATH_SEGMENT_LENGTH - ext.length - hash.length - 1,
  );
  return `${stem.slice(0, maxStemLength)}-${hash}${ext}`;
}

function shortenTargetParts(parts: string[], sourcePath: string): string[] {
  let nextParts = parts.map((part) => shortenPathSegment(part, sourcePath));
  if (nextParts.join("/").length <= MAX_CACHE_RELATIVE_PATH_LENGTH) {
    return nextParts;
  }

  const basename = nextParts[nextParts.length - 1] || "file";
  const firstSegment = nextParts[0] || "";
  const bucket = /^(images?|imgs?|figures?|tables?)$/i.test(firstSegment)
    ? firstSegment.toLowerCase()
    : "";
  nextParts = bucket ? [bucket, basename] : [basename];
  if (nextParts.join("/").length <= MAX_CACHE_RELATIVE_PATH_LENGTH) {
    return nextParts;
  }

  return [shortenPathSegment(basename, sourcePath)];
}

function normalizePathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function parseSafeArchivePath(relativePath: string): string[] | null {
  const raw = relativePath.trim();
  if (!raw) return null;
  if (/^(?:[A-Za-z]:|[\\/]{2}|[\\/])/.test(raw)) return null;

  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts;
}

function pathStartsWith(parts: string[], prefix: string[]): boolean {
  if (!prefix.length || prefix.length > parts.length) return false;
  return prefix.every((part, index) => parts[index] === part);
}

function stripPrefix(parts: string[], prefix: string[]): string[] {
  return pathStartsWith(parts, prefix) ? parts.slice(prefix.length) : parts;
}

function isMarkdownPath(parts: string[]): boolean {
  return /\.md$/i.test(parts[parts.length - 1] || "");
}

function isPdfPath(parts: string[]): boolean {
  return /\.pdf$/i.test(parts[parts.length - 1] || "");
}

function isContentListPath(parts: string[]): boolean {
  const basename = parts[parts.length - 1] || "";
  return (
    basename === CONTENT_LIST_FILE_NAME ||
    basename.endsWith("_content_list.json")
  );
}

function pickMarkdownCacheFile(
  files: MineruCacheFile[],
): { file: MineruCacheFile; parts: string[] } | null {
  const candidates = files
    .map((file) => ({
      file,
      parts: parseSafeArchivePath(file.relativePath),
    }))
    .filter(
      (entry): entry is { file: MineruCacheFile; parts: string[] } =>
        entry.parts !== null && isMarkdownPath(entry.parts),
    );

  return (
    candidates.find(
      (entry) =>
        (entry.parts[entry.parts.length - 1] || "").toLowerCase() === "full.md",
    ) ||
    candidates[0] ||
    null
  );
}

function relativeParts(fromDir: string[], toParts: string[]): string[] {
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length &&
    fromDir[common] === toParts[common]
  ) {
    common++;
  }

  return [
    ...Array.from({ length: fromDir.length - common }, () => ".."),
    ...toParts.slice(common),
  ];
}

function addPathMapVariant(
  pathMap: Map<string, string>,
  fromPath: string,
  toPath: string,
): void {
  const normalized = normalizePathKey(fromPath);
  if (!normalized || normalized === toPath) return;

  const existing = pathMap.get(normalized);
  if (!existing) {
    pathMap.set(normalized, toPath);
  } else if (existing !== toPath) {
    pathMap.delete(normalized);
  }
}

function addPathMapVariants(params: {
  pathMap: Map<string, string>;
  originalRelativePath: string;
  originalParts: string[];
  targetPath: string;
  strippedParts: string[];
  mdDirParts: string[];
}): void {
  const {
    pathMap,
    originalRelativePath,
    originalParts,
    targetPath,
    strippedParts,
    mdDirParts,
  } = params;

  addPathMapVariant(pathMap, originalRelativePath, targetPath);
  addPathMapVariant(pathMap, originalParts.join("/"), targetPath);
  addPathMapVariant(pathMap, strippedParts.join("/"), targetPath);

  if (mdDirParts.length) {
    addPathMapVariant(
      pathMap,
      relativeParts(mdDirParts, originalParts).join("/"),
      targetPath,
    );
  }
}

function buildStrippedArchiveParts(
  parts: string[],
  mdDirParts: string[],
): string[] {
  let stripped = stripPrefix(parts, mdDirParts);
  if (
    stripped === parts &&
    mdDirParts.length > 0 &&
    parts[0] === mdDirParts[0]
  ) {
    stripped = parts.slice(1);
  }
  if (stripped[0]?.toLowerCase() === "auto" && stripped.length > 1) {
    stripped = stripped.slice(1);
  }
  return stripped;
}

function normalizeArchiveTargetPath(params: {
  originalParts: string[];
  mdDirParts: string[];
  sourcePath: string;
}): { targetParts: string[]; strippedParts: string[] } | null {
  const { originalParts, mdDirParts, sourcePath } = params;
  if (isPdfPath(originalParts) || isMarkdownPath(originalParts)) return null;

  const strippedParts = buildStrippedArchiveParts(originalParts, mdDirParts);
  if (!strippedParts.length) return null;

  let targetParts = isContentListPath(strippedParts)
    ? [CONTENT_LIST_FILE_NAME]
    : strippedParts;

  targetParts = shortenTargetParts(targetParts, sourcePath);
  if (
    !targetParts.length ||
    targetParts.some((part) => part === "." || part === "..")
  ) {
    return null;
  }

  return { targetParts, strippedParts };
}

function resolveTargetCollision(params: {
  targetParts: string[];
  sourcePath: string;
  usedTargets: Map<string, string>;
}): string {
  const { targetParts, sourcePath, usedTargets } = params;
  let targetPath = targetParts.join("/");
  const existingSource = usedTargets.get(targetPath);
  if (!existingSource || existingSource === sourcePath) {
    usedTargets.set(targetPath, sourcePath);
    return targetPath;
  }

  const basename = targetParts[targetParts.length - 1] || "file";
  const { stem, ext } = splitFileName(basename);
  const hash = stableHash(sourcePath).slice(0, 8);
  const dedupedName = shortenPathSegment(`${stem}-${hash}${ext}`, sourcePath);
  const dedupedParts = [...targetParts.slice(0, -1), dedupedName];
  targetPath = dedupedParts.join("/");
  usedTargets.set(targetPath, sourcePath);
  return targetPath;
}

function isExternalOrAnchorPath(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value);
}

function rewritePathValue(value: string, pathMap: Map<string, string>): string {
  const trimmed = value.trim();
  if (!trimmed || isExternalOrAnchorPath(trimmed)) return value;

  const normalized = normalizePathKey(trimmed);
  const mapped = pathMap.get(normalized);
  return mapped || value;
}

function rewriteMarkdownPathRefs(
  mdContent: string,
  pathMap: Map<string, string>,
): string {
  return mdContent
    .replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (match, prefix, target, suffix) => {
      const trimmedTarget = String(target).trim();
      const unwrapped =
        trimmedTarget.startsWith("<") && trimmedTarget.endsWith(">")
          ? trimmedTarget.slice(1, -1)
          : trimmedTarget;
      const rewritten = rewritePathValue(unwrapped, pathMap);
      if (rewritten === unwrapped) return match;
      const nextTarget =
        trimmedTarget.startsWith("<") && trimmedTarget.endsWith(">")
          ? `<${rewritten}>`
          : rewritten;
      return `${prefix}${nextTarget}${suffix}`;
    })
    .replace(
      /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
      (match, prefix, target, suffix) => {
        const rewritten = rewritePathValue(String(target), pathMap);
        return rewritten === target ? match : `${prefix}${rewritten}${suffix}`;
      },
    );
}

function rewriteContentListPathValues(
  value: unknown,
  pathMap: Map<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteContentListPathValues(entry, pathMap));
  }
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      /(^|_)(?:img|image|table).*path$/i.test(key)
    ) {
      out[key] = rewritePathValue(entry, pathMap);
    } else {
      out[key] = rewriteContentListPathValues(entry, pathMap);
    }
  }
  return out;
}

function rewriteContentListFile(
  data: Uint8Array,
  pathMap: Map<string, string>,
): Uint8Array {
  try {
    const json = JSON.parse(new TextDecoder("utf-8").decode(data));
    const rewritten = rewriteContentListPathValues(json, pathMap);
    return new TextEncoder().encode(JSON.stringify(rewritten));
  } catch {
    return data;
  }
}

function parseContentListBytes(data: Uint8Array): ContentListEntry[] {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(data));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readContentListFromNormalizedFiles(
  files: NormalizedMineruCacheFile[],
): ContentListEntry[] {
  const contentList = files.find((file) =>
    isContentListPath(file.relativePath.split(/[\\/]+/).filter(Boolean)),
  );
  return contentList ? parseContentListBytes(contentList.data) : [];
}

function readManifestFromNormalizedFiles(
  files: NormalizedMineruCacheFile[],
): MineruManifest | null {
  const manifestFile = files.find(
    (file) => file.relativePath === "manifest.json",
  );
  if (!manifestFile) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8").decode(manifestFile.data),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as MineruManifest)
      : null;
  } catch {
    return null;
  }
}

function unwrapMarkdownTarget(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isLocalMarkdownTarget(value: string): boolean {
  const target = unwrapMarkdownTarget(value);
  return Boolean(target.trim()) && !isExternalOrAnchorPath(target.trim());
}

function stripLocalImageEmbedsFromLine(line: string): {
  line: string;
  removed: boolean;
} {
  let removed = false;
  const withoutMarkdownImages = line.replace(
    /!\[[^\]]*]\(([^)\n]+)\)/g,
    (match, target) => {
      if (!isLocalMarkdownTarget(String(target))) return match;
      removed = true;
      return "";
    },
  );
  const withoutHtmlImages = withoutMarkdownImages.replace(
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    (match, target) => {
      if (!isLocalMarkdownTarget(String(target))) return match;
      removed = true;
      return "";
    },
  );
  return { line: withoutHtmlImages.replace(/[ \t]+$/g, ""), removed };
}

export function stripMineruSourceImageEmbedsFromMarkdown(
  mdContent: string,
): string {
  const lines = mdContent.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const stripped = stripLocalImageEmbedsFromLine(line);
    if (stripped.removed && !stripped.line.trim()) continue;
    out.push(stripped.line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function hasLocalImageEmbeds(mdContent: string): boolean {
  return stripMineruSourceImageEmbedsFromMarkdown(mdContent) !== mdContent;
}

export function isDurableMineruCacheArtifactPath(
  relativePath: string,
  options: {
    includeLocalSyncState?: boolean;
    includeSourceImages?: boolean;
  } = {},
): boolean {
  const parts = parseSafeArchivePath(relativePath);
  if (!parts) return false;
  if (parts[0] === "__MACOSX") return false;
  const basename = parts[parts.length - 1] || "";
  if (!basename || basename === ".DS_Store") return false;
  const normalized = parts.join("/");
  if (
    normalized === FULL_MARKDOWN_FILE_NAME ||
    normalized === MANIFEST_FILE_NAME ||
    normalized === CONTENT_LIST_FILE_NAME ||
    normalized === MINERU_SOURCE_PROVENANCE_FILE
  ) {
    return true;
  }
  if (
    options.includeLocalSyncState &&
    normalized === MINERU_LOCAL_SYNC_STATE_FILE
  ) {
    return true;
  }
  if (
    options.includeSourceImages &&
    parts[0] === "images" &&
    parts.length > 1
  ) {
    return true;
  }
  return parts[0] === PDF_FIGURE_CROP_DIR && parts.length > 1;
}

function shouldWriteFinalizedCacheFile(
  relativePath: string,
  options: { keepSourceImages?: boolean } = {},
): boolean {
  return isDurableMineruCacheArtifactPath(relativePath, {
    includeSourceImages: options.keepSourceImages,
  });
}

function normalizeFigureCoverageLabel(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function readFigureCoverageLabels(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as { label?: unknown; baseLabel?: unknown };
  return [record.label, record.baseLabel]
    .map(normalizeFigureCoverageLabel)
    .filter(Boolean);
}

function readManifestFigureCoverageTargets(
  manifest: MineruManifest,
): unknown[] {
  const figures: unknown[] = [];
  if (Array.isArray(manifest.allFigures)) {
    figures.push(...manifest.allFigures);
  }
  if (Array.isArray(manifest.sections)) {
    for (const section of manifest.sections) {
      if (Array.isArray(section.figures)) {
        figures.push(...section.figures);
      }
    }
  }
  return figures;
}

function resolveCropProbePath(itemDir: string, cropPath: string): string {
  const normalized = cropPath.trim();
  if (!normalized) return normalized;
  if (/^(?:[A-Za-z]:|[\\/]{2}|[\\/])/.test(normalized)) return normalized;
  const relative = normalizePathKey(normalized);
  if (relative.startsWith(`${PDF_FIGURE_CROP_DIR}/`)) {
    return joinLocalPath(itemDir, ...relative.split("/"));
  }
  return normalized;
}

async function cropFileExists(
  itemDir: string,
  cropPath: unknown,
): Promise<boolean> {
  if (typeof cropPath !== "string" || !cropPath.trim()) return false;
  const probePath = resolveCropProbePath(itemDir, cropPath);
  if (await pathExists(probePath)) return true;
  return Boolean(await readFileBytes(probePath));
}

async function readReadyCropEntryLabels(params: {
  itemDir: string;
  entries: unknown;
}): Promise<Set<string>> {
  const labels = new Set<string>();
  if (!Array.isArray(params.entries)) return labels;
  for (const entry of params.entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { cropPath?: unknown };
    if (!(await cropFileExists(params.itemDir, record.cropPath))) continue;
    for (const label of readFigureCoverageLabels(entry)) {
      labels.add(label);
    }
  }
  return labels;
}

async function hasReadyPdfFigureCropCache(
  itemDir: string,
  manifest: MineruManifest,
): Promise<boolean> {
  const manifestFigures = readManifestFigureCoverageTargets(manifest);
  if (!manifestFigures.length) return false;

  const bytes = await readFileBytes(
    joinLocalPath(itemDir, PDF_FIGURE_CROP_DIR, PDF_FIGURE_CROP_METADATA_FILE),
  );
  if (!bytes) return false;

  let cache: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (!parsed || typeof parsed !== "object") return false;
    cache = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  if (cache.version !== PDF_FIGURE_CROP_CACHE_VERSION) return false;
  if (cache.algorithmVersion !== PDF_FIGURE_CROP_ALGORITHM_VERSION) {
    return false;
  }
  if (cache.manifestHash !== buildPdfFigureCropManifestHash(manifest)) {
    return false;
  }
  if (Array.isArray(cache.missingFigures) && cache.missingFigures.length) {
    return false;
  }

  const readyLabels = await readReadyCropEntryLabels({
    itemDir,
    entries: cache.entries,
  });
  if (!readyLabels.size) return false;

  return manifestFigures.every((figure) => {
    const figureLabels = readFigureCoverageLabels(figure);
    return figureLabels.some((label) => readyLabels.has(label));
  });
}

async function getChildren(path: string): Promise<string[] | null> {
  const io = getIOUtils();
  if (io?.getChildren) {
    try {
      return await io.getChildren(path);
    } catch {
      return null;
    }
  }
  return null;
}

function relativeCachePath(rootPath: string, filePath: string): string | null {
  const root = normalizePathKey(rootPath);
  const file = normalizePathKey(filePath);
  if (!file || file === root) return null;
  const prefix = `${root}/`;
  if (!file.startsWith(prefix)) return null;
  return file.slice(prefix.length);
}

export async function pruneNonDurableMineruCacheArtifacts(
  itemDir: string,
  options: { keepSourceImages?: boolean } = {},
): Promise<boolean> {
  let changed = false;
  const root = normalizePathKey(itemDir);

  async function visit(dir: string): Promise<void> {
    const children = await getChildren(dir);
    if (!children) return;
    for (const child of children) {
      const relativePath = relativeCachePath(root, child);
      if (!relativePath || relativePath === PENDING_CACHE_WRITE) continue;
      const childEntries = await getChildren(child);
      if (childEntries) {
        if (
          !isDurableMineruCacheArtifactPath(`${relativePath}/placeholder`, {
            includeLocalSyncState: true,
            includeSourceImages: options.keepSourceImages,
          })
        ) {
          await removePathQuietly(child);
          changed = true;
          continue;
        }
        await visit(child);
        continue;
      }
      if (
        !isDurableMineruCacheArtifactPath(relativePath, {
          includeLocalSyncState: true,
          includeSourceImages: options.keepSourceImages,
        })
      ) {
        await removePathQuietly(child);
        changed = true;
      }
    }
  }

  await visit(itemDir);
  return changed;
}

export async function pruneMineruSourceImagesWhenFigureCropsReady(
  itemDir: string,
  manifest: MineruManifest | null | undefined,
): Promise<boolean> {
  if (!manifest) return false;
  if (!(await hasReadyPdfFigureCropCache(itemDir, manifest))) return false;
  return await pruneNonDurableMineruCacheArtifacts(itemDir, {
    keepSourceImages: false,
  });
}

export function normalizeMineruCacheFiles(
  mdContent: string,
  files: MineruCacheFile[],
): NormalizedMineruCacheFiles {
  const mdFile = pickMarkdownCacheFile(files);
  const mdDirParts = mdFile ? mdFile.parts.slice(0, -1) : [];
  const pathMap = new Map<string, string>();
  const usedTargets = new Map<string, string>();
  const normalizedFiles: NormalizedMineruCacheFile[] = [];

  const canonicalContentList = files.find(
    (file) =>
      normalizePathKey(file.relativePath).toLowerCase() ===
      CONTENT_LIST_FILE_NAME,
  );
  if (canonicalContentList) {
    usedTargets.set(CONTENT_LIST_FILE_NAME, canonicalContentList.relativePath);
  }

  if (mdFile) {
    addPathMapVariant(pathMap, mdFile.file.relativePath, "full.md");
    addPathMapVariant(pathMap, mdFile.parts.join("/"), "full.md");
  }

  const pendingFiles: Array<{
    data: Uint8Array;
    originalRelativePath: string;
    originalParts: string[];
    targetPath: string;
  }> = [];

  for (const file of files) {
    const originalParts = parseSafeArchivePath(file.relativePath);
    if (!originalParts) continue;

    const normalized = normalizeArchiveTargetPath({
      originalParts,
      mdDirParts,
      sourcePath: file.relativePath,
    });
    if (!normalized) continue;

    const targetPath = resolveTargetCollision({
      targetParts: normalized.targetParts,
      sourcePath: file.relativePath,
      usedTargets,
    });

    addPathMapVariants({
      pathMap,
      originalRelativePath: file.relativePath,
      originalParts,
      targetPath,
      strippedParts: normalized.strippedParts,
      mdDirParts,
    });

    pendingFiles.push({
      data: file.data,
      originalRelativePath: file.relativePath,
      originalParts,
      targetPath,
    });
  }

  const rewrittenMdContent = rewriteMarkdownPathRefs(mdContent, pathMap);

  for (const file of pendingFiles) {
    const data = isContentListPath(file.originalParts)
      ? rewriteContentListFile(file.data, pathMap)
      : file.data;
    normalizedFiles.push({
      relativePath: file.targetPath,
      originalRelativePath: file.originalRelativePath,
      data,
    });
  }

  return {
    mdContent: rewrittenMdContent,
    files: normalizedFiles,
    pathMap,
  };
}

export function finalizeMineruCacheFiles(
  mdContent: string,
  files: MineruCacheFile[],
  options: FinalizeMineruCacheFilesOptions = {},
): FinalizedMineruCacheFiles {
  const normalized = normalizeMineruCacheFiles(mdContent, files);
  const contentList = readContentListFromNormalizedFiles(normalized.files);
  const canonicalMdContent = stripMineruSourceImageEmbedsFromMarkdown(
    normalized.mdContent,
  );
  const incomingManifest = readManifestFromNormalizedFiles(normalized.files);
  // Saved packages know the PDF length, including pages with no extracted text.
  const savedPageCount = incomingManifest?.totalPages;
  const pageCount =
    options.pageCount ??
    (Number.isSafeInteger(savedPageCount) &&
    savedPageCount! > 0 &&
    incomingManifest?.totalChars === normalized.mdContent.length
      ? savedPageCount
      : undefined);
  const sourceManifest = buildManifest(
    normalized.mdContent,
    contentList,
    pageCount,
  );
  const canonicalManifest = buildManifest(
    canonicalMdContent,
    contentList,
    pageCount,
  );
  const figureBlocks = hasLocalImageEmbeds(normalized.mdContent)
    ? sourceManifest.figureBlocks
    : incomingManifest?.figureBlocks || sourceManifest.figureBlocks;
  return {
    mdContent: canonicalMdContent,
    sourceMdContent: normalized.mdContent,
    files: normalized.files.filter((file) =>
      shouldWriteFinalizedCacheFile(file.relativePath, {
        keepSourceImages: options.keepSourceImages,
      }),
    ),
    pathMap: normalized.pathMap,
    manifest: {
      ...canonicalManifest,
      figureBlocks,
    },
  };
}

function formatCacheWriteError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }
  return String(error || "Unknown error");
}

function getItemKey(item: Zotero.Item | null | undefined): string {
  const value = (item as unknown as { key?: unknown } | null | undefined)?.key;
  return typeof value === "string" ? value.trim() : "";
}

function getAttachmentFilename(item: Zotero.Item): string {
  return String(
    (item as unknown as { attachmentFilename?: unknown }).attachmentFilename ||
      "",
  ).trim();
}

function getParentItem(item: Zotero.Item): Zotero.Item | null {
  const parentId = Number(item.parentID);
  if (!Number.isFinite(parentId) || parentId <= 0) return null;
  return Zotero.Items.get(Math.floor(parentId)) || null;
}

function parseMineruSourceProvenance(
  value: unknown,
): MineruSourceProvenance | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<MineruSourceProvenance> & {
    kind?: unknown;
    version?: unknown;
    attachmentId?: unknown;
    attachmentKey?: unknown;
    parentItemKey?: unknown;
    sourceFilename?: unknown;
    origin?: unknown;
    recordedAt?: unknown;
    parsedAt?: unknown;
    restoredAt?: unknown;
    packageAttachmentId?: unknown;
    cacheContentHash?: unknown;
  };
  const attachmentId = Number(record.attachmentId);
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
    return null;
  }
  const origin =
    record.origin === "parsed" || record.origin === "restored"
      ? record.origin
      : "parsed";
  const legacyParsedAt =
    typeof record.parsedAt === "string" && record.parsedAt.trim()
      ? record.parsedAt.trim()
      : undefined;
  const recordedAt =
    typeof record.recordedAt === "string" && record.recordedAt.trim()
      ? record.recordedAt.trim()
      : legacyParsedAt || new Date(0).toISOString();
  const packageAttachmentId = Number(record.packageAttachmentId);
  return {
    kind: MINERU_SOURCE_PROVENANCE_KIND,
    version: MINERU_SOURCE_PROVENANCE_VERSION,
    attachmentId: Math.floor(attachmentId),
    attachmentKey:
      typeof record.attachmentKey === "string"
        ? record.attachmentKey
        : undefined,
    parentItemKey:
      typeof record.parentItemKey === "string"
        ? record.parentItemKey
        : undefined,
    sourceFilename:
      typeof record.sourceFilename === "string"
        ? record.sourceFilename
        : undefined,
    origin,
    recordedAt,
    parsedAt: legacyParsedAt,
    restoredAt:
      typeof record.restoredAt === "string" && record.restoredAt.trim()
        ? record.restoredAt.trim()
        : undefined,
    packageAttachmentId:
      Number.isFinite(packageAttachmentId) && packageAttachmentId > 0
        ? Math.floor(packageAttachmentId)
        : undefined,
    cacheContentHash:
      typeof record.cacheContentHash === "string" &&
      record.cacheContentHash.trim()
        ? record.cacheContentHash.trim()
        : undefined,
  };
}

function getMineruSourceProvenancePath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), MINERU_SOURCE_PROVENANCE_FILE);
}

export async function buildMineruSourceProvenance(
  attachment: Zotero.Item,
  options: MineruSourceProvenanceWriteOptions = {},
): Promise<MineruSourceProvenance> {
  const parentItem = getParentItem(attachment);
  const now = options.recordedAt || new Date().toISOString();
  const origin = options.origin || "parsed";
  return {
    kind: MINERU_SOURCE_PROVENANCE_KIND,
    version: MINERU_SOURCE_PROVENANCE_VERSION,
    attachmentId: attachment.id,
    attachmentKey: getItemKey(attachment) || undefined,
    parentItemKey: getItemKey(parentItem) || undefined,
    sourceFilename: getAttachmentFilename(attachment) || undefined,
    origin,
    recordedAt: now,
    parsedAt: options.parsedAt || (origin === "parsed" ? now : undefined),
    restoredAt: options.restoredAt || (origin === "restored" ? now : undefined),
    packageAttachmentId: options.packageAttachmentId,
    cacheContentHash: options.cacheContentHash,
  };
}

export async function readMineruSourceProvenance(
  attachmentId: number,
): Promise<MineruSourceProvenance | null> {
  const bytes = await readFileBytes(
    getMineruSourceProvenancePath(attachmentId),
  );
  if (!bytes) return null;
  try {
    return parseMineruSourceProvenance(
      JSON.parse(new TextDecoder("utf-8").decode(bytes)),
    );
  } catch {
    return null;
  }
}

export async function writeMineruSourceProvenance(
  attachmentId: number,
  provenance: MineruSourceProvenance,
): Promise<void> {
  await ensureDir(getMineruItemDir(attachmentId));
  await writeFileBytes(
    getMineruSourceProvenancePath(attachmentId),
    new TextEncoder().encode(JSON.stringify(provenance, null, 2)),
  );
}

export async function writeMineruSourceProvenanceForAttachment(
  attachment: Zotero.Item,
  options: MineruSourceProvenanceWriteOptions = {},
): Promise<MineruSourceProvenance> {
  const provenance = await buildMineruSourceProvenance(attachment, options);
  await writeMineruSourceProvenance(attachment.id, provenance);
  return provenance;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function hasCachedMineruMd(id: number): Promise<boolean> {
  if (await hasPendingCacheWrite(id)) return false;
  if (await pathExists(getMineruMdPath(id))) return true;
  // Check legacy _content.md path
  if (await pathExists(getLegacyContentMdPath(id))) return true;
  // Check legacy single-file cache
  return await pathExists(getLegacyMdPath(id));
}

export async function readCachedMineruMd(id: number): Promise<string | null> {
  if (await hasPendingCacheWrite(id)) return null;
  // Keep pre-directory and _content.md caches readable on upgrade.
  for (const path of [
    getMineruMdPath(id),
    getLegacyContentMdPath(id),
    getLegacyMdPath(id),
  ]) {
    const bytes = await readFileBytes(path);
    if (await hasPendingCacheWrite(id)) return null;
    if (bytes) return new TextDecoder("utf-8").decode(bytes);
  }
  return null;
}

const PENDING_CACHE_WRITE = "_llm_write_pending.json";
export async function hasPendingCacheWrite(id: number): Promise<boolean> {
  return pathExists(joinLocalPath(getMineruItemDir(id), PENDING_CACHE_WRITE));
}

export function validateMineruManifest(
  md: string,
  manifest: MineruManifest,
  pageCount?: number,
): void {
  if (manifest.totalChars !== md.length)
    throw new Error("MinerU manifest text length mismatch");
  if (pageCount !== undefined && manifest.totalPages !== pageCount)
    throw new Error("MinerU manifest page count mismatch");
  const totalPages = pageCount ?? manifest.totalPages;
  if (
    totalPages !== undefined &&
    (!Number.isSafeInteger(totalPages) || totalPages <= 0)
  )
    throw new Error("Invalid MinerU manifest page count");
  let previousEnd = 0;
  for (const section of manifest.sections) {
    if (
      !Number.isInteger(section.charStart) ||
      !Number.isInteger(section.charEnd) ||
      section.charStart < previousEnd ||
      section.charEnd <= section.charStart ||
      section.charEnd > md.length ||
      md
        .slice(section.charStart, section.charEnd)
        .match(/^#{1,3}\s+(.+)/)?.[1]
        .trim() !== section.heading
    )
      throw new Error("Invalid MinerU manifest section offsets");
    // Manifests written before heading levels existed carry no level at all.
    const level = (section as { level?: number }).level;
    if (
      level !== undefined &&
      (!Number.isInteger(level) || level < 1 || level > 3)
    )
      throw new Error("Invalid MinerU manifest section level");
    previousEnd = section.charEnd;
  }
  for (const entry of [
    ...manifest.sections,
    ...manifest.allFigures,
    ...manifest.allTables,
    ...manifest.sections.flatMap((s) => [...s.figures, ...s.tables]),
  ]) {
    if (
      entry.page !== undefined &&
      (!Number.isInteger(entry.page) ||
        entry.page < 0 ||
        (totalPages !== undefined && entry.page >= totalPages))
    )
      throw new Error("Invalid MinerU manifest page index");
  }
}

type MineruCacheWriteOptions = {
  pageCount?: number;
  signal?: AbortSignal;
  beforeCommit?: () => Promise<void>;
};

type MineruCacheWriter = (
  mdContent: string,
  files: MineruCacheFile[],
  options?: MineruCacheWriteOptions,
) => Promise<void>;

const activeCacheWrites = new Map<number, Promise<void>>();

/**
 * Own the whole replacement, including a restore's cache check/removal and
 * metadata writes. The supplied writer shares that ownership without nesting
 * the queue. A disk pending marker may outlive a failed write; it is not a lock.
 */
export async function withMineruCacheWrite<T>(
  id: number,
  operation: (write: MineruCacheWriter) => Promise<T>,
  options: { skipIfBusy?: boolean } = {},
): Promise<T | undefined> {
  const previous = activeCacheWrites.get(id);
  if (previous && options.skipIfBusy) return undefined;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeCacheWrites.set(id, pending);
  try {
    await previous;
    return await operation((md, files, writeOptions) =>
      writeMineruCacheFilesOwned(id, md, files, writeOptions),
    );
  } finally {
    if (activeCacheWrites.get(id) === pending) activeCacheWrites.delete(id);
    release();
  }
}

export async function writeMineruCacheFiles(
  id: number,
  mdContent: string,
  files: MineruCacheFile[],
  options: MineruCacheWriteOptions = {},
): Promise<void> {
  await withMineruCacheWrite(id, (write) => write(mdContent, files, options));
}

async function writeMineruCacheFilesOwned(
  id: number,
  mdContent: string,
  files: MineruCacheFile[],
  options: MineruCacheWriteOptions = {},
): Promise<void> {
  const checkAbort = () => {
    if (options.signal?.aborted) throw new MineruCancelledError();
  };
  checkAbort();
  const itemDir = getMineruItemDir(id);
  await ensureDir(itemDir);
  const manifestProbe = finalizeMineruCacheFiles(mdContent, files, {
    pageCount: options.pageCount,
  });
  const keepSourceImages = !(await hasReadyPdfFigureCropCache(
    itemDir,
    manifestProbe.manifest,
  ));
  const finalized = keepSourceImages
    ? finalizeMineruCacheFiles(mdContent, files, {
        keepSourceImages: true,
        pageCount: options.pageCount,
      })
    : manifestProbe;

  validateMineruManifest(
    finalized.mdContent,
    finalized.manifest,
    options.pageCount,
  );
  checkAbort();
  const pendingPath = joinLocalPath(itemDir, PENDING_CACHE_WRITE);
  await writeFileBytes(pendingPath, new TextEncoder().encode("{}"));
  await pruneNonDurableMineruCacheArtifacts(itemDir, { keepSourceImages });

  for (const file of finalized.files) {
    checkAbort();
    const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
    const filePath = joinLocalPath(itemDir, ...parts);
    const parentDir = getLocalParentPath(filePath);
    try {
      if (parentDir !== itemDir) {
        await ensureDir(parentDir);
      }
      await writeFileBytes(filePath, file.data);
    } catch (error) {
      throw new Error(
        `Failed to write MinerU cache file "${file.relativePath}" from ` +
          `"${file.originalRelativePath}": ${formatCacheWriteError(error)}`,
      );
    }
  }

  const mdPath = getMineruMdPath(id);
  try {
    await writeFileBytes(mdPath, new TextEncoder().encode(finalized.mdContent));
  } catch (error) {
    throw new Error(
      `Failed to write MinerU cache file "full.md": ${formatCacheWriteError(
        error,
      )}`,
    );
  }

  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(finalized.manifest),
  );
  await writeFileBytes(getManifestPath(id), manifestBytes);
  const expected = [
    ...finalized.files.filter(
      (file) =>
        file.relativePath !== "full.md" &&
        file.relativePath !== "manifest.json",
    ),
    {
      relativePath: "full.md",
      data: new TextEncoder().encode(finalized.mdContent),
    },
    { relativePath: "manifest.json", data: manifestBytes },
  ];
  for (const file of expected) {
    checkAbort();
    const readback = await readFileBytes(
      joinLocalPath(itemDir, file.relativePath),
    );
    if (
      !readback ||
      (await hashMineruBytes(readback)) !== (await hashMineruBytes(file.data))
    )
      throw new Error(
        `MinerU cache integrity check failed: ${file.relativePath}`,
      );
  }
  await options.beforeCommit?.();
  checkAbort();
  await removePathQuietly(pendingPath);
  if (await pathExists(pendingPath))
    throw new Error("MinerU cache publication could not finish");

  // Clean up legacy _content.md if it exists
  const legacyContentPath = getLegacyContentMdPath(id);
  if (await pathExists(legacyContentPath)) {
    await removePathQuietly(legacyContentPath);
  }

  // Clean up legacy single-file cache if it exists
  const legacyPath = getLegacyMdPath(id);
  if (await pathExists(legacyPath)) {
    await removePathQuietly(legacyPath);
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export type ManifestFigure = {
  label: string;
  baseLabel: string;
  path: string;
  caption: string;
  page?: number;
};

export type ManifestTable = {
  label: string;
  baseLabel: string;
  path: string;
  caption: string;
  page?: number;
};

/** Manifests built before this version only knew `#` headings. */
export const MANIFEST_STRUCTURE_VERSION = 2;

export type ManifestSectionLevel = 1 | 2 | 3;

export type ManifestSection = {
  heading: string;
  /** Markdown heading depth: `#` → 1, `##` → 2, `###` → 3. */
  level: ManifestSectionLevel;
  /** Stable handle for this section inside the manifest (`s0`, `s1`, …). */
  sectionId: string;
  /** Index of the enclosing section in `sections`, when there is one. */
  parentIndex?: number;
  /** Heading chain down to this section, e.g. `2 Algorithm › 2.1 Weak form`. */
  path: string;
  page?: number;
  charStart: number;
  charEnd: number;
  figures: ManifestFigure[];
  tables: ManifestTable[];
  equationCount: number;
};

/** How much structure a parse actually yielded, for diagnostics. */
export type MineruManifestStructure = {
  version: typeof MANIFEST_STRUCTURE_VERSION;
  headingCounts: { h1: number; h2: number; h3: number };
  sectionsBuilt: number;
  labelledChars: number;
};

export type MineruManifest = {
  sections: ManifestSection[];
  allFigures: (ManifestFigure & { section: string })[];
  allTables: (ManifestTable & { section: string })[];
  figureBlocks?: MineruFigureBlock[];
  totalPages?: number;
  totalChars: number;
  noSections?: boolean;
  /** Absent on manifests written before {@link MANIFEST_STRUCTURE_VERSION}. */
  structure?: MineruManifestStructure;
};

function getManifestPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "manifest.json");
}

/** Headings that are journal/publisher metadata noise, not real sections. */
const NOISE_HEADING_BLOCKLIST = new Set([
  "cell reports",
  "cell",
  "neuron",
  "current biology",
  "nature",
  "nature neuroscience",
  "nature communications",
  "science",
  "elife",
  "pnas",
  "check for updates",
  "authors",
  "author",
  "highlights",
  "correspondence",
  "graphical abstract",
  "in brief",
  "a r t i c l e",
  "a r t i c l e i n f o",
  "a b s t r a c t",
  "key points",
  "star methods",
  "resource availability",
  "lead contact",
  "data and code",
  "experimental model",
  "funding information",
]);

function isNoiseHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  if (NOISE_HEADING_BLOCKLIST.has(trimmed.toLowerCase())) return true;
  // Unicode garbage from OCR artifacts (e.g. \uf0da sequences)
  if (/^[\uf000-\uf0ff\s]+$/.test(trimmed)) return true;
  return false;
}

/**
 * Build a manifest from full.md + content_list.json.
 *
 * 1. Scan full.md for `^# heading` lines to get char offsets for sections.
 * 2. Parse content_list.json for figure/table metadata per section.
 * 3. Combine into a lightweight manifest the agent can read quickly.
 */
export function buildManifest(
  mdContent: string,
  contentList: ContentListEntry[],
  pageCount?: number,
): MineruManifest {
  const figureBlocks = buildMineruFigureBlocks({
    fullMd: mdContent,
    contentList,
  });

  // ── Step 1: Extract section offsets from full.md ──
  // MinerU marks the paper title `#` and its sections `##`/`###`, so all three
  // depths are real sections.
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;
  const mdHeadings: {
    heading: string;
    level: ManifestSectionLevel;
    charStart: number;
  }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(mdContent)) !== null) {
    const heading = match[2].trim();
    if (!isNoiseHeading(heading)) {
      mdHeadings.push({
        heading,
        level: match[1].length as ManifestSectionLevel,
        charStart: match.index,
      });
    }
  }

  // ── Step 2: Map content_list figures/tables/equations to sections ──
  // Build a section index from content_list using text_level: 1 entries
  type CLSection = {
    heading: string;
    page?: number;
    figures: ManifestFigure[];
    tables: ManifestTable[];
    equationCount: number;
  };
  const clSections: CLSection[] = [];
  let currentCLSection: CLSection | null = null;
  let totalPages = 0;

  for (const entry of contentList) {
    if (entry.page_idx !== undefined && entry.page_idx + 1 > totalPages) {
      totalPages = entry.page_idx + 1;
    }

    if (
      entry.type === "text" &&
      entry.text_level !== undefined &&
      entry.text_level >= 1 &&
      entry.text_level <= 3 &&
      entry.text &&
      !isNoiseHeading(entry.text)
    ) {
      currentCLSection = {
        heading: entry.text.trim(),
        page: entry.page_idx,
        figures: [],
        tables: [],
        equationCount: 0,
      };
      clSections.push(currentCLSection);
      continue;
    }

    if (!currentCLSection) continue;

    if (entry.type === "image" && entry.img_path) {
      const captionText = (entry.image_caption || []).join(" ").trim();
      const label = extractFigureLabel(captionText);
      const effectiveLabel =
        label || `image-${currentCLSection.figures.length + 1}`;
      currentCLSection.figures.push({
        label: effectiveLabel,
        baseLabel: getManifestFigureBaseLabel(effectiveLabel),
        path: entry.img_path,
        caption: captionText.slice(0, 300),
        page: entry.page_idx,
      });
    }

    if (entry.type === "table" && (entry.img_path || entry.table_body)) {
      const captionText = (entry.table_caption || []).join(" ").trim();
      const footnoteText = (entry.table_footnote || []).join(" ").trim();
      const label = extractFigureLabel(captionText || footnoteText);
      const effectiveLabel =
        label || `table-${currentCLSection.tables.length + 1}`;
      currentCLSection.tables.push({
        label: effectiveLabel,
        baseLabel: getManifestFigureBaseLabel(effectiveLabel),
        path: entry.img_path || "",
        caption: (captionText || footnoteText).slice(0, 300),
        page: entry.page_idx,
      });
    }

    if (entry.type === "equation") {
      currentCLSection.equationCount += 1;
    }
  }

  // ── Step 3: Build manifest sections by combining md offsets + cl metadata ──
  // Match md headings to content_list sections by heading text
  const clSectionByHeading = new Map<string, CLSection[]>();
  for (const cls of clSections) {
    const occurrences = clSectionByHeading.get(cls.heading) || [];
    occurrences.push(cls);
    clSectionByHeading.set(cls.heading, occurrences);
  }

  // Hierarchy fields are assigned after the merge step, so ids and parents
  // always describe the sections the manifest actually ships.
  type DraftSection = Omit<
    ManifestSection,
    "sectionId" | "parentIndex" | "path"
  >;
  const drafts: DraftSection[] = [];
  for (let i = 0; i < mdHeadings.length; i++) {
    const { heading, level, charStart } = mdHeadings[i];
    const charEnd =
      i + 1 < mdHeadings.length
        ? mdHeadings[i + 1].charStart
        : mdContent.length;

    const cls = clSectionByHeading.get(heading)?.shift();

    drafts.push({
      heading,
      level,
      page: cls?.page,
      charStart,
      charEnd,
      figures: cls?.figures || [],
      tables: cls?.tables || [],
      equationCount: cls?.equationCount || 0,
    });
  }

  // If too many sections (50+), merge adjacent small ones (< 500 chars)
  if (drafts.length > 50) {
    const merged: DraftSection[] = [];
    for (const section of drafts) {
      const prevSection = merged.length > 0 ? merged[merged.length - 1] : null;
      if (
        prevSection &&
        prevSection.charEnd - prevSection.charStart < 500 &&
        section.charEnd - section.charStart < 500
      ) {
        // Merge small adjacent section into previous
        prevSection.charEnd = section.charEnd;
        prevSection.figures.push(...section.figures);
        prevSection.tables.push(...section.tables);
        prevSection.equationCount += section.equationCount;
      } else {
        merged.push({
          ...section,
          figures: [...section.figures],
          tables: [...section.tables],
        });
      }
    }
    drafts.length = 0;
    drafts.push(...merged);
  }

  // ── Step 4: Assign section ids, parents and heading paths ──
  const sections: ManifestSection[] = drafts.map((section, index) => ({
    ...section,
    sectionId: `s${index}`,
    path: section.heading,
  }));
  // The title block is every level-1 heading before the first deeper section:
  // an institute banner, the paper title. They are front matter, not sections
  // every path repeats. A paper written entirely in level-1 headings has no
  // title block, so its headings keep their own paths.
  const firstDeeperIndex = sections.findIndex((section) => section.level >= 2);
  const titleIndexes = new Set<number>();
  for (let i = 0; i < firstDeeperIndex; i += 1) {
    if (sections[i].level === 1) titleIndexes.add(i);
  }
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    for (let j = i - 1; j >= 0; j--) {
      if (sections[j].level < section.level) {
        section.parentIndex = j;
        break;
      }
    }
    const chain = [section.heading];
    let ancestor = section.parentIndex;
    while (ancestor !== undefined) {
      if (!titleIndexes.has(ancestor)) chain.push(sections[ancestor].heading);
      ancestor = sections[ancestor].parentIndex;
    }
    section.path = chain.reverse().join(" › ");
  }

  // Build flat figure/table lists
  const allFigures: (ManifestFigure & { section: string })[] = [];
  const allTables: (ManifestTable & { section: string })[] = [];
  for (const section of sections) {
    for (const fig of section.figures) {
      allFigures.push({ ...fig, section: section.heading });
    }
    for (const tbl of section.tables) {
      allTables.push({ ...tbl, section: section.heading });
    }
  }

  const headingCounts = { h1: 0, h2: 0, h3: 0 };
  for (const heading of mdHeadings) {
    if (heading.level === 1) headingCounts.h1 += 1;
    else if (heading.level === 2) headingCounts.h2 += 1;
    else headingCounts.h3 += 1;
  }

  return {
    sections,
    allFigures,
    allTables,
    figureBlocks,
    totalPages: pageCount ?? (totalPages || undefined),
    totalChars: mdContent.length,
    ...(sections.length <= 2 ? { noSections: true } : {}),
    structure: {
      version: MANIFEST_STRUCTURE_VERSION,
      headingCounts,
      sectionsBuilt: sections.length,
      labelledChars: sections.length
        ? mdContent.length - sections[0].charStart
        : 0,
    },
  };
}

/**
 * Find the content_list.json file in a MinerU cache directory.
 * The filename is `{uuid}_content_list.json` where uuid varies per paper.
 */
export async function findMineruContentListPath(
  itemDir: string,
): Promise<string | null> {
  const io = getIOUtils();
  const ioAny = io as Record<string, unknown> | undefined;
  const getChildren =
    ioAny && typeof ioAny.getChildren === "function"
      ? (ioAny.getChildren as (path: string) => Promise<string[]>)
      : null;
  if (!getChildren) return null;

  let entries: string[];
  try {
    entries = await getChildren(itemDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const basename = entry.split(/[\\/]/).pop() || "";
    if (
      basename === CONTENT_LIST_FILE_NAME ||
      basename.endsWith("_content_list.json")
    ) {
      return entry;
    }
  }
  return null;
}

export async function readMineruContentListFromDir(
  itemDir: string,
): Promise<ContentListEntry[]> {
  const contentListPath = await findMineruContentListPath(itemDir);
  if (!contentListPath) return [];
  const clBytes = await readFileBytes(contentListPath);
  if (!clBytes) return [];
  return parseContentListBytes(clBytes);
}

/**
 * Figures and tables a rebuild could not recover. They come from the content
 * list, which is pruned with the other non-durable artifacts once the cache is
 * finalized, so a later rebuild would otherwise drop every figure the stored
 * manifest knows. Same rule as the figure blocks: carry forward only when the
 * rebuild found none and the stored manifest had some. Section records are
 * reattached by exact heading text, first unmatched occurrence; a heading the
 * rebuild no longer has keeps its records in the flat lists only.
 */
function carryForwardManifestFigures(
  rebuilt: MineruManifest,
  previous: MineruManifest | null,
): MineruManifest {
  if (rebuilt.allFigures.length || rebuilt.allTables.length) return rebuilt;
  if (!previous?.allFigures?.length && !previous?.allTables?.length) {
    return rebuilt;
  }
  const storedByHeading = new Map<string, ManifestSection[]>();
  for (const section of previous.sections || []) {
    const occurrences = storedByHeading.get(section.heading) || [];
    occurrences.push(section);
    storedByHeading.set(section.heading, occurrences);
  }
  return {
    ...rebuilt,
    sections: rebuilt.sections.map((section) => {
      const stored = storedByHeading.get(section.heading)?.shift();
      if (!stored) return section;
      return {
        ...section,
        figures: stored.figures || [],
        tables: stored.tables || [],
        equationCount: stored.equationCount || 0,
      };
    }),
    allFigures: previous.allFigures || [],
    allTables: previous.allTables || [],
  };
}

/**
 * Build and write manifest.json for a cached paper.
 * Reads full.md and content_list.json from the cache directory.
 */
export async function buildAndWriteManifest(
  id: number,
): Promise<MineruManifest | null> {
  if (await hasPendingCacheWrite(id)) return null;
  const itemDir = getMineruItemDir(id);
  if (!(await pathExists(itemDir))) return null;

  const mdBytes = await readFileBytes(getMineruMdPath(id));
  if (!mdBytes) return null;
  const mdContent = new TextDecoder("utf-8").decode(mdBytes);

  const contentList = await readMineruContentListFromDir(itemDir);

  const previous = await readManifest(id);
  const rebuilt = buildManifest(mdContent, contentList, previous?.totalPages);
  // full.md no longer embeds the source images once a cache is finalized, so a
  // rebuild cannot recover figure blocks the stored manifest already knows.
  const recovered = carryForwardManifestFigures(rebuilt, previous);
  const manifest: MineruManifest = {
    ...recovered,
    // An older finalized cache may have pruned content_list.json. Preserve
    // page locations only for sections whose heading and source range agree.
    sections: recovered.sections.map((section) => {
      if (section.page !== undefined || !previous) return section;
      const stored = previous.sections.find(
        (old) =>
          old.heading === section.heading &&
          old.charStart === section.charStart &&
          old.charEnd === section.charEnd,
      );
      return stored?.page !== undefined
        ? { ...section, page: stored.page }
        : section;
    }),
    ...(rebuilt.figureBlocks?.length || !previous?.figureBlocks?.length
      ? {}
      : { figureBlocks: previous.figureBlocks }),
  };

  // Write manifest.json
  const manifestPath = getManifestPath(id);
  await writeFileBytes(
    manifestPath,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  return manifest;
}

export async function finalizeExistingMineruCache(
  id: number,
): Promise<boolean> {
  if (await hasPendingCacheWrite(id)) return false;
  const itemDir = getMineruItemDir(id);
  const mdBytes = await readFileBytes(getMineruMdPath(id));
  if (!mdBytes) return false;

  const sourceMdContent = new TextDecoder("utf-8").decode(mdBytes);
  const canonicalMdContent =
    stripMineruSourceImageEmbedsFromMarkdown(sourceMdContent);
  const contentList = await readMineruContentListFromDir(itemDir);
  const existingManifest = await readManifest(id);
  let changed = canonicalMdContent !== sourceMdContent;
  const sourceManifest = buildManifest(
    sourceMdContent,
    contentList,
    existingManifest?.totalPages,
  );
  const canonicalManifest = buildManifest(
    canonicalMdContent,
    contentList,
    existingManifest?.totalPages,
  );
  const finalizedManifest = {
    ...canonicalManifest,
    figureBlocks: sourceManifest.figureBlocks,
  };
  const keepSourceImages = !(await hasReadyPdfFigureCropCache(
    itemDir,
    finalizedManifest,
  ));

  const pruned = await pruneNonDurableMineruCacheArtifacts(itemDir, {
    keepSourceImages,
  });
  if (pruned) changed = true;

  if (changed) {
    await writeFileBytes(
      getMineruMdPath(id),
      new TextEncoder().encode(canonicalMdContent),
    );
  }

  if (changed || !existingManifest) {
    const manifest = {
      ...canonicalManifest,
      figureBlocks: changed
        ? sourceManifest.figureBlocks
        : existingManifest?.figureBlocks || sourceManifest.figureBlocks,
    };
    await writeFileBytes(
      getManifestPath(id),
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    changed = true;
  }

  return changed;
}

/**
 * Read a previously built manifest.json from cache.
 */
export async function readManifest(id: number): Promise<MineruManifest | null> {
  if (await hasPendingCacheWrite(id)) return null;
  const manifestPath = getManifestPath(id);
  const bytes = await readFileBytes(manifestPath);
  if (!bytes || (await hasPendingCacheWrite(id))) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Get or build the manifest for a cached paper.
 * Reads from disk if available, otherwise builds and writes it. A manifest
 * written before {@link MANIFEST_STRUCTURE_VERSION} predates `##`/`###`
 * headings, so it is rebuilt lazily on first use — and kept as-is when the
 * cache cannot be re-read.
 */
export async function ensureManifest(
  id: number,
): Promise<MineruManifest | null> {
  const existing = await readManifest(id);
  if (existing?.structure?.version === MANIFEST_STRUCTURE_VERSION)
    return existing;
  if (await hasPendingCacheWrite(id)) return existing;
  if (!(await pathExists(getMineruMdPath(id)))) return existing;
  return (await buildAndWriteManifest(id)) ?? existing;
}

export async function invalidateMineruMd(id: number): Promise<void> {
  await deleteMineruCheckpoint(id);
  // Remove the directory-based cache
  await removePathQuietly(getMineruItemDir(id));
  // Also remove legacy single-file cache
  await removePathQuietly(getLegacyMdPath(id));
  // Cascade: clear embedding cache since chunks will change
  try {
    const { clearEmbeddingCache } = await import("../retrieval/embeddingCache");
    await clearEmbeddingCache(id);
  } catch {
    /* embedding cache module may not be loaded yet */
  }
}

/**
 * One-time migration: remove legacy `_content.md` files from all cache
 * directories where `full.md` already exists.
 */
export async function cleanupLegacyContentMdFiles(): Promise<void> {
  const cacheDir = getMineruCacheDir();
  if (!(await pathExists(cacheDir))) return;

  const io = getIOUtils();
  if (!io?.exists || !io?.remove) return;

  // IOUtils.getChildren lists immediate children of a directory
  const ioAny = io as Record<string, unknown>;
  const getChildren =
    typeof ioAny.getChildren === "function"
      ? (ioAny.getChildren as (path: string) => Promise<string[]>)
      : null;
  if (!getChildren) return;

  let entries: string[];
  try {
    entries = await getChildren(cacheDir);
  } catch {
    return;
  }

  let cleaned = 0;
  for (const entry of entries) {
    // Only process numbered directories (attachment IDs)
    const basename = entry.split(/[\\/]/).pop() || "";
    if (!/^\d+$/.test(basename)) continue;

    const fullMdPath = joinLocalPath(entry, "full.md");
    const contentMdPath = joinLocalPath(entry, "_content.md");

    if ((await pathExists(fullMdPath)) && (await pathExists(contentMdPath))) {
      await removePathQuietly(contentMdPath);
      cleaned += 1;
    }
  }

  if (cleaned > 0) {
    appLogger.info(`LLM: Cleaned up ${cleaned} legacy _content.md file(s).`);
  }
}
