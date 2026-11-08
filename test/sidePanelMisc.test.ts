import { assert } from "chai";
import {
  appendMoveToSidePanelButton,
  collectMadeItems,
  mergeChatMadeItems,
  registerSidePanelItemHost,
  type ChatMadeItem,
  resolveSidePanelItemIdentity,
  unregisterSidePanelItemHost,
  type SidePanelItemRequest,
} from "../src/modules/contextPanel/sidePanelItems";
import {
  CLOSED_SIDE_PANEL_TABS,
  openItemSidePanelTab,
  openMiscSidePanelTab,
  openSidePanel,
  returnItemTabToMisc,
  showSidePanelNewTabPage,
} from "../src/modules/contextPanel/standaloneSidePanelState";
import { t } from "../src/utils/i18n";

/** A small DOM: tree, classes, attributes, dataset, listeners, selectors. */
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Record<string, Array<(e: any) => void>> = {};
  title = "";
  type = "";
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
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
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
  all(): FakeEl[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  matches(selector: string): boolean {
    if (selector === "[data-side-item-kind]") {
      return this.attrs["data-side-item-kind"] !== undefined;
    }
    if (selector === "[data-llm-no-side-items]") {
      return this.attrs["data-llm-no-side-items"] !== undefined;
    }
    if (selector === ".llm-side-move-btn") {
      return this.classes.has("llm-side-move-btn");
    }
    if (selector === ".llm-message-wrapper[data-message-index]") {
      return (
        this.classes.has("llm-message-wrapper") &&
        this.dataset.messageIndex !== undefined
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
const asEl = (el: FakeEl) => el as unknown as Element;

/** A message wrapper holding items; each item gets a marker and its button. */
function buildChat(
  doc: Document,
  messages: Array<{
    index: number;
    timestamp?: number;
    items: Array<{
      kind: string;
      source: string;
      withButton?: boolean;
      /** Rendered inside the agent trace (a tool call's input or result). */
      trace?: boolean;
    }>;
  }>,
) {
  const root = new FakeEl();
  for (const message of messages) {
    const wrapper = new FakeEl();
    wrapper.className = "llm-message-wrapper";
    wrapper.dataset.messageIndex = String(message.index);
    if (message.timestamp !== undefined) {
      wrapper.dataset.messageTimestamp = String(message.timestamp);
    }
    root.appendChild(wrapper);
    for (const item of message.items) {
      const el = new FakeEl();
      el.setAttribute("data-side-item-kind", item.kind);
      if (item.trace) {
        const trace = new FakeEl();
        trace.setAttribute("data-llm-no-side-items", "true");
        wrapper.appendChild(trace);
        trace.appendChild(el);
      } else {
        wrapper.appendChild(el);
      }
      if (item.withButton === false) continue;
      appendMoveToSidePanelButton({
        doc,
        parent: asEl(el),
        className: "x",
        buildRequest: () => ({
          kind: item.kind as SidePanelItemRequest["kind"],
          source: item.source,
          element: asEl(el),
        }),
      });
    }
  }
  return root;
}

describe("side panel Miscellaneous and host registration", function () {
  describe("the move button does not wait for the panel to open", function () {
    it("is present once the host is registered, panel opened or not", function () {
      const doc = fakeDoc();
      let panelOpen = false;
      const opened: SidePanelItemRequest[] = [];
      // The window registers this before any message renders; opening the
      // panel is the host's job at click time.
      const host = {
        open: (request: SidePanelItemRequest) => {
          panelOpen = true;
          opened.push(request);
        },
      };
      registerSidePanelItemHost(doc, host);
      try {
        const parent = new FakeEl();
        const button = appendMoveToSidePanelButton({
          doc,
          parent: asEl(parent),
          className: "x",
          buildRequest: () => ({ kind: "code", source: "a" }),
        }) as unknown as FakeEl;
        assert.isOk(button);
        assert.isFalse(panelOpen);
        button.click();
        assert.isTrue(panelOpen);
        assert.lengthOf(opened, 1);
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });
  });

  describe("collecting what the model made", function () {
    it("lists movable kinds newest first", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          {
            index: 1,
            items: [
              { kind: "mermaid", source: "graph TD" },
              { kind: "code", source: "x = 1" },
            ],
          },
          {
            index: 5,
            items: [
              { kind: "plan", source: "# Plan" },
              { kind: "html", source: "<p>hi</p>" },
            ],
          },
        ]);
        const made = collectMadeItems(chat as unknown as ParentNode);
        assert.deepEqual(
          made.map((item) => item.kind),
          ["html", "plan", "code", "mermaid"],
        );
        assert.deepEqual(
          made.map((item) => item.messageIndex),
          [5, 5, 1, 1],
        );
        assert.equal(made[0].request.source, "<p>hi</p>");
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });

    it("lists only answer items, never code blocks from the agent trace", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          {
            index: 1,
            items: [
              { kind: "code", source: '{"query":"x"}', trace: true },
              { kind: "code", source: '{"results":[]}', trace: true },
              { kind: "code", source: "def f():\n    return 1" },
            ],
          },
        ]);
        const made = collectMadeItems(chat as unknown as ParentNode);
        assert.deepEqual(
          made.map((item) => item.request.source),
          ["def f():\n    return 1"],
        );
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });

    it("lists figures with their own key, in order with other kinds", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          {
            index: 4,
            items: [
              { kind: "figure", source: "file:///a.png" },
              { kind: "code", source: "x" },
              { kind: "figure", source: "file:///b.png" },
            ],
          },
        ]);
        const made = collectMadeItems(chat as unknown as ParentNode);
        assert.deepEqual(
          made.map((item) => item.kind),
          ["figure", "code", "figure"],
        );
        assert.deepEqual(
          made.map(
            (item) => resolveSidePanelItemIdentity(item.request, 3).itemKey,
          ),
          ["3|figure|msg=4:1", "3|code|msg=4:0", "3|figure|msg=4:0"],
        );
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });

    it("skips an item with no button and returns nothing for an empty chat", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          {
            index: 0,
            items: [{ kind: "svg", source: "<svg/>", withButton: false }],
          },
        ]);
        assert.lengthOf(collectMadeItems(chat as unknown as ParentNode), 0);
        assert.lengthOf(
          collectMadeItems(new FakeEl() as unknown as ParentNode),
          0,
        );
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });

    it("gives a listed item the key its button would give", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          {
            index: 2,
            items: [
              { kind: "code", source: "a" },
              { kind: "code", source: "b" },
            ],
          },
        ]);
        const made = collectMadeItems(chat as unknown as ParentNode);
        const keys = made.map(
          (item) => resolveSidePanelItemIdentity(item.request, 7).itemKey,
        );
        assert.deepEqual(keys, ["7|code|msg=2:1", "7|code|msg=2:0"]);
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });
  });

  describe("one list from all chats of a paper", function () {
    it("reads each item's message time, 0 when the message has none", function () {
      const doc = fakeDoc();
      const host = { open() {} };
      registerSidePanelItemHost(doc, host);
      try {
        const chat = buildChat(doc, [
          { index: 1, timestamp: 1000, items: [{ kind: "code", source: "a" }] },
          { index: 3, items: [{ kind: "svg", source: "b" }] },
        ]);
        const made = collectMadeItems(chat as unknown as ParentNode);
        assert.deepEqual(
          made.map((item) => item.timestamp),
          [0, 1000],
        );
      } finally {
        unregisterSidePanelItemHost(doc, host);
      }
    });

    it("merges chats newest first, keeping order on equal times", function () {
      const item = (
        conversationKey: number,
        timestamp: number,
        source: string,
      ): ChatMadeItem => ({
        kind: "code",
        request: { kind: "code", source },
        messageIndex: 1,
        timestamp,
        conversationKey,
      });
      const main = [item(1, 300, "m2"), item(1, 100, "m1")];
      const other = [item(2, 400, "o2"), item(2, 300, "o1"), item(2, 0, "o0")];
      const merged = mergeChatMadeItems([main, other]);
      assert.deepEqual(
        merged.map((made) => made.request.source),
        ["o2", "m2", "o1", "m1", "o0"],
      );
      assert.deepEqual(mergeChatMadeItems([]), []);
    });
  });

  describe("the Miscellaneous tab in the panel state", function () {
    it("turns the New tab tab into one Miscellaneous tab", function () {
      const start = showSidePanelNewTabPage(
        openSidePanel(CLOSED_SIDE_PANEL_TABS),
      );
      const result = openMiscSidePanelTab(start, "misc-1");
      assert.isTrue(result.opened);
      assert.equal(result.state.activeId, "misc-1");
      assert.isFalse(result.state.newTabOpen);
      assert.equal(result.state.tabs[0].kind, "misc");
      const again = openMiscSidePanelTab(
        showSidePanelNewTabPage(result.state),
        "misc-2",
      );
      assert.isFalse(again.opened);
      assert.equal(again.state.activeId, "misc-1");
    });

    it("opens a picked row in the same tab, replacing the list", function () {
      const misc = openMiscSidePanelTab(
        showSidePanelNewTabPage(openSidePanel(CLOSED_SIDE_PANEL_TABS)),
        "misc-1",
      );
      const picked = openItemSidePanelTab(misc.state, {
        id: "item-1",
        itemKey: "7|code|msg=2:0",
        replaceId: "misc-1",
      });
      assert.isTrue(picked.opened);
      assert.deepEqual(
        picked.state.tabs.map((tab) => [tab.id, tab.kind]),
        [["item-1", "item"]],
      );
      assert.equal(picked.state.activeId, "item-1");
    });

    it("goes back from a picked item to the list in the same place", function () {
      const side = openItemSidePanelTab(openSidePanel(CLOSED_SIDE_PANEL_TABS), {
        id: "item-0",
        itemKey: "other",
      });
      const misc = openMiscSidePanelTab(
        showSidePanelNewTabPage(side.state),
        "misc-1",
      );
      const picked = openItemSidePanelTab(misc.state, {
        id: "item-1",
        itemKey: "7|code|msg=2:0",
        replaceId: "misc-1",
      });
      const back = returnItemTabToMisc(picked.state, "item-1", "misc-2");
      assert.isTrue(back.opened);
      assert.equal(back.tabId, "misc-2");
      assert.deepEqual(
        back.state.tabs.map((tab) => [tab.id, tab.kind]),
        [
          ["item-0", "item"],
          ["misc-2", "misc"],
        ],
      );
      assert.equal(back.state.activeId, "misc-2");
      // Not an item tab: nothing changes.
      const none = returnItemTabToMisc(back.state, "misc-2", "misc-3");
      assert.isNull(none.tabId);
      assert.strictEqual(none.state, back.state);
    });

    it("focuses an item tab that is already open and drops the list", function () {
      const first = openItemSidePanelTab(
        openSidePanel(CLOSED_SIDE_PANEL_TABS),
        {
          id: "item-1",
          itemKey: "k",
        },
      );
      const misc = openMiscSidePanelTab(
        showSidePanelNewTabPage(first.state),
        "misc-1",
      );
      const picked = openItemSidePanelTab(misc.state, {
        id: "item-2",
        itemKey: "k",
        replaceId: "misc-1",
      });
      assert.isFalse(picked.opened);
      assert.equal(picked.state.activeId, "item-1");
      assert.deepEqual(
        picked.state.tabs.map((tab) => tab.id),
        ["item-1"],
      );
    });
  });

  describe("Chinese strings", function () {
    const keys = [
      "Move to side panel",
      "Back to Miscellaneous",
      "Back to History",
      "Mermaid diagram",
      "HTML page",
      "Code",
      "Document",
      "Diagram",
      "Runs in a safe box: no internet, no access to Zotero",
      "Copied",
      "Could not save the note",
      "Run again",
      "Ran again",
      "Show in chat",
      "The source message is not in the main chat now.",
      "Saved as note",
      "Note already saved",
      "Miscellaneous",
      "View what the model made in these chats",
      "Made for this paper",
      "Made in library chats",
      "Nothing made for this paper yet",
      "Nothing made in library chats yet",
      "This chat",
      "Go to chat",
      "Go to the chat it came from",
      "open now",
      "Looking through the other chats...",
      "Open HTML preview viewer",
      "HTML preview",
      "HTML preview viewer controls",
      "Close HTML preview viewer",
      "Preview stopped: the page tried to leave.",
    ];

    it("has a zh-CN entry for every new string and none in English", function () {
      const scope = globalThis as unknown as { Zotero?: unknown };
      const saved = scope.Zotero;
      try {
        scope.Zotero = { locale: "en-US" };
        for (const key of keys) assert.equal(t(key), key);
        scope.Zotero = { locale: "zh-CN" };
        for (const key of keys) {
          assert.notEqual(t(key), key, `missing zh-CN for "${key}"`);
        }
      } finally {
        scope.Zotero = saved;
      }
    });
  });
});
