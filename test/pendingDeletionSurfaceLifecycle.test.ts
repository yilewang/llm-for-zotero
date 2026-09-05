import { assert } from "chai";
import {
  pendingDeletionStore,
  configurePendingDeletionFinalizers,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
  DELETION_UNDO_WINDOW_MS,
} from "../src/core/conversations/pendingDeletionStore";
import {
  forgetRecentlyDeletedConversation,
  isConversationRecentlyDeleted,
  markConversationRecentlyDeleted,
  resetRecentlyDeletedConversationsForTests,
} from "../src/core/conversations/recentlyDeletedConversations";
import { resolveConversationDeletionSurfaceAction } from "../src/modules/contextPanel/conversationDeletionSurfaceSync";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type FakeTimer = { fn: () => void; delayMs: number; cleared: boolean };

/**
 * Multi-surface world: several panels/windows subscribe to the one shared
 * store, exactly as the product does (one panel per pane, plus the standalone
 * window). The invariants under test:
 *   - a conversation whose deletion committed is never re-seeded by a surface
 *     that still had it mounted (it must not reappear as an empty "New chat");
 *   - the surface that surrendered a chat goes back to it only if the user
 *     explicitly presses Undo; expiry and provider/local failures never
 *     restore the conversation.
 */
function createWorld() {
  const persistedRows = new Map<string, Record<string, unknown>>();
  const deletedConversations: number[] = [];
  const timers: FakeTimer[] = [];
  let nowMs = 1_000_000;
  let failNextFinalizes = 0;
  let failNextRowDeletes = 0;

  function configure() {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const upper = sql.trimStart().toUpperCase();
          if (upper.startsWith("INSERT")) {
            const [
              id,
              kind,
              conversationId,
              conversationKey,
              system,
              payload,
              queuedAt,
              expiresAt,
              attempts,
            ] = params as unknown[];
            persistedRows.set(String(id), {
              id,
              kind,
              conversation_id: conversationId,
              conversation_key: conversationKey,
              system,
              payload,
              queued_at: queuedAt,
              expires_at: expiresAt,
              attempts,
            });
            return [];
          }
          if (upper.startsWith("DELETE")) {
            if (failNextRowDeletes > 0) {
              failNextRowDeletes -= 1;
              throw new Error("db busy");
            }
            persistedRows.delete(String((params as unknown[])[0]));
            return [];
          }
          if (upper.startsWith("UPDATE")) {
            const [attempts, id] = params as unknown[];
            const row = persistedRows.get(String(id));
            if (row) row.attempts = attempts;
            return [];
          }
          if (upper.startsWith("SELECT")) {
            return Array.from(persistedRows.values());
          }
          return [];
        },
      },
    };
    configurePendingDeletionStoreEnv({
      now: () => nowMs,
      setTimer: (fn, delayMs) => {
        const t: FakeTimer = { fn, delayMs, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (handle) => {
        const t = handle as FakeTimer | null;
        if (t) t.cleared = true;
      },
      log: () => {},
    });
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        if (failNextFinalizes > 0) {
          failNextFinalizes -= 1;
          return false;
        }
        deletedConversations.push(entry.conversationKey);
        return true;
      },
      finalizeTurn: async () => true,
    });
  }

  return {
    deletedConversations,
    persistedRows,
    configure,
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => nowMs,
    async fireDueTimers() {
      for (const t of timers.filter((x) => !x.cleared)) {
        t.cleared = true;
        t.fn();
      }
      await pendingDeletionStore.sweepExpired("flush");
    },
    failFinalizes(count: number) {
      failNextFinalizes = count;
    },
    failRowDeletes(count: number) {
      failNextRowDeletes = count;
    },
  };
}

let freshKeySeq = 900;

/**
 * A mounted surface. Mirrors what both production subscribers do: record the
 * tombstone on "finalized", resolve its own action, apply leave/restore, then
 * run the ambient "keep the mounted conversation listed" seeding, which is
 * exactly the path that used to resurrect deleted chats.
 */
function mountSurface(name: string, mountedKey: number) {
  const surrendered = new Map<string, number>();
  const seededRows: number[] = [];
  const state = { name, mountedKey, instanceID: `instance-${mountedKey}` };

  const seedActiveRow = () => {
    const key = state.mountedKey;
    if (
      key > 0 &&
      (pendingDeletionStore.isConversationPendingDeletion(key) ||
        isConversationRecentlyDeleted(key))
    ) {
      return;
    }
    seededRows.push(key);
  };

  const unsubscribe = pendingDeletionStore.subscribe((event) => {
    if (event.entry.kind !== "conversation") return;
    const entry = event.entry;
    // Mirrors production: only a REAL deletion tombstones the key.
    if (event.type === "finalized" && !event.dropped) {
      markConversationRecentlyDeleted(entry.conversationKey);
    }
    const action = resolveConversationDeletionSurfaceAction({
      eventType: event.type,
      entry,
      // Derived from the SURFACE's own mount, not from the entry — deriving it
      // from the entry would make the kind/system discrimination vacuous.
      surface:
        state.mountedKey > 0
          ? {
              conversationKey: state.mountedKey,
              instanceID: state.instanceID,
              kind: "global" as const,
              system: "upstream" as const,
            }
          : null,
      surrendered: surrendered.has(entry.id),
      dropped: Boolean(event.dropped),
    });
    if (action.type === "leave") {
      state.mountedKey = ++freshKeySeq;
      state.instanceID = `instance-${state.mountedKey}`;
      if (action.remember) surrendered.set(entry.id, entry.conversationKey);
    } else if (action.type === "restore") {
      state.mountedKey = surrendered.get(entry.id) ?? entry.conversationKey;
      state.instanceID = entry.instanceID;
      surrendered.delete(entry.id);
    } else if (action.type === "forget") {
      surrendered.delete(entry.id);
    }
    seedActiveRow();
  });

  return {
    state,
    seededRows,
    seedActiveRow,
    recordSurrender: (entryId: string, key: number) =>
      surrendered.set(entryId, key),
    unmount: () => unsubscribe(),
  };
}

