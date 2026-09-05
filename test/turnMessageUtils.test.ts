import { assert } from "chai";
import {
  findTurnPairByTimestamps,
  cloneTurnMessageForUndo,
  collectAttachmentHashesFromMessages,
  filterMessagesInPendingTurns,
} from "../src/modules/contextPanel/turnMessageUtils";
import type { Message } from "../src/modules/contextPanel/types";
import {
  pendingDeletionStore,
  configurePendingDeletionFinalizers,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
} from "../src/core/conversations/pendingDeletionStore";

const HASH_A = "a".repeat(64);
const HASH_IMG = "b".repeat(64);

function message(role: "user" | "assistant", timestamp: number): Message {
  return { role, timestamp, text: `${role}@${timestamp}` } as Message;
}

describe("turnMessageUtils", function () {
  it("finds a user/assistant pair by floored timestamps", function () {
    const history = [
      message("user", 100),
      message("assistant", 200),
      message("user", 300),
      message("assistant", 400),
    ];
    const pair = findTurnPairByTimestamps(history, 300.7, 400.2);
    assert.isOk(pair);
    assert.equal(pair!.userIndex, 2);
    assert.equal(pair!.userMessage.timestamp, 300);
    assert.isNull(findTurnPairByTimestamps(history, 300, 999));
    assert.isNull(findTurnPairByTimestamps(history, 0, 400));
  });

  it("clone is deep for array fields", function () {
    const original = {
      role: "user",
      timestamp: 1,
      text: "hi",
      attachments: [{ contentHash: HASH_A, category: "file" }],
      selectedTexts: ["a"],
    } as unknown as Message;
    const clone = cloneTurnMessageForUndo(original);
    assert.notStrictEqual(clone.attachments, original.attachments);
    assert.notStrictEqual(clone.attachments![0], original.attachments![0]);
    assert.notStrictEqual(clone.selectedTexts, original.selectedTexts);
    assert.deepEqual(clone.attachments, original.attachments);
  });

  it("collects non-image attachment hashes uniquely", function () {
    const messages = [
      {
        role: "user",
        timestamp: 1,
        text: "",
        attachments: [
          { contentHash: HASH_A, category: "file" },
          { contentHash: HASH_A, category: "file" },
          { contentHash: HASH_IMG, category: "image" },
        ],
      },
    ] as unknown as Message[];
    const hashes = collectAttachmentHashesFromMessages(messages);
    assert.deepEqual(hashes, [HASH_A]);
  });
});

describe("filterMessagesInPendingTurns", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  beforeEach(async function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.trimStart().toUpperCase().startsWith("SELECT")) return [];
          return [];
        },
      },
    };
    configurePendingDeletionStoreEnv({
      now: () => 1_000_000,
      setTimer: () => ({}),
      clearTimer: () => {},
      log: () => {},
    });
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("returns the same array when no turn is pending", function () {
    const messages = [
      { role: "user", text: "a", timestamp: 1000 },
      { role: "assistant", text: "b", timestamp: 1001 },
    ];
    assert.strictEqual(filterMessagesInPendingTurns(5, messages), messages);
  });

  it("filters both messages of a queued turn, role-aware", async function () {
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 1000,
      assistantTimestamp: 1001,
    });
    const messages = [
      { role: "user", text: "a", timestamp: 1000 },
      { role: "assistant", text: "b", timestamp: 1001 },
      { role: "user", text: "same-ms", timestamp: 1001 },
      { role: "user", text: "keep", timestamp: 2000 },
      { role: "assistant", text: "keep2", timestamp: 2001 },
      { role: "assistant", text: "no-ts" } as {
        role: string;
        text: string;
        timestamp?: number;
      },
    ];
    const filtered = filterMessagesInPendingTurns(5, messages);
    assert.deepEqual(
      filtered.map((message) => message.text),
      ["same-ms", "keep", "keep2", "no-ts"],
    );
    const otherConversation = filterMessagesInPendingTurns(6, messages);
    assert.strictEqual(otherConversation, messages);
  });
});
