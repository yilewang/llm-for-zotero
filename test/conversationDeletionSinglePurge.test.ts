import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import {
  createAgentRun,
  ensureAgentTraceSchema,
  forgetAgentTraceRunIDsForDeletedConversation,
} from "../src/agent/store/traceStore";
import { finalizeConversationDeletion } from "../src/modules/contextPanel/conversationDeletion";
import { resetConversationCleanupJobsInitForTests } from "../src/core/conversations/conversationCleanupJobs";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * Deleting a conversation purges its agent rows and attachment refs once,
 * inside the store's deletion transaction (the shared deletion kernel).  The
 * panel's deletion flow used to run the same purge and attachment-ref delete
 * a second time in the kernel's onBeforeCommit; by then the rows were gone,
 * so every repeated statement matched nothing.
 */
describe("conversation deletion purges agent rows once", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  const touchedKeys: number[] = [];

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    // The Claude Code deletion queues its provider job in the new database.
    resetConversationCleanupJobsInitForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
  });

  afterEach(function () {
    for (const key of touchedKeys.splice(0)) {
      forgetAgentTraceRunIDsForDeletedConversation(key);
    }
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  /** The statements of the transaction that deleted the catalog row. */
  function deletionTransaction(from: number, catalog: string): string[] {
    const sqls = harness.statements
      .slice(from)
      .map((statement) => statement.sql.replace(/\s+/g, " ").trim());
    const catalogDelete = sqls.findIndex((sql) =>
      sql.startsWith(`DELETE FROM ${catalog} WHERE conversation_key = ?`),
    );
    assert.isAtLeast(catalogDelete, 0, "the catalog row was deleted");
    const begin = sqls.lastIndexOf("BEGIN", catalogDelete);
    const commit = sqls.indexOf("COMMIT", catalogDelete);
    assert.isAtLeast(begin, 0);
    assert.isAbove(commit, catalogDelete);
    return sqls.slice(begin, commit + 1);
  }

  const stores = [
    {
      system: "upstream" as const,
      init: () => upstream.initChatStore(),
      create: async () => upstream.createGlobalConversation(1),
      catalog: "llm_for_zotero_global_conversations",
    },
    {
      system: "claude_code" as const,
      init: () => claude.initClaudeCodeStore(),
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))!.conversationKey,
      catalog: "llm_for_zotero_claude_conversations",
    },
    {
      system: "codex" as const,
      init: () => codex.initCodexAppServerStore(),
      create: async () =>
        (await codex.createCodexGlobalConversation(1))!.conversationKey,
      catalog: "llm_for_zotero_codex_conversations",
    },
  ];

  for (const store of stores) {
    it(`${store.system}: one purge and one attachment-ref delete`, async function () {
      await store.init();
      await ensureAgentTraceSchema();
      const key = await store.create();
      touchedKeys.push(key);
      await createAgentRun({
        runId: "run-1",
        conversationKey: key,
        mode: "agent",
        status: "completed",
        createdAt: 1,
      } as Parameters<typeof createAgentRun>[0]);
      const [row] = harness.all(
        `SELECT conversation_instance_id AS instanceID, conversation_id AS conversationID
         FROM ${store.catalog} WHERE conversation_key = ?`,
        [key],
      );
      const from = harness.statements.length;
      await finalizeConversationDeletion(
        {
          conversationKey: key,
          libraryID: 1,
          kind: "global",
          conversationSystem: store.system,
          instanceID: String(row.instanceID),
          conversationID: String(row.conversationID),
        },
        { cancelPendingRequest: async () => {} },
      );
      const transaction = deletionTransaction(from, store.catalog);
      const count = (prefix: string) =>
        transaction.filter((sql) => sql.startsWith(prefix)).length;
      assert.equal(
        count("SELECT run_id AS runId FROM llm_for_zotero_agent_runs"),
        1,
        "the agent purge runs once",
      );
      assert.equal(
        count("DELETE FROM llm_for_zotero_agent_runs WHERE conversation_key"),
        1,
      );
      assert.equal(
        count("DELETE FROM llm_for_zotero_attachment_refs"),
        1,
        "the attachment refs are deleted once",
      );
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM llm_for_zotero_agent_runs WHERE conversation_key = ?`,
          [key],
        ),
        0,
        "the agent rows are gone",
      );
    });
  }
});
