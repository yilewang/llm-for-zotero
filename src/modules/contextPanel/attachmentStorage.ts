import { CHAT_ATTACHMENTS_DIR_NAME } from "./constants";
import {
  fileUrlToPath,
  getLocalParentPath,
  joinLocalPath,
  toFileUrl,
} from "../../utils/localPath";

export const ATTACHMENT_BLOBS_TABLE = "llm_for_zotero_attachment_blobs";

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  copy?: (sourcePath: string, destPath: string) => Promise<void>;
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
  copy?: (sourcePath: string, destPath: string) => Promise<void>;
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

function sanitizeFileName(name: string): string {
  const trimmed = (name || "").trim() || "attachment";
  const withoutReserved = trimmed.replace(/[\\?%*:|"<>/]/g, "_");
  const withoutControlChars = Array.from(withoutReserved, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? "_" : ch;
  }).join("");
  const sanitized = withoutControlChars.replace(/\s+/g, " ").trim();
  return sanitized || "attachment";
}

function splitFileName(name: string): { stem: string; ext: string } {
  const safe = sanitizeFileName(name);
  const index = safe.lastIndexOf(".");
  if (index <= 0 || index === safe.length - 1) {
    return { stem: safe, ext: "" };
  }
  return {
    stem: safe.slice(0, index),
    ext: safe.slice(index),
  };
}

function getBaseWritableDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
    getTempDirectory?: () => { path?: string } | null;
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) {
    return dataDir.trim();
  }
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return profileDir.trim();
  }
  const tempDirObj = zotero.getTempDirectory?.();
  if (typeof tempDirObj?.path === "string" && tempDirObj.path.trim()) {
    return tempDirObj.path.trim();
  }
  throw new Error(
    "Cannot resolve writable data directory for chat attachments",
  );
}

export function getChatAttachmentsRootDir(): string {
  return joinLocalPath(getBaseWritableDir(), CHAT_ATTACHMENTS_DIR_NAME);
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
    return;
  }
  throw new Error("No directory creation API available");
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch (_err) {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch (_err) {
      return false;
    }
  }
  return false;
}

/**
 * Convert whatever a file-read API returns to a Uint8Array.
 *
 * Firefox extensions run in a separate JavaScript realm from the privileged
 * system APIs (IOUtils, OS.File).  Objects returned by those APIs are created
 * in the system realm, so `instanceof Uint8Array` / `instanceof ArrayBuffer`
 * comparisons against the extension realm's constructors silently return false
 * even for valid typed arrays.  We use realm-agnostic checks instead:
 *  - ArrayBuffer.isView()  → works cross-realm for any TypedArray / DataView
 *  - typeof .byteLength    → distinguishes a plain ArrayBuffer from everything else
 */
function coerceToUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (data == null) return null;
  // Fast path – same realm (unit tests, Node, some Zotero versions).
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Cross-realm TypedArray / DataView (ArrayBuffer.isView is spec-required to
  // work across realms because it checks internal slots, not the prototype).
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  // Cross-realm ArrayBuffer: it has a numeric byteLength but no "buffer" slot.
  const buf = data as unknown as { byteLength?: unknown };
  if (typeof buf.byteLength === "number" && !ArrayBuffer.isView(data)) {
    try {
      return new Uint8Array(data as unknown as ArrayBuffer);
    } catch {
      // Not actually an ArrayBuffer — fall through.
    }
  }
  return null;
}

async function readBytes(path: string): Promise<Uint8Array> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(path);
      const bytes = coerceToUint8Array(data);
      if (bytes) return bytes;
    } catch (err) {
      // IOUtils threw (e.g. file not found) – fall through to OS.File.
      const osFile2 = getOSFile();
      if (!osFile2?.read) throw err;
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    const data = await osFile.read(path);
    const bytes = coerceToUint8Array(data);
    if (bytes) return bytes;
  }
  throw new Error("No binary read API available");
}

export async function readAttachmentBytes(path: string): Promise<Uint8Array> {
  return readBytes(path);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
    return;
  }
  throw new Error("No binary write API available");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function computeSHA256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw new Error("WebCrypto subtle.digest unavailable");
  }
  const hashBuffer = await subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  const io = getIOUtils();
  if (io?.copy) {
    await io.copy(sourcePath, destPath);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.copy) {
    await osFile.copy(sourcePath, destPath);
    return;
  }
  throw new Error("No file copy API available");
}

async function removePath(path: string, recursive: boolean): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    try {
      await io.remove(path, { recursive, ignoreAbsent: true });
      return;
    } catch (err) {
      ztoolkit.log("LLM: IOUtils.remove failed", err);
    }
  }
  const osFile = getOSFile();
  try {
    if (recursive && osFile?.removeDir) {
      await osFile.removeDir(path, {
        ignoreAbsent: true,
        ignorePermissions: false,
      });
      return;
    }
    if (osFile?.remove) {
      await osFile.remove(path, { ignoreAbsent: true });
    }
  } catch (err) {
    ztoolkit.log("LLM: OS.File remove failed", err);
  }
}

async function reserveUniquePath(
  dirPath: string,
  fileName: string,
): Promise<string> {
  const { stem, ext } = splitFileName(fileName);
  const safeStem = stem.slice(0, 120) || "attachment";
  let attempt = 0;
  while (attempt < 500) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = `${safeStem}${suffix}${ext}`;
    const candidatePath = joinLocalPath(dirPath, candidate);
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
    attempt += 1;
  }
  const fallback = `${safeStem}-${Date.now()}${ext}`;
  return joinLocalPath(dirPath, fallback);
}

