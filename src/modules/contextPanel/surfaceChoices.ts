/**
 * The model and backend each chat surface has chosen.
 *
 * Surfaces are the ones conversationSelection.ts defines: every sidebar panel
 * (the library item pane and each reader tab) is "embedded"; the standalone
 * window is "standalone".
 *
 * - Embedded reads and writes the existing prefs exactly as before, so the
 *   sidebar panels keep sharing one choice and it survives a restart.
 * - Standalone keeps its choices in memory, for the window's lifetime. It
 *   never writes these prefs. Opening a window copies the sidebar's current
 *   values into the window's store (startStandaloneSurfaceChoicesFromSidebar),
 *   so a new window starts from the sidebar's values and afterwards the two
 *   are independent: a later sidebar change does not move an untouched window.
 *   Without that copy (no window opened yet) a standalone read falls back to
 *   the sidebar's (persisted) value.
 *
 * The choices covered: the model entry (and with it WebChat mode, which is a
 * property of the entry), the conversation system (API / Claude Code /
 * Codex), the Claude Code and Codex runtime model and reasoning effort, the
 * last-used reasoning levels the API model menu falls back to, the Codex
 * Direct reasoning selection per model, and the sticky Chat/Agent default.
 * Permission settings are deliberately not here: they stay one global setting.
 *
 * - Each torn-off window ("torn:<id>") keeps its own in-memory choices,
 *   copied from the standalone window's when it opens
 *   (startTornSurfaceChoices) and never written to prefs. Until then it reads
 *   the standalone window's. It never takes a WebChat model entry: WebChat
 *   drives one browser session, which the standalone window owns.
 *
 * - Side (the standalone window's temporary side chat) keeps its own
 *   in-memory choices, copied from the window's when the side chat starts
 *   (startSideSurfaceChoicesFromStandalone) and never written to prefs. It
 *   always runs on the API runtime ("upstream") and never takes a WebChat
 *   model entry: Claude Code, Codex, and WebChat own provider-side state that
 *   a never-saved chat cannot clean up. A torn window starts no side chats.
 *
 * Only the embedded surface writes prefs.
 *
 * Readers that act for no panel — the settings page, background and utility
 * work — keep reading the prefs directly.
 */
import type { ConversationSystem } from "../../shared/types";
import {
  getClaudeReasoningModePref,
  getClaudeRuntimeModelPref,
  getConversationSystemPref,
  setClaudeReasoningModePref,
  setClaudeRuntimeModelPref,
  setConversationSystemPref,
} from "../../claudeCode/prefs";
import {
  CLAUDE_REASONING_OPTIONS,
  type ClaudeReasoningMode,
} from "../../claudeCode/constants";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  setCodexReasoningModePref,
  setCodexRuntimeModelPref,
} from "../../codexAppServer/prefs";
import { DEFAULT_CODEX_RUNTIME_MODEL } from "../../codexAppServer/constants";
import {
  getCodexDirectReasoningSelection,
  getCodexDirectReasoningSelections,
  setCodexDirectReasoningSelection,
} from "../../codexAuth/reasoningPrefs";
import {
  getReaderChoicePref,
  setReaderChoicePref,
} from "../../utils/readerChoicePrefs";
import {
  decodeReaderSelection,
  isReaderRuntimeKey,
  normalizeStoredReaderSelection,
  READER_RUNTIME_KEYS,
  type ReaderRuntimeKey,
  type ReaderSelection,
  encodeReaderSelection,
} from "../../shared/readerSelection";
import {
  getLastUsedModelEntryId,
  getModelEntryById,
  setLastUsedModelEntryId,
  type RuntimeModelEntry,
} from "../../utils/modelProviders";
import {
  classifySurface,
  isSideSurface,
  isTornSurface,
  unhandledSurface,
  type SelectionSurface,
  type TornSurface,
  type WindowSurface,
} from "./conversationSelection";
import {
  getAvailableModelEntries,
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
  getLastUsedReasoningLevelsByProvider,
  getLastUsedRuntimeMode,
  isReasoningLevelSelection,
  normalizeReasoningProviderSelectionKey,
  resolveSelectedModelEntry,
  setLastUsedReasoningLevel,
  setLastUsedReasoningLevelForProvider,
  setLastUsedRuntimeMode,
} from "./prefHelpers";
import type { ChatRuntimeMode, ReasoningLevelSelection } from "./types";

