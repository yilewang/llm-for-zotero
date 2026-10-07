/**
 * A chat panel's history reload after a chat-list change (see
 * core/conversations/conversationCatalogEvents.ts).
 *
 * Every mounted panel hears every change, including panels nobody can see: a
 * sidebar panel in a reader tab that is not selected, a collapsed pane, a
 * minimized window. A shown panel reloads its history header and menu once per
 * burst of changes. A hidden panel puts the reload off and runs it once, when
 * it is shown again; opening its history menu reloads it anyway.
 */

export type CatalogReloadSchedulerDeps = {
  /** Runs the callback after the current turn (the panel window's timer). */
  defer: (run: () => void) => void;
  /** False once the panel is gone; nothing runs after that. */
  isAlive: () => boolean;
  isShown: () => boolean;
  /**
   * Calls onMaybeShown whenever the panel may have been shown; returns a
   * function that stops watching.
   */
  watchShown: (onMaybeShown: () => void) => () => void;
  /** Counts the panel's history reloads, whatever started them. */
  reloadsStarted: () => number;
  reload: () => void;
};

export function createCatalogReloadScheduler(
  deps: CatalogReloadSchedulerDeps,
): {
  onCatalogChanged: () => void;
  dispose: () => void;
} {
  let disposed = false;
  let scheduled = false;
  let reloadsAtLatestChange = 0;
  let stopWatching: (() => void) | null = null;

  const stopWatchingShown = () => {
    const stop = stopWatching;
    stopWatching = null;
    stop?.();
  };
  // No reload when the panel has already reloaded since the latest change
  // (typically its own write, or the user opening its history menu).
  const reloadIfStale = () => {
    if (deps.reloadsStarted() > reloadsAtLatestChange) return;
    deps.reload();
  };
  const onMaybeShown = () => {
    if (disposed || !stopWatching) return;
    if (!deps.isAlive()) {
      stopWatchingShown();
      return;
    }
    if (!deps.isShown()) return;
    stopWatchingShown();
    reloadIfStale();
  };

  return {
    onCatalogChanged: () => {
      if (disposed || !deps.isAlive()) return;
      reloadsAtLatestChange = deps.reloadsStarted();
      // A reload already scheduled, or waiting for the panel to be shown,
      // covers this change too.
      if (scheduled || stopWatching) return;
      scheduled = true;
      deps.defer(() => {
        scheduled = false;
        if (disposed || !deps.isAlive()) return;
        if (deps.isShown()) {
          reloadIfStale();
          return;
        }
        if (deps.reloadsStarted() > reloadsAtLatestChange) return;
        stopWatching = deps.watchShown(onMaybeShown);
      });
    },
    dispose: () => {
      disposed = true;
      stopWatchingShown();
    },
  };
}

type PanelWindow = Window & {
  windowState?: number;
  STATE_MINIMIZED?: number;
};

/**
 * Whether a chat panel is on screen: still in its document, laid out with a
 * size (not display:none, not in a collapsed pane), not hidden (a reader
 * tab's pane that is not selected), in a window that is not minimized.
 */
export function isChatPanelBodyShown(body: Element): boolean {
  if (!body.isConnected) return false;
  const win = body.ownerDocument?.defaultView as PanelWindow | null;
  if (!win) return false;
  // STATE_MINIMIZED is 2 on every Gecko chrome window.
  if (
    typeof win.windowState === "number" &&
    win.windowState === (win.STATE_MINIMIZED ?? 2)
  ) {
    return false;
  }
  try {
    const visibility = win.getComputedStyle(body)?.visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
  } catch {
    // No computed style: fall back to the layout box below.
  }
  const rect = (body as HTMLElement).getBoundingClientRect?.();
  if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
  return true;
}

type TabSelectionNotifier = {
  registerObserver: (
    observer: { notify: (event: string) => void },
    types: ["tab"],
    id: string,
  ) => string;
  unregisterObserver: (id: string) => void;
};

function getTabSelectionNotifier(): TabSelectionNotifier | undefined {
  try {
    return (
      globalThis as unknown as {
        Zotero?: { Notifier?: TabSelectionNotifier };
      }
    ).Zotero?.Notifier;
  } catch {
    return undefined;
  }
}

/**
 * Calls onMaybeShown whenever a panel may have come on screen: its box was
 * resized (shown after display:none, a pane expanded), a reader tab was
 * selected (a deck switch only changes visibility, which no resize reports),
 * or its window was restored. Returns a function that stops watching.
 */
export function watchChatPanelShown(
  body: Element,
  onMaybeShown: () => void,
  notifier: TabSelectionNotifier | undefined = getTabSelectionNotifier(),
): () => void {
  const doc = body.ownerDocument;
  const win = doc?.defaultView;
  const cleanups: Array<() => void> = [];
  const ResizeObserverCtor = (
    win as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
  )?.ResizeObserver;
  if (ResizeObserverCtor) {
    const observer = new ResizeObserverCtor(() => onMaybeShown());
    observer.observe(body);
    cleanups.push(() => observer.disconnect());
  }
  if (win) {
    const onWindowChange = () => onMaybeShown();
    win.addEventListener("sizemodechange", onWindowChange);
    doc.addEventListener("visibilitychange", onWindowChange);
    cleanups.push(() => {
      win.removeEventListener("sizemodechange", onWindowChange);
      doc.removeEventListener("visibilitychange", onWindowChange);
    });
    if (notifier) {
      let timer: number | undefined;
      let observerID: string | undefined;
      try {
        observerID = notifier.registerObserver(
          {
            notify: (event) => {
              if (event !== "select") return;
              // The tab deck switches after the notification.
              if (timer !== undefined) win.clearTimeout(timer);
              timer = win.setTimeout(() => {
                timer = undefined;
                onMaybeShown();
              }, 0) as unknown as number;
            },
          },
          ["tab"],
          "llm-history-panel-shown",
        );
      } catch {
        observerID = undefined;
      }
      cleanups.push(() => {
        if (timer !== undefined) win.clearTimeout(timer);
        if (observerID) notifier.unregisterObserver(observerID);
      });
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Stopping one watch must not keep the others alive.
      }
    }
  };
}
