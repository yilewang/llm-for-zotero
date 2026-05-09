import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";

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

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
  removeDir?: (
    path: string,
    options?: { ignoreAbsent?: boolean; ignorePermissions?: boolean },
  ) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

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

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
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

async function removePath(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    try {
      await io.remove(path, { recursive: true, ignoreAbsent: true });
    } catch {
      /* ignore */
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
      /* ignore */
    }
  } else if (osFile?.remove) {
    try {
      await osFile.remove(path, { ignoreAbsent: true });
    } catch {
      /* ignore */
    }
  }
}

// ── MinerU archive path normalization ────────────────────────────────────────

const CONTENT_LIST_FILE_NAME = "content_list.json";
const MAX_CACHE_PATH_SEGMENT_LENGTH = 80;
const MAX_CACHE_RELATIVE_PATH_LENGTH = 160;

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

export function normalizeMineruCacheFiles(
  mdContent: string,
  files: MineruCacheFile[],
): NormalizedMineruCacheFiles {
  const mdFile = pickMarkdownCacheFile(files);
  const mdDirParts = mdFile ? mdFile.parts.slice(0, -1) : [];
  const pathMap = new Map<string, string>();
  const usedTargets = new Map<string, string>();
  const normalizedFiles: NormalizedMineruCacheFile[] = [];

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
  if (await pathExists(getMineruMdPath(id))) return true;
  // Check legacy _content.md path
  if (await pathExists(getLegacyContentMdPath(id))) return true;
  // Check legacy single-file cache
  return await pathExists(getLegacyMdPath(id));
}

export async function readCachedMineruMd(id: number): Promise<string | null> {
  // Try full.md (current canonical path)
  const bytes = await readFileBytes(getMineruMdPath(id));
  if (bytes) return new TextDecoder("utf-8").decode(bytes);
  // Try legacy _content.md
  const legacyContentBytes = await readFileBytes(getLegacyContentMdPath(id));
  if (legacyContentBytes)
    return new TextDecoder("utf-8").decode(legacyContentBytes);
  // Try legacy single-file cache
  const legacyBytes = await readFileBytes(getLegacyMdPath(id));
  if (legacyBytes) return new TextDecoder("utf-8").decode(legacyBytes);
  return null;
}

