/**
 * Skills — runtime loading from the Zotero data directory.
 *
 * The user's skills directory is the sole source of truth. Built-in skills
 * are copied there on first run (or when new ones are added in updates).
 * Users can create, edit, or delete `.md` skill files freely.
 *
 * ## Upgrade mechanism
 *
 * We track a body hash for each skill file we write. On startup:
 *   1. If on-disk body hash == stored hash → user didn't touch it → safe to
 *      replace with latest shipped version.
 *   2. If hashes differ → user customized → leave it alone.
 *   3. If no stored hash (first run with hash tracking), only auto-upgrade
 *      or auto-delete files whose raw content matches a known shipped
 *      fingerprint from an older version.
 */
import { parseSkill } from "./skillLoader";
import type { AgentSkill } from "./skillLoader";
import {
  BUILTIN_SKILL_FILES,
  BUILTIN_SKILL_FILENAMES,
  getBuiltinSkillInstruction,
} from "./index";
import {
  extractManagedBlock,
  spliceManagedBlock,
  hashBody,
  hashSkillForUpgrade,
} from "./managedBlock";
import { joinLocalPath } from "../../utils/localPath";
import { patchSkillFrontmatter } from "./frontmatterPatcher";

// Re-export for callers that previously imported these from this module.
export { extractManagedBlock, spliceManagedBlock } from "./managedBlock";
export { patchSkillFrontmatter } from "./frontmatterPatcher";

// ---------------------------------------------------------------------------
// Body hash tracking — detect user modifications to skill files
// ---------------------------------------------------------------------------

const BODY_HASH_PREF_KEY = "extensions.zotero.llmForZotero.skillBodyHashes";

function getBodyHashes(): Record<string, string> {
  try {
    const raw = Zotero.Prefs?.get(BODY_HASH_PREF_KEY, true);
    if (typeof raw === "string" && raw) return JSON.parse(raw);
  } catch {
    /* */
  }
  return {};
}

function setBodyHashes(hashes: Record<string, string>): void {
  try {
    Zotero.Prefs?.set(BODY_HASH_PREF_KEY, JSON.stringify(hashes), true);
  } catch {
    /* */
  }
}

// ---------------------------------------------------------------------------
// Obsolete skill files (consolidated into write-note.md)
// ---------------------------------------------------------------------------

// Each entry carries the filename plus hashes of the exact raw file contents we
// shipped previously. During the first hash-tracking release, we only delete an
// obsolete file if its on-disk raw content still matches one of those shipped
// fingerprints. This preserves any user edits to the body or frontmatter.
// Bootstrap hashes cover every historically shipped version of each obsolete
// file, so users upgrading from any prior release see their unmodified copy
// cleaned up (not preserved as a personal-skill clutter). Hashes are raw-file
// djb2 computed against `git show <sha>:<path>` for each commit that touched
// the file. See scripts/compute_obsolete_hashes.mjs if a regen is needed.
const OBSOLETE_SKILL_FILES: ReadonlyArray<{
  filename: string;
  bootstrapRawHashes?: ReadonlyArray<string>;
}> = [
  {
    filename: "write-to-obsidian.md",
    bootstrapRawHashes: ["1ontyqg", "abubi2", "entogb", "1kqrsv2"],
  },
  {
    filename: "note-to-file.md",
    bootstrapRawHashes: ["1ps1z38", "1uu4w9d", "ts4pwh"],
  },
  {
    filename: "note-from-paper.md",
    bootstrapRawHashes: [
      "10pm2ce",
      "1h89oiu",
      "163vdby",
      "199dsib",
      "1jj7q1k",
      "iyngo1",
      "1u9djhs",
      "18wvjra",
    ],
  },
  {
    filename: "note-editing.md",
    bootstrapRawHashes: [
      "91xqa5",
      "1jy004u",
      "a5q2qs",
      "ykcj6",
      "1vyuswv",
      "18hy0fj",
      "1xm46q",
    ],
  },
  // note-template.md content was merged into write-note.md to fix a
  // cross-skill dependency bug. Unmodified on-disk copies are cleaned up;
  // customized copies are preserved as personal skills (though they no
  // longer shape note output — write-note.md now contains the template).
  {
    filename: "note-template.md",
    bootstrapRawHashes: ["128vd1c", "m675pz", "v55hyg"],
  },
];

