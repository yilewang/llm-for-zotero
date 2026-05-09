import { unzipSync, zipSync } from "fflate";
import { config, version as addonVersion } from "../../../package.json";
import { joinLocalPath, getLocalParentPath } from "../../utils/localPath";
import { isMineruSyncEnabled } from "../../utils/mineruConfig";
import {
  buildAndWriteManifest,
  ensureManifest,
  getMineruCacheDir,
  getMineruItemDir,
  hasCachedMineruMd,
  writeMineruCacheFiles,
  type MineruCacheFile,
} from "./mineruCache";
import { pdfTextCache, pdfTextLoadingTasks } from "./state";

export const MINERU_SYNC_PACKAGE_KIND = "llm-for-zotero/mineru-cache";
export const MINERU_SYNC_PACKAGE_VERSION = 1;
export const MINERU_SYNC_ATTACHMENT_TITLE_PREFIX =
  "[LLM for Zotero] MinerU cache";
export const MINERU_SYNC_METADATA_FILE = "_llm_sync.json";
export const MINERU_LOCAL_SYNC_STATE_FILE = "_llm_sync_state.json";
export const MINERU_CACHE_VERSION = "mineru-cache-v1";

export type MineruSyncMetadata = {
  kind: typeof MINERU_SYNC_PACKAGE_KIND;
  version: typeof MINERU_SYNC_PACKAGE_VERSION;
  createdAt: string;
  generatedAt?: string;
  updatedAt?: string;
  addonName: string;
  addonVersion: string;
  mineruCacheVersion?: string;
  cacheContentHash?: string;
  sourceAttachmentKey: string;
  sourceAttachmentFilename?: string;
  parentItemKey?: string;
};

export type MineruAvailabilityStatus = "missing" | "local" | "synced" | "both";

export type MineruAvailability = {
  status: MineruAvailabilityStatus;
  localCached: boolean;
  syncedPackage: boolean;
  attachmentId: number;
};

export type MineruAvailabilityOptions = {
  /**
   * When false, a correctly named package attachment is enough to mark sync
   * availability. UI scans use this cheap path; restore/repair still validate
   * package bytes before writing local cache files.
   */
  validateSyncedPackage?: boolean;
};

export type MineruSyncPublishResult = {
  status:
    | "published"
    | "up_to_date"
    | "disabled"
    | "not_found"
    | "not_pdf"
    | "missing_key"
    | "no_cache"
    | "unsupported_io"
    | "error";
  attachmentId: number;
  packageAttachmentId?: number;
  reason?: string;
};

export type MineruSyncRestoreResult = {
  status:
    | "restored"
    | "disabled"
    | "already_cached"
    | "not_pdf"
    | "missing_key"
    | "not_found"
    | "no_package"
    | "invalid_package"
    | "error";
  attachmentId: number;
  packageAttachmentId?: number;
  localContentHash?: string;
  packageContentHash?: string;
  diverged?: boolean;
  reason?: string;
};

export type MineruSyncMigrationResult = {
  scanned: number;
  published: number;
  restored: number;
  upToDate: number;
  diverged: number;
  skipped: number;
  failed: number;
};

export type MineruSyncMigrationOptions = {
  batchSize?: number;
  yieldMs?: number;
  onProgress?: (result: MineruSyncMigrationResult) => void;
};

