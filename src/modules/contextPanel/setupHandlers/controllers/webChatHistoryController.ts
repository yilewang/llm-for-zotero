import { createElement } from "../../../../utils/domHelpers";
import type { Message } from "../../types";

type WebChatHistorySession = {
  id: string;
  title: string;
  chatUrl: string | null;
};

type WebChatHistoryControllerDeps = {
  body: Element;
  historyMenu: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getSelectedModelInfo: () => { currentModel: string };
  closeHistoryMenu: () => void;
  getConversationKey: (item: Zotero.Item) => number;
  setConversationHistory: (
    conversationKey: number,
    messages: Message[],
  ) => void;
  refreshChatPreservingScroll: () => void;
  isWebChatMode: () => boolean;
  resetWebChatPdfUploadedForCurrentConversation: () => void;
  clearNextWebChatNewChatIntent: () => void;
  setSelectedReasoningLevel: (itemId: number, level: "high" | "none") => void;
  setSelectedReasoningProvider: (
    itemId: number,
    provider: "unsupported",
  ) => void;
  updateReasoningButton: () => void;
  setStatusMessage?: (
    message: string,
    level: "ready" | "sending" | "error",
  ) => void;
  log: (message: string, ...args: unknown[]) => void;
};

export function createWebChatHistoryController(
  deps: WebChatHistoryControllerDeps,
): {
  warmUpWebChatHistory: () => Promise<void>;
  renderWebChatHistoryMenu: () => Promise<void>;
} {
  let historyWarmUpRunning = false;

  const warmUpWebChatHistory = async () => {
    if (historyWarmUpRunning) return;
    historyWarmUpRunning = true;
    try {
      const { getWebChatTargetByModelName } =
        await import("../../../../webchat/types");
      const { currentModel: warmupModel } = deps.getSelectedModelInfo();
      const warmupTargetEntry = getWebChatTargetByModelName(warmupModel || "");
      const targetHostname = warmupTargetEntry?.modelName || null;
      const requestedAt = Date.now();

      const { relaySetCommand } =
        await import("../../../../webchat/relayServer");
      relaySetCommand({ type: "SCRAPE_HISTORY" });

      const {
        filterWebChatHistorySessionsForHostname,
        getWebChatHistorySiteSyncEntry,
        isWebChatHistorySiteFailure,
        waitForFreshChatHistorySnapshot,
      } = await import("../../../../webchat/client");
      const snapshot = await waitForFreshChatHistorySnapshot(
        "",
        targetHostname,
        requestedAt,
        25_000,
      );
      const sessions = filterWebChatHistorySessionsForHostname(
        snapshot.sessions,
        targetHostname,
      );
      const siteSyncEntry = getWebChatHistorySiteSyncEntry(
        snapshot,
        targetHostname,
      );
      if (sessions.length > 0) {
        deps.log(
          `[webchat] History warmed up: ${sessions.length} conversations`,
        );
      } else if (isWebChatHistorySiteFailure(siteSyncEntry)) {
        deps.log(
          `[webchat] History warm-up failed for ${targetHostname || "active site"}: ${siteSyncEntry?.status}`,
        );
      }
    } catch {
      // Ignore history warm-up failures; opening the menu triggers a fresh fetch.
    }
    historyWarmUpRunning = false;
  };

  const renderHistorySessions = async (
    doc: Document,
    container: HTMLElement,
    sessions: WebChatHistorySession[],
    host: string,
  ) => {
    const viewport = createElement(
      doc,
      "div",
      "llm-history-menu-section-viewport",
      {},
    );
    viewport.style.maxHeight = "300px";
    viewport.style.overflowY = "auto";

    const rows = createElement(doc, "div", "llm-history-menu-section-rows", {});

    for (const session of sessions) {
      const row = createElement(doc, "div", "llm-history-menu-row", {});
      const btn = createElement(doc, "button", "llm-history-menu-row-main", {
        type: "button",
      });
      const titleDiv = createElement(doc, "div", "llm-history-menu-row-title", {
        textContent: session.title || "Untitled",
      });
      titleDiv.title = session.title || "";
      let siteLabel = "webchat";
      try {
        if (session.chatUrl) {
          const url = new URL(session.chatUrl);
          siteLabel = url.hostname;
        }
      } catch {
        // Keep default label.
      }
      const subtitle = createElement(
        doc,
        "div",
        "llm-history-menu-row-subtitle",
        {
          textContent: siteLabel,
        },
      );
      btn.appendChild(titleDiv);
      btn.appendChild(subtitle);

      btn.addEventListener("click", () => {
        deps.closeHistoryMenu();
        const item = deps.getItem();
        if (!item) return;
        void (async () => {
          const key = deps.getConversationKey(item);
          const isDeepSeekSession =
            typeof session.chatUrl === "string" &&
            /chat\.deepseek\.com/i.test(session.chatUrl);
          try {
            let loadModelName = "chatgpt.com";
            try {
              if (session.chatUrl) {
                const loadUrl = new URL(session.chatUrl);
                const { WEBCHAT_TARGETS: targets } =
                  await import("../../../../webchat/types");
                const matched = targets.find(
                  (wt) =>
                    loadUrl.hostname === wt.modelName ||
                    loadUrl.hostname === `www.${wt.modelName}`,
                );
                if (matched) loadModelName = matched.modelName;
              }
            } catch {
              // Keep default.
            }
            deps.setConversationHistory(key, [
              {
                role: "assistant",
                text: `Loading conversation: **${session.title || "Untitled"}**\n\nFetching messages…`,
                timestamp: Date.now(),
                modelName: loadModelName,
                modelProviderLabel: "WebChat",
                streaming: true,
              },
            ]);
            deps.refreshChatPreservingScroll();
            deps.setStatusMessage?.("Loading conversation…", "sending");

            const { loadChatSession } =
              await import("../../../../webchat/client");
            deps.resetWebChatPdfUploadedForCurrentConversation();
            deps.clearNextWebChatNewChatIntent();
            const result = await loadChatSession(host, session.id);
            const messages: Message[] = [];

            if (
              result?.messages &&
              Array.isArray(result.messages) &&
              result.messages.length > 0
            ) {
              for (const message of result.messages) {
                messages.push({
                  role: message.kind === "user" ? "user" : "assistant",
                  text: message.text || "",
                  timestamp: message.timestamp
                    ? new Date(message.timestamp).getTime()
                    : Date.now(),
                  modelName: message.kind === "bot" ? loadModelName : undefined,
                  modelProviderLabel:
                    message.kind === "bot" ? "WebChat" : undefined,
                  reasoningDetails: message.thinking || undefined,
                });
              }
              deps.setStatusMessage?.(
                `Loaded ${result.messages.length} messages`,
                "ready",
              );
            } else {
              deps.setStatusMessage?.(
                "No messages found in the selected conversation",
                "ready",
              );
            }

            if (!deps.isWebChatMode()) return;

            deps.setConversationHistory(key, messages);
            const lastAssistant = messages
              .filter((message) => message.role === "assistant")
              .pop();
            deps.setSelectedReasoningLevel(
              item.id,
              lastAssistant?.reasoningDetails ? "high" : "none",
            );
            deps.setSelectedReasoningProvider(item.id, "unsupported");
            deps.updateReasoningButton();
            deps.refreshChatPreservingScroll();
          } catch (err) {
            deps.log("[webchat] Failed to load chat:", err);
            deps.setConversationHistory(key, [
              {
                role: "assistant",
                text: isDeepSeekSession
                  ? "Failed to load selected DeepSeek conversation"
                  : "Failed to load selected conversation",
                timestamp: Date.now(),
                modelProviderLabel: "WebChat",
              },
            ]);
            deps.refreshChatPreservingScroll();
            deps.setStatusMessage?.(
              isDeepSeekSession
                ? "Failed to load selected DeepSeek conversation"
                : `Error loading chat: ${(err as Error).message || "Unknown error"}`,
              "error",
            );
          }
        })();
      });

      row.appendChild(btn);
      rows.appendChild(row);
    }

    viewport.appendChild(rows);
    container.appendChild(viewport);
    if (!container.parentElement) deps.historyMenu?.appendChild(container);
  };

  const renderWebChatHistoryMenu = async () => {
    if (!deps.historyMenu) return;
    deps.historyMenu.innerHTML = "";

    const doc = deps.body.ownerDocument as Document;
    const header = createElement(
      doc,
      "div",
      "llm-history-menu-section-block",
      {},
    );
    const title = createElement(doc, "div", "llm-history-menu-section", {
      textContent: "WebChat Conversations",
    });
    title.style.padding = "6px 10px";
    title.style.fontSize = "10px";
    title.style.fontWeight = "600";
    title.style.textTransform = "uppercase";
    title.style.letterSpacing = "0.5px";
    title.style.opacity = "0.6";
    header.appendChild(title);

    const loadingEl = createElement(doc, "div", "", {
      textContent: "Fetching chat history…",
    });
    loadingEl.style.padding = "12px 10px";
    loadingEl.style.fontSize = "11px";
    loadingEl.style.opacity = "0.5";
    header.appendChild(loadingEl);
    deps.historyMenu.appendChild(header);

    const { getRelayBaseUrl: getHost, relaySetCommand } =
      await import("../../../../webchat/relayServer");
    const host = getHost();
    const {
      filterWebChatHistorySessionsForHostname,
      getWebChatHistorySiteSyncEntry,
      isWebChatHistorySiteFailure,
      waitForFreshChatHistorySnapshot,
    } = await import("../../../../webchat/client");

    const requestedAt = Date.now();
    relaySetCommand({ type: "SCRAPE_HISTORY" });

    const { getWebChatTargetByModelName } =
      await import("../../../../webchat/types");
    const { currentModel: historyModel } = deps.getSelectedModelInfo();
    const historyTargetEntry = getWebChatTargetByModelName(historyModel || "");
    const targetHostname = historyTargetEntry?.modelName || null;

    let sessions: WebChatHistorySession[] = [];
    let historyFetchFailed = false;
    try {
      const snapshot = await waitForFreshChatHistorySnapshot(
        host,
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
      // Relay not reachable.
    }

    loadingEl.remove();

    if (!sessions.length) {
      const empty = createElement(doc, "div", "", {
        textContent: historyFetchFailed
          ? "Failed to fetch history"
          : "No conversations yet",
      });
      empty.style.padding = "12px 10px";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.5";
      header.appendChild(empty);
      return;
    }

    await renderHistorySessions(doc, header, sessions, host);
  };

  return { warmUpWebChatHistory, renderWebChatHistoryMenu };
}
