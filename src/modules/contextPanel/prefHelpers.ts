import { DEFAULT_INPUT_TOKEN_CAP } from "../../utils/llmDefaults";
import {
  normalizeTemperature,
  normalizeMaxTokens,
  normalizeInputTokenCap,
} from "../../utils/normalization";
import { getModelInputTokenLimit } from "../../utils/modelInputCap";
import {
  config,
  MODEL_PROFILE_SUFFIX,
  ASSISTANT_NOTE_MAP_PREF_KEY,
  CUSTOM_SHORTCUT_ID_PREFIX,
  type ModelProfileKey,
} from "./constants";
import type {
  ApiProfile,
  CustomShortcut,
  ReasoningLevelSelection,
} from "./types";
import { selectedModelCache, panelFontScalePercent } from "./state";

export function getStringPref(key: string): string {
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value : "";
}

const LAST_MODEL_PROFILE_PREF_KEY = "lastUsedModelProfile";
const LAST_REASONING_LEVEL_PREF_KEY = "lastUsedReasoningLevel";
const LAST_REASONING_EXPANDED_PREF_KEY = "lastReasoningExpanded";
const LAST_PAPER_CONVERSATION_MAP_PREF_KEY = "lastUsedPaperConversationMap";
const MODEL_PROFILE_KEYS = new Set<ModelProfileKey>([
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
]);
const REASONING_LEVEL_SELECTIONS = new Set<ReasoningLevelSelection>([
  "none",
  "default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function buildPaperConversationMapKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}

export function getLastUsedModelProfileKey(): ModelProfileKey | null {
  const raw = getStringPref(LAST_MODEL_PROFILE_PREF_KEY).trim().toLowerCase();
  if (!raw || !MODEL_PROFILE_KEYS.has(raw as ModelProfileKey)) return null;
  return raw as ModelProfileKey;
}

export function setLastUsedModelProfileKey(key: ModelProfileKey): void {
  if (!MODEL_PROFILE_KEYS.has(key)) return;
  Zotero.Prefs.set(
    `${config.prefsPrefix}.${LAST_MODEL_PROFILE_PREF_KEY}`,
    key,
    true,
  );
}

export function getLastUsedReasoningLevel(): ReasoningLevelSelection | null {
  const raw = getStringPref(LAST_REASONING_LEVEL_PREF_KEY).trim().toLowerCase();
  if (!raw || !REASONING_LEVEL_SELECTIONS.has(raw as ReasoningLevelSelection)) {
    return null;
  }
  return raw as ReasoningLevelSelection;
}

export function setLastUsedReasoningLevel(
  level: ReasoningLevelSelection,
): void {
  if (!REASONING_LEVEL_SELECTIONS.has(level)) return;
  Zotero.Prefs.set(
    `${config.prefsPrefix}.${LAST_REASONING_LEVEL_PREF_KEY}`,
    level,
    true,
  );
}

export function getLastReasoningExpanded(): boolean {
  const value = Zotero.Prefs.get(
    `${config.prefsPrefix}.${LAST_REASONING_EXPANDED_PREF_KEY}`,
    true,
  );
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function setLastReasoningExpanded(expanded: boolean): void {
  Zotero.Prefs.set(
    `${config.prefsPrefix}.${LAST_REASONING_EXPANDED_PREF_KEY}`,
    Boolean(expanded),
    true,
  );
}

function getLastPaperConversationMap(): Record<string, number> {
  const raw = Zotero.Prefs.get(
    `${config.prefsPrefix}.${LAST_PAPER_CONVERSATION_MAP_PREF_KEY}`,
    true,
  );
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalized = Number(value);
      if (!Number.isFinite(normalized) || normalized <= 0) continue;
      out[key] = Math.floor(normalized);
    }
    return out;
  } catch (_err) {
    return {};
  }
}

function setLastPaperConversationMap(value: Record<string, number>): void {
  Zotero.Prefs.set(
    `${config.prefsPrefix}.${LAST_PAPER_CONVERSATION_MAP_PREF_KEY}`,
    JSON.stringify(value),
    true,
  );
}

export function getLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
  const map = getLastPaperConversationMap();
  const key = buildPaperConversationMapKey(libraryID, paperItemID);
  const value = Number(map[key]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function setLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getLastPaperConversationMap();
  const key = buildPaperConversationMapKey(libraryID, paperItemID);
  map[key] = Math.floor(conversationKey);
  setLastPaperConversationMap(map);
}

export function removeLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  const map = getLastPaperConversationMap();
  const key = buildPaperConversationMapKey(libraryID, paperItemID);
  if (!(key in map)) return;
  delete map[key];
  setLastPaperConversationMap(map);
}

