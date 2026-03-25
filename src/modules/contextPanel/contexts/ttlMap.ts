/**
 * A Map wrapper with time-to-live (TTL) eviction.
 * Entries expire after `ttlMs` milliseconds from when they were set.
 * Expired entries are lazily pruned on access and periodically via `prune()`.
 */
export class TTLMap<K, V> {
  private readonly data = new Map<K, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): this {
    this.data.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.data.size > this.maxEntries) {
      this.prune();
    }
    return this;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.data.delete(key);
  }

  /** Remove all expired entries. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (now > entry.expiresAt) {
        this.data.delete(key);
      }
    }
    // If still over max, evict oldest entries
    if (this.data.size > this.maxEntries) {
      const sorted = Array.from(this.data.entries()).sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      );
      const toRemove = sorted.slice(0, this.data.size - this.maxEntries);
      for (const [key] of toRemove) {
        this.data.delete(key);
      }
    }
  }

  get size(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }
}
