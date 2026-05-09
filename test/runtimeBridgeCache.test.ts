import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { getClaudeBridgeRuntime, resetClaudeBridgeRuntime } from "../src/claudeCode/runtime";

describe("claude bridge runtime cache", function () {
  afterEach(function () {
    resetClaudeBridgeRuntime();
  });

  it("reuses the same wrapper for the same core runtime", function () {
    const coreRuntime = {} as any;
    const first = getClaudeBridgeRuntime(coreRuntime);
    const second = getClaudeBridgeRuntime(coreRuntime);
    assert.strictEqual(first, second);
  });

  it("rebuilds the wrapper when the core runtime instance changes", function () {
    const firstCoreRuntime = {} as any;
    const secondCoreRuntime = {} as any;
    const first = getClaudeBridgeRuntime(firstCoreRuntime);
    const second = getClaudeBridgeRuntime(secondCoreRuntime);
    assert.notStrictEqual(first, second);
  });
});
