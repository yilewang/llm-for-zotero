import { config } from "../../package.json";

const MINERU_ENABLED_KEY = `${config.prefsPrefix}.mineruEnabled`;
const MINERU_API_KEY_KEY = `${config.prefsPrefix}.mineruApiKey`;
const MINERU_MODE_KEY = `${config.prefsPrefix}.mineruMode`;
const MINERU_LOCAL_API_BASE_KEY = `${config.prefsPrefix}.mineruLocalApiBase`;
const MINERU_LOCAL_BACKEND_KEY = `${config.prefsPrefix}.mineruLocalBackend`;
const MINERU_AUTO_WATCH_KEY = `${config.prefsPrefix}.mineruAutoWatchCollections`;
const MINERU_GLOBAL_AUTO_PARSE_KEY = `${config.prefsPrefix}.mineruGlobalAutoParse`;
const MINERU_SYNC_ENABLED_KEY = `${config.prefsPrefix}.mineruSyncEnabled`;

export const DEFAULT_MINERU_LOCAL_API_BASE = "http://127.0.0.1:8000";
export const DEFAULT_MINERU_LOCAL_BACKEND: MineruLocalBackend = "pipeline";

export type MineruMode = "cloud" | "local";

export type MineruLocalBackend = "pipeline" | "vlm" | "hybrid";

export const MINERU_LOCAL_BACKENDS: readonly MineruLocalBackend[] = [
  "pipeline",
  "vlm",
  "hybrid",
] as const;

const MINERU_BACKEND_API_VALUES: Record<MineruLocalBackend, string> = {
  pipeline: "pipeline",
  vlm: "vlm-auto-engine",
  hybrid: "hybrid-auto-engine",
};

export function toMineruApiBackend(backend: MineruLocalBackend): string {
  return MINERU_BACKEND_API_VALUES[backend];
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

export function normalizeMineruMode(value: unknown): MineruMode {
  return value === "local" ? "local" : "cloud";
}

export function getMineruMode(): MineruMode {
  return normalizeMineruMode(Zotero.Prefs.get(MINERU_MODE_KEY, true));
}

export function setMineruMode(value: MineruMode): void {
  Zotero.Prefs.set(MINERU_MODE_KEY, normalizeMineruMode(value), true);
}

export function normalizeMineruLocalApiBase(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return DEFAULT_MINERU_LOCAL_API_BASE;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.host) {
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.origin}${path}`;
    }
  } catch {
    /* fall back to default */
  }
  return DEFAULT_MINERU_LOCAL_API_BASE;
}

export function getMineruLocalApiBase(): string {
  return normalizeMineruLocalApiBase(
    Zotero.Prefs.get(MINERU_LOCAL_API_BASE_KEY, true),
  );
}

export function setMineruLocalApiBase(value: string): void {
  Zotero.Prefs.set(
    MINERU_LOCAL_API_BASE_KEY,
    normalizeMineruLocalApiBase(value),
    true,
  );
}

export function normalizeMineruLocalBackend(
  value: unknown,
): MineruLocalBackend {
  return MINERU_LOCAL_BACKENDS.includes(value as MineruLocalBackend)
    ? (value as MineruLocalBackend)
    : DEFAULT_MINERU_LOCAL_BACKEND;
}

export function getMineruLocalBackend(): MineruLocalBackend {
  return normalizeMineruLocalBackend(
    Zotero.Prefs.get(MINERU_LOCAL_BACKEND_KEY, true),
  );
}

export function setMineruLocalBackend(value: MineruLocalBackend): void {
  Zotero.Prefs.set(
    MINERU_LOCAL_BACKEND_KEY,
    normalizeMineruLocalBackend(value),
    true,
  );
}

// ── Global Auto-Parse Configuration ──────────────────────────────────────────

export function isGlobalAutoParseEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_GLOBAL_AUTO_PARSE_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setGlobalAutoParseEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_GLOBAL_AUTO_PARSE_KEY, value, true);
}

// ── Zotero File Sync Configuration ──────────────────────────────────────────

export function isMineruSyncEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_SYNC_ENABLED_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setMineruSyncEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_SYNC_ENABLED_KEY, value, true);
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