export type MineruSyncCleanupResult = {
  deleted: number;
  failed: number;
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
  getChildren?: (path: string) => Promise<string[]>;
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

type AttachmentImportApi = {
  importFromFile?: (options: {
    file: nsIFile | string;
    libraryID?: number;
    parentItemID?: number;
    title?: string;
    fileBaseName?: string;
    contentType?: string;
  }) => Promise<Zotero.Item>;
};

type MineruLocalSyncState = {
  kind: typeof MINERU_SYNC_PACKAGE_KIND;
  restoredAt: string;
  sourceAttachmentKey: string;
  packageAttachmentId?: number;
  cacheContentHash: string;
};

type ExtractedMineruSyncPackage = {
  metadata: MineruSyncMetadata;
  mdContent: string;
  files: MineruCacheFile[];
  contentHash: string;
};

type MineruPackageCandidate = {
  item: Zotero.Item;
  metadata?: MineruSyncMetadata;
  bytes?: Uint8Array;
  extracted?: ExtractedMineruSyncPackage;
  contentHash?: string;
  timestampMs: number;
  titleMatched: boolean;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
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
    await osFile.makeDir(path, {
      from: getLocalParentPath(path),
      ignoreExisting: true,
    });
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

function coerceToUint8Array(
  data: Uint8Array | ArrayBuffer | null | undefined,
): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  const buf = data as unknown as { byteLength?: unknown };
  if (typeof buf.byteLength === "number") {
    try {
      return new Uint8Array(data as unknown as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      return coerceToUint8Array(await io.read(path));
    } catch {
      /* fall through */
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      return coerceToUint8Array(await osFile.read(path));
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileBytes(path: string, data: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, data);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, data);
  }
}

function updateFnv1a(hash: number, byte: number): number {
  hash ^= byte & 0xff;
  return Math.imul(hash, 0x01000193) >>> 0;
}

function hashBytes(hash: number, bytes: Uint8Array): number {
  let next = hash >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    next = updateFnv1a(next, bytes[i]);
  }
  return next;
}

function computeCacheEntriesContentHash(
  entries: Record<string, Uint8Array>,
): string {
  const encoder = new TextEncoder();
  let hash = 0x811c9dc5;
  for (const path of Object.keys(entries).sort()) {
    if (
      path === MINERU_SYNC_METADATA_FILE ||
      path === MINERU_LOCAL_SYNC_STATE_FILE
    ) {
      continue;
    }
    hash = hashBytes(hash, encoder.encode(path));
    hash = updateFnv1a(hash, 0);
    hash = hashBytes(hash, entries[path]);
    hash = updateFnv1a(hash, 0xff);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function removePath(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    try {
      await io.remove(path, { recursive: true, ignoreAbsent: true });
      return;
    } catch {
      /* fall through */
    }
  }
  const osFile = getOSFile();
  if (osFile?.remove) {
    try {
      await osFile.remove(path, { ignoreAbsent: true });
    } catch {
      /* ignore */
    }
  }
}

function normalizePackagePath(value: string): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  if (/^(?:[A-Za-z]:|[\\/]{2}|[\\/])/.test(raw)) return null;
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

export function shouldIncludeMineruCachePackageEntry(
  relativePath: string,
): boolean {
  const normalized = normalizePackagePath(relativePath);
  if (!normalized) return false;
  const parts = normalized.split("/");
  if (parts[0] === "__MACOSX") return false;
  const basename = parts[parts.length - 1] || "";
  if (!basename || basename === ".DS_Store") return false;
  if (basename === MINERU_LOCAL_SYNC_STATE_FILE) return false;
  return basename.toLowerCase() !== "layout.json";
}

function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function toRelativePath(rootPath: string, filePath: string): string | null {
  const root = normalizeAbsolutePath(rootPath);
  const file = normalizeAbsolutePath(filePath);
  if (file === root) return null;
  const prefix = `${root}/`;
  if (!file.startsWith(prefix)) return null;
  return file.slice(prefix.length);
}

async function listCacheFiles(
  rootPath: string,
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const io = getIOUtils();
  if (!io?.getChildren) return [];

  const out: Array<{ absolutePath: string; relativePath: string }> = [];
  const visit = async (dirPath: string): Promise<void> => {
    let children: string[];
    try {
      children = await io.getChildren!(dirPath);
    } catch {
      return;
    }

    for (const childPath of children) {
      const bytes = await readFileBytes(childPath);
      if (bytes) {
        const relativePath = toRelativePath(rootPath, childPath);
        if (relativePath) {
          out.push({ absolutePath: childPath, relativePath });
        }
        continue;
      }
      await visit(childPath);
    }
  };

  await visit(rootPath);
  return out;
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

function getAttachmentTitle(item: Zotero.Item): string {
  try {
    const title = item.getField?.("title");
    if (typeof title === "string" && title.trim()) return title.trim();
  } catch {
    /* ignore */
  }
  return getAttachmentFilename(item) || `Attachment ${item.id}`;
}

function getParentItem(item: Zotero.Item): Zotero.Item | null {
  const parentId = Number(item.parentID);
  if (!Number.isFinite(parentId) || parentId <= 0) return null;
  return Zotero.Items.get(Math.floor(parentId)) || null;
}

function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return Boolean(
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf",
  );
}

function buildPackageTitle(sourceAttachmentKey: string): string {
  return `${MINERU_SYNC_ATTACHMENT_TITLE_PREFIX} ${sourceAttachmentKey}.zip`;
}

function getPackageAttachmentSearchText(item: Zotero.Item): string {
  return `${getAttachmentTitle(item)} ${getAttachmentFilename(item)}`.trim();
}

export function isMineruSyncPackageTitle(value: string): boolean {
  return value.trim().startsWith(MINERU_SYNC_ATTACHMENT_TITLE_PREFIX);
}

export function isMineruSyncPackageAttachment(item: Zotero.Item): boolean {
  if (!item?.isAttachment?.()) return false;
  return isMineruSyncPackageTitle(getPackageAttachmentSearchText(item));
}

function createMetadata(
  sourceAttachment: Zotero.Item,
  cacheContentHash: string,
): MineruSyncMetadata {
  const parentItem = getParentItem(sourceAttachment);
  const now = new Date().toISOString();
  return {
    kind: MINERU_SYNC_PACKAGE_KIND,
    version: MINERU_SYNC_PACKAGE_VERSION,
    createdAt: now,
    generatedAt: now,
    updatedAt: now,
    addonName: config.addonName,
    addonVersion,
    mineruCacheVersion: MINERU_CACHE_VERSION,
    cacheContentHash,
    sourceAttachmentKey: getItemKey(sourceAttachment),
    sourceAttachmentFilename: getAttachmentFilename(sourceAttachment),
    parentItemKey: getItemKey(parentItem),
  };
}

function parseMineruSyncMetadata(data: Uint8Array): MineruSyncMetadata | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8").decode(data),
    ) as Partial<MineruSyncMetadata>;
    if (
      parsed.kind !== MINERU_SYNC_PACKAGE_KIND ||
      parsed.version !== MINERU_SYNC_PACKAGE_VERSION ||
      typeof parsed.sourceAttachmentKey !== "string" ||
      !parsed.sourceAttachmentKey.trim()
    ) {
      return null;
    }
    return parsed as MineruSyncMetadata;
  } catch {
    return null;
  }
}

