import {
  config,
  ASSISTANT_NOTE_MAP_PREF_KEY,
  BUILTIN_SHORTCUT_FILES,
  buildDefaultUpstreamGlobalConversationKey,
  CUSTOM_SHORTCUT_ID_PREFIX,
  FONT_SCALE_DEFAULT_PERCENT,
  FONT_SCALE_MIN_PERCENT,
  FONT_SCALE_MAX_PERCENT,
  GLOBAL_CONVERSATION_KEY_BASE,
  MESSAGE_LINE_SPACING_DEFAULT_PERCENT,
  MESSAGE_LINE_SPACING_MIN_PERCENT,
  MESSAGE_LINE_SPACING_MAX_PERCENT,
  MESSAGE_PARAGRAPH_SPACING_DEFAULT_PX,
  MESSAGE_PARAGRAPH_SPACING_MIN_PX,
  MESSAGE_PARAGRAPH_SPACING_MAX_PX,
  MESSAGE_WORD_SPACING_DEFAULT_PX,
  MESSAGE_WORD_SPACING_MIN_PX,
  MESSAGE_WORD_SPACING_MAX_PX,
  isUpstreamGlobalConversationKey,
} from "./constants";
import type { CustomShortcut, ReasoningLevelSelection } from "./types";
import {
  selectedModelCache,
  panelFontScalePercent,
  messageLineSpacingPercent,
  messageParagraphSpacingPx,
  messageWordSpacingPx,
  messageFontFamily,
} from "./state";
import {
  deriveProviderLabel,
  getDefaultModelEntry,
  getLastUsedModelEntryId,
  getModelEntryById,
  getModelProviderGroups,
  getRuntimeModelEntries,
  setLastUsedModelEntryId,
  type ModelProviderGroup,
  type RuntimeModelEntry,
} from "../../utils/modelProviders";
import {
  clampStandaloneSidebarPreferredWidth,
  STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX,
} from "./standaloneWindowSizing";

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
  clear?: (key: string, global?: boolean) => void;
};

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (Zotero as unknown as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs || null
  );
}

export function getStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value : "";
}

export function getBoolPref(key: string, defaultValue = false): boolean {
  const value = getZoteroPrefs()?.get?.(`${config.prefsPrefix}.${key}`, true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
}

export function getAgentModeEnabled(): boolean {
  return getBoolPref("enableAgentMode", false);
}

export function getClaudeCodeModeEnabled(): boolean {
  return getBoolPref("enableClaudeCodeMode", false);
}

const LAST_REASONING_LEVEL_PREF_KEY = "lastUsedReasoningLevel";
const LAST_REASONING_LEVEL_BY_PROVIDER_PREF_KEY =
  "lastUsedReasoningLevelByProvider";
const LAST_REASONING_EXPANDED_PREF_KEY = "lastReasoningExpanded";
const LAST_CONVERSATION_MODE_MAP_PREF_KEY = "lastUsedConversationModeMap";
const LAST_GLOBAL_CONVERSATION_MAP_PREF_KEY = "lastUsedGlobalConversationMap";
const LAST_PAPER_CONVERSATION_MAP_PREF_KEY = "lastUsedPaperConversationMap";
const PANEL_FONT_SCALE_PREF_KEY = "panelFontScale";
const STANDALONE_SIDEBAR_WIDTH_PREF_KEY = "standaloneSidebarWidth";
const SHORTCUT_DEFAULTS_MIGRATION_PREF_KEY = "shortcutDefaultsMigrationVersion";
const SHORTCUT_DEFAULTS_MIGRATION_VERSION = 2;
const MESSAGE_LINE_SPACING_PREF_KEY = "messageLineSpacing";
const MESSAGE_PARAGRAPH_SPACING_PREF_KEY = "messageParagraphSpacing";
const MESSAGE_WORD_SPACING_PREF_KEY = "messageWordSpacing";
const MESSAGE_FONT_FAMILY_PREF_KEY = "messageFontFamily";
const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "emoji",
  "math",
  "fangsong",
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
const REASONING_PROVIDER_SELECTION_KEYS = new Set([
  "openai",
  "gemini",
  "deepseek",
  "kimi",
  "qwen",
  "grok",
  "anthropic",
]);

const BUILTIN_SHORTCUT_IDS = new Set<string>(
  BUILTIN_SHORTCUT_FILES.map((shortcut) => shortcut.id),
);
const BUILTIN_IDS_RESTORED_ON_MIGRATION = new Set<string>(["mermaid-diagram"]);
const KNOWN_OLD_BUILTIN_PROMPTS: Record<string, string[]> = {
  summarize: ["Summarize the document in 3-5 bullet points."],
};

export function buildPaperStateKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}

