/**
 * Context Panel Module
 *
 * This is the main entry point for the LLM context panel, which provides
 * a chat interface in Zotero's reader/library side panel.
 *
 * The module is split into focused sub-modules:
 * - constants.ts   – shared constants
 * - types.ts       – shared type definitions
 * - state.ts       – module-level mutable state
 * - buildUI.ts     – UI construction
 * - setupHandlers.ts – event handler wiring
 * - chat.ts        – conversation logic, send/refresh
 * - shortcuts.ts   – shortcut rendering and management
 * - screenshot.ts  – screenshot capture from PDF reader
 * - pdfContext.ts   – PDF text extraction, chunking, BM25, embeddings
 * - multiContextPlanner.ts – budget-first adaptive multi-context assembly
 * - notes.ts       – Zotero note creation from chat
 * - contextResolution.ts – tab/reader context resolution
 * - menuPositioning.ts   – dropdown/context menu positioning
 * - prefHelpers.ts – preference access helpers
 * - textUtils.ts   – text sanitization, formatting
 */

import { getLocaleID } from "../../utils/locale";
import { config, PANE_ID } from "./constants";
import type { Message } from "./types";
import type { ConversationSystem } from "../../shared/types";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  chatHistory,
  loadedConversationKeys,
  readerContextPanelRegistered,
  setReaderContextPanelRegistered,
  recentReaderSelectionCache,
} from "./state";
import { clearConversation as clearStoredConversation } from "../../utils/chatStore";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  clearOwnerAttachmentRefs,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";
import { normalizeSelectedText, setStatus } from "./textUtils";
import { buildUI } from "./buildUI";
import { setupHandlers } from "./setupHandlers";
import { ensureConversationLoaded, getConversationKey } from "./chat";
import { renderShortcuts } from "./shortcuts";
import { refreshChat } from "./chat";
import {
  beginChatRenderCycle,
  claimAsyncChatRender,
  claimDeferredChatRender,
  currentChatRenderCycle,
  setPanelRenderClaim,
  takePanelRenderClaim,
} from "./chatRenderCycle";
import { persistPendingChatScrollRestoreFromBody } from "./chatScrollSnapshots";
import {
  getActiveContextAttachmentFromTabs,
  getActiveReaderForSelectedTab,
  refreshLastKnownSelectedTabId,
  getItemSelectionCacheKeys,
  resolvePanelContextLifecycleState,
  applySelectedTextPreview,
  getSelectedTextContextEntries,
  type SelectedTextPageLocation,
} from "./contextResolution";
import {
  clearNoteEditingSelectedText,
  getNoteFocusConversationKey,
  syncNoteEditingSelectedText,
} from "./noteEditing/selectionController";
import {
  createNoteEditingSelectionTrackingLifecycle,
  type NoteEditingSelectionTrackingLifecycle,
} from "./noteEditing/selectionTrackingLifecycle";
import { ensurePDFTextCached, ensureNoteTextCached } from "./pdfContext";
import { getPageLabelForIndex } from "./livePdfSelectionLocator";
import {
  getFirstSelectionFromReader,
  getSelectionFromDocument,
} from "./readerSelection";
import {
  createReaderSelectionTrackingLifecycle,
  unregisterReaderSelectionTrackingListener,
  type ReaderSelectionTrackingLifecycle,
  type ReaderSelectionTrackingReader,
} from "./readerSelectionTracking";
import { resolveReaderPopupPaperContext } from "./readerPopup";
import {
  resolveReaderPopupPanelTarget,
  resolveStandalonePopupPanelTarget,
} from "./readerPopupPanelRouting";
import {
  includeReaderSelectedText,
  type IncludeReaderSelectedTextResult,
} from "./readerTextInclusion";
import {
  resolveInitialPanelItemState,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolveShortcutMode,
} from "./portalScope";
import { resolveActiveLibraryID } from "../../utils/zoteroLibraryScope";
import { getLockedGlobalConversationKey } from "./prefHelpers";
import { getEditableSelectionFromDocument } from "./noteSelection";
import {
  clearCompletedPanelLifecycleSignature,
  hasCompletedPanelLifecycleSignature,
  markCompletedPanelLifecycleSignature,
  type PanelLifecycleSignature,
} from "./panelLifecycleSignature";
import {
  hasPanelContextOwnerChanged,
  shouldRefreshContextSourceWithoutPanelRebuild,
} from "./panelContextLifecycle";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import {
  bindEmbeddedPanelHost,
  canLifecycleCommitPanelConversation,
  capturePanelOperationLease,
  evaluatePanelOwnership,
  isPanelOperationLeaseCurrent,
  renderPanelOwnershipBlocked,
} from "./panelHostOwnership";

export { openStandaloneChat } from "./standaloneWindow";
import {
  isStandaloneWindowActive,
  notifyStandaloneItemChanged,
  renderStandalonePlaceholder,
} from "./standaloneWindow";

// =============================================================================
// Public API
// =============================================================================

export function registerLLMStyles(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  if (doc.getElementById(`${config.addonRef}-styles`)) return;

  // Main styles
  const link = doc.createElement("link") as HTMLLinkElement;
  link.id = `${config.addonRef}-styles`;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(link);

  // KaTeX styles for math rendering
  const katexLink = doc.createElement("link") as HTMLLinkElement;
  katexLink.id = `${config.addonRef}-katex-styles`;
  katexLink.rel = "stylesheet";
  katexLink.type = "text/css";
  katexLink.href = `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`;
  doc.documentElement?.appendChild(katexLink);
}

