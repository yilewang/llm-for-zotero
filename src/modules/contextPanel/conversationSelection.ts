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
 *
 * Surfaces: every sidebar panel (the library item pane and each reader tab's
 * pane) is the "embedded" surface and shares one set of slots, exactly as
 * before. The standalone window is the "standalone" surface: it has its own
 * in-memory slots, so its choices never move a sidebar panel. Its reads fall
 * back to the embedded selection (active, then persisted) wherever it has not
 * chosen yet, and it never writes a pref: the persisted pointers stay the
 * sidebar's. A scope without `surface` is embedded.
 */
import type { ConversationSystem } from "../../shared/types";
import {
  claimMapRestore,
  clearMapRestores,
  invalidateMapRestore,
  type MapRestoreClaim,
} from "../../shared/mapRestoreOwnership";
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
  standaloneConversationModeByLibrary,
  standaloneGlobalConversationByLibrary,
  standalonePaperConversationByPaper,
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

/** Which chat surface a selection belongs to; see the module comment. */
export type SelectionSurface = "embedded" | "standalone";

export type GlobalSelectionScope = {
  system: ConversationSystem;
  libraryID: number;
  kind: "global";
  surface?: SelectionSurface;
};

export type PaperSelectionScope = {
  system: ConversationSystem;
  libraryID: number;
  kind: "paper";
  paperItemID: number;
  surface?: SelectionSurface;
};

export type SelectionScope = GlobalSelectionScope | PaperSelectionScope;

export type SelectionPrimeParams = {
  system: ConversationSystem;
  libraryID: number;
  mode: ConversationSelectionMode;
  conversationKey?: number;
  paperItemID?: number;
  surface?: SelectionSurface;
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
  invalidateRestore: () => void;
  prime: (value: V) => MapRestoreClaim;
  restoreSet: (value: V) => void;
  restoreDelete: () => void;
};

