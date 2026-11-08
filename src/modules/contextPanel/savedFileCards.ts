/**
 * File cards: the files an agent turn saved to disk, shown under its answer.
 *
 * A turn's files are found two ways, both on the finished answer, so every
 * runtime (plugin agent, Codex, Claude Code) is covered the same way:
 * - paths the answer names (the agent is told to give each saved file's full
 *   path), kept when the file sits in the chat's folder or was changed while
 *   the turn ran;
 * - files in the chat's folder (see agentFilesDirectory) changed while the
 *   turn ran, so a file the answer forgot to name still gets a card.
 *
 * The first finished render records what it found in `.llm-files.json` in the
 * chat's folder. Later renders read that record, so a file deleted or moved
 * afterwards keeps its card, which then says the file is no longer there. A
 * card is never shown for a path that never existed.
 */

import { markStandaloneFlatScope } from "./contentChrome";
import { t } from "../../utils/i18n";
import { getIOUtils } from "../../utils/geckoFs";
import {
  fileUrlToPath,
  isAbsoluteLocalPath,
  joinLocalPath,
  toFileUrl,
} from "../../utils/localPath";
import { launchLocalPath, revealLocalPath } from "../../utils/revealLocalPath";
import {
  AGENT_FILES_WORK_FOLDER,
  getAgentFilesRoot,
  resolveAgentFilesFolder,
  type AgentFilesTarget,
} from "../../utils/agentFilesDirectory";
import {
  fenceAround,
  getSidePanelItemHost,
  isOutsideAnswerContent,
  NO_SIDE_ITEMS_ATTRIBUTE,
  registerSideItemRequest,
  SIDE_ITEM_KIND_ATTRIBUTE,
} from "./sidePanelItems";
import { copyTextToClipboard } from "./clipboard";
import { openFigureViewer } from "./figureViewer";
import { createSandboxedHtmlFrame } from "./htmlPreviewFrame";
import { openStandaloneViewerWindow } from "./standaloneMermaidWindow";
import {
  isGlobalPortalItem,
  resolvePaperPortalBaseItem,
} from "../../services/context/portalItems";

export const SAVED_FILES_MANIFEST = ".llm-files.json";
/** A page bigger than this opens only from Finder, not in the chat. */
export const SAVED_FILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** A picture bigger than this keeps the type tile on its card. */
export const SAVED_FILE_CARD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** The Markdown a card's preview draws, from the top of the note. */
const CARD_MARKDOWN_PREVIEW_CHARS = 4000;
/** The width a page or note is laid out at before it is scaled to the card. */
const CARD_PAGE_LAYOUT_WIDTH = 1000;
const CARD_MARKDOWN_LAYOUT_WIDTH = 600;
const CARD_PREVIEW_HEIGHT = 150;
const CARD_PREVIEW_FALLBACK_WIDTH = 340;
/** A turn rarely runs longer; the window keeps later files off old answers. */
const TURN_WINDOW_MAX_MS = 2 * 60 * 60 * 1000;
/** File times can trail the clock the message time came from. */
const TURN_WINDOW_SLACK_MS = 5 * 1000;

export type SavedFilePreview = "html" | "markdown" | "text" | "image" | "none";