function getPanelItemIdKey(item: Zotero.Item | null | undefined): string {
  const id = Math.floor(Number((item as any)?.id || 0));
  return Number.isFinite(id) && id > 0 ? `${id}` : "";
}

function getPanelContextItemIdKey(
  item: Zotero.Item | null | undefined,
): string {
  const state = resolvePanelContextLifecycleState(item);
  const id = state?.requiresAsyncResolution ? 0 : state?.contextItemId || 0;
  return id > 0 ? `${id}` : "";
}

function getPanelContextOwnerItemIdKey(
  item: Zotero.Item | null | undefined,
): string {
  const id = resolvePanelContextLifecycleState(item)?.ownerItemId || 0;
  return id > 0 ? `${id}` : "";
}

function getPanelContextSourceStateKey(
  item: Zotero.Item | null | undefined,
): string {
  const state = resolvePanelContextLifecycleState(item);
  if (!state) return "";
  const contextItemId = state.requiresAsyncResolution ? 0 : state.contextItemId;
  return [
    state.sourceKind,
    contextItemId > 0 ? `${contextItemId}` : "",
    state.supportKind || "",
    state.contentSourceMode || "",
    state.requiresAsyncResolution ? "async" : "sync",
  ].join(":");
}

function writePanelContextDataset(
  panelRoot: HTMLElement | null | undefined,
  rawItem: Zotero.Item | null | undefined,
) {
  if (!panelRoot) return;
  const rawContextItemKey = rawItem
    ? String(Number(rawItem.id || 0) || "")
    : "";
  panelRoot.dataset.contextItemId = getPanelContextItemIdKey(rawItem);
  panelRoot.dataset.contextOwnerItemId = getPanelContextOwnerItemIdKey(rawItem);
  panelRoot.dataset.contextSourceStateKey =
    getPanelContextSourceStateKey(rawItem);
  panelRoot.dataset.rawContextItemId = rawContextItemKey;
}

function buildPanelLifecycleSignature(
  rawItem: Zotero.Item | null | undefined,
  resolvedItem: Zotero.Item | null | undefined,
): PanelLifecycleSignature {
  const rawContextItem = rawItem || resolvedItem;
  return {
    conversationKey: resolvedItem ? `${getConversationKey(resolvedItem)}` : "0",
    rawContextItemId: getPanelContextOwnerItemIdKey(rawContextItem),
    contextItemId: "",
    conversationSystem:
      resolveConversationSystemForItem(resolvedItem) || "upstream",
    conversationKind: resolveDisplayConversationKind(resolvedItem) || "",
    shortcutMode: resolveShortcutMode(resolvedItem),
  };
}

function isPanelRootInitialized(
  panelRoot: HTMLElement | null | undefined,
): boolean {
  return Boolean(panelRoot?.dataset?.handlersInitialized);
}

function isPanelBodyInitialized(body: Element): boolean {
  return isPanelRootInitialized(
    body.querySelector("#llm-main") as HTMLElement | null,
  );
}

function isPanelConversationLoaded(
  resolvedItem: Zotero.Item | null | undefined,
): boolean {
  return (
    !resolvedItem ||
    loadedConversationKeys.has(getConversationKey(resolvedItem))
  );
}

