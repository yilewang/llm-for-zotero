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

  it("forces Codex and Claude Code conversation systems to agent", function () {
    assert.equal(
      resolveRuntimeModeForConversation({
        cachedMode: "chat",
        isRuntimeConversationSystem: true,
        isWebChat: true,
        agentModeEnabled: false,
        displayConversationKind: "paper",
      }),
      "agent",
    );
  });
});
