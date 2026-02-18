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
  chatHistory,
  loadedConversationKeys,
  readerContextPanelRegistered,
  setReaderContextPanelRegistered,
  recentReaderSelectionCache,
  selectedTextCache,
  selectedTextPreviewExpandedCache,
} from "./state";
import { clearConversation as clearStoredConversation } from "../../utils/chatStore";
import { normalizeSelectedText, setStatus } from "./textUtils";
import { buildUI } from "./buildUI";
import { setupHandlers } from "./setupHandlers";
import {
  ensureConversationLoaded,
  persistChatScrollSnapshotFromBody,
} from "./chat";
import { renderShortcuts } from "./shortcuts";
import { refreshChat } from "./chat";
import {
  getActiveContextAttachmentFromTabs,
  getItemSelectionCacheKeys,
  applySelectedTextPreview,
} from "./contextResolution";
import { ensurePDFTextCached } from "./pdfContext";

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
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader" || tabType === "library");
      return true;
    },
    onRender: ({ body, item }) => {
      // Preserve existing chat scroll before the panel DOM is rebuilt.
      persistChatScrollSnapshotFromBody(body);
      buildUI(body, item);
    },
    onAsyncRender: async ({ body, item }) => {
      if (item) {
        await ensureConversationLoaded(item);
      }
      await renderShortcuts(body, item);
      setupHandlers(body, item);
      refreshChat(body, item);
      // Defer PDF extraction so the panel becomes interactive sooner.
      const activeContextItem = getActiveContextAttachmentFromTabs();
      if (activeContextItem) {
        void ensurePDFTextCached(activeContextItem);
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
    const selectedText = normalizeSelectedText(
      event.params?.annotation?.text || "",
    );
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

    if (selectedText) {
      let popupSentinelEl: HTMLElement | null = null;
      const addTextToPanel = () => {
        for (const key of keys) {
          selectedTextCache.set(key, selectedText);
          selectedTextPreviewExpandedCache.set(key, false);
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

          const panelRoots: HTMLDivElement[] = [];
          const seenRoots = new Set<Element>();
          for (const doc of docs) {
            const roots = Array.from(
              doc.querySelectorAll("#llm-main"),
            ) as HTMLDivElement[];
            for (const root of roots) {
              if (seenRoots.has(root)) continue;
              seenRoots.add(root);
              panelRoots.push(root);
            }
          }
          if (!panelRoots.length) return;

          const getPanelItemId = (root: HTMLDivElement): number | null => {
            const parsed = Number(root.dataset.itemId || 0);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
          };
          const isVisible = (root: HTMLElement) =>
            root.getClientRects().length > 0;
          const popupTopDoc = event.doc.defaultView?.top?.document || null;
          const rootStates = panelRoots
            .map((root) => ({
              root,
              panelItemId: getPanelItemId(root),
              keyed: false,
              visible: isVisible(root),
              sameDoc: popupTopDoc ? root.ownerDocument === popupTopDoc : false,
            }))
            .filter((state) => state.panelItemId !== null);
          if (!rootStates.length) return;
          for (const state of rootStates) {
            state.keyed = keys.includes(state.panelItemId as number);
          }

          // Deterministic single-target ranking:
          // 1) keyed + visible, 2) keyed, 3) same popup top-doc + visible,
          // 4) visible, 5) any remaining.
          const scoreState = (state: (typeof rootStates)[number]) => {
            if (state.keyed && state.visible) return 5;
            if (state.keyed) return 4;
            if (state.sameDoc && state.visible) return 3;
            if (state.visible) return 2;
            return 1;
          };
          let bestState = rootStates[0];
          let bestScore = scoreState(bestState);
          for (const state of rootStates.slice(1)) {
            const score = scoreState(state);
            if (score > bestScore) {
              bestState = state;
              bestScore = score;
            }
          }

          const panelRoot = bestState.root;
          const panelItemId = bestState.panelItemId as number;

          selectedTextCache.set(panelItemId, selectedText);
          selectedTextPreviewExpandedCache.set(panelItemId, false);

          const panelBody = panelRoot.parentElement || panelRoot;
          applySelectedTextPreview(panelBody, panelItemId);

          const status = panelBody.querySelector(
            "#llm-status",
          ) as HTMLElement | null;
          if (status) setStatus(status, "Selected text included", "ready");

          const inputEl = panelBody.querySelector(
            "#llm-input",
          ) as HTMLTextAreaElement | null;
          inputEl?.focus({ preventScroll: true });
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
          addTextBtn.addEventListener("click", (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            addTextToPanel();
          });
          event.append(addTextBtn);
          popupSentinelEl = addTextBtn;
          stripPopupRowChrome(addTextBtn.parentElement as HTMLElement | null);
        } catch (err) {
          ztoolkit.log("LLM: failed to append Add Text popup button", err);
        }
      }

      for (const key of keys) {
        recentReaderSelectionCache.set(key, selectedText);
      }

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

        let wasConnected = false;
        let checks = 0;
        const maxChecks = 600;

        const watchSentinel = () => {
          if (++checks > maxChecks) return;
          if (sentinel.isConnected) {
            wasConnected = true;
            setTimeout(watchSentinel, 500);
            return;
          }
          if (!wasConnected && checks <= 6) {
            setTimeout(watchSentinel, 200);
            return;
          }
          if (wasConnected) {
            for (const key of keys) {
              if (recentReaderSelectionCache.get(key) === selectedText) {
                recentReaderSelectionCache.delete(key);
              }
            }
          }
        };
        setTimeout(watchSentinel, 100);
      } catch (_err) {
        ztoolkit.log("LLM: selection popup sentinel failed", _err);
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

export function clearConversation(itemId: number) {
  chatHistory.delete(itemId);
  loadedConversationKeys.add(itemId);
  void clearStoredConversation(itemId).catch((err) => {
    ztoolkit.log("LLM: Failed to clear persisted chat history", err);
  });
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
