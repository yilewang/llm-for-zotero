const READER_CONTEXT_DECK_ID = "zotero-context-pane-deck";
const READER_ITEM_DECK_ID = "zotero-context-pane-item-deck";
const READER_SIDENAV_ID = "zotero-context-pane-sidenav";
const READER_AI_DECK_PANEL_ID = "llmforzotero-reader-ai-deck-panel";
const READER_AI_PANE_ID = "llmforzotero-reader-ai-pane";
const LIBRARY_ITEM_DECK_ID = "zotero-item-pane-content";
const LIBRARY_ITEM_DETAILS_ID = "zotero-item-details";
const LIBRARY_SIDENAV_ID = "zotero-view-item-sidenav";
const LIBRARY_AI_DECK_PANEL_ID = "llmforzotero-library-ai-deck-panel";
const LIBRARY_AI_PANE_ID = "llmforzotero-library-ai-pane";

type DedicatedPaneState = {
  scope: "reader" | "library";
  paneID: string;
  deck: Element;
  deckPanel: Element;
  itemDeck: Element;
  host: HTMLElement;
  sidenav: Element;
  activeRequested: boolean;
  onSidenavClick: (event: Event) => void;
  layoutObserver: MutationObserver;
  selectionObserver: MutationObserver;
};

type DedicatedPaneConfig = {
  scope: DedicatedPaneState["scope"];
  deckID: string;
  defaultPanelID: string;
  sidenavID: string;
  deckPanelID: string;
  hostID: string;
  hostClassName: string;
};

const readerDedicatedPaneStates = new Map<Window, DedicatedPaneState>();
const libraryDedicatedPaneStates = new Map<Window, DedicatedPaneState>();

function getButtonForPane(
  sidenav: Element,
  paneID: string,
): HTMLElement | null {
  const candidates = Array.from(
    sidenav.querySelectorAll(".btn[data-pane]"),
  ) as HTMLElement[];
  for (const candidate of candidates) {
    if (candidate.dataset.pane === paneID) return candidate;
  }
  return null;
}

function isAiPaneSelected(state: DedicatedPaneState): boolean {
  const deck = state.deck as Element & { selectedPanel?: Element | null };
  return deck.selectedPanel === state.deckPanel;
}

function syncReaderDedicatedPaneSelection(state: DedicatedPaneState): void {
  const active = isAiPaneSelected(state);
  const button = getButtonForPane(state.sidenav, state.paneID);
  if (button) {
    button.dataset.llmAiPaneButton = "true";
    button.setAttribute("aria-selected", active ? "true" : "false");
    button
      .closest("[role='tab']")
      ?.setAttribute("aria-selected", active ? "true" : "false");
  }
  state.sidenav.toggleAttribute("data-llm-reader-ai-active", active);
  if (active) {
    state.sidenav
      .querySelector(".highlight-notes-inactive")
      ?.classList.remove("highlight");
    state.sidenav
      .querySelector<HTMLElement>(".btn[data-pane='context-notes']")
      ?.setAttribute("aria-selected", "false");
  }
}

function activateReaderDedicatedPane(state: DedicatedPaneState): void {
  state.activeRequested = true;
  const deck = state.deck as Element & { selectedPanel?: Element | null };
  deck.selectedPanel = state.deckPanel;
  if (state.scope === "reader") {
    try {
      const contextPane = state.deck.ownerDocument.getElementById(
        "zotero-context-pane-inner",
      ) as (HTMLElement & { collapsed?: boolean }) | null;
      if (contextPane) contextPane.collapsed = false;
    } catch {
      void 0;
    }
  }
  if (state.scope === "reader") {
    try {
      const mainWindow = state.deck.ownerDocument.defaultView as
        | (Window & { ZoteroContextPane?: { collapsed?: boolean } })
        | null;
      if (mainWindow?.ZoteroContextPane) {
        mainWindow.ZoteroContextPane.collapsed = false;
      }
    } catch {
      void 0;
    }
  }
  syncReaderDedicatedPaneSelection(state);
}

function restoreReaderItemPane(state: DedicatedPaneState): void {
  state.activeRequested = false;
  if (!isAiPaneSelected(state)) return;
  const deck = state.deck as Element & { selectedPanel?: Element | null };
  deck.selectedPanel = state.itemDeck;
  syncReaderDedicatedPaneSelection(state);
}

