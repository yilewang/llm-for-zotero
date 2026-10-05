/**
 * One owner for remembering and recalling the active conversation of each
 * runtime, per library (global chat) and per paper.
 *
 * Every runtime keeps the same three pieces of selection state: an in-memory
 * "active" map, a persisted pointer (a pref for library chat, the paper
 * restore service for paper chat), and a per-library global/paper mode. The
 * runtimes differ only in which Map instance, which state-key builder, and
 * which pref wrapper they use, so each runtime is bound once in `ADAPTERS`.
 *
 * Persisted writes always go through the existing per-runtime wrappers; they
 * hold the key-range guards (Claude/Codex) and the webchat-isolation guard
 * (upstream). Upstream-only policies — the global lock, the sentinel remap,
 * and the key-band filter — stay with their callers.
 */
import type { ConversationSystem } from "../../shared/types";
import { invalidatePaperRestoreTargetCache } from "../../shared/paperConversationRestore";
import {
  getLastUsedClaudeConversationMode,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeConversationMode,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
  setLastUsedClaudeConversationMode,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "../../claudeCode/prefs";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  removeLastUsedCodexConversationMode,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "./state";
import {
  buildPaperStateKey,
  getLastUsedPaperConversationKey,
  getLastUsedUpstreamConversationMode,
  getLastUsedUpstreamGlobalConversationKey,
  removeLastUsedPaperConversationKey,
  removeLastUsedUpstreamConversationMode,
  removeLastUsedUpstreamGlobalConversationKey,
  setLastUsedPaperConversationKey,
  setLastUsedUpstreamConversationMode,
  setLastUsedUpstreamGlobalConversationKey,
} from "./prefHelpers";

export type ConversationSelectionMode = "global" | "paper";

export type GlobalSelectionScope = {
  system: ConversationSystem;
  libraryID: number;
  kind: "global";
};

export type PaperSelectionScope = {
  system: ConversationSystem;
  libraryID: number;
  kind: "paper";
  paperItemID: number;
};

export type SelectionScope = GlobalSelectionScope | PaperSelectionScope;

export type SelectionPrimeParams = {
  system: ConversationSystem;
  libraryID: number;
  mode: ConversationSelectionMode;
  conversationKey?: number;
  paperItemID?: number;
};

export type SelectionPrimeSnapshot = {
  restore: () => void;
};

/** One entry of one active map, with its state key already built. */
type Slot<V> = {
  has: () => boolean;
  get: () => V | undefined;
  set: (value: V) => void;
  delete: () => void;
};

type SelectionAdapter = {
  system: ConversationSystem;
  modeSlot: (libraryID: number) => Slot<ConversationSelectionMode>;
  globalSlot: (libraryID: number) => Slot<number>;
  paperSlot: (libraryID: number, paperItemID: number) => Slot<number>;
  getMode: (libraryID: number) => ConversationSelectionMode | null;
  setMode: (libraryID: number, mode: ConversationSelectionMode) => void;
  removeMode: (libraryID: number) => void;
  getGlobal: (libraryID: number) => number | null;
  setGlobal: (libraryID: number, conversationKey: number) => void;
  removeGlobal: (libraryID: number) => void;
  getPaper: (libraryID: number, paperItemID: number) => number | null;
  setPaper: (
    libraryID: number,
    paperItemID: number,
    conversationKey: number,
  ) => void;
  removePaper: (libraryID: number, paperItemID: number) => void;
};

function slot<K, V>(map: Map<K, V>, key: K): Slot<V> {
  return {
    has: () => map.has(key),
    get: () => map.get(key),
    set: (value) => {
      map.set(key, value);
    },
    delete: () => {
      map.delete(key);
    },
  };
}

// Upstream library maps key by the raw numeric library ID; Claude and Codex key
// by "<profile>:<library>". Paper maps key by "lib:paper" (upstream) or
// "<profile>:lib:paper" (Claude/Codex). The existing builders own those keys.
const ADAPTERS: Record<ConversationSystem, SelectionAdapter> = {
  upstream: {
    system: "upstream",
    modeSlot: (libraryID) => slot(activeConversationModeByLibrary, libraryID),
    globalSlot: (libraryID) =>
      slot(activeGlobalConversationByLibrary, libraryID),
    paperSlot: (libraryID, paperItemID) =>
      slot(
        activePaperConversationByPaper,
        buildPaperStateKey(libraryID, paperItemID),
      ),
    getMode: getLastUsedUpstreamConversationMode,
    setMode: setLastUsedUpstreamConversationMode,
    removeMode: removeLastUsedUpstreamConversationMode,
    getGlobal: getLastUsedUpstreamGlobalConversationKey,
    setGlobal: setLastUsedUpstreamGlobalConversationKey,
    removeGlobal: removeLastUsedUpstreamGlobalConversationKey,
    getPaper: getLastUsedPaperConversationKey,
    setPaper: setLastUsedPaperConversationKey,
    removePaper: removeLastUsedPaperConversationKey,
  },
  claude_code: {
    system: "claude_code",
    modeSlot: (libraryID) =>
      slot(
        activeClaudeConversationModeByLibrary,
        buildClaudeLibraryStateKey(libraryID),
      ),
    globalSlot: (libraryID) =>
      slot(
        activeClaudeGlobalConversationByLibrary,
        buildClaudeLibraryStateKey(libraryID),
      ),
    paperSlot: (libraryID, paperItemID) =>
      slot(
        activeClaudePaperConversationByPaper,
        buildClaudePaperStateKey(libraryID, paperItemID),
      ),
    getMode: getLastUsedClaudeConversationMode,
    setMode: setLastUsedClaudeConversationMode,
    removeMode: removeLastUsedClaudeConversationMode,
    getGlobal: getLastUsedClaudeGlobalConversationKey,
    setGlobal: setLastUsedClaudeGlobalConversationKey,
    removeGlobal: removeLastUsedClaudeGlobalConversationKey,
    getPaper: getLastUsedClaudePaperConversationKey,
    setPaper: setLastUsedClaudePaperConversationKey,
    removePaper: removeLastUsedClaudePaperConversationKey,
  },
  codex: {
    system: "codex",
    modeSlot: (libraryID) =>
      slot(
        activeCodexConversationModeByLibrary,
        buildCodexLibraryStateKey(libraryID),
      ),
    globalSlot: (libraryID) =>
      slot(
        activeCodexGlobalConversationByLibrary,
        buildCodexLibraryStateKey(libraryID),
      ),
    paperSlot: (libraryID, paperItemID) =>
      slot(
        activeCodexPaperConversationByPaper,
        buildCodexPaperStateKey(libraryID, paperItemID),
      ),
    getMode: getLastUsedCodexConversationMode,
    setMode: setLastUsedCodexConversationMode,
    removeMode: removeLastUsedCodexConversationMode,
    getGlobal: getLastUsedCodexGlobalConversationKey,
    setGlobal: setLastUsedCodexGlobalConversationKey,
    removeGlobal: removeLastUsedCodexGlobalConversationKey,
    getPaper: getLastUsedCodexPaperConversationKey,
    setPaper: setLastUsedCodexPaperConversationKey,
    removePaper: removeLastUsedCodexPaperConversationKey,
  },
};

function adapterFor(system: ConversationSystem): SelectionAdapter {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, system)
    ? ADAPTERS[system]
    : ADAPTERS.upstream;
}

