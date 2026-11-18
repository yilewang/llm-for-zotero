import {
  isRuntimeConversationSystemEnabled,
  setRuntimeConversationSystemEnabled,
} from "../shared/conversationSystemPrefs";
import { config } from "../../package.json";
import {
  getAntigravityProfileSignature,
  isAntigravityConversationKeyInAllocatedRange,
  isAntigravityConversationKeyInRange,
} from "./conversationKeys";
import {
  forgetPaperRestoreTarget,
  getPaperRestoreTarget,
  rememberPaperRestoreTarget,
} from "../shared/paperConversationRestore";

/**
 * Antigravity preferences. Conversation-key memory is scoped by profile
 * signature from the start, so it has no legacy unscoped prefs to read.
 */

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

type Kind = "global" | "paper";

const MODE_MAP_PREF = "antigravityConversationModeMap";
const GLOBAL_KEY_MAP_PREF = "antigravityGlobalConversationMap";
const ALLOCATED_KEY_MAP_PREF = "antigravityLastAllocatedConversationKeyMap";

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefsAPI } })
      .Zotero?.Prefs || null
  );
}

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function readJsonMap(key: string): Record<string, unknown> {
  const raw = getZoteroPrefs()?.get?.(prefKey(key), true);
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonMap(key: string, map: Record<string, unknown>): void {
  getZoteroPrefs()?.set?.(prefKey(key), JSON.stringify(map), true);
}

function isPositiveInt(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function libraryStateKey(libraryID: number): string {
  return `${getAntigravityProfileSignature()}:${Math.floor(libraryID)}`;
}

function allocatedStateKey(kind: Kind): string {
  return `${getAntigravityProfileSignature()}:${kind}`;
}

export function isAntigravityModeEnabled(): boolean {
  return isRuntimeConversationSystemEnabled("antigravity");
}

export function setAntigravityModeEnabled(enabled: boolean): void {
  setRuntimeConversationSystemEnabled("antigravity", enabled);
}

export function getLastUsedAntigravityConversationMode(
  libraryID: number,
): Kind | null {
  if (!isPositiveInt(libraryID)) return null;
  const value = readJsonMap(MODE_MAP_PREF)[libraryStateKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedAntigravityConversationMode(
  libraryID: number,
  mode: Kind,
): void {
  if (!isPositiveInt(libraryID)) return;
  const map = readJsonMap(MODE_MAP_PREF);
  map[libraryStateKey(libraryID)] = mode === "paper" ? "paper" : "global";
  writeJsonMap(MODE_MAP_PREF, map);
}

export function removeLastUsedAntigravityConversationMode(
  libraryID: number,
): void {
  if (!isPositiveInt(libraryID)) return;
  const map = readJsonMap(MODE_MAP_PREF);
  delete map[libraryStateKey(libraryID)];
  writeJsonMap(MODE_MAP_PREF, map);
}

export function getLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!isPositiveInt(libraryID)) return null;
  const value = Number(
    readJsonMap(GLOBAL_KEY_MAP_PREF)[libraryStateKey(libraryID)],
  );
  return isAntigravityConversationKeyInRange(value, "global")
    ? Math.floor(value)
    : null;
}

export function setLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!isPositiveInt(libraryID)) return;
  if (!isAntigravityConversationKeyInRange(conversationKey, "global")) return;
  const map = readJsonMap(GLOBAL_KEY_MAP_PREF);
  map[libraryStateKey(libraryID)] = Math.floor(conversationKey);
  writeJsonMap(GLOBAL_KEY_MAP_PREF, map);
}

export function removeLastUsedAntigravityGlobalConversationKey(
  libraryID: number,
): void {
  if (!isPositiveInt(libraryID)) return;
  const map = readJsonMap(GLOBAL_KEY_MAP_PREF);
  delete map[libraryStateKey(libraryID)];
  writeJsonMap(GLOBAL_KEY_MAP_PREF, map);
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
  if (!isPositiveInt(libraryID) || !isPositiveInt(paperItemID)) return;
  if (!isAntigravityConversationKeyInRange(conversationKey, "paper")) return;
  rememberPaperRestoreTarget(
    { system: "antigravity", libraryID, paperItemID },
    conversationKey,
  );
}

export function removeLastUsedAntigravityPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!isPositiveInt(libraryID) || !isPositiveInt(paperItemID)) return;
  forgetPaperRestoreTarget({ system: "antigravity", libraryID, paperItemID });
}

function getLastAllocatedConversationKey(kind: Kind): number | null {
  const value = Number(
    readJsonMap(ALLOCATED_KEY_MAP_PREF)[allocatedStateKey(kind)],
  );
  return isAntigravityConversationKeyInAllocatedRange(value, kind)
    ? Math.floor(value)
    : null;
}

/** Records a newly allocated key; the stored value only moves forward. */
function setLastAllocatedConversationKey(
  kind: Kind,
  conversationKey: number,
): void {
  if (!isAntigravityConversationKeyInAllocatedRange(conversationKey, kind)) {
    return;
  }
  const normalized = Math.floor(conversationKey);
  if (normalized <= (getLastAllocatedConversationKey(kind) || 0)) return;
  const map = readJsonMap(ALLOCATED_KEY_MAP_PREF);
  map[allocatedStateKey(kind)] = normalized;
  writeJsonMap(ALLOCATED_KEY_MAP_PREF, map);
}

export function getLastAllocatedAntigravityGlobalConversationKey():
  | number
  | null {
  return getLastAllocatedConversationKey("global");
}

export function getLastAllocatedAntigravityPaperConversationKey():
  | number
  | null {
  return getLastAllocatedConversationKey("paper");
}

export function setLastAllocatedAntigravityGlobalConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("global", conversationKey);
}

export function setLastAllocatedAntigravityPaperConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("paper", conversationKey);
}
