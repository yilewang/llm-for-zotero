import { assert } from "chai";
import {
  SIDE_ITEM_FLASH_CLASS,
  SIDE_ITEM_FLASH_MS,
  appendMoveToSidePanelButton,
  buildSidePanelItemKey,
  canRunItemAgain,
  canSaveItemAsNote,
  findItemOrdinal,
  findSourceMessage,
  flashSourceMessage,
  getSidePanelItemHost,
  registerSidePanelItemHost,
  resolveItemTabTitle,
  unregisterSidePanelItemHost,
  type SidePanelItemRequest,
} from "../src/modules/contextPanel/sidePanelItems";
import {
  CLOSED_SIDE_PANEL_TABS,
  SIDE_PANEL_MAX_TABS,
  openItemSidePanelTab,
  openSideChatSidePanelTab,
  openSidePanel,
} from "../src/modules/contextPanel/standaloneSidePanelState";

/** Just enough DOM for the helpers: tree, classes, dataset, listeners. */
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Record<string, Array<(e: any) => void>> = {};
  title = "";
  type = "";
  scrolled = 0;
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(" ");
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(name: string, fn: (e: any) => void) {
    (this.listeners[name] ||= []).push(fn);
  }
  click() {
    const event = { preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click || []) fn(event);
  }
  appendChild(child: FakeEl) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  scrollIntoView() {
    this.scrolled += 1;
  }
  all(): FakeEl[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  matches(selector: string): boolean {
    const message = selector.match(
      /^\.llm-message-wrapper\[data-message-index(?:="(\d+)")?\]$/,
    );
    if (message) {
      return (
        this.classes.has("llm-message-wrapper") &&
        this.dataset.messageIndex !== undefined &&
        (message[1] === undefined || this.dataset.messageIndex === message[1])
      );
    }
    const kind = selector.match(/^\[data-side-item-kind="(\w+)"\]$/);
    if (kind) return this.attrs["data-side-item-kind"] === kind[1];
    if (selector === ":scope > .llm-side-move-btn") return false;
    return false;
  }
  closest(selector: string): FakeEl | null {
    for (let el: FakeEl | null = this; el; el = el.parent) {
      if (el.matches(selector)) return el;
    }
    return null;
  }
  querySelector(selector: string): FakeEl | null {
    if (selector === ":scope > .llm-side-move-btn") {
      return (
        this.children.find((c) => c.classes.has("llm-side-move-btn")) || null
      );
    }
    return this.all().find((el) => el.matches(selector)) || null;
  }
  querySelectorAll(selector: string): FakeEl[] {
    return this.all().filter((el) => el.matches(selector));
  }
}

const fakeDoc = () =>
  ({ createElement: () => new FakeEl() }) as unknown as Document;
const asParent = (el: FakeEl) => el as unknown as Element;

