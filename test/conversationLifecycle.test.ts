import { assert } from "chai";
import { conversationRepository } from "../src/core/conversations/repository";
import { pendingDeletionStore } from "../src/core/conversations/pendingDeletionStore";
import {
  isConversationInstanceRecentlyDeleted,
  markConversationInstanceRecentlyDeleted,
  resetRecentlyDeletedConversationsForTests,
} from "../src/core/conversations/recentlyDeletedConversations";
import { shouldSeedConversationCatalogEntry } from "../src/modules/contextPanel/conversationLifecycle";

type ZoteroGlobal = typeof globalThis & { Zotero?: Record<string, any> };

describe("conversation lifecycle helpers", function () {
  const globalScope = globalThis as ZoteroGlobal;
  let originalZotero: Record<string, any> | undefined;
  let originalWitness: typeof conversationRepository.getCatalogIdentityWitness;
  let originalIsPending: typeof pendingDeletionStore.isConversationPendingDeletion;
  let durableTombstoneKeys: Set<number>;
  let pendingKeys: Set<number>;
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
    witnessCalls = [];
    witness = null;
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = {
      DB: {
        // Only the durable tombstone lookup reads the DB in these tests; the
        // in-memory mark's background persist is allowed to fail quietly.
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            /FROM llm_for_zotero_conversation_deletion_tombstones/.test(sql)
          ) {
            return durableTombstoneKeys.has(Number(params?.[0]))
              ? [{ present: 1 }]
              : [];
          }
          throw new Error("unexpected query");
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
});
