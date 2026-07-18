import { assert } from "chai";
import {
  getReaderContextPanelForTab,
  isPanelInReaderContextForTab,
  resolveReaderPopupPanelTarget,
  resolveStandalonePopupPanelTarget,
} from "../src/modules/contextPanel/readerPopupPanelRouting";

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  isConnected = true;
  ownerDocument!: FakeDocument;
  parentElement: FakeElement | null = null;
  selectedPanel?: FakeElement | null;
  selectedIndex?: number;

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    return selector === "#llm-main" && this.getAttribute("id") === "llm-main";
  }

  querySelector(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }
}

class FakeDocument {
  constructor(
    private readonly deck: FakeElement,
    private readonly dedicatedHost: FakeElement | null = null,
  ) {}

  getElementById(id: string): FakeElement | null {
    if (id === "zotero-context-pane-item-deck") return this.deck;
    if (id === "llmforzotero-reader-ai-pane") return this.dedicatedHost;
    return null;
  }
}

function buildReaderDeck() {
  const deck = new FakeElement();
  const doc = new FakeDocument(deck);
  deck.ownerDocument = doc;
  const stalePanel = new FakeElement();
  stalePanel.setAttribute("data-tab-id", "tab-stale");
  const staleRoot = new FakeElement();
  staleRoot.setAttribute("id", "llm-main");
  const activePanel = new FakeElement();
  activePanel.setAttribute("data-tab-id", "tab-active");
  const activeRoot = new FakeElement();
  activeRoot.setAttribute("id", "llm-main");
  stalePanel.ownerDocument = doc;
  activePanel.ownerDocument = doc;
  stalePanel.append(staleRoot);
  activePanel.append(activeRoot);
  deck.append(stalePanel, activePanel);
  deck.selectedPanel = activePanel;
  return {
    doc: doc as unknown as Document,
    staleRoot: staleRoot as unknown as Element,
    activePanel: activePanel as unknown as Element,
    activeRoot: activeRoot as unknown as Element,
  };
}

function buildStandalonePanel() {
  const deck = new FakeElement();
  const doc = new FakeDocument(deck);
  deck.ownerDocument = doc;
  const body = new FakeElement();
  const root = new FakeElement();
  body.ownerDocument = doc;
  root.setAttribute("id", "llm-main");
  root.setAttribute("data-standalone", "true");
  body.append(root);
  return {
    body: body as unknown as Element,
    root: root as unknown as Element,
  };
}

function buildDedicatedReaderPanel(ownerTabID = "tab-active") {
  const deck = new FakeElement();
  const host = new FakeElement();
  const doc = new FakeDocument(deck, host);
  deck.ownerDocument = doc;
  host.ownerDocument = doc;
  host.setAttribute("data-llm-reader-tab-id", ownerTabID);
  const root = new FakeElement();
  root.setAttribute("id", "llm-main");
  host.append(root);
  return {
    doc: doc as unknown as Document,
    host: host as unknown as Element,
    root: root as unknown as Element,
  };
}

describe("reader popup panel routing", function () {
  it("selects the context pane owned by the reader tab", function () {
    const { doc, activePanel, activeRoot, staleRoot } = buildReaderDeck();

    assert.strictEqual(
      getReaderContextPanelForTab(doc, "tab-active"),
      activePanel,
    );
    assert.isTrue(isPanelInReaderContextForTab(activeRoot, "tab-active"));
    assert.isFalse(isPanelInReaderContextForTab(staleRoot, "tab-active"));
  });

  it("uses the deck's selected panel when the reader tab ID is unavailable", function () {
    const { doc, activePanel } = buildReaderDeck();

    assert.strictEqual(getReaderContextPanelForTab(doc, null), activePanel);
  });

  it("does not fall back to another window's selected panel for a known tab ID", function () {
    const { doc } = buildReaderDeck();

    assert.isNull(getReaderContextPanelForTab(doc, "tab-in-another-window"));
  });

  it("does not mistake a connected panel outside the reader deck for active", function () {
    const { doc } = buildReaderDeck();
    const libraryPanelRoot = new FakeElement();
    libraryPanelRoot.ownerDocument = doc as unknown as FakeDocument;

    assert.isFalse(
      isPanelInReaderContextForTab(
        libraryPanelRoot as unknown as Element,
        "tab-active",
      ),
    );
  });

  it("returns the exact panel target for a known reader tab", function () {
    const { doc, activePanel, activeRoot } = buildReaderDeck();

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: doc,
      documents: [doc],
      tabID: "tab-active",
    });

    assert.strictEqual(target?.body, activePanel);
    assert.strictEqual(target?.root, activeRoot);
  });

  it("routes a reader popup to the matching dedicated chat pane", function () {
    const { doc, host, root } = buildDedicatedReaderPanel();

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: doc,
      documents: [doc],
      tabID: "tab-active",
    });

    assert.strictEqual(target?.body, host);
    assert.strictEqual(target?.root, root);
  });

  it("does not route a reader popup to another tab's dedicated chat", function () {
    const { doc } = buildDedicatedReaderPanel("tab-other");

    assert.isNull(
      resolveReaderPopupPanelTarget({
        preferredDocument: doc,
        documents: [doc],
        tabID: "tab-active",
      }),
    );
  });

  it("uses only the preferred window's selected panel without a tab ID", function () {
    const preferred = buildReaderDeck();
    const other = buildReaderDeck();

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: preferred.doc,
      documents: [preferred.doc, other.doc],
      tabID: null,
    });

    assert.strictEqual(target?.root, preferred.activeRoot);
  });

  it("finds a known tab in another Zotero window", function () {
    const preferred = buildReaderDeck();
    const other = buildReaderDeck();
    other.activePanel.setAttribute("data-tab-id", "tab-other-window");

    const target = resolveReaderPopupPanelTarget({
      preferredDocument: preferred.doc,
      documents: [preferred.doc, other.doc],
      tabID: "tab-other-window",
    });

    assert.strictEqual(target?.root, other.activeRoot);
  });

  it("refuses an ambiguous known tab across multiple windows", function () {
    const first = buildReaderDeck();
    const second = buildReaderDeck();

    assert.isNull(
      resolveReaderPopupPanelTarget({
        documents: [first.doc, second.doc],
        tabID: "tab-active",
      }),
    );
  });

  it("refuses multiple selected panels when no preferred window exists", function () {
    const first = buildReaderDeck();
    const second = buildReaderDeck();

    assert.isNull(
      resolveReaderPopupPanelTarget({
        documents: [first.doc, second.doc],
        tabID: null,
      }),
    );
  });

  it("returns the standalone chat target outside the reader deck", function () {
    const reader = buildReaderDeck();
    const standalone = buildStandalonePanel();

    const target = resolveStandalonePopupPanelTarget([
      reader.activePanel,
      standalone.body,
    ]);

    assert.strictEqual(target?.body, standalone.body);
    assert.strictEqual(target?.root, standalone.root);
  });

  it("ignores a disconnected standalone chat target", function () {
    const standalone = buildStandalonePanel();
    (standalone.body as unknown as FakeElement).isConnected = false;

    assert.isNull(resolveStandalonePopupPanelTarget([standalone.body]));
  });

  it("refuses multiple live standalone chat targets", function () {
    const first = buildStandalonePanel();
    const second = buildStandalonePanel();

    assert.isNull(resolveStandalonePopupPanelTarget([first.body, second.body]));
  });
});
