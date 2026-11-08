/**
 * The Inline Ask card's quick prompts (pills). A pill sends its prompt; the
 * card shows its label as the question.
 *
 * The built-ins are Explain, Define terms and Translate. The user edits,
 * deletes, adds and resets prompts from the card's right-click menu; the
 * changes live in Inline Ask's own prefs, apart from the sidebar's shortcut
 * prefs:
 *
 * - inlineAskPrompts: a JSON list of edited built-ins (by built-in id) and
 *   the user's own prompts, in the order added.
 * - inlineAskDeletedPrompts: a JSON list of deleted built-in ids.
 *
 * An unedited built-in follows the UI language (t()); an edited one keeps
 * the user's text. The card shows at most MAX_INLINE_ASK_PROMPTS prompts:
 * the remaining built-ins first, then the user's own. Reset clears both
 * prefs, which restores the three built-ins.
 */
import { t } from "../../../utils/i18n";
import {
  clearPref,
  getStringArrayPref,
  getStringPref,
  setStringArrayPref,
  setStringPref,
} from "../prefHelpers";

export type InlineAskQuickPrompt = {
  id: string;
  label: string;
  prompt: string;
};

export type InlineAskPromptText = { label: string; prompt: string };

export const MAX_INLINE_ASK_PROMPTS = 20;
export const INLINE_ASK_PROMPTS_PREF = "inlineAskPrompts";
export const INLINE_ASK_DELETED_PROMPTS_PREF = "inlineAskDeletedPrompts";
const CUSTOM_PROMPT_ID_PREFIX = "inline-ask-custom";

/** English sources; t() gives the UI-language copy (zh-CN in i18n.ts). */
export const DEFAULT_INLINE_ASK_PROMPTS: readonly InlineAskQuickPrompt[] = [
  {
    id: "explain",
    label: "Explain",
    prompt:
      "Explain this passage in plain language, using the context of the paper.",
  },
  {
    id: "define",
    label: "Define terms",
    prompt: "Define the technical terms in this passage.",
  },
  {
    id: "translate",
    label: "Translate",
    // Names the UI language: the zh-CN copy asks for Chinese.
    prompt: "Translate this passage into English.",
  },
];

const BUILTIN_IDS = new Set(
  DEFAULT_INLINE_ASK_PROMPTS.map((entry) => entry.id),
);