function slotFor(scope: SelectionScope): Slot<number> {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? adapter.globalSlot(scope.libraryID)
    : adapter.paperSlot(scope.libraryID, scope.paperItemID);
}

/** The active (in-memory) conversation key for the scope, or 0. */
export function recallActive(scope: SelectionScope): number {
  return slotFor(scope).get() || 0;
}

/**
 * The persisted conversation key for the scope, validated by the runtime's
 * pref getter. Paper targets read null until the paper restore service has
 * initialized for that runtime.
 */
export function recallPersisted(scope: SelectionScope): number | null {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? adapter.getGlobal(scope.libraryID)
    : adapter.getPaper(scope.libraryID, scope.paperItemID);
}

/** Active key, else persisted key, else 0. */
export function recall(scope: SelectionScope): number {
  return recallActive(scope) || recallPersisted(scope) || 0;
}

/** True when either the active or the persisted pointer names `key`. */
export function isRemembered(scope: SelectionScope, key: number): boolean {
  return slotFor(scope).get() === key || recallPersisted(scope) === key;
}

/**
 * Remember `key` as the active conversation: the map first, then (unless
 * `persist` is false) the persisted pointer through the runtime's wrapper.
 */
export function remember(
  scope: SelectionScope,
  key: number,
  options: { persist?: boolean } = {},
): void {
  slotFor(scope).set(key);
  if (options.persist === false) return;
  const adapter = adapterFor(scope.system);
  if (scope.kind === "global") {
    adapter.setGlobal(scope.libraryID, key);
  } else {
    adapter.setPaper(scope.libraryID, scope.paperItemID, key);
  }
}

/**
 * Forget the scope's selection only where it still names `expectedKey`
 * (compare-and-delete). The global pref is removed only if it holds the key;
 * a paper restore target is invalidated in the restore cache (the registry row
 * is already gone), optionally only for `instanceID`.
 */
export function forget(
  scope: SelectionScope,
  options: { expectedKey: number; instanceID?: string },
): void {
  const { expectedKey } = options;
  const activeSlot = slotFor(scope);
  if (Math.floor(Number(activeSlot.get() || 0)) === expectedKey) {
    activeSlot.delete();
  }
  if (scope.kind === "global") {
    const adapter = adapterFor(scope.system);
    const persistedKey = Number(adapter.getGlobal(scope.libraryID) || 0);
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === expectedKey
    ) {
      adapter.removeGlobal(scope.libraryID);
    }
    return;
  }
  invalidatePaperRestoreTargetCache(
    {
      system: adapterFor(scope.system).system,
      libraryID: scope.libraryID,
      paperItemID: scope.paperItemID,
    },
    expectedKey,
    options.instanceID,
  );
}

