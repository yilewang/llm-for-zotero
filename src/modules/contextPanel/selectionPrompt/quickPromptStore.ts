/**
 * Editable quick prompts: a list of built-in prompts the user can edit,
 * delete, add to and reset, kept in two prefs of the list's own.
 *
 * Two lists use it: the reader's Inline Ask pills (inlineAskPrompts.ts) and
 * the note editor's inline writing shortcuts (noteInlinePrompts.ts). Each
 * list names its built-ins and prefs:
 *
 * - savedPref: a JSON list of edited built-ins (by built-in id) and the
 *   user's own prompts, in the order added.
 * - deletedPref: a JSON list of deleted built-in ids.
 *
 * An unedited built-in follows the UI language (t()); an edited one keeps
 * the user's text. A list shows at most MAX_QUICK_PROMPTS prompts: the
 * remaining built-ins first, then the user's own. Reset clears both prefs,
 * which restores the built-ins.
 */
import { t } from "../../../utils/i18n";
import {
  clearPref,
  getStringArrayPref,
  getStringPref,
  setStringArrayPref,
  setStringPref,
} from "../prefHelpers";

export type QuickPrompt = {
  id: string;
  label: string;
  prompt: string;
};

export type QuickPromptText = { label: string; prompt: string };

export type QuickPromptList = {
  /** English sources; t() gives the UI-language copy. */
  defaults: readonly QuickPrompt[];
  savedPref: string;
  deletedPref: string;
  /** The start of the ids of the user's own prompts. */
  customIdPrefix: string;
};

export const MAX_QUICK_PROMPTS = 20;

export type QuickPromptStore = {
  /** Edited built-ins and the user's own prompts, in the order added. */
  saved: QuickPrompt[];
  /** Built-in ids the user deleted. */
  deleted: string[];
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isBuiltin(list: QuickPromptList, id: string): boolean {
  return list.defaults.some((entry) => entry.id === id);
}

/** The saved list from its pref text; drops malformed and repeated rows. */
export function parseSavedQuickPrompts(raw: string): QuickPrompt[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: QuickPrompt[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = cleanText(record.id);
    const label = cleanText(record.label);
    const prompt = cleanText(record.prompt);
    if (!id || !label || !prompt || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, prompt });
  }
  return out;
}

/** The stored changes; unreadable prefs read as none (the defaults). */
export function readQuickPromptStore(list: QuickPromptList): QuickPromptStore {
  try {
    return {
      saved: parseSavedQuickPrompts(getStringPref(list.savedPref)),
      deleted: getStringArrayPref(list.deletedPref).filter((id) =>
        isBuiltin(list, id),
      ),
    };
  } catch {
    return { saved: [], deleted: [] };
  }
}

export function writeQuickPromptStore(
  list: QuickPromptList,
  store: QuickPromptStore,
): void {
  if (store.saved.length) {
    setStringPref(list.savedPref, JSON.stringify(store.saved));
  } else {
    clearPref(list.savedPref);
  }
  if (store.deleted.length) {
    setStringArrayPref(list.deletedPref, store.deleted);
  } else {
    clearPref(list.deletedPref);
  }
}

function translatedDefault(
  entry: QuickPrompt,
  translate: (text: string) => string,
): QuickPrompt {
  return {
    id: entry.id,
    label: translate(entry.label),
    prompt: translate(entry.prompt),
  };
}

/** The prompts, in order: remaining built-ins, then the user's own. */
export function buildQuickPrompts(
  list: QuickPromptList,
  store: QuickPromptStore,
  translate: (text: string) => string = t,
): QuickPrompt[] {
  const deleted = new Set(store.deleted);
  const savedById = new Map(store.saved.map((entry) => [entry.id, entry]));
  const builtins = list.defaults
    .filter((entry) => !deleted.has(entry.id))
    .map((entry) => {
      const edited = savedById.get(entry.id);
      return edited ? { ...edited } : translatedDefault(entry, translate);
    });
  const custom = store.saved
    .filter((entry) => !isBuiltin(list, entry.id))
    .map((entry) => ({ ...entry }));
  return [...builtins, ...custom].slice(0, MAX_QUICK_PROMPTS);
}

