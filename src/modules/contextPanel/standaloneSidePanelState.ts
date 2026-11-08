/**
 * Pure state for the standalone window's side panel (no DOM, no Zotero):
 * its tabs (read-only past chats, temporary side chats, and the History
 * tab that lists past chats), when closing
 * must ask first, which context a side chat follows, and where its
 * "context switched" notes go.
 */

/** The panel holds at most this many tabs. */
export const SIDE_PANEL_MAX_TABS = 8;

export type SidePanelTabKind =
  | "readonly"
  | "sidechat"
  | "history"
  | "item"
  | "misc"
  | "progress";

export type SidePanelTab = {
  id: string;
  kind: SidePanelTabKind;
  /**
   * A read-only tab's past chat; 0 for a side chat (its key can move) and
   * for the History tab.
   */
  conversationKey: number;
  /** An item tab's identity (see buildSidePanelItemKey); unset otherwise. */
  itemKey?: string;
};

export type SidePanelTabsState = {
  open: boolean;
  tabs: readonly SidePanelTab[];
  /** The shown tab; null shows the New tab tab (the new-tab page). */
  activeId: string | null;
  /**
   * The New tab tab is in the strip, after the other tabs. It is shown
   * whenever `activeId` is null, so an open panel always has a shown tab.
   */
  newTabOpen: boolean;
  /** Side chat tab ids, most recently used first. */
  sideChatMru: readonly string[];
};

export const CLOSED_SIDE_PANEL_TABS: SidePanelTabsState = Object.freeze({
  open: false,
  tabs: Object.freeze([]) as readonly SidePanelTab[],
  activeId: null,
  newTabOpen: false,
  sideChatMru: Object.freeze([]) as readonly string[],
});

export type SidePanelTabOpenResult = {
  state: SidePanelTabsState;
  /** The tab now shown, or null when the panel is full. */
  tabId: string | null;
  /** A new tab was added (false: an open tab was focused, or refused). */
  opened: boolean;
  /** The panel already holds SIDE_PANEL_MAX_TABS tabs. */
  refused: boolean;
};

/** Open the panel; a first open shows the new-tab page. */
export function openSidePanel(state: SidePanelTabsState): SidePanelTabsState {
  return state.open
    ? state
    : { ...state, open: true, activeId: null, newTabOpen: true };
}

/** Closing the panel drops every tab. */
export function closeSidePanel(): SidePanelTabsState {
  return CLOSED_SIDE_PANEL_TABS;
}

export function canOpenSidePanelTab(state: SidePanelTabsState): boolean {
  return state.tabs.length < SIDE_PANEL_MAX_TABS;
}

function touchSideChat(mru: readonly string[], id: string): readonly string[] {
  return [id, ...mru.filter((entry) => entry !== id)];
}

/** Show a tab; a side chat becomes the most recently used one. */
export function focusSidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabsState {
  const tab = state.tabs.find((entry) => entry.id === id);
  if (!tab) return state;
  return {
    ...state,
    open: true,
    activeId: id,
    sideChatMru:
      tab.kind === "sidechat"
        ? touchSideChat(state.sideChatMru, id)
        : state.sideChatMru,
  };
}

/** The "+" button: shows the New tab tab, adding it only if it is missing. */
export function showSidePanelNewTabPage(
  state: SidePanelTabsState,
): SidePanelTabsState {
  return { ...state, open: true, activeId: null, newTabOpen: true };
}

/**
 * Close the New tab tab. With other tabs, the one before it is shown; with
 * none, the panel closes.
 */
export function closeSidePanelNewTab(
  state: SidePanelTabsState,
): SidePanelTabsState {
  if (!state.newTabOpen) return state;
  if (!state.tabs.length) return CLOSED_SIDE_PANEL_TABS;
  const next = { ...state, newTabOpen: false };
  if (state.activeId !== null) return next;
  return focusSidePanelTab(next, state.tabs[state.tabs.length - 1].id);
}

function addTab(
  state: SidePanelTabsState,
  tab: SidePanelTab,
): SidePanelTabOpenResult {
  if (!canOpenSidePanelTab(state)) {
    return { state, tabId: null, opened: false, refused: true };
  }
  // A tab opened from the New tab tab replaces it, as in a browser.
  const replacesNewTab = state.open && state.activeId === null;
  const next = focusSidePanelTab(
    {
      ...state,
      open: true,
      newTabOpen: replacesNewTab ? false : state.newTabOpen,
      tabs: [...state.tabs, tab],
    },
    tab.id,
  );
  return { state: next, tabId: tab.id, opened: true, refused: false };
}

/**
 * The New tab page's "History" row: the New tab tab becomes a History tab
 * (as a browser tab navigates). There is one History tab; with one open,
 * it is focused and the New tab tab goes.
 */
