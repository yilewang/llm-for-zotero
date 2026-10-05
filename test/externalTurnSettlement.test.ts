import { assert } from "chai";
import { describe, it } from "mocha";
import { settleExternalTurn } from "../src/agent/execution/externalTurnSettlement";
import type { AgentActionReceipt } from "../src/agent/contracts/types";

function delegatedCommandReceipt(
  status: AgentActionReceipt["status"],
): AgentActionReceipt {
  return {
    version: 2,
    executionAuthority: "external_runtime",
    id: `command_execute:${status}`,
    proposalId: "command_execute",
    proofDomain: "execution",
    capability: "command.execute",
    operation: "command_execute",
    verification: status === "observed" ? "execution_only" : "unverified",
    status,
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
  };
}

const DOCUMENT = { visibleMarkdown: "# Report", documentId: "document-1" };
const FAILED = [delegatedCommandReceipt("failed")];

describe("external turn settlement", function () {
  it("keeps an answered turn's text when its receipts prove the action", function () {
    assert.deepEqual(
      settleExternalTurn({
        answerText: "answer",
        answered: true,
        document: null,
        hostReceipts: [delegatedCommandReceipt("observed")],
      }),
      { status: "completed", text: "answer" },
    );
  });

  it("speaks the finalized document instead of the answer text", function () {
    assert.deepEqual(
      settleExternalTurn({
        answerText: "answer",
        answered: true,
        document: DOCUMENT,
        hostReceipts: [],
      }),
      { status: "completed", text: "# Report", documentId: "document-1" },
    );
  });

  it("reports the failure in place of the answer when the action is unverified", function () {
    const settlement = settleExternalTurn({
      answerText: "answer",
      answered: true,
      document: null,
      hostReceipts: FAILED,
    });
    assert.equal(settlement.status, "failed");
    assert.match(
      settlement.unverified || "",
      /^Delegated action results:\n\[Action status: command_execute — failed/,
    );
    assert.equal(settlement.text, settlement.unverified);
    assert.notProperty(settlement, "documentId");
  });

  it("appends the failure to the finalized document when the action is unverified", function () {
    const settlement = settleExternalTurn({
      answerText: "answer",
      answered: true,
      document: DOCUMENT,
      hostReceipts: FAILED,
    });
    assert.equal(settlement.status, "failed");
    assert.equal(settlement.text, `# Report\n\n${settlement.unverified}`);
    assert.equal(settlement.documentId, "document-1");
  });

  it("does not report a cancelled action as unverified", function () {
    assert.deepEqual(
      settleExternalTurn({
        answerText: "answer",
        answered: true,
        document: null,
        hostReceipts: [delegatedCommandReceipt("cancelled")],
      }),
      { status: "completed", text: "answer" },
    );
  });

  it("settles a turn that never answered as failed", function () {
    assert.deepEqual(
      settleExternalTurn({
        answerText: "fell back",
        answered: false,
        document: null,
        hostReceipts: [],
      }),
      { status: "failed", text: "fell back" },
    );
    const unverified = settleExternalTurn({
      answerText: "fell back",
      answered: false,
      document: null,
      hostReceipts: FAILED,
    });
    assert.equal(unverified.status, "failed");
    assert.equal(unverified.text, unverified.unverified);
  });
});