/** The standalone window's choices; keyed by choice name (and sub-key). */
const standaloneChoices = new Map<string, unknown>();
/** Each torn window's choices; each keyed like standaloneChoices. */
const tornChoices = new Map<TornSurface, Map<string, unknown>>();
/** The side chat's choices; keyed like standaloneChoices. */
const sideChoices = new Map<string, unknown>();

function storeFor<K>(
  stores: Map<K, Map<string, unknown>>,
  surface: K,
): Map<string, unknown> {
  let store = stores.get(surface);
  if (!store) {
    store = new Map<string, unknown>();
    stores.set(surface, store);
  }
  return store;
}

type SurfaceChoice<T> = {
  get: (surface?: SelectionSurface) => T;
  set: (value: T, surface?: SelectionSurface) => void;
  /** Copy the sidebar's current value into the window's store. */
  snapshot: () => void;
  /** Copy the standalone window's current value into a torn window's store. */
  snapshotTorn: (surface: TornSurface) => void;
  /** Copy the standalone window's current value into the side chat's store. */
  snapshotSide: () => void;
};

type KeyedSurfaceChoice<T> = {
  get: (key: string, surface?: SelectionSurface) => T;
  set: (key: string, value: T, surface?: SelectionSurface) => void;
  /** Copy the sidebar's current values (every key) into the window's store. */
  snapshot: () => void;
  /** Copy the standalone window's values (every key) into a torn window's store. */
  snapshotTorn: (surface: TornSurface) => void;
  /** Copy the standalone window's values (every key) into the side chat's store. */
  snapshotSide: () => void;
};

/**
 * One choice. `normalize` validates a window's write the way the pref setter
 * validates an embedded one; `null` drops the write, as the setter does.
 * `side` maps any value the side chat would read or write to one it may hold
 * (for example, always the API runtime); `torn` does the same for a torn
 * window; `null` drops a write.
 */
function surfaceChoice<T>(params: {
  name: string;
  getPref: () => T;
  setPref: (value: T) => void;
  normalize: (value: T) => T | null;
  side?: (value: T) => T | null;
  torn?: (value: T) => T | null;
}): SurfaceChoice<T> {
  const sideValue = (value: T): T | null =>
    params.side ? params.side(value) : value;
  const tornValue = (value: T): T | null =>
    params.torn ? params.torn(value) : value;
  // A fallback the surface may not hold reads unmapped; the caller decides.
  const mappedOr = (map: (value: T) => T | null, fallback: T): T => {
    const mapped = map(fallback);
    return mapped === null ? fallback : mapped;
  };
  const getStandalone = (): T =>
    standaloneChoices.has(params.name)
      ? (standaloneChoices.get(params.name) as T)
      : params.getPref();
  const getTorn = (surface: TornSurface): T => {
    const store = tornChoices.get(surface);
    if (store?.has(params.name)) return store.get(params.name) as T;
    return mappedOr(tornValue, getStandalone());
  };
  const putMapped = (
    store: Map<string, unknown>,
    mapped: T | null,
    dropWhenNull: boolean,
  ): void => {
    if (mapped !== null) store.set(params.name, mapped);
    else if (dropWhenNull) store.delete(params.name);
  };
  return {
    get: (surface) => {
      const target = classifySurface(surface);
      switch (target.kind) {
        case "embedded":
          return params.getPref();
        case "standalone":
          return getStandalone();
        case "torn":
          return getTorn(target.surface);
        case "side":
          if (sideChoices.has(params.name)) {
            return sideChoices.get(params.name) as T;
          }
          return mappedOr(sideValue, getStandalone());
        default:
          return unhandledSurface(target);
      }
    },
    set: (value, surface) => {
      const target = classifySurface(surface);
      if (target.kind === "embedded") {
        params.setPref(value);
        return;
      }
      const normalized = params.normalize(value);
      if (normalized === null) return;
      switch (target.kind) {
        case "standalone":
          standaloneChoices.set(params.name, normalized);
          return;
        case "torn":
          putMapped(
            storeFor(tornChoices, target.surface),
            tornValue(normalized),
            false,
          );
          return;
        case "side":
          putMapped(sideChoices, sideValue(normalized), false);
          return;
        default:
          unhandledSurface(target);
      }
    },
    snapshot: () => {
      standaloneChoices.set(params.name, params.getPref());
    },
    snapshotTorn: (surface) => {
      putMapped(
        storeFor(tornChoices, surface),
        tornValue(getStandalone()),
        true,
      );
    },
    snapshotSide: () => {
      putMapped(sideChoices, sideValue(getStandalone()), true);
    },
  };
}