export function readMineruSyncMetadataFromPackageBytes(
  zipBytes: Uint8Array,
): MineruSyncMetadata | null {
  try {
    const entries = unzipSync(zipBytes);
    const metadataBytes = entries[MINERU_SYNC_METADATA_FILE];
    return metadataBytes ? parseMineruSyncMetadata(metadataBytes) : null;
  } catch {
    return null;
  }
}

async function collectMineruCachePackageEntries(
  sourceAttachment: Zotero.Item,
): Promise<Record<string, Uint8Array> | null> {
  const sourceKey = getItemKey(sourceAttachment);
  if (!sourceKey) return null;

  const itemDir = getMineruItemDir(sourceAttachment.id);
  if (!(await pathExists(itemDir))) return null;

  try {
    await ensureManifest(sourceAttachment.id);
  } catch {
    try {
      await buildAndWriteManifest(sourceAttachment.id);
    } catch {
      /* manifest remains best-effort */
    }
  }

  const entries: Record<string, Uint8Array> = {};

  for (const file of await listCacheFiles(itemDir)) {
    const normalized = normalizePackagePath(file.relativePath);
    if (!normalized || !shouldIncludeMineruCachePackageEntry(normalized)) {
      continue;
    }
    const bytes = await readFileBytes(file.absolutePath);
    if (!bytes) continue;
    entries[normalized] = bytes;
  }

  if (!entries["full.md"]) return null;
  if (!entries["manifest.json"]) {
    try {
      await buildAndWriteManifest(sourceAttachment.id);
      const manifestBytes = await readFileBytes(
        joinLocalPath(itemDir, "manifest.json"),
      );
      if (manifestBytes) entries["manifest.json"] = manifestBytes;
    } catch {
      /* non-critical */
    }
  }

  return entries["full.md"] ? entries : null;
}

async function buildMineruSyncPackage(sourceAttachment: Zotero.Item): Promise<{
  packageBytes: Uint8Array;
  metadata: MineruSyncMetadata;
  contentHash: string;
} | null> {
  const entries = await collectMineruCachePackageEntries(sourceAttachment);
  if (!entries) return null;
  const contentHash = computeCacheEntriesContentHash(entries);
  const metadata = createMetadata(sourceAttachment, contentHash);
  const packageEntries: Record<string, Uint8Array> = {
    ...entries,
    [MINERU_SYNC_METADATA_FILE]: new TextEncoder().encode(
      JSON.stringify(metadata, null, 2),
    ),
  };
  return {
    packageBytes: zipSync(packageEntries, { level: 6 }),
    metadata,
    contentHash,
  };
}

export async function buildMineruSyncPackageBytes(
  sourceAttachment: Zotero.Item,
): Promise<Uint8Array | null> {
  const built = await buildMineruSyncPackage(sourceAttachment);
  return built?.packageBytes || null;
}

function getTempRootDir(): string {
  const tempPath =
    (
      Zotero as unknown as {
        getTempDirectory?: () => { path?: string } | null;
      }
    ).getTempDirectory?.()?.path || "";
  return joinLocalPath(
    tempPath || getMineruCacheDir(),
    "llm-for-zotero-mineru-sync",
  );
}

async function writeTempPackageFile(
  sourceAttachmentKey: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = getTempRootDir();
  await ensureDir(dir);
  const safeKey = sourceAttachmentKey.replace(/[^A-Za-z0-9_-]/g, "_");
  const filePath = joinLocalPath(
    dir,
    `${MINERU_SYNC_ATTACHMENT_TITLE_PREFIX.replace(/[^A-Za-z0-9_-]+/g, "-")}-${safeKey}-${Date.now()}.zip`,
  );
  await writeFileBytes(filePath, bytes);
  return filePath;
}

