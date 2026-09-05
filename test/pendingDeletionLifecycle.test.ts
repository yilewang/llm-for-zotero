import { assert } from "chai";
import {
  pendingDeletionStore,
  configurePendingDeletionFinalizers,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
  DELETION_UNDO_WINDOW_MS,
  type PendingDeletionEvent,
} from "../src/core/conversations/pendingDeletionStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type FakeTimer = { fn: () => void; delayMs: number; cleared: boolean };

/**
 * A miniature world mimicking real user conditions: a fake DB whose
 * pending_deletions rows persist across simulated restarts, fake timers
 * that can be killed (window close / quit), recording finalizers, and
 * "panels" that subscribe the way panel controllers do.
 *
 * The suite encodes two invariants:
 *   A — a chat the user did NOT intend to delete is never destroyed;
 *   B — a chat the user DID intend to delete is always destroyed.
 */
function createWorld() {
  const persistedRows = new Map<string, Record<string, unknown>>();
  const deletedConversations: number[] = [];
  const deletedTurns: Array<{ conversationKey: number; userTs: number }> = [];
  let timers: FakeTimer[] = [];
  let nowMs = 1_000_000;
  let failNextFinalizes = 0;

  function installZotero() {
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
  }

  function configure() {
    installZotero();
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
      finalizeTurn: async (entry) => {
        if (failNextFinalizes > 0) {
          failNextFinalizes -= 1;
          return false;
        }
        deletedTurns.push({
          conversationKey: entry.conversationKey,
          userTs: entry.userTimestamp,
        });
        return true;
      },
    });
  }

  return {
    deletedConversations,
    deletedTurns,
    persistedRows,
    configure,
    advance(ms: number) {
      nowMs += ms;
    },
    async fireDueTimers() {
      for (const t of timers.filter((x) => !x.cleared)) {
        t.cleared = true;
        t.fn();
      }
      await pendingDeletionStore.sweepExpired("flush");
    },
    killAllTimers() {
      for (const t of timers) t.cleared = true;
      timers = [];
    },
    failFinalizes(count: number) {
      failNextFinalizes = count;
    },
    /** Simulate quitting Zotero: timers die, memory resets, rows persist. */
    async restart() {
      this.killAllTimers();
      resetPendingDeletionStoreForTests();
      this.configure();
      await pendingDeletionStore.sweepAllPersisted("startup-sweep");
    },
  };
}

/** A panel generation: subscribes like a panel controller and mirrors state. */
function mountPanel() {
  const events: PendingDeletionEvent[] = [];
  const unsubscribe = pendingDeletionStore.subscribe((e) => events.push(e));
  return {
    events,
    isConversationVisible: (key: number) =>
      !pendingDeletionStore.isConversationPendingDeletion(key),
    undoLatest: async () => {
      const latest = pendingDeletionStore.getLatestPending();
      if (!latest) return null;
      return pendingDeletionStore.undo(latest.id);
    },
    unmount: () => unsubscribe(),
  };
}

function conversationInput(key: number) {
  return {
    conversationKind: "global" as const,
    instanceID: `instance-${key}`,
    conversationID: `lfz:test:upstream:global:lib-1:paper-0:legacy-${key}`,
    // Identity witness captured at queue time; queueing is refused without one.
    catalogCreatedAt: 1_700_000_000_000,
    conversationKey: key,
    libraryID: 1,
    system: "upstream" as const,
    title: `Chat ${key}`,
    wasActive: false,
  };
}

