import { assert } from "chai";
import {
  decodePaperFinding,
  decodeResearchCorpusItem,
  decodeResearchEdge,
  decodeResearchJob,
  decodeResearchOpenQuestion,
} from "../src/agent/research/decoders";
import {
  clearResearchConversationRowsInTransaction,
  invalidateResearchGraph,
  listResearchEdges,
  listResearchOpenQuestions,
  listThemeFindings,
  loadResearchJob,
  loadResearchJobForExecution,
  saveResearchEdge,
  saveResearchJob,
  saveResearchOpenQuestion,
  saveThemeFinding,
} from "../src/agent/research/store";
import type {
  ResearchEdge,
  ResearchJob,
  ResearchOpenQuestion,
} from "../src/agent/research/types";
import {
  installResearchHarness,
  type ResearchHarness,
} from "./helpers/researchHarness";

function edge(
  job: ResearchJob,
  overrides: Partial<ResearchEdge> = {},
): ResearchEdge {
  return {
    version: 1,
    edgeId: `${job.researchJobId}:edge:1`,
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    source: "1:PAPER001",
    target: "1:PAPER002",
    type: "contradicts",
    statement:
      "Paper 2 reports the opposite sign of the bias found in paper 1.",
    sourceClaimIds: ["PAPER001:c1"],
    targetClaimIds: ["PAPER002:c2"],
    confidence: "medium",
    requiresVerification: true,
    status: "candidate",
    subquestionIds: ["sq2"],
    scopeLineageDigest: job.scopeLineageDigest,
    lifecycle: "valid",
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function question(
  job: ResearchJob,
  overrides: Partial<ResearchOpenQuestion> = {},
): ResearchOpenQuestion {
  return {
    version: 1,
    questionId: `${job.researchJobId}:question:1`,
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    text: "Does the bias reverse at long distances in macaques too?",
    scope: { kind: "edge", ref: `${job.researchJobId}:edge:1` },
    priority: 1,
    origin: "model",
    status: "open",
    scopeLineageDigest: job.scopeLineageDigest,
    lifecycle: "valid",
    createdAt: 11,
    updatedAt: 11,
    ...overrides,
  };
}

describe("research graph store", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  let job: ResearchJob;
  beforeEach(async function () {
    harness = installResearchHarness();
    const ledger = await harness.approve();
    job = (await loadResearchJobForExecution(ledger.executionId))!;
  });
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  it("round-trips edges and hides invalidated ones by default", async function () {
    await saveResearchEdge(edge(job));
    await saveResearchEdge(
      edge(job, {
        edgeId: `${job.researchJobId}:edge:2`,
        type: "extends",
        status: "verified",
        requiresVerification: false,
        verification: { evidenceRefs: ["ev-1"], note: "page 4", decidedAt: 12 },
      }),
    );
    const edges = await listResearchEdges(job.researchJobId);
    assert.deepEqual(
      edges.map((entry) => [entry.type, entry.status]),
      [
        ["contradicts", "candidate"],
        ["extends", "verified"],
      ],
    );
    assert.deepEqual(edges[1].verification?.evidenceRefs, ["ev-1"]);
    await saveResearchEdge({
      ...edges[0],
      lifecycle: "invalidated",
      invalidatedAt: 20,
    });
    assert.lengthOf(await listResearchEdges(job.researchJobId), 1);
    assert.lengthOf(
      await listResearchEdges(job.researchJobId, { includeInvalidated: true }),
      2,
    );
  });

  it("rejects malformed edges", function () {
    assert.throws(
      () => decodeResearchEdge(edge(job, { target: "1:PAPER001" })),
      /itself/,
    );
    assert.throws(
      () => decodeResearchEdge({ ...edge(job), type: "related" }),
      /edge type/,
    );
    assert.throws(
      () => decodeResearchEdge({ ...edge(job), status: "maybe" }),
      /edge status/,
    );
    assert.throws(
      () =>
        decodeResearchEdge({
          ...edge(job),
          status: "verified",
          verification: undefined,
        }),
      /verification/,
    );
  });

  it("round-trips open questions and validates scope and priority", async function () {
    await saveResearchOpenQuestion(question(job));
    await saveResearchOpenQuestion(
      question(job, {
        questionId: `${job.researchJobId}:question:2`,
        scope: { kind: "corpus" },
        origin: "host_gap",
        status: "answered",
        resolution: { text: "Yes, in one study.", evidenceRefs: ["ev-2"] },
        priority: 3,
      }),
    );
    const questions = await listResearchOpenQuestions(job.researchJobId);
    assert.deepEqual(
      questions.map((entry) => entry.status),
      ["open", "answered"],
    );
    assert.equal(questions[1].resolution?.text, "Yes, in one study.");
    assert.throws(
      () => decodeResearchOpenQuestion({ ...question(job), priority: 4 }),
      /priority/,
    );
    assert.throws(
      () =>
        decodeResearchOpenQuestion({
          ...question(job),
          scope: { kind: "edge" },
        }),
      /scope/,
    );
  });

  it("invalidates edges, questions and themes together for a superseded scope", async function () {
    await saveResearchEdge(edge(job));
    await saveResearchOpenQuestion(question(job));
    await saveThemeFinding({
      version: 2,
      themeFindingId: `${job.researchJobId}:theme:t1`,
      researchJobId: job.researchJobId,
      executionId: job.executionId,
      parentTaskId: job.parentTaskId,
      title: "Theme",
      synthesis: "Synthesis",
      paperFindingIds: [`${job.researchJobId}:paper:1:PAPER001`],
      evidenceRefs: [],
      limitations: [],
      scopeLineageDigest: job.scopeLineageDigest,
      status: "valid",
      createdAt: 5,
    });
    await invalidateResearchGraph(job.researchJobId, 30);
    assert.lengthOf(await listResearchEdges(job.researchJobId), 0);
    assert.lengthOf(await listResearchOpenQuestions(job.researchJobId), 0);
    assert.lengthOf(await listThemeFindings(job.researchJobId), 0);
    const invalidated = await listResearchEdges(job.researchJobId, {
      includeInvalidated: true,
    });
    assert.equal(invalidated[0].invalidatedAt, 30);
  });

  it("stores frame, phase and capacity on the job and stays version 2 without them", async function () {
    const stored = (await loadResearchJob(job.researchJobId))!;
    assert.equal(
      stored.version,
      3,
      "adaptive jobs carry the frame from approval",
    );
    await saveResearchJob(
      {
        ...stored,
        frame: undefined,
        synthesisPhase: undefined,
        nodeCapacity: undefined,
        qualityReport: undefined,
        updatedAt: stored.updatedAt + 1,
      },
      harness!.conversationKey,
    );
    assert.equal(
      (await loadResearchJob(job.researchJobId))!.version,
      2,
      "a job without graph fields stays readable by older builds",
    );
    await saveResearchJob(
      {
        ...(await loadResearchJob(job.researchJobId))!,
        frame: {
          version: 1,
          slots: [
            {
              slotId: "question",
              name: "Question",
              description: "What the paper asks",
              kind: "identity",
            },
            {
              slotId: "sq1",
              name: "Frameworks",
              description: "Which frameworks",
              kind: "comparison",
            },
          ],
          revisedAt: 40,
        },
        synthesisPhase: "links",
        nodeCapacity: {
          fullNodeCapacity: 12,
          linkViewTokens: 50_000,
          compactCoreTokens: 360,
          compactPeripheralTokens: 90,
          mandatoryTiering: false,
          measuredAt: 40,
        },
        updatedAt: 41,
      },
      harness!.conversationKey,
    );
    const reloaded = (await loadResearchJob(job.researchJobId))!;
    assert.equal(reloaded.version, 3);
    assert.equal(reloaded.synthesisPhase, "links");
    assert.equal(reloaded.frame?.slots[1].slotId, "sq1");
    assert.equal(reloaded.nodeCapacity?.fullNodeCapacity, 12);
    assert.throws(
      () => decodeResearchJob({ ...reloaded, synthesisPhase: "dreaming" }),
      /synthesis phase/,
    );
  });

  it("decodes version-2 nodes with claims and keeps version-1 nodes unchanged", function () {
    const base = {
      findingId: "r:paper:1:PAPER001",
      researchJobId: "r",
      executionId: "e",
      parentTaskId: "t",
      libraryID: 1,
      itemKey: "PAPER001",
      subquestionIds: ["sq1"],
      criterionIds: [],
      findings: ["a"],
      contradictions: [],
      negativeEvidence: [],
      limitations: [],
      evidenceRefs: [],
      sourceFingerprint: "fp",
      inclusionDecision: "include",
      confidence: "high",
      unresolvedQuestions: [],
      createdAt: 1,
    };
    const legacy = decodePaperFinding({ ...base, version: 1 });
    assert.equal(legacy.version, 1);
    assert.isUndefined(legacy.claims);
    const node = decodePaperFinding({
      ...base,
      version: 2,
      tier: "core",
      frameSlots: { question: "How is state computed?", sq1: "Bayesian" },
      claims: [
        {
          claimId: "PAPER001:c1",
          statement: "Latent state is decodable from area 7a.",
          kind: "finding",
          subquestionIds: ["sq1"],
          evidence: {
            sourceKind: "body",
            pageIndex: 3,
            quote: "decodable",
            verified: true,
          },
        },
      ],
      hooks: {
        constructs: ["latent state"],
        methods: ["decoding"],
        datasets: [],
        populations: ["macaque"],
        keyQuantities: [],
      },
      candidateLinks: [
        { target: "1:PAPER002", type: "extends", note: "same task" },
      ],
      questionsRaised: [
        { text: "Does it hold in humans?", about: "1:PAPER002" },
      ],
    });
    assert.equal(node.version, 2);
    assert.equal(node.claims?.[0].evidence.pageIndex, 3);
    assert.equal(node.candidateLinks?.[0].type, "extends");
    assert.throws(
      () =>
        decodePaperFinding({
          ...base,
          version: 2,
          claims: [
            {
              claimId: "x",
              statement: "s",
              kind: "guess",
              subquestionIds: [],
              evidence: { sourceKind: "body" },
            },
          ],
        }),
      /claim kind/,
    );
  });

  it("decodes tier fields on version-2 corpus items", function () {
    const item = decodeResearchCorpusItem({
      version: 2,
      researchJobId: "r",
      executionId: "e",
      parentTaskId: "t",
      libraryID: 1,
      itemKey: "PAPER001",
      ordinal: 0,
      screeningStatus: "pending",
      criterionResults: {},
      inventoryRecorded: true,
      hasAbstract: true,
      attachmentItemKeys: [],
      duplicateAttachmentKeys: [],
      readable: true,
      indexed: true,
      tier: "supporting",
      relevanceScore: 0.42,
      tierSource: "host",
      textTokens: 9000,
      updatedAt: 1,
    });
    assert.equal(item.version, 2);
    assert.equal(item.tier, "supporting");
    assert.equal(item.textTokens, 9000);
  });

  it("sweeps edges and questions with the conversation", async function () {
    await saveResearchEdge(edge(job));
    await saveResearchOpenQuestion(question(job));
    await (globalThis as any).Zotero.DB.executeTransaction(() =>
      clearResearchConversationRowsInTransaction(harness!.conversationKey),
    );
    assert.lengthOf(
      await listResearchEdges(job.researchJobId, { includeInvalidated: true }),
      0,
    );
    assert.lengthOf(
      await listResearchOpenQuestions(job.researchJobId, {
        includeInvalidated: true,
      }),
      0,
    );
  });
});
