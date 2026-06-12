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
import {
  getCanonicalSkillDir,
  getCanonicalSkillFilePath,
  getCanonicalUserSkillsDir,
  getLegacyUserSkillsDir,
  getZoteroAgentRuntimeRootDir,
  NATIVE_SKILL_FILE_NAME,
} from "./nativeSkillPaths";

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
  "compare-papers.md": [
    "i0j6yq",
    "1yreksb",
    "7os2qk",
    "1frgnyh",
    "1jvl4lu",
    "cp9zod",
    "w9wsrp",
    "1w3ytrp",
    "1krlubq",
  ],
  "analyze-figures.md": ["msvqtf", "17o1bpl"],
  "simple-paper-qa.md": ["1r2ban6"],
  "evidence-based-qa.md": [
    "vyeyap",
    "1vhakii",
    "dxw5b3",
    "11cbpv7",
    "1er2ubr",
    "13esvqx",
    "1k39b46",
    "1xglfq0",
  ],
  "write-note.md": ["172xn8t"],
  "literature-review.md": ["kbrknh"],
  "import-cited-reference.md": ["19bomz1"],
};

const BUILTIN_BOOTSTRAP_BODY_HASHES: Partial<
  Record<string, ReadonlyArray<string>>
> = {
  "compare-papers.md": [
    "x00ci1",
    "1au58pu",
    "13ppssj",
    "19kyxys",
    "spgyhq",
    "17c7wx5",
    "6r67g8",
    "1j5fq18",
  ],
  "evidence-based-qa.md": [
    "1aby95d",
    "1g0a76y",
    "4gj0dx",
    "12qgkrq",
    "bgr2hf",
    "zjwar9",
  ],
};

const BUILTIN_FRONTMATTER_PATCH_OPTIONS: Partial<
  Record<string, Parameters<typeof patchSkillFrontmatter>[2]>
