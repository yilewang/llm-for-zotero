import { config, GLOBAL_CONVERSATION_KEY_BASE, isUpstreamGlobalConversationKey } from "./constants";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  selectedModelCache,
  selectedReasoningCache,
  selectedRuntimeModeCache,
  getPendingRequestId,
  setPendingRequestId,
  setCancelledRequestId,
  getAbortController,
  setAbortController,
} from "./state";
import {
  resolveActiveLibraryID,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolveInitialPanelItemState,
  resolveConversationBaseItem,
  resolveActiveNoteSession,
  resolvePreferredConversationSystem,
  resolveNoteConversationSystemSwitch,
  resolveShortcutMode,
  createGlobalPortalItem,
  createPaperPortalItem,
} from "./portalScope";
import {
  applyPanelFontScale,
  buildPaperStateKey,
  getClaudeCodeModeEnabled,
  getLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  removeLastUsedPaperConversationKey,
  setLockedGlobalConversationKey,
} from "./prefHelpers";
import { buildUI } from "./buildUI";
import { setupHandlers, type SetupHandlersHooks } from "./setupHandlers";
import { clearConversationSummary as clearConversationSummaryFromCache } from "./conversationSummaryCache";
import {
  ensureConversationLoaded,
  getConversationKey,
  refreshChat,
  resetSessionTokens,
} from "./chat";
import { renderShortcuts } from "./shortcuts";
import { createElement, HTML_NS } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import type { ConversationSystem } from "../../shared/types";
import type { ChatRuntimeMode } from "./types";
import {
  createGlobalConversation,
  createPaperConversation,
  ensureGlobalConversationExists,
  clearConversation as clearStoredConversation,
  deleteGlobalConversation,
  deletePaperConversation,
  getGlobalConversationUserTurnCount,
  getLatestEmptyGlobalConversation,
  getPaperConversation,
  listPaperConversations,
  loadConversation,
} from "../../utils/chatStore";
import { removeConversationAttachmentFiles } from "./attachmentStorage";
import { clearOwnerAttachmentRefs } from "../../utils/attachmentRefStore";
import { chatHistory, loadedConversationKeys } from "./state";
import {
  loadConversationHistoryScope,
} from "./historyLoader";
import { resolveStandalonePaperTabLabel } from "./standaloneTabLabel";
import {
  buildDefaultClaudeGlobalConversationKey,
} from "../../claudeCode/constants";
import {
  resolveRememberedClaudeConversationKey,
  invalidateAllClaudeHotRuntimes,
  refreshClaudeSlashCommands,
} from "../../claudeCode/runtime";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import {
  createClaudeProjectSkillTemplate,
  deleteClaudeProjectSkillFile,
  getClaudeProjectDir,
  listClaudeProjectSkillEntries,
} from "../../claudeCode/projectSkills";
import { getCoreAgentRuntime } from "../../agent";
import {
  getConversationSystemPref,
  getStoredConversationSystemPref,
  getLastUsedClaudeConversationMode,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
  setConversationSystemPref,
  setLastUsedClaudeConversationMode,
} from "../../claudeCode/prefs";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../claudeCode/portal";
import {
  clearClaudeConversation,
  createClaudeGlobalConversation,
  createClaudePaperConversation,
  deleteClaudeConversation,
  getClaudeConversationSummary,
  listClaudeGlobalConversations,
  listClaudePaperConversations,
  loadClaudeConversation,
  upsertClaudeConversationSummary,
} from "../../claudeCode/store";
import {
  loadClaudeConversationHistoryScope,
} from "../../claudeCode/historyLoader";
import {
  buildDefaultCodexGlobalConversationKey,
} from "../../codexAppServer/constants";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
} from "../../codexAppServer/portal";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  isCodexAppServerModeEnabled,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  clearCodexConversation,
  createCodexGlobalConversation,
  createCodexPaperConversation,
  deleteCodexConversation,
  getCodexConversationSummary,
  listCodexGlobalConversations,
  listCodexPaperConversations,
  loadCodexConversation,
  upsertCodexConversationSummary,
} from "../../codexAppServer/store";
import {
  loadCodexConversationHistoryScope,
} from "../../codexAppServer/historyLoader";

type StandaloneSessionState = {
  pending: boolean;
  window: Window | null;
};

const standaloneSessionState: StandaloneSessionState = {
  pending: false,
  window: null,
};

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

/** Called by index.ts onItemChange when the user switches paper tabs. */
export function notifyStandaloneItemChanged(item: Zotero.Item | null): void {
  standaloneItemChangeHandler?.(item);
}

function isStandaloneTrackedBody(body: Element): boolean {
  const standaloneWin = getStandaloneSessionWindow();
  if (standaloneWin && body.ownerDocument === standaloneWin.document) {
    return true;
  }
  return (body as HTMLElement).dataset?.standalone === "true";
}

function renderStandalonePlaceholdersInEmbeddedPanels(
  excludedBody?: Element | null,
): void {
  const seenBodies = new Set<Element>();
  const mainWindows = Zotero.getMainWindows?.() || [];
  for (const win of mainWindows) {
    const panelRoots = win?.document?.querySelectorAll?.("#llm-main") || [];
    for (const panelRoot of panelRoots) {
      const body = (panelRoot as Element).parentElement;
      if (
        !body ||
        !body.isConnected ||
        body === excludedBody ||
        isStandaloneTrackedBody(body) ||
        seenBodies.has(body)
      ) {
        continue;
      }
      renderStandalonePlaceholder(body);
      seenBodies.add(body);
    }
  }
  for (const [body] of activeContextPanels) {
    if (
      !(body as Element).isConnected ||
      body === excludedBody ||
      isStandaloneTrackedBody(body as Element) ||
      seenBodies.has(body as Element)
    ) {
      continue;
    }
    renderStandalonePlaceholder(body as Element);
    seenBodies.add(body as Element);
  }
}

function restoreEmbeddedPanelsAfterStandaloneClose(
  excludedBody?: Element | null,
): void {
  for (const [body] of activeContextPanels) {
    if (excludedBody && body === excludedBody) continue;
    if (!(body as Element).isConnected) {
      void releaseClaudeRuntimeForBody(body as Element);
      activeContextPanels.delete(body);
      activeContextPanelRawItems.delete(body);
      activeContextPanelStateSync.delete(body);
      continue;
    }
    const rawItem = activeContextPanelRawItems.get(body as Element) || null;
    const resolved = resolveInitialPanelItemState(rawItem, {
      conversationSystem: resolveConversationSystemForItem(rawItem),
    });
    buildUI(body as Element, resolved.item);
    activeContextPanels.set(body, () => resolved.item);
    setupHandlers(body as Element, resolved.item || rawItem);
    void (async () => {
      try {
        if (resolved.item) await ensureConversationLoaded(resolved.item);
        await renderShortcuts(
          body as Element,
          resolved.item,
          resolveShortcutMode(resolved.item),
        );
        refreshChat(body as Element, resolved.item);
      } catch (err) {
        ztoolkit.log("LLM: side panel restore failed", err);
      }
    })();
  }
}

/**
 * Replace a side-panel body with a placeholder message while the
 * standalone window is open.
 */
