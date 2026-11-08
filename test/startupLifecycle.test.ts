import { assert } from "chai";
import { describe, it } from "mocha";
import {
  createStartupLifecycle,
  watchStartupPhase,
  type StartupWindow,
} from "../src/core/startupLifecycle";

type FakeWindow = StartupWindow & {
  name: string;
  fireLoad: () => void;
  document: { readyState: string };
  closed: boolean;
};

function fakeWindow(name: string, readyState = "complete"): FakeWindow {
  const listeners: Array<() => void> = [];
  const win: FakeWindow = {
    name,
    closed: false,
    document: { readyState },
    addEventListener(_type, listener, options) {
      assert.deepEqual(options, { once: true });
      listeners.push(listener);
    },
    fireLoad() {
      win.document.readyState = "complete";
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return win;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const registered: string[] = [];
  const errors: Array<{
    error: unknown;
    cancelled: boolean;
    phase: string;
  }> = [];
  const lifecycle = createStartupLifecycle<FakeWindow>({
    registerWindow: (win) => registered.push(win.name),
    reportError: (error, context) =>
      errors.push({
        error,
        cancelled: context.cancelled,
        phase: context.phase,
      }),
  });
  return { lifecycle, registered, errors };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startup lifecycle", function () {
  it("returns from start() before the startup sequence settles", async function () {
    const { lifecycle } = setup();
    const gate = deferred();
    let finished = false;

    const returned = lifecycle.start(async () => {
      await gate.promise;
      finished = true;
    });

    assert.isUndefined(returned);
    await delay(0);
    assert.isFalse(finished);
    gate.resolve();
    await lifecycle.whenSettled();
    assert.isTrue(finished);
  });

  it("ignores a window load before the snapshot, then registers it once from the snapshot", function () {
    const { lifecycle, registered } = setup();
    const win = fakeWindow("main");

    lifecycle.onMainWindowLoad(win);
    assert.deepEqual(registered, []);

    lifecycle.registerMainWindows([win]);
    assert.deepEqual(registered, ["main"]);

    lifecycle.onMainWindowLoad(win);
    lifecycle.registerMainWindows([win]);
    assert.deepEqual(registered, ["main"]);
  });

  it("registers a window that loads after the snapshot once, directly", function () {
    const { lifecycle, registered } = setup();
    lifecycle.registerMainWindows([]);

    const win = fakeWindow("second");
    lifecycle.onMainWindowLoad(win);
    lifecycle.onMainWindowLoad(win);
    assert.deepEqual(registered, ["second"]);
  });

  it("registers a window again after it was unloaded", function () {
    const { lifecycle, registered } = setup();
    const win = fakeWindow("main");
    lifecycle.registerMainWindows([win]);
    lifecycle.onMainWindowUnload(win);
    lifecycle.onMainWindowLoad(win);
    assert.deepEqual(registered, ["main", "main"]);
  });

  it("registers a snapshot window that is still loading on its load event, once", function () {
    const { lifecycle, registered } = setup();
    const loading = fakeWindow("loading", "interactive");
    const closed = fakeWindow("closed");
    closed.closed = true;

    lifecycle.registerMainWindows([loading, closed]);
    assert.deepEqual(registered, []);

    // Zotero's own window-load hook and the snapshot's listener both fire.
    loading.fireLoad();
    lifecycle.onMainWindowLoad(loading);
    assert.deepEqual(registered, ["loading"]);
  });

  it("stops at the next check after a cancel and registers nothing", async function () {
    const { lifecycle, registered, errors } = setup();
    const gate = deferred();
    const win = fakeWindow("main");
    const steps: string[] = [];

    lifecycle.start(async () => {
      steps.push("stores");
      await gate.promise;
      if (lifecycle.isStopped()) return;
      steps.push("windows");
      lifecycle.registerMainWindows([win]);
    });
    await delay(0);

    const waiting = lifecycle.cancelAndWait(1_000);
    gate.resolve();
    assert.isTrue(await waiting);
    await lifecycle.whenSettled();

    lifecycle.registerMainWindows([win]);
    lifecycle.onMainWindowLoad(win);
    assert.deepEqual(steps, ["stores"]);
    assert.deepEqual(registered, []);
    assert.deepEqual(errors, []);
  });

  it("registers the remaining windows when one throws, then rethrows the first error", function () {
    const registered: string[] = [];
    const failure = new Error("window 1");
    const lifecycle = createStartupLifecycle<FakeWindow>({
      registerWindow: (win) => {
        if (win.name === "bad1") throw failure;
        if (win.name === "bad2") throw new Error("window 2");
        registered.push(win.name);
      },
      reportError: () => {},
    });

    assert.throws(
      () =>
        lifecycle.registerMainWindows([
          fakeWindow("bad1"),
          fakeWindow("good"),
          fakeWindow("bad2"),
        ]),
      failure,
    );
    assert.deepEqual(registered, ["good"]);
  });

  it("reports a load-listener failure as a window failure, not a startup failure", function () {
    const failure = new Error("register failed");
    const errors: Array<{ phase: string; cancelled: boolean }> = [];
    const lifecycle = createStartupLifecycle<FakeWindow>({
      registerWindow: () => {
        throw failure;
      },
      reportError: (error, context) => {
        assert.strictEqual(error, failure);
        errors.push(context);
      },
    });
    const loading = fakeWindow("loading", "loading");

    lifecycle.registerMainWindows([loading]);
    loading.fireLoad();

    assert.deepEqual(errors, [{ cancelled: false, phase: "window" }]);
    assert.isFalse(lifecycle.isStopped());
  });

  it("does not register a loading snapshot window after a cancel", async function () {
    const { lifecycle, registered } = setup();
    const loading = fakeWindow("loading", "loading");
    lifecycle.registerMainWindows([loading]);

    assert.isTrue(await lifecycle.cancelAndWait(10));
    loading.fireLoad();
    assert.deepEqual(registered, []);
  });

  it("reports a failed startup once, never rejects, and registers no window", async function () {
    const { lifecycle, registered, errors } = setup();
    const failure = new Error("store init failed");
    const win = fakeWindow("main");

    lifecycle.start(async () => {
      await delay(0);
      throw failure;
    });
    await lifecycle.whenSettled();

    assert.isTrue(lifecycle.isStopped());
    assert.deepEqual(errors, [
      { error: failure, cancelled: false, phase: "startup" },
    ]);
    lifecycle.registerMainWindows([win]);
    lifecycle.onMainWindowLoad(win);
    assert.deepEqual(registered, []);
  });

  it("reports a synchronous throw from the sequence as a failure", async function () {
    const { lifecycle, errors } = setup();
    const failure = new Error("sync");

    lifecycle.start(() => {
      throw failure;
    });
    await lifecycle.whenSettled();

    assert.deepEqual(errors, [
      { error: failure, cancelled: false, phase: "startup" },
    ]);
  });

  it("marks a failure that follows a cancel as cancelled", async function () {
    const { lifecycle, errors } = setup();
    const gate = deferred();
    const failure = new Error("surface disposed");

    lifecycle.start(async () => {
      await gate.promise;
      throw failure;
    });
    await delay(0);
    const waiting = lifecycle.cancelAndWait(1_000);
    gate.resolve();
    assert.isTrue(await waiting);

    assert.deepEqual(errors, [
      { error: failure, cancelled: true, phase: "startup" },
    ]);
  });

  it("gives up waiting after the timeout while the sequence is still pending", async function () {
    const { lifecycle } = setup();
    const gate = deferred();
    lifecycle.start(() => gate.promise);

    assert.isFalse(await lifecycle.cancelAndWait(10));
    assert.isTrue(lifecycle.isStopped());
    gate.resolve();
    await lifecycle.whenSettled();
  });

  it("reports a settled wait when nothing was started", async function () {
    const { lifecycle } = setup();
    assert.isTrue(await lifecycle.cancelAndWait(10));
  });
});

describe("startup phase watchdog", function () {
  it("warns once for a phase that has not settled in time", async function () {
    const traces: string[] = [];
    const slow: number[] = [];

    const value = await watchStartupPhase(
      "stuck store",
      async () => {
        await delay(60);
        return 7;
      },
      {
        trace: (message) => traces.push(message),
        onSlow: (ms) => slow.push(ms),
        slowAfterMs: 10,
      },
    );

    assert.equal(value, 7);
    assert.deepEqual(slow, [10]);
    assert.lengthOf(traces, 2);
    assert.match(traces[0], /stuck store started/);
    assert.match(traces[1], /stuck store finished in \d+ms/);
  });

  it("does not warn for a phase that settles in time", async function () {
    const slow: number[] = [];

    await watchStartupPhase("fast", () => 1, {
      trace: () => undefined,
      onSlow: (ms) => slow.push(ms),
      slowAfterMs: 20,
    });
    await delay(40);

    assert.deepEqual(slow, []);
  });

  it("traces a failed phase with its label and rethrows", async function () {
    const traces: string[] = [];
    const slow: number[] = [];
    const failure = new Error("boom");

    let caught: unknown;
    try {
      await watchStartupPhase(
        "migrations",
        () => {
          throw failure;
        },
        {
          trace: (message) => traces.push(message),
          onSlow: (ms) => slow.push(ms),
          slowAfterMs: 10,
        },
      );
    } catch (error) {
      caught = error;
    }
    await delay(30);

    assert.strictEqual(caught, failure);
    assert.match(traces[1], /migrations failed after \d+ms/);
    assert.deepEqual(slow, []);
  });
});