export function registerReaderContextPanel() {
  if (readerContextPanelRegistered) return;
  setReaderContextPanelRegistered(true);
  // Generation counter: incremented on every onAsyncRender call so stale
  // (superseded) renders can bail out at each await point.
  let renderGeneration = 0;
  const lastItemChangeSignatures = new WeakMap<Element, string>();
  const setupEmbeddedPanelHandlers = (
    body: Element,
    rawItem: Zotero.Item | null | undefined,
  ) => {
    setupHandlers(body, rawItem);
  };
  const rebuildEmbeddedPanelForHost = (
    body: Element,
    rawItem: Zotero.Item | null | undefined,
    resolvedState: { item: Zotero.Item | null },
  ) => {
    const hostLease = capturePanelOperationLease(body);
    if (
      !canLifecycleCommitPanelConversation(
        body,
        resolvedState.item,
        "embedded-rebuild",
        hostLease,
      )
    ) {
      renderPanelOwnershipBlocked(body, "embedded-rebuild", "unresolved");
      return;
    }
    clearCompletedPanelLifecycleSignature(body);
    persistPendingChatScrollRestoreFromBody(body);
    buildUI(body, resolvedState.item);
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    writePanelContextDataset(panelRoot, rawItem || resolvedState.item);
    activeContextPanels.set(body, () => resolvedState.item);
    activeContextPanelRawItems.set(body, rawItem || null);
    void retainClaudeRuntimeForBody(body, resolvedState.item);
    setupEmbeddedPanelHandlers(body, rawItem);
    const chatRenderCycle = beginChatRenderCycle(body);
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: getPanelItemIdKey(rawItem || null),
      cycle: chatRenderCycle,
    });
    void (async () => {
      try {
        if (resolvedState.item)
          await ensureConversationLoaded(resolvedState.item);
        if (isStandaloneWindowActive()) return;
        if (!isPanelOperationLeaseCurrent(hostLease)) return;
        if (!claimDeferredChatRender(body, chatRenderCycle)) return;
        refreshChat(body, resolvedState.item);
      } catch (err) {
        ztoolkit.log("LLM: embedded panel reconciliation failed", err);
      }
    })();
  };
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: `chrome://${config.addonRef}/content/icons/icon-sidebar.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/icon-sidebar.svg`,
    },
    onInit: ({ setEnabled, tabType }) => {
      setEnabled(true);
      ztoolkit.log(`LLM: panel init tabType=${tabType}`);
    },
    onItemChange: ({ body, setEnabled, tabType, item }) => {
      setEnabled(true);
      bindEmbeddedPanelHost(body, item || null, tabType);
      const resolvedState = resolveInitialPanelItemState(item);
      const mountedVerdict = evaluatePanelOwnership(body, resolvedState.item);
      if (
        mountedVerdict === "host-mismatch" ||
        (mountedVerdict === "unresolved" && isPanelBodyInitialized(body))
      ) {
        renderPanelOwnershipBlocked(body, "onItemChange", mountedVerdict);
        if (!isStandaloneWindowActive()) {
          rebuildEmbeddedPanelForHost(body, item || null, resolvedState);
        }
      }
      const selectedTabId = refreshLastKnownSelectedTabId();
      const itemChangeSignature = [
        tabType || "",
        selectedTabId ?? "",
        getPanelItemIdKey(item || null),
      ].join("|");
      if (itemChangeSignature === lastItemChangeSignatures.get(body)) {
        return true;
      }
      lastItemChangeSignatures.set(body, itemChangeSignature);
      if (isStandaloneWindowActive()) {
        notifyStandaloneItemChanged(item || null);
      }
      return true;
    },
    onRender: ({ body, item, tabType }) => {
      bindEmbeddedPanelHost(body, item || null, tabType);
      const lifecycleLease = capturePanelOperationLease(body);
      // When standalone window is open, show placeholder instead of full UI
      if (isStandaloneWindowActive()) {
        clearCompletedPanelLifecycleSignature(body);
        void releaseClaudeRuntimeForBody(body);
        renderStandalonePlaceholder(body);
        const resolvedState = resolveInitialPanelItemState(item);
        if (
          canLifecycleCommitPanelConversation(
            body,
            resolvedState.item,
            "standalone-placeholder-commit",
            lifecycleLease,
          )
        ) {
          activeContextPanels.set(body, () => resolvedState.item);
          activeContextPanelRawItems.set(body, item || null);
        }
        setPanelRenderClaim(body, {
          kind: "sync-rendered",
          itemKey: getPanelItemIdKey(item || null),
          cycle: currentChatRenderCycle(body),
        });
        return;
      }
      try {
        const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
        // Treat missing panel root as needing a full render — the body may
        // belong to a tab that onAsyncRender never fired for.
        // Also treat an uninitialized shell as incomplete.  Zotero can fire a
        // superseded async render after buildUI() but before setupHandlers();
        // that leaves a blank chat box and default "Model: ..." controls.
        const needsFullRender =
          !activeContextPanels.has(body) ||
          !panelRoot ||
          !isPanelRootInitialized(panelRoot) ||
          Boolean(panelRoot.dataset.ownershipBlocked);

        const resolvedState = resolveInitialPanelItemState(item);
        const expectedSystem =
          resolveConversationSystemForItem(resolvedState.item) || "upstream";

        // Also check if a global lock requires switching to open chat
        const libraryID =
          resolveActiveLibraryID() ||
          (resolvedState.item
            ? Number(resolvedState.item.libraryID || 0)
            : 0) ||
          (item ? Number(item.libraryID || 0) : 0);
        const lockedKey =
          expectedSystem === "claude_code" || expectedSystem === "codex"
            ? null
            : libraryID > 0
              ? getLockedGlobalConversationKey(libraryID)
              : null;
        const currentKind = panelRoot?.dataset?.conversationKind;
        const currentItemKey = panelRoot?.dataset?.itemId;
        const currentSystem = panelRoot?.dataset?.conversationSystem || "";
        const currentContextItemKey = panelRoot?.dataset?.contextItemId || "";
        const currentRawContextItemKey =
          panelRoot?.dataset?.rawContextItemId || "";
        const currentContextOwnerItemKey =
          panelRoot?.dataset?.contextOwnerItemId || "";
        const currentContextSourceStateKey =
          panelRoot?.dataset?.contextSourceStateKey || "";
        // Lock is stale if:
        // - lock active + panel in paper mode (need to switch to global)
        // - lock active + panel shows different global conversation
        // - lock cleared + panel still in global mode (need to switch back to paper)
        const lockStale =
          (lockedKey !== null &&
            (currentKind === "paper" ||
              (currentItemKey !== undefined &&
                currentItemKey !== String(lockedKey)))) ||
          (lockedKey === null && currentKind === "global" && !needsFullRender);

        // Detect if the active item has changed (e.g. user switched reader tabs).
        // If so, the panel must fully re-render to switch conversations.
        const storedItemKey = panelRoot?.dataset?.itemId;
        const newItemKey = resolvedState.item
          ? String(getConversationKey(resolvedState.item))
          : "0";
        const rawContextItem = item || resolvedState.item;
        const rawContextItemKey = rawContextItem
          ? String(Number(rawContextItem.id || 0) || "")
          : "";
        const newContextOwnerItemKey =
          getPanelContextOwnerItemIdKey(rawContextItem);
        const newContextSourceStateKey =
          getPanelContextSourceStateKey(rawContextItem);
        const itemChanged =
          !needsFullRender &&
          storedItemKey !== undefined &&
          storedItemKey !== newItemKey;
        const contextDecision = {
          needsFullRender,
          storedItemKey,
          newItemKey,
          currentKind,
          currentRawContextItemKey,
          rawContextItemKey,
          currentContextOwnerItemKey,
          newContextOwnerItemKey,
          currentContextSourceStateKey:
            currentContextSourceStateKey || currentContextItemKey,
          newContextSourceStateKey,
        };
        const contextOwnerChanged =
          hasPanelContextOwnerChanged(contextDecision);
        const sameOwnerContextSourceChanged =
          shouldRefreshContextSourceWithoutPanelRebuild(contextDecision);
        const systemChanged =
          !needsFullRender && currentSystem !== expectedSystem;

        if (
          needsFullRender ||
          lockStale ||
          itemChanged ||
          contextOwnerChanged ||
          systemChanged
        ) {
          // Build and attach synchronously so host identity is corrected even
          // when Zotero reveals a reused pane without a useful async render.
          rebuildEmbeddedPanelForHost(body, item, resolvedState);
        } else {
          // Same item — keep item reference current so delegated handlers
          // (e.g. Add Text) always resolve the active item.
          if (
            !canLifecycleCommitPanelConversation(
              body,
              resolvedState.item,
              "onRender-current-item-commit",
              lifecycleLease,
            )
          ) {
            return;
          }
          activeContextPanels.set(body, () => resolvedState.item);
          activeContextPanelRawItems.set(body, item || null);
          writePanelContextDataset(panelRoot, rawContextItem);
          void retainClaudeRuntimeForBody(body, resolvedState.item);
          if (sameOwnerContextSourceChanged) {
            persistPendingChatScrollRestoreFromBody(body);
            setPanelRenderClaim(body, {
              kind: "context-refresh",
              itemKey: getPanelItemIdKey(item || null),
            });
            const refreshContextSource = (body as any)
              .__llmRefreshContextSourceForCurrentItem;
            if (typeof refreshContextSource === "function") {
              refreshContextSource();
            } else {
              activeContextPanelStateSync.get(body)?.();
            }
          }
        }
      } catch {
        /* ignore */
      }
    },
    onAsyncRender: async ({ body, item, setEnabled }) => {
      setEnabled(true);
      // Skip full render when standalone window is active
      if (isStandaloneWindowActive()) return;

      const resolvedInitialState = resolveInitialPanelItemState(item);
      const resolvedItem = resolvedInitialState.item;
      const lifecycleSignature = buildPanelLifecycleSignature(
        item || null,
        resolvedItem,
      );
      if (
        isPanelBodyInitialized(body) &&
        hasCompletedPanelLifecycleSignature(body, lifecycleSignature, {
          conversationLoaded: isPanelConversationLoaded(resolvedItem),
        })
      ) {
        return;
      }

      // Take the latest onRender's claim in this synchronous prefix, before
      // any await AND before bumping renderGeneration. Ownership is bound to
      // the item whose onRender last ran: a mismatch means this async render
      // has been superseded and must bail with zero side effects — bumping
      // the generation first would cancel the rightful in-flight render, and
      // consuming the newer render's claim is how a stale async render used
      // to paint the previous item's conversation into the new panel.
      const renderClaim = takePanelRenderClaim(
        body,
        getPanelItemIdKey(item || null),
      );
      if (renderClaim.outcome === "stale") return;

      const hostLease = capturePanelOperationLease(body);
      if (!hostLease) {
        if (isPanelBodyInitialized(body)) {
          renderPanelOwnershipBlocked(body, "onAsyncRender", "unresolved");
        }
        return;
      }

      const thisGeneration = ++renderGeneration;
      // If onRender already did the synchronous buildUI + setupHandlers for
      // this render cycle, skip the duplicate work.  We still run the
      // async-only steps: ensureConversationLoaded (properly awaited),
      // renderShortcuts, refreshChat (after data ready), and content caching.
      const syncAlreadyRendered = renderClaim.outcome === "sync-rendered";
      // The cycle travels inside the claim, so it is exactly the cycle begun
      // by the onRender that left it; claiming is affine to this cycle so a
      // stale async render cannot steal a newer cycle's claim.
      const sharedChatRenderCycle =
        renderClaim.outcome === "sync-rendered" ? renderClaim.cycle : null;
      const contextRefreshOnly =
        renderClaim.outcome === "context-refresh" &&
        Boolean(body.querySelector("#llm-main"));
      if (
        !canLifecycleCommitPanelConversation(
          body,
          resolvedItem,
          "onAsyncRender-commit",
          hostLease,
        )
      ) {
        return;
      }
      if (contextRefreshOnly) {
        activeContextPanels.set(body, () => resolvedItem);
        activeContextPanelRawItems.set(body, item || null);
      } else if (!syncAlreadyRendered) {
        persistPendingChatScrollRestoreFromBody(body);
        buildUI(body, resolvedItem);
        const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
        writePanelContextDataset(panelRoot, item || resolvedItem);
        activeContextPanelRawItems.set(body, item || null);
      }

      if (resolvedItem) {
        await ensureConversationLoaded(resolvedItem);
      }
      // Bail if a newer render has started while we were awaiting,
      // or if the standalone window was opened during the await.
      if (renderGeneration !== thisGeneration) return;
      if (isStandaloneWindowActive()) return;
      if (!isPanelOperationLeaseCurrent(hostLease)) return;
      await renderShortcuts(
        body,
        resolvedItem,
        resolveShortcutMode(resolvedItem),
      );
      if (renderGeneration !== thisGeneration) return;
      if (isStandaloneWindowActive()) return;
      if (!isPanelOperationLeaseCurrent(hostLease)) return;
      if (!syncAlreadyRendered && !contextRefreshOnly) {
        setupEmbeddedPanelHandlers(body, item);
      }
      if (contextRefreshOnly) {
        const refreshContextSource = (body as any)
          .__llmRefreshContextSourceForCurrentItem;
        if (typeof refreshContextSource === "function") {
          refreshContextSource();
        } else {
          activeContextPanelStateSync.get(body)?.();
        }
      }
      if (claimAsyncChatRender(body, sharedChatRenderCycle)) {
        refreshChat(body, resolvedItem);
      }
      markCompletedPanelLifecycleSignature(body, lifecycleSignature);
      // Defer content extraction so the panel becomes interactive sooner.
      const activeContextItem = getActiveContextAttachmentFromTabs();
      if (activeContextItem) {
        void ensurePDFTextCached(activeContextItem);
      } else if (item && (item as any).isNote?.()) {
        void ensureNoteTextCached(item);
      }
    },
  });
}

