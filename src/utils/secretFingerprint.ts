import { fnv1a32Raw } from "./fnv1a";

/**
 * Stable, non-reversible fingerprint of a credential.
 *
 * Used to key caches and failure memories on "which credential is this"
 * without ever holding the credential itself somewhere it might be logged or
 * dumped. FNV-1a: not a security primitive, just a cheap stable digest.
 */
export function fingerprintSecret(secret: string): string {
  return fnv1a32Raw(secret).toString(16);
}