const OBSOLETE_SKILL_FILENAMES = new Set(
  OBSOLETE_SKILL_FILES.map((entry) => entry.filename),
);

const OBSOLETE_SKILL_IDS = new Set([
  "write-to-obsidian",
  "note-to-file",
  "note-from-paper",
  "note-editing",
  "note-template",
]);

// Exact raw-content hashes for prior shipped versions of built-ins whose
// version increased in this release. On the first run with hash tracking, we
// only auto-upgrade when the on-disk raw file still matches a known shipped
// version; edited copies are preserved and surfaced as customized instead.
const BUILTIN_BOOTSTRAP_RAW_HASHES: Partial<
  Record<string, ReadonlyArray<string>>
> = {
  "library-analysis.md": ["ftq8b2"],
  "compare-papers.md": ["1jvl4lu"],
  "analyze-figures.md": ["msvqtf", "17o1bpl"],
  "simple-paper-qa.md": ["1r2ban6"],
  "evidence-based-qa.md": ["1er2ubr"],
  "write-note.md": ["172xn8t"],
  "literature-review.md": ["kbrknh"],
  "import-cited-reference.md": ["19bomz1"],
};

// ---------------------------------------------------------------------------
// Gecko runtime helpers (mirrors patterns from mineruCache.ts)
// ---------------------------------------------------------------------------

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<number>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
  remove?: (path: string) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getBaseDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim())
    return profileDir.trim();
  throw new Error("Cannot resolve Zotero data directory for user skills");
}

/** Returns the directory path where user skill files are stored. */
export function getUserSkillsDir(): string {
  return joinLocalPath(getBaseDir(), "llm-for-zotero", "skills");
}

// ---------------------------------------------------------------------------
// Seeded tracking — remember which files we've copied so user deletions stick
// ---------------------------------------------------------------------------

const SEEDED_PREF_KEY = "extensions.zotero.llmForZotero.seededBuiltinSkills";

function getSeededSkills(): Set<string> {
  try {
    const raw = Zotero.Prefs?.get(SEEDED_PREF_KEY, true);
    if (typeof raw === "string" && raw) return new Set(JSON.parse(raw));
  } catch {
    /* */
  }
  return new Set();
}

function setSeededSkills(seeded: Set<string>): void {
  try {
    Zotero.Prefs?.set(SEEDED_PREF_KEY, JSON.stringify([...seeded]), true);
  } catch {
    /* */
  }
}

// ---------------------------------------------------------------------------
// File I/O helper
// ---------------------------------------------------------------------------

