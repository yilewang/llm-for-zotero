import { CHAT_ATTACHMENTS_DIR_NAME } from "./constants";

type PathUtilsLike = {
  join?: (...parts: string[]) => string;
  parent?: (path: string) => string;
};

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
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

function getPathUtils(): PathUtilsLike | undefined {
  return (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
}

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function joinPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.join) {
    return pathUtils.join(...parts);
  }
  const normalized = parts
    .filter((part) => Boolean(part))
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter((part) => Boolean(part));
  return normalized.join("/");
}

function getParentPath(path: string): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.parent) return pathUtils.parent(path);
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index > 0 ? normalized.slice(0, index) : normalized;
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
      from: getParentPath(path),
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
    const candidatePath = joinPath(dirPath, candidate);
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
    attempt += 1;
  }
  const fallback = `${safeStem}-${Date.now()}${ext}`;
  return joinPath(dirPath, fallback);
}

function getConversationDir(conversationKey: number): string {
  const root = joinPath(getBaseWritableDir(), CHAT_ATTACHMENTS_DIR_NAME);
  return joinPath(root, "chats", String(conversationKey));
}

function getConversationAttachmentPath(
  conversationKey: number,
  fileName: string,
): string {
  const dirPath = getConversationDir(conversationKey);
  const safeName = sanitizeFileName(fileName);
  return joinPath(dirPath, safeName);
}

function getNoteDir(noteId: number): string {
  const root = joinPath(getBaseWritableDir(), CHAT_ATTACHMENTS_DIR_NAME);
  return joinPath(root, "notes", String(noteId));
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

export function toFileUrl(path: string | undefined): string | undefined {
  const raw = (path || "").trim();
  if (!raw) return undefined;
  if (/^file:\/\//i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return undefined;
}
