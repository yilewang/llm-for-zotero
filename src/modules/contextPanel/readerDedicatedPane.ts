const READER_CONTEXT_DECK_ID = "zotero-context-pane-deck";
const READER_ITEM_DECK_ID = "zotero-context-pane-item-deck";
const READER_SIDENAV_ID = "zotero-context-pane-sidenav";
const READER_AI_DECK_PANEL_ID = "llmforzotero-reader-ai-deck-panel";
const READER_AI_PANE_ID = "llmforzotero-reader-ai-pane";

type ReaderDedicatedPaneState = {
  paneID: string;
  deck: Element;
  deckPanel: Element;
  itemDeck: Element;
  host: HTMLElement;
  sidenav: Element;
  onSidenavClick: (event: Event) => void;
  layoutObserver: MutationObserver;
  selectionObserver: MutationObserver;
};

const readerDedicatedPaneStates = new Map<Window, ReaderDedicatedPaneState>();

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

function isAiPaneSelected(state: ReaderDedicatedPaneState): boolean {
  const deck = state.deck as Element & { selectedPanel?: Element | null };
  return deck.selectedPanel === state.deckPanel;
}

function syncReaderDedicatedPaneSelection(
  state: ReaderDedicatedPaneState,
): void {
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

function activateReaderDedicatedPane(state: ReaderDedicatedPaneState): void {
  const deck = state.deck as Element & { selectedPanel?: Element | null };
  deck.selectedPanel = state.deckPanel;
  try {
    const contextPane = state.deck.ownerDocument.getElementById(
      "zotero-context-pane-inner",
    ) as (HTMLElement & { collapsed?: boolean }) | null;
    if (contextPane) contextPane.collapsed = false;
  } catch {
    void 0;
  }
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
  syncReaderDedicatedPaneSelection(state);
}

function restoreReaderItemPane(state: ReaderDedicatedPaneState): void {
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
}

function createReaderDedicatedPaneState(
  win: Window,
  paneID: string,
): ReaderDedicatedPaneState | null {
  const doc = win.document;
  const deck = doc.getElementById(READER_CONTEXT_DECK_ID);
  const itemDeck = doc.getElementById(READER_ITEM_DECK_ID);
  const sidenav = doc.getElementById(READER_SIDENAV_ID);
  if (!deck || !itemDeck || !sidenav) return null;

  let deckPanel: Element | null = doc.getElementById(READER_AI_DECK_PANEL_ID);
  let host = doc.getElementById(READER_AI_PANE_ID) as HTMLElement | null;
  if (!deckPanel) {
    const createdDeckPanel = doc.createXULElement("vbox");
    createdDeckPanel.id = READER_AI_DECK_PANEL_ID;
    createdDeckPanel.classList.add("llm-reader-ai-deck-panel");
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
    createdHost.id = READER_AI_PANE_ID;
    createdHost.className = "llm-reader-ai-pane";
    deckPanel.appendChild(createdHost);
    host = createdHost;
  } else if (host.parentElement !== deckPanel) {
    deckPanel.appendChild(host);
  }

  const state = {
    paneID,
    deck,
    deckPanel,
    itemDeck,
    host,
    sidenav,
    onSidenavClick: (_event: Event) => undefined,
    layoutObserver: null as unknown as MutationObserver,
    selectionObserver: null as unknown as MutationObserver,
  } satisfies ReaderDedicatedPaneState;

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
    syncReaderDedicatedPaneSelection(existing);
    return;
  }
  if (existing) unregisterReaderDedicatedPane(win);
  const state = createReaderDedicatedPaneState(win, paneID);
  if (state) readerDedicatedPaneStates.set(win, state);
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

export function unregisterAllReaderDedicatedPanes(): void {
  for (const win of [...readerDedicatedPaneStates.keys()]) {
    unregisterReaderDedicatedPane(win);
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
  if (tabType !== "reader" || !paneID) return sectionBody;

  const sourceSection = sectionBody.closest(
    "item-pane-custom-section, item-pane-section",
  ) as HTMLElement | null;
  sourceSection?.classList.add("llm-reader-ai-source-section");
  sourceSection?.style.setProperty("display", "none", "important");

  const win = sectionBody.ownerDocument.defaultView;
  if (!win) return sectionBody;
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
