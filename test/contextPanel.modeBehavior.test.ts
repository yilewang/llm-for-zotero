import { assert } from "chai";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import {
  filterManualPaperContextsAgainstAutoLoaded,
  resolveRuntimeModeForConversation,
} from "../src/modules/contextPanel/modeBehavior";

describe("contextPanel mode behavior", function () {
  const autoLoaded: PaperContextRef = {
    itemId: 10,
    contextItemId: 20,
    title: "Active Paper",
  };

  it("removes a manual paper context that duplicates the auto-loaded paper", function () {
    const unrelated: PaperContextRef = {
      itemId: 30,
      contextItemId: 40,
      title: "Other Paper",
    };

    assert.deepEqual(
      filterManualPaperContextsAgainstAutoLoaded(
        [{ ...autoLoaded, title: "Duplicate Active Paper" }, unrelated],
        autoLoaded,
      ),
      [unrelated],
    );
  });

  it("retains a different attachment for the same paper", function () {
    const secondAttachment: PaperContextRef = {
      itemId: 10,
      contextItemId: 21,
      title: "Active Paper",
      attachmentTitle: "Supplement",
    };

    assert.deepEqual(
      filterManualPaperContextsAgainstAutoLoaded(
        [secondAttachment],
        autoLoaded,
      ),
      [secondAttachment],
    );
  });

  it("retains unrelated paper contexts", function () {
    const unrelated: PaperContextRef = {
      itemId: 11,
      contextItemId: 20,
      title: "Different Paper",
    };

    assert.deepEqual(
      filterManualPaperContextsAgainstAutoLoaded([unrelated], autoLoaded),
      [unrelated],
    );
  });

  it("is agent for every built-in conversation when the feature is on", function () {
    assert.equal(
      resolveRuntimeModeForConversation({ agentModeEnabled: true }),
      "agent",
    );
  });

  it("is chat when the Agent feature is off", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        agentModeEnabled: false,
      }),
      "chat",
    );
  });

  it("forces webchat to chat", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        isWebChat: true,
        agentModeEnabled: true,
      }),
      "chat",
    );
  });

  it("ignores a cached per-conversation mode and the saved last-used mode", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "chat",
        lastUsedRuntimeMode: "chat",
        agentModeEnabled: true,
      } as never),
      "agent",
    );
  });

  it("forces Claude Code runtime conversations to agent", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        isRuntimeConversationSystem: true,
        runtimeConversationSystem: "claude_code",
        isWebChat: true,
        agentModeEnabled: false,
      }),
      "agent",
    );
  });

  it("keeps Codex runtime conversations in native chat mode", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        isRuntimeConversationSystem: true,
        runtimeConversationSystem: "codex",
        isWebChat: false,
        agentModeEnabled: true,
      }),
      "chat",
    );
  });
});
