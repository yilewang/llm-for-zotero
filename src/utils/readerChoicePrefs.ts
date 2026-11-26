import { config } from "../../package.json";
import {
  decodeReaderSelection,
  encodeReaderSelection,
  type ReaderRuntimeKey,
} from "../shared/readerSelection";
import { getZoteroPrefs } from "./pluginPrefs";

const READER_CHOICE_PREF_KEYS: Record<ReaderRuntimeKey, string> = {
  agent: "readerChoiceAgent",
  codex: "readerChoiceCodex",
  claude: "readerChoiceClaude",
  antigravity: "readerChoiceAntigravity",
};

function prefKey(runtime: ReaderRuntimeKey): string {
  return `${config.prefsPrefix}.${READER_CHOICE_PREF_KEYS[runtime]}`;
}

/** The stored string ("" for Same as main). */
export function getReaderChoicePref(runtime: ReaderRuntimeKey): string {
  const value = getZoteroPrefs()?.get?.(prefKey(runtime), true);
  return encodeReaderSelection(decodeReaderSelection(value));
}

export function setReaderChoicePref(
  runtime: ReaderRuntimeKey,
  stored: string,
): void {
  getZoteroPrefs()?.set?.(
    prefKey(runtime),
    encodeReaderSelection(decodeReaderSelection(stored)),
    true,
  );
}
