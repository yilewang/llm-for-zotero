import { assert } from "chai";
import { describe, it } from "mocha";

import {
  beginChatRenderCycle,
  claimAsyncChatRender,
  claimDeferredChatRender,
  currentChatRenderCycle,
  setPanelRenderClaim,
  takePanelRenderClaim,
} from "../src/modules/contextPanel/chatRenderCycle";

function fakeBody(): Element {
  return {} as Element;
}

describe("chatRenderCycle", function () {
  it("deferred path renders when it gets there first, async path skips", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    const captured = currentChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    assert.isFalse(claimAsyncChatRender(body, captured));
  });

  it("async path renders when it gets there first, deferred path skips", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimAsyncChatRender(body, currentChatRenderCycle(body)));
    assert.isFalse(claimDeferredChatRender(body, cycle));
  });

  it("deferred path renders alone when onAsyncRender never fires", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    // A second wake-up of the same deferred task must not render again.
    assert.isFalse(claimDeferredChatRender(body, cycle));
  });

  it("stale deferred task from a superseded cycle never renders", function () {
    const body = fakeBody();
    const staleCycle = beginChatRenderCycle(body);
    const currentCycle = beginChatRenderCycle(body);
    // Old tab-switch cycle wakes up after a newer full render began.
    assert.isFalse(claimDeferredChatRender(body, staleCycle));
    // The current cycle is unaffected by the stale claim attempt.
    assert.isTrue(claimDeferredChatRender(body, currentCycle));
  });

  it("stale in-flight async render cannot steal a newer cycle's claim", function () {
    const body = fakeBody();
    // onRender#1 (item A) begins C1; onAsyncRender A1 captures it, then
    // stalls on a slow conversation load.
    beginChatRenderCycle(body);
    const capturedByA1 = currentChatRenderCycle(body);
    // Fast tab switch: onRender#2 (item B) begins C2 with a deferred task D2.
    const cycle2 = beginChatRenderCycle(body);
    // A1 resumes late: it must NOT render (it would paint item A's
    // conversation into item B's panel) and must NOT consume C2's claim.
    assert.isFalse(claimAsyncChatRender(body, capturedByA1));
    // D2 still owns the render for item B.
    assert.isTrue(claimDeferredChatRender(body, cycle2));
  });

  it("async-only render cycles are never blocked by earlier full cycles", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    // A later onAsyncRender cycle without a sync onRender (e.g. context
    // refresh only) captures no cycle and must still render even though the
    // previous cycle's claim was consumed.
    assert.isTrue(claimAsyncChatRender(body, null));
  });

  it("async path without any prior cycle renders unconditionally", function () {
    const body = fakeBody();
    assert.strictEqual(currentChatRenderCycle(body), null);
    assert.isTrue(claimAsyncChatRender(body, null));
  });

  it("claims are tracked per body", function () {
    const bodyA = fakeBody();
    const bodyB = fakeBody();
    const cycleA = beginChatRenderCycle(bodyA);
    const cycleB = beginChatRenderCycle(bodyB);
    assert.isTrue(claimDeferredChatRender(bodyA, cycleA));
    assert.isTrue(claimAsyncChatRender(bodyB, currentChatRenderCycle(bodyB)));
    assert.isFalse(claimAsyncChatRender(bodyA, currentChatRenderCycle(bodyA)));
    assert.isFalse(claimDeferredChatRender(bodyB, cycleB));
  });
});

