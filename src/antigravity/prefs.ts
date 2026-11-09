import { config } from "../../package.json";
import {
  DEFAULT_ANTIGRAVITY_RUNTIME_MODEL,
  getAntigravityAllocatedConversationKeyRange,
  getAntigravityGlobalConversationKeyRange,
  getAntigravityPaperConversationKeyRange,
  getAntigravityProfileSignature,
  type AntigravityEffortMode,
} from "./constants";
import { buildAntigravityLibraryStateKey } from "./state";
import {
  forgetPaperRestoreTarget,
  getPaperRestoreTarget,
  rememberPaperRestoreTarget,
} from "../shared/paperConversationRestore";

/**
 * How much the agent may do on its own. agy has no interactive approvals in
 * headless mode: a tool that needs approval is refused and reported.
 */
export type AntigravityPermissionMode = "default" | "plan" | "full";

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
      if (trimmed) normalized[entryKey] = trimmed;
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonStringPref(key: string, value: Record<string, string>): void {
  setPref(key, JSON.stringify(value));
}

export function isAntigravityModeEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("enableAntigravityMode"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

export function setAntigravityModeEnabled(enabled: boolean): void {
  setPref("enableAntigravityMode", Boolean(enabled));
}

export function getAntigravityRuntimeModelPref(): string {
  return (
    getStringPref("antigravityModel").trim() ||
    DEFAULT_ANTIGRAVITY_RUNTIME_MODEL
  );
}

export function setAntigravityRuntimeModelPref(model: string): void {
  setPref("antigravityModel", model.trim());
}

export function getAntigravityEffortPref(): AntigravityEffortMode {
  const raw = getStringPref("antigravityEffort").trim().toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" ? raw : "auto";
}

export function setAntigravityEffortPref(mode: AntigravityEffortMode): void {
  setPref("antigravityEffort", mode);
}

export function getAntigravityPermissionModePref(): AntigravityPermissionMode {
  const raw = getStringPref("antigravityPermissionMode").trim();
  return raw === "plan" || raw === "full" ? raw : "default";
}

export function setAntigravityPermissionModePref(
  mode: AntigravityPermissionMode,
): void {
  setPref("antigravityPermissionMode", mode);
}

export function getAntigravityBinaryPathPref(): string {
  return getStringPref("antigravityPath").trim();
}

export function setAntigravityBinaryPathPref(path: string): void {
  setPref("antigravityPath", path.trim());
}

function buildGlobalConversationMapKey(libraryID: number): string {
  return buildAntigravityLibraryStateKey(libraryID);
}

export function getLastUsedAntigravityConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonStringPref("antigravityConversationModeMap");
  const value = map[buildGlobalConversationMapKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedAntigravityConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("antigravityConversationModeMap");
  map[buildGlobalConversationMapKey(libraryID)] =
    mode === "paper" ? "paper" : "global";
  setJsonStringPref("antigravityConversationModeMap", map);
}

export function removeLastUsedAntigravityConversationMode(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("antigravityConversationModeMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonStringPref("antigravityConversationModeMap", map);
}

export function isConversationKeyInRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range =
    kind === "global"
      ? getAntigravityGlobalConversationKeyRange()
      : getAntigravityPaperConversationKeyRange();
  return value >= range.start && value < range.endExclusive;
}

function isConversationKeyInAllocatedRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range = getAntigravityAllocatedConversationKeyRange(kind);
  return value >= range.start && value < range.endExclusive;
}

export function getLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonPref("antigravityGlobalConversationMap");
  const value = Number(map[buildGlobalConversationMapKey(libraryID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return isConversationKeyInRange(value, "global") ? Math.floor(value) : null;
}

export function setLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "global")) return;
  const map = getJsonPref("antigravityGlobalConversationMap");
  map[buildGlobalConversationMapKey(libraryID)] = Math.floor(conversationKey);
  setJsonPref("antigravityGlobalConversationMap", map);
}

export function removeLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonPref("antigravityGlobalConversationMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonPref("antigravityGlobalConversationMap", map);
}

export function getLastUsedAntigravityPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  return getPaperRestoreTarget({
    system: "antigravity",
    libraryID,
    paperItemID,
  });
}

export function setLastUsedAntigravityPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "paper")) return;
  rememberPaperRestoreTarget(
    { system: "antigravity", libraryID, paperItemID },
    conversationKey,
  );
}

export function removeLastUsedAntigravityPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  forgetPaperRestoreTarget({ system: "antigravity", libraryID, paperItemID });
}

function buildLastAllocatedMapKey(kind: "global" | "paper"): string {
  return `${getAntigravityProfileSignature()}:${kind}`;
}

function getLastAllocatedConversationKey(
  kind: "global" | "paper",
): number | null {
  const map = getJsonPref("antigravityLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey(kind)]);
  return Number.isFinite(value) &&
    isConversationKeyInAllocatedRange(value, kind)
    ? Math.floor(value)
    : null;
}

function setLastAllocatedConversationKey(
  kind: "global" | "paper",
  conversationKey: number,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInAllocatedRange(conversationKey, kind)) return;
  const normalized = Math.floor(conversationKey);
  if (normalized <= (getLastAllocatedConversationKey(kind) || 0)) return;
  const map = getJsonPref("antigravityLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey(kind)] = normalized;
  setJsonPref("antigravityLastAllocatedConversationKeyMap", map);
}

export function getLastAllocatedAntigravityGlobalConversationKey():
  | number
  | null {
  return getLastAllocatedConversationKey("global");
}

export function setLastAllocatedAntigravityGlobalConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("global", conversationKey);
}

export function getLastAllocatedAntigravityPaperConversationKey():
  | number
  | null {
  return getLastAllocatedConversationKey("paper");
}

export function setLastAllocatedAntigravityPaperConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("paper", conversationKey);
}
