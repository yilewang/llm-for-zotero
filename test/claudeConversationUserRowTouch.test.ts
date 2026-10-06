import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import * as claude from "../src/claudeCode/store";
import { updateLatestClaudeConversationUserMessageWithinWriteLock } from "../src/claudeCode/runtime";
import type { StoredChatMessage } from "../src/utils/chatStore";
import {
  FIXED_STORE_CLOCK_MS,
  installFixedClock,
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * The Claude Code runtime wrapper touches the catalog after a user-row write,
 * with the message's timestamp. The touch is not monotonic, so an exact-row
 * write (a retry's write-back) that finds no row must not touch it: that
 * would move the conversation's activity time back to an older turn.
 */

const LIBRARY_ID = 1;
const CATALOG = "llm_for_zotero_claude_conversations";

function at(offsetSeconds: number): number {
  return FIXED_STORE_CLOCK_MS + offsetSeconds * 1000;
}

function plain(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
): StoredChatMessage {
  return { role, text, timestamp } as StoredChatMessage;
}

describe("Claude Code user-row write and the catalog touch", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  let restoreClock: () => void;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
    restoreClock = installFixedClock();
  });

  afterEach(function () {
    restoreClock();
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  async function seededConversation(): Promise<number> {
    await claude.initClaudeCodeStore();
    const summary = await claude.createClaudeGlobalConversation(LIBRARY_ID);
    assert.ok(summary, "the Claude store created no conversation");
    const key = summary!.conversationKey;
    await claude.appendClaudeMessage(key, plain("user", "u1", at(1)));
    await claude.appendClaudeMessage(key, plain("assistant", "a1", at(2)));
    await claude.appendClaudeMessage(key, plain("user", "u2", at(3)));
    await claude.appendClaudeMessage(key, plain("assistant", "a2", at(4)));
    return key;
  }

  function catalogRow(key: number) {
    const [row] = harness.all(
      `SELECT updated_at, last_activity_at FROM ${CATALOG}
       WHERE conversation_key = ?`,
      [key],
    );
    return row;
  }

  function catalogWrites(from: number): string[] {
    return harness.statements
      .slice(from)
      .map((statement) => statement.sql.replace(/\s+/g, " ").trim())
      .filter((sql) =>
        new RegExp(`^(UPDATE|INSERT[A-Z ]*INTO) ${CATALOG}\\b`, "i").test(sql),
      );
  }

  it("an exact-row write that finds no row leaves the catalog untouched", async function () {
    const key = await seededConversation();
    const before = catalogRow(key);
    const from = harness.statements.length;

    await updateLatestClaudeConversationUserMessageWithinWriteLock(
      key,
      plain("user", "never written", at(1)),
      { expectedTimestamp: at(9) },
    );

    assert.deepEqual(catalogRow(key), before, "activity time unchanged");
    assert.deepEqual(catalogWrites(from), [], "no catalog touch ran");
    assert.deepEqual(
      harness
        .all(
          `SELECT text FROM llm_for_zotero_claude_messages
           WHERE conversation_key = ? ORDER BY id`,
          [key],
        )
        .map((row) => row.text),
      ["u1", "a1", "u2", "a2"],
    );
  });

  it("an exact-row write that finds its row still touches the catalog", async function () {
    const key = await seededConversation();
    const from = harness.statements.length;

    await updateLatestClaudeConversationUserMessageWithinWriteLock(
      key,
      plain("user", "u1-restored", at(1)),
      { expectedTimestamp: at(1) },
    );

    // The touch writes the message's own timestamp, as it always has.
    assert.isNotEmpty(catalogWrites(from), "the catalog touch ran");
    assert.equal(catalogRow(key).updated_at, at(1));
  });
});