export function renderStandalonePlaceholder(body: Element): void {
  if (typeof (body as any).replaceChildren === "function") {
    (body as any).replaceChildren();
  } else {
    body.textContent = "";
  }
  const doc = body.ownerDocument!;
  const wrap = createElement(doc, "div", "llm-standalone-placeholder");
  wrap.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100%;gap:12px;padding:24px;text-align:center;color:var(--fill-secondary);";

  const msg = createElement(doc, "div", "", {
    textContent: t("Chat is open in a separate window"),
  });
  msg.style.cssText = "font-size:13px;";

  const focusBtn = createElement(doc, "button", "llm-btn llm-btn-primary", {
    textContent: t("Focus Window"),
    type: "button",
  });
  focusBtn.style.cssText =
    "display:flex;align-items:center;justify-content:center;" +
    "padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;" +
    "background:var(--color-accent,#2563eb);color:#fff;border:none;";
  focusBtn.addEventListener("click", () => {
    getStandaloneSessionWindow()?.focus();
  });

  const closeBtn = createElement(doc, "button", "llm-btn", {
    textContent: t("Close Window & Return Here"),
    type: "button",
  });
  closeBtn.style.cssText =
    "display:flex;align-items:center;justify-content:center;" +
    "padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;" +
    "background:none;color:var(--fill-secondary);border:1px solid var(--stroke-secondary,#888);";
  closeBtn.addEventListener("click", () => {
    try {
      const win =
        getStandaloneSessionWindow() ||
        (addon.data.standaloneWindow as Window | undefined) ||
        null;
      ztoolkit.log(
        "LLM: close standalone clicked, win=",
        Boolean(win),
        "closed=",
        win ? (win as any).closed : "N/A",
      );
      if (win && !(win as any).closed) {
        (win as any).close();
      }
    } catch (err) {
      ztoolkit.log("LLM: close standalone failed", err);
    }
  });

  wrap.append(msg, focusBtn, closeBtn);
  body.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Day-group helpers for sidebar
// ---------------------------------------------------------------------------

type SidebarConv = {
  conversationKey: number;
  lastActivityAt: number;
  title?: string;
  sessionVersion?: number;
  paperItemID?: number;
  mode?: "open" | "paper";
};

function getDayGroupLabel(ts: number): string {
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const monthStart = todayStart - 29 * 86_400_000;

  if (ts >= todayStart) return t("Today");
  if (ts >= yesterdayStart) return t("Yesterday");
  if (ts >= weekStart) return t("Last 7 days");
  if (ts >= monthStart) return t("Last 30 days");
  return t("Older");
}

function groupByDay(
  conversations: SidebarConv[],
): Array<{ label: string; items: SidebarConv[] }> {
  const groups: Array<{ label: string; items: SidebarConv[] }> = [];
  let currentLabel = "";
  for (const conv of conversations) {
    const label = getDayGroupLabel(conv.lastActivityAt);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(conv);
  }
  return groups;
}

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

  const sourceItem = options?.initialItem || null;
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
  let currentConversationSystem: ConversationSystem =
    explicitConversationSystem ||
    resolvePreferredConversationSystem({
      item: resolvedSourceState.item,
      preferredSystem: sourceConversationSystem,
    });
  const initialBasePaperItem =
    resolvedSourceState.basePaperItem ||
    resolveConversationBaseItem(sourceItemForResolution || sourceItem) ||
    null;
  const initialDisplayConversationKind = resolveDisplayConversationKind(
    resolvedSourceState.item || sourceItem,
  );
  const isClaudeConversationSystem = () =>
    currentConversationSystem === "claude_code";
  const isCodexConversationSystem = () =>
    currentConversationSystem === "codex";
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
  const initialRememberedRuntimeMode =
    currentConversationSystem === "claude_code"
      ? getLastUsedClaudeConversationMode(libraryID)
      : currentConversationSystem === "codex"
        ? getLastUsedCodexConversationMode(libraryID)
      : null;
  const initialMode: "open" | "paper" =
    initialDisplayConversationKind === "paper"
      ? "paper"
      : initialDisplayConversationKind === "global"
        ? "open"
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
        : activeCodexGlobalConversationByLibrary.get(
            buildCodexLibraryStateKey(libraryID),
          ) ||
          getLastUsedCodexGlobalConversationKey(libraryID) ||
          buildDefaultCodexGlobalConversationKey(libraryID)
    : lockedKey ??
      activeGlobalConversationByLibrary.get(libraryID) ??
      GLOBAL_CONVERSATION_KEY_BASE;
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
  // throughout the entire openDialog + load cycle so any onRender calls
  // in the sidepanel will show the placeholder.
  setStandalonePending(true);

  const newWin = mainWin.openDialog(
    `chrome://${config.addonRef}/content/standaloneChat.xhtml`,
    "llmforzotero-standalone-chat",
    "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen",
  ) as Window | null;
  if (!newWin) {
    setStandalonePending(false);
    return;
  }

  if (options?.sourceBody && options.sourceBody.isConnected) {
    renderStandalonePlaceholder(options.sourceBody);
  }
  renderStandalonePlaceholdersInEmbeddedPanels(options?.sourceBody || null);

  setStandaloneSessionWindow(newWin);
  // Keep standalonePending = true until initWindow runs — see below
  let cancelled = false;

  // Mutable state for the standalone window
  let standaloneMode: "open" | "paper" = initialMode;
  let activeConversationKey = getConversationKey(initialMountedItem);
  let activeItem: Zotero.Item = initialMountedItem;
  let currentPaperItem: Zotero.Item | null = initialPaperItem;
  let currentBasePaperItem: Zotero.Item | null = initialBasePaperItem;
  let isInWebChatMode = false;
  let currentChatHooks: SetupHandlersHooks | null = null;
  let standaloneSidebarRenderQueued = false;
  let explicitNewChatInFlight = false;
  let initialRuntimeModeSeeded = false;
  let themeObserver: {
    observe(target: Node, options: MutationObserverInit): void;
    disconnect(): void;
  } | null = null;
  let darkMQ: MediaQueryList | null = null;
  let onSchemeChange: (() => void) | null = null;
  let cleanupStandalonePrefObserver: (() => void) | null = null;

  const initWindow = () => {
    // Now the window is loaded — safe to clear the pending flag.
    // isStandaloneWindowActive() will still return true because
    // addon.data.standaloneWindow is set and not closed.
    setStandalonePending(false);
    // Reset cancelled — the about:blank → XHTML transition in XUL may
    // fire an early unload that sets cancelled=true before load fires.
    cancelled = false;
    // Re-store the window reference for the same reason.
    setStandaloneSessionWindow(newWin);
    // Register the real unload handler now that the document is loaded.
    newWin.addEventListener("unload", cleanupWindow, { once: true });
    ztoolkit.log("LLM: standalone initWindow start");

    try {
      const doc = newWin.document;

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

      const syncZoteroVarsToStandalone = () => {
        if (cancelled || newWin.closed) return;
        const freshStyle = mainDocEl
          ? mainWin.getComputedStyle(mainDocEl)
          : null;
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
      mainCSS.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
      doc.documentElement?.appendChild(mainCSS);

      const katexCSS = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
      katexCSS.rel = "stylesheet";
      katexCSS.type = "text/css";
      katexCSS.href = `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`;
      doc.documentElement?.appendChild(katexCSS);

      const rerenderStandaloneShellAfterStylesReady = () => {
        if (cancelled || newWin.closed) return;
        const mountedItem = activeItem;
        if (!mountedItem) return;
        const llmMain = contentArea.querySelector("#llm-main") as HTMLElement | null;
        applyPanelFontScale(llmMain);
        applyPanelFontScale(root);
        const shortcutMode = standaloneMode === "open" ? "library" : "paper";
        void renderShortcuts(contentArea, mountedItem, shortcutMode);
        refreshChat(contentArea, mountedItem);
      };
      mainCSS.addEventListener("load", rerenderStandaloneShellAfterStylesReady, {
        once: true,
      });

      // Mount into the root div
      const root = doc.getElementById(
        "llmforzotero-standalone-chat-root",
      ) as HTMLElement | null;
      if (!root) return;

      root.dataset.standalone = "true";

      // -----------------------------------------------------------------------
      // Build the shell layout:
      //   topbar (full width)
      //   lowerArea: sidebar (icon strip + panel) | content
      // -----------------------------------------------------------------------

      // Switch root from row to column
      root.style.flexDirection = "column";

      // -- Sidebar toggle button (lives in icon strip) --
      const iconSidebarToggle = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconSidebarToggle.className =
        "llm-standalone-icon-btn llm-standalone-topbar-toggle";
      iconSidebarToggle.type = "button";
      iconSidebarToggle.title = t("Toggle sidebar");

      // -- Tab group (centered at top of content area) --
      const paperTab = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      paperTab.className = "llm-standalone-tab";
      paperTab.type = "button";
      paperTab.textContent = resolveStandalonePaperTabLabel({
        paperSlotItem: currentPaperItem,
      });
      paperTab.dataset.tab = "paper";

      const openTab = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      openTab.className = "llm-standalone-tab";
      openTab.type = "button";
      openTab.textContent = "Library chat";
      openTab.dataset.tab = "open";

      paperTab.classList.toggle("active", standaloneMode === "paper");
      openTab.classList.toggle("active", standaloneMode === "open");

      const tabGroup = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      tabGroup.className = "llm-standalone-tab-group";
      tabGroup.append(paperTab, openTab);

      const systemToggleBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      systemToggleBtn.className = "llm-standalone-claude-toggle";
      systemToggleBtn.type = "button";
      systemToggleBtn.setAttribute("aria-label", "Conversation runtime");

      const getPreferredRuntimeSystem = (): ConversationSystem => {
        if (resolveActiveNoteSession(activeItem)) {
          return isCodexAppServerModeEnabled() ? "codex" : "upstream";
        }
        const preferred = getConversationSystemPref();
        if (preferred === "codex" && isCodexAppServerModeEnabled()) return "codex";
        if (preferred === "claude_code" && getClaudeCodeModeEnabled()) return "claude_code";
        if (isCodexAppServerModeEnabled()) return "codex";
        if (getClaudeCodeModeEnabled()) return "claude_code";
        return "upstream";
      };

      const updateStandaloneSystemToggle = () => {
        const targetSystem = getPreferredRuntimeSystem();
        const enabled =
          !isInWebChatMode &&
          (resolveActiveNoteSession(activeItem)
            ? targetSystem === "codex" || isCodexConversationSystem()
            : getClaudeCodeModeEnabled() || isCodexAppServerModeEnabled());
        systemToggleBtn.style.display = enabled ? "inline-flex" : "none";
        const active = isRuntimeConversationSystem();
        const iconSystem = active ? currentConversationSystem : targetSystem;
        systemToggleBtn.dataset.active = active ? "true" : "false";
        systemToggleBtn.title = active
          ? "Switch to upstream mode"
          : iconSystem === "codex"
            ? "Switch to Codex mode"
            : "Switch to Claude Code mode";
        if (iconSystem === "codex") {
          systemToggleBtn.innerHTML =
            `<span class="llm-codex-system-toggle-icon" aria-hidden="true"></span>`;
          return;
        }
        systemToggleBtn.innerHTML = active
          ? `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"></path></svg>`
          : `<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"></path></svg>`;
      };

      const tabRow = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      tabRow.className = "llm-standalone-tab-row";
      tabRow.append(systemToggleBtn, tabGroup);

      // -- Lower area: sidebar + content side by side --
      const lowerArea = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      lowerArea.className = "llm-standalone-lower";

      // -- Sidebar: icon strip (always visible) + panel (collapsible) --
      const sidebar = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      sidebar.className = "llm-standalone-sidebar";
      sidebar.dataset.sidebarState = "expanded";

      // Icon strip — always visible vertical column with text-based icons
      const iconStrip = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      iconStrip.className = "llm-standalone-icon-strip";

      const iconNewChat = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconNewChat.className =
        "llm-standalone-icon-btn llm-standalone-icon-plus";
      iconNewChat.type = "button";
      iconNewChat.title = t("New chat");
      iconNewChat.textContent = "+";

      const iconSearch = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconSearch.className =
        "llm-standalone-icon-btn llm-standalone-icon-search";
      iconSearch.type = "button";
      iconSearch.title = t("Search history");

      const iconSkill = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconSkill.className = "llm-standalone-icon-btn llm-standalone-icon-skill";
      iconSkill.type = "button";
      iconSkill.title = t("Skills");

      const iconStripSpacer = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      iconStripSpacer.style.flex = "1";

      const iconSettings = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconSettings.className =
        "llm-standalone-icon-btn llm-standalone-icon-settings";
      iconSettings.type = "button";
      iconSettings.title = t("Settings");

      const iconExport = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconExport.className =
        "llm-standalone-icon-btn llm-standalone-icon-export";
      iconExport.type = "button";
      iconExport.title = t("Export");

      const iconClear = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      iconClear.className = "llm-standalone-icon-btn llm-standalone-icon-clear";
      iconClear.type = "button";
      iconClear.title = t("Clear");

      iconStrip.append(
        iconSidebarToggle,
        iconNewChat,
        iconSearch,
        iconSkill,
        iconStripSpacer,
        iconSettings,
        iconExport,
        iconClear,
      );

      // Export popup — floating menu from sidebar export icon
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

      // Panel — the expandable conversation list
      const sidebarPanel = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      sidebarPanel.className = "llm-standalone-sidebar-panel";

      const sidebarHeader = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      sidebarHeader.className = "llm-standalone-sidebar-header";

      const sidebarTitle = doc.createElementNS(
        HTML_NS,
        "span",
      ) as HTMLSpanElement;
      sidebarTitle.className = "llm-standalone-sidebar-title";
      sidebarTitle.textContent = t("History");

      const sidebarHeaderActions = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      sidebarHeaderActions.className = "llm-standalone-sidebar-actions";

      const webHistoryRefreshBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      webHistoryRefreshBtn.className = "llm-standalone-sidebar-refresh";
      webHistoryRefreshBtn.type = "button";
      webHistoryRefreshBtn.textContent = "\u21BB";
      webHistoryRefreshBtn.title = t("Refresh web history");
      webHistoryRefreshBtn.setAttribute("aria-label", t("Refresh web history"));
      webHistoryRefreshBtn.style.display = "none";

      sidebarHeaderActions.append(webHistoryRefreshBtn);
      sidebarHeader.append(sidebarTitle, sidebarHeaderActions);

      const sidebarList = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      sidebarList.className = "llm-standalone-sidebar-list";

      sidebarPanel.append(sidebarHeader, sidebarList);
      sidebar.append(iconStrip, sidebarPanel);

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

      const contentTitleBarSpacer = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      contentTitleBarSpacer.className = "llm-standalone-content-title-actions";
      contentTitleBar.append(contentTitleText, contentTitleBarSpacer);

      const contentArea = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      contentArea.className = "llm-standalone-content";
      contentArea.dataset.standalone = "true";

      contentWrapper.append(tabRow, contentTitleBar, contentArea);
      lowerArea.append(sidebar, contentWrapper);

      // -- Search overlay (Claude.ai-style centered popup) --
      const searchOverlay = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      searchOverlay.className = "llm-standalone-search-overlay";
      searchOverlay.style.display = "none";

      const searchPopup = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      searchPopup.className = "llm-standalone-search-popup";

      const searchHeader = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      searchHeader.className = "llm-standalone-search-header";

      const searchInput = doc.createElementNS(
        HTML_NS,
        "input",
      ) as HTMLInputElement;
      searchInput.className = "llm-standalone-search-input";
      searchInput.type = "text";
      searchInput.placeholder = t("Search history");
      searchInput.setAttribute("autocomplete", "off");
      searchInput.setAttribute("spellcheck", "false");

      const searchCloseBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      searchCloseBtn.className = "llm-standalone-search-close";
      searchCloseBtn.type = "button";
      searchCloseBtn.textContent = "\u00D7";

      searchHeader.append(searchInput, searchCloseBtn);

      const searchResults = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLDivElement;
      searchResults.className = "llm-standalone-search-results";

      searchPopup.append(searchHeader, searchResults);
      searchOverlay.appendChild(searchPopup);

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

      root.append(
        lowerArea,
        exportPopup,
        searchOverlay,
        skillOverlay,
        skillCtxMenu,
      );

      // -- Sidebar state management --
      let userManualSidebarState: "expanded" | "collapsed" | null = null;

      const setSidebarState = (state: "expanded" | "collapsed") => {
        sidebar.dataset.sidebarState = state;
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
        paperTab.textContent = resolveStandalonePaperTabLabel({
          paperSlotItem: currentPaperItem,
          isWebChat: isInWebChatMode,
        });
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

      const ensureClaudeConversationCatalogEntry = async (params: {
        conversationKey: number;
        libraryID: number;
        kind: "global" | "paper";
        paperItemID?: number;
      }) => {
        const existing = await getClaudeConversationSummary(params.conversationKey);
        if (existing) return existing;
        await upsertClaudeConversationSummary({
          conversationKey: params.conversationKey,
          libraryID: params.libraryID,
          kind: params.kind,
          paperItemID: params.paperItemID,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return getClaudeConversationSummary(params.conversationKey);
      };

      const ensureCodexConversationCatalogEntry = async (params: {
        conversationKey: number;
        libraryID: number;
        kind: "global" | "paper";
        paperItemID?: number;
      }) => {
        const existing = await getCodexConversationSummary(params.conversationKey);
        if (existing) return existing;
        await upsertCodexConversationSummary({
          conversationKey: params.conversationKey,
          libraryID: params.libraryID,
          kind: params.kind,
          paperItemID: params.paperItemID,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return getCodexConversationSummary(params.conversationKey);
      };

      // -----------------------------------------------------------------------
      // Webchat mode UI updates for standalone window
      // -----------------------------------------------------------------------
      const updateStandaloneWebChatUI = (isWebChat: boolean) => {
        if (cancelled) return;
        isInWebChatMode = isWebChat;

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

        // Clear/Exit icon — show "Exit" text, hide the trash icon via CSS class
        iconClear.title = isWebChat
          ? t("Exit webchat and return to previous model")
          : t("Clear");
        iconClear.textContent = isWebChat ? t("Exit") : "";
        iconClear.classList.toggle("llm-standalone-icon-exit", isWebChat);

        // Keep original paper title — webchat mode is already indicated by tabs/mode chip
        updateContentTitle();
        webHistoryRefreshBtn.style.display = isWebChat ? "inline-flex" : "none";

        // Sidebar: populate with webchat history, or restore local history
        if (isWebChat) {
          sidebarTitle.textContent = t("Web History");
          void renderWebChatSidebar();
        } else {
          sidebarTitle.textContent = t("History");
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
                const isDeepSeekSession =
                  typeof session.chatUrl === "string" &&
                  /chat\.deepseek\.com/i.test(session.chatUrl);
                try {
                  let loadModelName = "chatgpt.com";
                  try {
                    if (session.chatUrl) {
                      const loadUrl = new URL(session.chatUrl);
                      const { WEBCHAT_TARGETS: targets } =
                        await import("../../webchat/types");
                      const matched = targets.find(
                        (wt) =>
                          loadUrl.hostname === wt.modelName ||
                          loadUrl.hostname === `www.${wt.modelName}`,
                      );
                      if (matched) loadModelName = matched.modelName;
                    }
                  } catch {
                    /* default */
                  }

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
                      });
                    }
                  }

                  chatHistory.set(key, messages);
                  refreshChat(contentArea, activeItem);
                } catch (err) {
                  ztoolkit.log(
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
                  refreshChat(contentArea, activeItem);
                }
              })();
            });

            sidebarList.appendChild(row);
          }
        } catch (err) {
          ztoolkit.log("LLM: standalone webchat sidebar fetch failed", err);
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
      const updateContentTitle = () => {
        if (standaloneMode === "paper" && currentBasePaperItem) {
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
      };

      const buildStandalonePortalItem = (params: {
        mode: "open" | "paper";
        conversationKey: number;
        paperItem?: Zotero.Item | null;
        sessionVersion?: number;
      }): Zotero.Item | null => {
        if (params.mode === "open") {
          return isClaudeConversationSystem()
            ? (createClaudeGlobalPortalItem(getCurrentLibraryScopeID(), params.conversationKey) as Zotero.Item)
            : isCodexConversationSystem()
              ? (createCodexGlobalPortalItem(getCurrentLibraryScopeID(), params.conversationKey) as Zotero.Item)
            : createGlobalPortalItem(getCurrentLibraryScopeID(), params.conversationKey);
        }
        if (!params.paperItem) return null;
        return isClaudeConversationSystem()
          ? (createClaudePaperPortalItem(params.paperItem, params.conversationKey) as Zotero.Item)
          : isCodexConversationSystem()
            ? (createCodexPaperPortalItem(params.paperItem, params.conversationKey) as Zotero.Item)
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
        }, 0);
      };

      const mountChatPanel = (nextItem: Zotero.Item) => {
        const resolvedState = resolveInitialPanelItemState(nextItem, {
          conversationSystem: currentConversationSystem,
        });
        const mountedItem = resolvedState.item || nextItem;
        try {
          activeItem = mountedItem;
          currentConversationSystem =
            resolveConversationSystemForItem(mountedItem) || currentConversationSystem;
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
              if (isClaudeConversationSystem()) {
                activeClaudePaperConversationByPaper.set(
                  buildClaudePaperStateKey(paperLibraryID, paperItemID),
                  activeConversationKey,
                );
              } else if (isCodexConversationSystem()) {
                activeCodexPaperConversationByPaper.set(
                  buildCodexPaperStateKey(paperLibraryID, paperItemID),
                  activeConversationKey,
                );
                setLastUsedCodexPaperConversationKey(
                  paperLibraryID,
                  paperItemID,
                  activeConversationKey,
                );
              } else {
                activePaperConversationByPaper.set(
                  buildPaperStateKey(libraryID, paperItemID),
                  activeConversationKey,
                );
              }
            }
          }

          clearContent();
          updateContentTitle();

          buildUI(contentArea, mountedItem);

          // The left tab represents the preserved paper-side slot, so do not
          // derive its label from a mounted global portal item.
          syncPaperTabLabel();

          const llmMain = contentArea.querySelector(
            "#llm-main",
          ) as HTMLElement | null;
          if (llmMain) llmMain.dataset.standalone = "true";

          activeContextPanels.set(contentArea, () => activeItem);
          activeContextPanelRawItems.set(contentArea, mountedItem);
          void retainClaudeRuntimeForBody(contentArea, mountedItem);
          const chatHooks: SetupHandlersHooks = {
            onConversationHistoryChanged: () => {
              if (cancelled) return;
              scheduleStandaloneSidebarRender();
            },
            onWebChatModeChanged: (isWebChat) => {
              if (cancelled) return;
              updateStandaloneWebChatUI(isWebChat);
            },
          };
          setupHandlers(contentArea, mountedItem as any, chatHooks);
          // Store hooks reference so webchat load handlers can call clearWebChatNewChatIntent
          currentChatHooks = chatHooks;

          refreshChat(contentArea, mountedItem);
          applyPanelFontScale(llmMain);
          applyPanelFontScale(root);
          const shortcutMode = standaloneMode === "open" ? "library" : "paper";
          void renderShortcuts(contentArea, mountedItem, shortcutMode);
        } catch (err) {
          ztoolkit.log("LLM: standalone mountChatPanel sync failed", err);
        }

        void (async () => {
          try {
            if (cancelled) return;
            await ensureConversationLoaded(mountedItem);
            if (cancelled) return;
            refreshChat(contentArea, mountedItem);
            // Refresh sidebar after conversation is confirmed loaded
            scheduleStandaloneSidebarRender();
          } catch (err) {
            ztoolkit.log("LLM: standalone mount async failed", err);
          }
        })();
      };

      // -----------------------------------------------------------------------
      // Sidebar rendering — supports both open chat and paper chat
      // -----------------------------------------------------------------------
      const renderSidebarItems = (conversations: SidebarConv[]) => {
        clearSidebarList();

        if (conversations.length === 0) {
          const emptyMsg = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          emptyMsg.className = "llm-standalone-sidebar-empty";
          emptyMsg.textContent = t("No conversations yet");
          sidebarList.appendChild(emptyMsg);
          return;
        }

        const groups = groupByDay(conversations);
        for (const group of groups) {
          const dayLabel = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          dayLabel.className = "llm-standalone-day-label";
          dayLabel.textContent = group.label;
          sidebarList.appendChild(dayLabel);

          for (const conv of group.items) {
            const btn = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            btn.className = "llm-standalone-conv-item";
            if (conv.conversationKey === activeConversationKey) {
              btn.classList.add("active");
            }
            btn.type = "button";
            btn.dataset.conversationKey = String(conv.conversationKey);
            if (conv.sessionVersion !== undefined) {
              btn.dataset.sessionVersion = String(conv.sessionVersion);
            }
            const titleSpan = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            titleSpan.className = "llm-standalone-conv-title";
            titleSpan.textContent = conv.title || t("Untitled chat");
            const deleteBtn = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            deleteBtn.className = "llm-standalone-conv-delete";
            deleteBtn.setAttribute("role", "button");
            deleteBtn.setAttribute("aria-label", t("Delete conversation"));
            deleteBtn.title = t("Delete conversation");
            deleteBtn.dataset.action = "delete";
            btn.append(titleSpan, deleteBtn);
            btn.title = conv.title || t("Untitled chat");
            sidebarList.appendChild(btn);
          }
        }
      };

      const renderSidebar = async () => {
        if (cancelled) return;
        // In webchat mode, sidebar is managed by renderWebChatSidebar() — skip local rendering
        if (isInWebChatMode) return;
        ztoolkit.log(
          "LLM: standalone renderSidebar",
          "mode=" + standaloneMode,
          "hasBasePaper=" + Boolean(currentBasePaperItem),
          "basePaperId=" + (currentBasePaperItem?.id ?? "null"),
          "activeConvKey=" + activeConversationKey,
        );
        try {
          if (standaloneMode === "open") {
            let conversations: SidebarConv[];
            if (isClaudeConversationSystem()) {
              if (activeConversationKey > 0) {
                await ensureClaudeConversationCatalogEntry({
                  conversationKey: activeConversationKey,
                  libraryID: getCurrentLibraryScopeID(),
                  kind: "global",
                });
              }
              conversations = (await loadClaudeConversationHistoryScope({
                libraryID: getCurrentLibraryScopeID(),
                kind: "global",
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                mode: "open" as const,
              }));
            } else if (isCodexConversationSystem()) {
              if (activeConversationKey > 0) {
                await ensureCodexConversationCatalogEntry({
                  conversationKey: activeConversationKey,
                  libraryID: getCurrentLibraryScopeID(),
                  kind: "global",
                });
              }
              conversations = (await loadCodexConversationHistoryScope({
                libraryID: getCurrentLibraryScopeID(),
                kind: "global",
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                mode: "open" as const,
              }));
            } else {
              await ensureGlobalConversationExists(getCurrentLibraryScopeID(), activeConversationKey);
              conversations = (await loadConversationHistoryScope({
                mode: "open",
                libraryID: getCurrentLibraryScopeID(),
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                sessionVersion: entry.sessionVersion,
                paperItemID: entry.paperItemID,
                mode: entry.mode,
              }));
            }
            if (cancelled) return;
            sidebarTitle.textContent = t("History");
            renderSidebarItems(conversations);
          } else {
            if (!currentBasePaperItem) {
              ztoolkit.log(
                "LLM: standalone renderSidebar paper mode — currentBasePaperItem is null",
              );
              sidebarTitle.textContent = t("History");
              clearSidebarList();
              return;
            }
            const paperID = Number(currentBasePaperItem.id || 0);
            const paperLibID = Number(
              currentBasePaperItem.libraryID || libraryID,
            );
            ztoolkit.log(
              "LLM: standalone renderSidebar paper query",
              "paperID=" + paperID,
              "libraryID=" + paperLibID,
            );
            let conversations: SidebarConv[];
            if (isClaudeConversationSystem()) {
              if (activeConversationKey > 0) {
                await ensureClaudeConversationCatalogEntry({
                  conversationKey: activeConversationKey,
                  libraryID: paperLibID,
                  kind: "paper",
                  paperItemID: paperID,
                });
              }
              conversations = (await loadClaudeConversationHistoryScope({
                libraryID: paperLibID,
                kind: "paper",
                paperItemID: paperID,
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                paperItemID: entry.paperItemID,
                mode: "paper" as const,
              }));
            } else if (isCodexConversationSystem()) {
              if (activeConversationKey > 0) {
                await ensureCodexConversationCatalogEntry({
                  conversationKey: activeConversationKey,
                  libraryID: paperLibID,
                  kind: "paper",
                  paperItemID: paperID,
                });
              }
              conversations = (await loadCodexConversationHistoryScope({
                libraryID: paperLibID,
                kind: "paper",
                paperItemID: paperID,
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                paperItemID: entry.paperItemID,
                mode: "paper" as const,
              }));
            } else {
              conversations = (await loadConversationHistoryScope({
                mode: "paper",
                libraryID: paperLibID,
                paperItemID: paperID,
                limit: 50,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                sessionVersion: entry.sessionVersion,
                paperItemID: entry.paperItemID,
                mode: entry.mode,
              }));
            }
            if (cancelled) return;
            sidebarTitle.textContent = t("History");
            renderSidebarItems(conversations);
          }
        } catch (err) {
          ztoolkit.log("LLM: standalone sidebar render failed", err);
        }
      };

      // -----------------------------------------------------------------------
      // Search popup logic
      // -----------------------------------------------------------------------
      let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      let searchSeq = 0;
      const searchDocCache = new Map<
        number,
        { title: string; messages: string }
      >();

      const openSearchPopup = () => {
        searchOverlay.style.display = "flex";
        searchInput.value = "";
        searchResults.textContent = "";
        searchInput.focus();
        void runSearch("");
      };

      const closeSearchPopup = () => {
        searchOverlay.style.display = "none";
        searchInput.value = "";
        searchResults.textContent = "";
        if (searchDebounceTimer !== null) {
          clearTimeout(searchDebounceTimer);
          searchDebounceTimer = null;
        }
      };

      const resolvePaperLabel = (paperItemID: number | undefined): string => {
        if (!paperItemID) return t("Library chat");
        try {
          const paperItem = Zotero.Items.get(paperItemID);
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

      const renderSearchResults = (
        entries: SidebarConv[],
        query: string,
      ) => {
        searchResults.textContent = "";

        if (!entries.length) {
          const empty = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
          empty.className = "llm-standalone-search-empty";
          empty.textContent = query
            ? t("No matching history")
            : t("No conversations yet");
          searchResults.appendChild(empty);
          return;
        }

        const groups = groupByDay(entries);

        const entryMap = new Map<number, SidebarConv>();
        for (const e of entries) entryMap.set(e.conversationKey, e);

        for (const group of groups) {
          const dayLabel = doc.createElementNS(
            HTML_NS,
            "div",
          ) as HTMLDivElement;
          dayLabel.className = "llm-standalone-search-day-label";
          dayLabel.textContent = group.label;
          searchResults.appendChild(dayLabel);

          for (const conv of group.items) {
            const entry = entryMap.get(conv.conversationKey);
            if (!entry) continue;

            const btn = doc.createElementNS(
              HTML_NS,
              "button",
            ) as HTMLButtonElement;
            btn.className = "llm-standalone-search-item";
            btn.type = "button";
            btn.dataset.conversationKey = String(entry.conversationKey);
            btn.dataset.mode = entry.mode;
            if (entry.paperItemID) {
              btn.dataset.paperItemId = String(entry.paperItemID);
            }
            if (entry.sessionVersion !== undefined) {
              btn.dataset.sessionVersion = String(entry.sessionVersion);
            }

            const textWrap = doc.createElementNS(
              HTML_NS,
              "div",
            ) as HTMLDivElement;
            textWrap.className = "llm-standalone-search-text";

            const label = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            label.className = "llm-standalone-search-label";
            const isPaperEntry = entry.mode === "paper";
            label.dataset.labelType = isPaperEntry ? "paper" : "library";
            const labelText = isPaperEntry
              ? resolvePaperLabel(entry.paperItemID)
              : t("Library chat");
            label.textContent = labelText;

            const title = doc.createElementNS(
              HTML_NS,
              "span",
            ) as HTMLSpanElement;
            title.className = "llm-standalone-search-title";
            title.textContent = entry.title || t("Untitled chat");

            textWrap.append(label, title);
            btn.append(textWrap);
            btn.title = `${labelText}: ${entry.title || t("Untitled chat")}`;
            searchResults.appendChild(btn);
          }
        }
      };

      const runSearch = async (query: string) => {
        const thisSeq = ++searchSeq;
        try {
          const allEntries: SidebarConv[] = await (async () => {
            if (isClaudeConversationSystem()) {
              if (standaloneMode === "open") {
                return (await loadClaudeConversationHistoryScope({
                  libraryID: getCurrentLibraryScopeID(),
                  kind: "global",
                  limit: 100,
                })).map((entry) => ({
                  conversationKey: entry.conversationKey,
                  lastActivityAt: entry.lastActivityAt,
                  title: entry.title,
                  paperItemID: entry.paperItemID,
                  mode: entry.kind === "paper" ? "paper" : "open",
                }));
              }
              const paperID = Number(currentBasePaperItem?.id || 0);
              const paperLibID = Number(currentBasePaperItem?.libraryID || getCurrentLibraryScopeID());
              if (!Number.isFinite(paperID) || paperID <= 0 || !Number.isFinite(paperLibID) || paperLibID <= 0) {
                return [];
              }
              return (await loadClaudeConversationHistoryScope({
                libraryID: paperLibID,
                kind: "paper",
                paperItemID: paperID,
                limit: 100,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                paperItemID: entry.paperItemID,
                mode: entry.kind === "paper" ? "paper" : "open",
              }));
            }
            if (isCodexConversationSystem()) {
              if (standaloneMode === "open") {
                return (await loadCodexConversationHistoryScope({
                  libraryID: getCurrentLibraryScopeID(),
                  kind: "global",
                  limit: 100,
                })).map((entry) => ({
                  conversationKey: entry.conversationKey,
                  lastActivityAt: entry.lastActivityAt,
                  title: entry.title,
                  paperItemID: entry.paperItemID,
                  mode: entry.kind === "paper" ? "paper" : "open",
                }));
              }
              const paperID = Number(currentBasePaperItem?.id || 0);
              const paperLibID = Number(currentBasePaperItem?.libraryID || getCurrentLibraryScopeID());
              if (!Number.isFinite(paperID) || paperID <= 0 || !Number.isFinite(paperLibID) || paperLibID <= 0) {
                return [];
              }
              return (await loadCodexConversationHistoryScope({
                libraryID: paperLibID,
                kind: "paper",
                paperItemID: paperID,
                limit: 100,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                paperItemID: entry.paperItemID,
                mode: entry.kind === "paper" ? "paper" : "open",
              }));
            }
            if (standaloneMode === "open") {
              return (await loadConversationHistoryScope({
                mode: "open",
                libraryID: getCurrentLibraryScopeID(),
                limit: 100,
              })).map((entry) => ({
                conversationKey: entry.conversationKey,
                lastActivityAt: entry.lastActivityAt,
                title: entry.title,
                sessionVersion: entry.sessionVersion,
                paperItemID: entry.paperItemID,
                mode: entry.mode,
              }));
            }
            const paperID = Number(currentBasePaperItem?.id || 0);
            const paperLibID = Number(currentBasePaperItem?.libraryID || getCurrentLibraryScopeID());
            if (!Number.isFinite(paperID) || paperID <= 0 || !Number.isFinite(paperLibID) || paperLibID <= 0) {
              return [];
            }
            return (await loadConversationHistoryScope({
              mode: "paper",
              libraryID: paperLibID,
              paperItemID: paperID,
              limit: 100,
            })).map((entry) => ({
              conversationKey: entry.conversationKey,
              lastActivityAt: entry.lastActivityAt,
              title: entry.title,
              sessionVersion: entry.sessionVersion,
              paperItemID: entry.paperItemID,
              mode: entry.mode,
            }));
          })();
          if (thisSeq !== searchSeq || cancelled) return;

          if (!query.trim()) {
            // Show all entries when no query
            renderSearchResults(allEntries, "");
            return;
          }

          const normalizedQuery = query.trim().toLocaleLowerCase();
          const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

          // First pass: filter by title (instant)
          const titleMatches = allEntries.filter((entry) => {
            const normalizedTitle = (entry.title || "").toLocaleLowerCase();
            return tokens.every((token) => normalizedTitle.includes(token));
          });

          // Show title matches immediately
          renderSearchResults(titleMatches, query);

          // Second pass: search message content for entries not already matched
          const titleMatchKeys = new Set(
            titleMatches.map((e) => e.conversationKey),
          );
          const entriesToSearch = allEntries.filter(
            (e) => !titleMatchKeys.has(e.conversationKey),
          );

          const contentMatches: SidebarConv[] = [];
          for (const entry of entriesToSearch) {
            if (thisSeq !== searchSeq || cancelled) return;

            let doc_: { title: string; messages: string } | undefined =
              searchDocCache.get(entry.conversationKey);
            if (!doc_) {
              try {
                const messages = isClaudeConversationSystem()
                  ? await loadClaudeConversation(
                      entry.conversationKey,
                      200,
                    )
                  : isCodexConversationSystem()
                    ? await loadCodexConversation(
                        entry.conversationKey,
                        200,
                      )
                  : await loadConversation(
                      entry.conversationKey,
                      200,
                    );
                const messageText = messages.map((m: any) => m.text || "").join(" ");
                doc_ = { title: entry.title || "", messages: messageText };
                searchDocCache.set(entry.conversationKey, doc_);
              } catch {
                continue;
              }
            }
            if (thisSeq !== searchSeq || cancelled) return;

            const normalizedMessages = doc_.messages.toLocaleLowerCase();
            if (tokens.every((token) => normalizedMessages.includes(token))) {
              contentMatches.push(entry);
            }
          }

          if (thisSeq !== searchSeq || cancelled) return;

          // Merge title matches + content matches, dedup by conversationKey
          const dedupedMatches = new Map<number, SidebarConv>();
          for (const entry of [...titleMatches, ...contentMatches]) {
            const existing = dedupedMatches.get(entry.conversationKey);
            if (!existing || entry.lastActivityAt > existing.lastActivityAt) {
              dedupedMatches.set(entry.conversationKey, entry);
            }
          }
          const allMatches: SidebarConv[] = Array.from(dedupedMatches.values());
          allMatches.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
          renderSearchResults(allMatches, query);
        } catch (err) {
          ztoolkit.log("LLM: standalone search failed", err);
        }
      };

      // Search popup event handlers
      iconSearch.addEventListener("click", () => {
        if (searchOverlay.style.display !== "none") {
          closeSearchPopup();
        } else {
          openSearchPopup();
        }
      });

      searchCloseBtn.addEventListener("click", () => closeSearchPopup());

      searchOverlay.addEventListener("click", (e: Event) => {
        if (e.target === searchOverlay) closeSearchPopup();
      });

      searchInput.addEventListener("input", () => {
        if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchDebounceTimer = null;
          void runSearch(searchInput.value);
        }, 300);
      });

      searchInput.addEventListener("keydown", (e: Event) => {
        if ((e as KeyboardEvent).key === "Escape") {
          e.preventDefault();
          closeSearchPopup();
        }
      });

      searchResults.addEventListener("click", (e: Event) => {
        const target = e.target as Element | null;
        if (!target) return;
        const btn = target.closest(
          ".llm-standalone-search-item",
        ) as HTMLButtonElement | null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();

        const convKey = Number.parseInt(btn.dataset.conversationKey || "", 10);
        const mode = btn.dataset.mode || "paper";
        const paperItemId = Number.parseInt(btn.dataset.paperItemId || "0", 10);
        const sessionVersion = Number.parseInt(
          btn.dataset.sessionVersion || "0",
          10,
        );

        if (!Number.isFinite(convKey) || convKey <= 0) return;

        closeSearchPopup();

        try {
          if (mode === "paper" && paperItemId > 0) {
            const paperItem = Zotero.Items.get(
              paperItemId,
            ) as Zotero.Item | null;
            if (paperItem) {
              const sv = sessionVersion > 0 ? sessionVersion : 1;
              const portalItem = buildStandalonePortalItem({
                mode: "paper",
                conversationKey: convKey,
                paperItem,
                sessionVersion: sv,
              });
              if (!portalItem) return;
              standaloneMode = "paper";
              currentPaperItem = paperItem;
              currentBasePaperItem = paperItem;
              paperTab.classList.add("active");
              openTab.classList.remove("active");
              syncPaperTabLabel();
              mountChatPanel(portalItem);
            }
          } else {
            standaloneMode = "open";
            paperTab.classList.remove("active");
            openTab.classList.add("active");
            const portalItem = buildStandalonePortalItem({
              mode: "open",
              conversationKey: convKey,
            });
            if (!portalItem) return;
            mountChatPanel(portalItem);
          }
        } catch (err) {
          ztoolkit.log("LLM: standalone search navigate failed", err);
        }
      });

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
          await refreshClaudeSlashCommands(getCoreAgentRuntime(), true);
        } catch (err) {
          ztoolkit.log("LLM: Claude project command refresh failed", err);
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
            : await (await import("../../agent/skills/userSkills")).getSkillListing();
          if (renderSeq !== skillRenderSeq || skillSystem !== resolveSkillPopupSystem()) {
            return;
          }
          skillGrid.textContent = "";

        // "+" add button — first grid item
        const addBtn = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        addBtn.className = "llm-standalone-skill-item llm-standalone-skill-add";
        addBtn.type = "button";
        const addIcon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
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
            : await (await import("../../agent/skills/userSkills")).createSkillTemplate();
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

          const icon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          icon.className = "llm-standalone-skill-doc-icon";

          const label = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
          label.className = "llm-standalone-skill-label";
          label.textContent = entry.filename;

          item.append(icon, label);

          // Tooltip summarizes source + available actions
          const tooltipLines = [entry.description || entry.filename, ""];
          if (entry.source === "system") {
            tooltipLines.push(`Shipped built-in (v${entry.version ?? 0})`);
          } else if (entry.source === "customized") {
            const shippedVersion = entry.shippedVersion ?? null;
            const version = entry.version ?? 0;
            tooltipLines.push(
              entry.managedBlockOutdated
                ? `Customized — shipped v${shippedVersion ?? "unknown"} uses a new format. Right-click → Restore to default to adopt it (overwrites your edits).`
                : typeof shippedVersion === "number" && version < shippedVersion
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
          Zotero.debug?.(
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
        const dir = resolveSkillPopupSystem() === "claude_code"
          ? getClaudeProjectDir()
          : (await import("../../agent/skills/userSkills")).getUserSkillsDir();
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
        const win = doc.defaultView as unknown as {
          confirm?: (msg: string) => boolean;
        };
        // Destructive action: if the window has no `confirm` available for
        // any reason, refuse rather than silently overwrite user edits.
        const confirmed =
          typeof win?.confirm === "function"
            ? win.confirm(
                `Restore ${skillCtxFilename} to the shipped default? Your customizations in this file will be lost.`,
              )
            : false;
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
            const { initUserSkills } = await import(
              "../../agent/skills/userSkills"
            );
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
          Zotero.debug?.(
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
          if (!exportPopup.contains(target) && !iconExport.contains(target)) {
            exportPopup.style.display = "none";
          }
        }
      });

      // Sidebar click handler — delete conversation
      sidebarList.addEventListener("click", async (e: Event) => {
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
          const isActive = key === activeConversationKey;

          // Find a sibling conversation to switch to BEFORE deleting
          let fallbackKey: number | null = null;
          let fallbackSessionVersion: number | undefined;
          if (isActive) {
            const allItems = Array.from(
              sidebarList.querySelectorAll(".llm-standalone-conv-item"),
            ) as HTMLElement[];
            const idx = allItems.indexOf(row);
            // Prefer next sibling, then previous
            const sibling = allItems[idx + 1] || allItems[idx - 1] || null;
            if (sibling && Number(sibling.dataset.conversationKey) !== key) {
              fallbackKey = Number(sibling.dataset.conversationKey);
              fallbackSessionVersion = sibling.dataset.sessionVersion
                ? Number(sibling.dataset.sessionVersion)
                : undefined;
            }
          }

          // Immediately remove the row from the DOM for instant feedback
          const dayLabel = row.previousElementSibling;
          row.remove();
          // Remove orphaned day label if no more items follow it
          if (
            dayLabel?.classList.contains("llm-standalone-day-label") &&
            (!dayLabel.nextElementSibling ||
              dayLabel.nextElementSibling.classList.contains(
                "llm-standalone-day-label",
              ))
          ) {
            dayLabel.remove();
          }

          try {
            const pendingRequestId = getPendingRequestId(key);
            if (pendingRequestId > 0) {
              const ctrl = getAbortController(key);
              if (ctrl) ctrl.abort();
              setCancelledRequestId(key, pendingRequestId);
              setPendingRequestId(key, 0);
              setAbortController(key, null);
            }
            chatHistory.delete(key);
            loadedConversationKeys.delete(key);
            selectedModelCache.delete(key);
            selectedReasoningCache.delete(key);
            resetSessionTokens(key);
            clearConversationSummaryFromCache(key);
            if (isClaudeConversationSystem()) {
              await clearClaudeConversation(key);
            } else if (isCodexConversationSystem()) {
              await clearCodexConversation(key);
            } else {
              await clearStoredConversation(key);
            }
            await clearOwnerAttachmentRefs("conversation", key).catch(() => {});
            await removeConversationAttachmentFiles(key).catch(() => {});
            if (standaloneMode === "open") {
              const currentLibraryID = getCurrentLibraryScopeID();
              if (isClaudeConversationSystem()) {
                await deleteClaudeConversation(key);
                const rememberedKey =
                  activeClaudeGlobalConversationByLibrary.get(
                    buildClaudeLibraryStateKey(currentLibraryID),
                  );
                if (
                  rememberedKey !== undefined &&
                  Number(rememberedKey) === key
                ) {
                  activeClaudeGlobalConversationByLibrary.delete(
                    buildClaudeLibraryStateKey(currentLibraryID),
                  );
                }
                const persistedKey = getLastUsedClaudeGlobalConversationKey(
                  currentLibraryID,
                );
                if (persistedKey !== null && Number(persistedKey) === key) {
                  removeLastUsedClaudeGlobalConversationKey(currentLibraryID);
                }
              } else if (isCodexConversationSystem()) {
                await deleteCodexConversation(key);
                const codexLibraryStateKey =
                  buildCodexLibraryStateKey(currentLibraryID);
                const rememberedKey =
                  activeCodexGlobalConversationByLibrary.get(codexLibraryStateKey);
                if (
                  rememberedKey !== undefined &&
                  Number(rememberedKey) === key
                ) {
                  activeCodexGlobalConversationByLibrary.delete(
                    codexLibraryStateKey,
                  );
                }
                const persistedKey = getLastUsedCodexGlobalConversationKey(
                  currentLibraryID,
                );
                if (persistedKey !== null && Number(persistedKey) === key) {
                  removeLastUsedCodexGlobalConversationKey(currentLibraryID);
                }
              } else {
                await deleteGlobalConversation(key);
                const rememberedKey =
                  activeGlobalConversationByLibrary.get(currentLibraryID);
                if (
                  rememberedKey !== undefined &&
                  Number(rememberedKey) === key
                ) {
                  activeGlobalConversationByLibrary.delete(currentLibraryID);
                }
                const lockedKey = getLockedGlobalConversationKey(currentLibraryID);
                if (
                  lockedKey !== null &&
                  Number.isFinite(lockedKey) &&
                  Number(lockedKey) === key
                ) {
                  setLockedGlobalConversationKey(currentLibraryID, null);
                }
              }
            } else {
              if (isClaudeConversationSystem()) {
                await deleteClaudeConversation(key);
                if (currentBasePaperItem?.id) {
                  const paperLibraryID = getCurrentPaperLibraryID();
                  const paperStateKey = buildClaudePaperStateKey(
                    paperLibraryID,
                    Number(currentBasePaperItem.id),
                  );
                  const rememberedKey = activeClaudePaperConversationByPaper.get(
                    paperStateKey,
                  );
                  if (
                    rememberedKey !== undefined &&
                    Number(rememberedKey) === key
                  ) {
                    activeClaudePaperConversationByPaper.delete(paperStateKey);
                  }
                  const persistedKey = getLastUsedClaudePaperConversationKey(
                    paperLibraryID,
                    Number(currentBasePaperItem.id),
                  );
                  if (persistedKey !== null && Number(persistedKey) === key) {
                    removeLastUsedClaudePaperConversationKey(
                      paperLibraryID,
                      Number(currentBasePaperItem.id),
                    );
                  }
                }
              } else if (isCodexConversationSystem()) {
                await deleteCodexConversation(key);
                if (currentBasePaperItem?.id) {
                  const paperLibraryID = getCurrentPaperLibraryID();
                  const paperItemID = Number(currentBasePaperItem.id);
                  const paperStateKey = buildCodexPaperStateKey(
                    paperLibraryID,
                    paperItemID,
                  );
                  const rememberedKey = activeCodexPaperConversationByPaper.get(
                    paperStateKey,
                  );
                  if (
                    rememberedKey !== undefined &&
                    Number(rememberedKey) === key
                  ) {
                    activeCodexPaperConversationByPaper.delete(paperStateKey);
                  }
                  const persistedKey = getLastUsedCodexPaperConversationKey(
                    paperLibraryID,
                    paperItemID,
                  );
                  if (persistedKey !== null && Number(persistedKey) === key) {
                    removeLastUsedCodexPaperConversationKey(
                      paperLibraryID,
                      paperItemID,
                    );
                  }
                }
              } else {
                await deletePaperConversation(key);
                if (currentBasePaperItem?.id) {
                  const paperLibraryID = getCurrentPaperLibraryID();
                  const paperStateKey = `${paperLibraryID}:${Math.floor(Number(currentBasePaperItem.id))}`;
                  const rememberedKey = activePaperConversationByPaper.get(
                    paperStateKey,
                  );
                  if (
                    rememberedKey !== undefined &&
                    Number(rememberedKey) === key
                  ) {
                    activePaperConversationByPaper.delete(paperStateKey);
                  }
                  const persistedKey = getLastUsedPaperConversationKey(
                    paperLibraryID,
                    Number(currentBasePaperItem.id),
                  );
                  if (
                    persistedKey !== null &&
                    Number(persistedKey) === key
                  ) {
                    removeLastUsedPaperConversationKey(
                      paperLibraryID,
                      Number(currentBasePaperItem.id),
                    );
                  }
                }
              }
            }

            // Switch to fallback or create new conversation
            if (isActive) {
              if (fallbackKey) {
                activeConversationKey = fallbackKey;
                if (standaloneMode === "open") {
                  const currentLibraryID = getCurrentLibraryScopeID();
                  if (isClaudeConversationSystem()) {
                    activeClaudeGlobalConversationByLibrary.set(
                      buildClaudeLibraryStateKey(currentLibraryID),
                      fallbackKey,
                    );
                  } else if (isCodexConversationSystem()) {
                    activeCodexGlobalConversationByLibrary.set(
                      buildCodexLibraryStateKey(currentLibraryID),
                      fallbackKey,
                    );
                    setLastUsedCodexGlobalConversationKey(
                      currentLibraryID,
                      fallbackKey,
                    );
                  } else {
                    activeGlobalConversationByLibrary.set(currentLibraryID, fallbackKey);
                  }
                  const newItem = buildStandalonePortalItem({
                    mode: "open",
                    conversationKey: fallbackKey,
                  });
                  if (newItem) mountChatPanel(newItem);
                } else if (currentBasePaperItem) {
                  const sv = fallbackSessionVersion || 0;
                  const newItem = buildStandalonePortalItem({
                    mode: "paper",
                    conversationKey: fallbackKey,
                    paperItem: currentBasePaperItem,
                    sessionVersion: sv,
                  });
                  currentPaperItem = currentBasePaperItem;
                  if (newItem) mountChatPanel(newItem);
                }
              } else {
                if (standaloneMode === "open") {
                  const currentLibraryID = getCurrentLibraryScopeID();
                  const newKey = isClaudeConversationSystem()
                    ? Number((await createClaudeGlobalConversation(currentLibraryID))?.conversationKey || 0)
                    : isCodexConversationSystem()
                      ? Number((await createCodexGlobalConversation(currentLibraryID))?.conversationKey || 0)
                    : await createGlobalConversation(currentLibraryID);
                  if (newKey && !cancelled) {
                    activeConversationKey = newKey;
                    if (isClaudeConversationSystem()) {
                      activeClaudeGlobalConversationByLibrary.set(
                        buildClaudeLibraryStateKey(currentLibraryID),
                        newKey,
                      );
                    } else if (isCodexConversationSystem()) {
                      activeCodexGlobalConversationByLibrary.set(
                        buildCodexLibraryStateKey(currentLibraryID),
                        newKey,
                      );
                      setLastUsedCodexGlobalConversationKey(
                        currentLibraryID,
                        newKey,
                      );
                    } else {
                      activeGlobalConversationByLibrary.set(currentLibraryID, newKey);
                    }
                    const newItem = buildStandalonePortalItem({
                      mode: "open",
                      conversationKey: newKey,
                    });
                    if (newItem) mountChatPanel(newItem);
                  }
                } else if (currentBasePaperItem) {
                  if (isClaudeConversationSystem()) {
                    const paperId = Number(currentBasePaperItem.id || 0);
                    const summary = await createClaudePaperConversation(getCurrentPaperLibraryID(), paperId);
                    if (summary?.conversationKey && !cancelled) {
                      activeConversationKey = summary.conversationKey;
                      const newItem = buildStandalonePortalItem({
                        mode: "paper",
                        conversationKey: summary.conversationKey,
                        paperItem: currentBasePaperItem,
                      });
                      currentPaperItem = currentBasePaperItem;
                      if (newItem) mountChatPanel(newItem);
                    }
                  } else if (isCodexConversationSystem()) {
                    const paperId = Number(currentBasePaperItem.id || 0);
                    const summary = await createCodexPaperConversation(getCurrentPaperLibraryID(), paperId);
                    if (summary?.conversationKey && !cancelled) {
                      activeConversationKey = summary.conversationKey;
                      const newItem = buildStandalonePortalItem({
                        mode: "paper",
                        conversationKey: summary.conversationKey,
                        paperItem: currentBasePaperItem,
                      });
                      currentPaperItem = currentBasePaperItem;
                      if (newItem) mountChatPanel(newItem);
                    }
                  } else {
                    const paperId = Number(currentBasePaperItem.id || 0);
                    const summary = await createPaperConversation(getCurrentPaperLibraryID(), paperId);
                    const newKey = Number(summary?.conversationKey || 0);
                    if (!newKey || cancelled) return;
                    activeConversationKey = newKey;
                    currentPaperItem = currentBasePaperItem;
                    const newItem = buildStandalonePortalItem({
                      mode: "paper",
                      conversationKey: newKey,
                      paperItem: currentBasePaperItem,
                      sessionVersion: summary?.sessionVersion,
                    });
                    if (newItem) mountChatPanel(newItem);
                  }
                } else {
                  await restoreStandaloneOpenConversation(false);
                }
              }
            }

            // Full sidebar re-render to sync state from DB
            await renderSidebar();
          } catch (err) {
            ztoolkit.log("LLM: standalone delete conversation failed", err);
            // Re-render sidebar to recover from partial state
            await renderSidebar().catch(() => {});
          }
          return;
        }
      });

      // Sidebar click handler — switch conversation
      sidebarList.addEventListener("click", (e: Event) => {
        const target = (e.target as HTMLElement).closest(
          ".llm-standalone-conv-item",
        ) as HTMLElement | null;
        if (!target) return;
        // Ignore if click was on the delete button (handled above)
        if ((e.target as HTMLElement).closest(".llm-standalone-conv-delete"))
          return;
        const key = Number(target.dataset.conversationKey);
        if (!key || key === activeConversationKey) return;

        activeConversationKey = key;

        // Update active class
        for (const el of sidebarList.querySelectorAll(
          ".llm-standalone-conv-item",
        )) {
          el.classList.remove("active");
        }
        target.classList.add("active");

        if (standaloneMode === "open") {
          const currentLibraryID = getCurrentLibraryScopeID();
          if (isClaudeConversationSystem()) {
            activeClaudeGlobalConversationByLibrary.set(
              buildClaudeLibraryStateKey(currentLibraryID),
              key,
            );
          } else if (isCodexConversationSystem()) {
            activeCodexGlobalConversationByLibrary.set(
              buildCodexLibraryStateKey(currentLibraryID),
              key,
            );
            setLastUsedCodexGlobalConversationKey(currentLibraryID, key);
          } else {
            activeGlobalConversationByLibrary.set(currentLibraryID, key);
          }
          const newItem = buildStandalonePortalItem({
            mode: "open",
            conversationKey: key,
          });
          if (newItem) mountChatPanel(newItem);
        } else {
          if (currentBasePaperItem) {
            const sessionVersion = Number(target.dataset.sessionVersion || "0");
            const newItem = buildStandalonePortalItem({
              mode: "paper",
              conversationKey: key,
              paperItem: currentBasePaperItem,
              sessionVersion,
            });
            currentPaperItem = currentBasePaperItem;
            if (newItem) mountChatPanel(newItem);
          }
        }
      });

      const resolveStandaloneGlobalConversation = async (
        forceFresh = false,
      ): Promise<number> => {
        const currentLibraryID = getCurrentLibraryScopeID();
        if (!currentLibraryID) return 0;
        if (isClaudeConversationSystem()) {
          const currentKey = Number(activeConversationKey || 0);
          if (Number.isFinite(currentKey) && currentKey > 0) {
            try {
              const currentSummary = await getClaudeConversationSummary(currentKey);
              if (
                currentSummary &&
                currentSummary.kind === "global" &&
                Number(currentSummary.libraryID) === currentLibraryID &&
                (currentSummary.userTurnCount || 0) === 0
              ) {
                return Math.floor(currentKey);
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to inspect active Claude global draft", err);
            }
          }
          if (!forceFresh) {
            try {
              const summaries = await listClaudeGlobalConversations(
                currentLibraryID,
                50,
              );
              const latestEmpty = summaries.find(
                (summary) => (summary.userTurnCount || 0) === 0,
              );
              if (latestEmpty?.conversationKey) {
                return Math.floor(latestEmpty.conversationKey);
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to list Claude global drafts", err);
            }
          }
          return Number(
            (await createClaudeGlobalConversation(currentLibraryID))?.conversationKey || 0,
          );
        }
        if (isCodexConversationSystem()) {
          const currentKey = Number(activeConversationKey || 0);
          if (Number.isFinite(currentKey) && currentKey > 0) {
            try {
              const currentSummary = await getCodexConversationSummary(currentKey);
              if (
                currentSummary &&
                currentSummary.kind === "global" &&
                Number(currentSummary.libraryID) === currentLibraryID &&
                (currentSummary.userTurnCount || 0) === 0
              ) {
                return Math.floor(currentKey);
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to inspect active Codex global draft", err);
            }
          }
          if (!forceFresh) {
            try {
              const summaries = await listCodexGlobalConversations(
                currentLibraryID,
                50,
              );
              const latestEmpty = summaries.find(
                (summary) => (summary.userTurnCount || 0) === 0,
              );
              if (latestEmpty?.conversationKey) {
                return Math.floor(latestEmpty.conversationKey);
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to list Codex global drafts", err);
            }
          }
          return Number(
            (await createCodexGlobalConversation(currentLibraryID))?.conversationKey || 0,
          );
        }
        const currentKey = Number(activeConversationKey || 0);
        if (isUpstreamGlobalConversationKey(currentKey)) {
          try {
            const turnCount = await getGlobalConversationUserTurnCount(currentKey);
            if (turnCount === 0) {
              return Math.floor(currentKey);
            }
          } catch (err) {
            ztoolkit.log("LLM: standalone failed to inspect active global draft", err);
          }
        }
        if (!forceFresh) {
          try {
            const latestEmpty = await getLatestEmptyGlobalConversation(currentLibraryID);
            if (latestEmpty?.conversationKey) {
              return Math.floor(latestEmpty.conversationKey);
            }
          } catch (err) {
            ztoolkit.log("LLM: standalone failed to load latest global draft", err);
          }
        }
        return await createGlobalConversation(currentLibraryID);
      };

      const resolveStandalonePaperConversation = async (
        forceFresh = false,
      ): Promise<{ conversationKey: number; sessionVersion?: number }> => {
        if (!currentBasePaperItem) {
          return { conversationKey: 0 };
        }
        const paperLibraryID = getCurrentPaperLibraryID();
        const paperId = Number(currentBasePaperItem.id || 0);
        if (!paperLibraryID || !paperId) {
          return { conversationKey: 0 };
        }
        if (isClaudeConversationSystem()) {
          const currentKey = Number(activeConversationKey || 0);
          if (Number.isFinite(currentKey) && currentKey > 0) {
            try {
              const currentSummary = await getClaudeConversationSummary(currentKey);
              if (
                currentSummary &&
                currentSummary.kind === "paper" &&
                (currentSummary.userTurnCount || 0) === 0
              ) {
                return { conversationKey: Math.floor(currentKey) };
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to inspect active Claude paper draft", err);
            }
          }
          if (!forceFresh) {
            try {
              const summaries = await listClaudePaperConversations(
                paperLibraryID,
                paperId,
                50,
              );
              const emptyEntry = summaries.find(
                (summary) => (summary.userTurnCount || 0) === 0,
              );
              if (emptyEntry?.conversationKey) {
                return { conversationKey: Math.floor(emptyEntry.conversationKey) };
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to list Claude paper drafts", err);
            }
          }
          return {
            conversationKey: Number(
              (await createClaudePaperConversation(paperLibraryID, paperId))
                ?.conversationKey || 0,
            ),
          };
        }
        if (isCodexConversationSystem()) {
          const currentKey = Number(activeConversationKey || 0);
          if (Number.isFinite(currentKey) && currentKey > 0) {
            try {
              const currentSummary = await getCodexConversationSummary(currentKey);
              if (
                currentSummary &&
                currentSummary.kind === "paper" &&
                (currentSummary.userTurnCount || 0) === 0
              ) {
                return { conversationKey: Math.floor(currentKey) };
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to inspect active Codex paper draft", err);
            }
          }
          if (!forceFresh) {
            try {
              const summaries = await listCodexPaperConversations(
                paperLibraryID,
                paperId,
                50,
              );
              const emptyEntry = summaries.find(
                (summary) => (summary.userTurnCount || 0) === 0,
              );
              if (emptyEntry?.conversationKey) {
                return { conversationKey: Math.floor(emptyEntry.conversationKey) };
              }
            } catch (err) {
              ztoolkit.log("LLM: standalone failed to list Codex paper drafts", err);
            }
          }
          return {
            conversationKey: Number(
              (await createCodexPaperConversation(paperLibraryID, paperId))
                ?.conversationKey || 0,
            ),
          };
        }
        const currentKey = Number(activeConversationKey || 0);
        if (Number.isFinite(currentKey) && currentKey > 0) {
          try {
            const currentSummary = await getPaperConversation(currentKey);
            if (currentSummary && currentSummary.userTurnCount === 0) {
              return { conversationKey: Math.floor(currentKey) };
            }
          } catch (err) {
            ztoolkit.log("LLM: standalone failed to inspect active paper draft", err);
          }
        }
        if (!forceFresh) {
          try {
            const summaries = await listPaperConversations(paperLibraryID, paperId, 50);
            const emptyEntry = summaries.find((summary) => summary.userTurnCount === 0);
            if (emptyEntry?.conversationKey) {
              return {
                conversationKey: Math.floor(emptyEntry.conversationKey),
                sessionVersion: emptyEntry.sessionVersion,
              };
            }
          } catch (err) {
            ztoolkit.log("LLM: standalone failed to list paper drafts", err);
          }
        }
        const summary = await createPaperConversation(paperLibraryID, paperId);
        return {
          conversationKey: Number(summary?.conversationKey || 0),
          sessionVersion: summary?.sessionVersion,
        };
      };

      const restoreStandaloneOpenConversation = async (
        forceFresh = false,
      ): Promise<boolean> => {
        standaloneMode = "open";
        paperTab.classList.remove("active");
        openTab.classList.add("active");
        const conversationKey = await resolveStandaloneGlobalConversation(forceFresh);
        if (!conversationKey || cancelled) {
          return false;
        }
        activeConversationKey = conversationKey;
        const currentLibraryID = getCurrentLibraryScopeID();
        if (isClaudeConversationSystem()) {
          activeClaudeGlobalConversationByLibrary.set(
            buildClaudeLibraryStateKey(currentLibraryID),
            conversationKey,
          );
        } else if (isCodexConversationSystem()) {
          activeCodexGlobalConversationByLibrary.set(
            buildCodexLibraryStateKey(currentLibraryID),
            conversationKey,
          );
          setLastUsedCodexGlobalConversationKey(
            currentLibraryID,
            conversationKey,
          );
        } else {
          activeGlobalConversationByLibrary.set(currentLibraryID, conversationKey);
        }
        const nextItem = buildStandalonePortalItem({
          mode: "open",
          conversationKey,
        });
        if (!nextItem) {
          return false;
        }
        mountChatPanel(nextItem);
        scheduleStandaloneSidebarRender();
        return true;
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
            const newKey = await resolveStandaloneGlobalConversation(true);
            if (!newKey || cancelled) return;
            activeConversationKey = newKey;
            if (isClaudeConversationSystem()) {
              activeClaudeGlobalConversationByLibrary.set(
                buildClaudeLibraryStateKey(currentLibraryID),
                newKey,
              );
            } else if (isCodexConversationSystem()) {
              activeCodexGlobalConversationByLibrary.set(
                buildCodexLibraryStateKey(currentLibraryID),
                newKey,
              );
              setLastUsedCodexGlobalConversationKey(currentLibraryID, newKey);
            } else {
              activeGlobalConversationByLibrary.set(currentLibraryID, newKey);
            }
            const newItem = buildStandalonePortalItem({
              mode: "open",
              conversationKey: newKey,
            });
            if (!newItem) return;
            mountChatPanel(newItem);
            await renderSidebar();
          } else {
            if (currentBasePaperItem) {
              const { conversationKey: newKey, sessionVersion } =
                await resolveStandalonePaperConversation(true);
              if (!newKey || cancelled) return;
              const newItem = buildStandalonePortalItem({
                mode: "paper",
                conversationKey: newKey,
                paperItem: currentBasePaperItem,
                sessionVersion,
              });
              if (!newItem) return;
              activeConversationKey = newKey;
              currentPaperItem = currentBasePaperItem;
              mountChatPanel(newItem);
              await renderSidebar();
            }
          }
        } catch (err) {
          ztoolkit.log("LLM: standalone new chat failed", err);
        } finally {
          explicitNewChatInFlight = false;
        }
      });

      iconSidebarToggle.addEventListener("click", () => toggleSidebar());

      // Icon strip action buttons
      iconSettings.addEventListener("click", () => {
        const btn = contentArea.querySelector(
          "#llm-settings",
        ) as HTMLElement | null;
        if (btn) btn.click();
      });
      iconExport.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        if (exportPopup.style.display !== "none") {
          exportPopup.style.display = "none";
          return;
        }
        // Position popup to the right of the icon strip, near the export icon
        const stripRect = iconStrip.getBoundingClientRect();
        const iconRect = iconExport.getBoundingClientRect();
        exportPopup.style.position = "fixed";
        exportPopup.style.left = `${Math.round(stripRect.right + 4)}px`;
        exportPopup.style.top = `${Math.round(iconRect.top)}px`;
        exportPopup.style.display = "flex";
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

      // -----------------------------------------------------------------------
      // Top bar tab switching
      // -----------------------------------------------------------------------
      let systemSwitchSeq = 0;
      const switchConversationSystem = async (
        nextSystem: ConversationSystem,
        options?: { forceFresh?: boolean },
      ) => {
        const switchSeq = ++systemSwitchSeq;
        const activeNoteItem = resolveActiveNoteSession(activeItem)
          ? activeItem
          : null;
        if (activeNoteItem) {
          const resolvedNextSystem = resolveNoteConversationSystemSwitch({
            nextSystem,
            codexAvailable: isCodexAppServerModeEnabled(),
          });
          if (!resolvedNextSystem) return;
          if (resolvedNextSystem === currentConversationSystem) return;
          currentConversationSystem = resolvedNextSystem;
          activeConversationKey = getConversationKey(activeNoteItem);
          mountChatPanel(activeNoteItem);
          scheduleStandaloneSidebarRender();
          updateStandaloneSystemToggle();
          return;
        }
        const currentSystem = currentConversationSystem;
        if (nextSystem === currentSystem) return;
        const forceFresh = options?.forceFresh === true;
        setConversationSystemPref(nextSystem);
        currentConversationSystem = nextSystem;
        updateStandaloneSystemToggle();
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
            if (nextSystem === "claude_code") {
              activeClaudeGlobalConversationByLibrary.set(
                buildClaudeLibraryStateKey(libraryID),
                conversationKey,
              );
            } else if (nextSystem === "codex") {
              activeCodexGlobalConversationByLibrary.set(
                buildCodexLibraryStateKey(libraryID),
                conversationKey,
              );
              setLastUsedCodexGlobalConversationKey(libraryID, conversationKey);
            } else {
              activeGlobalConversationByLibrary.set(libraryID, conversationKey);
            }
            mountChatPanel(nextItem as Zotero.Item);
            scheduleStandaloneSidebarRender();
            updateStandaloneSystemToggle();
          };

          if (forceFresh) {
            const newKey = await resolveStandaloneGlobalConversation(true);
            if (switchSeq !== systemSwitchSeq) return;
            if (newKey > 0) {
              mountOpenConversation(newKey);
            }
            return;
          }

          if (nextSystem === "claude_code") {
            const rememberedKey = Number(
              resolveRememberedClaudeConversationKey({
                libraryID,
                kind: "global",
              }) || 0,
            );
            const targetKey = Number.isFinite(rememberedKey) && rememberedKey > 0
              ? Math.floor(rememberedKey)
              : buildDefaultClaudeGlobalConversationKey(libraryID);
            if (switchSeq !== systemSwitchSeq) return;
            if (targetKey > 0) {
              mountOpenConversation(targetKey);
            }
            return;
          }

          if (nextSystem === "codex") {
            const rememberedKey = Number(
              activeCodexGlobalConversationByLibrary.get(
                buildCodexLibraryStateKey(libraryID),
              ) ||
                getLastUsedCodexGlobalConversationKey(libraryID) ||
                0,
            );
            const targetKey = Number.isFinite(rememberedKey) && rememberedKey > 0
              ? Math.floor(rememberedKey)
              : buildDefaultCodexGlobalConversationKey(libraryID);
            if (switchSeq !== systemSwitchSeq) return;
            if (targetKey > 0) {
              mountOpenConversation(targetKey);
            }
            return;
          }

          const rememberedUpstreamKey = (() => {
            const lockedKey = getLockedGlobalConversationKey(libraryID);
            if (lockedKey !== null) return lockedKey;
            const activeKey = Number(activeGlobalConversationByLibrary.get(libraryID) || 0);
            return isUpstreamGlobalConversationKey(activeKey) ? Math.floor(activeKey) : 0;
          })();
          const targetKey = Number.isFinite(rememberedUpstreamKey) && rememberedUpstreamKey > 0
            ? Math.floor(rememberedUpstreamKey)
            : GLOBAL_CONVERSATION_KEY_BASE;
          if (switchSeq !== systemSwitchSeq) return;
          if (targetKey > 0) {
            mountOpenConversation(targetKey);
          }
          return;
        }
        const nextRawItem = getSelectedZoteroItem() || currentBasePaperItem || currentPaperItem;
        const resolved = resolveInitialPanelItemState(nextRawItem, {
          conversationSystem: nextSystem,
        });
        currentBasePaperItem = resolved.basePaperItem || currentBasePaperItem;
        currentPaperItem = resolved.item || currentPaperItem;
        if (forceFresh) {
          const paperItem = currentBasePaperItem;
          if (!paperItem) return;
          const { conversationKey: newKey, sessionVersion } =
            await resolveStandalonePaperConversation(true);
          if (switchSeq !== systemSwitchSeq) return;
          if (!newKey) return;
          const freshItem = nextSystem === "claude_code"
            ? createClaudePaperPortalItem(paperItem, newKey)
            : nextSystem === "codex"
              ? createCodexPaperPortalItem(paperItem, newKey)
            : createPaperPortalItem(paperItem, newKey, sessionVersion || 1);
          activeConversationKey = newKey;
          currentPaperItem = paperItem;
          mountChatPanel(freshItem as Zotero.Item);
          scheduleStandaloneSidebarRender();
          void renderShortcuts(contentArea, freshItem as Zotero.Item, "paper");
          updateStandaloneSystemToggle();
          return;
        }
        if (switchSeq !== systemSwitchSeq) return;
        const nextItem = resolved.item || nextRawItem;
        if (nextItem) {
          mountChatPanel(nextItem);
          scheduleStandaloneSidebarRender();
          void renderShortcuts(
            contentArea,
            nextItem,
            resolveShortcutMode(nextItem),
          );
        }
        updateStandaloneSystemToggle();
      };

      systemToggleBtn.addEventListener("click", () => {
        void switchConversationSystem(
          isRuntimeConversationSystem() ? "upstream" : getPreferredRuntimeSystem(),
          { forceFresh: true },
        );
      });
      updateStandaloneSystemToggle();
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
        const onClaudeModePrefChange = () => {
          if (cancelled) {
            unregister();
            return;
          }
          if (!getClaudeCodeModeEnabled()) {
            void releaseClaudeRuntimeForBody(contentArea as Element);
            void invalidateAllClaudeHotRuntimes(getCoreAgentRuntime()).catch((err) => {
              ztoolkit.log("LLM: Failed to invalidate all Claude hot runtimes", err);
            });
            if (getConversationSystemPref() === "claude_code") {
              setConversationSystemPref("upstream");
            }
            if (isClaudeConversationSystem()) {
              void switchConversationSystem("upstream");
              return;
            }
          }
          updateStandaloneSystemToggle();
        };
        const onCodexModePrefChange = () => {
          if (cancelled) {
            unregister();
            return;
          }
          if (!isCodexAppServerModeEnabled()) {
            if (getConversationSystemPref() === "codex") {
              setConversationSystemPref("upstream");
            }
            if (isCodexConversationSystem()) {
              void switchConversationSystem("upstream");
              return;
            }
          }
          updateStandaloneSystemToggle();
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

      const switchToMode = async (mode: "open" | "paper") => {
        // [webchat] If in webchat mode and user clicks "Library chat", exit webchat first
        if (isInWebChatMode && mode === "open") {
          const clearBtnEl = contentArea.querySelector(
            "#llm-clear",
          ) as HTMLElement | null;
          if (clearBtnEl) clearBtnEl.click();
        }
        if (isInWebChatMode && mode === "paper") return;
        if (mode === standaloneMode) return;

        standaloneMode = mode;
        if (isClaudeConversationSystem()) {
          setLastUsedClaudeConversationMode(
            getCurrentLibraryScopeID(),
            mode === "open" ? "global" : "paper",
          );
        } else if (isCodexConversationSystem()) {
          setLastUsedCodexConversationMode(
            getCurrentLibraryScopeID(),
            mode === "open" ? "global" : "paper",
          );
        }
        paperTab.classList.toggle("active", mode === "paper");
        openTab.classList.toggle("active", mode === "open");

        if (mode === "open") {
          const currentLibraryID = getCurrentLibraryScopeID();
          const key = await resolveStandaloneGlobalConversation(false);
          if (!key) return;
          activeConversationKey = key;
          if (isClaudeConversationSystem()) {
            activeClaudeGlobalConversationByLibrary.set(
              buildClaudeLibraryStateKey(currentLibraryID),
              key,
            );
          } else if (isCodexConversationSystem()) {
            activeCodexGlobalConversationByLibrary.set(
              buildCodexLibraryStateKey(currentLibraryID),
              key,
            );
            setLastUsedCodexGlobalConversationKey(currentLibraryID, key);
          } else {
            activeGlobalConversationByLibrary.set(currentLibraryID, key);
          }
          const item = buildStandalonePortalItem({
            mode: "open",
            conversationKey: key,
          });
          if (!item) return;
          mountChatPanel(item);
          scheduleStandaloneSidebarRender();
          return;
        }

        const rawItem =
          getSelectedZoteroItem() || currentBasePaperItem || currentPaperItem;
        const resolved = resolveInitialPanelItemState(rawItem, {
          conversationSystem: currentConversationSystem,
        });
        currentBasePaperItem =
          resolved.basePaperItem ||
          (rawItem ? resolveConversationBaseItem(rawItem) : null) ||
          currentBasePaperItem;
        const paperItem = currentBasePaperItem;
        currentPaperItem = paperItem;

        if (paperItem) {
          const paperLibraryID = getCurrentPaperLibraryID();
          const paperId = Number(paperItem.id || 0);
          if (paperLibraryID > 0 && paperId > 0) {
            const { conversationKey: newKey, sessionVersion } =
              await resolveStandalonePaperConversation(false);
            if (newKey > 0) {
              activeConversationKey = newKey;
              const item = buildStandalonePortalItem({
                mode: "paper",
                conversationKey: newKey,
                paperItem,
                sessionVersion,
              });
              if (item) {
                mountChatPanel(item);
                scheduleStandaloneSidebarRender();
                return;
              }
            }
          }
        }

        await restoreStandaloneOpenConversation(false);
        return;
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
      const SIDEBAR_AUTO_THRESHOLD = 700;
      let lastAutoState: "expanded" | "collapsed" | null = null;
      const handleResize = () => {
        const width = root.clientWidth || 0;
        const autoState =
          width < SIDEBAR_AUTO_THRESHOLD ? "collapsed" : "expanded";
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
      const RO =
        (newWin as any).ResizeObserver || (globalThis as any).ResizeObserver;
      if (RO) {
        const resizeObserver = new RO((entries: any[]) => {
          const width = entries[0]?.contentRect?.width || root.clientWidth || 0;
          const autoState =
            width < SIDEBAR_AUTO_THRESHOLD ? "collapsed" : "expanded";
          if (userManualSidebarState !== null) {
            if (lastAutoState !== null && autoState !== lastAutoState) {
              userManualSidebarState = null;
              setSidebarState(autoState);
            }
          } else {
            setSidebarState(autoState);
          }
          lastAutoState = autoState;
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
      standaloneItemChangeHandler = (rawItem: Zotero.Item | null) => {
        if (cancelled || standaloneMode !== "paper") return;
        const resolved = resolveInitialPanelItemState(rawItem, {
          conversationSystem:
            resolveConversationSystemForItem(rawItem) || currentConversationSystem,
        });
        const newBasePaper =
          resolved.basePaperItem ||
          (rawItem ? resolveConversationBaseItem(rawItem) : null);
        if (!newBasePaper) return;
        // Skip if same paper
        const newPaperID = Number(newBasePaper.id || 0);
        const oldPaperID = Number(currentBasePaperItem?.id || 0);
        if (newPaperID > 0 && newPaperID === oldPaperID) return;
        // Switch to the new paper
        currentBasePaperItem = newBasePaper;
        currentPaperItem = resolved.item || newBasePaper;
        mountChatPanel(currentPaperItem);
        scheduleStandaloneSidebarRender();
      };

      // Initial mount — preserve the source panel mode/item when available
      ztoolkit.log(
        "LLM: standalone mounting initial item",
        "mode=" + standaloneMode,
        "itemId=" + (initialMountedItem?.id ?? "null"),
        "convKey=" + getConversationKey(initialMountedItem),
      );
      mountChatPanel(initialMountedItem);

      // Load sidebar initially
      ztoolkit.log(
        "LLM: standalone renderSidebar start",
        "mode=" + standaloneMode,
      );
      scheduleStandaloneSidebarRender();
      renderStandalonePlaceholdersInEmbeddedPanels(contentArea);
    } catch (err) {
      ztoolkit.log("LLM: standalone initWindow failed", err);
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
    cleanupStandalonePrefObserver?.();
    standaloneItemChangeHandler = null;
    themeObserver?.disconnect();
    themeObserver = null;
    if (darkMQ && onSchemeChange) {
      darkMQ.removeEventListener("change", onSchemeChange);
    }
    darkMQ = null;
    onSchemeChange = null;
    setStandalonePending(false);
    // Remove the standalone window's content area from panel tracking
    const root = newWin.document?.getElementById(
      "llmforzotero-standalone-chat-root",
    );
    const contentArea = root?.querySelector(".llm-standalone-content");
    if (contentArea) {
      void releaseClaudeRuntimeForBody(contentArea as Element);
      activeContextPanels.delete(contentArea);
      activeContextPanelRawItems.delete(contentArea);
      activeContextPanelStateSync.delete(contentArea);
    }
    const sessionWin = getStandaloneSessionWindow();
    if (sessionWin === newWin || sessionWin === null) {
      setStandaloneSessionWindow(null);
    }
    restoreEmbeddedPanelsAfterStandaloneClose(contentArea as Element | null);
  };

  newWin.addEventListener("load", initWindow, { once: true });
  // Note: unload is registered inside initWindow to avoid the XUL
  // about:blank → document transition firing a premature unload.
}
