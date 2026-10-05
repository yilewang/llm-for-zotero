/**
 * FNV-1a, 32-bit, over UTF-16 code units: the unsigned 32-bit value. Callers
 * that store or compare a digest format it themselves (hex, base36, prefixed),
 * and that format is part of the stored value, so keep it as it is.
 */
export function fnv1a32Raw(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * FNV-1a, 32-bit: a short, stable digest of a string. It is a fingerprint for
 * cache keys and change detection, never a security hash.
 *
 * Returns eight lowercase hex characters, so a key built from it stays bounded
 * no matter how long the input is.
 */
export function fnv1a32(text: string): string {
  return fnv1a32Raw(text).toString(16).padStart(8, "0");
}
