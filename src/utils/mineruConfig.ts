import { config } from "../../package.json";

const MINERU_ENABLED_KEY = `${config.prefsPrefix}.mineruEnabled`;
const MINERU_API_KEY_KEY = `${config.prefsPrefix}.mineruApiKey`;
const MINERU_BACKEND_KEY = `${config.prefsPrefix}.mineruBackend`;
const MINERU_LOCAL_BASE_URL_KEY = `${config.prefsPrefix}.mineruLocalBaseUrl`;
const MINERU_LOCAL_HOST_KEY = `${config.prefsPrefix}.mineruLocalHost`;
const MINERU_LOCAL_PORT_KEY = `${config.prefsPrefix}.mineruLocalPort`;
const MINERU_LOCAL_LANGUAGE_KEY = `${config.prefsPrefix}.mineruLocalLanguage`;
const MINERU_LOCAL_BACKEND_KEY = `${config.prefsPrefix}.mineruLocalBackend`;
const MINERU_LOCAL_PARSE_METHOD_KEY = `${config.prefsPrefix}.mineruLocalParseMethod`;
const MINERU_LOCAL_FORMULA_KEY = `${config.prefsPrefix}.mineruLocalFormula`;
const MINERU_LOCAL_TABLE_KEY = `${config.prefsPrefix}.mineruLocalTable`;
const MINERU_AUTO_WATCH_KEY = `${config.prefsPrefix}.mineruAutoWatchCollections`;
const MINERU_GLOBAL_AUTO_PARSE_KEY = `${config.prefsPrefix}.mineruGlobalAutoParse`;

export type MineruBackendMode = "cloud" | "local";

export type MineruLocalOptions = {
  baseUrl: string;
  host: string;
  port: string;
  language: string;
  backend: string;
  parseMethod: string;
  formulaEnable: boolean;
  tableEnable: boolean;
};

const DEFAULT_MINERU_LOCAL_HOST = "10.9.9.9";
const DEFAULT_MINERU_LOCAL_PORT = "1337";
export const DEFAULT_MINERU_LOCAL_BASE_URL = `http://${DEFAULT_MINERU_LOCAL_HOST}:${DEFAULT_MINERU_LOCAL_PORT}`;
export const DEFAULT_MINERU_LOCAL_LANGUAGE = "ch";
export const DEFAULT_MINERU_LOCAL_BACKEND = "hybrid-auto-engine";
export const DEFAULT_MINERU_LOCAL_PARSE_METHOD = "auto";

function getStringPref(key: string): string {
  const value = Zotero.Prefs.get(key, true);
  return typeof value === "string" ? value.trim() : "";
}

function getBooleanPref(key: string, fallback: boolean): boolean {
  const value = Zotero.Prefs.get(key, true);
  if (typeof value === "boolean") return value;
  const normalized = `${value || ""}`.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function normalizeMineruLocalBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_MINERU_LOCAL_BASE_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function isMineruEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_ENABLED_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function getMineruApiKey(): string {
  const value = Zotero.Prefs.get(MINERU_API_KEY_KEY, true);
  return typeof value === "string" ? value : "";
}

export function setMineruEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_ENABLED_KEY, value, true);
}

export function setMineruApiKey(value: string): void {
  Zotero.Prefs.set(MINERU_API_KEY_KEY, value, true);
}

export function getMineruBackendMode(): MineruBackendMode {
  return getStringPref(MINERU_BACKEND_KEY) === "local" ? "local" : "cloud";
}

export function setMineruBackendMode(value: MineruBackendMode): void {
  Zotero.Prefs.set(MINERU_BACKEND_KEY, value, true);
}

