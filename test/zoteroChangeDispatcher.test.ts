import { assert } from "chai";
import { ZoteroChangeDispatcher } from "../src/services/zoteroChangeDispatcher";

describe("Zotero change observer lifecycle", function () {
  it("registers once, delivers native changes, and unregisters on shutdown", async function () {
    const original = globalThis.Zotero;
    let registrations = 0;
    let observer: { notify: (...args: any[]) => Promise<void> } | undefined;
    const removed: string[] = [];
    (globalThis as any).Zotero = {
      Notifier: {
        registerObserver: (value: typeof observer, types: string[]) => {
          registrations++;
          observer = value;
          assert.includeMembers(types, [
            "item",
            "collection",
            "collection-item",
            "item-tag",
            "trash",
          ]);
          return "native-library-observer";
        },
        unregisterObserver: (id: string) => removed.push(id),
      },
    };
    const dispatcher = new ZoteroChangeDispatcher();
    try {
      const delivered: string[] = [];
      dispatcher.subscribe("library-index", (change) => {
        delivered.push(
          `${change.type}:${change.event}:${change.ids.join(",")}`,
        );
      });
      dispatcher.registerNativeObserver();
      dispatcher.registerNativeObserver();
      assert.equal(registrations, 1);
      await observer!.notify("add", "collection", [17], {});
      await observer!.notify("add", "collection-item", ["17-81"], {});
      assert.deepEqual(delivered, [
        "collection:add:17",
        "collection-item:add:17-81",
      ]);
      dispatcher.unregisterNativeObserver();
      dispatcher.unregisterNativeObserver();
      assert.deepEqual(removed, ["native-library-observer"]);
      dispatcher.registerNativeObserver();
      assert.equal(
        registrations,
        2,
        "a new plugin lifecycle can register again",
      );
    } finally {
      dispatcher.unregisterNativeObserver?.();
      if (original) (globalThis as any).Zotero = original;
      else delete (globalThis as any).Zotero;
    }
  });
});
