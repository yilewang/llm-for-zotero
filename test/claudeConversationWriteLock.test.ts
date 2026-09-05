import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  appendClaudeConversationMessageWithinWriteLock,
  invalidateClaudeConversationSession,
  invalidateClaudeConversationSessionWithinWriteLock,
  resetClaudeBridgeRuntime,
  updateLatestClaudeConversationAssistantMessageWithinWriteLock,
  updateLatestClaudeConversationUserMessageWithinWriteLock,
} from "../src/claudeCode/runtime";
import type { AgentRuntime } from "../src/agent/runtime";
import { CLAUDE_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import {
  resetConversationWriteFenceForTests,
  withConversationWriteLock,
} from "../src/shared/conversationWriteFence";

describe("Claude conversation write locking", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  const originalFetch = globalThis.fetch;

  afterEach(function () {
    resetConversationWriteFenceForTests();
    resetClaudeBridgeRuntime();
    globalScope.Zotero = originalZotero;
    globalThis.fetch = originalFetch;
  });

  it("persists Claude turns while the send path owns the write lock", async function () {
    const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 91;
    const queries: string[] = [];
    const summaryRow = {
      conversationID: "lfz:test:claude-write-lock",
      instanceID: "instance-claude-write-lock",
      conversationKey,
      libraryID: 1,
      kind: "global",
      paperItemID: null,
      createdAt: 100,
      updatedAt: 100,
      title: null,
      providerSessionId: null,
      scopedConversationKey: null,
      scopeType: null,
      scopeId: null,
      scopeLabel: null,
      cwd: null,
      modelName: null,
      effort: null,
      userTurnCount: 0,
    };
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          return sql.includes("FROM llm_for_zotero_claude_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
            ? [summaryRow]
            : [];
        },
        executeTransaction: async <T>(task: () => Promise<T>) => await task(),
      },
      debug: () => undefined,
      Profile: { dir: "/tmp/llm-for-zotero-claude-write-lock-test" },
      Utilities: { randomString: () => "write-lock-test" },
    };

    const completion = withConversationWriteLock(conversationKey, async () => {
      await appendClaudeConversationMessageWithinWriteLock(conversationKey, {
        role: "user",
        text: "initial question",
        timestamp: 200,
        modelName: "claude-sonnet-4-5",
      });
      await updateLatestClaudeConversationUserMessageWithinWriteLock(
        conversationKey,
        {
          text: "edited question",
          timestamp: 201,
        },
      );
      await updateLatestClaudeConversationAssistantMessageWithinWriteLock(
        conversationKey,
        {
          text: "answer",
          timestamp: 202,
          modelName: "claude-sonnet-4-5",
        },
      );
      return "completed";
    });
    const outcome = await Promise.race([
      completion,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 1_000),
      ),
    ]);

    assert.equal(
      outcome,
      "completed",
      "Claude persistence must not reacquire its caller's conversation lock",
    );
    assert.isTrue(
      queries.some((sql) =>
        sql.includes("INSERT INTO llm_for_zotero_claude_messages"),
      ),
      "the regression must exercise the real Claude message store",
    );
  });

  it("invalidates a Claude session without reacquiring its own write lock", async function () {
    const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 92;
    globalScope.Zotero = {
      DB: {
        queryAsync: async () => [],
      },
      Prefs: {
        get: () => "http://127.0.0.1:19787",
      },
      debug: () => undefined,
      Profile: { dir: "/tmp/llm-for-zotero-claude-invalidation-lock-test" },
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ invalidated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const completion = invalidateClaudeConversationSession({} as AgentRuntime, {
      conversationKey,
      metadata: {
        instanceID: "instance-claude-invalidation-lock",
        providerSessionId: "session-claude-invalidation-lock",
      },
    }).then(() => "completed");
    const outcome = await Promise.race([
      completion,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    assert.equal(
      outcome,
      "completed",
      "Claude invalidation must not reacquire the lock held by its runtime wrapper",
    );

    const callerOwnedKey = conversationKey + 1;
    const callerOwnedCompletion = withConversationWriteLock(
      callerOwnedKey,
      () =>
        invalidateClaudeConversationSessionWithinWriteLock({} as AgentRuntime, {
          conversationKey: callerOwnedKey,
          metadata: {
            instanceID: "instance-caller-owned-claude-invalidation-lock",
            providerSessionId: "session-caller-owned-claude-invalidation-lock",
          },
        }),
    ).then(() => "completed");
    const callerOwnedOutcome = await Promise.race([
      callerOwnedCompletion,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    assert.equal(
      callerOwnedOutcome,
      "completed",
      "callers that already own the lock must use the non-locking invalidation path",
    );
  });
});