export type InlineAskPromptStore = {
  /** Edited built-ins and the user's own prompts, in the order added. */
  saved: InlineAskQuickPrompt[];
  /** Built-in ids the user deleted. */
  deleted: string[];
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The saved list from its pref text; drops malformed and repeated rows. */
export function parseInlineAskSavedPrompts(
  raw: string,
): InlineAskQuickPrompt[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: InlineAskQuickPrompt[] = [];
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
export function readInlineAskPromptStore(): InlineAskPromptStore {
  try {
    return {
      saved: parseInlineAskSavedPrompts(getStringPref(INLINE_ASK_PROMPTS_PREF)),
      deleted: getStringArrayPref(INLINE_ASK_DELETED_PROMPTS_PREF).filter(
        (id) => BUILTIN_IDS.has(id),
      ),
    };
  } catch {
    return { saved: [], deleted: [] };
  }
}

export function writeInlineAskPromptStore(store: InlineAskPromptStore): void {
  if (store.saved.length) {
    setStringPref(INLINE_ASK_PROMPTS_PREF, JSON.stringify(store.saved));
  } else {
    clearPref(INLINE_ASK_PROMPTS_PREF);
  }
  if (store.deleted.length) {
    setStringArrayPref(INLINE_ASK_DELETED_PROMPTS_PREF, store.deleted);
  } else {
    clearPref(INLINE_ASK_DELETED_PROMPTS_PREF);
  }
}

function translatedDefault(
  entry: InlineAskQuickPrompt,
  translate: (text: string) => string,
): InlineAskQuickPrompt {
  return {
    id: entry.id,
    label: translate(entry.label),
    prompt: translate(entry.prompt),
  };
}

/** The pills, in order: remaining built-ins, then the user's own. */
export function buildInlineAskQuickPrompts(
  store: InlineAskPromptStore,
  translate: (text: string) => string = t,
): InlineAskQuickPrompt[] {
  const deleted = new Set(store.deleted);
  const savedById = new Map(store.saved.map((entry) => [entry.id, entry]));
  const builtins = DEFAULT_INLINE_ASK_PROMPTS.filter(
    (entry) => !deleted.has(entry.id),
  ).map((entry) => {
    const edited = savedById.get(entry.id);
    return edited ? { ...edited } : translatedDefault(entry, translate);
  });
  const custom = store.saved
    .filter((entry) => !BUILTIN_IDS.has(entry.id))
    .map((entry) => ({ ...entry }));
  return [...builtins, ...custom].slice(0, MAX_INLINE_ASK_PROMPTS);
}

function normalizedText(value: InlineAskPromptText): InlineAskPromptText {
  return { label: cleanText(value.label), prompt: cleanText(value.prompt) };
}

/**
 * The store after editing prompt `id`. A built-in edited back to its shown
 * default drops its override, so it follows the UI language again.
 */
export function editInlineAskPromptInStore(
  store: InlineAskPromptStore,
  id: string,
  value: InlineAskPromptText,
  translate: (text: string) => string = t,
): InlineAskPromptStore {
  const { label, prompt } = normalizedText(value);
  if (!label || !prompt) return store;
  const builtin = DEFAULT_INLINE_ASK_PROMPTS.find((entry) => entry.id === id);
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

/** The store with a new prompt last, or null when the card is full. */
export function addInlineAskPromptToStore(
  store: InlineAskPromptStore,
  value: InlineAskPromptText,
  id: string,
): InlineAskPromptStore | null {
  const { label, prompt } = normalizedText(value);
  if (!label || !prompt || !id) return null;
  if (BUILTIN_IDS.has(id) || store.saved.some((entry) => entry.id === id))
    return null;
  if (buildInlineAskQuickPrompts(store).length >= MAX_INLINE_ASK_PROMPTS)
    return null;
  return { ...store, saved: [...store.saved, { id, label, prompt }] };
}

export function deleteInlineAskPromptFromStore(
  store: InlineAskPromptStore,
  id: string,
): InlineAskPromptStore {
  const saved = store.saved.filter((entry) => entry.id !== id);
  if (!BUILTIN_IDS.has(id)) return { ...store, saved };
  const deleted = store.deleted.includes(id)
    ? store.deleted
    : [...store.deleted, id];
  return { saved, deleted };
}

export function createInlineAskPromptId(): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_PROMPT_ID_PREFIX}-${Date.now().toString(36)}-${token}`;
}

/** The prompts as the card shows them now. */
export function getInlineAskQuickPrompts(): InlineAskQuickPrompt[] {
  return buildInlineAskQuickPrompts(readInlineAskPromptStore());
}

/**
 * The card's prompt editing, persisted at once. Each call reads the prefs
 * fresh, so two open cards cannot overwrite each other's changes.
 */
export type InlineAskPromptEditing = {
  list(): InlineAskQuickPrompt[];
  canAdd(): boolean;
  edit(id: string, value: InlineAskPromptText): void;
  /** False when the card is full or the text is empty. */
  add(value: InlineAskPromptText): boolean;
  remove(id: string): void;
  reset(): void;
};

export function createInlineAskPromptEditing(
  createId: () => string = createInlineAskPromptId,
): InlineAskPromptEditing {
  return {
    list: getInlineAskQuickPrompts,
    canAdd: () => getInlineAskQuickPrompts().length < MAX_INLINE_ASK_PROMPTS,
    edit: (id, value) => {
      const store = readInlineAskPromptStore();
      const next = editInlineAskPromptInStore(store, id, value);
      if (next !== store) writeInlineAskPromptStore(next);
    },
    add: (value) => {
      const next = addInlineAskPromptToStore(
        readInlineAskPromptStore(),
        value,
        createId(),
      );
      if (!next) return false;
      writeInlineAskPromptStore(next);
      return true;
    },
    remove: (id) => {
      writeInlineAskPromptStore(
        deleteInlineAskPromptFromStore(readInlineAskPromptStore(), id),
      );
    },
    reset: () => {
      writeInlineAskPromptStore({ saved: [], deleted: [] });
    },
  };
}
