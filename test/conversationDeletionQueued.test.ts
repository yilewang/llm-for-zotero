import { assert } from "chai";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
} from "../src/modules/contextPanel/conversationDeletion";
import { chatHistory } from "../src/modules/contextPanel/state";
import type { Message } from "../src/modules/contextPanel/types";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

function message(role: "user" | "assistant", timestamp: number): Message {
  return { role, timestamp, text: `${role}@${timestamp}` } as Message;
}

describe("finalizeQueuedTurnDeletion", function () {
  afterEach(function () {
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
  });

  it("deletes rows, drops the loaded in-memory pair, and reports success", async function () {
    const queries: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    chatHistory.set(5, [
      message("user", 100),
      message("assistant", 200),
      message("user", 300),
      message("assistant", 400),
    ]);
    const ok = await finalizeQueuedTurnDeletion({
      id: "pd-1",
      kind: "turn",
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
    });
    assert.isTrue(ok);
    const remaining = chatHistory.get(5)!;
    assert.lengthOf(remaining, 2);
    assert.equal(remaining[0].timestamp, 300);
    assert.isTrue(
      queries.some((sql) => sql.includes("DELETE")),
      `expected a DELETE, got: ${queries.join(" | ")}`,
    );
    assert.isTrue(
      queries.some((sql) => sql.includes("llm_for_zotero_agent_transcript")),
      "turn deletion must purge the durable agent transcript boundary",
    );
  });

  it("returns false when the DB delete throws, leaving memory untouched", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("DELETE")) throw new Error("locked");
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    chatHistory.set(5, [message("user", 100), message("assistant", 200)]);
    const ok = await finalizeQueuedTurnDeletion({
      id: "pd-2",
      kind: "turn",
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
    });
    assert.isFalse(ok);
    assert.lengthOf(chatHistory.get(5)!, 2);
  });
});