let blobTableInitTask: Promise<void> | null = null;
async function ensureBlobTable(): Promise<void> {
  if (!blobTableInitTask) {
    blobTableInitTask = (async () => {
      await Zotero.DB.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${ATTACHMENT_BLOBS_TABLE} (
          hash TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );
    })();
  }
  await blobTableInitTask;
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function getConversationDir(conversationKey: number): string {
  const root = getChatAttachmentsRootDir();
  return joinLocalPath(root, "chats", String(conversationKey));
}

function getConversationAttachmentPath(
  conversationKey: number,
  fileName: string,
): string {
  const dirPath = getConversationDir(conversationKey);
  const safeName = sanitizeFileName(fileName);
  return joinLocalPath(dirPath, safeName);
}

function getNoteDir(noteId: number): string {
  const root = getChatAttachmentsRootDir();
  return joinLocalPath(root, "notes", String(noteId));
}

function getBlobDir(contentHash: string): string {
  const root = getChatAttachmentsRootDir();
  return joinLocalPath(root, "blobs", contentHash);
}

function getBlobPath(contentHash: string, fileName: string): string {
  const dirPath = getBlobDir(contentHash);
  return joinLocalPath(dirPath, sanitizeFileName(fileName));
}

export function extractManagedBlobHash(storedPath: string | undefined): string {
  const raw = (storedPath || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const root = getChatAttachmentsRootDir()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const prefix = `${root}/blobs/`;
  if (!normalized.startsWith(prefix)) return "";
  const rest = normalized.slice(prefix.length);
  const hash = rest.split("/")[0] || "";
  return normalizeHash(hash) || "";
}

export function isManagedBlobPath(storedPath: string | undefined): boolean {
  return Boolean(extractManagedBlobHash(storedPath));
}

export async function persistAttachmentBlob(
  fileName: string,
  bytes: Uint8Array,
): Promise<{ storedPath: string; contentHash: string; sizeBytes: number }> {
  await ensureBlobTable();
  const contentHash = await computeSHA256Hex(bytes);
  const rows = (await Zotero.DB.queryAsync(
    `SELECT path
     FROM ${ATTACHMENT_BLOBS_TABLE}
     WHERE hash = ?
     LIMIT 1`,
    [contentHash],
  )) as Array<{ path?: unknown }> | undefined;
  const existingPath =
    typeof rows?.[0]?.path === "string" && rows[0].path.trim()
      ? rows[0].path.trim()
      : "";
  if (existingPath && (await pathExists(existingPath))) {
    return {
      storedPath: existingPath,
      contentHash,
      sizeBytes: bytes.byteLength,
    };
  }
  const fallbackName = sanitizeFileName(fileName || "") || `${contentHash}.bin`;
  const storedPath = existingPath || getBlobPath(contentHash, fallbackName);
  await ensureDir(getLocalParentPath(storedPath));
  await writeBytes(storedPath, bytes);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${ATTACHMENT_BLOBS_TABLE} (hash, path, size_bytes, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      contentHash,
      storedPath,
      Math.max(0, Math.floor(bytes.byteLength)),
      Date.now(),
    ],
  );
  return {
    storedPath,
    contentHash,
    sizeBytes: bytes.byteLength,
  };
}

export async function ensureAttachmentBlobFromPath(
  sourcePath: string,
  fileName: string,
): Promise<{ storedPath: string; contentHash: string }> {
  const normalizedSource = (sourcePath || "").trim();
  if (!normalizedSource) {
    throw new Error("Cannot import attachment from empty source path");
  }
  if (isManagedBlobPath(normalizedSource)) {
    const contentHash = extractManagedBlobHash(normalizedSource);
    if (contentHash) {
      await ensureBlobTable();
      await Zotero.DB.queryAsync(
        `INSERT OR REPLACE INTO ${ATTACHMENT_BLOBS_TABLE} (hash, path, size_bytes, created_at)
         VALUES (
           ?,
           ?,
           COALESCE((SELECT size_bytes FROM ${ATTACHMENT_BLOBS_TABLE} WHERE hash = ?), 0),
           COALESCE((SELECT created_at FROM ${ATTACHMENT_BLOBS_TABLE} WHERE hash = ?), ?)
         )`,
        [contentHash, normalizedSource, contentHash, contentHash, Date.now()],
      );
      return { storedPath: normalizedSource, contentHash };
    }
  }
  const bytes = await readBytes(normalizedSource);
  const persisted = await persistAttachmentBlob(fileName, bytes);
  return {
    storedPath: persisted.storedPath,
    contentHash: persisted.contentHash,
  };
}

export async function persistConversationAttachmentFile(
  conversationKey: number,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  const dirPath = getConversationDir(conversationKey);
  await ensureDir(dirPath);
  // Conversation uploads use stable path by filename so re-uploading the same
  // file name in the same chat overwrites instead of creating duplicates.
  const targetPath = getConversationAttachmentPath(conversationKey, fileName);
  await writeBytes(targetPath, bytes);
  return targetPath;
}

export async function copyAttachmentFileToNoteDir(
  noteId: number,
  sourcePath: string,
  fileName: string,
): Promise<string> {
  const dirPath = getNoteDir(noteId);
  await ensureDir(dirPath);
  const targetPath = await reserveUniquePath(dirPath, fileName);
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

export async function removeConversationAttachmentFiles(
  conversationKey: number,
): Promise<void> {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  await removePath(getConversationDir(Math.floor(conversationKey)), true);
}

export async function removeAttachmentFile(path: string): Promise<void> {
  const trimmed = (path || "").trim();
  if (!trimmed) return;
  await removePath(trimmed, false);
}

export { fileUrlToPath, toFileUrl };
