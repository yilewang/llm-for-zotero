import { joinLocalPath } from "../../utils/localPath";
import {
  NATIVE_SKILL_FILE_NAME,
  getCanonicalUserSkillsDir,
  getCodexSkillProjectionDir,
} from "./nativeSkillPaths";
import { hasSkillRuntimeMarker, skillBodyForRuntime } from "./runtimeSections";

/**
 * Codex-only copies of skills with runtime sections.
 *
 * In native skill mode Codex reads each SKILL.md from disk itself, so the
 * per-runtime stripping of runtimeSections.ts cannot run at delivery. For
 * every canonical skill whose file holds a runtime marker, this writes the
 * file as Codex should read it (frontmatter kept, the `codex` section kept,
 * every other section removed) under `getCodexSkillProjectionDir()`. The
 * Codex client registers that folder as an extra skill root and hides the
 * canonical copy per thread (codexAppServer/skillProjection.ts).
 *
 * The canonical file is read each time, so a user's edit applies on the
 * next turn. Unmarked skills get no copy and keep their native path.
 */

export type CodexSkillProjectionIO = {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write: (path: string, data: Uint8Array) => Promise<number>;
  makeDirectory: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  getChildren: (path: string) => Promise<string[]>;
  remove: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
};

export type CodexSkillProjection = {
  skillId: string;
  /** The user's copy, which Codex would otherwise discover from its cwd. */
  canonicalPath: string;
  /** The Codex-only copy under the projection folder. */
  projectedPath: string;
};

export type CodexSkillProjectionResult = {
  /** The projection folder, the extra skill root to register. */
  root: string;
  /** One entry per marked skill, by skill id. */
  projections: CodexSkillProjection[];
  /** Whether this call wrote or removed a copy. */
  changed: boolean;
};

const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function getIOUtils(): CodexSkillProjectionIO | undefined {
  const io = (globalThis as unknown as { IOUtils?: CodexSkillProjectionIO })
    .IOUtils;
  return io &&
    typeof io.read === "function" &&
    typeof io.write === "function" &&
    typeof io.getChildren === "function"
    ? io
    : undefined;
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

async function readText(
  io: CodexSkillProjectionIO,
  path: string,
): Promise<string | null> {
  try {
    const data = await io.read(path);
    return new TextDecoder("utf-8").decode(
      data instanceof Uint8Array ? data : new Uint8Array(data),
    );
  } catch {
    return null;
  }
}

async function children(
  io: CodexSkillProjectionIO,
  path: string,
): Promise<string[]> {
  try {
    if (!(await io.exists(path))) return [];
    return await io.getChildren(path);
  } catch {
    return [];
  }
}

type MarkedSkill = CodexSkillProjection & { raw: string };

/** Read only: each canonical skill whose file holds a runtime marker. */
async function scanMarkedSkills(
  io: CodexSkillProjectionIO,
  canonicalDir: string,
  root: string,
): Promise<MarkedSkill[]> {
  const marked: MarkedSkill[] = [];
  for (const child of await children(io, canonicalDir)) {
    const skillId = lastSegment(child);
    if (!SAFE_SKILL_ID.test(skillId)) continue;
    const canonicalPath = joinLocalPath(child, NATIVE_SKILL_FILE_NAME);
    const raw = await readText(io, canonicalPath);
    if (raw === null || !hasSkillRuntimeMarker(raw)) continue;
    const projectedPath = joinLocalPath(
      joinLocalPath(root, skillId),
      NATIVE_SKILL_FILE_NAME,
    );
    marked.push({ skillId, canonicalPath, projectedPath, raw });
  }
  return marked;
}

/**
 * The marked skills and their paths, with nothing written or removed. The
 * client uses it when a sync fails, so the canonical copies stay hidden from
 * Codex and the marked skills go through the stripped instruction block.
 */
export async function listCodexSkillProjections(
  options: {
    io?: CodexSkillProjectionIO;
    canonicalDir?: string;
    projectionDir?: string;
  } = {},
): Promise<CodexSkillProjectionResult> {
  const io = options.io || getIOUtils();
  const root = options.projectionDir || getCodexSkillProjectionDir();
  if (!io) return { root, projections: [], changed: false };
  const canonicalDir = options.canonicalDir || getCanonicalUserSkillsDir();
  const marked = await scanMarkedSkills(io, canonicalDir, root);
  const projections = marked.map(({ raw: _raw, ...entry }) => entry);
  projections.sort((left, right) => left.skillId.localeCompare(right.skillId));
  return { root, projections, changed: false };
}

/**
 * Bring the projection folder in line with the canonical skills: write each
 * marked skill's Codex copy when its content differs, and remove copies
 * whose skill is gone or no longer marked. Without IOUtils (tests, or a host
 * without file access) it does nothing and reports no projection.
 */
export async function syncCodexSkillProjections(
  options: {
    io?: CodexSkillProjectionIO;
    canonicalDir?: string;
    projectionDir?: string;
  } = {},
): Promise<CodexSkillProjectionResult> {
  const io = options.io || getIOUtils();
  const root = options.projectionDir || getCodexSkillProjectionDir();
  if (!io) return { root, projections: [], changed: false };
  const canonicalDir = options.canonicalDir || getCanonicalUserSkillsDir();
  const projections: CodexSkillProjection[] = [];
  let changed = false;
  for (const { raw, ...entry } of await scanMarkedSkills(
    io,
    canonicalDir,
    root,
  )) {
    const content = skillBodyForRuntime(raw, "codex");
    if ((await readText(io, entry.projectedPath)) !== content) {
      await io.makeDirectory(joinLocalPath(root, entry.skillId), {
        createAncestors: true,
        ignoreExisting: true,
      });
      await io.write(entry.projectedPath, new TextEncoder().encode(content));
      changed = true;
    }
    projections.push(entry);
  }
  const kept = new Set(projections.map((entry) => entry.skillId));
  for (const child of await children(io, root)) {
    if (kept.has(lastSegment(child))) continue;
    await io.remove(child, { recursive: true, ignoreAbsent: true });
    changed = true;
  }
  projections.sort((left, right) => left.skillId.localeCompare(right.skillId));
  return { root, projections, changed };
}
