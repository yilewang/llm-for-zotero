import { assert } from "chai";
import {
  listResearchEdges,
  listResearchOpenQuestions,
  loadResearchJobForExecution,
} from "../src/agent/research/store";
import {
  installResearchHarness,
  nodeFinding,
  type ResearchHarness,
} from "./helpers/researchHarness";

async function job(h: ResearchHarness) {
  return (await loadResearchJobForExecution((await h.ledger()).executionId))!;
}

async function attempt(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** Inventory, read and record every fixture paper as a core node. */
async function recordAllNodes(h: ResearchHarness) {
  await h.run(
    { operation: "inventory_scope" },
    {
      runtimeContextBudget: {
        contextWindowTokens: 200_000,
        usedContextTokens: 10_000,
      },
    },
  );
  await h.verifiedRead(
    h.papers.map((paper) => paper.key),
    "body",
  );
  let last: any;
  for (const [index, paper] of h.papers.entries()) {
    const others = h.papers.filter((entry) => entry.key !== paper.key);
    last = await h.run({
      operation: "record_papers",
      papers: [
        {
          libraryID: 1,
          itemKey: paper.key,
          finding: nodeFinding({
            mainMessage: `Paper ${index + 1} main message.`,
            noLinkSeen: undefined,
            candidateLinks: [
              {
                target: `1:${others[0].key}`,
                type: "extends",
                note: "shared task",
              },
            ],
          }),
        },
      ],
    });
  }
  return last;
}

describe("research graph loop", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  beforeEach(async function () {
    harness = installResearchHarness();
    await harness.approve();
  });
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  it("moves to the links phase when every node is durable and shows every node compactly", async function () {
    const last = await recordAllNodes(harness!);
    assert.match(last.continuationCheckpoint.instruction, /links phase/);
    assert.equal((await job(harness!)).synthesisPhase, "links");
    const view = await harness!.run({ operation: "list_findings" });
    assert.equal(view.view, "compact");
    assert.lengthOf(view.findings, 3);
    assert.deepEqual(
      view.findings[0].claims.map((claim: any) => claim.claimId),
      ["PAPER001:c1", "PAPER001:c2", "PAPER001:c3"],
    );
    assert.equal(view.findings[0].frameSlots.sq1, "Bayesian observer.");
    assert.equal(view.findings[0].candidateLinks[0].target, "1:PAPER002");
    assert.isNull(view.nextCursor);
  });

  it("refuses edges before the links phase and validates them afterwards", async function () {
    await harness!.run({ operation: "inventory_scope" });
    const early = await attempt(() =>
      harness!.run({
        operation: "record_edges",
        edges: [
          {
            source: "1:PAPER001",
            target: "1:PAPER002",
            type: "extends",
            statement: "x",
            confidence: "low",
          },
        ],
      }),
    );
    assert.match(early, /nodes phase/);
    await recordAllNodes(harness!);
    const unknownClaim = await attempt(() =>
      harness!.run({
        operation: "record_edges",
        edges: [
          {
            source: "1:PAPER001",
            target: "1:PAPER002",
            type: "extends",
            statement: "Two extends one.",
            confidence: "medium",
            sourceClaimIds: ["PAPER001:c9"],
          },
        ],
      }),
    );
    assert.match(unknownClaim, /claim PAPER001:c9/);
    const result = await harness!.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Paper two extends paper one to humans.",
          confidence: "medium",
          sourceClaimIds: ["PAPER001:c1"],
          targetClaimIds: ["PAPER002:c1"],
        },
        {
          source: "1:PAPER002",
          target: "1:PAPER003",
          type: "contradicts",
          statement: "Paper three reports the opposite bias.",
          confidence: "low",
          sourceClaimIds: ["PAPER002:c1"],
          targetClaimIds: ["PAPER003:c1"],
        },
      ],
    });
    assert.lengthOf(result.edges, 2);
    assert.isTrue(
      result.edges[1].requiresVerification,
      "contradictions are always verified",
    );
    assert.isFalse(result.edges[0].requiresVerification);
    assert.equal(result.edges[0].status, "candidate");
    const again = await harness!.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Revised statement.",
          confidence: "high",
        },
      ],
    });
    assert.equal(again.edges[0].edgeId, result.edges[0].edgeId);
    assert.match(again.warnings[0], /updated existing edge/);
    const edges = await listResearchEdges((await job(harness!)).researchJobId);
    assert.lengthOf(edges, 2);
    assert.equal(edges[0].statement, "Revised statement.");
    assert.deepEqual(
      edges[0].subquestionIds,
      [],
      "the re-record replaced its claim ids, so its subquestions follow",
    );
    assert.deepEqual(edges[1].subquestionIds, ["sq2"]);
  });

  it("enforces the stop rules on phase transitions and ranks required verification first", async function () {
    await recordAllNodes(harness!);
    const noEdges = await attempt(() =>
      harness!.run({ operation: "advance_phase", phase: "verification" }),
    );
    assert.match(noEdges, /No edges are recorded/);
    const skip = await attempt(() =>
      harness!.run({ operation: "advance_phase", phase: "structure" }),
    );
    assert.match(skip, /one step at a time/);
    await harness!.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Two extends one.",
          confidence: "high",
        },
        {
          source: "1:PAPER002",
          target: "1:PAPER003",
          type: "contradicts",
          statement: "Three contradicts two.",
          confidence: "low",
        },
      ],
    });
    const advanced = await harness!.run({
      operation: "advance_phase",
      phase: "verification",
    });
    assert.equal(advanced.phase, "verification");
    const work = await harness!.run({ operation: "next_work" });
    assert.equal(work.phase, "verification");
    assert.isFalse(work.phaseComplete);
    assert.equal(work.candidates[0].kind, "verify_edge");
    assert.equal(work.candidates[0].type, "contradicts");
    assert.isTrue(work.candidates[0].required);
    assert.match(work.candidates[0].action, /update_edges/);
    const blocked = await attempt(() =>
      harness!.run({ operation: "advance_phase", phase: "structure" }),
    );
    assert.match(blocked, /must be verified, refuted, or marked tentative/);
    const contradiction = work.candidates[0].edgeId;
    const noRead = await attempt(() =>
      harness!.run({
        operation: "update_edges",
        edges: [{ edgeId: contradiction, status: "verified" }],
      }),
    );
    assert.match(noRead, /targeted paper_read/);
    // An overview re-read is not verification, even after the edge exists.
    await harness!.verifiedRead(["PAPER003"], "body");
    const overviewOnly = await attempt(() =>
      harness!.run({
        operation: "update_edges",
        edges: [{ edgeId: contradiction, status: "verified" }],
      }),
    );
    assert.match(overviewOnly, /targeted paper_read/);
    // A targeted read of either paper verifies, with or without a page locator.
    await harness!.verifiedRead(["PAPER003"], "body", { mode: "targeted" });
    const decided = await harness!.run({
      operation: "update_edges",
      edges: [
        {
          edgeId: contradiction,
          status: "verified",
          note: "Figure 2 shows the reversed sign.",
        },
      ],
    });
    assert.equal(decided.edges[0].status, "verified");
    const stored = (
      await listResearchEdges((await job(harness!)).researchJobId)
    ).find((edge) => edge.edgeId === contradiction)!;
    assert.lengthOf(stored.verification!.evidenceRefs, 1);
    assert.match(stored.verification!.evidenceRefs[0], /:obs:1$/);
    assert.match(
      stored.verification!.evidenceRefs[0],
      /read-\d+:obs:1$/,
      "the targeted read, not the earlier overview, is the evidence",
    );
    const tentative = await attempt(() =>
      harness!.run({
        operation: "update_edges",
        edges: [{ edgeId: work.candidates[1].edgeId, status: "tentative" }],
      }),
    );
    assert.match(tentative, /needs a note/);
    await harness!.run({
      operation: "update_edges",
      edges: [
        {
          edgeId: work.candidates[1].edgeId,
          status: "tentative",
          note: "Different tasks; not checkable.",
        },
      ],
    });
    const done = await harness!.run({ operation: "next_work" });
    assert.isTrue(done.phaseComplete);
    assert.lengthOf(done.candidates, 0);
    assert.equal(done.counts.verifiedEdges, 1);
    assert.equal(done.counts.tentativeEdges, 1);
    const structure = await harness!.run({
      operation: "advance_phase",
      phase: "structure",
    });
    assert.equal(structure.phase, "structure");
  });

  it("records and resolves open questions scoped to edges, nodes and subquestions", async function () {
    await recordAllNodes(harness!);
    const { edges } = await harness!.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Two extends one.",
          confidence: "high",
        },
        {
          source: "1:PAPER002",
          target: "1:PAPER003",
          type: "shares_method",
          statement: "Same task.",
          confidence: "high",
        },
      ],
    });
    const badScope = await attempt(() =>
      harness!.run({
        operation: "record_questions",
        questions: [
          { text: "Does it replicate?", scope: { kind: "edge", ref: "nope" } },
        ],
      }),
    );
    assert.match(badScope, /existing edge/);
    const recorded = await harness!.run({
      operation: "record_questions",
      questions: [
        {
          text: "Does it replicate in humans?",
          scope: { kind: "edge", ref: edges[0].edgeId },
        },
        {
          text: "Which frameworks recur?",
          scope: { kind: "subquestion", ref: "sq1" },
          priority: 3,
        },
        {
          text: "Is paper three an outlier?",
          scope: { kind: "node", ref: "1:PAPER003" },
        },
      ],
    });
    assert.deepEqual(
      recorded.questions.map((question: any) => question.priority),
      [1, 3, 2],
    );
    const work = await harness!
      .run({ operation: "advance_phase", phase: "verification" })
      .then(() => harness!.run({ operation: "next_work" }));
    const questionCandidate = work.candidates.find(
      (entry: any) => entry.kind === "answer_question",
    );
    assert.deepEqual(questionCandidate.targets, ["1:PAPER001", "1:PAPER002"]);
    const missingResolution = await attempt(() =>
      harness!.run({
        operation: "resolve_questions",
        questions: [
          { questionId: recorded.questions[0].questionId, status: "answered" },
        ],
      }),
    );
    assert.match(missingResolution, /resolution/);
    await harness!.run({
      operation: "resolve_questions",
      questions: [
        {
          questionId: recorded.questions[0].questionId,
          status: "answered",
          resolution: "Yes, paper two.",
        },
        {
          questionId: recorded.questions[1].questionId,
          status: "abandoned",
          resolution: "Out of scope.",
        },
      ],
    });
    const questions = await listResearchOpenQuestions(
      (await job(harness!)).researchJobId,
    );
    assert.deepEqual(
      questions.map((question) => question.status),
      ["answered", "abandoned", "open"],
    );
  });
});

