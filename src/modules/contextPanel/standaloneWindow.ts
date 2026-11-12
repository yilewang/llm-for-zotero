import {
  buildDefaultUpstreamGlobalConversationKey,
  config,
  GLOBAL_CONVERSATION_KEY_BASE,
} from "./constants";
import { appLogger } from "../../core/logging";
import { isConversationKeyForKind } from "../../shared/conversationKeySpace";
import {
  activeContextPanels,
  unregisterContextPanel,
  activeContextPanelRawItems,
  activeGlobalConversationByLibrary,
  clearSelectedReasoningForSurface,
  selectedRuntimeModeCache,
} from "./state";
import {
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolveInitialPanelItemState,
  resolveRememberedGlobalPanelItem,
  resolveConversationBaseItem,
  resolvePaperChatSourceItem,
  resolveActiveNoteSession,
  resolvePreferredConversationSystem,
  resolveNoteFocusSystemSwitch,
  resolveShortcutMode,
  createGlobalPortalItem,
  createPaperPortalItem,
} from "./portalScope";
import { isGlobalPortalItem } from "../../services/context/portalItems";
import { resolveActiveLibraryID } from "../../utils/zoteroLibraryScope";
import {
  applyPanelFontScale,
  getClaudeCodeModeEnabled,
  getLastUsedUpstreamGlobalConversationKey,
  getStandaloneSidebarWidthPref,
  getStandalonePinnedPapersPref,
  getStandaloneSidebarCollapsedGroupsPref,
  getStandaloneSidebarGroupOrderPref,
  getStandaloneSidebarSectionOptionsPref,
  getStandaloneSidebarPinnedCollapsedPref,
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
  setStandaloneSidebarWidthPref,
  setStandalonePinnedPapersPref,
  setStandaloneSidebarCollapsedGroupsPref,
  setStandaloneSidebarGroupOrderPref,
  setStandaloneSidebarSectionOptionsPref,
  setStandaloneSidebarPinnedCollapsedPref,
} from "./prefHelpers";
import {
  clearStandaloneSelection,
  clearTornSelection,
  isTornSurface,
  recall,
  recallMode,
  remember,
  rememberMode,
  type WindowSurface,
} from "./conversationSelection";
import {
  clearTornSurfaceChoices,
  startStandaloneSurfaceChoicesFromSidebar,
  startTornSurfaceChoices,
  demoteConversationSystemOnEverySurface,
  surfaceChoices,
} from "./surfaceChoices";
import {
  allocateTornSurface,
  findTornWindowForConversation,
  registerTornChatWindow,
  setTornWindowConversation,
  type TornChatIdentity,
} from "./tornChatWindows";
import {
  TEAR_OFF_MIME,
  classifyTearOffDragEnd,
  decodeTornChatIdentity,
  encodeTornChatIdentity,
  isUsableDragPoint,
  tearOffDropPoint,
  type ScreenPoint,
  type ScreenRect,
} from "./tearOffDrag";
import { mountPanelShell } from "./panelMount";
import {
  createHistoryActivityIndicator,
  observeHistoryActivity,
} from "./historyActivity";
import {
  disposeSetupHandlers,
  type ContextPreviewRenderMetrics,
  type SetupHandlersHooks,
} from "./setupHandlers";
import {
  ensureConversationLoaded,
  getConversationKey,
  refreshChat,
  resetSessionTokens,
} from "./chat";
import { renderShortcuts } from "./shortcuts";
import { bindTaskProgressToggle } from "./taskProgress/panel";
import { createTaskProgressToggleButton } from "./taskProgress/toggleButton";
import { HTML_NS } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import {
  bindStandalonePanelHost,
  clearPanelHostBinding,
} from "./panelHostOwnership";
import { getPanelHandle } from "./panelHandle";
import type { ConversationSystem } from "../../shared/types";
import type { ChatRuntimeMode } from "./types";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../../core/conversations/repository";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";
import {
  chatHistory,
  isAnyRequestPending,
  isRequestPending,
  loadedConversationKeys,
  subscribeRequestActivity,
  webChatIsolatedConversationKeys,
  webChatSessionConversationKeys,
} from "./state";
import { loadAllConversationHistory } from "./historyLoader";
import {
  isUnifiedHistoryRowListed,
  listUnifiedHistoryEntries,
  resolveUnifiedHistorySystems,
} from "./unifiedHistorySource";
import {
  formatGlobalHistoryTimestamp,
  getHistoryRowRuntimeLabel,
  isOrphanHistoryEntry,
  maybeSelectPaperHistoryTarget,
  normalizeConversationTitleSeed,
  normalizeHistoryPaperItemID,
  normalizeHistoryTitle,
  resolvePaperHistoryNavigationDecision,
  resolveHistoryEntryPaperBaseItem,
  resolveHistoryEntrySourceState,
  type ConversationHistoryEntry,
  type HistoryPaperPaneSelector,
} from "./setupHandlers/controllers/conversationHistoryController";
import {
  createHistorySearchDocument,
  createHistorySearchDocumentFingerprint,
  type HistorySearchDocument,
} from "./setupHandlers/controllers/historySearchController";
import { createHistorySearchPopupController } from "./setupHandlers/controllers/historySearchPopupController";
import { primeHistoryNavigationMode } from "./historyNavigationModeSync";
import { resolveStandalonePaperTabLabel } from "./standaloneTabLabel";
import { resolveFreshConversationDraft } from "./freshConversationDraft";
import { decidePanelIdentityAdoption } from "./standaloneConversationSwitch";
import { collapseDuplicateReusableConversationDrafts } from "./standaloneConversationResolution";
import {
  createRuntimeSystemControls,
  RUNTIME_CONVERSATION_SYSTEMS,
  resolveRuntimeSystemToggleTarget,
  syncRuntimeSystemControls,
} from "./runtimeSystemControls";
import { buildDefaultClaudeGlobalConversationKey } from "../../claudeCode/constants";
import {
  resolveRememberedClaudeConversationKey,
  invalidateAllClaudeHotRuntimes,
  refreshClaudeSlashCommands,
} from "../../claudeCode/runtime";
import { releaseClaudeRuntimeForBody } from "../../claudeCode/runtimeRetention";
import {
  createClaudeProjectSkillTemplate,
  deleteClaudeProjectSkillFile,
  getClaudeProjectDir,
  listClaudeProjectSkillEntries,
} from "../../claudeCode/projectSkills";
import { initAgentSubsystem } from "../../agent";
import {
  getConversationSystemPref,
  getStoredConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
} from "../../claudeCode/prefs";
import { showStandaloneConfirmationDialog } from "./standaloneConfirmationDialog";
import { showConversationRenameDialog } from "./conversationRenameDialog";
import {
  isConversationRenameEligible,
  type ConversationRenameIdentity,
} from "./conversationRenameEligibility";
import {
  installStandaloneColumnResizeBehavior,
  installStandaloneVerticalResizeBehavior,
  scheduleStandaloneWindowFitForElement,
  STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX,
  STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX,
} from "./standaloneWindowSizing";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../claudeCode/portal";
import { loadAllClaudeConversationHistory } from "../../claudeCode/historyLoader";
import { buildDefaultCodexGlobalConversationKey } from "../../codexAppServer/constants";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
} from "../../codexAppServer/portal";
import { isCodexAppServerModeEnabled } from "../../codexAppServer/prefs";
import { loadAllCodexConversationHistory } from "../../codexAppServer/historyLoader";
import { clearActiveConversationForPendingDeletion } from "./conversationDeletionActivation";
import {
  createSerializedConversationDeletionEventQueue,
  resolveConversationDeletionSurfaceAction,
} from "./conversationDeletionSurfaceSync";
import { forgetRecentlyDeletedConversation } from "../../core/conversations/recentlyDeletedConversations";
import {
  commitConversationRename,
  markCommittedConversationDeletionTombstone,
  queueWitnessedConversationDeletion,
  shouldSeedConversationCatalogEntry,
} from "./conversationLifecycle";
import {
  pendingDeletionStore,
  type PendingConversationDeletionEntry,
  type PendingDeletionEvent,
} from "../../core/conversations/pendingDeletionStore";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { setStatus } from "./textUtils";
import { getRegisteredConversationScope } from "../../shared/conversationRegistry";
import {
  createStandaloneSidebarView,
  setStandaloneFollowerChromeHost,
  setStandaloneSidebarCollapsedChromeHost,
  setStandaloneSidebarFlyoutOpen,
  setStandaloneSidebarState,
} from "./standaloneSidebarView";
import { installStandaloneSidebarFlyout } from "./standaloneSidebarFlyout";
import {
  formatStandaloneSidebarShortDate,
  getStandaloneSidebarEntryTime,
  getStandaloneSidebarGroupLabel,
  getStandaloneSidebarSectionOptions,
  groupStandaloneSidebarEntries,
  moveStandaloneSidebarGroup,
  sortStandaloneSidebarEntries,
  type StandaloneSidebarGroupKey,
  type StandaloneSidebarSortOrder,
} from "./standaloneSidebarSort";
import { installStandaloneSidebarGroupDrag } from "./standaloneSidebarGroupDrag";
import { releaseInlineEdit } from "./inlineEditState";
import { pluginStylesheetHref } from "../../utils/pluginReload";
import { createPluginUpdateController } from "../pluginUpdate";
import { getPluginUpdateDeps } from "../pluginUpdateAdapters";
import { createStandaloneUpdateControl } from "./standaloneUpdateControl";
import { registerSidePanelItemHost } from "./sidePanelItems";
import { resolveSidePanelWorkspacePaperID } from "./standaloneSidePanelState";
import {
  resolvePinnedPaperDot,
  togglePinnedPaper,
  updateReadyPinnedPapers,
} from "./standalonePinnedPapers";
import {
  createZoteroNavigationHost,
  navigateToLibraryObject,
} from "./agentTrace/actionCardNavigation";
import { formatPaperCreatorYearLabel } from "./setupHandlers/controllers/composeContextController";
import { resolvePaperContextRefFromItem } from "../../services/paperContent/paperAttribution";
import {
  createStandaloneSidePanel,
  type StandaloneSidePanelController,
} from "./standaloneSidePanel";

type StandaloneSessionState = {
  pending: boolean;
  window: Window | null;
};

const standaloneSessionState: StandaloneSessionState = {
  pending: false,
  window: null,
};

const STANDALONE_MIN_WIDTH_PX = 500;
const STANDALONE_MIN_HEIGHT_PX = 500;
const STANDALONE_SIDEBAR_AUTO_COLLAPSE_THRESHOLD_PX =
  STANDALONE_MIN_WIDTH_PX + STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX;
const STANDALONE_SIDEBAR_AUTO_EXPAND_THRESHOLD_PX = 600;
const STANDALONE_WINDOW_FEATURES =
  "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen,dialog=no,dependent=no";
// A torn-off window (a follower) holds one chat and has no conversation
// list, so it opens narrow, and keeps a minimum of its own below the
// standalone window's.
const TORN_WINDOW_WIDTH_PX = 420;
const TORN_WINDOW_HEIGHT_PX = 760;
const TORN_WINDOW_MIN_WIDTH_PX = 360;
// Where the pointer holds the tear-off drag image, from its top-left corner.
const TEAR_OFF_DRAG_IMAGE_GRAB_PX = 14;
const TORN_WINDOW_MIN_HEIGHT_PX = 480;

function buildTornWindowFeatures(placement?: {
  screenX: number;
  screenY: number;
}): string {
  const features = STANDALONE_WINDOW_FEATURES.split(",").filter(
    (feature) => feature !== "centerscreen",
  );
  features.push(
    `width=${TORN_WINDOW_WIDTH_PX}`,
    `height=${TORN_WINDOW_HEIGHT_PX}`,
  );
  if (
    placement &&
    Number.isFinite(placement.screenX) &&
    Number.isFinite(placement.screenY)
  ) {
    features.push(
      `screenX=${Math.round(placement.screenX)}`,
      `screenY=${Math.round(placement.screenY)}`,
    );
  }
  return features.join(",");
}