const PREVIEW_BY_EXTENSION: Record<string, SavedFilePreview> = {
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  py: "text",
  r: "text",
  tex: "text",
  bib: "text",
  svg: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

/** Files a person opens; other writes (caches, logs, lock files) get no card. */
const USER_FILE_EXTENSIONS = new Set([
  ...Object.keys(PREVIEW_BY_EXTENSION),
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "ipynb",
  "zip",
]);

/** The folder target of the chat a panel shows: its paper, or its library. */
export function resolveAgentFilesTargetForPanelItem(
  item: unknown,
): AgentFilesTarget | null {
  if (!item || typeof item !== "object") return null;
  if (isGlobalPortalItem(item)) {
    return { kind: "library", libraryID: item.libraryID };
  }
  const base =
    resolvePaperPortalBaseItem(item as Zotero.Item) || (item as Zotero.Item);
  const id = Number(base?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const parentID = Number(base.parentID);
  return base.isAttachment?.() && Number.isInteger(parentID) && parentID > 0
    ? { kind: "paper", itemId: parentID }
    : { kind: "paper", itemId: id };
}

/** The user's home folder, for "~/" paths; empty when Gecko gives none. */
export function resolveHomeDir(): string {
  const scope = globalThis as typeof globalThis & {
    PathUtils?: { homeDir?: string };
    Services?: {
      dirsvc?: { get?: (key: string, iface: unknown) => { path?: string } };
    };
    Ci?: { nsIFile?: unknown };
  };
  try {
    const fromPathUtils = scope.PathUtils?.homeDir?.trim();
    if (fromPathUtils) return fromPathUtils;
    return (
      scope.Services?.dirsvc?.get?.("Home", scope.Ci?.nsIFile)?.path?.trim() ||
      ""
    );
  } catch {
    return "";
  }
}

export function fileExtension(path: string): string {
  const name = fileBaseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function savedFilePreviewKind(path: string): SavedFilePreview {
  return PREVIEW_BY_EXTENSION[fileExtension(path)] || "none";
}

function isInside(path: string, directory: string): boolean {
  const dir = directory.replace(/[\\/]+$/, "");
  return (
    path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCandidate(raw: string, homeDir: string): string | null {
  let value = raw.trim().replace(/^<|>$/g, "");
  value = value.replace(/[.,;:!?'"]+$/, "");
  if (/^file:\/\//i.test(value)) value = fileUrlToPath(value) || "";
  else if (/%[0-9A-Fa-f]{2}/.test(value)) {
    try {
      value = decodeURI(value);
    } catch {
      /* keep as written */
    }
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    if (!homeDir) return null;
    value = joinLocalPath(homeDir, value.slice(2));
  }
  if (!value || !isAbsoluteLocalPath(value)) return null;
  if (!USER_FILE_EXTENSIONS.has(fileExtension(value))) return null;
  return value;
}

/**
 * Local file paths an answer names, in the order it names them: file links,
 * Markdown link targets, `code` spans, bare paths, and paths inside the chat's
 * folder (whose name has spaces, so a bare match would stop short).
 */
export function extractLocalFilePaths(
  text: string,
  options: { homeDir?: string; folder?: string | null } = {},
): string[] {
  const homeDir = options.homeDir || "";
  const found: Array<{ at: number; path: string }> = [];
  const add = (at: number, raw: string | undefined) => {
    const path = raw ? normalizeCandidate(raw, homeDir) : null;
    if (path) found.push({ at, path });
  };
  const source = String(text || "");
  for (const match of source.matchAll(/file:\/\/[^\s)<>"'`\]]+/gi)) {
    add(match.index ?? 0, match[0]);
  }
  for (const match of source.matchAll(
    /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))\s*\)/g,
  )) {
    add(match.index ?? 0, match[1] || match[2]);
  }
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    add(match.index ?? 0, match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s("'])((?:~[\\/]|\/|[A-Za-z]:\\)[^\s)"'`<>\]]*)/g,
  )) {
    add((match.index ?? 0) + 1, match[1]);
  }
  for (const folder of [options.folder, homeDir ? "~" : ""]) {
    if (!folder) continue;
    const pattern = new RegExp(
      `${escapeRegExp(folder)}[\\\\/][^\\n"'\`<>)\\]]+?\\.([A-Za-z0-9]{1,8})(?=$|[\\s"'\`<>)\\],;:!?]|\\.(?:\\s|$))`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      add(match.index ?? 0, match[0]);
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.path)
    .filter((path) => (seen.has(path) ? false : (seen.add(path), true)));
}

type FileStat = {
  exists: boolean;
  isDirectory?: boolean;
  lastModified?: number;
  size?: number;
};

type StatIOUtils = {
  stat?: (path: string) => Promise<{
    type?: string;
    size?: number;
    lastModified?: number;
  }>;
  getChildren?: (path: string) => Promise<string[]>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  readUTF8?: (path: string) => Promise<string>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

function io(): StatIOUtils | undefined {
  return getIOUtils() as StatIOUtils | undefined;
}

export async function statLocalPath(path: string): Promise<FileStat> {
  try {
    const stat = await io()?.stat?.(path);
    if (!stat) return { exists: false };
    return {
      exists: true,
      isDirectory: stat.type === "directory",
      lastModified: Number(stat.lastModified) || undefined,
      size: Number(stat.size) || 0,
    };
  } catch {
    return { exists: false };
  }
}

export type TurnWindow = { start: number; end: number };

/**
 * From the question's time to the next question (at most two hours on), as a
 * half-open range. Both ends move back by the same slack, so the windows of
 * neighbouring turns meet without overlapping and a file belongs to one turn.
 */
export function buildTurnWindow(params: {
  userTimestamp: number;
  assistantTimestamp: number;
  nextUserTimestamp?: number;
}): TurnWindow {
  const start =
    (params.userTimestamp || params.assistantTimestamp) - TURN_WINDOW_SLACK_MS;
  const cap =
    Math.max(params.userTimestamp, params.assistantTimestamp) +
    TURN_WINDOW_MAX_MS;
  const end =
    params.nextUserTimestamp && params.nextUserTimestamp <= cap
      ? params.nextUserTimestamp - TURN_WINDOW_SLACK_MS
      : cap + TURN_WINDOW_SLACK_MS;
  return { start, end };
}

function inWindow(stat: FileStat, window: TurnWindow): boolean {
  const time = stat.lastModified || 0;
  return time >= window.start && time < window.end;
}

async function listChildren(directory: string): Promise<string[]> {
  try {
    return (await io()?.getChildren?.(directory)) || [];
  } catch {
    return [];
  }
}

/** Files in the folder (and one level of subfolders) changed in the window. */
async function scanFolder(
  folder: string,
  window: TurnWindow,
): Promise<Array<{ path: string; time: number }>> {
  const found: Array<{ path: string; time: number }> = [];
  const visit = async (directory: string, depth: number) => {
    for (const child of await listChildren(directory)) {
      const name = fileBaseName(child);
      // Hidden entries, the scratch folder and the record itself.
      if (name.startsWith(".") || name === AGENT_FILES_WORK_FOLDER) continue;
      const stat = await statLocalPath(child);
      if (!stat.exists) continue;
      if (stat.isDirectory) {
        if (depth < 1) await visit(child, depth + 1);
        continue;
      }
      if (!USER_FILE_EXTENSIONS.has(fileExtension(child))) continue;
      if (inWindow(stat, window))
        found.push({ path: child, time: stat.lastModified || 0 });
    }
  };
  await visit(folder, 0);
  return found.sort((a, b) => a.time - b.time);
}

/** Zotero's own files (storage, MinerU cache) are papers, not saved files. */
function isZoteroManagedPath(path: string): boolean {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DataDirectory?: { dir?: string } };
    }
  ).Zotero;
  const dataDir = zotero?.DataDirectory?.dir;
  const root = getAgentFilesRoot();
  if (root && isInside(path, root)) return false;
  return Boolean(dataDir && isInside(path, dataDir));
}

/** The files a finished turn saved. */
export async function detectSavedFiles(params: {
  text: string;
  folder: string | null;
  homeDir?: string;
  window: TurnWindow;
}): Promise<string[]> {
  const result: string[] = [];
  const named = extractLocalFilePaths(params.text, {
    homeDir: params.homeDir,
    folder: params.folder,
  });
  for (const path of named) {
    if (isZoteroManagedPath(path)) continue;
    if (fileBaseName(path).startsWith(".")) continue;
    if (
      params.folder &&
      isInside(path, joinLocalPath(params.folder, AGENT_FILES_WORK_FOLDER))
    )
      continue;
    const stat = await statLocalPath(path);
    if (!stat.exists || stat.isDirectory) continue;
    const ours = Boolean(params.folder && isInside(path, params.folder));
    if (ours || inWindow(stat, params.window)) result.push(path);
  }
  if (params.folder && (await statLocalPath(params.folder)).isDirectory) {
    for (const { path } of await scanFolder(params.folder, params.window)) {
      if (!result.includes(path)) result.push(path);
    }
  }
  return result;
}

type SavedFilesManifest = {
  version: 1;
  /** `<conversationKey>:<assistant timestamp>` → the paths that turn saved. */
  messages: Record<string, string[]>;
};

export function savedFilesMessageKey(
  conversationKey: number,
  assistantTimestamp: number,
): string {
  return `${conversationKey}:${Math.floor(assistantTimestamp)}`;
}

const manifestCache = new Map<string, Promise<SavedFilesManifest>>();
const manifestWrites = new Map<string, Promise<void>>();

async function readManifest(folder: string): Promise<SavedFilesManifest> {
  const empty: SavedFilesManifest = { version: 1, messages: {} };
  const path = joinLocalPath(folder, SAVED_FILES_MANIFEST);
  try {
    const stat = await statLocalPath(path);
    if (!stat.exists) return empty;
    const bytes = await io()?.read?.(path);
    if (!bytes) return empty;
    const parsed = JSON.parse(
      new TextDecoder().decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      ),
    ) as Partial<SavedFilesManifest>;
    const messages: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed?.messages || {})) {
      if (Array.isArray(value)) {
        messages[key] = value.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
    }
    return { version: 1, messages };
  } catch {
    return empty;
  }
}

function loadManifest(folder: string): Promise<SavedFilesManifest> {
  let pending = manifestCache.get(folder);
  if (!pending) {
    pending = readManifest(folder);
    manifestCache.set(folder, pending);
  }
  return pending;
}

async function recordInManifest(
  folder: string,
  messageKey: string,
  paths: string[],
): Promise<void> {
  const previous = manifestWrites.get(folder) || Promise.resolve();
  const next = previous.then(async () => {
    const manifest = await loadManifest(folder);
    manifest.messages[messageKey] = paths;
    const fs = io();
    if (!fs?.write) return;
    await fs.makeDirectory?.(folder, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await fs.write(
      joinLocalPath(folder, SAVED_FILES_MANIFEST),
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );
  });
  manifestWrites.set(
    folder,
    next.catch(() => undefined),
  );
  await next;
}

const FOLDER_CACHE_MS = 30 * 1000;
const folderCache = new Map<
  string,
  { at: number; folder: Promise<string | null> }
>();

/** One folder lookup for a burst of renders (a chat draws many answers). */
function resolveFolderCached(target: AgentFilesTarget): Promise<string | null> {
  const key =
    target.kind === "paper" ? `p:${target.itemId}` : `l:${target.libraryID}`;
  const now = Date.now();
  const cached = folderCache.get(key);
  if (cached && now - cached.at < FOLDER_CACHE_MS) return cached.folder;
  const folder = resolveAgentFilesFolder(target).catch(() => null);
  folderCache.set(key, { at: now, folder });
  return folder;
}

/** Turns found with no files this session; they are not written down. */
const emptyTurns = new Set<string>();
const pendingTurns = new Map<string, Promise<string[]>>();

/**
 * The files of one finished turn: the record when there is one, else a fresh
 * look, which is recorded when it finds files.
 */
export async function resolveTurnSavedFiles(params: {
  target: AgentFilesTarget | null;
  conversationKey: number;
  assistantTimestamp: number;
  text: string;
  window: TurnWindow;
  homeDir?: string;
}): Promise<string[]> {
  const messageKey = savedFilesMessageKey(
    params.conversationKey,
    params.assistantTimestamp,
  );
  if (emptyTurns.has(messageKey)) return [];
  const running = pendingTurns.get(messageKey);
  if (running) return running;
  const work = (async () => {
    const folder = params.target
      ? await resolveFolderCached(params.target)
      : null;
    if (folder) {
      const recorded = (await loadManifest(folder)).messages[messageKey];
      if (recorded) return recorded;
    }
    const found = await detectSavedFiles({
      text: params.text,
      folder,
      homeDir: params.homeDir,
      window: params.window,
    });
    if (!found.length) {
      emptyTurns.add(messageKey);
      return found;
    }
    if (folder) {
      try {
        await recordInManifest(folder, messageKey, found);
      } catch {
        /* the cards still show this session */
      }
    }
    return found;
  })();
  pendingTurns.set(messageKey, work);
  try {
    return await work;
  } finally {
    pendingTurns.delete(messageKey);
  }
}

/** "~/Desktop/x.html" for a path in the home folder. */
export function displayLocalPath(path: string, homeDir?: string): string {
  if (homeDir && isInside(path, homeDir)) {
    return `~${path.slice(homeDir.replace(/[\\/]+$/, "").length)}`;
  }
  return path;
}

export type SavedFileCardOptions = {
  homeDir?: string;
  /** Opens an HTML page in the full-window viewer (the sidebar's full view). */
  openViewer?: (source: string, anchor: HTMLElement) => void;
  /**
   * Draws Markdown into a box, using the box's own document (the full-view
   * window is another document). Without it a note keeps its type tile.
   */
  renderMarkdown?: (target: HTMLElement, markdown: string) => void;
  /** Called after a card's preview mounts, so the chat can keep its scroll. */
  onPreviewMounted?: () => void;
};

export type SavedFileTileType =
  | "html"
  | "md"
  | "image"
  | "pdf"
  | "docx"
  | "other"
  | "missing";

export type SavedFileClickAction = "side-panel" | "full-view" | "default-app";

const IMAGE_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp"]);

/** "Web page", "Markdown note", "CSV file": what a person calls the file. */
export function savedFileTypeLabel(
  path: string,
  translate: (en: string) => string = t,
): string {
  const ext = fileExtension(path);
  if (!ext) return translate("File");
  if (ext === "html" || ext === "htm") return translate("Web page");
  if (ext === "md" || ext === "markdown") return translate("Markdown note");
  if (IMAGE_EXTENSIONS.has(ext)) return translate("Picture");
  if (ext === "pdf") return translate("PDF");
  if (ext === "docx") return translate("Word document");
  return translate("{type} file").replace("{type}", ext.toUpperCase());
}

/** "340 B", "12 KB", "1.4 MB". */
export function formatFileSize(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (size < 1024) return `${Math.round(size)} B`;
  const kb = size / 1024;
  if (Math.round(kb) < 1024) return `${Math.round(kb)} KB`;
  const oneDecimal = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const mb = kb / 1024;
  if (Math.round(mb * 10) / 10 < 1024) return `${oneDecimal(mb)} MB`;
  return `${oneDecimal(mb / 1024)} GB`;
}

/** The colour class and the letters on the card's type tile. */
export function savedFileTile(
  path: string,
  missing: boolean,
): { type: SavedFileTileType; label: string } {
  if (missing) return { type: "missing", label: "?" };
  const ext = fileExtension(path);
  const label = ext ? ext.toUpperCase().slice(0, 4) : "FILE";
  let type: SavedFileTileType = "other";
  if (ext === "html" || ext === "htm") type = "html";
  else if (ext === "md" || ext === "markdown") type = "md";
  else if (IMAGE_EXTENSIONS.has(ext)) type = "image";
  else if (ext === "pdf") type = "pdf";
  else if (ext === "docx") type = "docx";
  return { type, label };
}

/** True when the plugin can show the file itself (a page, note or picture). */
export function isShowableSavedFile(
  kind: SavedFilePreview,
  size: number | undefined,
): boolean {
  return (
    (kind === "html" || kind === "markdown" || kind === "image") &&
    (size || 0) <= SAVED_FILE_PREVIEW_MAX_BYTES
  );
}

/**
 * What a card's preview area shows: a page, a note or a picture drawn from the
 * file, or the type tile. A missing file (no size) and a big one get the tile.
 */
export function savedFileCardPreviewKind(
  path: string,
  size: number | undefined,
): "html" | "markdown" | "image" | "tile" {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
    return "tile";
  const kind = savedFilePreviewKind(path);
  if (kind === "html" || kind === "markdown") {
    return size <= SAVED_FILE_PREVIEW_MAX_BYTES ? kind : "tile";
  }
  if (kind === "image") {
    return size <= SAVED_FILE_CARD_IMAGE_MAX_BYTES ? "image" : "tile";
  }
  return "tile";
}

/** What a click on the card does. Every page, note and picture has a full view. */
export function decideSavedFileClick(params: {
  showable: boolean;
  standalone: boolean;
}): SavedFileClickAction {
  if (!params.showable) return "default-app";
  return params.standalone ? "side-panel" : "full-view";
}

const ACTION_LABELS: Record<SavedFileClickAction, string> = {
  "side-panel": "Open in side panel",
  "full-view": "Open full view",
  "default-app": "Open in default app",
};

function isMacRuntime(): boolean {
  return Boolean(
    (globalThis as { Zotero?: { isMac?: boolean } }).Zotero?.isMac,
  );
}

async function readText(path: string): Promise<string | null> {
  try {
    const bytes = await io()?.read?.(path);
    if (!bytes) return null;
    return new TextDecoder().decode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

/** The <img> for a saved picture, as the card and the side panel show it. */
function createSavedFileImage(
  doc: Document,
  path: string,
  className: string,
): HTMLImageElement {
  const img = doc.createElement("img") as HTMLImageElement;
  img.className = className;
  img.alt = fileBaseName(path);
  // A saved drawing gets a white backdrop (zoteroPane.css).
  if (fileExtension(path) === "svg") img.dataset.llmImageKind = "svg";
  img.src = toFileUrl(path) || path;
  return img;
}

/** Scales a box laid out at `layoutWidth` down to the preview area's width. */
function fitPreviewBox(
  box: HTMLElement,
  area: HTMLElement,
  layoutWidth: number,
): () => void {
  const apply = () => {
    const width = area.clientWidth || CARD_PREVIEW_FALLBACK_WIDTH;
    const scale = width / layoutWidth;
    box.style.width = `${layoutWidth}px`;
    box.style.height = `${Math.ceil(CARD_PREVIEW_HEIGHT / scale)}px`;
    box.style.transform = `scale(${scale})`;
  };
  apply();
  return apply;
}

/**
 * Draws the real file in a card's preview area: a page in the safe box, a
 * note as Markdown, a picture as itself, each scaled to a thumbnail. Returns
 * true once it mounted; any failure leaves the type tile and returns false.
 */
async function mountCardPreview(
  doc: Document,
  area: HTMLElement,
  path: string,
  previewKind: "html" | "markdown" | "image",
  options: SavedFileCardOptions,
): Promise<boolean> {
  try {
    let element: HTMLElement;
    let refit: (() => void) | null = null;
    if (previewKind === "image") {
      const img = createSavedFileImage(
        doc,
        path,
        "llm-saved-file-preview-image",
      );
      img.setAttribute("aria-hidden", "true");
      img.addEventListener("error", () => {
        img.remove();
        delete area.dataset.previewReady;
      });
      element = img;
    } else if (previewKind === "html") {
      const source = await readText(path);
      if (source === null) return false;
      // Saved pages sit on white: a themed one gets the light sheet.
      const frame = createSandboxedHtmlFrame(
        doc,
        source,
        "llm-saved-file-preview-frame",
        "light",
      );
      frame.setAttribute("scrolling", "no");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("aria-hidden", "true");
      refit = fitPreviewBox(frame, area, CARD_PAGE_LAYOUT_WIDTH);
      element = frame;
    } else {
      if (!options.renderMarkdown) return false;
      const source = await readText(path);
      if (source === null) return false;
      const box = doc.createElement("div");
      box.className =
        "llm-saved-file-preview-markdown llm-standalone-side-panel-item-rendered";
      box.setAttribute("aria-hidden", "true");
      markStandaloneFlatScope(box);
      // A thumbnail, not part of the answer: no →| buttons or Miscellaneous rows.
      box.setAttribute(NO_SIDE_ITEMS_ATTRIBUTE, "true");
      options.renderMarkdown(box, source.slice(0, CARD_MARKDOWN_PREVIEW_CHARS));
      for (const focusable of Array.from(
        box.querySelectorAll("a, button, input, textarea, select, [tabindex]"),
      )) {
        (focusable as HTMLElement).tabIndex = -1;
      }
      refit = fitPreviewBox(box, area, CARD_MARKDOWN_LAYOUT_WIDTH);
      element = box;
    }
    area.insertBefore(element, area.firstChild);
    area.dataset.previewReady = "true";
    if (refit) {
      const Observer = doc.defaultView?.ResizeObserver;
      if (Observer) {
        try {
          new Observer(refit).observe(area);
        } catch {
          /* the first fit stays */
        }
      }
    }
    options.onPreviewMounted?.();
    return true;
  } catch {
    return false;
  }
}

/** Closes the one open ⋯ menu, if any. */
let closeOpenCardMenu: (() => void) | null = null;

type CardMenuItem =
  | { icon: string; label: string; run: () => void }
  | "divider";

/** Opens the ⋯ menu above the card's footer; one menu is open at a time. */
function openCardMenu(
  card: HTMLElement,
  anchor: HTMLElement,
  items: CardMenuItem[],
): void {
  closeOpenCardMenu?.();
  const doc = card.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = "llm-response-menu llm-saved-file-menu";
  menu.setAttribute("role", "menu");
  const close = () => {
    menu.remove();
    doc.removeEventListener("mousedown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
    anchor.setAttribute("aria-expanded", "false");
    if (closeOpenCardMenu === close) closeOpenCardMenu = null;
  };
  const onOutside = (event: Event) => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || anchor.contains(target))) return;
    close();
  };
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    anchor.focus?.();
  };
  for (const item of items) {
    if (item === "divider") {
      const line = doc.createElement("div");
      line.className = "llm-saved-file-menu-divider";
      line.setAttribute("role", "separator");
      menu.appendChild(line);
      continue;
    }
    const row = doc.createElement("button") as HTMLButtonElement;
    row.type = "button";
    row.className = "llm-response-menu-item llm-saved-file-menu-item";
    row.setAttribute("role", "menuitem");
    const icon = doc.createElement("span");
    icon.className = "llm-saved-file-menu-icon";
    icon.dataset.icon = item.icon;
    icon.setAttribute("aria-hidden", "true");
    const label = doc.createElement("span");
    label.textContent = item.label;
    row.append(icon, label);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
      item.run();
    });
    menu.appendChild(row);
  }
  card.appendChild(menu);
  anchor.setAttribute("aria-expanded", "true");
  doc.addEventListener("mousedown", onOutside, true);
  doc.addEventListener("keydown", onKey, true);
  closeOpenCardMenu = close;
  (
    menu.querySelector(".llm-saved-file-menu-item") as HTMLElement | null
  )?.focus?.();
}

/**
 * Opens a saved page, note or picture in its own full-view window. Resolves
 * false when the window could not open, so the caller can fall back.
 */
export async function openSavedFileWindow(
  doc: Document,
  path: string,
  renderMarkdown?: (target: HTMLElement, markdown: string) => void,
): Promise<boolean> {
  const kind = savedFilePreviewKind(path);
  const title = fileBaseName(path);
  if (kind === "image") {
    return openStandaloneViewerWindow(doc, {
      kind: "image",
      src: toFileUrl(path) || path,
      title,
      alt: title,
    });
  }
  if (kind !== "html" && kind !== "markdown") return false;
  const source = await readText(path);
  if (source === null) return false;
  if (kind === "html") {
    return openStandaloneViewerWindow(doc, { kind: "html", source, title });
  }
  if (!renderMarkdown) return false;
  return openStandaloneViewerWindow(doc, {
    kind: "markdown",
    markdown: source,
    title,
    renderMarkdown,
  });
}

/** The old full views, for a host that cannot open a window. */
async function openFullViewFallback(
  card: HTMLElement,
  path: string,
  kind: SavedFilePreview,
  options: SavedFileCardOptions,
): Promise<void> {
  if (kind === "image") {
    openFigureViewer(card, {
      src: toFileUrl(path) || path,
      alt: fileBaseName(path),
      caption: fileBaseName(path),
    });
  } else if (kind === "html") {
    const source = await readText(path);
    if (source !== null) options.openViewer?.(source, card);
  } else {
    launchLocalPath(path);
  }
}

/**
 * One card: a preview area on top (a type tile for now), then the name, the
 * kind and size, and a ⋯ menu. A click anywhere on the card is its main action.
 */
export async function createSavedFileCard(
  doc: Document,
  path: string,
  options: SavedFileCardOptions = {},
): Promise<HTMLElement> {
  const stat = await statLocalPath(path);
  const missing = !stat.exists || Boolean(stat.isDirectory);
  const kind = savedFilePreviewKind(path);
  const showable = !missing && isShowableSavedFile(kind, stat.size);
  const name = fileBaseName(path);
  const standaloneAtBuild = Boolean(getSidePanelItemHost(doc));
  const card = doc.createElement("div");
  card.className = `llm-saved-file-card${missing ? " is-missing" : ""}`;
  card.dataset.savedFilePath = path;
  card.dataset.savedFilePreview = kind;
  if (standaloneAtBuild) card.dataset.standalone = "true";

  const decide = () =>
    decideSavedFileClick({
      showable,
      standalone: Boolean(getSidePanelItemHost(doc)),
    });
  const runAction = (action: SavedFileClickAction) => {
    if (action === "side-panel") {
      getSidePanelItemHost(doc)?.open({
        kind: "file",
        title: name,
        source: path,
        filePath: path,
        element: card,
      });
    } else if (action === "full-view") {
      void openSavedFileWindow(doc, path, options.renderMarkdown).then(
        (opened) => {
          if (!opened) void openFullViewFallback(card, path, kind, options);
        },
      );
    } else {
      launchLocalPath(path);
    }
  };

  const tile = savedFileTile(path, missing);
  const previewArea = doc.createElement("div");
  previewArea.className = "llm-saved-file-preview";
  const tileEl = doc.createElement("span");
  tileEl.className = "llm-saved-file-tile";
  tileEl.dataset.type = tile.type;
  tileEl.setAttribute("aria-hidden", "true");
  const page = doc.createElement("span");
  page.className = "llm-saved-file-tile-page";
  const letters = doc.createElement("span");
  letters.className = "llm-saved-file-tile-label";
  letters.textContent = tile.label;
  tileEl.append(page, letters);
  previewArea.appendChild(tileEl);

  const previewKind = savedFileCardPreviewKind(
    path,
    missing ? undefined : stat.size || 0,
  );
  if (previewKind !== "tile") {
    const load = () => {
      void mountCardPreview(doc, previewArea, path, previewKind, options);
    };
    const Observer = doc.defaultView?.IntersectionObserver;
    if (Observer) {
      try {
        const observer = new Observer((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          load();
        });
        observer.observe(previewArea);
      } catch {
        load();
      }
    } else {
      load();
    }
  }

  const footer = doc.createElement("div");
  footer.className = "llm-saved-file-footer";
  const text = doc.createElement("div");
  text.className = "llm-saved-file-text";
  const nameEl = doc.createElement("div");
  nameEl.className = "llm-saved-file-name";
  nameEl.textContent = name;
  nameEl.title = path;
  const meta = doc.createElement("div");
  meta.className = "llm-saved-file-meta";
  if (missing) {
    meta.textContent = t("Moved or deleted");
  } else {
    const line = `${savedFileTypeLabel(path)} · ${formatFileSize(stat.size || 0)}`;
    meta.textContent = showable
      ? line
      : `${line} · ${t("opens in default app")}`;
  }
  text.append(nameEl, meta);

  const more = doc.createElement("button") as HTMLButtonElement;
  more.type = "button";
  more.className = "llm-saved-file-more";
  more.title = t("More actions");
  more.setAttribute("aria-label", t("More actions"));
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  const dots = doc.createElement("span");
  dots.className = "llm-saved-file-more-icon";
  dots.setAttribute("aria-hidden", "true");
  more.appendChild(dots);
  more.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (card.querySelector(".llm-saved-file-menu")) {
      closeOpenCardMenu?.();
      return;
    }
    const items: CardMenuItem[] = [];
    if (missing) {
      items.push({
        icon: "copy",
        label: t("Copy where it was"),
        run: () => void copyTextToClipboard(card, path),
      });
    } else {
      const standalone = Boolean(getSidePanelItemHost(doc));
      if (standalone && showable) {
        items.push({
          icon: "side-panel",
          label: t("Open in side panel"),
          run: () => runAction("side-panel"),
        });
      }
      if (showable) {
        items.push({
          icon: "full-view",
          label: t("Open full view"),
          run: () => runAction("full-view"),
        });
      }
      items.push({
        icon: "app",
        label: t("Open in default app"),
        run: () => runAction("default-app"),
      });
      items.push("divider", {
        icon: "folder",
        label: isMacRuntime() ? t("Show in Finder") : t("Show in folder"),
        run: () => void revealLocalPath(path),
      });
      items.push({
        icon: "copy",
        label: t("Copy file path"),
        run: () => void copyTextToClipboard(card, path),
      });
    }
    openCardMenu(card, more, items);
  });
  footer.append(text, more);
  card.append(previewArea, footer);

  if (!missing) {
    const label = t(ACTION_LABELS[decide()]);
    const overlay = doc.createElement("div");
    overlay.className = "llm-saved-file-preview-overlay";
    overlay.textContent = label;
    previewArea.appendChild(overlay);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${name}, ${label}`);
    card.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".llm-saved-file-menu")) return;
      closeOpenCardMenu?.();
      runAction(decide());
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      runAction(decide());
    });
  }
  return card;
}

/**
 * Draws the turn's file cards into `host` once they are known. Each card is
 * marked as a "file" item, so it gets a row in Miscellaneous, like the other
 * things the answer made.
 */
export async function mountSavedFileCards(
  host: HTMLElement,
  params: Parameters<typeof resolveTurnSavedFiles>[0] &
    SavedFileCardOptions & {
      /** Called once the cards are in, so the chat can keep its scroll. */
      onMounted?: () => void;
    },
): Promise<void> {
  const paths = await resolveTurnSavedFiles(params);
  if (!paths.length || !host.isConnected) return;
  const doc = host.ownerDocument;
  const cards = await Promise.all(
    paths.map((path) =>
      createSavedFileCard(doc, path, {
        ...params,
        onPreviewMounted: params.onMounted,
      }),
    ),
  );
  host.replaceChildren(...cards);
  host.hidden = false;
  params.onMounted?.();
  if (isOutsideAnswerContent(host)) return;
  for (const card of cards) {
    const path = card.dataset.savedFilePath || "";
    card.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, "file");
    registerSideItemRequest(card, () => ({
      kind: "file",
      title: fileBaseName(path),
      source: path,
      filePath: path,
      element: card,
    }));
  }
}

/**
 * A saved file in a side panel tab, read from disk each time: a page in the
 * safe box, Markdown rendered, text as code, a picture as itself. A file that
 * is gone, too big, or of another type says so.
 */
export async function renderSavedFileInto(
  doc: Document,
  root: HTMLElement,
  path: string,
  render: {
    markdown: (target: HTMLElement, markdown: string) => void;
  },
): Promise<void> {
  const note = (text: string) => {
    const box = doc.createElement("div");
    box.className = "llm-saved-file-note";
    box.textContent = text;
    root.replaceChildren(box);
  };
  const stat = await statLocalPath(path);
  if (!stat.exists || stat.isDirectory) {
    note(
      t(
        "This file is no longer there. It may have been moved, renamed, or deleted.",
      ),
    );
    return;
  }
  const preview = savedFilePreviewKind(path);
  if (preview === "none") {
    note(t("This kind of file can't be shown here. Use Show in folder."));
    return;
  }
  if ((stat.size || 0) > SAVED_FILE_PREVIEW_MAX_BYTES) {
    note(t("This file is too big to show here. Use Show in folder."));
    return;
  }
  if (preview === "image") {
    root.replaceChildren(
      createSavedFileImage(doc, path, "llm-saved-file-image"),
    );
    return;
  }
  const source = await readText(path);
  if (source === null) {
    note(t("This file could not be read."));
    return;
  }
  if (preview === "html") {
    root.replaceChildren(
      createSandboxedHtmlFrame(
        doc,
        source,
        "llm-side-panel-item-frame",
        "light",
      ),
    );
    return;
  }
  const box = doc.createElement("div");
  box.className = "llm-standalone-side-panel-item-rendered";
  root.replaceChildren(box);
  render.markdown(
    box,
    preview === "markdown" ? source : fenceAround(fileExtension(path), source),
  );
}
