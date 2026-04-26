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
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
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
import { buildUI, syncGlobalLockVisibility } from "./buildUI";
import { setupHandlers } from "./setupHandlers";
import { ensureConversationLoaded, getConversationKey } from "./chat";
import { renderShortcuts } from "./shortcuts";
import { refreshChat } from "./chat";
import {
  getActiveContextAttachmentFromTabs,
  getActiveReaderForSelectedTab,
  getItemSelectionCacheKeys,
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  syncSelectedTextContextForSource,
} from "./contextResolution";
import { ensurePDFTextCached, ensureNoteTextCached } from "./pdfContext";
import { resolveCurrentSelectionPageLocationFromReader } from "./livePdfSelectionLocator";
import {
  getFirstSelectionFromReader,
  getSelectionFromDocument,
} from "./readerSelection";
import { resolveReaderPopupPaperContext } from "./readerPopup";
import {
  resolveInitialPanelItemState,
  resolveActiveLibraryID,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
} from "./portalScope";
import { getLockedGlobalConversationKey } from "./prefHelpers";
import { getEditableSelectionFromDocument } from "./noteSelection";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
} from "../../claudeCode/state";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import {
  ensurePanelDebugHarnessStarted,
  unregisterPanelDebugHarness,
} from "./debugHarness";

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