type ReaderTextSelectionPopupHandler =
  _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup">;

let readerSelectionTrackingHandler: ReaderTextSelectionPopupHandler | null =
  null;
let readerSelectionTrackingLifecycle: ReaderSelectionTrackingLifecycle | null =
  null;
let readerSelectionTrackingReaderAPI: ReaderSelectionTrackingReader<ReaderTextSelectionPopupHandler> | null =
  null;

function getReaderSelectionTrackingHandler(): ReaderTextSelectionPopupHandler {
  if (readerSelectionTrackingHandler) return readerSelectionTrackingHandler;
  readerSelectionTrackingHandler = (event) => {
    const selectedText = (() => {
      const fromAnnotation = normalizeSelectedText(
        event.params?.annotation?.text || "",
      );
      if (fromAnnotation) return fromAnnotation;
      const fromPopupDoc = getSelectionFromDocument(
        event.doc,
        normalizeSelectedText,
      );
      if (fromPopupDoc) return fromPopupDoc;
      return getFirstSelectionFromReader(
        event.reader as any,
        normalizeSelectedText,
      );
    })();
    const itemId = event.reader?._item?.id || event.reader?.itemID;
    if (typeof itemId !== "number") return;
    const item = Zotero.Items.get(itemId) || null;
    const cacheKeys = getItemSelectionCacheKeys(item);
    const keys = cacheKeys.length ? cacheKeys : [itemId];
    const popupPrefValue = Zotero.Prefs.get(
      `${config.prefsPrefix}.showPopupAddText`,
      true,
    );
    const showAddTextInPopup =
      popupPrefValue !== false &&
      `${popupPrefValue || ""}`.toLowerCase() !== "false";

    const resolveSelectedTextForPopupAction = (): string => {
      const fromPopupDoc = getSelectionFromDocument(
        event.doc,
        normalizeSelectedText,
      );
      if (fromPopupDoc) return fromPopupDoc;
      const fromParams = normalizeSelectedText(
        (event.params as unknown as { text?: string; selectedText?: string })
          ?.text ||
          (event.params as unknown as { text?: string; selectedText?: string })
            ?.selectedText ||
          "",
      );
      if (fromParams) return fromParams;
      const fromAnnotation = normalizeSelectedText(
        event.params?.annotation?.text || "",
      );
      if (fromAnnotation) return fromAnnotation;
      const fromReader = getFirstSelectionFromReader(
        event.reader as any,
        normalizeSelectedText,
      );
      if (fromReader) return fromReader;
      for (const key of keys) {
        const cached = normalizeSelectedText(
          recentReaderSelectionCache.get(key) || "",
        );
        if (cached) return cached;
      }
      return "";
    };

    if (selectedText || showAddTextInPopup) {
      let popupSentinelEl: HTMLElement | null = null;
      const addTextToPanel =
        async (): Promise<IncludeReaderSelectedTextResult | null> => {
          const effectiveSelectedText =
            normalizeSelectedText(selectedText) ||
            resolveSelectedTextForPopupAction();
          if (!effectiveSelectedText) {
            ztoolkit.log("LLM: Add Text popup action skipped (no selection)");
            return null;
          }
          try {
            const docs = new Set<Document>();
            const pushDoc = (doc?: Document | null) => {
              if (doc) docs.add(doc);
            };
            pushDoc(event.doc);
            pushDoc(event.doc.defaultView?.top?.document || null);
            try {
              pushDoc(Zotero.getMainWindow()?.document || null);
            } catch (_err) {
              void _err;
            }
            try {
              const wins = Zotero.getMainWindows?.() || [];
              for (const win of wins) {
                pushDoc(win?.document || null);
              }
            } catch (_err) {
              void _err;
            }
            const readerWithTab = event.reader as unknown as {
              tabID?: string | number | null;
              _tabID?: string | number | null;
            };
            const popupTopDoc = event.doc.defaultView?.top?.document || null;
            const target = isStandaloneWindowActive()
              ? resolveStandalonePopupPanelTarget(activeContextPanels.keys())
              : resolveReaderPopupPanelTarget({
                  preferredDocument: popupTopDoc,
                  documents: docs,
                  tabID: readerWithTab.tabID ?? readerWithTab._tabID ?? null,
                });
            if (!target) {
              ztoolkit.log(
                "LLM: Add Text popup action skipped (reader panel unavailable)",
              );
              return null;
            }

            const readerPaperContext = resolveReaderPopupPaperContext(
              item,
              getActiveContextAttachmentFromTabs(),
            );
            const panelBody = target.body;
            const conversationKey = Math.floor(
              Number(target.root.dataset.itemId || 0),
            );
            if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
              ztoolkit.log(
                "LLM: Add Text popup action skipped (invalid conversation target)",
              );
              return null;
            }
            const selectedPaperContext =
              target.root.dataset.conversationKind === "global"
                ? readerPaperContext
                : null;
            const popupAnnotation = event.params?.annotation as unknown as {
              pageIndex?: unknown;
              pageLabel?: unknown;
              position?: {
                pageIndex?: unknown;
                pageLabel?: unknown;
              } | null;
            };
            const rawPopupPageIndex =
              popupAnnotation?.position?.pageIndex ??
              popupAnnotation?.pageIndex;
            const parsedPopupPageIndex = Number(rawPopupPageIndex);
            const popupPageIndex =
              Number.isFinite(parsedPopupPageIndex) && parsedPopupPageIndex >= 0
                ? Math.floor(parsedPopupPageIndex)
                : null;
            const rawPopupPageLabel =
              popupAnnotation?.position?.pageLabel ??
              popupAnnotation?.pageLabel;
            const popupPageLabel =
              typeof rawPopupPageLabel === "string" && rawPopupPageLabel.trim()
                ? rawPopupPageLabel.trim()
                : popupPageIndex !== null
                  ? getPageLabelForIndex(event.reader as any, popupPageIndex)
                  : undefined;
            const selectedTextLocation: SelectedTextPageLocation | null =
              popupPageIndex !== null
                ? {
                    contextItemId: itemId,
                    pageIndex: popupPageIndex,
                    pageLabel: popupPageLabel,
                  }
                : null;
            return await includeReaderSelectedText({
              body: panelBody,
              conversationKey,
              selectedText: effectiveSelectedText,
              reader: event.reader as any,
              paperContext: selectedPaperContext,
              initialLocation: selectedTextLocation,
              log: (message, ...args) => ztoolkit.log(message, ...args),
            });
          } catch (err) {
            ztoolkit.log("LLM: Add Text popup action failed", err);
            return null;
          }
        };
      const stripPopupRowChrome = (
        row: HTMLElement | null,
        hideRow: boolean = false,
      ) => {
        if (!row) return;
        const HTMLElementCtor = event.doc.defaultView?.HTMLElement;
        if (hideRow) {
          row.style.display = "none";
        } else {
          row.style.width = "100%";
          row.style.padding = "0 12px";
          row.style.margin = "0";
          row.style.borderTop = "none";
          row.style.borderBottom = "none";
          row.style.boxShadow = "none";
          row.style.background = "transparent";
        }
        const isSeparator = (el: Element | null): el is HTMLElement => {
          if (!el || !HTMLElementCtor || !(el instanceof HTMLElementCtor))
            return false;
          const tag = el.tagName.toLowerCase();
          return tag === "hr" || el.getAttribute("role") === "separator";
        };
        const prev = row.previousElementSibling;
        const next = row.nextElementSibling;
        if (isSeparator(prev)) prev.style.display = "none";
        if (isSeparator(next)) next.style.display = "none";
      };
      if (showAddTextInPopup) {
        try {
          const addTextBtn = event.doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "button",
          ) as HTMLButtonElement;
          addTextBtn.type = "button";
          addTextBtn.textContent = "Add Text";
          addTextBtn.title = "Add selected text to LLM panel";
          addTextBtn.style.cssText = [
            "display:block",
            "width:100%",
            "margin:0",
            "padding:6px 8px",
            "box-sizing:border-box",
            "border:1px solid rgba(130,130,130,0.38)",
            "border-radius:6px",
            "background:rgba(255,255,255,0.04)",
            // Keep text readable across light/dark themes.
            "color:inherit",
            "font-size:12px",
            "line-height:1.25",
            "text-align:center",
            "cursor:pointer",
          ].join(";");
          let addTextHandled = false;
          const showAddTextUnavailable = () => {
            addTextBtn.textContent = "Unable to add text";
            addTextBtn.title = "The active reader chat panel is unavailable";
            addTextBtn.disabled = true;
            addTextBtn.style.cursor = "not-allowed";
          };
          const handleAddTextAction = (e: Event) => {
            if (addTextHandled) return;
            addTextHandled = true;
            e.preventDefault();
            e.stopPropagation();
            void addTextToPanel().then((result) => {
              if (
                !result ||
                result.outcome === "no-selection" ||
                result.outcome === "invalid-target"
              ) {
                showAddTextUnavailable();
              }
            });
          };
          const isPrimaryButton = (e: Event): boolean => {
            const maybeMouse = e as MouseEvent;
            return (
              typeof maybeMouse.button !== "number" || maybeMouse.button === 0
            );
          };
          // Reader popup items may be removed before "click" fires.
          // Handle early pointer/mouse down as the primary trigger.
          addTextBtn.addEventListener("pointerdown", (e: Event) => {
            if (!isPrimaryButton(e)) return;
            handleAddTextAction(e);
          });
          addTextBtn.addEventListener("mousedown", (e: Event) => {
            if (!isPrimaryButton(e)) return;
            handleAddTextAction(e);
          });
          addTextBtn.addEventListener("click", handleAddTextAction);
          addTextBtn.addEventListener("command", handleAddTextAction);
          event.append(addTextBtn);
          popupSentinelEl = addTextBtn;
          stripPopupRowChrome(addTextBtn.parentElement as HTMLElement | null);
        } catch (err) {
          ztoolkit.log("LLM: failed to append Add Text popup button", err);
        }
      }

      if (selectedText) {
        for (const key of keys) {
          recentReaderSelectionCache.set(key, selectedText);
        }
      } else {
        for (const key of keys) {
          recentReaderSelectionCache.delete(key);
        }
      }

      if (selectedText) {
        try {
          let sentinel = popupSentinelEl;
          if (!sentinel) {
            const fallback = event.doc.createElementNS(
              "http://www.w3.org/1999/xhtml",
              "span",
            ) as HTMLSpanElement;
            fallback.style.display = "none";
            event.append(fallback);
            stripPopupRowChrome(
              fallback.parentElement as HTMLElement | null,
              true,
            );
            sentinel = fallback;
          }

          // Clean up cache when the selection popup is dismissed.
          // MutationObserver proved unreliable in this Gecko context, so use a
          // delayed connectivity check instead.
          const sentinelEl: HTMLSpanElement | null = sentinel;
          const win = sentinelEl?.ownerDocument?.defaultView;
          if (win && sentinelEl) {
            win.setTimeout(() => {
              if (!sentinelEl.isConnected) {
                for (const key of keys) {
                  if (recentReaderSelectionCache.get(key) === selectedText) {
                    recentReaderSelectionCache.delete(key);
                  }
                }
              }
            }, 30_000);
          }
        } catch (_err) {
          ztoolkit.log("LLM: selection popup sentinel failed", _err);
        }
      }
    } else {
      for (const key of keys) {
        recentReaderSelectionCache.delete(key);
      }
    }
  };
  return readerSelectionTrackingHandler;
}

