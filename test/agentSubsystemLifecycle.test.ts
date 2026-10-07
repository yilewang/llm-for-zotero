import { assert } from "chai";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
  shutdownAgentSubsystem,
} from "../src/agent/index";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type { AgentModelStep } from "../src/agent/types";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function captureRejection(task: Promise<unknown>): Promise<unknown> {
  try {
    await task;
    return null;
  } catch (error) {
    return error;
  }
}

function installAgentLifecycleTestZotero() {
  const gates: Array<Deferred<unknown[]>> = [];
  let gatedAgentRunTableCreates = 0;
  const endpoints: Record<string, unknown> = {};
  const globalScope = globalThis as typeof globalThis & { Zotero?: any };
  const originalZotero = globalScope.Zotero;
  globalScope.Zotero = {
    DB: {
      executeTransaction: async (callback: () => Promise<unknown>) =>
        await callback(),
      queryAsync: async (sql: string) => {
        if (
          sql.includes(
            "CREATE TABLE IF NOT EXISTS llm_for_zotero_agent_runs",
          ) &&
          gates.length
        ) {
          gatedAgentRunTableCreates += 1;
          return await gates.shift()!.promise;
        }
        return [];
      },
    },
    Server: {
      Endpoints: endpoints,
    },
    Profile: {
      dir: "/tmp/llm-for-zotero-agent-lifecycle-test",
    },
    debug: () => undefined,
  };
  return {
    endpoints,
    gates,
    getGatedAgentRunTableCreates: () => gatedAgentRunTableCreates,
    restore: () => {
      globalScope.Zotero = originalZotero;
    },
  };
}

describe("agent subsystem lifecycle", function () {
  let restoreZotero: (() => void) | null = null;

  afterEach(function () {
    try {
      shutdownAgentSubsystem();
    } catch {
      // Ignore cleanup errors if the fake Zotero object has already been removed.
    }
    restoreZotero?.();
    restoreZotero = null;
  });

  it("does not publish an init that finishes after shutdown", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const gate = createDeferred<unknown[]>();
    fixture.gates.push(gate);

    const initTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 1);

    shutdownAgentSubsystem();
    gate.resolve([]);
    const error = await captureRejection(initTask);

    assert.instanceOf(error, Error);
    assert.match(String((error as Error).message), /cancelled/);
    assert.throws(() => getCoreAgentRuntime(), /not initialized/);
    assert.deepEqual(Object.keys(fixture.endpoints), []);
  });

  it("does not let a stale init finalizer clear a newer init task", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const staleGate = createDeferred<unknown[]>();
    fixture.gates.push(staleGate);

    const staleTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 1);

    shutdownAgentSubsystem();

    const currentGate = createDeferred<unknown[]>();
    fixture.gates.push(currentGate);
    const currentTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 2);

    staleGate.resolve([]);
    const staleError = await captureRejection(staleTask);
    assert.instanceOf(staleError, Error);
    assert.match(String((staleError as Error).message), /cancelled/);

    const unexpectedThirdGate = createDeferred<unknown[]>();
    fixture.gates.push(unexpectedThirdGate);
    const sameCurrentTask = initAgentSubsystem();
    await flushMicrotasks();
    const gatedCount = fixture.getGatedAgentRunTableCreates();
    if (gatedCount > 2) {
      unexpectedThirdGate.resolve([]);
    }
    assert.equal(gatedCount, 2);

    currentGate.resolve([]);
    const [currentRuntime, sameCurrentRuntime] = await Promise.all([
      currentTask,
      sameCurrentTask,
    ]);
    assert.strictEqual(currentRuntime, sameCurrentRuntime);
    assert.strictEqual(getCoreAgentRuntime(), currentRuntime);
  });

  it("passes the caller's Stop signal from the public runTurn to the runtime, and none by default", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const runtime = await initAgentSubsystem();
    const received: Array<{ signal?: AbortSignal }> = [];
    runtime.runTurn = (async (params: { signal?: AbortSignal }) => {
      received.push(params);
      return { kind: "completed", runId: "run-1", text: "" };
    }) as never;
    const request = {
      conversationKey: 7,
      conversationGeneration: 0,
      mode: "agent" as const,
      userText: "continue",
    };
    const stop = new AbortController();
    await getAgentApi().runTurn(request, undefined, { signal: stop.signal });
    await getAgentApi().runTurn(request);
    assert.strictEqual(received[0].signal, stop.signal);
    assert.notProperty(received[1], "signal");
  });
});

/**
 * The public `runTurn` is a third-party contract: a turn the caller stopped
 * rejects with `Error("Aborted")`, or with what the stopped provider call
 * threw, and a turn the provider failed rejects with the provider's error.
 */
