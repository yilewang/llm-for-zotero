/**
 * Lifecycle of the plugin's background startup sequence.
 *
 * Zotero awaits each plugin's bootstrap `startup()` before it starts the next
 * plugin, and each plugin's `onMainWindowLoad` before the next plugin's
 * (issue #528). The plugin therefore runs its startup steps in a background
 * task and never awaits that task from a bootstrap hook. This module owns the
 * task, the cancel and failure state, and per-window registration, so a window
 * is registered exactly once and nothing is registered after a failed or
 * cancelled startup. It has no Zotero dependency; the caller injects effects.
 */

/** The part of a main window this module reads. */
export type StartupWindow = {
  readonly closed: boolean;
  readonly document: { readonly readyState: string };
  addEventListener(
    type: "load",
    listener: () => void,
    options: { once: true },
  ): void;
};

export type StartupLifecycleOptions<W extends StartupWindow> = {
  /** Adds the plugin's UI to one main window. Must not await. */
  registerWindow: (win: W) => void;
  /**
   * Receives a failed startup sequence, once, or a window that failed to
   * register on its load event. `cancelled` is true when shutdown had already
   * begun, so teardown may have caused the error.
   */
  reportError: (
    error: unknown,
    context: { cancelled: boolean; phase: "startup" | "window" },
  ) => void;
};

export type StartupLifecycle<W extends StartupWindow> = {
  /** Starts the sequence and returns at once. Call once per plugin instance. */
  start: (run: () => Promise<void>) => void;
  /** True after a cancel or a failure; the sequence must register nothing more. */
  isStopped: () => boolean;
  /** Settles with the sequence; never rejects. */
  whenSettled: () => Promise<void>;
  /**
   * Registers the main windows open now and lets the window-load hook register
   * later windows directly. A window that is still loading registers on its
   * load event. Throws when a window fails to register.
   */
  registerMainWindows: (windows: Iterable<W>) => void;
  /** Zotero's window-load hook. Ignores windows until the snapshot is taken. */
  onMainWindowLoad: (win: W) => void;
  onMainWindowUnload: (win: W) => void;
  /**
   * Stops the sequence at its next check and waits up to `timeoutMs` for it to
   * settle. Resolves false when it did not settle in time.
   */
  cancelAndWait: (timeoutMs: number) => Promise<boolean>;
};

export function createStartupLifecycle<W extends StartupWindow>(
  options: StartupLifecycleOptions<W>,
): StartupLifecycle<W> {
  let task: Promise<void> | null = null;
  let cancelled = false;
  let failed = false;
  let mainWindowsSnapshotTaken = false;
  let registeredWindows = new WeakSet<W>();

  const isStopped = () => cancelled || failed;

  function report(error: unknown, phase: "startup" | "window"): void {
    try {
      options.reportError(error, { cancelled, phase });
    } catch {
      // Reporting must never turn a handled failure into an unhandled one.
    }
  }

  // The check and the add happen before registerWindow runs, and nothing here
  // awaits, so two callers for one window cannot both register it.
  function registerOnce(win: W): void {
    if (isStopped() || registeredWindows.has(win)) return;
    registeredWindows.add(win);
    options.registerWindow(win);
  }

  return {
    start(run) {
      task = Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          failed = true;
          report(error, "startup");
        });
    },
    isStopped,
    whenSettled: () => task ?? Promise.resolve(),
    registerMainWindows(windows) {
      mainWindowsSnapshotTaken = true;
      // One window failing must not skip the others; the first error is
      // rethrown after the loop.
      let firstError: { error: unknown } | null = null;
      for (const win of windows) {
        if (win.closed) continue;
        if (win.document.readyState === "complete") {
          try {
            registerOnce(win);
          } catch (error) {
            firstError ??= { error };
          }
          continue;
        }
        win.addEventListener(
          "load",
          () => {
            try {
              registerOnce(win);
            } catch (error) {
              report(error, "window");
            }
          },
          { once: true },
        );
      }
      if (firstError) throw firstError.error;
    },
    onMainWindowLoad(win) {
      if (!mainWindowsSnapshotTaken) return;
      registerOnce(win);
    },
    onMainWindowUnload(win) {
      registeredWindows.delete(win);
    },
    async cancelAndWait(timeoutMs) {
      cancelled = true;
      const settled = task ? await waitWithTimeout(task, timeoutMs) : true;
      registeredWindows = new WeakSet<W>();
      return settled;
    },
  };
}

/** Resolves true when `task` settles within `timeoutMs`, false otherwise. */
export async function waitWithTimeout(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export type StartupPhaseWatch = {
  /** Writes the phase start and end; shown whatever the plugin's log level. */
  trace: (message: string) => void;
  /** Called once if the phase has not settled after `slowAfterMs`. */
  onSlow: (elapsedMs: number) => void;
  slowAfterMs: number;
};

/**
 * Runs one startup phase with a start and end trace, so a startup that hangs
 * names the phase it hangs in, and warns once if the phase is slow.
 */
export async function watchStartupPhase<T>(
  label: string,
  task: () => Promise<T> | T,
  watch: StartupPhaseWatch,
): Promise<T> {
  const start = Date.now();
  watch.trace(`LLM startup: ${label} started`);
  const timer = setTimeout(() => {
    try {
      watch.onSlow(watch.slowAfterMs);
    } catch {
      // A diagnostic must not throw out of a timer.
    }
  }, watch.slowAfterMs);
  try {
    const value = await task();
    watch.trace(`LLM startup: ${label} finished in ${Date.now() - start}ms`);
    return value;
  } catch (error) {
    watch.trace(`LLM startup: ${label} failed after ${Date.now() - start}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