> = {
  "compare-papers.md": {
    historicalContexts: ["paper-set"],
  },
  "evidence-based-qa.md": {
    historicalContexts: ["single-paper,paper-set"],
  },
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
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

/** Returns the directory path where user skill files are stored. */
export function getUserSkillsDir(): string {
  return getCanonicalUserSkillsDir();
}

/** Returns the root directory Codex can use as cwd to discover `.agents/skills`. */
export function getUserSkillsRuntimeRootDir(): string {
  return getZoteroAgentRuntimeRootDir();
}

/** Legacy flat skill folder, retained only as a migration source. */
export function getLegacySkillsDir(): string {
  return getLegacyUserSkillsDir();
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function resolveBuiltinFilenameForSkillId(skillId: string): string | null {
  for (const [filename, raw] of Object.entries(BUILTIN_SKILL_FILES)) {
    try {
      if (parseSkill(raw).id === skillId) return filename;
    } catch {
      /* ignore malformed shipped skill */
    }
  }
  return null;
}

function resolveBuiltinFilename(value: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  if (BUILTIN_SKILL_FILES[trimmed] !== undefined) return trimmed;
  if (BUILTIN_SKILL_FILES[`${trimmed}.md`] !== undefined) {
    return `${trimmed}.md`;
  }
  return resolveBuiltinFilenameForSkillId(trimmed);
}

function ensureNativeSkillName(raw: string, skill: AgentSkill): string {
  if (/^name:\s*.+$/m.test(raw)) return raw;
  const lines = raw.split("\n");
  const start = lines.findIndex((line) => line.trim() === "---");
  if (start < 0) return raw;
  lines.splice(start + 1, 0, `name: ${skill.id}`);
  return lines.join("\n");
}

async function readSkillFile(
  io: IOUtilsLike,
  filePath: string,
): Promise<{ raw: string; skill: AgentSkill } | null> {
  const raw = await readFileText(io, filePath);
  if (!raw) return null;
  try {
    return { raw, skill: parseSkill(raw) };
  } catch {
    return null;
  }
}

async function listCanonicalSkillFiles(io: IOUtilsLike): Promise<string[]> {
  if (!io.exists || !io.getChildren) return [];
  const skillsDir = getUserSkillsDir();
  try {
    if (!(await io.exists(skillsDir))) return [];
    const children = await io.getChildren(skillsDir);
    const files: string[] = [];
    for (const child of children) {
      if (child.endsWith(".md")) continue;
      const skillFile = joinLocalPath(child, NATIVE_SKILL_FILE_NAME);
      if (await io.exists(skillFile).catch(() => false)) {
        files.push(skillFile);
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function normalizeCanonicalSkillFrontmatter(
  io: IOUtilsLike,
): Promise<void> {
  if (!io.read || !io.write) return;
  for (const filePath of await listCanonicalSkillFiles(io)) {
    const loaded = await readSkillFile(io, filePath);
    if (!loaded || loaded.skill.id === "unknown") continue;
    const next = ensureNativeSkillName(loaded.raw, loaded.skill);
    if (next === loaded.raw) continue;
    await io.write(filePath, new TextEncoder().encode(next));
  }
}

async function migrateLegacyFlatSkills(
  io: IOUtilsLike,
  seeded: Set<string>,
): Promise<void> {
  if (
    !io.exists ||
    !io.read ||
    !io.write ||
    !io.getChildren ||
    !io.makeDirectory
  ) {
    return;
  }
  const legacyDir = getLegacySkillsDir();
  try {
    if (!(await io.exists(legacyDir))) return;
  } catch {
    return;
  }

  let entries: string[];
  try {
    entries = await io.getChildren(legacyDir);
  } catch {
    return;
  }

  for (const filePath of entries.filter((entry) => entry.endsWith(".md"))) {
    try {
      const loaded = await readSkillFile(io, filePath);
      if (!loaded) continue;
      const { raw, skill } = loaded;
      const filename = basename(filePath);
      if (
        skill.id === "unknown" ||
        OBSOLETE_SKILL_FILENAMES.has(filename) ||
        OBSOLETE_SKILL_IDS.has(skill.id)
      ) {
        continue;
      }
      const targetFile = getCanonicalSkillFilePath(skill.id);
      if (await io.exists(targetFile).catch(() => false)) {
        continue;
      }
      await io.makeDirectory(getCanonicalSkillDir(skill.id), {
        createAncestors: true,
        ignoreExisting: true,
      });
      await io.write(targetFile, new TextEncoder().encode(raw));
      if (BUILTIN_SKILL_FILENAMES.has(filename)) {
        seeded.add(filename);
      }
      Zotero.debug?.(
        `[llm-for-zotero] Migrated skill ${filename} to ${targetFile}`,
      );
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Skill migration warning for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

function matchesKnownHash(
  hash: string | undefined,
  hashes: ReadonlyArray<string> | undefined,
): boolean {
  return Boolean(hash && hashes?.includes(hash));
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

  await migrateLegacyFlatSkills(io, seeded);

  // ── Step 1: Remove obsolete canonical skill files ───────────────────────
  // Old note skills were consolidated into write-note.md. Delete only if:
  //   (a) we have a stored hash proving the file is unmodified, OR
  //   (b) bootstrap — no stored hash (pre-hash install) AND the raw file
  //       still matches a known shipped fingerprint.
  // Any other content is preserved as a personal skill.
  if (io.read && io.remove) {
    for (const { filename: file, bootstrapRawHashes } of OBSOLETE_SKILL_FILES) {
      try {
        const obsoleteSkillId = file.replace(/\.md$/i, "");
        const filePath = getCanonicalSkillFilePath(obsoleteSkillId);
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
    const shippedSkill = parseSkill(shippedContent);
    const filePath = getCanonicalSkillFilePath(shippedSkill.id);
    const shippedHash = hashSkillForUpgrade(
      shippedContent,
      shippedSkill.instruction,
    );
    const shippedManaged = extractManagedBlock(shippedContent).block;

    try {
      const fileExists = await io.exists(filePath);

      if (!fileExists) {
        if (seeded.has(filename)) continue; // User deleted it — respect that

        await io.makeDirectory(getCanonicalSkillDir(shippedSkill.id), {
          createAncestors: true,
          ignoreExisting: true,
        });
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

      const knownHistoricalBodyHashes = BUILTIN_BOOTSTRAP_BODY_HASHES[filename];
      const trackedCustomizedBody =
        storedHash &&
        onDiskHash === storedHash &&
        knownHistoricalBodyHashes?.length &&
        !matchesKnownHash(storedHash, knownHistoricalBodyHashes);

      if (trackedCustomizedBody) {
        Zotero.debug?.(
          `[llm-for-zotero] Kept customized skill body: ${filename} ` +
            `(shipped v${shippedSkill.version} available — use preferences to restore defaults)`,
        );
      } else if (storedHash && onDiskHash === storedHash) {
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
  // Updates plugin-owned frontmatter fields and known old shipped routing
  // metadata; all other keys (including user-customized `match:` patterns and
  // custom contexts) are preserved verbatim. Useful for keeping customized
  // files compatible without touching the instruction body.
  if (io.read) {
    for (const [filename, shippedContent] of Object.entries(
      BUILTIN_SKILL_FILES,
    )) {
      const shippedSkill = parseSkill(shippedContent);
      const filePath = getCanonicalSkillFilePath(shippedSkill.id);
      try {
        if (!(await io.exists(filePath))) continue;
        const onDiskRaw = await readFileText(io, filePath);
        if (!onDiskRaw) continue;
        const patched = patchSkillFrontmatter(
          onDiskRaw,
          shippedContent,
          BUILTIN_FRONTMATTER_PATCH_OPTIONS[filename],
        );
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

  await normalizeCanonicalSkillFrontmatter(io);
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
  const skillFiles = await listCanonicalSkillFiles(io);
  const skills: AgentSkill[] = [];

  for (const filePath of skillFiles) {
    try {
      const data = await io.read(filePath);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const raw = new TextDecoder("utf-8").decode(bytes);

      const skill = parseSkill(raw);
      const filename =
        resolveBuiltinFilenameForSkillId(skill.id) || basename(filePath);

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
  return listCanonicalSkillFiles(io);
}

export async function deleteSkillFile(filePath: string): Promise<boolean> {
  const io = getIOUtils();
  if (!io?.remove) return false;

  try {
    const target = /[\\/]SKILL\.md$/i.test(filePath)
      ? dirname(filePath)
      : filePath;
    await io.remove(target, { recursive: true, ignoreAbsent: true });
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
name: my-custom-skill
id: my-custom-skill
description: Describe what this skill does
version: 1
contexts: any
activation: auto
match: /your regex pattern here/i
---

<!--
  Custom skill template.

  - name/id/description: shown in the "/" slash menu and native skill pickers
  - match: regex patterns that trigger this skill (OR semantics)
  - contexts: any, single-paper, paper-set, library-corpus, or note
  - activation: auto, manual, or both
  - version: increment when you make significant changes

  The text below is injected into the agent's current-turn guidance when
  the skill activates. Edit it to define how the agent should behave.
-->

Describe when and how the agent should behave when this skill matches.
`;

  let index = 1;
  let filePath: string;
  while (true) {
    filePath = getCanonicalSkillFilePath(`custom-skill-${index}`);
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
    await io.makeDirectory(dirname(filePath), {
      createAncestors: true,
      ignoreExisting: true,
    });
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

  const skillFiles = await listCanonicalSkillFiles(io);
  const listing: SkillListingEntry[] = [];

  for (const filePath of skillFiles) {
    try {
      const data = await io.read(filePath);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const raw = new TextDecoder("utf-8").decode(bytes);
      const skill = parseSkill(raw);
      if (skill.id === "unknown") continue;

      const filename = skill.id;
      const shippedFilename = resolveBuiltinFilenameForSkillId(skill.id);
      const shippedContent = shippedFilename
        ? BUILTIN_SKILL_FILES[shippedFilename]
        : undefined;

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
  filenameOrSkillId: string,
): Promise<boolean> {
  const filename = resolveBuiltinFilename(filenameOrSkillId);
  if (!filename) return false;
  const shippedContent = BUILTIN_SKILL_FILES[filename];
  if (shippedContent === undefined) return false;

  const io = getIOUtils();
  if (!io?.write || !io?.makeDirectory) return false;

  const shippedSkill = parseSkill(shippedContent);
  const dir = getCanonicalSkillDir(shippedSkill.id);
  try {
    await io.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch {
    /* */
  }

  const filePath = getCanonicalSkillFilePath(shippedSkill.id);
  const shippedHash = hashSkillForUpgrade(
    shippedContent,
    shippedSkill.instruction,
  );

  try {
    await io.write(
      filePath,
      new TextEncoder().encode(
        ensureNativeSkillName(shippedContent, shippedSkill),
      ),
    );
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
  filenameOrSkillId: string,
): Promise<{ onDisk: string; shipped: string } | null> {
  const filename = resolveBuiltinFilename(filenameOrSkillId);
  if (!filename) return null;
  const shippedContent = BUILTIN_SKILL_FILES[filename];
  if (shippedContent === undefined) return null;

  const io = getIOUtils();
  if (!io?.exists || !io?.read) return null;

  const shippedSkill = parseSkill(shippedContent);
  const filePath = getCanonicalSkillFilePath(shippedSkill.id);
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
