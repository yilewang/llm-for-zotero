import { config } from "../../package.json";

export const TAVILY_API_KEY_PREF = `${config.prefsPrefix}.tavilyApiKey`;
export const ANYSEARCH_API_KEY_PREF = `${config.prefsPrefix}.anysearchApiKey`;
export const WEB_ACCESS_PROVIDER_PREF = `${config.prefsPrefix}.webAccessProvider`;
export type WebAccessProviderId = "tavily" | "anysearch";

export function getWebAccessProvider(): WebAccessProviderId {
  try {
    return Zotero.Prefs.get(WEB_ACCESS_PROVIDER_PREF, true) === "anysearch"
      ? "anysearch"
      : "tavily";
  } catch {
    return "tavily";
  }
}

export function setWebAccessProvider(value: WebAccessProviderId): void {
  if (value !== "tavily" && value !== "anysearch") {
    throw new Error("Unsupported web access provider.");
  }
  Zotero.Prefs.set(WEB_ACCESS_PROVIDER_PREF, value, true);
}

/** Deliberately no environment, model-key, or cross-provider fallback. */
export function getAnysearchApiKey(): string {
  try {
    return String(Zotero.Prefs.get(ANYSEARCH_API_KEY_PREF, true) || "").trim();
  } catch {
    return "";
  }
}

export function setAnysearchApiKey(value: string): void {
  Zotero.Prefs.set(ANYSEARCH_API_KEY_PREF, value.trim(), true);
}

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