function syncReaderDedicatedPaneLayout(host: HTMLElement): void {
  Object.assign(host.style, {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
    boxSizing: "border-box",
  });

  const panel = host.querySelector<HTMLElement>(".llm-panel");
  if (!panel) return;
  Object.assign(panel.style, {
    flex: "1 1 auto",
    height: "100%",
    minHeight: "0",
  });

  const chatShell = panel.querySelector<HTMLElement>(".llm-chat-shell");
  if (chatShell) {
    Object.assign(chatShell.style, {
      flex: "1 1 0",
      height: "auto",
      minHeight: "0",
      maxHeight: "none",
      resize: "none",
    });
  }

  const input = panel.querySelector<HTMLElement>(".llm-input");
  if (input) {
    Object.assign(input.style, {
      maxHeight: "30vh",
      resize: "none",
    });
  }
}

function createReaderDedicatedPaneState(
  win: Window,
  paneID: string,
  config: DedicatedPaneConfig,
): DedicatedPaneState | null {
  const doc = win.document;
  const deck = doc.getElementById(config.deckID);
  const itemDeck = doc.getElementById(config.defaultPanelID);
  const sidenav = doc.getElementById(config.sidenavID);
  if (!deck || !itemDeck || !sidenav) return null;

  let deckPanel: Element | null = doc.getElementById(config.deckPanelID);
  let host = doc.getElementById(config.hostID) as HTMLElement | null;
  if (!deckPanel) {
    const createdDeckPanel = doc.createXULElement("vbox");
    createdDeckPanel.id = config.deckPanelID;
    createdDeckPanel.classList.add("llm-dedicated-ai-deck-panel");
    createdDeckPanel.setAttribute("flex", "1");
    createdDeckPanel.setAttribute("role", "tabpanel");
    createdDeckPanel.setAttribute("aria-label", "LLM Assistant");
    deck.appendChild(createdDeckPanel);
    deckPanel = createdDeckPanel;
  }
  if (!host) {
    const createdHost = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    createdHost.id = config.hostID;
    createdHost.className = config.hostClassName;
    deckPanel.appendChild(createdHost);
    host = createdHost;
  } else if (host.parentElement !== deckPanel) {
    deckPanel.appendChild(host);
  }
  host.classList.add(...config.hostClassName.split(/\s+/).filter(Boolean));

  const state = {
    scope: config.scope,
    paneID,
    deck,
    deckPanel,
    itemDeck,
    host,
    sidenav,
    activeRequested: false,
    onSidenavClick: (_event: Event) => undefined,
    layoutObserver: null as unknown as MutationObserver,
    selectionObserver: null as unknown as MutationObserver,
  } satisfies DedicatedPaneState;

  syncReaderDedicatedPaneLayout(host);
  state.layoutObserver = new win.MutationObserver(() => {
    syncReaderDedicatedPaneLayout(host);
  });
  state.layoutObserver.observe(host, { childList: true });

  state.onSidenavClick = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    if (typeof mouseEvent.button === "number" && mouseEvent.button !== 0) {
      return;
    }
    const target = event.target as Element | null;
    const button = target?.closest?.(".btn") as HTMLElement | null;
    if (!button) return;
    if (button.dataset.pane === state.paneID) {
      event.preventDefault();
      event.stopPropagation();
      (
        event as Event & { stopImmediatePropagation?: () => void }
      ).stopImmediatePropagation?.();
      activateReaderDedicatedPane(state);
      return;
    }
    if (isAiPaneSelected(state)) {
      restoreReaderItemPane(state);
    }
    win.setTimeout(() => syncReaderDedicatedPaneSelection(state), 0);
  };
  sidenav.addEventListener("click", state.onSidenavClick, true);

  state.selectionObserver = new win.MutationObserver(() => {
    syncReaderDedicatedPaneSelection(state);
  });
  state.selectionObserver.observe(deck, {
    attributes: true,
    attributeFilter: ["selectedIndex", "selected-index"],
  });
  syncReaderDedicatedPaneSelection(state);
  return state;
}

