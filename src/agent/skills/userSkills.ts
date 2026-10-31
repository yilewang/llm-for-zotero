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

// Exact raw-content hashes for prior shipped versions of built-ins whose
// version increased in this release. On the first run with hash tracking, we
// only auto-upgrade when the on-disk raw file still matches a known shipped
// version; edited copies are preserved and surfaced as customized instead.
const BUILTIN_BOOTSTRAP_RAW_HASHES: Partial<
  Record<string, ReadonlyArray<string>>
> = {
  "library-analysis.md": [
    "ftq8b2",
    "qttubn",
    "i2f8xa",
    // Released texts the list missed, from each release tag's copy
    // (v3.7.12, v3.8.5, v3.8.6, v3.8.11 and v3.8.24).
    "1gboxxt",
    "1dibsu3",
    "1fmb4jm",
    "19974y5",
    "1c3awl3",
    // v4, which named the synthesis digest the sized views omit (v5).
    "1fqhql1",
    // v5, whose context_read paging step v6 moves into context_read's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "1nb2mr9",
    "13a396o",
  ],
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
    "6upxur",
    "qs8z4b",
    "ulypcf",
    // Both parallel v8 texts (main and the tool-consolidation branch).
    "jch7ho",
    "11c76b5",
    // v9, the text v10's digest part extends, as shipped and as the
    // canonical copy carrying its native `name:` line.
    "l93iop",
    "jop719",
    // v10, the text v11's dimension-named digest replaces, as shipped and
    // as the canonical copy carrying its native `name:` line.
    "1mp6wjc",
    "1a6j60s",
    // v11, whose task_update digest step v12 moves into task_update's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "ngexre",
    "1m607zi",
    // v12, whose reading v13 makes follow what the user asked to read (only
    // the abstracts, named sections, or full reads), as shipped and as the
    // canonical copy carrying its native `name:` line.
    "xytjpv",
    "urjtw7",
  ],
  "analyze-figures.md": [
    "msvqtf",
    "17o1bpl",
    "gdr4uu",
    "1kjl8up",
    "e0ebpu",
    "z5uzar",
    "1u0n8ze",
  ],
  "evidence-based-qa.md": [
    "en0khz",
    "vyeyap",
    "1vhakii",
    "dxw5b3",
    "11cbpv7",
    "1er2ubr",
    "13esvqx",
    "1k39b46",
    "1xglfq0",
    "qdqcm0",
    "90zxig",
    "5iibf",
    "1qkh4mt",
    "14eowou",
    "1l2klni",
    "37vjex",
    // v12, the text v13's lookup-first route and absence distinction
    // replace, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "mlbz5s",
    "1psjdpv",
  ],
  "write-note.md": [
    "172xn8t",
    "nvca0f",
    "17lvl1z",
    "u1ej3e",
    "1c1s5yg",
    "1cfk2wb",
    "3m65z4",
    // v18, whose context_read source step v19 moves into context_read's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "1kxggv",
    "xw13m",
  ],
  "literature-review.md": [
    "kbrknh",
    "nxpr5d",
    "1cnjf9i",
    "3tk61l",
    "1ptwzpw",
    "pefrjt",
    "fptven",
    "10fqwsh",
    // Released texts the list missed, from each release tag's copy
    // (v3.7.18 to v3.9.5).
    "1gbl57m",
    "n96aqu",
    "w18p0a",
    "1dbaw6y",
    "1ymizha",
    "1mwckog",
    "au1hm1",
    "y7vpt5",
    "q3t63g",
    "fjgktb",
    // v10, the investigation-loop text the ordinary v11 replaces.
    "liv5sv",
    // v11, the text v12's digest parts replace, as shipped and as the
    // canonical copy carrying its native `name:` line.
    "1hrhlxd",
    "3mijhi",
    // v12, the text v13's question-led digest and Select step replace, as
    // shipped and as the canonical copy carrying its native `name:` line.
    "mujbgx",
    "18cssl2",
    // v13 (v3.9.10 to v3.9.12), the text v14's nothing-relevant rule (find
    // papers through the selection card, never review outside abstracts)
    // extends, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "15xumq",
    "1rape47",
    // v14, whose task_update parts, digest and retry steps v15 moves into
    // task_update's guidance (#541), as shipped and as the canonical copy
    // carrying its native `name:` line.
    "kl1d3v",
    "b7qleo",
    // v15, whose submit_document step v16 leaves to submit_document's
    // description, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "xfd5wu",
    "17ofyyb",
    // v16, whose never-review-outside-abstracts rule v17 replaces with the
    // selection card's choice to import and cite or cite without importing,
    // as shipped and as the canonical copy carrying its native `name:` line.
    "16809kz",
    "1488enc",
    // v17, whose coverage line v18 counts a paper as read in full only when
    // its reader read every character (a digest's Full, a complete full
    // paper_read), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "127dobw",
    "1al1wxd",
  ],
  "reorganize-library.md": [
    // v1, whose task_update part v2 moves into task_update's guidance
    // (#541), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "1nlucw4",
    "1jwuu81",
    // v2, whose never-a-full-text rule v3 leaves to the user (a full text,
    // or every paper, when the user asks), as shipped and as the canonical
    // copy carrying its native `name:` line.
    "9pqjhh",
    "1hpk276",
  ],
  "import-cited-reference.md": [
    "19bomz1",
    "e9tjej",
    "145es7h",
    "1j1qzbc",
    "1sx03p9",
    "1mtgn5u",
    // v6, whose web_read page step v7 moves into web_read's guidance
    // (#541), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "iryqnj",
    "qquewx",
  ],
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
    "1t8gyg9",
    "7cp6rj",
    // Both parallel v8 bodies (main and the tool-consolidation branch).
    "1eveisf",
    "8zlow4",
    // v9, the body v10's digest part extends.
    "1s8bw97",
    // v10, the body v11's dimension-named digest replaces.
    "dds2si",
    // v11, the body whose task_update digest step v12 moves into
    // task_update's guidance (#541).
    "e98t03",
    // v12, the body whose reading v13 makes follow what the user asked to
    // read.
    "ihlct7",
  ],
  "evidence-based-qa.md": [
    "41yh3d",
    "1aby95d",
    "1g0a76y",
    "4gj0dx",
    "12qgkrq",
    "bgr2hf",
    "zjwar9",
    "49orr",
    "13yvvl6",
    "1l4p1x2",
    "u49rr3",
    // v12, the body v13's lookup-first route replaces.
    "7fiyr0",
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
        appLogger.debug(
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
            appLogger.info(
              `[llm-for-zotero] Refreshed managed block: ${filename}`,
            );
            seeded.add(filename);
            continue;
          }
        }
        await io.write(filePath, encoder.encode(shippedContent));
        bodyHashes[filename] = shippedHash;
        appLogger.info(`[llm-for-zotero] Upgraded skill: ${filename}`);
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