export function registerReaderSelectionTracking() {
  const readerAPI = Zotero.Reader as
    | ReaderSelectionTrackingReader<ReaderTextSelectionPopupHandler>
    | undefined;
  if (!readerAPI || typeof readerAPI.registerEventListener !== "function") {
    return;
  }
  if (
    readerSelectionTrackingLifecycle &&
    readerSelectionTrackingReaderAPI === readerAPI
  ) {
    readerSelectionTrackingLifecycle.ensureRegistered();
    return;
  }

  readerSelectionTrackingLifecycle?.dispose();
  readerSelectionTrackingReaderAPI = readerAPI;
  readerSelectionTrackingLifecycle = createReaderSelectionTrackingLifecycle({
    readerAPI,
    pluginID: config.addonID,
    handler: getReaderSelectionTrackingHandler(),
    timerHost: globalThis,
    intervalDelayMs: __env__ === "test" ? 50 : undefined,
    onError: (error) => {
      ztoolkit.log("LLM: reader selection tracking health check failed", error);
    },
  });
}

export function unregisterReaderSelectionTracking() {
  const readerAPI = Zotero.Reader as
    | ReaderSelectionTrackingReader<ReaderTextSelectionPopupHandler>
    | undefined;
  if (readerSelectionTrackingLifecycle) {
    readerSelectionTrackingLifecycle.dispose();
  } else if (readerAPI) {
    unregisterReaderSelectionTrackingListener(readerAPI, config.addonID);
  }
  readerSelectionTrackingLifecycle = null;
  readerSelectionTrackingReaderAPI = null;
  readerSelectionTrackingHandler = null;
}

