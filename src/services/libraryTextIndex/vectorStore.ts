/**
 * Vector layer storage for the library text index.
 *
 * Chunk embeddings are unit-normalized and quantized to int8 with one float32
 * scale per vector, then stored as one shard file per attachment under
 * `{dataDir}/llm-for-zotero-index/vectors/{namespaceHash}/{attachmentId}.bin`.
 * The namespace is the embedding cache key plus the dimension count, so a
 * provider or model change never mixes incompatible vectors.
 *
 * Shard layout (little-endian): 8-byte magic `LFZVEC01`, uint32 dims,
 * uint32 count, `count` float32 scales, then `count * dims` int8 values.
 *
 * `LibraryVectorMatrix` holds the loaded shards as one contiguous int8 matrix
 * for a brute-force scoped dot-product search.
 */

import { fnv1a32 } from "../../utils/fnv1a";
import {
  ensureDir,
  getIOUtils,
  getOSFile,
  readFileBytes,
  writeFileBytes,
} from "../../utils/geckoFs";
import { joinLocalPath } from "../../utils/localPath";

export type QuantizedVector = { q: Int8Array; scale: number };

export type VectorSearchHit = {
  attachmentId: number;
  chunkIndex: number;
  score: number;
};

const MAGIC = new TextEncoder().encode("LFZVEC01");
const HEADER_BYTES = 16;
const VECTOR_DIR = "llm-for-zotero-index";

// ── Quantization ─────────────────────────────────────────────────────────────

export function quantizeVector(vector: number[]): QuantizedVector {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  let max = 0;
  const unit = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    unit[i] = vector[i] / norm;
    max = Math.max(max, Math.abs(unit[i]));
  }
  const scale = max / 127 || 1;
  const q = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    q[i] = Math.max(-127, Math.min(127, Math.round(unit[i] / scale)));
  }
  return { q, scale };
}

/** Dot product of two quantized unit vectors; approximates their cosine. */
export function dotQuantized(a: QuantizedVector, b: QuantizedVector): number {
  let sum = 0;
  const n = Math.min(a.q.length, b.q.length);
  for (let i = 0; i < n; i += 1) sum += a.q[i] * b.q[i];
  return sum * a.scale * b.scale;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function vectorNamespace(cacheKey: string, dims: number): string {
  return `${cacheKey}:${dims}`;
}

export function namespaceHash(namespace: string): string {
  return fnv1a32(namespace);
}

function getBaseDir(): string {
  // Same resolution as getLibraryTextIndexDbPath: the vectors directory sits
  // next to the index database in the Zotero data directory.
  const dir = (globalThis as { Zotero?: { DataDirectory?: { dir?: string } } })
    .Zotero?.DataDirectory?.dir;
  if (typeof dir !== "string" || !dir.trim()) {
    throw new Error("Cannot resolve data directory for vector shards");
  }
  return dir.trim();
}

function getNamespaceDir(namespace: string): string {
  return joinLocalPath(
    getBaseDir(),
    VECTOR_DIR,
    "vectors",
    namespaceHash(namespace),
  );
}

export function getVectorShardPath(
  namespace: string,
  attachmentId: number,
): string {
  return joinLocalPath(getNamespaceDir(namespace), `${attachmentId}.bin`);
}

// ── Gecko I/O helpers ────────────────────────────────────────────────────────

// Unlike the shared `pathExists`, this one lets API errors propagate.
async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) return io.exists(path);
  const osFile = getOSFile();
  if (osFile?.exists) return osFile.exists(path);
  return false;
}

// ── Shard files ──────────────────────────────────────────────────────────────

export async function writeVectorShard(
  namespace: string,
  attachmentId: number,
  vectors: QuantizedVector[],
  dims: number,
): Promise<{ path: string; bytes: number }> {
  const count = vectors.length;
  const bytes = new Uint8Array(HEADER_BYTES + count * 4 + count * dims);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(8, dims, true);
  view.setUint32(12, count, true);
  let offset = HEADER_BYTES;
  for (const v of vectors) {
    view.setFloat32(offset, v.scale, true);
    offset += 4;
  }
  for (const v of vectors) {
    if (v.q.length !== dims) {
      throw new Error(
        `Vector has ${v.q.length} dimensions; the shard expects ${dims}`,
      );
    }
    bytes.set(new Uint8Array(v.q.buffer, v.q.byteOffset, dims), offset);
    offset += dims;
  }
  const path = getVectorShardPath(namespace, attachmentId);
  await ensureDir(getNamespaceDir(namespace));
  await writeFileBytes(path, bytes);
  return { path, bytes: bytes.length };
}

