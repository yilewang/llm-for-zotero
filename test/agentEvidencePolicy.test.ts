import { assert } from "chai";
import {
  renderTurnReadingRule,
  resolveReadStopGuidance,
  resolveTurnEvidencePolicy,
} from "../src/agent/context/evidencePolicy";
import type { AgentCoverageEntry } from "../src/agent/context/coverageLedger";
import type { ResolvedSelectedTextAnchor } from "../src/shared/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";

const paperContext = {
  itemId: 3928,
  contextItemId: 3931,
  title: "Variability and stability in visual processing",
};

function anchor(
  overrides: Partial<ResolvedSelectedTextAnchor> = {},
): ResolvedSelectedTextAnchor {
  return {
    contextIndex: 0,
    contextItemId: 3931,
    pageIndex: 5,
    pageLabel: "6",
    paperContext,
    resolution: "chunks",
    primaryChunkIndex: 41,
    preferredChunkIndexes: [40, 41, 42],
    contextText:
      "Consistency in categorization of object category over longer time scales. We asked whether the changes are stimulus-dependent...",
    injectedChars: 140,
    ...overrides,
  };
}

function selectionRequest(params: {
  coverage?: "overview" | "targeted" | "exhaustive";
  source?: "provided_context" | "metadata" | "document_text" | "rendered_pages";
  anchors?: ResolvedSelectedTextAnchor[];
  withSelection?: boolean;
}) {
  const withSelection = params.withSelection ?? true;
  return resolvedAgentRequest({
    conversationKey: 4101,
    mode: "agent",
    conversationKind: "paper",
    libraryID: 1,
    activeItemId: paperContext.itemId,
    selectedPaperContexts: [paperContext],
    userText: "can you explain this part of result to me?",
    model: "test-model",
    ...(withSelection
      ? {
          selectedTextContexts: [
            {
              text: "Consistency in categorization of object category over longer time scales",
              source: "pdf" as const,
              paperContext,
              contextItemId: 3931,
              pageIndex: 5,
              pageLabel: "6",
            },
          ],
          resolvedSelectedTextAnchors: params.anchors ?? [anchor()],
        }
      : {}),
    classifiedIntent: classifiedFixture({
      semantic: semanticFixture({
        reading: {
          source: params.source ?? "document_text",
          coverage: params.coverage ?? "targeted",
        },
      }),
    }),
  });
}

