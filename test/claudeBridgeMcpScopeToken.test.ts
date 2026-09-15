import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  invalidateClaudeConversationSession,
  resetClaudeBridgeRuntime,
} from "../src/claudeCode/runtime";
import { resolveClaudeBridgeMcpScopeToken } from "../src/agent/externalBackendBridge";
import { resolveConversationScopeToken } from "../src/agent/mcp/server";
import { getClaudeProfileSignature } from "../src/claudeCode/projectSkills";
import type { AgentRuntime } from "../src/agent/runtime";
import { CLAUDE_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import { resetConversationWriteFenceForTests } from "../src/shared/conversationWriteFence";

describe("Claude bridge MCP scope token", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 73;
  const otherConversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 74;

  beforeEach(function () {
    globalScope.Zotero = {
      Profile: { dir: "/tmp/lfz-claude-bridge-scope-profile" },
      Prefs: { get: () => "" },
      DB: { queryAsync: async () => [] },
    };
  });

  afterEach(function () {
    resetConversationWriteFenceForTests();
    resetClaudeBridgeRuntime();
    globalScope.Zotero = originalZotero;
  });

  it("keeps the bridge turn scope token stable for one conversation", function () {
    const profileSignature = getClaudeProfileSignature();
    const request = {
      conversationKey,
      metadata: { conversationInstanceID: "instance-bridge-scope" },
    };
    const firstTurn = resolveClaudeBridgeMcpScopeToken(
      request,
      profileSignature,
    );
    const secondTurn = resolveClaudeBridgeMcpScopeToken(
      request,
      profileSignature,
    );
    assert.equal(firstTurn, secondTurn);
    assert.equal(
      firstTurn,
      resolveConversationScopeToken({
        profileSignature,
        conversationKey,
        instanceID: "instance-bridge-scope",
      }),
    );
  });

  it("separates tokens by conversation and instance identity", function () {
    const profileSignature = getClaudeProfileSignature();
    const legacyLane = resolveClaudeBridgeMcpScopeToken(
      { conversationKey, metadata: {} },
      profileSignature,
    );
    const instanceLane = resolveClaudeBridgeMcpScopeToken(
      { conversationKey, metadata: { conversationInstanceID: "inst-a" } },
      profileSignature,
    );
    const otherConversation = resolveClaudeBridgeMcpScopeToken(
      { conversationKey: otherConversationKey, metadata: {} },
      profileSignature,
    );
    assert.notEqual(legacyLane, instanceLane);
    assert.notEqual(legacyLane, otherConversation);
    assert.notEqual(instanceLane, otherConversation);
  });

  it("releases the stable token when the Claude session is invalidated", async function () {
    const profileSignature = getClaudeProfileSignature();
    const request = {
      conversationKey,
      metadata: {
        conversationInstanceID: "instance-bridge-scope",
        providerSessionId: "sess-bridge-scope",
      },
    };
    const beforeInvalidation = resolveClaudeBridgeMcpScopeToken(
      request,
      profileSignature,
    );
    await invalidateClaudeConversationSession(null as unknown as AgentRuntime, {
      conversationKey,
      metadata: {
        instanceID: "instance-bridge-scope",
        providerSessionId: "sess-bridge-scope",
      },
    });
    const afterInvalidation = resolveClaudeBridgeMcpScopeToken(
      request,
      profileSignature,
    );
    assert.notEqual(afterInvalidation, beforeInvalidation);
  });
});