function isFiniteRect(rect: ScreenRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * The available area of the screen at (x, y); the source window's screen
 * when the screen manager is missing or fails.
 */
function readDropScreen(x: number, y: number, sourceWin: Window): ScreenRect {
  try {
    const screen = (globalThis as any).Services?.screenManager?.screenForRect?.(
      x,
      y,
      1,
      1,
    );
    if (screen) {
      const left = { value: 0 };
      const top = { value: 0 };
      const width = { value: 0 };
      const height = { value: 0 };
      screen.GetAvailRectDisplayPix(left, top, width, height);
      const rect = {
        left: Number(left.value),
        top: Number(top.value),
        width: Number(width.value),
        height: Number(height.value),
      };
      if (isFiniteRect(rect)) return rect;
    }
  } catch {
    // Fall back to the source window's screen.
  }
  try {
    const screen = sourceWin.screen as Screen & {
      availLeft?: number;
      availTop?: number;
    };
    const rect = {
      left: Number(screen.availLeft || 0),
      top: Number(screen.availTop || 0),
      width: Number(screen.availWidth),
      height: Number(screen.availHeight),
    };
    if (isFiniteRect(rect)) return rect;
  } catch {
    // Use the window's own size below.
  }
  return {
    left: 0,
    top: 0,
    width: TORN_WINDOW_WIDTH_PX,
    height: TORN_WINDOW_HEIGHT_PX,
  };
}

/**
 * The paper's short name: "Creator, Year", as the composer's paper chip
 * shows it, or its title when it has no creator.
 */
function resolvePaperShortLabel(paper: Zotero.Item): string {
  const ref = resolvePaperContextRefFromItem(paper);
  const label = ref ? formatPaperCreatorYearLabel(ref) : "";
  if (label && label !== "Paper") return label;
  try {
    return String(paper.getField("title") || "").trim() || t("Paper");
  } catch {
    return t("Paper");
  }
}

/**
 * A follower window's title for the chat it holds: the chat's own title from
 * its catalog entry, in a paper chat and a library chat alike ("Paper chat"
 * or "Library chat" while it has none).
 */
export async function getFollowerTitle(
  identity: TornChatIdentity,
): Promise<string> {
  const fallback =
    identity.kind === "paper" ? t("Paper chat") : t("Library chat");
  try {
    const entry = await conversationRepository.getCatalogEntry({
      system: identity.system,
      conversationKey: identity.conversationKey,
      kind: identity.kind === "paper" ? "paper" : "global",
    });
    return normalizeHistoryTitle(entry?.title || "") || fallback;
  } catch (err) {
    appLogger.warn("LLM: follower title lookup failed", err);
    return fallback;
  }
}

const UNLINKED_CARD_ID = "llmforzotero-unlinked-card";
const UNLINKED_CARD_SHOW_DELAY_MS = 250;
const UNLINKED_CARD_HIDE_GRACE_MS = 150;

/**
 * A follower's unlinked icon explains itself in a small hover card: it opens
 * after a short hover or on keyboard focus, sits under the icon inside the
 * window, and closes on leave (with a grace so the pointer can reach the
 * card), blur, Escape or when the window loses focus. One card per window.
 */
function bindUnlinkedHoverCard(
  doc: Document,
  root: HTMLElement,
  icon: HTMLElement,
): void {
  const win = doc.defaultView;
  if (!win) return;
  const card = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  card.id = UNLINKED_CARD_ID;
  card.className = "llm-unlinked-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  const heading = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  heading.className = "llm-unlinked-card-title";
  heading.textContent = t("Not linked to the PDF reader");
  const body = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  body.className = "llm-unlinked-card-body";
  body.textContent = t(
    "This chat keeps its own context. Switching PDF tabs in Zotero does not change it.",
  );
  card.append(heading, body);
  root.append(card);

  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  const clearTimers = () => {
    if (showTimer !== undefined) win.clearTimeout(showTimer);
    if (hideTimer !== undefined) win.clearTimeout(hideTimer);
    showTimer = hideTimer = undefined;
  };
  const hide = () => {
    clearTimers();
    card.hidden = true;
  };
  const show = () => {
    clearTimers();
    card.hidden = false;
    const margin = 8;
    const iconRect = icon.getBoundingClientRect();
    const width = card.offsetWidth;
    const left = Math.max(
      margin,
      Math.min(iconRect.left, win.innerWidth - width - margin),
    );
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(iconRect.bottom + 6)}px`;
  };
  const scheduleShow = (delay: number) => {
    if (hideTimer !== undefined) win.clearTimeout(hideTimer);
    hideTimer = undefined;
    if (!card.hidden || showTimer !== undefined) return;
    showTimer = win.setTimeout(show, delay);
  };
  const scheduleHide = () => {
    if (showTimer !== undefined) win.clearTimeout(showTimer);
    showTimer = undefined;
    if (card.hidden || hideTimer !== undefined) return;
    hideTimer = win.setTimeout(hide, UNLINKED_CARD_HIDE_GRACE_MS);
  };
  const keepOpen = () => {
    if (hideTimer !== undefined) win.clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  icon.addEventListener("mouseenter", () =>
    scheduleShow(UNLINKED_CARD_SHOW_DELAY_MS),
  );
  icon.addEventListener("mouseleave", scheduleHide);
  card.addEventListener("mouseenter", keepOpen);
  card.addEventListener("mouseleave", scheduleHide);
  icon.addEventListener("focus", show);
  icon.addEventListener("blur", hide);
  doc.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && !card.hidden) hide();
  });
  win.addEventListener("blur", hide);
}

/**
 * A follower's kind line: "Paper chat · <short label>" with the paper's full
 * title as its tooltip, or "Library chat · <library name>".
 */
export function getFollowerKindLine(
  identity: Pick<TornChatIdentity, "kind" | "libraryID" | "paperItemID">,
): { kind: "paper" | "library"; text: string; tooltip: string } {
  if (identity.kind === "paper") {
    const paper = Zotero.Items.get(
      Math.floor(Number(identity.paperItemID || 0)),
    ) as Zotero.Item | false;
    if (paper) {
      let fullTitle = "";
      try {
        fullTitle = String(paper.getField("title") || "");
      } catch {
        fullTitle = "";
      }
      return {
        kind: "paper",
        text: `${t("Paper chat")} \u00B7 ${resolvePaperShortLabel(paper)}`,
        tooltip: fullTitle,
      };
    }
    return { kind: "paper", text: t("Paper chat"), tooltip: "" };
  }
  let libraryName = "";
  try {
    libraryName = String(Zotero.Libraries.getName(identity.libraryID) || "");
  } catch {
    libraryName = "";
  }
  return {
    kind: "library",
    text: libraryName
      ? `${t("Library chat")} \u00B7 ${libraryName}`
      : t("Library chat"),
    tooltip: "",
  };
}

// A chat window remembers its library chat in its own selection slot only
// (the standalone window's, or a torn-off window's). The sidebar panels keep
// theirs, and the persisted pointers stay the sidebar's (see
// conversationSelection.ts).
function rememberStandaloneGlobalConversation(
  system: ConversationSystem,
  libraryID: number,
  conversationKey: number,
  surface: WindowSurface,
): void {
  remember({ system, libraryID, kind: "global", surface }, conversationKey);
}

// A chat window remembers its paper chat in its own selection slot only; the
// sidebar's remembered chat for the paper is left alone.
function rememberStandalonePaperConversation(
  system: ConversationSystem,
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
  surface: WindowSurface,
): void {
  remember(
    { system, libraryID, kind: "paper", paperItemID, surface },
    conversationKey,
  );
}

function clampStandaloneWindowSize(
  win: Window,
  minWidth: number,
  minHeight: number,
): void {
  try {
    const currentWidth = Math.ceil(
      Number(win.outerWidth || win.innerWidth || 0),
    );
    const currentHeight = Math.ceil(
      Number(win.outerHeight || win.innerHeight || 0),
    );
    if (!Number.isFinite(currentWidth) || !Number.isFinite(currentHeight)) {
      return;
    }
    const nextWidth = Math.max(currentWidth, minWidth);
    const nextHeight = Math.max(currentHeight, minHeight);
    if (nextWidth !== currentWidth || nextHeight !== currentHeight) {
      win.resizeTo(nextWidth, nextHeight);
    }
  } catch (err) {
    appLogger.debug("LLM: standalone minimum size fallback failed", err);
  }
}

function getStandaloneSessionWindow(): Window | null {
  const candidate =
    standaloneSessionState.window || addon.data.standaloneWindow || null;
  if (!candidate || candidate.closed) {
    standaloneSessionState.window = null;
    if (addon.data.standaloneWindow === candidate) {
      addon.data.standaloneWindow = undefined;
    }
    return null;
  }
  standaloneSessionState.window = candidate;
  if (addon.data.standaloneWindow !== candidate) {
    addon.data.standaloneWindow = candidate;
  }
  return candidate;
}

function setStandaloneSessionWindow(win: Window | null): void {
  standaloneSessionState.window = win && !win.closed ? win : null;
  addon.data.standaloneWindow = standaloneSessionState.window || undefined;
}

function setStandalonePending(pending: boolean): void {
  standaloneSessionState.pending = pending;
}

/** Returns true when the standalone chat window is open or being opened. */
export function isStandaloneWindowActive(): boolean {
  if (standaloneSessionState.pending) return true;
  return Boolean(getStandaloneSessionWindow());
}

// Callback registered by initWindow for item-change notifications.
let standaloneItemChangeHandler: ((item: Zotero.Item | null) => void) | null =
  null;

// Reads the open window's paper chat; set by initWindow, cleared on close.
let standaloneActivePaperIDReader: (() => number | null) | null = null;

/**
 * The paper the open standalone window is chatting about, or null for the
 * library chat or when no window is open.
 */
export function getStandaloneActivePaperItemID(): number | null {
  try {
    return standaloneActivePaperIDReader?.() ?? null;
  } catch {
    return null;
  }
}

/** Called by index.ts onItemChange when the user switches paper tabs. */
export function notifyStandaloneItemChanged(item: Zotero.Item | null): void {
  standaloneItemChangeHandler?.(item);
}

/**
 * The sidebar chat panels stay live while the window is open, so closing it
 * leaves them alone. Only bodies that went away while it was open are
 * dropped from panel tracking here.
 */
function releaseDisconnectedEmbeddedPanels(
  excludedBody?: Element | null,
): void {
  for (const [body] of activeContextPanels) {
    if (excludedBody && body === excludedBody) continue;
    if ((body as Element).isConnected) continue;
    void releaseClaudeRuntimeForBody(body as Element);
    unregisterContextPanel(body);
  }
}

type SidebarConv = {
  conversationID?: string;
  conversationKey: number;
  kind?: "global" | "paper";
  conversationSystem?: ConversationSystem;
  libraryID?: number;
  lastActivityAt: number;
  createdAt?: number;
  title?: string;
  userTurnCount?: number;
  sessionVersion?: number;
  paperItemID?: number;
  providerSessionId?: string;
  scopedConversationKey?: string;
  mode?: "open" | "paper";
  /** A WebChat session row (hidden from history; never torn off). */
  webchatSession?: boolean;
};

type StandaloneCreateConversationOptions = {
  forceFresh?: boolean;
  excludeConversationKey?: number;
};

// ---------------------------------------------------------------------------
// Standalone window
// ---------------------------------------------------------------------------

/**
 * Open the LLM chat in a standalone window. If already open, focuses it.
 */
export function openStandaloneChat(options?: {
  initialItem?: Zotero.Item | null;
  initialConversationSystem?: ConversationSystem | null;
  initialRuntimeMode?: ChatRuntimeMode | null;
  sourceBody?: Element | null;
}): void {
  const existingWin = getStandaloneSessionWindow();
  if (existingWin) {
    existingWin.focus();
    return;
  }

  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  // A new window starts from the sidebar's selection (read below), model and
  // backend, and keeps its own from here on; nothing a previous window chose
  // carries over, and a later sidebar change does not move this window.
  clearStandaloneSelection();
  startStandaloneSurfaceChoicesFromSidebar();

  const sourceRawContextItem =
    options?.sourceBody && options.sourceBody.isConnected
      ? activeContextPanelRawItems.get(options.sourceBody) || null
      : null;
  const sourceItem = sourceRawContextItem || options?.initialItem || null;
  const explicitConversationSystem = options?.initialConversationSystem
    ? resolvePreferredConversationSystem({
        item: null,
        preferredSystem: options.initialConversationSystem,
      })
    : null;
  const storedConversationSystem = getStoredConversationSystemPref();
  const preferredConversationSystem =
    explicitConversationSystem ||
    storedConversationSystem ||
    getConversationSystemPref();
  const initialRuntimeMode =
    options?.initialRuntimeMode === "agent"
      ? "agent"
      : options?.initialRuntimeMode === "chat"
        ? "chat"
        : null;
  const sourceItemSystem = resolveConversationSystemForItem(sourceItem);
  const sourceItemForResolution =
    explicitConversationSystem &&
    sourceItemSystem &&
    sourceItemSystem !== explicitConversationSystem
      ? resolveConversationBaseItem(sourceItem)
      : sourceItem;
  const sourceConversationSystem: ConversationSystem =
    explicitConversationSystem ||
    (sourceItemForResolution
      ? resolvePreferredConversationSystem({
          item: sourceItemForResolution,
          preferredSystem: preferredConversationSystem,
        })
      : preferredConversationSystem === "codex" && isCodexAppServerModeEnabled()
        ? "codex"
        : preferredConversationSystem === "claude_code" &&
            getClaudeCodeModeEnabled()
          ? "claude_code"
          : "upstream");
  const resolvedSourceState = resolveInitialPanelItemState(
    sourceItemForResolution,
    {
      conversationSystem: sourceConversationSystem,
    },
  );
  // The window's runtime when it opens; the window keeps its own from here.
  const currentConversationSystem: ConversationSystem =
    explicitConversationSystem ||
    resolvePreferredConversationSystem({
      item: resolvedSourceState.item,
      preferredSystem: sourceConversationSystem,
    });
  const initialBasePaperItem =
    resolvedSourceState.basePaperItem ||
    resolvePaperChatSourceItem(sourceItemForResolution || sourceItem) ||
    null;
  const initialDisplayConversationKind = resolveDisplayConversationKind(
    resolvedSourceState.item || sourceItem,
  );
  const isClaudeConversationSystem = () =>
    currentConversationSystem === "claude_code";
  const isCodexConversationSystem = () => currentConversationSystem === "codex";
  const isRuntimeConversationSystem = () =>
    isClaudeConversationSystem() || isCodexConversationSystem();
  const initialLibraryID =
    Number(
      resolvedSourceState.item?.libraryID ||
        initialBasePaperItem?.libraryID ||
        sourceItem?.libraryID ||
        resolveActiveLibraryID() ||
        1,
    ) || 1;

  const libraryID = initialLibraryID > 0 ? Math.floor(initialLibraryID) : 1;
  const initialRememberedRuntimeMode = isRuntimeConversationSystem()
    ? recallMode(currentConversationSystem, libraryID, { source: "persisted" })
    : null;
  const initialMode: "open" | "paper" =
    initialDisplayConversationKind === "global"
      ? "open"
      : initialDisplayConversationKind === "paper" && initialBasePaperItem
        ? "paper"
        : initialRememberedRuntimeMode === "global"
          ? "open"
          : initialBasePaperItem
            ? "paper"
            : "open";
  const lockedKey = isRuntimeConversationSystem()
    ? null
    : getLockedGlobalConversationKey(libraryID);
  const sourceClaudeGlobalKey =
    resolvedSourceState.item &&
    (resolvedSourceState.item as any).__llmClaudeGlobalPortalItem === true
      ? Number(resolvedSourceState.item.id || 0)
      : sourceItem && (sourceItem as any).__llmClaudeGlobalPortalItem === true
        ? Number(sourceItem.id || 0)
        : 0;
  const sourceCodexGlobalKey =
    resolvedSourceState.item &&
    (resolvedSourceState.item as any).__llmCodexGlobalPortalItem === true
      ? Number(resolvedSourceState.item.id || 0)
      : sourceItem && (sourceItem as any).__llmCodexGlobalPortalItem === true
        ? Number(sourceItem.id || 0)
        : 0;
  const sourceUpstreamGlobalKey = isGlobalPortalItem(resolvedSourceState.item)
    ? Number(resolvedSourceState.item?.id || 0)
    : isGlobalPortalItem(sourceItem)
      ? Number(sourceItem?.id || 0)
      : 0;
  const rememberedUpstreamGlobalKey =
    activeGlobalConversationByLibrary.get(libraryID) ??
    getLastUsedUpstreamGlobalConversationKey(libraryID);
  const conversationKey = isClaudeConversationSystem()
    ? sourceClaudeGlobalKey > 0
      ? sourceClaudeGlobalKey
      : resolveRememberedClaudeConversationKey({
          libraryID,
          kind: "global",
        }) || buildDefaultClaudeGlobalConversationKey(libraryID)
    : isCodexConversationSystem()
      ? sourceCodexGlobalKey > 0
        ? sourceCodexGlobalKey
        : recall({ system: "codex", libraryID, kind: "global" }) ||
          buildDefaultCodexGlobalConversationKey(libraryID)
      : sourceUpstreamGlobalKey > 0
        ? sourceUpstreamGlobalKey
        : (lockedKey ??
          (rememberedUpstreamGlobalKey === GLOBAL_CONVERSATION_KEY_BASE
            ? buildDefaultUpstreamGlobalConversationKey(libraryID)
            : rememberedUpstreamGlobalKey) ??
          buildDefaultUpstreamGlobalConversationKey(libraryID));
  const globalPortalItem = isClaudeConversationSystem()
    ? createClaudeGlobalPortalItem(libraryID, conversationKey)
    : isCodexConversationSystem()
      ? createCodexGlobalPortalItem(libraryID, conversationKey)
      : createGlobalPortalItem(libraryID, conversationKey);
  const initialPaperItem =
    initialMode === "paper"
      ? resolvedSourceState.item || initialBasePaperItem
      : null;
  const initialNoteSession = resolveActiveNoteSession(resolvedSourceState.item);
  const initialMountedItem = initialNoteSession
    ? resolvedSourceState.item
    : initialPaperItem || globalPortalItem;

  // Set flag BEFORE openDialog — keeps isStandaloneWindowActive() true
  // throughout the entire openDialog + load cycle.
  setStandalonePending(true);

  const newWin = openChatWindowInstance({
    mainWin,
    dialogName: "llmforzotero-standalone-chat",
    features: STANDALONE_WINDOW_FEATURES,
    windowSurface: "standalone",
    conversationSystem: currentConversationSystem,
    mode: initialMode,
    mountedItem: initialMountedItem,
    paperItem: initialPaperItem,
    basePaperItem: initialBasePaperItem,
    rawContextItem: sourceItemForResolution || sourceItem || initialMountedItem,
    runtimeMode: initialRuntimeMode,
    libraryID,
  });
  if (!newWin) {
    setStandalonePending(false);
    return;
  }

  setStandaloneSessionWindow(newWin);
  // Keep standalonePending = true until the window's initWindow runs (see
  // openChatWindowInstance).
}

// Shows a follower's chat in the open standalone window; set by its
// initWindow, cleared on close. Resolves true once the window shows it.
let standaloneConversationOpener:
  | ((identity: TornChatIdentity) => Promise<boolean>)
  | null = null;

// The chat a standalone window still opening shows once its initWindow has
// run; a later request replaces it (the earlier one resolves false).
let pendingLeaderConversation: {
  identity: TornChatIdentity;
  settle: (shown: boolean) => void;
} | null = null;

function takePendingLeaderConversation(): typeof pendingLeaderConversation {
  const pending = pendingLeaderConversation;
  pendingLeaderConversation = null;
  return pending;
}

// How long a request waits for the standalone window to load.
const PENDING_LEADER_TIMEOUT_MS = 30_000;
const PENDING_LEADER_POLL_MS = 250;

/**
 * Settles `pending` false if the standalone window it waits for closes
 * before it loads (its initWindow and cleanupWindow then never run), or
 * does not load in time. Such a window also leaves the pending flag set:
 * clear it, since no window is opening any more.
 */
function watchPendingLeaderConversation(
  pending: NonNullable<typeof pendingLeaderConversation>,
): void {
  const deadline = Date.now() + PENDING_LEADER_TIMEOUT_MS;
  const check = () => {
    if (pendingLeaderConversation !== pending) return;
    const opening = getStandaloneSessionWindow();
    if (opening && Date.now() < deadline) {
      void Zotero.Promise.delay(PENDING_LEADER_POLL_MS).then(check);
      return;
    }
    if (!opening) setStandalonePending(false);
    takePendingLeaderConversation()?.settle(false);
  };
  void Zotero.Promise.delay(PENDING_LEADER_POLL_MS).then(check);
}

/**
 * "Open in main window": shows a follower's chat in the standalone window,
 * opening it first when it is closed, and brings it forward. Resolves true
 * once the standalone window shows the chat; false when it cannot (the
 * chat's paper is gone, or the window did not open).
 */
export function openConversationInLeader(
  identity: TornChatIdentity,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    takePendingLeaderConversation()?.settle(false);
    const leader = getStandaloneSessionWindow();
    const opener = standaloneConversationOpener;
    if (leader && !standaloneSessionState.pending) {
      // No opener: the window failed to set itself up.
      if (!opener) {
        resolve(false);
        return;
      }
      bringChatWindowForward(leader);
      opener(identity).then(resolve, () => resolve(false));
      return;
    }
    // The window opens on the chat's paper (or the library chat itself) and
    // in its runtime; the opener then shows the exact chat.
    let initialItem: Zotero.Item;
    if (identity.kind === "paper") {
      const paper = Zotero.Items.get(
        Math.floor(Number(identity.paperItemID || 0)),
      ) as Zotero.Item | false;
      if (!paper || (paper as any).deleted) {
        resolve(false);
        return;
      }
      initialItem = paper;
    } else {
      const libraryID = Math.floor(Number(identity.libraryID || 0)) || 1;
      initialItem = (
        identity.system === "claude_code"
          ? createClaudeGlobalPortalItem(libraryID, identity.conversationKey)
          : identity.system === "codex"
            ? createCodexGlobalPortalItem(libraryID, identity.conversationKey)
            : createGlobalPortalItem(libraryID, identity.conversationKey)
      ) as Zotero.Item;
    }
    const pending = { identity, settle: resolve };
    pendingLeaderConversation = pending;
    // A window still opening shows the chat once its initWindow has run.
    if (!leader) {
      openStandaloneChat({
        initialItem,
        initialConversationSystem: identity.system,
      });
    }
    if (!getStandaloneSessionWindow()) {
      takePendingLeaderConversation()?.settle(false);
      return;
    }
    watchPendingLeaderConversation(pending);
  });
}

/**
 * Open a follower window on one chat. It is another instance of the
 * standalone window document, in its compact follower layout: it holds that
 * chat (History, or its side panel's Open as main chat, loads another), does
 * not follow the PDF reader or Zotero's selection, and is not the singleton
 * the standalone window (the leader) is. Its surface "torn:<id>" starts from
 * the leader's model and runtime choices and keeps its own from then on.
 * A remembered-chat read it has no slot for falls back to the leader's
 * slots, then the sidebar's (conversationSelection.ts), so a follower
 * resolves a chat it was not given as the leader would. A chat has at most
 * one follower: when one already shows the chat, it comes forward and is
 * returned, and nothing opens. Returns null when the chat cannot be shown
 * (its paper is gone, or its runtime is off) or the window does not open.
 */
export function openTornChatWindow(
  identity: TornChatIdentity,
  placement?: { screenX: number; screenY: number },
): Window | null {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return null;
  const conversationKey = Math.floor(Number(identity.conversationKey || 0));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return null;
  // One window per chat: the window that already shows it comes forward.
  const holder = findTornWindowForConversation(conversationKey);
  if (holder) {
    bringChatWindowForward(holder);
    return holder;
  }
  const system = identity.system;
  if (
    (system === "codex" && !isCodexAppServerModeEnabled()) ||
    (system === "claude_code" && !getClaudeCodeModeEnabled())
  ) {
    return null;
  }
  let paperItem: Zotero.Item | null = null;
  if (identity.kind === "paper") {
    const candidate = Zotero.Items.get(
      Math.floor(Number(identity.paperItemID || 0)),
    ) as Zotero.Item | false;
    if (!candidate || (candidate as any).deleted) return null;
    paperItem = candidate;
  }
  const libraryID =
    Math.floor(
      Number(
        paperItem?.libraryID ||
          identity.libraryID ||
          resolveActiveLibraryID() ||
          1,
      ),
    ) || 1;
  const mountedItem = (
    paperItem
      ? system === "claude_code"
        ? createClaudePaperPortalItem(paperItem, conversationKey)
        : system === "codex"
          ? createCodexPaperPortalItem(paperItem, conversationKey)
          : createPaperPortalItem(paperItem, conversationKey, 1)
      : system === "claude_code"
        ? createClaudeGlobalPortalItem(libraryID, conversationKey)
        : system === "codex"
          ? createCodexGlobalPortalItem(libraryID, conversationKey)
          : createGlobalPortalItem(libraryID, conversationKey)
  ) as Zotero.Item;

  // The window starts from the standalone window's choices and keeps its
  // own from here on; its selection slots start on the chat it shows.
  const surface = allocateTornSurface();
  startTornSurfaceChoices(surface);
  surfaceChoices.conversationSystem.set(system, surface);
  if (paperItem) {
    rememberStandalonePaperConversation(
      system,
      libraryID,
      Number(paperItem.id),
      conversationKey,
      surface,
    );
  } else {
    rememberStandaloneGlobalConversation(
      system,
      libraryID,
      conversationKey,
      surface,
    );
  }
  rememberMode(system, libraryID, paperItem ? "paper" : "global", {
    surface,
  });

  const newWin = openChatWindowInstance({
    mainWin,
    dialogName: `llmforzotero-torn-chat-${surface.slice("torn:".length)}`,
    features: buildTornWindowFeatures(placement),
    windowSurface: surface,
    conversationSystem: system,
    mode: paperItem ? "paper" : "open",
    mountedItem,
    paperItem: paperItem ? mountedItem : null,
    basePaperItem: paperItem,
    rawContextItem: paperItem || mountedItem,
    runtimeMode: null,
    libraryID,
  });
  if (!newWin) {
    clearTornSelection(surface);
    clearTornSurfaceChoices(surface);
    return null;
  }
  // Recorded before the window loads, so a second open meanwhile finds it.
  setTornWindowConversation(newWin, conversationKey);
  return newWin;
}

function bringChatWindowForward(win: Window): void {
  try {
    win.focus();
  } catch {
    // The window is going away.
  }
}

type ChatWindowInstanceParams = {
  mainWin: NonNullable<ReturnType<typeof Zotero.getMainWindow>>;
  dialogName: string;
  features: string;
  /** "standalone" for the standalone window; "torn:<id>" for a torn one. */
  windowSurface: WindowSurface;
  conversationSystem: ConversationSystem;
  mode: "open" | "paper";
  mountedItem: Zotero.Item;
  paperItem: Zotero.Item | null;
  basePaperItem: Zotero.Item | null;
  rawContextItem: Zotero.Item | null;
  runtimeMode: "agent" | "chat" | null;
  libraryID: number;
};

/**
 * Opens one chat window (the standalone window, or a torn-off window) and
 * builds its shell once it loads. The standalone window's singleton
 * bookkeeping (pending flag, session slot) stays with its caller and
 * initWindow/cleanupWindow below; a torn-off window skips all of it, does
 * not follow the PDF reader, and is listed in tornChatWindows.ts instead.
 */
function openChatWindowInstance(
  params: ChatWindowInstanceParams,
): Window | null {
  const {
    mainWin,
    windowSurface,
    mode: initialMode,
    mountedItem: initialMountedItem,
    paperItem: initialPaperItem,
    basePaperItem: initialBasePaperItem,
    runtimeMode: initialRuntimeMode,
    libraryID,
  } = params;
  const tornSurface = isTornSurface(windowSurface) ? windowSurface : null;
  // The standalone window (the leader) follows the PDF reader; a torn-off
  // window (a follower) keeps its own chat and is not the standalone
  // singleton.
  const linkedToReader = tornSurface === null;
  const minWindowWidth = linkedToReader
    ? STANDALONE_MIN_WIDTH_PX
    : TORN_WINDOW_MIN_WIDTH_PX;
  const minWindowHeight = linkedToReader
    ? STANDALONE_MIN_HEIGHT_PX
    : TORN_WINDOW_MIN_HEIGHT_PX;
  let currentConversationSystem: ConversationSystem = params.conversationSystem;
  const isClaudeConversationSystem = () =>
    currentConversationSystem === "claude_code";
  const isCodexConversationSystem = () => currentConversationSystem === "codex";
  const isRuntimeConversationSystem = () =>
    isClaudeConversationSystem() || isCodexConversationSystem();

  const newWin = mainWin.openDialog(
    `chrome://${config.addonRef}/content/standaloneChat.xhtml`,
    params.dialogName,
    params.features,
  ) as Window | null;
  if (!newWin) return null;
  const disposeTornRegistration = tornSurface
    ? registerTornChatWindow(newWin, tornSurface)
    : null;

  let cancelled = false;

  // Mutable state for the standalone window
  let standaloneMode: "open" | "paper" = initialMode;
  let activeConversationKey = getConversationKey(initialMountedItem);
  let activeItem: Zotero.Item = initialMountedItem;
  let currentPaperItem: Zotero.Item | null = initialPaperItem;
  let currentBasePaperItem: Zotero.Item | null = initialBasePaperItem;
  let currentRawContextItem: Zotero.Item | null = params.rawContextItem;
  let isInWebChatMode = false;
  let currentChatHooks: SetupHandlersHooks | null = null;
  let standaloneSidebarRenderQueued = false;
  let standaloneMountGeneration = 0;
  let explicitNewChatInFlight = false;
  let initialRuntimeModeSeeded = false;
  let standaloneAttachmentGcTimer: number | null = null;
  let unsubscribeStandalonePendingDeletions: (() => void) | null = null;
  let disposeHistoryActivity: (() => void) | null = null;
  let disposePluginUpdate: (() => void) | null = null;
  let themeObserver: {
    observe(target: Node, options: MutationObserverInit): void;
    disconnect(): void;
  } | null = null;
  let darkMQ: MediaQueryList | null = null;
  let onSchemeChange: (() => void) | null = null;
  let cleanupStandalonePrefObserver: (() => void) | null = null;
  let cleanupStandaloneTabFollow: (() => void) | null = null;
  let cleanupTornPaperWatch: (() => void) | null = null;
  // The module-level reader link this window set (the standalone window
  // only), so closing a window clears only its own.
  let ownItemChangeHandler: ((item: Zotero.Item | null) => void) | null = null;
  let ownActivePaperIDReader: (() => number | null) | null = null;
  let ownConversationOpener:
    | ((identity: TornChatIdentity) => Promise<boolean>)
    | null = null;
  let cleanupStandaloneVerticalResize: (() => void) | null = null;
  let cleanupStandaloneSidebarResize: (() => void) | null = null;
  let cleanupStandaloneSidebarFlyout: (() => void) | null = null;
  let unbindStandaloneTaskProgressToggle: (() => void) | null = null;
  let enforceStandaloneMinimumSize: (() => void) | null = null;
  let disposeStandaloneSidePanel: (() => void) | null = null;
  let disposePinnedPaperActivity: (() => void) | null = null;

  const initWindow = () => {
    // A torn-off window is not the standalone singleton: it never touches
    // the pending flag or the session slot.
    if (linkedToReader) {
      // Now the window is loaded — safe to clear the pending flag.
      // isStandaloneWindowActive() will still return true because
      // addon.data.standaloneWindow is set and not closed.
      setStandalonePending(false);
    }
    // Reset cancelled — the about:blank → XHTML transition in XUL may
    // fire an early unload that sets cancelled=true before load fires.
    cancelled = false;
    if (linkedToReader) {
      // Re-store the window reference for the same reason.
      setStandaloneSessionWindow(newWin);
    } else {
      newWin.document?.documentElement?.setAttribute(
        "windowtype",
        "llmforzotero:chat",
      );
    }
    // Register the real unload handler now that the document is loaded.
    newWin.addEventListener("unload", cleanupWindow, { once: true });
    appLogger.debug("LLM: standalone initWindow start");

    const scheduleStandaloneAttachmentGc = (delayMs = 5_000) => {
      const clearTimer = () => {
        if (standaloneAttachmentGcTimer === null) return;
        newWin.clearTimeout(standaloneAttachmentGcTimer);
        standaloneAttachmentGcTimer = null;
      };
      clearTimer();
      standaloneAttachmentGcTimer = newWin.setTimeout(() => {
        standaloneAttachmentGcTimer = null;
        void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
          (err) => {
            appLogger.warn("LLM: standalone attachment GC failed", err);
          },
        );
      }, delayMs);
    };

    try {
      const doc = newWin.document;
      // The →| ("Move to side panel") buttons exist only where this host is
      // registered. Register it now, before any message renders, whether or
      // not the side panel has been opened or even created yet; the call
      // goes to the panel once it exists (it opens the panel if needed).
      registerSidePanelItemHost(doc, {
        open: (request) => standaloneSidePanel?.openItem(request),
      });
      doc.documentElement?.setAttribute("minwidth", `${minWindowWidth}`);
      doc.documentElement?.setAttribute("minheight", `${minWindowHeight}`);
      if (doc.documentElement) {
        doc.documentElement.style.minWidth = `${minWindowWidth}px`;
        doc.documentElement.style.minHeight = `${minWindowHeight}px`;
      }
      enforceStandaloneMinimumSize = () =>
        clampStandaloneWindowSize(newWin, minWindowWidth, minWindowHeight);
      newWin.addEventListener("resize", enforceStandaloneMinimumSize);
      newWin.setTimeout(enforceStandaloneMinimumSize, 0);

      // Inject Zotero CSS variables that the standalone window doesn't inherit.
      const zoteroVars = [
        "--fill-primary",
        "--fill-secondary",
        "--fill-tertiary",
        "--fill-quaternary",
        "--fill-quinary",
        "--stroke-primary",
        "--stroke-secondary",
        "--material-background",
        "--material-sidepane",
        "--material-toolbar",
        "--color-accent",
        "--accent-blue",
      ];
      const mainDocEl = mainWin.document.documentElement;
      let styleEl: HTMLStyleElement | null = null;

      function parseCssRgbChannel(channel: string): number | null {
        const trimmed = channel.trim();
        if (!trimmed) return null;
        const value = Number.parseFloat(trimmed);
        if (!Number.isFinite(value)) return null;
        if (trimmed.endsWith("%")) {
          return Math.max(0, Math.min(255, (value / 100) * 255));
        }
        return Math.max(0, Math.min(255, value));
      }

      function parseCssRgbColor(
        value: string,
      ): [number, number, number] | null {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
        if (hex) {
          const full =
            hex.length === 3
              ? hex
                  .split("")
                  .map((part) => `${part}${part}`)
                  .join("")
              : hex;
          return [
            Number.parseInt(full.slice(0, 2), 16),
            Number.parseInt(full.slice(2, 4), 16),
            Number.parseInt(full.slice(4, 6), 16),
          ];
        }
        const rgb = trimmed.match(/^rgba?\(([^)]+)\)$/i)?.[1];
        if (!rgb) return null;
        const parts = rgb
          .replace(/\s*\/\s*[^, ]+$/, "")
          .split(/[,\s]+/)
          .filter(Boolean);
        if (parts.length < 3) return null;
        const channels = parts.slice(0, 3).map(parseCssRgbChannel);
        if (channels.some((channel) => channel === null)) return null;
        return channels as [number, number, number];
      }

      function getCssRgbLuminance(color: [number, number, number]): number {
        const [r, g, b] = color.map((channel) => {
          const value = channel / 255;
          return value <= 0.03928
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }

      function isLightStandaloneTheme(
        style: CSSStyleDeclaration | null,
      ): boolean {
        const background =
          style?.getPropertyValue("--material-background").trim() ||
          style?.getPropertyValue("--material-sidepane").trim() ||
          "";
        const color = parseCssRgbColor(background);
        if (color) return getCssRgbLuminance(color) > 0.5;
        return !mainWin.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
      }

      const syncZoteroVarsToStandalone = () => {
        if (cancelled || newWin.closed) return;
        const freshStyle = mainDocEl
          ? mainWin.getComputedStyle(mainDocEl)
          : null;
        const rootEl = doc.getElementById(
          "llmforzotero-standalone-chat-root",
        ) as HTMLElement | null;
        if (rootEl) {
          rootEl.dataset.standaloneTheme = isLightStandaloneTheme(freshStyle)
            ? "light"
            : "dark";
        }
        const decls = zoteroVars
          .map((v) => {
            const val = freshStyle?.getPropertyValue(v).trim();
            return val ? `${v}: ${val};` : "";
          })
          .filter(Boolean)
          .join("\n  ");
        if (!decls) return;
        if (!styleEl) {
          styleEl = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
          doc.documentElement?.prepend(styleEl);
        }
        styleEl.textContent = `:root {\n  ${decls}\n}`;
      };

      // Initial injection
      syncZoteroVarsToStandalone();

      // Re-sync when Zotero's theme changes (attribute changes on root element).
      // Access MutationObserver from the main window — it's not a global in the
      // standalone window's Gecko execution context.
      const MO = (mainWin as any).MutationObserver as
        | typeof MutationObserver
        | undefined;
      if (MO && mainDocEl) {
        themeObserver = new MO(() => syncZoteroVarsToStandalone());
        themeObserver.observe(mainDocEl, {
          attributes: true,
          attributeFilter: ["style", "class"],
        });
      }

      // Re-sync on OS-level dark/light switch
      const mq = mainWin.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
      darkMQ = mq;
      onSchemeChange = () => {
        newWin.setTimeout(() => syncZoteroVarsToStandalone(), 100);
      };
      if (mq) mq.addEventListener("change", onSchemeChange);

      // Inject CSS
      const mainCSS = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
      mainCSS.rel = "stylesheet";
      mainCSS.type = "text/css";
      mainCSS.href = pluginStylesheetHref("zoteroPane.css");
      doc.documentElement?.appendChild(mainCSS);

      const katexCSS = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
      katexCSS.rel = "stylesheet";
      katexCSS.type = "text/css";
      katexCSS.href = pluginStylesheetHref("vendor/katex/katex.min.css");
      doc.documentElement?.appendChild(katexCSS);

      const rerenderStandaloneShellAfterStylesReady = () => {
        if (cancelled || newWin.closed) return;
        const mountedItem = activeItem;
        if (!mountedItem) return;
        const llmMain = contentArea.querySelector(
          "#llm-main",
        ) as HTMLElement | null;
        applyPanelFontScale(llmMain);
        applyPanelFontScale(root);
        const shortcutMode = standaloneMode === "open" ? "library" : "paper";
        void renderShortcuts(contentArea, mountedItem, shortcutMode);
        refreshChat(contentArea, mountedItem);
      };
      mainCSS.addEventListener(
        "load",
        rerenderStandaloneShellAfterStylesReady,
        {
          once: true,
        },
      );

      // Mount into the root div
      const root = doc.getElementById(
        "llmforzotero-standalone-chat-root",
      ) as HTMLElement | null;
      if (!root) return;

      root.dataset.standalone = "true";
      // The leader has the chat list and follows the PDF reader; a follower
      // holds one chat in two compact header rows.
      root.dataset.windowRole = linkedToReader ? "leader" : "follower";

      // -----------------------------------------------------------------------
      // Build the shell layout:
      //   topbar (full width)
      //   lowerArea: unified expandable sidebar | content
      // -----------------------------------------------------------------------

      // Switch root from row to column
      root.style.flexDirection = "column";

      // -- Tab group (centered at top of content area) --
      const paperTab = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      paperTab.className = "llm-standalone-tab";
      paperTab.type = "button";
      paperTab.textContent = t(
        resolveStandalonePaperTabLabel({
          isNoteSession: Boolean(resolveActiveNoteSession(activeItem)),
        }),
      );
      paperTab.dataset.tab = "paper";

      const openTab = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      openTab.className = "llm-standalone-tab";
      openTab.type = "button";
      openTab.textContent = t("Library chat");
      openTab.dataset.tab = "open";

      paperTab.classList.toggle("active", standaloneMode === "paper");
      openTab.classList.toggle("active", standaloneMode === "open");

      const tabGroup = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      tabGroup.className = "llm-standalone-tab-group";
      tabGroup.append(paperTab, openTab);

      const standaloneRuntimeSystemControls = createRuntimeSystemControls(doc, {
        groupClassName: "llm-standalone-runtime-system-controls",
        buttonClassName: "llm-standalone-runtime-system-toggle",
      });
      const updateStandaloneSystemToggles = () => {
        syncRuntimeSystemControls(standaloneRuntimeSystemControls, {
          activeSystem: currentConversationSystem,
          codexEnabled: isCodexAppServerModeEnabled(),
          claudeEnabled: getClaudeCodeModeEnabled(),
        });
      };

      // The leading slot is the tab row's single grid cell on the left. It
      // holds the runtime controls; the window buttons and sidebar toggle
      // join them whenever the sidebar is collapsed. A follower's top row
      // holds its window buttons, unlinked icon and title here instead.
      const tabRowLeading = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      tabRowLeading.className = "llm-standalone-tab-row-leading";
      if (linkedToReader) {
        tabRowLeading.append(standaloneRuntimeSystemControls.group);
      }

      // The trailing slot holds the side panel toggle (right edge).
      const tabRowTrailing = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      tabRowTrailing.className = "llm-standalone-tab-row-trailing";

      const tabRow = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      tabRow.className = "llm-standalone-tab-row";
      if (linkedToReader) {
        tabRow.append(tabRowLeading, tabGroup, tabRowTrailing);
      } else {
        // A follower's actions sit in the row under this one.
        tabRow.append(tabRowLeading);
      }

      // -- Lower area: sidebar + content side by side --
      const lowerArea = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      lowerArea.className = "llm-standalone-lower";

      const sidebarView = createStandaloneSidebarView(doc, t);
      // Pinned papers (oldest first), and the papers whose answer finished
      // while another paper was on screen. The list and its actions are set
      // up below, once the paper switch code exists.
      let pinnedPaperIDs = getStandalonePinnedPapersPref();
      let readyPinnedPaperIDs = new Set<number>();
      // The main chat each paper last showed in this window.
      const shownPaperConversationKeys = new Map<number, number>();
      let renderPinnedPapers: () => void = () => {};
      disposeHistoryActivity = observeHistoryActivity(sidebarView.list);
      // The plugin-update control lives in the standalone window only; torn
      // windows close on an update.
      if (linkedToReader) {
        const lastSeenKey = `${config.prefsPrefix}.lastSeenVersion`;
        const updateController = createPluginUpdateController({
          getDeps: getPluginUpdateDeps,
          readLastSeen: () => {
            const value = Zotero.Prefs.get(lastSeenKey, true);
            return typeof value === "string" ? value : "";
          },
          writeLastSeen: (value) => Zotero.Prefs.set(lastSeenKey, value, true),
          isReplyInFlight: isAnyRequestPending,
          setInterval: (fn, ms) => newWin.setInterval(fn, ms),
          clearInterval: (handle) => newWin.clearInterval(handle as number),
        });
        const updateControl = createStandaloneUpdateControl({
          doc,
          win: newWin,
          slot: sidebarView.updateSlot,
          anchorRow: sidebarView.footerRow,
          controller: updateController,
          translate: t,
          openUrl: (url) => Zotero.launchURL(url),
        });
        updateController.start();
        disposePluginUpdate = () => {
          updateControl.dispose();
          updateController.dispose();
        };
      }
      const sidebar = sidebarView.root;
      const sidebarPanel = sidebarView.panel;
      const iconSidebarToggle = sidebarView.toggleButton;
      const iconNewChat = sidebarView.newChatButton;
      const iconSearch = sidebarView.searchButton;
      const iconSkill = sidebarView.skillsButton;
      const iconSettings = sidebarView.preferencesButton;
      const webHistoryRefreshBtn = sidebarView.refreshButton;
      const standaloneHistoryUndo = sidebarView.undo;
      const standaloneHistoryUndoText = sidebarView.undoText;
      const standaloneHistoryUndoBtn = sidebarView.undoButton;
      const sidebarList = sidebarView.list;
      const sidebarResizeHandle = sidebarView.resizeHandle;

      if (linkedToReader) {
        // A collapsed sidebar renders nothing at all, so the window controls
        // and the collapse toggle move into the tab row for as long as it is
        // hidden, and hovering the toggle floats the sidebar back over the
        // content.
        setStandaloneSidebarCollapsedChromeHost(sidebarView, tabRowLeading);
        cleanupStandaloneSidebarFlyout = installStandaloneSidebarFlyout({
          win: newWin,
          toggle: iconSidebarToggle,
          panel: sidebarPanel,
          isCollapsed: () => sidebar.dataset.sidebarState === "collapsed",
          setOpen: (open) => setStandaloneSidebarFlyoutOpen(sidebarView, open),
        });
      } else {
        // A follower has no sidebar: its window controls live in its top
        // row for good, without the sidebar toggle.
        setStandaloneFollowerChromeHost(sidebarView, tabRowLeading);
      }

      // Export popup — floating menu from the content-title Export action
      const exportPopup = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      exportPopup.className = "llm-standalone-export-popup";
      exportPopup.style.display = "none";

      const exportPopupCopyBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      exportPopupCopyBtn.className = "llm-standalone-popup-item";
      exportPopupCopyBtn.type = "button";
      exportPopupCopyBtn.textContent = t("Copy chat as md");

      const exportPopupNoteBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      exportPopupNoteBtn.className = "llm-standalone-popup-item";
      exportPopupNoteBtn.type = "button";
      exportPopupNoteBtn.textContent = t("Save chat as note");

      exportPopup.append(exportPopupCopyBtn, exportPopupNoteBtn);

      let standaloneSidebarEntriesByKey = new Map<number, SidebarConv>();
      // Counts history row opens, so only the newest click mounts its chat.
      let standaloneHistoryOpenSeq = 0;
      // Set once the runtime switch code exists (see adoptStandaloneRuntime).
      let adoptStandaloneRuntime: (
        system: ConversationSystem,
      ) => Promise<boolean> = async () => false;

      // -- Content area --
      const contentWrapper = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      contentWrapper.className = "llm-standalone-content-wrapper";

      const contentTitleBar = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      contentTitleBar.className = "llm-standalone-content-title";

      const contentTitleText = doc.createElementNS(
        HTML_NS,
        "span",
      ) as HTMLSpanElement;
      contentTitleText.className = "llm-standalone-content-title-text";

      // A follower does not follow the PDF reader; a small unlinked icon
      // before its title says so, in a paper chat and a library chat alike.
      let unlinkedIcon: HTMLSpanElement | null = null;
      if (!linkedToReader) {
        unlinkedIcon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
        unlinkedIcon.className = "llm-standalone-unlinked-icon";
        // A hover card (built below) explains the icon; a title would add a
        // native tooltip on top of it.
        unlinkedIcon.tabIndex = 0;
        unlinkedIcon.setAttribute(
          "aria-label",
          t("Not linked to the PDF reader"),
        );
        unlinkedIcon.setAttribute("aria-describedby", UNLINKED_CARD_ID);
        root.dataset.readerLink = "unlinked";
      }

      if (unlinkedIcon) bindUnlinkedHoverCard(doc, root, unlinkedIcon);

      const contentTitleBarSpacer = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      contentTitleBarSpacer.className = "llm-standalone-content-title-actions";

      // Shows or hides the Task progress row for the conversation on screen;
      // bound to the chat panel below, once the content area exists.
      const iconTaskProgress = createTaskProgressToggleButton(doc);

      // Pins the paper on screen: it is listed under "Pinned papers" and
      // keeps its side panel tabs while another paper is shown.
      const iconPin = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconPin.className = "llm-standalone-title-action llm-standalone-icon-pin";
      iconPin.type = "button";
      iconPin.hidden = true;

      const iconExport = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconExport.className =
        "llm-standalone-title-action llm-standalone-icon-export";
      iconExport.type = "button";
      iconExport.title = t("Export");
      iconExport.setAttribute("aria-label", t("Export"));

      const iconClear = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconClear.className =
        "llm-standalone-title-action llm-standalone-icon-clear";
      iconClear.type = "button";
      iconClear.title = t("Delete conversation");
      iconClear.setAttribute("aria-label", t("Delete conversation"));
      // A follower's own header buttons. Open in main window goes after the
      // side panel toggle (below, once the side panel exists).
      let iconFollowerHistory: HTMLButtonElement | null = null;
      let iconFollowerOpenMain: HTMLButtonElement | null = null;
      let iconFollowerMore: HTMLButtonElement | null = null;
      // The follower's kind line under its title: an icon, then "Paper chat
      // · Klaus et al., 2017" or "Library chat · My Library".
      let followerKindIcon: HTMLSpanElement | null = null;
      let followerKindText: HTMLSpanElement | null = null;
      let followerKindLine: HTMLDivElement | null = null;
      // The second row under the divider: the kind line at the left, the four
      // actions at the right.
      let followerKindRow: HTMLDivElement | null = null;
      let followerActions: HTMLDivElement | null = null;
      if (linkedToReader) {
        contentTitleBarSpacer.append(
          iconPin,
          iconTaskProgress,
          iconExport,
          iconClear,
        );
        contentTitleBar.append(contentTitleText, contentTitleBarSpacer);
      } else {
        const createFollowerAction = (className: string, label: string) => {
          const button = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          button.className = `llm-standalone-title-action ${className}`;
          button.type = "button";
          button.title = label;
          button.setAttribute("aria-label", label);
          return button;
        };
        iconFollowerHistory = createFollowerAction(
          "llm-follower-history",
          t("History"),
        );
        iconFollowerHistory.setAttribute("aria-haspopup", "dialog");
        iconFollowerOpenMain = createFollowerAction(
          "llm-follower-open-main",
          t("Open in main window"),
        );
        iconFollowerMore = createFollowerAction(
          "llm-follower-more",
          t("More actions"),
        );
        iconFollowerMore.setAttribute("aria-haspopup", "menu");
        iconFollowerMore.setAttribute("aria-expanded", "false");
        // One row. Left: the window buttons, the unlinked icon and the chat's
        // title. Right: History, then the side panel toggle and Open in main
        // window (added below, once the side panel exists), then More. Task
        // progress, Export and Delete live in the More menu and keep no
        // button in the page: the menu runs the buttons' own handlers. The
        // kind line sits under the row, at the top left of the chat.
        contentTitleText.classList.add("llm-follower-title");
        const titleLine = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        titleLine.className = "llm-follower-title-line";
        if (unlinkedIcon) titleLine.append(unlinkedIcon);
        titleLine.append(contentTitleText);
        followerKindLine = doc.createElementNS(
          HTML_NS,
          "div",
        ) as HTMLDivElement;
        followerKindLine.className = "llm-follower-kind-line";
        // The icon and text are filled in by syncFollowerTitle, inside a
        // button for a paper chat and a plain span for a library chat.
        followerKindRow = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        followerKindRow.className = "llm-follower-kind-row";
        followerActions = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        followerActions.className = "llm-follower-actions";
        followerActions.append(iconFollowerHistory);
        followerKindRow.append(followerKindLine, followerActions);
        tabRowLeading.append(titleLine);
      }

      const contentArea = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      contentArea.className = "llm-standalone-content";
      contentArea.dataset.standalone = "true";
      // A torn window declares its surface before its panel binds, so
      // anything that reads the body first already sees its own surface.
      if (tornSurface) contentArea.dataset.selectionSurface = tornSurface;
      unbindStandaloneTaskProgressToggle = bindTaskProgressToggle(
        contentArea,
        iconTaskProgress,
      );

      // A follower has no second header row; its kind line goes under the
      // top row instead.
      if (linkedToReader) {
        contentWrapper.append(tabRow, contentTitleBar, contentArea);
      } else if (followerKindRow) {
        contentWrapper.append(tabRow, followerKindRow, contentArea);
      } else {
        contentWrapper.append(tabRow, contentArea);
      }
      // A follower has no chat list: its sidebar is never shown.
      if (linkedToReader) lowerArea.append(sidebar);
      lowerArea.append(contentWrapper);

      // -- Skills overlay (popup for managing agent skills) --
      const skillOverlay = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      skillOverlay.className = "llm-standalone-skill-overlay";
      skillOverlay.style.display = "none";

      const skillPopup = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      skillPopup.className = "llm-standalone-skill-popup";

      const skillHeader = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      skillHeader.className = "llm-standalone-skill-header";

      const skillTitle = doc.createElementNS(
        HTML_NS,
        "span",
      ) as HTMLSpanElement;
      skillTitle.className = "llm-standalone-skill-title";
      skillTitle.textContent = t("Skills");

      const skillRefreshBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      skillRefreshBtn.className = "llm-outline-btn";
      skillRefreshBtn.type = "button";
      skillRefreshBtn.textContent = t("Check for updates");
      skillRefreshBtn.title = t(
        "Re-seed built-in skills and refresh the list. Customized files are kept — use the right-click menu to restore individual skills to default.",
      );

      const skillCloseBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      skillCloseBtn.className = "llm-standalone-search-close";
      skillCloseBtn.type = "button";
      skillCloseBtn.textContent = "\u00D7";

      skillHeader.append(skillTitle, skillRefreshBtn, skillCloseBtn);

      const skillGrid = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      skillGrid.className = "llm-standalone-skill-grid";

      skillPopup.append(skillHeader, skillGrid);
      skillOverlay.appendChild(skillPopup);

      // Skills context menu (right-click)
      const skillCtxMenu = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      skillCtxMenu.className = "llm-standalone-skill-ctx-menu";
      skillCtxMenu.style.display = "none";

      const skillCtxShowInFs = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      skillCtxShowInFs.className = "llm-standalone-skill-ctx-item";
      skillCtxShowInFs.type = "button";
      skillCtxShowInFs.textContent = t("Show in file system");

      const skillCtxRestore = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      skillCtxRestore.className = "llm-standalone-skill-ctx-item";
      skillCtxRestore.type = "button";
      skillCtxRestore.textContent = t("Restore to default");
      skillCtxRestore.style.display = "none"; // only shown for customized built-ins

      const skillCtxDelete = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      skillCtxDelete.className =
        "llm-standalone-skill-ctx-item llm-standalone-skill-ctx-delete";
      skillCtxDelete.type = "button";
      skillCtxDelete.textContent = t("Delete");

      skillCtxMenu.append(skillCtxShowInFs, skillCtxRestore, skillCtxDelete);

      // Chat row context menu (right-click), styled like the skills menu.
      const convCtxMenu = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      convCtxMenu.className =
        "llm-standalone-skill-ctx-menu llm-standalone-conv-ctx-menu";
      convCtxMenu.setAttribute("role", "menu");
      convCtxMenu.style.display = "none";

      const convCtxOpenInWindow = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      convCtxOpenInWindow.className = "llm-standalone-skill-ctx-item";
      convCtxOpenInWindow.type = "button";
      convCtxOpenInWindow.setAttribute("role", "menuitem");
      convCtxOpenInWindow.dataset.action = "open-in-new-window";
      convCtxOpenInWindow.textContent = t("Open in New Window");
      convCtxMenu.append(convCtxOpenInWindow);

      // A follower's More menu, built like the chat row menu: Task progress,
      // Export, a line, then Delete conversation.
      let followerMoreMenu: HTMLDivElement | null = null;
      let followerMoreTaskItem: HTMLButtonElement | null = null;
      let followerMoreExportItem: HTMLButtonElement | null = null;
      let followerMoreDeleteItem: HTMLButtonElement | null = null;
      if (!linkedToReader) {
        const createMoreItem = (
          action: string,
          label: string,
          role = "menuitem",
        ) => {
          const item = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          item.className = "llm-standalone-skill-ctx-item";
          item.type = "button";
          item.setAttribute("role", role);
          item.dataset.action = action;
          item.textContent = label;
          return item;
        };
        followerMoreMenu = doc.createElementNS(
          HTML_NS,
          "div",
        ) as HTMLDivElement;
        followerMoreMenu.className =
          "llm-standalone-skill-ctx-menu llm-follower-more-menu";
        followerMoreMenu.setAttribute("role", "menu");
        followerMoreMenu.style.display = "none";
        followerMoreTaskItem = createMoreItem(
          "task-progress",
          t("Task progress"),
          "menuitemcheckbox",
        );
        followerMoreExportItem = createMoreItem("export", t("Export"));
        const separator = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        separator.className = "llm-follower-menu-separator";
        separator.setAttribute("role", "separator");
        followerMoreDeleteItem = createMoreItem(
          "delete",
          t("Delete conversation"),
        );
        followerMoreDeleteItem.classList.add("llm-standalone-skill-ctx-delete");
        followerMoreMenu.append(
          followerMoreTaskItem,
          followerMoreExportItem,
          separator,
          followerMoreDeleteItem,
        );
      }

      root.append(lowerArea, exportPopup, skillOverlay, skillCtxMenu);
      // Its one item opens a torn-off window, which only the standalone
      // window offers.
      if (linkedToReader) root.append(convCtxMenu);
      if (followerMoreMenu) root.append(followerMoreMenu);
      cleanupStandaloneVerticalResize = installStandaloneVerticalResizeBehavior(
        newWin,
        contentArea,
        {
          minWindowHeight,
        },
      );
      // Set once the side panel exists (below); the History pane leaves it
      // its width.
      let standaloneSidePanel: StandaloneSidePanelController | null = null;
      const standaloneSidebarResize = installStandaloneColumnResizeBehavior(
        newWin,
        lowerArea,
        sidebarPanel,
        sidebarResizeHandle,
        {
          initialWidth: getStandaloneSidebarWidthPref(),
          onWidthCommit: setStandaloneSidebarWidthPref,
          // The panel's width, less what the window is about to gain for it.
          getReservedWidth: () =>
            (standaloneSidePanel?.getOccupiedWidth() || 0) -
            (standaloneSidePanel?.getPendingWindowWidthChange() || 0),
        },
      );
      cleanupStandaloneSidebarResize = standaloneSidebarResize.dispose;

      // -- Sidebar state management --
      let userManualSidebarState: "expanded" | "collapsed" | null = null;

      const setSidebarState = (state: "expanded" | "collapsed") => {
        setStandaloneSidebarState(sidebarView, state);
        // The side panel's room depends on the History pane's width.
        standaloneSidePanel?.relayout();
      };

      const toggleSidebar = () => {
        const current = sidebar.dataset.sidebarState || "expanded";
        const next = current === "expanded" ? "collapsed" : "expanded";
        userManualSidebarState = next;
        setSidebarState(next);
      };

      // -----------------------------------------------------------------------
      // Helpers
      // -----------------------------------------------------------------------
      const clearContent = () => {
        if (typeof (contentArea as any).replaceChildren === "function") {
          (contentArea as any).replaceChildren();
        } else {
          contentArea.textContent = "";
        }
      };

      const clearSidebarList = () => {
        if (typeof (sidebarList as any).replaceChildren === "function") {
          (sidebarList as any).replaceChildren();
        } else {
          sidebarList.textContent = "";
        }
      };

      const getSelectedZoteroItem = (): Zotero.Item | null => {
        try {
          const activePane = Zotero.getActiveZoteroPane?.() as any;
          const activeItems = activePane?.getSelectedItems?.();
          if (activeItems?.[0]) {
            return activeItems[0];
          }
        } catch {
          void 0;
        }
        try {
          const mainPane = (mainWin as any)?.ZoteroPane;
          const mainItems = mainPane?.getSelectedItems?.();
          return mainItems?.[0] || null;
        } catch {
          return null;
        }
      };

      const syncPaperTabLabel = () => {
        paperTab.textContent = t(
          resolveStandalonePaperTabLabel({
            isWebChat: isInWebChatMode,
            isNoteSession: Boolean(resolveActiveNoteSession(activeItem)),
          }),
        );
      };

      const getCurrentLibraryScopeID = (): number => {
        const activeLibraryID = Number(activeItem?.libraryID || 0);
        if (Number.isFinite(activeLibraryID) && activeLibraryID > 0) {
          return Math.floor(activeLibraryID);
        }
        const paperLibraryID = Number(
          currentBasePaperItem?.libraryID || currentPaperItem?.libraryID || 0,
        );
        if (Number.isFinite(paperLibraryID) && paperLibraryID > 0) {
          return Math.floor(paperLibraryID);
        }
        return libraryID;
      };

      const getLibraryIDForPaperItem = (
        paperItem: Zotero.Item | null | undefined,
      ): number => {
        const value = Number(paperItem?.libraryID || 0);
        return Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : getCurrentLibraryScopeID();
      };

      const getCurrentPaperLibraryID = (): number => {
        const value = Number(
          currentBasePaperItem?.libraryID ||
            currentPaperItem?.libraryID ||
            getCurrentLibraryScopeID(),
        );
        return Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : getCurrentLibraryScopeID();
      };

      // -----------------------------------------------------------------------
      // Tear-off: drag a chat row (or the chat title) out of the standalone
      // window, or pick "Open in New Window" on a row, to open the chat in a
      // torn-off window. Only the standalone window is a source: a torn-off
      // window never opens another. Never for WebChat (its mode, rows and
      // session chats) or for note chats.
      // -----------------------------------------------------------------------
      // The chat as one a follower can hold, or null (WebChat, note chats,
      // a paper that is gone).
      const chatIdentityFor = (candidate: {
        system: ConversationSystem;
        conversationKey: number;
        kind: "paper" | "global";
        libraryID: number;
        paperItemID?: number;
      }): TornChatIdentity | null => {
        if (cancelled || newWin.closed || isInWebChatMode) return null;
        // A note session lists and shows the note's own chats.
        if (resolveActiveNoteSession(activeItem)) return null;
        const key = Math.floor(Number(candidate.conversationKey || 0));
        if (!Number.isFinite(key) || key <= 0) return null;
        if (
          webChatSessionConversationKeys.has(key) ||
          webChatIsolatedConversationKeys.has(key)
        ) {
          return null;
        }
        if (!isConversationKeyForKind(candidate.system, candidate.kind, key)) {
          return null;
        }
        const libraryID = Math.floor(Number(candidate.libraryID || 0));
        if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
        if (candidate.kind === "global") {
          return {
            system: candidate.system,
            conversationKey: key,
            kind: "global",
            libraryID,
          };
        }
        const paperItemID = Math.floor(Number(candidate.paperItemID || 0));
        if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
        const paper = Zotero.Items.get(paperItemID) as Zotero.Item | false;
        if (!paper || (paper as any).deleted || (paper as any).isNote?.()) {
          return null;
        }
        return {
          system: candidate.system,
          conversationKey: key,
          kind: "paper",
          libraryID,
          paperItemID,
        };
      };
      const tearOffIdentityFor = (
        candidate: Parameters<typeof chatIdentityFor>[0],
      ): TornChatIdentity | null =>
        linkedToReader ? chatIdentityFor(candidate) : null;

      const tearOffIdentityForEntry = (
        conv: SidebarConv,
      ): TornChatIdentity | null => {
        if (conv.webchatSession === true) return null;
        const listedKind =
          conv.kind ||
          (conv.mode === "open"
            ? "global"
            : conv.mode === "paper"
              ? "paper"
              : null);
        const kind: "paper" | "global" =
          listedKind || (standaloneMode === "open" ? "global" : "paper");
        return tearOffIdentityFor({
          system: conv.conversationSystem || currentConversationSystem,
          conversationKey: conv.conversationKey,
          kind,
          libraryID: Number(conv.libraryID || 0) || getCurrentLibraryScopeID(),
          paperItemID:
            kind === "paper"
              ? Number(conv.paperItemID || 0) ||
                Number(currentBasePaperItem?.id || 0)
              : undefined,
        });
      };

      // The chat on screen, while a paper or library chat is mounted.
      const shownChatIdentity = (): TornChatIdentity | null => {
        if (standaloneMode === "paper") {
          if (!currentBasePaperItem) return null;
          return chatIdentityFor({
            system: currentConversationSystem,
            conversationKey: activeConversationKey,
            kind: "paper",
            libraryID: getLibraryIDForPaperItem(currentBasePaperItem),
            paperItemID: Number(currentBasePaperItem.id || 0),
          });
        }
        return chatIdentityFor({
          system: currentConversationSystem,
          conversationKey: activeConversationKey,
          kind: "global",
          libraryID: getCurrentLibraryScopeID(),
        });
      };
      const tearOffIdentityForTitle = (): TornChatIdentity | null =>
        linkedToReader ? shownChatIdentity() : null;

      // The tear-off drag under way. Its source region is the node that
      // gets the drag's `drag` and `dragend` events (dataTransfer.addElement),
      // one the list's renders never replace: the chat list for a row, the
      // title row for the title.
      let activeTearOffDrag: {
        identity: TornChatIdentity;
        getIdentity: () => TornChatIdentity | null;
        region: HTMLElement;
        droppedOnSource: boolean;
        lastDragPoint: ScreenPoint | null;
      } | null = null;

      // The picture under the pointer during a tear-off drag: a small window
      // with the unlinked icon and the title its follower opens with. Kept
      // rendered off-screen, since a drag image must be laid out.
      let tearOffDragImage: HTMLDivElement | null = null;
      let tearOffDragImageTitle: HTMLSpanElement | null = null;
      const renderTearOffDragImage = (title: string): HTMLDivElement => {
        if (!tearOffDragImage || !tearOffDragImage.isConnected) {
          tearOffDragImage = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          tearOffDragImage.className = "llm-tear-off-drag-image";
          tearOffDragImage.setAttribute("aria-hidden", "true");
          const bar = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
          bar.className = "llm-tear-off-drag-image-bar";
          const icon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          icon.className = "llm-standalone-unlinked-icon";
          tearOffDragImageTitle = doc.createElementNS(
            HTML_NS,
            "span",
          ) as HTMLSpanElement;
          tearOffDragImageTitle.className = "llm-tear-off-drag-image-title";
          bar.append(icon, tearOffDragImageTitle);
          tearOffDragImage.append(bar);
          root.append(tearOffDragImage);
        }
        tearOffDragImageTitle!.textContent = title;
        return tearOffDragImage;
      };

      // The follower's title, known while dragstart runs (the drag image is
      // taken right after it): the chat's listed title, else the label the
      // drag started on.
      const tearOffDragTitle = (
        identity: TornChatIdentity,
        source: HTMLElement,
      ): string => {
        const listed = standaloneSidebarEntriesByKey.get(
          identity.conversationKey,
        );
        if (identity.kind === "paper") {
          return normalizeHistoryTitle(listed?.title || "") || t("Paper chat");
        }
        const label =
          source.querySelector(".llm-standalone-conv-title") || source;
        return (
          normalizeHistoryTitle(listed?.title || "") ||
          normalizeHistoryTitle(label.textContent || "") ||
          t("Library chat")
        );
      };

      /**
       * A finished tear-off drag: opens the torn-off window where the drag
       * ended, unless it was cancelled, dropped back on its own source
       * region, or no point says where it ended.
       */
      const finishTearOffDrag = (
        event: DragEvent,
        identity: TornChatIdentity,
        drag: { droppedOnSource: boolean; lastDragPoint: ScreenPoint | null },
        source: "row" | "title",
      ): Window | null => {
        const transfer = event.dataTransfer;
        let userCancelled = false;
        try {
          userCancelled = Boolean((transfer as any)?.mozUserCancelled);
        } catch {
          userCancelled = false;
        }
        const screenX = Number(event.screenX);
        const screenY = Number(event.screenY);
        const point = tearOffDropPoint(screenX, screenY, drag.lastDragPoint);
        const dropScreen = readDropScreen(
          point?.screenX ?? 0,
          point?.screenY ?? 0,
          newWin,
        );
        const decision = classifyTearOffDragEnd({
          userCancelled,
          droppedOnSource: drag.droppedOnSource,
          screenX,
          screenY,
          lastDragPoint: drag.lastDragPoint,
          dropScreen,
          windowSize: {
            width: TORN_WINDOW_WIDTH_PX,
            height: TORN_WINDOW_HEIGHT_PX,
          },
          grabOffset: {
            x: TEAR_OFF_DRAG_IMAGE_GRAB_PX,
            y: TEAR_OFF_DRAG_IMAGE_GRAB_PX,
          },
        });
        // Kept for live checks of real desktop drags (no chat text).
        appLogger.debug("LLM: tear-off dragend", {
          source,
          userCancelled,
          droppedOnSource: drag.droppedOnSource,
          screenX,
          screenY,
          lastDragPoint: drag.lastDragPoint,
          dropEffect: String(transfer?.dropEffect || ""),
          dropScreen,
          decision,
        });
        if (decision.kind !== "open") return null;
        return openTornChatWindow(identity, {
          screenX: decision.screenX,
          screenY: decision.screenY,
        });
      };

      // Makes `region` a tear-off source region: it takes back its own
      // drag (so a release there opens nothing), records where the drag
      // goes, and finishes it. Installed once per region.
      const installTearOffRegion = (region: HTMLElement) => {
        const isOwnDrag = (event: DragEvent): boolean =>
          Boolean(
            activeTearOffDrag &&
            activeTearOffDrag.region === region &&
            Array.from(event.dataTransfer?.types || []).includes(TEAR_OFF_MIME),
          );
        const accept = (event: DragEvent) => {
          if (!isOwnDrag(event)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        };
        region.addEventListener("dragenter", accept);
        region.addEventListener("dragover", accept);
        region.addEventListener("drop", (event: DragEvent) => {
          if (!isOwnDrag(event)) return;
          event.preventDefault();
          activeTearOffDrag!.droppedOnSource = true;
        });
        region.addEventListener("drag", (event: DragEvent) => {
          const drag = activeTearOffDrag;
          if (!drag || drag.region !== region) return;
          const screenX = Number(event.screenX);
          const screenY = Number(event.screenY);
          if (isUsableDragPoint(screenX, screenY)) {
            drag.lastDragPoint = { screenX, screenY };
          }
        });
        region.addEventListener("dragend", (event: DragEvent) => {
          const drag = activeTearOffDrag;
          if (!drag || drag.region !== region) return;
          activeTearOffDrag = null;
          let carried: TornChatIdentity | null = null;
          try {
            carried = decodeTornChatIdentity(
              event.dataTransfer?.getData(TEAR_OFF_MIME) || "",
            );
          } catch {
            carried = null;
          }
          // The chat must still be one that may be torn off.
          if (!drag.getIdentity()) return;
          finishTearOffDrag(
            event,
            carried || drag.identity,
            drag,
            region === sidebarList ? "row" : "title",
          );
        });
      };

      // Makes `source` a tear-off drag source for the chat `getIdentity`
      // names at the moment the drag starts; `region` is its source region.
      const installTearOffDragSource = (
        source: HTMLElement,
        getIdentity: () => TornChatIdentity | null,
        region: HTMLElement,
      ) => {
        source.addEventListener("dragstart", (event: DragEvent) => {
          activeTearOffDrag = null;
          const identity = getIdentity();
          const transfer = event.dataTransfer;
          if (!identity || !transfer) {
            event.preventDefault();
            return;
          }
          // Only the plugin's own type: no text or URL a desktop or another
          // app could turn into a file.
          transfer.clearData();
          transfer.setData(TEAR_OFF_MIME, encodeTornChatIdentity(identity));
          transfer.effectAllowed = "move";
          try {
            // A release outside every window is the gesture, not a failure:
            // no image sliding back.
            (transfer as any).mozShowFailAnimation = false;
          } catch {
            /* chrome-only; the drag works without it */
          }
          try {
            // `drag` and `dragend` go to the region, which outlives the row.
            (transfer as any).addElement?.(region);
          } catch {
            /* they bubble up from the source instead */
          }
          try {
            transfer.setDragImage(
              renderTearOffDragImage(tearOffDragTitle(identity, source)),
              TEAR_OFF_DRAG_IMAGE_GRAB_PX,
              TEAR_OFF_DRAG_IMAGE_GRAB_PX,
            );
          } catch {
            /* the default image */
          }
          activeTearOffDrag = {
            identity,
            getIdentity,
            region,
            droppedOnSource: false,
            lastDragPoint: null,
          };
        });
      };

      // A torn-off window's title is never draggable, so on macOS it stays
      // part of the top row that moves the window.
      const syncTitleTearOff = () => {
        if (tearOffIdentityForTitle()) {
          contentTitleText.setAttribute("draggable", "true");
        } else {
          contentTitleText.removeAttribute("draggable");
        }
      };
      if (linkedToReader) {
        installTearOffRegion(sidebarList);
        installTearOffRegion(contentTitleBar);
        installTearOffDragSource(
          contentTitleText,
          tearOffIdentityForTitle,
          contentTitleBar,
        );
      }

      let convCtxEntry: SidebarConv | null = null;
      const hideConvCtxMenu = () => {
        convCtxMenu.style.display = "none";
        convCtxEntry = null;
      };
      sidebarList.addEventListener("contextmenu", (e: Event) => {
        const row = (e.target as Element | null)?.closest?.(
          ".llm-standalone-conv-item",
        ) as HTMLElement | null;
        if (!row || !sidebarList.contains(row)) return;
        hideConvCtxMenu();
        const entry = standaloneSidebarEntriesByKey.get(
          Number(row.dataset.conversationKey || 0),
        );
        if (!entry || !tearOffIdentityForEntry(entry)) return;
        e.preventDefault();
        e.stopPropagation();
        const me = e as MouseEvent;
        convCtxEntry = entry;
        convCtxMenu.style.display = "flex";
        const menuW = convCtxMenu.offsetWidth || 160;
        const menuH = convCtxMenu.offsetHeight || 40;
        let x = me.clientX + 4;
        let y = me.clientY + 4;
        if (x + menuW > (doc.documentElement?.clientWidth ?? 9999))
          x = me.clientX - menuW;
        if (y + menuH > (doc.documentElement?.clientHeight ?? 9999))
          y = me.clientY - menuH;
        convCtxMenu.style.left = `${Math.max(0, x)}px`;
        convCtxMenu.style.top = `${Math.max(0, y)}px`;
      });
      convCtxOpenInWindow.addEventListener("click", () => {
        const entry = convCtxEntry;
        hideConvCtxMenu();
        const identity = entry ? tearOffIdentityForEntry(entry) : null;
        if (identity) openTornChatWindow(identity);
      });
      doc.addEventListener("mousedown", (e: Event) => {
        if (convCtxMenu.style.display === "none") return;
        if (!convCtxMenu.contains(e.target as Node)) hideConvCtxMenu();
      });
      doc.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape" && convCtxMenu.style.display !== "none") {
          hideConvCtxMenu();
        }
      });

      const ensureConversationCatalogEntry = async (params: {
        conversationKey?: number;
        libraryID: number;
        kind: "global" | "paper";
        paperItemID?: number;
      }) =>
        conversationRepository.ensureCatalogEntry({
          system: currentConversationSystem,
          conversationKey: params.conversationKey,
          libraryID: params.libraryID,
          kind: params.kind,
          paperItemID: params.paperItemID,
        });

      // Ambient sidebar seeding: never resurrect a key whose deletion is queued
      // or just committed. A keyless paper ensure is a plain "give this paper a
      // conversation" request and stays allowed.
      const ensureActiveConversationCatalogEntry = async (params: {
        conversationKey?: number;
        libraryID: number;
        kind: "global" | "paper";
        paperItemID?: number;
      }) => {
        const key = Number(params.conversationKey || 0);
        if (
          key > 0 &&
          !(await shouldSeedConversationCatalogEntry({
            system: currentConversationSystem,
            kind: params.kind,
            conversationKey: key,
          }))
        ) {
          return null;
        }
        return ensureConversationCatalogEntry(params);
      };

      const toSidebarConversation = (
        entry: ConversationCatalogEntry,
      ): SidebarConv => ({
        conversationID: entry.conversationID,
        conversationKey: entry.conversationKey,
        kind: entry.kind,
        libraryID: entry.libraryID,
        lastActivityAt: entry.lastActivityAt || entry.createdAt || 0,
        createdAt: entry.createdAt || undefined,
        title: entry.title,
        userTurnCount: entry.userTurnCount,
        sessionVersion: entry.sessionVersion,
        paperItemID: entry.paperItemID,
        providerSessionId: entry.providerSessionId,
        scopedConversationKey: entry.scopedConversationKey,
        conversationSystem: entry.system,
        mode: entry.kind === "paper" ? "paper" : "open",
        ...(entry.webchatSession === true ? { webchatSession: true } : {}),
      });

      // -----------------------------------------------------------------------
      // Webchat mode UI updates for standalone window
      // -----------------------------------------------------------------------
      const updateStandaloneWebChatUI = (isWebChat: boolean) => {
        if (cancelled) return;
        isInWebChatMode = isWebChat;
        updateStandaloneSystemToggles();

        // Tab labels
        if (isWebChat) {
          syncPaperTabLabel();
          paperTab.classList.add("active");
          openTab.classList.remove("active");
          // Force paper tab active since webchat uses that slot
          if (standaloneMode !== "paper") {
            standaloneMode = "paper";
          }
        } else {
          // Restore the paper-slot label, not the currently mounted panel item.
          syncPaperTabLabel();
          paperTab.classList.toggle("active", standaloneMode === "paper");
          openTab.classList.toggle("active", standaloneMode === "open");
        }

        // Delete/Exit action — show "Exit" text only in WebChat.
        const deleteOrExitLabel = isWebChat
          ? t("Exit webchat and return to previous model")
          : t("Delete conversation");
        iconClear.title = deleteOrExitLabel;
        iconClear.setAttribute("aria-label", deleteOrExitLabel);
        iconClear.textContent = isWebChat ? t("Exit") : "";
        iconClear.classList.toggle("llm-standalone-icon-exit", isWebChat);

        // Keep original paper title — webchat mode is already indicated by tabs/mode chip
        updateContentTitle();
        webHistoryRefreshBtn.style.display = isWebChat ? "inline-flex" : "none";

        renderPinnedPapers();

        // Sidebar: populate with webchat history, or restore local history
        if (isWebChat) {
          void renderWebChatSidebar();
        } else {
          scheduleStandaloneSidebarRender();
        }
      };

      const resolveActiveWebChatHostname = async (): Promise<string | null> => {
        const [
          { relayGetStateSnapshot },
          { getWebChatTargetByModelName, WEBCHAT_TARGETS },
        ] = await Promise.all([
          import("../../webchat/relayServer"),
          import("../../webchat/types"),
        ]);
        const currentModelName =
          currentChatHooks?.getCurrentModelName?.() || null;
        const currentTargetHostname =
          getWebChatTargetByModelName(currentModelName || "")?.modelName ||
          null;
        if (currentTargetHostname) {
          return currentTargetHostname;
        }
        const activeTarget = relayGetStateSnapshot().active_target || null;
        return (
          WEBCHAT_TARGETS.find((target) => target.id === activeTarget)
            ?.modelName || null
        );
      };

      // Render webchat history items directly into the sidebar list
      let webChatSidebarRenderSeq = 0;
      const renderWebChatSidebar = async () => {
        if (cancelled || !isInWebChatMode) return;
        const mySeq = ++webChatSidebarRenderSeq;
        webHistoryRefreshBtn.disabled = true;
        clearSidebarList();

        // Loading indicator
        const loadingEl = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        loadingEl.className = "llm-standalone-sidebar-empty";
        loadingEl.textContent = t("Fetching…");
        sidebarList.appendChild(loadingEl);

        try {
          const requestedAt = Date.now();
          const [
            { relaySetCommand },
            {
              filterWebChatHistorySessionsForHostname,
              getWebChatHistorySiteSyncEntry,
              isWebChatHistorySiteFailure,
              waitForFreshChatHistorySnapshot,
            },
          ] = await Promise.all([
            import("../../webchat/relayServer"),
            import("../../webchat/client"),
          ]);
          const targetHostname = await resolveActiveWebChatHostname();

          relaySetCommand({ type: "SCRAPE_HISTORY" });

          let sessions: Array<{
            id: string;
            title: string;
            chatUrl: string | null;
          }> = [];
          let historyFetchFailed = false;
          try {
            const snapshot = await waitForFreshChatHistorySnapshot(
              "",
              targetHostname,
              requestedAt,
            );
            sessions = filterWebChatHistorySessionsForHostname(
              snapshot.sessions,
              targetHostname,
            );
            historyFetchFailed = isWebChatHistorySiteFailure(
              getWebChatHistorySiteSyncEntry(snapshot, targetHostname),
            );
          } catch {
            /* relay not reachable */
          }

          if (
            cancelled ||
            !isInWebChatMode ||
            mySeq !== webChatSidebarRenderSeq
          )
            return;
          loadingEl.remove();

          if (!sessions.length) {
            const emptyEl = doc.createElementNS(
              HTML_NS,
              "div",
            ) as HTMLDivElement;
            emptyEl.className = "llm-standalone-sidebar-empty";
            emptyEl.textContent = historyFetchFailed
              ? t("Failed to fetch history")
              : t("No conversations yet");
            sidebarList.appendChild(emptyEl);
            return;
          }

          for (const session of sessions) {
            const row = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            row.className = "llm-standalone-conv-item";
            row.type = "button";
            row.title = session.title || "Untitled";

            const titleEl = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            titleEl.className = "llm-standalone-conv-title";
            titleEl.textContent = session.title || "Untitled";

            row.appendChild(titleEl);
            row.addEventListener("click", () => {
              if (!activeItem) return;
              // Load the webchat conversation
              void (async () => {
                const key = getConversationKey(activeItem);
                const { getWebChatTargetByUrl } =
                  await import("../../webchat/types");
                const sessionTarget = getWebChatTargetByUrl(session.chatUrl);
                const isDeepSeekSession = sessionTarget?.id === "deepseek";
                try {
                  const loadModelName =
                    sessionTarget?.modelName || "chatgpt.com";

                  webChatIsolatedConversationKeys.add(key);
                  loadedConversationKeys.add(key);
                  chatHistory.set(key, [
                    {
                      role: "assistant" as const,
                      text: `Loading conversation: **${session.title || "Untitled"}**\n\nFetching messages…`,
                      timestamp: Date.now(),
                      modelName: loadModelName,
                      modelProviderLabel: "WebChat",
                      streaming: true,
                    },
                  ]);
                  refreshChat(contentArea, activeItem);

                  // Clear force-new-chat intent so follow-up sends
                  // continue in the loaded conversation, not start fresh.
                  currentChatHooks?.clearWebChatNewChatIntent?.();

                  const { loadChatSession } =
                    await import("../../webchat/client");
                  const result = await loadChatSession("", session.id);

                  if (cancelled || !isInWebChatMode) return;

                  const messages: Array<{
                    role: "user" | "assistant";
                    text: string;
                    timestamp: number;
                    modelName?: string;
                    modelProviderLabel?: string;
                    reasoningDetails?: string;
                    webchatChatUrl?: string;
                    webchatChatId?: string;
                  }> = [];

                  if (result?.messages?.length) {
                    for (const m of result.messages) {
                      messages.push({
                        role: m.kind === "user" ? "user" : "assistant",
                        text: m.text || "",
                        timestamp: m.timestamp
                          ? new Date(m.timestamp).getTime()
                          : Date.now(),
                        modelName: m.kind === "bot" ? loadModelName : undefined,
                        modelProviderLabel:
                          m.kind === "bot" ? "WebChat" : undefined,
                        reasoningDetails: m.thinking || undefined,
                        webchatChatUrl:
                          m.kind === "bot"
                            ? session.chatUrl || undefined
                            : undefined,
                        webchatChatId:
                          m.kind === "bot" ? session.id : undefined,
                      });
                    }
                  }

                  chatHistory.set(key, messages);
                  loadedConversationKeys.add(key);
                  webChatIsolatedConversationKeys.add(key);
                  refreshChat(contentArea, activeItem);
                } catch (err) {
                  appLogger.warn(
                    "LLM: standalone webchat sidebar load failed",
                    err,
                  );
                  chatHistory.set(key, [
                    {
                      role: "assistant" as const,
                      text: isDeepSeekSession
                        ? t("Failed to load selected DeepSeek conversation")
                        : t("Failed to load selected conversation"),
                      timestamp: Date.now(),
                      modelProviderLabel: "WebChat",
                    },
                  ]);
                  loadedConversationKeys.add(key);
                  webChatIsolatedConversationKeys.add(key);
                  refreshChat(contentArea, activeItem);
                }
              })();
            });

            sidebarList.appendChild(row);
          }
        } catch (err) {
          appLogger.warn("LLM: standalone webchat sidebar fetch failed", err);
          loadingEl.textContent = t("Failed to fetch history");
        } finally {
          webHistoryRefreshBtn.disabled = false;
        }
      };

      webHistoryRefreshBtn.addEventListener("click", () => {
        if (cancelled || !isInWebChatMode || webHistoryRefreshBtn.disabled)
          return;
        void renderWebChatSidebar();
      });

      // -----------------------------------------------------------------------
      // Mount chat UI into contentArea
      // -----------------------------------------------------------------------
      // A follower's title is the chat's own, read from its catalog entry
      // (the newest read wins; the last title read for each chat shows
      // meanwhile), and its kind line names the paper or the library.
      let followerTitleSeq = 0;
      let followerKindPaperID = 0;
      // Shows the chat's own paper in the main window's library tab, not the
      // paper the reader has open.
      const showFollowerPaperInLibrary = async () => {
        const itemID = followerKindPaperID;
        if (itemID <= 0 || cancelled || newWin.closed) return;
        try {
          const mainTabs = (Zotero.getMainWindow() as any)?.Zotero_Tabs;
          if (mainTabs && mainTabs.selectedID !== "zotero-pane") {
            mainTabs.select("zotero-pane");
          }
          await navigateToLibraryObject(
            { kind: "item", itemId: itemID, label: "" },
            createZoteroNavigationHost(),
          );
          if (mainTabs && mainTabs.selectedID !== "zotero-pane") {
            mainTabs.select("zotero-pane");
          }
        } catch (err) {
          appLogger.warn("LLM: follower show in library failed", err);
        }
      };
      followerKindLine?.addEventListener("click", (event: Event) => {
        const target = event.target as Element | null;
        if (!target?.closest?.(".llm-follower-kind-link")) return;
        void showFollowerPaperInLibrary();
      });
      const followerChatTitles = new Map<number, string>();
      const syncFollowerTitle = () => {
        const seq = ++followerTitleSeq;
        const conversationKey = activeConversationKey;
        const paper =
          standaloneMode === "paper" && currentBasePaperItem
            ? currentBasePaperItem
            : null;
        const identity: TornChatIdentity = paper
          ? {
              system: currentConversationSystem,
              conversationKey,
              kind: "paper",
              libraryID: getLibraryIDForPaperItem(paper),
              paperItemID: Number(paper.id || 0),
            }
          : {
              system: currentConversationSystem,
              conversationKey,
              kind: "global",
              libraryID: getCurrentLibraryScopeID(),
            };
        const kindLine = getFollowerKindLine(identity);
        if (followerKindLine) {
          // A paper chat's line is a button that shows the paper in the
          // library; a library chat's is plain text. Rebuilt on every sync so
          // an in-place switch changes both the target and the role.
          const isPaper = kindLine.kind === "paper";
          followerKindPaperID = paper ? Number(paper.id || 0) : 0;
          const main = doc.createElementNS(
            HTML_NS,
            isPaper ? "button" : "span",
          ) as HTMLButtonElement | HTMLSpanElement;
          main.className = "llm-follower-kind-main";
          const icon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          icon.className = "llm-follower-kind-icon";
          icon.dataset.kind = kindLine.kind;
          const text = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          text.className = "llm-follower-kind-text";
          text.textContent = kindLine.text;
          if (isPaper) {
            const label = t("Show in library");
            (main as HTMLButtonElement).type = "button";
            main.classList.add("llm-follower-kind-link");
            main.title = kindLine.tooltip
              ? `${label}: ${kindLine.tooltip}`
              : label;
            main.setAttribute("aria-label", label);
          }
          main.append(icon, text);
          followerKindIcon = icon;
          followerKindText = text;
          followerKindLine.replaceChildren(main);
          followerKindLine.dataset.kind = kindLine.kind;
        }
        const shown =
          followerChatTitles.get(conversationKey) ||
          (paper ? t("Paper chat") : t("Library chat"));
        contentTitleText.textContent = shown;
        contentTitleText.title = shown;
        void getFollowerTitle(identity).then((title) => {
          if (cancelled || newWin.closed || seq !== followerTitleSeq) return;
          followerChatTitles.set(conversationKey, title);
          contentTitleText.textContent = title;
          contentTitleText.title = title;
        });
      };

      const updateContentTitle = () => {
        if (!linkedToReader) {
          // Every switch in a torn-off window passes here (mount, in-place
          // switch, the panel's own switch), so the registry follows it.
          setTornWindowConversation(newWin, activeConversationKey);
          syncFollowerTitle();
        } else if (standaloneMode === "paper" && currentBasePaperItem) {
          try {
            const title =
              (currentBasePaperItem as any).getField?.("title") || "";
            contentTitleText.textContent = title || "Paper chat";
          } catch {
            contentTitleText.textContent = "Paper chat";
          }
        } else {
          contentTitleText.textContent = "Library chat";
        }
        syncTitleTearOff();
        syncPinButton();
      };

      const syncPinButton = () => {
        const paperID =
          standaloneMode === "paper"
            ? Number(currentBasePaperItem?.id || 0)
            : 0;
        iconPin.hidden = paperID <= 0;
        const pinned = paperID > 0 && pinnedPaperIDs.includes(paperID);
        iconPin.setAttribute("aria-pressed", pinned ? "true" : "false");
        const label = pinned ? t("Unpin this paper") : t("Pin this paper");
        iconPin.title = label;
        iconPin.setAttribute("aria-label", label);
      };

      // The window's own runtime (never the sidebar's saved one) decides the
      // portal item, unless a history row names its own runtime.
      const buildStandalonePortalItem = (params: {
        mode: "open" | "paper";
        conversationKey: number;
        paperItem?: Zotero.Item | null;
        sessionVersion?: number;
        system?: ConversationSystem;
      }): Zotero.Item | null => {
        const system = params.system || currentConversationSystem;
        if (params.mode === "open") {
          return system === "claude_code"
            ? (createClaudeGlobalPortalItem(
                getCurrentLibraryScopeID(),
                params.conversationKey,
              ) as Zotero.Item)
            : system === "codex"
              ? (createCodexGlobalPortalItem(
                  getCurrentLibraryScopeID(),
                  params.conversationKey,
                ) as Zotero.Item)
              : createGlobalPortalItem(
                  getCurrentLibraryScopeID(),
                  params.conversationKey,
                );
        }
        if (!params.paperItem) return null;
        return system === "claude_code"
          ? (createClaudePaperPortalItem(
              params.paperItem,
              params.conversationKey,
            ) as Zotero.Item)
          : system === "codex"
            ? (createCodexPaperPortalItem(
                params.paperItem,
                params.conversationKey,
              ) as Zotero.Item)
            : createPaperPortalItem(
                params.paperItem,
                params.conversationKey,
                params.sessionVersion || 1,
              );
      };

      const scheduleStandaloneSidebarRender = () => {
        if (cancelled || standaloneSidebarRenderQueued) return;
        standaloneSidebarRenderQueued = true;
        newWin.setTimeout(() => {
          standaloneSidebarRenderQueued = false;
          void renderSidebar();
          // A library chat's title can change with its history (its first
          // question names it).
          if (!linkedToReader) syncFollowerTitle();
        }, 0);
      };

      // Timing for the debug log of each conversation switch.
      const standaloneNowMs = (): number =>
        newWin.performance?.now?.() ?? Date.now();

      const mountChatPanel = (
        nextItem: Zotero.Item,
        rawContextItem?: Zotero.Item | null,
      ) => {
        const mountStartedAt = standaloneNowMs();
        const mountGeneration = ++standaloneMountGeneration;
        const isCurrentMount = () =>
          !cancelled &&
          !newWin.closed &&
          mountGeneration === standaloneMountGeneration;
        const resolvedState = resolveInitialPanelItemState(nextItem, {
          conversationSystem: currentConversationSystem,
          conversationMode: standaloneMode === "open" ? "global" : "paper",
          surface: windowSurface,
        });
        const mountedItem = resolvedState.item || nextItem;
        const rawItemForPanel =
          rawContextItem ||
          currentRawContextItem ||
          resolveConversationBaseItem(mountedItem) ||
          mountedItem;
        try {
          currentRawContextItem = rawItemForPanel;
          activeItem = mountedItem;
          currentConversationSystem =
            resolveConversationSystemForItem(mountedItem) ||
            currentConversationSystem;
          activeConversationKey = getConversationKey(mountedItem);
          if (
            initialRuntimeMode &&
            !initialRuntimeModeSeeded &&
            !isRuntimeConversationSystem()
          ) {
            if (!selectedRuntimeModeCache.has(activeConversationKey)) {
              selectedRuntimeModeCache.set(
                activeConversationKey,
                initialRuntimeMode,
              );
            }
            initialRuntimeModeSeeded = true;
          } else if (initialRuntimeMode && !initialRuntimeModeSeeded) {
            initialRuntimeModeSeeded = true;
          }

          if (standaloneMode === "paper" && currentBasePaperItem) {
            const paperItemID = Number(currentBasePaperItem.id || 0);
            if (paperItemID > 0) {
              const paperLibraryID = getCurrentPaperLibraryID();
              rememberStandalonePaperConversation(
                currentConversationSystem,
                paperLibraryID,
                paperItemID,
                activeConversationKey,
                windowSurface,
              );
              shownPaperConversationKeys.set(
                paperItemID,
                activeConversationKey,
              );
              readyPinnedPaperIDs.delete(paperItemID);
            }
          }

          clearContent();
          updateContentTitle();
          renderPinnedPapers();

          let standaloneInputFitRequestId = 0;
          const cancelPendingStandaloneInputFit = () => {
            standaloneInputFitRequestId += 1;
          };
          const scheduleStandaloneInputFit = () => {
            if (cancelled || newWin.closed) return;
            const fitRequestId = (standaloneInputFitRequestId += 1);
            const inputSection = contentArea.querySelector(
              ".llm-input-section",
            ) as HTMLElement | null;
            scheduleStandaloneWindowFitForElement(newWin, inputSection, {
              shouldRun: () => fitRequestId === standaloneInputFitRequestId,
            });
          };
          const scheduleStandaloneInputFitAfterContextPreviewRender = (
            metrics: ContextPreviewRenderMetrics,
          ) => {
            if (metrics.nextHeight <= metrics.previousHeight) {
              cancelPendingStandaloneInputFit();
              return;
            }
            scheduleStandaloneInputFit();
          };
          const chatHooks: SetupHandlersHooks = {
            onConversationHistoryChanged: () => {
              if (cancelled) return;
              scheduleStandaloneSidebarRender();
            },
            onConversationIdentityChanged: (panelItem, panelKey) => {
              if (cancelled || newWin.closed) return;
              if (
                decidePanelIdentityAdoption(activeConversationKey, panelKey) ===
                "ignore"
              ) {
                return;
              }
              // The panel switched by itself (its own New chat button or a
              // deleted chat's fallback). Follow it. This only sets window
              // state and redraws views; it never asks the panel to switch,
              // so it cannot loop back into this hook.
              const leftKey = activeConversationKey;
              activeConversationKey = panelKey;
              activeItem = panelItem;
              if (standaloneMode === "paper" && currentBasePaperItem) {
                const paperItemID = Number(currentBasePaperItem.id || 0);
                if (paperItemID > 0) {
                  rememberStandalonePaperConversation(
                    currentConversationSystem,
                    getCurrentPaperLibraryID(),
                    paperItemID,
                    panelKey,
                    windowSurface,
                  );
                }
              }
              updateContentTitle();
              syncPaperTabLabel();
              const leftEntry = standaloneSidebarEntriesByKey.get(leftKey);
              if (
                !markStandaloneSidebarActiveRow(panelKey) ||
                (leftEntry && !(Number(leftEntry.userTurnCount) > 0))
              ) {
                scheduleStandaloneSidebarRender();
              }
              try {
                standaloneSidePanel?.onMainMounted();
              } catch (err) {
                appLogger.warn("LLM: standalone side panel follow failed", err);
              }
            },
            onDefaultContextRendered: scheduleStandaloneInputFit,
            onContextPreviewRendered:
              scheduleStandaloneInputFitAfterContextPreviewRender,
            onWebChatModeChanged: (isWebChat) => {
              if (cancelled) return;
              updateStandaloneWebChatUI(isWebChat);
            },
            prepareItemsAsDefaultContextTarget: async () => {
              if (cancelled || newWin.closed) return;
              return await createStandaloneOpenConversationForContext();
            },
            // The runtime badge menu: the window owns its runtime, and the
            // sidebar's stays as it is.
            requestConversationSystem: (system) => {
              if (cancelled || newWin.closed) return;
              void switchConversationSystem(system, { forceFresh: true });
            },
          };
          const llmMain = mountPanelShell({
            body: contentArea,
            renderItem: mountedItem,
            beforeRegister: (panelRoot) => {
              // The left tab represents the preserved paper-side slot, so do
              // not derive its label from a mounted global portal item.
              syncPaperTabLabel();
              if (panelRoot) panelRoot.dataset.standalone = "true";
              bindStandalonePanelHost(contentArea, mountedItem, windowSurface);
            },
            // Live: the standalone window re-points activeItem in place.
            getMountedItem: () => activeItem,
            rawItem: rawItemForPanel,
            retainFor: mountedItem,
            setupItem: mountedItem,
            hooks: chatHooks,
          });
          // Store hooks reference so webchat load handlers can call clearWebChatNewChatIntent
          currentChatHooks = chatHooks;

          refreshChat(contentArea, mountedItem);
          applyPanelFontScale(llmMain);
          applyPanelFontScale(root);
          const shortcutMode = standaloneMode === "open" ? "library" : "paper";
          void renderShortcuts(contentArea, mountedItem, shortcutMode);
        } catch (err) {
          appLogger.warn("LLM: standalone mountChatPanel sync failed", err);
        }
        // The side panel follows the main chat (mode, paper, conversation).
        try {
          standaloneSidePanel?.onMainMounted();
        } catch (err) {
          appLogger.warn("LLM: standalone side panel follow failed", err);
        }
        const mountSyncMs = standaloneNowMs() - mountStartedAt;

        void (async () => {
          try {
            if (!isCurrentMount()) return;
            await ensureConversationLoaded(mountedItem, {
              body: contentArea,
            });
            if (!isCurrentMount()) return;
            refreshChat(contentArea, mountedItem);
            // Refresh sidebar after conversation is confirmed loaded
            scheduleStandaloneSidebarRender();
            appLogger.debug("LLM: standalone conversation shown", {
              path: "remount",
              conversationKey: activeConversationKey,
              syncMs: Math.round(mountSyncMs * 10) / 10,
              totalMs:
                Math.round((standaloneNowMs() - mountStartedAt) * 10) / 10,
            });
          } catch (err) {
            appLogger.warn("LLM: standalone mount async failed", err);
          }
        })();
      };

      /**
       * Marks `conversationKey`'s row in the History list as the active one,
       * without reading the list again. Returns false when the list has no
       * row for it (the list content changed: render it again).
       */
      const markStandaloneSidebarActiveRow = (
        conversationKey: number,
      ): boolean => {
        let found = false;
        for (const row of Array.from(
          sidebarList.querySelectorAll(".llm-standalone-conv-item"),
        ) as HTMLElement[]) {
          const isActive =
            Number(row.dataset.conversationKey || 0) === conversationKey;
          row.classList.toggle("active", isActive);
          if (isActive) found = true;
        }
        return found;
      };

      /**
       * Shows `nextItem`'s conversation in the mounted panel. When the panel
       * can move there in place (same runtime, mode, library and paper; see
       * standaloneConversationSwitch.ts), it keeps its DOM, listeners and
       * controllers and swaps only the conversation, which it draws once.
       * Otherwise, or when the in-place switch is refused, this is the full
       * remount (mountChatPanel).
       *
       * In place, the window's History list is not read again: the switch
       * marks the active row, and renders the list again only when the row
       * is missing or the chat being left was an empty draft (the list
       * collapses duplicate drafts around the active chat). Chat-list
       * changes still reach the list through the panel's history hook.
       *
       * The window's state moves at once, as with a mount. The promise
       * settles once the panel shows the conversation (in place, or rebuilt
       * after a refused switch), or a newer switch took over; it never
       * rejects. Callers that act on the panel's conversation next (adding
       * context to it) wait for it.
       */
      const showStandaloneConversation = (
        nextItem: Zotero.Item,
        rawContextItem?: Zotero.Item | null,
      ): Promise<void> => {
        const startedAt = standaloneNowMs();
        const resolvedState = resolveInitialPanelItemState(nextItem, {
          conversationSystem: currentConversationSystem,
          conversationMode: standaloneMode === "open" ? "global" : "paper",
          surface: windowSurface,
        });
        const targetItem = resolvedState.item || nextItem;
        const handle = getPanelHandle(contentArea);
        const decision = handle?.resolveConversationSwitch(targetItem) || {
          inPlace: false as const,
          reason: "no-panel" as const,
        };
        if (!handle || !decision.inPlace) {
          appLogger.debug("LLM: standalone conversation switch remounts", {
            reason: decision.inPlace ? "no-panel" : decision.reason,
          });
          mountChatPanel(nextItem, rawContextItem);
          return Promise.resolve();
        }
        try {
          return switchStandaloneConversationInPlace(
            handle,
            targetItem,
            rawContextItem,
            startedAt,
          );
        } catch (err) {
          // A throw before the switch started leaves the window half-moved;
          // a rebuild puts it back in one consistent state.
          appLogger.warn("LLM: standalone in-place switch failed", err);
          mountChatPanel(nextItem, rawContextItem);
          return Promise.resolve();
        }
      };
      const switchStandaloneConversationInPlace = (
        handle: NonNullable<ReturnType<typeof getPanelHandle>>,
        targetItem: Zotero.Item,
        rawContextItem: Zotero.Item | null | undefined,
        startedAt: number,
      ): Promise<void> => {
        const switchGeneration = ++standaloneMountGeneration;
        const isCurrentSwitch = () =>
          !cancelled &&
          !newWin.closed &&
          switchGeneration === standaloneMountGeneration;
        // Callers may already have moved activeConversationKey; the chat
        // being left is the one the panel shows.
        const shownItem = activeContextPanels.get(contentArea)?.() || null;
        const previousKey = shownItem ? getConversationKey(shownItem) : 0;
        const rawItemForPanel =
          rawContextItem ||
          currentRawContextItem ||
          resolveConversationBaseItem(targetItem) ||
          targetItem;
        // The window's own state, as mountChatPanel writes it. The runtime is
        // unchanged: an in-place switch never changes it.
        currentRawContextItem = rawItemForPanel;
        activeItem = targetItem;
        activeConversationKey = getConversationKey(targetItem);
        if (standaloneMode === "paper" && currentBasePaperItem) {
          const paperItemID = Number(currentBasePaperItem.id || 0);
          if (paperItemID > 0) {
            rememberStandalonePaperConversation(
              currentConversationSystem,
              getCurrentPaperLibraryID(),
              paperItemID,
              activeConversationKey,
              windowSurface,
            );
          }
        }
        updateContentTitle();
        syncPaperTabLabel();
        // As a mount does, bind the host to the item shown. The new binding
        // also retires the panel leases taken for the chat being left, so a
        // request still running there keeps saving but no longer draws here.
        bindStandalonePanelHost(contentArea, targetItem, windowSurface);
        activeContextPanelRawItems.set(contentArea, rawItemForPanel);
        const leftEntry = standaloneSidebarEntriesByKey.get(previousKey);
        if (
          !markStandaloneSidebarActiveRow(activeConversationKey) ||
          (leftEntry && !(Number(leftEntry.userTurnCount) > 0))
        ) {
          scheduleStandaloneSidebarRender();
        }
        const remountInstead = (reason: string, err?: unknown) => {
          if (!isCurrentSwitch()) return;
          (err ? appLogger.warn : appLogger.debug)(
            "LLM: standalone in-place switch refused",
            { reason, error: err },
          );
          mountChatPanel(targetItem, rawItemForPanel);
        };
        return handle.switchConversationInPlace(targetItem).then(
          (switched) => {
            if (!isCurrentSwitch()) return;
            const panelItem = activeContextPanels.get(contentArea)?.() || null;
            if (
              !switched ||
              !panelItem ||
              getConversationKey(panelItem) !== activeConversationKey
            ) {
              remountInstead(switched ? "other-conversation" : "refused");
              return;
            }
            activeItem = panelItem;
            try {
              standaloneSidePanel?.onMainMounted();
            } catch (err) {
              appLogger.warn("LLM: standalone side panel follow failed", err);
            }
            appLogger.debug("LLM: standalone conversation shown", {
              path: "in-place",
              conversationKey: activeConversationKey,
              totalMs: Math.round((standaloneNowMs() - startedAt) * 10) / 10,
            });
          },
          (err) => remountInstead("error", err),
        );
      };

      // -----------------------------------------------------------------------
      // Sidebar rendering — supports both open chat and paper chat
      // -----------------------------------------------------------------------
      // The runtimes whose chats the window's lists show: the built-in one and
      // the ones on in Preferences; a note session shows only its own.
      const getStandaloneHistorySystems = (): ConversationSystem[] =>
        resolveUnifiedHistorySystems({
          activeSystem: currentConversationSystem,
          codexEnabled: isCodexAppServerModeEnabled(),
          claudeEnabled: getClaudeCodeModeEnabled(),
          singleSystem: Boolean(resolveActiveNoteSession(activeItem)),
        });

      // Agent / Codex / Claude sections: their order, which are folded, each
      // one's own sort and dates, and the list last drawn (so a change
      // redraws without a reload).
      let sidebarGroupOrder = getStandaloneSidebarGroupOrderPref();
      const sidebarCollapsedGroups = new Set(
        getStandaloneSidebarCollapsedGroupsPref(),
      );
      const sidebarSectionOptions = getStandaloneSidebarSectionOptionsPref();
      let lastSidebarConversations: SidebarConv[] | null = null;
      // The section whose sort button opened the shared sort menu.
      let sidebarSortMenuKey: StandaloneSidebarGroupKey | null = null;
      const sidebarSortButtonFor = (key: StandaloneSidebarGroupKey | null) =>
        key
          ? (sidebarList.querySelector(
              `.llm-standalone-conv-group[data-group-key="${key}"] .llm-standalone-conv-group-sort`,
            ) as HTMLButtonElement | null)
          : null;
      const syncSidebarSortControls = (key: StandaloneSidebarGroupKey) => {
        const options = getStandaloneSidebarSectionOptions(
          sidebarSectionOptions,
          key,
        );
        for (const [order, item] of sidebarView.historySortItems) {
          item.setAttribute("aria-checked", String(order === options.sort));
        }
        sidebarView.historyShowDatesItem.setAttribute(
          "aria-checked",
          String(options.showDates),
        );
      };
      const setSidebarSortMenuOpen = (
        open: boolean,
        key: StandaloneSidebarGroupKey | null = sidebarSortMenuKey,
      ) => {
        const menu = sidebarView.historySortMenu;
        sidebarSortButtonFor(sidebarSortMenuKey)?.setAttribute(
          "aria-expanded",
          "false",
        );
        if (!open || !key) {
          menu.hidden = true;
          sidebarSortMenuKey = null;
          return;
        }
        const button = sidebarSortButtonFor(key);
        if (!button) return;
        sidebarSortMenuKey = key;
        syncSidebarSortControls(key);
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        const panelRect = sidebarPanel.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        menu.style.top = `${Math.round(buttonRect.bottom - panelRect.top + 4)}px`;
        menu.style.right = `${Math.max(
          4,
          Math.round(panelRect.right - buttonRect.right),
        )}px`;
        sidebarView.historySortItems
          .get(
            getStandaloneSidebarSectionOptions(sidebarSectionOptions, key).sort,
          )
          ?.focus();
      };
      const redrawSidebarSections = (focusKey?: StandaloneSidebarGroupKey) => {
        if (isInWebChatMode) return;
        if (!lastSidebarConversations) {
          scheduleStandaloneSidebarRender();
          return;
        }
        renderSidebarItems(lastSidebarConversations);
        if (focusKey) {
          (
            sidebarList.querySelector(
              `.llm-standalone-conv-group[data-group-key="${focusKey}"]`,
            ) as HTMLElement | null
          )?.focus();
        }
      };
      sidebarView.historySortMenu.addEventListener("click", (event) => {
        event.stopPropagation();
        const key = sidebarSortMenuKey;
        const item = (event.target as Element | null)?.closest?.(
          ".llm-standalone-history-sort-item",
        ) as HTMLButtonElement | null;
        if (!item || !key) return;
        const options = {
          ...getStandaloneSidebarSectionOptions(sidebarSectionOptions, key),
        };
        if (item.dataset.sortOrder) {
          options.sort = item.dataset.sortOrder as StandaloneSidebarSortOrder;
        } else if (item.dataset.sortToggle === "dates") {
          options.showDates = !options.showDates;
        }
        sidebarSectionOptions.set(key, options);
        setStandaloneSidebarSectionOptionsPref(sidebarSectionOptions);
        if (item.dataset.sortOrder) {
          redrawSidebarSections();
          sidebarSortButtonFor(key)?.focus();
        } else {
          // Keep the menu open on its toggle, over the redrawn list.
          redrawSidebarSections();
          setSidebarSortMenuOpen(true, key);
          sidebarView.historyShowDatesItem.focus();
        }
      });
      sidebarView.historySortMenu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          const key = sidebarSortMenuKey;
          setSidebarSortMenuOpen(false);
          sidebarSortButtonFor(key)?.focus();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = Array.from(
          sidebarView.historySortMenu.querySelectorAll(
            ".llm-standalone-history-sort-item",
          ),
        ) as HTMLButtonElement[];
        const index = items.indexOf(doc.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      });
      doc.addEventListener("mousedown", (event) => {
        const target = event.target as Element | null;
        if (
          target &&
          (sidebarView.historySortMenu.contains(target) ||
            target.closest?.(".llm-standalone-conv-group-sort"))
        ) {
          return;
        }
        setSidebarSortMenuOpen(false);
      });

      // Section labels: click (or Enter) folds the section, the sort button
      // at the end sets its order, and dragging a label (or Alt+Up/Down)
      // moves the section.
      const toggleSidebarGroup = (key: StandaloneSidebarGroupKey) => {
        if (sidebarCollapsedGroups.has(key)) sidebarCollapsedGroups.delete(key);
        else sidebarCollapsedGroups.add(key);
        setStandaloneSidebarCollapsedGroupsPref(
          Array.from(sidebarCollapsedGroups),
        );
        redrawSidebarSections(key);
      };
      // A section's "+": a new chat in the window's own mode works like the
      // new chat button; another mode switches the window to it, fresh.
      const startSidebarSectionChat = (key: StandaloneSidebarGroupKey) => {
        if (cancelled || newWin.closed) return;
        if (key === currentConversationSystem) {
          iconNewChat.click();
          return;
        }
        void switchConversationSystem(key, { forceFresh: true });
      };
      const createSidebarGroupHeader = (
        key: StandaloneSidebarGroupKey,
        count: number,
      ): HTMLDivElement => {
        const label = t(getStandaloneSidebarGroupLabel(key));
        const header = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        header.className = "llm-standalone-conv-group";
        header.dataset.groupKey = key;
        header.tabIndex = 0;
        header.setAttribute("role", "button");
        const collapsed = sidebarCollapsedGroups.has(key);
        header.setAttribute("aria-expanded", String(!collapsed));
        if (collapsed) header.dataset.collapsed = "true";
        header.title = t(
          collapsed
            ? "Click to expand, drag to reorder"
            : "Click to collapse, drag to reorder",
        );
        header.addEventListener("click", () => toggleSidebarGroup(key));
        header.addEventListener("keydown", (event) => {
          if (event.target !== header) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleSidebarGroup(key);
        });
        const name = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
        name.className = "llm-standalone-conv-group-name";
        name.textContent = label;
        const chevron = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
        chevron.className = "llm-standalone-conv-group-chevron";
        chevron.setAttribute("aria-hidden", "true");
        const countSpan = doc.createElementNS(
          HTML_NS,
          "span",
        ) as HTMLSpanElement;
        countSpan.className = "llm-standalone-conv-group-count";
        countSpan.textContent = String(count);
        const sortButton = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        sortButton.className = "llm-standalone-conv-group-sort";
        sortButton.type = "button";
        sortButton.title = t("Sort");
        sortButton.setAttribute("aria-label", `${t("Sort")}: ${label}`);
        sortButton.setAttribute("aria-haspopup", "menu");
        sortButton.setAttribute("aria-expanded", "false");
        sortButton.addEventListener("click", (event) => {
          event.stopPropagation();
          setSidebarSortMenuOpen(sidebarSortMenuKey !== key, key);
        });
        // "+" starts a new chat in this section's mode.
        const newButton = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        newButton.className = "llm-standalone-conv-group-new";
        newButton.type = "button";
        newButton.title = `${t("New chat")}: ${label}`;
        newButton.setAttribute("aria-label", `${t("New chat")}: ${label}`);
        newButton.addEventListener("click", (event) => {
          event.stopPropagation();
          startSidebarSectionChat(key);
        });
        header.setAttribute(
          "aria-label",
          `${label} (${count}). ${t("Alt+Up or Alt+Down to reorder")}`,
        );
        header.append(name, countSpan, chevron, sortButton, newButton);
        return header;
      };
      installStandaloneSidebarGroupDrag({
        list: sidebarList,
        onMove: (key, toIndex) => {
          const visible = Array.from(
            sidebarList.querySelectorAll(".llm-standalone-conv-group"),
          ).map(
            (el) => (el as HTMLElement).dataset.groupKey,
          ) as StandaloneSidebarGroupKey[];
          sidebarGroupOrder = moveStandaloneSidebarGroup(
            sidebarGroupOrder,
            key as StandaloneSidebarGroupKey,
            toIndex,
            visible,
          );
          setStandaloneSidebarGroupOrderPref(sidebarGroupOrder);
          redrawSidebarSections(key as StandaloneSidebarGroupKey);
        },
      });

      const renderSidebarItems = (conversations: SidebarConv[]) => {
        setSidebarSortMenuOpen(false);
        lastSidebarConversations = conversations;
        clearSidebarList();
        const visibleConversations =
          collapseDuplicateReusableConversationDrafts({
            entries: conversations,
            activeConversationKey,
          }).filter(
            (conv) =>
              !pendingDeletionStore.isConversationPendingDeletion(
                conv.conversationKey,
              ),
          );
        standaloneSidebarEntriesByKey = new Map(
          conversations.map((conv) => [conv.conversationKey, conv]),
        );

        if (visibleConversations.length === 0) {
          const emptyMsg = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          emptyMsg.className = "llm-standalone-sidebar-empty";
          emptyMsg.textContent = t("No conversations yet");
          sidebarList.appendChild(emptyMsg);
          return;
        }

        const now = Date.now();
        const sections = groupStandaloneSidebarEntries(
          visibleConversations,
          sidebarGroupOrder,
          currentConversationSystem,
        );
        for (const section of sections) {
          if (section.key) {
            sidebarList.appendChild(
              createSidebarGroupHeader(section.key, section.items.length),
            );
            if (sidebarCollapsedGroups.has(section.key)) continue;
          }
          // The section's rows sit in one box, so its guide line can show
          // while the mouse is over the section.
          const sectionRowsBox = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          sectionRowsBox.className = "llm-standalone-conv-section-rows";
          sidebarList.appendChild(sectionRowsBox);
          const sectionOptions = getStandaloneSidebarSectionOptions(
            sidebarSectionOptions,
            section.key,
          );
          for (const conv of sortStandaloneSidebarEntries(
            section.items,
            sectionOptions.sort,
          )) {
            const btn = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
            btn.className = "llm-standalone-conv-item";
            if (conv.conversationKey === activeConversationKey) {
              btn.classList.add("active");
            }
            btn.setAttribute("role", "button");
            btn.tabIndex = 0;
            btn.dataset.conversationKey = String(conv.conversationKey);
            btn.dataset.conversationSystem =
              conv.conversationSystem || currentConversationSystem;
            if (conv.sessionVersion !== undefined) {
              btn.dataset.sessionVersion = String(conv.sessionVersion);
            }
            const titleSpan = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            titleSpan.className = "llm-standalone-conv-title";
            titleSpan.textContent = conv.title || t("Untitled chat");
            const renameBtn = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            renameBtn.className = "llm-standalone-conv-rename";
            renameBtn.type = "button";
            renameBtn.setAttribute("aria-label", t("Rename chat"));
            renameBtn.title = t("Rename chat");
            renameBtn.dataset.action = "rename";
            const deleteBtn = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            deleteBtn.className = "llm-standalone-conv-delete";
            deleteBtn.type = "button";
            deleteBtn.setAttribute("aria-label", t("Delete conversation"));
            deleteBtn.title = t("Delete conversation");
            deleteBtn.dataset.action = "delete";
            btn.append(
              createHistoryActivityIndicator(
                doc,
                conv.conversationKey,
                t("Working"),
              ),
              titleSpan,
            );
            // The section label names the runtime, so rows carry no tag.
            if (sectionOptions.showDates) {
              const time = getStandaloneSidebarEntryTime(
                conv,
                sectionOptions.sort,
              );
              const dateText = formatStandaloneSidebarShortDate(time, {
                now,
                translate: t,
              });
              if (dateText) {
                const dateSpan = doc.createElementNS(
                  HTML_NS,
                  "span",
                ) as HTMLSpanElement;
                dateSpan.className = "llm-standalone-conv-date";
                dateSpan.textContent = dateText;
                dateSpan.title = new Date(time).toLocaleString();
                btn.appendChild(dateSpan);
              }
            }
            btn.append(renameBtn, deleteBtn);
            btn.title = conv.title || t("Untitled chat");
            if (tearOffIdentityForEntry(conv)) {
              btn.setAttribute("draggable", "true");
              installTearOffDragSource(
                btn,
                () => tearOffIdentityForEntry(conv),
                sidebarList,
              );
            }
            sectionRowsBox.appendChild(btn);
          }
        }
      };

      // A follower has no chat list. It only makes sure the chat it shows
      // has a catalog entry, as the list's render does, once per chat.
      let followerSeededConversationKey = 0;
      const seedFollowerConversation = async () => {
        const key = activeConversationKey;
        if (key <= 0 || key === followerSeededConversationKey) return;
        followerSeededConversationKey = key;
        try {
          if (standaloneMode === "open") {
            await ensureActiveConversationCatalogEntry({
              conversationKey: key,
              libraryID: getCurrentLibraryScopeID(),
              kind: "global",
            });
          } else if (currentBasePaperItem) {
            await ensureActiveConversationCatalogEntry({
              conversationKey: key,
              libraryID: Number(currentBasePaperItem.libraryID || libraryID),
              kind: "paper",
              paperItemID: Number(currentBasePaperItem.id || 0),
            });
          }
        } catch (err) {
          appLogger.warn("LLM: follower catalog seed failed", err);
        }
      };

      const renderSidebar = async () => {
        if (cancelled) return;
        // In webchat mode, sidebar is managed by renderWebChatSidebar() — skip local rendering
        if (isInWebChatMode) return;
        if (!linkedToReader) {
          await seedFollowerConversation();
          return;
        }
        appLogger.debug(
          "LLM: standalone renderSidebar",
          "mode=" + standaloneMode,
          "hasBasePaper=" + Boolean(currentBasePaperItem),
          "basePaperId=" + (currentBasePaperItem?.id ?? "null"),
          "activeConvKey=" + activeConversationKey,
        );
        try {
          if (standaloneMode === "open") {
            const currentLibraryID = getCurrentLibraryScopeID();
            if (activeConversationKey > 0) {
              await ensureActiveConversationCatalogEntry({
                conversationKey: activeConversationKey,
                libraryID: currentLibraryID,
                kind: "global",
              });
            }
            const conversations = (
              await listUnifiedHistoryEntries({
                libraryID: currentLibraryID,
                scope: "global",
                systems: getStandaloneHistorySystems(),
                activeSystem: currentConversationSystem,
                limit: 50,
              })
            ).map(toSidebarConversation);
            if (cancelled) return;
            renderSidebarItems(conversations);
          } else {
            if (!currentBasePaperItem) {
              appLogger.debug(
                "LLM: standalone renderSidebar paper mode — currentBasePaperItem is null",
              );
              clearSidebarList();
              return;
            }
            const paperID = Number(currentBasePaperItem.id || 0);
            const paperLibID = Number(
              currentBasePaperItem.libraryID || libraryID,
            );
            appLogger.debug(
              "LLM: standalone renderSidebar paper query",
              "paperID=" + paperID,
              "libraryID=" + paperLibID,
            );
            await ensureActiveConversationCatalogEntry({
              conversationKey:
                activeConversationKey > 0 ? activeConversationKey : undefined,
              libraryID: paperLibID,
              kind: "paper",
              paperItemID: paperID,
            });
            const conversations = (
              await listUnifiedHistoryEntries({
                libraryID: paperLibID,
                scope: "paper",
                paperItemID: paperID,
                systems: getStandaloneHistorySystems(),
                activeSystem: currentConversationSystem,
                limit: 50,
              })
            ).map(toSidebarConversation);
            if (cancelled) return;
            renderSidebarItems(conversations);
          }
        } catch (err) {
          appLogger.warn("LLM: standalone sidebar render failed", err);
        }
      };

      // -----------------------------------------------------------------------
      // Search popup logic
      // -----------------------------------------------------------------------
      const searchDocCache = new Map<
        number,
        { fingerprint: string; document: HistorySearchDocument }
      >();

      const resolvePaperLabel = (paperItemID: number | undefined): string => {
        if (!paperItemID) return t("Library chat");
        try {
          const paperItem = resolveHistoryEntryPaperBaseItem(
            { paperItemID },
            (id) => Zotero.Items.get(id) as Zotero.Item | null,
          );
          if (!paperItem) return t("Paper chat");
          let firstCreator = "";
          let year = "";
          try {
            firstCreator = (paperItem as any).getField("firstCreator") || "";
          } catch {
            /* */
          }
          try {
            year = (paperItem as any).getField("year") || "";
          } catch {
            /* */
          }
          if (firstCreator && year) return `${firstCreator}, ${year}`;
          if (firstCreator) return firstCreator;
          if (year) return year;
          return t("Paper chat");
        } catch {
          return t("Paper chat");
        }
      };

      const resolvePaperSearchScopeLabel = (
        paperItemID: number | undefined,
        sourceState: ConversationHistoryEntry["sourceState"] = "active",
      ): string => {
        if (sourceState === "orphan") return t("Orphan");
        if (!paperItemID) return t("Library chat");
        try {
          const paperItem = resolveHistoryEntryPaperBaseItem(
            { paperItemID },
            (id) => Zotero.Items.get(id) as Zotero.Item | null,
          );
          const title = String(paperItem?.getField?.("title") || "").trim();
          return title || resolvePaperLabel(paperItemID);
        } catch {
          return resolvePaperLabel(paperItemID);
        }
      };

      const toStandaloneHistoryEntry = (
        entry: SidebarConv,
      ): ConversationHistoryEntry => {
        const isPaper = entry.mode === "paper";
        const title = normalizeHistoryTitle(entry.title) || t("Untitled chat");
        const sourceState = resolveHistoryEntrySourceState(
          {
            kind: isPaper ? "paper" : "global",
            paperItemID: entry.paperItemID,
          },
          (id) => Zotero.Items.get(id) as Zotero.Item | null,
        );
        return {
          system: entry.conversationSystem || currentConversationSystem,
          kind: isPaper ? "paper" : "global",
          sourceState,
          section: isPaper ? "paper" : "open",
          sectionTitle: isPaper
            ? resolvePaperSearchScopeLabel(entry.paperItemID, sourceState)
            : t("Library chat"),
          conversationID: entry.conversationID,
          conversationKey: entry.conversationKey,
          libraryID: entry.libraryID || getCurrentLibraryScopeID(),
          title,
          timestampText:
            formatGlobalHistoryTimestamp(entry.lastActivityAt) ||
            (isPaper ? t("Paper chat") : t("Library chat")),
          deletable: true,
          isDraft: false,
          isPendingDelete: false,
          lastActivityAt: entry.lastActivityAt,
          userTurnCount: entry.userTurnCount,
          paperItemID: entry.paperItemID,
          sessionVersion: entry.sessionVersion,
          providerSessionId: entry.providerSessionId,
          scopedConversationKey: entry.scopedConversationKey,
        };
      };

      // Every chat of the listed runtimes in this library: the Search history
      // popup and the side panel's History tab read it. Empty chats of other
      // runtimes are left out.
      const loadAllStandaloneSearchEntries = async (): Promise<
        ConversationHistoryEntry[]
      > => {
        const libraryID = getCurrentLibraryScopeID();
        const limit = 100;
        const activeSystem = currentConversationSystem;
        const loadSystemEntries = async (
          system: ConversationSystem,
        ): Promise<SidebarConv[]> => {
          if (system === "claude_code" || system === "codex") {
            const summaries =
              system === "claude_code"
                ? await loadAllClaudeConversationHistory({ libraryID, limit })
                : await loadAllCodexConversationHistory({ libraryID, limit });
            return summaries.map((entry) => ({
              conversationKey: entry.conversationKey,
              conversationID: entry.conversationID,
              conversationSystem: system,
              libraryID,
              lastActivityAt: entry.lastActivityAt,
              title: entry.title,
              userTurnCount: entry.userTurnCount,
              paperItemID: entry.paperItemID,
              providerSessionId: entry.providerSessionId,
              scopedConversationKey: entry.scopedConversationKey,
              mode: entry.kind === "paper" ? "paper" : "open",
            }));
          }
          return (await loadAllConversationHistory({ libraryID, limit })).map(
            (entry) => ({
              conversationKey: entry.conversationKey,
              conversationID: entry.conversationID,
              conversationSystem: "upstream" as const,
              libraryID,
              lastActivityAt: entry.lastActivityAt,
              title: entry.title,
              userTurnCount: entry.userTurnCount,
              sessionVersion: entry.sessionVersion,
              paperItemID: entry.paperItemID,
              mode: entry.mode,
            }),
          );
        };
        const perSystem = await Promise.all(
          getStandaloneHistorySystems().map(async (system) => {
            try {
              return await loadSystemEntries(system);
            } catch (err) {
              appLogger.warn("LLM: standalone history rows failed", {
                system,
                error: err,
              });
              return [] as SidebarConv[];
            }
          }),
        );
        return perSystem
          .flat()
          .filter((entry) =>
            isUnifiedHistoryRowListed(
              {
                system: entry.conversationSystem || activeSystem,
                userTurnCount: entry.userTurnCount,
              },
              activeSystem,
            ),
          )
          .sort((a, b) => {
            if (b.lastActivityAt !== a.lastActivityAt) {
              return b.lastActivityAt - a.lastActivityAt;
            }
            return b.conversationKey - a.conversationKey;
          })
          .map(toStandaloneHistoryEntry)
          .filter(
            (entry) =>
              !pendingDeletionStore.isConversationPendingDeletion(
                entry.conversationKey,
              ),
          )
          .slice(0, limit);
      };

      const loadStandaloneSearchDocument = async (
        entry: ConversationHistoryEntry,
      ): Promise<HistorySearchDocument> => {
        const fingerprint = createHistorySearchDocumentFingerprint(entry);
        const cached = searchDocCache.get(entry.conversationKey);
        if (cached?.fingerprint === fingerprint) return cached.document;
        const messages = await conversationRepository.loadMessages({
          system: entry.system,
          conversationKey: entry.conversationKey,
          limit: 200,
        });
        const document = createHistorySearchDocument(entry, messages);
        searchDocCache.set(entry.conversationKey, { fingerprint, document });
        return document;
      };

      const getCurrentStandaloneHistoryPaperItemID = (): number => {
        return normalizeHistoryPaperItemID(currentBasePaperItem?.id);
      };

      const maybeSelectStandaloneHistoryPaperItem = async (
        decision: ReturnType<typeof resolvePaperHistoryNavigationDecision>,
        paperItem: Zotero.Item,
      ): Promise<boolean> => {
        try {
          return await maybeSelectPaperHistoryTarget({
            decision,
            paperItemID: paperItem.id,
            getPane: () =>
              Zotero.getActiveZoteroPane?.() as
                | HistoryPaperPaneSelector
                | undefined,
          });
        } catch (err) {
          appLogger.warn("LLM: Failed to select standalone history paper", {
            paperItemID: paperItem.id,
            error: err,
          });
          return false;
        }
      };

      // One window per chat: in a torn-off window, picking a chat another
      // torn-off window shows brings that window forward, and this one stays
      // as it is. True when it did.
      const bringForwardOtherTornWindow = (
        conversationKey: number,
      ): boolean => {
        if (linkedToReader) return false;
        const holder = findTornWindowForConversation(conversationKey);
        if (!holder || holder === newWin) return false;
        bringChatWindowForward(holder);
        return true;
      };

      // A history row, or a follower's chat (see showFollowerChat): the
      // fields a switch reads. selectInZotero: false leaves showing the
      // paper in Zotero to the caller.
      const selectStandaloneSearchEntry = async (
        entry: Pick<
          ConversationHistoryEntry,
          | "system"
          | "kind"
          | "sourceState"
          | "conversationKey"
          | "libraryID"
          | "paperItemID"
          | "sessionVersion"
        >,
        options?: { selectInZotero?: boolean },
      ): Promise<boolean> => {
        // This window did not switch (the side panel keeps its tab).
        if (bringForwardOtherTornWindow(entry.conversationKey)) return false;
        // A row of another runtime opens in that runtime: the window adopts
        // it (leaving WebChat first) right before it mounts the row's chat.
        // The sidebar's runtime stays as it is.
        const targetSystem = entry.system;
        if (
          targetSystem !== currentConversationSystem &&
          !getStandaloneHistorySystems().includes(targetSystem)
        ) {
          return false;
        }
        // The open claims its sequence number once every refusal check has
        // passed, before its first await, so a refused click never cancels an
        // earlier open and a later click always wins over this one. A
        // follower claims the chat in the registry then too, so an open of
        // the chat elsewhere meanwhile finds this window (one window per
        // chat); an open that fails gives the claim back, unless a later
        // open has made its own.
        let openSeq = 0;
        const claimOpen = () => {
          openSeq = ++standaloneHistoryOpenSeq;
          if (!linkedToReader) {
            setTornWindowConversation(newWin, entry.conversationKey);
          }
        };
        const releaseClaim = () => {
          if (!linkedToReader && openSeq === standaloneHistoryOpenSeq) {
            setTornWindowConversation(newWin, activeConversationKey);
          }
        };
        const isNewestOpen = () =>
          openSeq === standaloneHistoryOpenSeq && !cancelled && !newWin.closed;
        const adoptTargetRuntime = async (): Promise<boolean> => {
          if (!isNewestOpen()) return false;
          // Read at this moment: an earlier open may have moved the window.
          if (targetSystem === currentConversationSystem) return true;
          const adopted = await adoptStandaloneRuntime(targetSystem);
          return adopted && isNewestOpen();
        };
        try {
          if (entry.kind === "paper") {
            if (isOrphanHistoryEntry(entry)) {
              const statusEl = contentArea.querySelector(
                "#llm-status",
              ) as HTMLElement | null;
              if (statusEl) {
                setStatus(
                  statusEl,
                  t("This chat's source item was deleted"),
                  "warning",
                );
              }
              return false;
            }
            const paperItem = resolveHistoryEntryPaperBaseItem(
              entry,
              (id) => Zotero.Items.get(id) as Zotero.Item | null,
            );
            if (!paperItem) {
              const statusEl = contentArea.querySelector(
                "#llm-status",
              ) as HTMLElement | null;
              if (statusEl) {
                setStatus(
                  statusEl,
                  t("This chat's source item was deleted"),
                  "warning",
                );
              }
              return false;
            }
            const navigationDecision = resolvePaperHistoryNavigationDecision({
              entryPaperItemID: paperItem.id,
              currentPaperItemID: getCurrentStandaloneHistoryPaperItemID(),
            });
            if (navigationDecision === "missing-target-paper") {
              const statusEl = contentArea.querySelector(
                "#llm-status",
              ) as HTMLElement | null;
              if (statusEl) {
                setStatus(statusEl, t("Could not find this paper"), "error");
              }
              return false;
            }
            const sessionVersion = Number(entry.sessionVersion || 0);
            const sv = sessionVersion > 0 ? sessionVersion : 1;
            const portalItem = buildStandalonePortalItem({
              mode: "paper",
              conversationKey: entry.conversationKey,
              paperItem,
              sessionVersion: sv,
              system: targetSystem,
            });
            if (!portalItem) return false;
            const targetModeSnapshot = primeHistoryNavigationMode({
              system: targetSystem,
              libraryID:
                Number(entry.libraryID || 0) ||
                Number(paperItem.libraryID || 0) ||
                getCurrentLibraryScopeID(),
              surface: windowSurface,
              mode: "paper",
              conversationKey: entry.conversationKey,
              paperItemID: paperItem.id,
            });
            let mounted = false;
            claimOpen();
            try {
              // The standalone window shows the row's paper in Zotero too and
              // follows it there; a torn-off window only makes it its own
              // paper and leaves Zotero as it is.
              if (
                linkedToReader &&
                options?.selectInZotero !== false &&
                navigationDecision === "select-target-paper"
              ) {
                const selected = await maybeSelectStandaloneHistoryPaperItem(
                  navigationDecision,
                  paperItem,
                );
                if (!selected) {
                  const statusEl = contentArea.querySelector(
                    "#llm-status",
                  ) as HTMLElement | null;
                  if (statusEl) {
                    setStatus(
                      statusEl,
                      t("Could not focus this paper"),
                      "error",
                    );
                  }
                  return false;
                }
                if (!isNewestOpen()) return false;
              }
              if (!(await adoptTargetRuntime())) return false;
              standaloneMode = "paper";
              currentPaperItem = paperItem;
              currentBasePaperItem = paperItem;
              currentRawContextItem = paperItem;
              paperTab.classList.add("active");
              openTab.classList.remove("active");
              syncPaperTabLabel();
              await showStandaloneConversation(portalItem, paperItem);
              mounted = true;
            } finally {
              if (!mounted) {
                targetModeSnapshot.restore();
                releaseClaim();
              }
            }
          } else {
            const portalItem = buildStandalonePortalItem({
              mode: "open",
              conversationKey: entry.conversationKey,
              system: targetSystem,
            });
            if (!portalItem) return false;
            const targetModeSnapshot = primeHistoryNavigationMode({
              system: targetSystem,
              libraryID:
                Number(entry.libraryID || 0) || getCurrentLibraryScopeID(),
              surface: windowSurface,
              mode: "global",
              conversationKey: entry.conversationKey,
            });
            let mounted = false;
            claimOpen();
            try {
              if (!(await adoptTargetRuntime())) return false;
              standaloneMode = "open";
              paperTab.classList.remove("active");
              openTab.classList.add("active");
              await showStandaloneConversation(portalItem);
              mounted = true;
            } finally {
              if (!mounted) {
                targetModeSnapshot.restore();
                releaseClaim();
              }
            }
          }
          return true;
        } catch (err) {
          appLogger.warn("LLM: standalone search navigate failed", err);
          return false;
        }
      };

      // The list sources the Search history popup and the side panel's
      // History list share.
      const standaloneHistoryListSources = {
        showRuntimeLabel: true,
        loadEntries: loadAllStandaloneSearchEntries,
        loadDocument: loadStandaloneSearchDocument,
        translate: t,
        log: (...args: unknown[]) =>
          appLogger.warn("LLM: standalone history list", args),
        resolveLabel: (entry: ConversationHistoryEntry) =>
          isOrphanHistoryEntry(entry)
            ? t("Orphan")
            : entry.kind === "paper"
              ? resolvePaperLabel(entry.paperItemID)
              : t("Library chat"),
        resolveScopeLabel: (entry: ConversationHistoryEntry) =>
          entry.kind === "paper"
            ? resolvePaperSearchScopeLabel(entry.paperItemID, entry.sourceState)
            : t("Library chat"),
      };

      const searchPopupController = createHistorySearchPopupController({
        ...standaloneHistoryListSources,
        parent: root,
        // Another window taking the chat also answers the pick: the popup
        // closes.
        onSelect: (entry) =>
          bringForwardOtherTornWindow(entry.conversationKey) ||
          selectStandaloneSearchEntry(entry),
        onDelete: async (entry) => {
          await queueStandaloneHistoryDeletion(
            toStandaloneDeletionEntry(entry),
          );
        },
      });

      const resolveStandaloneHistoryEntryPaper = (
        entry: ConversationHistoryEntry,
      ): Zotero.Item | null =>
        entry.kind === "paper" && !isOrphanHistoryEntry(entry)
          ? resolveHistoryEntryPaperBaseItem(
              entry,
              (id) => Zotero.Items.get(id) as Zotero.Item | null,
            )
          : null;

      const readPixelStyleVariable = (name: string): number => {
        const value = Number.parseFloat(
          lowerArea.style.getPropertyValue(name) || "",
        );
        return Number.isFinite(value) && value > 0 ? value : 0;
      };

      // Third column: History (read-only past chats) and a temporary side
      // chat that follows the main chat's paper or library. A torn-off
      // window's is read only: no side chats, and "Open as main chat" loads
      // the chat into this window (or brings forward the window holding it).
      standaloneSidePanel = createStandaloneSidePanel({
        win: newWin,
        lowerArea,
        mainBody: contentArea,
        toggleHost: followerActions || tabRowTrailing,
        readOnly: !linkedToReader,
        getMainContext: () => ({
          mode: standaloneMode,
          conversationKey: activeConversationKey,
          basePaperItem:
            standaloneMode === "paper" ? currentBasePaperItem : null,
          libraryID: getCurrentLibraryScopeID(),
          conversationSystem: currentConversationSystem,
        }),
        historyList: standaloneHistoryListSources,
        buildHistoryEntryItem: (entry) => {
          if (entry.kind !== "paper") {
            return buildStandalonePortalItem({
              mode: "open",
              conversationKey: entry.conversationKey,
              system: entry.system,
            });
          }
          const paperItem = resolveStandaloneHistoryEntryPaper(entry);
          if (!paperItem) return null;
          const sessionVersion = Number(entry.sessionVersion || 0);
          return buildStandalonePortalItem({
            mode: "paper",
            conversationKey: entry.conversationKey,
            paperItem,
            sessionVersion: sessionVersion > 0 ? sessionVersion : 1,
            system: entry.system,
          });
        },
        resolveHistoryEntryPaper: resolveStandaloneHistoryEntryPaper,
        openAsMainChat: selectStandaloneSearchEntry,
        minWindowWidth,
        getReservedLeftWidth: () =>
          !linkedToReader || sidebar.dataset.sidebarState === "collapsed"
            ? 0
            : readPixelStyleVariable("--llm-standalone-sidebar-panel-width") +
              STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX,
        onLayoutChanged: () => {
          applyAutoSidebarStateForCurrentWidth();
          standaloneSidebarResize.relayout();
          standaloneSidePanel?.relayout();
        },
        // Every paper keeps its tabs until the window closes; a paper that
        // is gone (deleted) gives them up.
        shouldKeepWorkspace: (key) => {
          const paperID = resolveSidePanelWorkspacePaperID(key);
          return paperID > 0 ? Boolean(Zotero.Items.get(paperID)) : true;
        },
      });
      disposeStandaloneSidePanel = () => {
        standaloneSidePanel?.dispose();
        standaloneSidePanel = null;
      };

      iconSearch.addEventListener("click", () => {
        searchPopupController.toggle();
      });
      // A follower's History lists every chat, under its own button; the
      // side panel toggle comes first in the top row, then Open in main
      // window.
      if (iconFollowerHistory) {
        const historyButton = iconFollowerHistory;
        historyButton.addEventListener("click", () => {
          searchPopupController.toggle({ anchor: historyButton });
        });
      }
      if (iconFollowerOpenMain) {
        const openMainButton = iconFollowerOpenMain;
        followerActions?.append(openMainButton);
        if (iconFollowerMore) followerActions?.append(iconFollowerMore);
        // The chat moves to the standalone window (opened if closed), and
        // this window closes once that window shows it; otherwise it stays.
        openMainButton.addEventListener("click", () => {
          const identity = shownChatIdentity();
          if (!identity || openMainButton.disabled) return;
          openMainButton.disabled = true;
          void openConversationInLeader(identity).then((shown) => {
            if (cancelled || newWin.closed) return;
            if (shown) {
              newWin.close();
              return;
            }
            openMainButton.disabled = false;
          });
        });
      }

      // ----------------------------------------------------------------
      // Skills popup — open/close/render/interactions
      // ----------------------------------------------------------------
      let skillCtxFilePath = ""; // tracks which file the context menu targets
      let skillCtxFilename = ""; // basename of ctx target
      let skillCtxSource: "system" | "customized" | "personal" = "personal";

      /** Reload the in-memory skill list from disk (call after create/delete). */
      const reloadRuntimeSkills = async () => {
        const { loadUserSkills } =
          await import("../../agent/skills/userSkills");
        const { setUserSkills } = await import("../../agent/skills");
        const skills = await loadUserSkills();
        setUserSkills(skills);
      };

      const reloadClaudeProjectCommands = async () => {
        try {
          await refreshClaudeSlashCommands(await initAgentSubsystem(), true);
        } catch (err) {
          appLogger.warn("LLM: Claude project command refresh failed", err);
        }
      };

      const resolveSkillPopupSystem = (): "upstream" | "claude_code" =>
        resolveConversationSystemForItem(activeItem) === "claude_code"
          ? "claude_code"
          : "upstream";

      let skillRenderSeq = 0;
      const renderSkillGrid = async () => {
        const renderSeq = ++skillRenderSeq;
        const skillSystem = resolveSkillPopupSystem();
        const isClaudeMode = skillSystem === "claude_code";
        try {
          const entries: Array<{
            filePath: string;
            openPath?: string;
            filename: string;
            description: string;
            source: "system" | "customized" | "personal";
            managedBlockOutdated?: boolean;
            shippedVersion?: number | null;
            version?: number;
            id?: string;
          }> = isClaudeMode
            ? (await listClaudeProjectSkillEntries()).map((entry) => ({
                filePath: entry.filePath,
                openPath: entry.openPath,
                filename: `/${entry.name}`,
                description: entry.description,
                source: "personal" as const,
              }))
            : await (
                await import("../../agent/skills/userSkills")
              ).getSkillListing();
          if (
            renderSeq !== skillRenderSeq ||
            skillSystem !== resolveSkillPopupSystem()
          ) {
            return;
          }
          skillGrid.textContent = "";

          // "+" add button — first grid item
          const addBtn = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          addBtn.className =
            "llm-standalone-skill-item llm-standalone-skill-add";
          addBtn.type = "button";
          const addIcon = doc.createElementNS(
            HTML_NS,
            "span",
          ) as HTMLSpanElement;
          addIcon.className = "llm-standalone-skill-add-icon";
          addIcon.textContent = "+";
          const addLabel = doc.createElementNS(
            HTML_NS,
            "span",
          ) as HTMLSpanElement;
          addLabel.className = "llm-standalone-skill-label";
          addLabel.textContent = t("New skill");
          addBtn.append(addIcon, addLabel);
          addBtn.addEventListener("click", async () => {
            const filePath = isClaudeMode
              ? await createClaudeProjectSkillTemplate()
              : await (
                  await import("../../agent/skills/userSkills")
                ).createSkillTemplate();
            if (filePath) {
              try {
                (
                  Zotero as unknown as { launchFile?: (p: string) => void }
                ).launchFile?.(filePath);
              } catch {
                /* */
              }
              if (isClaudeMode) {
                await reloadClaudeProjectCommands();
              } else {
                await reloadRuntimeSkills();
              }
              void renderSkillGrid();
            }
          });
          skillGrid.appendChild(addBtn);

          // Skill file items
          for (const entry of entries) {
            const item = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            item.className = "llm-standalone-skill-item";
            item.type = "button";
            item.dataset.filePath = entry.filePath;
            item.dataset.source = entry.source;

            // Customized built-ins get an accent border; outdated-format gets
            // a stronger amber cue so the user notices they should restore.
            if (entry.source === "customized") {
              item.style.borderColor = entry.managedBlockOutdated
                ? "#d97706"
                : "var(--color-accent, #2563eb)";
            }

            const icon = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            icon.className = "llm-standalone-skill-doc-icon";

            const label = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            label.className = "llm-standalone-skill-label";
            label.textContent = entry.filename;

            item.append(icon, label);

            // Tooltip summarizes source + available actions
            const tooltipLines = [
              t(entry.description || "") || entry.filename,
              "",
            ];
            if (entry.source === "system") {
              tooltipLines.push(`Shipped built-in (v${entry.version ?? 0})`);
            } else if (entry.source === "customized") {
              const shippedVersion = entry.shippedVersion ?? null;
              const version = entry.version ?? 0;
              tooltipLines.push(
                entry.managedBlockOutdated
                  ? `Customized — shipped v${shippedVersion ?? "unknown"} uses a new format. Right-click → Restore to default to adopt it (overwrites your edits).`
                  : typeof shippedVersion === "number" &&
                      version < shippedVersion
                    ? `Customized — shipped v${shippedVersion} available. Right-click → Restore to default to adopt it.`
                    : `Customized built-in.`,
              );
            } else {
              tooltipLines.push(`Your custom skill.`);
            }
            item.title = tooltipLines.filter(Boolean).join("\n");

            // Left click — open in system editor
            item.addEventListener("click", () => {
              try {
                (
                  Zotero as unknown as { launchFile?: (p: string) => void }
                ).launchFile?.(entry.openPath || entry.filePath);
              } catch {
                /* */
              }
            });

            // Right click — context menu
            item.addEventListener("contextmenu", (e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              const me = e as MouseEvent;
              skillCtxFilePath = entry.filePath;
              skillCtxFilename = entry.filename;
              skillCtxSource = entry.source;
              skillCtxMenu.style.display = "flex";

              // Show Restore only for customized built-ins
              skillCtxRestore.style.display =
                entry.source === "customized" ? "flex" : "none";
              // Hide Delete for system built-ins (they'd just be re-seeded)
              skillCtxDelete.style.display =
                entry.source === "system" ? "none" : "flex";

              // Position with viewport bounds checking
              const menuW = 200;
              const menuH = 110;
              let x = me.clientX + 4;
              let y = me.clientY + 4;
              if (x + menuW > (doc.documentElement?.clientWidth ?? 9999))
                x = me.clientX - menuW;
              if (y + menuH > (doc.documentElement?.clientHeight ?? 9999))
                y = me.clientY - menuH;
              skillCtxMenu.style.left = `${x}px`;
              skillCtxMenu.style.top = `${y}px`;
            });

            skillGrid.appendChild(item);
          }
        } catch (err) {
          if (renderSeq !== skillRenderSeq) return;
          skillGrid.textContent = "";
          const errorEl = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
          errorEl.className = "llm-standalone-sidebar-empty";
          errorEl.textContent = t("Failed to load skills");
          skillGrid.appendChild(errorEl);
          appLogger.warn(
            `[llm-for-zotero] Standalone skill grid render failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      };

      const openSkillPopup = () => {
        skillOverlay.style.display = "flex";
        skillGrid.textContent = "";
        const loading = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        loading.className = "llm-standalone-sidebar-empty";
        loading.textContent = t("Loading…");
        skillGrid.appendChild(loading);
        if (resolveSkillPopupSystem() === "claude_code") {
          void reloadClaudeProjectCommands();
        } else {
          void reloadRuntimeSkills();
        }
        void renderSkillGrid();
      };

      const closeSkillPopup = () => {
        skillOverlay.style.display = "none";
        skillCtxMenu.style.display = "none";
      };

      // Skill icon toggle
      iconSkill.addEventListener("click", () => {
        if (skillOverlay.style.display !== "none") {
          closeSkillPopup();
        } else {
          openSkillPopup();
        }
      });

      skillCloseBtn.addEventListener("click", () => closeSkillPopup());

      skillOverlay.addEventListener("click", (e: Event) => {
        if (e.target === skillOverlay) closeSkillPopup();
      });

      // Escape key — attached at document level so it works regardless of focus
      doc.addEventListener("keydown", (e: Event) => {
        if (skillOverlay.style.display === "none") return;
        if ((e as KeyboardEvent).key === "Escape") {
          e.preventDefault();
          closeSkillPopup();
        }
      });

      // Context menu: Show in file system
      skillCtxShowInFs.addEventListener("click", async () => {
        skillCtxMenu.style.display = "none";
        const dir =
          resolveSkillPopupSystem() === "claude_code"
            ? getClaudeProjectDir()
            : (
                await import("../../agent/skills/userSkills")
              ).getUserSkillsDir();
        try {
          (
            Zotero as unknown as { launchFile?: (p: string) => void }
          ).launchFile?.(dir);
        } catch {
          /* */
        }
      });

      const refreshSkillPopupForCurrentSystem = async () => {
        if (resolveSkillPopupSystem() === "claude_code") {
          await reloadClaudeProjectCommands();
        } else {
          await reloadRuntimeSkills();
        }
        await renderSkillGrid();
      };

      // Context menu: Restore to default (customized built-ins only)
      skillCtxRestore.addEventListener("click", async () => {
        skillCtxMenu.style.display = "none";
        if (!skillCtxFilename || skillCtxSource !== "customized") return;
        const { restoreSkillToDefault } =
          await import("../../agent/skills/userSkills");
        const confirmed = await showStandaloneConfirmationDialog(doc, {
          title: t("Restore skill to default?"),
          message: `Restore ${skillCtxFilename} to the shipped default? Your customizations in this file will be lost.`,
          confirmLabel: t("Restore"),
          cancelLabel: t("Cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        const ok = await restoreSkillToDefault(skillCtxFilename);
        skillCtxFilePath = "";
        skillCtxFilename = "";
        if (ok) {
          await refreshSkillPopupForCurrentSystem();
        }
      });

      // Context menu: Delete (+ reload runtime skills)
      skillCtxDelete.addEventListener("click", async () => {
        skillCtxMenu.style.display = "none";
        if (!skillCtxFilePath) return;
        if (resolveSkillPopupSystem() === "claude_code") {
          await deleteClaudeProjectSkillFile(skillCtxFilePath);
          await reloadClaudeProjectCommands();
        } else {
          const { deleteSkillFile } =
            await import("../../agent/skills/userSkills");
          await deleteSkillFile(skillCtxFilePath);
          await reloadRuntimeSkills();
        }
        skillCtxFilePath = "";
        skillCtxFilename = "";
        await refreshSkillPopupForCurrentSystem();
      });

      // Header: Check for updates — re-seed built-ins and refresh the grid
      skillRefreshBtn.addEventListener("click", async () => {
        skillRefreshBtn.disabled = true;
        const originalText = skillRefreshBtn.textContent;
        skillRefreshBtn.textContent = t("Checking…");
        try {
          if (resolveSkillPopupSystem() === "claude_code") {
            await reloadClaudeProjectCommands();
          } else {
            const { initUserSkills } =
              await import("../../agent/skills/userSkills");
            await initUserSkills();
            await reloadRuntimeSkills();
          }
          await renderSkillGrid();
          skillRefreshBtn.textContent = t("Up to date");
          doc.defaultView?.setTimeout(() => {
            skillRefreshBtn.textContent = originalText;
            skillRefreshBtn.disabled = false;
          }, 1500);
        } catch (err) {
          appLogger.warn(
            `[llm-for-zotero] Skill refresh failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          skillRefreshBtn.textContent = t("Update failed");
          doc.defaultView?.setTimeout(() => {
            skillRefreshBtn.textContent = originalText;
            skillRefreshBtn.disabled = false;
          }, 2000);
        }
      });

      // Dismiss context menu on click outside
      doc.addEventListener("mousedown", (e: Event) => {
        const target = e.target as HTMLElement;
        if (skillCtxMenu.style.display !== "none") {
          if (!skillCtxMenu.contains(target)) {
            skillCtxMenu.style.display = "none";
          }
        }
      });

      // Click-outside dismissal for export popup
      doc.addEventListener("mousedown", (e: Event) => {
        const target = e.target as HTMLElement;
        if (exportPopup.style.display !== "none") {
          if (
            !exportPopup.contains(target) &&
            !iconExport.contains(target) &&
            !iconFollowerMore?.contains(target)
          ) {
            exportPopup.style.display = "none";
          }
        }
      });

      const hideStandaloneHistoryUndoToast = () => {
        standaloneHistoryUndo.style.display = "none";
        standaloneHistoryUndoText.textContent = "";
      };

      const showStandaloneHistoryUndoToast = () => {
        standaloneHistoryUndoText.textContent = `Conversation deleted — Undo`;
        standaloneHistoryUndo.style.display = "flex";
      };

      const renderStandalonePendingDeletionToast = () => {
        // This window renders conversation undo only. A newer TURN deletion
        // (queued from the item panel, which shares one store) must not blank
        // out a conversation deletion that is still undoable here.
        const latest =
          pendingDeletionStore.getLatestPendingOfKind("conversation");
        if (!latest || latest.expiresAt <= Date.now()) {
          hideStandaloneHistoryUndoToast();
          return;
        }
        showStandaloneHistoryUndoToast();
      };

      renderStandalonePendingDeletionToast();

      const setStandaloneHistoryStatus = (
        message: string,
        level: "ready" | "warning" | "error",
      ) => {
        const statusEl = contentArea.querySelector(
          "#llm-status",
        ) as HTMLElement | null;
        if (statusEl) setStatus(statusEl, message, level);
      };

      const getStandaloneRenameIdentity = (
        entry: SidebarConv,
      ): ConversationRenameIdentity => ({
        system: entry.conversationSystem || currentConversationSystem,
        kind: entry.kind || (entry.mode === "paper" ? "paper" : "global"),
        conversationKey: Number(entry.conversationKey || 0),
      });

      const renameStandaloneHistoryEntry = async (
        entry: SidebarConv,
      ): Promise<void> => {
        const target = getStandaloneRenameIdentity(entry);
        const renameGeneration = getConversationWriteGeneration(
          target.conversationKey,
        );
        if (
          !isConversationRenameEligible({
            identity: target,
            pendingDelete: pendingDeletionStore.isConversationPendingDeletion(
              target.conversationKey,
            ),
          })
        ) {
          return;
        }
        // Like the panel, refuse before the dialog opens, with the panel's
        // messages; the commit re-checks both after the user confirms.
        if (isOrphanHistoryEntry(toStandaloneHistoryEntry(entry))) {
          setStandaloneHistoryStatus(
            t("This chat's source item was deleted"),
            "warning",
          );
          return;
        }
        if (isRequestPending(target.conversationKey)) {
          setStandaloneHistoryStatus(
            t("History is unavailable while generating"),
            "ready",
          );
          return;
        }
        const currentTitle = normalizeHistoryTitle(entry.title || "");
        const rawTitle = await showConversationRenameDialog(doc, {
          title: t("Rename chat"),
          initialTitle: currentTitle,
          confirmLabel: t("Rename"),
          cancelLabel: t("Cancel"),
        });
        if (rawTitle === null) return;
        const title = normalizeConversationTitleSeed(rawTitle);
        if (!title) {
          setStandaloneHistoryStatus(t("Chat title cannot be empty"), "error");
          return;
        }
        try {
          const renamed = await commitConversationRename({
            target,
            title,
            expectedGeneration: renameGeneration,
            findCurrentEntry: () =>
              standaloneSidebarEntriesByKey.get(target.conversationKey),
            toIdentity: getStandaloneRenameIdentity,
            // The panel's guards, each read from the window's own state. A
            // sidebar row has no pending-delete flag of its own; the commit
            // checks the pending-deletion store for every surface.
            isOrphan: (currentEntry) =>
              isOrphanHistoryEntry(toStandaloneHistoryEntry(currentEntry)),
            isRequestPending: (conversationKey) =>
              isRequestPending(conversationKey),
            // The window does not hand its sidebar to another owner, so it
            // stays current until it closes.
            isStillCurrent: () => !cancelled,
          });
          if (!renamed) return;
          searchDocCache.delete(target.conversationKey);
          if (cancelled) return;
          await renderSidebar();
          if (cancelled) return;
          setStandaloneHistoryStatus(t("Conversation renamed"), "ready");
        } catch (err) {
          appLogger.warn("LLM: standalone rename conversation failed", err);
          if (cancelled) return;
          setStandaloneHistoryStatus(
            t("Failed to rename conversation"),
            "error",
          );
        }
      };

      const normalizeStandaloneCreateConversationOptions = (
        options: boolean | StandaloneCreateConversationOptions | undefined,
      ): Required<StandaloneCreateConversationOptions> => {
        if (typeof options === "boolean") {
          return { forceFresh: options, excludeConversationKey: 0 };
        }
        return {
          forceFresh: Boolean(options?.forceFresh),
          excludeConversationKey:
            Number.isFinite(options?.excludeConversationKey) &&
            Number(options?.excludeConversationKey) > 0
              ? Math.floor(Number(options?.excludeConversationKey))
              : 0,
        };
      };

      // Conversations this window gave up because a deletion was queued, keyed
      // by pending-deletion entry id, so an undone or abandoned deletion can
      // put the user back instead of stranding them on a fresh blank chat.
      const standaloneSurrenderedDeletions = new Map<string, SidebarConv>();
      const enqueueStandaloneConversationDeletionEvent =
        createSerializedConversationDeletionEventQueue();

      const switchStandaloneToConversationEntry = async (
        entry: SidebarConv,
      ): Promise<boolean> => {
        const key = Number(entry.conversationKey || 0);
        if (!key) return false;
        if (pendingDeletionStore.isConversationPendingDeletion(key)) {
          setStandaloneHistoryStatus(
            t("Deletion pending; retrying safely"),
            "warning",
          );
          return false;
        }
        // Deliberate navigation: the user wants this key alive again, and this
        // window has chosen where it sits — any remembered surrender is void so
        // an abandoned deletion cannot yank it off the chat just opened.
        forgetRecentlyDeletedConversation(key);
        standaloneSurrenderedDeletions.clear();
        const entryMode =
          entry.mode || (entry.kind === "global" ? "open" : "paper");
        standaloneMode = entryMode === "open" ? "open" : "paper";
        paperTab.classList.toggle("active", standaloneMode === "paper");
        openTab.classList.toggle("active", standaloneMode === "open");
        activeConversationKey = key;
        if (standaloneMode === "open") {
          const currentLibraryID = Number(
            entry.libraryID || getCurrentLibraryScopeID(),
          );
          rememberStandaloneGlobalConversation(
            currentConversationSystem,
            currentLibraryID,
            key,
            windowSurface,
          );
          const newItem = buildStandalonePortalItem({
            mode: "open",
            conversationKey: key,
          });
          if (!newItem) return false;
          await showStandaloneConversation(newItem);
          return true;
        }
        if (!currentBasePaperItem) return false;
        const newItem = buildStandalonePortalItem({
          mode: "paper",
          conversationKey: key,
          paperItem: currentBasePaperItem,
          sessionVersion: entry.sessionVersion,
        });
        currentPaperItem = currentBasePaperItem;
        if (!newItem) return false;
        await showStandaloneConversation(newItem);
        return true;
      };

      const clearStandaloneActiveConversationForPendingDeletion = async (
        entry: SidebarConv,
      ): Promise<boolean> => {
        const deletedConversationKey = Number(entry.conversationKey || 0);
        return await clearActiveConversationForPendingDeletion(
          entry.kind || (standaloneMode === "open" ? "global" : "paper"),
          {
            createFreshGlobalConversation: async () => {
              const currentLibraryID = getCurrentLibraryScopeID();
              const newKey = await resolveFreshStandaloneGlobalConversation({
                forceFresh: true,
                excludeConversationKey: deletedConversationKey,
              });
              if (!newKey || cancelled) return false;
              return await switchStandaloneToConversationEntry({
                conversationKey: newKey,
                kind: "global",
                conversationSystem: currentConversationSystem,
                libraryID: currentLibraryID,
                lastActivityAt: Date.now(),
                mode: "open",
              });
            },
            createFreshPaperConversation: async () => {
              if (!currentBasePaperItem) {
                return await restoreStandaloneOpenConversation(false);
              }
              const paperId = Number(currentBasePaperItem.id || 0);
              const paperLibraryID = getCurrentPaperLibraryID();
              const summary = await resolveStandalonePaperConversation({
                forceFresh: true,
                excludeConversationKey: deletedConversationKey,
              });
              const newKey = Number(summary.conversationKey || 0);
              if (!newKey || cancelled) return false;
              return await switchStandaloneToConversationEntry({
                conversationKey: newKey,
                kind: "paper",
                conversationSystem: currentConversationSystem,
                libraryID: paperLibraryID,
                lastActivityAt: Date.now(),
                paperItemID: paperId,
                sessionVersion: summary.sessionVersion,
                mode: "paper",
              });
            },
            log: (message, ...args) => appLogger.warn(message, ...args),
          },
        );
      };

      const toStandaloneDeletionSurfaceEntry = (
        entry: PendingConversationDeletionEntry,
      ): SidebarConv => ({
        conversationID: entry.conversationID,
        conversationKey: entry.conversationKey,
        kind: entry.conversationKind,
        conversationSystem: entry.system,
        libraryID: entry.libraryID,
        lastActivityAt: 0,
        title: entry.title,
        paperItemID: entry.paperItemID,
        providerSessionId: entry.providerSessionId,
        mode: entry.conversationKind === "paper" ? "paper" : "open",
      });

      const handleStandaloneConversationDeletionEvent = async (
        event: PendingDeletionEvent,
      ): Promise<void> => {
        if (event.entry.kind !== "conversation") return;
        const entry = event.entry;
        // The standalone window tombstones when its serialized handler reaches
        // this event, before renderSidebar can re-seed the dead key.
        markCommittedConversationDeletionTombstone(event);
        const registered =
          activeConversationKey > 0
            ? await getRegisteredConversationScope(activeConversationKey)
            : null;
        const action = resolveConversationDeletionSurfaceAction({
          eventType: event.type,
          entry,
          surface:
            activeConversationKey > 0
              ? {
                  conversationKey: activeConversationKey,
                  instanceID: registered?.instanceID || undefined,
                  kind: standaloneMode === "open" ? "global" : "paper",
                  system: currentConversationSystem,
                }
              : null,
          surrendered: standaloneSurrenderedDeletions.has(entry.id),
          dropped: Boolean(event.dropped),
          holdsOneChat: !linkedToReader,
        });
        if (action.type === "close") {
          // A follower holds one chat: it keeps it, with its panel's Undo,
          // while Undo is possible, and closes once the deletion is final. It
          // never falls back to another chat (which another window may hold).
          newWin.close();
          return;
        }
        if (action.type === "leave") {
          const surfaceEntry = toStandaloneDeletionSurfaceEntry(entry);
          const left =
            await clearStandaloneActiveConversationForPendingDeletion(
              surfaceEntry,
            );
          if (left && action.remember) {
            standaloneSurrenderedDeletions.set(entry.id, surfaceEntry);
          } else if (!action.remember) {
            // Nothing to come back to; drop the memory rather than leaking it.
            standaloneSurrenderedDeletions.delete(entry.id);
          }
          if (!left) {
            setStandaloneHistoryStatus(
              t("Cannot delete active conversation right now"),
              "error",
            );
          }
        } else if (action.type === "restore") {
          const target =
            standaloneSurrenderedDeletions.get(entry.id) ||
            toStandaloneDeletionSurfaceEntry(entry);
          standaloneSurrenderedDeletions.delete(entry.id);
          await switchStandaloneToConversationEntry(target);
        } else if (action.type === "forget") {
          standaloneSurrenderedDeletions.delete(entry.id);
        }
        if (cancelled || newWin.closed) return;
        scheduleStandaloneSidebarRender();
      };

      unsubscribeStandalonePendingDeletions?.();
      unsubscribeStandalonePendingDeletions = pendingDeletionStore.subscribe(
        (event) => {
          if (cancelled || newWin.closed) return;
          renderStandalonePendingDeletionToast();
          if (event.entry.kind === "conversation") {
            void enqueueStandaloneConversationDeletionEvent(() =>
              handleStandaloneConversationDeletionEvent(event),
            );
            standaloneSidePanel?.onConversationDeletionChanged();
            return;
          }
          scheduleStandaloneSidebarRender();
        },
      );

      standaloneHistoryUndoBtn.addEventListener("click", () => {
        // Must match renderStandalonePendingDeletionToast: this button is
        // labelled with a conversation title, so it may only undo that entry.
        const latest =
          pendingDeletionStore.getLatestPendingOfKind("conversation");
        if (!latest) return;
        void pendingDeletionStore.undo(latest.id).then((undone) => {
          if (undone) {
            setStandaloneHistoryStatus(t("Conversation restored"), "ready");
            return;
          }
          setStandaloneHistoryStatus(
            t("Failed to restore. Check logs."),
            "error",
          );
        });
      });

      const toStandaloneDeletionEntry = (
        entry: ConversationHistoryEntry,
      ): SidebarConv => ({
        conversationID: entry.conversationID,
        conversationKey: entry.conversationKey,
        kind: entry.kind,
        conversationSystem: entry.system,
        libraryID: entry.libraryID || getCurrentLibraryScopeID(),
        lastActivityAt: entry.lastActivityAt,
        title: entry.title,
        userTurnCount: entry.userTurnCount,
        sessionVersion: entry.sessionVersion,
        paperItemID: entry.paperItemID,
        providerSessionId: entry.providerSessionId,
        scopedConversationKey: entry.scopedConversationKey,
        mode: entry.kind === "paper" ? "paper" : "open",
      });

      const hydrateStandaloneHistoryDeletionEntry = async (
        entry: SidebarConv,
      ): Promise<SidebarConv> => {
        const conversationKey = Number(entry.conversationKey || 0);
        const kind =
          entry.kind || (entry.mode === "paper" ? "paper" : "global");
        const conversationSystem =
          entry.conversationSystem || currentConversationSystem;
        if (!conversationKey) {
          return { ...entry, kind, conversationSystem };
        }
        try {
          const summary = await conversationRepository.getCatalogEntry({
            system: conversationSystem,
            kind,
            conversationKey,
          });
          if (!summary || summary.kind !== kind) {
            return {
              ...entry,
              kind,
              conversationSystem,
              libraryID: entry.libraryID || getCurrentLibraryScopeID(),
            };
          }
          return toSidebarConversation(summary);
        } catch (err) {
          appLogger.warn(
            "LLM: Failed to hydrate standalone history row before deletion",
            { conversationKey, error: err },
          );
          return {
            ...entry,
            kind,
            conversationSystem,
            libraryID: entry.libraryID || getCurrentLibraryScopeID(),
          };
        }
      };

      // Like the panel, never delete a conversation that is generating:
      // queueing the deletion fences the send's writes, so an Undo would
      // restore the chat with an answer that streamed but was never saved.
      const rejectStandaloneDeletionWhileGenerating = (
        conversationKey: number,
      ): boolean => {
        if (!isRequestPending(conversationKey)) return false;
        setStandaloneHistoryStatus(
          t("Cannot delete while generating"),
          "ready",
        );
        return true;
      };

      const queueStandaloneHistoryDeletion = async (rawEntry: SidebarConv) => {
        const rawKey = Number(rawEntry.conversationKey || 0);
        if (rawKey && rejectStandaloneDeletionWhileGenerating(rawKey)) return;
        const entry = await hydrateStandaloneHistoryDeletionEntry(rawEntry);
        const key = Number(entry.conversationKey || 0);
        if (!key) return;
        const isActive = key === activeConversationKey;
        if (pendingDeletionStore.isConversationPendingDeletion(key)) {
          return;
        }

        const deletionConversationSystem =
          entry.conversationSystem || currentConversationSystem;
        try {
          const conversationKind =
            (entry.kind || (standaloneMode === "open" ? "global" : "paper")) ===
            "paper"
              ? ("paper" as const)
              : ("global" as const);
          // Persist the write-ahead intent before moving an active window.
          // The queued event performs the move after the row is durable, so a
          // crash cannot strand the user in a new chat without an obligation.
          // The pending-deletion check above runs before the witness read;
          // the final check refuses a send that started in the meantime.
          const queueResult = await queueWitnessedConversationDeletion({
            intent: {
              conversationKind,
              conversationID: entry.conversationID,
              conversationKey: key,
              libraryID:
                Number(entry.libraryID || 0) ||
                (entry.kind === "paper"
                  ? getCurrentPaperLibraryID()
                  : getCurrentLibraryScopeID()),
              system: deletionConversationSystem,
              paperItemID: entry.paperItemID,
              providerSessionId: entry.providerSessionId || undefined,
              title: entry.title || "",
              wasActive: isActive,
            },
            finalCheck: () => !rejectStandaloneDeletionWhileGenerating(key),
          });
          if (queueResult.status === "refused") return;
          if (queueResult.status === "failed") {
            setStandaloneHistoryStatus(
              t("Failed to queue deletion. Check logs."),
              "error",
            );
            return;
          }
          const queued = queueResult.entry;
          if (isActive) {
            // We already stepped off this chat above; remember where we came
            // from so an undo or an abandoned deletion can put the user back.
            standaloneSurrenderedDeletions.set(queued.id, entry);
          }
          await renderSidebar();
          setStandaloneHistoryStatus(
            t("Conversation deleted. Undo available."),
            "ready",
          );
        } catch (err) {
          appLogger.warn("LLM: standalone delete conversation failed", err);
          if (isActive) {
            await switchStandaloneToConversationEntry(entry).catch(() => {});
          }
          await renderSidebar().catch(() => {});
        }
      };

      // Sidebar click handler — rename or delete conversation
      sidebarList.addEventListener("click", async (e: Event) => {
        const renameTarget = (e.target as HTMLElement).closest(
          ".llm-standalone-conv-rename",
        ) as HTMLElement | null;
        if (renameTarget) {
          e.preventDefault();
          e.stopPropagation();
          const row = renameTarget.closest(
            ".llm-standalone-conv-item",
          ) as HTMLElement | null;
          if (!row) return;
          const key = Number(row.dataset.conversationKey);
          if (!key) return;
          const entry = standaloneSidebarEntriesByKey.get(key);
          if (!entry) return;
          await renameStandaloneHistoryEntry(entry);
          return;
        }

        const deleteTarget = (e.target as HTMLElement).closest(
          ".llm-standalone-conv-delete",
        ) as HTMLElement | null;
        if (deleteTarget) {
          e.preventDefault();
          e.stopPropagation();
          const row = deleteTarget.closest(
            ".llm-standalone-conv-item",
          ) as HTMLElement | null;
          if (!row) return;
          const key = Number(row.dataset.conversationKey);
          if (!key) return;
          const entry = standaloneSidebarEntriesByKey.get(key);
          if (!entry) return;
          await queueStandaloneHistoryDeletion({
            ...entry,
            conversationKey: key,
            lastActivityAt: entry.lastActivityAt,
          });
          return;
        }
      });

      // Sidebar click handler — switch conversation
      sidebarList.addEventListener("click", (e: Event) => {
        const target = (e.target as HTMLElement).closest(
          ".llm-standalone-conv-item",
        ) as HTMLElement | null;
        if (!target) return;
        // Ignore row actions handled above.
        if (
          (e.target as HTMLElement).closest(
            ".llm-standalone-conv-rename, .llm-standalone-conv-delete",
          )
        )
          return;
        const key = Number(target.dataset.conversationKey);
        if (!key || key === activeConversationKey) return;
        const openSeq = ++standaloneHistoryOpenSeq;
        const rowSystem =
          standaloneSidebarEntriesByKey.get(key)?.conversationSystem ||
          currentConversationSystem;

        const openRow = () => {
          activeConversationKey = key;
          markStandaloneSidebarActiveRow(key);

          if (standaloneMode === "open") {
            const currentLibraryID = getCurrentLibraryScopeID();
            rememberStandaloneGlobalConversation(
              currentConversationSystem,
              currentLibraryID,
              key,
              windowSurface,
            );
            const newItem = buildStandalonePortalItem({
              mode: "open",
              conversationKey: key,
            });
            if (newItem) void showStandaloneConversation(newItem);
          } else {
            if (currentBasePaperItem) {
              const sessionVersion = Number(
                target.dataset.sessionVersion || "0",
              );
              const newItem = buildStandalonePortalItem({
                mode: "paper",
                conversationKey: key,
                paperItem: currentBasePaperItem,
                sessionVersion,
              });
              currentPaperItem = currentBasePaperItem;
              if (newItem) void showStandaloneConversation(newItem);
            }
          }
        };

        if (rowSystem === currentConversationSystem) {
          openRow();
          return;
        }
        // A row of another runtime: the window adopts that runtime first.
        void adoptStandaloneRuntime(rowSystem).then((adopted) => {
          if (
            !adopted ||
            openSeq !== standaloneHistoryOpenSeq ||
            cancelled ||
            newWin.closed
          ) {
            return;
          }
          openRow();
        });
      });

      sidebarList.addEventListener("keydown", (e: Event) => {
        const event = e as KeyboardEvent;
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target as HTMLElement;
        const row = target.closest(
          ".llm-standalone-conv-item",
        ) as HTMLElement | null;
        if (!row || target !== row) return;
        event.preventDefault();
        row.click();
      });

      /**
       * The conversation on screen may belong to the runtime the window is
       * leaving: `currentConversationSystem` flips before the key moves. Only a
       * key from the entered runtime's own key space may be offered as that
       * runtime's current draft, or the window would mount the new runtime on
       * the old runtime's conversation and its declared scope would stop
       * describing what it is showing.
       */
      const currentDraftCandidateForSystem = (
        kind: "global" | "paper",
      ): number => {
        const key = Math.floor(Number(activeConversationKey || 0));
        if (!Number.isFinite(key) || key <= 0) return 0;
        return isConversationKeyForKind(currentConversationSystem, kind, key)
          ? key
          : 0;
      };

      const resolveFreshStandaloneGlobalConversation = async (
        options: boolean | StandaloneCreateConversationOptions = false,
      ): Promise<number> => {
        const { excludeConversationKey } =
          normalizeStandaloneCreateConversationOptions(options);
        const currentLibraryID = getCurrentLibraryScopeID();
        if (!currentLibraryID) return 0;
        const result = await resolveFreshConversationDraft({
          system: currentConversationSystem,
          kind: "global",
          libraryID: currentLibraryID,
          currentConversationKey: currentDraftCandidateForSystem("global"),
          excludeConversationKey,
        });
        return result.conversationKey;
      };

      const resolveStandalonePaperConversation = async (
        options: boolean | StandaloneCreateConversationOptions = false,
        paperItemOverride?: Zotero.Item | null,
      ): Promise<{ conversationKey: number; sessionVersion?: number }> => {
        const { excludeConversationKey } =
          normalizeStandaloneCreateConversationOptions(options);
        const targetPaperItem = paperItemOverride || currentBasePaperItem;
        if (!targetPaperItem) {
          return { conversationKey: 0 };
        }
        const paperLibraryID = getLibraryIDForPaperItem(targetPaperItem);
        const paperId = Number(targetPaperItem.id || 0);
        if (!paperLibraryID || !paperId) {
          return { conversationKey: 0 };
        }
        const result = await resolveFreshConversationDraft({
          system: currentConversationSystem,
          kind: "paper",
          libraryID: paperLibraryID,
          paperItemID: paperId,
          currentConversationKey: currentDraftCandidateForSystem("paper"),
          excludeConversationKey,
        });
        return {
          conversationKey: result.conversationKey,
          sessionVersion: result.sessionVersion,
        };
      };

      const touchStandaloneEmptyDraftActivity = async (
        conversationKey: number,
        kind: "global" | "paper",
      ): Promise<void> => {
        const normalizedKey = Number.isFinite(conversationKey)
          ? Math.floor(conversationKey)
          : 0;
        if (normalizedKey <= 0) return;
        await conversationRepository.touchEmptyCatalogActivity({
          system: currentConversationSystem,
          kind,
          conversationKey: normalizedKey,
          timestamp: Date.now(),
        });
      };

      const mountStandaloneOpenConversation = async (
        conversationKey: number,
      ): Promise<boolean> => {
        const normalizedKey = Number.isFinite(conversationKey)
          ? Math.floor(conversationKey)
          : 0;
        if (normalizedKey <= 0 || cancelled) return false;
        standaloneMode = "open";
        paperTab.classList.remove("active");
        openTab.classList.add("active");
        activeConversationKey = normalizedKey;
        const currentLibraryID = getCurrentLibraryScopeID();
        rememberStandaloneGlobalConversation(
          currentConversationSystem,
          currentLibraryID,
          normalizedKey,
          windowSurface,
        );
        const nextItem = buildStandalonePortalItem({
          mode: "open",
          conversationKey: normalizedKey,
        });
        if (!nextItem) {
          return false;
        }
        scheduleStandaloneSidebarRender();
        await showStandaloneConversation(nextItem);
        return true;
      };

      const createStandaloneOpenConversationForContext =
        async (): Promise<boolean> => {
          const currentLibraryID = getCurrentLibraryScopeID();
          if (!currentLibraryID) return false;
          const summary = await conversationRepository.createCatalogEntry({
            system: currentConversationSystem,
            kind: "global",
            libraryID: currentLibraryID,
          });
          const conversationKey = Number(summary?.conversationKey || 0);
          if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
            return false;
          }
          if (cancelled) return false;
          await touchStandaloneEmptyDraftActivity(conversationKey, "global");
          return await mountStandaloneOpenConversation(conversationKey);
        };

      const restoreStandaloneOpenConversation = async (
        options: boolean | StandaloneCreateConversationOptions = false,
      ): Promise<boolean> => {
        const normalizedOptions =
          normalizeStandaloneCreateConversationOptions(options);
        const rememberedItem =
          !normalizedOptions.forceFresh &&
          !normalizedOptions.excludeConversationKey
            ? resolveRememberedGlobalPanelItem(
                getCurrentLibraryScopeID(),
                currentConversationSystem,
                windowSurface,
              )
            : null;
        const conversationKey = rememberedItem
          ? getConversationKey(rememberedItem)
          : await resolveFreshStandaloneGlobalConversation(normalizedOptions);
        if (!conversationKey || cancelled) {
          return false;
        }
        return await mountStandaloneOpenConversation(conversationKey);
      };

      // Icon strip handlers — new chat
      iconNewChat.addEventListener("click", async () => {
        if (explicitNewChatInFlight) return;
        explicitNewChatInFlight = true;
        try {
          // [webchat] In webchat mode, delegate to embedded panel's "+" button.
          // Don't clear sidebar — webchat history stays (conversations live on the web).
          if (isInWebChatMode) {
            const embeddedNewBtn = contentArea.querySelector(
              "#llm-history-new",
            ) as HTMLElement | null;
            if (embeddedNewBtn) embeddedNewBtn.click();
            return;
          }

          if (standaloneMode === "open") {
            const currentLibraryID = getCurrentLibraryScopeID();
            const newKey = await resolveFreshStandaloneGlobalConversation(true);
            if (!newKey || cancelled) return;
            await touchStandaloneEmptyDraftActivity(newKey, "global");
            activeConversationKey = newKey;
            rememberStandaloneGlobalConversation(
              currentConversationSystem,
              currentLibraryID,
              newKey,
              windowSurface,
            );
            const newItem = buildStandalonePortalItem({
              mode: "open",
              conversationKey: newKey,
            });
            if (!newItem) return;
            await showStandaloneConversation(newItem);
            await renderSidebar();
          } else {
            if (currentBasePaperItem) {
              const { conversationKey: newKey, sessionVersion } =
                await resolveStandalonePaperConversation(true);
              if (!newKey || cancelled) return;
              await touchStandaloneEmptyDraftActivity(newKey, "paper");
              const newItem = buildStandalonePortalItem({
                mode: "paper",
                conversationKey: newKey,
                paperItem: currentBasePaperItem,
                sessionVersion,
              });
              if (!newItem) return;
              activeConversationKey = newKey;
              currentPaperItem = currentBasePaperItem;
              await showStandaloneConversation(newItem);
              await renderSidebar();
            }
          }
        } catch (err) {
          appLogger.warn("LLM: standalone new chat failed", err);
        } finally {
          explicitNewChatInFlight = false;
        }
      });

      iconSidebarToggle.addEventListener("click", () => toggleSidebar());

      // Standalone navigation and content-title actions
      iconSettings.addEventListener("click", () => {
        const btn = contentArea.querySelector(
          "#llm-settings",
        ) as HTMLElement | null;
        if (btn) btn.click();
      });
      // The export popup opens under `anchor`, flush with its right edge.
      const openExportPopup = (anchor: HTMLElement) => {
        const iconRect = anchor.getBoundingClientRect();
        exportPopup.style.position = "fixed";
        exportPopup.style.left = "auto";
        exportPopup.style.right = `${Math.max(
          8,
          Math.round(newWin.innerWidth - iconRect.right),
        )}px`;
        exportPopup.style.top = `${Math.round(iconRect.bottom + 4)}px`;
        exportPopup.style.display = "flex";
      };
      iconExport.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        if (exportPopup.style.display !== "none") {
          exportPopup.style.display = "none";
          return;
        }
        openExportPopup(iconExport);
      });
      exportPopupCopyBtn.addEventListener("click", () => {
        exportPopup.style.display = "none";
        const innerBtn = contentArea.querySelector(
          "#llm-export-copy",
        ) as HTMLElement | null;
        if (innerBtn) innerBtn.click();
      });
      exportPopupNoteBtn.addEventListener("click", () => {
        exportPopup.style.display = "none";
        const innerBtn = contentArea.querySelector(
          "#llm-export-note",
        ) as HTMLElement | null;
        if (innerBtn) innerBtn.click();
      });
      iconClear.addEventListener("click", () => {
        const btn = contentArea.querySelector(
          "#llm-clear",
        ) as HTMLElement | null;
        if (btn) btn.click();
      });

      // A follower's More menu. Its items run the handlers of the Task
      // progress, Export and Delete buttons, which a follower keeps out of
      // the page (the same buttons, so the same state and the same flows).
      if (
        iconFollowerMore &&
        followerMoreMenu &&
        followerMoreTaskItem &&
        followerMoreExportItem &&
        followerMoreDeleteItem
      ) {
        const moreButton = iconFollowerMore;
        const moreMenu = followerMoreMenu;
        const taskItem = followerMoreTaskItem;
        const hideMoreMenu = () => {
          moreMenu.style.display = "none";
          moreButton.setAttribute("aria-expanded", "false");
        };
        const showMoreMenu = () => {
          // Task progress shows its state, and is off where the row never
          // shows (a note chat, no conversation).
          const applies = iconTaskProgress.style.display !== "none";
          const pressed = iconTaskProgress.getAttribute("aria-pressed");
          taskItem.setAttribute(
            "aria-checked",
            applies && pressed === "true" ? "true" : "false",
          );
          taskItem.disabled = !applies;
          exportPopup.style.display = "none";
          moreMenu.style.display = "flex";
          const rect = moreButton.getBoundingClientRect();
          moreMenu.style.left = "auto";
          moreMenu.style.right = `${Math.max(
            8,
            Math.round(newWin.innerWidth - rect.right),
          )}px`;
          moreMenu.style.top = `${Math.round(rect.bottom + 4)}px`;
          moreButton.setAttribute("aria-expanded", "true");
        };
        moreButton.addEventListener("click", () => {
          if (moreMenu.style.display !== "none") hideMoreMenu();
          else showMoreMenu();
        });
        taskItem.addEventListener("click", () => {
          hideMoreMenu();
          iconTaskProgress.click();
        });
        followerMoreExportItem.addEventListener("click", () => {
          hideMoreMenu();
          openExportPopup(moreButton);
        });
        followerMoreDeleteItem.addEventListener("click", () => {
          hideMoreMenu();
          iconClear.click();
        });
        doc.addEventListener("mousedown", (e: Event) => {
          if (moreMenu.style.display === "none") return;
          const target = e.target as Node;
          if (!moreMenu.contains(target) && !moreButton.contains(target)) {
            hideMoreMenu();
          }
        });
        doc.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Escape" && moreMenu.style.display !== "none") {
            hideMoreMenu();
          }
        });
      }

      // -----------------------------------------------------------------------
      // Top bar tab switching
      // -----------------------------------------------------------------------
      let systemSwitchSeq = 0;
      const switchConversationSystem = async (
        nextSystem: ConversationSystem,
        options?: { forceFresh?: boolean },
      ) => {
        const switchSeq = ++systemSwitchSeq;
        // WebChat is an upstream-only provider mode. Leaving it here restores
        // a non-webchat model entry before the runtime changes, so the
        // remounted panel (and a later return to upstream) cannot silently
        // re-enter webchat; the remount replaces the conversation itself.
        if (isInWebChatMode) {
          await currentChatHooks?.leaveWebChatMode?.();
          if (switchSeq !== systemSwitchSeq || cancelled || newWin.closed)
            return;
        }
        const activeNoteSession = resolveActiveNoteSession(activeItem);
        const activeNoteItem = activeNoteSession ? activeItem : null;
        if (activeNoteSession && activeNoteItem) {
          const resolvedNextSystem = resolveNoteFocusSystemSwitch({
            nextSystem,
            codexAvailable: isCodexAppServerModeEnabled(),
            claudeAvailable: getClaudeCodeModeEnabled(),
          });
          if (!resolvedNextSystem) return;
          if (resolvedNextSystem === currentConversationSystem) return;
          // The window's backend is its own; the sidebar keeps the saved one.
          surfaceChoices.conversationSystem.set(
            resolvedNextSystem,
            windowSurface,
          );
          currentConversationSystem = resolvedNextSystem;
          if (options?.forceFresh === true) {
            if (activeNoteSession.conversationKind === "global") {
              const newKey =
                await resolveFreshStandaloneGlobalConversation(true);
              if (switchSeq !== systemSwitchSeq || !newKey) return;
              await touchStandaloneEmptyDraftActivity(newKey, "global");
              if (switchSeq !== systemSwitchSeq) return;
              const libraryID = activeNoteSession.libraryID;
              rememberStandaloneGlobalConversation(
                resolvedNextSystem,
                libraryID,
                newKey,
                windowSurface,
              );
              activeConversationKey = newKey;
            } else {
              const paperItem =
                currentBasePaperItem ||
                resolveConversationBaseItem(activeNoteItem);
              const { conversationKey: newKey } =
                await resolveStandalonePaperConversation(true, paperItem);
              if (switchSeq !== systemSwitchSeq || !newKey || !paperItem)
                return;
              await touchStandaloneEmptyDraftActivity(newKey, "paper");
              if (switchSeq !== systemSwitchSeq) return;
              const libraryID = getLibraryIDForPaperItem(paperItem);
              const paperItemID = Number(paperItem.id || 0);
              rememberStandalonePaperConversation(
                resolvedNextSystem,
                libraryID,
                paperItemID,
                newKey,
                windowSurface,
              );
              activeConversationKey = newKey;
            }
          }
          if (switchSeq !== systemSwitchSeq || cancelled || newWin.closed)
            return;
          activeConversationKey = getConversationKey(activeNoteItem);
          mountChatPanel(activeNoteItem);
          scheduleStandaloneSidebarRender();
          updateStandaloneSystemToggles();
          return;
        }
        const currentSystem = currentConversationSystem;
        if (nextSystem === currentSystem) return;
        const forceFresh = options?.forceFresh === true;
        surfaceChoices.conversationSystem.set(nextSystem, windowSurface);
        currentConversationSystem = nextSystem;
        updateStandaloneSystemToggles();
        if (standaloneMode === "open") {
          const libraryID = getCurrentLibraryScopeID();
          const mountOpenConversation = (conversationKey: number) => {
            if (switchSeq !== systemSwitchSeq) return;
            const nextItem =
              nextSystem === "claude_code"
                ? createClaudeGlobalPortalItem(libraryID, conversationKey)
                : nextSystem === "codex"
                  ? createCodexGlobalPortalItem(libraryID, conversationKey)
                  : createGlobalPortalItem(libraryID, conversationKey);
            activeConversationKey = conversationKey;
            rememberStandaloneGlobalConversation(
              nextSystem,
              libraryID,
              conversationKey,
              windowSurface,
            );
            mountChatPanel(nextItem as Zotero.Item);
            scheduleStandaloneSidebarRender();
            updateStandaloneSystemToggles();
          };

          if (forceFresh) {
            const newKey = await resolveFreshStandaloneGlobalConversation(true);
            if (switchSeq !== systemSwitchSeq) return;
            if (newKey > 0) {
              await touchStandaloneEmptyDraftActivity(newKey, "global");
              if (switchSeq !== systemSwitchSeq) return;
              mountOpenConversation(newKey);
            }
            return;
          }

          const rememberedItem = resolveRememberedGlobalPanelItem(
            libraryID,
            nextSystem,
            windowSurface,
          );
          const targetKey = rememberedItem
            ? getConversationKey(rememberedItem)
            : 0;
          if (switchSeq !== systemSwitchSeq) return;
          if (targetKey > 0) {
            mountOpenConversation(targetKey);
          }
          return;
        }
        // A torn-off window stays on its own paper, never the one Zotero
        // shows.
        const nextRawItem = linkedToReader
          ? getSelectedZoteroItem() || currentBasePaperItem || currentPaperItem
          : currentBasePaperItem || currentPaperItem || currentRawContextItem;
        const resolved = resolveInitialPanelItemState(nextRawItem, {
          conversationSystem: nextSystem,
          conversationMode: "paper",
          surface: windowSurface,
        });
        currentRawContextItem = nextRawItem || currentRawContextItem;
        currentBasePaperItem = resolved.basePaperItem || currentBasePaperItem;
        currentPaperItem = resolved.item || currentPaperItem;
        if (forceFresh) {
          const paperItem = currentBasePaperItem;
          if (!paperItem) return;
          const { conversationKey: newKey, sessionVersion } =
            await resolveStandalonePaperConversation(true);
          if (switchSeq !== systemSwitchSeq) return;
          if (!newKey) return;
          await touchStandaloneEmptyDraftActivity(newKey, "paper");
          if (switchSeq !== systemSwitchSeq) return;
          const freshItem =
            nextSystem === "claude_code"
              ? createClaudePaperPortalItem(paperItem, newKey)
              : nextSystem === "codex"
                ? createCodexPaperPortalItem(paperItem, newKey)
                : createPaperPortalItem(paperItem, newKey, sessionVersion || 1);
          activeConversationKey = newKey;
          currentPaperItem = paperItem;
          mountChatPanel(freshItem as Zotero.Item, currentRawContextItem);
          scheduleStandaloneSidebarRender();
          void renderShortcuts(contentArea, freshItem as Zotero.Item, "paper");
          updateStandaloneSystemToggles();
          return;
        }
        if (switchSeq !== systemSwitchSeq) return;
        const nextItem = resolved.item || nextRawItem;
        if (nextItem) {
          mountChatPanel(nextItem, currentRawContextItem);
          scheduleStandaloneSidebarRender();
          void renderShortcuts(
            contentArea,
            nextItem,
            resolveShortcutMode(nextItem),
          );
        }
        updateStandaloneSystemToggles();
      };

      /**
       * Makes `system` the window's runtime for a history row of that runtime,
       * without mounting anything: the caller mounts the row's chat next.
       * Leaves WebChat first. The sidebar's saved runtime is not touched.
       * Resolves false when the runtime is off or a newer switch started.
       */
      adoptStandaloneRuntime = async (
        system: ConversationSystem,
      ): Promise<boolean> => {
        if (
          (system === "codex" && !isCodexAppServerModeEnabled()) ||
          (system === "claude_code" && !getClaudeCodeModeEnabled())
        ) {
          return false;
        }
        const switchSeq = ++systemSwitchSeq;
        if (isInWebChatMode) {
          await currentChatHooks?.leaveWebChatMode?.();
          if (switchSeq !== systemSwitchSeq || cancelled || newWin.closed) {
            return false;
          }
        }
        if (system !== currentConversationSystem) {
          surfaceChoices.conversationSystem.set(system, windowSurface);
          currentConversationSystem = system;
        }
        updateStandaloneSystemToggles();
        return true;
      };

      for (const system of RUNTIME_CONVERSATION_SYSTEMS) {
        standaloneRuntimeSystemControls.buttons[system].addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            // A rebuilt standalone shell must never let duplicate listeners
            // turn one physical click into two runtime toggles.
            event.stopImmediatePropagation();
            if (cancelled || newWin.closed) return;
            void switchConversationSystem(
              resolveRuntimeSystemToggleTarget(
                currentConversationSystem,
                system,
              ),
              { forceFresh: true },
            );
          },
        );
      }
      updateStandaloneSystemToggles();
      {
        const claudeModePrefKey = `${config.prefsPrefix}.enableClaudeCodeMode`;
        const codexModePrefKey = `${config.prefsPrefix}.enableCodexAppServerMode`;
        let claudeObserverId: symbol | undefined;
        let codexObserverId: symbol | undefined;
        const unregister = () => {
          for (const observerId of [claudeObserverId, codexObserverId]) {
            if (observerId === undefined) continue;
            try {
              (Zotero as any).Prefs.unregisterObserver(observerId);
            } catch {
              void 0;
            }
          }
          claudeObserverId = undefined;
          codexObserverId = undefined;
        };
        cleanupStandalonePrefObserver = unregister;
        // The runtime of the chat on screen was turned off. The leader moves
        // to the Agent runtime; a follower holds one chat, so it closes rather
        // than show another chat (which another window may hold). It closes
        // after this pref notification: closing unregisters its observers,
        // and doing that while Zotero walks the observer list skips the next
        // window's.
        const leaveTurnedOffRuntime = () => {
          if (!linkedToReader) {
            newWin.setTimeout(() => {
              if (!newWin.closed) newWin.close();
            }, 0);
            return;
          }
          void switchConversationSystem("upstream");
        };
        const onClaudeModePrefChange = () => {
          if (cancelled || newWin.closed) {
            unregister();
            return;
          }
          if (!getClaudeCodeModeEnabled()) {
            void releaseClaudeRuntimeForBody(contentArea as Element);
            void initAgentSubsystem()
              .then((coreRuntime) =>
                invalidateAllClaudeHotRuntimes(coreRuntime),
              )
              .catch((err) => {
                appLogger.warn(
                  "LLM: Failed to invalidate all Claude hot runtimes",
                  err,
                );
              });
            demoteConversationSystemOnEverySurface("claude_code");
            if (isClaudeConversationSystem()) {
              leaveTurnedOffRuntime();
              return;
            }
          }
          updateStandaloneSystemToggles();
        };
        const onCodexModePrefChange = () => {
          if (cancelled || newWin.closed) {
            unregister();
            return;
          }
          if (!isCodexAppServerModeEnabled()) {
            demoteConversationSystemOnEverySurface("codex");
            if (isCodexConversationSystem()) {
              leaveTurnedOffRuntime();
              return;
            }
          }
          updateStandaloneSystemToggles();
        };
        try {
          claudeObserverId = (Zotero as any).Prefs.registerObserver(
            claudeModePrefKey,
            onClaudeModePrefChange,
            true,
          );
          codexObserverId = (Zotero as any).Prefs.registerObserver(
            codexModePrefKey,
            onCodexModePrefChange,
            true,
          );
        } catch {
          void 0;
        }
      }

      const commitStandaloneMode = (mode: "open" | "paper") => {
        standaloneMode = mode;
        // The window's own mode slot only; the sidebar's mode and the
        // persisted mode stay as they are.
        rememberMode(
          currentConversationSystem,
          getCurrentLibraryScopeID(),
          mode === "open" ? "global" : "paper",
          { surface: windowSurface },
        );
        paperTab.classList.toggle("active", mode === "paper");
        openTab.classList.toggle("active", mode === "open");
      };

      const showNoPaperChatSourceStatus = () => {
        setStandaloneHistoryStatus(
          t("Open a supported Zotero document to start a paper chat"),
          "error",
        );
      };

      const resolvePaperSwitchTarget = (
        rawItem: Zotero.Item | null,
      ): {
        rawItem: Zotero.Item | null;
        paperItem: Zotero.Item | null;
        panelItem: Zotero.Item | null;
      } => {
        const resolved = resolveInitialPanelItemState(rawItem, {
          conversationSystem: currentConversationSystem,
          conversationMode: "paper",
          surface: windowSurface,
        });
        const paperItem =
          resolved.basePaperItem ||
          (rawItem ? resolvePaperChatSourceItem(rawItem) : null);
        return {
          rawItem,
          paperItem,
          panelItem: resolved.item || paperItem,
        };
      };

      const mountRememberedStandalonePaperConversation = (params: {
        paperItem: Zotero.Item;
        panelItem?: Zotero.Item | null;
        rawItem?: Zotero.Item | null;
      }): boolean => {
        const paperLibraryID = getLibraryIDForPaperItem(params.paperItem);
        const paperId = Number(params.paperItem.id || 0);
        if (
          !Number.isFinite(paperLibraryID) ||
          paperLibraryID <= 0 ||
          !Number.isFinite(paperId) ||
          paperId <= 0
        ) {
          return false;
        }
        const nextItem = params.panelItem || params.paperItem;
        if (cancelled) return false;
        currentRawContextItem = params.rawItem || params.paperItem;
        currentBasePaperItem = params.paperItem;
        currentPaperItem = nextItem;
        commitStandaloneMode("paper");
        mountChatPanel(nextItem, currentRawContextItem);
        scheduleStandaloneSidebarRender();
        return true;
      };

      const switchToMode = async (mode: "open" | "paper") => {
        try {
          // [webchat] If in webchat mode and user clicks "Library chat", exit webchat first
          if (isInWebChatMode && mode === "open") {
            const clearBtnEl = contentArea.querySelector(
              "#llm-clear",
            ) as HTMLElement | null;
            if (clearBtnEl) clearBtnEl.click();
          }
          if (isInWebChatMode && mode === "paper") return;
          if (mode === standaloneMode) return;

          if (mode === "open") {
            const rememberedItem = resolveRememberedGlobalPanelItem(
              getCurrentLibraryScopeID(),
              currentConversationSystem,
              windowSurface,
            );
            const key = rememberedItem ? getConversationKey(rememberedItem) : 0;
            if (!key) return;
            commitStandaloneMode("open");
            await mountStandaloneOpenConversation(key);
            return;
          }

          // A torn-off window returns to its own paper, never the one Zotero
          // shows; once that paper is in the trash it has none.
          const rawItem = linkedToReader
            ? getSelectedZoteroItem() ||
              currentRawContextItem ||
              currentBasePaperItem ||
              currentPaperItem
            : currentBasePaperItem || currentPaperItem || currentRawContextItem;
          const target = resolvePaperSwitchTarget(rawItem);
          if (
            !target.paperItem ||
            (!linkedToReader && (target.paperItem as any).deleted)
          ) {
            showNoPaperChatSourceStatus();
            return;
          }
          const mounted = mountRememberedStandalonePaperConversation({
            paperItem: target.paperItem,
            panelItem: target.panelItem,
            rawItem: target.rawItem,
          });
          if (!mounted) {
            showNoPaperChatSourceStatus();
          }
        } catch (err) {
          appLogger.warn("LLM: standalone mode switch failed", err);
          if (mode === "paper") showNoPaperChatSourceStatus();
        }
      };

      paperTab.addEventListener("click", () => {
        void switchToMode("paper");
      });
      openTab.addEventListener("click", () => {
        void switchToMode("open");
      });

      // Auto-collapse sidebar when window is narrow, respecting manual override.
      // ResizeObserver is unavailable in some Gecko/XUL window contexts —
      // fall back to a simple resize event listener.
      let lastAutoState: "expanded" | "collapsed" | null = null;
      let lastAutoWidth: number | null = null;
      const resolveAutoSidebarState = (width: number) => {
        let autoState: "expanded" | "collapsed" =
          lastAutoState ||
          (width < STANDALONE_SIDEBAR_AUTO_COLLAPSE_THRESHOLD_PX
            ? "collapsed"
            : "expanded");
        if (
          lastAutoWidth !== null &&
          width < lastAutoWidth &&
          width < STANDALONE_SIDEBAR_AUTO_COLLAPSE_THRESHOLD_PX
        ) {
          autoState = "collapsed";
        } else if (
          lastAutoWidth !== null &&
          width > lastAutoWidth &&
          width > STANDALONE_SIDEBAR_AUTO_EXPAND_THRESHOLD_PX
        ) {
          autoState = "expanded";
        } else if (
          lastAutoWidth === null &&
          width >= STANDALONE_SIDEBAR_AUTO_COLLAPSE_THRESHOLD_PX
        ) {
          autoState = "expanded";
        }
        lastAutoWidth = width;
        return autoState;
      };
      const applyAutoSidebarState = (width: number) => {
        const autoState = resolveAutoSidebarState(width);
        if (userManualSidebarState !== null) {
          if (lastAutoState !== null && autoState !== lastAutoState) {
            userManualSidebarState = null;
            setSidebarState(autoState);
          }
        } else {
          setSidebarState(autoState);
        }
        lastAutoState = autoState;
      };
      // The History pane is measured against the room left of the side
      // panel. The panel widens the window by its own width, so opening or
      // closing it leaves that room (and the pane's state) unchanged; the
      // pending part covers the moment before the window reports its size.
      // Only a real narrowing (or a screen too small for the panel) counts.
      const resolveAutoSidebarWidth = (width: number) =>
        Math.max(
          0,
          width -
            (standaloneSidePanel?.getOccupiedWidth() || 0) +
            (standaloneSidePanel?.getPendingWindowWidthChange() || 0),
        );
      const applyAutoSidebarStateForCurrentWidth = () => {
        applyAutoSidebarState(resolveAutoSidebarWidth(root.clientWidth || 0));
      };
      const handleResize = () => {
        applyAutoSidebarStateForCurrentWidth();
      };
      const RO =
        (newWin as any).ResizeObserver || (globalThis as any).ResizeObserver;
      if (RO) {
        const resizeObserver = new RO((entries: any[]) => {
          const width = entries[0]?.contentRect?.width || root.clientWidth || 0;
          applyAutoSidebarState(resolveAutoSidebarWidth(width));
        });
        resizeObserver.observe(root);
      } else {
        newWin.addEventListener("resize", handleResize);
        handleResize();
      }

      // Cmd/Ctrl+W to close the standalone window
      newWin.addEventListener("keydown", (e: KeyboardEvent) => {
        const isMac = (Zotero as any).isMac;
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "w") {
          e.preventDefault();
          newWin.close();
        }
      });

      // Listen for paper tab changes in the main Zotero window.
      // When the user switches to a different paper, update the standalone chat.
      // A torn-off window keeps its own paper and never follows (see below).
      const readActivePaperID = () =>
        standaloneMode === "paper"
          ? Number(currentPaperItem?.id || 0) || null
          : null;
      // A pinned paper opened from the sidebar selects it in Zotero; until
      // that settles, other papers Zotero shows on the way are not followed.
      // Arriving at the pinned paper settles it. A paper skipped meanwhile is
      // checked again when the wait ends, so the window ends on what Zotero
      // shows.
      let pinnedPaperNavigation: { paperID: number; until: number } | null =
        null;
      let pinnedPaperRecheck: number | null = null;
      const followReaderItem = (rawItem: Zotero.Item | null) => {
        if (cancelled || standaloneMode !== "paper") return;
        const target = resolvePaperSwitchTarget(rawItem);
        const newBasePaper = target.paperItem;
        if (pinnedPaperNavigation) {
          const arrived =
            Number(newBasePaper?.id || 0) === pinnedPaperNavigation.paperID;
          if (arrived || Date.now() > pinnedPaperNavigation.until) {
            pinnedPaperNavigation = null;
          } else {
            if (pinnedPaperRecheck === null) {
              pinnedPaperRecheck = newWin.setTimeout(
                () => {
                  pinnedPaperRecheck = null;
                  if (cancelled) return;
                  pinnedPaperNavigation = null;
                  standaloneItemChangeHandler?.(readSelectedTabItem());
                },
                Math.max(0, pinnedPaperNavigation.until - Date.now()) + 50,
              );
            }
            return;
          }
        }
        if (!newBasePaper) {
          currentRawContextItem = rawItem;
          currentBasePaperItem = null;
          currentPaperItem = null;
          syncPaperTabLabel();
          void restoreStandaloneOpenConversation(false).then(() => {
            if (!cancelled) showNoPaperChatSourceStatus();
          });
          return;
        }
        // Skip if same paper
        const newPaperID = Number(newBasePaper.id || 0);
        const oldPaperID = Number(currentBasePaperItem?.id || 0);
        if (newPaperID > 0 && newPaperID === oldPaperID) {
          const newRawContextID = Number(rawItem?.id || 0);
          const oldRawContextID = Number(currentRawContextItem?.id || 0);
          if (newRawContextID > 0 && newRawContextID !== oldRawContextID) {
            currentRawContextItem = rawItem;
            mountChatPanel(
              target.panelItem ||
                activeItem ||
                currentPaperItem ||
                newBasePaper,
              rawItem,
            );
            scheduleStandaloneSidebarRender();
          }
          return;
        }
        // Switch to the new paper
        const mounted = mountRememberedStandalonePaperConversation({
          paperItem: newBasePaper,
          panelItem: target.panelItem,
          rawItem: target.rawItem || newBasePaper,
        });
        if (!mounted && !cancelled) {
          void restoreStandaloneOpenConversation(false).then(() => {
            if (!cancelled) showNoPaperChatSourceStatus();
          });
        }
      };

      // Follow the selected main-window tab from Zotero's own tab notifier.
      // The panels' onItemChange only fires when a tab's own host re-renders
      // with a new signature, so re-selecting a tab seen before was missed.
      const readSelectedTabItem = (): Zotero.Item | null => {
        const tabs = (mainWin as any)?.Zotero_Tabs;
        const tabID = tabs?.selectedID;
        if (!tabID) return null;
        if (tabs.selectedType === "library") return getSelectedZoteroItem();
        const reader = (Zotero as any).Reader?.getByTabID?.(tabID);
        const itemID = Number(reader?.itemID || 0);
        return itemID > 0 ? (Zotero.Items.get(itemID) as Zotero.Item) : null;
      };
      if (linkedToReader) {
        ownActivePaperIDReader = readActivePaperID;
        standaloneActivePaperIDReader = ownActivePaperIDReader;
        ownItemChangeHandler = followReaderItem;
        standaloneItemChangeHandler = ownItemChangeHandler;
        const tabFollowObserverID = Zotero.Notifier.registerObserver(
          {
            notify: (event: string) => {
              if (event !== "select") return;
              // Zotero_Tabs updates selectedID after it notifies.
              mainWin?.setTimeout(() => {
                if (cancelled || newWin.closed) return;
                const item = readSelectedTabItem();
                if (item) standaloneItemChangeHandler?.(item);
              }, 0);
            },
          },
          ["tab"],
          "llm-standalone-tab-follow",
        );
        cleanupStandaloneTabFollow = () =>
          Zotero.Notifier.unregisterObserver(tabFollowObserverID);
      } else {
        // A torn-off window's own paper moved to the trash (or deleted)
        // closes the window when it holds that paper's chat; the chat stays
        // in history. A library chat only forgets the paper it came from.
        const closeForTrashedOwnPaper = () => {
          if (cancelled || newWin.closed || !currentBasePaperItem) return;
          const paper = Zotero.Items.get(
            Number(currentBasePaperItem.id || 0),
          ) as Zotero.Item | false;
          if (paper && !(paper as any).deleted) return;
          if (standaloneMode === "paper") {
            newWin.close();
            return;
          }
          currentRawContextItem = null;
          currentBasePaperItem = null;
          currentPaperItem = null;
          syncPaperTabLabel();
          updateContentTitle();
        };
        const paperWatchObserverID = Zotero.Notifier.registerObserver(
          {
            notify: (event: string, _type: string, ids: unknown[]) => {
              if (event !== "trash" && event !== "delete" && event !== "modify")
                return;
              const paperID = Number(currentBasePaperItem?.id || 0);
              if (!paperID || !ids.some((id) => Number(id) === paperID)) return;
              newWin.setTimeout(closeForTrashedOwnPaper, 0);
            },
          },
          ["item"],
          "llm-torn-chat-paper-watch",
        );
        cleanupTornPaperWatch = () =>
          Zotero.Notifier.unregisterObserver(paperWatchObserverID);
      }

      // -- Pinned papers ------------------------------------------------------
      const savePinnedPapers = (ids: number[]) => {
        pinnedPaperIDs = ids;
        setStandalonePinnedPapersPref(ids);
      };
      const getPinnedPaper = (paperID: number): Zotero.Item | null => {
        const item = Zotero.Items.get(paperID) as Zotero.Item | false;
        return item && !(item as any).deleted ? item : null;
      };
      const togglePin = (paperID: number) => {
        savePinnedPapers(togglePinnedPaper(pinnedPaperIDs, paperID));
        if (!pinnedPaperIDs.includes(paperID)) {
          readyPinnedPaperIDs.delete(paperID);
        }
        syncPinButton();
        renderPinnedPapers();
      };
      /** The reader tab showing the paper (or one of its files), if open. */
      const findPaperReaderTab = (
        paperID: number,
      ): { tabID: string; item: Zotero.Item } | null => {
        const tabs = (mainWin as any)?.Zotero_Tabs;
        for (const tab of (tabs?._tabs || []) as any[]) {
          if (!String(tab?.type || "").startsWith("reader")) continue;
          const item = Zotero.Items.get(Number(tab?.data?.itemID || 0)) as
            | Zotero.Item
            | false;
          if (!item) continue;
          const base = resolvePaperChatSourceItem(item);
          if (Number(base?.id || 0) === paperID) {
            return { tabID: String(tab.id), item };
          }
        }
        return null;
      };
      /**
       * Shows the paper in Zotero too: its reader tab when one is open,
       * otherwise the paper selected in the library (no new reader tab).
       * keepTabFocused stops Zotero from focusing the reader, which would
       * bring the main Zotero window in front of this one.
       */
      const revealPaperInZotero = (paperID: number, readerTabID?: string) => {
        try {
          const tabs = (mainWin as any)?.Zotero_Tabs;
          const keepFocus = { keepTabFocused: true };
          if (readerTabID) {
            tabs?.select?.(readerTabID, false, keepFocus);
            return;
          }
          if (tabs && tabs.selectedID !== "zotero-pane") {
            tabs.select?.("zotero-pane", false, keepFocus);
          }
          void (mainWin as any)?.ZoteroPane?.selectItem?.(paperID);
        } catch (err) {
          appLogger.warn("LLM: standalone pinned paper reveal failed", err);
        }
      };
      const openPinnedPaper = (paperID: number) => {
        if (cancelled || isInWebChatMode) return;
        const paper = getPinnedPaper(paperID);
        if (!paper) {
          togglePin(paperID);
          return;
        }
        const readerTab = findPaperReaderTab(paperID);
        pinnedPaperNavigation = { paperID, until: Date.now() + 1500 };
        const shown =
          standaloneMode === "paper" &&
          Number(currentBasePaperItem?.id || 0) === paperID;
        if (!shown) {
          const target = resolvePaperSwitchTarget(readerTab?.item || paper);
          if (target.paperItem) {
            mountRememberedStandalonePaperConversation({
              paperItem: target.paperItem,
              panelItem: target.panelItem,
              rawItem: target.rawItem || target.paperItem,
            });
          }
        }
        revealPaperInZotero(paperID, readerTab?.tabID);
      };
      // "Open in main window" from a follower: this window shows the
      // follower's chat. A paper chat shows its paper in Zotero too, the way
      // a pinned paper does, so following the reader does not pull this
      // window back to the paper Zotero showed before. True once shown.
      const showFollowerChat = async (
        identity: TornChatIdentity,
      ): Promise<boolean> => {
        if (cancelled || newWin.closed) return false;
        const target = {
          system: identity.system,
          kind: identity.kind,
          sourceState: "active" as const,
          conversationKey: identity.conversationKey,
          libraryID: identity.libraryID,
          paperItemID: identity.paperItemID,
        };
        if (identity.kind !== "paper") {
          return selectStandaloneSearchEntry(target);
        }
        const paperID = Math.floor(Number(identity.paperItemID || 0));
        pinnedPaperNavigation = { paperID, until: Date.now() + 1500 };
        const shown = await selectStandaloneSearchEntry(target, {
          selectInZotero: false,
        });
        if (!shown || cancelled || newWin.closed) {
          pinnedPaperNavigation = null;
          return false;
        }
        revealPaperInZotero(paperID, findPaperReaderTab(paperID)?.tabID);
        return true;
      };
      renderPinnedPapers = () => {
        // A follower has no Pinned list.
        if (cancelled || !linkedToReader) return;
        const list = sidebarView.pinnedList;
        list.replaceChildren();
        const shownPaperID =
          standaloneMode === "paper"
            ? Number(currentBasePaperItem?.id || 0)
            : 0;
        let shownCount = 0;
        for (const paperID of pinnedPaperIDs) {
          const paper = getPinnedPaper(paperID);
          if (!paper) continue;
          shownCount += 1;
          const row = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
          row.className =
            "llm-standalone-conv-item llm-standalone-pinned-paper";
          row.classList.toggle("active", paperID === shownPaperID);
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          row.dataset.paperItemId = String(paperID);
          let title = "";
          try {
            title = String(paper.getField("title") || "");
          } catch {
            title = "";
          }
          row.title = title || resolvePaperShortLabel(paper);
          const label = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          label.className = "llm-standalone-conv-title";
          label.textContent = resolvePaperShortLabel(paper);
          row.append(label);
          const conversationKey = shownPaperConversationKeys.get(paperID) || 0;
          const dot = resolvePinnedPaperDot({
            writing: conversationKey > 0 && isRequestPending(conversationKey),
            readyUnseen: readyPinnedPaperIDs.has(paperID),
          });
          if (dot === "writing") {
            row.appendChild(
              createHistoryActivityIndicator(
                doc,
                conversationKey,
                t("Writing an answer"),
              ),
            );
          } else if (dot === "ready") {
            const ready = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            ready.className = "llm-standalone-pinned-ready";
            ready.setAttribute("role", "img");
            ready.setAttribute("aria-label", t("Answer ready"));
            ready.title = t("Answer ready");
            row.appendChild(ready);
          }
          const unpin = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          unpin.className = "llm-standalone-conv-delete";
          unpin.type = "button";
          unpin.dataset.action = "unpin";
          unpin.title = t("Unpin");
          unpin.setAttribute("aria-label", t("Unpin"));
          row.appendChild(unpin);
          list.appendChild(row);
        }
        // The section always shows (outside WebChat), empty or not.
        sidebarView.pinnedRegion.hidden = isInWebChatMode;
        sidebarView.pinnedClear.hidden = shownCount === 0;
      };
      // "Pinned" folds like an agent section; its fold is remembered.
      let pinnedCollapsed = getStandaloneSidebarPinnedCollapsedPref();
      const syncPinnedFold = () => {
        const header = sidebarView.pinnedHeader;
        header.setAttribute("aria-expanded", String(!pinnedCollapsed));
        if (pinnedCollapsed) header.dataset.collapsed = "true";
        else delete header.dataset.collapsed;
        header.title = t(
          pinnedCollapsed ? "Click to expand" : "Click to collapse",
        );
        sidebarView.pinnedList.hidden = pinnedCollapsed;
      };
      const togglePinnedFold = () => {
        pinnedCollapsed = !pinnedCollapsed;
        setStandaloneSidebarPinnedCollapsedPref(pinnedCollapsed);
        syncPinnedFold();
      };
      syncPinnedFold();
      sidebarView.pinnedHeader.addEventListener("click", (event) => {
        if ((event.target as Element | null)?.closest?.("button")) return;
        togglePinnedFold();
      });
      sidebarView.pinnedHeader.addEventListener("keydown", (event) => {
        if (event.target !== sidebarView.pinnedHeader) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        togglePinnedFold();
      });
      sidebarView.pinnedClear.addEventListener("click", () => {
        if (cancelled || !pinnedPaperIDs.length) return;
        savePinnedPapers([]);
        readyPinnedPaperIDs.clear();
        syncPinButton();
        renderPinnedPapers();
      });
      sidebarView.pinnedList.addEventListener("click", (event) => {
        const target = event.target as Element | null;
        const row = target?.closest?.(
          ".llm-standalone-pinned-paper",
        ) as HTMLElement | null;
        const paperID = Number(row?.dataset.paperItemId || 0);
        if (!row || paperID <= 0) return;
        if (target?.closest?.('[data-action="unpin"]')) {
          event.stopPropagation();
          togglePin(paperID);
          return;
        }
        openPinnedPaper(paperID);
      });
      sidebarView.pinnedList.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const row = (event.target as Element | null)?.closest?.(
            ".llm-standalone-pinned-paper",
          ) as HTMLElement | null;
          if (!row || event.target !== row) return;
          event.preventDefault();
          openPinnedPaper(Number(row.dataset.paperItemId || 0));
        },
      );
      iconPin.addEventListener("click", () => {
        const paperID =
          standaloneMode === "paper"
            ? Number(currentBasePaperItem?.id || 0)
            : 0;
        if (paperID > 0) togglePin(paperID);
      });
      // A pinned paper's dot follows its main chat's answer.
      disposePinnedPaperActivity = subscribeRequestActivity(
        (conversationKey) => {
          if (cancelled || !linkedToReader) return;
          for (const [paperID, key] of shownPaperConversationKeys) {
            if (key !== conversationKey) continue;
            readyPinnedPaperIDs = updateReadyPinnedPapers(readyPinnedPaperIDs, {
              paperID,
              pending: isRequestPending(conversationKey),
              shownPaperID:
                standaloneMode === "paper"
                  ? Number(currentBasePaperItem?.id || 0) || null
                  : null,
            });
            if (pinnedPaperIDs.includes(paperID)) renderPinnedPapers();
          }
        },
      );
      renderPinnedPapers();

      // Initial mount preserves the current paper/library conversation. The
      // only automatic blank draft is created once during Zotero startup.
      appLogger.debug(
        "LLM: standalone mounting initial item",
        "mode=" + standaloneMode,
        "itemId=" + (initialMountedItem?.id ?? "null"),
        "convKey=" + getConversationKey(initialMountedItem),
      );
      mountChatPanel(initialMountedItem, currentRawContextItem);
      appLogger.debug(
        "LLM: standalone renderSidebar start",
        "mode=" + standaloneMode,
      );
      scheduleStandaloneSidebarRender();
      // Followers' "Open in main window" lands here; a request made while
      // this window was opening runs now, after the initial mount.
      if (linkedToReader) {
        ownConversationOpener = showFollowerChat;
        standaloneConversationOpener = ownConversationOpener;
        const pending = takePendingLeaderConversation();
        if (pending) {
          showFollowerChat(pending.identity).then(pending.settle, (err) => {
            appLogger.warn("LLM: standalone open follower chat failed", err);
            pending.settle(false);
          });
        }
      }
    } catch (err) {
      appLogger.warn("LLM: standalone initWindow failed", err);
      // A follower waiting on this window keeps its chat.
      if (linkedToReader && !ownConversationOpener) {
        takePendingLeaderConversation()?.settle(false);
      }
      // Show a visible error so the window isn't silently blank
      try {
        const root = newWin.document?.getElementById(
          "llmforzotero-standalone-chat-root",
        );
        const target = root || newWin.document?.body;
        if (target) {
          const msg = newWin.document.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          msg.style.cssText =
            "display:flex;align-items:center;justify-content:center;" +
            "height:100%;color:#f87171;font-size:14px;padding:24px;text-align:center;";
          msg.textContent =
            "Failed to initialize chat window. Check the error console for details.";
          target.appendChild(msg);
        }
      } catch {
        /* ignore fallback errors */
      }
    }
  };

  const cleanupWindow = () => {
    cancelled = true;
    // Before the panel's teardown below, which would repaint the button.
    unbindStandaloneTaskProgressToggle?.();
    unbindStandaloneTaskProgressToggle = null;
    disposeHistoryActivity?.();
    disposeHistoryActivity = null;
    disposePinnedPaperActivity?.();
    disposePinnedPaperActivity = null;
    disposePluginUpdate?.();
    disposePluginUpdate = null;
    unsubscribeStandalonePendingDeletions?.();
    unsubscribeStandalonePendingDeletions = null;
    cleanupStandalonePrefObserver?.();
    cleanupStandaloneTabFollow?.();
    cleanupStandaloneTabFollow = null;
    cleanupTornPaperWatch?.();
    cleanupTornPaperWatch = null;
    cleanupStandaloneVerticalResize?.();
    cleanupStandaloneVerticalResize = null;
    cleanupStandaloneSidebarResize?.();
    cleanupStandaloneSidebarResize = null;
    cleanupStandaloneSidebarFlyout?.();
    cleanupStandaloneSidebarFlyout = null;
    // The side chat is never saved: closing the window drops it.
    try {
      disposeStandaloneSidePanel?.();
    } catch (err) {
      appLogger.warn("LLM: standalone side panel cleanup failed", err);
    }
    disposeStandaloneSidePanel = null;
    // Only the window that set the reader link (and the follower-chat
    // opener) clears it: closing a torn-off window leaves the standalone
    // window following the PDF reader.
    if (
      ownItemChangeHandler &&
      standaloneItemChangeHandler === ownItemChangeHandler
    ) {
      standaloneItemChangeHandler = null;
    }
    if (
      ownActivePaperIDReader &&
      standaloneActivePaperIDReader === ownActivePaperIDReader
    ) {
      standaloneActivePaperIDReader = null;
    }
    if (
      ownConversationOpener &&
      standaloneConversationOpener === ownConversationOpener
    ) {
      standaloneConversationOpener = null;
    }
    ownItemChangeHandler = null;
    ownActivePaperIDReader = null;
    ownConversationOpener = null;
    themeObserver?.disconnect();
    themeObserver = null;
    if (enforceStandaloneMinimumSize) {
      newWin.removeEventListener("resize", enforceStandaloneMinimumSize);
    }
    enforceStandaloneMinimumSize = null;
    if (darkMQ && onSchemeChange) {
      darkMQ.removeEventListener("change", onSchemeChange);
    }
    darkMQ = null;
    onSchemeChange = null;
    if (standaloneAttachmentGcTimer !== null) {
      newWin.clearTimeout(standaloneAttachmentGcTimer);
      standaloneAttachmentGcTimer = null;
    }
    if (linkedToReader) setStandalonePending(false);
    // Remove the standalone window's content area from panel tracking
    const root = newWin.document?.getElementById(
      "llmforzotero-standalone-chat-root",
    );
    const contentArea = root?.querySelector(".llm-standalone-content");
    if (contentArea) {
      disposeSetupHandlers(contentArea);
      // The window is closing, so its content area is still connected here and
      // the panel's own teardown keeps an open message edit; release it or the
      // edit pins the whole window DOM in memory.
      releaseInlineEdit(contentArea);
      clearPanelHostBinding(contentArea);
      void releaseClaudeRuntimeForBody(contentArea as Element);
      unregisterContextPanel(contentArea);
    }
    if (linkedToReader) {
      const sessionWin = getStandaloneSessionWindow();
      if (sessionWin === newWin || sessionWin === null) {
        setStandaloneSessionWindow(null);
      }
    }
    if (tornSurface) {
      // The window's in-memory selection and choices (its reasoning levels
      // too) go with it; nothing it chose was ever written to prefs.
      disposeTornRegistration?.();
      clearTornSelection(tornSurface);
      clearTornSurfaceChoices(tornSurface);
      clearSelectedReasoningForSurface(tornSurface);
    }
    releaseDisconnectedEmbeddedPanels(contentArea as Element | null);
  };

  newWin.addEventListener("load", initWindow, { once: true });
  // Note: unload is registered inside initWindow to avoid the XUL
  // about:blank → document transition firing a premature unload.
  return newWin;
}
