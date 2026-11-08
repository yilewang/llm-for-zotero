import { assert } from "chai";
import { describe, it } from "mocha";
import { nextRuntimeCompression } from "../src/modules/contextPanel/setupHandlers/controllers/headerSpacing";

// Three runtime buttons can give up 26px in all.
const AVAILABLE = 26;

describe("nextRuntimeCompression", function () {
  it("keeps full spacing when the header fits", function () {
    assert.equal(nextRuntimeCompression(0, -10, AVAILABLE), 0);
  });

  it("grows to the smallest step that covers the shortage", function () {
    assert.closeTo(nextRuntimeCompression(0, 2.6, AVAILABLE), 0.1, 1e-9);
    assert.closeTo(nextRuntimeCompression(0, 2.7, AVAILABLE), 0.15, 1e-9);
  });

  it("caps at full compression", function () {
    assert.equal(nextRuntimeCompression(0, 100, AVAILABLE), 1);
  });

  it("returns to full spacing once there is room to spare", function () {
    assert.equal(nextRuntimeCompression(0.4, -10, AVAILABLE), 0);
  });

  it("settles when the shortage wobbles across a step line", function () {
    for (const center of [0, 2.6]) {
      let current = 0;
      const written: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        const shortage = center + (frame % 2 ? 0.1 : -0.1);
        const next = nextRuntimeCompression(current, shortage, AVAILABLE);
        if (next !== current && frame >= 4) written.push(next);
        current = next;
      }
      assert.deepEqual(
        written,
        [],
        `a shortage of ${center} ± 0.1px must settle, not flip every frame`,
      );
    }
  });
});
