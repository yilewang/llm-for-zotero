import { parseSkill } from "./skillLoader";

/**
 * Patch an on-disk skill file's frontmatter: update `description` and
 * `version` to the shipped values in place, preserving every other line
 * (user-customized `match:` patterns, any custom frontmatter keys, the
 * instruction body). If `description:` or `version:` are missing on disk,
 * they are inserted at the top of the frontmatter.
 *
 * Returns the patched string, or `null` if no patch is needed (on-disk
 * version is already current, or the file has no frontmatter block).
 *
 * Kept in a standalone module (no `.md` imports) so the helper can be
 * unit-tested without pulling in the build-time skill bundle.
 */
export function patchSkillFrontmatter(
  onDiskRaw: string,
  shippedRaw: string,
): string | null {
  const onDisk = parseSkill(onDiskRaw);
  const shipped = parseSkill(shippedRaw);

  if (onDisk.version >= shipped.version) return null;

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
  const patchedFm = fmLines.map((line) => {
    const trimmed = line.trim();
    if (/^description:/.test(trimmed)) {
      sawDescription = true;
      return `description: ${shipped.description}`;
    }
    if (/^version:/.test(trimmed)) {
      sawVersion = true;
      return `version: ${shipped.version}`;
    }
    return line;
  });
  if (!sawVersion) patchedFm.unshift(`version: ${shipped.version}`);
  if (!sawDescription) patchedFm.unshift(`description: ${shipped.description}`);

  const header = lines.slice(0, fmStart + 1);
  const body = lines.slice(fmEnd);
  return [...header, ...patchedFm, ...body].join("\n");
}
