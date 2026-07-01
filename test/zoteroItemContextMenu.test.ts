import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  clearContextSurfaceActionTargetsForTests,
  dispatchZoteroItemsAsContext,
  drainPendingStandaloneContextItemsForTests,
  registerContextSurfaceActionTarget,
  registerZoteroItemContextMenu,
} from "../src/modules/contextPanel/zoteroItemContextMenu";

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
  });

  it("registers the Zotero item-tree command with the requested label", function () {
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

    assert.lengthOf(registrations, 1);
    assert.equal(registrations[0].menu, "item");
    assert.equal(registrations[0].options.tag, "menuitem");
    assert.equal(
      registrations[0].options.label,
      "Add Items as Context to LLM-for-Zotero",
    );
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
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
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

    assert.isTrue(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);
    assert.deepEqual(received, [[item]]);
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
});
