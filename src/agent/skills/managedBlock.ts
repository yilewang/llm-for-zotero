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

/**
 * Prompt banner for skills that carry user customizations outside the managed
 * block. When a shipped baseline is available, this detects changes on both
 * sides of the managed section. Without a baseline it retains after-block
 * detection for existing callers.
 *
 * User customizations are the user's own preferences, but cannot override the
 * current request or grant effects. Every prompt path that injects
 * `skill.instruction` should surface this banner next to the skill header.
 */
export type SkillCustomizationNoticeOptions = {
  source?: "system" | "customized" | "personal";
  /** The current shipped body for a built-in skill, when one exists. */
  shippedInstruction?: string;
};

function customizationLocations(
  instruction: string,
  shippedInstruction: string,
): {
  locations: Array<"before" | "after">;
  managedSectionChanged: boolean;
} | null {
  const current = extractManagedBlock(instruction);
  const shipped = extractManagedBlock(shippedInstruction);
  if (current.block === null || shipped.block === null) return null;
  const locations: Array<"before" | "after"> = [];
  if (current.before.trim() !== shipped.before.trim()) locations.push("before");
  if (current.after.trim() !== shipped.after.trim()) locations.push("after");
  return {
    locations,
    managedSectionChanged: current.block !== shipped.block,
  };
}

function customizationLocationText(
  locations: ReadonlyArray<"before" | "after">,
): string {
  return locations.length === 2
    ? "before and after the managed section"
    : `${locations[0]} the managed section`;
}

/**
 * Explain which loaded instructions are user-controlled without treating a
 * skill as permission or allowing it to override the current request.
 *
 * Passing the shipped instruction makes detection exact for both sides of a
 * managed block. Callers without that baseline retain the legacy after-block
 * detection behavior.
 */
export function getSkillCustomizationNotice(
  instruction: string,
  options: SkillCustomizationNoticeOptions = {},
): string | null {
  if (options.source === "system") return null;
  if (options.source === "personal") {
    return (
      "NOTE: This is a PERSONAL SKILL. Its entire instruction is user-authored. " +
      "Use these preferences when relevant, while following the current request " +
      "and host permission policy."
    );
  }

  if (options.shippedInstruction !== undefined) {
    const comparison = customizationLocations(
      instruction,
      options.shippedInstruction,
    );
    if (!comparison || comparison.managedSectionChanged) {
      if (options.source !== "customized") return null;
      return (
        "NOTE: This built-in skill is CUSTOMIZED, but its user-owned sections " +
        "could not be separated safely from the shipped defaults. Preserve and " +
        "apply the entire loaded instruction as potentially user-authored " +
        "guidance, while following the current request and host permission policy."
      );
    }
    if (!comparison.locations.length) {
      return options.source === "customized"
        ? "NOTE: This built-in skill is marked CUSTOMIZED. Preserve the " +
            "entire loaded instruction as potentially user-authored guidance, " +
            "while following the current request and host permission policy."
        : null;
    }
    return (
      `NOTE: This skill contains USER CUSTOMIZATIONS ${customizationLocationText(comparison.locations)}. ` +
      "Use these preferences when relevant, while following the current request " +
      "and host permission policy."
    );
  }

  const { block, after } = extractManagedBlock(instruction);
  if (block !== null && after.trim()) {
    return (
      "NOTE: This skill contains USER CUSTOMIZATIONS after the managed section. " +
      "Use these preferences when relevant, while following the current request " +
      "and host permission policy."
    );
  }
  if (options.source === "customized") {
    return (
      "NOTE: This built-in skill is CUSTOMIZED. Preserve the entire loaded " +
      "instruction as potentially user-authored guidance, while following the " +
      "current request and host permission policy."
    );
  }
  return null;
}

/**
 * Simple djb2 hash — fast, good distribution, not crypto. It is 32 bits, so a
 * user's edited text can in principle collide with a listed shipped hash and
 * be upgraded as untouched (about 1 in 4 billion per compared text).
 */
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
