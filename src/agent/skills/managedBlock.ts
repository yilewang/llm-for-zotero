/**
 * MANAGED-block markers for skill files.
 *
 * Content between the BEGIN and END markers is plugin-owned and refreshed
 * on upgrade. Content outside the markers is user-owned and preserved.
 *
 * Kept in a standalone module (no `.md` imports) so the helpers can be
 * unit-tested without pulling in the build-time skill bundle.
 */

export const MANAGED_BEGIN_MARKER = "<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->";
export const MANAGED_END_MARKER = "<!-- LLM-FOR-ZOTERO:MANAGED-END -->";

/**
 * Extract the managed block from a skill file's raw content.
 *
 * Returns the content between MANAGED-BEGIN and MANAGED-END markers, or null
 * if markers are missing or malformed. `before` and `after` capture
 * user-owned content outside the markers (preserved on upgrade).
 */
export function extractManagedBlock(raw: string): {
  block: string | null;
  before: string;
  after: string;
} {
  const beginIdx = raw.indexOf(MANAGED_BEGIN_MARKER);
  const endIdx = raw.indexOf(MANAGED_END_MARKER);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) {
    return { block: null, before: raw, after: "" };
  }
  const blockStart = beginIdx + MANAGED_BEGIN_MARKER.length;
  const blockEnd = endIdx;
  const before = raw.slice(0, beginIdx);
  const block = raw.slice(blockStart, blockEnd);
  const after = raw.slice(endIdx + MANAGED_END_MARKER.length);
  return { block, before, after };
}

/**
 * Splice a new managed block into an on-disk file, preserving user content
 * outside the markers. If the on-disk file has no markers, returns null
 * (caller decides whether to flag as outdated-format or full-overwrite).
 */
export function spliceManagedBlock(
  onDiskRaw: string,
  newBlock: string,
): string | null {
  const { block, before, after } = extractManagedBlock(onDiskRaw);
  if (block === null) return null;
  return before + MANAGED_BEGIN_MARKER + newBlock + MANAGED_END_MARKER + after;
}

/** Simple djb2 hash — fast, good distribution, not crypto. */
export function hashBody(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Compute the hash used to decide whether a skill needs upgrading.
 *
 * - If the raw content has MANAGED markers: hash only the managed block.
 *   This lets us detect plugin-owned content drift while ignoring user
 *   edits outside the markers.
 * - Otherwise (legacy, no markers): hash the provided `fallbackBody` —
 *   typically `parseSkill(raw).instruction`, i.e. body without frontmatter.
 *   Frontmatter is deliberately excluded: `description` and `version` are
 *   plugin-managed (rewritten by `patchSkillFrontmatter` on upgrade), while
 *   `match:` and user-added keys are preserved by the same patcher regardless
 *   of hash outcome. So frontmatter-only edits neither block auto-upgrade
 *   nor get silently lost.
 */
export function hashSkillForUpgrade(raw: string, fallbackBody: string): string {
  const { block } = extractManagedBlock(raw);
  if (block !== null) return hashBody(block);
  return hashBody(fallbackBody);
}
