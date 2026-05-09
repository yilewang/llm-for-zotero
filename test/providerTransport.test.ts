import { assert } from "chai";
import {
  resolveAnthropicMessagesEndpoint,
  resolveProviderTransportEndpoint,
} from "../src/utils/providerTransport";

describe("providerTransport", function () {
  it("maps MiniMax between Anthropic and OpenAI compatible bases", function () {
    assert.equal(
      resolveProviderTransportEndpoint({
        protocol: "openai_chat_compat",
        apiBase: "https://api.minimax.io/anthropic",
      }),
      "https://api.minimax.io/v1/chat/completions",
    );
    assert.equal(
      resolveAnthropicMessagesEndpoint("https://api.minimax.io/v1"),
      "https://api.minimax.io/anthropic/v1/messages",
    );
  });

  it("maps GLM between Anthropic and OpenAI compatible bases", function () {
    assert.equal(
      resolveProviderTransportEndpoint({
        protocol: "openai_chat_compat",
        apiBase: "https://open.bigmodel.cn/api/anthropic",
      }),
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    assert.equal(
      resolveAnthropicMessagesEndpoint("https://open.bigmodel.cn/api/paas/v4"),
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
    assert.equal(
      resolveAnthropicMessagesEndpoint(
        "https://open.bigmodel.cn/api/coding/paas/v4",
      ),
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });
});
