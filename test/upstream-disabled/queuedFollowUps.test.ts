import { assert } from "chai";
import {
  buildQueuedFollowUpThreadKey,
  clearQueuedFollowUpState,
  enqueueQueuedFollowUp,
  getQueuedFollowUps,
  registerQueuedFollowUpBody,
  removeQueuedFollowUp,
  scheduleQueuedFollowUpDrainForThread,
  SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY,
  setQueuedFollowUpBodySyncCallback,
  shiftQueuedFollowUp,
} from "../src/modules/contextPanel/queuedFollowUps";

describe("queuedFollowUps", function () {
  beforeEach(function () {
    clearQueuedFollowUpState();
    setQueuedFollowUpBodySyncCallback(() => undefined);
  });

  afterEach(function () {
    clearQueuedFollowUpState();
    setQueuedFollowUpBodySyncCallback(() => undefined);
  });

  it("keys queues by conversation system and conversation key", function () {
    assert.equal(
      buildQueuedFollowUpThreadKey({
        conversationSystem: "upstream",
        conversationKey: 42,
      }),
      "upstream:42",
    );
    assert.equal(
      buildQueuedFollowUpThreadKey({
        conversationSystem: "claude_code",
        conversationKey: 42,
      }),
      "claude_code:42",
    );
    assert.equal(
      buildQueuedFollowUpThreadKey({
        conversationSystem: "codex",
        conversationKey: 42,
      }),
      "codex:42",
    );
  });

  it("excludes WebChat from queue keying", function () {
    assert.isNull(
      buildQueuedFollowUpThreadKey({
        conversationSystem: "upstream",
        conversationKey: 42,
        webChatActive: true,
      }),
    );
    assert.deepEqual(enqueueQueuedFollowUp(null, "ignored"), []);
  });

  it("drains queued prompts FIFO", function () {
    const key = "codex:7";
    enqueueQueuedFollowUp(key, "first");
    enqueueQueuedFollowUp(key, "second");

    assert.equal(shiftQueuedFollowUp(key)?.text, "first");
    assert.equal(shiftQueuedFollowUp(key)?.text, "second");
    assert.isNull(shiftQueuedFollowUp(key));
  });

  it("removes queued prompts by id", function () {
    const key = "upstream:9";
    enqueueQueuedFollowUp(key, "first");
    const queue = enqueueQueuedFollowUp(key, "second");
    const first = queue[0];
    if (!first) assert.fail("expected a queued prompt");

    removeQueuedFollowUp(key, first.id);

    assert.deepEqual(
      getQueuedFollowUps(key).map((entry) => entry.text),
      ["second"],
    );
  });

  it("syncs registered bodies only for the changed thread", function () {
    const synced: Element[] = [];
    const bodyA = { isConnected: true } as unknown as Element;
    const bodyB = { isConnected: true } as unknown as Element;
    setQueuedFollowUpBodySyncCallback((body) => synced.push(body));
    registerQueuedFollowUpBody("claude_code:1", bodyA);
    registerQueuedFollowUpBody("codex:1", bodyB);

    enqueueQueuedFollowUp("claude_code:1", "follow-up");

    assert.deepEqual(synced, [bodyA]);
  });

  it("schedules a drain on the first connected registered body", function () {
    let called = 0;
    const disconnected = {
      isConnected: false,
      [SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY]: () => {
        throw new Error("disconnected body should not be scheduled");
      },
    } as unknown as Element;
    const connected = {
      isConnected: true,
      [SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY]: () => {
        called += 1;
      },
    } as unknown as Element;
    registerQueuedFollowUpBody("upstream:10", disconnected);
    registerQueuedFollowUpBody("upstream:10", connected);

    assert.isTrue(scheduleQueuedFollowUpDrainForThread("upstream:10"));
    assert.equal(called, 1);
  });
});