describe("side panel items", function () {
  describe("item tabs in the panel state", function () {
    const key = "1|mermaid|msg=3:0";

    it("opens a new item tab and shows it", function () {
      const result = openItemSidePanelTab(
        openSidePanel(CLOSED_SIDE_PANEL_TABS),
        { id: "item-1", itemKey: key },
      );
      assert.isTrue(result.opened);
      assert.equal(result.state.activeId, "item-1");
      assert.isFalse(result.state.newTabOpen);
      assert.equal(result.state.tabs[0].kind, "item");
      assert.equal(result.state.tabs[0].itemKey, key);
    });

    it("switches to the open tab when the same item is moved again", function () {
      const first = openItemSidePanelTab(
        openSidePanel(CLOSED_SIDE_PANEL_TABS),
        { id: "item-1", itemKey: key },
      );
      const other = openItemSidePanelTab(first.state, {
        id: "item-2",
        itemKey: "1|code|msg=3:0",
      });
      assert.equal(other.state.activeId, "item-2");
      const again = openItemSidePanelTab(other.state, {
        id: "item-3",
        itemKey: key,
      });
      assert.isFalse(again.opened);
      assert.isFalse(again.refused);
      assert.equal(again.tabId, "item-1");
      assert.equal(again.state.activeId, "item-1");
      assert.lengthOf(again.state.tabs, 2);
    });

    it("refuses a new item tab at the tab limit but still switches to an open one", function () {
      let state = openSidePanel(CLOSED_SIDE_PANEL_TABS);
      for (let i = 0; i < SIDE_PANEL_MAX_TABS; i++) {
        state = openItemSidePanelTab(state, {
          id: `item-${i}`,
          itemKey: `k${i}`,
        }).state;
      }
      assert.lengthOf(state.tabs, SIDE_PANEL_MAX_TABS);
      const refused = openItemSidePanelTab(state, {
        id: "item-x",
        itemKey: "new",
      });
      assert.isTrue(refused.refused);
      assert.isNull(refused.tabId);
      assert.equal(refused.state, state);
      const sideChat = openSideChatSidePanelTab(state, "sc");
      assert.isTrue(sideChat.refused);
      const existing = openItemSidePanelTab(state, {
        id: "item-y",
        itemKey: "k2",
      });
      assert.isFalse(existing.refused);
      assert.equal(existing.state.activeId, "item-2");
    });
  });

  describe("identity and titles", function () {
    it("keys an item by chat, kind, message, and position", function () {
      const base = {
        conversationKey: 7,
        messageIndex: 4,
        kind: "svg" as const,
        ordinal: 0,
      };
      assert.equal(buildSidePanelItemKey(base), buildSidePanelItemKey(base));
      assert.notEqual(
        buildSidePanelItemKey(base),
        buildSidePanelItemKey({ ...base, ordinal: 1 }),
      );
      assert.notEqual(
        buildSidePanelItemKey(base),
        buildSidePanelItemKey({ ...base, kind: "code" }),
      );
      assert.notEqual(
        buildSidePanelItemKey(base),
        buildSidePanelItemKey({ ...base, messageIndex: 5 }),
      );
    });

    it("keys a plan by its document id, not its message index", function () {
      const plan = {
        conversationKey: 7,
        kind: "plan" as const,
        ordinal: 0,
        documentId: "doc-9",
      };
      assert.equal(
        buildSidePanelItemKey({ ...plan, messageIndex: 2 }),
        buildSidePanelItemKey({ ...plan, messageIndex: 8 }),
      );
    });

    it("titles tabs by kind, language, plan title, or question", function () {
      assert.equal(resolveItemTabTitle({ kind: "mermaid" }), "Mermaid diagram");
      assert.equal(resolveItemTabTitle({ kind: "svg" }), "Figure");
      assert.equal(resolveItemTabTitle({ kind: "html" }), "HTML page");
      assert.equal(resolveItemTabTitle({ kind: "figure" }), "Figure");
      assert.equal(
        resolveItemTabTitle({ kind: "figure", title: "Fig. 2 · p. 4" }),
        "Fig. 2 · p. 4",
      );
      assert.equal(
        resolveItemTabTitle({ kind: "code", lang: "python" }),
        "python",
      );
      assert.equal(
        resolveItemTabTitle({ kind: "plan", title: "Review plan" }),
        "Review plan",
      );
    });

    it("limits note saving to plans, and re-running to HTML", function () {
      assert.isTrue(canSaveItemAsNote("plan"));
      assert.isFalse(canSaveItemAsNote("code"));
      assert.isTrue(canRunItemAgain("html"));
      assert.isFalse(canRunItemAgain("svg"));
    });
  });

  describe("the move button exists only where a host is registered", function () {
    const request: SidePanelItemRequest = { kind: "code", source: "x = 1" };

    it("adds no button in the sidebar (no host for the document)", function () {
      const doc = fakeDoc();
      const parent = new FakeEl();
      const button = appendMoveToSidePanelButton({
        doc,
        parent: asParent(parent),
        className: "x",
        buildRequest: () => request,
      });
      assert.isNull(button);
      assert.lengthOf(parent.children, 0);
    });

    it("adds a titled button in the standalone window, once, and opens the item", function () {
      const doc = fakeDoc();
      const opened: SidePanelItemRequest[] = [];
      const host = { open: (r: SidePanelItemRequest) => void opened.push(r) };
      registerSidePanelItemHost(doc, host);
      try {
        const parent = new FakeEl();
        const button = appendMoveToSidePanelButton({
          doc,
          parent: asParent(parent),
          className: "x",
          buildRequest: () => request,
        }) as unknown as FakeEl;
        assert.equal(button.title, "Move to side panel");
        assert.isTrue(button.classes.has("llm-side-move-btn"));
        assert.isNull(
          appendMoveToSidePanelButton({
            doc,
            parent: asParent(parent),
            className: "x",
            buildRequest: () => request,
          }),
        );
        button.click();
        assert.deepEqual(opened, [request]);
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
      assert.isNull(getSidePanelItemHost(doc));
    });
  });

  describe("source message lookup and Show in chat", function () {
    const buildChat = () => {
      const chat = new FakeEl();
      const wrappers = [0, 1, 2].map((i) => {
        const wrapper = new FakeEl();
        wrapper.classes.add("llm-message-wrapper");
        wrapper.dataset.messageIndex = String(i);
        chat.appendChild(wrapper);
        return wrapper;
      });
      return { chat, wrappers };
    };

    it("finds the message and the position of an item inside it", function () {
      const { wrappers } = buildChat();
      const first = new FakeEl();
      const second = new FakeEl();
      for (const el of [first, second]) {
        el.attrs["data-side-item-kind"] = "code";
        wrappers[1].appendChild(el);
      }
      const found = findSourceMessage(asParent(second));
      assert.equal(found?.messageIndex, 1);
      assert.equal(
        findItemOrdinal(found!.wrapper, asParent(second), "code"),
        1,
      );
      assert.equal(findItemOrdinal(found!.wrapper, asParent(first), "code"), 0);
      assert.isNull(findSourceMessage(asParent(new FakeEl())));
    });

    it("scrolls to the right message and flashes it for a short time", function () {
      const { chat, wrappers } = buildChat();
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const wrapper = flashSourceMessage({
        container: chat as unknown as ParentNode,
        messageIndex: 2,
        setTimeout: (fn, ms) => timers.push({ fn, ms }),
      });
      assert.equal(wrapper, wrappers[2] as unknown as Element);
      assert.equal(wrappers[2].scrolled, 1);
      assert.equal(wrappers[0].scrolled, 0);
      assert.isTrue(wrappers[2].classes.has(SIDE_ITEM_FLASH_CLASS));
      assert.isFalse(wrappers[1].classes.has(SIDE_ITEM_FLASH_CLASS));
      assert.equal(timers[0].ms, SIDE_ITEM_FLASH_MS);
      timers[0].fn();
      assert.isFalse(wrappers[2].classes.has(SIDE_ITEM_FLASH_CLASS));
    });

    it("does nothing when the message is not in the chat", function () {
      const { chat } = buildChat();
      assert.isNull(
        flashSourceMessage({
          container: chat as unknown as ParentNode,
          messageIndex: 9,
          setTimeout: () => {
            throw new Error("no timer expected");
          },
        }),
      );
      assert.isNull(
        flashSourceMessage({
          container: chat as unknown as ParentNode,
          messageIndex: -1,
          setTimeout: () => undefined,
        }),
      );
    });
  });
});
