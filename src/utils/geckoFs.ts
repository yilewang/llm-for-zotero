/**
 * Shared Gecko file-system helpers: IOUtils first, OS.File as the fallback.
 *
 * The getters read the globals on every call and never cache them, because
 * unit tests swap `globalThis.IOUtils` and `globalThis.OS` per test, often
 * with partial stubs. Every helper therefore probes each method before use.
 *
 * Only the copies that behaved identically were moved here. Modules whose
 * helpers differ (throwing readers, fall-through readers, other coercions,
 * other error handling) keep their own private versions.
 */

import { getLocalParentPath } from "./localPath";

export type GeckoIOUtils = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
  copy?: (sourcePath: string, destPath: string) => Promise<void>;
  stat?: (path: string) => Promise<{ size?: number; type?: string }>;
  setPermissions?: (path: string, permissions: number) => Promise<void>;
};

export type GeckoOSFile = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  writeAtomic?: (
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
  removeDir?: (
    path: string,
    options?: { ignoreAbsent?: boolean; ignorePermissions?: boolean },
  ) => Promise<void>;
  copy?: (sourcePath: string, destPath: string) => Promise<void>;
  setPermissions?: (
    path: string,
    options: { unixMode?: number },
  ) => Promise<void>;
};

/** Reads `globalThis.IOUtils` on every call. */
export function getIOUtils(): GeckoIOUtils | undefined {
  return (globalThis as unknown as { IOUtils?: GeckoIOUtils }).IOUtils;
}

/** Reads `globalThis.OS.File` on every call. */
export function getOSFile(): GeckoOSFile | undefined {
  return (globalThis as { OS?: { File?: GeckoOSFile } }).OS?.File;
}

/** True when the path exists; false on any API error or when no API exists. */
export async function pathExists(path: string): Promise<boolean> {
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

/**
 * Reads a file as bytes. Returns null on a read error or when no API exists.
 * An IOUtils error does not fall through to OS.File.
 */
export async function readFileBytes(path: string): Promise<Uint8Array | null> {
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

/**
 * Writes bytes to a file. Write errors propagate.
 * Returns false, without writing, when no API exists.
 */
export async function writeFileBytes(
  path: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return true;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
    return true;
  }
  return false;
}

/**
 * Creates a directory and its ancestors. Errors propagate.
 * The OS.File fallback passes no `from` option.
 * Returns false when no API exists.
 */
export async function ensureDir(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return true;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, { ignoreExisting: true });
    return true;
  }
  return false;
}

/**
 * Creates a directory and its ancestors. Errors propagate.
 * The OS.File fallback creates the path from its parent directory.
 * Returns false when no API exists, so callers can raise their own error.
 */
export async function ensureDirFromParent(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return true;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, {
      from: getLocalParentPath(path),
      ignoreExisting: true,
    });
    return true;
  }
  return false;
}

/**
 * Removes a file or directory tree. Ignores every error and a missing path.
 * OS.File uses `removeDir` when present, else `remove`.
 */
export async function removePathQuietly(path: string): Promise<void> {
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
