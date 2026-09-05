class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #source: Map<K, V>;

  constructor(source: Map<K, V>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number {
    return this.#source.size;
  }

  get(key: K): V | undefined {
    return this.#source.get(key);
  }

  has(key: K): boolean {
    return this.#source.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#source.entries();
  }

  keys(): MapIterator<K> {
    return this.#source.keys();
  }

  values(): MapIterator<V> {
    return this.#source.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#source.forEach((value, key) =>
      callbackfn.call(thisArg, value, key, this),
    );
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  cloneSource(): Map<K, V> {
    return new Map(this.#source);
  }
}

class ReadonlySetView<T> implements ReadonlySet<T> {
  readonly #source: Set<T>;

  constructor(source: Set<T>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number {
    return this.#source.size;
  }

  has(value: T): boolean {
    return this.#source.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#source.entries();
  }

  keys(): SetIterator<T> {
    return this.#source.keys();
  }

  values(): SetIterator<T> {
    return this.#source.values();
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    this.#source.forEach((value) =>
      callbackfn.call(thisArg, value, value, this),
    );
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  cloneSource(): Set<T> {
    return new Set(this.#source);
  }
}

export function readonlyMap<K, V>(
  source: ReadonlyMap<K, V>,
): ReadonlyMap<K, V> {
  return source instanceof ReadonlyMapView
    ? source
    : new ReadonlyMapView(source instanceof Map ? source : new Map(source));
}

export function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  return source instanceof ReadonlySetView
    ? source
    : new ReadonlySetView(source instanceof Set ? source : new Set(source));
}

export function patchMap<K, V>(
  base: ReadonlyMap<K, V>,
  updates: ReadonlyMap<K, V>,
  deleted: ReadonlySet<K> = new Set(),
): ReadonlyMap<K, V> {
  if (!updates.size && !deleted.size) return base;
  let changed = false;
  for (const key of deleted) {
    if (!updates.has(key) && base.has(key)) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    for (const [key, value] of updates) {
      if (!base.has(key) || base.get(key) !== value) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return base;
  const next =
    base instanceof ReadonlyMapView ? base.cloneSource() : new Map(base);
  for (const key of deleted) {
    if (!updates.has(key)) next.delete(key);
  }
  for (const [key, value] of updates) next.set(key, value);
  return new ReadonlyMapView(next);
}

export function patchSet<T>(
  base: ReadonlySet<T>,
  added: ReadonlySet<T>,
  deleted: ReadonlySet<T>,
): ReadonlySet<T> {
  if (!added.size && !deleted.size) return base;
  let changed = false;
  for (const value of deleted) {
    if (!added.has(value) && base.has(value)) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    for (const value of added) {
      if (!base.has(value)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return base;
  const next =
    base instanceof ReadonlySetView ? base.cloneSource() : new Set(base);
  for (const value of deleted) {
    if (!added.has(value)) next.delete(value);
  }
  for (const value of added) next.add(value);
  return new ReadonlySetView(next);
}
