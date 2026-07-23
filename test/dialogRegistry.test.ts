import { assert } from "chai";
import {
  closeAllAddonDialogs,
  registerAddonDialog,
} from "../src/utils/dialogRegistry";

describe("dialog registry", function () {
  const globals = globalThis as unknown as {
    addon?: { data: { dialogs: Set<unknown> } };
  };
  let previousAddon: typeof globals.addon;

  beforeEach(function () {
    previousAddon = globals.addon;
    globals.addon = { data: { dialogs: new Set() } };
  });

  afterEach(function () {
    if (previousAddon) globals.addon = previousAddon;
    else delete globals.addon;
  });

  it("tracks concurrent dialogs and closes every active window", function () {
    const closed: string[] = [];
    const first = { window: { close: () => closed.push("first") } };
    const second = { window: { close: () => closed.push("second") } };
    registerAddonDialog(first as Parameters<typeof registerAddonDialog>[0]);
    registerAddonDialog(second as Parameters<typeof registerAddonDialog>[0]);

    closeAllAddonDialogs();

    assert.deepEqual(closed, ["first", "second"]);
    assert.equal(globals.addon?.data.dialogs.size, 0);
  });

  it("unregisters one dialog without orphaning another", function () {
    const closed: string[] = [];
    const first = { window: { close: () => closed.push("first") } };
    const second = { window: { close: () => closed.push("second") } };
    const unregisterFirst = registerAddonDialog(
      first as Parameters<typeof registerAddonDialog>[0],
    );
    registerAddonDialog(second as Parameters<typeof registerAddonDialog>[0]);

    unregisterFirst();
    unregisterFirst();
    closeAllAddonDialogs();

    assert.deepEqual(closed, ["second"]);
  });
});
