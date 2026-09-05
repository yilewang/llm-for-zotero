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

  it("defaults paper chat to chat even when agent mode is enabled", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        agentModeEnabled: true,
        displayConversationKind: "paper",
      }),
      "chat",
    );
  });

  it("defaults library chat to agent when agent mode is enabled", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        agentModeEnabled: true,
        displayConversationKind: "global",
      }),
      "agent",
    );
  });

  it("defaults note-editing sessions to agent when agent mode is enabled", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        agentModeEnabled: true,
        displayConversationKind: "global",
        noteKind: "standalone",
      }),
      "agent",
    );
    assert.equal(
      resolveRuntimeModeForConversation({
        agentModeEnabled: true,
        displayConversationKind: "paper",
        noteKind: "item",
      }),
      "agent",
    );
  });

  it("forces webchat to chat without changing cached intent", function () {
    const cachedMode = "agent" as const;

    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode,
        isWebChat: true,
        agentModeEnabled: true,
        displayConversationKind: "global",
      }),
      "chat",
    );
    assert.equal(cachedMode, "agent");
  });

  it("uses explicit cached user choices over defaults", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "chat",
        agentModeEnabled: true,
        displayConversationKind: "global",
      }),
      "chat",
    );
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "agent",
        agentModeEnabled: true,
        displayConversationKind: "paper",
      }),
      "agent",
    );
  });

  it("forces Claude Code runtime conversations to agent", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "chat",
        isRuntimeConversationSystem: true,
        runtimeConversationSystem: "claude_code",
        isWebChat: true,
        agentModeEnabled: false,
        displayConversationKind: "paper",
      }),
      "agent",
    );
  });

  it("keeps Codex runtime conversations in native chat mode", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "agent",
        isRuntimeConversationSystem: true,
        runtimeConversationSystem: "codex",
        isWebChat: false,
        agentModeEnabled: true,
        displayConversationKind: "global",
      }),
      "chat",
    );
  });

  it("falls back to the sticky last used mode for paper conversations", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: true,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: "agent",
      }),
      "agent",
    );
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: true,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: "chat",
      }),
      "chat",
    );
  });

  it("keeps chat for paper conversations when no sticky mode was ever chosen", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: true,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: null,
      }),
      "chat",
    );
  });

  it("lets the per-conversation choice win over the sticky mode", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "chat",
        agentModeEnabled: true,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: "agent",
      }),
      "chat",
    );
  });

  it("keeps notes and global conversations on agent even when the sticky mode is chat", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: true,
        displayConversationKind: "global",
        lastUsedRuntimeMode: "chat",
      }),
      "agent",
    );
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: true,
        displayConversationKind: "paper",
        noteKind: "standalone",
        lastUsedRuntimeMode: "chat",
      }),
      "agent",
    );
  });

  it("never resurrects agent mode from the sticky mode while the feature is off", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        agentModeEnabled: false,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: "agent",
      }),
      "chat",
    );
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: null,
        isWebChat: true,
        agentModeEnabled: true,
        displayConversationKind: "paper",
        lastUsedRuntimeMode: "agent",
      }),
      "chat",
    );
  });
});
