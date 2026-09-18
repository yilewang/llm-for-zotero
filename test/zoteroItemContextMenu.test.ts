import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  clearContextSurfaceActionTargetsForTests,
  dispatchZoteroItemsAsContext,
  dispatchZoteroItemsToSidebar,
  drainPendingStandaloneContextItemsForTests,
  registerContextSurfaceActionTarget,
  registerZoteroItemContextMenu,
} from "../src/modules/contextPanel/zoteroItemContextMenu";
import {
  clearMineruManagerNavigationForTests,
  registerMineruManagerSelectionTarget,
} from "../src/modules/mineruManagerNavigation";

function makeItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: () => `Item ${id}`,
  } as unknown as Zotero.Item;
}

describe("Zotero item context menu dispatch", function () {
  afterEach(function () {
    clearContextSurfaceActionTargetsForTests();
    clearMineruManagerNavigationForTests();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
  });

  it("prepares and targets only the dropped-on sidebar, even with another surface open", async function () {
    const body = { isConnected: true } as Element;
    const unrelated = { isConnected: true } as Element;
    const container = {
      contains: (element: Element) => element === body,
    } as Element;
    const received: number[][] = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "embedded",
      prepareItemsAsDefaultContextTarget: async () => {
        registerContextSurfaceActionTarget(body, {
          surfaceKind: "embedded",
          addItemsAsDefaultContext: async (items) => {
            received.push(items.map((item) => item.id));
            return { changed: true };
          },
        });
        return true;
      },
      addItemsAsDefaultContext: async () => {
        throw new Error("stale target");
      },
    });
    registerContextSurfaceActionTarget(unrelated, {
      surfaceKind: "standalone",
      addItemsAsDefaultContext: async () => {
        throw new Error("wrong surface");
      },
    });
    assert.isTrue(
      await dispatchZoteroItemsToSidebar(container, [makeItem(1), makeItem(2)]),
    );
    assert.deepEqual(received, [[1, 2]]);
  });

  it("abandons sidebar drops when preparation is refused or the target is removed", async function () {
    for (const disconnect of [false, true]) {
      const body = { isConnected: true } as Element;
      const container = {
        contains: (element: Element) => element === body,
      } as Element;
      registerContextSurfaceActionTarget(body, {
        surfaceKind: "embedded",
        prepareItemsAsDefaultContextTarget: async () => {
          if (disconnect) (body as any).isConnected = false;
          return disconnect;
        },
        addItemsAsDefaultContext: async () => {
          throw new Error("must not add");
        },
      });
      assert.isFalse(
        await dispatchZoteroItemsToSidebar(container, [
          makeItem(1),
          makeItem(2),
        ]),
      );
    }
  });

  it("registers the Zotero item-tree command between separators", function () {
    const registrations: Array<{
      menu: string;
      options: { id?: string; label?: string; tag?: string };
    }> = [];
    const toolkit = {
      Menu: {
        register: (menu: string, options: any) => {
          registrations.push({ menu, options });
        },
      },
    };

    registerZoteroItemContextMenu({
      ztoolkit: toolkit as any,
      getSelectedItems: () => [],
      openStandaloneChat: () => undefined,
    });

    assert.lengthOf(registrations, 3);
    assert.deepEqual(
      registrations.map((registration) => registration.menu),
      ["item", "item", "item"],
    );
    assert.equal(registrations[0].options.tag, "menuseparator");
    assert.equal(registrations[1].options.tag, "menuitem");
    assert.equal(
      registrations[1].options.label,
      "Add Items as Context to LLM-for-Zotero",
    );
    assert.equal(registrations[2].options.tag, "menuseparator");
  });

  it("opens MinerU manager and preselects every PDF below the selected item", function () {
    const parent = {
      id: 10,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getAttachments: () => [11, 12, 13],
      getField: () => "Parent",
    } as unknown as Zotero.Item;
    const pdfA = {
      id: 11,
      libraryID: 1,
      isRegularItem: () => false,
      isAttachment: () => true,
      attachmentContentType: "application/pdf",
    } as unknown as Zotero.Item;
    const pdfB = {
      id: 12,
      libraryID: 1,
      isRegularItem: () => false,
      isAttachment: () => true,
      attachmentContentType: "application/pdf",
    } as unknown as Zotero.Item;
    const noteAttachment = {
      id: 13,
      libraryID: 1,
      isRegularItem: () => false,
      isAttachment: () => true,
      attachmentContentType: "text/html",
    } as unknown as Zotero.Item;
    const items = new Map<number, Zotero.Item>([
      [11, pdfA],
      [12, pdfB],
      [13, noteAttachment],
    ]);
    (globalThis as unknown as { Zotero: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => items.get(id) || null },
    };

    let requestedIds: readonly number[] = [];
    registerMineruManagerSelectionTarget((attachmentIds) => {
      requestedIds = [...attachmentIds];
      return true;
    });

    const registrations: Array<{
      options: {
        id?: string;
        label?: string;
        commandListener?: () => void;
      };
    }> = [];
    let openCount = 0;
    registerZoteroItemContextMenu({
      ztoolkit: {
        Menu: {
          register: (_menu: string, options: any) => {
            registrations.push({ options });
          },
        },
      } as any,
      getSelectedItems: () => [parent],
      openStandaloneChat: () => undefined,
      openMineruManager: () => {
        openCount += 1;
      },
    });

    const mineruCommand = registrations.find(
      ({ options }) => options.id === "llmforzotero-recognize-pdfs-with-mineru",
    )?.options;
    assert.equal(mineruCommand?.label, "Open MinerU Manager");
    assert.isFunction(mineruCommand?.commandListener);

    mineruCommand?.commandListener?.();

    assert.deepEqual(requestedIds, [11, 12]);
    assert.equal(openCount, 1);
  });

  it("opens MinerU manager even when the selected item has no PDF", function () {
    const parentWithoutPdf = {
      id: 20,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getAttachments: () => [],
      getField: () => "No PDF",
    } as unknown as Zotero.Item;
    (globalThis as unknown as { Zotero: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { get: () => null },
    };

    const registrations: Array<{
      options: {
        id?: string;
        commandListener?: () => void;
      };
    }> = [];
    let openCount = 0;
    registerZoteroItemContextMenu({
      ztoolkit: {
        Menu: {
          register: (_menu: string, options: any) => {
            registrations.push({ options });
          },
        },
      } as any,
      getSelectedItems: () => [parentWithoutPdf],
      openStandaloneChat: () => undefined,
      openMineruManager: () => {
        openCount += 1;
      },
    });

    registrations
      .find(
        ({ options }) =>
          options.id === "llmforzotero-recognize-pdfs-with-mineru",
      )
      ?.options.commandListener?.();

    assert.equal(openCount, 1);
  });

  it("opens standalone instead of dispatching to a mounted embedded chat surface", async function () {
    const item = makeItem(1);
    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "embedded",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);
    assert.deepEqual(received, []);

    const standaloneReceived: Zotero.Item[][] = [];
    await drainPendingStandaloneContextItemsForTests(async (items) => {
      standaloneReceived.push(items);
      return { changed: true };
    });
    assert.deepEqual(standaloneReceived, [[item]]);
  });

  it("focuses an existing standalone surface and dispatches there", async function () {
    const item = makeItem(3);
    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const completed: Array<{ changed: boolean; itemIds: number[] }> = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
      afterItemsAsDefaultContextAdded: async (result, items) => {
        completed.push({
          changed: result.changed,
          itemIds: items.map((receivedItem) => receivedItem.id),
        });
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isTrue(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);
    assert.deepEqual(received, [[item]]);
    assert.deepEqual(completed, [{ changed: true, itemIds: [3] }]);
  });

  it("prepares a fresh standalone context target before adding right-click context", async function () {
    const item = makeItem(5);
    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const freshReceived: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        registerContextSurfaceActionTarget(body, {
          surfaceKind: "standalone",
          addItemsAsDefaultContext: async (items) => {
            freshReceived.push(items);
            return { changed: true };
          },
        });
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isTrue(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
    assert.deepEqual(freshReceived, [[item]]);
  });

  it("does not add right-click context to the old standalone chat when fresh target preparation fails", async function () {
    const item = makeItem(7);
    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        return false;
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
  });

  it("opens standalone and applies queued context when no chat surface is mounted", async function () {
    const item = makeItem(2);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);

    const received: Zotero.Item[][] = [];
    await drainPendingStandaloneContextItemsForTests(async (items) => {
      received.push(items);
      return { changed: true };
    });

    assert.deepEqual(received, [[item]]);
  });

  it("notifies a newly mounted standalone surface after applying queued context", async function () {
    const item = makeItem(4);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const completed: Array<{ changed: boolean; itemIds: number[] }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
      afterItemsAsDefaultContextAdded: async (result, items) => {
        completed.push({
          changed: result.changed,
          itemIds: items.map((receivedItem) => receivedItem.id),
        });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(opened, 1);
    assert.deepEqual(received, [[item]]);
    assert.deepEqual(completed, [{ changed: true, itemIds: [4] }]);
  });

  it("prepares the fresh standalone target before draining queued context", async function () {
    const item = makeItem(6);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const freshReceived: Zotero.Item[][] = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        registerContextSurfaceActionTarget(body, {
          surfaceKind: "standalone",
          addItemsAsDefaultContext: async (items) => {
            freshReceived.push(items);
            return { changed: true };
          },
        });
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
    assert.deepEqual(freshReceived, [[item]]);
  });
});
