/**
 * The saved reader selection of each runtime (plugin Agent, Codex, Claude
 * Code), next to the per-runtime main model prefs. The sidebar reads and
 * writes these; the standalone window and side chats keep their own in-memory
 * copies (modules/contextPanel/surfaceChoices.ts).
 */
declare const Zotero: any;

import { config } from "../../package.json";
import {
  decodeReaderSelection,
  encodeReaderSelection,
  type ReaderRuntimeKey,
  type ReaderSelection,
} from "../shared/readerSelection";

const READER_CHOICE_PREF_KEYS: Record<ReaderRuntimeKey, string> = {
  agent: "readerChoiceAgent",
  codex: "readerChoiceCodex",
  claude: "readerChoiceClaude",
};

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function prefs(): ZoteroPrefsAPI | null {
  return (
    (Zotero as unknown as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs || null
  );
}

function prefKey(runtime: ReaderRuntimeKey): string {
  return `${config.prefsPrefix}.${READER_CHOICE_PREF_KEYS[runtime]}`;
}

/** The stored string ("" for Same as main). */
export function getReaderChoicePref(runtime: ReaderRuntimeKey): string {
  const value = prefs()?.get?.(prefKey(runtime), true);
  return encodeReaderSelection(decodeReaderSelection(value));
}

export function setReaderChoicePref(
  runtime: ReaderRuntimeKey,
  stored: string,
): void {
  prefs()?.set?.(
    prefKey(runtime),
    encodeReaderSelection(decodeReaderSelection(stored)),
    true,
  );
}

export function getReaderSelectionPref(
  runtime: ReaderRuntimeKey,
): ReaderSelection | null {
  return decodeReaderSelection(getReaderChoicePref(runtime));
}
