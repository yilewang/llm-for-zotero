/**
 * The conversation systems the plugin knows, and the per-system facts that
 * do not depend on any runtime's implementation.
 *
 * A conversation system is where a conversation lives and which engine runs
 * it: "upstream" is the plugin's own agent; every other system is an external
 * agent runtime (Claude Code, Codex, Antigravity). This module is the single list of them.
 *
 * Rules for code that branches on a system:
 * - Membership tests use `isConversationSystem` / `isRuntimeConversationSystem`,
 *   never a hand-written `=== "upstream" || === "claude_code" || ...` chain.
 * - Per-system data lives in the descriptor table below, or in a
 *   `Record<RuntimeConversationSystem, T>` next to its owner, so adding a
 *   system fails to compile until every table names it.
 * - Per-system behavior uses an exhaustive `switch` ending in
 *   `assertNeverConversationSystem`, never an `else` that silently means
 *   "the other runtime".
 * - A positive test such as `system === "codex"` is fine when its `else` is
 *   the neutral, runtime-independent behavior.
 */

export const CONVERSATION_SYSTEMS = [
  "upstream",
  "claude_code",
  "codex",
  "antigravity",
] as const;

export type ConversationSystem = (typeof CONVERSATION_SYSTEMS)[number];

/** A system run by an external agent runtime (everything but "upstream"). */
export type RuntimeConversationSystem = Exclude<ConversationSystem, "upstream">;

export const RUNTIME_CONVERSATION_SYSTEMS: readonly RuntimeConversationSystem[] =
  CONVERSATION_SYSTEMS.filter(
    (system): system is RuntimeConversationSystem => system !== "upstream",
  );

/** One value per runtime, in registry order. */
export function mapRuntimeConversationSystems<T>(
  value: (system: RuntimeConversationSystem) => T,
): Record<RuntimeConversationSystem, T> {
  return Object.fromEntries(
    RUNTIME_CONVERSATION_SYSTEMS.map((system) => [system, value(system)]),
  ) as Record<RuntimeConversationSystem, T>;
}

export function isConversationSystem(
  value: unknown,
): value is ConversationSystem {
  return (
    typeof value === "string" &&
    (CONVERSATION_SYSTEMS as readonly string[]).includes(value)
  );
}

export function isRuntimeConversationSystem(
  value: unknown,
): value is RuntimeConversationSystem {
  return isConversationSystem(value) && value !== "upstream";
}

/** Trims and lower-cases a stored value; null when it names no system. */
export function normalizeConversationSystem(
  value: unknown,
): ConversationSystem | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isConversationSystem(normalized) ? normalized : null;
}

/** Ends an exhaustive `switch` over systems; a new system fails to compile. */
export function assertNeverConversationSystem(value: never): never {
  throw new Error(`Unhandled conversation system: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Runtime descriptors
// ---------------------------------------------------------------------------

/**
 * Width of one key band. Each runtime owns a global band and a paper band;
 * see conversationKeySpace.ts for how a band is split by profile.
 */
export const RUNTIME_CONVERSATION_KEY_BAND_SIZE = 1_000_000_000_000_000;

export type RuntimeConversationSystemDescriptor = {
  system: RuntimeConversationSystem;
  /** Full product name, e.g. in history sources and accessible labels. */
  label: string;
  /** Compact name for badges, sidebar groups, and history rows. */
  shortLabel: string;
  /** Boolean pref (without the plugin prefix) that turns the mode on. */
  enablePref: string;
  /** First key of the runtime's global and paper key bands. Persisted. */
  keyBases: { global: number; paper: number };
  /** Reader-model slot the runtime's reader selection is stored under. */
  readerRuntimeKey: "claude" | "codex" | "antigravity";
  /** Permission-chip provider id. */
  permissionProvider: "claude" | "codex" | "antigravity";
  /** Usage-ledger runtime name (`UsageEventRuntime`). Persisted. */
  usageSource: "claude-code" | "codex" | "antigravity";
  /**
   * What runs a turn. `external_turn_host`: the shared external-runtime turn
   * host (agent/externalRuntimeTurnHost.ts), which takes the plugin's paper
   * context and Zotero MCP tools and sends slash messages to the runtime as
   * its own commands. `codex_app_server`: Codex's native app-server path.
   */
  engine: "external_turn_host" | "codex_app_server";
};

export const RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS: Readonly<
  Record<RuntimeConversationSystem, RuntimeConversationSystemDescriptor>
> = {
  claude_code: {
    system: "claude_code",
    label: "Claude Code",
    shortLabel: "Claude",
    enablePref: "enableClaudeCodeMode",
    keyBases: {
      global: 3 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
      paper: 4 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
    },
    readerRuntimeKey: "claude",
    permissionProvider: "claude",
    usageSource: "claude-code",
    engine: "external_turn_host",
  },
  codex: {
    system: "codex",
    label: "Codex",
    shortLabel: "Codex",
    enablePref: "enableCodexAppServerMode",
    keyBases: {
      global: 5 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
      paper: 6 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
    },
    readerRuntimeKey: "codex",
    permissionProvider: "codex",
    usageSource: "codex",
    engine: "codex_app_server",
  },
  antigravity: {
    system: "antigravity",
    label: "Antigravity",
    shortLabel: "Antigravity",
    enablePref: "enableAntigravityMode",
    // The last two bands below Number.MAX_SAFE_INTEGER; no fifth runtime fits.
    keyBases: {
      global: 7 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
      paper: 8 * RUNTIME_CONVERSATION_KEY_BAND_SIZE,
    },
    readerRuntimeKey: "antigravity",
    permissionProvider: "antigravity",
    usageSource: "antigravity",
    engine: "external_turn_host",
  },
};

/** True for a runtime whose turns run through the external turn host. */
export function usesExternalTurnHost(
  system: RuntimeConversationSystem | null | undefined,
): boolean {
  return Boolean(
    system &&
    RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].engine ===
      "external_turn_host",
  );
}

export function getRuntimeConversationSystemDescriptor(
  system: RuntimeConversationSystem,
): RuntimeConversationSystemDescriptor {
  return RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system];
}

/** The runtime whose permission-chip provider id this is, if any. */
export function runtimeConversationSystemForPermissionProvider(
  provider: string,
): RuntimeConversationSystem | null {
  return (
    RUNTIME_CONVERSATION_SYSTEMS.find(
      (system) =>
        RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].permissionProvider ===
        provider,
    ) ?? null
  );
}