function pathToNsIFile(filePath: string): nsIFile | string {
  const zoteroFile = (
    Zotero as unknown as {
      File?: { pathToFile?: (pathOrFile: string) => nsIFile };
    }
  ).File;
  if (zoteroFile?.pathToFile) {
    try {
      return zoteroFile.pathToFile(filePath);
    } catch {
      /* fall through */
    }
  }

  const components = (
    globalThis as unknown as {
      Components?: {
        classes?: Record<
          string,
          { createInstance: (iface: unknown) => nsIFile }
        >;
        interfaces?: { nsIFile?: unknown };
      };
    }
  ).Components;
  const localFileClass = components?.classes?.["@mozilla.org/file/local;1"];
  const nsIFileIface = components?.interfaces?.nsIFile;
  if (localFileClass && nsIFileIface) {
    try {
      const file = localFileClass.createInstance(nsIFileIface);
      file.initWithPath(filePath);
      return file;
    } catch {
      /* fall through */
    }
  }

  return filePath;
}

async function deletePackageAttachment(item: Zotero.Item): Promise<void> {
  const eraseTx = (item as unknown as { eraseTx?: () => Promise<void> })
    .eraseTx;
  if (typeof eraseTx === "function") {
    await eraseTx.call(item);
    return;
  }
  (item as unknown as { deleted?: boolean }).deleted = true;
  await item.saveTx();
}

async function readAttachmentFileBytes(
  item: Zotero.Item,
): Promise<Uint8Array | null> {
  const path = await (
    item as unknown as { getFilePathAsync?: () => Promise<string | false> }
  ).getFilePathAsync?.();
  if (!path) return null;
  return readFileBytes(path);
}

async function computeLocalMineruCacheContentHash(
  attachmentId: number,
): Promise<string | null> {
  const itemDir = getMineruItemDir(attachmentId);
  if (!(await pathExists(itemDir))) return null;
  const entries: Record<string, Uint8Array> = {};
  for (const file of await listCacheFiles(itemDir)) {
    const normalized = normalizePackagePath(file.relativePath);
    if (!normalized || !shouldIncludeMineruCachePackageEntry(normalized)) {
      continue;
    }
    const bytes = await readFileBytes(file.absolutePath);
    if (bytes) entries[normalized] = bytes;
  }
  return entries["full.md"] ? computeCacheEntriesContentHash(entries) : null;
}

async function packageAttachmentHasMetadata(
  item: Zotero.Item,
): Promise<boolean> {
  const filename = getAttachmentFilename(item).toLowerCase();
  const contentType = String(
    (item as unknown as { attachmentContentType?: unknown })
      .attachmentContentType || "",
  ).toLowerCase();
  if (
    !filename.endsWith(".zip") &&
    !contentType.includes("zip") &&
    !isMineruSyncPackageAttachment(item)
  ) {
    return false;
  }
  const bytes = await readAttachmentFileBytes(item);
  return Boolean(bytes && readMineruSyncMetadataFromPackageBytes(bytes));
}