function normalizeTemperaturePref(raw: string): number {
  return normalizeTemperature(raw);
}

function normalizeMaxTokensPref(raw: string): number {
  return normalizeMaxTokens(raw);
}

export function getApiProfiles(): Record<ModelProfileKey, ApiProfile> {
  const primary: ApiProfile = {
    apiBase: getStringPref("apiBasePrimary") || getStringPref("apiBase") || "",
    apiKey: getStringPref("apiKeyPrimary") || getStringPref("apiKey") || "",
    model:
      getStringPref("modelPrimary") || getStringPref("model") || "gpt-4o-mini",
  };

  const profiles: Record<ModelProfileKey, ApiProfile> = {
    primary: {
      apiBase: primary.apiBase.trim(),
      apiKey: primary.apiKey.trim(),
      model: primary.model.trim(),
    },
    secondary: {
      apiBase: getStringPref("apiBaseSecondary").trim(),
      apiKey: getStringPref("apiKeySecondary").trim(),
      model: getStringPref("modelSecondary").trim(),
    },
    tertiary: {
      apiBase: getStringPref("apiBaseTertiary").trim(),
      apiKey: getStringPref("apiKeyTertiary").trim(),
      model: getStringPref("modelTertiary").trim(),
    },
    quaternary: {
      apiBase: getStringPref("apiBaseQuaternary").trim(),
      apiKey: getStringPref("apiKeyQuaternary").trim(),
      model: getStringPref("modelQuaternary").trim(),
    },
  };

  return profiles;
}

export function getSelectedProfileForItem(itemId: number): {
  key: ModelProfileKey;
  apiBase: string;
  apiKey: string;
  model: string;
} {
  const profiles = getApiProfiles();
  const preferredKey =
    getLastUsedModelProfileKey() || selectedModelCache.get(itemId) || "primary";
  const selectedKey =
    preferredKey !== "primary" && profiles[preferredKey].model
      ? preferredKey
      : "primary";
  selectedModelCache.set(itemId, selectedKey);
  return { key: selectedKey, ...profiles[selectedKey] };
}

export function getAdvancedModelParamsForProfile(profileKey: ModelProfileKey): {
  temperature: number;
  maxTokens: number;
  inputTokenCap: number;
} {
  const suffix = MODEL_PROFILE_SUFFIX[profileKey];
  const modelName =
    suffix === "Primary"
      ? (getStringPref(`model${suffix}`) || getStringPref("model")).trim()
      : getStringPref(`model${suffix}`).trim();
  const defaultInputTokenCap =
    getModelInputTokenLimit(modelName) || DEFAULT_INPUT_TOKEN_CAP;
  return {
    temperature: normalizeTemperaturePref(
      getStringPref(`temperature${suffix}`),
    ),
    maxTokens: normalizeMaxTokensPref(getStringPref(`maxTokens${suffix}`)),
    inputTokenCap: normalizeInputTokenCap(
      getStringPref(`inputTokenCap${suffix}`),
      defaultInputTokenCap,
    ),
  };
}

export function applyPanelFontScale(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.setProperty("--llm-font-scale", `${panelFontScalePercent / 100}`);
}

/** Get/set JSON preferences with error handling */
function getJsonPref(key: string): Record<string, string> {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, string>): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

