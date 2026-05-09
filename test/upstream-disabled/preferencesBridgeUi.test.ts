import { assert } from "chai";
import { describe, it } from "mocha";

describe("bridge settings UI behavior", function () {
  it("persists bridge URL only on commit events", function () {
    const events: string[] = [];
    const commitBridgeUrl = () => {
      events.push("commit");
    };

    const inputListeners = new Map<string, () => void>();
    const input = {
      value: "http://127.0.0.1:19787",
      addEventListener(type: string, fn: () => void) {
        inputListeners.set(type, fn);
      },
    } as unknown as HTMLInputElement;

    input.addEventListener("change", commitBridgeUrl);
    input.addEventListener("blur", commitBridgeUrl);

    assert.isUndefined(inputListeners.get("input"));
    inputListeners.get("change")?.();
    inputListeners.get("blur")?.();
    assert.deepEqual(events, ["commit", "commit"]);
  });
});
