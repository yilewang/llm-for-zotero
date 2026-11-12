/**
 * Torn-off chat windows: extra instances of the standalone window document
 * that each keep their own paper and do not follow the PDF reader.
 *
 * Each window has its own selection surface "torn:<id>" (see
 * conversationSelection.ts) and is listed here while it is open, with the
 * chat it shows, so one chat never has two such windows. The standalone
 * window is not listed here; it stays the one window in
 * `addon.data.standaloneWindow`.
 */
import type { ConversationSystem } from "../../shared/types";
import type { TornSurface } from "./conversationSelection";

/** The chat a torn-off window opens on. */
export type TornChatIdentity = {
  system: ConversationSystem;
  conversationKey: number;
  kind: "paper" | "global";
  libraryID: number;
  paperItemID?: number;
};

let lastTornWindowID = 0;
const tornWindows = new Map<TornSurface, Window>();
// The chat each listed window shows, by conversation key. Keys fall in
// separate ranges per runtime and chat kind (conversationKeySpace.ts), so
// the key alone names the chat. The library is not part of it: chats of two
// libraries that ever shared a key would count as one chat here.
const tornWindowConversations = new Map<Window, string>();

/** The key as a registry entry; "" when it names no chat. */
function normalizeConversationKey(conversationKey: number | string): string {
  const key = Math.floor(Number(conversationKey));
  return Number.isFinite(key) && key > 0 ? String(key) : "";
}

function isListedTornWindow(win: Window): boolean {
  for (const listed of tornWindows.values()) {
    if (listed === win) return true;
  }
  return false;
}

/** A surface name no open or earlier window of this session has used. */
export function allocateTornSurface(): TornSurface {
  lastTornWindowID += 1;
  return `torn:${lastTornWindowID}`;
}

/**
 * Lists `win` under `surface` until the returned disposer runs (on unload).
 * The disposer leaves a later window registered under the same surface.
 */
export function registerTornChatWindow(
  win: Window,
  surface: TornSurface,
): () => void {
  tornWindows.set(surface, win);
  return () => {
    if (tornWindows.get(surface) === win) {
      tornWindows.delete(surface);
      tornWindowConversations.delete(win);
    }
  };
}

/**
 * Records the chat a listed window shows: when it opens, and on every
 * switch inside it. A window that is not listed is ignored.
 */
export function setTornWindowConversation(
  win: Window,
  conversationKey: number | string,
): void {
  if (!isListedTornWindow(win)) return;
  const key = normalizeConversationKey(conversationKey);
  if (key) tornWindowConversations.set(win, key);
  else tornWindowConversations.delete(win);
}

/** The open torn-off window that shows the chat, if there is one. */
export function findTornWindowForConversation(
  conversationKey: number | string,
): Window | null {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return null;
  for (const win of getTornChatWindows()) {
    if (tornWindowConversations.get(win) === key) return win;
  }
  return null;
}

/** The open torn-off windows, oldest first. */
export function getTornChatWindows(): Window[] {
  const open: Window[] = [];
  for (const [surface, win] of tornWindows) {
    if (!win || win.closed) {
      tornWindows.delete(surface);
      if (win) tornWindowConversations.delete(win);
      continue;
    }
    open.push(win);
  }
  return open;
}

/** Closes every torn-off window; each one cleans up in its unload. */
export function closeAllTornChatWindows(): void {
  for (const win of getTornChatWindows()) {
    try {
      win.close();
    } catch {
      // The window is already going away.
    }
  }
}