function buildLibraryStateKey(libraryID: number): string {
  return `${Math.floor(libraryID)}`;
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
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${LAST_REASONING_LEVEL_PREF_KEY}`,
    level,
    true,
  );
}

function getLastReasoningLevelByProviderMap(): Record<string, string> {
  const raw = getStringPref(LAST_REASONING_LEVEL_BY_PROVIDER_PREF_KEY).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [provider, level] of Object.entries(parsed)) {
      if (
        REASONING_PROVIDER_SELECTION_KEYS.has(provider) &&
        typeof level === "string" &&
        REASONING_LEVEL_SELECTIONS.has(level as ReasoningLevelSelection)
      ) {
        out[provider] = level;
      }
    }
    return out;
  } catch (_err) {
    return {};
  }
}

export function getLastUsedReasoningLevelForProvider(
  provider: string,
): ReasoningLevelSelection | null {
  const normalized = provider.trim().toLowerCase();
  if (!REASONING_PROVIDER_SELECTION_KEYS.has(normalized)) return null;
  const level = getLastReasoningLevelByProviderMap()[normalized];
  if (!level) return null;
  return level as ReasoningLevelSelection;
}

export function setLastUsedReasoningLevelForProvider(
  provider: string,
  level: ReasoningLevelSelection,
): void {
  const normalized = provider.trim().toLowerCase();
  if (
    !REASONING_PROVIDER_SELECTION_KEYS.has(normalized) ||
    !REASONING_LEVEL_SELECTIONS.has(level)
  ) {
    return;
  }
  const map = getLastReasoningLevelByProviderMap();
  map[normalized] = level;
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${LAST_REASONING_LEVEL_BY_PROVIDER_PREF_KEY}`,
    JSON.stringify(map),
    true,
  );
}

export function getLastReasoningExpanded(): boolean {
  const value = getZoteroPrefs()?.get?.(
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
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${LAST_REASONING_EXPANDED_PREF_KEY}`,
    Boolean(expanded),
    true,
  );
}

function getLastPaperConversationMap(): Record<string, number> {
  const raw = getZoteroPrefs()?.get?.(
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

function getLastConversationModeMap(): Record<string, "global" | "paper"> {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${LAST_CONVERSATION_MODE_MAP_PREF_KEY}`,
    true,
  );
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, "global" | "paper"> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== "global" && value !== "paper") continue;
      out[key] = value;
    }
    return out;
  } catch (_err) {
    return {};
  }
}

function setLastConversationModeMap(
  value: Record<string, "global" | "paper">,
): void {
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${LAST_CONVERSATION_MODE_MAP_PREF_KEY}`,
    JSON.stringify(value),
    true,
  );
}

function getLastGlobalConversationMap(): Record<string, number> {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${LAST_GLOBAL_CONVERSATION_MAP_PREF_KEY}`,
    true,
  );
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalized = Number(value);
      if (!Number.isFinite(normalized) || normalized <= 0) continue;
      const conversationKey = Math.floor(normalized);
      if (!isUpstreamGlobalConversationKey(conversationKey)) continue;
      out[key] = conversationKey;
    }
    return out;
  } catch (_err) {
    return {};
  }
}

