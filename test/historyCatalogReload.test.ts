import { assert } from "chai";
import {
  createCatalogReloadScheduler,
  isChatPanelBodyShown,
  watchChatPanelShown,
} from "../src/modules/contextPanel/historyCatalogReload";

describe("historyCatalogReload: a panel's history reload after a chat-list change", function () {
  function createHarness(options: { shown?: boolean } = {}) {
    const deferred: Array<() => void> = [];
    const state = {
      alive: true,
      shown: options.shown ?? true,
      reloadsStarted: 0,
      reloads: 0,
      watching: 0,
      onMaybeShown: null as (() => void) | null,
    };
    const scheduler = createCatalogReloadScheduler({
      defer: (run) => {
        deferred.push(run);
      },
      isAlive: () => state.alive,
      isShown: () => state.shown,
      watchShown: (onMaybeShown) => {
        state.watching += 1;
        state.onMaybeShown = onMaybeShown;
        return () => {
          state.watching -= 1;
          state.onMaybeShown = null;
        };
      },
      reloadsStarted: () => state.reloadsStarted,
      reload: () => {
        state.reloadsStarted += 1;
        state.reloads += 1;
      },
    });
    const runDeferred = () => {
      while (deferred.length) deferred.shift()!();
    };
    return { scheduler, state, runDeferred, deferred };
  }

  it("reloads a shown panel once per burst of changes", function () {
    const { scheduler, state, runDeferred, deferred } = createHarness();
    scheduler.onCatalogChanged();
    scheduler.onCatalogChanged();
    scheduler.onCatalogChanged();
    assert.lengthOf(deferred, 1, "one scheduled reload per burst");
    runDeferred();
    assert.equal(state.reloads, 1);
  });

  it("skips the reload when the panel already reloaded since the change", function () {
    const { scheduler, state, runDeferred } = createHarness();
    scheduler.onCatalogChanged();
    state.reloadsStarted += 1; // the panel's own write reloaded it
    runDeferred();
    assert.equal(state.reloads, 0);
  });

  it("defers a hidden panel's reload and runs it once when the panel is shown", function () {
    const { scheduler, state, runDeferred } = createHarness({ shown: false });
    scheduler.onCatalogChanged();
    runDeferred();
    // Two more bursts while hidden.
    scheduler.onCatalogChanged();
    runDeferred();
    scheduler.onCatalogChanged();
    runDeferred();
    assert.equal(state.reloads, 0, "a hidden panel does not reload");
    assert.equal(state.watching, 1, "one watch for being shown");
    // A signal while still hidden does nothing.
    state.onMaybeShown?.();
    assert.equal(state.reloads, 0);
    state.shown = true;
    state.onMaybeShown?.();
    assert.equal(state.reloads, 1, "one reload when shown");
    assert.equal(state.watching, 0, "the watch ends once flushed");
    // Back to normal afterwards.
    scheduler.onCatalogChanged();
    runDeferred();
    assert.equal(state.reloads, 2);
  });

  it("drops a deferred reload that a later reload already covered", function () {
    const { scheduler, state, runDeferred } = createHarness({ shown: false });
    scheduler.onCatalogChanged();
    runDeferred();
    state.reloadsStarted += 1; // e.g. the user opened the history menu
    state.shown = true;
    state.onMaybeShown?.();
    assert.equal(state.reloads, 0);
    assert.equal(state.watching, 0);
  });

  it("a change after that covering reload is still flushed when shown", function () {
    const { scheduler, state, runDeferred } = createHarness({ shown: false });
    scheduler.onCatalogChanged();
    runDeferred();
    state.reloadsStarted += 1;
    scheduler.onCatalogChanged();
    runDeferred();
    state.shown = true;
    state.onMaybeShown?.();
    assert.equal(state.reloads, 1);
  });

  it("stops watching and never reloads after dispose or once the panel is gone", function () {
    const first = createHarness({ shown: false });
    first.scheduler.onCatalogChanged();
    first.runDeferred();
    assert.equal(first.state.watching, 1);
    first.scheduler.dispose();
    assert.equal(first.state.watching, 0);
    first.state.shown = true;
    first.scheduler.onCatalogChanged();
    first.runDeferred();
    assert.equal(first.state.reloads, 0);

    const second = createHarness({ shown: false });
    second.scheduler.onCatalogChanged();
    second.runDeferred();
    second.state.alive = false;
    second.state.shown = true;
    const signal = second.state.onMaybeShown;
    signal?.();
    assert.equal(second.state.reloads, 0);
    assert.equal(second.state.watching, 0);
  });
});

