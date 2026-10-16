declare const Zotero: any;

import { config } from "../../package.json";

/**
 * Preferences for the ACP agent backend.
 *
 * The backend is one pref rather than a conversation system: a conversation
 * that runs on ACP is still this plugin's own conversation (its storage,
 * history and key space), so nothing about it changes when the backend does.
 * See `src/acp/runtime.ts` for what that buys and what it defers.
 */

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (Zotero as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs || null;
}

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function getStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  return typeof value === "string" ? value : "";
}

function getBooleanPref(key: string, fallback: boolean): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function setPref(key: string, value: unknown): void {
  getZoteroPrefs()?.set?.(prefKey(key), value, true);
}

/** Any ACP agent is acceptable; this is the one we know works. */
export const DEFAULT_ACP_AGENT_COMMAND = "hermes acp --accept-hooks";

export function isAcpAgentEnabled(): boolean {
  return getBooleanPref("enableAcpAgent", false);
}

export function setAcpAgentEnabled(enabled: boolean): void {
  setPref("enableAcpAgent", Boolean(enabled));
}

export function getAcpAgentCommand(): string {
  return getStringPref("acpAgentCommand").trim() || DEFAULT_ACP_AGENT_COMMAND;
}

export function setAcpAgentCommand(command: string): void {
  setPref("acpAgentCommand", command.trim());
}

/**
 * Working directory for `session/new`. Empty means the plugin's own runtime
 * root, which is where the other external runtimes start too.
 */
export function getAcpWorkingDirectory(): string {
  return getStringPref("acpWorkingDirectory").trim();
}

export function setAcpWorkingDirectory(directory: string): void {
  setPref("acpWorkingDirectory", directory.trim());
}
