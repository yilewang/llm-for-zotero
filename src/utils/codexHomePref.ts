import { config } from "../../package.json";
import { isWindowsDriveAbsolutePath, joinLocalPath } from "./localPath";

const CODEX_HOME_PREF_KEY = `${config.prefsPrefix}.codexHome`;

/**
 * Turns the folder as the user typed it into a path Codex and IOUtils accept:
 * drops one pair of surrounding quotes (Windows "Copy as path" adds them),
 * expands a leading `~`, and gives a drive path backslashes.
 */
export function normalizeCodexHomePath(
  value: string,
  resolveHomeDir: () => string,
): string {
  let path = value.trim();
  const quoted = path.match(/^(["'])(.*)\1$/);
  if (quoted) path = quoted[2].trim();
  const tilde = path.match(/^~(?:[\\/](.*))?$/);
  if (tilde) {
    const home = resolveHomeDir();
    if (home) path = tilde[1] ? joinLocalPath(home, tilde[1]) : home;
  }
  if (isWindowsDriveAbsolutePath(path)) path = joinLocalPath(path);
  return path;
}

function resolveHomeDir(): string {
  const scope = globalThis as {
    PathUtils?: { homeDir?: string };
    Services?: {
      dirsvc?: { get?: (key: string, iface: unknown) => { path?: string } };
    };
    Ci?: { nsIFile?: unknown };
  };
  try {
    return (
      scope.PathUtils?.homeDir ||
      scope.Services?.dirsvc?.get?.("Home", scope.Ci?.nsIFile)?.path ||
      ""
    );
  } catch {
    return "";
  }
}

/**
 * The folder the user set for the Codex App Server runtime; empty means
 * "leave CODEX_HOME as Zotero inherited it". Read by the process launcher and
 * by Codex sign-in lookup, so it lives below both.
 */
export function getCodexHomePref(): string {
  const value = (
    globalThis as {
      Zotero?: {
        Prefs?: { get?: (key: string, global?: boolean) => unknown };
      };
    }
  ).Zotero?.Prefs?.get?.(CODEX_HOME_PREF_KEY, true);
  return typeof value === "string"
    ? normalizeCodexHomePath(value, resolveHomeDir)
    : "";
}
