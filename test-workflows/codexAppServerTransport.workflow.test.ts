import { assert } from "chai";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import {
  createFakeStdioProcess,
  settle,
  type FakeStdioProcess,
} from "../test/helpers/fakeStdioProcess";

/**
 * The Codex app-server connection on a scripted stdio child: framing,
 * request correlation, timeouts, server-request dispatch, notifications, and
 * shutdown. These pin the wire behavior Codex mode depends on, so moving the
 * transport into a shared layer cannot change it.
 */
describe("workflow: Codex app-server transport", function () {
  this.timeout(30000);

  let child: FakeStdioProcess;
  let proc: CodexAppServerProcess;

  function open(): CodexAppServerProcess {
    child = createFakeStdioProcess();
    proc = CodexAppServerProcess.forTest(child, "codex app-server --test");
    proc.startForTest();
    return proc;
  }

  afterEach(async function () {
    await proc?.destroyAndWait().catch(() => undefined);
  });

  it("writes requests without a jsonrpc field and matches responses split across chunks", async function () {
    open();
    const first = proc.sendRequest("thread/start", { cwd: "/tmp" });
    const second = proc.sendRequest("model/list", {});
    await child.waitForSent(2);
    assert.deepEqual(child.sent(), [
      { method: "thread/start", id: 1, params: { cwd: "/tmp" } },
      { method: "model/list", id: 2, params: {} },
    ]);
    // Second answer first, the two in one chunk split mid-message.
    const wire =
      `${JSON.stringify({ id: 2, result: { data: ["m"] } })}\n` +
      `${JSON.stringify({ id: 1, result: { thread: { id: "t1" } } })}\n`;
    child.pushStdout(wire.slice(0, 17));
    child.pushStdout(wire.slice(17));
    assert.deepEqual(await second, { data: ["m"] });
    assert.deepEqual(await first, { thread: { id: "t1" } });
  });

  it("rejects an error response with the server's message", async function () {
    open();
    const request = proc.sendRequest("thread/inject_items", {});
    await child.waitForSent(1);
    child.emit({
      id: 1,
      error: { code: -32601, message: "unknown method thread/inject_items" },
    });
    let failure: unknown;
    try {
      await request;
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.equal(
      (failure as Error).message,
      "unknown method thread/inject_items",
    );
  });

  it("times out a request, and kills the process unless told not to", async function () {
    open();
    let soft: unknown;
    await proc
      .sendRequest("account/read", {}, 30, { failProcessOnTimeout: false })
      .catch((error) => (soft = error));
    assert.equal(
      (soft as Error).message,
      "Timed out waiting for codex app-server response to account/read after 30ms",
    );
    assert.isFalse(child.killed());

    const reasons: Array<string | undefined> = [];
    proc.onClose((reason) => reasons.push(reason));
    let hard: unknown;
    await proc.sendRequest("turn/start", {}, 30).catch((e) => (hard = e));
    assert.match((hard as Error).message, /response to turn\/start after 30ms/);
    assert.isTrue(child.killed());
    assert.deepEqual(reasons, [
      "Timed out waiting for codex app-server response to turn/start after 30ms",
    ]);
    let after: unknown;
    await proc.sendRequest("x", {}).catch((e) => (after = e));
    assert.equal((after as Error).message, "CodexAppServerProcess destroyed");
  });

  it("dispatches server requests to the handler that accepts them", async function () {
    open();
    const seen: string[] = [];
    proc.onRequest(
      "item/tool/requestUserInput",
      async (params: any) => {
        seen.push(`thread:${params.threadId}`);
        return { answer: "accepted" };
      },
      (params: any) => params?.threadId === "t-mine",
    );
    proc.onRequest("item/tool/requestUserInput", async () => {
      seen.push("fallback");
      return { answer: "fallback" };
    });
    child.emit({
      id: 50,
      method: "item/tool/requestUserInput",
      params: { threadId: "t-mine", turnId: "u1" },
    });
    child.emit({
      id: 51,
      method: "item/tool/requestUserInput",
      params: { threadId: "t-other", turnId: "u2" },
    });
    await child.waitForSent(2);
    assert.sameDeepMembers(child.sent(), [
      { id: 50, result: { answer: "accepted" } },
      { id: 51, result: { answer: "fallback" } },
    ]);
    assert.sameMembers(seen, ["thread:t-mine", "fallback"]);
  });

  it("answers an unhandled server request with -32601 and a failed handler with -32000", async function () {
    open();
    proc.onRequest("item/fileChange/requestApproval", async () => {
      throw new Error("review card unavailable");
    });
    child.emit({ id: 7, method: "unknown/request", params: {} });
    child.emit({
      id: 8,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t" },
    });
    await child.waitForSent(2);
    assert.sameDeepMembers(child.sent(), [
      {
        id: 7,
        error: {
          code: -32601,
          message: "No handler registered for unknown/request",
        },
      },
      { id: 8, error: { code: -32000, message: "review card unavailable" } },
    ]);
  });

  it("stops answering a request the server resolved or whose turn completed", async function () {
    open();
    const signals: AbortSignal[] = [];
    proc.onRequest("item/tool/requestUserInput", (_params, _id, signal) => {
      signals.push(signal as AbortSignal);
      return new Promise((resolve) =>
        (signal as AbortSignal).addEventListener("abort", () =>
          resolve({ late: true }),
        ),
      );
    });
    child.emit({
      id: 1,
      method: "item/tool/requestUserInput",
      params: { threadId: "t", turnId: "u" },
    });
    child.emit({
      id: 2,
      method: "item/tool/requestUserInput",
      params: { threadId: "t", turnId: "v" },
    });
    await settle(10);
    assert.isTrue(proc.hasPendingUserInput("t"));
    child.emit({
      method: "serverRequest/resolved",
      params: { requestId: 1, threadId: "t" },
    });
    child.emit({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "v" } },
    });
    await settle(20);
    assert.lengthOf(signals, 2);
    assert.isTrue(signals.every((signal) => signal.aborted));
    assert.deepEqual(child.sent(), []);
    assert.isFalse(proc.hasPendingUserInput("t"));
  });

  it("delivers notifications and shows every message to activity listeners", async function () {
    open();
    const deltas: unknown[] = [];
    const activity: unknown[] = [];
    proc.onNotification("item/agentMessage/delta", (params) =>
      deltas.push(params),
    );
    proc.onActivity((message) => activity.push(message));
    const request = proc.sendRequest("ping", {});
    child.emit({ method: "item/agentMessage/delta", params: { delta: "Hi" } });
    child.emit({ id: 1, result: {} });
    await request;
    assert.deepEqual(deltas, [{ delta: "Hi" }]);
    assert.deepEqual(activity, [
      { method: "item/agentMessage/delta", params: { delta: "Hi" } },
      { id: 1, result: {} },
    ]);
  });

  it("fails pending requests with the stderr tail when the process exits on its own", async function () {
    open();
    const reasons: Array<string | undefined> = [];
    proc.onClose((reason) => reasons.push(reason));
    const request = proc.sendRequest("thread/start", {});
    child.pushStdout("not json\n");
    child.pushStderr("fatal: config is broken\n");
    await settle(10);
    child.exit(1);
    let failure: unknown;
    await request.catch((error) => (failure = error));
    assert.equal(
      (failure as Error).message,
      "codex app-server process closed unexpectedly: not json fatal: config is broken (launched: codex app-server --test)",
    );
    assert.deepEqual(reasons, [(failure as Error).message]);
  });

  it("destroys cleanly: pending requests fail, the child is killed, and waiting returns", async function () {
    open();
    const request = proc.sendRequest("thread/start", {});
    await child.waitForSent(1);
    const settled = await proc.destroyAndWait();
    let failure: unknown;
    await request.catch((error) => (failure = error));
    assert.equal((failure as Error).message, "CodexAppServerProcess destroyed");
    assert.isTrue(child.killed());
    assert.isTrue(settled);
    const late: string[] = [];
    proc.onClose((reason) => late.push(String(reason)));
    assert.deepEqual(late, ["CodexAppServerProcess destroyed"]);
  });
});