type MainWindowWithNoteEditingTracker = _ZoteroTypes.MainWindow & {
  __llmNoteEditingSelectionTracking?: NoteEditingSelectionTrackingLifecycle & {
    lastNoteId: number;
    conversationKeys: Set<number>;
  };
};

const noteEditingSelectionTrackingWindows =
  new Set<MainWindowWithNoteEditingTracker>();

function getNoteEditorDocuments(rootDoc: Document, noteId: number): Document[] {
  const result: Document[] = [];
  for (const editor of Array.from(rootDoc.querySelectorAll("note-editor"))) {
    const noteEditor = editor as Element & { item?: Zotero.Item };
    if (noteEditor.item?.id !== noteId || !noteEditor.getClientRects().length)
      continue;
    const doc = (noteEditor.querySelector("iframe") as HTMLIFrameElement | null)
      ?.contentDocument;
    if (doc) result.push(doc);
  }
  return result;
}

function getActiveNoteItemFromWindow(
  win: _ZoteroTypes.MainWindow,
): Zotero.Item | null {
  try {
    const tabs = (win as unknown as { Zotero?: { Tabs?: any } }).Zotero?.Tabs;
    const selectedId =
      tabs?.selectedID === undefined || tabs?.selectedID === null
        ? ""
        : `${tabs.selectedID}`;
    const activeTab = Array.isArray(tabs?._tabs)
      ? tabs._tabs.find(
          (tab: Record<string, unknown>) => `${tab?.id || ""}` === selectedId,
        )
      : null;
    const data = (activeTab?.data || {}) as Record<string, unknown>;
    const candidateIds = [
      data.itemID,
      data.itemId,
      data.id,
      data.noteID,
      data.noteId,
    ];
    for (const candidateId of candidateIds) {
      const parsed = Number(candidateId);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      const item = Zotero.Items.get(Math.floor(parsed)) || null;
      if ((item as any)?.isNote?.()) {
        return item;
      }
    }
  } catch (_err) {
    void _err;
  }

  try {
    const pane = (
      win as unknown as {
        ZoteroPane?: { getSelectedItems?: () => Zotero.Item[] };
      }
    ).ZoteroPane;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const noteItem = selectedItems.find((item: Zotero.Item) =>
      (item as any)?.isNote?.(),
    );
    return noteItem || null;
  } catch (_err) {
    void _err;
  }

  return null;
}

