import { assert } from "chai";
import { describe, it } from "mocha";

import {
  getPanelHandle,
  publishPanelHandle,
  unpublishPanelHandle,
  type PanelHandle,
} from "../src/modules/contextPanel/panelHandle";

function makeHandle(): PanelHandle & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    refreshContextSourceForCurrentItem: () => {
      calls.push("refresh");
    },
    applyResolvedClaudeEffort: (effort: unknown) => {
      calls.push(["effort", effort]);
    },
  };
}

describe("panelHandle", function () {
  it("returns no handle for a body that never published one", function () {
    assert.isUndefined(getPanelHandle({} as Element));
  });

  it("returns the published handle for its body only", function () {
    const body = {} as Element;
    const other = {} as Element;
    const handle = makeHandle();
    publishPanelHandle(body, handle);

    assert.strictEqual(getPanelHandle(body), handle);
    assert.isUndefined(getPanelHandle(other));

    getPanelHandle(body)?.refreshContextSourceForCurrentItem();
    getPanelHandle(body)?.applyResolvedClaudeEffort("high");
    assert.deepEqual(handle.calls, ["refresh", ["effort", "high"]]);
  });

  it("removes the handle when its publisher unpublishes it", function () {
    const body = {} as Element;
    const handle = makeHandle();
    publishPanelHandle(body, handle);
    unpublishPanelHandle(body, handle);

    assert.isUndefined(getPanelHandle(body));
  });

  it("keeps a newer handle when a stale publisher unpublishes", function () {
    const body = {} as Element;
    const stale = makeHandle();
    const newer = makeHandle();
    publishPanelHandle(body, stale);
    publishPanelHandle(body, newer);
    unpublishPanelHandle(body, stale);

    assert.strictEqual(getPanelHandle(body), newer);
    unpublishPanelHandle(body, newer);
    assert.isUndefined(getPanelHandle(body));
  });
});