function normalizedText(value: QuickPromptText): QuickPromptText {
  return { label: cleanText(value.label), prompt: cleanText(value.prompt) };
}

/**
 * The store after editing prompt `id`. A built-in edited back to its shown
 * default drops its override, so it follows the UI language again.
 */
export function editQuickPromptInStore(
  list: QuickPromptList,
  store: QuickPromptStore,
  id: string,
  value: QuickPromptText,
  translate: (text: string) => string = t,
): QuickPromptStore {
  const { label, prompt } = normalizedText(value);
  if (!label || !prompt) return store;
  const builtin = list.defaults.find((entry) => entry.id === id);
  if (builtin) {
    if (store.deleted.includes(id)) return store;
    const shown = translatedDefault(builtin, translate);
    const others = store.saved.filter((entry) => entry.id !== id);
    if (shown.label === label && shown.prompt === prompt) {
      return { ...store, saved: others };
    }
    const index = store.saved.findIndex((entry) => entry.id === id);
    const saved = store.saved.slice();
    if (index >= 0) saved[index] = { id, label, prompt };
    else saved.push({ id, label, prompt });
    return { ...store, saved };
  }
  const index = store.saved.findIndex((entry) => entry.id === id);
  if (index < 0) return store;
  const saved = store.saved.slice();
  saved[index] = { id, label, prompt };
  return { ...store, saved };
}

/** The store with a new prompt last, or null when the list is full. */
export function addQuickPromptToStore(
  list: QuickPromptList,
  store: QuickPromptStore,
  value: QuickPromptText,
  id: string,
): QuickPromptStore | null {
  const { label, prompt } = normalizedText(value);
  if (!label || !prompt || !id) return null;
  if (isBuiltin(list, id) || store.saved.some((entry) => entry.id === id))
    return null;
  if (buildQuickPrompts(list, store).length >= MAX_QUICK_PROMPTS) return null;
  return { ...store, saved: [...store.saved, { id, label, prompt }] };
}

export function deleteQuickPromptFromStore(
  list: QuickPromptList,
  store: QuickPromptStore,
  id: string,
): QuickPromptStore {
  const saved = store.saved.filter((entry) => entry.id !== id);
  if (!isBuiltin(list, id)) return { ...store, saved };
  const deleted = store.deleted.includes(id)
    ? store.deleted
    : [...store.deleted, id];
  return { saved, deleted };
}

export function createQuickPromptId(list: QuickPromptList): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `${list.customIdPrefix}-${Date.now().toString(36)}-${token}`;
}

/** The list's prompts as shown now. */
export function listQuickPrompts(list: QuickPromptList): QuickPrompt[] {
  return buildQuickPrompts(list, readQuickPromptStore(list));
}

/**
 * A list's editing, persisted at once. Each call reads the prefs fresh, so
 * two open popups cannot overwrite each other's changes.
 */
export type QuickPromptEditing = {
  list(): QuickPrompt[];
  canAdd(): boolean;
  edit(id: string, value: QuickPromptText): void;
  /** False when the list is full or the text is empty. */
  add(value: QuickPromptText): boolean;
  remove(id: string): void;
  reset(): void;
};

export function createQuickPromptEditing(
  list: QuickPromptList,
  createId: () => string = () => createQuickPromptId(list),
): QuickPromptEditing {
  const current = () => listQuickPrompts(list);
  return {
    list: current,
    canAdd: () => current().length < MAX_QUICK_PROMPTS,
    edit: (id, value) => {
      const store = readQuickPromptStore(list);
      const next = editQuickPromptInStore(list, store, id, value);
      if (next !== store) writeQuickPromptStore(list, next);
    },
    add: (value) => {
      const next = addQuickPromptToStore(
        list,
        readQuickPromptStore(list),
        value,
        createId(),
      );
      if (!next) return false;
      writeQuickPromptStore(list, next);
      return true;
    },
    remove: (id) => {
      writeQuickPromptStore(
        list,
        deleteQuickPromptFromStore(list, readQuickPromptStore(list), id),
      );
    },
    reset: () => {
      writeQuickPromptStore(list, { saved: [], deleted: [] });
    },
  };
}
