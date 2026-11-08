import { assert } from "chai";
import {
  clearChatPanelExtensions,
  getChatPanelExtensions,
  isChatPanelReadOnly,
  isChatPanelTurnRewriteDisabled,
  mergeChatPanelExtensions,
  setChatPanelExtensions,
  updateChatPanelExtensions,
} from "../src/modules/contextPanel/chatPanelExtensions";
import { resolveSideChatSlashItemView } from "../src/modules/contextPanel/sideChatSlashItem";

describe("chatPanelExtensions", function () {
  it("disables edit, retry, and fork for a read-only or side chat body", function () {
    const plain = {} as Element;
    const readOnly = {} as Element;
    const sideChat = {} as Element;
    setChatPanelExtensions(readOnly, { readOnly: true });
    setChatPanelExtensions(sideChat, { sideChat: true });
    assert.isFalse(isChatPanelTurnRewriteDisabled(plain));
    assert.isTrue(isChatPanelTurnRewriteDisabled(readOnly));
    assert.isTrue(isChatPanelTurnRewriteDisabled(sideChat));
    // A side chat keeps its write controls (delete, copy): it is not read-only.
    assert.isFalse(isChatPanelReadOnly(sideChat));
    clearChatPanelExtensions(readOnly);
    clearChatPanelExtensions(sideChat);
  });

  it("merges patches and drops keys set to undefined", function () {
    const afterRender = () => undefined;
    const merged = mergeChatPanelExtensions(
      { readOnly: true, afterRender },
      { readOnly: undefined, extraAssistantActions: [] },
    );
    assert.deepEqual(merged, { afterRender, extraAssistantActions: [] });
    assert.isNull(
      mergeChatPanelExtensions({ readOnly: true }, { readOnly: undefined }),
    );
  });

  it("keeps per-body registrations separate and clears them", function () {
    const bodyA = {} as Element;
    const bodyB = {} as Element;
    assert.isNull(getChatPanelExtensions(bodyA));
    assert.isFalse(isChatPanelReadOnly(bodyA));

    setChatPanelExtensions(bodyA, { readOnly: true });
    updateChatPanelExtensions(bodyB, { readOnly: false });
    assert.isTrue(isChatPanelReadOnly(bodyA));
    assert.isFalse(isChatPanelReadOnly(bodyB));

    const attach = () => undefined;
    updateChatPanelExtensions(bodyA, {
      sideChatSlashItem: { getState: () => ({ available: false }), attach },
    });
    assert.isTrue(isChatPanelReadOnly(bodyA));
    assert.equal(
      getChatPanelExtensions(bodyA)?.sideChatSlashItem?.attach,
      attach,
    );

    setChatPanelExtensions(bodyA, {});
    assert.isNull(getChatPanelExtensions(bodyA));
    clearChatPanelExtensions(bodyB);
    assert.isNull(getChatPanelExtensions(bodyB));
  });

  it("resolves the side chat slash item from the provider state", function () {
    assert.deepEqual(resolveSideChatSlashItemView(null), {
      visible: false,
      disabled: true,
      hint: "",
      title: "",
    });
    assert.deepEqual(resolveSideChatSlashItemView({ available: false }), {
      visible: true,
      disabled: true,
      hint: "Start a side chat first",
      title: "",
    });
    assert.deepEqual(
      resolveSideChatSlashItemView({ available: true, title: "Why figure 2?" }),
      {
        visible: true,
        disabled: false,
        hint: "Attach \u201c{title}\u201d as context",
        title: "Why figure 2?",
      },
      "the hint names the side chat",
    );
  });
});
