import type { ConversationSystem } from "./types";

export type ConversationKeyKind = "global" | "paper";

export type ConversationKeyClassification = {
  system: ConversationSystem;
  kind: ConversationKeyKind;
};

export type ConversationKeyRange = {
  start: number;
  endExclusive: number;
};

export const UPSTREAM_PAPER_CONVERSATION_KEY_BASE = 1_500_000_000;
export const UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE = 2_000_000_000;
export const UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE = 2_500_000_000;
export const UPSTREAM_RUNTIME_CONVERSATION_KEY_END = 3_000_000_000;

export const RUNTIME_PROFILE_KEY_MULTIPLIER = 1_000_000_000;
export const RUNTIME_PROFILE_SLOT_MOD = 999_999;
export const RUNTIME_DEFAULT_CONVERSATION_KEY_OFFSET = 100_000_000;
export const RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET = 500_000_000;

export const CLAUDE_GLOBAL_CONVERSATION_KEY_BASE = 3_000_000_000_000_000;
export const CLAUDE_PAPER_CONVERSATION_KEY_BASE = 4_000_000_000_000_000;
export const CODEX_GLOBAL_CONVERSATION_KEY_BASE = 5_000_000_000_000_000;
export const CODEX_PAPER_CONVERSATION_KEY_BASE = 6_000_000_000_000_000;
/** Exclusive end of the Codex bands (the next system's bands start here). */
export const CODEX_CONVERSATION_KEY_END = 7_000_000_000_000_000;
export const ANTIGRAVITY_GLOBAL_CONVERSATION_KEY_BASE =
  CODEX_CONVERSATION_KEY_END;
export const ANTIGRAVITY_PAPER_CONVERSATION_KEY_BASE = 8_000_000_000_000_000;
// Still below Number.MAX_SAFE_INTEGER (~9.007e15): every key stays exact.
export const RUNTIME_CONVERSATION_KEY_END = 9_000_000_000_000_000;

type RuntimeConversationSystem = Exclude<ConversationSystem, "upstream">;

const RUNTIME_KIND_BASES: Record<
  RuntimeConversationSystem,
  Record<ConversationKeyKind, number>
> = {
  claude_code: {
    global: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
    paper: CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  },
  codex: {
    global: CODEX_GLOBAL_CONVERSATION_KEY_BASE,
    paper: CODEX_PAPER_CONVERSATION_KEY_BASE,
  },
  antigravity: {
    global: ANTIGRAVITY_GLOBAL_CONVERSATION_KEY_BASE,
    paper: ANTIGRAVITY_PAPER_CONVERSATION_KEY_BASE,
  },
};

// Each runtime kind band is exactly one profile-slot span wide.
const RUNTIME_KIND_BAND_WIDTH = 1_000_000_000_000_000;

function normalizeConversationKey(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeScopeId(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function containsKey(range: ConversationKeyRange, value: number): boolean {
  const normalized = normalizeConversationKey(value);
  return Boolean(
    normalized && normalized >= range.start && normalized < range.endExclusive,
  );
}

export function getProfileKeySlot(profileSignature?: string | null): number {
  const signature =
    typeof profileSignature === "string" ? profileSignature.trim() : "";
  const hex = signature.replace(/^profile-/, "");
  const parsed = Number.parseInt(hex, 16);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return (parsed % RUNTIME_PROFILE_SLOT_MOD) + 1;
}

export function getProfileKeyOffset(profileSignature?: string | null): number {
  return getProfileKeySlot(profileSignature) * RUNTIME_PROFILE_KEY_MULTIPLIER;
}

function fullKindRange(
  system: ConversationSystem,
  kind: ConversationKeyKind,
): ConversationKeyRange {
  if (system === "upstream") {
    return kind === "global"
      ? {
          start: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
          endExclusive: UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
        }
      : {
          start: 1,
          endExclusive: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
        };
  }
  const start = RUNTIME_KIND_BASES[system][kind];
  return { start, endExclusive: start + RUNTIME_KIND_BAND_WIDTH };
}

export function getConversationKeyRange(
  system: ConversationSystem,
  kind: ConversationKeyKind,
  profileSignature?: string | null,
): ConversationKeyRange {
  if (system === "upstream" || profileSignature === undefined) {
    return fullKindRange(system, kind);
  }
  const start =
    RUNTIME_KIND_BASES[system][kind] + getProfileKeyOffset(profileSignature);
  return {
    start,
    endExclusive: start + RUNTIME_PROFILE_KEY_MULTIPLIER,
  };
}

export function getRuntimeDefaultConversationKeyRange(
  system: Exclude<ConversationSystem, "upstream">,
  kind: ConversationKeyKind,
  profileSignature?: string | null,
): ConversationKeyRange {
  const range = getConversationKeyRange(system, kind, profileSignature || "");
  return {
    start: range.start + RUNTIME_DEFAULT_CONVERSATION_KEY_OFFSET,
    endExclusive: range.start + RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET,
  };
}

export function getRuntimeAllocatedConversationKeyRange(
  system: Exclude<ConversationSystem, "upstream">,
  kind: ConversationKeyKind,
  profileSignature?: string | null,
): ConversationKeyRange {
  const range = getConversationKeyRange(system, kind, profileSignature || "");
  return {
    start: range.start + RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET,
    endExclusive: range.endExclusive,
  };
}

export function buildDefaultConversationKey(
  system: ConversationSystem,
  kind: ConversationKeyKind,
  scopeId: number,
  profileSignature?: string | null,
): number {
  if (system === "upstream") {
    if (kind === "global") {
      return UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + normalizeScopeId(scopeId);
    }
    return normalizeScopeId(scopeId);
  }
  return (
    getRuntimeDefaultConversationKeyRange(system, kind, profileSignature || "")
      .start + normalizeScopeId(scopeId)
  );
}

export function buildDefaultUpstreamGlobalConversationKey(
  libraryID: number,
): number {
  return buildDefaultConversationKey("upstream", "global", libraryID);
}

export function classifyConversationKey(
  value: number,
): ConversationKeyClassification | null {
  const key = normalizeConversationKey(value);
  if (!key) return null;
  const systems: ConversationSystem[] = [
    "upstream",
    "claude_code",
    "codex",
    "antigravity",
  ];
  const kinds: ConversationKeyKind[] = ["global", "paper"];
  for (const system of systems) {
    for (const kind of kinds) {
      if (containsKey(fullKindRange(system, kind), key)) {
        return { system, kind };
      }
    }
  }
  return null;
}

export function isConversationKeyFor(
  system: ConversationSystem,
  key: number,
): boolean {
  return classifyConversationKey(key)?.system === system;
}

export function isConversationKeyForKind(
  system: ConversationSystem,
  kind: ConversationKeyKind,
  key: number,
): boolean {
  const classification = classifyConversationKey(key);
  return classification?.system === system && classification.kind === kind;
}

export function isRuntimeAllocatedConversationKeyForKind(
  system: Exclude<ConversationSystem, "upstream">,
  kind: ConversationKeyKind,
  key: number,
): boolean {
  if (!isConversationKeyForKind(system, kind, key)) return false;
  const base = RUNTIME_KIND_BASES[system][kind];
  const offsetWithinProfile =
    (Math.floor(key) - base) % RUNTIME_PROFILE_KEY_MULTIPLIER;
  return offsetWithinProfile >= RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET;
}

export function isConversationKeyInRange(
  key: number,
  range: ConversationKeyRange,
): boolean {
  return containsKey(range, key);
}
