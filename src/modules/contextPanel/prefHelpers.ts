import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_ALLOWED_TOKENS,
} from "../../utils/llmDefaults";
import {
  normalizeTemperature,
  normalizeMaxTokens,
} from "../../utils/normalization";
import {
  config,
  MODEL_PROFILE_SUFFIX,
  ASSISTANT_NOTE_MAP_PREF_KEY,
  CUSTOM_SHORTCUT_ID_PREFIX,
  type ModelProfileKey,
} from "./constants";
import type { ApiProfile, CustomShortcut } from "./types";
import { selectedModelCache, panelFontScalePercent } from "./state";

export function getStringPref(key: string): string {
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value : "";
}

export function normalizeTemperaturePref(raw: string): number {
  return normalizeTemperature(raw);
}

export function normalizeMaxTokensPref(raw: string): number {
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
  const selected = selectedModelCache.get(itemId) || "primary";
  if (selected !== "primary" && profiles[selected].model) {
    return { key: selected, ...profiles[selected] };
  }
  return { key: "primary", ...profiles.primary };
}

export function getAdvancedModelParamsForProfile(profileKey: ModelProfileKey): {
  temperature: number;
  maxTokens: number;
} {
  const suffix = MODEL_PROFILE_SUFFIX[profileKey];
  return {
    temperature: normalizeTemperaturePref(
      getStringPref(`temperature${suffix}`),
    ),
    maxTokens: normalizeMaxTokensPref(getStringPref(`maxTokens${suffix}`)),
  };
}

export function applyPanelFontScale(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.setProperty("--llm-font-scale", `${panelFontScalePercent / 100}`);
}

/** Get/set JSON preferences with error handling */
export function getJsonPref(key: string): Record<string, string> {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function setJsonPref(key: string, value: Record<string, string>): void {
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

export function getStringArrayPref(key: string): string[] {
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

export function setStringArrayPref(key: string, value: string[]): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

export function getCustomShortcutsPref(key: string): CustomShortcut[] {
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

export function setCustomShortcutsPref(
  key: string,
  value: CustomShortcut[],
): void {
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

export function getAssistantNoteMap(): Record<string, string> {
  try {
    return getJsonPref(ASSISTANT_NOTE_MAP_PREF_KEY);
  } catch (err) {
    ztoolkit.log("LLM: Failed to read assistantNoteMap pref:", err);
    return {};
  }
}

export function setAssistantNoteMap(value: Record<string, string>): void {
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