/**
 * One choice per key. `getAllPrefs` lists every key the pref holds, so the
 * window can copy them when it opens; `unset` is what the pref reads for a
 * key it does not hold, which is what the window reads for a key the sidebar
 * had not set when the window opened.
 */
function keyedSurfaceChoice<T>(params: {
  name: string;
  normalizeKey: (key: string) => string | null;
  getPref: (key: string) => T;
  getAllPrefs: () => Record<string, T>;
  unset: T;
  setPref: (key: string, value: T) => void;
  normalize: (value: T) => T | null;
}): KeyedSurfaceChoice<T> {
  const slot = (key: string) => {
    const normalizedKey = params.normalizeKey(key);
    return normalizedKey === null
      ? null
      : `${params.name}\u0000${normalizedKey}`;
  };
  // Present once a store has copied its source's values for this choice.
  const snapshotMarker = `${params.name}\u0000\u0000snapshot`;
  const slotPrefix = `${params.name}\u0000`;
  // The stores a surface reads, first to last, before the sidebar's prefs.
  const windowStores = (window: WindowSurface): Map<string, unknown>[] => {
    const torn = window === "standalone" ? undefined : tornChoices.get(window);
    return torn ? [torn, standaloneChoices] : [standaloneChoices];
  };
  const sideStores = (): Map<string, unknown>[] => [
    sideChoices,
    ...windowStores("standalone"),
  ];
  // The first store holding the slot answers; a store that copied its source
  // without this slot reads `unset`.
  const readSlot = (
    stores: Map<string, unknown>[],
    surfaceKey: string,
    fallback: () => T,
  ): T => {
    for (const store of stores) {
      if (store.has(surfaceKey)) return store.get(surfaceKey) as T;
      if (store.has(snapshotMarker)) return params.unset;
    }
    return fallback();
  };
  const read = (stores: Map<string, unknown>[], key: string): T => {
    const surfaceKey = slot(key);
    if (surfaceKey === null) return params.getPref(key);
    return readSlot(stores, surfaceKey, () => params.getPref(key));
  };
  // Copy every key the source stores read: the sidebar's keys (their last
  // fallback) and each store's own.
  const copyInto = (
    target: Map<string, unknown>,
    from: Map<string, unknown>[],
  ): void => {
    const copied = new Set<string>();
    for (const key of Object.keys(params.getAllPrefs())) {
      const surfaceKey = slot(key);
      if (surfaceKey === null) continue;
      copied.add(surfaceKey);
      target.set(surfaceKey, read(from, key));
    }
    for (const store of from) {
      for (const surfaceKey of Array.from(store.keys())) {
        if (
          surfaceKey === snapshotMarker ||
          !surfaceKey.startsWith(slotPrefix) ||
          copied.has(surfaceKey)
        ) {
          continue;
        }
        copied.add(surfaceKey);
        target.set(
          surfaceKey,
          readSlot(from, surfaceKey, () => params.unset),
        );
      }
    }
    target.set(snapshotMarker, true);
  };
  return {
    get: (key, surface) => {
      const target = classifySurface(surface);
      switch (target.kind) {
        case "embedded":
          return params.getPref(key);
        case "standalone":
          return read(windowStores("standalone"), key);
        case "torn":
          return read(windowStores(target.surface), key);
        case "side":
          return read(sideStores(), key);
        default:
          return unhandledSurface(target);
      }
    },
    set: (key, value, surface) => {
      const target = classifySurface(surface);
      if (target.kind === "embedded") {
        params.setPref(key, value);
        return;
      }
      const surfaceKey = slot(key);
      const normalized = params.normalize(value);
      if (surfaceKey === null || normalized === null) return;
      switch (target.kind) {
        case "standalone":
          standaloneChoices.set(surfaceKey, normalized);
          return;
        case "torn":
          storeFor(tornChoices, target.surface).set(surfaceKey, normalized);
          return;
        case "side":
          sideChoices.set(surfaceKey, normalized);
          return;
        default:
          unhandledSurface(target);
      }
    },
    snapshot: () => {
      for (const [key, value] of Object.entries(params.getAllPrefs())) {
        const standaloneKey = slot(key);
        if (standaloneKey !== null) standaloneChoices.set(standaloneKey, value);
      }
      standaloneChoices.set(snapshotMarker, true);
    },
    snapshotTorn: (surface) => {
      copyInto(storeFor(tornChoices, surface), windowStores("standalone"));
    },
    snapshotSide: () => {
      copyInto(sideChoices, windowStores("standalone"));
    },
  };
}