describe("historyCatalogReload: whether a chat panel is on screen", function () {
  type FakeStyle = { visibility: string };
  function createBody(
    options: {
      connected?: boolean;
      visibility?: string;
      width?: number;
      height?: number;
      windowState?: number;
    } = {},
  ) {
    const win = {
      STATE_MINIMIZED: 2,
      windowState: options.windowState ?? 3,
      getComputedStyle: (): FakeStyle => ({
        visibility: options.visibility ?? "visible",
      }),
    };
    return {
      isConnected: options.connected ?? true,
      ownerDocument: { defaultView: win },
      getBoundingClientRect: () => ({
        width: options.width ?? 300,
        height: options.height ?? 500,
      }),
    } as unknown as Element;
  }

  it("is shown when connected, laid out, visible, and its window is not minimized", function () {
    assert.isTrue(isChatPanelBodyShown(createBody()));
  });

  it("is hidden when detached, in a hidden reader tab, collapsed, or minimized", function () {
    assert.isFalse(isChatPanelBodyShown(createBody({ connected: false })));
    assert.isFalse(isChatPanelBodyShown(createBody({ visibility: "hidden" })));
    assert.isFalse(
      isChatPanelBodyShown(createBody({ visibility: "collapse" })),
    );
    assert.isFalse(isChatPanelBodyShown(createBody({ width: 0, height: 0 })));
    assert.isFalse(isChatPanelBodyShown(createBody({ width: 0 })));
    assert.isFalse(isChatPanelBodyShown(createBody({ windowState: 2 })));
  });

  it("watches resizes, reader tab selection and window restore, and stops on dispose", function () {
    const observed: unknown[] = [];
    let disconnected = 0;
    const listeners = new Map<string, Set<() => void>>();
    const timers: Array<() => void> = [];
    const win = {
      ResizeObserver: class {
        constructor(private callback: () => void) {}
        observe(target: unknown) {
          observed.push(target);
          resizeCallbacks.push(this.callback);
        }
        disconnect() {
          disconnected += 1;
        }
      },
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
      setTimeout: (run: () => void) => {
        timers.push(run);
        return timers.length;
      },
      clearTimeout: () => undefined,
    };
    const resizeCallbacks: Array<() => void> = [];
    const doc = {
      defaultView: win,
      addEventListener: win.addEventListener,
      removeEventListener: win.removeEventListener,
    };
    const body = { ownerDocument: doc } as unknown as Element;
    const notifierObservers = new Map<
      string,
      { notify: (event: string) => void }
    >();
    const notifier = {
      registerObserver: (
        observer: { notify: (event: string) => void },
        _types: string[],
      ) => {
        const id = `observer-${notifierObservers.size + 1}`;
        notifierObservers.set(id, observer);
        return id;
      },
      unregisterObserver: (id: string) => {
        notifierObservers.delete(id);
      },
    };
    let signals = 0;
    const stop = watchChatPanelShown(body, () => (signals += 1), notifier);
    assert.deepEqual(observed, [body]);
    resizeCallbacks[0]();
    assert.equal(signals, 1, "a resize signals");
    for (const observer of notifierObservers.values())
      observer.notify("select");
    assert.equal(signals, 1, "tab selection waits for the deck to switch");
    timers.shift()!();
    assert.equal(signals, 2, "then signals");
    for (const observer of notifierObservers.values()) observer.notify("add");
    assert.lengthOf(timers, 0, "other tab events are ignored");
    for (const listener of listeners.get("sizemodechange") || []) listener();
    assert.equal(signals, 3, "a window restore signals");
    stop();
    assert.equal(disconnected, 1);
    assert.equal(notifierObservers.size, 0);
    assert.equal(listeners.get("sizemodechange")?.size || 0, 0);
    assert.equal(listeners.get("visibilitychange")?.size || 0, 0);
  });
});
