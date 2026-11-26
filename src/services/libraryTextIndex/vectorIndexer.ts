/**
 * Opt-in vector stage of the library text index.
 *
 * Embeds the chunks of an indexed document into the current embedding
 * namespace (`{embedding cacheKey}:{dims}`), writes one int8 shard per
 * document, and keeps an in-memory `LibraryVectorMatrix` per namespace for the
 * hybrid search. The dimension count is unknown until the first embedding
 * call, so the namespace reads `{cacheKey}:auto` until then; the first
 * successful embed records `vector_dims:{cacheKey}` in `index_meta` and every
 * later call resolves to the concrete namespace.
 *
 * Gated by the hidden `libraryTextIndexVectors` pref (default off) and by
 * semantic search being enabled with a resolvable embedding provider.
 */
import { config } from "../../../package.json";
import { appLogger } from "../../core/logging";
import {
  callEmbeddings,
  getResolvedEmbeddingConfig,
  resolveSemanticSearchState,
} from "../../utils/llmClient";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_BATCH_TIMEOUT_MS,
} from "../retrieval/constants";
import { EMBEDDING_CONCURRENCY } from "./constants";
import type { LibraryTextIndexStore } from "./store";
import {
  getVectorShardPath,
  LibraryVectorMatrix,
  quantizeVector,
  removeVectorNamespace,
  vectorNamespace,
  writeVectorShard,
} from "./vectorStore";

export type EmbedTexts = (texts: string[]) => Promise<number[][]>;
export type EmbedDocumentVectorsResult = {
  status: "embedded" | "unchanged" | "skipped";
  chunkCount: number;
  dims: number;
  /** The namespace the vectors live in (an `:auto` input resolves here). */
  namespace: string;
};

const VECTORS_PREF = `${config.prefsPrefix}.libraryTextIndexVectors`;
const DIMS_META_PREFIX = "vector_dims:";
const AUTO_SUFFIX = ":auto";

const matrices = new Map<string, LibraryVectorMatrix>();
const loading = new Map<string, Promise<LibraryVectorMatrix | null>>();
/** Embedding dimensions per cache key, hydrated from index_meta. */
const knownDims = new Map<string, number>();
const hydratedStores = new WeakSet<LibraryTextIndexStore>();
let pruneFailureLogged = false;

export function isVectorsPrefOn(): boolean {
  const value = (
    globalThis as {
      Zotero?: { Prefs?: { get?: (key: string, global?: boolean) => unknown } };
    }
  ).Zotero?.Prefs?.get?.(VECTORS_PREF, true);
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/** Null when the vectors pref or semantic search is off. */
export function currentVectorNamespace(): {
  namespace: string;
  dims: number | null;
} | null {
  if (!isVectorsPrefOn()) return null;
  try {
    if (!resolveSemanticSearchState().enabled) return null;
    const { cacheKey } = getResolvedEmbeddingConfig();
    const dims = knownDims.get(cacheKey);
    return dims
      ? { namespace: vectorNamespace(cacheKey, dims), dims }
      : { namespace: `${cacheKey}${AUTO_SUFFIX}`, dims: null };
  } catch {
    return null;
  }
}

/**
 * Loads the recorded embedding dimensions once per store, so
 * `currentVectorNamespace` names the concrete namespace after a restart.
 * Must run before an `:auto` namespace is used to prune others.
 */
export async function loadVectorDims(
  store: LibraryTextIndexStore,
): Promise<void> {
  if (hydratedStores.has(store)) return;
  for (const [key, value] of await store.listIndexMeta(DIMS_META_PREFIX)) {
    const dims = Number(value);
    if (Number.isInteger(dims) && dims > 0)
      knownDims.set(key.slice(DIMS_META_PREFIX.length), dims);
  }
  hydratedStores.add(store);
}

function namespaceDims(namespace: string): number | null {
  const dims = Number(namespace.slice(namespace.lastIndexOf(":") + 1));
  return Number.isInteger(dims) && dims > 0 ? dims : null;
}

async function embedBounded(
  texts: string[],
  embed: EmbedTexts,
): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE)
    batches.push(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
  const out: number[][][] = new Array(batches.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const i = next++;
      try {
        out[i] = await embed(batches[i]);
      } catch (error) {
        failed = true; // stop the other workers taking new batches
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(EMBEDDING_CONCURRENCY, batches.length) },
      worker,
    ),
  );
  return out.flat();
}

const defaultEmbed: EmbedTexts = (texts) =>
  callEmbeddings(texts, { timeoutMs: EMBEDDING_BATCH_TIMEOUT_MS });

