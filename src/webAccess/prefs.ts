import { config } from "../../package.json";
import { getDeepSeekSearchCredential } from "./deepseekSearchKey";
import type { WebAccessProviderId } from "./types";

export type { WebAccessProviderId } from "./types";

export const TAVILY_API_KEY_PREF = `${config.prefsPrefix}.tavilyApiKey`;
export const ANYSEARCH_API_KEY_PREF = `${config.prefsPrefix}.anysearchApiKey`;
export const WEB_ACCESS_PROVIDER_PREF = `${config.prefsPrefix}.webAccessProvider`;

const PROVIDERS: readonly WebAccessProviderId[] = [
  "tavily",
  "anysearch",
  "deepseek",
];

/** The saved choice; unknown values (including an old "auto") read as "tavily". */
export function getWebAccessProvider(): WebAccessProviderId {
  try {
    const value = Zotero.Prefs.get(WEB_ACCESS_PROVIDER_PREF, true);
    return PROVIDERS.find((provider) => provider === value) || "tavily";
  } catch {
    return "tavily";
  }
}

export function setWebAccessProvider(value: WebAccessProviderId): void {
  if (!PROVIDERS.includes(value)) {
    throw new Error("Unsupported web access provider.");
  }
  Zotero.Prefs.set(WEB_ACCESS_PROVIDER_PREF, value, true);
}

/** True when the chosen provider can make a call: the tools are offered. */
export function isWebAccessConfigured(): boolean {
  switch (getWebAccessProvider()) {
    case "anysearch":
      return true;
    case "deepseek":
      return Boolean(getDeepSeekSearchCredential());
    default:
      return hasTavilyApiKey();
  }
}

/**
 * Deliberately no environment, model-key, or cross-provider fallback for
 * Tavily and AnySearch. DeepSeek is the one exception: its key comes from an
 * official DeepSeek model profile (see deepseekSearchKey.ts).
 */
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
