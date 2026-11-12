/**
 * Coalesces repeated change notifications into one, sent `delayMs` after the
 * last `schedule()`. Settings text fields save on every keystroke; the chat
 * panels listening to those saves only need to hear about the burst once.
 */
export function createDeferredNotifier(params: {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  notify: () => void;
  delayMs?: number;
}): {
  /** Restart the delay; one notification follows the last call. */
  schedule: () => void;
  /** Send a pending notification now (blur, window close). */
  flush: () => void;
  /** Drop a pending notification that another save already sent. */
  cancel: () => void;
} {
  const delayMs = params.delayMs ?? 300;
  let handle: unknown = null;
  const cancel = () => {
    if (handle === null) return;
    params.clearTimeout(handle);
    handle = null;
  };
  return {
    schedule: () => {
      cancel();
      handle = params.setTimeout(() => {
        handle = null;
        params.notify();
      }, delayMs);
    },
    flush: () => {
      if (handle === null) return;
      cancel();
      params.notify();
    },
    cancel,
  };
}
