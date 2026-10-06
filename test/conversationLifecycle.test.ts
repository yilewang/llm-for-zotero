import { assert } from "chai";
import { conversationRepository } from "../src/core/conversations/repository";
import { pendingDeletionStore } from "../src/core/conversations/pendingDeletionStore";
import {
  isConversationInstanceRecentlyDeleted,
  markConversationInstanceRecentlyDeleted,
  resetRecentlyDeletedConversationsForTests,
} from "../src/core/conversations/recentlyDeletedConversations";
import {
  markCommittedConversationDeletionTombstone,
  shouldSeedConversationCatalogEntry,
} from "../src/modules/contextPanel/conversationLifecycle";
import type {
  PendingConversationDeletionEntry,
  PendingDeletionEvent,
  PendingTurnDeletionEntry,
} from "../src/core/conversations/pendingDeletionStore";

type ZoteroGlobal = typeof globalThis & { Zotero?: Record<string, any> };

describe("conversation lifecycle helpers", function () {
  const globalScope = globalThis as ZoteroGlobal;
  let originalZotero: Record<string, any> | undefined;
  let originalWitness: typeof conversationRepository.getCatalogIdentityWitness;
  let originalIsPending: typeof pendingDeletionStore.isConversationPendingDeletion;
  let durableTombstoneKeys: Set<number>;
  let pendingKeys: Set<number>;
  let dbQueries: Array<{ sql: string; params: unknown[] }>;
  let witnessCalls: unknown[];
  let witness: Awaited<
    ReturnType<typeof conversationRepository.getCatalogIdentityWitness>
  >;

  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalWitness = conversationRepository.getCatalogIdentityWitness;
    originalIsPending = pendingDeletionStore.isConversationPendingDeletion;
    durableTombstoneKeys = new Set();
    pendingKeys = new Set();
    dbQueries = [];
    witnessCalls = [];
    witness = null;
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = {
      DB: {
        // The durable tombstone lookup answers from durableTombstoneKeys;
        // every other statement (the mark's background persist) is recorded.
        queryAsync: async (sql: string, params?: unknown[]) => {
          dbQueries.push({ sql, params: params || [] });
          if (
            /FROM llm_for_zotero_conversation_deletion_tombstones/.test(sql)
          ) {
            return durableTombstoneKeys.has(Number(params?.[0]))
              ? [{ present: 1 }]
              : [];
          }
          return [];
        },
      },
    };
    conversationRepository.getCatalogIdentityWitness = async (target) => {
      witnessCalls.push(target);
      return witness;
    };
    pendingDeletionStore.isConversationPendingDeletion = (key: number) =>
      pendingKeys.has(key);
  });

  afterEach(function () {
    conversationRepository.getCatalogIdentityWitness = originalWitness;
    pendingDeletionStore.isConversationPendingDeletion = originalIsPending;
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  describe("shouldSeedConversationCatalogEntry", function () {
    const target = {
      system: "upstream" as const,
      kind: "global" as const,
      conversationKey: 41,
      libraryID: 1,
    };
    const liveWitness = {
      instanceID: "instance-41",
      catalogCreatedAt: 1000,
      conversationID: "conv-41",
    };

    it("refuses a key queued for deletion without reading the catalog", async function () {
      pendingKeys.add(41);
      assert.isFalse(await shouldSeedConversationCatalogEntry(target));
      assert.deepEqual(witnessCalls, []);
    });

    it("hands the caller's target to the witness read unchanged", async function () {
      witness = liveWitness;
      assert.isTrue(await shouldSeedConversationCatalogEntry(target));
      assert.deepEqual(witnessCalls, [target]);
      assert.strictEqual(witnessCalls[0], target);
    });

    it("refuses an instance whose deletion just committed", async function () {
      witness = liveWitness;
      markConversationInstanceRecentlyDeleted(41, "instance-41");
      assert.isFalse(await shouldSeedConversationCatalogEntry(target));
    });

    it("allows a recycled key whose live instance differs from the deleted one", async function () {
      witness = liveWitness;
      markConversationInstanceRecentlyDeleted(41, "instance-old");
      durableTombstoneKeys.add(41);
      assert.isTrue(await shouldSeedConversationCatalogEntry(target));
    });

    it("refuses a witnessless key that has a durable deletion tombstone", async function () {
      durableTombstoneKeys.add(41);
      assert.isFalse(await shouldSeedConversationCatalogEntry(target));
    });

    it("allows a witnessless key with no tombstone", async function () {
      assert.isTrue(await shouldSeedConversationCatalogEntry(target));
    });
  });

  describe("markCommittedConversationDeletionTombstone", function () {
    const conversationEntry = (
      overrides: Partial<PendingConversationDeletionEntry> = {},
    ): PendingConversationDeletionEntry => ({
      id: "pending-77",
      kind: "conversation",
      conversationKind: "global",
      instanceID: "instance-77",
      catalogCreatedAt: 1000,
      conversationKey: 77,
      libraryID: 1,
      system: "upstream",
      title: "Doomed",
      wasActive: false,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
      ...overrides,
    });

    for (const type of ["completed", "finalized"] as const) {
      it(`tombstones the instance on a real ${type} deletion`, function () {
        const marked = markCommittedConversationDeletionTombstone({
          type,
          entry: conversationEntry(),
        });
        assert.isTrue(marked);
        assert.isTrue(isConversationInstanceRecentlyDeleted(77, "instance-77"));
      });
    }

    it("persists the tombstone under the entry's identity digest", async function () {
      markCommittedConversationDeletionTombstone({
        type: "completed",
        entry: conversationEntry({ identityDigest: "digest-77" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const insert = dbQueries.find((query) =>
        /INSERT OR IGNORE INTO llm_for_zotero_conversation_deletion_tombstones/.test(
          query.sql,
        ),
      );
      assert.isOk(insert);
      assert.deepEqual(insert!.params.slice(0, 3), [
        "digest-77",
        77,
        "instance-77",
      ]);
    });

    const refusals: Array<[string, PendingDeletionEvent]> = [
      [
        "a dropped intent",
        { type: "completed", entry: conversationEntry(), dropped: true },
      ],
      ["a queued intent", { type: "queued", entry: conversationEntry() }],
      ["an undone intent", { type: "undone", entry: conversationEntry() }],
      [
        "a local-deleted event",
        { type: "local-deleted", entry: conversationEntry() },
      ],
      [
        "an entry without an instance ID",
        { type: "finalized", entry: conversationEntry({ instanceID: "" }) },
      ],
      [
        "a turn deletion",
        {
          type: "completed",
          entry: {
            id: "turn-77",
            kind: "turn",
            conversationKey: 77,
            instanceID: "instance-77",
          } as unknown as PendingTurnDeletionEntry,
        },
      ],
    ];
    for (const [label, event] of refusals) {
      it(`leaves the key seedable for ${label}`, function () {
        assert.isFalse(markCommittedConversationDeletionTombstone(event));
        assert.isFalse(
          isConversationInstanceRecentlyDeleted(77, "instance-77"),
        );
      });
    }
  });
});