describe("pending deletion full lifecycle", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("A1: undo within the window restores everything; nothing is ever deleted", async function () {
    const world = createWorld();
    world.configure();
    const panel = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    assert.isFalse(panel.isConversationVisible(1));
    const undone = await panel.undoLatest();
    assert.isOk(undone);
    assert.isTrue(panel.isConversationVisible(1));
    world.advance(DELETION_UNDO_WINDOW_MS * 10);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, []);
    assert.equal(world.persistedRows.size, 0);
    panel.unmount();
  });

  it("A2: panel rebuild mid-window — new panel still hides the row and undo still works", async function () {
    const world = createWorld();
    world.configure();
    const oldPanel = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    oldPanel.unmount(); // user switches item/tab: buildUI tears the panel down
    const newPanel = mountPanel(); // successor generation subscribes
    assert.isFalse(
      newPanel.isConversationVisible(1),
      "rebuilt panel must keep hiding the queued row",
    );
    assert.isOk(
      pendingDeletionStore.getLatestPending(),
      "rebuilt panel must be able to render the undo toast",
    );
    const undone = await newPanel.undoLatest();
    assert.isOk(undone, "undo must work from the successor panel");
    world.advance(DELETION_UNDO_WINDOW_MS * 10);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, []);
    newPanel.unmount();
  });

  it("A3: undo then restart — the conversation survives (no leftover row to sweep)", async function () {
    const world = createWorld();
    world.configure();
    const panel = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    await panel.undoLatest();
    panel.unmount();
    await world.restart();
    assert.deepEqual(world.deletedConversations, []);
    assert.equal(world.persistedRows.size, 0);
  });

  it("A4: deleting chat 2 never touches chat 1, across rebuilds and restarts", async function () {
    const world = createWorld();
    world.configure();
    const panel = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(2));
    assert.isTrue(panel.isConversationVisible(1));
    panel.unmount();
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.restart();
    assert.deepEqual(world.deletedConversations, [2]);
    assert.notInclude(world.deletedConversations, 1);
  });

  it("A5: undoing a turn deletion leaves the turn intact after expiry and restart", async function () {
    const world = createWorld();
    world.configure();
    const panel = mountPanel();
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 3,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
    });
    assert.isTrue(pendingDeletionStore.isMessageInPendingTurn(3, 100));
    await panel.undoLatest();
    assert.isFalse(pendingDeletionStore.isMessageInPendingTurn(3, 100));
    world.advance(DELETION_UNDO_WINDOW_MS * 10);
    await world.fireDueTimers();
    await world.restart();
    assert.deepEqual(world.deletedTurns, []);
    panel.unmount();
  });

  it("B1: no undo — the timer completes the delete", async function () {
    const world = createWorld();
    world.configure();
    mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, [1]);
    assert.equal(world.persistedRows.size, 0);
  });

  it("B2: panel rebuild mid-window — delete still completes on time", async function () {
    const world = createWorld();
    world.configure();
    const oldPanel = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    oldPanel.unmount();
    mountPanel();
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, [1]);
  });

  it("B3: window closed mid-window (timers die) — restart sweep completes the delete", async function () {
    const world = createWorld();
    world.configure();
    mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    world.killAllTimers(); // standalone window closed / Zotero quit
    world.advance(DELETION_UNDO_WINDOW_MS * 10);
    assert.deepEqual(world.deletedConversations, [], "no timer may fire");
    await world.restart();
    assert.deepEqual(
      world.deletedConversations,
      [1],
      "startup sweep must complete the intended delete",
    );
    assert.equal(world.persistedRows.size, 0);
  });

  it("B4: turn deletion queued then window closed — restart deletes exactly that turn", async function () {
    const world = createWorld();
    world.configure();
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 3,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
    });
    world.killAllTimers();
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.restart();
    assert.deepEqual(world.deletedTurns, [{ conversationKey: 3, userTs: 100 }]);
  });

  it("B5: transient finalize failures retry to completion within the session", async function () {
    const world = createWorld();
    world.configure();
    mountPanel();
    world.failFinalizes(2);
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers(); // attempt 1: fails, re-arms
    await world.fireDueTimers(); // attempt 2: fails, re-arms
    await world.fireDueTimers(); // attempt 3: succeeds
    assert.deepEqual(world.deletedConversations, [1]);
    assert.equal(world.persistedRows.size, 0);
  });

  it("B6: rapid queue of several chats — every one completes, none survives", async function () {
    const world = createWorld();
    world.configure();
    mountPanel();
    for (const key of [1, 2, 3]) {
      await pendingDeletionStore.queueConversationDeletion(
        conversationInput(key),
      );
    }
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.fireDueTimers();
    assert.sameMembers(world.deletedConversations, [1, 2, 3]);
    assert.equal(world.persistedRows.size, 0);
  });

  it("B7: queue in one surface, undo in another — surfaces share one truth", async function () {
    const world = createWorld();
    world.configure();
    const embeddedPanel = mountPanel();
    const standalone = mountPanel();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    assert.isFalse(embeddedPanel.isConversationVisible(1));
    assert.isFalse(standalone.isConversationVisible(1));
    await standalone.undoLatest();
    assert.isTrue(embeddedPanel.isConversationVisible(1));
    world.advance(DELETION_UNDO_WINDOW_MS * 10);
    await world.fireDueTimers();
    assert.deepEqual(world.deletedConversations, []);
    embeddedPanel.unmount();
    standalone.unmount();
  });

  it("B8: crash mid-finalize (row not yet cleared) — restart retries and completes", async function () {
    const world = createWorld();
    world.configure();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(9));
    // Crash before the timer fires: nothing finalized, row persisted.
    assert.equal(world.persistedRows.size, 1);
    world.advance(DELETION_UNDO_WINDOW_MS + 1);
    await world.restart();
    assert.deepEqual(world.deletedConversations, [9]);
    assert.equal(world.persistedRows.size, 0);
    // A second restart is a no-op — finalize is idempotent per row.
    await world.restart();
    assert.deepEqual(world.deletedConversations, [9]);
  });
});
