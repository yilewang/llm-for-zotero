import { config } from "../../package.json";

export const TAVILY_API_KEY_PREF = `${config.prefsPrefix}.tavilyApiKey`;

export function getTavilyApiKey(): string {
  try {
    return String(Zotero.Prefs.get(TAVILY_API_KEY_PREF, true) || "").trim();
  } catch {
    return "";
  }
}

export function setTavilyApiKey(value: string): void {
  Zotero.Prefs.set(TAVILY_API_KEY_PREF, value.trim(), true);
}

export function hasTavilyApiKey(): boolean {
  return Boolean(getTavilyApiKey());
}
