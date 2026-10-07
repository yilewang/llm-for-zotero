import { assert } from "chai";
import { describe, it } from "mocha";

import type { BlockStreamFlushReason } from "../src/modules/contextPanel/blockStreamCoalescer";
import { createStreamingResponse } from "../src/modules/contextPanel/streamingResponse";
import type { Message } from "../src/modules/contextPanel/types";

/**
 * Drives the streaming-response owner the way the retry and send flows drive
 * it: construct, start, push deltas, flush with a reason, and end the turn by
 * rolling back or disposing.
 */
function harness(initialText = "") {
  const message = { role: "assistant", text: initialText } as Message;
  const refreshes: string[] = [];
  let scheduled = 0;

  const streamingResponse = createStreamingResponse({
    message,
    refreshMessage: () => refreshes.push(message.text),
    createQueuedRefresh: (refresh) => () => {
      scheduled += 1;
      refresh();
    },
  });

  return {
    message,
    refreshes,
    streamingResponse,
    scheduledRefreshes: () => scheduled,
  };
}

/** Long enough to cross the coalescer's target, ending at a block boundary. */
const PARAGRAPH = `${"word ".repeat(40)}\n\n`;

describe("streaming response owner", function () {
  describe("lifecycle", function () {
    it("drops deltas pushed before the stream is started", function () {
      const { message, streamingResponse, refreshes } = harness();

      streamingResponse.push(PARAGRAPH);
      streamingResponse.flush("final");

      assert.equal(message.text, "");
      assert.equal(streamingResponse.getStreamedText(), "");
      assert.deepEqual(refreshes, []);
    });

    it("appends a released block to the message and repaints once", function () {
      const { message, streamingResponse, refreshes, scheduledRefreshes } =
        harness();

      streamingResponse.start();
      streamingResponse.push(PARAGRAPH);

      assert.equal(message.text, PARAGRAPH);
      assert.deepEqual(refreshes, [PARAGRAPH]);
      assert.equal(scheduledRefreshes(), 1);
    });

    it("buffers a short delta and keeps it in the streamed text", function () {
      const { message, streamingResponse, refreshes } = harness();

      streamingResponse.start();
      streamingResponse.push("still typing");

      assert.equal(message.text, "");
      assert.deepEqual(refreshes, []);
      assert.equal(streamingResponse.getStreamedText(), "still typing");
    });

    it("sanitizes each delta and ignores one left empty", function () {
      const { message, streamingResponse } = harness();

      streamingResponse.start();
      streamingResponse.push("\u0000");
      streamingResponse.push(`a\u0000b${PARAGRAPH}`);

      assert.equal(message.text, `ab${PARAGRAPH}`);
      assert.equal(streamingResponse.getStreamedText(), `ab${PARAGRAPH}`);
    });

    it("ignores a second start so one turn keeps one stream", function () {
      const { message, streamingResponse } = harness();

      streamingResponse.start();
      streamingResponse.push("first");
      streamingResponse.start();
      streamingResponse.flush("final");

      assert.equal(message.text, "first");
      assert.equal(streamingResponse.getStreamedText(), "first");
    });

    it("appends to whatever the message already held", function () {
      const { message, streamingResponse } = harness("earlier answer\n\n");

      streamingResponse.start();
      streamingResponse.push("continued");
      streamingResponse.flush("final");

      assert.equal(message.text, "earlier answer\n\ncontinued");
    });
  });

  describe("flush reasons the flows use", function () {
    const reasons: BlockStreamFlushReason[] = [
      "final",
      "cancel",
      "error",
      "event",
    ];

    for (const reason of reasons) {
      it(`releases the buffered tail on a "${reason}" flush`, function () {
        const { message, streamingResponse, refreshes } = harness();

        streamingResponse.start();
        streamingResponse.push("buffered tail");
        assert.equal(message.text, "");

        streamingResponse.flush(reason);

        assert.equal(message.text, "buffered tail");
        assert.deepEqual(refreshes, ["buffered tail"]);
      });
    }

    it("stays quiet when there is nothing left to release", function () {
      const { streamingResponse, refreshes } = harness();

      streamingResponse.start();
      streamingResponse.push("tail");
      streamingResponse.flush("final");
      streamingResponse.flush("final");

      assert.deepEqual(refreshes, ["tail"]);
    });

    it("flushes nothing before the stream is started", function () {
      const { streamingResponse, refreshes } = harness();

      streamingResponse.flush("cancel");

      assert.deepEqual(refreshes, []);
    });
  });

  describe("rollback", function () {
    it("restores the message text the stream started from", function () {
      const { message, streamingResponse } = harness("the previous answer");

      streamingResponse.start();
      streamingResponse.push(PARAGRAPH);
      assert.equal(message.text, `the previous answer${PARAGRAPH}`);

      streamingResponse.rollback();

      assert.equal(message.text, "the previous answer");
    });

    it("drops the buffered tail and refuses later deltas", function () {
      const { message, streamingResponse, refreshes } = harness();

      streamingResponse.start();
      streamingResponse.push("half an answer");
      streamingResponse.rollback();
      streamingResponse.push("after the rollback");
      streamingResponse.flush("final");

      assert.equal(message.text, "");
      assert.deepEqual(refreshes, []);
    });

    it("leaves the message alone when the stream never started", function () {
      const { message, streamingResponse } = harness("untouched");

      streamingResponse.rollback();

      assert.equal(message.text, "untouched");
    });

    it("is idempotent", function () {
      const { message, streamingResponse } = harness("the previous answer");

      streamingResponse.start();
      streamingResponse.push(PARAGRAPH);
      streamingResponse.rollback();
      streamingResponse.rollback();

      assert.equal(message.text, "the previous answer");
    });
  });

  describe("dispose", function () {
    it("keeps the released text and hands back the unreleased tail first", function () {
      const { message, streamingResponse } = harness();

      streamingResponse.start();
      streamingResponse.push(PARAGRAPH);
      streamingResponse.push("dropped mid-sentence");
      const streamed = streamingResponse.getStreamedText();
      streamingResponse.dispose();

      assert.equal(streamed, `${PARAGRAPH}dropped mid-sentence`);
      assert.equal(message.text, PARAGRAPH);
    });

    it("refuses later deltas", function () {
      const { message, streamingResponse, refreshes } = harness();

      streamingResponse.start();
      streamingResponse.dispose();
      streamingResponse.push(PARAGRAPH);
      streamingResponse.flush("final");

      assert.equal(message.text, "");
      assert.deepEqual(refreshes, []);
    });

    it("is idempotent, and stays so after a rollback", function () {
      const { message, streamingResponse } = harness("the previous answer");

      streamingResponse.start();
      streamingResponse.push(PARAGRAPH);
      streamingResponse.rollback();
      streamingResponse.dispose();
      streamingResponse.dispose();

      assert.equal(message.text, "the previous answer");
    });

    it("does nothing before the stream is started", function () {
      const { message, streamingResponse } = harness("untouched");

      streamingResponse.dispose();

      assert.equal(message.text, "untouched");
    });
  });

  describe("stall timer", function () {
    it("schedules, fires and clears the stall timer through injected timers", function () {
      const message = { role: "assistant", text: "" } as Message;
      const refreshes: string[] = [];
      const scheduled: { callback: () => void; delayMs: number }[] = [];
      const cleared: unknown[] = [];

      const streamingResponse = createStreamingResponse({
        message,
        refreshMessage: () => refreshes.push(message.text),
        createQueuedRefresh: (refresh) => refresh,
        setTimer: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return `timer-${scheduled.length}`;
        },
        clearTimer: (timer) => {
          cleared.push(timer);
        },
      });

      streamingResponse.start();
      streamingResponse.push("stalled");
      assert.equal(scheduled.length, 1, "a buffered delta arms the timer");
      assert.equal(scheduled[0].delayMs, 450);
      assert.equal(message.text, "");

      scheduled[0].callback();
      assert.equal(message.text, "stalled");
      assert.deepEqual(refreshes, ["stalled"]);

      streamingResponse.push(" again");
      assert.equal(scheduled.length, 2, "the next buffered delta re-arms it");
      streamingResponse.flush("final");

      assert.deepEqual(cleared, ["timer-2"]);
      assert.equal(message.text, "stalled again");
    });

    it("uses the global setTimeout and clearTimeout when no timers are injected", function () {
      const globals = globalThis as unknown as {
        setTimeout: (callback: () => void, delayMs: number) => unknown;
        clearTimeout: (timer: unknown) => void;
      };
      const originalSetTimeout = globals.setTimeout;
      const originalClearTimeout = globals.clearTimeout;
      const delays: number[] = [];
      const cleared: unknown[] = [];
      const handle = { fake: "timer" };
      globals.setTimeout = (_callback, delayMs) => {
        delays.push(delayMs);
        return handle;
      };
      globals.clearTimeout = (timer) => {
        cleared.push(timer);
      };

      try {
        const { message, streamingResponse } = harness();

        streamingResponse.start();
        streamingResponse.push("stalled");
        streamingResponse.flush("final");

        assert.deepEqual(delays, [450]);
        assert.deepEqual(cleared, [handle]);
        assert.equal(message.text, "stalled");
      } finally {
        globals.setTimeout = originalSetTimeout;
        globals.clearTimeout = originalClearTimeout;
      }
    });
  });

  describe("queued refresh", function () {
    it("builds the message's repaint once, through the panel's factory", function () {
      const message = { role: "assistant", text: "" } as Message;
      const built: (() => void)[] = [];

      const streamingResponse = createStreamingResponse({
        message,
        refreshMessage: () => {
          message.text += "!";
        },
        createQueuedRefresh: (refresh) => {
          built.push(refresh);
          return refresh;
        },
      });

      assert.equal(built.length, 1);
      streamingResponse.queueRefresh();
      assert.equal(message.text, "!");
    });
  });
});