export async function writeMineruCacheFiles(
  id: number,
  mdContent: string,
  files: MineruCacheFile[],
): Promise<void> {
  const itemDir = getMineruItemDir(id);
  await ensureDir(itemDir);
  const normalized = normalizeMineruCacheFiles(mdContent, files);

  for (const file of normalized.files) {
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
    await writeFileBytes(
      mdPath,
      new TextEncoder().encode(normalized.mdContent),
    );
  } catch (error) {
    throw new Error(
      `Failed to write MinerU cache file "full.md": ${formatCacheWriteError(
        error,
      )}`,
    );
  }

  // Clean up legacy _content.md if it exists
  const legacyContentPath = getLegacyContentMdPath(id);
  if (await pathExists(legacyContentPath)) {
    await removePath(legacyContentPath);
  }

  // Clean up legacy single-file cache if it exists
  const legacyPath = getLegacyMdPath(id);
  if (await pathExists(legacyPath)) {
    await removePath(legacyPath);
  }

  // Build manifest.json from content_list + full.md (best effort)
  try {
    await buildAndWriteManifest(id);
  } catch {
    // Non-critical — manifest is an optimization, not required
  }
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function readMineruImageAsBase64(
  attachmentId: number,
  relativePath: string,
): Promise<string | null> {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const filePath = joinLocalPath(getMineruItemDir(attachmentId), ...parts);
  const bytes = await readFileBytes(filePath);
  if (!bytes || bytes.length === 0) return null;
  const ext = (relativePath.match(/\.(\w+)$/)?.[1] || "png").toLowerCase();
  const mime = EXT_MIME[ext] || "image/png";
  return `data:${mime};base64,${toBase64(bytes)}`;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export type ManifestFigure = {
  label: string;
  path: string;
  caption: string;
  page?: number;
};

export type ManifestTable = {
  label: string;
  path: string;
  caption: string;
  page?: number;
};

export type ManifestSection = {
  heading: string;
  page?: number;
  charStart: number;
  charEnd: number;
  figures: ManifestFigure[];
  tables: ManifestTable[];
  equationCount: number;
};

export type MineruManifest = {
  sections: ManifestSection[];
  allFigures: (ManifestFigure & { section: string })[];
  allTables: (ManifestTable & { section: string })[];
  totalPages?: number;
  totalChars: number;
  noSections?: boolean;
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

/** Extract a figure/table label like "Fig. 1", "Figure 3", "Table 2" from caption text. */
function extractFigureLabel(caption: string): string {
  const match = caption.match(
    /^(Fig(?:ure)?\.?\s*\d+|Table\s*\d+|Supplementary\s+Fig(?:ure)?\.?\s*\d+)/i,
  );
  return match ? match[1] : "";
}

type ContentListEntry = {
  type: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  img_path?: string;
  image_caption?: string[];
  image_footnote?: string[];
  table_body?: string;
  table_caption?: string[];
  table_footnote?: string[];
};

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
): MineruManifest {
  // ── Step 1: Extract section offsets from full.md ──
  const headingPattern = /^#\s+(.+)$/gm;
  const mdHeadings: { heading: string; charStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(mdContent)) !== null) {
    const heading = match[1].trim();
    if (!isNoiseHeading(heading)) {
      mdHeadings.push({ heading, charStart: match.index });
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
      entry.text_level === 1 &&
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
      currentCLSection.figures.push({
        label: label || `image-${currentCLSection.figures.length + 1}`,
        path: entry.img_path,
        caption: captionText.slice(0, 300),
        page: entry.page_idx,
      });
    }

    if (entry.type === "table" && entry.img_path) {
      const captionText = (entry.table_caption || []).join(" ").trim();
      const footnoteText = (entry.table_footnote || []).join(" ").trim();
      const label = extractFigureLabel(captionText || footnoteText);
      currentCLSection.tables.push({
        label: label || `table-${currentCLSection.tables.length + 1}`,
        path: entry.img_path,
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
  const clSectionByHeading = new Map<string, CLSection>();
  for (const cls of clSections) {
    clSectionByHeading.set(cls.heading, cls);
  }

  const sections: ManifestSection[] = [];
  for (let i = 0; i < mdHeadings.length; i++) {
    const { heading, charStart } = mdHeadings[i];
    const charEnd =
      i + 1 < mdHeadings.length
        ? mdHeadings[i + 1].charStart
        : mdContent.length;

    const cls = clSectionByHeading.get(heading);

    sections.push({
      heading,
      page: cls?.page,
      charStart,
      charEnd,
      figures: cls?.figures || [],
      tables: cls?.tables || [],
      equationCount: cls?.equationCount || 0,
    });
  }

  // Handle edge case: 0-2 real sections → noSections mode
  if (sections.length <= 2) {
    return {
      sections,
      allFigures: [],
      allTables: [],
      totalPages: totalPages || undefined,
      totalChars: mdContent.length,
      noSections: true,
    };
  }

  // If too many sections (50+), merge adjacent small ones (< 500 chars)
  if (sections.length > 50) {
    const merged: ManifestSection[] = [];
    for (const section of sections) {
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
    sections.length = 0;
    sections.push(...merged);
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

  return {
    sections,
    allFigures,
    allTables,
    totalPages: totalPages || undefined,
    totalChars: mdContent.length,
  };
}

/**
 * Find the content_list.json file in a MinerU cache directory.
 * The filename is `{uuid}_content_list.json` where uuid varies per paper.
 */
async function findContentListPath(itemDir: string): Promise<string | null> {
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

/**
 * Build and write manifest.json for a cached paper.
 * Reads full.md and content_list.json from the cache directory.
 */
export async function buildAndWriteManifest(
  id: number,
): Promise<MineruManifest | null> {
  const itemDir = getMineruItemDir(id);
  if (!(await pathExists(itemDir))) return null;

  const mdBytes = await readFileBytes(getMineruMdPath(id));
  if (!mdBytes) return null;
  const mdContent = new TextDecoder("utf-8").decode(mdBytes);

  const contentListPath = await findContentListPath(itemDir);
  let contentList: ContentListEntry[] = [];
  if (contentListPath) {
    const clBytes = await readFileBytes(contentListPath);
    if (clBytes) {
      try {
        contentList = JSON.parse(new TextDecoder("utf-8").decode(clBytes));
      } catch {
        // Invalid JSON — proceed without content_list
      }
    }
  }

  const manifest = buildManifest(mdContent, contentList);

  // Write manifest.json
  const manifestPath = getManifestPath(id);
  await writeFileBytes(
    manifestPath,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  return manifest;
}

/**
 * Read a previously built manifest.json from cache.
 */
export async function readManifest(id: number): Promise<MineruManifest | null> {
  const manifestPath = getManifestPath(id);
  const bytes = await readFileBytes(manifestPath);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Get or build the manifest for a cached paper.
 * Reads from disk if available, otherwise builds and writes it.
 */
export async function ensureManifest(
  id: number,
): Promise<MineruManifest | null> {
  const existing = await readManifest(id);
  if (existing) return existing;
  return buildAndWriteManifest(id);
}

export async function invalidateMineruMd(id: number): Promise<void> {
  // Remove the directory-based cache
  await removePath(getMineruItemDir(id));
  // Also remove legacy single-file cache
  await removePath(getLegacyMdPath(id));
  // Cascade: clear embedding cache since chunks will change
  try {
    const { clearEmbeddingCache } = await import("./embeddingCache");
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
      await removePath(contentMdPath);
      cleaned += 1;
    }
  }

  if (cleaned > 0) {
    ztoolkit.log(`LLM: Cleaned up ${cleaned} legacy _content.md file(s).`);
  }
}