describe("public agent API runTurn endings", function () {
  let restoreDb: (() => void) | null = null;

  afterEach(function () {
    try {
      shutdownAgentSubsystem();
    } catch {
      // The fake Zotero object may not carry what shutdown unregisters.
    }
    restoreDb?.();
    restoreDb = null;
  });

  /** The public API over a real runtime whose model is `runStep`. */
  async function publicApiOver(
    runStep: (params: AgentStepParams) => Promise<AgentModelStep>,
    registry = new AgentToolRegistry(),
    runtimeOptions: { stoppedRunWaitMs?: number } = {},
  ) {
    const fixture = installAgentLifecycleTestZotero();
    const subsystem = await initAgentSubsystem();
    fixture.restore();
    restoreDb = installMockDb();
    const real = new AgentRuntime({
      registry,
      ...runtimeOptions,
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        runStep,
      }),
    });
    subsystem.runTurn = real.runTurn.bind(real);
    return Object.assign(getAgentApi(), { real });
  }

  const request = (conversationKey: number) => ({
    conversationKey,
    mode: "agent" as const,
    userText: "Read the notes",
    model: "test",
    apiBase: "",
    apiKey: "test",
  });

  const readStep: AgentModelStep = {
    kind: "tool_calls",
    calls: [{ id: "c1", name: "read_notes", arguments: {} }],
    assistantMessage: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", name: "read_notes", arguments: {} }],
    },
  };

  it("resolves an answered turn to its completed outcome", async function () {
    const api = await publicApiOver(async () => ({
      kind: "final",
      text: "The answer.",
      assistantMessage: { role: "assistant", content: "The answer." },
    }));
    const outcome = await api.runTurn(request(9401));
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") assert.equal(outcome.text, "The answer.");
  });

  it('rejects with Error("Aborted") when the caller stopped the turn between steps', async function () {
    const stop = new AbortController();
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_notes",
        description: "Read notes",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: (async () => {
        stop.abort();
        return { notes: [] };
      }) as never,
    });
    const api = await publicApiOver(async () => readStep, registry);
    const error = await captureRejection(
      api.runTurn(request(9402), undefined, { signal: stop.signal }),
    );
    assert.instanceOf(error, Error);
    assert.equal((error as Error).message, "Aborted");
  });

  it("rejects with the stopped provider call's own error when the caller stopped it in flight", async function () {
    const stop = new AbortController();
    const thrown = new Error("The request was aborted.");
    const api = await publicApiOver(async () => {
      stop.abort();
      throw thrown;
    });
    const error = await captureRejection(
      api.runTurn(request(9403), undefined, { signal: stop.signal }),
    );
    assert.strictEqual(error, thrown);
  });

  it("rejects with the provider's own error when the provider failed", async function () {
    class ProviderError extends Error {
      readonly status = 503;
    }
    const thrown = new ProviderError("provider down");
    const api = await publicApiOver(async () => {
      throw thrown;
    });
    const error = await captureRejection(api.runTurn(request(9404)));
    assert.strictEqual(error, thrown);
  });
  it("sends the wait for a stopped prior run to the caller's onEvent as a status", async function () {
    const held = createDeferred<void>();
    const reading = createDeferred<void>();
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_notes",
        description: "Read notes",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: (async () => {
        reading.resolve();
        await held.promise;
        return { notes: [] };
      }) as never,
    });
    const api = await publicApiOver(
      async (params) =>
        params.request.userText === "prior"
          ? params.messages.some((message) => message.role === "tool")
            ? {
                kind: "final",
                text: "Prior.",
                assistantMessage: { role: "assistant", content: "Prior." },
              }
            : readStep
          : {
              kind: "final",
              text: "Done.",
              assistantMessage: { role: "assistant", content: "Done." },
            },
      registry,
      { stoppedRunWaitMs: 20 },
    );
    const prior = api.real.runTurn({
      request: { ...request(9405), userText: "prior" },
    });
    await reading.promise;
    const statuses: string[] = [];
    const outcome = await api.runTurn(
      { ...request(9405), userText: "next" },
      (event) => {
        if (event.type === "status") statuses.push(event.text);
      },
    );
    held.resolve();
    await prior;
    assert.equal(outcome.kind, "completed");
    assert.equal(statuses[0], "Waiting for the stopped run to finish");
  });

  it("rethrows a returned ending's cause, or rebuilds its error when none was kept", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreDb = fixture.restore;
    const subsystem = await initAgentSubsystem();
    const cause = new Error("bridge report");
    const endings = [
      { kind: "cancelled", runId: "r1" },
      {
        kind: "failed",
        runId: "r2",
        message: "provider down",
        interrupted: true,
      },
      {
        kind: "failed",
        runId: "r3",
        message: "redacted",
        interrupted: false,
        cause,
      },
      { kind: "cancelled", runId: "r4", cause },
    ];
    let next = 0;
    subsystem.runTurn = (async () => endings[next++]) as never;
    const rejections = [];
    for (let index = 0; index < endings.length; index++)
      rejections.push(
        await captureRejection(getAgentApi().runTurn(request(9405))),
      );
    assert.deepEqual(
      rejections
        .slice(0, 2)
        .map((error) => [error instanceof Error, (error as Error).message]),
      [
        [true, "Aborted"],
        [true, "provider down"],
      ],
    );
    assert.strictEqual(rejections[2], cause);
    assert.strictEqual(rejections[3], cause);
  });
});
