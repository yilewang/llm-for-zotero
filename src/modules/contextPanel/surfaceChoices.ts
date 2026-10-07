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
  getLastUsedModelEntryId,
  getModelEntryById,
  setLastUsedModelEntryId,
  type RuntimeModelEntry,
} from "../../utils/modelProviders";
import type { SelectionSurface } from "./conversationSelection";
import {
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

type SurfaceChoice<T> = {
  get: (surface?: SelectionSurface) => T;
  set: (value: T, surface?: SelectionSurface) => void;
  /** Copy the sidebar's current value into the window's store. */
  snapshot: () => void;
};

type KeyedSurfaceChoice<T> = {
  get: (key: string, surface?: SelectionSurface) => T;
  set: (key: string, value: T, surface?: SelectionSurface) => void;
  /** Copy the sidebar's current values (every key) into the window's store. */
  snapshot: () => void;
};

/**
 * One choice. `normalize` validates a standalone write the way the pref
 * setter validates an embedded one; `null` drops the write, as the setter
 * does.
 */
function surfaceChoice<T>(params: {
  name: string;
  getPref: () => T;
  setPref: (value: T) => void;
  normalize: (value: T) => T | null;
}): SurfaceChoice<T> {
  return {
    get: (surface) =>
      surface === "standalone" && standaloneChoices.has(params.name)
        ? (standaloneChoices.get(params.name) as T)
        : params.getPref(),
    set: (value, surface) => {
      if (surface !== "standalone") {
        params.setPref(value);
        return;
      }
      const normalized = params.normalize(value);
      if (normalized === null) return;
      standaloneChoices.set(params.name, normalized);
    },
    snapshot: () => {
      standaloneChoices.set(params.name, params.getPref());
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
  // Present once the window has copied the sidebar's values for this choice.
  const snapshotMarker = `${params.name}\u0000\u0000snapshot`;
  return {
    get: (key, surface) => {
      if (surface !== "standalone") return params.getPref(key);
      const standaloneKey = slot(key);
      if (standaloneKey === null) return params.getPref(key);
      if (standaloneChoices.has(standaloneKey)) {
        return standaloneChoices.get(standaloneKey) as T;
      }
      return standaloneChoices.has(snapshotMarker)
        ? params.unset
        : params.getPref(key);
    },
    set: (key, value, surface) => {
      if (surface !== "standalone") {
        params.setPref(key, value);
        return;
      }
      const standaloneKey = slot(key);
      const normalized = params.normalize(value);
      if (standaloneKey === null || normalized === null) return;
      standaloneChoices.set(standaloneKey, normalized);
    },
    snapshot: () => {
      for (const [key, value] of Object.entries(params.getAllPrefs())) {
        const standaloneKey = slot(key);
        if (standaloneKey !== null) standaloneChoices.set(standaloneKey, value);
      }
      standaloneChoices.set(snapshotMarker, true);
    },
  };
}

const modelEntryId = surfaceChoice<string>({
  name: "modelEntryId",
  getPref: getLastUsedModelEntryId,
  setPref: setLastUsedModelEntryId,
  normalize: (entryId) => getModelEntryById(entryId)?.entryId || null,
});

const conversationSystem = surfaceChoice<ConversationSystem>({
  name: "conversationSystem",
  getPref: getConversationSystemPref,
  setPref: setConversationSystemPref,
  normalize: (system) =>
    system === "claude_code" || system === "codex" ? system : "upstream",
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

export const surfaceChoices = {
  modelEntryId,
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
  return resolveSelectedModelEntry(modelEntryId.get(surface));
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
 * surface's conversation system: both fall back to the API.
 */
export function demoteConversationSystemOnEverySurface(
  system: ConversationSystem,
): void {
  if (getConversationSystemPref() === system) {
    setConversationSystemPref("upstream");
  }
  if (standaloneChoices.get("conversationSystem") === system) {
    standaloneChoices.set("conversationSystem", "upstream");
  }
}

/** Forget every standalone choice; reads fall back to the sidebar's prefs. */
export function clearStandaloneSurfaceChoices(): void {
  standaloneChoices.clear();
}

/**
 * A new window starts from the sidebar's current values: forget the previous
 * window's choices and copy every sidebar value into the window's store, so
 * a later sidebar change does not move the window.
 */
export function startStandaloneSurfaceChoicesFromSidebar(): void {
  standaloneChoices.clear();
  for (const choice of Object.values(surfaceChoices)) choice.snapshot();
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
    getLastUsedRuntimeMode: () => lastUsedRuntimeMode.get(resolveSurface()),
    setLastUsedRuntimeMode: (mode: ChatRuntimeMode) =>
      lastUsedRuntimeMode.set(mode, resolveSurface()),
  };
}

export type PanelSurfaceChoices = ReturnType<typeof bindSurfaceChoices>;
