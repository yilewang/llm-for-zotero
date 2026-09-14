import { config } from "../../../package.json";

const KEY = `${config.prefsPrefix}.externalMcpWritesEnabled`;

export function areExternalMcpWritesEnabled(): boolean {
  return Zotero.Prefs.get(KEY, true) === true;
}

export function setExternalMcpWritesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(KEY, enabled, true);
}