function setLastGlobalConversationMap(value: Record<string, number>): void {
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${LAST_GLOBAL_CONVERSATION_MAP_PREF_KEY}`,
    JSON.stringify(value),
    true,
  );
}

export function getLastUsedUpstreamConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  return getLastConversationModeMap()[buildLibraryStateKey(libraryID)] || null;
}

export function setLastUsedUpstreamConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getLastConversationModeMap();
  map[buildLibraryStateKey(libraryID)] = mode === "global" ? "global" : "paper";
  setLastConversationModeMap(map);
}

export function removeLastUsedUpstreamConversationMode(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getLastConversationModeMap();
  const key = buildLibraryStateKey(libraryID);
  if (!(key in map)) return;
  delete map[key];
  setLastConversationModeMap(map);
}

export function getLastUsedUpstreamGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const value = Number(
    getLastGlobalConversationMap()[buildLibraryStateKey(libraryID)],
  );
  if (!Number.isFinite(value) || value <= 0) return null;
  const conversationKey = Math.floor(value);
  return isUpstreamGlobalConversationKey(conversationKey)
    ? conversationKey
    : null;
}

export function setLastUsedUpstreamGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const normalizedKey = Math.floor(conversationKey);
  if (!isUpstreamGlobalConversationKey(normalizedKey)) return;
  const map = getLastGlobalConversationMap();
  map[buildLibraryStateKey(libraryID)] = normalizedKey;
  setLastGlobalConversationMap(map);
}

export function removeLastUsedUpstreamGlobalConversationKey(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getLastGlobalConversationMap();
  const key = buildLibraryStateKey(libraryID);
  if (!(key in map)) return;
  delete map[key];
  setLastGlobalConversationMap(map);
}

function setLastPaperConversationMap(value: Record<string, number>): void {
  getZoteroPrefs()?.set?.(
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
  const key = buildPaperStateKey(libraryID, paperItemID);
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
  const key = buildPaperStateKey(libraryID, paperItemID);
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
  const key = buildPaperStateKey(libraryID, paperItemID);
  if (!(key in map)) return;
  delete map[key];
  setLastPaperConversationMap(map);
}

export function getModelConfigGroups(): ModelProviderGroup[] {
  return getModelProviderGroups();
}

export function getAvailableModelEntries(): RuntimeModelEntry[] {
  return getRuntimeModelEntries();
}

export function getSelectedModelEntryForItem(
  itemId: number,
): RuntimeModelEntry | null {
  const entries = getRuntimeModelEntries();
  if (!entries.length) {
    selectedModelCache.delete(itemId);
    return null;
  }

  const preferredId =
    getLastUsedModelEntryId() || selectedModelCache.get(itemId) || "";
  const selected =
    entries.find((entry) => entry.entryId === preferredId) ||
    getDefaultModelEntry() ||
    entries[0] ||
    null;
  if (!selected) {
    selectedModelCache.delete(itemId);
    return null;
  }

  selectedModelCache.set(itemId, selected.entryId);
  return selected;
}

export function setSelectedModelEntryForItem(
  itemId: number,
  entryId: string,
): void {
  const selected = getModelEntryById(entryId);
  if (!selected) return;
  selectedModelCache.set(itemId, selected.entryId);
  setLastUsedModelEntryId(selected.entryId);
}

export function getAdvancedModelParamsForEntry(
  entryId: string | undefined,
): RuntimeModelEntry["advanced"] | undefined {
  const selected = getModelEntryById(entryId);
  return selected?.advanced;
}

export function getProviderLabelForSettings(
  apiBase: string,
  providerIndex: number,
): string {
  return deriveProviderLabel(apiBase, providerIndex);
}

export function applyPanelFontScale(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.setProperty("--llm-font-scale", `${panelFontScalePercent / 100}`);
  panel.style.setProperty(
    "--llm-message-line-height",
    `${messageLineSpacingPercent / 100}`,
  );
  panel.style.setProperty(
    "--llm-message-paragraph-spacing",
    `${messageParagraphSpacingPx}px`,
  );
  panel.style.setProperty(
    "--llm-message-word-spacing",
    `${messageWordSpacingPx}px`,
  );
  panel.style.setProperty(
    "--llm-message-font-family",
    formatMessageFontFamilyCssValue(messageFontFamily),
  );
}

export function getFontScalePref(): number {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${PANEL_FONT_SCALE_PREF_KEY}`,
    true,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT_PERCENT;
  return Math.max(FONT_SCALE_MIN_PERCENT, Math.min(n, FONT_SCALE_MAX_PERCENT));
}

