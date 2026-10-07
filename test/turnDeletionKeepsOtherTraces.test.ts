import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import {
  appendAgentRunEvent,
  createAgentRun,
  ensureAgentTraceSchema,
  forgetAgentTraceRunIDsForDeletedConversation,
} from "../src/agent/store/traceStore";
import {
  initAgentChangeJournal,
  prepareJournalAction,
} from "../src/agent/store/changeJournal";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import { finalizeQueuedTurnDeletion } from "../src/modules/contextPanel/conversationDeletion";
import type { ConversationSystem } from "../src/shared/types";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * Deleting one turn used to delete the agent trace of every turn in the chat:
 * the purge deleted trace rows by conversation, and the cleanup after the
 * commit cleared every run of the conversation again. Only the runs the
 * deleted turn's rows name may go.
 */
describe("deleting one turn keeps the other turns' agent traces, plan documents and undo history", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  const touchedKeys: number[] = [];
  const systemOf = new Map<number, ConversationSystem>();

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

  function eventRunIDs(key: number): string[] {
    return harness
      .all(
        `SELECT DISTINCT e.run_id FROM llm_for_zotero_agent_run_events e
         WHERE e.run_id LIKE ? ORDER BY e.run_id`,
        [`%-${systemOf.get(key)}`],
      )
      .map((row) => String(row.run_id));
  }

  async function startRun(key: number, runId: string): Promise<void> {
    await createAgentRun({
      runId,
      conversationKey: key,
      mode: "agent",
      status: "completed",
      createdAt: 1,
    } as Parameters<typeof createAgentRun>[0]);
    await appendAgentRunEvent(runId, 1, {
      type: "status",
      text: `working on ${runId}`,
    } as Parameters<typeof appendAgentRunEvent>[2]);
  }

  const stores: Array<{
    system: ConversationSystem;
    init: () => Promise<unknown>;
    create: () => Promise<number>;
    append: (
      key: number,
      message: upstream.StoredChatMessage,
    ) => Promise<unknown>;
  }> = [
    {
      system: "upstream",
      init: () => upstream.initChatStore(),
      create: () => upstream.createGlobalConversation(1),
      append: (key, message) => upstream.appendMessage(key, message),
    },
    {
      system: "claude_code",
      init: () => claude.initClaudeCodeStore(),
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))!.conversationKey,
      append: (key, message) => claude.appendClaudeMessage(key, message),
    },
    {
      system: "codex",
      init: () => codex.initCodexAppServerStore(),
      create: async () =>
        (await codex.createCodexGlobalConversation(1))!.conversationKey,
      append: (key, message) => codex.appendCodexMessage(key, message),
    },
  ];

  it("only the deleted turn's run and events go, in every store", async function () {
    await ensureAgentTraceSchema();
    await initAgentChangeJournal();
    // The attachment-ref store creates its tables once per process, so an
    // earlier test's database may have had them; this one needs its own.
    harness.run(
      `CREATE TABLE IF NOT EXISTS llm_for_zotero_attachment_refs (
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_type, owner_id, blob_hash)
      )`,
    );
    for (const store of stores) {
      await store.init();
      const key = await store.create();
      touchedKeys.push(key);
      systemOf.set(key, store.system);
      // Two agent turns and one plain turn, each run named by its own rows.
      const turns: Array<[number, number, string | undefined]> = [
        [1_000, 2_000, `run-a-${store.system}`],
        [3_000, 4_000, `run-b-${store.system}`],
        [5_000, 6_000, undefined],
      ];
      for (const [userTs, assistantTs, runId] of turns) {
        await store.append(key, {
          role: "user",
          text: `q${userTs}`,
          timestamp: userTs,
          agentRunId: runId,
        } as upstream.StoredChatMessage);
        await store.append(key, {
          role: "assistant",
          text: `a${assistantTs}`,
          timestamp: assistantTs,
          agentRunId: runId,
        } as upstream.StoredChatMessage);
        if (runId) await startRun(key, runId);
      }
      const runA = `run-a-${store.system}`;
      const runB = `run-b-${store.system}`;
      assert.deepEqual(runIDs(key), [runA, runB]);

      const deleteTurn = (userTimestamp: number, assistantTimestamp: number) =>
        finalizeQueuedTurnDeletion(
          {
            id: `pd-${userTimestamp}`,
            kind: "turn",
            conversationKey: key,
            system: store.system,
            userTimestamp,
            assistantTimestamp,
            queuedAt: 1,
            expiresAt: 2,
            attempts: 0,
          },
          {
            detachProviderSession: async () => undefined,
          },
        );

      assert.isTrue(await deleteTurn(1_000, 2_000));
      assert.deepEqual(runIDs(key), [runB], "the other turn keeps its run");
      assert.deepEqual(eventRunIDs(key), [runB], "and its events");

      // A plain turn names no run, so it takes no trace with it.
      assert.isTrue(await deleteTurn(5_000, 6_000));
      assert.deepEqual(runIDs(key), [runB]);
      assert.deepEqual(eventRunIDs(key), [runB]);

      // The deleted run's mark was cleared after the commit, so a new run of
      // the conversation is kept.
      await startRun(key, `run-c-${store.system}`);
      assert.deepEqual(
        runIDs(key),
        [runB, `run-c-${store.system}`],
        store.system,
      );
    }
  });

  function journalRunIDs(key: number): string[] {
    return harness
      .all(
        `SELECT run_id FROM llm_for_zotero_agent_journal_actions_v2
         WHERE conversation_key = ? ORDER BY run_id`,
        [key],
      )
      .map((row) => String(row.run_id));
  }

  function ownedDocumentIDs(key: number): string[] {
    return harness
      .all(
        `SELECT document_id FROM llm_for_zotero_plan_document_owners
         WHERE conversation_key = ? ORDER BY document_id`,
        [key],
      )
      .map((row) => String(row.document_id));
  }

  function storedDocumentIDs(): string[] {
    return harness
      .all(
        `SELECT document_id FROM llm_for_zotero_plan_documents
         ORDER BY document_id`,
        [],
      )
      .map((row) => String(row.document_id));
  }

  it("only the deleted turn's undo history and plan documents go", async function () {
    await ensureAgentTraceSchema();
    await initAgentChangeJournal();
    await initPlanDocumentStore();
    harness.run(
      `CREATE TABLE IF NOT EXISTS llm_for_zotero_attachment_refs (
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_type, owner_id, blob_hash)
      )`,
    );
    await upstream.initChatStore();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    // Turn A names its own plan document; turns B and C share one.
    const turns: Array<[number, number, string, string]> = [
      [1_000, 2_000, "run-a", "doc-a"],
      [3_000, 4_000, "run-b", "doc-shared"],
      [5_000, 6_000, "run-c", "doc-shared"],
    ];
    for (const [userTs, assistantTs, runId, documentId] of turns) {
      await upstream.appendMessage(key, {
        role: "user",
        text: `q${userTs}`,
        timestamp: userTs,
        agentRunId: runId,
      } as upstream.StoredChatMessage);
      await upstream.appendMessage(key, {
        role: "assistant",
        text: `a${assistantTs}`,
        timestamp: assistantTs,
        agentRunId: runId,
        documentId,
      } as upstream.StoredChatMessage);
      await createAgentRun({
        runId,
        conversationKey: key,
        mode: "agent",
        status: "completed",
        createdAt: 1,
      } as Parameters<typeof createAgentRun>[0]);
      await prepareJournalAction({
        runId,
        conversationKey: key,
        toolName: "library_update",
        description: `change of ${runId}`,
        effect: "write",
        reversibility: "full",
      });
    }
    for (const [, assistantTs, , documentId] of turns) {
      harness.run(
        `INSERT OR IGNORE INTO llm_for_zotero_plan_document_owners
           (document_id, conversation_key, source_message_timestamp)
         VALUES (?, ?, ?)`,
        [documentId, key, assistantTs],
      );
      harness.run(
        `INSERT OR IGNORE INTO llm_for_zotero_plan_documents
           (document_id, origin_kind, conversation_key, content_hash,
            payload_json, created_at)
         VALUES (?, 'direct', ?, ?, '{}', 1)`,
        [documentId, key, `hash-${documentId}`],
      );
    }
    const deleteTurn = (userTimestamp: number, assistantTimestamp: number) =>
      finalizeQueuedTurnDeletion(
        {
          id: `pd-${userTimestamp}`,
          kind: "turn",
          conversationKey: key,
          system: "upstream",
          userTimestamp,
          assistantTimestamp,
          queuedAt: 1,
          expiresAt: 2,
          attempts: 0,
        },
        { detachProviderSession: async () => undefined },
      );

    assert.isTrue(await deleteTurn(1_000, 2_000));
    assert.deepEqual(journalRunIDs(key), ["run-b", "run-c"]);
    assert.deepEqual(ownedDocumentIDs(key), ["doc-shared"]);
    assert.deepEqual(storedDocumentIDs(), ["doc-shared"]);

    // Turn C still shows the shared document, so deleting turn B keeps it.
    assert.isTrue(await deleteTurn(3_000, 4_000));
    assert.deepEqual(journalRunIDs(key), ["run-c"]);
    assert.deepEqual(ownedDocumentIDs(key), ["doc-shared"]);
    assert.deepEqual(storedDocumentIDs(), ["doc-shared"]);

    // The last turn that names it takes it with it.
    assert.isTrue(await deleteTurn(5_000, 6_000));
    assert.deepEqual(journalRunIDs(key), []);
    assert.deepEqual(ownedDocumentIDs(key), []);
    assert.deepEqual(storedDocumentIDs(), []);
  });
});
