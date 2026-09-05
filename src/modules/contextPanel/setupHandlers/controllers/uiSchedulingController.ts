type FrameSchedulerWindow = {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: (callback: () => void, delay?: number) => number;
  clearTimeout?: (handle: number) => void;
};

type CoalescedFrameSchedulerOptions = {
  getWindow: () => FrameSchedulerWindow | null | undefined;
  run: () => void;
};

export type CoalescedFrameScheduler = {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
  isPending: () => boolean;
};

const THROTTLED_FRAME_FALLBACK_MS = 100;

export function createCoalescedFrameScheduler(
  options: CoalescedFrameSchedulerOptions,
): CoalescedFrameScheduler {
  let pending = false;
  let frameHandle: number | null = null;
  let timeoutHandle: number | null = null;

  const clearScheduledHandle = () => {
    const win = options.getWindow();
    if (frameHandle !== null) {
      win?.cancelAnimationFrame?.(frameHandle);
    }
    if (timeoutHandle !== null) {
      if (win?.clearTimeout) {
        win.clearTimeout(timeoutHandle);
      } else {
        clearTimeout(timeoutHandle as unknown as ReturnType<typeof setTimeout>);
      }
    }
    frameHandle = null;
    timeoutHandle = null;
  };

  const runNow = () => {
    if (!pending) return;
    clearScheduledHandle();
    pending = false;
    options.run();
  };

  return {
    schedule: () => {
      if (pending) return;
      pending = true;
      const win = options.getWindow();
      if (win?.requestAnimationFrame) {
        frameHandle = win.requestAnimationFrame(() => {
          frameHandle = null;
          runNow();
        });
        // Background Zotero windows may expose requestAnimationFrame while
        // throttling it indefinitely. Keep panel state synchronized even when
        // no frame is delivered.
        const timeoutFn =
          win.setTimeout?.bind(win) ||
          ((callback: () => void, delay?: number) =>
            setTimeout(callback, delay) as unknown as number);
        timeoutHandle = timeoutFn(() => {
          timeoutHandle = null;
          runNow();
        }, THROTTLED_FRAME_FALLBACK_MS);
        return;
      }
      const timeoutFn =
        win?.setTimeout?.bind(win) ||
        ((callback: () => void, delay?: number) =>
          setTimeout(callback, delay) as unknown as number);
      timeoutHandle = timeoutFn(() => {
        timeoutHandle = null;
        runNow();
      }, 0);
    },
    flush: () => {
      if (!pending) return;
      clearScheduledHandle();
      runNow();
    },
    cancel: () => {
      if (!pending) return;
      clearScheduledHandle();
      pending = false;
    },
    isPending: () => pending,
  };
}

export function getOrCreateKeyedInFlightTask<K>(
  tasks: Map<K, Promise<void>>,
  key: K,
  createTask: () => Promise<void>,
): Promise<void> {
  const existing = tasks.get(key);
  if (existing) return existing;
  const task = (async () => createTask())().finally(() => {
    if (tasks.get(key) === task) {
      tasks.delete(key);
    }
  });
  tasks.set(key, task);
  return task;
}