export function setFontScalePref(value: number): void {
  const clamped = Math.max(
    FONT_SCALE_MIN_PERCENT,
    Math.min(value, FONT_SCALE_MAX_PERCENT),
  );
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${PANEL_FONT_SCALE_PREF_KEY}`,
    clamped,
    true,
  );
}

export function getStandaloneSidebarWidthPref(): number {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${STANDALONE_SIDEBAR_WIDTH_PREF_KEY}`,
    true,
  );
  if (typeof raw !== "number" && typeof raw !== "string") {
    return STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX;
  return clampStandaloneSidebarPreferredWidth(parsed);
}

export function setStandaloneSidebarWidthPref(value: number): void {
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${STANDALONE_SIDEBAR_WIDTH_PREF_KEY}`,
    clampStandaloneSidebarPreferredWidth(value),
    true,
  );
}

export function getMessageLineSpacingPref(): number {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${MESSAGE_LINE_SPACING_PREF_KEY}`,
    true,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return MESSAGE_LINE_SPACING_DEFAULT_PERCENT;
  return Math.max(
    MESSAGE_LINE_SPACING_MIN_PERCENT,
    Math.min(n, MESSAGE_LINE_SPACING_MAX_PERCENT),
  );
}

export function setMessageLineSpacingPref(value: number): void {
  const clamped = Math.max(
    MESSAGE_LINE_SPACING_MIN_PERCENT,
    Math.min(value, MESSAGE_LINE_SPACING_MAX_PERCENT),
  );
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${MESSAGE_LINE_SPACING_PREF_KEY}`,
    clamped,
    true,
  );
}

export function getMessageParagraphSpacingPref(): number {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${MESSAGE_PARAGRAPH_SPACING_PREF_KEY}`,
    true,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return MESSAGE_PARAGRAPH_SPACING_DEFAULT_PX;
  return Math.max(
    MESSAGE_PARAGRAPH_SPACING_MIN_PX,
    Math.min(n, MESSAGE_PARAGRAPH_SPACING_MAX_PX),
  );
}

export function setMessageParagraphSpacingPref(value: number): void {
  const clamped = Math.max(
    MESSAGE_PARAGRAPH_SPACING_MIN_PX,
    Math.min(value, MESSAGE_PARAGRAPH_SPACING_MAX_PX),
  );
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${MESSAGE_PARAGRAPH_SPACING_PREF_KEY}`,
    clamped,
    true,
  );
}

export function getMessageWordSpacingPref(): number {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${MESSAGE_WORD_SPACING_PREF_KEY}`,
    true,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return MESSAGE_WORD_SPACING_DEFAULT_PX;
  return Math.max(
    MESSAGE_WORD_SPACING_MIN_PX,
    Math.min(n, MESSAGE_WORD_SPACING_MAX_PX),
  );
}

