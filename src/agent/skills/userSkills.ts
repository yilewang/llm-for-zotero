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
 *   1. If on-disk body hash == stored hash and the stored hash is a body we
 *      shipped → user didn't touch it → safe to replace with latest shipped
 *      version.
 *   2. If hashes differ, or the stored hash is no shipped body (a copy the
 *      first run tracked as it found it) → user customized → leave it alone.
 *   3. If no stored hash (first run with hash tracking, or a skills folder
 *      new at this start), only auto-upgrade or auto-delete files whose raw
 *      content or body matches a known shipped fingerprint from an older
 *      version.
 */
import { getSkillRoutingDiagnostics, parseSkill } from "./skillLoader";
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
import {
  BUILTIN_BOOTSTRAP_BODY_HASHES,
  BUILTIN_BOOTSTRAP_RAW_HASHES,
} from "./builtinSkillHashes";
import { joinLocalPath } from "../../utils/localPath";
import { patchSkillFrontmatter } from "./frontmatterPatcher";
import { appLogger } from "../../core/logging";
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
// Obsolete skill files (note skills consolidated into write-note.md;
// simple-paper-qa retired in favour of evidence-based-qa)
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
  // simple-paper-qa was retired in favour of evidence-based-qa; ordinary
  // paper questions need no skill. Hashes cover every
  // committed version of the file (v1-v10).
  {
    filename: "simple-paper-qa.md",
    bootstrapRawHashes: [
      "gfjvxt",
      "1w32fwi",
      "x02wmo",
      "tz1pi3",
      "1r2ban6",
      "1yqxw4",
      "14ok99f",
      "2vt80m",
      "14c21tp",
      "1vf0uap",
      "326eei",
      "e821k0",
      "168pnq0",
      "19icn0l",
      "en8n9t",
      "1181x3a",
      "19mtsg3",
      "a3hatz",
      "yu43tj",
      "12lfm6n",
      "1620eqd",
      "13ehjz6",
      "1o0or48",
    ],
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
  "simple-paper-qa",
]);

/**
 * Retired built-ins whose surviving copy (Step 1 keeps only customized or
 * unknown copies) still loads, as a personal skill under its own id, so a
 * user's edits never vanish silently. The note skills consolidated into
 * write-note stay skipped: write-note owns that workflow.
 */
const RETIRED_SKILL_IDS_KEPT_AS_PERSONAL = new Set(["simple-paper-qa"]);

/** Obsolete IDs already reported by loadUserSkills; each is logged once. */
const loggedObsoleteSkillIds = new Set<string>();

const BUILTIN_FRONTMATTER_PATCH_OPTIONS: Partial<
  Record<string, Parameters<typeof patchSkillFrontmatter>[2]>