function coverageEntry(
  overrides: Partial<AgentCoverageEntry> = {},
): AgentCoverageEntry {
  return {
    key: "paper:3928:passage:results",
    resourceKey: "paper:3928",
    resourceLabel: "(Paulsen et al., 2026)",
    sourceKind: "mineru",
    topic: "cross-day decoding",
    granularity: "passage",
    coverage: "targeted",
    confidence: "high",
    toolName: "paper_read",
    evidenceRefs: [],
    count: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as AgentCoverageEntry;
}

describe("turn evidence policy", function () {
  it("counts a chunk-verified selection as held document text at the selected locus", function () {
    const policy = resolveTurnEvidencePolicy(selectionRequest({}));
    assert.ok(policy);
    assert.equal(policy!.coverage, "targeted");
    assert.equal(policy!.held.length, 1);
    assert.equal(policy!.held[0].kind, "selection_anchor");
    assert.include(policy!.held[0].label, "selected text 1");
    assert.include(policy!.held[0].label, "page 6");
    assert.include(policy!.held[0].label, "chunk-verified");
    assert.isFalse(policy!.retrievalRequired);
  });

  it("does not treat a locator-only selection as held evidence", function () {
    const policy = resolveTurnEvidencePolicy(
      selectionRequest({
        anchors: [
          anchor({
            resolution: "locator-only",
            contextText: undefined,
            preferredChunkIndexes: [],
            primaryChunkIndex: undefined,
          }),
        ],
      }),
    );
    assert.ok(policy);
    assert.deepEqual(policy!.held, []);
    assert.isTrue(policy!.retrievalRequired);
  });

  it("keeps retrieval required for exhaustive coverage even when context is held", function () {
    const policy = resolveTurnEvidencePolicy(
      selectionRequest({ coverage: "exhaustive" }),
    );
    assert.ok(policy);
    assert.equal(policy!.held.length, 1);
    assert.isTrue(policy!.retrievalRequired);
    assert.equal(policy!.readBudget, Number.POSITIVE_INFINITY);
  });

  it("counts prior paper reads from the coverage ledger as held evidence for follow-up turns", function () {
    const policy = resolveTurnEvidencePolicy(
      selectionRequest({ withSelection: false }),
      { priorCoverage: [coverageEntry()] },
    );
    assert.ok(policy);
    assert.equal(policy!.held.length, 1);
    assert.equal(policy!.held[0].kind, "prior_read");
    assert.include(policy!.held[0].label, "(Paulsen et al., 2026)");
    assert.include(policy!.held[0].label, "cross-day decoding");
    assert.isFalse(policy!.retrievalRequired);
  });

  it("ignores metadata-only prior coverage when body text is required", function () {
    const policy = resolveTurnEvidencePolicy(
      selectionRequest({ withSelection: false }),
      {
        priorCoverage: [
          coverageEntry({
            sourceKind: "zotero_metadata",
            granularity: "metadata",
            coverage: "listed",
          }),
        ],
      },
    );
    assert.ok(policy);
    assert.deepEqual(policy!.held, []);
    assert.isTrue(policy!.retrievalRequired);
  });

  it("returns no policy for metadata reading and a non-retrieval policy for provided context", function () {
    assert.isNull(
      resolveTurnEvidencePolicy(selectionRequest({ source: "metadata" })),
    );
    const provided = resolveTurnEvidencePolicy(
      selectionRequest({ source: "provided_context" }),
    );
    assert.ok(provided);
    assert.isFalse(provided!.retrievalRequired);
  });

  it("scales the read budget by requested coverage", function () {
    const overview = resolveTurnEvidencePolicy(
      selectionRequest({ coverage: "overview", withSelection: false }),
    );
    const targeted = resolveTurnEvidencePolicy(
      selectionRequest({ coverage: "targeted", withSelection: false }),
    );
    assert.equal(overview!.readBudget, 1);
    assert.equal(targeted!.readBudget, 2);
  });
});

describe("turn reading rule rendering", function () {
  it("renders a conditional rule when held evidence satisfies targeted coverage", function () {
    const rule = renderTurnReadingRule(
      resolveTurnEvidencePolicy(selectionRequest({}))!,
    );
    assert.include(rule, "TURN RULE");
    assert.include(rule, "Support needed: document_text at targeted coverage");
    assert.include(rule, "Already held");
    assert.include(rule, "selected text 1");
    assert.include(rule, "Answer from the held context");
    assert.include(rule, "paper_read mode 'targeted'");
    assert.include(rule, "only for a specific claim in your draft");
    assert.notInclude(rule, "requires document_text evidence");
  });

  it("renders the mandatory rule when nothing is held", function () {
    const rule = renderTurnReadingRule(
      resolveTurnEvidencePolicy(selectionRequest({ withSelection: false }))!,
    );
    assert.include(
      rule,
      "requires document_text evidence at targeted coverage",
    );
    assert.include(rule, "paper_read mode 'targeted'");
    assert.notInclude(rule, "Already held");
  });

  it("keeps the full read mandatory for exhaustive coverage and says held context does not satisfy it", function () {
    const rule = renderTurnReadingRule(
      resolveTurnEvidencePolicy(selectionRequest({ coverage: "exhaustive" }))!,
    );
    assert.include(rule, "paper_read mode 'full'");
    assert.include(rule, "does not satisfy exhaustive coverage");
  });

  it("names prior reads as held evidence for a follow-up turn", function () {
    const rule = renderTurnReadingRule(
      resolveTurnEvidencePolicy(selectionRequest({ withSelection: false }), {
        priorCoverage: [coverageEntry()],
      })!,
    );
    assert.include(rule, "Already held");
    assert.include(rule, "prior read");
    assert.include(rule, "(Paulsen et al., 2026)");
  });
});

describe("read stop guidance", function () {
  const targeted = { coverage: "targeted" as const, readBudget: 2 };
  const exhaustive = {
    coverage: "exhaustive" as const,
    readBudget: Number.POSITIVE_INFINITY,
  };

  it("asks for a draft-based self-check after the first targeted read", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_or_self_check");
    assert.include(
      guidance.reason,
      "Answer from the held and delivered evidence",
    );
    assert.include(guidance.reason, "specifically named claim in your draft");
    assert.notInclude(guidance.reason, "missing dimension");
  });

  it("stops targeted retrieval when a read adds nothing new", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unchanged",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "answer_now");
    assert.include(guidance.reason, "do not retrieve again for this question");
  });

  it("stops targeted retrieval once the read budget is used", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "answer_now");
    assert.include(guidance.reason, "read budget");
    assert.include(guidance.reason, "disclose");
  });

  it("keeps gap hunting for exhaustive coverage", function () {
    const unchanged = resolveReadStopGuidance(exhaustive, {
      frontier: "unchanged",
      readsThisTurn: 5,
    });
    assert.equal(unchanged.recommendation, "name_a_specific_missing_dimension");
    const advanced = resolveReadStopGuidance(exhaustive, {
      frontier: "advanced",
      readsThisTurn: 5,
    });
    assert.equal(advanced.recommendation, "answer_or_self_check");
    assert.include(advanced.reason, "missing dimension");
  });

  it("reports source unavailability regardless of coverage", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unavailable",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_with_source_limitation");
  });

  it("yields no chat turn policy while an approved plan is executing", function () {
    const request = resolvedAgentRequest({
      conversationKey: 4103,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: "plan-reading",
        revision: 1,
        executionId: "execution-reading",
        approvedDigest: "sha256:reading",
        provider: "original",
      },
      classifiedIntent: classifiedFixture({
        semantic: semanticFixture({
          reading: { source: "document_text", coverage: "targeted" },
        }),
      }),
    });
    assert.isNull(resolveTurnEvidencePolicy(request));
  });
});