function getPackageTimestampMs(metadata?: MineruSyncMetadata): number {
  if (!metadata) return 0;
  for (const value of [
    metadata.updatedAt,
    metadata.generatedAt,
    metadata.createdAt,
  ]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function extractPackageFiles(zipBytes: Uint8Array): ExtractedMineruSyncPackage | null {
  try {
    const zipEntries = unzipSync(zipBytes);
    const metadataBytes = zipEntries[MINERU_SYNC_METADATA_FILE];
    const metadata = metadataBytes
      ? parseMineruSyncMetadata(metadataBytes)
      : null;
    const fullMdBytes = zipEntries["full.md"];
    if (!metadata || !fullMdBytes) return null;

    const hashEntries: Record<string, Uint8Array> = {};
    const files: MineruCacheFile[] = [];
    for (const [entryPath, data] of Object.entries(zipEntries)) {
      if (entryPath === MINERU_SYNC_METADATA_FILE) continue;
      const normalized = normalizePackagePath(entryPath);
      if (!normalized || !shouldIncludeMineruCachePackageEntry(normalized)) {
        continue;
      }
      hashEntries[normalized] = data;
      if (normalized !== "full.md") {
        files.push({ relativePath: normalized, data });
      }
    }

    if (!hashEntries["full.md"]) return null;
    const contentHash = computeCacheEntriesContentHash(hashEntries);
    if (
      typeof metadata.cacheContentHash === "string" &&
      metadata.cacheContentHash.trim() &&
      metadata.cacheContentHash !== contentHash
    ) {
      return null;
    }

    return {
      metadata,
      mdContent: new TextDecoder("utf-8").decode(fullMdBytes),
      files,
      contentHash,
    };
  } catch {
    return null;
  }
}

async function collectPackageAttachmentCandidates(
  sourceAttachment: Zotero.Item,
): Promise<Zotero.Item[]> {
  const sourceKey = getItemKey(sourceAttachment);
  if (!sourceKey) return [];

  const candidates: Zotero.Item[] = [];
  const parentItem = getParentItem(sourceAttachment);
  if (parentItem?.getAttachments) {
    for (const attachmentId of parentItem.getAttachments()) {
      const item = Zotero.Items.get(attachmentId);
      if (
        item?.isAttachment?.() &&
        !(item as unknown as { deleted?: boolean }).deleted
      ) {
        candidates.push(item);
      }
    }
  } else {
    const libraryID = Number(sourceAttachment.libraryID);
    if (Number.isFinite(libraryID) && libraryID > 0) {
      try {
        const items = await Zotero.Items.getAll(
          Math.floor(libraryID),
          false,
          false,
          false,
        );
        for (const item of items) {
          if (
            item?.isAttachment?.() &&
            !(item as unknown as { deleted?: boolean }).deleted
          ) {
            candidates.push(item);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  return candidates;
}

async function findPackageCandidatesForSource(
  sourceAttachment: Zotero.Item,
  options: { loadBytes?: boolean; requireReadable?: boolean } = {},
): Promise<MineruPackageCandidate[]> {
  const sourceKey = getItemKey(sourceAttachment);
  if (!sourceKey) return [];

  const matches: MineruPackageCandidate[] = [];
  const candidates = await collectPackageAttachmentCandidates(sourceAttachment);
  for (const item of candidates) {
    const titleMatched =
      isMineruSyncPackageAttachment(item) &&
      getPackageAttachmentSearchText(item).includes(sourceKey);
    const filename = getAttachmentFilename(item).toLowerCase();
    const contentType = String(
      (item as unknown as { attachmentContentType?: unknown })
        .attachmentContentType || "",
    ).toLowerCase();
    const zipish = filename.endsWith(".zip") || contentType.includes("zip");
    if (!titleMatched && !zipish) continue;

    try {
      const shouldRead = Boolean(options.loadBytes || options.requireReadable);
      if (!titleMatched && !shouldRead) continue;
      const bytes = shouldRead ? await readAttachmentFileBytes(item) : null;
      const extracted = bytes ? extractPackageFiles(bytes) : null;
      const metadata = extracted?.metadata;
      if (metadata && metadata.sourceAttachmentKey !== sourceKey) continue;
      if (options.requireReadable && !extracted) continue;
      if (!titleMatched && !extracted) continue;
      matches.push({
        item,
        metadata,
        bytes: bytes || undefined,
        extracted: extracted || undefined,
        contentHash: extracted?.contentHash,
        timestampMs: getPackageTimestampMs(metadata),
        titleMatched,
      });
    } catch {
      /* ignore unreadable non-package attachments */
    }
  }
  return matches;
}

function selectBestPackageCandidate(
  candidates: MineruPackageCandidate[],
): MineruPackageCandidate | null {
  const readable = candidates.filter((candidate) => candidate.extracted);
  if (!readable.length) return null;
  readable.sort((a, b) => {
    const byTime = b.timestampMs - a.timestampMs;
    if (byTime !== 0) return byTime;
    return b.item.id - a.item.id;
  });
  return readable[0];
}

async function prunePackageCandidates(
  candidates: MineruPackageCandidate[],
  keepAttachmentId?: number,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.item.id === keepAttachmentId) continue;
    try {
      await deletePackageAttachment(candidate.item);
    } catch {
      ztoolkit.log(
        "LLM: Failed to prune duplicate MinerU sync package",
        candidate.item.id,
      );
    }
  }
}

export async function hasSyncedMineruPackageForAttachment(
  sourceAttachment: Zotero.Item,
  options: MineruAvailabilityOptions = {},
): Promise<boolean> {
  if (!isPdfAttachment(sourceAttachment)) return false;
  const validateSyncedPackage = options.validateSyncedPackage !== false;
  const candidates = await findPackageCandidatesForSource(sourceAttachment, {
    loadBytes: validateSyncedPackage,
    requireReadable: validateSyncedPackage,
  });
  return candidates.length > 0;
}

export async function getMineruAvailabilityForAttachment(
  sourceAttachment: Zotero.Item,
  options: MineruAvailabilityOptions = {},
): Promise<MineruAvailability> {
  const attachmentId = sourceAttachment.id;
  if (!isPdfAttachment(sourceAttachment)) {
    return {
      status: "missing",
      localCached: false,
      syncedPackage: false,
      attachmentId,
    };
  }
  const syncEnabled = isMineruSyncEnabled();
  const [localCached, syncedPackage] = await Promise.all([
    hasCachedMineruMd(attachmentId),
    syncEnabled
      ? hasSyncedMineruPackageForAttachment(sourceAttachment, options)
      : Promise.resolve(false),
  ]);
  return {
    status: localCached
      ? syncedPackage
        ? "both"
        : "local"
      : syncedPackage
        ? "synced"
        : "missing",
    localCached,
    syncedPackage,
    attachmentId,
  };
}

export async function getMineruAvailabilityForAttachmentId(
  attachmentId: number,
  options: MineruAvailabilityOptions = {},
): Promise<MineruAvailability> {
  const item = Zotero.Items.get(attachmentId);
  if (!item) {
    return {
      status: "missing",
      localCached: false,
      syncedPackage: false,
      attachmentId,
    };
  }
  return getMineruAvailabilityForAttachment(item, options);
}

async function importPackageAttachment(params: {
  sourceAttachment: Zotero.Item;
  packageBytes: Uint8Array;
}): Promise<Zotero.Item | null> {
  const attachmentsApi = (
    Zotero as unknown as { Attachments?: AttachmentImportApi }
  ).Attachments;
  if (!attachmentsApi?.importFromFile) return null;

  const sourceKey = getItemKey(params.sourceAttachment);
  const tempPath = await writeTempPackageFile(sourceKey, params.packageBytes);
  const parentItem = getParentItem(params.sourceAttachment);
  const title = buildPackageTitle(sourceKey);
  const filename = title.replace(/^\[/, "").replace(/[^A-Za-z0-9._-]+/g, "-");

  try {
    const imported = await attachmentsApi.importFromFile({
      file: pathToNsIFile(tempPath),
      libraryID: parentItem ? undefined : params.sourceAttachment.libraryID,
      parentItemID: parentItem?.id,
      title,
      fileBaseName: filename.replace(/\.zip$/i, ""),
      contentType: "application/zip",
    });

    try {
      imported.setField?.("title", title);
      await imported.saveTx();
    } catch {
      /* imported item may already have the title */
    }
    return imported;
  } finally {
    void removePath(tempPath);
  }
}

async function writeLocalSyncState(params: {
  attachmentId: number;
  sourceAttachmentKey: string;
  packageAttachmentId?: number;
  cacheContentHash: string;
}): Promise<void> {
  const state: MineruLocalSyncState = {
    kind: MINERU_SYNC_PACKAGE_KIND,
    restoredAt: new Date().toISOString(),
    sourceAttachmentKey: params.sourceAttachmentKey,
    packageAttachmentId: params.packageAttachmentId,
    cacheContentHash: params.cacheContentHash,
  };
  await writeFileBytes(
    joinLocalPath(getMineruItemDir(params.attachmentId), MINERU_LOCAL_SYNC_STATE_FILE),
    new TextEncoder().encode(JSON.stringify(state, null, 2)),
  );
}

async function invalidateRestoredMineruCache(
  attachmentId: number,
): Promise<void> {
  pdfTextCache.delete(attachmentId);
  pdfTextLoadingTasks.delete(attachmentId);
  import("./multiContextPlanner")
    .then(({ clearRetrievalCandidateCache }) =>
      clearRetrievalCandidateCache(attachmentId),
    )
    .catch(() => {});
  import("./embeddingCache")
    .then(({ clearEmbeddingCache }) => clearEmbeddingCache(attachmentId))
    .catch(() => {});
}

function cloneMigrationResult(
  result: MineruSyncMigrationResult,
): MineruSyncMigrationResult {
  return { ...result };
}

function yieldToUi(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  });
}

export async function publishMineruCachePackageForAttachment(
  attachmentId: number,
): Promise<MineruSyncPublishResult> {
  if (!isMineruSyncEnabled()) {
    return { status: "disabled", attachmentId };
  }

  try {
    const sourceAttachment = Zotero.Items.get(attachmentId);
    if (!sourceAttachment) return { status: "not_found", attachmentId };
    if (!isPdfAttachment(sourceAttachment)) {
      return { status: "not_pdf", attachmentId };
    }
    const sourceKey = getItemKey(sourceAttachment);
    if (!sourceKey) return { status: "missing_key", attachmentId };

    const built = await buildMineruSyncPackage(sourceAttachment);
    if (!built) return { status: "no_cache", attachmentId };

    const existing = await findPackageCandidatesForSource(sourceAttachment, {
      loadBytes: true,
      requireReadable: false,
    });
    const equivalent = selectBestPackageCandidate(
      existing.filter((candidate) => candidate.contentHash === built.contentHash),
    );
    if (equivalent) {
      await prunePackageCandidates(existing, equivalent.item.id);
      return {
        status: "up_to_date",
        attachmentId,
        packageAttachmentId: equivalent.item.id,
      };
    }

    const imported = await importPackageAttachment({
      sourceAttachment,
      packageBytes: built.packageBytes,
    });
    if (!imported) {
      return {
        status: "unsupported_io",
        attachmentId,
        reason: "Zotero attachment import is unavailable",
      };
    }
    await prunePackageCandidates(existing, imported.id);
    return {
      status: "published",
      attachmentId,
      packageAttachmentId: imported.id,
    };
  } catch (error) {
    return {
      status: "error",
      attachmentId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureMineruRuntimeCacheForAttachment(
  sourceAttachment: Zotero.Item,
): Promise<MineruSyncRestoreResult> {
  const attachmentId = sourceAttachment.id;
  if (!isMineruSyncEnabled()) return { status: "disabled", attachmentId };
  if (!isPdfAttachment(sourceAttachment))
    return { status: "not_pdf", attachmentId };
  const sourceKey = getItemKey(sourceAttachment);
  if (!sourceKey) return { status: "missing_key", attachmentId };

  try {
    if (await hasCachedMineruMd(attachmentId)) {
      return { status: "already_cached", attachmentId };
    }

    const candidates = await findPackageCandidatesForSource(sourceAttachment, {
      loadBytes: true,
      requireReadable: false,
    });
    if (!candidates.length) return { status: "no_package", attachmentId };

    const selected = selectBestPackageCandidate(candidates);
    if (!selected?.extracted) {
      return { status: "invalid_package", attachmentId };
    }

    const packageContentHash = selected.extracted.contentHash;

    await removePath(getMineruItemDir(attachmentId));
    await writeMineruCacheFiles(
      attachmentId,
      selected.extracted.mdContent,
      selected.extracted.files,
    );
    await writeLocalSyncState({
      attachmentId,
      sourceAttachmentKey: sourceKey,
      packageAttachmentId: selected.item.id,
      cacheContentHash: packageContentHash,
    });
    await invalidateRestoredMineruCache(attachmentId);
    return {
      status: "restored",
      attachmentId,
      packageAttachmentId: selected.item.id,
      packageContentHash,
    };
  } catch (error) {
    return {
      status: "error",
      attachmentId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function restoreSyncedMineruCacheForAttachment(
  sourceAttachment: Zotero.Item,
): Promise<MineruSyncRestoreResult> {
  return ensureMineruRuntimeCacheForAttachment(sourceAttachment);
}

export async function ensureMineruCacheDirForAttachment(
  sourceAttachment: Zotero.Item | null | undefined,
): Promise<string | undefined> {
  if (!sourceAttachment || !isPdfAttachment(sourceAttachment)) return undefined;
  const attachmentId = sourceAttachment.id;
  try {
    if (await hasCachedMineruMd(attachmentId)) {
      return getMineruItemDir(attachmentId);
    }

    const restored =
      await ensureMineruRuntimeCacheForAttachment(sourceAttachment);
    if (
      (restored.status === "restored" ||
        restored.status === "already_cached") &&
      (await hasCachedMineruMd(attachmentId))
    ) {
      return getMineruItemDir(attachmentId);
    }
  } catch {
    /* fall back to existing non-MinerU paths */
  }
  return undefined;
}

export async function repairSyncedMineruCacheForAttachment(
  sourceAttachment: Zotero.Item,
): Promise<MineruSyncRestoreResult> {
  const attachmentId = sourceAttachment.id;
  if (!isMineruSyncEnabled()) return { status: "disabled", attachmentId };
  if (!isPdfAttachment(sourceAttachment))
    return { status: "not_pdf", attachmentId };
  const sourceKey = getItemKey(sourceAttachment);
  if (!sourceKey) return { status: "missing_key", attachmentId };

  try {
    const candidates = await findPackageCandidatesForSource(sourceAttachment, {
      loadBytes: true,
      requireReadable: false,
    });
    if (!candidates.length) return { status: "no_package", attachmentId };

    const selected = selectBestPackageCandidate(candidates);
    if (!selected?.extracted) {
      return { status: "invalid_package", attachmentId };
    }
    await prunePackageCandidates(candidates, selected.item.id);

    const uniqueHashes = new Set(
      candidates
        .map((candidate) => candidate.contentHash)
        .filter((hash): hash is string => Boolean(hash)),
    );
    const diverged = uniqueHashes.size > 1;
    if (diverged) {
      ztoolkit.log(
        "LLM: MinerU sync package divergence detected",
        sourceKey,
        [...uniqueHashes],
      );
    }
    const packageContentHash = selected.extracted.contentHash;
    const localContentHash = await computeLocalMineruCacheContentHash(
      attachmentId,
    );

    if (localContentHash && localContentHash === packageContentHash) {
      await writeLocalSyncState({
        attachmentId,
        sourceAttachmentKey: sourceKey,
        packageAttachmentId: selected.item.id,
        cacheContentHash: packageContentHash,
      });
      return {
        status: "already_cached",
        attachmentId,
        packageAttachmentId: selected.item.id,
        localContentHash,
        packageContentHash,
        diverged,
      };
    }

    await removePath(getMineruItemDir(attachmentId));
    await writeMineruCacheFiles(
      attachmentId,
      selected.extracted.mdContent,
      selected.extracted.files,
    );
    await writeLocalSyncState({
      attachmentId,
      sourceAttachmentKey: sourceKey,
      packageAttachmentId: selected.item.id,
      cacheContentHash: packageContentHash,
    });
    await invalidateRestoredMineruCache(attachmentId);
    return {
      status: "restored",
      attachmentId,
      packageAttachmentId: selected.item.id,
      localContentHash: localContentHash || undefined,
      packageContentHash,
      diverged,
    };
  } catch (error) {
    return {
      status: "error",
      attachmentId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

let migrationTask: Promise<MineruSyncMigrationResult> | null = null;

async function getAllLibraryPdfAttachments(): Promise<Zotero.Item[]> {
  const libraryID = Number(Zotero.Libraries.userLibraryID);
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  let allItems: Zotero.Item[];
  try {
    allItems = await Zotero.Items.getAll(
      Math.floor(libraryID),
      true,
      false,
      false,
    );
  } catch {
    return [];
  }

  const out: Zotero.Item[] = [];
  const seen = new Set<number>();
  const addPdf = (item: Zotero.Item | null | undefined) => {
    if (!item || !isPdfAttachment(item) || seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };

  for (const item of allItems) {
    if (item?.isRegularItem?.()) {
      for (const attachmentId of item.getAttachments?.() || []) {
        addPdf(Zotero.Items.get(attachmentId));
      }
    } else {
      addPdf(item);
    }
  }
  return out;
}

export async function publishExistingMineruCaches(
  options: MineruSyncMigrationOptions = {},
): Promise<MineruSyncMigrationResult> {
  const result: MineruSyncMigrationResult = {
    scanned: 0,
    published: 0,
    restored: 0,
    upToDate: 0,
    diverged: 0,
    skipped: 0,
    failed: 0,
  };
  if (!isMineruSyncEnabled()) return result;

  const batchSize =
    Number.isFinite(options.batchSize) && Number(options.batchSize) > 0
      ? Math.floor(Number(options.batchSize))
      : 5;
  const yieldMs =
    Number.isFinite(options.yieldMs) && Number(options.yieldMs) >= 0
      ? Math.floor(Number(options.yieldMs))
      : 25;

  for (const item of await getAllLibraryPdfAttachments()) {
    result.scanned += 1;
    try {
      const restored = await repairSyncedMineruCacheForAttachment(item);
      if (restored.status === "restored") result.restored += 1;
      if (restored.diverged) result.diverged += 1;
      if (restored.status === "error") {
        result.failed += 1;
      } else {
        const published = await publishMineruCachePackageForAttachment(item.id);
        if (published.status === "published") {
          result.published += 1;
        } else if (published.status === "up_to_date") {
          result.upToDate += 1;
        } else if (published.status === "error") {
          result.failed += 1;
        } else {
          result.skipped += 1;
        }
      }
    } catch {
      result.failed += 1;
    }

    if (result.scanned % batchSize === 0) {
      options.onProgress?.(cloneMigrationResult(result));
      await yieldToUi(yieldMs);
    }
  }

  options.onProgress?.(cloneMigrationResult(result));
  return result;
}

export async function repairMineruSyncPackages(
  options: MineruSyncMigrationOptions = {},
): Promise<MineruSyncMigrationResult> {
  return publishExistingMineruCaches(options);
}

export function startMineruSyncMigrationIfEnabled(): void {
  if (!isMineruSyncEnabled() || migrationTask) return;
  migrationTask = publishExistingMineruCaches()
    .catch((error) => {
      ztoolkit.log("LLM: MinerU sync migration failed", error);
      return {
        scanned: 0,
        published: 0,
        restored: 0,
        upToDate: 0,
        diverged: 0,
        skipped: 0,
        failed: 1,
      };
    })
    .finally(() => {
      migrationTask = null;
    }) as Promise<MineruSyncMigrationResult>;
}

function getLibraryIdsForCleanup(): number[] {
  try {
    const libraries = Zotero.Libraries.getAll?.() || [];
    const ids = libraries
      .map((library) => Number(library.libraryID))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length) return ids;
  } catch {
    /* fall through */
  }
  const userLibraryID = Number(Zotero.Libraries.userLibraryID);
  return Number.isFinite(userLibraryID) && userLibraryID > 0
    ? [Math.floor(userLibraryID)]
    : [];
}

export async function cleanSyncedMineruPackages(): Promise<MineruSyncCleanupResult> {
  const result: MineruSyncCleanupResult = { deleted: 0, failed: 0 };
  for (const libraryID of getLibraryIdsForCleanup()) {
    let items: Zotero.Item[];
    try {
      items = await Zotero.Items.getAll(libraryID, false, false, false);
    } catch {
      continue;
    }
    for (const item of items) {
      if (!item?.isAttachment?.()) continue;
      let shouldDelete = isMineruSyncPackageAttachment(item);
      if (!shouldDelete) {
        try {
          shouldDelete = await packageAttachmentHasMetadata(item);
        } catch {
          shouldDelete = false;
        }
      }
      if (!shouldDelete) continue;
      try {
        await deletePackageAttachment(item);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}
