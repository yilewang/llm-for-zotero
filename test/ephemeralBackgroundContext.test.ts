import { assert } from "chai";
import {
  EPHEMERAL_BACKGROUND_CONTEXT_LABEL,
  buildEphemeralBackgroundContextBlock,
  clearEphemeralBackgroundContextProvider,
  moveEphemeralBackgroundContextProvider,
  setEphemeralBackgroundContextProvider,
} from "../src/shared/ephemeralBackgroundContext";
import {
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
} from "../src/shared/conversationKeySpace";

describe("ephemeral background context", function () {
  it("labels the provider's text for an ephemeral key", function () {
    const key = allocateEphemeralPaperConversationKey();
    setEphemeralBackgroundContextProvider(key, () => "Q: hi\n\nA: hello");
    const block = buildEphemeralBackgroundContextBlock(key);
    assert.isTrue(block.startsWith(EPHEMERAL_BACKGROUND_CONTEXT_LABEL));
    assert.include(block, "Q: hi\n\nA: hello");
    clearEphemeralBackgroundContextProvider(key);
    assert.equal(buildEphemeralBackgroundContextBlock(key), "");
  });

  it("gives nothing for a real key, an empty provider, or a failing one", function () {
    setEphemeralBackgroundContextProvider(42, () => "never");
    assert.equal(buildEphemeralBackgroundContextBlock(42), "");
    const key = allocateEphemeralGlobalConversationKey();
    setEphemeralBackgroundContextProvider(key, () => "   ");
    assert.equal(buildEphemeralBackgroundContextBlock(key), "");
    setEphemeralBackgroundContextProvider(key, () => null);
    assert.equal(buildEphemeralBackgroundContextBlock(key), "");
    setEphemeralBackgroundContextProvider(key, () => {
      throw new Error("boom");
    });
    assert.equal(buildEphemeralBackgroundContextBlock(key), "");
    clearEphemeralBackgroundContextProvider(key);
  });

  it("moves with the side chat to its new key", function () {
    const oldKey = allocateEphemeralPaperConversationKey();
    const newKey = allocateEphemeralGlobalConversationKey();
    setEphemeralBackgroundContextProvider(oldKey, () => "main chat text");
    moveEphemeralBackgroundContextProvider(oldKey, newKey);
    assert.equal(buildEphemeralBackgroundContextBlock(oldKey), "");
    assert.include(
      buildEphemeralBackgroundContextBlock(newKey),
      "main chat text",
    );
    clearEphemeralBackgroundContextProvider(newKey);
  });
});