describe("panelRenderClaim", function () {
  it("a stale async render for a superseded item cannot consume the claim or steal the render", function () {
    const body = fakeBody();
    // onRender(item B): full render begins cycle C2 and leaves a claim for B.
    const cycle2 = beginChatRenderCycle(body);
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-B",
      cycle: cycle2,
    });
    // A stale onAsyncRender(item A) wakes up after B's onRender. It must be
    // told it is superseded — not handed B's claim and cycle.
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "stale",
    });
    // B's deferred fallback still owns the render.
    assert.isTrue(claimDeferredChatRender(body, cycle2));
    // B's own async render still finds its claim intact, then skips the
    // duplicate render because the deferred path already rendered.
    const own = takePanelRenderClaim(body, "item-B");
    assert.equal(own.outcome, "sync-rendered");
    assert.isFalse(
      claimAsyncChatRender(
        body,
        own.outcome === "sync-rendered" ? own.cycle : null,
      ),
    );
  });

  it("a matching async render consumes the claim exactly once", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-A",
      cycle,
    });
    const first = takePanelRenderClaim(body, "item-A");
    assert.equal(first.outcome, "sync-rendered");
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "none",
    });
  });

  it("a sync-rendered claim without a cycle still lets its async render own the chat render", function () {
    // Standalone-placeholder path: onRender marked the body sync-rendered but
    // began no cycle of its own.
    const body = fakeBody();
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-A",
      cycle: null,
    });
    const claim = takePanelRenderClaim(body, "item-A");
    assert.equal(claim.outcome, "sync-rendered");
    assert.isTrue(
      claimAsyncChatRender(
        body,
        claim.outcome === "sync-rendered" ? claim.cycle : null,
      ),
    );
  });

  it("a full render's claim replaces a pending context-refresh claim", function () {
    const body = fakeBody();
    setPanelRenderClaim(body, { kind: "context-refresh", itemKey: "item-B" });
    // Item switch: the full render for A overwrites B's pending refresh.
    const cycle = beginChatRenderCycle(body);
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-A",
      cycle,
    });
    assert.deepEqual(takePanelRenderClaim(body, "item-B"), {
      outcome: "stale",
    });
    assert.equal(takePanelRenderClaim(body, "item-A").outcome, "sync-rendered");
  });

  it("a context-refresh claim is consumed only by its own item", function () {
    const body = fakeBody();
    setPanelRenderClaim(body, { kind: "context-refresh", itemKey: "item-B" });
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "stale",
    });
    assert.deepEqual(takePanelRenderClaim(body, "item-B"), {
      outcome: "context-refresh",
    });
    assert.deepEqual(takePanelRenderClaim(body, "item-B"), {
      outcome: "none",
    });
  });

  it("a stale async render arriving after the owner consumed its claim is still rejected", function () {
    const body = fakeBody();
    // onRender(B) leaves its claim; B's own async render consumes it first.
    const cycleB = beginChatRenderCycle(body);
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-B",
      cycle: cycleB,
    });
    assert.equal(takePanelRenderClaim(body, "item-B").outcome, "sync-rendered");
    // A stale onAsyncRender(A) arrives late, AFTER the claim is gone. The
    // body is still owned by B, so A must be rejected — "none" would send it
    // down the async-only path where it rebuilds A's panel over B's.
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "stale",
    });
    // The rejection must not disturb B: a repeat take for the owner still
    // reports the claim as already consumed.
    assert.deepEqual(takePanelRenderClaim(body, "item-B"), {
      outcome: "none",
    });
  });

  it("ownership survives across consumed claims of both kinds", function () {
    const body = fakeBody();
    setPanelRenderClaim(body, {
      kind: "sync-rendered",
      itemKey: "item-B",
      cycle: beginChatRenderCycle(body),
    });
    assert.equal(takePanelRenderClaim(body, "item-B").outcome, "sync-rendered");
    // A later same-item context refresh re-marks the body and is consumed.
    setPanelRenderClaim(body, { kind: "context-refresh", itemKey: "item-B" });
    assert.equal(
      takePanelRenderClaim(body, "item-B").outcome,
      "context-refresh",
    );
    // Stale A is still rejected long after both claims were consumed.
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "stale",
    });
  });

  it("a body that never rendered accepts its first async-only render", function () {
    const body = fakeBody();
    // No onRender ever ran for this body — there is no owner to defend, so
    // the async-only render proceeds exactly as before.
    assert.deepEqual(takePanelRenderClaim(body, "item-A"), {
      outcome: "none",
    });
  });
});