/**
 * The remembered global/paper mode for a library, or null. `"active+persisted"`
 * reads the active map first; `"persisted"` reads only the pref. Callers own
 * any default (for example the upstream lock-implies-global rule).
 */
export function recallMode(
  system: ConversationSystem,
  libraryID: number,
  options: { source: "active+persisted" | "persisted" },
): ConversationSelectionMode | null {
  const adapter = adapterFor(system);
  if (options.source === "persisted") return adapter.getMode(libraryID);
  return adapter.modeSlot(libraryID).get() || adapter.getMode(libraryID);
}

/**
 * Remember the library mode: the active map first (unless `active` is false),
 * then the pref. Each runtime's pref setter keeps its own normalization.
 */
export function rememberMode(
  system: ConversationSystem,
  libraryID: number,
  mode: ConversationSelectionMode,
  options: { active?: boolean } = {},
): void {
  const adapter = adapterFor(system);
  if (options.active !== false) adapter.modeSlot(libraryID).set(mode);
  adapter.setMode(libraryID, mode);
}

type GuardedRestore = {
  isStillPrimed: () => boolean;
  restore: () => void;
};

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function isRestorableKey(value: number | null): value is number {
  return Boolean(value && value > 0);
}

function isRestorableMode(
  value: ConversationSelectionMode | null,
): value is ConversationSelectionMode {
  return value === "global" || value === "paper";
}

/**
 * Write `value` into one map slot and its persisted pointer, and return a
 * guarded restore of both. Order: snapshot the map, read the previous
 * persisted value, write the map, write the pref.
 */
function primeEntry<V>(params: {
  slot: Slot<V>;
  value: V;
  readPersisted: () => V | null;
  writePersisted: (value: V) => void;
  removePersisted: () => void;
  isRestorable: (value: V | null) => value is V;
}): GuardedRestore {
  const { slot: entry, value } = params;
  const hadValue = entry.has();
  const previousValue = entry.get();
  const previousPersisted = params.readPersisted();
  entry.set(value);
  params.writePersisted(value);
  return {
    isStillPrimed: () => entry.get() === value,
    restore: () => {
      if (hadValue) entry.set(previousValue as V);
      else entry.delete();
      if (params.isRestorable(previousPersisted)) {
        params.writePersisted(previousPersisted);
        return;
      }
      params.removePersisted();
    },
  };
}

/**
 * Pre-select the library mode (and the global or paper conversation) before a
 * history navigation, so the surfaces it triggers render the target. The
 * returned `restore()` undoes every primed entry, in reverse order, but only
 * if none of them has been changed since; a newer navigation always wins.
 */
export function prime(params: SelectionPrimeParams): SelectionPrimeSnapshot {
  const libraryID = normalizePositiveInt(params.libraryID);
  if (!libraryID) return { restore: () => undefined };

  const conversationKey = normalizePositiveInt(params.conversationKey);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  const mode: ConversationSelectionMode =
    params.mode === "global" ? "global" : "paper";
  const adapter = adapterFor(params.system);
  const restoreCallbacks: GuardedRestore[] = [];

  restoreCallbacks.push(
    primeEntry({
      slot: adapter.modeSlot(libraryID),
      value: mode,
      readPersisted: () => adapter.getMode(libraryID),
      writePersisted: (value) => adapter.setMode(libraryID, value),
      removePersisted: () => adapter.removeMode(libraryID),
      isRestorable: isRestorableMode,
    }),
  );

  if (mode === "global" && conversationKey) {
    restoreCallbacks.push(
      primeEntry({
        slot: adapter.globalSlot(libraryID),
        value: conversationKey,
        readPersisted: () => adapter.getGlobal(libraryID),
        writePersisted: (value) => adapter.setGlobal(libraryID, value),
        removePersisted: () => adapter.removeGlobal(libraryID),
        isRestorable: isRestorableKey,
      }),
    );
  } else if (mode === "paper" && conversationKey && paperItemID) {
    restoreCallbacks.push(
      primeEntry({
        slot: adapter.paperSlot(libraryID, paperItemID),
        value: conversationKey,
        readPersisted: () => adapter.getPaper(libraryID, paperItemID),
        writePersisted: (value) =>
          adapter.setPaper(libraryID, paperItemID, value),
        removePersisted: () => adapter.removePaper(libraryID, paperItemID),
        isRestorable: isRestorableKey,
      }),
    );
  }

  return {
    restore: () => {
      if (!restoreCallbacks.every(({ isStillPrimed }) => isStillPrimed())) {
        return;
      }
      for (const { restore } of [...restoreCallbacks].reverse()) restore();
    },
  };
}