export function registerReaderDedicatedPane(win: Window, paneID: string): void {
  const existing = readerDedicatedPaneStates.get(win);
  if (existing?.paneID === paneID) {
    if (existing.activeRequested) activateReaderDedicatedPane(existing);
    else syncReaderDedicatedPaneSelection(existing);
    return;
  }
  if (existing) unregisterReaderDedicatedPane(win);
  const state = createReaderDedicatedPaneState(win, paneID, {
    scope: "reader",
    deckID: READER_CONTEXT_DECK_ID,
    defaultPanelID: READER_ITEM_DECK_ID,
    sidenavID: READER_SIDENAV_ID,
    deckPanelID: READER_AI_DECK_PANEL_ID,
    hostID: READER_AI_PANE_ID,
    hostClassName:
      "llm-reader-ai-pane llm-dedicated-ai-pane llm-modern-chat-pane",
  });
  if (state) readerDedicatedPaneStates.set(win, state);
}

function registerLibraryDedicatedPane(win: Window, paneID: string): void {
  const existing = libraryDedicatedPaneStates.get(win);
  if (existing?.paneID === paneID) {
    if (existing.activeRequested) activateReaderDedicatedPane(existing);
    else syncReaderDedicatedPaneSelection(existing);
    return;
  }
  if (existing) unregisterLibraryDedicatedPane(win);
  const state = createReaderDedicatedPaneState(win, paneID, {
    scope: "library",
    deckID: LIBRARY_ITEM_DECK_ID,
    defaultPanelID: LIBRARY_ITEM_DETAILS_ID,
    sidenavID: LIBRARY_SIDENAV_ID,
    deckPanelID: LIBRARY_AI_DECK_PANEL_ID,
    hostID: LIBRARY_AI_PANE_ID,
    hostClassName:
      "llm-library-ai-pane llm-dedicated-ai-pane llm-modern-chat-pane",
  });
  if (state) libraryDedicatedPaneStates.set(win, state);
}

export function unregisterReaderDedicatedPane(win: Window): void {
  const state = readerDedicatedPaneStates.get(win);
  if (!state) return;
  state.sidenav.removeEventListener("click", state.onSidenavClick, true);
  state.layoutObserver.disconnect();
  state.selectionObserver.disconnect();
  state.deckPanel.remove();
  readerDedicatedPaneStates.delete(win);
}

export function unregisterLibraryDedicatedPane(win: Window): void {
  const state = libraryDedicatedPaneStates.get(win);
  if (!state) return;
  state.sidenav.removeEventListener("click", state.onSidenavClick, true);
  state.layoutObserver.disconnect();
  state.selectionObserver.disconnect();
  state.deckPanel.remove();
  libraryDedicatedPaneStates.delete(win);
}

export function unregisterAllReaderDedicatedPanes(): void {
  for (const win of [...readerDedicatedPaneStates.keys()]) {
    unregisterReaderDedicatedPane(win);
  }
  for (const win of [...libraryDedicatedPaneStates.keys()]) {
    unregisterLibraryDedicatedPane(win);
  }
}

function getSourceReaderTabID(body: Element): string {
  return (
    (body.closest("item-details") as HTMLElement | null)?.dataset.tabId || ""
  );
}

export function resolveReaderDedicatedPanelBody(params: {
  sectionBody: Element;
  tabType?: string | null;
  paneID: string | null;
}): Element | null {
  const { sectionBody, tabType, paneID } = params;
  if (!paneID) return sectionBody;

  const sourceSection = sectionBody.closest(
    "item-pane-custom-section, item-pane-section",
  ) as HTMLElement | null;
  sourceSection?.classList.add("llm-reader-ai-source-section");
  sourceSection?.style.setProperty("display", "none", "important");

  const win = sectionBody.ownerDocument.defaultView;
  if (!win) return sectionBody;
  if (tabType !== "reader") {
    registerLibraryDedicatedPane(win, paneID);
    return libraryDedicatedPaneStates.get(win)?.host || sectionBody;
  }
  registerReaderDedicatedPane(win, paneID);
  const state = readerDedicatedPaneStates.get(win);
  if (!state) return sectionBody;

  const sourceTabID = getSourceReaderTabID(sectionBody);
  const selectedTabID = String(
    (win as Window & { Zotero_Tabs?: { selectedID?: unknown } }).Zotero_Tabs
      ?.selectedID || "",
  );
  if (sourceTabID && selectedTabID && sourceTabID !== selectedTabID) {
    return null;
  }
  return state.host;
}

export function activateReaderDedicatedPaneForDocument(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  const state = readerDedicatedPaneStates.get(win);
  if (!state) return false;
  activateReaderDedicatedPane(state);
  return true;
}
