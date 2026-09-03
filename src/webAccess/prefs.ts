import { config } from "../../package.json";

export const TAVILY_API_KEY_PREF = `${config.prefsPrefix}.tavilyApiKey`;
export const YOUCOM_API_KEY_PREF = `${config.prefsPrefix}.youcomApiKey`;
export const WEB_ACCESS_PROVIDER_PREF = `${config.prefsPrefix}.webAccessProvider`;

export type WebAccessProviderKind = "tavily" | "youcom";

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

export function getYoucomApiKey(): string {
  try {
    return String(Zotero.Prefs.get(YOUCOM_API_KEY_PREF, true) || "").trim();
  } catch {
    return "";
  }
}

export function setYoucomApiKey(value: string): void {
  Zotero.Prefs.set(YOUCOM_API_KEY_PREF, value.trim(), true);
}

export function hasYoucomApiKey(): boolean {
  return Boolean(getYoucomApiKey());
}

export function getWebAccessProvider(): WebAccessProviderKind {
  try {
    const value = String(
      Zotero.Prefs.get(WEB_ACCESS_PROVIDER_PREF, true) || "",
    ).trim();
    return value === "youcom" ? "youcom" : "tavily";
  } catch {
    return "tavily";
  }
}

export function setWebAccessProvider(value: WebAccessProviderKind): void {
  Zotero.Prefs.set(WEB_ACCESS_PROVIDER_PREF, value, true);
}

export function hasConfiguredWebAccessApiKey(): boolean {
  return getWebAccessProvider() === "youcom"
    ? hasYoucomApiKey()
    : hasTavilyApiKey();
}
