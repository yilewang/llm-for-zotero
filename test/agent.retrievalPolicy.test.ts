import { assert } from "chai";
import {
  deriveRetrievalPolicy,
  isDeepPaperTool,
} from "../src/modules/contextPanel/Agent/retrievalPolicy";

describe("agent retrievalPolicy", function () {
  it("classifies library count queries as metadata-only broad mode", function () {
    const policy = deriveRetrievalPolicy({
      question: "How many hippocampus papers are in my library?",
      conversationMode: "open",
      hasActivePaperContext: false,
      selectedPaperContextCount: 0,
      pinnedPaperContextCount: 0,
    });

    assert.equal(policy.intent, "library_count");
    assert.equal(policy.maxDepthAllowed, "metadata");
    assert.isFalse(policy.allowPlannerPaperReads);
    assert.isTrue(policy.shouldOfferDeepenCTA);
  });

  it("keeps library count intent even when paper contexts already exist", function () {
    const policy = deriveRetrievalPolicy({
      question: "How many papers in my library are about hippocampus?",
      conversationMode: "open",
      hasActivePaperContext: false,
      selectedPaperContextCount: 5,
      pinnedPaperContextCount: 3,
    });

    assert.equal(policy.intent, "library_count");
    assert.equal(policy.maxDepthAllowed, "metadata");
    assert.isFalse(policy.allowPlannerPaperReads);
  });

  it("classifies thematic library queries as abstract-limited mode", function () {
    const policy = deriveRetrievalPolicy({
      question: "What themes are common in my hippocampus papers?",
      conversationMode: "open",
      hasActivePaperContext: false,
      selectedPaperContextCount: 0,
      pinnedPaperContextCount: 0,
    });

    assert.equal(policy.intent, "library_thematic_summary");
    assert.equal(policy.maxDepthAllowed, "abstract");
    assert.isFalse(policy.allowPlannerPaperReads);
  });

  it("keeps explicit paper-specific deep requests in deep mode", function () {
    const policy = deriveRetrievalPolicy({
      question: "Read paper 3 in depth and summarize methods/results.",
      conversationMode: "open",
      hasActivePaperContext: false,
      selectedPaperContextCount: 0,
      pinnedPaperContextCount: 0,
    });

    assert.equal(policy.intent, "paper_specific_or_explicit_deep");
    assert.equal(policy.maxDepthAllowed, "deep");
    assert.isTrue(policy.allowPlannerPaperReads);
  });

  it("flags deep paper tools for policy gating", function () {
    assert.isTrue(isDeepPaperTool("read_paper_text"));
    assert.isTrue(isDeepPaperTool("find_claim_evidence"));
    assert.isFalse(isDeepPaperTool("list_papers"));
    assert.isFalse(isDeepPaperTool("search_internet"));
  });
});
