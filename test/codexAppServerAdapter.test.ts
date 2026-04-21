import { assert } from "chai";
import {
  CodexAppServerAdapter,
  shouldResetCodexAppServerThreadOnError,
} from "../src/agent/model/codexAppServer";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("CodexAppServerAdapter", function () {
  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_app_server",
      ...overrides,
    };
  }

  it("advertises tool-calling support for agent runtime requests", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.supportsTools(request));
    assert.isTrue(adapter.getCapabilities(request).toolCalls);
  });

  it("advertises multimodal support for non-text-only models", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.getCapabilities(request).multimodal);
  });

  it("keeps thread state for recoverable adapter errors", function () {
    assert.isFalse(
      shouldResetCodexAppServerThreadOnError(
        new Error("Turn ended with status: failed"),
      ),
    );
  });

  it("resets thread state when the app-server session becomes unusable", function () {
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error(
          "Timed out waiting for codex app-server turn completion after 60000ms",
        ),
      ),
    );
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error("codex app-server process closed unexpectedly"),
      ),
    );
  });
});
