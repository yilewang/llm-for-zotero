declare const Zotero: any;

import { config } from "../../package.json";
import {
  DEFAULT_CODEX_RUNTIME_MODEL,
  CODEX_REASONING_OPTIONS,
  getCodexGlobalConversationKeyRange,
  getCodexPaperConversationKeyRange,
  getCodexProfileSignature,
  type CodexReasoningMode,
  type CodexRuntimeModel,
} from "./constants";
import { buildCodexLibraryStateKey, buildCodexPaperStateKey } from "./state";

export type CodexNativeSkillRoutingMode =
  | "hybrid"
  | "deterministic"
  | "classifier";

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefsAPI } })
      .Zotero?.Prefs || null
  );
}

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function getStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  return typeof value === "string" ? value : "";
}

function getNumberPref(key: string): number | null {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function setPref(key: string, value: unknown): void {
  getZoteroPrefs()?.set?.(prefKey(key), value, true);
}

function getJsonPref(key: string): Record<string, number> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      const n = Number(entryValue);
      if (!Number.isFinite(n) || n <= 0) continue;
      normalized[entryKey] = Math.floor(n);
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, number>): void {
  setPref(key, JSON.stringify(value));
}

function getJsonStringPref(key: string): Record<string, string> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, string> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      if (typeof entryValue !== "string") continue;
      const trimmed = entryValue.trim();
      if (!trimmed) continue;
      normalized[entryKey] = trimmed;
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonStringPref(key: string, value: Record<string, string>): void {
  setPref(key, JSON.stringify(value));
}

