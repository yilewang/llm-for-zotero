import { assert } from "chai";
import {
  orderQuoteValidationBatchByViewportPriority,
  resolveQuoteValidationIdleTimeouts,
} from "../src/modules/contextPanel/chat";
import type { Message } from "../src/modules/contextPanel/types";

function assistant(label: string): Message {
  return { role: "assistant", text: label } as unknown as Message;
}

describe("quote validation scheduling", function () {
  describe("orderQuoteValidationBatchByViewportPriority", function () {
    it("classifies the newest (bottom, on-screen) messages first", function () {
      const a = assistant("oldest");
      const b = assistant("middle");
      const c = assistant("newest");
      const history = [a, assistant("user-ish"), b, c];
      const batch = [
        { assistantMessage: a },
        { assistantMessage: b },
        { assistantMessage: c },
      ];

      const ordered = orderQuoteValidationBatchByViewportPriority(
        batch,
        history,
      );

      assert.deepEqual(
        ordered.map((entry) => entry.assistantMessage),
        [c, b, a],
        "highest history index should come first",
      );
    });

    it("pushes messages missing from history to the end, order preserved", function () {
      const inHistory = assistant("visible");
      const staleOne = assistant("stale-1");
      const staleTwo = assistant("stale-2");
      const history = [assistant("other"), inHistory];
      const batch = [
        { assistantMessage: staleOne },
        { assistantMessage: inHistory },
        { assistantMessage: staleTwo },
      ];

      const ordered = orderQuoteValidationBatchByViewportPriority(
        batch,
        history,
      );

      assert.deepEqual(
        ordered.map((entry) => entry.assistantMessage),
        [inHistory, staleOne, staleTwo],
      );
    });

    it("does not mutate the input batch", function () {
      const a = assistant("a");
      const b = assistant("b");
      const history = [a, b];
      const batch = [{ assistantMessage: a }, { assistantMessage: b }];
      const snapshot = [...batch];

      orderQuoteValidationBatchByViewportPriority(batch, history);

      assert.deepEqual(batch, snapshot, "original array order preserved");
    });
  });

  describe("resolveQuoteValidationIdleTimeouts", function () {
    it("uses cooperative defaults when no prompt timeout is requested", function () {
      assert.deepEqual(resolveQuoteValidationIdleTimeouts(true), {
        idleTimeout: 1200,
        fallbackDelayMs: 250,
      });
      assert.deepEqual(resolveQuoteValidationIdleTimeouts(false), {
        idleTimeout: 1200,
        fallbackDelayMs: 16,
      });
    });

    it("collapses both timeouts to the prompt budget for a prompt wait", function () {
      assert.deepEqual(resolveQuoteValidationIdleTimeouts(true, 32), {
        idleTimeout: 32,
        fallbackDelayMs: 32,
      });
    });

    it("clamps a negative prompt budget to zero", function () {
      assert.deepEqual(resolveQuoteValidationIdleTimeouts(true, -5), {
        idleTimeout: 0,
        fallbackDelayMs: 0,
      });
    });
  });
});
