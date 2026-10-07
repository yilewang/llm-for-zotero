import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import {
  createAgentRun,
  ensureAgentTraceSchema,
  forgetAgentTraceRunIDsForDeletedConversation,
} from "../src/agent/store/traceStore";
import { purgeAgentConversation } from "../src/agent/store/agentConversationPurge";
import { finalizeQueuedTurnDeletion } from "../src/modules/contextPanel/conversationDeletion";
import { withAgentTurnPurge } from "../src/modules/contextPanel/agentConversationCleanup";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * F14: a deletion transaction that rolls back must not leave the agent
 * purge's "these runs were deleted" marker behind.  The marker exists so a
 * late run of a conversation being deleted is dropped; left behind after a
 * rollback, it drops every later agent run of the conversation (the run row
 * is deleted as soon as it is created, so its trace is lost).
 */
describe("a rolled-back agent purge keeps later agent runs", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  const touchedKeys: number[] = [];

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
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

  function runIDs(key: number): string[] {
    return harness
      .all(
        `SELECT run_id FROM llm_for_zotero_agent_runs
         WHERE conversation_key = ? ORDER BY run_id`,
        [key],
      )
      .map((row) => String(row.run_id));
  }

  async function startRun(key: number, runId: string): Promise<void> {
    await createAgentRun({
      runId,
      conversationKey: key,
      mode: "agent",
      status: "running",
      createdAt: 1,
    } as Parameters<typeof createAgentRun>[0]);
  }

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

  const stores = [
    {
      name: "upstream",
      init: () => upstream.initChatStore(),
      create: async () => upstream.createGlobalConversation(1),
      catalog: "llm_for_zotero_global_conversations",
      deleteLocalRows: (
        key: number,
        id: Parameters<typeof upstream.deleteUpstreamConversationLocalRows>[2],
      ) => upstream.deleteUpstreamConversationLocalRows(key, "global", id),
    },
    {
      name: "claude_code",
      init: () => claude.initClaudeCodeStore(),
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))!.conversationKey,
      catalog: "llm_for_zotero_claude_conversations",
      deleteLocalRows: (
        key: number,
        id: Parameters<typeof claude.deleteClaudeConversationLocalRows>[1],
      ) => claude.deleteClaudeConversationLocalRows(key, id),
    },
    {
      name: "codex",
      init: () => codex.initCodexAppServerStore(),
      create: async () =>
        (await codex.createCodexGlobalConversation(1))!.conversationKey,
      catalog: "llm_for_zotero_codex_conversations",
      deleteLocalRows: (
        key: number,
        id: Parameters<typeof codex.deleteCodexConversationLocalRows>[1],
      ) => codex.deleteCodexConversationLocalRows(key, id),
    },
  ];

  for (const store of stores) {
    it(`${store.name}: a conversation deletion that rolls back`, async function () {
      await store.init();
      await ensureAgentTraceSchema();
      const key = await store.create();
      touchedKeys.push(key);
      await startRun(key, "old-run");
      let failure = "";
      await store
        .deleteLocalRows(key, {
          ...identity(store.catalog, key),
          onCommit: async () => {
            throw new Error("simulated provider-job failure");
          },
        })
        .catch((error) => {
          failure = String(error);
        });
      assert.include(failure, "simulated provider-job failure");
      assert.deepEqual(runIDs(key), ["old-run"], "the rollback kept the run");
      await startRun(key, "new-run");
      assert.deepEqual(
        runIDs(key),
        ["new-run", "old-run"],
        "a later run of the conversation survives",
      );
    });
  }

  it("upstream: a queued turn deletion whose transaction rolls back", async function () {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    await upstream.appendMessage(key, {
      role: "user",
      text: "q",
      timestamp: 1_000,
      agentRunId: "old-run",
    } as upstream.StoredChatMessage);
    await upstream.appendMessage(key, {
      role: "assistant",
      text: "a",
      timestamp: 2_000,
      agentRunId: "old-run",
    } as upstream.StoredChatMessage);
    await startRun(key, "old-run");
    // Fail the turn deletion's transaction after its last statement (the
    // agent purge runs in its onBeforeCommit), so it rolls back.
    const db = globalScope.Zotero!.DB as {
      executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
    };
    const realTransaction = db.executeTransaction;
    let failNext = true;
    db.executeTransaction = (task) =>
      realTransaction(async () => {
        const result = await task();
        const purged = !runIDs(key).includes("old-run");
        if (failNext && purged) {
          failNext = false;
          throw new Error("simulated commit failure");
        }
        return result;
      });
    const outcome = await finalizeQueuedTurnDeletion({
      id: "pd-1",
      kind: "turn",
      conversationKey: key,
      system: "upstream",
      userTimestamp: 1_000,
      assistantTimestamp: 2_000,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
    });
    db.executeTransaction = realTransaction;
    assert.isFalse(outcome);
    assert.isFalse(failNext, "the turn deletion reached its purge");
    assert.deepEqual(runIDs(key), ["old-run"], "the rollback kept the run");
    await startRun(key, "new-run");
    assert.deepEqual(runIDs(key), ["new-run", "old-run"]);
  });

  it("an owner that rolls back undoes the purge it ran", async function () {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    await startRun(key, "old-run");
    const db = globalScope.Zotero!.DB as {
      executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
    };
    let failure = "";
    await withAgentTurnPurge(key, (onBeforeCommit) =>
      db.executeTransaction(async () => {
        await onBeforeCommit({
          agentRunIds: ["old-run", "stray-run"],
          documentIds: [],
        });
        throw new Error("simulated rollback");
      }),
    ).catch((error) => {
      failure = String(error);
    });
    assert.include(failure, "simulated rollback");
    await startRun(key, "new-run");
    assert.deepEqual(runIDs(key), ["new-run", "old-run"]);
  });

  it("a purge that fails part-way undoes its own marker", async function () {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    await startRun(key, "old-run");
    const db = globalScope.Zotero!.DB as {
      queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
      executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
    };
    const realQuery = db.queryAsync;
    db.queryAsync = async (sql, params) => {
      if (/DELETE FROM llm_for_zotero_agent_transcript/.test(sql)) {
        throw new Error("disk I/O error");
      }
      return realQuery(sql, params);
    };
    let failure = "";
    await db
      .executeTransaction(() =>
        purgeAgentConversation(key, { clearTaskProgress: () => {} }),
      )
      .catch((error) => {
        failure = String(error);
      });
    db.queryAsync = realQuery;
    assert.include(failure, "disk I/O error");
    await startRun(key, "new-run");
    assert.deepEqual(runIDs(key), ["new-run", "old-run"]);
  });

  it("a committed purge still drops a late run of the deleted conversation", async function () {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    await startRun(key, "old-run");
    const db = globalScope.Zotero!.DB as {
      executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
    };
    await db.executeTransaction(() =>
      purgeAgentConversation(key, { clearTaskProgress: () => {} }),
    );
    assert.deepEqual(runIDs(key), []);
    await startRun(key, "late-run");
    assert.deepEqual(runIDs(key), [], "the marker drops the late run");
  });

  it("a rolled-back purge after a committed one puts the earlier mark back", async function () {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    await startRun(key, "old-run");
    const db = globalScope.Zotero!.DB as {
      executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
    };
    await db.executeTransaction(() =>
      purgeAgentConversation(key, { clearTaskProgress: () => {} }),
    );
    // A row written past the mark (as a stale writer could), so the second
    // purge has a run to mark and its rollback has a mark to undo.
    harness.run(
      `INSERT INTO llm_for_zotero_agent_runs
         (run_id, conversation_key, mode, status, created_at)
       VALUES ('stray-run', ?, 'agent', 'completed', 2)`,
      [key],
    );
    let failure = "";
    await withAgentTurnPurge(key, (onBeforeCommit) =>
      db.executeTransaction(async () => {
        await onBeforeCommit({
          agentRunIds: ["old-run", "stray-run"],
          documentIds: [],
        });
        throw new Error("simulated rollback");
      }),
    ).catch((error) => {
      failure = String(error);
    });
    assert.include(failure, "simulated rollback");
    assert.deepEqual(runIDs(key), ["stray-run"], "the rollback kept the row");
    await startRun(key, "late-run");
    assert.deepEqual(
      runIDs(key),
      ["stray-run"],
      "the first purge's mark still drops a late run",
    );
  });
});