export const getShortcutOverrides = () => getJsonPref("shortcuts");
export const setShortcutOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcuts", v);
export const getShortcutLabelOverrides = () => getJsonPref("shortcutLabels");
export const setShortcutLabelOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcutLabels", v);
export const getDeletedShortcutIds = () =>
  getStringArrayPref("shortcutDeleted");
export const setDeletedShortcutIds = (v: string[]) =>
  setStringArrayPref("shortcutDeleted", v);
export const getCustomShortcuts = () =>
  getCustomShortcutsPref("customShortcuts");
export const setCustomShortcuts = (v: CustomShortcut[]) =>
  setCustomShortcutsPref("customShortcuts", v);
export const getShortcutOrder = () => getStringArrayPref("shortcutOrder");
export const setShortcutOrder = (v: string[]) =>
  setStringArrayPref("shortcutOrder", v);

function getStringArrayPref(key: string): string[] {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function setStringArrayPref(key: string, value: string[]): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

function getCustomShortcutsPref(key: string): CustomShortcut[] {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const shortcuts: CustomShortcut[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const id =
        typeof (entry as any).id === "string" ? (entry as any).id.trim() : "";
      const label =
        typeof (entry as any).label === "string"
          ? (entry as any).label.trim()
          : "";
      const prompt =
        typeof (entry as any).prompt === "string"
          ? (entry as any).prompt.trim()
          : "";
      if (!id || !prompt) continue;
      shortcuts.push({
        id,
        label: label || "Custom Shortcut",
        prompt,
      });
    }
    return shortcuts;
  } catch {
    return [];
  }
}

function setCustomShortcutsPref(key: string, value: CustomShortcut[]): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

export function createCustomShortcutId(): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_SHORTCUT_ID_PREFIX}-${Date.now()}-${token}`;
}

export function resetShortcutsToDefault(): void {
  setShortcutOverrides({});
  setShortcutLabelOverrides({});
  setDeletedShortcutIds([]);
  setCustomShortcuts([]);
  setShortcutOrder([]);
}

function getAssistantNoteMap(): Record<string, string> {
  try {
    return getJsonPref(ASSISTANT_NOTE_MAP_PREF_KEY);
  } catch (err) {
    ztoolkit.log("LLM: Failed to read assistantNoteMap pref:", err);
    return {};
  }
}

function setAssistantNoteMap(value: Record<string, string>): void {
  try {
    setJsonPref(ASSISTANT_NOTE_MAP_PREF_KEY, value);
  } catch (err) {
    ztoolkit.log("LLM: Failed to write assistantNoteMap pref:", err);
  }
}

export function removeAssistantNoteMapEntry(parentItemId: number): void {
  const parentKey = String(parentItemId);
  const map = getAssistantNoteMap();
  if (!(parentKey in map)) return;
  delete map[parentKey];
  setAssistantNoteMap(map);
}

export function getTrackedAssistantNoteForParent(
  parentItemId: number,
): Zotero.Item | null {
  const parentKey = String(parentItemId);
  const map = getAssistantNoteMap();
  const rawNoteId = map[parentKey];
  if (!rawNoteId) return null;
  const noteId = Number.parseInt(rawNoteId, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) {
    removeAssistantNoteMapEntry(parentItemId);
    return null;
  }
  let note: Zotero.Item | null = null;
  try {
    note = Zotero.Items.get(noteId) || null;
  } catch {
    ztoolkit.log(`LLM: Failed to get note item ${noteId}`);
    removeAssistantNoteMapEntry(parentItemId);
    return null;
  }
  if (
    !note ||
    !note.isNote?.() ||
    note.deleted ||
    note.parentID !== parentItemId
  ) {
    removeAssistantNoteMapEntry(parentItemId);
    return null;
  }
  return note;
}

export function rememberAssistantNoteForParent(
  parentItemId: number,
  noteId: number,
): void {
  if (!Number.isFinite(noteId) || noteId <= 0) return;
  const map = getAssistantNoteMap();
  map[String(parentItemId)] = String(noteId);
  setAssistantNoteMap(map);
}
