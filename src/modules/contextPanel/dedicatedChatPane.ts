import {
  installSidebarLayoutPreference,
  syncSidebarSectionLayout,
} from "./sidebarLayout";
import { installSidebarThemePreference } from "./sidebarTheme";
import { installPersistentLibraryChatPane } from "./persistentLibraryChatPane";
import { getReaderContextPanelForTab } from "./readerPopupPanelRouting";
import { appLogger } from "../../core/logging";

type TabSelectionObserver = {
  registerObserver: (
    observer: { notify: (event: string) => void },
    types: ["tab"],
    id: string,
  ) => string;
  unregisterObserver: (id: string) => void;
};

/**
 * Keep the native per-tab item-details host (and its render/ownership hooks),
 * but make chat and item details mutually exclusive views of the right pane.
 * Window-level presentation survives reader tab changes without owning chat
 * mode, conversation identity, drafts, or the library-chat lock.
 */
export function installDedicatedChatPane(
  doc: Document,
  notifier?: TabSelectionObserver,
): () => void {
  const root = doc.documentElement;
  const win = doc.defaultView;
  let refreshTimer: number | undefined;
  const refreshSelectedPane = () => {
    if (!win) return;
    if (refreshTimer !== undefined) win.clearTimeout(refreshTimer);
    // Native tab selection first updates its retained deck and skipRender
    // flags. Then ask the existing section lifecycle to reconcile mode/owner;
    // a cached native render otherwise leaves another tab's old Paper chat.
    refreshTimer = win.setTimeout(() => {
      refreshTimer = undefined;
      libraryPane.refresh();
      if (
        !["chat", "stacked"].includes(
          root.getAttribute("data-llm-pane-view") || "",
        )
      )
        return;
      const tabs = (win as Window & { Zotero_Tabs?: { selectedID?: string } })
        .Zotero_Tabs;
      const host =
        getReaderContextPanelForTab(doc, tabs?.selectedID) ||
        doc.querySelector('item-details[tabType="library"]');
      const section = host?.querySelector(".llm-dedicated-chat-pane") as
        | (Element & { _forceRenderAll?: () => Promise<void> })
        | null;
      void section?._forceRenderAll?.().catch((error: unknown) => {
        appLogger.warn(
          `LLM: dedicated pane reconciliation failed: ${String(error)}`,
        );
      });
    }, 0);
  };
  root.setAttribute("data-llm-pane-view", "details");
  const disposeLayout = installSidebarLayoutPreference(doc);
  const disposeTheme = installSidebarThemePreference(doc);
  const libraryPane = installPersistentLibraryChatPane(doc);
  type ChatSidenav = Element & {
    _collapsed: boolean;
    container?: { getPane: (id: string) => Element | null };
  };
  // Close the full-pane chat without unmounting it: its conversation and
  // draft stay with the native host, exactly as the rail icon leaves them.
  const closeChatView = (event: Event, sidenav: ChatSidenav) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    root.setAttribute("data-llm-pane-view", "details");
    sidenav._collapsed = true;
  };
  const onClick = (event: Event) => {
    if ((event as MouseEvent).button !== 0) return;
    const target = event.target as Element | null;
    const button = target?.closest?.("[data-pane]");
    const sidenav = button?.closest("item-pane-sidenav") as
      | (Element & {
          _collapsed: boolean;
          container?: { getPane: (id: string) => Element | null };
        })
      | null;
    if (!sidenav) return;
    if (button?.hasAttribute("disabled")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const pane = button?.getAttribute("data-pane");
    if (!pane) return;
    const chatPane = sidenav.container
      ?.getPane(pane)
      ?.classList.contains("llm-dedicated-chat-pane");
    if (
      chatPane &&
      root.getAttribute("data-llm-pane-view") === "chat" &&
      !sidenav._collapsed
    ) {
      // Native pane navigation always expands after scrolling. Intercept the
      // close click before it can reopen the retained conversation host.
      closeChatView(event, sidenav);
      return;
    }
    root.setAttribute("data-llm-pane-view", chatPane ? "chat" : "details");
    const libraryPane = doc.getElementById("zotero-item-pane");
    const emptyLibrary =
      sidenav.id === "zotero-view-item-sidenav" &&
      libraryPane?.getAttribute("view-type") !== "item";
    if (
      root.getAttribute("data-llm-sidebar-layout") === "stacked" &&
      (!emptyLibrary || root.getAttribute("data-llm-pane-view") !== "chat")
    ) {
      root.setAttribute("data-llm-pane-view", "stacked");
    }
    syncSidebarSectionLayout(doc);
    refreshSelectedPane();
  };
  // Change layout before Zotero scrolls, expands, and focuses its native pane.
  // Keyboard activation also dispatches a click through the native sidenav.
  doc.addEventListener("click", onClick, true);
  const observerID = notifier?.registerObserver(
    {
      notify: (event) => {
        if (event === "select") refreshSelectedPane();
      },
    },
    ["tab"],
    "llm-dedicated-chat-pane",
  );
  return () => {
    libraryPane.dispose();
    disposeLayout();
    disposeTheme();
    if (observerID) notifier?.unregisterObserver(observerID);
    if (refreshTimer !== undefined) win?.clearTimeout(refreshTimer);
    doc.removeEventListener("click", onClick, true);
    root.removeAttribute("data-llm-pane-view");
  };
}