> = {
  "compare-papers.md": {
    historicalContexts: ["paper-set"],
  },
  "evidence-based-qa.md": {
    historicalContexts: ["single-paper,paper-set"],
  },
  "analyze-figures.md": {
    historicalContexts: ["single-paper", "single-paper,visual-input"],
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

function isSafeSkillIdForPath(skillId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillId);
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
        !isSafeSkillIdForPath(skill.id) ||
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
      appLogger.info(
        `[llm-for-zotero] Migrated skill ${filename} to ${targetFile}`,
      );
    } catch (err) {
      appLogger.warn(
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

// The canonical skills folder whose start last finished. The seeded record,
// the stored hashes and the finished legacy migration belong to this folder
// only. Unset in profiles from before the pref existed; `pending:<dir>` while
// a first start in <dir> runs, so an interrupted one is redone.
const SEEDED_DIR_PREF_KEY = "extensions.zotero.llmForZotero.seededSkillsDir";

function getSeededSkillsDir(): string | undefined {
  try {
    const raw = Zotero.Prefs?.get(SEEDED_DIR_PREF_KEY, true);
    if (typeof raw === "string") return raw;
  } catch {
    /* */
  }
  return undefined;
}

function setSeededSkillsDir(value: string): void {
  try {
    Zotero.Prefs?.set(SEEDED_DIR_PREF_KEY, value, true);
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

/** Line index of the frontmatter's closing `---`, as parseSkill reads it. */
function frontmatterEndLine(lines: ReadonlyArray<string>): number {
  const start = lines.findIndex((line) => line.trim() === "---");
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i;
  }
  return -1;
}

/**
 * The upgraded text of a copy whose body (managed block, else instruction)
 * is a shipped one. Only text the plugin owns is replaced:
 * - a copy that is a shipped file exactly becomes the current shipped file;
 * - a copy with a managed block gets the shipped block, and everything
 *   around it (frontmatter included) stays;
 * - otherwise the copy keeps its own frontmatter (the user's `match:`,
 *   `activation:` or other keys) above the shipped body. Step 3 then
 *   updates the plugin-owned `description:` and `version:` lines.
 */
function upgradeKnownCopy(
  onDiskContent: string,
  shippedContent: string,
  rawKnown: boolean,
): string {
  if (rawKnown) return shippedContent;
  const shippedManaged = extractManagedBlock(shippedContent).block;
  if (
    shippedManaged !== null &&
    extractManagedBlock(onDiskContent).block !== null
  ) {
    const spliced = spliceManagedBlock(onDiskContent, shippedManaged);
    if (spliced !== null) return spliced;
  }
  const onDiskLines = onDiskContent.split("\n");
  const shippedLines = shippedContent.split("\n");
  const onDiskEnd = frontmatterEndLine(onDiskLines);
  const shippedEnd = frontmatterEndLine(shippedLines);
  if (onDiskEnd < 0 || shippedEnd < 0) return shippedContent;
  return [
    ...onDiskLines.slice(0, onDiskEnd + 1),
    ...shippedLines.slice(shippedEnd + 1),
  ].join("\n");
}

/**
 * Ids of the skills that another profile folder under the same data
 * directory (`agent-runtime/profile-*`, a profile's earlier path) holds as
 * `.agents/skills/<id>/SKILL.md`.
 */
async function skillIdsInOtherProfileFolders(
  io: IOUtilsLike,
  skillIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (!io.exists || !io.getChildren) return found;
  const currentRoot = getZoteroAgentRuntimeRootDir();
  let children: string[];
  try {
    children = await io.getChildren(dirname(currentRoot));
  } catch {
    return found;
  }
  for (const child of children) {
    const name = basename(child);
    if (!name.startsWith("profile-") || name === basename(currentRoot)) {
      continue;
    }
    for (const id of skillIds) {
      if (found.has(id)) continue;
      const skillFile = joinLocalPath(
        child,
        ".agents",
        "skills",
        id,
        NATIVE_SKILL_FILE_NAME,
      );
      if (await io.exists(skillFile).catch(() => false)) found.add(id);
    }
  }
  return found;
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
  // The skills folder lives under the profile's path signature, so a profile
  // copied, restored or moved to another path starts with a new, empty folder
  // while the profile-wide records (seeded built-ins, stored hashes) still
  // describe the folder used before. They apply only to a known folder: the
  // one whose start last finished, or, in a profile from before that record,
  // a folder that already existed. Decide before anything is written.
  const seededDir = getSeededSkillsDir();
  let folderKnown: boolean;
  try {
    const dirExisted = await io.exists(dir);
    folderKnown = seededDir === dir || (seededDir === undefined && dirExisted);
    // Mark the first start in this folder until it finishes, so a start
    // interrupted after it made the folder runs again in full.
    if (!folderKnown) setSeededSkillsDir(`pending:${dir}`);
    if (!dirExisted) {
      await io.makeDirectory(dir, {
        createAncestors: true,
        ignoreExisting: true,
      });
    }
  } catch {
    return;
  }

  const seeded = getSeededSkills();
  // A new folder's files (the migrated legacy copies) start untracked, so
  // only a known shipped text upgrades and anything else stays the user's.
  const bodyHashes = folderKnown ? getBodyHashes() : {};
  const encoder = new TextEncoder();

  // Copy the legacy flat folder in once, into a folder that is not yet
  // known. Every later start leaves it alone, so a skill the user deletes
  // from a known folder stays deleted although its legacy copy remains.
  if (!folderKnown) await migrateLegacyFlatSkills(io, seeded);

  // A profile from before the folder record may already have lost built-ins
  // to the old profile-wide record: a profile that moved got a new folder in
  // which every recorded built-in counted as deleted. Another profile folder
  // that holds the skill is the evidence of that move, so only then is an
  // absent recorded built-in written again; with no such folder, the
  // absence is the user's deletion and stays.
  const movedProfileSkillIds =
    folderKnown && seededDir === undefined
      ? await skillIdsInOtherProfileFolders(
          io,
          Object.values(BUILTIN_SKILL_FILES).map(
            (content) => parseSkill(content).id,
          ),
        )
      : new Set<string>();
  // The first start in a folder (not yet known, or known only because it
  // existed) records the folder only if every built-in it had to write was
  // written; otherwise the next start tries again.
  const firstStartHere = !folderKnown || seededDir === undefined;
  let unwrittenBuiltins = 0;

  // ── Step 1: Remove obsolete canonical skill files ───────────────────────
  // Old note skills were consolidated into write-note.md and simple-paper-qa
  // was retired in favour of evidence-based-qa. Delete only if:
  //   (a) we have a stored hash proving the file is unmodified, OR
  //   (b) bootstrap — no stored hash (pre-hash install) AND the raw file
  //       still matches a known shipped fingerprint.
  // Any other content stays on disk. loadUserSkills loads a surviving
  // simple-paper-qa as a personal skill under its own id; surviving old note
  // skills are kept on disk but not loaded (write-note owns that workflow).
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
          appLogger.info(
            `[llm-for-zotero] Removed obsolete ${file}` +
              (unmodifiedByBootstrap
                ? " (bootstrap: shipped fingerprint match)"
                : ""),
          );
        } else {
          // Customized or unknown legacy copy → keep it on disk
          seeded.delete(file);
          appLogger.debug(`[llm-for-zotero] Kept customized ${file} on disk`);
        }
      } catch (err) {
        appLogger.warn(
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
    let writingAbsentFile = false;
    try {
      const fileExists = await io.exists(filePath);

      if (!fileExists) {
        // The user deleted it from this folder — respect that. A folder not
        // yet known holds no deletion, so every absent built-in is written
        // after the legacy migration. A built-in deleted only from the
        // legacy flat folder therefore comes back in a new canonical folder;
        // that is accepted.
        if (
          folderKnown &&
          seeded.has(filename) &&
          !movedProfileSkillIds.has(shippedSkill.id)
        ) {
          continue;
        }

        writingAbsentFile = true;
        await io.makeDirectory(getCanonicalSkillDir(shippedSkill.id), {
          createAncestors: true,
          ignoreExisting: true,
        });
        await io.write(filePath, encoder.encode(shippedContent));
        bodyHashes[filename] = shippedHash;
        seeded.add(filename);
        appLogger.info(`[llm-for-zotero] Seeded skill: ${filename}`);
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
      if (onDiskHash === shippedHash) {
        // Already up to date (managed block or whole body matches)
        bodyHashes[filename] = shippedHash;
        seeded.add(filename);
        continue;
      }

      // On-disk differs from shipped — decide whether to upgrade.
      const storedHash = bodyHashes[filename];

      const knownHistoricalBodyHashes = BUILTIN_BOOTSTRAP_BODY_HASHES[filename];
      // An untouched copy whose stored hash is no shipped body was tracked by
      // the bootstrap branch below as the user's own text. It stays the
      // user's, for every built-in, even one without a body list.
      const trackedCustomizedBody =
        storedHash &&
        onDiskHash === storedHash &&
        !matchesKnownHash(storedHash, knownHistoricalBodyHashes);

      if (trackedCustomizedBody) {
        appLogger.debug(
          `[llm-for-zotero] Kept customized skill body: ${filename} ` +
            `(shipped v${shippedSkill.version} available — use preferences to restore defaults)`,
        );
      } else if (storedHash && onDiskHash === storedHash) {
        // Hash matches what we last wrote → user didn't modify the managed
        // section/body. Safe to upgrade while preserving content outside any
        // managed block, and the frontmatter.
        const rawKnown = matchesKnownRawHash(
          onDiskContent,
          BUILTIN_BOOTSTRAP_RAW_HASHES[filename],
        );
        await io.write(
          filePath,
          encoder.encode(
            upgradeKnownCopy(onDiskContent, shippedContent, rawKnown),
          ),
        );
        bodyHashes[filename] = shippedHash;
        appLogger.info(`[llm-for-zotero] Upgraded skill: ${filename}`);
      } else if (!storedHash) {
        // Bootstrap: no hash record (pre-hash installation). Only upgrade if
        // the raw file, or its body (the managed block when it has one),
        // still matches a known shipped version for this built-in; otherwise
        // treat it as customized and start tracking its current hash.
        const rawKnown = matchesKnownRawHash(
          onDiskContent,
          BUILTIN_BOOTSTRAP_RAW_HASHES[filename],
        );
        const bodyKnown = matchesKnownHash(
          onDiskHash,
          knownHistoricalBodyHashes,
        );
        // A listed body is an earlier shipped text whatever its `version:`
        // line says (an earlier start may have raised it), as on the tracked
        // branch; a raw match still needs the older version.
        if (
          bodyKnown ||
          (rawKnown && onDiskSkill.version < shippedSkill.version)
        ) {
          // A known body may sit among the user's own text (around a managed
          // block, or as frontmatter): replace only the plugin's text, as the
          // tracked branch does.
          await io.write(
            filePath,
            encoder.encode(
              upgradeKnownCopy(onDiskContent, shippedContent, rawKnown),
            ),
          );
          bodyHashes[filename] = shippedHash;
          appLogger.info(
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
        appLogger.debug(
          `[llm-for-zotero] Kept customized skill: ${filename} ` +
            `(shipped v${shippedSkill.version} available — use preferences to restore defaults)`,
        );
      }

      seeded.add(filename);
    } catch (err) {
      // Only an absent built-in that could not be written keeps the folder
      // unrecorded; a failed upgrade of an existing copy does not.
      if (writingAbsentFile) unwrittenBuiltins++;
      appLogger.warn(
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
          appLogger.info(
            `[llm-for-zotero] Patched skill metadata: ${filename}`,
          );
        }
      } catch (err) {
        appLogger.warn(
          `[llm-for-zotero] Skill metadata patch warning for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  try {
    await normalizeCanonicalSkillFrontmatter(io);
  } catch (err) {
    appLogger.warn(
      `[llm-for-zotero] Skill name normalization warning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // This folder's start finished: its records now describe it. A first start
  // with a failed built-in leaves the folder pending (or unrecorded) instead.
  if (firstStartHere && unwrittenBuiltins > 0) return;
  setSeededSkillsDir(dir);
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
        const keptAsPersonal = RETIRED_SKILL_IDS_KEPT_AS_PERSONAL.has(skill.id);
        if (!loggedObsoleteSkillIds.has(skill.id)) {
          loggedObsoleteSkillIds.add(skill.id);
          appLogger.info(
            keptAsPersonal
              ? `[llm-for-zotero] Loaded customized copy of retired skill ${skill.id} as a personal skill: ${filePath}`
              : `[llm-for-zotero] Skipped retired skill ${skill.id} left in profile: ${filePath}`,
          );
        }
        if (!keptAsPersonal) continue;
      }

      if (skill.id === "unknown" || !skill.instruction.trim()) {
        appLogger.warn(
          `[llm-for-zotero] Skipping invalid skill file (missing id or instruction): ${filePath}`,
        );
        continue;
      }
      for (const diagnostic of getSkillRoutingDiagnostics(skill)) {
        appLogger.debug(
          `[llm-for-zotero] Skill routing diagnostic for ${skill.id}: ${diagnostic}`,
        );
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
      appLogger.warn(
        `[llm-for-zotero] Error loading skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (skills.length > 0) {
    appLogger.info(
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
    appLogger.warn(
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
---

<!--
  Custom skill template.

  - name/id/description: shown in the "/" slash menu and native skill pickers
  - description: the agent reads this in the skill inventory to decide when to load the skill
  - contexts: any, single-paper, paper-set, library-corpus, note, or visual-input
  - activation: auto, manual, or both
  - version: increment when you make significant changes

  The text below is injected into the agent's current-turn guidance when
  the skill activates. Edit it to define how the agent should behave.
-->

Describe precisely when and how the agent should apply this workflow.
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
    appLogger.warn(
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
      appLogger.warn(
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
    appLogger.info(`[llm-for-zotero] Restored skill to default: ${filename}`);
    return true;
  } catch (err) {
    appLogger.warn(
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
    appLogger.warn(
      `[llm-for-zotero] Failed to open skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
