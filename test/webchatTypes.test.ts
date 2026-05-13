import { assert } from "chai";
import {
  getWebChatTargetByModelName,
  getWebChatTargetDisplayName,
} from "../src/webchat/types";

describe("webchat target types", function () {
  it("keeps canonical host model names separate from compact display names", function () {
    assert.equal(
      getWebChatTargetByModelName("chatgpt.com")?.modelName,
      "chatgpt.com",
    );
    assert.equal(
      getWebChatTargetByModelName("chat.deepseek.com")?.modelName,
      "chat.deepseek.com",
    );

    assert.equal(getWebChatTargetDisplayName("chatgpt.com"), "chatgpt");
    assert.equal(getWebChatTargetDisplayName("chat.deepseek.com"), "deepseek");
  });
});
