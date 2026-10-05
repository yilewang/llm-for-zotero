import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MENUS_CLOSED_BY_MODEL_MENU,
  MENUS_CLOSED_BY_REASONING_MENU,
  MENUS_CLOSED_BY_RETRY_MODEL_MENU,
  createMenuRegistry,
} from "../src/modules/contextPanel/setupHandlers/controllers/menuRegistry";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("menuRegistry", function () {
  it("closes a registered menu", function () {
    const menus = createMenuRegistry();
    let closed = 0;
    menus.register("model", () => closed++);
    menus.close("model");
    assert.equal(closed, 1);
  });

  it("treats close and isOpen on an unregistered menu as a no-op", function () {
    const menus = createMenuRegistry();
    assert.doesNotThrow(() => menus.close("slash"));
    assert.doesNotThrow(() => menus.closeMany(["slash", "history"]));
    assert.doesNotThrow(() => menus.closer("slash")());
    assert.isFalse(menus.isOpen("slash"));
  });

  it("closes many menus in the given order", function () {
    const menus = createMenuRegistry();
    const calls: string[] = [];
    menus.register("slash", () => calls.push("slash"));
    menus.register("prompt", () => calls.push("prompt"));
    menus.register("history", () => calls.push("history"));
    menus.closeMany(["history", "slash", "export", "prompt"]);
    assert.deepEqual(calls, ["history", "slash", "prompt"]);
  });

  it("replaces the closer when a menu is registered again", function () {
    const menus = createMenuRegistry();
    const calls: string[] = [];
    menus.register("slash", () => calls.push("placeholder"));
    menus.register("slash", () => calls.push("full"));
    menus.close("slash");
    menus.closeMany(["slash"]);
    assert.deepEqual(calls, ["full", "full"]);
  });

  it("binds a closer thunk late, to the closer registered at call time", function () {
    const menus = createMenuRegistry();
    const calls: string[] = [];
    const closeSlash = menus.closer("slash");
    closeSlash();
    menus.register("slash", () => calls.push("placeholder"));
    closeSlash();
    menus.register("slash", () => calls.push("full"));
    closeSlash();
    assert.deepEqual(calls, ["placeholder", "full"]);
  });

  it("reports isOpen from the registered probe, false without one", function () {
    const menus = createMenuRegistry();
    let open = true;
    menus.register(
      "history",
      () => {
        open = false;
      },
      () => open,
    );
    menus.register("export", () => {});
    assert.isTrue(menus.isOpen("history"));
    menus.close("history");
    assert.isFalse(menus.isOpen("history"));
    assert.isFalse(menus.isOpen("export"));
    // Registering again without a probe drops the old probe.
    open = true;
    menus.register("history", () => {});
    assert.isFalse(menus.isOpen("history"));
  });

  it("pins the menus each opener closes, in order", function () {
    assert.deepEqual(
      [...MENUS_CLOSED_BY_MODEL_MENU],
      ["slash", "retryModel", "reasoning", "prompt", "historyNew", "history"],
    );
    assert.deepEqual(
      [...MENUS_CLOSED_BY_REASONING_MENU],
      ["slash", "retryModel", "model", "prompt", "historyNew", "history"],
    );
    assert.deepEqual(
      [...MENUS_CLOSED_BY_RETRY_MODEL_MENU],
      [
        "slash",
        "response",
        "export",
        "prompt",
        "historyNew",
        "history",
        "model",
        "reasoning",
      ],
    );
  });

  it("setupHandlers opens each menu after closing its pinned list", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const bodyOf = (start: string): string => {
      const from = source.indexOf(start);
      assert.isAtLeast(from, 0, `missing ${start}`);
      const to = source.indexOf("\n  };", from);
      assert.isAbove(to, from, `unterminated ${start}`);
      return source.slice(from, to);
    };
    assert.include(
      bodyOf("\n  openModelMenu = () => {"),
      "menus.closeMany(MENUS_CLOSED_BY_MODEL_MENU);",
    );
    assert.include(
      bodyOf("\n  openReasoningMenu = () => {"),
      "menus.closeMany(MENUS_CLOSED_BY_REASONING_MENU);",
    );
    assert.include(
      bodyOf("\n  const openRetryModelMenu = (anchor: HTMLButtonElement) => {"),
      "menus.closeMany(MENUS_CLOSED_BY_RETRY_MODEL_MENU);",
    );
  });
});
