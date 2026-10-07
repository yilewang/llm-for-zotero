import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as upstream from "../src/utils/chatStore";
import {
  createAgentRun,
  ensureAgentTraceSchema,
  forgetAgentTraceRunIDsForDeletedConversation,
} from "../src/agent/store/traceStore";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import { deleteTrailingTurnPairs } from "../src/modules/contextPanel/editTruncation";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * Edit and retry deletes the stored turns after the edited one.  Each pair's
 * transaction also purges the trace of the runs that pair's rows name; the
 * turns before the edited one keep their traces.
 */
describe("edit truncation deletes the trailing turns and their agent rows", function () {
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

  function messageTexts(key: number): string[] {
    return harness
      .all(
        `SELECT text FROM llm_for_zotero_chat_messages
         WHERE conversation_key = ? ORDER BY id`,
        [key],
      )
      .map((row) => String(row.text));
  }

  function runIDs(key: number): string[] {
    return harness
      .all(
        `SELECT run_id FROM llm_for_zotero_agent_runs
         WHERE conversation_key = ? ORDER BY run_id`,
        [key],
      )
      .map((row) => String(row.run_id));
  }

  async function seedConversation(): Promise<number> {
    await upstream.initChatStore();
    await ensureAgentTraceSchema();
    const key = await upstream.createGlobalConversation(1);
    touchedKeys.push(key);
    for (const [index, role] of [
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ].entries()) {
      // Each turn's rows name that turn's own run.
      const runId = `run-${Math.floor(index / 2)}`;
      await upstream.appendMessage(key, {
        role,
        text: `${role}-${index}`,
        timestamp: 1_000 * (index + 1),
        agentRunId: runId,
      } as upstream.StoredChatMessage);
      if (role === "user") {
        await createAgentRun({
          runId,
          conversationKey: key,
          mode: "agent",
          status: "completed",
          createdAt: 1,
        } as Parameters<typeof createAgentRun>[0]);
      }
    }
    return key;
  }

  it("deletes each trailing pair and purges the agent rows", async function () {
    const key = await seedConversation();
    const ok = await deleteTrailingTurnPairs({
      conversationKey: key,
      pairs: [
        { userTs: 3_000, assistantTs: 4_000 },
        { userTs: 5_000, assistantTs: 6_000 },
      ],
      conversationGeneration: getConversationWriteGeneration(key),
      conversationSystem: "upstream",
    });
    assert.isTrue(ok);
    assert.deepEqual(messageTexts(key), ["user-0", "assistant-1"]);
    assert.deepEqual(
      runIDs(key),
      ["run-0"],
      "only the deleted turns' runs were purged",
    );
    await createAgentRun({
      runId: "next-run",
      conversationKey: key,
      mode: "agent",
      status: "running",
      createdAt: 2,
    } as Parameters<typeof createAgentRun>[0]);
    assert.deepEqual(
      runIDs(key),
      ["next-run", "run-0"],
      "a later agent run of the conversation survives",
    );
  });

  it("stops without deleting when the conversation changed", async function () {
    const key = await seedConversation();
    const ok = await deleteTrailingTurnPairs({
      conversationKey: key,
      pairs: [{ userTs: 3_000, assistantTs: 4_000 }],
      conversationGeneration: getConversationWriteGeneration(key) + 1,
      conversationSystem: "upstream",
    });
    assert.isFalse(ok);
    assert.lengthOf(messageTexts(key), 6);
    assert.deepEqual(runIDs(key), ["run-0", "run-1", "run-2"]);
  });

  it("a later pair that fails does not leave the committed purge's mark behind", async function () {
    const key = await seedConversation();
    // Fail the second pair's delete, after the first pair has committed.
    const db = globalScope.Zotero!.DB as {
      queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const realQuery = db.queryAsync;
    db.queryAsync = async (sql, params = []) => {
      if (
        sql
          .trimStart()
          .startsWith("DELETE FROM llm_for_zotero_chat_messages") &&
        params.includes(5_000)
      ) {
        throw new Error("simulated write failure");
      }
      return realQuery(sql, params);
    };
    const ok = await deleteTrailingTurnPairs({
      conversationKey: key,
      pairs: [
        { userTs: 3_000, assistantTs: 4_000 },
        { userTs: 5_000, assistantTs: 6_000 },
      ],
      conversationGeneration: getConversationWriteGeneration(key),
      conversationSystem: "upstream",
    });
    db.queryAsync = realQuery;
    assert.isFalse(ok);
    assert.deepEqual(
      messageTexts(key),
      ["user-0", "assistant-1", "user-4", "assistant-5"],
      "the first pair committed, the second rolled back",
    );
    assert.deepEqual(
      runIDs(key),
      ["run-0", "run-2"],
      "the committed purge removed only its turn's run",
    );
    await createAgentRun({
      runId: "next-run",
      conversationKey: key,
      mode: "agent",
      status: "running",
      createdAt: 2,
    } as Parameters<typeof createAgentRun>[0]);
    assert.deepEqual(
      runIDs(key),
      ["next-run", "run-0", "run-2"],
      "a later agent run of the conversation survives",
    );
  });

  it("is what editUserTurnAndRetry uses for the trailing turns", function () {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function editUserTurnAndRetry");
    assert.isAtLeast(start, 0);
    const end = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);
    assert.include(body, "deleteTrailingTurnPairs(");
    assert.notInclude(
      body,
      "conversationRepository.deleteTurnMessages(",
      "the edit path deletes stored turns only through the helper",
    );
  });
});
