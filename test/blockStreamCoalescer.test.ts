import { assert } from "chai";
import {
  createBlockStreamCoalescer,
  type BlockStreamFlushReason,
} from "../src/modules/contextPanel/blockStreamCoalescer";

describe("blockStreamCoalescer", function () {
  it("coalesces adjacent tiny deltas until an event boundary", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 0,
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("Hello");
    coalescer.pushText(" ");
    coalescer.pushText("world");

    assert.deepEqual(blocks, []);
    coalescer.flushNow("event");

    assert.deepEqual(blocks, [{ text: "Hello world", reason: "event" }]);
    assert.equal(coalescer.getFullText(), "Hello world");
  });

  it("flushes at Markdown block boundaries once the pending text is large enough", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    const coalescer = createBlockStreamCoalescer({
      minBoundaryChars: 10,
      targetChars: 100,
      maxWaitMs: 0,
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("First paragraph.");
    assert.deepEqual(blocks, []);

    coalescer.pushText("\n\n");
    assert.deepEqual(blocks, [
      { text: "First paragraph.\n\n", reason: "boundary" },
    ]);
  });

  it("flushes by hard cap for uninterrupted text", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    const coalescer = createBlockStreamCoalescer({
      hardCapChars: 8,
      maxWaitMs: 0,
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("abcdefgh");

    assert.deepEqual(blocks, [{ text: "abcdefgh", reason: "hard-cap" }]);
  });

  it("flushes by timer when no natural boundary arrives", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    let timerCallback: (() => void) | null = null;
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 700,
      setTimer: (callback) => {
        timerCallback = callback;
        return "timer";
      },
      clearTimer: () => {
        timerCallback = null;
      },
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("partial");
    assert.deepEqual(blocks, []);
    assert.isFunction(timerCallback);

    timerCallback?.();
    assert.deepEqual(blocks, [{ text: "partial", reason: "timer" }]);
  });

  it("can cancel pending output without emitting it", function () {
    const blocks: string[] = [];
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 0,
      onBlock: (text) => blocks.push(text),
    });

    coalescer.pushText("abandoned");
    coalescer.cancel();
    coalescer.flushNow("final");

    assert.deepEqual(blocks, []);
    assert.equal(coalescer.getFullText(), "abandoned");
  });
});
