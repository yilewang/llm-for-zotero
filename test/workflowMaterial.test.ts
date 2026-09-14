import { assert } from "chai";
import {
  assertMaterialReady,
  materialDocumentId,
  recordMaterialOutput,
} from "../src/agent/documents/workflowMaterial";
import { resolveDocumentOutcomePolicy } from "../src/agent/documents/outcomePolicy";
import { evaluatePreparedActionContract } from "../src/agent/contracts/actionEvaluation";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";

const output = {
  id: "summary",
  description: "Summarize the paper",
  afterActions: [0],
  sourceActionIndexes: [0],
  requiredEvidence: "body" as const,
};
const gateway = {
  getItem: (id: number) => ({ id, libraryID: 1, key: `KEY${id}` }),
} as any;
function request() {
  const intent = classifiedFixture({
    semantic: semanticFixture({ materialOutputs: [output] }),
  });
  return resolvedAgentRequest({
    conversationKey: 42,
    mode: "agent",
    libraryID: 1,
    userText: "Move and summarize",
    classifiedIntent: intent,
    actionPreparation: { state: "ready", issues: [] },
    actionContract: {
      version: 4,
      id: "workflow",
      interpretationSource: "semantic",
      writeDisposition: "required",
      intent,
      obligations: [
        {
          id: "move",
          operation: "move_to_collection",
          capability: "zotero.collections",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "papers",
          targetBoundary: {
            kind: "selection",
            libraryID: 1,
            frozenTargetIds: [42],
            scopeDigest: "42",
          },
        },
      ],
    },
    actionProgress: {
      version: 1,
      contractId: "workflow",
      state: "pending",
      correctionCount: 0,
      obligations: [
        {
          obligationId: "move",
          status: "open",
          verifiedTargetIds: [],
          unresolvedTargetIds: [],
          journalStepIds: [],
          failureReasons: [],
        },
      ],
      appliedReceiptKeys: [],
      updatedAt: 1,
    },
  });
}
describe("generated workflow material", function () {
  it("requires durable material for a summary that will be saved, in ordinary and approved Plan execution", function () {
    const r = request();
    assert.isTrue(resolveDocumentOutcomePolicy({ request: r }).required);
    r.planContext = { phase: "executing", planId: "plan", revision: 1 } as any;
    assert.isTrue(resolveDocumentOutcomePolicy({ request: r }).required);
    r.planContext = { phase: "planning", planId: "plan", revision: 1 } as any;
    assert.isFalse(resolveDocumentOutcomePolicy({ request: r }).required);
  });
  it("requires the preceding move and verified body evidence for the exact source paper", function () {
    const r = request();
    assert.throws(
      () => assertMaterialReady(r, output, gateway),
      /prerequisite/,
    );
    r.actionProgress!.obligations[0].status = "fulfilled";
    assert.throws(
      () => assertMaterialReady(r, output, gateway),
      /Read the requested source/,
    );
    r.documentReadObservations = [
      {
        issuer: "zotero_host",
        libraryID: 1,
        itemKey: "KEY99",
        capabilities: ["body"],
      },
    ] as any;
    assert.throws(
      () => assertMaterialReady(r, output, gateway),
      /Read the requested source/,
    );
    r.documentReadObservations = [
      {
        issuer: "zotero_host",
        libraryID: 1,
        itemKey: "KEY42",
        capabilities: ["body"],
      },
    ] as any;
    assert.doesNotThrow(() => assertMaterialReady(r, output, gateway));
  });
  it("retains the same document identity across resumed provider runs", function () {
    const r = request();
    const id = materialDocumentId(r, output.id);
    r.metadata = { sourceMessageTimestamp: 500 };
    assert.equal(materialDocumentId(r, output.id), id);
    assert.notEqual(materialDocumentId(r, "another-output"), id);
  });
  it("cannot report completion with a missing generated output even after the move succeeds", function () {
    const r = request();
    r.actionProgress!.obligations[0].status = "fulfilled";
    assert.notEqual(evaluatePreparedActionContract(r, []).state, "satisfied");
    recordMaterialOutput(r, output, {
      documentId: "doc",
      documentVersion: 1,
      contentHash: "sha256:content",
    } as any);
    assert.equal(evaluatePreparedActionContract(r, []).state, "satisfied");
  });
});
