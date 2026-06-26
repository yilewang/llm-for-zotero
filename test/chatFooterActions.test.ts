import { assert } from "chai";

import {
  appendUserMessageCopyAction,
  shouldShowAssistantFooterActions,
  shouldShowUserFooterCopyAction,
} from "../src/modules/contextPanel/chat";

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly dataset: Record<string, string> = {};
  public readonly attributes: Record<string, string> = {};
  public className = "";
  public id = "";
  public title = "";
  public textContent = "";
  public type = "";
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => unknown>
  >();

  constructor(
    public readonly ownerDocument: FakeDocument,
    public readonly tagName = "div",
  ) {}

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(
    type: string,
    listener: (event: FakeEvent) => unknown,
  ): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith("#")) return null;
    const id = selector.slice(1);
    return this.findById(id);
  }

  async dispatch(type: string): Promise<FakeEvent> {
    const event = new FakeEvent();
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
    return event;
  }

  private findById(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const match = child.findById(id);
      if (match) return match;
    }
    return null;
  }
}

class FakeEvent {
  public defaultPrevented = false;
  public propagationStopped = false;
  public immediatePropagationStopped = false;

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
  }
}

class FakeDocument {
  public defaultView: {
    navigator: { clipboard: { writeText: (value: string) => Promise<void> } };
  };

  constructor(writeText: (value: string) => Promise<void>) {
    this.defaultView = {
      navigator: {
        clipboard: {
          writeText,
        },
      },
    };
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

describe("chat footer actions", function () {
  describe("assistant footer action visibility", function () {
    it("hides footer actions while the assistant response is streaming", function () {
      assert.isFalse(shouldShowAssistantFooterActions({ streaming: true }));
    });

    it("shows footer actions after the assistant response finishes", function () {
      assert.isTrue(shouldShowAssistantFooterActions({ streaming: false }));
    });

    it("hides footer actions for compact marker messages", function () {
      assert.isFalse(
        shouldShowAssistantFooterActions({
          streaming: false,
          compactMarker: true,
        }),
      );
    });
  });

  describe("user footer copy action", function () {
    it("shows only for non-empty user messages", function () {
      assert.isTrue(
        shouldShowUserFooterCopyAction({ text: "Copy this query" }),
      );
      assert.isFalse(shouldShowUserFooterCopyAction({ text: "   \n\t" }));
    });

    it("reuses the assistant footer copy icon and copies the user query", async function () {
      let copiedText = "";
      const doc = new FakeDocument(async (value) => {
        copiedText = value;
      });
      const body = new FakeElement(doc, "div");
      const status = new FakeElement(doc, "div");
      status.id = "llm-status";
      body.appendChild(status);
      const actions = new FakeElement(doc, "div");

      const button = appendUserMessageCopyAction({
        body: body as unknown as Element,
        doc: doc as unknown as Document,
        actions: actions as unknown as HTMLElement,
        message: { text: "  help me explain figure 1  " },
      });

      assert.exists(button);
      assert.equal(actions.children[0], button);
      assert.include(button!.className, "llm-message-action");
      assert.include(button!.className, "llm-message-action-copy");
      assert.equal(button!.title, "Copy query");
      assert.equal(button!.attributes["aria-label"], "Copy query");

      const event = await (button as unknown as FakeElement).dispatch("click");

      assert.isTrue(event.defaultPrevented);
      assert.isTrue(event.propagationStopped);
      assert.isTrue(event.immediatePropagationStopped);
      assert.equal(copiedText, "help me explain figure 1");
      assert.equal(status.textContent, "Copied query");
      assert.equal(status.className, "llm-status llm-status-ready");
    });
  });
});
