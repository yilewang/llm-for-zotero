/**
 * Stable, non-reversible fingerprint of a credential.
 *
 * Used to key caches and failure memories on "which credential is this"
 * without ever holding the credential itself somewhere it might be logged or
 * dumped. FNV-1a: not a security primitive, just a cheap stable digest.
 */
export function fingerprintSecret(secret: string): string {
  let hash = 2166136261;
  for (let i = 0; i < secret.length; i += 1) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
