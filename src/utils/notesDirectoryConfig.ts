import { config } from "../../package.json";

// Pref keys: path/folder/attachments use old obsidian keys for backward compat
// with existing user data. Nickname is a new key.
const NOTES_DIR_PATH_KEY = `${config.prefsPrefix}.obsidianVaultPath`;
const NOTES_DIR_FOLDER_KEY = `${config.prefsPrefix}.obsidianTargetFolder`;
const NOTES_DIR_ATTACHMENTS_KEY = `${config.prefsPrefix}.obsidianAttachmentsFolder`;
const NOTES_DIR_NICKNAME_KEY = `${config.prefsPrefix}.notesDirectoryNickname`;

export function getNotesDirectoryPath(): string {
  const value = Zotero.Prefs.get(NOTES_DIR_PATH_KEY, true);
  return typeof value === "string" ? value : "";
}

export function setNotesDirectoryPath(value: string): void {
  Zotero.Prefs.set(NOTES_DIR_PATH_KEY, value, true);
}

export function getNotesDirectoryFolder(): string {
  const value = Zotero.Prefs.get(NOTES_DIR_FOLDER_KEY, true);
  return typeof value === "string" ? value : "Zotero Notes";
}

export function setNotesDirectoryFolder(value: string): void {
  Zotero.Prefs.set(NOTES_DIR_FOLDER_KEY, value, true);
}

export function getNotesDirectoryAttachmentsFolder(): string {
  const value = Zotero.Prefs.get(NOTES_DIR_ATTACHMENTS_KEY, true);
  return typeof value === "string" ? value : "assets";
}

export function setNotesDirectoryAttachmentsFolder(value: string): void {
  Zotero.Prefs.set(NOTES_DIR_ATTACHMENTS_KEY, value, true);
}

export function getNotesDirectoryNickname(): string {
  const value = Zotero.Prefs.get(NOTES_DIR_NICKNAME_KEY, true);
  return typeof value === "string" ? value : "";
}

export function setNotesDirectoryNickname(value: string): void {
  Zotero.Prefs.set(NOTES_DIR_NICKNAME_KEY, value, true);
}

export function isNotesDirectoryConfigured(): boolean {
  return getNotesDirectoryPath().trim().length > 0;
}
