/**
 * The standalone window's side panel: a third column to the right of the main
 * chat, opened from the tab row's trailing toggle.
 *
 * The panel holds tabs, like a browser:
 * - Read-only tabs: a past chat picked from the History tab's Search history
 *   list, drawn with the main chat's renderer, no handlers, and a composer
 *   that cannot send.
 * - Side chat tabs: each a full second chat panel on its own temporary
 *   (ephemeral) key that follows the main chat's paper or library, reads the
 *   main chat as background, and is never saved.
 * - Item tabs: one thing moved out of the main chat with the "Move to side
 *   panel" button (a Mermaid diagram, an SVG figure, an HTML page, a code
 *   block, or a plan document). Temporary: they are not saved,
 *   and the panel drops them when it closes.
 * - The History tab: the Search history field and list; a picked chat
 *   replaces it with that chat's read-only tab.
 * - The Task progress tab: the main chat's Task progress, docked. While it is
 *   open the row leaves the main chat (`registerTaskProgressDock`).
 * The "+" button shows the new-tab page: a "Side chat" row and a "History"
 * row, which turns the New tab tab into the History tab.
 *
 * A torn-off window's (a follower's) panel is read only (`readOnly`): it
 * shows other chats for reference and starts no side chats.
 *
 * Pure decisions live in standaloneSidePanelState.ts; this module owns the
 * DOM and the panel lifecycles.
 */
import {
  CONTENT_TAB_ZOOM_ATTRIBUTE,
  markStandaloneFlatScope,
} from "./contentChrome";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import { appLogger } from "../../core/logging";
import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import type { ConversationSystem } from "../../shared/types";
import { releaseClaudeRuntimeForBody } from "../../claudeCode/runtimeRetention";
import { getContextSourceModeCssClassName } from "../../services/paperContent/contextSourceModes";
import { resolvePaperContextRefFromItem } from "../../services/paperContent/paperAttribution";
import { buildUI } from "./buildUI";
import { createContextIcon } from "./contextIcons";
import { composeContextStore } from "./contexts/composeContextStore";
import {
  copyRenderedMarkdownToClipboard,
  disposeChatRendering,
  ensureConversationLoaded,
  loadConversationMessagesForReadOnlyView,
  refreshChat,
} from "./chat";
import {
  clearChatPanelExtensions,
  setChatPanelExtensions,
  updateChatPanelExtensions,
} from "./chatPanelExtensions";
import {
  restoreChatScrollStateForConversationKey,
  saveChatScrollStateForConversationKey,
  type SavedChatScrollState,
} from "./chatScrollSnapshots";
import {
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
  clearEphemeralBackgroundContextProvider,
  discardEphemeralConversation,
  isEphemeralConversationBusy,
  moveEphemeralConversation,
  setEphemeralBackgroundContextProvider,
} from "./ephemeralConversations";
import { releaseInlineEdit } from "./inlineEditState";
import { getPanelHandle } from "./panelHandle";
import { clearPanelHostBinding, markSidePanelBody } from "./panelHostOwnership";
import { mountPanelShell } from "./panelMount";
import { createGlobalPortalItem, createPaperPortalItem } from "./portalScope";
import {
  applyPanelFontScale,
  getSideReaderTextSizePref,
  setSideReaderTextSizePref,
  SIDE_READER_TEXT_SIZE_MAX_PERCENT,
  SIDE_READER_TEXT_SIZE_MIN_PERCENT,
  SIDE_READER_TEXT_SIZE_STEP_PERCENT,
} from "./prefHelpers";
import { disposeSetupHandlers } from "./setupHandlers";
import { formatPaperContextChipLabel } from "./setupHandlers/controllers/composeContextController";
import {
  formatGlobalHistoryTimestamp,
  type ConversationHistoryEntry,
} from "./setupHandlers/controllers/conversationHistoryController";
import {
  createEmbeddedHistorySearchList,
  type EmbeddedHistorySearchListDeps,
  type EmbeddedHistorySearchListView,
} from "./setupHandlers/controllers/historySearchPopupController";
import { renderShortcuts } from "./shortcuts";
import {
  buildMainChatBackgroundContext,
  buildSideChatTranscriptContext,
} from "./sideChatContext";
import {
  CLOSED_SIDE_PANEL_TABS,
  SIDE_PANEL_MAX_TABS,
  appendSideChatContextNote,
  buildSidePanelExcludedKeys,
  canOpenSidePanelTab,
  closeSidePanel,
  closeSidePanelTab,
  findLastFinishedAnswerText,
  focusSidePanelTab,
  hasFinishedAnswer,
  isSameSideChatContext,
  resolveSidePanelWorkspaceKey,
  openHistorySidePanelTab,
  moveSidePanelTab,
  openItemSidePanelTab,
  openMiscSidePanelTab,
  openTaskProgressSidePanelTab,
  hasTaskProgressSidePanelTab,
  returnItemTabToMisc,
  returnReadOnlyTabToHistory,
  openReadOnlySidePanelTab,
  openSideChatSidePanelTab,
  openSidePanel,
  resolveAskInSideChatTab,
  resolveSideChatContext,
  resolveSideChatContextNoteAnchors,
  resolveSideChatTabTitle,
  resolveSidePanelCloseDecision,
  resolveSlashSideChatTab,
  showSidePanelNewTabPage,
  closeSidePanelNewTab,
  type SideChatContext,
  type SideChatContextNote,
  type SidePanelTabsState,
} from "./standaloneSidePanelState";
import { openStandaloneResponseDocument } from "./standaloneResponseDocumentWindow";
import {
  computeStandaloneSidePanelSlideFrame,
  computeStandaloneWindowWidthChange,
  createCubicBezierEasing,
  installStandaloneColumnResizeBehavior,
  STANDALONE_PANEL_SLIDE_DURATION_MS,
  STANDALONE_PANEL_SLIDE_EASING,
  STANDALONE_SIDE_PANEL_DEFAULT_WIDTH_PX,
  STANDALONE_SIDE_PANEL_MAX_WIDTH_PX,
  STANDALONE_SIDE_PANEL_MIN_WIDTH_PX,
  STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX,
} from "./standaloneWindowSizing";
import {
  chatHistory,
  getAbortController,
  loadedConversationKeys,
  readOnlyBorrowedConversationKeys,
  setResponseActionRunner,
  unregisterContextPanel,
} from "./state";
import {
  resetSideSurfaceChoices,
  startSideSurfaceChoicesFromStandalone,
} from "./surfaceChoices";
import { setNeutralStatus, setStatus } from "./textUtils";
import { copyTextToClipboard } from "./clipboard";
import { flushPendingChatRender } from "./progressiveChatRender";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { renderSavedFileInto, savedFilePreviewKind } from "./savedFileCards";
import { revealLocalPath } from "../../utils/revealLocalPath";
import { resolveMineruHint } from "./taskProgress/mineruHint";
import {
  getTaskProgressPanelInput,
  registerTaskProgressDock,
  syncTaskProgressPanel,
} from "./taskProgress/panel";
import {
  displayedTaskRunState,
  getTaskProgress,
  subscribeTaskProgress,
} from "./taskProgress/store";
import {
  TASK_PROGRESS_OPEN_PASSAGE_EVENT,
  TASK_PROGRESS_REMOVE_PAPER_EVENT,
  createTaskProgressCard,
  mountTaskProgressView,
  type TaskProgressView,
  type TaskProgressViewInput,
} from "./taskProgress/view";
import {
  TASK_PROGRESS_OFFER_EVENT,
  TASK_PROGRESS_OPEN_SOURCE_EVENT,
  TASK_PROGRESS_SHOW_IN_ANSWER_EVENT,
  findTaskSource,
  type TaskProgressOpenSourceDetail,
} from "./taskProgress/outsideView";
import { webSourceKey } from "./webSourcesData";
import { mountSourcePageView, type SourcePageView } from "./sourcePageView";
import {
  registerSidePanelWebHost,
  unregisterSidePanelWebHost,
  type SidePanelSourceTarget,
  type SidePanelWebHost,
  type WebSourceLink,
} from "./webSourcesSidePanel";
import {
  buildItemFenceMarkdown,
  canRunItemAgain,
  canSaveItemAsNote,
  collectMadeItems,
  flashSourceMessage,
  mergeChatMadeItems,
  resolveSidePanelItemIdentity,
  type ChatMadeItem,
  registerSidePanelItemHost,
  resolveItemTabTitle,
  unregisterSidePanelItemHost,
  type SidePanelItemHost,
  type SidePanelItemKind,
  type SidePanelItemRequest,
} from "./sidePanelItems";

export const SIDE_PANEL_WIDTH_VARIABLE = "--llm-standalone-side-panel-width";

/** Workflow tests slow the open/close slide down to film it; null = normal. */
let slideDurationOverrideMs: number | null = null;
export function setStandaloneSidePanelSlideDurationForTest(
  durationMs: number | null,
): void {
  slideDurationOverrideMs =
    durationMs === null ? null : Math.max(0, Number(durationMs) || 0);
}
export const SIDE_PANEL_ID = "llm-standalone-side-panel";
const SIDE_CHAT_CONTEXT_NOTE_CLASS = "llm-side-chat-context-note";
const CONTEXT_FOLLOW_RETRY_MS = 400;

/** What the window's main chat shows right now. */
export type StandaloneSidePanelMainContext = {
  mode: "open" | "paper";
  conversationKey: number;
  basePaperItem: Zotero.Item | null;
  libraryID: number;
  conversationSystem: ConversationSystem;
};

export type StandaloneSidePanelDeps = {
  win: Window;
  /** The window's columns row (History pane | main chat | side panel). */
  lowerArea: HTMLElement;
  /** The main chat's panel body (the window's content area). */
  mainBody: HTMLElement;
  /** The tab row's trailing slot that hosts the toggle. */
  toggleHost: HTMLElement;
  /**
   * A torn-off window's panel: no Side chat row, no "Ask in side chat", and
   * no side chat in the composer's quote and slash menus. History,
   * Miscellaneous and Task progress stay.
   */
  readOnly?: boolean;
  getMainContext: () => StandaloneSidePanelMainContext;
  /** The same list sources the window's Search history popup uses. */
  historyList: Pick<
    EmbeddedHistorySearchListDeps,
    | "loadEntries"
    | "loadDocument"
    | "searchEntries"
    | "translate"
    | "log"
    | "resolveLabel"
    | "resolveScopeLabel"
    | "showRuntimeLabel"
  >;
  /** The portal item a history entry's conversation renders on. */
  buildHistoryEntryItem: (
    entry: ConversationHistoryEntry,
  ) => Zotero.Item | null;
  /** A paper chat's paper, or null. */
  resolveHistoryEntryPaper: (
    entry: ConversationHistoryEntry,
  ) => Zotero.Item | null;
  /**
   * Switch the main chat to the entry, as the Search history popup does (in
   * a torn-off window, in place). False when the main chat did not switch.
   */
  openAsMainChat: (entry: ConversationHistoryEntry) => Promise<boolean>;
  /** Width the History pane takes from the columns row. */
  getReservedLeftWidth: () => number;
  /** The window's minimum outer width. */
  minWindowWidth?: number;
  /** The panel opened, closed, or changed width. */
  onLayoutChanged: () => void;
  /**
   * Whether a paper's (or the library's) tabs are kept when the main chat
   * moves away from it; tabs that are not kept are dropped.
   */
  shouldKeepWorkspace: (key: string) => boolean;
};

export type StandaloneSidePanelController = {
  toggleButton: HTMLButtonElement;
  column: HTMLElement;
  splitter: HTMLElement;
  isOpen: () => boolean;
  /** Width the panel and its divider take from the columns row. */
  getOccupiedWidth: () => number;
  /**
   * Outer width the window is still about to gain (positive) or give back
   * (negative) for the panel: a resize asked for but not yet applied.
   */
  getPendingWindowWidthChange: () => number;
  relayout: () => void;
  /** Called after every main-chat mount (mode, paper, or chat changed). */
  onMainMounted: () => void;
  /** Opens the panel if closed, then the item's tab (the →| buttons). */
  openItem: (request: SidePanelItemRequest) => void;
  /** Drops the tabs kept for a paper or library that is not on screen. */
  dropWorkspace: (key: string) => void;
  /**
   * A chat is being deleted, or its deletion was undone: the tabs of items
   * made in a chat being deleted close, and Miscellaneous lists are read again.
   */
  onConversationDeletionChanged: () => void;
  /** Window close: drop everything without asking. */
  dispose: () => void;
};

type TabViewBase = {
  id: string;
  /** The tab's content (title row and chat body), shown while active. */
  root: HTMLElement;
  body: HTMLElement;
  /** The tab in the bar's strip. */
  tab: HTMLElement;
  tabTitle: HTMLElement;
  /** The inline "close this side chat?" card, while it shows. */
  confirm: HTMLElement | null;
  disposed: boolean;
};

type ReadOnlyTabView = TabViewBase & {
  kind: "readonly";
  entry: ConversationHistoryEntry;
  item: Zotero.Item;
  conversationKey: number;
  /**
   * The messages this view put in chatHistory, so it removes them, and only
   * them: a real load that replaced them owns the entry.
   */
  addedMessages: unknown[] | null;
  /** The conversation's own scroll state, put back when the view closes. */
  savedScroll: SavedChatScrollState;
};

type SideChatTabView = TabViewBase & {
  kind: "sidechat";
  clearButton: HTMLButtonElement;
  conversationKey: number;
  context: SideChatContext;
  basePaperItem: Zotero.Item | null;
  item: Zotero.Item | null;
  notes: SideChatContextNote[];
  followRetryTimer: number | null;
};

type HistoryTabView = TabViewBase & {
  kind: "history";
  list: EmbeddedHistorySearchListView;
};

type ItemTabView = TabViewBase & {
  kind: "item";
  itemKind: SidePanelItemKind;
  itemKey: string;
  /** The main chat and message the item came from (messageIndex -1: unknown). */
  conversationKey: number;
  messageIndex: number;
  /** A document or code tab's text size buttons, kept in step with the others. */
  syncReaderSize?: () => void;
};

type MiscTabView = TabViewBase & {
  kind: "misc";
  /** The scrolling list; its position is kept while a picked item is shown. */
  list: HTMLElement;
  /** Redraws the list from the main chat's rendered messages. */
  refresh: () => void;
  /** Stops watching the main chat. */
  stopWatching: () => void;
};

type TaskProgressTabView = TabViewBase & {
  kind: "progress";
  /** The docked Task progress view (row as heading, drawer always open). */
  view: TaskProgressView;
  /** A source's page, shown in place of the list (sourcePageView.ts). */
  page: SourcePageView;
  /** Points the view at the main chat's conversation. */
  setInput: (input: TaskProgressViewInput) => void;
  /** Stops following the run's state (the tab's icon). */
  stopWatching: () => void;
};