export function openHistorySidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabOpenResult {
  const existing = state.tabs.find((tab) => tab.kind === "history");
  if (existing) {
    const replacesNewTab = state.open && state.activeId === null;
    return {
      state: focusSidePanelTab(
        replacesNewTab ? { ...state, newTabOpen: false } : state,
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  return addTab(state, { id, kind: "history", conversationKey: 0 });
}

/**
 * A past chat opens once; picking it again focuses its tab. Picked in the
 * History tab (`replaceId`), it takes that tab's place, or, when already
 * open, the History tab closes and the open tab is focused.
 */
export function openReadOnlySidePanelTab(
  state: SidePanelTabsState,
  params: { id: string; conversationKey: number; replaceId?: string },
): SidePanelTabOpenResult {
  const existing = state.tabs.find(
    (tab) =>
      tab.kind === "readonly" && tab.conversationKey === params.conversationKey,
  );
  const replaceIndex = params.replaceId
    ? state.tabs.findIndex((tab) => tab.id === params.replaceId)
    : -1;
  if (replaceIndex >= 0) {
    if (existing) {
      return {
        state: focusSidePanelTab(
          closeSidePanelTab(state, params.replaceId!),
          existing.id,
        ),
        tabId: existing.id,
        opened: false,
        refused: false,
      };
    }
    const tabs = [...state.tabs];
    tabs[replaceIndex] = {
      id: params.id,
      kind: "readonly",
      conversationKey: params.conversationKey,
    };
    return {
      state: focusSidePanelTab({ ...state, tabs }, params.id),
      tabId: params.id,
      opened: true,
      refused: false,
    };
  }
  if (existing) {
    const replacesNewTab = state.open && state.activeId === null;
    return {
      state: focusSidePanelTab(
        replacesNewTab ? { ...state, newTabOpen: false } : state,
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  return addTab(state, {
    id: params.id,
    kind: "readonly",
    conversationKey: params.conversationKey,
  });
}

/**
 * The New tab page's "Miscellaneous" row: the New tab tab becomes the
 * Miscellaneous tab (the list of what the model made in the main chat).
 * There is one; with one open, it is focused and the New tab tab goes.
 */
export function openMiscSidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabOpenResult {
  const existing = state.tabs.find((tab) => tab.kind === "misc");
  if (existing) {
    const replacesNewTab = state.open && state.activeId === null;
    return {
      state: focusSidePanelTab(
        replacesNewTab ? { ...state, newTabOpen: false } : state,
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  return addTab(state, { id, kind: "misc", conversationKey: 0 });
}

/**
 * The Task progress tab: from the New tab page's "Task progress" row (the
 * New tab tab becomes it) or the →| button on the chat's Task progress row.
 * There is one; with one open, it is focused and a shown New tab tab goes.
 */
export function openTaskProgressSidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabOpenResult {
  const existing = state.tabs.find((tab) => tab.kind === "progress");
  if (existing) {
    const replacesNewTab = state.open && state.activeId === null;
    return {
      state: focusSidePanelTab(
        replacesNewTab ? { ...state, newTabOpen: false } : state,
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  return addTab(state, { id, kind: "progress", conversationKey: 0 });
}

/** Whether the panel shows a Task progress tab (the chat's row then hides). */
export function hasTaskProgressSidePanelTab(
  state: SidePanelTabsState,
): boolean {
  return state.open && state.tabs.some((tab) => tab.kind === "progress");
}

/**
 * An item moved from the main chat (diagram, figure, page, code, plan)
 * opens once; moving the same item again focuses its tab. A tab
 * opened from the New tab tab replaces it, as for other tabs. Picked in the
 * Miscellaneous tab (`replaceId`), it takes that tab's place, or, when
 * already open, the Miscellaneous tab closes and the open tab is focused.
 */
export function openItemSidePanelTab(
  state: SidePanelTabsState,
  params: { id: string; itemKey: string; replaceId?: string },
): SidePanelTabOpenResult {
  const existing = state.tabs.find(
    (tab) => tab.kind === "item" && tab.itemKey === params.itemKey,
  );
  const replaceIndex = params.replaceId
    ? state.tabs.findIndex((tab) => tab.id === params.replaceId)
    : -1;
  if (replaceIndex >= 0) {
    if (existing) {
      return {
        state: focusSidePanelTab(
          closeSidePanelTab(state, params.replaceId!),
          existing.id,
        ),
        tabId: existing.id,
        opened: false,
        refused: false,
      };
    }
    const tabs = [...state.tabs];
    tabs[replaceIndex] = {
      id: params.id,
      kind: "item",
      conversationKey: 0,
      itemKey: params.itemKey,
    };
    return {
      state: focusSidePanelTab({ ...state, tabs }, params.id),
      tabId: params.id,
      opened: true,
      refused: false,
    };
  }
  if (existing) {
    const replacesNewTab = state.open && state.activeId === null;
    return {
      state: focusSidePanelTab(
        replacesNewTab ? { ...state, newTabOpen: false } : state,
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  return addTab(state, {
    id: params.id,
    kind: "item",
    conversationKey: 0,
    itemKey: params.itemKey,
  });
}

/**
 * "Back to Miscellaneous" on an item picked in the Miscellaneous list: the
 * item tab turns back into the Miscellaneous tab, in the same place. When a
 * Miscellaneous tab is open elsewhere, the item tab closes and that one is
 * focused instead.
 */
export function returnItemTabToMisc(
  state: SidePanelTabsState,
  itemTabId: string,
  miscId: string,
): SidePanelTabOpenResult {
  const index = state.tabs.findIndex(
    (tab) => tab.id === itemTabId && tab.kind === "item",
  );
  if (index < 0) {
    return { state, tabId: null, opened: false, refused: false };
  }
  const existing = state.tabs.find((tab) => tab.kind === "misc");
  if (existing) {
    return {
      state: focusSidePanelTab(
        closeSidePanelTab(state, itemTabId),
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  const tabs = [...state.tabs];
  tabs[index] = { id: miscId, kind: "misc", conversationKey: 0 };
  return {
    state: focusSidePanelTab({ ...state, tabs }, miscId),
    tabId: miscId,
    opened: true,
    refused: false,
  };
}

/**
 * "Back to History" on a past chat picked in the History list: the read-only
 * tab turns back into the History tab, in the same place. When a History tab
 * is open elsewhere, the read-only tab closes and that one is focused.
 */
export function returnReadOnlyTabToHistory(
  state: SidePanelTabsState,
  readOnlyTabId: string,
  historyId: string,
): SidePanelTabOpenResult {
  const index = state.tabs.findIndex(
    (tab) => tab.id === readOnlyTabId && tab.kind === "readonly",
  );
  if (index < 0) {
    return { state, tabId: null, opened: false, refused: false };
  }
  const existing = state.tabs.find((tab) => tab.kind === "history");
  if (existing) {
    return {
      state: focusSidePanelTab(
        closeSidePanelTab(state, readOnlyTabId),
        existing.id,
      ),
      tabId: existing.id,
      opened: false,
      refused: false,
    };
  }
  const tabs = [...state.tabs];
  tabs[index] = { id: historyId, kind: "history", conversationKey: 0 };
  return {
    state: focusSidePanelTab({ ...state, tabs }, historyId),
    tabId: historyId,
    opened: true,
    refused: false,
  };
}

export function openSideChatSidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabOpenResult {
  return addTab(state, { id, kind: "sidechat", conversationKey: 0 });
}

/**
 * Close one tab. The active tab hands over to its right neighbour, then
 * its left one; the New tab tab counts as the last one. With nothing left,
 * the New tab tab appears.
 */
export function closeSidePanelTab(
  state: SidePanelTabsState,
  id: string,
): SidePanelTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const sideChatMru = state.sideChatMru.filter((entry) => entry !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    activeId =
      (tabs[index] || (state.newTabOpen ? null : tabs[index - 1]) || null)
        ?.id ?? null;
  }
  const next = {
    ...state,
    tabs,
    sideChatMru,
    activeId,
    newTabOpen: state.newTabOpen || activeId === null,
  };
  return activeId ? focusSidePanelTab(next, activeId) : next;
}

/**
 * Move a tab to `index` in the strip (clamped), keeping which tab is shown.
 * "Open as main chat" uses it to put the previous main chat where the
 * opened chat's tab was.
 */
export function moveSidePanelTab(
  state: SidePanelTabsState,
  id: string,
  index: number,
): SidePanelTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const to = Math.max(0, Math.min(Math.trunc(index), tabs.length));
  if (to === from) return state;
  tabs.splice(to, 0, state.tabs[from]);
  return { ...state, tabs };
}

function isSideChatTab(state: SidePanelTabsState, id: string | null): boolean {
  return Boolean(
    id && state.tabs.some((tab) => tab.id === id && tab.kind === "sidechat"),
  );
}

/**
 * Where "Ask in side chat" goes: the shown side chat, else the most
 * recently used one; null means open a new side chat.
 */
export function resolveAskInSideChatTab(
  state: SidePanelTabsState,
): string | null {
  if (isSideChatTab(state, state.activeId)) return state.activeId;
  return state.sideChatMru.find((id) => isSideChatTab(state, id)) ?? null;
}

/**
 * Which side chat "Add side chat" attaches: the shown one, else the most
 * recently used one, provided it has an answer.
 */
export function resolveSlashSideChatTab(
  state: SidePanelTabsState,
  hasAnswer: (id: string) => boolean,
): string | null {
  if (isSideChatTab(state, state.activeId) && hasAnswer(state.activeId!)) {
    return state.activeId;
  }
  return (
    state.sideChatMru.find((id) => isSideChatTab(state, id) && hasAnswer(id)) ??
    null
  );
}

/** A side chat tab is titled by its first question, once asked. */
export function resolveSideChatTabTitle(
  messages: ReadonlyArray<{ role: string; text?: string }>,
  fallback: string,
): string {
  const first = messages.find((message) => message.role === "user");
  const text = String(first?.text || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

/** A side chat with messages is not saved, so closing it asks first. */
export function resolveSidePanelCloseDecision(params: {
  messageCount: number;
}): "close" | "confirm" {
  return params.messageCount > 0 ? "confirm" : "close";
}

type AnswerMessage = {
  role: "user" | "assistant";
  text?: string;
  streaming?: boolean;
};

/** The newest assistant answer that has finished and has text, if any. */
export function findLastFinishedAnswerText(
  messages: readonly AnswerMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.streaming) continue;
    const text = String(message.text || "").trim();
    if (text) return text;
  }
  return null;
}

export function hasFinishedAnswer(messages: readonly AnswerMessage[]): boolean {
  return findLastFinishedAnswerText(messages) !== null;
}

/** What a side chat answers about: one paper, or a whole library. */
export type SideChatContext = {
  kind: "paper" | "global";
  paperItemID: number;
  libraryID: number;
};

function positiveInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** The side chat follows the main chat: its paper, or its library. */
export function resolveSideChatContext(params: {
  mode: "open" | "paper";
  basePaperItemID: number | null | undefined;
  libraryID: number;
}): SideChatContext {
  const paperItemID = positiveInt(params.basePaperItemID);
  const libraryID = positiveInt(params.libraryID) || 1;
  return params.mode === "paper" && paperItemID
    ? { kind: "paper", paperItemID, libraryID }
    : { kind: "global", paperItemID: 0, libraryID };
}

export function isSameSideChatContext(
  a: SideChatContext | null,
  b: SideChatContext | null,
): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === "paper"
    ? a.paperItemID === b.paperItemID
    : a.libraryID === b.libraryID;
}

/** A divider in the side chat after its first `afterMessageCount` messages. */
export type SideChatContextNote = {
  afterMessageCount: number;
  text: string;
};

/**
 * Adds a "context switched" note after the current messages. An empty chat
 * gets none; a second switch with no message in between replaces the note.
 */
export function appendSideChatContextNote(
  notes: readonly SideChatContextNote[],
  messageCount: number,
  text: string,
): SideChatContextNote[] {
  const count = Math.max(0, Math.floor(Number(messageCount) || 0));
  if (!count) return [...notes];
  const kept = notes.filter((note) => note.afterMessageCount !== count);
  return [...kept, { afterMessageCount: count, text }];
}

/**
 * Where each note goes among the rendered messages (their indices): after
 * the last rendered message that comes before it, or first (null) when none
 * does.
 */
export function resolveSideChatContextNoteAnchors(
  notes: readonly SideChatContextNote[],
  renderedMessageIndices: readonly number[],
): Array<{ text: string; afterMessageIndex: number | null }> {
  const sorted = [...renderedMessageIndices]
    .filter((index) => Number.isFinite(index))
    .sort((a, b) => a - b);
  return notes.map((note) => {
    let anchor: number | null = null;
    for (const index of sorted) {
      if (index < note.afterMessageCount) anchor = index;
      else break;
    }
    return { text: note.text, afterMessageIndex: anchor };
  });
}

/** The main chat's own conversation never shows in the panel's lists. */
export function buildSidePanelExcludedKeys(
  mainConversationKey: number,
): ReadonlySet<number> {
  const key = positiveInt(mainConversationKey);
  return new Set(key ? [key] : []);
}

/**
 * Each paper (and each library's chat) keeps its own side panel tabs: the
 * key names whose tabs the panel shows for this main chat context.
 */
export function resolveSidePanelWorkspaceKey(params: {
  mode: "open" | "paper";
  basePaperItemID: number | null | undefined;
  libraryID: number;
}): string {
  const context = resolveSideChatContext(params);
  return context.kind === "paper"
    ? `paper:${context.paperItemID}`
    : `library:${context.libraryID}`;
}

/** The paper a workspace key names, or 0 for a library's workspace. */
export function resolveSidePanelWorkspacePaperID(key: string): number {
  const match = /^paper:(\d+)$/.exec(String(key || ""));
  return match ? positiveInt(match[1]) : 0;
}