async function readFileText(
  io: IOUtilsLike,
  path: string,
): Promise<string | null> {
  if (!io.read) return null;
  try {
    const data = await io.read(path);
    const bytes =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

function matchesKnownRawHash(
  raw: string,
  hashes: ReadonlyArray<string> | undefined,
): boolean {
  if (!hashes?.length) return false;
  return hashes.includes(hashBody(raw));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the user skills directory exists, seed/upgrade built-in skills.
 * Call this before loadUserSkills().
 */
export async function initUserSkills(): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.makeDirectory) return;

  const dir = getUserSkillsDir();
  try {
    if (!(await io.exists(dir))) {
      await io.makeDirectory(dir, {
        createAncestors: true,
        ignoreExisting: true,
      });
    }
  } catch {
    return;
  }

  const seeded = getSeededSkills();
  const bodyHashes = getBodyHashes();
  const encoder = new TextEncoder();

  // ── Step 1: Remove obsolete skill files ─────────────────────────────────
  // Old note skills were consolidated into write-note.md. Delete only if:
  //   (a) we have a stored hash proving the file is unmodified, OR
  //   (b) bootstrap — no stored hash (pre-hash install) AND the raw file
  //       still matches a known shipped fingerprint.
  // Any other content is preserved as a personal skill.
  if (io.read && io.remove) {
    for (const { filename: file, bootstrapRawHashes } of OBSOLETE_SKILL_FILES) {
      try {
        const filePath = joinLocalPath(dir, file);
        if (!(await io.exists(filePath))) {
          delete bodyHashes[file];
          seeded.delete(file);
          continue;
        }

        const content = await readFileText(io, filePath);
        if (!content) continue;

        const onDiskSkill = parseSkill(content);
        const storedHash = bodyHashes[file];
        // Must use the same hash algorithm as Step 2 (which writes the
        // stored hash). Step 2 uses hashSkillForUpgrade — managed-block-only
        // when markers are present, whole-body otherwise. Using hashBody()
        // here creates a guaranteed mismatch for any file with MANAGED
        // markers, stranding obsolete files on disk.
        const onDiskHash = hashSkillForUpgrade(
          content,
          onDiskSkill.instruction,
        );

        const unmodifiedByHash = !!storedHash && onDiskHash === storedHash;
        // Bootstrap path: pre-hash-tracking installs never stored a hash
        // for the obsolete files. Only delete if the raw file content still
        // matches a known shipped fingerprint; any body/frontmatter edits are
        // preserved as a personal skill.
        const unmodifiedByBootstrap =
          !storedHash && matchesKnownRawHash(content, bootstrapRawHashes);

        if (unmodifiedByHash || unmodifiedByBootstrap) {
          await io.remove(filePath);
          delete bodyHashes[file];
          seeded.delete(file);
          Zotero.debug?.(
            `[llm-for-zotero] Removed obsolete ${file}` +
              (unmodifiedByBootstrap
                ? " (bootstrap: shipped fingerprint match)"
                : ""),
          );
        } else {
          // Customized or unknown legacy copy → keep as personal skill
          seeded.delete(file);
          Zotero.debug?.(`[llm-for-zotero] Kept ${file} as personal skill`);
        }
      } catch (err) {
        Zotero.debug?.(
          `[llm-for-zotero] Obsolete skill cleanup warning for ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Step 2: Seed and upgrade built-in skills ────────────────────────────
  for (const [filename, shippedContent] of Object.entries(
    BUILTIN_SKILL_FILES,
  )) {
    const filePath = joinLocalPath(dir, filename);
    const shippedSkill = parseSkill(shippedContent);
    const shippedHash = hashSkillForUpgrade(
      shippedContent,
      shippedSkill.instruction,
    );
    const shippedManaged = extractManagedBlock(shippedContent).block;

    try {
      const fileExists = await io.exists(filePath);

      if (!fileExists) {
        if (seeded.has(filename)) continue; // User deleted it — respect that

        await io.write(filePath, encoder.encode(shippedContent));
        bodyHashes[filename] = shippedHash;
        seeded.add(filename);
        Zotero.debug?.(`[llm-for-zotero] Seeded skill: ${filename}`);
        continue;
      }

      // File exists — check if we should upgrade
      if (!io.read) {
        seeded.add(filename);
        continue;
      }
      const onDiskContent = await readFileText(io, filePath);
      if (!onDiskContent) {
        seeded.add(filename);
        continue;
      }

      const onDiskSkill = parseSkill(onDiskContent);
      const onDiskHash = hashSkillForUpgrade(
        onDiskContent,
        onDiskSkill.instruction,
      );
      const onDiskManaged = extractManagedBlock(onDiskContent).block;

      if (onDiskHash === shippedHash) {
        // Already up to date (managed block or whole body matches)
        bodyHashes[filename] = shippedHash;
        seeded.add(filename);
        continue;
      }

      // On-disk differs from shipped — decide whether to upgrade.
      const storedHash = bodyHashes[filename];

      if (storedHash && onDiskHash === storedHash) {
        // Hash matches what we last wrote → user didn't modify the managed
        // section/body. Safe to upgrade while preserving content outside any
        // managed block.
        if (shippedManaged !== null && onDiskManaged !== null) {
          const spliced = spliceManagedBlock(onDiskContent, shippedManaged);
          if (spliced !== null) {
            await io.write(filePath, encoder.encode(spliced));
            bodyHashes[filename] = shippedHash;
            Zotero.debug?.(
              `[llm-for-zotero] Refreshed managed block: ${filename}`,
            );
            seeded.add(filename);
            continue;
          }
        }
        await io.write(filePath, encoder.encode(shippedContent));
        bodyHashes[filename] = shippedHash;
        Zotero.debug?.(`[llm-for-zotero] Upgraded skill: ${filename}`);
      } else if (!storedHash) {
        // Bootstrap: no hash record (pre-hash installation). Only upgrade if
        // the raw file still matches a known shipped version for this built-in;
        // otherwise treat it as customized and start tracking its current hash.
        if (
          onDiskSkill.version < shippedSkill.version &&
          matchesKnownRawHash(
            onDiskContent,
            BUILTIN_BOOTSTRAP_RAW_HASHES[filename],
          )
        ) {
          await io.write(filePath, encoder.encode(shippedContent));
          bodyHashes[filename] = shippedHash;
          Zotero.debug?.(
            `[llm-for-zotero] Bootstrap-upgraded skill: ${filename} (v${onDiskSkill.version} → v${shippedSkill.version})`,
          );
        } else {
          // Same/newer version, unknown raw body, or edited previous version
          // → preserve and start tracking the current file state.
          bodyHashes[filename] = onDiskHash;
        }
      } else {
        // storedHash exists but differs from on-disk → user customized.
        // Leave file alone, but log so the developer / advanced user knows
        // a shipped update is available (surfaced via the preferences UI).
        Zotero.debug?.(
          `[llm-for-zotero] Kept customized skill: ${filename} ` +
            `(shipped v${shippedSkill.version} available — use preferences to restore defaults)`,
        );
      }

      seeded.add(filename);
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Skill processing error for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  setSeededSkills(seeded);
  setBodyHashes(bodyHashes);

  // ── Step 3: Metadata patching (frontmatter only) ────────────────────────
  // Updates `description` and `version` frontmatter fields only; all other
  // keys (including user-customized `match:` patterns and any other custom
  // metadata the user added) are preserved verbatim. Useful for keeping the
  // displayed description/version current on customized files without
  // touching either the instruction body or user-added frontmatter.
  if (io.read) {
    for (const [filename, shippedContent] of Object.entries(
      BUILTIN_SKILL_FILES,
    )) {
      const filePath = joinLocalPath(dir, filename);
      try {
        if (!(await io.exists(filePath))) continue;
        const onDiskRaw = await readFileText(io, filePath);
        if (!onDiskRaw) continue;
        const patched = patchSkillFrontmatter(onDiskRaw, shippedContent);
        if (patched) {
          await io.write(filePath, encoder.encode(patched));
          Zotero.debug?.(
            `[llm-for-zotero] Patched skill metadata: ${filename}`,
          );
        }
      } catch (err) {
        Zotero.debug?.(
          `[llm-for-zotero] Skill metadata patch warning for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Scan the user skills directory for `.md` files and parse them.
 * Returns an empty array if the directory does not exist or no valid
 * skill files are found. Never throws.
 */
export async function loadUserSkills(): Promise<AgentSkill[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read || !io?.getChildren) return [];

  const dir = getUserSkillsDir();

  try {
    if (!(await io.exists(dir))) return [];
  } catch {
    return [];
  }

  let entries: string[];
  try {
    entries = await io.getChildren(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((entry) => entry.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const skills: AgentSkill[] = [];

  for (const filePath of mdFiles) {
    try {
      const data = await io.read(filePath);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const raw = new TextDecoder("utf-8").decode(bytes);

      const skill = parseSkill(raw);
      const filename = filePath.split(/[/\\]/).pop() || "";

      if (
        OBSOLETE_SKILL_FILENAMES.has(filename) ||
        OBSOLETE_SKILL_IDS.has(skill.id)
      ) {
        Zotero.debug?.(
          `[llm-for-zotero] Skipping obsolete preserved skill file: ${filePath}`,
        );
        continue;
      }

      if (skill.id === "unknown" || skill.patterns.length === 0) {
        Zotero.debug?.(
          `[llm-for-zotero] Skipping invalid skill file (missing id or match patterns): ${filePath}`,
        );
        continue;
      }

      if (BUILTIN_SKILL_FILENAMES.has(filename)) {
        const shippedInstruction = getBuiltinSkillInstruction(filename);
        skill.source =
          shippedInstruction !== undefined &&
          skill.instruction === shippedInstruction
            ? "system"
            : "customized";
      } else {
        skill.source = "personal";
      }

      skills.push(skill);
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Error loading skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (skills.length > 0) {
    Zotero.debug?.(
      `[llm-for-zotero] Loaded ${skills.length} skill(s) from ${dir}`,
    );
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Skill file management (used by the skills popup UI)
// ---------------------------------------------------------------------------

export async function listSkillFiles(): Promise<string[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.getChildren) return [];

  const dir = getUserSkillsDir();
  try {
    if (!(await io.exists(dir))) return [];
    const entries = await io.getChildren(dir);
    return entries.filter((entry) => entry.endsWith(".md"));
  } catch {
    return [];
  }
}

export async function deleteSkillFile(filePath: string): Promise<boolean> {
  const io = getIOUtils();
  if (!io?.remove) return false;

  try {
    await io.remove(filePath);
    return true;
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to delete skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function createSkillTemplate(): Promise<string | null> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.makeDirectory) return null;

  const dir = getUserSkillsDir();

  try {
    await io.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch {
    /* */
  }
  const encoder = new TextEncoder();
  const template = `---
id: my-custom-skill
description: Describe what this skill does
version: 1
match: /your regex pattern here/i
---

<!--
  Custom skill template.

  - name/description: shown in the "/" slash menu
  - match: regex patterns that trigger this skill (OR semantics)
  - version: increment when you make significant changes

  The text below is injected into the agent's system prompt when
  the skill activates. Edit it to define how the agent should behave.
-->

Describe when and how the agent should behave when this skill matches.
`;

  let index = 1;
  let filePath: string;
  while (true) {
    filePath = joinLocalPath(dir, `custom-skill-${index}.md`);
    try {
      const exists = await io.exists(filePath);
      if (!exists) break;
    } catch {
      break;
    }
    index++;
    if (index > 999) return null;
  }

  try {
    await io.write(filePath, encoder.encode(template));
    return filePath;
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to create skill template: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preferences UI helpers — listing, diffing, restoring skill files
// ---------------------------------------------------------------------------

export type SkillListingEntry = {
  filename: string;
  filePath: string;
  id: string;
  description: string;
  version: number;
  /** Classification of this file relative to shipped built-ins. */
  source: "system" | "customized" | "personal";
  /** Shipped version, or null if this file is user-created (personal). */
  shippedVersion: number | null;
  /**
   * True if this is a built-in skill whose shipped version uses MANAGED
   * markers but the on-disk copy does not. These files cannot be auto-
   * upgraded safely — the user must click "Restore to default" (which
   * loses their body edits) to adopt the new format.
   */
  managedBlockOutdated: boolean;
};

/**
 * List all skill files with classification (system/customized/personal)
 * and shipped-version metadata for the preferences UI.
 */
export async function getSkillListing(): Promise<SkillListingEntry[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read || !io?.getChildren) return [];

  const dir = getUserSkillsDir();
  try {
    if (!(await io.exists(dir))) return [];
  } catch {
    return [];
  }

  let entries: string[];
  try {
    entries = await io.getChildren(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((entry) => entry.endsWith(".md"));
  const listing: SkillListingEntry[] = [];

  for (const filePath of mdFiles) {
    try {
      const data = await io.read(filePath);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const raw = new TextDecoder("utf-8").decode(bytes);
      const skill = parseSkill(raw);
      if (skill.id === "unknown") continue;

      const filename = filePath.split(/[/\\]/).pop() || "";
      const shippedContent = BUILTIN_SKILL_FILES[filename];

      let source: "system" | "customized" | "personal";
      let shippedVersion: number | null = null;
      let managedBlockOutdated = false;

      if (shippedContent !== undefined) {
        const shippedSkill = parseSkill(shippedContent);
        shippedVersion = shippedSkill.version;

        if (skill.instruction === shippedSkill.instruction) {
          source = "system";
        } else {
          source = "customized";
          const shippedManaged = extractManagedBlock(shippedContent).block;
          const onDiskManaged = extractManagedBlock(raw).block;
          if (shippedManaged !== null && onDiskManaged === null) {
            managedBlockOutdated = true;
          }
        }
      } else {
        source = "personal";
      }

      listing.push({
        filename,
        filePath,
        id: skill.id,
        description: skill.description,
        version: skill.version,
        source,
        shippedVersion,
        managedBlockOutdated,
      });
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Error listing skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  listing.sort((a, b) => a.filename.localeCompare(b.filename));
  return listing;
}

/**
 * Overwrite the on-disk skill file with the shipped version and update
 * tracking prefs. Used by the preferences "Restore to default" action.
 *
 * Returns true on success, false if the file is not a known built-in
 * or I/O failed.
 */
export async function restoreSkillToDefault(
  filename: string,
): Promise<boolean> {
  const shippedContent = BUILTIN_SKILL_FILES[filename];
  if (shippedContent === undefined) return false;

  const io = getIOUtils();
  if (!io?.write || !io?.makeDirectory) return false;

  const dir = getUserSkillsDir();
  try {
    await io.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch {
    /* */
  }

  const filePath = joinLocalPath(dir, filename);
  const shippedSkill = parseSkill(shippedContent);
  const shippedHash = hashSkillForUpgrade(
    shippedContent,
    shippedSkill.instruction,
  );

  try {
    await io.write(filePath, new TextEncoder().encode(shippedContent));
    const bodyHashes = getBodyHashes();
    bodyHashes[filename] = shippedHash;
    setBodyHashes(bodyHashes);
    const seeded = getSeededSkills();
    seeded.add(filename);
    setSeededSkills(seeded);
    Zotero.debug?.(`[llm-for-zotero] Restored skill to default: ${filename}`);
    return true;
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to restore skill ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Return the on-disk and shipped content of a built-in skill for diff
 * preview. Returns null if the skill is not a built-in or I/O failed.
 */
export async function getSkillDiff(
  filename: string,
): Promise<{ onDisk: string; shipped: string } | null> {
  const shippedContent = BUILTIN_SKILL_FILES[filename];
  if (shippedContent === undefined) return null;

  const io = getIOUtils();
  if (!io?.exists || !io?.read) return null;

  const filePath = joinLocalPath(getUserSkillsDir(), filename);
  try {
    if (!(await io.exists(filePath))) return null;
    const onDisk = await readFileText(io, filePath);
    if (onDisk === null) return null;
    return { onDisk, shipped: shippedContent };
  } catch {
    return null;
  }
}

/**
 * Open a skill file in the OS default editor.
 */
export async function openSkillFile(filePath: string): Promise<void> {
  try {
    const fileModule = Zotero as unknown as {
      File?: { reveal?: (path: string) => void };
      launchFile?: (path: string) => void;
    };
    if (typeof fileModule.launchFile === "function") {
      fileModule.launchFile(filePath);
    } else if (fileModule.File?.reveal) {
      fileModule.File.reveal(filePath);
    }
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to open skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
