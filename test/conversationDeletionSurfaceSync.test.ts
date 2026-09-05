import { assert } from "chai";
import {
  createSerializedConversationDeletionEventQueue,
  resolveConversationDeletionSurfaceAction,
  type ConversationDeletionSurfaceEntry,
  type ConversationDeletionSurfaceSnapshot,
} from "../src/modules/contextPanel/conversationDeletionSurfaceSync";

function entry(
  overrides: Partial<ConversationDeletionSurfaceEntry> = {},
): ConversationDeletionSurfaceEntry {
  return {
    conversationKey: 7,
    conversationKind: "global",
    system: "upstream",
    wasActive: true,
    ...overrides,
  };
}

function surface(
  overrides: Partial<ConversationDeletionSurfaceSnapshot> = {},
): ConversationDeletionSurfaceSnapshot {
  return {
    conversationKey: 7,
    kind: "global",
    system: "upstream",
    ...overrides,
  };
}

describe("resolveConversationDeletionSurfaceAction", function () {
  it("a surface showing the queued conversation leaves it and remembers", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "queued",
        entry: entry(),
        surface: surface(),
        surrendered: false,
      }),
      { type: "leave", remember: true },
    );
  });

  it("a surface showing a different conversation is left alone", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "queued",
        entry: entry(),
        surface: surface({ conversationKey: 8 }),
        surrendered: false,
      }),
      { type: "none" },
    );
  });

  it("a surface in the other mode is left alone", function () {
    // Paper and global keys can collide; mode is part of the identity.
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "queued",
        entry: entry(),
        surface: surface({ kind: "paper" }),
        surrendered: false,
      }),
      { type: "none" },
    );
  });

  it("a surface on another conversation system is left alone", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "queued",
        entry: entry(),
        surface: surface({ system: "claude_code" }),
        surrendered: false,
      }),
      { type: "none" },
    );
  });

  it("a still-mounted surface leaves on finalize without remembering", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalized",
        entry: entry(),
        surface: surface(),
        surrendered: false,
      }),
      { type: "leave", remember: false },
    );
  });

  it("only the surrendering surface returns when the deletion is abandoned", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "gave-up",
        entry: entry(),
        surface: surface({ conversationKey: 9 }),
        surrendered: true,
      }),
      { type: "restore" },
    );
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "gave-up",
        entry: entry(),
        surface: surface({ conversationKey: 9 }),
        surrendered: false,
      }),
      { type: "none" },
    );
  });

  it("the surrendering surface returns when the deletion is undone", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "undone",
        entry: entry(),
        surface: surface({ conversationKey: 9 }),
        surrendered: true,
      }),
      { type: "restore" },
    );
  });

  it("restores a surface that surrendered even when the deleting surface was not on the chat", function () {
    // The deleter had the chat inactive (wasActive false) but a DIFFERENT
    // mounted surface was showing it and stepped off; that surface must still
    // be taken back. Gating restore on the deleter's wasActive stranded it.
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "gave-up",
        entry: entry({ wasActive: false }),
        surface: surface({ conversationKey: 9 }),
        surrendered: true,
      }),
      { type: "restore" },
    );
  });

  it("never drags back a surface that did not surrender", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "undone",
        entry: entry({ wasActive: true }),
        surface: surface({ conversationKey: 9 }),
        surrendered: false,
      }),
      { type: "none" },
    );
  });

  it("a dropped intent does not evict a surface from the surviving chat", function () {
    // "finalized" with dropped=true means the intent was withdrawn (stale, or
    // no identity witness) and the conversation still exists. Treating it as a
    // real deletion would yank the user out of a live chat.
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalized",
        entry: entry(),
        surface: surface(),
        surrendered: false,
        dropped: true,
      }),
      { type: "none" },
    );
  });

  it("a dropped intent restores the surface that had surrendered", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalized",
        entry: entry(),
        surface: surface({ conversationKey: 9 }),
        surrendered: true,
        dropped: true,
      }),
      { type: "restore" },
    );
  });

  it("a completed deletion never restores a surrendered surface onto the dead key", function () {
    // The chat is genuinely gone (nothing owns the key, or it was reassigned).
    // Restoring here is exactly how a deleted chat came back as an empty
    // "New chat", so a plain completion must forget, never restore.
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalized",
        entry: entry(),
        surface: surface({ conversationKey: 9 }),
        surrendered: true,
        dropped: false,
      }),
      { type: "forget" },
    );
  });

  it("a retry of a dropped intent does not evict the user from the live chat", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalize-failed",
        entry: entry(),
        surface: surface(),
        surrendered: false,
        dropped: true,
      }),
      { type: "none" },
    );
  });

  it("a real deletion still evicts a still-mounted surface", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalized",
        entry: entry(),
        surface: surface(),
        surrendered: false,
        dropped: false,
      }),
      { type: "leave", remember: false },
    );
  });

  it("a finalize retry keeps a still-mounted surface moving off", function () {
    assert.deepEqual(
      resolveConversationDeletionSurfaceAction({
        eventType: "finalize-failed",
        entry: entry(),
        surface: surface(),
        surrendered: false,
      }),
      { type: "leave", remember: true },
    );
  });
});

describe("createSerializedConversationDeletionEventQueue", function () {
  it("keeps Undo behind the queued leave reaction", async function () {
    const enqueue = createSerializedConversationDeletionEventQueue();
    const order: string[] = [];
    let releaseLeave: (() => void) | undefined;
    let markLeaveStarted: (() => void) | undefined;
    const leaveStarted = new Promise<void>((resolve) => {
      markLeaveStarted = resolve;
    });

    const leave = enqueue(async () => {
      order.push("leave-start");
      markLeaveStarted?.();
      await new Promise<void>((resolve) => {
        releaseLeave = resolve;
      });
      order.push("leave-finished");
    });
    const undo = enqueue(async () => {
      order.push("undo");
    });

    await leaveStarted;
    assert.deepEqual(order, ["leave-start"]);
    releaseLeave?.();
    await Promise.all([leave, undo]);
    assert.deepEqual(order, ["leave-start", "leave-finished", "undo"]);
  });
});
