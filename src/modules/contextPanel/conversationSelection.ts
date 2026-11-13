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
 *
 * Each torn-off chat window is a "torn:<id>" surface with slots of its own,
 * apart from the standalone window's and from every other torn window's. Its
 * reads fall back to the standalone window's selection, then the embedded
 * one; like the standalone window it never writes a pref.
 *
 * The standalone window's temporary side chat is the "side" surface (a torn
 * window has no side chats). It reads like the standalone window (its own key
 * is fixed, so reads are informational) and writes no slot and no pref:
 * remembering a side chat's conversation is a no-op. Only the embedded
 * surface writes prefs.
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
  standaloneConversationModeByLibrary,
  standaloneGlobalConversationByLibrary,
  standalonePaperConversationByPaper,
  tornGlobalByLibrary,
  tornModeByLibrary,
  tornPaperByPaper,
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

/** A torn-off chat window; the ID never contains "|". */
export type TornSurface = `torn:${string}`;

/** Which chat surface a selection belongs to; see the module comment. */
export type SelectionSurface = "embedded" | "standalone" | "side" | TornSurface;

/** The surfaces with slots of their own: the standalone and torn windows. */
export type WindowSurface = "standalone" | TornSurface;

/** A surface sorted by kind, carrying its narrowed value. */
export type ClassifiedSurface =
  | { kind: "embedded" }
  | { kind: "standalone" }
  | { kind: "side" }
  | { kind: "torn"; surface: TornSurface };

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

export function isTornSurface(
  surface: SelectionSurface | undefined,
): surface is TornSurface {
  return typeof surface === "string" && surface.startsWith("torn:");
}

/** The side chat remembers nothing, in memory or in prefs. */
export function isSideSurface(
  surface: SelectionSurface | undefined,
): surface is "side" {
  return surface === "side";
}

/** Sort a surface by kind; a scope without a surface is embedded. */
export function classifySurface(
  surface: SelectionSurface | undefined,
): ClassifiedSurface {
  if (surface === undefined || surface === "embedded") {
    return { kind: "embedded" };
  }
  if (surface === "standalone") return { kind: "standalone" };
  if (isSideSurface(surface)) return { kind: "side" };
  return { kind: "torn", surface };
}

/** The exhaustiveness check for a switch over ClassifiedSurface kinds. */
export function unhandledSurface(surface: never): never {
  throw new Error(`Unhandled selection surface: ${JSON.stringify(surface)}`);
}

/**
 * A surface name read from the DOM (`data-selection-surface`), or null when
 * it names none. Torn window IDs must be non-empty and free of "|".
 */
export function parseSelectionSurface(value: unknown): SelectionSurface | null {
  if (value === "embedded" || value === "standalone" || value === "side") {
    return value;
  }
  if (typeof value !== "string" || !/^torn:[^|]+$/.test(value)) {
    return null;
  }
  return value as TornSurface;
}

/** The window whose slots the surface reads first, or null for the sidebar. */
function windowOf(surface: ClassifiedSurface): WindowSurface | null {
  switch (surface.kind) {
    case "embedded":
      return null;
    case "standalone":
      return "standalone";
    case "torn":
      return surface.surface;
    case "side":
      return "standalone";
    default:
      return unhandledSurface(surface);
  }
}

/** A torn window's slots first, then the standalone window's. */
function windowReadOrder(window: WindowSurface): WindowSurface[] {
  return window === "standalone" ? ["standalone"] : [window, "standalone"];
}

// The standalone window's slots live in maps of their own, keyed by the
// runtime name plus the runtime's own state key. Torn windows share three more
// maps, keyed by the torn surface plus that same key.
function standaloneKey(
  adapter: SelectionAdapter,
  stateKey: string | number,
): string {
  return `${adapter.system}|${stateKey}`;
}

function windowKey(
  window: WindowSurface,
  adapter: SelectionAdapter,
  stateKey: string | number,
): string {
  const key = standaloneKey(adapter, stateKey);
  return window === "standalone" ? key : `${window}|${key}`;
}

function windowModeSlot(
  window: WindowSurface,
  adapter: SelectionAdapter,
  libraryID: number,
): Slot<ConversationSelectionMode> {
  return slot(
    window === "standalone"
      ? standaloneConversationModeByLibrary
      : tornModeByLibrary,
    windowKey(window, adapter, adapter.libraryStateKey(libraryID)),
  );
}

function windowGlobalSlot(
  window: WindowSurface,
  adapter: SelectionAdapter,
  libraryID: number,
): Slot<number> {
  return slot(
    window === "standalone"
      ? standaloneGlobalConversationByLibrary
      : tornGlobalByLibrary,
    windowKey(window, adapter, adapter.libraryStateKey(libraryID)),
  );
}

