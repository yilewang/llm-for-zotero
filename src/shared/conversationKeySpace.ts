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
export const RUNTIME_CONVERSATION_KEY_END = 7_000_000_000_000_000;

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
  if (system === "claude_code") {
    return kind === "global"
      ? {
          start: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
          endExclusive: CLAUDE_PAPER_CONVERSATION_KEY_BASE,
        }
      : {
          start: CLAUDE_PAPER_CONVERSATION_KEY_BASE,
          endExclusive: CODEX_GLOBAL_CONVERSATION_KEY_BASE,
        };
  }
  return kind === "global"
    ? {
        start: CODEX_GLOBAL_CONVERSATION_KEY_BASE,
        endExclusive: CODEX_PAPER_CONVERSATION_KEY_BASE,
      }
    : {
        start: CODEX_PAPER_CONVERSATION_KEY_BASE,
        endExclusive: RUNTIME_CONVERSATION_KEY_END,
      };
}

export function getConversationKeyRange(
  system: ConversationSystem,
  kind: ConversationKeyKind,
  profileSignature?: string | null,
): ConversationKeyRange {
  if (system === "upstream" || profileSignature === undefined) {
    return fullKindRange(system, kind);
  }
  const base =
    system === "claude_code"
      ? kind === "global"
        ? CLAUDE_GLOBAL_CONVERSATION_KEY_BASE
        : CLAUDE_PAPER_CONVERSATION_KEY_BASE
      : kind === "global"
        ? CODEX_GLOBAL_CONVERSATION_KEY_BASE
        : CODEX_PAPER_CONVERSATION_KEY_BASE;
  const start = base + getProfileKeyOffset(profileSignature);
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
  const systems: ConversationSystem[] = ["upstream", "claude_code", "codex"];
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
  const base =
    system === "claude_code"
      ? kind === "global"
        ? CLAUDE_GLOBAL_CONVERSATION_KEY_BASE
        : CLAUDE_PAPER_CONVERSATION_KEY_BASE
      : kind === "global"
        ? CODEX_GLOBAL_CONVERSATION_KEY_BASE
        : CODEX_PAPER_CONVERSATION_KEY_BASE;
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

// ---------------------------------------------------------------------------
// Ephemeral (never persisted) conversation keys
// ---------------------------------------------------------------------------
//
// A temporary side chat needs a conversation key that every chat path accepts
// (it classifies as an upstream paper or global key), but that no store ever
// writes. The top of each upstream range is reserved for these keys: real
// allocators stop below the band (capAllocationRangeEndBelowEphemeralBand),
// and isEphemeralConversationKey() is the stateless predicate every
// persistence path checks. Allocation is an in-memory counter only: no ledger
// row, no catalog row.

/** First key of the ephemeral paper band (upstream paper range top). */
export const EPHEMERAL_PAPER_CONVERSATION_KEY_BASE = 1_900_000_000;
/** First key of the ephemeral global band (upstream global range top). */
export const EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE = 2_900_000_000;

const EPHEMERAL_KEY_BANDS: ConversationKeyRange[] = [
  {
    start: EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
    endExclusive: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  },
  {
    start: EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
    endExclusive: UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
  },
];

/** True for a key from the reserved never-persisted band. */
export function isEphemeralConversationKey(value: number): boolean {
  if (typeof value !== "number") return false;
  return EPHEMERAL_KEY_BANDS.some((band) => containsKey(band, value));
}

/**
 * The end a real allocator may use for [start, endExclusive): lowered to the
 * start of an ephemeral band the range would otherwise reach.
 */
export function capAllocationRangeEndBelowEphemeralBand(
  start: number,
  endExclusive: number,
): number {
  let end = endExclusive;
  for (const band of EPHEMERAL_KEY_BANDS) {
    if (start < band.start && end > band.start) end = band.start;
  }
  return end;
}

// Each session starts at a random offset (well inside the band) so a key from
// an earlier session is unlikely to repeat; the counters restart at launch.
const EPHEMERAL_KEY_START_OFFSET_LIMIT = 50_000_000;
function randomStartOffset(): number {
  return Math.floor(Math.random() * EPHEMERAL_KEY_START_OFFSET_LIMIT);
}
let nextEphemeralPaperKeyOffset = randomStartOffset();
let nextEphemeralGlobalKeyOffset = randomStartOffset();

function allocateInBand(band: ConversationKeyRange, offset: number): number {
  const size = band.endExclusive - band.start;
  return band.start + (offset % size);
}

/** A fresh in-memory paper-kind key; nothing is written anywhere. */
export function allocateEphemeralPaperConversationKey(): number {
  const key = allocateInBand(
    EPHEMERAL_KEY_BANDS[0],
    nextEphemeralPaperKeyOffset,
  );
  nextEphemeralPaperKeyOffset += 1;
  return key;
}

/** A fresh in-memory global-kind key; nothing is written anywhere. */
export function allocateEphemeralGlobalConversationKey(): number {
  const key = allocateInBand(
    EPHEMERAL_KEY_BANDS[1],
    nextEphemeralGlobalKeyOffset,
  );
  nextEphemeralGlobalKeyOffset += 1;
  return key;
}
