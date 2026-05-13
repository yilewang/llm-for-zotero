import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import { FONT_SCALE_DEFAULT_PERCENT } from "../src/modules/contextPanel/constants";
import { attachFontScaleShortcutController } from "../src/modules/contextPanel/setupHandlers/controllers/fontScaleShortcutController";
import { setPanelFontScalePercent } from "../src/modules/contextPanel/state";

type FakeEvent = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type Listener = EventListenerOrEventListenerObject;

class FakeStyle {
  private values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) || "";
  }
}

class FakeElement {
  readonly style = new FakeStyle();
  private children = new Set<FakeElement>();

  constructor(readonly id: string) {}

  appendChild(child: FakeElement): void {
    this.children.add(child);
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains(node)) return true;
    }
    return false;
  }
}

class FakeDocument {
  readonly main = new FakeElement("llm-main");
  readonly child = new FakeElement("llm-child");
  readonly outside = new FakeElement("outside");
  readonly standaloneRoot = new FakeElement(
    "llmforzotero-standalone-chat-root",
  );
  activeElement: FakeElement | null = this.child;
  useStandaloneRoot = false;
  private listeners = new Map<string, Listener[]>();

  constructor() {
    this.main.appendChild(this.child);
    this.standaloneRoot.appendChild(this.main);
  }

  querySelector(selector: string): FakeElement | null {
    return selector === "#llm-main" ? this.main : null;
  }

  getElementById(id: string): FakeElement | null {
    if (id !== "llmforzotero-standalone-chat-root") return null;
    return this.useStandaloneRoot ? this.standaloneRoot : null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) || []) {
      if (typeof listener === "function") {
        listener(event as unknown as Event);
      } else {
        listener.handleEvent(event as unknown as Event);
      }
    }
  }
}

function makeKeyboardEvent(
  target: FakeElement,
  overrides: Partial<FakeEvent>,
): FakeEvent {
  const event: FakeEvent = {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
    ...overrides,
  };
  return event;
}

describe("fontScaleShortcutController", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    setPanelFontScalePercent(FONT_SCALE_DEFAULT_PERCENT);
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("uses Cmd/Ctrl+Shift+> to increase the panel font scale", function () {
    const doc = new FakeDocument();
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.child, { key: ">", code: "Period" });
    doc.dispatch("keydown", event);

    assert.isTrue(event.defaultPrevented);
    assert.isTrue(event.propagationStopped);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "1.3");
  });

  it("uses Cmd/Ctrl+Shift+< to decrease the panel font scale", function () {
    const doc = new FakeDocument();
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.child, { key: "<", code: "Comma" });
    doc.dispatch("keydown", event);

    assert.isTrue(event.defaultPrevented);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "1.1");
  });

  it("uses Cmd/Ctrl+Shift+0 to reset the panel font scale", function () {
    const doc = new FakeDocument();
    setPanelFontScalePercent(150);
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.child, { key: ")", code: "Digit0" });
    doc.dispatch("keydown", event);

    assert.isTrue(event.defaultPrevented);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "1.2");
  });

  it("does not intercept Zotero native Cmd/Ctrl +/-/0 zoom shortcuts", function () {
    const doc = new FakeDocument();
    attachFontScaleShortcutController(doc as unknown as Document);

    for (const event of [
      makeKeyboardEvent(doc.child, {
        key: "+",
        code: "Equal",
        shiftKey: false,
      }),
      makeKeyboardEvent(doc.child, {
        key: "-",
        code: "Minus",
        shiftKey: false,
      }),
      makeKeyboardEvent(doc.child, {
        key: "0",
        code: "Digit0",
        shiftKey: false,
      }),
    ]) {
      doc.dispatch("keydown", event);
      assert.isFalse(event.defaultPrevented);
      assert.isFalse(event.propagationStopped);
    }
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "");
  });

  it("ignores shortcuts outside the LLM panel", function () {
    const doc = new FakeDocument();
    doc.activeElement = doc.outside;
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.outside, {
      key: ">",
      code: "Period",
    });
    doc.dispatch("keydown", event);

    assert.isFalse(event.defaultPrevented);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "");
  });

  it("does not intercept Zotero zoom command events", function () {
    const doc = new FakeDocument();
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.child, {
      target: { id: "cmd_fullZoomEnlarge" },
    });
    doc.dispatch("command", event);

    assert.isFalse(event.defaultPrevented);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "");
  });

  it("applies shortcuts from inside the standalone chat root", function () {
    const doc = new FakeDocument();
    doc.useStandaloneRoot = true;
    doc.activeElement = doc.main;
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.main, { key: ">", code: "Period" });
    doc.dispatch("keydown", event);

    assert.isTrue(event.defaultPrevented);
    assert.equal(doc.main.style.getPropertyValue("--llm-font-scale"), "1.3");
    assert.equal(
      doc.standaloneRoot.style.getPropertyValue("--llm-font-scale"),
      "1.3",
    );
  });

  it("persists the updated panel font scale preference", async function () {
    const doc = new FakeDocument();
    attachFontScaleShortcutController(doc as unknown as Document);

    const event = makeKeyboardEvent(doc.child, { key: ">", code: "Period" });
    doc.dispatch("keydown", event);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(prefStore.get(`${config.prefsPrefix}.panelFontScale`), 130);
  });
});