type SelectionAdapter = {
  system: ConversationSystem;
  /** The runtime's own key for a library / a paper in its maps. */
  libraryStateKey: (libraryID: number) => string | number;
  paperStateKey: (libraryID: number, paperItemID: number) => string;
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

// Slot wrappers are recreated for each call, so rollback ownership belongs to
// the underlying map/key. Value equality alone misses a newer same-value commit.
function slot<K, V>(map: Map<K, V>, key: K): Slot<V> {
  const invalidateRestore = () => invalidateMapRestore(map, key);
  return {
    has: () => map.has(key),
    get: () => map.get(key),
    set: (value) => {
      invalidateRestore();
      map.set(key, value);
    },
    delete: () => {
      invalidateRestore();
      map.delete(key);
    },
    invalidateRestore,
    prime: (value) => {
      const claim = claimMapRestore(map, key);
      map.set(key, value);
      return claim;
    },
    restoreSet: (value) => map.set(key, value),
    restoreDelete: () => map.delete(key),
  };
}

// Upstream library maps key by the raw numeric library ID; Claude and Codex key
// by "<profile>:<library>". Paper maps key by "lib:paper" (upstream) or
// "<profile>:lib:paper" (Claude/Codex). The existing builders own those keys.
const ADAPTERS: Record<ConversationSystem, SelectionAdapter> = {
  upstream: {
    system: "upstream",
    libraryStateKey: (libraryID) => libraryID,
    paperStateKey: buildPaperStateKey,
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
    libraryStateKey: buildClaudeLibraryStateKey,
    paperStateKey: buildClaudePaperStateKey,
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
    libraryStateKey: buildCodexLibraryStateKey,
    paperStateKey: buildCodexPaperStateKey,
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

function isStandaloneSurface(surface: SelectionSurface | undefined): boolean {
  return surface === "standalone";
}

// The standalone window's slots live in maps of their own, keyed by the
// runtime name plus the runtime's own state key.
function standaloneKey(
  adapter: SelectionAdapter,
  stateKey: string | number,
): string {
  return `${adapter.system}|${stateKey}`;
}

function standaloneModeSlot(
  adapter: SelectionAdapter,
  libraryID: number,
): Slot<ConversationSelectionMode> {
  return slot(
    standaloneConversationModeByLibrary,
    standaloneKey(adapter, adapter.libraryStateKey(libraryID)),
  );
}

function standaloneGlobalSlot(
  adapter: SelectionAdapter,
  libraryID: number,
): Slot<number> {
  return slot(
    standaloneGlobalConversationByLibrary,
    standaloneKey(adapter, adapter.libraryStateKey(libraryID)),
  );
}

function standalonePaperSlot(
  adapter: SelectionAdapter,
  libraryID: number,
  paperItemID: number,
): Slot<number> {
  return slot(
    standalonePaperConversationByPaper,
    standaloneKey(adapter, adapter.paperStateKey(libraryID, paperItemID)),
  );
}

/** The embedded (sidebar) active slot for the scope, whatever its surface. */
function embeddedSlotFor(scope: SelectionScope): Slot<number> {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? adapter.globalSlot(scope.libraryID)
    : adapter.paperSlot(scope.libraryID, scope.paperItemID);
}

/** The standalone window's active slot for the scope, whatever its surface. */
function standaloneSlotFor(scope: SelectionScope): Slot<number> {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? standaloneGlobalSlot(adapter, scope.libraryID)
    : standalonePaperSlot(adapter, scope.libraryID, scope.paperItemID);
}

/**
 * The active (in-memory) conversation key for the scope, or 0. The standalone
 * surface reads its own slot first, then the sidebar's.
 */
export function recallActive(scope: SelectionScope): number {
  if (isStandaloneSurface(scope.surface)) {
    return standaloneSlotFor(scope).get() || embeddedSlotFor(scope).get() || 0;
  }
  return embeddedSlotFor(scope).get() || 0;
}

/**
 * The persisted conversation key for the scope, validated by the runtime's
 * pref getter. Paper targets read null until the paper restore service has
 * initialized for that runtime. Both surfaces read the same (sidebar-owned)
 * pointer.
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

/**
 * True when any pointer names `key`: either surface's active slot or the
 * persisted pointer. A conversation either surface has chosen is legitimate.
 */
export function isRemembered(scope: SelectionScope, key: number): boolean {
  return (
    embeddedSlotFor(scope).get() === key ||
    standaloneSlotFor(scope).get() === key ||
    recallPersisted(scope) === key
  );
}

/**
 * Remember `key` as the active conversation: the map first, then (unless
 * `persist` is false) the persisted pointer through the runtime's wrapper.
 * The standalone surface writes its own slot only and never persists.
 */
export function remember(
  scope: SelectionScope,
  key: number,
  options: { persist?: boolean } = {},
): void {
  if (isStandaloneSurface(scope.surface)) {
    standaloneSlotFor(scope).set(key);
    return;
  }
  embeddedSlotFor(scope).set(key);
  if (options.persist === false) return;
  const adapter = adapterFor(scope.system);
  if (scope.kind === "global") {
    adapter.setGlobal(scope.libraryID, key);
  } else {
    adapter.setPaper(scope.libraryID, scope.paperItemID, key);
  }
}

/**
 * Record a conversation that provisioning resolved for a load. Provisioning
 * runs on every conversation load, from either surface, without knowing which
 * one asked, so it re-points only the selections that asked for it: each
 * surface whose pointer names `requestedKey` moves to `key` (the same key, or
 * the fresh key that replaced a retired one). The sidebar's pointer is also
 * written (and persisted) when it names `key` already or names nothing yet —
 * a sidebar that has chosen a different conversation keeps it. A sidebar that
 * names nothing is left alone when the window's own slot is the one that
 * asked: the window never writes the sidebar's saved chat.
 */
export function rememberProvisioned(
  scope: SelectionScope,
  requestedKey: number,
  key: number,
): void {
  const windowSlot = standaloneSlotFor(scope);
  const windowAsked = windowSlot.get() === requestedKey;
  if (windowAsked) windowSlot.set(key);
  const embeddedScope: SelectionScope = { ...scope, surface: "embedded" };
  const sidebarKey = recall(embeddedScope);
  if (!sidebarKey && windowAsked) return;
  if (!sidebarKey || sidebarKey === requestedKey || sidebarKey === key) {
    remember(embeddedScope, key);
  }
}

/**
 * Forget the scope's selection only where it still names `expectedKey`
 * (compare-and-delete), in both surfaces' active slots whatever the scope's
 * surface. The global pref is removed only if it holds the key; a paper
 * restore target is invalidated in the restore cache (the registry row is
 * already gone), optionally only for `instanceID`.
 */
export function forget(
  scope: SelectionScope,
  options: { expectedKey: number; instanceID?: string },
): void {
  const { expectedKey } = options;
  for (const activeSlot of [embeddedSlotFor(scope), standaloneSlotFor(scope)]) {
    if (Math.floor(Number(activeSlot.get() || 0)) === expectedKey) {
      activeSlot.delete();
    }
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
 * any default (for example the upstream lock-implies-global rule). The
 * standalone surface reads its own mode first, then the sidebar's.
 */
export function recallMode(
  system: ConversationSystem,
  libraryID: number,
  options: {
    source: "active+persisted" | "persisted";
    surface?: SelectionSurface;
  },
): ConversationSelectionMode | null {
  const adapter = adapterFor(system);
  if (options.source === "persisted") return adapter.getMode(libraryID);
  if (isStandaloneSurface(options.surface)) {
    const standaloneMode = standaloneModeSlot(adapter, libraryID).get();
    if (standaloneMode) return standaloneMode;
  }
  return adapter.modeSlot(libraryID).get() || adapter.getMode(libraryID);
}

/**
 * Remember the library mode: the active map first (unless `active` is false),
 * then the pref. Each runtime's pref setter keeps its own normalization. The
 * standalone surface writes its own mode only and never the pref.
 */
export function rememberMode(
  system: ConversationSystem,
  libraryID: number,
  mode: ConversationSelectionMode,
  options: { active?: boolean; surface?: SelectionSurface } = {},
): void {
  const adapter = adapterFor(system);
  if (isStandaloneSurface(options.surface)) {
    if (options.active !== false) {
      standaloneModeSlot(adapter, libraryID).set(mode);
    }
    return;
  }
  if (options.active !== false) adapter.modeSlot(libraryID).set(mode);
  else adapter.modeSlot(libraryID).invalidateRestore();
  adapter.setMode(libraryID, mode);
}

/**
 * Drop everything the standalone window has chosen. A newly opened window
 * starts from the sidebar's selection and diverges from there.
 */
export function clearStandaloneSelection(): void {
  clearMapRestores(standaloneConversationModeByLibrary);
  clearMapRestores(standaloneGlobalConversationByLibrary);
  clearMapRestores(standalonePaperConversationByPaper);
  standaloneConversationModeByLibrary.clear();
  standaloneGlobalConversationByLibrary.clear();
  standalonePaperConversationByPaper.clear();
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

type PersistedEntry<V> = {
  read: () => V | null;
  write: (value: V) => void;
  remove: () => void;
};

/**
 * Write `value` into one map slot and (when given) its persisted pointer, and
 * return a guarded restore of both. Order: snapshot the map, read the previous
 * persisted value, write the map, write the pref.
 */
function primeEntry<V>(params: {
  slot: Slot<V>;
  value: V;
  persisted: PersistedEntry<V> | null;
  isRestorable: (value: V | null) => value is V;
}): GuardedRestore {
  const { slot: entry, value, persisted } = params;
  const hadValue = entry.has();
  const previousValue = entry.get();
  const previousPersisted = persisted ? persisted.read() : null;
  const ownership = entry.prime(value);
  persisted?.write(value);
  return {
    isStillPrimed: () => ownership.isCurrent() && entry.get() === value,
    restore: () => {
      if (hadValue) entry.restoreSet(previousValue as V);
      else entry.restoreDelete();
      ownership.restorePrevious();
      if (!persisted) return;
      if (params.isRestorable(previousPersisted)) {
        persisted.write(previousPersisted);
        return;
      }
      persisted.remove();
    },
  };
}

/**
 * Pre-select the library mode (and the global or paper conversation) before a
 * history navigation, so the surfaces it triggers render the target. The
 * returned `restore()` undoes every primed entry, in reverse order, but only
 * if none of them has been changed since; a newer navigation always wins.
 * The standalone surface primes its own slots only, never a pref, so a window
 * navigation leaves the sidebar's selection alone.
 */
export function prime(params: SelectionPrimeParams): SelectionPrimeSnapshot {
  const libraryID = normalizePositiveInt(params.libraryID);
  if (!libraryID) return { restore: () => undefined };

  const conversationKey = normalizePositiveInt(params.conversationKey);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  const mode: ConversationSelectionMode =
    params.mode === "global" ? "global" : "paper";
  const adapter = adapterFor(params.system);
  const standalone = isStandaloneSurface(params.surface);
  const restoreCallbacks: GuardedRestore[] = [];

  restoreCallbacks.push(
    primeEntry({
      slot: standalone
        ? standaloneModeSlot(adapter, libraryID)
        : adapter.modeSlot(libraryID),
      value: mode,
      persisted: standalone
        ? null
        : {
            read: () => adapter.getMode(libraryID),
            write: (value) => adapter.setMode(libraryID, value),
            remove: () => adapter.removeMode(libraryID),
          },
      isRestorable: isRestorableMode,
    }),
  );

  if (mode === "global" && conversationKey) {
    restoreCallbacks.push(
      primeEntry({
        slot: standalone
          ? standaloneGlobalSlot(adapter, libraryID)
          : adapter.globalSlot(libraryID),
        value: conversationKey,
        persisted: standalone
          ? null
          : {
              read: () => adapter.getGlobal(libraryID),
              write: (value) => adapter.setGlobal(libraryID, value),
              remove: () => adapter.removeGlobal(libraryID),
            },
        isRestorable: isRestorableKey,
      }),
    );
  } else if (mode === "paper" && conversationKey && paperItemID) {
    restoreCallbacks.push(
      primeEntry({
        slot: standalone
          ? standalonePaperSlot(adapter, libraryID, paperItemID)
          : adapter.paperSlot(libraryID, paperItemID),
        value: conversationKey,
        persisted: standalone
          ? null
          : {
              read: () => adapter.getPaper(libraryID, paperItemID),
              write: (value) => adapter.setPaper(libraryID, paperItemID, value),
              remove: () => adapter.removePaper(libraryID, paperItemID),
            },
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
