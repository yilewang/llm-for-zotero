import { appLogger } from "../core/logging";
import {
  listCodexSkillProjections,
  syncCodexSkillProjections,
  type CodexSkillProjection,
  type CodexSkillProjectionResult,
} from "../agent/skills/codexSkillProjection";

/**
 * Codex sees only the Codex-only copy of a skill with runtime sections
 * (agent/skills/codexSkillProjection.ts):
 *
 * 1. Each turn or fork first syncs the copies from the canonical files.
 * 2. Each app-server process gets the copies' folder as its one extra skill
 *    root (`skills/extraRoots/set`), before its first thread request, and
 *    again whenever a copy changed (the request clears Codex's skill cache).
 *    The list lives in the process, so a respawned process gets it again.
 * 3. Each thread/start, thread/resume and thread/fork hides the canonical
 *    copies with `skills.config` path rules (`withCodexSkillDisableRules`).
 *    A name rule would hide both copies, since they share a name.
 *
 * If Codex rejects the request (an older app-server), the process is marked
 * unsupported and logged once; the turn then sends the marked skills it
 * selects through the stripped instruction block instead of skill items.
 * If the sync itself fails, a read-only scan still names the marked skills:
 * their canonical copies stay hidden and they go through the same block.
 */

export const CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD = "skills/extraRoots/set";

export type CodexSkillProjectionState = {
  root: string;
  projections: CodexSkillProjection[];
  /** Whether this process lists the Codex-only copies. */
  registered: boolean;
};

type ProjectionProcess = {
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
};

type ProcessRecord = { generation?: number; unsupported?: boolean };

const processRecords = new WeakMap<object, ProcessRecord>();
/** Bumped whenever a sync wrote or removed a copy. */
let projectionGeneration = 0;
let loggedUnsupported = false;
let loggedSyncFailure = false;

export async function prepareCodexSkillProjections(
  proc: ProjectionProcess,
  sync: () => Promise<CodexSkillProjectionResult> = () =>
    syncCodexSkillProjections(),
  scan: () => Promise<CodexSkillProjectionResult> = () =>
    listCodexSkillProjections(),
): Promise<CodexSkillProjectionState> {
  let result: CodexSkillProjectionResult;
  try {
    result = await sync();
  } catch (error) {
    if (!loggedSyncFailure) {
      loggedSyncFailure = true;
      appLogger.warn(
        "Codex app-server native: could not write the Codex-only skill copies",
        error,
      );
    }
    // The copies may be stale or missing, but the canonical files still carry
    // both runtime sections: keep them hidden (read-only scan) and send the
    // selected marked skills through the instruction block.
    try {
      const listed = await scan();
      return {
        root: listed.root,
        projections: listed.projections,
        registered: false,
      };
    } catch {
      return { root: "", projections: [], registered: false };
    }
  }
  if (result.changed) projectionGeneration += 1;
  let record = processRecords.get(proc);
  if (!record) {
    record = {};
    processRecords.set(proc, record);
  }
  const state = { root: result.root, projections: result.projections };
  // Nothing marked and nothing registered before: leave the process alone.
  if (!result.projections.length && record.generation === undefined)
    return { ...state, registered: false };
  if (record.unsupported) return { ...state, registered: false };
  if (record.generation === projectionGeneration)
    return { ...state, registered: true };
  const generation = projectionGeneration;
  try {
    await proc.sendRequest(CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD, {
      extraRoots: [result.root],
    });
    record.generation = generation;
    return { ...state, registered: true };
  } catch (error) {
    record.unsupported = true;
    if (!loggedUnsupported) {
      loggedUnsupported = true;
      appLogger.warn(
        "Codex app-server native: skills/extraRoots/set is unsupported; marked skills go through the instruction block",
        error,
      );
    }
    return { ...state, registered: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `config` plus a `skills.config` rule `{ path, enabled:false }` for each
 * path. Existing keys stay. Existing rules stay, in order, before the new
 * ones; a path that already has a rule keeps it. A nested `skills` object
 * gets the rules in its `config` list, so its other keys stay with it. A
 * `skills.config` value that is not a list is left unchanged, without the
 * rules. Pure; the input is not changed.
 */
export function withCodexSkillDisableRules(
  config: Record<string, unknown> | undefined,
  paths: readonly string[],
): Record<string, unknown> | undefined {
  if (!paths.length) return config;
  const merge = (existing: unknown): unknown[] | undefined => {
    if (existing !== undefined && !Array.isArray(existing)) return undefined;
    const list = [...((existing as unknown[] | undefined) || [])];
    for (const path of paths) {
      if (!list.some((entry) => isPlainObject(entry) && entry.path === path))
        list.push({ path, enabled: false });
    }
    return list;
  };
  const next: Record<string, unknown> = { ...(config || {}) };
  if ("skills.config" in next) {
    const merged = merge(next["skills.config"]);
    if (merged) next["skills.config"] = merged;
    return next;
  }
  if (isPlainObject(next.skills)) {
    const merged = merge(next.skills.config);
    if (merged) next.skills = { ...next.skills, config: merged };
    return next;
  }
  next["skills.config"] = merge(undefined);
  return next;
}

/** Forget every process registration and logged warning (tests). */
export function resetCodexSkillProjectionStateForTests(): void {
  projectionGeneration = 0;
  loggedUnsupported = false;
  loggedSyncFailure = false;
}
