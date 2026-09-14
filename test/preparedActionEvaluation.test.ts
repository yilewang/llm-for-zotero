import { assert } from "chai";
import {
  evaluateActionContract,
  evaluatePreparedActionContract,
} from "../src/agent/contracts/actionEvaluation";
import {
  semanticContractFixture,
  classifiedFixture,
} from "./helpers/semanticIntent";

describe("prepared action completion", function () {
  it("accepts an explicitly interpreted answer with no requested actions", function () {
    assert.equal(
      evaluatePreparedActionContract(
        {
          classifiedIntent: classifiedFixture(),
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });

  it("does not accept prose completion without a current semantic contract", function () {
    const decision = evaluatePreparedActionContract({}, []);
    assert.equal(decision.state, "failed");
    assert.isUndefined(decision.correction);
  });
  it("does not accept an unresolved reference even when a prior contract exists", function () {
    const contract = semanticContractFixture({
      id: "old",
      obligations: [],
      writeDisposition: "none",
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: {
          state: "needs_input",
          issues: ["Choose an exact destination"],
        },
      },
      [],
    );
    assert.equal(decision.state, "failed");
    assert.include(decision.failure!, "Choose an exact destination");
  });
  it("accepts a valid semantic answer contract without inventing mutation evidence", function () {
    const intent = classifiedFixture();
    const contract = semanticContractFixture({
      id: "answer",
      intent,
      obligations: [],
      writeDisposition: "none",
    });
    assert.equal(
      evaluatePreparedActionContract(
        {
          actionContract: contract,
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });
  it("requires verified evidence for an unresolved concrete effect", function () {
    const contract = semanticContractFixture({
      id: "filing",
      writeDisposition: "required",
      obligations: [
        {
          id: "filing:0",
          operation: "move_to_collection",
          capability: "zotero.collections",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "papers",
          parameters: { destinationCollectionId: 5 },
        },
      ],
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: { state: "ready", issues: [] },
      },
      [],
    );
    assert.equal(decision.state, "pending");
    assert.isString(decision.correction);
  });

  function tagReceipt(
    status: import("../src/agent/contracts/types").AgentActionReceipt["status"],
  ): import("../src/agent/contracts/types").AgentActionReceipt {
    return {
      version: 2,
      id: "contract:unmatched:apply_tags",
      proposalId: "proposal:apply_tags",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification: "verified",
      status,
      requestedTargets: ["item:41"],
      appliedTargets: status === "applied" ? ["item:41"] : [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
  }

  it("reports delegated native receipts without rechecking Original Agent intent", function () {
    const receipt = {
      ...tagReceipt("applied"),
      executionAuthority: "external_runtime" as const,
    };
    const request = {
      actionPreparation: {
        state: "needs_input" as const,
        issues: ["Original semantic reference was not resolved"],
      },
    };
    assert.equal(
      evaluatePreparedActionContract(request, [receipt]).state,
      "satisfied",
    );
    assert.equal(
      evaluatePreparedActionContract(request, [tagReceipt("applied")]).state,
      "failed",
    );
  });

  for (const status of ["partial", "failed", "unverified"] as const) {
    it(`reports delegated ${status} effects without automatically retrying`, function () {
      const receipt = {
        ...tagReceipt(status),
        executionAuthority: "external_runtime" as const,
      };
      const decision = evaluatePreparedActionContract({}, [receipt]);
      assert.equal(decision.state, status);
      assert.include(decision.failure!, status);
      assert.isUndefined(decision.correction);
    });
  }

  it("reports a dropped action as not performed instead of bare success", function () {
    const contract = semanticContractFixture({
      id: "dropped",
      writeDisposition: "none",
      obligations: [],
      skippedActions: [{ actionIndex: 0, operation: "apply_tags" }],
    });
    const decision = evaluateActionContract(contract, []);
    assert.equal(decision.state, "failed");
    assert.include(decision.failure!, "apply tags");
    assert.include(decision.failure!, "not performed");
  });

  it("accepts a dropped action covered by the agent's own judgment write", function () {
    const contract = semanticContractFixture({
      id: "dropped-then-done",
      writeDisposition: "none",
      obligations: [],
      skippedActions: [{ actionIndex: 0, operation: "apply_tags" }],
    });
    assert.equal(
      evaluateActionContract(contract, [tagReceipt("applied")]).state,
      "satisfied",
    );
    // A receipt that did not apply anything does not cover the dropped action.
    assert.equal(
      evaluateActionContract(contract, [tagReceipt("failed")]).state,
      "failed",
    );
  });
});
