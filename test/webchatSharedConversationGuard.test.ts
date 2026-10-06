import { assert } from "chai";
import {
  canIsolateConversationForWebChat,
  isConversationShownOutsideWebChat,
} from "../src/modules/contextPanel/chat";
import {
  activeContextPanels,
  clearAllState,
  webChatIsolatedConversationKeys,
} from "../src/modules/contextPanel/state";

/** A mounted panel body showing `conversationKey`. */
function panelBody(conversationKey: number, connected = true): Element {
  const root = { dataset: { itemId: String(conversationKey) } };
  return {
    isConnected: connected,
    querySelector: (selector: string) =>
      selector === "#llm-main" ? root : null,
  } as unknown as Element;
}

function fakeItem(id: number): Zotero.Item {
  return { id, isAttachment: () => false } as unknown as Zotero.Item;
}

describe("WebChat never empties a chat another panel shows outside WebChat", function () {
  afterEach(function () {
    clearAllState();
  });

  it("sees the window's API view of the chat the sidebar takes into WebChat", function () {
    const sidebar = panelBody(41);
    const windowPanel = panelBody(41);
    const item = fakeItem(41);
    activeContextPanels.set(sidebar, () => item);
    activeContextPanels.set(windowPanel, () => item);
    const webChatPanels = new Set<Element>([sidebar]);
    const isWebChatPanel = (body: Element) => webChatPanels.has(body);

    assert.isTrue(
      isConversationShownOutsideWebChat(41, sidebar, isWebChatPanel),
      "the window shows the chat outside WebChat",
    );
    assert.isFalse(
      canIsolateConversationForWebChat(41, sidebar, isWebChatPanel),
      "the sidebar must not empty the window's chat",
    );

    // Once the window is in WebChat too (or shows another chat), isolating
    // is safe.
    webChatPanels.add(windowPanel);
    assert.isFalse(
      isConversationShownOutsideWebChat(41, sidebar, isWebChatPanel),
    );
    assert.isTrue(
      canIsolateConversationForWebChat(41, sidebar, isWebChatPanel),
    );
  });

  it("ignores the asking panel, panels on other chats, and detached panels", function () {
    const asking = panelBody(42);
    const otherChat = panelBody(43);
    const detached = panelBody(42, false);
    activeContextPanels.set(asking, () => fakeItem(42));
    activeContextPanels.set(otherChat, () => fakeItem(43));
    activeContextPanels.set(detached, () => fakeItem(42));
    const isWebChatPanel = () => false;

    assert.isFalse(
      isConversationShownOutsideWebChat(42, asking, isWebChatPanel),
    );
    assert.isTrue(canIsolateConversationForWebChat(42, asking, isWebChatPanel));
  });

  it("a chat already isolated for WebChat stays isolatable", function () {
    const sidebar = panelBody(44);
    const windowPanel = panelBody(44);
    activeContextPanels.set(sidebar, () => fakeItem(44));
    activeContextPanels.set(windowPanel, () => fakeItem(44));
    webChatIsolatedConversationKeys.add(44);
    assert.isTrue(
      canIsolateConversationForWebChat(44, sidebar, (body) => body === sidebar),
    );
  });
});
