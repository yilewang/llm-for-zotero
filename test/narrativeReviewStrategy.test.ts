import { assert } from "chai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePlanContract } from "../src/agent/plans/contracts";
import {
  resolveAdaptiveReadingBudget,
  resolvePlannedReadingPapers,
} from "../src/agent/research/readingBudget";
import { resolveResearchPolicy } from "../src/agent/research/policy";
import { bindCitationEvidenceRefs } from "../src/agent/documents/citationService";
import { canonicalizePlanResearchEvidenceDepth } from "../src/agent/plans/coordinator";

const policy = resolveResearchPolicy("plan_research");

describe("narrative literature-review strategy", function () {
  it("accepts a narrative review without systematic-review eligibility criteria or a fixed paper quota", function () {
    const contract = decodePlanContract({
      investigation: {
        question: "How can behavior remain stable while representations drift?",
        subquestions: [
          { id: "mechanisms", question: "Which mechanisms are proposed?" },
        ],
        criteria: [],
        reviewMode: "narrative",
        readingStrategy: "adaptive",
        scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
        requiredEvidenceDepth: "body",
        estimatedDeepReadPapers: 0,
        approvedLargeCorpus: false,
      },
      deliverable: { kind: "answer" },
      researchPolicy: policy,
    });

    assert.equal(contract.investigation?.reviewMode, "narrative");
    assert.equal(contract.investigation?.readingStrategy, "adaptive");
    assert.deepEqual(contract.investigation?.criteria, []);
    assert.equal(contract.investigation?.estimatedDeepReadPapers, 0);
  });

  it("derives adaptive full-scope reading from the frozen corpus instead of a count in the prompt", function () {
    const adaptive = {
      reviewMode: "narrative" as const,
      readingStrategy: "adaptive" as const,
      requiredEvidenceDepth: "body" as const,
      estimatedDeepReadPapers: 0,
    };
    assert.equal(resolvePlannedReadingPapers(adaptive, 7), 7);
    assert.equal(resolvePlannedReadingPapers(adaptive, 55), 55);
    assert.equal(
      resolvePlannedReadingPapers(
        {
          ...adaptive,
          readingStrategy: "selected",
          estimatedDeepReadPapers: 6,
        },
        55,
      ),
      6,
    );
  });

  it("treats adaptive reading as a body-evidence promise even with a zero quota", function () {
    const contract = canonicalizePlanResearchEvidenceDepth(
      decodePlanContract({
        investigation: {
          question: "What does this corpus show?",
          subquestions: [{ id: "q1", question: "What is the main answer?" }],
          criteria: [],
          reviewMode: "narrative",
          readingStrategy: "adaptive",
          scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
          requiredEvidenceDepth: "abstract",
          estimatedDeepReadPapers: 0,
          approvedLargeCorpus: false,
        },
        deliverable: { kind: "answer" },
        researchPolicy: policy,
      }),
    );

    assert.equal(contract.investigation?.requiredEvidenceDepth, "body");
  });

  it("sizes reading depth from remaining model capacity and never from small, medium, or large corpus labels", function () {
    const smallWindow = resolveAdaptiveReadingBudget({
      contextWindowTokens: 128_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 16_000,
      paperCount: 30,
    });
    const largeWindow = resolveAdaptiveReadingBudget({
      contextWindowTokens: 1_000_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 100_000,
      paperCount: 30,
    });
    const morePapers = resolveAdaptiveReadingBudget({
      contextWindowTokens: 1_000_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 100_000,
      paperCount: 60,
    });

    assert.isAbove(largeWindow.tokensPerPaper, smallWindow.tokensPerPaper);
    assert.isBelow(morePapers.tokensPerPaper, largeWindow.tokensPerPaper);
    assert.isAtMost(
      largeWindow.allocatedReadingTokens,
      largeWindow.remainingInputTokens,
    );
    assert.equal(
      largeWindow.maxCharactersPerPaper,
      largeWindow.tokensPerPaper * 4,
    );
  });

  it("teaches the default review skill to understand every paper and reserve screening for systematic reviews", function () {
    const skillPath = fileURLToPath(
      new URL("../src/agent/skills/literature-review.md", import.meta.url),
    );
    const skill = readFileSync(skillPath, "utf8");
    assert.include(skill, "read → understand → connect → write");
    assert.include(skill, "Do not choose a fixed number of papers");
    assert.include(skill, "Only use formal inclusion/exclusion screening");
    assert.include(skill, "read one capacity-sized group");
    assert.include(skill, "immediately persist");
    assert.include(
      skill,
      "Never accumulate multiple unrecorded reading groups",
    );
    assert.include(
      skill,
      "When the checkpoint says all papers are durable, do not call inventory_scope again",
    );
    assert.include(
      skill,
      "When a checkpoint supplies the remaining manifest, do not call inventory_scope again",
    );
    assert.include(skill, "SANRA");
    assert.include(
      skill,
      "`finalize` with `outcome:'complete'`",
      "finalize needs an explicit outcome; a bare finalize costs a rejected round",
    );
  });

  it("names the finalize outcome in the research_update guidance", async function () {
    const { createResearchUpdateTool } =
      await import("../src/agent/tools/plan/researchUpdate");
    const tool = createResearchUpdateTool({} as never);
    assert.include(
      tool.guidance?.instruction ?? "",
      "then finalize with outcome complete",
    );
  });

  it("binds durable evidence to citations by paper identity without model-visible IDs", function () {
    const clusters = bindCitationEvidenceRefs(
      [
        {
          citationId: "claim-1",
          sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
        },
      ],
      [
        {
          version: 2,
          evidenceRef: "opaque:research:evidence:1",
          observationId: "observation-1",
          libraryID: 1,
          itemKey: "AAAA1111",
          sourceKind: "body",
        },
      ],
    );

    assert.deepEqual(clusters[0].sources[0].evidenceRefs, [
      "opaque:research:evidence:1",
    ]);
  });
});