/** The entry ID itself when it names an API (not WebChat) entry, else null. */
function apiModelEntryIdOrNull(entryId: string): string | null {
  const entry = getModelEntryById(entryId);
  return entry && entry.authMode !== "webchat" ? entry.entryId : null;
}

const modelEntryId = surfaceChoice<string>({
  name: "modelEntryId",
  getPref: getLastUsedModelEntryId,
  setPref: setLastUsedModelEntryId,
  normalize: (entryId) => getModelEntryById(entryId)?.entryId || null,
  side: apiModelEntryIdOrNull,
  torn: apiModelEntryIdOrNull,
});

const conversationSystem = surfaceChoice<ConversationSystem>({
  name: "conversationSystem",
  getPref: getConversationSystemPref,
  setPref: setConversationSystemPref,
  normalize: (system) =>
    system === "claude_code" || system === "codex" || system === "antigravity"
      ? system
      : "upstream",
  // The side chat is never saved, so it runs only on the API runtime.
  side: () => "upstream",
});

const claudeRuntimeModel = surfaceChoice<string>({
  name: "claudeRuntimeModel",
  getPref: getClaudeRuntimeModelPref,
  setPref: setClaudeRuntimeModelPref,
  normalize: (model) => model.trim() || null,
});

const claudeReasoningMode = surfaceChoice<ClaudeReasoningMode>({
  name: "claudeReasoningMode",
  getPref: getClaudeReasoningModePref,
  setPref: setClaudeReasoningModePref,
  normalize: (mode) => (CLAUDE_REASONING_OPTIONS.includes(mode) ? mode : null),
});

const codexRuntimeModel = surfaceChoice<string>({
  name: "codexRuntimeModel",
  getPref: getCodexRuntimeModelPref,
  setPref: setCodexRuntimeModelPref,
  normalize: (model) => model.trim() || DEFAULT_CODEX_RUNTIME_MODEL,
});

const codexReasoningMode = surfaceChoice<string>({
  name: "codexReasoningMode",
  getPref: getCodexReasoningModePref,
  setPref: setCodexReasoningModePref,
  normalize: (mode) => {
    const normalized = mode.trim();
    return !normalized || normalized.toLowerCase() === "auto"
      ? "auto"
      : normalized;
  },
});

const lastUsedReasoningLevel = surfaceChoice<ReasoningLevelSelection | null>({
  name: "lastUsedReasoningLevel",
  getPref: getLastUsedReasoningLevel,
  setPref: (level) => {
    if (level) setLastUsedReasoningLevel(level);
  },
  normalize: (level) =>
    level && isReasoningLevelSelection(level) ? level : null,
});

const lastUsedReasoningLevelForProvider =
  keyedSurfaceChoice<ReasoningLevelSelection | null>({
    name: "lastUsedReasoningLevelForProvider",
    normalizeKey: normalizeReasoningProviderSelectionKey,
    getPref: getLastUsedReasoningLevelForProvider,
    getAllPrefs: getLastUsedReasoningLevelsByProvider,
    unset: null,
    setPref: (provider, level) => {
      if (level) setLastUsedReasoningLevelForProvider(provider, level);
    },
    normalize: (level) =>
      level && isReasoningLevelSelection(level) ? level : null,
  });