export function getMineruLocalOptions(): MineruLocalOptions {
  const baseUrl = normalizeMineruLocalBaseUrl(
    getStringPref(MINERU_LOCAL_BASE_URL_KEY),
  );
  const host = getStringPref(MINERU_LOCAL_HOST_KEY) || DEFAULT_MINERU_LOCAL_HOST;
  const port = getStringPref(MINERU_LOCAL_PORT_KEY) || DEFAULT_MINERU_LOCAL_PORT;
  return {
    baseUrl,
    host,
    port,
    language:
      getStringPref(MINERU_LOCAL_LANGUAGE_KEY) || DEFAULT_MINERU_LOCAL_LANGUAGE,
    backend:
      getStringPref(MINERU_LOCAL_BACKEND_KEY) || DEFAULT_MINERU_LOCAL_BACKEND,
    parseMethod:
      getStringPref(MINERU_LOCAL_PARSE_METHOD_KEY) ||
      DEFAULT_MINERU_LOCAL_PARSE_METHOD,
    formulaEnable: getBooleanPref(MINERU_LOCAL_FORMULA_KEY, true),
    tableEnable: getBooleanPref(MINERU_LOCAL_TABLE_KEY, true),
  };
}

export function setMineruLocalBaseUrl(value: string): void {
  Zotero.Prefs.set(
    MINERU_LOCAL_BASE_URL_KEY,
    normalizeMineruLocalBaseUrl(value),
    true,
  );
}

export function setMineruLocalHost(value: string): void {
  Zotero.Prefs.set(MINERU_LOCAL_HOST_KEY, value.trim(), true);
}

export function setMineruLocalPort(value: string): void {
  Zotero.Prefs.set(MINERU_LOCAL_PORT_KEY, value.trim(), true);
}

export function setMineruLocalLanguage(value: string): void {
  Zotero.Prefs.set(MINERU_LOCAL_LANGUAGE_KEY, value.trim(), true);
}

export function setMineruLocalBackend(value: string): void {
  Zotero.Prefs.set(MINERU_LOCAL_BACKEND_KEY, value.trim(), true);
}

export function setMineruLocalParseMethod(value: string): void {
  Zotero.Prefs.set(MINERU_LOCAL_PARSE_METHOD_KEY, value.trim(), true);
}

export function setMineruLocalFormulaEnable(value: boolean): void {
  Zotero.Prefs.set(MINERU_LOCAL_FORMULA_KEY, value, true);
}

export function setMineruLocalTableEnable(value: boolean): void {
  Zotero.Prefs.set(MINERU_LOCAL_TABLE_KEY, value, true);
}

// ── Global Auto-Parse Configuration ──────────────────────────────────────────

export function isGlobalAutoParseEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_GLOBAL_AUTO_PARSE_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setGlobalAutoParseEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_GLOBAL_AUTO_PARSE_KEY, value, true);
}

// ── Auto-Watch Collections Configuration ─────────────────────────────────────

export function getAutoWatchCollectionIds(): Set<number> {
  const value = Zotero.Prefs.get(MINERU_AUTO_WATCH_KEY, true);
  const str = typeof value === "string" ? value : "";
  if (!str) return new Set();
  const ids = str
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return new Set(ids);
}

export function setAutoWatchCollectionIds(ids: Set<number>): void {
  const str = Array.from(ids).join(",");
  Zotero.Prefs.set(MINERU_AUTO_WATCH_KEY, str, true);
}

export function addAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.add(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function removeAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.delete(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function isAutoWatchCollection(collectionId: number): boolean {
  return getAutoWatchCollectionIds().has(collectionId);
}

// ── Filename Exclusion Patterns ─────────────────────────────────────────────

const MINERU_EXCLUDE_PATTERNS_KEY = `${config.prefsPrefix}.mineruExcludePatterns`;

export function getMineruExcludePatterns(): string[] {
  const raw = Zotero.Prefs.get(MINERU_EXCLUDE_PATTERNS_KEY, true);
  const str = typeof raw === "string" ? raw : "";
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());
  } catch {
    return [];
  }
}

export function setMineruExcludePatterns(patterns: string[]): void {
  Zotero.Prefs.set(MINERU_EXCLUDE_PATTERNS_KEY, JSON.stringify(patterns), true);
}

export function isFilenameExcluded(filename: string): boolean {
  const patterns = getMineruExcludePatterns();
  if (patterns.length === 0) return false;
  const lower = filename.toLowerCase();
  for (const pat of patterns) {
    if (pat.startsWith("/") && pat.endsWith("/") && pat.length > 2) {
      try {
        if (new RegExp(pat.slice(1, -1), "i").test(filename)) return true;
      } catch {
        /* invalid regex — skip */
      }
    } else {
      if (lower.includes(pat.toLowerCase())) return true;
    }
  }
  return false;
}
