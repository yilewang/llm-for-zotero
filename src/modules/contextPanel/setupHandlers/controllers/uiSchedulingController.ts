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

export function createCoalescedFrameScheduler(
  options: CoalescedFrameSchedulerOptions,
): CoalescedFrameScheduler {
  let pending = false;
  let frameHandle: number | null = null;
  let timeoutHandle: number | null = null;
  let scheduledWithRaf = false;

  const clearScheduledHandle = () => {
    const win = options.getWindow();
    if (frameHandle !== null && scheduledWithRaf) {
      win?.cancelAnimationFrame?.(frameHandle);
    } else if (timeoutHandle !== null) {
      if (win?.clearTimeout) {
        win.clearTimeout(timeoutHandle);
      } else {
        clearTimeout(timeoutHandle as unknown as ReturnType<typeof setTimeout>);
      }
    }
    frameHandle = null;
    timeoutHandle = null;
    scheduledWithRaf = false;
  };

  const runNow = () => {
    pending = false;
    frameHandle = null;
    timeoutHandle = null;
    scheduledWithRaf = false;
    options.run();
  };

  return {
    schedule: () => {
      if (pending) return;
      pending = true;
      const win = options.getWindow();
      if (win?.requestAnimationFrame) {
        scheduledWithRaf = true;
        frameHandle = win.requestAnimationFrame(() => runNow());
        return;
      }
      const timeoutFn =
        win?.setTimeout?.bind(win) ||
        ((callback: () => void, delay?: number) =>
          setTimeout(callback, delay) as unknown as number);
      timeoutHandle = timeoutFn(() => runNow(), 0);
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
  let task: Promise<void>;
  task = (async () => createTask())().finally(() => {
    if (tasks.get(key) === task) {
      tasks.delete(key);
    }
  });
  tasks.set(key, task);
  return task;
}
