import { config } from "../../package.json";

const CODEX_DIRECT_REASONING_PREF_KEY = `${config.prefsPrefix}.codexDirectReasoningSelections`;

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getPrefs(): ZoteroPrefsAPI | undefined {
  return (Zotero as unknown as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs;
}

function selectionKey(model: string): string {
  return model.trim().toLowerCase();
}

function readSelections(): Record<string, string> {
  const raw = getPrefs()?.get?.(CODEX_DIRECT_REASONING_PREF_KEY, true);
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries = Object.entries(parsed);
    const selections: Record<string, string> = {};
    let migrated = false;
    for (const [key, value] of entries) {
      if (key.includes("\u0000")) continue;
      if (typeof value === "string" && value.trim()) {
        selections[selectionKey(key)] = value.trim();
      }
    }
    for (const [key, value] of entries) {
      const separator = key.indexOf("\u0000");
      if (separator < 0) continue;
      migrated = true;
      const modelKey = selectionKey(key.slice(separator + 1));
      if (
        modelKey &&
        selections[modelKey] === undefined &&
        typeof value === "string" &&
        value.trim()
      ) {
        selections[modelKey] = value.trim();
      }
    }
    if (migrated) {
      getPrefs()?.set?.(
        CODEX_DIRECT_REASONING_PREF_KEY,
        JSON.stringify(selections),
        true,
      );
    }
    return selections;
  } catch (_error) {
    return {};
  }
}

export function getCodexDirectReasoningSelection(model: string): string {
  return readSelections()[selectionKey(model)] || "auto";
}

export function setCodexDirectReasoningSelection(
  model: string,
  selection: string,
): void {
  const key = selectionKey(model);
  const value = selection.trim() || "auto";
  const selections = readSelections();
  if (selections[key] === value) return;
  selections[key] = value;
  getPrefs()?.set?.(
    CODEX_DIRECT_REASONING_PREF_KEY,
    JSON.stringify(selections),
    true,
  );
}