function windowPaperSlot(
  window: WindowSurface,
  adapter: SelectionAdapter,
  libraryID: number,
  paperItemID: number,
): Slot<number> {
  return slot(
    window === "standalone"
      ? standalonePaperConversationByPaper
      : tornPaperByPaper,
    windowKey(window, adapter, adapter.paperStateKey(libraryID, paperItemID)),
  );
}

/** The embedded (sidebar) active slot for the scope, whatever its surface. */
function embeddedSlotFor(scope: SelectionScope): Slot<number> {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? adapter.globalSlot(scope.libraryID)
    : adapter.paperSlot(scope.libraryID, scope.paperItemID);
}

/** One window's active slot for the scope, whatever the scope's surface. */
function windowSlotFor(
  window: WindowSurface,
  scope: SelectionScope,
): Slot<number> {
  const adapter = adapterFor(scope.system);
  return scope.kind === "global"
    ? windowGlobalSlot(window, adapter, scope.libraryID)
    : windowPaperSlot(window, adapter, scope.libraryID, scope.paperItemID);
}

/** Every torn window's slot that holds a key for the scope. */
function tornSlotsFor(scope: SelectionScope): Slot<number>[] {
  const adapter = adapterFor(scope.system);
  const map = scope.kind === "global" ? tornGlobalByLibrary : tornPaperByPaper;
  const scopeKey = standaloneKey(
    adapter,
    scope.kind === "global"
      ? adapter.libraryStateKey(scope.libraryID)
      : adapter.paperStateKey(scope.libraryID, scope.paperItemID),
  );
  const slots: Slot<number>[] = [];
  for (const key of map.keys()) {
    if (key.slice(key.indexOf("|") + 1) === scopeKey) {
      slots.push(slot(map, key));
    }
  }
  return slots;
}

/** Every window's active slot for the scope: the standalone window's, then each torn window's. */
function allWindowSlotsFor(scope: SelectionScope): Slot<number>[] {
  return [windowSlotFor("standalone", scope), ...tornSlotsFor(scope)];
}

/** The window's own choice, then each window it falls back to, then the sidebar's. */
function recallWindowActive(
  window: WindowSurface,
  scope: SelectionScope,
): number {
  for (const surface of windowReadOrder(window)) {
    const key = windowSlotFor(surface, scope).get();
    if (key) return key;
  }
  return embeddedSlotFor(scope).get() || 0;
}

/**
 * The active (in-memory) conversation key for the scope, or 0. A window reads
 * its own slot first (a torn window then the standalone window's), then the
 * sidebar's; a side chat reads like the standalone window.
 */
