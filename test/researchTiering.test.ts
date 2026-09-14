import { assert } from "chai";
import { rankCorpusRelevance } from "../src/agent/research/relevance";
import {
  buildCorpusMap,
  proposeReadingGroups,
  proposeTiers,
  resolveLinkViewTokens,
  resolveNodeCapacity,
  resolveTierReadPlan,
} from "../src/agent/research/tiering";
import { buildDefaultResearchFrame } from "../src/agent/research/frame";

describe("capacity-derived tiering", function () {
  it("ranks papers whose metadata matches the question and subquestions", function () {
    const scores = rankCorpusRelevance({
      papers: [
        {
          identity: "1:A",
          title: "Dopamine prediction errors in the striatum",
          abstract: "Reward prediction error signals.",
        },
        {
          identity: "1:B",
          title: "A Poisson GAM for neural tuning",
          abstract: "Statistical estimation of tuning curves.",
        },
        {
          identity: "1:C",
          title: "Habit formation and dopamine",
          abstract: "Habits, prediction errors, striatum, dopamine.",
        },
      ],
      question: "How does dopamine signal prediction errors?",
      subquestions: ["Which striatal circuits carry reward prediction errors?"],
    });
    assert.equal(Math.max(scores.get("1:A")!, scores.get("1:C")!), 1);
    assert.isAbove(Math.min(scores.get("1:A")!, scores.get("1:C")!), 0.5);
    assert.equal(scores.get("1:B"), 0);
  });

  it("derives the full-node capacity from the link view budget", function () {
    assert.equal(
      resolveLinkViewTokens({
        contextWindowTokens: 128_000,
        usedContextTokens: 20_000,
        outputReserveTokens: 8_000,
      }),
      50_000,
    );
    const small = resolveNodeCapacity({
      paperCount: 12,
      linkViewTokens: 50_000,
      now: 1,
    });
    assert.equal(small.fullNodeCapacity, 12);
    assert.isFalse(small.mandatoryTiering);
    const large = resolveNodeCapacity({
      paperCount: 300,
      linkViewTokens: 50_000,
      now: 1,
    });
    assert.equal(large.fullNodeCapacity, 85);
    assert.isTrue(large.mandatoryTiering);
    const unknown = resolveNodeCapacity({ paperCount: 40, now: 1 });
    assert.equal(unknown.fullNodeCapacity, 40);
    assert.isFalse(unknown.mandatoryTiering);
  });

  it("proposes every paper as core below capacity and tiers by relevance above it", function () {
    const papers = Array.from({ length: 6 }, (_, index) => ({
      identity: `1:P${index}`,
      relevanceScore: [1, 0.8, 0.5, 0.4, 0.1, 0][index],
      ordinal: index,
    }));
    const relaxed = proposeTiers({
      papers,
      capacity: resolveNodeCapacity({
        paperCount: 6,
        linkViewTokens: 50_000,
        now: 1,
      }),
    });
    assert.isTrue([...relaxed.values()].every((tier) => tier === "core"));
    const capacity = resolveNodeCapacity({
      paperCount: 6,
      linkViewTokens: 1_000,
      now: 1,
    });
    assert.equal(capacity.fullNodeCapacity, 1);
    const tiers = proposeTiers({ papers, capacity });
    assert.equal(tiers.get("1:P0"), "core");
    assert.equal(tiers.get("1:P1"), "supporting");
    assert.equal(tiers.get("1:P2"), "supporting");
    assert.equal(tiers.get("1:P3"), "supporting");
    assert.equal(tiers.get("1:P4"), "peripheral");
    assert.equal(tiers.get("1:P5"), "peripheral");
  });

  it("maps tiers to read plans from the frame", function () {
    const frame = buildDefaultResearchFrame({
      subquestions: [{ id: "sq1", question: "Which frameworks?" }],
    });
    assert.deepEqual(
      resolveTierReadPlan({ tier: "core", frame, readable: true }),
      { readMode: "overview" },
    );
    const supporting = resolveTierReadPlan({
      tier: "supporting",
      frame,
      readable: true,
    });
    assert.equal(supporting.readMode, "targeted");
    assert.deepEqual(supporting.suggestedQueries, ["Which frameworks?"]);
    assert.equal(
      resolveTierReadPlan({ tier: "peripheral", frame, readable: true })
        .suggestedMaxChars,
      12_000,
    );
  });

  it("proposes read groups by tier and measured size within the reading allocation", function () {
    const groups = proposeReadingGroups({
      papers: [
        { identity: "1:A", tier: "core", ordinal: 0, textTokens: 30_000 },
        { identity: "1:B", tier: "peripheral", ordinal: 1, textTokens: 5_000 },
        { identity: "1:C", tier: "core", ordinal: 2, textTokens: 30_000 },
        { identity: "1:D", tier: "core", ordinal: 3, textTokens: 30_000 },
        { identity: "1:E", tier: "supporting", ordinal: 4 },
      ],
      allocatedReadingTokens: 70_000,
    });
    assert.deepEqual(groups, [["1:A", "1:C"], ["1:D"], ["1:E"], ["1:B"]]);
  });

  it("renders one corpus-map line per paper with tier, node state and message", function () {
    const lines = buildCorpusMap({
      corpus: [
        {
          libraryID: 1,
          itemKey: "A",
          ordinal: 1,
          screeningStatus: "included",
          tier: "core",
        } as never,
        {
          libraryID: 1,
          itemKey: "B",
          ordinal: 0,
          screeningStatus: "pending",
        } as never,
      ],
      findings: [
        {
          libraryID: 1,
          itemKey: "A",
          findings: [],
          claims: [{}, {}],
          mainMessage: "Latent state is decodable.",
        } as never,
      ],
      edges: [
        {
          source: "1:A",
          target: "1:B",
          lifecycle: "valid",
          status: "candidate",
        } as never,
      ],
      labels: new Map([["1:A", "(Alpha, 2020)"]]),
    });
    assert.deepEqual(lines, [
      "#1 1:B 1:B [core] node pending",
      "#2 1:A (Alpha, 2020) [core] node ok (2 claims, 1 edges) — Latent state is decodable.",
    ]);
  });
});