export function isCodexAppServerModeEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("enableCodexAppServerMode"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function setCodexAppServerModeEnabled(enabled: boolean): void {
  setPref("enableCodexAppServerMode", Boolean(enabled));
}

export function getCodexRuntimeModelPref(): CodexRuntimeModel {
  return (
    getStringPref("codexAppServerModel").trim() || DEFAULT_CODEX_RUNTIME_MODEL
  );
}

export function setCodexRuntimeModelPref(model: string): void {
  const normalized = model.trim() || DEFAULT_CODEX_RUNTIME_MODEL;
  setPref("codexAppServerModel", normalized);
}

export function getCodexReasoningModePref(): CodexReasoningMode {
  const raw = getStringPref("codexAppServerReasoning").trim().toLowerCase();
  return CODEX_REASONING_OPTIONS.includes(raw as CodexReasoningMode)
    ? (raw as CodexReasoningMode)
    : "auto";
}

export function setCodexReasoningModePref(mode: CodexReasoningMode): void {
  if (!CODEX_REASONING_OPTIONS.includes(mode)) return;
  setPref("codexAppServerReasoning", mode);
}

export function getCodexBinaryPathPref(): string {
  return getStringPref("codexAppServerPath").trim();
}

export function setCodexBinaryPathPref(path: string): void {
  setPref("codexAppServerPath", String(path || "").trim());
}

export function isCodexZoteroMcpToolsEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("codexAppServerZoteroMcpToolsEnabled"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return true;
}

export function setCodexZoteroMcpToolsEnabled(enabled: boolean): void {
  setPref("codexAppServerZoteroMcpToolsEnabled", Boolean(enabled));
}

export function getCodexNativeSkillRoutingModePref(): CodexNativeSkillRoutingMode {
  const raw = getStringPref("codexNativeSkillRoutingMode").trim().toLowerCase();
  if (raw === "deterministic" || raw === "classifier" || raw === "hybrid") {
    return raw;
  }
  return "hybrid";
}

export function setCodexNativeSkillRoutingModePref(
  mode: CodexNativeSkillRoutingMode,
): void {
  if (mode !== "hybrid" && mode !== "deterministic" && mode !== "classifier") {
    return;
  }
  setPref("codexNativeSkillRoutingMode", mode);
}

export function getLastUsedCodexConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonStringPref("codexAppServerConversationModeMap");
  const value = map[buildGlobalConversationMapKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedCodexConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("codexAppServerConversationModeMap");
  map[buildGlobalConversationMapKey(libraryID)] = mode === "paper" ? "paper" : "global";
  setJsonStringPref("codexAppServerConversationModeMap", map);
}

export function removeLastUsedCodexConversationMode(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("codexAppServerConversationModeMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonStringPref("codexAppServerConversationModeMap", map);
}

function buildPaperConversationMapKey(
  libraryID: number,
  paperItemID: number,
): string {
  return buildCodexPaperStateKey(libraryID, paperItemID);
}

function buildGlobalConversationMapKey(libraryID: number): string {
  return buildCodexLibraryStateKey(libraryID);
}

export function isConversationKeyInRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range = kind === "global"
    ? getCodexGlobalConversationKeyRange()
    : getCodexPaperConversationKeyRange();
  return value >= range.start && value < range.endExclusive;
}

export function getLastUsedCodexGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonPref("codexAppServerGlobalConversationMap");
  const value = Number(map[buildGlobalConversationMapKey(libraryID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return isConversationKeyInRange(value, "global") ? Math.floor(value) : null;
}

export function setLastUsedCodexGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getJsonPref("codexAppServerGlobalConversationMap");
  map[buildGlobalConversationMapKey(libraryID)] = Math.floor(conversationKey);
  setJsonPref("codexAppServerGlobalConversationMap", map);
}

export function removeLastUsedCodexGlobalConversationKey(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonPref("codexAppServerGlobalConversationMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonPref("codexAppServerGlobalConversationMap", map);
}

export function getLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
  const map = getJsonPref("codexAppServerPaperConversationMap");
  const value = Number(map[buildPaperConversationMapKey(libraryID, paperItemID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return isConversationKeyInRange(value, "paper") ? Math.floor(value) : null;
}

export function setLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getJsonPref("codexAppServerPaperConversationMap");
  map[buildPaperConversationMapKey(libraryID, paperItemID)] = Math.floor(conversationKey);
  setJsonPref("codexAppServerPaperConversationMap", map);
}

export function removeLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  const map = getJsonPref("codexAppServerPaperConversationMap");
  delete map[buildPaperConversationMapKey(libraryID, paperItemID)];
  setJsonPref("codexAppServerPaperConversationMap", map);
}

function buildLastAllocatedMapKey(kind: "global" | "paper"): string {
  return `${getCodexProfileSignature()}:${kind}`;
}

function getScopedLegacyAllocatedConversationKey(kind: "global" | "paper"): number | null {
  const value = getNumberPref(
    kind === "global"
      ? "codexAppServerLastAllocatedGlobalConversationKey"
      : "codexAppServerLastAllocatedPaperConversationKey",
  );
  return value && isConversationKeyInRange(value, kind) ? value : null;
}

export function getLastAllocatedCodexGlobalConversationKey(): number | null {
  const map = getJsonPref("codexAppServerLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey("global")]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return getScopedLegacyAllocatedConversationKey("global");
}

export function setLastAllocatedCodexGlobalConversationKey(conversationKey: number): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const current = getLastAllocatedCodexGlobalConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = getJsonPref("codexAppServerLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey("global")] = normalized;
  setJsonPref("codexAppServerLastAllocatedConversationKeyMap", map);
  setPref("codexAppServerLastAllocatedGlobalConversationKey", normalized);
}

export function getLastAllocatedCodexPaperConversationKey(): number | null {
  const map = getJsonPref("codexAppServerLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey("paper")]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return getScopedLegacyAllocatedConversationKey("paper");
}

export function setLastAllocatedCodexPaperConversationKey(conversationKey: number): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const current = getLastAllocatedCodexPaperConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = getJsonPref("codexAppServerLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey("paper")] = normalized;
  setJsonPref("codexAppServerLastAllocatedConversationKeyMap", map);
  setPref("codexAppServerLastAllocatedPaperConversationKey", normalized);
}
