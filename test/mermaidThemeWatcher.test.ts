import { assert } from "chai";
import { describe, it, beforeEach } from "mocha";

import {
  buildMermaidSvgCacheKey,
  cacheMermaidSvg,
  clearMermaidSvgCache,
} from "../src/modules/contextPanel/mermaidSvgCache";
import { renderMermaidBlocks } from "../src/modules/contextPanel/renderedMarkdown";
import { FakeElement } from "./helpers/fakeDom";

/**
 * The theme watcher a chat rebuild leaves behind.
 *
 * Every assistant answer containing a Mermaid diagram is rendered into a fresh
 * `.llm-rendered-markdown` element, so a watcher that observes the rendered
 * root grows one live MutationObserver per render, each one pinning the
 * detached subtree it observes for the life of the window. What the watcher
 * actually needs is the elements whose colours decide the diagram theme:
 * `documentElement`, `body`, and the live panel root.
 */

const MERMAID_SOURCE = "graph TD; A-->B;";
const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
/** Pinned to `MERMAID_RENDER_VERSION` in renderedMarkdown.ts. */
const MERMAID_RENDER_VERSION = "4";

/**
 * A fake element that knows whether it is still in the document.
 *
 * The shared fake reports `isConnected: false` for everything; the watcher's
 * liveness check needs the real distinction between a panel still in the tree
 * and one a rebuild replaced.
 */
class DomFakeElement extends FakeElement {
  /** Set on the stand-in for `document.documentElement`. */
  public isDocumentRoot = false;
  private parsedChildren: FakeElement[] = [];
  private markup = "";

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if ((node as DomFakeElement).isDocumentRoot) return true;
      node = node.parentElement;
    }
    return false;
  }

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  /** Enough markup parsing for the cached-SVG insertion path. */
  set innerHTML(value: string) {
    this.markup = value;
    this.parsedChildren = value.trim().startsWith("<svg")
      ? [new DomFakeElement("svg")]
      : [];
  }

  get innerHTML(): string {
    return this.markup;
  }

  get firstElementChild(): FakeElement | null {
    return this.parsedChildren[0] || this.children[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === ".llm-mermaid-preview[data-llm-mermaid-source]") {
      return this.findAllByClass("llm-mermaid-preview").filter(
        (element) => element.dataset.llmMermaidSource !== undefined,
      );
    }
    return super.querySelectorAll(selector);
  }
}

type RecordedObserver = {
  target: FakeElement | null;
  disconnected: boolean;
};

type TestDom = {
  doc: Document;
  html: DomFakeElement;
  body: DomFakeElement;
  observers: RecordedObserver[];
  mediaListenerCount: () => number;
  addPanel: () => DomFakeElement;
  renderAnswer: (panel: DomFakeElement) => Promise<DomFakeElement>;
};

function liveObserverTargets(observers: RecordedObserver[]): FakeElement[] {
  return observers
    .filter((observer) => !observer.disconnected)
    .map((observer) => observer.target)
    .filter((target): target is FakeElement => Boolean(target));
}

function createTestDom(): TestDom {
  const observers: RecordedObserver[] = [];
  let mediaListeners = 0;

  class RecordingMutationObserver {
    public readonly record: RecordedObserver = {
      target: null,
      disconnected: false,
    };

    constructor(_callback: () => void) {
      observers.push(this.record);
    }

    observe(target: FakeElement): void {
      this.record.target = target;
    }

    disconnect(): void {
      this.record.disconnected = true;
    }
  }

  const html = new DomFakeElement("html");
  html.isDocumentRoot = true;
  const body = new DomFakeElement("body");
  html.appendChild(body);

  const win = {
    MutationObserver: RecordingMutationObserver,
    getComputedStyle: () => ({
      backgroundColor: "rgb(255, 255, 255)",
      color: "rgb(0, 0, 0)",
      getPropertyValue: () => "",
    }),
    setTimeout: (callback: () => void) => {
      void callback;
      return 0;
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {
        mediaListeners++;
      },
      removeEventListener: () => {
        mediaListeners--;
      },
    }),
    // A cache miss must not reach the script loader (its onload never fires
    // under mocha); this stub keeps such a miss a fast failure.
    mermaid: {
      initialize: () => {},
      render: () => ({ svg: MERMAID_SVG }),
    },
  };

  const doc = {
    documentElement: html,
    body,
    defaultView: win,
    createElement: (tagName: string) => new DomFakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      new DomFakeElement(tagName),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;

  const addPanel = (): DomFakeElement => {
    const panel = new DomFakeElement("div");
    panel.className = "llm-panel";
    body.appendChild(panel);
    return panel;
  };

  const renderAnswer = async (
    panel: DomFakeElement,
  ): Promise<DomFakeElement> => {
    const container = new DomFakeElement("div");
    container.className = "llm-rendered-markdown";
    const preview = new DomFakeElement("div");
    preview.className = "llm-mermaid-preview";
    preview.dataset.llmMermaidSource = MERMAID_SOURCE;
    container.appendChild(preview);
    panel.appendChild(container);
    await renderMermaidBlocks(
      container as unknown as ParentNode,
      doc as unknown as Document,
    );
    assert.strictEqual(
      preview.dataset.mermaidState,
      "rendered",
      "the cached diagram should have been inserted without the renderer",
    );
    return container;
  };

  return {
    doc,
    html,
    body,
    observers,
    mediaListenerCount: () => mediaListeners,
    addPanel,
    renderAnswer,
  };
}

describe("mermaid theme watcher", function () {
  beforeEach(() => {
    clearMermaidSvgCache();
    // Both themes are seeded so the render path stays on the cache hit even if
    // the fake document's colours resolve to dark.
    for (const themeKey of ["light", "dark"]) {
      cacheMermaidSvg(
        buildMermaidSvgCacheKey(
          MERMAID_RENDER_VERSION,
          themeKey,
          MERMAID_SOURCE,
        ),
        MERMAID_SVG,
      );
    }
  });

  it("does not add an observer for every rendered answer", async function () {
    const dom = createTestDom();
    const panel = dom.addPanel();

    for (let i = 0; i < 5; i++) {
      await dom.renderAnswer(panel);
    }

    const live = liveObserverTargets(dom.observers);
    assert.strictEqual(
      live.length,
      3,
      "only the document root, body and live panel should stay observed",
    );
    assert.sameMembers(live, [dom.html, dom.body, panel]);
    assert.strictEqual(
      dom.mediaListenerCount(),
      1,
      "one prefers-color-scheme listener per document",
    );
  });

  it("replaces the observer of a panel the UI rebuilt", async function () {
    const dom = createTestDom();
    const firstPanel = dom.addPanel();
    await dom.renderAnswer(firstPanel);

    firstPanel.remove();
    const secondPanel = dom.addPanel();
    await dom.renderAnswer(secondPanel);

    const live = liveObserverTargets(dom.observers);
    assert.sameMembers(
      live,
      [dom.html, dom.body, secondPanel],
      "the rebuilt panel is observed and the detached one is released",
    );
    assert.isTrue(
      dom.observers.some(
        (observer) => observer.target === firstPanel && observer.disconnected,
      ),
      "the detached panel's observer should have been disconnected",
    );
  });
});