describe("tiering inside the research loop", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: import("./helpers/researchHarness").ResearchHarness | undefined;
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  async function setup(count: number) {
    const { installResearchHarness, paperFixtures } =
      await import("./helpers/researchHarness");
    harness = installResearchHarness({ papers: paperFixtures(count) });
    await harness.approve();
    return harness;
  }

  it("gives every paper a core tier with a decorated manifest when the corpus fits the link view", async function () {
    const h = await setup(4);
    const inventory = await h.run(
      { operation: "inventory_scope" },
      {
        runtimeContextBudget: {
          contextWindowTokens: 128_000,
          usedContextTokens: 20_000,
        },
      },
    );
    assert.equal(inventory.phase, "nodes");
    assert.deepEqual(
      inventory.frame.slots.map((slot: any) => slot.slotId),
      ["question", "approach", "system", "sq1", "sq2"],
    );
    assert.isFalse(inventory.nodeCapacity.mandatoryTiering);
    assert.equal(inventory.nodeCapacity.fullNodeCapacity, 4);
    assert.isTrue(
      inventory.readingManifest.every((entry: any) => entry.tier === "core"),
    );
    assert.isTrue(
      inventory.readingManifest.every(
        (entry: any) => entry.readMode === "overview",
      ),
    );
    assert.equal(inventory.readingManifest[0].textTokens, 10_000);
    assert.deepEqual(
      inventory.proposedGroups.flat().sort(),
      h.papers.map((p) => `1:${p.key}`).sort(),
    );
    assert.lengthOf(inventory.corpusMap, 4);
    assert.match(inventory.corpusMap[0], /\[core\] node pending/);
    const { listResearchCorpusItems, loadResearchJobForExecution } =
      await import("../src/agent/research/store");
    const job = (await loadResearchJobForExecution(
      (await h.ledger()).executionId,
    ))!;
    const corpus = await listResearchCorpusItems({
      researchJobId: job.researchJobId,
    });
    assert.isTrue(
      corpus.every(
        (item) => item.tier === "core" && item.tierSource === "host",
      ),
    );
    assert.isTrue(
      corpus.every((item) => typeof item.relevanceScore === "number"),
    );
    assert.equal(job.synthesisPhase, "nodes");
  });

  it("makes tiering mandatory when the corpus cannot be held in view and issues tiered read plans", async function () {
    const h = await setup(8);
    const inventory = await h.run(
      { operation: "inventory_scope" },
      {
        runtimeContextBudget: {
          contextWindowTokens: 12_000,
          usedContextTokens: 1_000,
        },
      },
    );
    assert.isTrue(inventory.nodeCapacity.mandatoryTiering);
    const tiers = inventory.readingManifest.map((entry: any) => entry.tier);
    assert.equal(
      tiers.filter((tier: string) => tier === "core").length,
      inventory.nodeCapacity.fullNodeCapacity,
    );
    const supporting = inventory.readingManifest.find(
      (entry: any) => entry.tier === "supporting",
    );
    const peripheral = inventory.readingManifest.find(
      (entry: any) => entry.tier === "peripheral",
    );
    assert.equal(supporting?.readMode, "targeted");
    assert.isAbove(supporting?.suggestedQueries.length, 0);
    assert.isAbove(peripheral?.suggestedMaxChars, 0);
    assert.equal(inventory.proposedGroups[0].length, 1);
  });

  it("lets the model override tiers with a reason but not exceed the core capacity", async function () {
    const h = await setup(6);
    await h.run(
      { operation: "inventory_scope" },
      {
        runtimeContextBudget: {
          contextWindowTokens: 12_000,
          usedContextTokens: 1_000,
        },
      },
    );
    const { listResearchCorpusItems, loadResearchJobForExecution } =
      await import("../src/agent/research/store");
    const job = (await loadResearchJobForExecution(
      (await h.ledger()).executionId,
    ))!;
    const corpus = await listResearchCorpusItems({
      researchJobId: job.researchJobId,
    });
    const core = corpus.find((item) => item.tier === "core")!;
    const other = corpus.find((item) => item.tier !== "core")!;
    let error = "";
    try {
      await h.run({
        operation: "set_tiers",
        tiers: [{ identity: `1:${other.itemKey}`, tier: "core" }],
      });
    } catch (caught) {
      error = String(caught);
    }
    assert.match(error, /requires a reason/);
    try {
      await h.run({
        operation: "set_tiers",
        tiers: [
          {
            identity: `1:${other.itemKey}`,
            tier: "core",
            reason: "Directly answers sq2.",
          },
        ],
      });
    } catch (caught) {
      error = String(caught);
    }
    assert.match(
      error,
      new RegExp(`At most ${job.nodeCapacity!.fullNodeCapacity} core papers`),
    );
    await h.run({
      operation: "set_tiers",
      tiers: [
        {
          identity: `1:${core.itemKey}`,
          tier: "supporting",
          reason: "Only the discussion is relevant.",
        },
        {
          identity: `1:${other.itemKey}`,
          tier: "core",
          reason: "Directly answers sq2.",
        },
      ],
    });
    const updated = await listResearchCorpusItems({
      researchJobId: job.researchJobId,
    });
    assert.equal(
      updated.find((item) => item.itemKey === other.itemKey)?.tier,
      "core",
    );
    assert.equal(
      updated.find((item) => item.itemKey === other.itemKey)?.tierSource,
      "model",
    );
    assert.equal(
      updated.find((item) => item.itemKey === core.itemKey)?.tier,
      "supporting",
    );
  });

  it("refines comparison slots but protects identity slots and filled slots", async function () {
    const h = await setup(2);
    const inventory = await h.run({ operation: "inventory_scope" });
    const slots = inventory.frame.slots;
    const revised = await h.run({
      operation: "set_frame",
      slots: [
        ...slots,
        {
          slotId: "species",
          name: "Species",
          description: "Species studied",
          kind: "comparison",
        },
      ],
    });
    assert.include(
      revised.frame.slots.map((slot: any) => slot.slotId),
      "species",
    );
    let error = "";
    try {
      await h.run({
        operation: "set_frame",
        slots: slots.filter((slot: any) => slot.slotId !== "question"),
      });
    } catch (caught) {
      error = String(caught);
    }
    assert.match(error, /identity slots are fixed/);
    try {
      await h.run({
        operation: "set_frame",
        slots: slots.map((slot: any) =>
          slot.slotId === "sq1" ? { ...slot, kind: "identity" } : slot,
        ),
      });
    } catch (caught) {
      error = String(caught);
    }
    assert.match(error, /cannot be an identity slot/);
  });

  it("returns the corpus map and next proposed groups in the record checkpoint", async function () {
    const h = await setup(3);
    await h.run(
      { operation: "inventory_scope" },
      {
        runtimeContextBudget: {
          contextWindowTokens: 200_000,
          usedContextTokens: 10_000,
        },
      },
    );
    await h.verifiedRead(["PAPER001"], "body");
    const result = await h.run({
      operation: "record_papers",
      papers: [
        {
          libraryID: 1,
          itemKey: "PAPER001",
          finding: {
            mainMessage: "Paper one shows X.",
            relevance: "Central.",
            confidence: "high",
            frameSlots: {
              question: "q",
              approach: "a",
              system: "s",
              sq1: "f",
              sq2: "g",
            },
            claims: [
              {
                statement: "X holds.",
                kind: "finding",
                subquestionIds: ["sq1"],
                evidence: { sourceKind: "body" },
              },
              {
                statement: "Via Y.",
                kind: "mechanism",
                subquestionIds: ["sq1"],
                evidence: { sourceKind: "body" },
              },
              {
                statement: "Small n.",
                kind: "limitation",
                subquestionIds: [],
                evidence: { sourceKind: "body" },
              },
            ],
            candidateLinks: [
              { target: "1:PAPER002", type: "extends", note: "same task" },
            ],
          },
        },
      ],
    });
    assert.match(
      result.continuationCheckpoint.instruction,
      /Corpus map \(one line per paper\)/,
    );
    assert.match(
      result.continuationCheckpoint.instruction,
      /node ok \(3 claims, 0 edges\)/,
    );
    assert.match(
      result.continuationCheckpoint.instruction,
      /Proposed next groups/,
    );
    assert.equal(result.content.corpusMap.length, 3);
    const remaining = JSON.parse(
      result.continuationCheckpoint.instruction.match(
        /\[\{[\s\S]*?\}\](?=\n\nProposed)/,
      )![0],
    );
    assert.deepEqual(
      remaining.map((entry: any) => entry.identity),
      ["1:PAPER002", "1:PAPER003"],
    );
    assert.equal(remaining[0].readMode, "overview");
  });
});