describe("research structure phase", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  beforeEach(async function () {
    harness = installResearchHarness();
    await harness.approve();
  });
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  async function reachStructure(h: ResearchHarness) {
    await recordAllNodes(h);
    const { edges } = await h.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Two extends one.",
          confidence: "high",
        },
        {
          source: "1:PAPER002",
          target: "1:PAPER003",
          type: "contradicts",
          statement: "Three contradicts two.",
          confidence: "low",
        },
      ],
    });
    await h.run({ operation: "advance_phase", phase: "verification" });
    await h.verifiedRead(["PAPER003"], "body", {
      pageIndex: 2,
      mode: "targeted",
    });
    await h.run({
      operation: "update_edges",
      edges: [
        { edgeId: edges[1].edgeId, status: "verified", note: "Table 1." },
      ],
    });
    await h.run({ operation: "advance_phase", phase: "structure" });
    return edges;
  }

  it("serves the graph view with communities, chronology and gaps", async function () {
    const edges = await reachStructure(harness!);
    await harness!.run({
      operation: "record_questions",
      questions: [
        {
          text: "Why the sign flip?",
          scope: { kind: "edge", ref: edges[1].edgeId },
        },
      ],
    });
    const graph = await harness!.run({ operation: "list_graph" });
    assert.equal(graph.phase, "structure");
    assert.lengthOf(graph.nodes, 3);
    assert.deepEqual(graph.nodes[0].claimIds, [
      "PAPER001:c1",
      "PAPER001:c2",
      "PAPER001:c3",
    ]);
    assert.deepEqual(
      graph.edges.map((edge: any) => [edge.type, edge.status]),
      [
        ["extends", "candidate"],
        ["contradicts", "verified"],
      ],
    );
    assert.equal(graph.edges[1].note, "Table 1.");
    assert.deepEqual(graph.communities[0].members, [
      "1:PAPER001",
      "1:PAPER002",
      "1:PAPER003",
    ]);
    assert.deepEqual(
      graph.chronology.map((entry: any) => entry.year),
      ["2016", "2017", "2018"],
    );
    assert.deepEqual(graph.gaps.isolatedNodes, []);
    assert.deepEqual(graph.gaps.unresolvedContradictions, []);
    assert.lengthOf(graph.openQuestions, 1);
    assert.deepEqual(graph.gaps.openQuestions, [
      graph.openQuestions[0].questionId,
    ]);
  });

  it("binds themes to edges that connect their papers and gates finalize on the writing phase", async function () {
    const edges = await reachStructure(harness!);
    const unbound = await attempt(() =>
      harness!.run({
        operation: "record_themes",
        themes: [
          {
            themeId: "T1",
            title: "Latent state",
            synthesis: "Papers one and two build one story.",
            limitations: [],
            paperIdentities: ["1:PAPER001", "1:PAPER002"],
          },
        ],
      }),
    );
    assert.match(unbound, /names no edgeIds/);
    const wrongEdge = await attempt(() =>
      harness!.run({
        operation: "record_themes",
        themes: [
          {
            themeId: "T1",
            title: "Latent state",
            synthesis: "Papers one and two build one story.",
            limitations: [],
            paperIdentities: ["1:PAPER001", "1:PAPER002"],
            edgeIds: [edges[1].edgeId],
          },
        ],
      }),
    );
    assert.match(wrongEdge, /both papers must belong to the theme/);
    const early = await attempt(() =>
      harness!.run({ operation: "finalize", outcome: "complete" }),
    );
    assert.match(early, /writing phase/);
    await harness!.run({
      operation: "record_themes",
      themes: [
        {
          themeId: "T1",
          title: "Latent state",
          synthesis:
            "Paper two extends paper one; paper three contradicts two on the sign.",
          limitations: [],
          paperIdentities: ["1:PAPER001", "1:PAPER002", "1:PAPER003"],
          edgeIds: [edges[0].edgeId, edges[1].edgeId],
          communityId: "C1",
        },
      ],
    });
    const themes = await harness!.run({ operation: "list_themes" });
    assert.deepEqual(themes.themes[0].edgeIds, [
      edges[0].edgeId,
      edges[1].edgeId,
    ]);
    await harness!.run({ operation: "advance_phase", phase: "writing" });
    const finalized = await harness!.run({
      operation: "finalize",
      outcome: "complete",
    });
    assert.equal(finalized.progress.coverageStatus, "complete");
    const finalJob = await job(harness!);
    assert.equal(finalJob.status, "completed");
  });
});

