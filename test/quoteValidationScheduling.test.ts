import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("quote source warming bounds", function () {
  it("stops warming before it can evict its own page-text cache", function () {
    const chatSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../src/modules/contextPanel/chat.ts",
      ),
      "utf8",
    );
    const locatorSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../src/modules/contextPanel/livePdfSelectionLocator.ts",
      ),
      "utf8",
    );
    const warmLimit = Number(
      /const MAX_WARMED_QUOTE_SOURCE_PAPERS = (\d+)/.exec(chatSource)?.[1],
    );
    const cacheLimit = Number(
      /const MAX_PAGE_TEXT_CACHE_ENTRIES = (\d+)/.exec(locatorSource)?.[1],
    );

    assert.isAbove(warmLimit, 0, "warm limit should be defined");
    assert.isAbove(cacheLimit, 0, "page-text cache limit should be defined");
    assert.isAtMost(
      warmLimit,
      cacheLimit,
      "warming more papers than the cache holds would evict pages it just read",
    );
    // A library-chat answer can carry many evidence papers; the warm loop must
    // apply the bound rather than iterating everything it is handed.
    assert.include(chatSource, "MAX_WARMED_QUOTE_SOURCE_PAPERS,\n  );");
  });
});
