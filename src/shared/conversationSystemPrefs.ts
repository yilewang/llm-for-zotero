/**
 * Preferences that belong to conversation systems as a whole: which system
 * the panel uses, and whether each runtime's mode is turned on.
 */

import { config } from "../../package.json";
import {
  RUNTIME_CONVERSATION_SYSTEMS,
  RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS,
  normalizeConversationSystem,
  type ConversationSystem,
  type RuntimeConversationSystem,
} from "../core/conversations/conversationSystems";

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

const CONVERSATION_SYSTEM_PREF = "conversationSystem";

/** The stored system, or null when the pref is missing or unrecognized. */
export function getStoredConversationSystemPref(): ConversationSystem | null {
  return normalizeConversationSystem(
    getZoteroPrefs()?.get?.(prefKey(CONVERSATION_SYSTEM_PREF), true),
  );
}

export function getConversationSystemPref(): ConversationSystem {
  return getStoredConversationSystemPref() || "upstream";
}

export function setConversationSystemPref(system: ConversationSystem): void {
  getZoteroPrefs()?.set?.(
    prefKey(CONVERSATION_SYSTEM_PREF),
    normalizeConversationSystem(system) || "upstream",
    true,
  );
}

function readBooleanPref(key: string): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

/** Whether the user turned the runtime's mode on in settings. */
export function isRuntimeConversationSystemEnabled(
  system: RuntimeConversationSystem,
): boolean {
  return readBooleanPref(
    RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].enablePref,
  );
}

export function setRuntimeConversationSystemEnabled(
  system: RuntimeConversationSystem,
  enabled: boolean,
): void {
  getZoteroPrefs()?.set?.(
    prefKey(RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].enablePref),
    Boolean(enabled),
    true,
  );
}

/** The upstream system is always available; a runtime when its mode is on. */
export function isConversationSystemEnabled(
  system: ConversationSystem,
): boolean {
  return system === "upstream" || isRuntimeConversationSystemEnabled(system);
}

/**
 * The runtimes the user added in Settings (comma-separated system ids); the
 * built-in runtime is always there and never listed.
 */
const ADDED_RUNTIME_SYSTEMS_PREF = "addedRuntimeSystems";

/** The runtimes the user added, in registry order. */
export function getAddedRuntimeSystems(): RuntimeConversationSystem[] {
  const raw = String(
    getZoteroPrefs()?.get?.(prefKey(ADDED_RUNTIME_SYSTEMS_PREF), true) || "",
  );
  const names = new Set(raw.split(",").map((name) => name.trim()));
  return RUNTIME_CONVERSATION_SYSTEMS.filter((system) => names.has(system));
}

export function setAddedRuntimeSystems(
  systems: readonly RuntimeConversationSystem[],
): void {
  const wanted = new Set(systems);
  getZoteroPrefs()?.set?.(
    prefKey(ADDED_RUNTIME_SYSTEMS_PREF),
    RUNTIME_CONVERSATION_SYSTEMS.filter((system) => wanted.has(system)).join(
      ",",
    ),
    true,
  );
}

/** Listed in Settings: added, or switched on (so set up before the list). */
export function isRuntimeListed(system: RuntimeConversationSystem): boolean {
  return (
    getAddedRuntimeSystems().includes(system) ||
    isRuntimeConversationSystemEnabled(system)
  );
}