function refreshPanelsForConversationKey(conversationKey: number): void {
  for (const [activeBody, syncPanelState] of activeContextPanelStateSync) {
    if (!(activeBody as Element).isConnected) {
      activeContextPanels.delete(activeBody);
      activeContextPanelStateSync.delete(activeBody);
      continue;
    }
    const activeRoot = activeBody.querySelector(
      "#llm-main",
    ) as HTMLDivElement | null;
    const activeConversationKey = activeRoot
      ? Number(activeRoot.dataset.itemId || 0)
      : 0;
    if (
      Number.isFinite(activeConversationKey) &&
      activeConversationKey === conversationKey
    ) {
      syncPanelState();
    }
  }
}

export function refreshNoteEditingPanelsForNote(noteId: number): number {
  const normalizedNoteId = Math.floor(Number(noteId || 0));
  if (!Number.isFinite(normalizedNoteId) || normalizedNoteId <= 0) return 0;
  let refreshedPanels = 0;
  for (const [activeBody, syncPanelState] of activeContextPanelStateSync) {
    if (!(activeBody as Element).isConnected) {
      activeContextPanels.delete(activeBody);
      activeContextPanelStateSync.delete(activeBody);
      continue;
    }
    const activeRoot = activeBody.querySelector(
      "#llm-main",
    ) as HTMLDivElement | null;
    const panelNoteId = Number(activeRoot?.dataset.noteId || 0);
    if (
      !Number.isFinite(panelNoteId) ||
      Math.floor(panelNoteId) !== normalizedNoteId
    ) {
      continue;
    }
    const activeConversationKey = Number(activeRoot?.dataset.itemId || 0);
    if (Number.isFinite(activeConversationKey) && activeConversationKey > 0) {
      applySelectedTextPreview(activeBody, Math.floor(activeConversationKey));
    } else {
      syncPanelState();
    }
    refreshedPanels += 1;
  }
  return refreshedPanels;
}

