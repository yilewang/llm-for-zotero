import { assert } from "chai";
import { describe, it } from "mocha";
import { revealReaderChatPane } from "../src/modules/contextPanel/dedicatedChatPane";

const CHAT_PANE = "plugin-namespaced-chat";

class FakeMouseEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown>,
  ) {}
}

function makeReaderPane(options: {
  collapsed: boolean;
  view: string;
  rootSize: [number, number];
  tabID?: string;
  withSection?: boolean;
}) {
  const clicks: FakeMouseEvent[] = [];
  const button = {
    getAttribute: (name: string) => (name === "data-pane" ? CHAT_PANE : null),
    dispatchEvent: (event: FakeMouseEvent) => {
      clicks.push(event);
      return true;
    },
  };
  const otherButton = {
    getAttribute: (name: string) => (name === "data-pane" ? "info" : null),
    dispatchEvent: () => {
      throw new Error("the wrong rail icon was clicked");
    },
  };
  const root = {
    isConnected: true,
    getBoundingClientRect: () => ({
      width: options.rootSize[0],
      height: options.rootSize[1],
    }),
  };
  const section = {
    getAttribute: (name: string) => (name === "data-pane" ? CHAT_PANE : null),
  };
  const details = {
    nodeType: 1,
    getAttribute: (name: string) =>
      name === "data-tab-id" ? options.tabID || "tab-1" : null,
    querySelector: (selector: string) =>
      selector === ".llm-dedicated-chat-pane"
        ? options.withSection === false
          ? null
          : section
        : selector === "#llm-main"
          ? root
          : null,
    sidenav: {
      _collapsed: options.collapsed,
      querySelectorAll: () => [otherButton, button],
    },
  };
  const deck = { children: [details], selectedPanel: details };
  const doc = {
    getElementById: (id: string) =>
      id === "zotero-context-pane-item-deck" ? deck : null,
    documentElement: {
      getAttribute: (name: string) =>
        name === "data-llm-pane-view" ? options.view : null,
    },
    defaultView: { MouseEvent: FakeMouseEvent },
  } as unknown as Document;
  return { doc, clicks };
}

describe("revealReaderChatPane", function () {
  it("clicks the chat's rail icon when the reader pane is collapsed", function () {
    // A collapsed pane still lays the panel out a few pixels wide.
    const { doc, clicks } = makeReaderPane({
      collapsed: true,
      view: "stacked",
      rootSize: [4, 44],
    });
    assert.isTrue(revealReaderChatPane(doc, "tab-1"));
    assert.lengthOf(clicks, 1);
    assert.equal(clicks[0].type, "click");
    assert.deepInclude(clicks[0].init, { bubbles: true, detail: 1, button: 0 });
  });

  it("clicks when the pane is open on item details and the chat is hidden", function () {
    const { doc, clicks } = makeReaderPane({
      collapsed: false,
      view: "details",
      rootSize: [0, 0],
    });
    assert.isTrue(revealReaderChatPane(doc, "tab-1"));
    assert.lengthOf(clicks, 1);
  });

  it("leaves an open chat alone, since the icon would close it", function () {
    const chatView = makeReaderPane({
      collapsed: false,
      view: "chat",
      rootSize: [0, 0],
    });
    assert.isFalse(revealReaderChatPane(chatView.doc, "tab-1"));
    assert.lengthOf(chatView.clicks, 0);

    const shown = makeReaderPane({
      collapsed: false,
      view: "stacked",
      rootSize: [300, 500],
    });
    assert.isFalse(revealReaderChatPane(shown.doc, "tab-1"));
    assert.lengthOf(shown.clicks, 0);
  });

  it("does nothing for another tab or a pane without the chat section", function () {
    const other = makeReaderPane({
      collapsed: true,
      view: "stacked",
      rootSize: [4, 44],
    });
    assert.isFalse(revealReaderChatPane(other.doc, "tab-2"));
    assert.lengthOf(other.clicks, 0);

    const noSection = makeReaderPane({
      collapsed: true,
      view: "stacked",
      rootSize: [4, 44],
      withSection: false,
    });
    assert.isFalse(revealReaderChatPane(noSection.doc, "tab-1"));
    assert.lengthOf(noSection.clicks, 0);
  });
});
