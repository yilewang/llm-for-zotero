import { assert } from "chai";
import { describe, it } from "mocha";
import {
  createInlineAskSession,
  type InlineAskTurnRunner,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskSession";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A runner the test drives: each call is held until the test settles it. */
function heldRunner() {
  const calls: Array<{
    prompt: string;
    history: Array<{ role: string; content: string }>;
    signal?: AbortSignal;
    onDelta: (delta: string) => void;
    result: Deferred<{ text: string; errorMessage?: string }>;
  }> = [];
  const runTurn: InlineAskTurnRunner = (input) => {
    const result = deferred<{ text: string; errorMessage?: string }>();
    calls.push({ ...input, result });
    return result.promise;
  };
  return { calls, runTurn };
}

function fakeAbortControllers() {
  const made: Array<{ aborted: boolean }> = [];
  return {
    made,
    create: () => {
      const state = { aborted: false };
      made.push(state);
      return {
        signal: state as unknown as AbortSignal,
        abort: () => {
          state.aborted = true;
        },
      };
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createInlineAskSession", function () {
  it("starts in compose without a conversation", function () {
    const { runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    assert.equal(session.getState().phase, "compose");
    assert.deepEqual(session.getState().turns, []);
    assert.isFalse(session.hasConversation());
  });

  it("streams an answer: waiting, then streaming, then answered", async function () {
    const { calls, runTurn } = heldRunner();
    const phases: string[] = [];
    const session = createInlineAskSession({
      runTurn,
      onChange: (state) => phases.push(state.phase),
    });
    assert.isTrue(session.send("  What is drift?  "));
    assert.equal(session.getState().phase, "waiting");
    assert.isTrue(session.hasConversation());
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].prompt, "What is drift?");
    assert.deepEqual(calls[0].history, []);
    calls[0].onDelta("Drift is ");
    assert.equal(session.getState().phase, "streaming");
    calls[0].onDelta("change.");
    const turns = session.getState().turns;
    assert.deepEqual(
      turns.map((turn) => [turn.role, turn.text]),
      [
        ["user", "What is drift?"],
        ["assistant", "Drift is change."],
      ],
    );
    calls[0].result.resolve({ text: "Drift is change." });
    await flush();
    assert.equal(session.getState().phase, "answered");
    const answer = session.getState().turns[1];
    assert.equal(answer.role, "assistant");
    assert.equal(answer.role === "assistant" && answer.status, "done");
    assert.includeMembers(phases, ["waiting", "streaming", "answered"]);
  });

  it("shows a quick prompt's label but sends its full prompt", function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    session.send("Explain this passage in plain language.", "Explain");
    assert.equal(calls[0].prompt, "Explain this passage in plain language.");
    const first = session.getState().turns[0];
    assert.equal(first.role === "user" && first.shownText, "Explain");
    assert.equal(first.text, "Explain this passage in plain language.");
  });

  it("refuses an empty prompt and a send while an answer is running", function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    assert.isFalse(session.send("   "));
    assert.isTrue(session.send("first"));
    assert.isFalse(session.send("second"));
    assert.lengthOf(calls, 1);
  });

  it("sends earlier finished turns as history for a follow-up", async function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    session.send("Q1 full", "Q1");
    calls[0].onDelta("A1");
    calls[0].result.resolve({ text: "A1" });
    await flush();
    session.send("Q2");
    assert.deepEqual(calls[1].history, [
      { role: "user", content: "Q1 full" },
      { role: "assistant", content: "A1" },
    ]);
  });

  it("keeps a failed turn on screen but out of the history", async function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    session.send("Q1");
    calls[0].result.resolve({ text: "", errorMessage: "No output" });
    await flush();
    const failed = session.getState().turns[1];
    assert.equal(failed.role === "assistant" && failed.status, "error");
    assert.equal(failed.text, "No output");
    assert.equal(session.getState().phase, "answered");
    session.send("Q2");
    assert.deepEqual(calls[1].history, []);

    calls[1].result.reject(new Error("HTTP 500"));
    await flush();
    const rejected = session.getState().turns[3];
    assert.equal(rejected.role === "assistant" && rejected.status, "error");
    assert.equal(rejected.text, "HTTP 500");
  });

  it("stop aborts the request and drops deltas that arrive late", async function () {
    const { calls, runTurn } = heldRunner();
    const aborts = fakeAbortControllers();
    let changes = 0;
    const session = createInlineAskSession({
      runTurn,
      onChange: () => {
        changes += 1;
      },
      createAbortController: aborts.create,
    });
    session.send("Q1");
    calls[0].onDelta("partial");
    session.stop();
    assert.isTrue(aborts.made[0].aborted);
    assert.equal(session.getState().phase, "answered");
    const changesAfterStop = changes;
    calls[0].onDelta(" late");
    calls[0].result.resolve({ text: "partial late" });
    await flush();
    assert.equal(session.getState().turns[1].text, "partial");
    assert.equal(changes, changesAfterStop);
  });

  it("a late delta from a stopped turn never reaches the next turn", async function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({ runTurn, onChange: () => {} });
    session.send("Q1");
    session.stop();
    session.send("Q2");
    calls[0].onDelta("stale");
    calls[1].onDelta("fresh");
    calls[0].result.resolve({ text: "stale" });
    await flush();
    const turns = session.getState().turns;
    assert.equal(turns[turns.length - 1].text, "fresh");
    assert.notInclude(
      turns.map((turn) => turn.text),
      "stale",
    );
  });

  it("dispose stops the request and reports no more changes", async function () {
    const { calls, runTurn } = heldRunner();
    const aborts = fakeAbortControllers();
    let changes = 0;
    const session = createInlineAskSession({
      runTurn,
      onChange: () => {
        changes += 1;
      },
      createAbortController: aborts.create,
    });
    session.send("Q1");
    const before = changes;
    session.dispose();
    assert.isTrue(aborts.made[0].aborted);
    calls[0].onDelta("late");
    calls[0].result.resolve({ text: "late" });
    await flush();
    assert.equal(changes, before);
    assert.isFalse(session.send("Q2"));
  });

  it("runs without an AbortController", async function () {
    const { calls, runTurn } = heldRunner();
    const session = createInlineAskSession({
      runTurn,
      onChange: () => {},
      createAbortController: () => null,
    });
    session.send("Q1");
    assert.isUndefined(calls[0].signal);
    session.stop();
    calls[0].onDelta("late");
    assert.lengthOf(session.getState().turns, 1);
  });
});