function refreshTrackedNoteEditingSelection(
  win: MainWindowWithNoteEditingTracker,
): void {
  const tracker = win.__llmNoteEditingSelectionTracking;
  if (!tracker) return;
  const noteItem = getActiveNoteItemFromWindow(win);
  const noteId = noteItem?.id || 0;
  const docs = noteId ? getNoteEditorDocuments(win.document, noteId) : [];
  // A temporarily unmounted editor has no new selection state to publish.
  if (noteId && noteId === tracker.lastNoteId && !docs.length) return;
  for (const doc of docs) tracker.trackSelectionDocument(doc);
  const text = docs.map(getEditableSelectionFromDocument).find(Boolean) || "";
  const keys = new Set<number>();
  for (const [body] of activeContextPanelStateSync) {
    if (!body.isConnected) continue;
    const root = body.querySelector("#llm-main") as HTMLElement | null;
    if (Number(root?.dataset.noteId) !== noteId) continue;
    const key = Number(root?.dataset.itemId);
    if (key > 0) keys.add(key);
  }
  if (noteItem && !keys.size) {
    const key = getNoteFocusConversationKey(noteItem);
    if (key) keys.add(key);
  }
  for (const key of tracker.conversationKeys) {
    if (keys.has(key) && tracker.lastNoteId === noteId) continue;
    if (clearNoteEditingSelectedText(key)?.changed)
      refreshPanelsForConversationKey(key);
  }
  for (const key of keys) {
    const synced = syncNoteEditingSelectedText({
      noteItem,
      text,
      conversationKey: key,
    });
    if (synced?.changed) refreshPanelsForConversationKey(key);
  }
  tracker.lastNoteId = noteId;
  tracker.conversationKeys = keys;
}

export function registerNoteEditingSelectionTracking(
  win: _ZoteroTypes.MainWindow,
) {
  const trackedWindow = win as MainWindowWithNoteEditingTracker;
  if (trackedWindow.__llmNoteEditingSelectionTracking) return;
  const refresh = () => {
    refreshTrackedNoteEditingSelection(trackedWindow);
  };
  const handleUnload = () => {
    unregisterNoteEditingSelectionTracking(trackedWindow);
  };
  const lifecycle = createNoteEditingSelectionTrackingLifecycle({
    timerHost: win,
    refresh,
    onDispose: () => {
      win.removeEventListener("unload", handleUnload);
      noteEditingSelectionTrackingWindows.delete(trackedWindow);
      if (
        trackedWindow.__llmNoteEditingSelectionTracking?.dispose ===
        lifecycle.dispose
      ) {
        delete trackedWindow.__llmNoteEditingSelectionTracking;
      }
    },
  });
  trackedWindow.__llmNoteEditingSelectionTracking = {
    ...lifecycle,
    lastNoteId: 0,
    conversationKeys: new Set(),
  };
  noteEditingSelectionTrackingWindows.add(trackedWindow);
  lifecycle.trackSelectionDocument(win.document);
  win.addEventListener("unload", handleUnload, { once: true });
  refresh();
}

export function unregisterNoteEditingSelectionTracking(win: Window): void {
  const trackedWindow = win as MainWindowWithNoteEditingTracker;
  trackedWindow.__llmNoteEditingSelectionTracking?.dispose();
}

export function unregisterAllNoteEditingSelectionTracking(): void {
  for (const win of [...noteEditingSelectionTrackingWindows]) {
    unregisterNoteEditingSelectionTracking(win);
  }
}

export function clearConversation(itemId: number) {
  chatHistory.set(itemId, []);
  loadedConversationKeys.add(itemId);
  void clearStoredConversation(itemId).catch((err) => {
    ztoolkit.log("LLM: Failed to clear persisted chat history", err);
  });
  void clearOwnerAttachmentRefs("conversation", itemId).catch((err) => {
    ztoolkit.log(
      "LLM: Failed to clear persisted conversation attachment refs",
      err,
    );
  });
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log("LLM: Failed to collect unreferenced attachment blobs", err);
    },
  );
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
