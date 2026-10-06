import { assert } from "chai";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import { getCodexProfileSignature } from "../src/codexAppServer/constants";
import { resolveConversationScopeToken } from "../src/agent/mcp/server";
import { conversationRepository } from "../src/core/conversations/repository";
import { resetConversationCleanupJobsInitForTests } from "../src/core/conversations/conversationCleanupJobs";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * What the runtime store adapters add to a deletion, against real SQLite:
 * Codex releases the conversation's MCP scope token after either deletion
 * path, and a Claude Code scope alone is enough to queue the Claude provider
 * cleanup job (a Codex scope is not).
 */
describe("conversation repository: runtime store adapters on deletion", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    resetConversationCleanupJobsInitForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  function identity(table: string, key: number) {
    const [row] = harness.all(
      `SELECT conversation_instance_id AS instanceID, conversation_id AS conversationID
       FROM ${table} WHERE conversation_key = ?`,
      [key],
    );
    return {
      instanceID: String(row.instanceID),
      conversationID: String(row.conversationID),
    };
  }

  function cleanupJobs(key: number): Array<Record<string, unknown>> {
    try {
      return harness.all(
        `SELECT operation, system, provider_session_id AS providerSessionId
         FROM llm_for_zotero_conversation_cleanup_jobs
         WHERE conversation_key = ?`,
        [key],
      );
    } catch {
      return [];
    }
  }

  it("Codex releases the scope token after the local-row deletion", async function () {
    await codex.initCodexAppServerStore();
    const key = (await codex.createCodexGlobalConversation(1))!.conversationKey;
    const id = identity("llm_for_zotero_codex_conversations", key);
    const tokenParams = {
      profileSignature: getCodexProfileSignature(),
      conversationKey: key,
      instanceID: id.instanceID,
    };
    const before = resolveConversationScopeToken(tokenParams);
    assert.equal(resolveConversationScopeToken(tokenParams), before);
    await conversationRepository.deleteLocalConversationRows({
      system: "codex",
      kind: "global",
      conversationKey: key,
      ...id,
    });
    assert.notEqual(
      resolveConversationScopeToken(tokenParams),
      before,
      "the deleted conversation's token was released",
    );
  });

  it("Codex releases the scope token after the legacy deletion", async function () {
    await codex.initCodexAppServerStore();
    const key = (await codex.createCodexGlobalConversation(1))!.conversationKey;
    const tokenParams = {
      profileSignature: getCodexProfileSignature(),
      conversationKey: key,
    };
    const before = resolveConversationScopeToken(tokenParams);
    // No instance witness: the pre-ledger deletion path.
    await conversationRepository.deleteCatalogEntry({
      system: "codex",
      kind: "global",
      conversationKey: key,
    });
    assert.lengthOf(
      harness.all(
        `SELECT 1 FROM llm_for_zotero_codex_conversations WHERE conversation_key = ?`,
        [key],
      ),
      0,
    );
    assert.notEqual(
      resolveConversationScopeToken(tokenParams),
      before,
      "the legacy deletion released the key-only token",
    );
  });

  it("a Claude Code scope without a session queues the Claude cleanup job", async function () {
    await claude.initClaudeCodeStore();
    const key = (await claude.createClaudeGlobalConversation(1))!
      .conversationKey;
    await conversationRepository.deleteLocalConversationRows({
      system: "claude_code",
      kind: "global",
      conversationKey: key,
      libraryID: 1,
      providerScope: { scopeType: "open", scopeId: "library-1" },
      ...identity("llm_for_zotero_claude_conversations", key),
    });
    assert.deepEqual(cleanupJobs(key), [
      {
        operation: "claude_invalidate",
        system: "claude_code",
        providerSessionId: "",
      },
    ]);
  });

  it("a Codex scope without a session queues no cleanup job", async function () {
    await codex.initCodexAppServerStore();
    const key = (await codex.createCodexGlobalConversation(1))!.conversationKey;
    await conversationRepository.deleteLocalConversationRows({
      system: "codex",
      kind: "global",
      conversationKey: key,
      libraryID: 1,
      providerScope: { scopeType: "open", scopeId: "library-1" },
      ...identity("llm_for_zotero_codex_conversations", key),
    });
    assert.deepEqual(cleanupJobs(key), []);
  });
});
