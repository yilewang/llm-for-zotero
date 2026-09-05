import { assert } from "chai";
import {
  createCoalescedFrameScheduler,
  getOrCreateKeyedInFlightTask,
} from "../src/modules/contextPanel/setupHandlers/controllers/uiSchedulingController";

describe("uiSchedulingController", function () {
  it("coalesces repeated frame work until the next animation frame", function () {
    const frameCallbacks: FrameRequestCallback[] = [];
    const canceled = new Set<number>();
    const win = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: (handle: number) => {
        canceled.add(handle);
      },
    };
    let calls = 0;
    const scheduler = createCoalescedFrameScheduler({
      getWindow: () => win,
      run: () => {
        calls += 1;
      },
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    assert.equal(calls, 0);
    assert.equal(frameCallbacks.length, 1);
    assert.isTrue(scheduler.isPending());

    frameCallbacks[0](16);

    assert.equal(calls, 1);
    assert.isFalse(scheduler.isPending());
    assert.equal(canceled.size, 0);
  });

  it("flushes pending frame work synchronously", function () {
    const frameCallbacks: FrameRequestCallback[] = [];
    const canceled = new Set<number>();
    const win = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: (handle: number) => {
        canceled.add(handle);
      },
    };
    let calls = 0;
    const scheduler = createCoalescedFrameScheduler({
      getWindow: () => win,
      run: () => {
        calls += 1;
      },
    });

    scheduler.schedule();
    scheduler.flush();

    assert.equal(calls, 1);
    assert.isFalse(scheduler.isPending());
    assert.deepEqual(Array.from(canceled), [1]);
  });

  it("falls back when an available animation frame is throttled", function () {
    let frameCallback: FrameRequestCallback | null = null;
    let timeoutCallback: (() => void) | null = null;
    let timeoutDelay = -1;
    const canceledFrames = new Set<number>();
    const clearedTimeouts = new Set<number>();
    const win = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      },
      cancelAnimationFrame: (handle: number) => {
        canceledFrames.add(handle);
      },
      setTimeout: (callback: () => void, delay?: number) => {
        timeoutCallback = callback;
        timeoutDelay = delay ?? 0;
        return 2;
      },
      clearTimeout: (handle: number) => {
        clearedTimeouts.add(handle);
      },
    };
    let calls = 0;
    const scheduler = createCoalescedFrameScheduler({
      getWindow: () => win,
      run: () => {
        calls += 1;
      },
    });

    scheduler.schedule();

    assert.equal(timeoutDelay, 100);
    assert.isTrue(scheduler.isPending());
    timeoutCallback?.();
    assert.equal(calls, 1);
    assert.isFalse(scheduler.isPending());
    assert.deepEqual(Array.from(canceledFrames), [1]);
    assert.equal(clearedTimeouts.size, 0);

    frameCallback?.(16);
    assert.equal(calls, 1);
  });

  it("dedupes repeated keyed async work while in flight", async function () {
    const tasks = new Map<number, Promise<void>>();
    let starts = 0;
    let release: (() => void) | null = null;
    const createTask = () =>
      new Promise<void>((resolve) => {
        starts += 1;
        release = resolve;
      });

    const first = getOrCreateKeyedInFlightTask(tasks, 42, createTask);
    const second = getOrCreateKeyedInFlightTask(tasks, 42, createTask);

    assert.strictEqual(second, first);
    assert.equal(starts, 1);
    assert.isTrue(tasks.has(42));

    release?.();
    await first;

    assert.isFalse(tasks.has(42));
    await getOrCreateKeyedInFlightTask(tasks, 42, async () => {
      starts += 1;
    });
    assert.equal(starts, 2);
  });
});
