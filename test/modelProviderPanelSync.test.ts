import { assert } from "chai";
import { createModelProviderGroupsPanelSync } from "../src/modules/contextPanel/modelProviderPanelSync";
import { createDeferredNotifier } from "../src/modules/preferences/deferredNotifier";

function panel(connected = true) {
  return { isConnected: connected } as unknown as Element;
}

describe("provider settings change → open chat panels", function () {
  it("syncs model controls without rebuilding chats when runtime entries are unchanged", function () {
    let signature = "entries-v1";
    let fullRefreshes = 0;
    const first = panel();
    const second = panel();
    const panels = [first, second];
    const sync = createModelProviderGroupsPanelSync({
      listPanels: () => panels,
      readModelEntriesSignature: () => signature,
      refreshAllPanels: () => {
        fullRefreshes += 1;
      },
    });
    const synced: Element[] = [];
    sync.register(first, () => synced.push(first));
    sync.register(second, () => synced.push(second));

    sync.onModelProviderGroupsChanged();

    assert.equal(fullRefreshes, 0);
    assert.deepEqual(synced, [first, second]);

    signature = "entries-v2";
    sync.onModelProviderGroupsChanged();
    assert.equal(fullRefreshes, 1);
    assert.lengthOf(synced, 4);

    sync.onModelProviderGroupsChanged();
    assert.equal(fullRefreshes, 1);
  });

  it("rebuilds chats on the first change when no panel recorded the entries", function () {
    let fullRefreshes = 0;
    const sync = createModelProviderGroupsPanelSync({
      listPanels: () => [],
      readModelEntriesSignature: () => "entries",
      refreshAllPanels: () => {
        fullRefreshes += 1;
      },
    });
    sync.onModelProviderGroupsChanged();
    assert.equal(fullRefreshes, 1);
  });

  it("skips disconnected and unregistered panels", function () {
    const gone = panel(false);
    const retired = panel();
    const live = panel();
    const sync = createModelProviderGroupsPanelSync({
      listPanels: () => [gone, retired, live],
      readModelEntriesSignature: () => "entries",
      refreshAllPanels: () => undefined,
    });
    const synced: Element[] = [];
    sync.register(gone, () => synced.push(gone));
    const unregister = sync.register(retired, () => synced.push(retired));
    sync.register(live, () => synced.push(live));
    unregister();

    sync.onModelProviderGroupsChanged();

    assert.deepEqual(synced, [live]);
  });
});

describe("deferred notifier for typed settings", function () {
  function fakeTimers() {
    let next = 1;
    const pending = new Map<number, () => void>();
    return {
      host: {
        setTimeout: (callback: () => void) => {
          const id = next++;
          pending.set(id, callback);
          return id;
        },
        clearTimeout: (id: unknown) => {
          pending.delete(id as number);
        },
      },
      pending,
      fireAll() {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback();
      },
    };
  }

  it("coalesces a burst into one notification after the delay", function () {
    const timers = fakeTimers();
    let notifications = 0;
    const notifier = createDeferredNotifier({
      ...timers.host,
      notify: () => {
        notifications += 1;
      },
      delayMs: 300,
    });
    notifier.schedule();
    notifier.schedule();
    notifier.schedule();
    assert.equal(timers.pending.size, 1);
    assert.equal(notifications, 0);
    timers.fireAll();
    assert.equal(notifications, 1);
  });

  it("flushes a pending notification at once and only once", function () {
    const timers = fakeTimers();
    let notifications = 0;
    const notifier = createDeferredNotifier({
      ...timers.host,
      notify: () => {
        notifications += 1;
      },
    });
    notifier.flush();
    assert.equal(notifications, 0);
    notifier.schedule();
    notifier.flush();
    notifier.flush();
    assert.equal(notifications, 1);
    assert.equal(timers.pending.size, 0);
  });

  it("drops a pending notification that an immediate save already covered", function () {
    const timers = fakeTimers();
    let notifications = 0;
    const notifier = createDeferredNotifier({
      ...timers.host,
      notify: () => {
        notifications += 1;
      },
    });
    notifier.schedule();
    notifier.cancel();
    timers.fireAll();
    notifier.flush();
    assert.equal(notifications, 0);
  });
});