/** Reads a shard; returns null when it is missing, corrupt or truncated. */
export async function readVectorShard(
  path: string,
): Promise<{ dims: number; vectors: QuantizedVector[] } | null> {
  const bytes = await readFileBytes(path);
  if (!bytes || bytes.length < HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (bytes.length !== HEADER_BYTES + count * 4 + count * dims) return null;
  const vectors: QuantizedVector[] = [];
  let scaleOffset = HEADER_BYTES;
  let dataOffset = HEADER_BYTES + count * 4;
  for (let i = 0; i < count; i += 1) {
    const scale = view.getFloat32(scaleOffset, true);
    scaleOffset += 4;
    vectors.push({
      q: new Int8Array(bytes.slice(dataOffset, dataOffset + dims).buffer),
      scale,
    });
    dataOffset += dims;
  }
  return { dims, vectors };
}

export async function removeVectorNamespace(namespace: string): Promise<void> {
  const dir = getNamespaceDir(namespace);
  const io = getIOUtils();
  if (io?.remove) {
    await io.remove(dir, { recursive: true, ignoreAbsent: true });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    await osFile.removeDir(dir, { ignoreAbsent: true });
  }
}

/** Removes every namespace: the whole `{dataDir}/llm-for-zotero-index/vectors` directory. */
export async function removeAllVectorNamespaces(): Promise<void> {
  const dir = joinLocalPath(getBaseDir(), VECTOR_DIR, "vectors");
  const io = getIOUtils();
  if (io?.remove) {
    await io.remove(dir, { recursive: true, ignoreAbsent: true });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    await osFile.removeDir(dir, { ignoreAbsent: true });
  }
}

/** Total bytes of the shard files in one namespace directory. */
export async function measureVectorBytes(namespace: string): Promise<number> {
  const io = getIOUtils();
  if (!io?.getChildren) return 0;
  const dir = getNamespaceDir(namespace);
  if (!(await pathExists(dir))) return 0;
  let total = 0;
  for (const child of await io.getChildren(dir)) {
    if (io.stat) {
      total += Number((await io.stat(child)).size || 0);
    } else {
      total += (await readFileBytes(child))?.length ?? 0;
    }
  }
  return total;
}

// ── In-memory matrix ─────────────────────────────────────────────────────────

export type VectorMatrixEntry = {
  attachmentId: number;
  chunkCount: number;
  vectors: QuantizedVector[];
};

const MIN_MATRIX_CAPACITY_ROWS = 64;

/**
 * Contiguous int8 matrix of chunk vectors with a brute-force scoped search.
 *
 * Backing arrays carry spare capacity and grow by doubling, so appending rows
 * one document at a time is amortized O(1) per row. `addDocuments` sizes the
 * arrays once for a bulk load.
 */
export class LibraryVectorMatrix {
  private data = new Int8Array(0);
  private scales = new Float32Array(0);
  private capacity = 0; // rows the backing arrays can hold
  private owner: number[] = []; // attachmentId per row
  private chunk: number[] = []; // chunkIndex per row
  private rowsByDoc = new Map<number, number>(); // attachmentId -> row count
  private reallocations = 0;

  constructor(readonly dims: number) {}

  get rows(): number {
    return this.owner.length;
  }

  /** Test-only: how many times the backing arrays have been reallocated. */
  get reallocationCount(): number {
    return this.reallocations;
  }

  has(attachmentId: number): boolean {
    return this.rowsByDoc.has(attachmentId);
  }

  /** Rows map to (attachmentId, chunkIndex = position in `vectors`). */
  addDocument(attachmentId: number, vectors: QuantizedVector[]): void {
    this.addDocuments([{ attachmentId, chunkCount: vectors.length, vectors }]);
  }

  /**
   * Adds many documents with one capacity check. Equivalent to calling
   * `addDocument` for each entry in order: an id already present (or repeated
   * later in `entries`) is replaced by its last occurrence.
   */
  addDocuments(entries: VectorMatrixEntry[]): void {
    const latest = new Map<number, VectorMatrixEntry>();
    for (const entry of entries) {
      if (entry.chunkCount !== entry.vectors.length) {
        throw new Error(
          `Attachment ${entry.attachmentId} declares ${entry.chunkCount} chunks but has ${entry.vectors.length} vectors`,
        );
      }
      for (const v of entry.vectors) this.assertDims(v);
      latest.delete(entry.attachmentId);
      latest.set(entry.attachmentId, entry);
    }
    if (!latest.size) return;
    const replaced = new Set<number>();
    for (const id of latest.keys()) if (this.has(id)) replaced.add(id);
    if (replaced.size) this.compactWithout(replaced);
    let added = 0;
    for (const entry of latest.values()) added += entry.vectors.length;
    this.ensureCapacity(this.rows + added);
    for (const entry of latest.values()) {
      entry.vectors.forEach((v, i) => {
        const row = this.rows;
        this.data.set(v.q, row * this.dims);
        this.scales[row] = v.scale;
        this.owner.push(entry.attachmentId);
        this.chunk.push(i);
      });
      this.rowsByDoc.set(entry.attachmentId, entry.vectors.length);
    }
  }

  /** O(rows); runs on deletes and re-indexes only, never on the query path. */
  removeDocument(attachmentId: number): void {
    if (!this.has(attachmentId)) return;
    this.compactWithout(new Set([attachmentId]));
  }

  search(
    query: QuantizedVector,
    scope: ReadonlySet<number>,
    topK: number,
  ): VectorSearchHit[] {
    const hits: VectorSearchHit[] = [];
    const n = Math.min(this.dims, query.q.length);
    for (let r = 0; r < this.rows; r += 1) {
      if (!scope.has(this.owner[r])) continue;
      let sum = 0;
      const base = r * this.dims;
      for (let i = 0; i < n; i += 1) sum += this.data[base + i] * query.q[i];
      hits.push({
        attachmentId: this.owner[r],
        chunkIndex: this.chunk[r],
        score: sum * this.scales[r] * query.scale,
      });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.attachmentId - b.attachmentId ||
        a.chunkIndex - b.chunkIndex,
    );
    return hits.slice(0, Math.max(1, topK));
  }

  private assertDims(v: QuantizedVector): void {
    if (v.q.length !== this.dims) {
      throw new Error(
        `Vector has ${v.q.length} dimensions; the matrix expects ${this.dims}`,
      );
    }
  }

  private ensureCapacity(neededRows: number): void {
    if (neededRows <= this.capacity) return;
    const capacity = Math.max(
      neededRows,
      this.capacity * 2,
      MIN_MATRIX_CAPACITY_ROWS,
    );
    const data = new Int8Array(capacity * this.dims);
    data.set(this.data.subarray(0, this.rows * this.dims), 0);
    const scales = new Float32Array(capacity);
    scales.set(this.scales.subarray(0, this.rows), 0);
    this.data = data;
    this.scales = scales;
    this.capacity = capacity;
    this.reallocations += 1;
  }

  /** Drops the rows of `ids` in place, keeping capacity and row order. */
  private compactWithout(ids: ReadonlySet<number>): void {
    let write = 0;
    for (let read = 0; read < this.rows; read += 1) {
      const id = this.owner[read];
      if (ids.has(id)) continue;
      if (write !== read) {
        this.data.copyWithin(
          write * this.dims,
          read * this.dims,
          (read + 1) * this.dims,
        );
        this.scales[write] = this.scales[read];
        this.owner[write] = id;
        this.chunk[write] = this.chunk[read];
      }
      write += 1;
    }
    this.owner.length = write;
    this.chunk.length = write;
    for (const id of ids) this.rowsByDoc.delete(id);
  }
}