const codexDirectReasoningSelection = keyedSurfaceChoice<string>({
  name: "codexDirectReasoningSelection",
  normalizeKey: (model) => model.trim().toLowerCase(),
  getPref: getCodexDirectReasoningSelection,
  getAllPrefs: getCodexDirectReasoningSelections,
  unset: "auto",
  setPref: setCodexDirectReasoningSelection,
  normalize: (selection) => selection.trim() || "auto",
});

const lastUsedRuntimeMode = surfaceChoice<ChatRuntimeMode | null>({
  name: "lastUsedRuntimeMode",
  getPref: getLastUsedRuntimeMode,
  setPref: (mode) => {
    if (mode) setLastUsedRuntimeMode(mode);
  },
  normalize: (mode) => (mode === "chat" || mode === "agent" ? mode : null),
});

/**
 * The reader model each runtime reads papers with: one stored selection per
 * runtime (agent, codex, claude), "" for Same as main. Keyed like the Codex
 * Direct reasoning selection, so a window copies all three when it opens.
 */
const readerChoice = keyedSurfaceChoice<string>({
  name: "readerChoice",
  normalizeKey: (key) => (isReaderRuntimeKey(key) ? key : null),
  getPref: (key) => (isReaderRuntimeKey(key) ? getReaderChoicePref(key) : ""),
  getAllPrefs: () =>
    Object.fromEntries(
      READER_RUNTIME_KEYS.map((key) => [key, getReaderChoicePref(key)]),
    ),
  unset: "",
  setPref: (key, value) => {
    if (isReaderRuntimeKey(key)) setReaderChoicePref(key, value);
  },
  normalize: normalizeStoredReaderSelection,
});

export const surfaceChoices = {
  modelEntryId,
  readerChoice,
  conversationSystem,
  claudeRuntimeModel,
  claudeReasoningMode,
  codexRuntimeModel,
  codexReasoningMode,
  lastUsedReasoningLevel,
  lastUsedReasoningLevelForProvider,
  codexDirectReasoningSelection,
  lastUsedRuntimeMode,
};

/** The model entry the surface's API model menu has selected. */
export function getSelectedModelEntryForSurface(
  surface?: SelectionSurface,
): RuntimeModelEntry | null {
  const selected = resolveSelectedModelEntry(modelEntryId.get(surface));
  const excludesWebChat = isSideSurface(surface) || isTornSurface(surface);
  if (!excludesWebChat || selected?.authMode !== "webchat") return selected;
  // Side chats and torn windows never run on WebChat: take the first API
  // entry instead.
  return (
    getAvailableModelEntries().find((entry) => entry.authMode !== "webchat") ||
    null
  );
}

/** The reader the surface picked for a runtime; null for Same as main. */
export function getReaderSelectionForSurface(
  runtime: ReaderRuntimeKey,
  surface?: SelectionSurface,
): ReaderSelection | null {
  return decodeReaderSelection(readerChoice.get(runtime, surface));
}

export function setSelectedModelEntryForSurface(
  entryId: string,
  surface?: SelectionSurface,
): void {
  const selected = getModelEntryById(entryId);
  if (!selected) return;
  modelEntryId.set(selected.entryId, surface);
}

/**
 * A runtime that was just disabled in Settings can no longer be any
 * surface's conversation system: every surface falls back to the API.
 */
export function demoteConversationSystemOnEverySurface(
  system: ConversationSystem,
): void {
  if (getConversationSystemPref() === system) {
    setConversationSystemPref("upstream");
  }
  for (const store of [standaloneChoices, ...tornChoices.values()]) {
    if (store.get("conversationSystem") === system) {
      store.set("conversationSystem", "upstream");
    }
  }
}

/** Forget every standalone choice; reads fall back to the sidebar's prefs. */
export function clearStandaloneSurfaceChoices(): void {
  standaloneChoices.clear();
}

/**
 * A new window starts from the sidebar's current values: forget the previous
 * window's choices and copy every sidebar value into the window's store, so
 * a later sidebar change does not move the window. Torn windows keep theirs.
 */
export function startStandaloneSurfaceChoicesFromSidebar(): void {
  standaloneChoices.clear();
  for (const choice of Object.values(surfaceChoices)) choice.snapshot();
}

/**
 * A new torn window starts from the standalone window's current values (which
 * fall back to the sidebar's), never on a WebChat entry. Later changes on
 * either window stay apart.
 */
