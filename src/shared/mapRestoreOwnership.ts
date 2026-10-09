/**
 * Ownership of pending map-entry rollbacks. A same-value write is still a new
 * commit, so comparing the entry's value is not sufficient to detect it.
 * Callers must invalidate ownership before every write to a guarded entry.
 */
const ownersByMap = new WeakMap<object, Map<unknown, symbol>>();

export type MapRestoreClaim = {
  isCurrent: () => boolean;
  restorePrevious: () => boolean;
};

export function invalidateMapRestore(map: object, key: unknown): void {
  ownersByMap.get(map)?.delete(key);
}

export function clearMapRestores(map: object): void {
  ownersByMap.delete(map);
}

export function claimMapRestore(map: object, key: unknown): MapRestoreClaim {
  let owners = ownersByMap.get(map);
  if (!owners) {
    owners = new Map();
    ownersByMap.set(map, owners);
  }
  const previous = owners.get(key);
  const owner = Symbol("map-restore");
  owners.set(key, owner);
  return {
    isCurrent: () => ownersByMap.get(map)?.get(key) === owner,
    restorePrevious: () => {
      const current = ownersByMap.get(map);
      if (current?.get(key) !== owner) return false;
      if (previous) current.set(key, previous);
      else current.delete(key);
      return true;
    },
  };
}
