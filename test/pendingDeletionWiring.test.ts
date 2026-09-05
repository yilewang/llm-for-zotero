import { assert } from "chai";
import {
  configurePendingDeletionSubsystem,
  resetPendingDeletionSubsystemForTests,
} from "../src/modules/contextPanel/pendingDeletionWiring";
import {
  pendingDeletionStore,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
} from "../src/core/conversations/pendingDeletionStore";
import { chatHistory } from "../src/modules/contextPanel/state";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

describe("pendingDeletionWiring", function () {
  afterEach(function () {
    resetPendingDeletionStoreForTests();
    resetPendingDeletionSubsystemForTests();
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
  });

  it("registers finalizers so a swept turn row deletes for real", async function () {
    const queries: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          if (
            sql.trimStart().toUpperCase().startsWith("SELECT") &&
            sql.includes("llm_for_zotero_pending_deletions")
          ) {
            return [
              {
                id: "pd-x",
                kind: "turn",
                conversation_id: null,
                conversation_key: 5,
                system: "upstream",
                payload: JSON.stringify({
                  userTimestamp: 100,
                  assistantTimestamp: 200,
                }),
                queued_at: 1,
                expires_at: 2,
                attempts: 0,
              },
            ];
          }
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
      Prefs: { get: () => undefined, set: () => {} },
    };
    configurePendingDeletionStoreEnv({
      now: () => 10,
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {},
    });
    configurePendingDeletionSubsystem();
    await pendingDeletionStore.sweepAllPersisted("startup");
    assert.isTrue(
      queries.some(
        (sql) => sql.includes("DELETE") && sql.includes("chat_messages"),
      ),
      `expected a chat_messages delete, got: ${queries.join(" | ")}`,
    );
    assert.isTrue(
      queries.some((sql) =>
        sql.includes("DELETE FROM llm_for_zotero_pending_deletions"),
      ),
    );
  });
});
