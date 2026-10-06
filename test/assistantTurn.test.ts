import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";

import {
  createAssistantTurn,
  finalizeCancelledAssistantMessage,
  type AssistantTurnDeps,
} from "../src/modules/contextPanel/assistantTurn";
import type { CodexNativeActivityTraceController } from "../src/modules/contextPanel/codexNativeTrace/controller";
import { EMPTY_OUTPUT_LIMIT_MESSAGE } from "../src/modules/contextPanel/directChatCompletion";
import {
  setAbortController,
  setCancelledRequestId,
} from "../src/modules/contextPanel/state";
import type { Message } from "../src/modules/contextPanel/types";
import { formatCodexZoteroMcpError } from "../src/codexAppServer/mcpErrors";
import { setAppLogSinkForTests } from "../src/core/logging";
import type { ModelTurnOutcome } from "../src/shared/llm";
import type { TurnUsageRecorder } from "../src/utils/usageTurnRecorder";

/**
 * Drives the assistant-turn owner the way the retry flow drives it, with fake
 * timers, a fake trace, a fake usage recorder, and fake persistence. Every
 * observable step is appended to one `log`, so ordering can be asserted.
 */

const KEY = 9_400_001;
const REQUEST_ID = 7;

function harness(overrides: Partial<AssistantTurnDeps> = {}) {
  const message = {
    role: "assistant",
    text: "",
    streaming: true,
  } as Message;
  const log: string[] = [];
  const timers: { callback: () => void; delayMs: number }[] = [];
  const traceCalls: { name: string; args: unknown[] }[] = [];
  const trace = {
    runId: "run-fake",
    flushBufferedProgress: (reason: string) => {
      traceCalls.push({ name: "flushBufferedProgress", args: [reason] });
      log.push(
        `trace.flush:${reason} text=${message.text} streaming=${String(message.streaming)}`,
      );
    },
    persist: async (...args: unknown[]) => {
      traceCalls.push({ name: "persist", args });
      log.push(
        `trace.persist:${String(args[2])} text=${message.text} streaming=${String(message.streaming)}`,
      );
    },
    finish: (text: string) => {
      traceCalls.push({ name: "finish", args: [text] });
      log.push(`trace.finish:${text}`);
    },
    dispose: () => {
      traceCalls.push({ name: "dispose", args: [] });
      log.push("trace.dispose");
    },
    noteSkillActivated: (skillId: string) => {
      traceCalls.push({ name: "noteSkillActivated", args: [skillId] });
    },
  };
  const createdTraces: { message: Message; queueRefresh: () => void }[] = [];
  const usageFlushes: string[] = [];
  let dispatchedCount = 0;
  const usageRecorder: TurnUsageRecorder = {
    markDispatched: () => {
      dispatchedCount += 1;
      log.push("usage.dispatched");
    },
    record: () => undefined,
    snapshot: () => ({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    flush: (reason) => {
      usageFlushes.push(reason);
      log.push(`usage.flush:${reason}`);
      return new Promise<boolean>(() => undefined);
    },
  };
  const quoteCalls: unknown[] = [];

  const turn = createAssistantTurn({
    message,
    conversationKey: KEY,
    conversationGeneration: 3,
    requestId: REQUEST_ID,
    isCodexNativeTurn: false,
    usageRecorder,
    refreshMessage: () => log.push(`refreshMessage text=${message.text}`),
    refreshChat: () => log.push(`refreshChat text=${message.text}`),
    refreshCompletedTurn: () =>
      log.push(
        `refreshCompletedTurn text=${message.text} streaming=${String(message.streaming)}`,
      ),
    setStatus: (text, kind) => log.push(`status:${kind}:${text}`),
    createQueuedRefresh: (refresh) => refresh,
    resolveRetryHint: (errorMessage, imageCount) =>
      imageCount > 0 ? ` [hint for ${errorMessage} x${imageCount}]` : "",
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimer: () => undefined,
    createCodexTrace: (traceMessage, queueRefresh) => {
      createdTraces.push({ message: traceMessage, queueRefresh });
      return trace as unknown as CodexNativeActivityTraceController;
    },
    finalizeQuoteCitations: (quoteMessage, options) => {
      quoteCalls.push(options);
      log.push(
        `quotes text=${quoteMessage.text} status=${String(quoteMessage.completionStatus)}`,
      );
    },
    ...overrides,
  });

  return {
    message,
    log,
    timers,
    trace,
    traceCalls,
    createdTraces,
    usageFlushes,
    quoteCalls,
    turn,
    dispatchedCount: () => dispatchedCount,
  };
}

/** Long enough to cross the coalescer's target, ending at a block boundary. */
const PARAGRAPH = `${"word ".repeat(40)}\n\n`;
const COMPLETE: ModelTurnOutcome = {
  text: "",
  completion: { status: "complete" },
};

afterEach(function () {
  setCancelledRequestId(KEY, -1);
  setAbortController(KEY, null);
});

describe("assistant turn owner", function () {
  describe("stream", function () {
    it("drops deltas until the flow starts the stream late", function () {
      const { message, turn } = harness();

      turn.push(PARAGRAPH);
      turn.flush("final");
      assert.equal(message.text, "");

      turn.start();
      turn.push(PARAGRAPH);
      assert.equal(message.text, PARAGRAPH);
    });

    it("arms the stalled-stream timer through the injected timers", function () {
      const { message, turn, timers } = harness();

      turn.start();
      turn.push("stalled tail");
      assert.lengthOf(timers, 1);
      assert.equal(message.text, "");

      timers[0].callback();
      assert.equal(message.text, "stalled tail");
    });

    it("rolls the message back to its pre-start text", function () {
      const { message, turn } = harness();
      message.text = "previous answer";

      turn.start();
      turn.push(PARAGRAPH);
      turn.rollback();

      assert.equal(message.text, "previous answer");
    });
  });

  describe("codex trace", function () {
    it("wires the trace to the stream's repaint and notes forced skills", function () {
      const { turn, createdTraces, traceCalls, message } = harness({
        isCodexNativeTurn: true,
      });

      turn.attachCodexTrace(["skill-a", "skill-b"]);

      assert.lengthOf(createdTraces, 1);
      assert.strictEqual(createdTraces[0].message, message);
      assert.strictEqual(createdTraces[0].queueRefresh, turn.queueRefresh);
      assert.isNotNull(turn.codexTrace);
      assert.deepEqual(
        traceCalls
          .filter((call) => call.name === "noteSkillActivated")
          .map((call) => call.args[0]),
        ["skill-a", "skill-b"],
      );
    });

    it("attaches no trace to a turn that is not native Codex", function () {
      const { turn, createdTraces } = harness();

      turn.attachCodexTrace(["skill-a"]);

      assert.lengthOf(createdTraces, 0);
      assert.isNull(turn.codexTrace);
      assert.isUndefined(turn.persistTrace());
    });

    it("persists the trace under the turn's conversation and generation", async function () {
      const { turn, traceCalls } = harness({ isCodexNativeTurn: true });
      turn.attachCodexTrace();

      await turn.persistTrace();
      await turn.persistTrace("failed");

      assert.deepEqual(
        traceCalls
          .filter((call) => call.name === "persist")
          .map((call) => call.args),
        [
          [KEY, 3, undefined],
          [KEY, 3, "failed"],
        ],
      );
    });
  });

  describe("wasCancelled", function () {
    it("is false while the request is neither cancelled nor aborted", function () {
      const { turn } = harness();

      assert.isFalse(turn.wasCancelled());
      assert.isFalse(turn.wasCancelled(new Error("boom")));
    });

    it("is true once a cancel names this request or a later one", function () {
      const { turn } = harness();

      setCancelledRequestId(KEY, REQUEST_ID - 1);
      assert.isFalse(turn.wasCancelled());
      setCancelledRequestId(KEY, REQUEST_ID);
      assert.isTrue(turn.wasCancelled());
      setCancelledRequestId(KEY, REQUEST_ID + 1);
      assert.isTrue(turn.wasCancelled());
    });

    it("is true when the conversation's abort signal fired", function () {
      const { turn } = harness();
      const controller = new AbortController();
      setAbortController(KEY, controller);

      assert.isFalse(turn.wasCancelled());
      controller.abort();
      assert.isTrue(turn.wasCancelled());
    });

    it("counts a caught AbortError only on the error path", function () {
      const { turn } = harness();
      const abortError = Object.assign(new Error("aborted"), {
        name: "AbortError",
      });

      assert.isTrue(turn.wasCancelled(abortError));
      assert.isFalse(turn.wasCancelled());
    });
  });

  describe("cancel", function () {
    it("trace-first: flush, trace flush, finalize, trace persist, repaint, row, status", async function () {
      const { turn, log, message } = harness({ isCodexNativeTurn: true });
      turn.attachCodexTrace();
      turn.start();
      turn.push("unflushed tail");
      log.length = 0;

      await turn.cancel({
        order: "trace-first",
        persist: async (traceStatus) => {
          log.push(
            `row:${String(traceStatus)} text=${message.text} streaming=${String(message.streaming)}`,
          );
        },
      });

      assert.deepEqual(log, [
        "refreshMessage text=unflushed tail",
        // The trace flush sees the released tail, before finalization.
        "trace.flush:cancel text=unflushed tail streaming=true",
        "trace.persist:cancelled text=unflushed tail streaming=false",
        "refreshChat text=unflushed tail",
        "row:undefined text=unflushed tail streaming=false",
        "status:ready:Cancelled",
      ]);
    });

    it("refresh-first: repaints, then hands the cancelled status to the flow's persist", async function () {
      const { turn, log, message, traceCalls } = harness({
        isCodexNativeTurn: true,
      });
      turn.attachCodexTrace();
      turn.start();
      log.length = 0;

      await turn.cancel({
        order: "refresh-first",
        persist: async (traceStatus) => {
          log.push(`row:${String(traceStatus)} text=${message.text}`);
        },
      });

      assert.deepEqual(log, [
        "trace.flush:cancel text= streaming=true",
        "refreshChat text=[Cancelled]",
        "row:cancelled text=[Cancelled]",
        "status:ready:Cancelled",
      ]);
      assert.isEmpty(traceCalls.filter((call) => call.name === "persist"));
    });

    it("replaces the Cancel button's placeholder with the buffered text that streamed", async function () {
      const { turn, message } = harness();
      turn.start();
      turn.push("Only buffered text");
      // The Cancel button marks a bubble that shows nothing yet.
      message.text = "[Cancelled]";

      await turn.cancel({ order: "trace-first", persist: async () => {} });

      assert.equal(message.text, "Only buffered text");
    });

    it("keeps the placeholder when nothing streamed", async function () {
      const { turn, message } = harness();
      turn.start();
      message.text = "[Cancelled]";

      await turn.cancel({ order: "refresh-first", persist: async () => {} });

      assert.equal(message.text, "[Cancelled]");
    });

    it("propagates a failed row write and reports no Cancelled status", async function () {
      const { turn, log } = harness();
      turn.start();

      let caught: unknown;
      try {
        await turn.cancel({
          order: "trace-first",
          persist: async () => {
            throw new Error("store down");
          },
        });
      } catch (error) {
        caught = error;
      }

      assert.equal((caught as Error)?.message, "store down");
      assert.notInclude(log, "status:ready:Cancelled");
    });
  });

  describe("completion", function () {
    it("releases the buffered tail before the flow resolves the text", function () {
      const { turn, message, log } = harness();
      turn.start();
      turn.push("final tail");
      log.length = 0;

      const emptyText = turn.beginCompletion(COMPLETE);

      assert.equal(message.text, "final tail");
      assert.deepEqual(log, ["refreshMessage text=final tail"]);
      assert.equal(
        emptyText,
        "The model completed without producing visible text.",
      );
    });

    it("returns the output-limit text, or nothing when images were generated", function () {
      const limited: ModelTurnOutcome = {
        text: "",
        completion: { status: "incomplete", reason: "output_limit" },
      };
      assert.equal(
        harness().turn.beginCompletion(limited),
        EMPTY_OUTPUT_LIMIT_MESSAGE,
      );

      const withImages = harness();
      withImages.message.generatedImages = [
        { id: "img-1", src: "data:image/png;base64,AAAA" },
      ] as Message["generatedImages"];
      assert.equal(withImages.turn.beginCompletion(limited), "");
    });

    it("stamps completion fields before quote finalization, then closes the trace", async function () {
      const { turn, log, message, quoteCalls } = harness({
        isCodexNativeTurn: true,
      });
      turn.attachCodexTrace();
      message.text = "the answer";
      const quotes = { conversationKey: KEY, paperContexts: [] };

      await turn.recordCompletion(
        {
          text: "the answer",
          completion: { status: "incomplete", reason: "provider_pause" },
        },
        quotes,
      );

      assert.equal(message.completionStatus, "incomplete");
      assert.equal(message.completionReason, "provider_pause");
      assert.deepEqual(log, [
        "quotes text=the answer status=incomplete",
        "trace.finish:the answer",
      ]);
      assert.deepEqual(quoteCalls, [quotes]);
    });

    it("clears the completion reason for a complete turn", async function () {
      const { turn, message } = harness();
      message.completionReason = "output_limit";

      await turn.recordCompletion(COMPLETE, {});

      assert.equal(message.completionStatus, "complete");
      assert.isUndefined(message.completionReason);
    });

    it("presents the finished turn after its flags are settled", function () {
      const { turn, log, message } = harness();
      message.interrupted = true;

      turn.presentCompletion({ compactMarker: true });

      assert.equal(message.text, "Conversation compacted");
      assert.isTrue(message.compactMarker);
      assert.isUndefined(message.interrupted);
      assert.deepEqual(log, [
        "refreshCompletedTurn text=Conversation compacted streaming=false",
      ]);
    });

    it("keeps the text of a compact turn that has one", function () {
      const { turn, message } = harness();
      message.text = "summary";

      turn.presentCompletion({ compactMarker: false });

      assert.equal(message.text, "summary");
      assert.isFalse(message.compactMarker);
    });
  });

  describe("saveCompletion", function () {
    /** Completes the turn the way both flows do before they save it. */
    async function completedTurn() {
      const rig = harness();
      rig.turn.start();
      rig.turn.push("the answer");
      rig.turn.beginCompletion(COMPLETE);
      await rig.turn.recordCompletion(COMPLETE, {});
      rig.turn.presentCompletion({ compactMarker: false });
      rig.log.length = 0;
      return rig;
    }

    /** The completed answer's state, which a failed save must not change. */
    const completedState = (message: Message) => ({
      text: message.text,
      streaming: message.streaming,
      interrupted: message.interrupted,
      completionStatus: message.completionStatus,
    });

    const logged: { level: string; args: readonly unknown[] }[] = [];
    beforeEach(function () {
      logged.length = 0;
      setAppLogSinkForTests((level, args) => logged.push({ level, args }));
    });
    afterEach(function () {
      setAppLogSinkForTests(null);
    });

    it("saves once and sets no status when the save succeeds", async function () {
      const { turn, log } = await completedTurn();
      const attempts: number[] = [];

      const saved = await turn.saveCompletion(async (attempt) => {
        attempts.push(attempt);
      });

      assert.isTrue(saved);
      assert.deepEqual(attempts, [0]);
      assert.deepEqual(log, []);
      assert.deepEqual(logged, []);
    });

    it("tries a failed save once more, and a second success saves the answer", async function () {
      const { turn, log, message } = await completedTurn();
      const before = completedState(message);
      const attempts: number[] = [];

      const saved = await turn.saveCompletion(async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw new Error("store busy");
      });

      assert.isTrue(saved);
      assert.deepEqual(attempts, [0, 1]);
      assert.deepEqual(log, [], "no status: the flow reports Ready");
      assert.deepEqual(completedState(message), before);
      assert.lengthOf(logged, 1, "the first failure is logged");
      assert.include(String(logged[0].args[0]), "not saved");
      assert.equal((logged[0].args[1] as Error).message, "store busy");
    });

    it("keeps the answer complete and warns when the second save fails too", async function () {
      const { turn, log, message } = await completedTurn();
      const before = completedState(message);
      assert.deepEqual(before, {
        text: "the answer",
        streaming: false,
        interrupted: undefined,
        completionStatus: "complete",
      });
      const attempts: number[] = [];

      const saved = await turn.saveCompletion(async (attempt) => {
        attempts.push(attempt);
        throw new Error(`write failed ${attempt}`);
      });

      assert.isFalse(saved);
      assert.deepEqual(attempts, [0, 1], "one save, then one more");
      assert.deepEqual(completedState(message), before, "not interrupted");
      assert.deepEqual(log, [
        "status:warning:Answer not saved. It will be lost when you reload.",
      ]);
      assert.deepEqual(
        logged.map((entry) => (entry.args[1] as Error).message),
        ["write failed 0", "write failed 1"],
        "both failures are logged with their errors",
      );
    });
  });

  describe("readInterruption", function () {
    // The read-before-dispose ORDER is pinned in the source by
    // chatStreamingResponseWiring.test.ts: the coalescer keeps its full text
    // after cancel, so the order is not observable from here.
    it("keeps the unreleased tail and refuses later deltas", function () {
      const { turn, message } = harness();
      turn.start();
      turn.push("partial tail");

      const interruption = turn.readInterruption(new Error("socket closed"), {
        codexLabel: "unused",
        imageCount: 0,
      });

      assert.deepEqual(interruption, {
        text: "partial tail",
        interrupted: true,
        errorMessage: "socket closed",
        retryHint: "",
      });
      // The stream was disposed: later deltas never reach the message.
      turn.push(PARAGRAPH);
      turn.flush("final");
      assert.equal(message.text, "");
    });

    it("falls back to the message text, then to an error notice with the hint", function () {
      const fromMessage = harness();
      fromMessage.turn.start();
      fromMessage.message.text = "released earlier";
      assert.include(
        fromMessage.turn.readInterruption(new Error("x"), {
          codexLabel: "unused",
          imageCount: 0,
        }),
        { text: "released earlier", interrupted: true },
      );

      const empty = harness();
      empty.turn.start();
      assert.deepEqual(
        empty.turn.readInterruption(new Error("413 payload too large"), {
          codexLabel: "unused",
          imageCount: 2,
        }),
        {
          text: "Error: 413 payload too large [hint for 413 payload too large x2]",
          interrupted: false,
          errorMessage: "413 payload too large",
          retryHint: " [hint for 413 payload too large x2]",
        },
      );
    });

    it("words a native Codex error with the flow's label", function () {
      const { turn } = harness({ isCodexNativeTurn: true });
      const error = new Error("codex exploded");

      const interruption = turn.readInterruption(error, {
        codexLabel: "Native conversation retry failed",
        imageCount: 0,
      });

      assert.equal(
        interruption.errorMessage,
        formatCodexZoteroMcpError(error, "Native conversation retry failed"),
      );
    });

    it("words an error without a message as Error", function () {
      const { turn } = harness();
      assert.equal(
        turn.readInterruption({}, { codexLabel: "unused", imageCount: 0 })
          .errorMessage,
        "Error",
      );
    });
  });

  describe("usage and end", function () {
    it("marks the dispatch on the flow's recorder", function () {
      const h = harness();
      h.turn.dispatched();
      assert.equal(h.dispatchedCount(), 1);
    });

    it("disposes the trace and flushes usage with the noted outcome, unawaited", function () {
      const { turn, log, usageFlushes } = harness({ isCodexNativeTurn: true });
      turn.attachCodexTrace();
      turn.noteUsageOutcome("abort");

      // The fake flush never settles; end() must still return synchronously.
      const result = turn.end();

      assert.isUndefined(result);
      assert.deepEqual(usageFlushes, ["abort"]);
      assert.deepEqual(log.slice(-2), ["trace.dispose", "usage.flush:abort"]);
    });

    it("flushes usage as complete when no outcome was noted", function () {
      const { turn, usageFlushes } = harness();
      turn.end();
      assert.deepEqual(usageFlushes, ["complete"]);
    });
  });
});

describe("finalizeCancelledAssistantMessage", function () {
  it("keeps streamed text, or falls back, and clears the streaming state", function () {
    const message = {
      role: "assistant",
      text: "",
      streaming: true,
      interrupted: true,
      completionStatus: "complete",
      reasoningSummary: "thought",
      reasoningOpen: undefined,
      webchatCompletionReason: "done",
    } as unknown as Message;

    finalizeCancelledAssistantMessage(message);

    assert.equal(message.text, "[Cancelled]");
    assert.isFalse(message.streaming);
    assert.isUndefined(message.interrupted);
    assert.isUndefined(message.completionStatus);
    assert.isTrue(message.reasoningOpen);
    assert.isNull(message.webchatCompletionReason);
    assert.isNumber(message.timestamp);
  });
});
