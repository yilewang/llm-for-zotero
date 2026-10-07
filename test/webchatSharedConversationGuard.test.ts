import { assert } from "chai";
import {
  canIsolateConversationForWebChat,
  isConversationShownOutsideWebChat,
  shouldMoveToOwnWebChatSession,
} from "../src/modules/contextPanel/chat";
import {
  activeContextPanels,
  chatHistory,
  clearAllState,
  webChatIsolatedConversationKeys,
  webChatSessionConversationKeys,
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

describe("a paper panel in WebChat always ends up on the paper's WebChat session", function () {
  afterEach(function () {
    clearAllState();
  });

  it("moves off the paper's ordinary chat even when another panel left it isolated for WebChat", function () {
    // Another panel on the same paper entered WebChat on the ordinary chat
    // (isolating it) and then moved to the WebChat session. A second panel
    // opening on the ordinary chat must follow it, not stay behind.
    webChatIsolatedConversationKeys.add(43);
    chatHistory.set(43, []);
    assert.isTrue(
      shouldMoveToOwnWebChatSession({ conversationKey: 43, paperMode: true }),
    );
  });

  it("stays on a WebChat session row it already shows", function () {
    webChatSessionConversationKeys.add(1500000006);
    webChatIsolatedConversationKeys.add(1500000006);
    chatHistory.set(1500000006, []);
    assert.isFalse(
      shouldMoveToOwnWebChatSession({
        conversationKey: 1500000006,
        paperMode: true,
      }),
    );
    // A session row whose WebChat history is gone is opened afresh.
    chatHistory.delete(1500000006);
    assert.isTrue(
      shouldMoveToOwnWebChatSession({
        conversationKey: 1500000006,
        paperMode: true,
      }),
    );
  });

  it("a library chat stays in place unless another panel shows it outside WebChat", function () {
    const asking = panelBody(45);
    const other = panelBody(45);
    activeContextPanels.set(asking, () => fakeItem(45));
    activeContextPanels.set(other, () => fakeItem(45));
    assert.isFalse(
      shouldMoveToOwnWebChatSession({
        conversationKey: 45,
        paperMode: false,
        body: asking,
        isWebChatPanel: () => true,
      }),
    );
    assert.isTrue(
      shouldMoveToOwnWebChatSession({
        conversationKey: 45,
        paperMode: false,
        body: asking,
        isWebChatPanel: (body) => body === asking,
      }),
    );
    webChatIsolatedConversationKeys.add(45);
    chatHistory.set(45, []);
    assert.isFalse(
      shouldMoveToOwnWebChatSession({
        conversationKey: 45,
        paperMode: false,
        body: asking,
        isWebChatPanel: (body) => body === asking,
      }),
    );
  });

  it("forgets a session row with the rest of the runtime state", function () {
    webChatSessionConversationKeys.add(1500000007);
    clearAllState();
    assert.isFalse(webChatSessionConversationKeys.has(1500000007));
  });
});
