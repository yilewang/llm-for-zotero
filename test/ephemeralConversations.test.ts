import { assert } from "chai";
import {
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
  discardEphemeralConversation,
  isEphemeralConversationBusy,
  moveEphemeralConversation,
} from "../src/modules/contextPanel/ephemeralConversations";
import {
  chatHistory,
  clearAllState,
  draftInputCache,
  loadedConversationKeys,
  selectedTextCache,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import {
  buildEphemeralBackgroundContextBlock,
  setEphemeralBackgroundContextProvider,
} from "../src/shared/ephemeralBackgroundContext";
import type { Message } from "../src/modules/contextPanel/types";

describe("ephemeral side chat conversations", function () {
  afterEach(function () {
    clearAllState();
  });

  it("moves the in-memory chat, draft, chips, and background to the new key", function () {
    const oldKey = allocateEphemeralPaperConversationKey();
    const newKey = allocateEphemeralGlobalConversationKey();
    const history: Message[] = [
      { role: "user", text: "Q1", timestamp: 1 },
      { role: "assistant", text: "A1", timestamp: 2 },
    ];
    chatHistory.set(oldKey, history);
    loadedConversationKeys.add(oldKey);
    draftInputCache.set(oldKey, "half a question");
    selectedTextCache.set(oldKey, [{ text: "chip", source: "model" }]);
    setEphemeralBackgroundContextProvider(oldKey, () => "main chat");

    assert.isTrue(moveEphemeralConversation(oldKey, newKey));

    assert.deepEqual(
      chatHistory.get(newKey)?.map((message) => message.text),
      ["Q1", "A1"],
    );
    assert.isTrue(loadedConversationKeys.has(newKey));
    assert.equal(draftInputCache.get(newKey), "half a question");
    assert.deepEqual(selectedTextCache.get(newKey), [
      { text: "chip", source: "model" },
    ]);
    assert.include(buildEphemeralBackgroundContextBlock(newKey), "main chat");
    assert.isFalse(chatHistory.has(oldKey));
    assert.isFalse(loadedConversationKeys.has(oldKey));
    assert.isUndefined(draftInputCache.get(oldKey));
    assert.isFalse(selectedTextCache.has(oldKey));
    assert.equal(buildEphemeralBackgroundContextBlock(oldKey), "");
  });

  it("refuses real keys, the same key, and a side chat that is answering", function () {
    const key = allocateEphemeralPaperConversationKey();
    const other = allocateEphemeralPaperConversationKey();
    chatHistory.set(key, []);
    assert.isFalse(moveEphemeralConversation(key, key));
    assert.isFalse(moveEphemeralConversation(key, 123));
    assert.isFalse(moveEphemeralConversation(123, key));

    assert.isFalse(isEphemeralConversationBusy(key));
    assert.isTrue(tryBeginRequest(key, 1, null));
    assert.isTrue(isEphemeralConversationBusy(key));
    assert.isFalse(moveEphemeralConversation(key, other));
    assert.isTrue(chatHistory.has(key));
    // A real key is never reported as an ephemeral side chat.
    assert.isFalse(isEphemeralConversationBusy(123));
  });

  it("discards everything a side chat holds in memory", function () {
    const key = allocateEphemeralGlobalConversationKey();
    chatHistory.set(key, [{ role: "user", text: "Q", timestamp: 1 }]);
    loadedConversationKeys.add(key);
    setEphemeralBackgroundContextProvider(key, () => "main chat");
    discardEphemeralConversation(key);
    assert.isFalse(chatHistory.has(key));
    assert.isFalse(loadedConversationKeys.has(key));
    assert.equal(buildEphemeralBackgroundContextBlock(key), "");
  });
});
