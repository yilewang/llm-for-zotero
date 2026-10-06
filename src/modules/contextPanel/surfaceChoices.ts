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
 *   never writes these prefs, and wherever it has not chosen yet it reads the
 *   sidebar's (persisted) value. A new window starts from the sidebar's values
 *   because opening one clears the previous window's choices.
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
};

type KeyedSurfaceChoice<T> = {
  get: (key: string, surface?: SelectionSurface) => T;
  set: (key: string, value: T, surface?: SelectionSurface) => void;
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
  };
}

function keyedSurfaceChoice<T>(params: {
  name: string;
  normalizeKey: (key: string) => string | null;
  getPref: (key: string) => T;
  setPref: (key: string, value: T) => void;
  normalize: (value: T) => T | null;
}): KeyedSurfaceChoice<T> {
  const slot = (key: string) => {
    const normalizedKey = params.normalizeKey(key);
    return normalizedKey === null
      ? null
      : `${params.name}\u0000${normalizedKey}`;
  };
  return {
    get: (key, surface) => {
      const standaloneKey = surface === "standalone" ? slot(key) : null;
      return standaloneKey !== null && standaloneChoices.has(standaloneKey)
        ? (standaloneChoices.get(standaloneKey) as T)
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

/** Forget every standalone choice; a new window starts from the sidebar's. */
export function clearStandaloneSurfaceChoices(): void {
  standaloneChoices.clear();
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
