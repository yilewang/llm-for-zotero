import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

describe("live provider transport acceptance", function () {
  this.timeout(240000);

  it("answers synthetic prompts through chat, streaming, and agent adapters", async function () {
    const credentials = await resolveLiveAgentCredentials();
    assert.isOk(
      credentials,
      "Configure the requested model in the explicitly selected test profile; this test must not silently skip.",
    );
    assert.include(
      ["openai_chat_compat", "anthropic_messages", "responses_api"],
      credentials!.providerProtocol,
    );
    // The harness passes only 'Say OK', empty history, and no tools to the
    // adapters. It does not run the agent context builder or retrieve library data.
    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    const result = await api.checkProviderConversationTransport({
      ...credentials!,
      providerProtocol: credentials!.providerProtocol as
        | "openai_chat_compat"
        | "anthropic_messages"
        | "responses_api",
      conversationKey: -43900916,
    });
    for (const [path, text] of Object.entries(result)) {
      assert.isNotEmpty(text.trim(), `${path} must return a model answer`);
    }
  });
});
