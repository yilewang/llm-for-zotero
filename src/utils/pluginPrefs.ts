/**
 * Reading and writing the plugin's own Zotero preferences.
 *
 * Every function takes the short preference name (`claudeCodeModel`) and
 * adds the plugin's prefix itself. Outside Zotero, where there is no
 * preference store, reads give the empty result and writes do nothing.
 */
import { config } from "../../package.json";

/** The parts of `Zotero.Prefs` the plugin uses. */
export type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
  clear?: (key: string, global?: boolean) => void;
  prefHasUserValue?: (key: string) => boolean;
};

/** Zotero's preference store, or null outside Zotero. */
export function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefsAPI } })
      .Zotero?.Prefs || null
  );
}

/** The full name of one of the plugin's preferences. */
export function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

/** The preference when it holds a string, otherwise "". */
export function readStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  return typeof value === "string" ? value : "";
}

/** The preference as a number above zero, rounded down, otherwise null. */
export function readPositiveIntPref(key: string): number | null {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** Stores a value under the preference. */
export function writePref(key: string, value: unknown): void {
  getZoteroPrefs()?.set?.(prefKey(key), value, true);
}

/**
 * A preference that holds a JSON object of numbers. Entries that are not a
 * number above zero are left out; text that is not valid JSON gives {}.
 */
export function readPositiveIntMapPref(key: string): Record<string, number> {
  const raw = readStringPref(key).trim();
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

/**
 * A preference that holds a JSON object of strings. Values are trimmed, and
 * entries that are empty or not a string are left out; text that is not
 * valid JSON gives {}.
 */
export function readStringMapPref(key: string): Record<string, string> {
  const raw = readStringPref(key).trim();
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
