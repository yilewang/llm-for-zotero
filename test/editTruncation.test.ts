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
 * transaction also purges the conversation's agent rows, because agent state
 * is keyed by the conversation, not by the deleted message rows.
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
      await upstream.appendMessage(key, {
        role,
        text: `${role}-${index}`,
        timestamp: 1_000 * (index + 1),
      } as upstream.StoredChatMessage);
    }
    await createAgentRun({
      runId: "run-1",
      conversationKey: key,
      mode: "agent",
      status: "completed",
      createdAt: 1,
    } as Parameters<typeof createAgentRun>[0]);
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
    assert.deepEqual(runIDs(key), [], "the agent rows were purged");
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
    assert.deepEqual(runIDs(key), ["run-1"]);
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
