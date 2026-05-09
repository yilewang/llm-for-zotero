/**
 * Persistent disk cache for paper chunk embeddings.
 *
 * Stores one JSON file per paper in `{dataDir}/llm-for-zotero-embeddings/`.
 * Uses the same Gecko I/O pattern as mineruCache.ts (IOUtils → OS.File fallback).
 *
 * Cache invalidation:
 *  - chunk content changes (chunkHash mismatch)
 *  - embedding model changes (model mismatch)
 *  - MinerU cache invalidation (cascade via clearEmbeddingCache)
 */

import { joinLocalPath } from "../../utils/localPath";

const EMBEDDING_CACHE_DIR = "llm-for-zotero-embeddings";
const CACHE_VERSION = 2; // v2: added provider field for cross-provider cache isolation

// ── Gecko I/O helpers (mirrors mineruCache.ts) ──────────────────────────────

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
  throw new Error("Cannot resolve data directory for embedding cache");
}

function getCacheDir(): string {
  return joinLocalPath(getBaseDir(), EMBEDDING_CACHE_DIR);
}

function getCachePath(itemId: number): string {
  return joinLocalPath(getCacheDir(), `${itemId}.json`);
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

// ── Chunk hashing ───────────────────────────────────────────────────────────

/**
 * Compute a simple numeric hash of chunk texts for cache invalidation.
 * Uses a fast FNV-1a-like hash — not cryptographic, but sufficient for
 * detecting content changes.
 */
export function computeChunkHash(chunks: string[]): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      hash ^= chunk.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    // separator between chunks
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Cache format ────────────────────────────────────────────────────────────

type EmbeddingCacheEntry = {
  version: number;
  model: string;
  chunkHash: string;
  /** Embedding provider identifier (e.g. "openai", "gemini", "main:openai") */
  provider: string;
  dimensions: number;
  count: number;
  embeddings: number[][];
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Attempt to load cached embeddings from disk.
 * Returns null on any mismatch (model, chunkHash, provider, version) or I/O error.
 */
export async function loadCachedEmbeddings(
  itemId: number,
  chunkHash: string,
  model: string,
  provider: string,
): Promise<number[][] | null> {
  try {
    const bytes = await readFileBytes(getCachePath(itemId));
    if (!bytes) return null;

    const text = new TextDecoder().decode(bytes);
    const entry: EmbeddingCacheEntry = JSON.parse(text);

    if (entry.version !== CACHE_VERSION) return null;
    if (entry.model !== model) return null;
    if (entry.chunkHash !== chunkHash) return null;
    if (entry.provider !== provider) return null;
    if (
      !Array.isArray(entry.embeddings) ||
      entry.embeddings.length !== entry.count
    )
      return null;

    return entry.embeddings;
  } catch {
    return null;
  }
}

/**
 * Persist embeddings to disk.  Fire-and-forget — callers should not await
 * this in the critical path.
 */
export async function saveCachedEmbeddings(
  itemId: number,
  chunkHash: string,
  model: string,
  provider: string,
  dimensions: number,
  embeddings: number[][],
): Promise<void> {
  try {
    await ensureDir(getCacheDir());

    const entry: EmbeddingCacheEntry = {
      version: CACHE_VERSION,
      model,
      chunkHash,
      provider,
      dimensions,
      count: embeddings.length,
      embeddings,
    };

    const json = JSON.stringify(entry);
    await writeFileBytes(getCachePath(itemId), new TextEncoder().encode(json));
  } catch (err) {
    ztoolkit.log("Failed to save embedding cache:", err);
  }
}

/**
 * Clear cached embeddings.
 * @param itemId  If provided, clear only that item. Otherwise clear all.
 */
export async function clearEmbeddingCache(itemId?: number): Promise<void> {
  if (itemId != null) {
    await removePath(getCachePath(itemId));
  } else {
    await removePath(getCacheDir());
  }
}