export function setMessageWordSpacingPref(value: number): void {
  const clamped = Math.max(
    MESSAGE_WORD_SPACING_MIN_PX,
    Math.min(value, MESSAGE_WORD_SPACING_MAX_PX),
  );
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${MESSAGE_WORD_SPACING_PREF_KEY}`,
    clamped,
    true,
  );
}

export function getMessageFontFamilyPref(): string {
  const raw = getZoteroPrefs()?.get?.(
    `${config.prefsPrefix}.${MESSAGE_FONT_FAMILY_PREF_KEY}`,
    true,
  );
  return typeof raw === "string" ? raw : "";
}

export function setMessageFontFamilyPref(value: string): void {
  getZoteroPrefs()?.set?.(
    `${config.prefsPrefix}.${MESSAGE_FONT_FAMILY_PREF_KEY}`,
    value,
    true,
  );
}

function stripFontFamilyQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function formatFontFamilyToken(raw: string): string | null {
  const token = stripFontFamilyQuotes(
    raw
      .replace(/[\n\r;]/g, " ")
      .replace(/[{}]/g, "")
      .trim(),
  );
  if (!token) return null;
  const lower = token.toLowerCase();
  if (GENERIC_FONT_FAMILIES.has(lower)) return lower;
  if (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) return token;
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatMessageFontFamilyCssValue(value: string): string {
  const tokens = value
    .split(",")
    .map(formatFontFamilyToken)
    .filter((token): token is string => Boolean(token));
  if (!tokens.length) return "inherit";
  const hasGenericFallback = tokens.some((token) =>
    GENERIC_FONT_FAMILIES.has(token.toLowerCase()),
  );
  if (!hasGenericFallback) tokens.push("sans-serif");
  return tokens.join(", ");
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

function normalizeShortcutText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeShortcutOverridesForMigration(
  overrides: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [id, prompt] of Object.entries(overrides)) {
    if (!BUILTIN_SHORTCUT_IDS.has(id) || typeof prompt !== "string") continue;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) continue;
    const knownOldPrompts = KNOWN_OLD_BUILTIN_PROMPTS[id] || [];
    const normalizedPrompt = normalizeShortcutText(trimmedPrompt);
    if (
      knownOldPrompts.some(
        (oldPrompt) => normalizeShortcutText(oldPrompt) === normalizedPrompt,
      )
    ) {
      continue;
    }
    next[id] = trimmedPrompt;
  }
  return next;
}

function normalizeShortcutLabelOverridesForMigration(
  labels: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [id, label] of Object.entries(labels)) {
    if (!BUILTIN_SHORTCUT_IDS.has(id) || typeof label !== "string") continue;
    const trimmedLabel = label.trim();
    if (!trimmedLabel) continue;
    next[id] = trimmedLabel;
  }
  return next;
}

function normalizeCustomShortcutList(
  customShortcuts: CustomShortcut[],
): CustomShortcut[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const normalized: CustomShortcut[] = [];

  for (const shortcut of customShortcuts) {
    const id = shortcut.id.trim();
    const prompt = shortcut.prompt.trim();
    const label = shortcut.label.trim() || "Custom Shortcut";
    if (!id || !prompt) continue;
    if (BUILTIN_SHORTCUT_IDS.has(id) || seenIds.has(id)) continue;

    const contentKey = `${label}\u0000${prompt}`;
    if (seenContent.has(contentKey)) continue;
    seenIds.add(id);
    seenContent.add(contentKey);
    normalized.push({ id, label, prompt });
  }

  return normalized;
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
    return normalizeCustomShortcutList(shortcuts);
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

function clearShortcutPref(key: string, fallback: () => void): void {
  const prefName = `${config.prefsPrefix}.${key}`;
  const prefs = getZoteroPrefs();
  if (typeof prefs?.clear === "function") {
    try {
      prefs.clear(prefName, true);
      return;
    } catch {
      // Fall through to the old empty-value behavior for test stubs or older APIs.
    }
  }
  fallback();
}

function logShortcutPrefMaintenance(message: string): void {
  const globalZtoolkit = globalThis as typeof globalThis & {
    ztoolkit?: { log?: (...args: unknown[]) => void };
  };
  try {
    globalZtoolkit.ztoolkit?.log?.(message);
  } catch {
    // Logging must never block pref repair.
  }
}

export function normalizeShortcutOrderForVisibleIds(
  savedOrder: string[],
  currentVisibleIds: string[],
): string[] {
  const visibleSet = new Set(currentVisibleIds);
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const id of savedOrder) {
    if (!visibleSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  for (const id of currentVisibleIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function migrateShortcutDefaultsIfNeeded(): void {
  const prefs = getZoteroPrefs();
  const migrationPref = `${config.prefsPrefix}.${SHORTCUT_DEFAULTS_MIGRATION_PREF_KEY}`;
  const currentVersion = Number(prefs?.get?.(migrationPref, true) || 0);
  if (
    Number.isFinite(currentVersion) &&
    currentVersion >= SHORTCUT_DEFAULTS_MIGRATION_VERSION
  ) {
    return;
  }

  const overrides = normalizeShortcutOverridesForMigration(
    getShortcutOverrides(),
  );
  const labelOverrides = normalizeShortcutLabelOverridesForMigration(
    getShortcutLabelOverrides(),
  );
  const deletedIds = dedupeStrings(getDeletedShortcutIds())
    .filter((id) => BUILTIN_SHORTCUT_IDS.has(id))
    .filter((id) => !BUILTIN_IDS_RESTORED_ON_MIGRATION.has(id));
  const customShortcuts = normalizeCustomShortcutList(getCustomShortcuts());
  const customIds = customShortcuts.map((shortcut) => shortcut.id);
  const visibleBuiltinIds = BUILTIN_SHORTCUT_FILES.map(
    (shortcut) => shortcut.id,
  ).filter((id) => !deletedIds.includes(id));
  const visibleIds = [...visibleBuiltinIds, ...customIds];
  const shortcutOrder = normalizeShortcutOrderForVisibleIds(
    getShortcutOrder(),
    visibleIds,
  );

  setShortcutOverrides(overrides);
  setShortcutLabelOverrides(labelOverrides);
  setDeletedShortcutIds(deletedIds);
  setCustomShortcuts(customShortcuts);
  setShortcutOrder(shortcutOrder);
  prefs?.set?.(migrationPref, SHORTCUT_DEFAULTS_MIGRATION_VERSION, true);
  logShortcutPrefMaintenance(
    `LLM: Migrated shortcut defaults to v${SHORTCUT_DEFAULTS_MIGRATION_VERSION} (previous=${currentVersion || 0}, builtins=${BUILTIN_SHORTCUT_FILES.map((shortcut) => shortcut.id).join(",")})`,
  );
}

export function resetShortcutsToDefault(): void {
  clearShortcutPref("shortcuts", () => setShortcutOverrides({}));
  clearShortcutPref("shortcutLabels", () => setShortcutLabelOverrides({}));
  clearShortcutPref("shortcutDeleted", () => setDeletedShortcutIds([]));
  clearShortcutPref("customShortcuts", () => setCustomShortcuts([]));
  clearShortcutPref("shortcutOrder", () => setShortcutOrder([]));
  logShortcutPrefMaintenance(
    `LLM: Reset shortcuts to defaults (builtins=${BUILTIN_SHORTCUT_FILES.map((shortcut) => shortcut.id).join(",")})`,
  );
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

// =============================================================================
// Locked Global Conversation Preference
// =============================================================================

const LOCKED_GLOBAL_CONVERSATION_PREF_KEY = "lockedGlobalConversation";

/**
 * Returns the conversation key that is locked as the default open-chat session
 * for the given library, or null if no lock is active.
 */
export function getLockedGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const prefKey = `${config.prefsPrefix}.${LOCKED_GLOBAL_CONVERSATION_PREF_KEY}.${Math.floor(libraryID)}`;
  const raw = getZoteroPrefs()?.get?.(prefKey, true);
  const normalized = Number(raw);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  const conversationKey = Math.floor(normalized);
  if (conversationKey === GLOBAL_CONVERSATION_KEY_BASE) {
    return buildDefaultUpstreamGlobalConversationKey(libraryID);
  }
  return isUpstreamGlobalConversationKey(conversationKey)
    ? conversationKey
    : null;
}

/**
 * Locks (or unlocks) a global-chat session as the default for the given library.
 * Pass null or 0 to clear the lock.
 */
export function setLockedGlobalConversationKey(
  libraryID: number,
  key: number | null,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const prefKey = `${config.prefsPrefix}.${LOCKED_GLOBAL_CONVERSATION_PREF_KEY}.${Math.floor(libraryID)}`;
  if (key === null || !Number.isFinite(key) || key <= 0) {
    getZoteroPrefs()?.set?.(prefKey, 0, true);
  } else {
    getZoteroPrefs()?.set?.(prefKey, Math.floor(key), true);
  }
}
