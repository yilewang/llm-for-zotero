import { assert } from "chai";
import { runHarnessProcess } from "../src/deepseekHarness/process";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

function pipe() {
  const chunks: string[] = [];
  let waiting: ((value: string) => void) | undefined;
  return {
    push(value: string) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(value);
      } else chunks.push(value);
    },
    readString() {
      return chunks.length
        ? Promise.resolve(chunks.shift()!)
        : new Promise<string>((resolve) => (waiting = resolve));
    },
  };
}

describe("Harness model-time budget", function () {
  const originalLoad = CodexAppServerProcess.loadSubprocessModule;
  const originalZotero = globalThis.Zotero;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  let now: number;
  let nextTimer: number;
  let timers: Map<number, { at: number; fn: () => void }>;
  let stdout: ReturnType<typeof pipe>;
  let stderr: ReturnType<typeof pipe>;
  let runId: number;
  let resolveTool: (value: unknown) => void;
  let controller: AbortController;
  let toolCalls: number;

  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  const tick = async (duration: number) => {
    now += duration;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
    await flush();
  };
  const start = () =>
    runHarnessProcess(
      {
        model: "test",
        contextWindow: 131072,
        apiBase: "http://test",
        apiKey: "secret",
        systemPrompt: "",
        history: [],
        tools: [],
      },
      "test",
      {
        signal: controller.signal,
        onStop: () => controller.abort(),
        onEvent: async () => {},
        onToolCall: async () => {
          toolCalls++;
          return new Promise((resolve) => {
            resolveTool = resolve;
            controller.signal.addEventListener("abort", () => resolve(null), {
              once: true,
            });
          });
        },
      },
    );

  beforeEach(function () {
    now = 1000;
    nextTimer = 0;
    timers = new Map();
    toolCalls = 0;
    stdout = pipe();
    stderr = pipe();
    controller = new AbortController();
    Date.now = () => now;
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, fn });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) =>
      timers.delete(id)) as unknown as typeof clearTimeout;
    globalThis.Zotero = {
      Prefs: { get: () => "/test/runtime" },
    } as typeof Zotero;
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async () => ({
        stdout,
        stderr,
        stdin: {
          write: async (line: string) => {
            const message = JSON.parse(line);
            if (message.method === "initialize")
              stdout.push(
                JSON.stringify({ id: message.id, result: {} }) + "\n",
              );
            if (message.method === "run") runId = message.id;
            if (message.method === "checkpoint")
              stdout.push(
                JSON.stringify({ id: message.id, result: { saved: true } }) +
                  "\n",
              );
          },
          close: async () => {
            stdout.push("");
            stderr.push("");
          },
        },
        wait: async () => {},
        kill: () => {},
      }),
    });
  });
  afterEach(function () {
    CodexAppServerProcess.loadSubprocessModule = originalLoad;
    globalThis.Zotero = originalZotero;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realNow;
  });

  it("keeps a question pending beyond ten minutes and renews the model-step budget", async function () {
    const result = start();
    await flush();
    await tick(100000);
    stdout.push(
      JSON.stringify({
        method: "tool_call",
        id: "question",
        params: { callId: "q1", name: "request_user_input", args: {} },
      }) + "\n",
    );
    await flush();
    assert.equal(toolCalls, 1);
    await tick(1200000);
    assert.equal(
      timers.size,
      0,
      "No model deadline runs while the host tool waits",
    );
    resolveTool({ selected: "A" });
    await flush();
    await tick(499999);
    stdout.push(
      JSON.stringify({ id: runId, result: { text: "completed" } }) + "\n",
    );
    assert.deepEqual(await result, { text: "completed" });
  });

  it("checkpoints a timed-out step once and bounds the resumed attempt", async function () {
    const result = start().then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await flush();
    await tick(600000);
    await tick(600000);
    assert.equal(await result, "Harness run timed out");
  });

  it("renews the deadline when a model step completes", async function () {
    const result = start();
    await flush();
    await tick(500000);
    stdout.push(
      JSON.stringify({ method: "event", params: { type: "usage", round: 1 } }) +
        "\n",
    );
    await flush();
    await tick(500000);
    stdout.push(
      JSON.stringify({ id: runId, result: { text: "completed" } }) + "\n",
    );
    assert.deepEqual(await result, { text: "completed" });
  });

  it("continues a checkpointed step without dispatching another host tool", async function () {
    const result = start();
    await flush();
    const firstRun = runId;
    await tick(600000);
    assert.notEqual(runId, firstRun);
    stdout.push(
      JSON.stringify({ id: runId, result: { text: "resumed" } }) + "\n",
    );
    assert.deepEqual(await result, { text: "resumed" });
    assert.equal(toolCalls, 0);
  });

  it("allows cancellation while a question waits", async function () {
    const result = start().then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await flush();
    stdout.push(
      JSON.stringify({
        method: "tool_call",
        id: "question",
        params: { callId: "q1", name: "request_user_input", args: {} },
      }) + "\n",
    );
    await flush();
    controller.abort();
    await flush();
    assert.equal(await result, "Cancelled");
  });
});