export function registerReaderContextPanel() {
  if (readerContextPanelRegistered) return;
  setReaderContextPanelRegistered(true);
  ensurePanelDebugHarnessStarted();
  // Generation counter: incremented on every onAsyncRender call so stale
  // (superseded) renders can bail out at each await point.
  let renderGeneration = 0;
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
    },
    onInit: ({ setEnabled, tabType }) => {
      setEnabled(true);
      ztoolkit.log(`LLM: panel init tabType=${tabType}`);
    },
    onItemChange: ({ setEnabled, tabType, item }) => {
      setEnabled(true);
      if (isStandaloneWindowActive()) {
        notifyStandaloneItemChanged(item || null);
        return true;
      }
      ztoolkit.log(`LLM: panel itemChange tabType=${tabType}`);
      // Refresh the cached tab ID (side effect of getActiveReaderForSelectedTab)
      getActiveReaderForSelectedTab();
      return true;
    },
    onRender: ({ body, item }) => {
      // When standalone window is open, show placeholder instead of full UI
      if (isStandaloneWindowActive()) {
        void releaseClaudeRuntimeForBody(body);
        renderStandalonePlaceholder(body);
        const resolvedState = resolveInitialPanelItemState(item);
        activeContextPanels.set(body, () => resolvedState.item);
        activeContextPanelRawItems.set(body, item || null);
        (body as any).__llmSyncRendered = true;
        return;
      }
      syncGlobalLockVisibility(body);
      try {
        const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
        // Treat missing panel root as needing a full render — the body may
        // belong to a tab that onAsyncRender never fired for.
        const needsFullRender = !activeContextPanels.has(body) || !panelRoot;

        const resolvedState = resolveInitialPanelItemState(item);
        const expectedSystem =
          resolveConversationSystemForItem(resolvedState.item) || "upstream";

        // Also check if a global lock requires switching to open chat
        const libraryID = resolveActiveLibraryID() ||
          (resolvedState.item ? Number(resolvedState.item.libraryID || 0) : 0) ||
          (item ? Number(item.libraryID || 0) : 0);
        const lockedKey =
          expectedSystem === "claude_code"
            ? null
            : libraryID > 0
              ? getLockedGlobalConversationKey(libraryID)
              : null;
        const currentKind = panelRoot?.dataset?.conversationKind;
        const currentItemKey = panelRoot?.dataset?.itemId;
        const currentSystem = panelRoot?.dataset?.conversationSystem || "";
        // Lock is stale if:
        // - lock active + panel in paper mode (need to switch to global)
        // - lock active + panel shows different global conversation
        // - lock cleared + panel still in global mode (need to switch back to paper)
        const lockStale =
          (lockedKey !== null && (
            currentKind === "paper" ||
            (currentItemKey !== undefined && currentItemKey !== String(lockedKey))
          )) ||
          (lockedKey === null && currentKind === "global" && !needsFullRender);

        // Detect if the active item has changed (e.g. user switched reader tabs).
        // If so, the panel must fully re-render to switch conversations.
        const storedItemKey = panelRoot?.dataset?.itemId;
        const newItemKey = resolvedState.item
          ? String(getConversationKey(resolvedState.item))
          : "0";
        const itemChanged =
          !needsFullRender &&
          storedItemKey !== undefined &&
          storedItemKey !== newItemKey;
        const systemChanged =
          !needsFullRender &&
          currentSystem !== expectedSystem;

        if (needsFullRender || lockStale || itemChanged || systemChanged) {
          // Build UI synchronously so panel data attributes (basePaperItemId,
          // conversationKind, etc.) are immediately correct.  The reader popup
          // "Add Text" path reads these attributes to decide paper-mismatch —
          // if we defer buildUI, the stale panel from the previous tab wins.
          buildUI(body, resolvedState.item);
          activeContextPanels.set(body, () => resolvedState.item);
          activeContextPanelRawItems.set(body, item || null);
          void retainClaudeRuntimeForBody(body, resolvedState.item);
          // Attach handlers synchronously so buttons (lock, send, etc.) are
          // immediately interactive — don't gate on ensureConversationLoaded.
          setupHandlers(body, item);
          // Flag: onAsyncRender can skip the duplicate buildUI + setupHandlers.
          (body as any).__llmSyncRendered = true;
          // Defer conversation loading and chat rendering
          void (async () => {
            try {
              if (resolvedState.item) await ensureConversationLoaded(resolvedState.item);
              if (isStandaloneWindowActive()) return;
              refreshChat(body, resolvedState.item);
            } catch (err) {
              ztoolkit.log("LLM: onRender async setup failed", err);
            }
          })();
        } else {
          // Same item — keep item reference current so delegated handlers
          // (e.g. Add Text) always resolve the active item.
          activeContextPanels.set(body, () => resolvedState.item);
          activeContextPanelRawItems.set(body, item || null);
          void retainClaudeRuntimeForBody(body, resolvedState.item);
        }
      } catch { /* ignore */ }
    },
    onAsyncRender: async ({ body, item, setEnabled, tabType }) => {
      setEnabled(true);
      // Skip full render when standalone window is active
      if (isStandaloneWindowActive()) return;
      const thisGeneration = ++renderGeneration;
      ztoolkit.log(
        `LLM: panel asyncRender tabType=${tabType} hasItem=${Boolean(item)} gen=${thisGeneration}`,
      );

      const resolvedInitialState = resolveInitialPanelItemState(item);
      const resolvedItem = resolvedInitialState.item;

      // If onRender already did the synchronous buildUI + setupHandlers for
      // this render cycle, skip the duplicate work.  We still run the
      // async-only steps: ensureConversationLoaded (properly awaited),
      // renderShortcuts, refreshChat (after data ready), and content caching.
      const syncAlreadyRendered = (body as any).__llmSyncRendered === true;
      if (syncAlreadyRendered) {
        delete (body as any).__llmSyncRendered;
      } else {
        buildUI(body, resolvedItem);
        activeContextPanelRawItems.set(body, item || null);
      }

      if (resolvedItem) {
        await ensureConversationLoaded(resolvedItem);
      }
      // Bail if a newer render has started while we were awaiting,
      // or if the standalone window was opened during the await.
      if (renderGeneration !== thisGeneration) return;
      if (isStandaloneWindowActive()) return;
      const shortcutMode = resolveDisplayConversationKind(resolvedItem) === "global" ? "library" : "paper";
      await renderShortcuts(body, resolvedItem, shortcutMode);
      if (renderGeneration !== thisGeneration) return;
      if (isStandaloneWindowActive()) return;
      if (!syncAlreadyRendered) {
        setupHandlers(body, item);
      }
      refreshChat(body, resolvedItem);
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

export function registerReaderSelectionTracking() {
  const readerAPI = Zotero.Reader as _ZoteroTypes.Reader & {
    __llmSelectionTrackingRegistered?: boolean;
  };
  if (!readerAPI || readerAPI.__llmSelectionTrackingRegistered) return;

  const handler: _ZoteroTypes.Reader.EventHandler<
    "renderTextSelectionPopup"
  > = (event) => {
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
      const addTextToPanel = async () => {
        const effectiveSelectedText =
          normalizeSelectedText(selectedText) ||
          resolveSelectedTextForPopupAction();
        if (!effectiveSelectedText) {
          ztoolkit.log("LLM: Add Text popup action skipped (no selection)");
          return;
        }
        try {
          const panelRecords: Array<{
            body: Element;
            root: HTMLDivElement;
          }> = [];
          const seenRoots = new Set<Element>();
          const pushPanelRecord = (
            body: Element | null | undefined,
            root: HTMLDivElement | null | undefined,
          ) => {
            if (!body || !root || seenRoots.has(root)) return;
            seenRoots.add(root);
            panelRecords.push({ body, root });
          };
          for (const [panelBody] of activeContextPanels.entries()) {
            if (!(panelBody as Element).isConnected) {
              void releaseClaudeRuntimeForBody(panelBody as Element);
              unregisterPanelDebugHarness(panelBody as Element);
              activeContextPanels.delete(panelBody);
              activeContextPanelRawItems.delete(panelBody);
              activeContextPanelStateSync.delete(panelBody);
              continue;
            }
            const root = panelBody.querySelector(
              "#llm-main",
            ) as HTMLDivElement | null;
            pushPanelRecord(panelBody, root);
          }
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

          if (!panelRecords.length) {
            for (const doc of docs) {
              const roots = Array.from(
                doc.querySelectorAll("#llm-main"),
              ) as HTMLDivElement[];
              for (const root of roots) {
                const panelBody = root.parentElement || root;
                pushPanelRecord(panelBody, root);
              }
            }
          }
          if (!panelRecords.length) return;

          const readerLibraryID = Number(item?.libraryID || 0);
          const normalizedReaderLibraryID =
            Number.isFinite(readerLibraryID) && readerLibraryID > 0
              ? Math.floor(readerLibraryID)
              : 0;
          const readerPaperContext = resolveReaderPopupPaperContext(
            item,
            getActiveContextAttachmentFromTabs(),
          );
          const readerPaperItemID =
            readerPaperContext && Number.isFinite(readerPaperContext.itemId)
              ? Math.floor(readerPaperContext.itemId)
              : 0;
          const getPanelItemId = (root: HTMLDivElement): number | null => {
            const parsed = Number(root.dataset.itemId || 0);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
          };
          const getPanelLibraryId = (root: HTMLDivElement): number | null => {
            const parsed = Number(root.dataset.libraryId || 0);
            return Number.isFinite(parsed) && parsed > 0
              ? Math.floor(parsed)
              : null;
          };
          const getPanelConversationKind = (
            root: HTMLDivElement,
          ): "global" | "paper" | null => {
            const raw = `${root.dataset.conversationKind || ""}`
              .trim()
              .toLowerCase();
            if (raw === "global") return "global";
            if (raw === "paper") return "paper";
            return null;
          };
          const getPanelBasePaperItemID = (
            root: HTMLDivElement,
          ): number | null => {
            const parsed = Number(root.dataset.basePaperItemId || 0);
            return Number.isFinite(parsed) && parsed > 0
              ? Math.floor(parsed)
              : null;
          };
          const getPanelConversationSystem = (
            root: HTMLDivElement,
          ): "upstream" | "claude_code" | null => {
            const raw = `${root.dataset.conversationSystem || ""}`
              .trim()
              .toLowerCase();
            if (raw === "upstream") return "upstream";
            if (raw === "claude_code") return "claude_code";
            return null;
          };
          const isVisible = (root: HTMLElement) =>
            root.getClientRects().length > 0;
          const popupTopDoc = event.doc.defaultView?.top?.document || null;
          const rootStates = panelRecords
            .map(({ body, root }) => {
              const ownerDoc = body.ownerDocument;
              const panelItemId = getPanelItemId(root);
              const panelLibraryId = getPanelLibraryId(root);
              const conversationKind = getPanelConversationKind(root);
              const conversationSystem = getPanelConversationSystem(root);
              const conversationKey = panelItemId;
              const basePaperItemID = getPanelBasePaperItemID(root);
              const panelModeLock =
                panelLibraryId && conversationSystem === "claude_code"
                  ? activeClaudeConversationModeByLibrary.get(panelLibraryId)
                  : panelLibraryId && conversationSystem === "upstream"
                    ? activeConversationModeByLibrary.get(panelLibraryId)
                    : null;
              const panelGlobalConversationKey =
                panelModeLock === "global" && panelLibraryId
                  ? Math.floor(
                      Number(
                        (conversationSystem === "claude_code"
                          ? activeClaudeGlobalConversationByLibrary.get(panelLibraryId)
                          : activeGlobalConversationByLibrary.get(panelLibraryId)) || 0,
                      ),
                    )
                  : 0;
              const sameConversationMode =
                panelModeLock === "global"
                  ? conversationKind === "global"
                  : panelModeLock === "paper"
                    ? conversationKind === "paper"
                    : false;
              return {
                body,
                root,
                panelItemId,
                panelLibraryId,
                conversationKind,
                conversationSystem,
                basePaperItemID,
                conversationKey,
                visible: isVisible(root),
                sameDoc: popupTopDoc ? ownerDoc === popupTopDoc : false,
                sameLibrary:
                  normalizedReaderLibraryID > 0 &&
                  panelLibraryId === normalizedReaderLibraryID,
                matchesReaderPaper:
                  readerPaperItemID > 0 &&
                  basePaperItemID !== null &&
                  basePaperItemID === readerPaperItemID,
                matchesLockedGlobal:
                  panelGlobalConversationKey > 0 &&
                  conversationKey === panelGlobalConversationKey,
                sameConversationMode,
                hasActiveFocus: Boolean(
                  ownerDoc?.activeElement &&
                  root.contains(ownerDoc.activeElement),
                ),
              };
            })
            .filter(
              (state) =>
                state.panelItemId !== null &&
                state.conversationKey !== null &&
                state.conversationKind !== null &&
                state.conversationSystem !== null,
            );
          if (!rootStates.length) return;
          const sameLibraryStates =
            normalizedReaderLibraryID > 0
              ? rootStates.filter((state) => state.sameLibrary)
              : [];
          const rankedStates = sameLibraryStates.length
            ? sameLibraryStates
            : rootStates;

          // Deterministic status/focus target ranking:
          // 1) same doc + visible + focused panel
          // 2) visible + focused panel
          // 3) same doc + visible + matching global lock
          // 4) same doc + visible + matching reader paper
          // 5) same doc + visible
          // 6) visible + matching global lock
          // 7) visible + matching reader paper
          // 8) visible
          // 9) same doc
          // 10) focused panel
          const scoreState = (state: (typeof rankedStates)[number]) => {
            if (state.sameDoc && state.visible && state.hasActiveFocus)
              return 8;
            if (state.visible && state.hasActiveFocus) return 7;
            if (state.sameDoc && state.visible && state.matchesLockedGlobal)
              return 6.5;
            if (state.sameDoc && state.visible && state.matchesReaderPaper)
              return 6;
            if (state.visible && state.sameConversationMode) return 5.5;
            if (state.sameDoc && state.visible) return 5;
            if (state.visible && state.matchesLockedGlobal) return 4.5;
            if (state.visible && state.matchesReaderPaper) return 4;
            if (state.visible) return 3;
            if (state.matchesReaderPaper) return 2.5;
            if (state.sameDoc) return 2;
            if (state.matchesLockedGlobal) return 1.5;
            if (state.hasActiveFocus) return 1;
            return 0;
          };
          let bestState = rankedStates[0];
          let bestScore = scoreState(bestState);
          for (const state of rankedStates.slice(1)) {
            const score = scoreState(state);
            if (score > bestScore) {
              bestState = state;
              bestScore = score;
            }
          }

          const panelBody = bestState.body;

          // Derive conversation key directly from the reader's paper —
          // no dependency on panel scoring or stale panel data attributes.
          const isGlobalConversation = bestState.conversationKind === "global";
          let conversationKey: number;
          let selectedPaperContext: typeof readerPaperContext | null;
          if (isGlobalConversation) {
            // Global mode: use the panel's global conversation key
            conversationKey = bestState.conversationKey as number;
            selectedPaperContext = readerPaperContext;
          } else {
            // Paper mode: resolve the conversation key from the reader's
            // paper item via resolveInitialPanelItemState + getConversationKey.
            // This correctly handles portal keys (multi-conversation papers).
            const readerItem = readerPaperItemID > 0
              ? Zotero.Items.get(readerPaperItemID) || null
              : null;
            if (readerItem) {
              const resolved = resolveInitialPanelItemState(readerItem, {
                conversationSystem: bestState.conversationSystem,
              });
              conversationKey = resolved.item
                ? getConversationKey(resolved.item)
                : readerPaperItemID;
            } else {
              conversationKey = bestState.conversationKey as number;
            }
            selectedPaperContext = null;
          }

          const selectedTextLocation =
            await resolveCurrentSelectionPageLocationFromReader(
              event.reader as any,
              effectiveSelectedText,
            );
          const added = appendSelectedTextContextForItem(
            conversationKey,
            effectiveSelectedText,
            "pdf",
            selectedPaperContext,
            selectedTextLocation,
          );

          // Refresh any panel whose conversation key matches
          let refreshedPanels = 0;
          for (const [
            activeBody,
            syncPanelState,
          ] of activeContextPanelStateSync) {
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
              !Number.isFinite(activeConversationKey) ||
              activeConversationKey !== conversationKey
            ) {
              continue;
            }
            syncPanelState();
            refreshedPanels += 1;
          }
          if (!refreshedPanels) {
            // Search all registered panel bodies for a matching conversation
            for (const [activeBody] of activeContextPanels) {
              if (!(activeBody as Element).isConnected) continue;
              const activeRoot = (activeBody as Element).querySelector(
                "#llm-main",
              ) as HTMLDivElement | null;
              if (Number(activeRoot?.dataset?.itemId || 0) === conversationKey) {
                applySelectedTextPreview(activeBody as Element, conversationKey);
                refreshedPanels += 1;
                break;
              }
            }
          }
          const status = panelBody.querySelector(
            "#llm-status",
          ) as HTMLElement | null;
          if (status) {
            setStatus(
              status,
              added ? "Selected text included" : "Text Context up to 5",
              added ? "ready" : "error",
            );
          }
          if (added) {
            const inputEl = panelBody.querySelector(
              "#llm-input",
            ) as HTMLTextAreaElement | null;
            inputEl?.focus({ preventScroll: true });
          }
        } catch (err) {
          ztoolkit.log("LLM: Add Text popup action failed", err);
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
          const handleAddTextAction = (e: Event) => {
            if (addTextHandled) return;
            addTextHandled = true;
            e.preventDefault();
            e.stopPropagation();
            void addTextToPanel();
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

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    handler,
    config.addonID,
  );
  readerAPI.__llmSelectionTrackingRegistered = true;
}

type MainWindowWithNoteEditingTracker = _ZoteroTypes.MainWindow & {
  __llmNoteEditingSelectionTracking?: {
    intervalId: number;
    refresh: () => void;
    lastNoteId: number;
    lastParentPaperItemId: number;
    lastSelectionText: string;
  };
};

function collectAccessibleDocuments(
  rootDoc: Document,
  docs: Document[] = [],
  seen: Set<Document> = new Set<Document>(),
  depth = 0,
): Document[] {
  if (!rootDoc || seen.has(rootDoc) || depth > 3) {
    return docs;
  }
  seen.add(rootDoc);
  docs.push(rootDoc);
  const frames = Array.from(rootDoc.querySelectorAll("iframe"));
  for (const frame of frames) {
    try {
      const frameDoc = (frame as HTMLIFrameElement).contentDocument;
      if (frameDoc) {
        collectAccessibleDocuments(frameDoc, docs, seen, depth + 1);
      }
    } catch (_err) {
      void _err;
    }
  }
  return docs;
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
      ? tabs._tabs.find((tab: Record<string, unknown>) => `${tab?.id || ""}` === selectedId)
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
    const pane = (win as unknown as {
      ZoteroPane?: { getSelectedItems?: () => Zotero.Item[] };
    }).ZoteroPane;
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

function refreshTrackedNoteEditingSelection(
  win: MainWindowWithNoteEditingTracker,
): void {
  const tracker = win.__llmNoteEditingSelectionTracking;
  if (!tracker) return;

  // If focus is inside the plugin's own UI (e.g. the input box), the note
  // editing selection hasn't changed — preserve the current tracking state.
  // Without this guard, the note editor iframe transiently loses hasFocus()
  // and the "Editing..." chip disappears.
  try {
    const activeEl = win.document.activeElement;
    if (
      activeEl &&
      (activeEl.id === "llm-main" || activeEl.closest?.("#llm-main"))
    ) {
      return;
    }
  } catch {
    // Ignore — proceed with normal refresh
  }

  // Fast path: skip expensive iframe traversal when no note tab is active.
  // getActiveNoteItemFromWindow traverses Zotero tabs and items; only proceed
  // to the heavier collectAccessibleDocuments when a note is actually open.
  const noteItem = getActiveNoteItemFromWindow(win);
  const nextNoteId =
    noteItem && Number.isFinite(noteItem.id) && noteItem.id > 0
      ? Math.floor(noteItem.id)
      : 0;
  const nextParentPaperItemId: number = (() => {
    if (!noteItem) return 0;
    try {
      const parentId = Number((noteItem as any).parentItemID ?? 0);
      return Number.isFinite(parentId) && parentId > 0 ? Math.floor(parentId) : 0;
    } catch { return 0; }
  })();

  if (nextNoteId === 0 && tracker.lastNoteId === 0) {
    // No note was active before and none is active now — nothing to do.
    return;
  }

  // When focus moves to another window (e.g. the standalone chat window),
  // the note-editor iframe loses hasFocus() and getEditableSelectionFromDocument
  // returns "". Guard against this: if the main window has lost focus but the
  // same note is still active and we already had a selection, keep it so the
  // "Editing" chip stays visible while the user types in the standalone input.
  try {
    if (
      tracker.lastSelectionText &&
      tracker.lastNoteId === nextNoteId &&
      typeof win.document.hasFocus === "function" &&
      !win.document.hasFocus()
    ) {
      return;
    }
  } catch { /* ignore */ }

  const nextSelectionText = noteItem
    ? collectAccessibleDocuments(win.document).reduce((found, doc) => {
        if (found) return found;
        // Skip documents from background tab editors: only the focused
        // editor's selection matters.  Without this, switching from Note A
        // (with selected text) to Note B leaks Note A's selection because
        // collectAccessibleDocuments traverses ALL iframes, including
        // hidden-tab editors that still hold stale selections.
        if (doc !== win.document && typeof doc.hasFocus === "function") {
          if (!doc.hasFocus()) return found;
        }
        return getEditableSelectionFromDocument(doc);
      }, "")
    : "";

  if (
    tracker.lastNoteId === nextNoteId &&
    tracker.lastSelectionText === nextSelectionText
  ) {
    return;
  }

  if (
    tracker.lastNoteId > 0 &&
    (tracker.lastNoteId !== nextNoteId || !nextSelectionText)
  ) {
    if (
      syncSelectedTextContextForSource(
        tracker.lastNoteId,
        "",
        "note-edit",
      )
    ) {
      refreshPanelsForConversationKey(tracker.lastNoteId);
    }
    // Also clear from the parent paper panel (used by standalone window).
    if (tracker.lastParentPaperItemId > 0) {
      if (syncSelectedTextContextForSource(tracker.lastParentPaperItemId, "", "note-edit")) {
        refreshPanelsForConversationKey(tracker.lastParentPaperItemId);
      }
    }
  }

  if (nextNoteId > 0 && nextSelectionText) {
    if (
      syncSelectedTextContextForSource(
        nextNoteId,
        nextSelectionText,
        "note-edit",
      )
    ) {
      refreshPanelsForConversationKey(nextNoteId);
    }
    // Also sync to the parent paper panel so the standalone window (which is
    // keyed to the parent paper item, not the note) shows the editing chip.
    if (nextParentPaperItemId > 0) {
      if (syncSelectedTextContextForSource(nextParentPaperItemId, nextSelectionText, "note-edit")) {
        refreshPanelsForConversationKey(nextParentPaperItemId);
      }
    }
  }

  tracker.lastNoteId = nextNoteId;
  tracker.lastParentPaperItemId = nextParentPaperItemId;
  tracker.lastSelectionText = nextSelectionText;
}

export function registerNoteEditingSelectionTracking(
  win: _ZoteroTypes.MainWindow,
) {
  const trackedWindow = win as MainWindowWithNoteEditingTracker;
  if (trackedWindow.__llmNoteEditingSelectionTracking) return;
  const refresh = () => {
    refreshTrackedNoteEditingSelection(trackedWindow);
  };
  // Debounced version for event-driven calls (selectionchange, mouseup,
  // keyup) — prevents the expensive iframe traversal from firing dozens
  // of times per second during rapid typing or drag-selecting.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedRefresh = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 150);
  };
  // Interval reduced from 250ms → 1000ms.  The event listeners handle
  // real-time changes; this interval is only a fallback safety net.
  const intervalId = win.setInterval(refresh, 1000);
  trackedWindow.__llmNoteEditingSelectionTracking = {
    intervalId,
    refresh,
    lastNoteId: 0,
    lastParentPaperItemId: 0,
    lastSelectionText: "",
  };
  win.document.addEventListener("selectionchange", debouncedRefresh, true);
  win.document.addEventListener("mouseup", debouncedRefresh, true);
  win.document.addEventListener("keyup", debouncedRefresh, true);
  win.addEventListener(
    "unload",
    () => {
      const tracker = trackedWindow.__llmNoteEditingSelectionTracking;
      if (!tracker) return;
      win.clearInterval(tracker.intervalId);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      win.document.removeEventListener("selectionchange", debouncedRefresh, true);
      win.document.removeEventListener("mouseup", debouncedRefresh, true);
      win.document.removeEventListener("keyup", debouncedRefresh, true);
      delete trackedWindow.__llmNoteEditingSelectionTracking;
    },
    { once: true },
  );
  refresh();
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
