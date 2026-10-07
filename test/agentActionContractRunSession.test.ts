/**
 * One turn's receipts and what they prove when the turn ends. A turn carries
 * no contract of obligations: the receipts its tools produced are the whole
 * record of what it did.
 */
import { assert } from "chai";
import { ActionContractRunSession } from "../src/agent/contracts/actionContractRunSession";
import type { AgentActionReceipt } from "../src/agent/contracts/types";

function receipt(
  overrides: Partial<AgentActionReceipt> = {},
): AgentActionReceipt {
  return {
    version: 2,
    id: "proposal:apply_tags:unmatched:result",
    proposalId: "proposal:apply_tags",
    proofDomain: "zotero_state",
    capability: "zotero.tags",
    operation: "apply_tags",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:41"],
    appliedTargets: ["item:41"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  };
}

describe("a turn's action receipts", function () {
  it("reports only the receipts that took effect, in the order they were recorded", function () {
    const session = new ActionContractRunSession();
    session.recordToolReceipts([
      receipt({
        id: "read",
        capability: "zotero.read",
        operation: "read_full",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
      }),
      receipt({ id: "first", operation: "apply_tags" }),
    ]);
    session.recordToolReceipts([
      receipt({ id: "failed", status: "failed", appliedTargets: [] }),
      receipt({
        id: "second",
        capability: "zotero.collections",
        operation: "move_to_collection",
        normalizedParameters: { sourceCollectionId: 7 },
      }),
    ]);
    assert.deepEqual(session.receiptStatus().split("\n"), [
      "[Action status: apply_tags — applied 1/1; Verified; proof:zotero_state]",
      "[Action status: move_to_collection — applied 1/1; Verified; proof:zotero_state]",
    ]);
  });

  it("accepts a turn whose receipts prove what they claim", function () {
    const session = new ActionContractRunSession();
    assert.deepEqual(session.evaluateFinal(), { kind: "accept" });
    session.recordToolReceipts([
      receipt(),
      receipt({ id: "cancelled", status: "cancelled", appliedTargets: [] }),
    ]);
    assert.deepEqual(session.evaluateFinal(), { kind: "accept" });
  });

  it("fails a turn whose applied effect could not be verified", function () {
    const session = new ActionContractRunSession();
    session.recordToolReceipts([receipt({ verification: "unverified" })]);
    const decision = session.evaluateFinal();
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.include(
      decision.failure,
      "Concrete action results could not be verified",
    );
    assert.include(decision.failure, "apply_tags");
  });
});
