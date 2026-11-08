import { assert } from "chai";
import {
  PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN,
  PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL,
  PROGRESSIVE_CHAT_RENDER_MIN_MESSAGES,
  cancelPendingChatRender,
  clearPendingChatRender,
  flushPendingChatRender,
  getPendingChatRender,
  planProgressiveChatRenderRange,
  resolveAnchorMessageIndex,
  setPendingChatRender,
  type PendingChatRender,
} from "../src/modules/contextPanel/progressiveChatRender";

const history = Array.from({ length: 100 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  timestamp: 1000 + index + 0.5,
  id: index % 10 === 0 ? 500 + index : undefined,
}));

describe("progressiveChatRender", function () {
  describe("planProgressiveChatRenderRange", function () {
    it("draws a short conversation in one pass", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: PROGRESSIVE_CHAT_RENDER_MIN_MESSAGES,
          allowed: true,
          scrollMode: "followBottom",
          anchorIndex: -1,
        }),
        { start: 0, end: PROGRESSIVE_CHAT_RENDER_MIN_MESSAGES },
      );
    });

    it("draws only the newest messages first when following the bottom", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "followBottom",
          anchorIndex: -1,
        }),
        { start: 240 - PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL, end: 240 },
      );
    });

    it("draws everything when the render cannot be split", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: false,
          scrollMode: "followBottom",
          anchorIndex: -1,
        }),
        { start: 0, end: 240 },
      );
    });

    it("draws around an older scroll anchor", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "manual",
          anchorIndex: 40,
        }),
        {
          start: 40 - PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN,
          end: 40 + PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL,
        },
      );
    });

    it("stops at the newest message for an anchor near the end", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "manual",
          anchorIndex: 239,
        }),
        { start: 239 - PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN, end: 240 },
      );
    });

    it("draws everything for a manual position without a known anchor", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "manual",
          anchorIndex: -1,
        }),
        { start: 0, end: 240 },
      );
    });

    it("includes required messages such as an open edit", function () {
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "followBottom",
          anchorIndex: -1,
          requiredIndices: [-1, 12, 400],
        }),
        { start: 12, end: 240 },
      );
      assert.deepEqual(
        planProgressiveChatRenderRange({
          total: 240,
          allowed: true,
          scrollMode: "manual",
          anchorIndex: 40,
          requiredIndices: [100],
        }),
        { start: 40 - PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN, end: 101 },
      );
    });
  });

  describe("resolveAnchorMessageIndex", function () {
    it("finds a message by role, floored timestamp, and index", function () {
      assert.equal(
        resolveAnchorMessageIndex(history, {
          messageRole: "assistant",
          messageTimestamp: "1031",
          messageIndex: "31",
        }),
        31,
      );
    });

    it("falls back to role and timestamp when the index moved", function () {
      assert.equal(
        resolveAnchorMessageIndex(history, {
          messageRole: "assistant",
          messageTimestamp: "1031",
          messageIndex: "7",
        }),
        31,
      );
    });

    it("finds a message by its stored id key", function () {
      assert.equal(
        resolveAnchorMessageIndex(history, { messageAnchorKey: "id:520" }),
        20,
      );
    });

    it("reads a role:timestamp:index key without other fields", function () {
      assert.equal(
        resolveAnchorMessageIndex(history, {
          messageAnchorKey: "user:1012:12",
        }),
        12,
      );
    });

    it("returns -1 for a missing or unknown anchor", function () {
      assert.equal(resolveAnchorMessageIndex(history, undefined), -1);
      assert.equal(
        resolveAnchorMessageIndex(history, {
          messageRole: "user",
          messageTimestamp: "1",
        }),
        -1,
      );
    });
  });

  describe("pending registry", function () {
    const makePending = (log: string[], name: string): PendingChatRender => ({
      conversationKey: 1,
      isPending: () => true,
      flush: () => log.push(`${name}:flush`),
      cancel: () => log.push(`${name}:cancel`),
    });

    it("cancels the previous pending render of the same box", function () {
      const box = {} as Element;
      const log: string[] = [];
      const first = makePending(log, "first");
      const second = makePending(log, "second");
      setPendingChatRender(box, first);
      setPendingChatRender(box, second);
      assert.deepEqual(log, ["first:cancel"]);
      assert.equal(getPendingChatRender(box), second);
      clearPendingChatRender(box, first);
      assert.equal(getPendingChatRender(box), second);
      assert.isTrue(flushPendingChatRender(box));
      cancelPendingChatRender(box);
      assert.deepEqual(log, ["first:cancel", "second:flush", "second:cancel"]);
      clearPendingChatRender(box, second);
      assert.isUndefined(getPendingChatRender(box));
      assert.isFalse(flushPendingChatRender(box));
    });
  });
});
