import { parseSkill } from "./skillLoader";

export type SkillFrontmatterPatchOptions = {
  historicalContexts?: ReadonlyArray<string>;
};

function normalizeContextsValue(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

/**
 * Patch an on-disk skill file's frontmatter: update `description` and
 * `version` to the shipped values in place, add missing shipped routing
 * metadata such as `contexts` / `activation`, preserving every other line
 * (user-customized `match:` patterns, any custom frontmatter keys, the
 * instruction body). If `description:` or `version:` are missing on disk,
 * they are inserted at the top of the frontmatter.
 *
 * Returns the patched string, or `null` if no patch is needed (on-disk
 * metadata is already current, or the file has no frontmatter block).
 *
 * Kept in a standalone module (no `.md` imports) so the helper can be
 * unit-tested without pulling in the build-time skill bundle.
 */
export function patchSkillFrontmatter(
  onDiskRaw: string,
  shippedRaw: string,
  options: SkillFrontmatterPatchOptions = {},
): string | null {
  const onDisk = parseSkill(onDiskRaw);
  const shipped = parseSkill(shippedRaw);
  const shouldPatchVersionedMetadata = onDisk.version < shipped.version;

  const lines = onDiskRaw.split("\n");
  let fmStart = -1;
  let fmEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      if (fmStart < 0) fmStart = i;
      else {
        fmEnd = i;
        break;
      }
    }
  }
  if (fmStart < 0 || fmEnd < 0) return null;

  const fmLines = lines.slice(fmStart + 1, fmEnd);
  let sawDescription = false;
  let sawVersion = false;
  let sawContexts = false;
  let sawActivation = false;
  let sawSupersedes = false;
  let changed = false;
  const shippedContexts = shipped.contexts.join(",");
  const normalizedShippedContexts = normalizeContextsValue(shippedContexts);
  const historicalContexts = new Set(
    (options.historicalContexts || []).map(normalizeContextsValue),
  );
  const patchedFm = fmLines.map((line) => {
    const trimmed = line.trim();
    if (/^description:/.test(trimmed)) {
      sawDescription = true;
      if (!shouldPatchVersionedMetadata) return line;
      const next = `description: ${shipped.description}`;
      if (next !== line) changed = true;
      return next;
    }
    if (/^version:/.test(trimmed)) {
      sawVersion = true;
      if (!shouldPatchVersionedMetadata) return line;
      const next = `version: ${shipped.version}`;
      if (next !== line) changed = true;
      return next;
    }
    const contextsMatch = trimmed.match(/^contexts:\s*(.*)$/);
    if (contextsMatch) {
      sawContexts = true;
      const normalizedOnDiskContexts = normalizeContextsValue(contextsMatch[1]);
      if (
        historicalContexts.has(normalizedOnDiskContexts) &&
        normalizedOnDiskContexts !== normalizedShippedContexts
      ) {
        const next = `contexts: ${shippedContexts}`;
        if (next !== line) changed = true;
        return next;
      }
      return line;
    }
    if (/^activation:/.test(trimmed)) {
      sawActivation = true;
      return line;
    }
    if (/^supersedes:/.test(trimmed)) {
      sawSupersedes = true;
      return line;
    }
    return line;
  });
  if (shouldPatchVersionedMetadata && !sawVersion) {
    patchedFm.unshift(`version: ${shipped.version}`);
    changed = true;
  }
  if (shouldPatchVersionedMetadata && !sawDescription) {
    patchedFm.unshift(`description: ${shipped.description}`);
    changed = true;
  }
  if (
    shouldPatchVersionedMetadata &&
    !sawActivation &&
    shipped.activation !== "auto"
  ) {
    patchedFm.push(`activation: ${shipped.activation}`);
    changed = true;
  }
  if (
    shouldPatchVersionedMetadata &&
    !sawSupersedes &&
    shipped.supersedes.length
  ) {
    patchedFm.push(`supersedes: ${shipped.supersedes.join(",")}`);
    changed = true;
  }
  if (
    shouldPatchVersionedMetadata &&
    !sawContexts &&
    !(shipped.contexts.length === 1 && shipped.contexts[0] === "any")
  ) {
    patchedFm.push(`contexts: ${shipped.contexts.join(",")}`);
    changed = true;
  }

  if (!changed) return null;

  const header = lines.slice(0, fmStart + 1);
  const body = lines.slice(fmEnd);
  return [...header, ...patchedFm, ...body].join("\n");
}