type TabView =
  | ReadOnlyTabView
  | SideChatTabView
  | HistoryTabView
  | ItemTabView
  | MiscTabView
  | TaskProgressTabView;

function setButtonLabel(button: HTMLElement, label: string): void {
  button.title = label;
  button.setAttribute("aria-label", label);
}

function createIconButton(
  doc: Document,
  iconClass: string,
  label: string,
): HTMLButtonElement {
  const button = createElement(
    doc,
    "button",
    `llm-standalone-title-action ${iconClass}`,
    { type: "button" },
  );
  setButtonLabel(button, label);
  return button;
}

function readPixelVariable(element: HTMLElement, name: string): number {
  const value = Number.parseFloat(element.style.getPropertyValue(name) || "");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function resolvePaperDisplayTitle(paper: Zotero.Item | null): string {
  let title = "";
  try {
    title = String((paper as any)?.getField?.("title") || "").trim();
  } catch {
    title = "";
  }
  if (!title) return t("this paper");
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

/** Tear down a full chat panel mounted on `body` (setupHandlers and all). */
function disposeMountedPanelBody(body: HTMLElement): void {
  disposeSetupHandlers(body);
  releaseInlineEdit(body);
  clearPanelHostBinding(body);
  void releaseClaudeRuntimeForBody(body);
  unregisterContextPanel(body);
  disposeChatRendering(body);
}

export function createStandaloneSidePanel(
  deps: StandaloneSidePanelDeps,
): StandaloneSidePanelController {
  const { win, lowerArea, mainBody } = deps;
  const doc = lowerArea.ownerDocument;

  let tabsState: SidePanelTabsState = CLOSED_SIDE_PANEL_TABS;
  const views = new Map<string, TabView>();
  let tabSequence = 0;
  let newTabPage: {
    root: HTMLElement;
    startPage: HTMLElement;
    title: HTMLElement;
    /** Null in a read-only panel. */
    sideChatRow: HTMLButtonElement | null;
    historyRow: HTMLButtonElement;
    miscRow: HTMLButtonElement;
    progressRow: HTMLButtonElement;
  } | null = null;
  let panelConfirm: HTMLElement | null = null;
  let disposed = false;

  const nextTabId = (
    kind: "readonly" | "sidechat" | "history" | "item" | "misc" | "progress",
  ) => `${kind}-${++tabSequence}`;

  // -- Toggle (tab row, trailing slot) --------------------------------------
  const toggleButton = createElement(
    doc,
    "button",
    "llm-standalone-title-action llm-standalone-side-panel-toggle",
    { type: "button" },
  );
  toggleButton.setAttribute("aria-controls", SIDE_PANEL_ID);
  toggleButton.setAttribute("aria-expanded", "false");
  setButtonLabel(toggleButton, t("Open side panel"));
  deps.toggleHost.appendChild(toggleButton);

  // -- Column: divider + panel ---------------------------------------------
  const splitter = createElement(
    doc,
    "div",
    "llm-standalone-sidebar-resizer llm-standalone-side-panel-resizer",
  );
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-label", t("Resize side panel"));
  splitter.tabIndex = 0;
  splitter.hidden = true;

  const column = createElement(doc, "aside", "llm-standalone-side-panel", {
    id: SIDE_PANEL_ID,
  });
  column.setAttribute("aria-label", t("Side panel"));
  column.hidden = true;

  // The bar: browser-style tabs on a darker strip, the "+" button after
  // the last tab, and the panel's close button at the far right.
  const bar = createElement(doc, "div", "llm-standalone-side-panel-bar");
  const strip = createElement(doc, "div", "llm-standalone-side-panel-tabs");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", t("Side panel tabs"));
  const newTabButton = createIconButton(
    doc,
    "llm-standalone-side-panel-icon-new-tab",
    t("New tab"),
  );
  const closeButton = createIconButton(
    doc,
    "llm-standalone-side-panel-icon-close",
    t("Close side panel"),
  );
  closeButton.classList.add("llm-standalone-side-panel-close");
  bar.append(strip, newTabButton, closeButton);

  const viewHost = createElement(doc, "div", "llm-standalone-side-panel-view");
  column.append(bar, viewHost);
  lowerArea.append(splitter, column);

  // -- Window width -------------------------------------------------------
  // The panel widens the window instead of taking the main chat's room: the
  // window keeps its left edge and grows to the right, as far as the screen
  // allows, and gives that width back when the panel closes, unless the user
  // resized the window in between. The window never moves. What the screen
  // cannot give, the main column gives up.
  let windowGrowth = 0;
  /** The outer width last asked for, until the window reports it. */
  let pendingOuterWidth: number | null = null;
  /** The outer width the panel last gave the window. */
  let lastSetOuterWidth: number | null = null;
  let pendingTimer: number | null = null;
  const PENDING_RESIZE_TIMEOUT_MS = 1000;
  const outerWidthNow = () => Math.round(Number(win.outerWidth) || 0);
  const settlePendingResize = () => {
    if (pendingTimer !== null) win.clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pendingOuterWidth === null) return;
    // A window manager may refuse or trim the resize; keep what it gave.
    windowGrowth = Math.max(
      0,
      windowGrowth + (outerWidthNow() - pendingOuterWidth),
    );
    lastSetOuterWidth = outerWidthNow();
    pendingOuterWidth = null;
  };
  const getPendingWindowWidthChange = () =>
    pendingOuterWidth === null ? 0 : pendingOuterWidth - outerWidthNow();
  /**
   * Asks for the window width that gives the panel `targetGrowth`; returns
   * the outer width to slide to (the current one if nothing changes).
   */
  const planWindowWidthForPanel = (targetGrowth: number): number => {
    const currentWidth = outerWidthNow();
    const fromWidth = pendingOuterWidth ?? currentWidth;
    if (!currentWidth || typeof win.resizeTo !== "function") return fromWidth;
    const frame = computeStandaloneWindowWidthChange({
      outerWidth: fromWidth,
      screenX: Math.round(Number(win.screenX) || 0),
      delta: targetGrowth - windowGrowth,
      availLeft: (win.screen as any)?.availLeft,
      availWidth: win.screen?.availWidth,
      minWidth: deps.minWindowWidth,
    });
    if (frame.width === fromWidth) return fromWidth;
    windowGrowth = Math.max(0, windowGrowth + frame.applied);
    pendingOuterWidth = frame.width;
    lastSetOuterWidth = frame.width;
    if (pendingTimer !== null) win.clearTimeout(pendingTimer);
    pendingTimer = null;
    return frame.width;
  };
  const planGiveBackWindowWidth = (): number => {
    // The window's real width: a resize the user made while a slide or its
    // report was still pending counts too.
    const width = outerWidthNow();
    const untouched =
      lastSetOuterWidth !== null && Math.abs(width - lastSetOuterWidth) <= 2;
    if (!untouched && pendingOuterWidth !== null) {
      if (pendingTimer !== null) win.clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingOuterWidth = null;
    }
    // If the user resized the window, keep their width.
    const target =
      windowGrowth > 0 && untouched ? planWindowWidthForPanel(0) : width;
    windowGrowth = 0;
    return target;
  };
  const onWindowResizeSettle = () => {
    if (
      !slide &&
      pendingOuterWidth !== null &&
      Math.abs(outerWidthNow() - pendingOuterWidth) <= 1
    ) {
      settlePendingResize();
    }
  };
  win.addEventListener("resize", onWindowResizeSettle);

  // -- Open and close slide ---------------------------------------------------
  // Like the History pane's width transition (same duration and easing):
  // each frame the window's right edge moves and the main column takes an
  // explicit width, so the main chat never jumps. The panel keeps its full
  // width throughout; the window edge (and the main column, when the screen
  // has no room) uncovers or covers it. On close the panel's content stays
  // until the slide ends.
  const mainColumn =
    (Array.from(lowerArea.children).find((child) =>
      child.contains(mainBody),
    ) as HTMLElement | undefined) || null;
  const slideEase = createCubicBezierEasing(...STANDALONE_PANEL_SLIDE_EASING);
  let slide: {
    frameId: number | null;
    finish: () => void;
  } | null = null;
  const prefersReducedMotion = () => {
    try {
      return Boolean(
        win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
      );
    } catch {
      return false;
    }
  };
  const resolveSlideDuration = () =>
    slideDurationOverrideMs ??
    (prefersReducedMotion() ? 0 : STANDALONE_PANEL_SLIDE_DURATION_MS);
  const finishSlide = () => slide?.finish();
  const runSlide = (params: {
    toOuterWidth: number;
    fromMainWidth: number;
    toMainWidth: number;
    panelWidth: number;
    onDone: () => void;
  }) => {
    finishSlide();
    const fromOuterWidth = outerWidthNow();
    const startedAt = Number(win.performance?.now?.() ?? Date.now());
    const duration = resolveSlideDuration();
    let lastOuterWidth = fromOuterWidth;
    const pin = (mainWidth: number) => {
      if (mainColumn) mainColumn.style.flex = `0 0 ${mainWidth}px`;
      column.style.flex = `0 0 ${params.panelWidth}px`;
    };
    const unpin = () => {
      if (mainColumn) mainColumn.style.removeProperty("flex");
      column.style.removeProperty("flex");
    };
    const resizeTo = (width: number) => {
      if (width === lastOuterWidth) return;
      lastOuterWidth = width;
      win.resizeTo(width, win.outerHeight);
    };
    const current = {
      frameId: null as number | null,
      finish: () => {
        if (slide !== current) return;
        if (current.frameId !== null)
          win.cancelAnimationFrame?.(current.frameId);
        slide = null;
        resizeTo(params.toOuterWidth);
        unpin();
        if (pendingOuterWidth !== null) {
          pendingTimer = win.setTimeout(
            settlePendingResize,
            PENDING_RESIZE_TIMEOUT_MS,
          );
          onWindowResizeSettle();
        }
        params.onDone();
      },
    };
    slide = current;
    const canAnimate =
      duration > 0 &&
      typeof win.requestAnimationFrame === "function" &&
      (params.toOuterWidth !== fromOuterWidth ||
        Math.abs(params.toMainWidth - params.fromMainWidth) >= 1);
    if (!canAnimate) {
      current.finish();
      return;
    }
    const step = () => {
      if (slide !== current) return;
      const now = Number(win.performance?.now?.() ?? Date.now());
      const frame = computeStandaloneSidePanelSlideFrame({
        fromOuterWidth,
        toOuterWidth: params.toOuterWidth,
        fromMainWidth: params.fromMainWidth,
        toMainWidth: params.toMainWidth,
        progress: (now - startedAt) / duration,
        ease: slideEase,
      });
      if (frame.done) {
        current.finish();
        return;
      }
      pin(frame.mainWidth);
      resizeTo(frame.outerWidth);
      current.frameId = win.requestAnimationFrame(step);
    };
    pin(params.fromMainWidth);
    current.frameId = win.requestAnimationFrame(step);
  };
  /** The panel's current width plus its divider. */
  const panelLayoutWidth = () =>
    readPixelVariable(lowerArea, SIDE_PANEL_WIDTH_VARIABLE) +
    STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX;
  const mainColumnWidth = () => mainColumn?.getBoundingClientRect().width || 0;

  const resize = installStandaloneColumnResizeBehavior(
    win,
    lowerArea,
    column,
    splitter,
    {
      side: "right",
      widthVariable: SIDE_PANEL_WIDTH_VARIABLE,
      resizingClass: "llm-standalone-side-panel-resizing",
      defaultWidth: STANDALONE_SIDE_PANEL_DEFAULT_WIDTH_PX,
      minWidth: STANDALONE_SIDE_PANEL_MIN_WIDTH_PX,
      maxWidth: STANDALONE_SIDE_PANEL_MAX_WIDTH_PX,
      // Room the window is about to gain counts as room.
      getReservedWidth: () =>
        deps.getReservedLeftWidth() - getPendingWindowWidthChange(),
      // The divider moves width between the main chat and the panel, like
      // the History pane's; only opening and closing resize the window.
      // Kept for this window only; no pref.
      onWidthCommit: () => deps.onLayoutChanged(),
    },
  );

  const isOpen = () => tabsState.open;

  // -- The main column's chrome metrics and theme ---------------------------
  // The main tab row's gap shrinks with the main column's width (a container
  // query); the panel copies its resolved value, so the tabs and the bar
  // buttons match Paper chat | Library chat exactly.
  const syncChromeGap = () => {
    const mainTabRow = doc.querySelector(
      ".llm-standalone-tab-row",
    ) as HTMLElement | null;
    if (!mainTabRow) return;
    const gap = Number.parseFloat(
      win.getComputedStyle(mainTabRow)?.columnGap || "",
    );
    if (!Number.isFinite(gap) || gap < 0) return;
    column.style.setProperty("--llm-standalone-chrome-gap", `${gap}px`);
  };
  const onWindowResize = () => {
    if (isOpen()) syncChromeGap();
    scheduleNewTabAlign();
  };
  win.addEventListener("resize", onWindowResize);
  // The list takes the Search history popup's theme class; follow the
  // window's light/dark switch.
  const chatRoot = doc.getElementById("llmforzotero-standalone-chat-root");
  const MutationObserverCtor = (win as any).MutationObserver as
    | typeof MutationObserver
    | undefined;
  const themeObserver =
    chatRoot && MutationObserverCtor
      ? new MutationObserverCtor(() => {
          for (const view of views.values()) {
            if (view.kind === "history") view.list.syncTheme();
          }
        })
      : null;
  if (chatRoot) {
    themeObserver?.observe(chatRoot, {
      attributes: true,
      attributeFilter: ["data-standalone-theme"],
    });
  }
  // The main start page comes and goes with the main chat.
  const mainStartPageObserver = MutationObserverCtor
    ? new MutationObserverCtor(() => {
        if (newTabPage && !newTabPage.root.hidden) scheduleNewTabAlign();
      })
    : null;
  mainStartPageObserver?.observe(mainBody, { childList: true, subtree: true });
  const getOccupiedWidth = () =>
    isOpen()
      ? readPixelVariable(lowerArea, SIDE_PANEL_WIDTH_VARIABLE) +
        STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX
      : 0;

  const mainHandle = () => getPanelHandle(mainBody);
  const addTextToMainChat = (text: string): boolean => {
    const value = String(text || "").trim();
    if (!value) return false;
    return (
      mainHandle()?.addTextContext(value, {
        source: "model",
        focusInput: true,
      }) === true
    );
  };
  /** The tab limit, said in the main chat's footer. */
  const reportTabLimit = () => {
    const status = mainBody.querySelector("#llm-status") as HTMLElement | null;
    if (status) {
      setStatus(
        status,
        t(
          "The side panel holds {count} tabs. Close one to open another.",
        ).replace("{count}", `${SIDE_PANEL_MAX_TABS}`),
        "warning",
      );
    }
  };

  const excludedKeys = () =>
    buildSidePanelExcludedKeys(deps.getMainContext().conversationKey);

  // -- Shared title row (same row as the main chat's title) -----------------
  const createTitleRow = (title: string) => {
    const row = createElement(doc, "div", "llm-standalone-content-title");
    row.classList.add("llm-standalone-side-panel-title");
    const text = createElement(
      doc,
      "span",
      "llm-standalone-content-title-text",
      { textContent: title },
    );
    const actions = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-title-actions",
    );
    row.append(text, actions);
    return { row, text, actions };
  };

  const createPill = (
    label: string,
    variant: "read-only" | "temporary" | "kind",
  ) => {
    const pill = createElement(doc, "span", "llm-standalone-side-panel-pill", {
      textContent: label,
    });
    pill.dataset.variant = variant;
    return pill;
  };

  // -- Tabs in the strip ------------------------------------------------------
  const createTab = (
    id: string,
    kind: "readonly" | "sidechat" | "history" | "item" | "misc" | "progress",
    title: string,
    iconClass?: string,
  ) => {
    const tab = createElement(doc, "div", "llm-standalone-side-panel-tab");
    tab.dataset.sideTabId = id;
    tab.dataset.sideTabKind = kind;
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    const icon = createElement(
      doc,
      "span",
      `llm-standalone-side-panel-tab-icon ${
        iconClass ||
        (kind === "sidechat"
          ? "llm-standalone-side-panel-icon-side-chat"
          : "llm-standalone-side-panel-icon-history")
      }`,
    );
    icon.setAttribute("aria-hidden", "true");
    const tabTitle = createElement(
      doc,
      "span",
      "llm-standalone-side-panel-tab-title",
      { textContent: title },
    );
    tab.title = title;
    const close = createElement(
      doc,
      "button",
      "llm-standalone-side-panel-tab-close",
      { type: "button" },
    );
    setButtonLabel(close, t("Close tab"));
    tab.append(icon, tabTitle, close);
    tab.addEventListener("click", (event) => {
      if (
        (event.target as Element | null)?.closest?.(
          ".llm-standalone-side-panel-tab-close",
        )
      ) {
        return;
      }
      focusTab(id);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        focusTab(id);
      }
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      requestTabClose(id);
    });
    return { tab, tabTitle };
  };

  // The New tab tab: the new-tab page's own tab, with a house icon.
  const newTabTab = (() => {
    const tab = createElement(doc, "div", "llm-standalone-side-panel-tab");
    tab.dataset.sideTabKind = "newtab";
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    const icon = createElement(
      doc,
      "span",
      "llm-standalone-side-panel-tab-icon llm-standalone-side-panel-icon-home",
    );
    icon.setAttribute("aria-hidden", "true");
    const title = createElement(
      doc,
      "span",
      "llm-standalone-side-panel-tab-title",
      { textContent: t("New tab") },
    );
    tab.title = t("New tab");
    const close = createElement(
      doc,
      "button",
      "llm-standalone-side-panel-tab-close",
      { type: "button" },
    );
    setButtonLabel(close, t("Close tab"));
    tab.append(icon, title, close);
    const show = () => setTabsState(showSidePanelNewTabPage(tabsState));
    tab.addEventListener("click", (event) => {
      if (
        (event.target as Element | null)?.closest?.(
          ".llm-standalone-side-panel-tab-close",
        )
      ) {
        return;
      }
      show();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        show();
      }
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!tabsState.tabs.length) requestPanelClose();
      else setTabsState(closeSidePanelNewTab(tabsState));
    });
    return tab;
  })();

  const setTabTitle = (view: TabView, title: string) => {
    if (view.tabTitle.textContent === title) return;
    view.tabTitle.textContent = title;
    view.tab.title = title;
    // A longer title can push the shown tab out of the strip's view.
    if (view.tab.classList.contains("active")) revealActiveTab(view);
  };
  const revealActiveTab = (view: TabView) => {
    const run = () =>
      view.tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(run);
    } else {
      run();
    }
  };

  // -- New-tab page -----------------------------------------------------------
  // The chat start page (its title and tagline, centred in the panel) with
  // two nav rows in the window's nav-row style in place of its notes:
  // "Side chat" opens a new side chat tab; "History" turns this tab into
  // the History tab.
  // Two nav rows, in the window's nav-row style: "Side chat" opens a new
  // side chat tab; "History" turns this tab into the History tab.
  const createLaunchRow = (
    kind: "sidechat" | "history" | "misc" | "progress",
    iconClass: string,
    label: string,
    hint: string,
  ) => {
    const row = createElement(
      doc,
      "button",
      "llm-standalone-nav-row llm-standalone-side-panel-launch-row",
      { type: "button" },
    );
    row.dataset.sideLaunch = kind;
    const icon = createElement(
      doc,
      "span",
      `llm-standalone-nav-icon ${iconClass}`,
    );
    icon.setAttribute("aria-hidden", "true");
    row.append(
      icon,
      createElement(doc, "span", "llm-standalone-nav-label", {
        textContent: label,
      }),
      createElement(doc, "span", "llm-standalone-side-panel-launch-hint", {
        textContent: hint,
      }),
    );
    return row;
  };
  const ensureNewTabPage = () => {
    if (newTabPage) return newTabPage;
    const root = createElement(doc, "div", "llm-standalone-side-panel-newtab");
    root.dataset.sideView = "newtab";
    // As the side bodies: the standalone start page centres in its column.
    root.dataset.standalone = "true";
    const startPage = createElement(doc, "div", "llm-start-page");
    const title = createElement(doc, "div", "llm-start-page-title", {
      textContent: "LLM-for-Zotero",
    });
    startPage.append(
      title,
      createElement(doc, "div", "llm-start-page-subtitle", {
        textContent: deps.readOnly
          ? t("Read a past chat")
          : t("Ask on the side, or read a past chat"),
      }),
    );
    const nav = createElement(
      doc,
      "div",
      "llm-standalone-primary-nav llm-standalone-side-panel-newtab-nav",
    );
    // A read-only panel starts no side chats.
    const sideChatRow = deps.readOnly
      ? null
      : createLaunchRow(
          "sidechat",
          "llm-standalone-side-panel-icon-side-chat",
          t("Side chat"),
          t("Ask a quick side question. Not saved."),
        );
    sideChatRow?.addEventListener("click", () => openNewSideChat());
    const historyRow = createLaunchRow(
      "history",
      "llm-standalone-side-panel-icon-history",
      t("History"),
      t("Read another past chat, read-only"),
    );
    historyRow.addEventListener("click", () => openHistoryTab());
    const miscRow = createLaunchRow(
      "misc",
      "llm-standalone-side-panel-icon-misc",
      t("Miscellaneous"),
      t("View what the model made in these chats"),
    );
    miscRow.addEventListener("click", () => openMiscTab());
    const progressRow = createLaunchRow(
      "progress",
      "llm-standalone-side-panel-icon-task-progress",
      t("Task progress"),
      t("Steps, papers and web pages the agent went through"),
    );
    progressRow.addEventListener("click", () => openTaskProgressTab());
    if (sideChatRow) nav.append(sideChatRow);
    nav.append(historyRow, miscRow, progressRow);
    startPage.appendChild(nav);
    root.appendChild(startPage);
    viewHost.appendChild(root);
    alignObserver?.observe(root);
    newTabPage = {
      root,
      startPage,
      title,
      sideChatRow,
      historyRow,
      miscRow,
      progressRow,
    };
    return newTabPage;
  };
  const destroyNewTabPage = () => {
    newTabPage?.root.remove();
    newTabPage = null;
  };
  // While the main chat shows its start page, the New tab page's title sits
  // on the same line as the main title, so the two pages read as one row;
  // otherwise the page centres in its column.
  let observedMainStartPage: Element | null = null;
  let alignFrame: number | null = null;
  const alignNewTabTitle = () => {
    alignFrame = null;
    const page = newTabPage;
    if (disposed || !page || page.root.hidden || !isOpen()) return;
    const mainStartPages = Array.from(
      mainBody.querySelectorAll(".llm-start-page, .llm-standalone-start-page"),
    ) as HTMLElement[];
    const mainStartPage =
      mainStartPages.find((element) => element.getClientRects().length) || null;
    if (mainStartPage !== observedMainStartPage) {
      if (observedMainStartPage)
        alignObserver?.unobserve(observedMainStartPage);
      if (mainStartPage) alignObserver?.observe(mainStartPage);
      observedMainStartPage = mainStartPage;
    }
    const mainTitle = mainStartPage?.querySelector(".llm-start-page-title");
    const { startPage, title } = page;
    if (!mainTitle) {
      delete startPage.dataset.titleLine;
      startPage.style.removeProperty("padding-top");
      return;
    }
    startPage.dataset.titleLine = "main";
    const paddingTop =
      Number.parseFloat(win.getComputedStyle(startPage)?.paddingTop || "") || 0;
    const shift =
      mainTitle.getBoundingClientRect().top - title.getBoundingClientRect().top;
    if (Math.abs(shift) < 0.5) return;
    startPage.style.paddingTop = `${Math.max(0, paddingTop + shift)}px`;
  };
  const scheduleNewTabAlign = () => {
    if (alignFrame !== null || disposed) return;
    alignFrame =
      typeof win.requestAnimationFrame === "function"
        ? win.requestAnimationFrame(alignNewTabTitle)
        : (alignNewTabTitle(), null);
  };
  const ResizeObserverCtor = (win as any).ResizeObserver as
    | typeof ResizeObserver
    | undefined;
  const alignObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => scheduleNewTabAlign())
    : null;

  // -- History tab ------------------------------------------------------------
  // The Search history field (on the title line) and the list; a picked chat
  // replaces this tab with its read-only tab.
  const buildHistoryView = (id: string): HistoryTabView => {
    const root = createElement(doc, "div", "llm-standalone-side-panel-history");
    root.dataset.sideView = "history";
    root.dataset.sideTabId = id;
    const searchRow = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-search-row",
    );
    const listHost = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-history-list",
    );
    root.append(searchRow, listHost);
    viewHost.appendChild(root);
    const list = createEmbeddedHistorySearchList({
      ...deps.historyList,
      parent: listHost,
      showSearch: true,
      searchHost: searchRow,
      getExcludedConversationKeys: excludedKeys,
      onSelect: (entry) => openReadOnly(entry, id),
    });
    const { tab, tabTitle } = createTab(id, "history", t("History"));
    return {
      kind: "history",
      id,
      root,
      body: root,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      list,
    };
  };
  const disposeHistoryView = (view: HistoryTabView) => {
    if (view.disposed) return;
    view.disposed = true;
    view.list.destroy();
    view.root.remove();
    view.tab.remove();
  };
  const historyView = (id: string | null) => {
    const view = id ? views.get(id) : undefined;
    return view?.kind === "history" ? view : null;
  };
  const openHistoryTab = () => {
    const result = openHistorySidePanelTab(tabsState, nextTabId("history"));
    if (result.refused) {
      reportTabLimit();
      return;
    }
    if (result.opened && result.tabId) {
      views.set(result.tabId, buildHistoryView(result.tabId));
    }
    setTabsState(result.state);
  };

  // -- Read-only tabs -------------------------------------------------------
  const disposeReadOnlyView = (view: ReadOnlyTabView) => {
    if (view.disposed) return;
    view.disposed = true;
    // Another read-only tab never holds the same key (picking it focuses
    // the open tab), so this view owns the borrowed copy.
    const ownsHistory =
      view.addedMessages !== null &&
      chatHistory.get(view.conversationKey) === view.addedMessages;
    if (ownsHistory) {
      readOnlyBorrowedConversationKeys.delete(view.conversationKey);
      if (!loadedConversationKeys.has(view.conversationKey)) {
        chatHistory.delete(view.conversationKey);
      }
    }
    // The view's renders wrote this conversation's scroll state; put back
    // what the main chat had, or nothing if it had none. When the main chat
    // now shows this conversation, its own scroll state stays.
    if (deps.getMainContext().conversationKey !== view.conversationKey) {
      restoreChatScrollStateForConversationKey(
        view.conversationKey,
        view.savedScroll,
      );
    }
    disposeChatRendering(view.body);
    clearChatPanelExtensions(view.body);
    setResponseActionRunner(view.body, null);
    view.root.remove();
    view.tab.remove();
  };

  const configureReadOnlyComposer = (view: ReadOnlyTabView) => {
    const body = view.body;
    const inputSection = body.querySelector(
      ".llm-input-section",
    ) as HTMLElement | null;
    if (inputSection) inputSection.dataset.sideReadOnly = "true";
    for (const control of Array.from(
      inputSection?.querySelectorAll("button, input, textarea, select") || [],
    )) {
      (control as HTMLButtonElement).disabled = true;
    }
    const input = body.querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement | null;
    if (input) {
      input.placeholder = t(
        "This chat is read-only. Open it as your main chat to keep going.",
      );
      input.readOnly = true;
      input.disabled = true;
    }
    // No Chat/Agent switch, model, or send controls: nothing can be sent.
    for (const selector of [
      "#llm-runtime-mode-toggle",
      ".llm-actions-left",
      ".llm-actions-right",
    ]) {
      const element = body.querySelector(selector) as HTMLElement | null;
      if (element) element.style.display = "none";
    }
    // The context row shows the chat's paper, as the main chat would, but
    // greyed: nothing here can change it.
    const paper = deps.resolveHistoryEntryPaper(view.entry);
    const paperContext =
      view.entry.kind === "paper"
        ? resolvePaperContextRefFromItem(paper)
        : null;
    const paperPreview = body.querySelector(
      "#llm-paper-context-preview",
    ) as HTMLElement | null;
    const paperList = body.querySelector(
      "#llm-paper-context-list",
    ) as HTMLElement | null;
    if (paperContext && paperPreview && paperList) {
      const mode = paperContext.contentSourceMode || "text";
      const chip = createElement(
        doc,
        "div",
        `llm-selected-context llm-paper-context-chip llm-paper-context-chip-static llm-paper-context-chip-autoloaded collapsed ${getContextSourceModeCssClassName(mode)}`,
      );
      chip.dataset.sideReadOnlyChip = "true";
      chip.setAttribute("aria-disabled", "true");
      const header = createElement(
        doc,
        "div",
        "llm-image-preview-header llm-selected-context-header llm-paper-context-chip-header",
      );
      const label = createElement(doc, "span", "llm-paper-context-chip-label", {
        title: paperContext.title || "",
      });
      label.append(
        createContextIcon(doc, "paper", "llm-paper-context-chip-icon"),
        createElement(doc, "span", "llm-paper-context-chip-text", {
          textContent: formatPaperContextChipLabel(paperContext, mode),
        }),
      );
      header.appendChild(label);
      chip.appendChild(header);
      paperList.replaceChildren(chip);
      // As the main chat shows its chips (setupHandlers' preview render).
      paperPreview.style.display = "contents";
      paperList.style.display = "contents";
    }
    const actionsRow = body.querySelector(".llm-actions") as HTMLElement | null;
    if (actionsRow) {
      const group = createElement(
        doc,
        "div",
        "llm-standalone-side-panel-readonly-actions",
      );
      if (view.entry.kind === "paper" && paper) {
        const addPaper = createElement(
          doc,
          "button",
          "llm-shortcut-btn llm-action-btn llm-action-btn-secondary",
          { type: "button", textContent: t("Add this paper to main chat") },
        );
        addPaper.dataset.sideReadOnlyAction = "add-paper";
        addPaper.addEventListener("click", () => {
          void mainHandle()?.addItemsAsDefaultContext([paper]);
        });
        group.appendChild(addPaper);
      }
      const openMain = createElement(
        doc,
        "button",
        "llm-shortcut-btn llm-action-btn llm-action-btn-primary",
        { type: "button", textContent: t("Open as main chat") },
      );
      openMain.dataset.sideReadOnlyAction = "open-main";
      openMain.addEventListener("click", () => {
        const entry = view.entry;
        const previousKey = deps.getMainContext().conversationKey;
        const index = tabsState.tabs.findIndex((tab) => tab.id === view.id);
        // Drop the read-only copy first so the main chat loads its own.
        closeTabNow(view.id);
        void (async () => {
          if (!(await deps.openAsMainChat(entry))) {
            // The switch failed (the main chat says why): the tab comes back.
            restoreReadOnlyTab(entry, index);
            return;
          }
          await showPreviousMainChat(previousKey, index);
        })().catch((err) => {
          appLogger.warn("LLM: side panel open as main chat failed", err);
        });
      });
      group.appendChild(openMain);
      actionsRow.appendChild(group);
    }
    const status = body.querySelector("#llm-status") as HTMLElement | null;
    if (status) setNeutralStatus(status, t("Read-only"));
    const footerControls = body.querySelector(
      ".llm-footer-controls",
    ) as HTMLElement | null;
    if (footerControls) footerControls.style.display = "none";
  };

  const buildReadOnlyView = (
    id: string,
    entry: ConversationHistoryEntry,
    item: Zotero.Item,
    fromHistory = false,
  ): ReadOnlyTabView => {
    const savedScroll = saveChatScrollStateForConversationKey(
      entry.conversationKey,
    );
    const title = entry.title || t("Untitled chat");
    const root = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-readonly",
    );
    root.dataset.sideView = "readonly";
    root.dataset.sideTabId = id;
    const { row, actions } = createTitleRow(title);
    // Only a chat picked in the History list can go back to it.
    if (fromHistory) {
      const back = createIconButton(
        doc,
        "llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-back",
        t("Back to History"),
      );
      back.dataset.itemAction = "back";
      back.addEventListener("click", () => backToHistory(id));
      row.prepend(back);
    }
    actions.appendChild(createPill(t("Read-only"), "read-only"));
    const body = createElement(
      doc,
      "div",
      "llm-standalone-side-body llm-standalone-side-readonly-body",
    );
    body.dataset.standalone = "true";
    body.dataset.sideReadOnly = "true";
    root.append(row, body);
    viewHost.appendChild(root);
    buildUI(body, item);
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    if (panelRoot) panelRoot.dataset.standalone = "true";
    applyPanelFontScale(panelRoot);
    const { tab, tabTitle } = createTab(id, "readonly", title);
    const view: ReadOnlyTabView = {
      kind: "readonly",
      id,
      root,
      body,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      entry,
      item,
      conversationKey: entry.conversationKey,
      addedMessages: null,
      savedScroll,
    };
    setChatPanelExtensions(body, {
      readOnly: true,
      extraAssistantActions: [
        {
          id: "quote-main",
          label: t("Quote in main chat"),
          run: (info) => {
            addTextToMainChat(info.contentText);
          },
        },
      ],
    });
    setResponseActionRunner(body, async (action, target) => {
      if (!target) return;
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (action === "copy" && target.contentText.trim()) {
        await copyRenderedMarkdownToClipboard(
          body,
          target.contentText,
          target.quoteCitations,
        );
        if (status) setStatus(status, t("Copied response"), "ready");
      } else if (action === "expand") {
        openStandaloneResponseDocument(body, target);
      }
    });
    configureReadOnlyComposer(view);
    void (async () => {
      const key = view.conversationKey;
      try {
        if (!chatHistory.has(key) && !loadedConversationKeys.has(key)) {
          const messages = await loadConversationMessagesForReadOnlyView(
            key,
            deps.getMainContext().conversationSystem,
          );
          if (view.disposed) return;
          if (!chatHistory.has(key) && !loadedConversationKeys.has(key)) {
            chatHistory.set(key, messages);
            // Display-only copy: a real load must replace it, not trust it.
            readOnlyBorrowedConversationKeys.add(key);
            view.addedMessages = messages;
          }
        }
        if (view.disposed) return;
        refreshChat(body, item);
      } catch (err) {
        appLogger.warn("LLM: side panel read-only load failed", err);
      }
    })();
    return view;
  };

  /**
   * A past chat opens in a read-only tab, or focuses its open tab. Picked
   * in the History tab, it replaces that tab.
   */
  const openReadOnly = (
    entry: ConversationHistoryEntry,
    fromHistoryId?: string,
  ): boolean => {
    const result = openReadOnlySidePanelTab(tabsState, {
      id: nextTabId("readonly"),
      conversationKey: entry.conversationKey,
      replaceId: fromHistoryId,
    });
    if (result.refused) {
      reportTabLimit();
      return false;
    }
    if (result.opened && result.tabId) {
      const item = deps.buildHistoryEntryItem(entry);
      if (!item) return false;
      views.set(
        result.tabId,
        buildReadOnlyView(result.tabId, entry, item, Boolean(fromHistoryId)),
      );
    }
    const replaced = historyView(fromHistoryId ?? null);
    if (replaced && !result.state.tabs.some((tab) => tab.id === replaced.id)) {
      views.delete(replaced.id);
      disposeHistoryView(replaced);
    }
    setTabsState(result.state);
    return true;
  };

  /** "Back to History": the read-only tab turns back into the History tab. */
  const backToHistory = (readOnlyTabId: string) => {
    const readOnly = views.get(readOnlyTabId);
    if (disposed || readOnly?.kind !== "readonly") return;
    const result = returnReadOnlyTabToHistory(
      tabsState,
      readOnlyTabId,
      nextTabId("history"),
    );
    if (!result.tabId) return;
    views.delete(readOnlyTabId);
    disposeReadOnlyView(readOnly);
    if (result.opened) {
      views.set(result.tabId, buildHistoryView(result.tabId));
    }
    setTabsState(result.state);
  };

  /** Open `entry` read-only again at `index` in the strip. */
  const restoreReadOnlyTab = (
    entry: ConversationHistoryEntry,
    index: number,
  ) => {
    if (disposed || !tabsState.open || !openReadOnly(entry)) return;
    const tab = tabsState.tabs.find(
      (candidate) =>
        candidate.kind === "readonly" &&
        candidate.conversationKey === entry.conversationKey,
    );
    if (tab && index >= 0)
      setTabsState(moveSidePanelTab(tabsState, tab.id, index));
  };

  /**
   * After "Open as main chat", the chat the main column showed before takes
   * the opened chat's place as a read-only tab, so both stay in view. A
   * chat with no saved turns has no history entry and opens no tab.
   */
  const showPreviousMainChat = async (previousKey: number, index: number) => {
    if (disposed || !tabsState.open) return;
    if (!Number.isFinite(previousKey) || previousKey <= 0) return;
    if (previousKey === deps.getMainContext().conversationKey) return;
    const entries = await deps.historyList.loadEntries();
    if (disposed || !tabsState.open) return;
    const previous = entries.find(
      (candidate) => candidate.conversationKey === previousKey,
    );
    if (previous) restoreReadOnlyTab(previous, index);
  };

  // -- Side chat tabs -------------------------------------------------------
  const sideChatMessages = (view: SideChatTabView | null | undefined) =>
    view ? chatHistory.get(view.conversationKey) || [] : [];
  const sideChatViews = () =>
    [...views.values()].filter(
      (view): view is SideChatTabView => view.kind === "sidechat",
    );
  const sideChatView = (id: string | null) => {
    const view = id ? views.get(id) : undefined;
    return view?.kind === "sidechat" ? view : null;
  };

  const registerBackgroundProvider = (conversationKey: number) => {
    setEphemeralBackgroundContextProvider(conversationKey, () => {
      const mainKey = deps.getMainContext().conversationKey;
      const text = buildMainChatBackgroundContext(
        chatHistory.get(mainKey) || [],
      );
      return text || null;
    });
  };

  const renderContextNotes = (view: SideChatTabView, chatBox: HTMLElement) => {
    if (view.disposed) return;
    for (const old of Array.from(
      chatBox.querySelectorAll(`.${SIDE_CHAT_CONTEXT_NOTE_CLASS}`),
    ) as Element[]) {
      old.remove();
    }
    view.clearButton.disabled = isEphemeralConversationBusy(
      view.conversationKey,
    );
    // The tab is titled by the chat's first question once it is asked.
    setTabTitle(
      view,
      resolveSideChatTabTitle(sideChatMessages(view), t("Side chat")),
    );
    if (!view.notes.length) return;
    const wrappers = Array.from(
      chatBox.querySelectorAll(".llm-message-wrapper[data-message-index]"),
    ) as HTMLElement[];
    if (!wrappers.length) return;
    const byIndex = new Map<number, HTMLElement>();
    for (const wrapper of wrappers) {
      byIndex.set(Number(wrapper.dataset.messageIndex), wrapper);
    }
    const anchors = resolveSideChatContextNoteAnchors(view.notes, [
      ...byIndex.keys(),
    ]);
    for (const anchor of anchors) {
      const note = createElement(doc, "div", SIDE_CHAT_CONTEXT_NOTE_CLASS);
      note.setAttribute("role", "note");
      note.appendChild(
        createElement(doc, "span", "llm-side-chat-context-note-text", {
          textContent: anchor.text,
        }),
      );
      if (anchor.afterMessageIndex === null) {
        wrappers[0].before(note);
      } else {
        const wrapper = byIndex.get(anchor.afterMessageIndex);
        // Keep notes in their own order when two share one anchor.
        let after: Element | null = wrapper || null;
        while (
          after?.nextElementSibling?.classList.contains(
            SIDE_CHAT_CONTEXT_NOTE_CLASS,
          )
        ) {
          after = after.nextElementSibling;
        }
        after?.after(note);
      }
    }
  };

  const hideTabConfirm = (view: TabView) => {
    view.confirm?.remove();
    view.confirm = null;
  };

  const sideChatRenderSignature = (conversationKey: number): string => {
    const history = chatHistory.get(conversationKey);
    const last = history?.[history.length - 1];
    return [
      conversationKey,
      history ? history.length : -1,
      last?.timestamp ?? "",
      last?.text?.length ?? 0,
      last?.streaming ? 1 : 0,
    ].join(":");
  };

  const mountSideChatBody = (view: SideChatTabView) => {
    hideTabConfirm(view);
    const { body, context, conversationKey } = view;
    if (body.childElementCount) {
      disposeMountedPanelBody(body);
      body.replaceChildren();
    }
    const item =
      context.kind === "paper" && view.basePaperItem
        ? createPaperPortalItem(view.basePaperItem, conversationKey, 1)
        : createGlobalPortalItem(context.libraryID, conversationKey);
    view.item = item;
    markSidePanelBody(body);
    const panelRoot = mountPanelShell({
      body,
      renderItem: item,
      beforeRegister: () => markSidePanelBody(body, item),
      getMountedItem: () => item,
      rawItem: context.kind === "paper" ? view.basePaperItem : null,
      setupItem: item,
    });
    setChatPanelExtensions(body, {
      sideChat: true,
      extraAssistantActions: [
        {
          id: "send-main",
          label: t("Send to main chat"),
          run: (info) => {
            addTextToMainChat(info.contentText);
          },
        },
      ],
      afterRender: (chatBox) => renderContextNotes(view, chatBox),
    });
    refreshChat(body, item);
    applyPanelFontScale(panelRoot);
    if (context.kind === "paper") void renderShortcuts(body, item, "paper");
    const input = body.querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement | null;
    if (input && !input.disabled) {
      input.placeholder =
        context.kind === "paper"
          ? t("Ask a side question about this paper...")
          : t("Ask a side question about your library...");
    }
    registerBackgroundProvider(conversationKey);
    // A side chat reopened from its tab already holds its history in memory;
    // the load then changes nothing, and a second full render is wasted.
    const loadChangesNothing =
      loadedConversationKeys.has(conversationKey) &&
      chatHistory.has(conversationKey) &&
      composeContextStore.initializedConversations.has(conversationKey);
    const renderedSignature = sideChatRenderSignature(conversationKey);
    void ensureConversationLoaded(item, { body })
      .then(() => {
        if (view.disposed || view.item !== item) return;
        if (
          loadChangesNothing &&
          sideChatRenderSignature(conversationKey) === renderedSignature
        ) {
          return;
        }
        refreshChat(body, item);
      })
      .catch((err) => {
        appLogger.warn("LLM: side chat load failed", err);
      });
  };

  const resolveCurrentSideChatContext = () => {
    const main = deps.getMainContext();
    return {
      context: resolveSideChatContext({
        mode: main.mode,
        basePaperItemID: Number(main.basePaperItem?.id || 0),
        libraryID: main.libraryID,
      }),
      basePaperItem: main.basePaperItem,
    };
  };

  const buildSideChatView = (id: string): SideChatTabView => {
    const { context, basePaperItem } = resolveCurrentSideChatContext();
    const conversationKey =
      context.kind === "paper"
        ? allocateEphemeralPaperConversationKey()
        : allocateEphemeralGlobalConversationKey();
    const root = createElement(doc, "div", "llm-standalone-side-panel-chat");
    root.dataset.sideView = "sidechat";
    root.dataset.sideTabId = id;
    const { row, actions } = createTitleRow(t("Side chat"));
    row
      .querySelector(".llm-standalone-content-title-text")
      ?.after(createPill(t("Temporary"), "temporary"));
    const clearButton = createIconButton(
      doc,
      "llm-standalone-side-panel-icon-clear",
      t("Clear side chat"),
    );
    actions.appendChild(clearButton);
    const body = createElement(doc, "div", "llm-standalone-side-body");
    body.dataset.standalone = "true";
    root.append(row, body);
    viewHost.appendChild(root);
    // The first side chat starts from the window's model and reasoning
    // choices; later ones share the side chats' choices.
    if (!sideChatViews().length) startSideSurfaceChoicesFromStandalone();
    const { tab, tabTitle } = createTab(id, "sidechat", t("Side chat"));
    const view: SideChatTabView = {
      kind: "sidechat",
      id,
      root,
      body,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      clearButton,
      conversationKey,
      context,
      basePaperItem: context.kind === "paper" ? basePaperItem : null,
      item: null,
      notes: [],
      followRetryTimer: null,
    };
    clearButton.addEventListener("click", () => clearSideChat(view));
    return view;
  };

  const stopSideChatRequest = (view: SideChatTabView) => {
    if (!isEphemeralConversationBusy(view.conversationKey)) return;
    const cancel = view.body.querySelector(
      "#llm-cancel",
    ) as HTMLButtonElement | null;
    try {
      cancel?.click();
    } catch (err) {
      appLogger.warn("LLM: side chat cancel failed", err);
    }
    try {
      getAbortController(view.conversationKey)?.abort();
    } catch {
      // Already aborted.
    }
  };

  const clearSideChat = (view: SideChatTabView) => {
    if (view.disposed || isEphemeralConversationBusy(view.conversationKey)) {
      return;
    }
    hideTabConfirm(view);
    discardEphemeralConversation(view.conversationKey);
    chatHistory.set(view.conversationKey, []);
    loadedConversationKeys.add(view.conversationKey);
    registerBackgroundProvider(view.conversationKey);
    view.notes = [];
    if (view.item) refreshChat(view.body, view.item);
  };

  const disposeSideChatView = (view: SideChatTabView) => {
    if (view.disposed) return;
    if (view.followRetryTimer !== null) {
      win.clearTimeout(view.followRetryTimer);
      view.followRetryTimer = null;
    }
    stopSideChatRequest(view);
    view.disposed = true;
    disposeMountedPanelBody(view.body);
    clearChatPanelExtensions(view.body);
    clearEphemeralBackgroundContextProvider(view.conversationKey);
    discardEphemeralConversation(view.conversationKey);
    view.root.remove();
    view.tab.remove();
  };

  const followMainContext = (view: SideChatTabView) => {
    if (view.disposed || disposed) return;
    const { context, basePaperItem } = resolveCurrentSideChatContext();
    if (isSameSideChatContext(view.context, context)) return;
    if (isEphemeralConversationBusy(view.conversationKey)) {
      // Move the chat once its answer ends.
      if (view.followRetryTimer === null) {
        view.followRetryTimer = win.setTimeout(() => {
          view.followRetryTimer = null;
          followMainContext(view);
        }, CONTEXT_FOLLOW_RETRY_MS);
      }
      return;
    }
    const nextKey =
      context.kind === "paper"
        ? allocateEphemeralPaperConversationKey()
        : allocateEphemeralGlobalConversationKey();
    if (!moveEphemeralConversation(view.conversationKey, nextKey)) {
      appLogger.warn("LLM: side chat context move refused", {
        from: view.conversationKey,
        to: nextKey,
      });
      return;
    }
    const messageCount = (chatHistory.get(nextKey) || []).length;
    const noteText =
      context.kind === "paper"
        ? t(
            "Context switched to {paper}. New questions use this paper.",
          ).replace("{paper}", resolvePaperDisplayTitle(basePaperItem))
        : t(
            "Context switched to My Library. New questions use your whole library.",
          );
    view.notes = appendSideChatContextNote(view.notes, messageCount, noteText);
    // New questions use the new paper or library only: do not restore the
    // earlier turns' paper chips into the composer.
    composeContextStore.initializedConversations.mark(nextKey);
    view.conversationKey = nextKey;
    view.context = context;
    view.basePaperItem = context.kind === "paper" ? basePaperItem : null;
    mountSideChatBody(view);
  };

  /** Opens a new side chat tab; null when the panel is full or read only. */
  const openNewSideChat = (): SideChatTabView | null => {
    if (deps.readOnly) return null;
    const id = nextTabId("sidechat");
    const result = openSideChatSidePanelTab(openSidePanel(tabsState), id);
    if (result.refused) {
      reportTabLimit();
      return null;
    }
    const view = buildSideChatView(id);
    views.set(id, view);
    setTabsState(result.state);
    // Mounted while shown, so the composer lays out at the panel's width.
    mountSideChatBody(view);
    return view;
  };

  const askInSideChat = (text: string, question?: string) => {
    if (deps.readOnly) return;
    const opened = openSidePanel(tabsState);
    const targetId = resolveAskInSideChatTab(opened);
    let view = sideChatView(targetId);
    if (view) {
      setTabsState(focusSidePanelTab(opened, view.id));
    } else {
      view = openNewSideChat();
    }
    if (!view) return;
    getPanelHandle(view.body)?.addTextContext(text, {
      source: "model",
      focusInput: true,
      question,
    });
  };

  // -- Item tabs -----------------------------------------------------------
  const ITEM_KIND_LABELS: Record<SidePanelItemKind, string> = {
    mermaid: "Diagram",
    svg: "Figure",
    html: "HTML",
    code: "Code",
    // An agent-written document (a literature review, a report), whatever
    // the internal kind is called.
    plan: "Document",
    figure: "Paper figure",
    file: "File",
  };
  const HTML_SAFE_BOX_NOTE =
    "Runs in a safe box: no internet, no access to Zotero";

  // The text size of a document or code tab: one size for every such tab,
  // remembered across restarts.
  const READER_TEXT_SIZE_VARIABLE = "--llm-side-reader-text-scale";
  const readerSizeSyncs = new Set<() => void>();
  const applyReaderTextSize = (target: HTMLElement) => {
    target.style.setProperty(
      READER_TEXT_SIZE_VARIABLE,
      String(getSideReaderTextSizePref() / 100),
    );
  };
  const setReaderTextSize = (percent: number) => {
    setSideReaderTextSizePref(percent);
    for (const target of Array.from(
      doc.querySelectorAll(
        '.llm-standalone-side-panel-item-body[data-side-text-size="true"]',
      ),
    ) as HTMLElement[])
      applyReaderTextSize(target);
    for (const sync of readerSizeSyncs) sync();
  };

  const buildItemView = (
    id: string,
    request: SidePanelItemRequest,
    itemKey: string,
    messageIndex: number,
    conversationKey: number,
    fromMisc: boolean,
  ): ItemTabView => {
    const kind = request.kind;
    const title = resolveItemTabTitle(request, t);
    const root = createElement(doc, "div", "llm-standalone-side-panel-item");
    root.dataset.sideView = "item";
    root.dataset.sideItemKind = kind;
    root.dataset.sideTabId = id;
    const { row, actions } = createTitleRow(title);
    // Only an item picked in the Miscellaneous list can go back to it.
    if (fromMisc) {
      const back = createIconButton(
        doc,
        "llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-back",
        t("Back to Miscellaneous"),
      );
      back.dataset.itemAction = "back";
      back.addEventListener("click", () => backToMisc(id));
      row.prepend(back);
    }
    row
      .querySelector(".llm-standalone-content-title-text")
      ?.after(createPill(t(ITEM_KIND_LABELS[kind]), "kind"));
    const status = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-item-status",
    );
    status.setAttribute("role", "status");
    const filePath = kind === "file" ? request.filePath || request.source : "";
    const runsPage =
      kind === "html" ||
      (kind === "file" && savedFilePreviewKind(filePath) === "html");
    const defaultStatus = runsPage ? t(HTML_SAFE_BOX_NOTE) : "";
    status.textContent = defaultStatus;
    status.hidden = !defaultStatus;
    let feedbackTimer: number | null = null;
    const showFeedback = (text: string) => {
      status.textContent = text;
      status.hidden = false;
      if (feedbackTimer !== null) win.clearTimeout(feedbackTimer);
      feedbackTimer = win.setTimeout(() => {
        feedbackTimer = null;
        status.textContent = defaultStatus;
        status.hidden = !defaultStatus;
      }, 2000);
    };

    const body = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-item-body",
    );
    body.dataset.itemKind = kind;
    const mountBody = () => {
      body.replaceChildren();
      if (kind === "file") {
        void renderSavedFileInto(doc, body, filePath, {
          markdown: (target, markdown) => {
            markStandaloneFlatScope(target);
            renderRenderedMarkdownInto(target, markdown, doc);
          },
        });
        return;
      }
      const box = createElement(
        doc,
        "div",
        "llm-standalone-side-panel-item-rendered",
      );
      // The flat style, as in chat answers: no container, one hover bar.
      markStandaloneFlatScope(box);
      // Diagrams and drawings zoom and pan like a figure tab.
      if (!request.renderBody && (kind === "mermaid" || kind === "svg")) {
        box.setAttribute(CONTENT_TAB_ZOOM_ATTRIBUTE, "true");
      }
      body.appendChild(box);
      if (request.renderBody) {
        request.renderBody(doc, box);
      } else if (
        kind === "mermaid" ||
        kind === "svg" ||
        kind === "code" ||
        kind === "html"
      ) {
        renderRenderedMarkdownInto(box, buildItemFenceMarkdown(request), doc);
      } else {
        renderRenderedMarkdownInto(box, request.source, doc);
      }
    };

    // Icon-only, like the other side panel title actions; the label lives in
    // title and aria-label.
    const makeAction = (name: string, label: string, run: () => void) => {
      const button = createIconButton(
        doc,
        `llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-${name}`,
        label,
      );
      button.dataset.itemAction = name;
      button.addEventListener("click", run);
      return button;
    };
    // A document is read here: text size − and +, and its own window, like
    // the diagram and page viewers' controls. Copy and Save as note stay on
    // the card in the chat and in the document's own window. A code tab gets
    // the same − and +; its copy button is on the code block's hover bar.
    const reader = kind === "plan";
    const sizable = reader || kind === "code";
    let syncReaderSize: (() => void) | undefined;
    if (reader) body.dataset.sideReader = "true";
    if (sizable) {
      body.dataset.sideTextSize = "true";
      const smaller = makeAction("text-smaller", t("Smaller text"), () =>
        setReaderTextSize(
          getSideReaderTextSizePref() - SIDE_READER_TEXT_SIZE_STEP_PERCENT,
        ),
      );
      const larger = makeAction("text-larger", t("Larger text"), () =>
        setReaderTextSize(
          getSideReaderTextSizePref() + SIDE_READER_TEXT_SIZE_STEP_PERCENT,
        ),
      );
      const syncSizeButtons = () => {
        const size = getSideReaderTextSizePref();
        smaller.disabled = size <= SIDE_READER_TEXT_SIZE_MIN_PERCENT;
        larger.disabled = size >= SIDE_READER_TEXT_SIZE_MAX_PERCENT;
      };
      readerSizeSyncs.add(syncSizeButtons);
      syncReaderSize = syncSizeButtons;
      applyReaderTextSize(body);
      syncSizeButtons();
      actions.append(smaller, larger);
      const openOwnWindow = reader ? request.openOwnWindow : undefined;
      if (openOwnWindow) {
        actions.appendChild(
          makeAction("own-window", t("Open in its own window"), () => {
            if (!openOwnWindow())
              showFeedback(t("The document window could not be opened"));
          }),
        );
      }
    }
    if (!sizable)
      actions.appendChild(
        makeAction("copy", t("Copy"), () => {
          void copyTextToClipboard(mainBody, request.source)
            .then(() => showFeedback(t("Copied")))
            .catch((err) => appLogger.warn("LLM: side panel copy failed", err));
        }),
      );
    if (!reader && canSaveItemAsNote(kind) && request.saveAsNote) {
      const save = request.saveAsNote;
      const button = makeAction("note", t("Save as note"), () => {
        button.disabled = true;
        void save()
          .then((text) => showFeedback(t(text)))
          .catch((err) => {
            appLogger.warn("LLM: side panel save as note failed", err);
            showFeedback(t("Could not save the note"));
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      actions.appendChild(button);
    }
    if (kind === "file") {
      actions.appendChild(
        makeAction("reveal", t("Show in folder"), () => {
          revealLocalPath(filePath);
        }),
      );
    }
    if (canRunItemAgain(kind)) {
      const reload = kind === "file";
      actions.appendChild(
        makeAction(
          "rerun",
          t(reload ? "Load again from disk" : "Run again"),
          () => {
            mountBody();
            showFeedback(t(reload ? "Loaded again" : "Ran again"));
          },
        ),
      );
    }
    if (!reader && messageIndex >= 0) {
      actions.appendChild(
        makeAction("show-in-chat", t("Show in chat"), () => showInChat(view)),
      );
    }
    root.append(row, status, body);
    viewHost.appendChild(root);
    mountBody();
    const { tab, tabTitle } = createTab(
      id,
      "item",
      title,
      `llm-standalone-side-panel-icon-item-${kind}`,
    );
    const view: ItemTabView = {
      kind: "item",
      itemKind: kind,
      itemKey,
      id,
      root,
      body,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      conversationKey,
      messageIndex,
      syncReaderSize,
    };
    return view;
  };

  /**
   * Scrolls the main chat to the item's message and flashes it; an item from
   * another chat of the paper switches the main chat to that chat first.
   */
  const showInChat = (view: ItemTabView) => {
    void goToChat(view.conversationKey, view.messageIndex).then((shown) => {
      const mainStatus = mainBody.querySelector(
        "#llm-status",
      ) as HTMLElement | null;
      if (!shown && mainStatus && !disposed) {
        setStatus(
          mainStatus,
          t("The source message is not in the main chat now."),
          "warning",
        );
      }
    });
  };

  const disposeItemView = (view: ItemTabView) => {
    if (view.disposed) return;
    view.disposed = true;
    if (view.syncReaderSize) readerSizeSyncs.delete(view.syncReaderSize);
    view.root.remove();
    view.tab.remove();
  };

  /**
   * Opens the panel if it is closed, then opens the item's tab, or switches
   * to it when the same item (same source message, kind, and position) is
   * already open.
   */
  const openItem = (
    request: SidePanelItemRequest,
    replaceId?: string,
    /** The chat the item was made in; default: the main chat. */
    sourceConversationKey?: number,
  ): boolean => {
    if (disposed) return false;
    const conversationKey =
      sourceConversationKey ?? deps.getMainContext().conversationKey;
    const { messageIndex, itemKey } = resolveSidePanelItemIdentity(
      request,
      conversationKey,
    );
    const result = openItemSidePanelTab(openSidePanel(tabsState), {
      id: nextTabId("item"),
      itemKey,
      replaceId,
    });
    if (result.refused) {
      reportTabLimit();
      return false;
    }
    const replaced = replaceId ? views.get(replaceId) : undefined;
    if (result.opened && result.tabId) {
      views.set(
        result.tabId,
        buildItemView(
          result.tabId,
          request,
          itemKey,
          messageIndex,
          conversationKey,
          replaced?.kind === "misc",
        ),
      );
    }
    if (
      replaced &&
      replaced.kind === "misc" &&
      !result.state.tabs.some((tab) => tab.id === replaced.id)
    ) {
      miscScrollTop = replaced.list.scrollTop;
      views.delete(replaced.id);
      disposeMiscView(replaced);
    }
    setTabsState(result.state);
    return true;
  };

  /**
   * Turns an item tab picked from the Miscellaneous list back into that list,
   * refreshed and scrolled where it was.
   */
  const backToMisc = (itemTabId: string) => {
    const item = views.get(itemTabId);
    if (disposed || item?.kind !== "item") return;
    const result = returnItemTabToMisc(tabsState, itemTabId, nextTabId("misc"));
    if (!result.tabId) return;
    views.delete(itemTabId);
    disposeItemView(item);
    let misc = views.get(result.tabId);
    if (result.opened) {
      misc = buildMiscView(result.tabId);
      views.set(result.tabId, misc);
    } else if (misc?.kind === "misc") {
      misc.refresh();
    }
    setTabsState(result.state);
    if (misc?.kind === "misc") misc.list.scrollTop = miscScrollTop;
  };

  // -- Miscellaneous tab -------------------------------------------------------
  /** Where the list was scrolled when a picked item replaced it. */
  let miscScrollTop = 0;

  // The other chats of the paper are not on screen. Each is drawn once into
  // a hidden body with the main chat's renderer (as a read-only tab draws
  // it), its items are read off, and the body is dropped. The result is kept
  // until the chat changes (its last activity time moves).
  type MadeItemScan = { stamp: number; items: ChatMadeItem[] };
  const madeItemScans = new Map<number, MadeItemScan>();
  let scanQueue: Promise<unknown> = Promise.resolve();
  let scanHost: HTMLElement | null = null;
  const ensureScanHost = () => {
    if (!scanHost) {
      scanHost = createElement(
        doc,
        "div",
        "llm-standalone-side-misc-scan-host",
      );
      scanHost.setAttribute("aria-hidden", "true");
      column.appendChild(scanHost);
    }
    return scanHost;
  };

  /** Resolves once `root` has had no changes for `quietMs` (at most `maxMs`). */
  const waitForQuietDom = (root: Element, quietMs = 200, maxMs = 3000) =>
    new Promise<void>((resolve) => {
      const MutationObserverCtor = (
        win as unknown as { MutationObserver?: typeof MutationObserver }
      ).MutationObserver;
      if (!MutationObserverCtor) {
        resolve();
        return;
      }
      let quietTimer: number | null = null;
      let capTimer: number | null = null;
      const done = () => {
        observer.disconnect();
        if (quietTimer !== null) win.clearTimeout(quietTimer);
        if (capTimer !== null) win.clearTimeout(capTimer);
        resolve();
      };
      const observer = new MutationObserverCtor(() => {
        if (quietTimer !== null) win.clearTimeout(quietTimer);
        quietTimer = win.setTimeout(done, quietMs);
      });
      observer.observe(root, { childList: true, subtree: true });
      quietTimer = win.setTimeout(done, quietMs);
      capTimer = win.setTimeout(done, maxMs);
    });

  const scanChatMadeItems = async (
    entry: ConversationHistoryEntry,
  ): Promise<ChatMadeItem[]> => {
    const key = entry.conversationKey;
    const stamp = Number(entry.lastActivityAt) || 0;
    const cached = madeItemScans.get(key);
    if (cached && cached.stamp === stamp) return cached.items;
    if (disposed) return [];
    const item = deps.buildHistoryEntryItem(entry);
    if (!item) return [];
    const savedScroll = saveChatScrollStateForConversationKey(key);
    const body = createElement(
      doc,
      "div",
      "llm-standalone-side-body llm-standalone-side-misc-scan",
    );
    body.dataset.standalone = "true";
    body.dataset.sideReadOnly = "true";
    ensureScanHost().appendChild(body);
    let added: unknown[] | null = null;
    try {
      buildUI(body, item);
      setChatPanelExtensions(body, { readOnly: true });
      if (!chatHistory.has(key) && !loadedConversationKeys.has(key)) {
        const messages = await loadConversationMessagesForReadOnlyView(
          key,
          entry.system,
        );
        if (disposed) return [];
        if (!chatHistory.has(key) && !loadedConversationKeys.has(key)) {
          chatHistory.set(key, messages);
          readOnlyBorrowedConversationKeys.add(key);
          added = messages;
        }
      }
      refreshChat(body, item);
      flushPendingChatRender(body.querySelector("#llm-chat-box"));
      await waitForQuietDom(body);
      const items = collectMadeItems(body).map((made) => ({
        ...made,
        conversationKey: key,
      }));
      madeItemScans.set(key, { stamp, items });
      return items;
    } finally {
      if (added && chatHistory.get(key) === added) {
        // A read-only tab that opened this chat meanwhile took the copy.
        const reader = [...views.values()].find(
          (view): view is ReadOnlyTabView =>
            view.kind === "readonly" && view.conversationKey === key,
        );
        if (reader) {
          reader.addedMessages = added;
        } else {
          readOnlyBorrowedConversationKeys.delete(key);
          if (!loadedConversationKeys.has(key)) chatHistory.delete(key);
        }
      }
      if (deps.getMainContext().conversationKey !== key) {
        restoreChatScrollStateForConversationKey(key, savedScroll);
      }
      disposeChatRendering(body);
      clearChatPanelExtensions(body);
      body.remove();
    }
  };
  /** One chat at a time: each scan draws a whole chat. */
  const queueChatScan = (entry: ConversationHistoryEntry) => {
    const next = scanQueue.then(() => scanChatMadeItems(entry));
    scanQueue = next.catch(() => undefined);
    return next;
  };

  /**
   * The chats of the main chat's paper (or, in Library chat, the library's
   * chats), as the history list has them; chats being deleted are left out.
   */
  const loadWorkspaceChats = async (): Promise<ConversationHistoryEntry[]> => {
    const main = deps.getMainContext();
    const paperID = Number(main.basePaperItem?.id || 0);
    const entries = await deps.historyList.loadEntries();
    return entries.filter((entry) => {
      if (
        entry.isPendingDelete ||
        pendingDeletionStore.isConversationPendingDeletion(
          entry.conversationKey,
        )
      ) {
        return false;
      }
      if (main.mode === "paper") {
        return (
          entry.kind === "paper" &&
          paperID > 0 &&
          Number(deps.resolveHistoryEntryPaper(entry)?.id || 0) === paperID
        );
      }
      return (
        entry.kind === "global" &&
        (!entry.libraryID || entry.libraryID === main.libraryID)
      );
    });
  };

  /**
   * Shows the item's message in the main chat and flashes it. An item from
   * another chat first switches the main chat to that chat.
   */
  const goToChat = async (
    conversationKey: number,
    messageIndex: number,
  ): Promise<boolean> => {
    const flash = () => {
      flushPendingChatRender(mainBody.querySelector("#llm-chat-box"));
      return flashSourceMessage({
        container: mainBody,
        messageIndex,
        setTimeout: (callback, ms) => win.setTimeout(callback, ms),
      });
    };
    if (conversationKey === deps.getMainContext().conversationKey) {
      return Boolean(flash());
    }
    const entries = await deps.historyList.loadEntries();
    const entry = entries.find(
      (candidate) => candidate.conversationKey === conversationKey,
    );
    if (!entry || disposed) return false;
    if (!(await deps.openAsMainChat(entry))) return false;
    // The main chat draws the switched-to chat on its own time.
    for (let attempt = 0; attempt < 40 && !disposed; attempt++) {
      if (
        deps.getMainContext().conversationKey === conversationKey &&
        flash()
      ) {
        return true;
      }
      await new Promise((resolve) => win.setTimeout(resolve, 75));
    }
    return false;
  };

  // What the model made (diagrams, figures, pages, code, plan documents) in
  // every chat of the main chat's paper (or every library chat), newest
  // first, in the History list's row styles. A picked row turns this tab
  // into that item's tab.
  const buildMiscView = (id: string): MiscTabView => {
    const root = createElement(doc, "div", "llm-standalone-side-panel-misc");
    root.dataset.sideView = "misc";
    root.dataset.sideTabId = id;
    const { row, text } = createTitleRow(t("Made for this paper"));
    const count = createPill("", "kind");
    text.after(count);
    const list = createElement(
      doc,
      "div",
      "llm-standalone-search-results llm-standalone-side-panel-misc-list",
    );
    root.append(row, list);
    viewHost.appendChild(root);

    /** The other chats' items and the chats' titles, from the last reload. */
    let otherItems: ChatMadeItem[] = [];
    let chatsByKey = new Map<number, ConversationHistoryEntry>();
    let loading = false;
    let generation = 0;

    const redraw = () => {
      const main = deps.getMainContext();
      const paper = main.mode === "paper";
      text.textContent = paper
        ? t("Made for this paper")
        : t("Made in library chats");
      const mainItems: ChatMadeItem[] = collectMadeItems(mainBody).map(
        (made) => ({ ...made, conversationKey: main.conversationKey }),
      );
      const items = mergeChatMadeItems([
        mainItems,
        otherItems.filter(
          (made) => made.conversationKey !== main.conversationKey,
        ),
      ]);
      list.replaceChildren();
      count.textContent = String(items.length);
      count.hidden = !items.length;
      if (!items.length && !loading) {
        list.appendChild(
          createElement(doc, "div", "llm-standalone-search-empty", {
            textContent: paper
              ? t("Nothing made for this paper yet")
              : t("Nothing made in library chats yet"),
          }),
        );
        return;
      }
      for (const made of items) {
        const item = createElement(
          doc,
          "div",
          "llm-standalone-search-item",
        ) as HTMLDivElement;
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.dataset.madeKind = made.kind;
        item.dataset.madeConversationKey = `${made.conversationKey}`;
        const textWrap = createElement(
          doc,
          "div",
          "llm-standalone-search-text",
        );
        const label = createElement(
          doc,
          "span",
          "llm-standalone-search-label",
          {
            textContent: t(ITEM_KIND_LABELS[made.kind]),
          },
        );
        label.dataset.labelType = "item";
        label.dataset.itemKind = made.kind;
        const title = resolveItemTabTitle(made.request, t);
        textWrap.append(
          label,
          createElement(doc, "span", "llm-standalone-search-title", {
            textContent: title,
          }),
        );
        const goTo = createElement(
          doc,
          "span",
          "llm-standalone-side-panel-misc-go",
          { textContent: t("Go to chat") },
        ) as HTMLSpanElement;
        goTo.setAttribute("role", "button");
        goTo.setAttribute("tabindex", "0");
        goTo.title = t("Go to the chat it came from");
        const go = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          void goToChat(made.conversationKey, made.messageIndex);
        };
        goTo.addEventListener("click", go);
        goTo.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") go(event);
        });
        textWrap.appendChild(goTo);
        item.appendChild(textWrap);
        const isMain = made.conversationKey === main.conversationKey;
        const chatTitle =
          chatsByKey.get(made.conversationKey)?.title ||
          (isMain ? t("This chat") : t("Untitled chat"));
        const time = formatGlobalHistoryTimestamp(made.timestamp);
        const metaText = time ? `${chatTitle} · ${time}` : chatTitle;
        if (metaText) {
          const meta = createElement(
            doc,
            "div",
            "llm-standalone-search-meta llm-standalone-side-panel-misc-meta",
          );
          meta.appendChild(
            createElement(doc, "span", "llm-standalone-side-panel-misc-from", {
              textContent: metaText,
            }),
          );
          if (isMain) {
            meta.appendChild(
              createElement(
                doc,
                "span",
                "llm-standalone-side-panel-misc-here",
                {
                  textContent: t("open now"),
                },
              ),
            );
          }
          item.appendChild(meta);
        }
        item.title = `${t(ITEM_KIND_LABELS[made.kind])}: ${title} (${chatTitle})`;
        const pick = () =>
          void openItem(made.request, id, made.conversationKey);
        item.addEventListener("click", pick);
        item.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.target !== item) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick();
          }
        });
        list.appendChild(item);
      }
      if (loading) {
        list.appendChild(
          createElement(doc, "div", "llm-standalone-search-empty", {
            textContent: t("Looking through the other chats..."),
          }),
        );
      }
    };

    /** Reads the chat list again and scans the chats not read yet. */
    const reload = () => {
      const run = ++generation;
      loading = true;
      redraw();
      void (async () => {
        try {
          const chats = await loadWorkspaceChats();
          if (run !== generation || view.disposed) return;
          chatsByKey = new Map(
            chats.map((entry) => [entry.conversationKey, entry]),
          );
          const mainKey = deps.getMainContext().conversationKey;
          const others = chats.filter(
            (entry) => entry.conversationKey !== mainKey,
          );
          const collect = () =>
            others.flatMap(
              (entry) => madeItemScans.get(entry.conversationKey)?.items || [],
            );
          otherItems = collect();
          redraw();
          for (const entry of others) {
            const cached = madeItemScans.get(entry.conversationKey);
            if (cached && cached.stamp === (Number(entry.lastActivityAt) || 0))
              continue;
            try {
              await queueChatScan(entry);
            } catch (err) {
              appLogger.warn("LLM: Miscellaneous chat scan failed", err);
            }
            if (run !== generation || view.disposed) return;
            otherItems = collect();
            redraw();
          }
        } catch (err) {
          appLogger.warn("LLM: Miscellaneous chat list failed", err);
        }
        if (run !== generation || view.disposed) return;
        loading = false;
        redraw();
      })();
    };

    // The main chat's own items follow it: a debounced watch on its messages.
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        timer = null;
        if (!view.disposed) redraw();
      }, 150);
    };
    const MutationObserverCtor = (
      win as unknown as { MutationObserver?: typeof MutationObserver }
    ).MutationObserver;
    const observer = MutationObserverCtor
      ? new MutationObserverCtor(schedule)
      : null;
    observer?.observe(mainBody, { childList: true, subtree: true });

    const { tab, tabTitle } = createTab(
      id,
      "misc",
      t("Miscellaneous"),
      "llm-standalone-side-panel-icon-misc",
    );
    const view: MiscTabView = {
      kind: "misc",
      list,
      id,
      root,
      body: root,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      refresh: reload,
      stopWatching: () => {
        generation++;
        observer?.disconnect();
        if (timer !== null) win.clearTimeout(timer);
        timer = null;
      },
    };
    reload();
    return view;
  };
  const disposeMiscView = (view: MiscTabView) => {
    if (view.disposed) return;
    view.disposed = true;
    view.stopWatching();
    view.root.remove();
    view.tab.remove();
  };
  const openMiscTab = () => {
    const result = openMiscSidePanelTab(tabsState, nextTabId("misc"));
    if (result.refused) {
      reportTabLimit();
      return;
    }
    if (result.opened && result.tabId) {
      views.set(result.tabId, buildMiscView(result.tabId));
    } else if (result.tabId) {
      const view = views.get(result.tabId);
      if (view?.kind === "misc") view.refresh();
    }
    setTabsState(result.state);
  };
  // -- Task progress tab --------------------------------------------------------
  // The main chat's Task progress, docked: the chat's own card (row and
  // drawer), flat, with the drawer always open and filling the tab. It follows
  // the main chat's conversation; the run's state shows on the tab's icon.
  const buildTaskProgressView = (id: string): TaskProgressTabView => {
    const root = createElement(
      doc,
      "div",
      "llm-standalone-side-panel-task-progress",
    );
    root.dataset.sideView = "progress";
    root.dataset.sideTabId = id;
    const card = createTaskProgressCard(doc);
    card.classList.add("llm-task-progress-docked");
    const row = card.querySelector(".llm-task-progress") as HTMLButtonElement;
    const drawer = card.querySelector(
      ".llm-task-progress-drawer",
    ) as HTMLElement;
    // The ids belong to the main chat's own card.
    row.removeAttribute("id");
    row.removeAttribute("aria-controls");
    drawer.removeAttribute("id");
    row.tabIndex = -1;
    const back = createElement(
      doc,
      "button",
      "llm-task-progress-move llm-task-progress-back",
      { type: "button" },
    );
    setButtonLabel(back, t("Move back to chat"));
    back.addEventListener("click", () => moveTaskProgressToChat());
    card.insertBefore(back, row.nextSibling);
    card.dataset.movable = "true";
    root.appendChild(card);
    // The question list sizes its text as the chat does.
    applyPanelFontScale(root);
    // A passage to open, or a paper to remove, is the main chat's to handle.
    const forward = (event: Event) => {
      event.stopPropagation();
      const CustomEventCtor = (
        win as unknown as { CustomEvent: typeof CustomEvent }
      ).CustomEvent;
      mainBody.dispatchEvent(
        new CustomEventCtor(event.type, {
          bubbles: true,
          detail: (event as CustomEvent).detail,
        }),
      );
    };
    root.addEventListener(TASK_PROGRESS_OPEN_PASSAGE_EVENT, forward);
    root.addEventListener(TASK_PROGRESS_REMOVE_PAPER_EVENT, forward);
    // "Show in answer" and the offers to search further act on the chat.
    root.addEventListener(TASK_PROGRESS_SHOW_IN_ANSWER_EVENT, forward);
    root.addEventListener(TASK_PROGRESS_OFFER_EVENT, forward);
    // A source's page shows in this tab, in place of the list.
    const page = mountSourcePageView({
      doc,
      win,
      createTitleRow,
      createIconButton: (iconClass, label) =>
        createIconButton(doc, iconClass, label),
      copyText: (text) => copyTextToClipboard(mainBody, text),
      onClose: () => {
        card.hidden = false;
      },
    });
    root.appendChild(page.root);
    const openSource = (event: Event) => {
      event.stopPropagation();
      const detail = (event as CustomEvent<TaskProgressOpenSourceDetail>)
        .detail;
      if (!detail?.source) return;
      showSourcePage(view, {
        link: {
          url: detail.source.url,
          title: detail.source.title,
          organization: detail.source.organization,
          hostname: detail.source.hostname,
          faviconUrl: detail.source.faviconUrl,
          ...(detail.source.kind === "paper" ? { kind: "paper" as const } : {}),
        },
        source: detail.source,
        turn: detail.turn,
        ...(detail.phrases?.length ? { phrases: detail.phrases } : {}),
      });
    };
    root.addEventListener(TASK_PROGRESS_OPEN_SOURCE_EVENT, openSource);
    const progressView = mountTaskProgressView({
      doc,
      row,
      drawer,
      shell: root,
      chatBox: root,
      keyTarget: root,
      docked: true,
      deps: {
        setTimeout: (callback, ms) => win.setTimeout(callback, ms),
        clearTimeout: (handle) => win.clearTimeout(handle as number),
        now: () => win.performance?.now?.() ?? Date.now(),
        resolveMineru: resolveMineruHint,
      },
    });
    const { tab, tabTitle } = createTab(
      id,
      "progress",
      t("Task progress"),
      "llm-standalone-side-panel-icon-task-progress",
    );
    const icon = tab.querySelector(
      ".llm-standalone-side-panel-tab-icon",
    ) as HTMLElement | null;
    let conversationKey: number | null = null;
    const paintIcon = () => {
      if (!icon) return;
      const state = displayedTaskRunState(
        conversationKey ? getTaskProgress(conversationKey) : null,
      );
      if (icon.dataset.taskState !== state) icon.dataset.taskState = state;
    };
    const unsubscribe = subscribeTaskProgress((key) => {
      if (key === conversationKey) paintIcon();
    });
    const view: TaskProgressTabView = {
      kind: "progress",
      id,
      root,
      body: root,
      tab,
      tabTitle,
      confirm: null,
      disposed: false,
      view: progressView,
      page,
      setInput: (input) => {
        if (view.disposed) return;
        // Another chat: its own sources, so the page closes.
        if (input.conversationKey !== conversationKey && page.isShowing()) {
          page.reset();
          card.hidden = false;
        }
        conversationKey = input.conversationKey;
        progressView.setInput(input);
        paintIcon();
      },
      stopWatching: () => {
        unsubscribe();
        root.removeEventListener(TASK_PROGRESS_OPEN_PASSAGE_EVENT, forward);
        root.removeEventListener(TASK_PROGRESS_REMOVE_PAPER_EVENT, forward);
        root.removeEventListener(TASK_PROGRESS_SHOW_IN_ANSWER_EVENT, forward);
        root.removeEventListener(TASK_PROGRESS_OFFER_EVENT, forward);
        root.removeEventListener(TASK_PROGRESS_OPEN_SOURCE_EVENT, openSource);
      },
    };
    const input = getTaskProgressPanelInput(mainBody);
    if (input) view.setInput(input);
    viewHost.appendChild(root);
    return view;
  };
  const disposeTaskProgressView = (view: TaskProgressTabView) => {
    if (view.disposed) return;
    view.disposed = true;
    view.stopWatching();
    view.view.dispose();
    view.page.dispose();
    view.root.remove();
    view.tab.remove();
  };
  /** A source's page in the Task progress tab, in place of the list. */
  const showSourcePage = (
    view: TaskProgressTabView,
    entry: Parameters<SourcePageView["show"]>[0],
  ) => {
    const card = view.root.querySelector(
      ".llm-task-progress-card",
    ) as HTMLElement | null;
    if (card) card.hidden = true;
    view.page.show(entry);
  };
  /** The list again, in place of a page. */
  const showTaskProgressList = (view: TaskProgressTabView) => {
    if (!view.page.isShowing()) return;
    view.page.reset();
    const card = view.root.querySelector(
      ".llm-task-progress-card",
    ) as HTMLElement | null;
    if (card) card.hidden = false;
  };
  /** The →| button, the New tab row and the title bar button while docked. */
  const openTaskProgressTab = (): TaskProgressTabView | null => {
    if (disposed) return null;
    const result = openTaskProgressSidePanelTab(
      openSidePanel(tabsState),
      nextTabId("progress"),
    );
    if (result.refused) {
      reportTabLimit();
      return null;
    }
    if (result.opened && result.tabId) {
      views.set(result.tabId, buildTaskProgressView(result.tabId));
    }
    setTabsState(result.state);
    const view = result.tabId ? views.get(result.tabId) : null;
    // Shown now: the list takes the place the chat's card was left at.
    if (result.opened && view?.kind === "progress") view.view.resume();
    return view?.kind === "progress" ? view : null;
  };
  const taskProgressViews = () =>
    [...views.values()].filter(
      (view): view is TaskProgressTabView => view.kind === "progress",
    );
  // -- Sources from the chat ---------------------------------------------------
  // A marker in the chat shows its sources in the Task progress tab, under
  // its question; a link to a source opens its page there.
  const mainTaskProgress = () =>
    getTaskProgress(deps.getMainContext().conversationKey);
  const turnOfRun = (runId?: string): number => {
    const record = mainTaskProgress();
    if (!record) return 0;
    return (runId && record.turnByRunId[runId]) || record.turnIndex || 0;
  };
  const webHost: SidePanelWebHost = {
    showSources: (target: SidePanelSourceTarget) => {
      const view = openTaskProgressTab();
      if (!view) return;
      showTaskProgressList(view);
      view.view.flush();
      const turn = turnOfRun(target.runId);
      if (turn) view.view.reveal({ turn, keys: target.keys });
    },
    openPage: (link: WebSourceLink) => {
      const view = openTaskProgressTab();
      if (!view) return;
      const key = webSourceKey(link.url);
      const found = findTaskSource(
        mainTaskProgress(),
        (source) =>
          webSourceKey(source.url) === key ||
          (source.kind === "paper" && source.sourceId === link.url),
        turnOfRun(link.runId) || undefined,
      );
      showSourcePage(view, {
        link,
        ...(found ? { source: found.source, turn: found.turn } : {}),
      });
    },
    sourceState: (target) => {
      const turn = turnOfRun(target.runId);
      const key = target.keys[0];
      const found = findTaskSource(
        mainTaskProgress(),
        (source) => source.key === key,
        turn || undefined,
      );
      return found ? found.source.state : null;
    },
  };
  registerSidePanelWebHost(doc, webHost);
  /**
   * |← in the tab, or the title bar's Task progress button: the tab closes
   * and the row is back in the chat. The panel closes with it when it held
   * nothing else.
   */
  const moveTaskProgressToChat = () => {
    const tab = tabsState.tabs.find((entry) => entry.kind === "progress");
    if (!tab || disposed) return;
    if (tabsState.tabs.length === 1 && !tabsState.newTabOpen) {
      closePanelNow();
      return;
    }
    closeTabNow(tab.id);
  };
  /** The main chat's row hides while the tab is open, and comes back after. */
  let lastDocked = false;
  const syncTaskProgressDock = () => {
    const docked = !disposed && hasTaskProgressSidePanelTab(tabsState);
    if (docked === lastDocked) return;
    lastDocked = docked;
    syncTaskProgressPanel(mainBody);
  };
  const unregisterTaskProgressDock = registerTaskProgressDock(mainBody, {
    isDocked: () => !disposed && hasTaskProgressSidePanelTab(tabsState),
    open: openTaskProgressTab,
    close: moveTaskProgressToChat,
    onInput: (input) => {
      for (const view of taskProgressViews()) view.setInput(input);
    },
  });

  const itemHost: SidePanelItemHost = {
    open: (request) => void openItem(request),
  };
  registerSidePanelItemHost(doc, itemHost);

  // -- Closing a tab --------------------------------------------------------
  const createConfirmCard = (params: {
    className: string;
    message: string;
    actions: Array<{
      label: string;
      action: string;
      variant: "secondary" | "danger";
      disabled?: boolean;
      run: () => void;
    }>;
  }) => {
    const card = createElement(
      doc,
      "div",
      `llm-action-inline-card ${params.className}`,
    );
    card.setAttribute("role", "alertdialog");
    const content = createElement(doc, "div", "llm-agent-hitl-content");
    const message = createElement(doc, "div", "llm-agent-hitl-description", {
      textContent: params.message,
    });
    const actions = createElement(doc, "div", "llm-agent-hitl-actions");
    const buttons = params.actions.map((entry) => {
      const element = createElement(
        doc,
        "button",
        `llm-agent-hitl-btn llm-agent-hitl-btn-${entry.variant}`,
        { type: "button", textContent: entry.label },
      );
      element.dataset.confirmAction = entry.action;
      element.disabled = entry.disabled === true;
      element.addEventListener("click", () => entry.run());
      return element;
    });
    actions.append(...buttons);
    content.append(message, actions);
    card.appendChild(content);
    return { card, first: buttons[0] };
  };

  const showTabCloseConfirm = (view: SideChatTabView) => {
    if (view.confirm?.isConnected) return;
    const { card, first } = createConfirmCard({
      className: "llm-side-chat-close-confirm",
      message: t(
        "Close this side chat? It is not saved, so these messages will be gone.",
      ),
      actions: [
        {
          label: t("Keep it open"),
          action: "keep",
          variant: "secondary",
          run: () => hideTabConfirm(view),
        },
        {
          label: t("Send last answer to main chat"),
          action: "send-last",
          variant: "secondary",
          disabled: findLastFinishedAnswerText(sideChatMessages(view)) === null,
          run: () => {
            const text = findLastFinishedAnswerText(sideChatMessages(view));
            if (text) addTextToMainChat(text);
            closeTabNow(view.id);
          },
        },
        {
          label: t("Close and discard"),
          action: "discard",
          variant: "danger",
          run: () => closeTabNow(view.id),
        },
      ],
    });
    const inputSection = view.body.querySelector(
      ".llm-input-section",
    ) as HTMLElement | null;
    if (inputSection?.parentElement) {
      inputSection.parentElement.insertBefore(card, inputSection);
    } else {
      view.body.appendChild(card);
    }
    view.confirm = card;
    first?.focus();
  };

  const requestTabClose = (id: string) => {
    const view = views.get(id);
    if (!view) return;
    if (
      view.kind === "sidechat" &&
      resolveSidePanelCloseDecision({
        messageCount: sideChatMessages(view).length,
      }) === "confirm"
    ) {
      focusTab(id);
      showTabCloseConfirm(view);
      return;
    }
    closeTabNow(id);
  };

  const disposeView = (view: TabView) => {
    if (view.kind === "sidechat") disposeSideChatView(view);
    else if (view.kind === "history") disposeHistoryView(view);
    else if (view.kind === "item") disposeItemView(view);
    else if (view.kind === "misc") disposeMiscView(view);
    else if (view.kind === "progress") disposeTaskProgressView(view);
    else disposeReadOnlyView(view);
  };

  const closeTabNow = (id: string) => {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    disposeView(view);
    setTabsState(closeSidePanelTab(tabsState, id));
  };

  const focusTab = (id: string) => {
    setTabsState(focusSidePanelTab(tabsState, id));
  };

  // -- Closing the panel ------------------------------------------------------
  const hidePanelConfirm = () => {
    panelConfirm?.remove();
    panelConfirm = null;
  };

  const showPanelCloseConfirm = (count: number) => {
    hidePanelConfirm();
    const message =
      count === 1
        ? t(
            "Close the side panel? 1 side chat is not saved, so its messages will be gone.",
          )
        : t(
            "Close the side panel? {count} side chats are not saved, so their messages will be gone.",
          ).replace("{count}", `${count}`);
    const { card, first } = createConfirmCard({
      className: "llm-side-panel-close-confirm",
      message,
      actions: [
        {
          label: t("Keep it open"),
          action: "panel-keep",
          variant: "secondary",
          run: () => hidePanelConfirm(),
        },
        {
          label: t("Close and discard"),
          action: "panel-discard",
          variant: "danger",
          run: () => closePanelNow(),
        },
      ],
    });
    column.insertBefore(card, viewHost);
    panelConfirm = card;
    first?.focus();
  };

  const requestPanelClose = () => {
    const unsaved = sideChatViews().filter(
      (view) =>
        resolveSidePanelCloseDecision({
          messageCount: sideChatMessages(view).length,
        }) === "confirm",
    ).length;
    if (unsaved > 0) {
      showPanelCloseConfirm(unsaved);
      return;
    }
    closePanelNow();
  };

  const disposeAllViews = () => {
    for (const view of [...views.values()]) disposeView(view);
    views.clear();
    destroyNewTabPage();
    hidePanelConfirm();
  };

  /** Closes the panel; its tabs are dropped once the close slide ends. */
  const closePanelNow = () => {
    hidePanelConfirm();
    setTabsState(closeSidePanel());
  };

  // -- Rendering ------------------------------------------------------------
  /** The close slide runs: the panel still shows what it showed. */
  let closing = false;
  const renderToggle = () => {
    const open = isOpen();
    toggleButton.setAttribute("aria-expanded", open ? "true" : "false");
    setButtonLabel(
      toggleButton,
      open ? t("Close side panel") : t("Open side panel"),
    );
  };
  const render = () => {
    renderToggle();
    if (closing) return;
    const open = isOpen();
    column.hidden = !open;
    if (open) syncChromeGap();
    splitter.hidden = !open;
    lowerArea.classList.toggle("llm-standalone-side-panel-open", open);
    const activeView = tabsState.activeId
      ? views.get(tabsState.activeId) || null
      : null;
    column.dataset.sideView = !open
      ? "closed"
      : activeView
        ? activeView.kind
        : "newtab";
    // The strip lists the tabs in order; the "+" button follows it.
    const tabs = tabsState.tabs
      .map((tab) => views.get(tab.id))
      .filter((view): view is TabView => Boolean(view));
    for (const [index, view] of tabs.entries()) {
      if (strip.children[index] !== view.tab) {
        strip.insertBefore(view.tab, strip.children[index] || null);
      }
      const active = view === activeView;
      view.tab.classList.toggle("active", active);
      view.tab.setAttribute("aria-selected", active ? "true" : "false");
      view.root.hidden = !active;
    }
    // The New tab tab, when open, is the last one; it is the shown tab
    // whenever no other tab is.
    if (tabsState.newTabOpen) {
      if (strip.children[tabs.length] !== newTabTab) {
        strip.insertBefore(newTabTab, strip.children[tabs.length] || null);
      }
      newTabTab.classList.toggle("active", !activeView);
      newTabTab.setAttribute("aria-selected", !activeView ? "true" : "false");
    } else {
      newTabTab.remove();
    }
    strip.hidden = !open;
    newTabButton.hidden = !open;
    const full = !canOpenSidePanelTab(tabsState);
    if (open && !activeView) {
      const page = ensureNewTabPage();
      page.root.hidden = false;
      if (page.sideChatRow) page.sideChatRow.disabled = full;
      page.historyRow.disabled =
        full && !tabsState.tabs.some((tab) => tab.kind === "history");
      page.miscRow.disabled =
        full && !tabsState.tabs.some((tab) => tab.kind === "misc");
      page.progressRow.disabled =
        full && !tabsState.tabs.some((tab) => tab.kind === "progress");
      scheduleNewTabAlign();
    } else if (newTabPage) {
      newTabPage.root.hidden = true;
    }
    if (activeView) revealActiveTab(activeView);
    else if (open) {
      const run = () =>
        newTabTab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(run);
      } else {
        run();
      }
    }
  };

  /** Opening: the window grows and uncovers the panel. */
  const slideOpen = () => {
    const fromMainWidth = mainColumnWidth();
    const toOuterWidth = planWindowWidthForPanel(
      resize.getPreferredWidth() + STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX,
    );
    resize.relayout();
    render();
    const panelWidth = readPixelVariable(lowerArea, SIDE_PANEL_WIDTH_VARIABLE);
    const gained = toOuterWidth - outerWidthNow();
    runSlide({
      toOuterWidth,
      fromMainWidth,
      // What the screen cannot give, the main column gives.
      toMainWidth: Math.max(
        0,
        fromMainWidth - Math.max(0, panelLayoutWidth() - gained),
      ),
      panelWidth,
      onDone: () => deps.onLayoutChanged(),
    });
  };

  /**
   * Closing: the window shrinks back (or the main column grows, if the user
   * kept the width) over the panel, which keeps its content until the end.
   */
  const slideClose = (
    closingViews: TabView[] = [...views.values()],
    afterClose?: () => void,
  ) => {
    const fromMainWidth = mainColumnWidth();
    const panelWidth = readPixelVariable(lowerArea, SIDE_PANEL_WIDTH_VARIABLE);
    const occupied = panelLayoutWidth();
    const fromOuterWidth = pendingOuterWidth ?? outerWidthNow();
    const toOuterWidth = planGiveBackWindowWidth();
    const givenBack = Math.max(0, fromOuterWidth - toOuterWidth);
    closing = true;
    runSlide({
      toOuterWidth,
      fromMainWidth,
      toMainWidth: fromMainWidth + Math.max(0, occupied - givenBack),
      panelWidth,
      onDone: () => {
        closing = false;
        for (const view of closingViews) {
          if (views.get(view.id) === view) views.delete(view.id);
          disposeView(view);
        }
        afterClose?.();
        if (!isOpen()) {
          destroyNewTabPage();
          hidePanelConfirm();
        }
        render();
        deps.onLayoutChanged();
      },
    });
  };

  const setTabsState = (next: SidePanelTabsState) => {
    applyTabsState(next);
    syncTaskProgressDock();
  };
  const applyTabsState = (next: SidePanelTabsState) => {
    if (disposed) return;
    const wasOpen = isOpen();
    const wasActiveId = wasOpen ? tabsState.activeId : undefined;
    // A slide still running ends at once before the next one starts.
    if (next.open !== wasOpen) finishSlide();
    tabsState = next;
    if (isOpen() && !wasOpen) {
      slideOpen();
    } else if (!isOpen() && wasOpen) {
      slideClose();
      renderToggle();
      deps.onLayoutChanged();
      return;
    }
    render();
    // The History tab's list reloads each time it comes into view.
    if (isOpen() && tabsState.activeId !== wasActiveId) {
      historyView(tabsState.activeId)?.list.refresh();
    }
    if (isOpen() !== wasOpen) deps.onLayoutChanged();
  };

  toggleButton.addEventListener("click", () => {
    if (isOpen()) requestPanelClose();
    else if (!restoreStashedWorkspace()) setTabsState(openSidePanel(tabsState));
  });
  closeButton.addEventListener("click", () => requestPanelClose());
  newTabButton.addEventListener("click", () =>
    setTabsState(showSidePanelNewTabPage(tabsState)),
  );

  // -- One set of tabs per paper ------------------------------------------
  // The panel shows the tabs of the main chat's paper (or library). Moving
  // the main chat elsewhere puts them away, hidden but alive (a side chat
  // keeps answering), when that paper's tabs are kept; otherwise they are
  // dropped. Coming back shows them as they were. Whether the panel is open
  // is the user's alone: moving the main chat never opens or closes it.
  type StashedWorkspace = {
    state: SidePanelTabsState;
    views: TabView[];
  };
  const stashedWorkspaces = new Map<string, StashedWorkspace>();
  let workspaceKey: string | null = null;
  const resolveCurrentWorkspaceKey = () => {
    const main = deps.getMainContext();
    return resolveSidePanelWorkspaceKey({
      mode: main.mode,
      basePaperItemID: Number(main.basePaperItem?.id || 0),
      libraryID: main.libraryID,
    });
  };
  const putAwayView = (view: TabView) => {
    hideTabConfirm(view);
    view.root.hidden = true;
    view.tab.remove();
  };
  const switchWorkspace = (nextKey: string) => {
    const previousKey = workspaceKey;
    workspaceKey = nextKey;
    if (previousKey === null || previousKey === nextKey) return;
    // A close slide still running drops its tabs first.
    finishSlide();
    hidePanelConfirm();
    const leavingState = tabsState;
    const leavingViews = [...views.values()];
    const open = leavingState.open;
    const keep = open && deps.shouldKeepWorkspace(previousKey);
    // A shut panel stays shut: the paper's tabs wait for it to open.
    const incoming = open ? stashedWorkspaces.get(nextKey) : undefined;
    if (incoming) stashedWorkspaces.delete(nextKey);
    views.clear();
    for (const view of incoming?.views || []) views.set(view.id, view);
    for (const view of leavingViews) putAwayView(view);
    if (keep) {
      // Tabs still waiting from before the panel was shut here give way.
      dropWorkspace(previousKey);
      stashedWorkspaces.set(previousKey, {
        state: leavingState,
        views: leavingViews,
      });
    } else {
      for (const view of leavingViews) disposeView(view);
    }
    let nextState = incoming?.state || CLOSED_SIDE_PANEL_TABS;
    let progress: TaskProgressTabView | null = null;
    if (open && !incoming) {
      // An open panel stays open on a chat with no tabs yet: the New tab
      // page, or its own Task progress when Task progress was open.
      nextState = openSidePanel(CLOSED_SIDE_PANEL_TABS);
      if (leavingState.tabs.some((tab) => tab.kind === "progress")) {
        const result = openTaskProgressSidePanelTab(
          nextState,
          nextTabId("progress"),
        );
        if (result.tabId) {
          progress = buildTaskProgressView(result.tabId);
          views.set(result.tabId, progress);
          nextState = result.state;
        }
      }
    }
    tabsState = nextState;
    render();
    progress?.view.resume();
  };
  /**
   * The toggle on a shut panel: a paper's tabs put away while the panel
   * was open elsewhere come back as they were. False when there are none.
   */
  const restoreStashedWorkspace = (): boolean => {
    const stashed = workspaceKey ? stashedWorkspaces.get(workspaceKey) : null;
    if (!stashed || disposed) return false;
    finishSlide();
    stashedWorkspaces.delete(workspaceKey!);
    for (const view of stashed.views) views.set(view.id, view);
    setTabsState(stashed.state);
    return true;
  };
  const dropWorkspace = (key: string) => {
    const stashed = stashedWorkspaces.get(key);
    if (!stashed) return;
    stashedWorkspaces.delete(key);
    for (const view of stashed.views) disposeView(view);
  };

  // -- Main-chat registrations ---------------------------------------------
  const slashSideChat = () =>
    sideChatView(
      resolveSlashSideChatTab(tabsState, (id) =>
        hasFinishedAnswer(sideChatMessages(sideChatView(id))),
      ),
    );
  const applyMainExtensions = () => {
    // A read-only panel offers the main chat no way into a side chat.
    if (deps.readOnly) return;
    updateChatPanelExtensions(mainBody, {
      extraAssistantActions: [
        {
          id: "ask-side",
          label: t("Ask in side chat"),
          run: (info) => askInSideChat(info.contentText),
        },
      ],
      sideChatQuote: {
        quote: (text, question) => askInSideChat(text, question),
      },
      sideChatSlashItem: {
        getState: () => {
          const view = slashSideChat();
          return view
            ? {
                available: true,
                title: resolveSideChatTabTitle(
                  sideChatMessages(view),
                  t("Side chat"),
                ),
              }
            : { available: false };
        },
        attach: () => {
          const text = buildSideChatTranscriptContext(
            sideChatMessages(slashSideChat()),
          );
          if (!text) return;
          mainHandle()?.addTextContext(text, {
            source: "sidechat",
            focusInput: true,
          });
        },
      },
    });
  };
  applyMainExtensions();
  render();

  return {
    toggleButton,
    column,
    splitter,
    isOpen,
    getOccupiedWidth,
    getPendingWindowWidthChange,
    relayout: () => {
      resize.relayout();
      if (isOpen()) syncChromeGap();
    },
    onMainMounted: () => {
      if (disposed) return;
      switchWorkspace(resolveCurrentWorkspaceKey());
      syncTaskProgressDock();
      applyMainExtensions();
      for (const view of sideChatViews()) followMainContext(view);
      if (isOpen()) historyView(tabsState.activeId)?.list.refresh();
      for (const view of views.values()) {
        if (view.kind === "misc") view.refresh();
      }
      // A paper's tabs coming back follow the chat shown now.
      const progressInput = getTaskProgressPanelInput(mainBody);
      if (progressInput) {
        for (const view of taskProgressViews()) view.setInput(progressInput);
      }
    },
    openItem: (request) => void openItem(request),
    dropWorkspace,
    onConversationDeletionChanged: () => {
      if (disposed) return;
      const deleting = (key: number) =>
        pendingDeletionStore.isConversationPendingDeletion(key);
      for (const view of [...views.values()]) {
        if (view.kind === "item" && deleting(view.conversationKey)) {
          closeTabNow(view.id);
        }
      }
      for (const stashed of stashedWorkspaces.values()) {
        for (const view of [...stashed.views]) {
          if (view.kind !== "item" || !deleting(view.conversationKey)) continue;
          stashed.state = closeSidePanelTab(stashed.state, view.id);
          stashed.views = stashed.views.filter((other) => other !== view);
          disposeView(view);
        }
      }
      for (const view of views.values()) {
        if (view.kind === "misc") view.refresh();
      }
    },
    dispose: () => {
      if (disposed) return;
      if (slide?.frameId != null) win.cancelAnimationFrame?.(slide.frameId);
      slide = null;
      closing = false;
      disposeAllViews();
      for (const key of [...stashedWorkspaces.keys()]) dropWorkspace(key);
      disposed = true;
      unregisterTaskProgressDock();
      unregisterSidePanelItemHost(doc, itemHost);
      unregisterSidePanelWebHost(doc, webHost);
      scanHost?.remove();
      madeItemScans.clear();
      resize.dispose();
      themeObserver?.disconnect();
      mainStartPageObserver?.disconnect();
      alignObserver?.disconnect();
      if (alignFrame !== null) win.cancelAnimationFrame?.(alignFrame);
      win.removeEventListener("resize", onWindowResize);
      win.removeEventListener("resize", onWindowResizeSettle);
      if (pendingTimer !== null) win.clearTimeout(pendingTimer);
      updateChatPanelExtensions(mainBody, {
        extraAssistantActions: undefined,
        sideChatSlashItem: undefined,
        sideChatQuote: undefined,
      });
      // A torn-off window's panel never started the side chats' choices.
      if (!deps.readOnly) resetSideSurfaceChoices();
    },
  };
}