function conversationInput(key: number, wasActive = false) {
  return {
    conversationKind: "global" as const,
    instanceID: `instance-${key}`,
    conversationID: `lfz:test:upstream:global:lib-1:paper-0:legacy-${key}`,
    catalogCreatedAt: 1_700_000_000_000,
    conversationKey: key,
    libraryID: 1,
    system: "upstream" as const,
    title: `Chat ${key}`,
    wasActive,
  };
}

describe("pending deletion across mounted surfaces", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
    resetRecentlyDeletedConversationsForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  it("a second surface mounted on the deleted chat never re-seeds its catalog row", async function () {
    // The zombie reproduction: two panels mounted on the same chat (ordinary
    // with one panel per reader tab), one deletes it, the other must not
    // resurrect it as an empty "New chat".
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    const surfaceB = mountSurface("B", 1);
    await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, [1], "the chat is deleted");
    assert.notInclude(
      surfaceA.seededRows,
      1,
      "the deleting surface must not re-seed the dead key",
    );
    assert.notInclude(
      surfaceB.seededRows,
      1,
      "a second mounted surface must not re-seed the dead key",
    );
    surfaceA.unmount();
    surfaceB.unmount();
  });

  it("a delete whose row withdrawal fails and retries never resurrects the chat", async function () {
    // The exact sequence that was rated a release-blocker: the conversation is
    // really deleted, the write-ahead row removal then fails (DB busy) and the
    // entry retries. On the retry the catalog row is already gone, which the
    // classifier reports as a plain completion — NOT a survival. The surface
    // that surrendered the chat must be forgotten, never restored onto the dead
    // key, and the key must be tombstoned so nothing re-seeds it.
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    assert.notEqual(
      surfaceA.state.mountedKey,
      1,
      "A steps off the doomed chat",
    );
    const strandedOn = surfaceA.state.mountedKey;

    world.failRowDeletes(1);
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    assert.deepEqual(
      world.deletedConversations,
      [1],
      "the conversation is really deleted on the first pass",
    );

    // Retry: the row withdrawal now succeeds and "finalized" is emitted.
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();

    assert.notEqual(
      surfaceA.state.mountedKey,
      1,
      "the surface must never be restored onto the destroyed chat",
    );
    assert.equal(
      surfaceA.state.mountedKey,
      strandedOn,
      "and it stays where it was moved to",
    );
    assert.isTrue(
      isConversationRecentlyDeleted(1),
      "the dead key must be tombstoned so nothing re-seeds it",
    );
    assert.notInclude(
      surfaceA.seededRows,
      1,
      "the deleted chat must not be re-seeded as an empty New chat",
    );
    surfaceA.unmount();
  });

  it("a queued deletion moves every mounted surface off the doomed chat", async function () {
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    const surfaceB = mountSurface("B", 1);
    await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    assert.notEqual(surfaceA.state.mountedKey, 1);
    assert.notEqual(surfaceB.state.mountedKey, 1);
    surfaceA.unmount();
    surfaceB.unmount();
  });

  it("the tombstone stops blocking once the key is deliberately reused", async function () {
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    // A deliberate navigation back onto the recycled key lifts the tombstone.
    forgetRecentlyDeletedConversation(1);
    surfaceA.state.mountedKey = 1;
    surfaceA.seedActiveRow();
    assert.include(
      surfaceA.seededRows,
      1,
      "a new chat on a recycled key must still be seedable",
    );
    surfaceA.unmount();
  });

  it("a failed deletion remains hidden and retryable without restoring the chat", async function () {
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    const surfaceB = mountSurface("B", 2);
    // Every local finalization attempt fails. The intent remains durable and
    // the surrendered surface stays off the exact instance indefinitely.
    world.failFinalizes(10_000);
    await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    for (let i = 0; i < 3; i++) {
      world.advance(DELETION_UNDO_WINDOW_MS + 1);
      await world.fireDueTimers();
    }
    assert.notEqual(
      surfaceA.state.mountedKey,
      1,
      "the surface must never be restored after expiry",
    );
    assert.equal(
      surfaceB.state.mountedKey,
      2,
      "an uninvolved surface keeps its own place",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(1),
      "the failed deletion remains an outstanding obligation",
    );
    assert.notInclude(
      surfaceA.seededRows,
      1,
      "retry failure must not re-seed the hidden instance",
    );
    surfaceA.unmount();
    surfaceB.unmount();
  });

  it("an undone deletion puts the surrendering surface back on its chat", async function () {
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 1);
    const queued = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, true),
    );
    assert.notEqual(surfaceA.state.mountedKey, 1);
    await pendingDeletionStore.undo(queued!.id);
    assert.equal(surfaceA.state.mountedKey, 1);
    surfaceA.unmount();
  });

  it("a surface that never showed the chat is not dragged onto it", async function () {
    const world = createWorld();
    world.configure();
    const surfaceA = mountSurface("A", 2);
    const queued = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(1, false),
    );
    await pendingDeletionStore.undo(queued!.id);
    assert.equal(
      surfaceA.state.mountedKey,
      2,
      "a surface showing another chat must stay where it is",
    );
    surfaceA.unmount();
  });
});