export function startTornSurfaceChoices(surface: TornSurface): void {
  tornChoices.set(surface, new Map<string, unknown>());
  for (const choice of Object.values(surfaceChoices)) {
    choice.snapshotTorn(surface);
  }
}

/** Forget one torn window's choices; reads fall back to the standalone window's. */
export function clearTornSurfaceChoices(surface: TornSurface): void {
  tornChoices.delete(surface);
}

/**
 * A new side chat starts from the window's current values (its model,
 * reasoning levels, and Chat/Agent default), always on the API runtime and
 * never on a WebChat entry. Later changes on either surface stay apart.
 */
export function startSideSurfaceChoicesFromStandalone(): void {
  sideChoices.clear();
  for (const choice of Object.values(surfaceChoices)) choice.snapshotSide();
}

/** Forget every side-chat choice; reads fall back to the window's. */
export function resetSideSurfaceChoices(): void {
  sideChoices.clear();
}

/**
 * The choices bound to one panel. Panels derive their surface from their host
 * binding, so the binding is read on every call rather than captured once.
 */
export function bindSurfaceChoices(resolveSurface: () => SelectionSurface) {
  return {
    surface: resolveSurface,
    getSelectedModelEntry: () =>
      getSelectedModelEntryForSurface(resolveSurface()),
    setSelectedModelEntry: (entryId: string) =>
      setSelectedModelEntryForSurface(entryId, resolveSurface()),
    getModelEntryId: () => modelEntryId.get(resolveSurface()),
    getConversationSystem: () => conversationSystem.get(resolveSurface()),
    setConversationSystem: (system: ConversationSystem) =>
      conversationSystem.set(system, resolveSurface()),
    getClaudeRuntimeModel: () => claudeRuntimeModel.get(resolveSurface()),
    setClaudeRuntimeModel: (model: string) =>
      claudeRuntimeModel.set(model, resolveSurface()),
    getClaudeReasoningMode: () => claudeReasoningMode.get(resolveSurface()),
    setClaudeReasoningMode: (mode: ClaudeReasoningMode) =>
      claudeReasoningMode.set(mode, resolveSurface()),
    getCodexRuntimeModel: () => codexRuntimeModel.get(resolveSurface()),
    setCodexRuntimeModel: (model: string) =>
      codexRuntimeModel.set(model, resolveSurface()),
    getCodexReasoningMode: () => codexReasoningMode.get(resolveSurface()),
    setCodexReasoningMode: (mode: string) =>
      codexReasoningMode.set(mode, resolveSurface()),
    getLastUsedReasoningLevel: () =>
      lastUsedReasoningLevel.get(resolveSurface()),
    setLastUsedReasoningLevel: (level: ReasoningLevelSelection) =>
      lastUsedReasoningLevel.set(level, resolveSurface()),
    getLastUsedReasoningLevelForProvider: (provider: string) =>
      lastUsedReasoningLevelForProvider.get(provider, resolveSurface()),
    setLastUsedReasoningLevelForProvider: (
      provider: string,
      level: ReasoningLevelSelection,
    ) =>
      lastUsedReasoningLevelForProvider.set(provider, level, resolveSurface()),
    getCodexDirectReasoningSelection: (model: string) =>
      codexDirectReasoningSelection.get(model, resolveSurface()),
    setCodexDirectReasoningSelection: (model: string, selection: string) =>
      codexDirectReasoningSelection.set(model, selection, resolveSurface()),
    getReaderSelection: (runtime: ReaderRuntimeKey): ReaderSelection | null =>
      getReaderSelectionForSurface(runtime, resolveSurface()),
    setReaderSelection: (
      runtime: ReaderRuntimeKey,
      selection: ReaderSelection | null,
    ) =>
      readerChoice.set(
        runtime,
        encodeReaderSelection(selection),
        resolveSurface(),
      ),
    getLastUsedRuntimeMode: () => lastUsedRuntimeMode.get(resolveSurface()),
    setLastUsedRuntimeMode: (mode: ChatRuntimeMode) =>
      lastUsedRuntimeMode.set(mode, resolveSurface()),
  };
}

export type PanelSurfaceChoices = ReturnType<typeof bindSurfaceChoices>;