describe("finalizeQueuedConversationDeletion stale-intent guards", function () {
  afterEach(function () {
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
  });

  function baseEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "pd-c1",
      kind: "conversation" as const,
      conversationKind: "global" as const,
      conversationKey: 2_000_000_777,
      libraryID: 1,
      system: "upstream" as const,
      instanceID: "instance-original",
      title: "Chat",
      wasActive: false,
      queuedAt: 1_000,
      // Identity witness captured when the deletion was queued. The catalog
      // row's createdAt must still match this exactly at finalize time.
      catalogCreatedAt: 500,
      expiresAt: 7_000,
      attempts: 0,
      ...overrides,
    };
  }

  // Builds a Zotero.DB stub whose catalog SELECT returns one global-conversation
  // row (or none), recording every destructive statement it is asked to run.
  function installDb(options: {
    catalogRow?: {
      conversationID?: string;
      createdAt: number;
    } | null;
    catalogThrows?: boolean;
    registryRows?: () => unknown[];
    destructive: string[];
  }) {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          const isSelect = sql.trimStart().toUpperCase().startsWith("SELECT");
          if (sql.includes("llm_for_zotero_conversation_registry")) {
            if (isSelect) return options.registryRows?.() ?? [];
            return [];
          }
          if (isSelect && sql.includes("llm_for_zotero_global_conversations")) {
            if (options.catalogThrows) throw new Error("db locked");
            if (!options.catalogRow) return [];
            return [
              {
                conversationID: options.catalogRow.conversationID ?? "",
                conversationKey: 2_000_000_777,
                libraryID: 1,
                sessionVersion: 1,
                createdAt: options.catalogRow.createdAt,
                title: "Chat",
                lastActivityAt: options.catalogRow.createdAt + 10,
                userTurnCount: 1,
              },
            ];
          }
          if (sql.includes("DELETE")) options.destructive.push(sql);
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
  }

  // DROPPED = the row was withdrawn and the conversation is still ALIVE (we
  // never deleted anything), so surfaces must not tombstone it or evict the
  // user from it.
  function assertDroppedAlive(result: unknown, message: string) {
    assert.deepEqual(result, { ok: true, dropped: true }, message);
  }

  function assertQuarantined(result: unknown, message: string) {
    assert.deepEqual(result, { ok: false, quarantined: true }, message);
  }

  // COMPLETED = the queued conversation is genuinely gone (nothing owns the key,
  // or the key belongs to a different conversation now). Surfaces must treat it
  // as a real deletion — restoring anyone onto this key is what resurrected
  // deleted chats as empty "New chat" rows.
  function assertCompletedGone(result: unknown, message: string) {
    assert.strictEqual(result, true, message);
  }

  it("never destroys the key's new owner: a re-created catalog row under the same key is dropped", async function () {
    // The regression test for the wrong-conversation-deletion blocker. The
    // conversationID is byte-identical (it is a deterministic hash of the
    // scope, and the key was recycled), so ONLY the createdAt witness can tell
    // these two conversations apart.
    const destructive: string[] = [];
    installDb({
      catalogRow: { conversationID: "lfz:original:owner", createdAt: 9_000 },
      registryRows: () => [
        {
          conversationID: "lfz:original:owner",
          instanceID: "instance-other",
          conversationKey: 2_000_000_777,
          system: "upstream",
          kind: "global",
          profileSignature: "profile-default",
          libraryID: 1,
          paperItemID: null,
          valid: 1,
          invalidReason: null,
        },
      ],
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({
        conversationID: "lfz:original:owner",
        catalogCreatedAt: 500,
      }) as never,
    );
    assertCompletedGone(
      ok,
      "the key belongs to another conversation now — not a survival",
    );
    assert.lengthOf(
      destructive,
      0,
      "the conversation that now owns the recycled key must not be touched",
    );
  });

  it("proceeds when the catalog identity witness still matches", async function () {
    // Guards against the fix over-blocking legitimate deletions.
    const destructive: string[] = [];
    installDb({
      catalogRow: { conversationID: "lfz:original:owner", createdAt: 500 },
      registryRows: () => [
        {
          conversationID: "lfz:original:owner",
          instanceID: "instance-original",
          conversationKey: 2_000_000_777,
          system: "upstream",
          kind: "global",
          profileSignature: "profile-default",
          libraryID: 1,
          paperItemID: null,
          valid: 1,
          invalidReason: null,
        },
      ],
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({
        conversationID: "lfz:original:owner",
        catalogCreatedAt: 500,
      }) as never,
    );
    assert.isTrue(ok, "a verified intent must complete");
    assert.isAbove(
      destructive.length,
      0,
      "a verified deletion must actually delete the conversation's rows",
    );
  });

  it("drops the intent when no catalog row owns the key any more", async function () {
    const destructive: string[] = [];
    installDb({ catalogRow: null, destructive });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: "lfz:original:owner" }) as never,
    );
    assertCompletedGone(
      ok,
      "a key with no catalog row leaves nothing to delete",
    );
    assert.lengthOf(destructive, 0);
  });

  it("quarantines an intent persisted without an identity witness (older build)", async function () {
    // Rows written before the witness existed can never be verified, so they
    // must fail closed rather than trusting the recycled key.
    const destructive: string[] = [];
    installDb({
      catalogRow: { conversationID: "lfz:original:owner", createdAt: 500 },
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({
        conversationID: "lfz:original:owner",
        catalogCreatedAt: 0,
      }) as never,
    );
    assertQuarantined(ok, "nothing was deleted while identity is unverifiable");
    assert.lengthOf(destructive, 0);
  });

  it("defers when the catalog read throws", async function () {
    const destructive: string[] = [];
    installDb({ catalogThrows: true, destructive });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: "lfz:original:owner" }) as never,
    );
    assert.isFalse(ok, "unverifiable ownership must defer for retry");
    assert.lengthOf(destructive, 0);
  });

  it("drops a stale intent when the key is now registered to a different conversation", async function () {
    // The catalog witness AND the catalog conversation id both match, so the
    // registry branch is genuinely reached rather than short-circuited.
    const destructive: string[] = [];
    installDb({
      catalogRow: { conversationID: "lfz:original:owner", createdAt: 500 },
      registryRows: () => [
        {
          conversationID: "lfz:other:owner",
          instanceID: "instance-other",
          conversationKey: 2_000_000_777,
          system: "upstream",
          kind: "global",
          profileSignature: "profile-default",
          libraryID: 1,
          paperItemID: null,
          valid: 1,
          invalidReason: null,
        },
      ],
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: "lfz:original:owner" }) as never,
    );
    assertCompletedGone(ok, "the key is owned by another conversation now");
    assert.lengthOf(destructive, 0, "the key's new owner must not be touched");
  });

  it("treats a failed registry stale-check as retryable instead of proceeding destructively", async function () {
    const destructive: string[] = [];
    installDb({
      // The catalog witness and conversation id match, so the registry read is
      // reached; that read fails and ownership cannot be verified.
      catalogRow: { conversationID: "lfz:original:owner", createdAt: 500 },
      registryRows: () => {
        throw new Error("db locked");
      },
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: "lfz:original:owner" }) as never,
    );
    assert.isFalse(
      ok,
      "unverified ownership must defer the deletion for retry",
    );
    assert.lengthOf(
      destructive,
      0,
      "no destructive statement may run while ownership is unverified",
    );
  });

  it("drops an ID-less intent whose witness no longer matches the catalog row", async function () {
    const destructive: string[] = [];
    installDb({
      // A different conversation owns the key now: same key, newer createdAt.
      catalogRow: { conversationID: "", createdAt: 5_000 },
      destructive,
    });
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({
        conversationID: undefined,
        catalogCreatedAt: 500,
      }) as never,
    );
    assertCompletedGone(ok, "a witness mismatch means the original is gone");
    assert.lengthOf(destructive, 0);
  });
});
