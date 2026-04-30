import { config } from "../../package.json";

// Pref keys: path/folder/attachments use old obsidian keys for backward compat
// with existing user data. Nickname is a new key.
const NOTES_DIR_PATH_KEY = `${config.prefsPrefix}.obsidianVaultPath`;
const NOTES_DIR_FOLDER_KEY = `${config.prefsPrefix}.obsidianTargetFolder`;
const NOTES_DIR_ATTACHMENTS_KEY = `${config.prefsPrefix}.obsidianAttachmentsFolder`;
const NOTES_DIR_NICKNAME_KEY = `${config.prefsPrefix}.notesDirectoryNickname`;

type ZoteroPrefsLike = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getPrefs(): ZoteroPrefsLike | null {
  return (
    (globalThis as typeof globalThis & {
      Zotero?: { Prefs?: ZoteroPrefsLike };
    }).Zotero?.Prefs || null
  );
}

function getStringPref(key: string, fallback = ""): string {
  const value = getPrefs()?.get?.(key, true);
  return typeof value === "string" ? value : fallback;
}

function setStringPref(key: string, value: string): void {
  getPrefs()?.set?.(key, value, true);
}

export function getNotesDirectoryPath(): string {
  return getStringPref(NOTES_DIR_PATH_KEY);
}

export function setNotesDirectoryPath(value: string): void {
  setStringPref(NOTES_DIR_PATH_KEY, value);
}

export function getNotesDirectoryFolder(): string {
  return getStringPref(NOTES_DIR_FOLDER_KEY, "Zotero Notes");
}

export function setNotesDirectoryFolder(value: string): void {
  setStringPref(NOTES_DIR_FOLDER_KEY, value);
}

export function getNotesDirectoryAttachmentsFolder(): string {
  return getStringPref(NOTES_DIR_ATTACHMENTS_KEY, "assets");
}

export function setNotesDirectoryAttachmentsFolder(value: string): void {
  setStringPref(NOTES_DIR_ATTACHMENTS_KEY, value);
}

export function getNotesDirectoryNickname(): string {
  return getStringPref(NOTES_DIR_NICKNAME_KEY);
}

export function setNotesDirectoryNickname(value: string): void {
  setStringPref(NOTES_DIR_NICKNAME_KEY, value);
}

export function isNotesDirectoryConfigured(): boolean {
  return getNotesDirectoryPath().trim().length > 0;
}