export async function embedDocumentVectors(params: {
  store: LibraryTextIndexStore;
  attachmentId: number;
  namespace: string;
  embed?: EmbedTexts;
  matrix?: LibraryVectorMatrix;
}): Promise<EmbedDocumentVectorsResult> {
  const { store, attachmentId } = params;
  const embed = params.embed || defaultEmbed;
  let namespace = params.namespace;
  const autoCacheKey = namespace.endsWith(AUTO_SUFFIX)
    ? namespace.slice(0, -AUTO_SUFFIX.length)
    : null;
  if (autoCacheKey !== null) {
    const recorded = Number(
      await store.getIndexMeta(`${DIMS_META_PREFIX}${autoCacheKey}`),
    );
    if (Number.isInteger(recorded) && recorded > 0) {
      knownDims.set(autoCacheKey, recorded);
      namespace = vectorNamespace(autoCacheKey, recorded);
    }
  }
  const doc = await store.getDocument(attachmentId);
  if (!doc || !doc.chunkCount)
    return { status: "skipped", chunkCount: 0, dims: 0, namespace };
  if (!namespace.endsWith(AUTO_SUFFIX)) {
    const existing = await store.getVectorDocument(attachmentId, namespace);
    if (existing && existing.sourceFingerprint === doc.sourceFingerprint)
      return {
        status: "unchanged",
        chunkCount: existing.chunkCount,
        dims: existing.dims,
        namespace,
      };
  }
  const chunks = await store.getChunksForDocument(attachmentId);
  if (!chunks.length)
    return { status: "skipped", chunkCount: 0, dims: 0, namespace };
  const raw = await embedBounded(
    chunks.map((c) => c.text),
    embed,
  );
  if (raw.length !== chunks.length || !raw[0]?.length)
    throw new Error(
      `Embedding returned ${raw.length} vectors for ${chunks.length} chunks`,
    );
  const dims = raw[0].length;
  if (namespace.endsWith(AUTO_SUFFIX) && autoCacheKey !== null) {
    // Record the dimensions before any row exists under the concrete
    // namespace, so an `:auto` prune can never delete this provider's vectors.
    await store.setIndexMeta(`${DIMS_META_PREFIX}${autoCacheKey}`, `${dims}`);
    knownDims.set(autoCacheKey, dims);
    namespace = vectorNamespace(autoCacheKey, dims);
  }
  const expected = namespaceDims(namespace);
  if (expected !== null && expected !== dims)
    throw new Error(
      `Embedding returned ${dims} dimensions; namespace ${namespace} expects ${expected}`,
    );
  const vectors = raw.map(quantizeVector); // writeVectorShard rejects ragged vectors
  const { path } = await writeVectorShard(
    namespace,
    attachmentId,
    vectors,
    dims,
  );
  await store.upsertVectorDocument({
    attachmentId,
    namespace,
    dims,
    chunkCount: vectors.length,
    path,
    sourceFingerprint: doc.sourceFingerprint,
  });
  const matrix = params.matrix || matrices.get(namespace);
  if (matrix && matrix.dims === dims) matrix.addDocument(attachmentId, vectors);
  return { status: "embedded", chunkCount: vectors.length, dims, namespace };
}

/**
 * Removes the shard directories, rows and loaded matrices of every namespace
 * other than `keep`. A namespace's rows go only after its directory is gone,
 * so a failed removal (file lock, permissions) is retried at the next
 * reconcile instead of orphaning the directory. Never throws for a failed
 * directory; returns the namespaces actually removed.
 */
export async function pruneVectorNamespaces(
  store: LibraryTextIndexStore,
  keep: string,
): Promise<string[]> {
  const stale = (await store.listVectorNamespaces()).filter(
    (namespace) => namespace !== keep,
  );
  const removed: string[] = [];
  for (const namespace of stale) {
    matrices.delete(namespace);
    try {
      await removeVectorNamespace(namespace);
    } catch (error) {
      if (!pruneFailureLogged) {
        pruneFailureLogged = true;
        appLogger.warn(
          `LLM index: could not remove vector namespace files; will retry at the next start`,
          error,
        );
      }
      continue;
    }
    await store.deleteVectorNamespace(namespace);
    removed.push(namespace);
  }
  return removed;
}

type IOLike = {
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
};
type OSFileRemoveLike = {
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
};

async function removeShardFile(path: string): Promise<void> {
  const io = (globalThis as { IOUtils?: IOLike }).IOUtils;
  if (io?.remove) return io.remove(path, { ignoreAbsent: true });
  const osFile = (globalThis as { OS?: { File?: OSFileRemoveLike } }).OS?.File;
  if (osFile?.remove) return osFile.remove(path, { ignoreAbsent: true });
}

/**
 * Best-effort cleanup after documents left the index: removes their shard
 * files and their rows in the loaded matrices. The `vector_documents` rows
 * must already be deleted (read them before deleting the documents). The
 * file removed is the one derived from namespace + attachment id, never the
 * row's stored path, so a corrupted row cannot delete a file elsewhere.
 */
export async function removeDocumentVectors(
  rows: Array<{ attachmentId: number; namespace: string; path: string }>,
): Promise<void> {
  for (const row of rows) {
    matrices.get(row.namespace)?.removeDocument(row.attachmentId);
    let path = "";
    try {
      path = getVectorShardPath(row.namespace, row.attachmentId);
      await removeShardFile(path);
    } catch (error) {
      appLogger.debug(
        `LLM index: could not remove vector shard ${path || row.attachmentId}`,
        error,
      );
    }
  }
}

/**
 * Forgets every loaded matrix and recorded dimension count, for when the
 * index files are deleted underneath them (clear/rebuild).
 */
export function clearLoadedVectorState(): void {
  matrices.clear();
  loading.clear();
  knownDims.clear();
}