describe("document support audit in the plan finalizer", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  const spec = {
    kind: "literature_review",
    title: "Latent State Review",
    requiredSections: ["Introduction", "Thematic synthesis", "References"],
    requiresReferences: true,
    requiresCoverageSection: true,
    allowFigures: false,
    citationStyle: {
      styleId: "http://www.zotero.org/styles/apa",
      styleTitle: "APA",
      locale: "en-US",
    },
  };

  async function completeResearch(h: ResearchHarness) {
    await recordAllNodes(h);
    const { edges } = await h.run({
      operation: "record_edges",
      edges: [
        {
          source: "1:PAPER001",
          target: "1:PAPER002",
          type: "extends",
          statement: "Two extends one.",
          confidence: "high",
        },
        {
          source: "1:PAPER002",
          target: "1:PAPER003",
          type: "contradicts",
          statement: "Three contradicts two.",
          confidence: "low",
        },
      ],
    });
    await h.run({ operation: "advance_phase", phase: "verification" });
    await h.verifiedRead(["PAPER003"], "body", {
      pageIndex: 2,
      mode: "targeted",
    });
    await h.run({
      operation: "update_edges",
      edges: [
        { edgeId: edges[1].edgeId, status: "verified", note: "Table 1." },
      ],
    });
    await h.run({ operation: "advance_phase", phase: "structure" });
    await h.run({
      operation: "record_themes",
      themes: [
        {
          themeId: "T1",
          title: "Latent state",
          synthesis: "One story with a contradiction.",
          limitations: [],
          paperIdentities: ["1:PAPER001", "1:PAPER002", "1:PAPER003"],
          edgeIds: [edges[0].edgeId, edges[1].edgeId],
        },
      ],
    });
    await h.run({ operation: "advance_phase", phase: "writing" });
    await h.run({ operation: "finalize", outcome: "complete" });
    return edges;
  }

  const citations = [
    {
      citationId: "C1",
      sources: [{ libraryID: 1, itemKey: "PAPER001", evidenceRefs: [] }],
    },
    {
      citationId: "C2",
      sources: [{ libraryID: 1, itemKey: "PAPER002", evidenceRefs: [] }],
    },
    {
      citationId: "C3",
      sources: [{ libraryID: 1, itemKey: "PAPER003", evidenceRefs: [] }],
    },
  ];

  it("rejects unsupported cross-paper paragraphs, then calibrates and accepts a supported document", async function () {
    const { PlanDocumentFinalizer } =
      await import("../src/agent/documents/planFinalization");
    // Loaded the same way as the finalizer so the class identity matches.
    const { ToolInputRejection } =
      await import("../src/agent/tools/execution/failure");
    harness = installResearchHarness();
    await harness.approve({ deliverable: { kind: "document", spec } });
    await completeResearch(harness);
    const ledger = await harness.ledger();
    const documentTask = await harness.activeTask();
    assert.equal(documentTask.expectedEffect, "artifact");
    const finalizer = new PlanDocumentFinalizer(harness.gateway as never);
    const submit = (markdown: string, title = spec.title) =>
      finalizer.finalize({
        executionId: ledger.executionId,
        activeTaskId: documentTask.taskId,
        input: {
          title,
          markdown,
          citations,
          quotes: [],
          assets: [],
          groundingReviewed: "passed",
          groundingIssues: [],
        },
        now: 500,
      });
    let unsupportedError: unknown;
    const unsupported = await attempt(() =>
      submit(
        [
          "# Latent State Review",
          "",
          "## Introduction",
          "",
          "All three papers [[cite:C1]] [[cite:C2]] [[cite:C3]].",
          "",
          "## Thematic synthesis",
          "",
          "Papers one and three converge on decoding [[cite:C1]] [[cite:C3]].",
        ].join("\n"),
      ).catch((error: unknown) => {
        unsupportedError = error;
        throw error;
      }),
    );
    assert.instanceOf(
      unsupportedError,
      ToolInputRejection,
      "a refused document counts on the input-rejection cap, not the tool-error breaker",
    );
    assert.match(unsupported, /support audit failed/);
    assert.match(unsupported, /record_edges/);
    assert.match(unsupported, /1:PAPER001, 1:PAPER003/);
    const finalized = await submit(
      [
        "# Latent State Review (draft)",
        "",
        "## Introduction",
        "",
        "All three papers [[cite:C1]] [[cite:C2]] [[cite:C3]].",
        "",
        "## Thematic synthesis",
        "",
        "Paper two extends paper one to humans [[cite:C1]] [[cite:C2]], and paper three contradicts two on the sign of the bias [[cite:C2]] [[cite:C3]].",
      ].join("\n"),
      "Latent State Review (draft)",
    );
    const markdown = finalized.document.visibleMarkdown;
    assert.equal(
      finalized.document.title,
      spec.title,
      "the approved title owns the document",
    );
    assert.match(
      markdown,
      /^# Latent State Review\n/,
      "the leading heading follows the approved title",
    );
    assert.notMatch(markdown, /\(draft\)/);
    assert.match(markdown, /## Scope and limitations/);
    assert.match(
      markdown,
      /Coverage: 3 papers in the approved scope \(3 at full-text depth\)/,
    );
    assert.match(
      markdown,
      /Relationships: 2 recorded between papers, 1 verified/,
    );
    assert.isTrue(
      markdown.indexOf("## Scope and limitations") <
        markdown.indexOf("## References"),
    );
    assert.deepEqual(finalized.supportAudit, {
      crossPaperParagraphs: 1,
      supported: 1,
      unsupported: [],
    });
    const finalJob = await job(harness);
    assert.equal(finalJob.synthesisPhase, "complete");
    assert.equal(finalJob.qualityReport?.crossPaperParagraphs, 1);
    assert.equal(finalJob.qualityReport?.crossPaperParagraphsSupported, 1);
    assert.equal(finalJob.qualityReport?.edgesVerified, 1);
  });
});
