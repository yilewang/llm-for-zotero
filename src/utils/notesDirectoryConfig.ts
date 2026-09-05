import { config } from "../../package.json";
import { joinLocalPath } from "./localPath";

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

export type NotesDirectoryConfig = {
  directoryPath: string;
  defaultFolder: string;
  defaultTargetPath: string;
  attachmentsFolder: string;
  attachmentsPath: string;
  nickname: string;
};

/**
 * Path information attached to note-writing requests. This is purely
 * informational: it never overrides the path the agent chooses. Its only
 * enforcement consumer is run_command's channel rule, which redirects
 * Markdown note writes to file_io (same paths, same content — just the
 * tool that carries undo and overwrite confirmation).
 */
export type NotesDirectoryWritePolicy = NotesDirectoryConfig;

function getPrefs(): ZoteroPrefsLike | null {
  return (
    (
      globalThis as typeof globalThis & {
        Zotero?: { Prefs?: ZoteroPrefsLike };
      }
    ).Zotero?.Prefs || null
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

export function getNotesDirectoryConfig(): NotesDirectoryConfig | null {
  if (!isNotesDirectoryConfigured()) return null;
  const directoryPath = getNotesDirectoryPath();
  const defaultFolder = getNotesDirectoryFolder();
  const attachmentsFolder = getNotesDirectoryAttachmentsFolder();
  const nickname = getNotesDirectoryNickname().trim();
  const defaultTargetPath = defaultFolder
    ? joinLocalPath(directoryPath, defaultFolder)
    : directoryPath;
  const attachmentsPath = attachmentsFolder
    ? joinLocalPath(directoryPath, attachmentsFolder)
    : "";
  return {
    directoryPath,
    defaultFolder,
    defaultTargetPath,
    attachmentsFolder,
    attachmentsPath,
    nickname,
  };
}

export function buildNotesDirectoryConfigSection(): string {
  const notesConfig = getNotesDirectoryConfig();
  if (!notesConfig) return "";
  const lines = ["Notes directory configuration (user-configured):"];
  if (notesConfig.nickname) {
    lines.push(`- Nickname: ${notesConfig.nickname}`);
  }
  lines.push(
    `- Directory path: ${notesConfig.directoryPath}`,
    `- Default folder: ${notesConfig.defaultFolder}`,
    `- Default target path: ${notesConfig.defaultTargetPath}`,
    `- Default note file template: ${joinLocalPath(notesConfig.defaultTargetPath, "<filename>.md")}`,
    `- Rule: Default target path is the default destination, not a constraint. When neither the user's message nor their skill customizations direct otherwise, write file-based notes directly under it (do not append Default folder to Default target path again). When the user's message or skill customizations specify another folder, layout, or path pattern, follow that instead — subdirectories are created automatically.`,
    `- Attachments folder: ${notesConfig.attachmentsFolder} (relative to notes directory root)`,
  );
  if (notesConfig.attachmentsPath) {
    lines.push(
      `- Attachments path: ${notesConfig.attachmentsPath} (resolved absolute path for copying images)`,
    );
  }
  if (notesConfig.nickname) {
    lines.push(
      `When the user mentions "${notesConfig.nickname}" in the context of notes, write to this directory.`,
    );
  }
  return lines.join("\n");
}

function normalizeForComparison(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function isLocalPathInsideOrEqual(
  path: string,
  directory: string,
): boolean {
  const normalizedPath = normalizeForComparison(path);
  const normalizedDirectory = normalizeForComparison(directory);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}/`)
  );
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

export function parseNotesDirectoryWritePolicy(
  value: unknown,
): NotesDirectoryWritePolicy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const directoryPath = readStringField(record, "directoryPath");
  const defaultTargetPath = readStringField(record, "defaultTargetPath");
  if (!directoryPath || !defaultTargetPath) return null;
  return {
    directoryPath,
    defaultFolder: readStringField(record, "defaultFolder"),
    defaultTargetPath,
    attachmentsFolder: readStringField(record, "attachmentsFolder"),
    attachmentsPath: readStringField(record, "attachmentsPath"),
    nickname: readStringField(record, "nickname"),
  };
}
