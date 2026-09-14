import { assert } from "chai";

import { openStandaloneDocumentWindow } from "../src/modules/contextPanel/standaloneDocumentWindow";

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly attributes: Record<string, string> = {};
  public readonly style = {
    values: {} as Record<string, string>,
    setProperty(name: string, value: string) {
      this.values[name] = value;
    },
    getPropertyValue(name: string) {
      return this.values[name] || "";
    },
  };
  public className = "";
  public textContent = "";
  public rel = "";
  public type = "";
  public href = "";

  prepend(child: FakeElement): void {
    this.children.unshift(child);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  querySelector(selector: string): FakeElement | null {
    const wanted = selector.replace(".", "");
    for (const child of this.children) {
      if (child.className.split(" ").includes(wanted)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  public readonly documentElement = new FakeElement();
  public title = "";
  public defaultView: unknown = null;

  constructor(public readonly root: FakeElement) {}

  getElementById(id: string): FakeElement | null {
    return id === "document-root" ? this.root : null;
  }

  createElementNS(_namespace: string, _name: string): FakeElement {
    return new FakeElement();
  }
}

function createWindow(doc: FakeDocument) {
  const listeners = new Map<
    string,
    Array<(event?: Record<string, unknown>) => void>
  >();
  const win = {
    closed: false,
    focusCount: 0,
    document: doc,
    addEventListener(
      type: string,
      listener: (event?: Record<string, unknown>) => void,
    ) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
    focus() {
      this.focusCount += 1;
    },
    dispatchKey(params: { key: string; metaKey?: boolean; ctrlKey?: boolean }) {
      let defaultPrevented = false;
      const event = {
        key: params.key,
        metaKey: params.metaKey ?? false,
        ctrlKey: params.ctrlKey ?? false,
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      for (const listener of listeners.get("keydown") || []) listener(event);
      return defaultPrevented;
    },
    close() {
      this.closed = true;
      for (const listener of listeners.get("unload") || []) listener();
    },
  };
  doc.defaultView = win;
  return win;
}

describe("standalone document window", function () {
  it("installs source styling, renders once, focuses an existing key, and supports close shortcuts", function () {
    const firstDoc = new FakeDocument(new FakeElement());
    const secondDoc = new FakeDocument(new FakeElement());
    const windows = [createWindow(firstDoc), createWindow(secondDoc)];
    const openCalls: unknown[][] = [];
    const sourceDoc = {
      documentElement: new FakeElement(),
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) =>
            name === "--fill-primary" ? "rgb(1, 2, 3)" : "",
        }),
        openDialog: (...args: unknown[]) => {
          openCalls.push(args);
          return windows[openCalls.length - 1];
        },
      },
    };
    let renderCount = 0;
    const options = {
      sourceDoc: sourceDoc as unknown as Document,
      chromeDocument: "standaloneResponseDocument.xhtml",
      windowName: "response-window-1",
      rootId: "document-root",
      title: "Response from Codex",
      render: (_doc: Document, root: HTMLElement) => {
        renderCount += 1;
        root.className = "rendered";
      },
    };

    assert.isTrue(openStandaloneDocumentWindow(options));
    assert.equal(renderCount, 1);
    assert.lengthOf(openCalls, 1);
    assert.include(String(openCalls[0][0]), "standaloneResponseDocument.xhtml");
    assert.equal(firstDoc.title, "Response from Codex");
    assert.equal(firstDoc.documentElement.attributes.minwidth, "720");
    assert.equal(firstDoc.documentElement.attributes.minheight, "520");
    assert.equal(firstDoc.root.className, "rendered");
    assert.equal(
      firstDoc.documentElement.children[0].textContent.includes(
        "--fill-primary",
      ),
      true,
    );
    assert.equal(firstDoc.documentElement.children[1].rel, "stylesheet");

    assert.isTrue(openStandaloneDocumentWindow(options));
    assert.lengthOf(openCalls, 1);
    assert.equal(windows[0].focusCount, 1);
    assert.equal(renderCount, 1);

    assert.isTrue(
      openStandaloneDocumentWindow({
        ...options,
        windowName: "response-window-2",
      }),
    );
    assert.lengthOf(openCalls, 2);
    assert.equal(renderCount, 2);

    assert.isFalse(windows[0].dispatchKey({ key: "x", metaKey: true }));
    assert.isFalse(windows[0].closed);
    assert.isTrue(windows[0].dispatchKey({ key: "Escape" }));
    assert.isTrue(windows[0].closed);
    assert.isFalse(windows[1].closed);
    assert.isTrue(windows[1].dispatchKey({ key: "w", metaKey: true }));
    assert.isTrue(windows[1].closed);
  });

  it("closes with Ctrl-W", function () {
    const targetDoc = new FakeDocument(new FakeElement());
    const targetWin = createWindow(targetDoc);
    const sourceDoc = {
      documentElement: new FakeElement(),
      defaultView: {
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        openDialog: () => targetWin,
      },
    };

    assert.isTrue(
      openStandaloneDocumentWindow({
        sourceDoc: sourceDoc as unknown as Document,
        chromeDocument: "standaloneResponseDocument.xhtml",
        windowName: "response-window-ctrl-w",
        rootId: "document-root",
        title: "Response from Codex",
        render: () => undefined,
      }),
    );
    assert.isTrue(targetWin.dispatchKey({ key: "w", ctrlKey: true }));
    assert.isTrue(targetWin.closed);
  });

  it("zooms document text with Cmd or Ctrl shortcuts and resets locally", function () {
    const targetDoc = new FakeDocument(new FakeElement());
    const targetWin = createWindow(targetDoc);
    const sourceDoc = {
      documentElement: new FakeElement(),
      defaultView: {
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        openDialog: () => targetWin,
      },
    };

    assert.isTrue(
      openStandaloneDocumentWindow({
        sourceDoc: sourceDoc as unknown as Document,
        chromeDocument: "standaloneResponseDocument.xhtml",
        windowName: "response-window-text-zoom",
        rootId: "document-root",
        title: "Response from Codex",
        render: () => undefined,
      }),
    );

    const fontSize = () =>
      targetDoc.documentElement.style.getPropertyValue(
        "--llm-document-font-size",
      );
    assert.equal(fontSize(), "15.5px");
    assert.isTrue(targetWin.dispatchKey({ key: "=", metaKey: true }));
    assert.equal(fontSize(), "17.05px");
    assert.isTrue(targetWin.dispatchKey({ key: "+", ctrlKey: true }));
    assert.equal(fontSize(), "18.6px");
    assert.isTrue(targetWin.dispatchKey({ key: "-", metaKey: true }));
    assert.equal(fontSize(), "17.05px");
    assert.isTrue(targetWin.dispatchKey({ key: "0", metaKey: true }));
    assert.equal(fontSize(), "15.5px");

    for (let index = 0; index < 20; index += 1) {
      targetWin.dispatchKey({ key: "-", ctrlKey: true });
    }
    assert.equal(fontSize(), "10.85px");
    for (let index = 0; index < 30; index += 1) {
      targetWin.dispatchKey({ key: "+", ctrlKey: true });
    }
    assert.equal(fontSize(), "31px");

    assert.isFalse(targetWin.dispatchKey({ key: "x", metaKey: true }));
    assert.equal(fontSize(), "31px");
  });

  function openWithRender(
    targetDoc: FakeDocument,
    render: (doc: Document, root: HTMLElement) => void,
  ): boolean {
    const targetWin = createWindow(targetDoc);
    const sourceDoc = {
      documentElement: new FakeElement(),
      defaultView: {
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        openDialog: () => targetWin,
      },
    };
    return openStandaloneDocumentWindow({
      sourceDoc: sourceDoc as unknown as Document,
      chromeDocument: "standaloneResponseDocument.xhtml",
      windowName: `response-window-${Math.random()}`,
      rootId: "document-root",
      title: "Response from Codex",
      render,
    });
  }

  it("installs a traffic light drag strip that a re-rendered document cannot wipe", function () {
    const targetDoc = new FakeDocument(new FakeElement());
    targetDoc.documentElement.setAttribute("customtitlebar", "true");

    assert.isTrue(
      openWithRender(targetDoc, (_doc, root) => {
        // The real renderers replace every child of the root, so the strip
        // has to live outside it.
        (root as unknown as FakeElement).children.length = 0;
      }),
    );

    const strip = targetDoc.documentElement.children.find(
      (child) => child.className === "llm-window-titlebar",
    );
    assert.isDefined(strip, "expected a drag strip on the document element");
    assert.equal(strip?.children[0]?.className, "llm-window-buttons");
    assert.equal(strip?.children[0]?.attributes["aria-hidden"], "true");
  });

  it("leaves document windows untouched when the platform keeps its title bar", function () {
    const targetDoc = new FakeDocument(new FakeElement());

    assert.isTrue(openWithRender(targetDoc, () => undefined));

    assert.isUndefined(
      targetDoc.documentElement.children.find(
        (child) => child.className === "llm-window-titlebar",
      ),
    );
  });
});
