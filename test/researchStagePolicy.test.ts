import { assert } from "chai";
import {
  assertResearchTransition,
  recoverableResearchStage,
} from "../src/agent/research/stages";

describe("research transition eligibility", function () {
  const state = {
    current: "inventory" as const,
    adaptive: false,
    inventoryComplete: false,
    screeningComplete: false,
    findingsComplete: false,
  };
  it("does not mistake stage bookkeeping for inventory evidence", function () {
    assert.throws(
      () =>
        assertResearchTransition({
          ...state,
          current: "broad_screening",
          next: "recall_expansion",
        }),
      /Inventory/,
    );
  });
  it("requires systematic screening before recall expansion", function () {
    assert.throws(
      () =>
        assertResearchTransition({
          ...state,
          current: "broad_screening",
          next: "recall_expansion",
          inventoryComplete: true,
        }),
      /screening/,
    );
  });
  it("allows adaptive synthesis only from durable paper understanding", function () {
    assert.throws(
      () =>
        assertResearchTransition({
          ...state,
          adaptive: true,
          current: "broad_screening",
          next: "hierarchical_synthesis",
          inventoryComplete: true,
        }),
      /findings|order/,
    );
    assert.doesNotThrow(() =>
      assertResearchTransition({
        ...state,
        adaptive: true,
        current: "broad_screening",
        next: "hierarchical_synthesis",
        inventoryComplete: true,
        findingsComplete: true,
      }),
    );
  });
  it("applies identical prerequisites to explicit and automatic advancement", function () {
    assert.doesNotThrow(() =>
      assertResearchTransition({
        ...state,
        next: "broad_screening",
        inventoryComplete: true,
      }),
    );
    assert.throws(
      () => assertResearchTransition({ ...state, next: "broad_screening" }),
      /Inventory/,
    );
  });
  it("recovers the earliest missing prerequisite without inventing completed work", function () {
    assert.equal(
      recoverableResearchStage({ ...state, current: "hierarchical_synthesis" }),
      "inventory",
    );
    assert.equal(
      recoverableResearchStage({
        ...state,
        current: "deep_evidence",
        inventoryComplete: true,
      }),
      "broad_screening",
    );
    assert.equal(
      recoverableResearchStage({
        ...state,
        current: "hierarchical_synthesis",
        adaptive: true,
        inventoryComplete: true,
      }),
      "broad_screening",
    );
    assert.equal(
      recoverableResearchStage({
        ...state,
        current: "hierarchical_synthesis",
        inventoryComplete: true,
        screeningComplete: true,
      }),
      "paper_findings",
    );
    assert.equal(
      recoverableResearchStage({
        ...state,
        current: "hierarchical_synthesis",
        inventoryComplete: true,
        screeningComplete: true,
        findingsComplete: true,
      }),
      "hierarchical_synthesis",
    );
  });
});
