const MINERU_CACHE_DIR_NAME = "llm-for-zotero-mineru";

export type MineruCacheFile = {
  relativePath: string;
  data: Uint8Array;
};

type PathUtilsLike = {
  join?: (...parts: string[]) => string;
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
  if (pathUtils?.join) return pathUtils.join(...parts);
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join("/");
}

function getParentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index > 0 ? normalized.slice(0, index) : normalized;
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
  return joinPath(getBaseDir(), MINERU_CACHE_DIR_NAME);
}

export function getMineruItemDir(id: number): string {
  return joinPath(getMineruCacheDir(), String(id));
}

// The md content is stored at a well-known path for quick access
function getMineruMdPath(id: number): string {
  return joinPath(getMineruItemDir(id), "_content.md");
}

// Legacy path (pre-directory cache)
function getLegacyMdPath(id: number): string {
  return joinPath(getMineruCacheDir(), `${id}.md`);
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

async function writeFileBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function hasCachedMineruMd(id: number): Promise<boolean> {
  if (await pathExists(getMineruMdPath(id))) return true;
  // Check legacy single-file cache
  return pathExists(getLegacyMdPath(id));
}

export async function readCachedMineruMd(
  id: number,
): Promise<string | null> {
  // Try new directory-based cache
  const bytes = await readFileBytes(getMineruMdPath(id));
  if (bytes) return new TextDecoder("utf-8").decode(bytes);
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

  // Write all extracted files from ZIP, skipping PDFs (the original
  // PDF is included in the MinerU ZIP but we already have it in Zotero)
  for (const file of files) {
    if (/\.pdf$/i.test(file.relativePath)) continue;
    // Split relative path into individual components so PathUtils.join
    // doesn't reject segments containing '/'.
    const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
    const filePath = joinPath(itemDir, ...parts);
    const parentDir = getParentPath(filePath);
    if (parentDir !== itemDir) {
      await ensureDir(parentDir);
    }
    await writeFileBytes(filePath, file.data);
  }

  // Write md content at a well-known path for quick cache reads
  await writeFileBytes(
    getMineruMdPath(id),
    new TextEncoder().encode(mdContent),
  );

  // Clean up legacy single-file cache if it exists
  const legacyPath = getLegacyMdPath(id);
  if (await pathExists(legacyPath)) {
    await removePath(legacyPath);
  }
}

export async function invalidateMineruMd(id: number): Promise<void> {
  // Remove the directory-based cache
  await removePath(getMineruItemDir(id));
  // Also remove legacy single-file cache
  await removePath(getLegacyMdPath(id));
}