export function recallActive(scope: SelectionScope): number {
  const surface = classifySurface(scope.surface);
  switch (surface.kind) {
    case "embedded":
      return embeddedSlotFor(scope).get() || 0;
    case "standalone":
      return recallWindowActive("standalone", scope);
    case "torn":
      return recallWindowActive(surface.surface, scope);
    case "side":
      return recallWindowActive("standalone", scope);
    default:
      return unhandledSurface(surface);
  }
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
 * True when any pointer names `key`: any surface's active slot (the sidebar's
 * or any window's) or the persisted pointer. A conversation any surface has
 * chosen is legitimate.
 */
export function isRemembered(scope: SelectionScope, key: number): boolean {
  return (
    embeddedSlotFor(scope).get() === key ||
    allWindowSlotsFor(scope).some((windowSlot) => windowSlot.get() === key) ||
    recallPersisted(scope) === key
  );
}

/**
 * Remember `key` as the active conversation: the map first, then (unless
 * `persist` is false) the persisted pointer through the runtime's wrapper.
 * A window writes its own slot only and never persists; a side chat writes
 * nothing.
 */
export function remember(
  scope: SelectionScope,
  key: number,
  options: { persist?: boolean } = {},
): void {
  const surface = classifySurface(scope.surface);
  switch (surface.kind) {
    case "side":
      return;
    case "standalone":
      windowSlotFor("standalone", scope).set(key);
      return;
    case "torn":
      windowSlotFor(surface.surface, scope).set(key);
      return;
    case "embedded":
      break;
    default:
      unhandledSurface(surface);
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
 * runs on every conversation load, from any surface, without knowing which
 * one asked, so it re-points only the selections that asked for it: each
 * surface whose pointer names `requestedKey` moves to `key` (the same key, or
 * the fresh key that replaced a retired one). The sidebar's pointer is also
 * written (and persisted) when it names `key` already or names nothing yet —
 * a sidebar that has chosen a different conversation keeps it. A sidebar that
 * names nothing is left alone when a window's own slot is the one that
 * asked: a window never writes the sidebar's saved chat.
 */
export function rememberProvisioned(
  scope: SelectionScope,
  requestedKey: number,
  key: number,
): void {
  let windowAsked = false;
  for (const windowSlot of allWindowSlotsFor(scope)) {
    if (windowSlot.get() !== requestedKey) continue;
    windowSlot.set(key);
    windowAsked = true;
  }
  const embeddedScope: SelectionScope = { ...scope, surface: "embedded" };
  const sidebarKey = recall(embeddedScope);
  if (!sidebarKey && windowAsked) return;
  if (!sidebarKey || sidebarKey === requestedKey || sidebarKey === key) {
    remember(embeddedScope, key);
  }
}

/**
 * Forget the scope's selection only where it still names `expectedKey`
 * (compare-and-delete), in every surface's active slots whatever the scope's
 * surface. The global pref is removed only if it holds the key; a paper
 * restore target is invalidated in the restore cache (the registry row is
 * already gone), optionally only for `instanceID`.
 */
export function forget(
  scope: SelectionScope,
  options: { expectedKey: number; instanceID?: string },
): void {
  const { expectedKey } = options;
  for (const activeSlot of [
    embeddedSlotFor(scope),
    ...allWindowSlotsFor(scope),
  ]) {
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
 * any default (for example the upstream lock-implies-global rule). A window
 * reads its own mode first (a torn window then the standalone window's), then
 * the sidebar's; a side chat reads like the standalone window.
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
  const window = windowOf(classifySurface(options.surface));
  for (const surface of window ? windowReadOrder(window) : []) {
    const windowMode = windowModeSlot(surface, adapter, libraryID).get();
    if (windowMode) return windowMode;
  }
  return adapter.modeSlot(libraryID).get() || adapter.getMode(libraryID);
}

/**
 * Remember the library mode: the active map first (unless `active` is false),
 * then the pref. Each runtime's pref setter keeps its own normalization. A
 * window writes its own mode only and never the pref.
 */
export function rememberMode(
  system: ConversationSystem,
  libraryID: number,
  mode: ConversationSelectionMode,
  options: { active?: boolean; surface?: SelectionSurface } = {},
): void {
  if (isSideSurface(options.surface)) return;
  const adapter = adapterFor(system);
  const window = windowOf(classifySurface(options.surface));
  if (window) {
    if (options.active !== false) {
      windowModeSlot(window, adapter, libraryID).set(mode);
    }
    return;
  }
  if (options.active !== false) adapter.modeSlot(libraryID).set(mode);
  adapter.setMode(libraryID, mode);
}

/**
 * Drop everything the standalone window has chosen. A newly opened window
 * starts from the sidebar's selection and diverges from there. Torn windows
 * keep their own.
 */
export function clearStandaloneSelection(): void {
  standaloneConversationModeByLibrary.clear();
  standaloneGlobalConversationByLibrary.clear();
  standalonePaperConversationByPaper.clear();
}

/** Drop everything one torn window has chosen; other windows keep theirs. */
export function clearTornSelection(surface: TornSurface): void {
  for (const map of [
    tornModeByLibrary,
    tornGlobalByLibrary,
    tornPaperByPaper,
  ] as Map<string, unknown>[]) {
    for (const key of Array.from(map.keys())) {
      if (key.slice(0, key.indexOf("|")) === surface) map.delete(key);
    }
  }
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
  entry.set(value);
  persisted?.write(value);
  return {
    isStillPrimed: () => entry.get() === value,
    restore: () => {
      if (hadValue) entry.set(previousValue as V);
      else entry.delete();
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
 * A window primes its own slots only, never a pref, so a window navigation
 * leaves the sidebar's selection alone.
 */
export function prime(params: SelectionPrimeParams): SelectionPrimeSnapshot {
  const libraryID = normalizePositiveInt(params.libraryID);
  if (!libraryID) return { restore: () => undefined };
  // The side chat selects nothing (see isSideSurface).
  if (isSideSurface(params.surface)) return { restore: () => undefined };

  const conversationKey = normalizePositiveInt(params.conversationKey);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  const mode: ConversationSelectionMode =
    params.mode === "global" ? "global" : "paper";
  const adapter = adapterFor(params.system);
  const window = windowOf(classifySurface(params.surface));
  const restoreCallbacks: GuardedRestore[] = [];

  restoreCallbacks.push(
    primeEntry({
      slot: window
        ? windowModeSlot(window, adapter, libraryID)
        : adapter.modeSlot(libraryID),
      value: mode,
      persisted: window
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
        slot: window
          ? windowGlobalSlot(window, adapter, libraryID)
          : adapter.globalSlot(libraryID),
        value: conversationKey,
        persisted: window
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
        slot: window
          ? windowPaperSlot(window, adapter, libraryID, paperItemID)
          : adapter.paperSlot(libraryID, paperItemID),
        value: conversationKey,
        persisted: window
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
