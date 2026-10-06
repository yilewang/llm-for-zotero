import { assert } from "chai";
import { afterEach, describe, it } from "mocha";

import { mountPanelShell } from "../src/modules/contextPanel/panelMount";
import {
  activeContextPanelRawItems,
  activeContextPanels,
  unregisterContextPanel,
} from "../src/modules/contextPanel/state";

type Item = Zotero.Item;

function fakeItem(id: number): Item {
  return { id } as unknown as Item;
}

function fakeBody(panelRoot: HTMLElement | null): Element {
  return {
    querySelector: (selector: string) =>
      selector === "#llm-main" ? panelRoot : null,
  } as unknown as Element;
}

function recordingDeps(body: Element, log: unknown[]) {
  const registration = () => ({
    registered: activeContextPanels.has(body),
    mounted: activeContextPanels.get(body)?.() ?? null,
    raw: activeContextPanelRawItems.has(body)
      ? activeContextPanelRawItems.get(body)
      : "absent",
  });
  return {
    buildUI: (target: Element, item?: Item | null) => {
      log.push(["buildUI", target === body, item ?? null, registration()]);
    },
    retainClaudeRuntimeForBody: async (target: Element, item: unknown) => {
      log.push(["retain", target === body, item, registration()]);
    },
    setupHandlers: (target: Element, item?: Item | null, hooks?: unknown) => {
      log.push(["setup", target === body, item ?? null, hooks, registration()]);
    },
  };
}

describe("mountPanelShell", function () {
  const bodies: Element[] = [];
  afterEach(function () {
    for (const body of bodies.splice(0)) unregisterContextPanel(body);
  });

  it("builds, prepares, registers, retains, then sets up handlers in that order", function () {
    const panelRoot = { dataset: {} } as unknown as HTMLElement;
    const body = fakeBody(panelRoot);
    bodies.push(body);
    const renderItem = fakeItem(1);
    const mountedItem = fakeItem(2);
    const rawItem = fakeItem(3);
    const setupItem = fakeItem(4);
    const retainItem = fakeItem(5);
    const hooks = { onDefaultContextRendered: () => {} };
    const log: unknown[] = [];

    const returned = mountPanelShell(
      {
        body,
        renderItem,
        beforeRegister: (root) => {
          log.push([
            "beforeRegister",
            root === panelRoot,
            activeContextPanels.has(body),
          ]);
        },
        getMountedItem: () => mountedItem,
        rawItem,
        retainFor: retainItem,
        setupItem,
        hooks,
      },
      recordingDeps(body, log),
    );

    assert.strictEqual(returned, panelRoot);
    const registered = { registered: true, mounted: mountedItem, raw: rawItem };
    assert.deepEqual(log, [
      [
        "buildUI",
        true,
        renderItem,
        { registered: false, mounted: null, raw: "absent" },
      ],
      ["beforeRegister", true, false],
      ["retain", true, retainItem, registered],
      ["setup", true, setupItem, hooks, registered],
    ]);
  });

  it("retains a null item when asked and skips retention when retainFor is omitted", function () {
    const withNull = fakeBody(null);
    const without = fakeBody(null);
    bodies.push(withNull, without);
    const nullLog: unknown[] = [];
    const omittedLog: unknown[] = [];

    mountPanelShell(
      {
        body: withNull,
        renderItem: null,
        getMountedItem: () => null,
        rawItem: null,
        retainFor: null,
        setupItem: null,
      },
      recordingDeps(withNull, nullLog),
    );
    mountPanelShell(
      {
        body: without,
        renderItem: null,
        getMountedItem: () => null,
        rawItem: null,
        setupItem: null,
      },
      recordingDeps(without, omittedLog),
    );

    assert.deepEqual(
      nullLog.map((entry) => (entry as unknown[])[0]),
      ["buildUI", "retain", "setup"],
    );
    assert.strictEqual((nullLog[1] as unknown[])[2], null);
    assert.deepEqual(
      omittedLog.map((entry) => (entry as unknown[])[0]),
      ["buildUI", "setup"],
    );
  });

  it("registers a live mounted-item getter rather than a snapshot", function () {
    const body = fakeBody(null);
    bodies.push(body);
    let current = fakeItem(10);
    mountPanelShell(
      {
        body,
        renderItem: current,
        getMountedItem: () => current,
        rawItem: current,
        setupItem: current,
      },
      recordingDeps(body, []),
    );
    current = fakeItem(11);
    assert.strictEqual(activeContextPanels.get(body)?.(), current);
  });

  it("does not register or set up handlers when building the UI throws", function () {
    const body = fakeBody(null);
    bodies.push(body);
    const log: unknown[] = [];
    const deps = {
      ...recordingDeps(body, log),
      buildUI: () => {
        throw new Error("build failed");
      },
    };
    assert.throws(
      () =>
        mountPanelShell(
          {
            body,
            renderItem: null,
            getMountedItem: () => null,
            rawItem: null,
            retainFor: null,
            setupItem: null,
          },
          deps,
        ),
      "build failed",
    );
    assert.isFalse(activeContextPanels.has(body));
    assert.deepEqual(log, []);
  });
});
