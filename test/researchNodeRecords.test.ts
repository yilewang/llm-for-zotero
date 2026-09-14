import { assert } from "chai";
import { buildDefaultResearchFrame } from "../src/agent/research/frame";
import {
  listPaperFindings,
  listResearchCorpusItems,
  loadResearchJobForExecution,
  saveResearchCorpusItem,
  saveResearchJob,
} from "../src/agent/research/store";
import { createResearchUpdateTool } from "../src/agent/tools/plan/researchUpdate";
import {
  installResearchHarness,
  legacyFinding,
  type ResearchHarness,
} from "./helpers/researchHarness";

async function installFrame(harness: ResearchHarness) {
  const ledger = await harness.ledger();
  const job = (await loadResearchJobForExecution(ledger.executionId))!;
  await saveResearchJob(
    {
      ...job,
      frame: buildDefaultResearchFrame({
        subquestions: [
          { id: "sq1", question: "Which computational frameworks are used?" },
          {
            id: "sq2",
            question: "What empirical findings and contradictions emerge?",
          },
        ],
      }),
      updatedAt: job.updatedAt + 1,
    },
    harness.conversationKey,
  );
}

function coreNode(overrides: Record<string, unknown> = {}) {
  return {
    mainMessage:
      "Area 7a tracks a latent world state through recurrent dynamics.",
    relevance: "Supplies the mechanistic template for inference in the review.",
    confidence: "high",
    frameSlots: {
      question: "How does parietal cortex compute a latent state?",
      approach:
        "Neural recordings during virtual navigation plus an RNN model.",
      system: "Three macaques, firefly task.",
      sq1: "Dynamic Bayesian observer; recurrent network.",
      sq2: "Latent state decodable from single neurons; predicts errors.",
    },
    claims: [
      {
        statement:
          "Latent displacement from the goal is decodable from area 7a.",
        kind: "finding",
        subquestionIds: ["sq2"],
        evidence: {
          sourceKind: "body",
          quote: "decodable from single neurons",
        },
      },
      {
        statement:
          "Recurrent coupling, not feedforward input, carries the state.",
        kind: "mechanism",
        subquestionIds: ["sq1"],
        evidence: { sourceKind: "body" },
      },
      {
        statement:
          "Decoding is correlational; inheritance from other areas is untested.",
        kind: "limitation",
        subquestionIds: [],
        evidence: { sourceKind: "body" },
      },
    ],
    hooks: {
      constructs: ["latent state"],
      methods: ["decoding", "RNN"],
      populations: ["macaque"],
    },
    candidateLinks: [
      {
        target: "1:PAPER002",
        type: "extends",
        note: "same firefly task in humans",
      },
    ],
    ...overrides,
  };
}

describe("claim-based node records", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  beforeEach(async function () {
    harness = installResearchHarness();
    await harness.approve();
    await installFrame(harness);
    await harness.run({ operation: "inventory_scope" });
  });
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  async function record(finding: Record<string, unknown>, key = "PAPER001") {
    return harness!.run({
      operation: "record_papers",
      papers: [{ libraryID: 1, itemKey: key, finding }],
    });
  }

  async function failure(finding: Record<string, unknown>, key = "PAPER001") {
    try {
      await record(finding, key);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  }

  it("records a core node with host-assigned claim ids and derived legacy fields", async function () {
    await harness!.verifiedRead(["PAPER001"], "body");
    await record(coreNode());
    const job = (await loadResearchJobForExecution(
      (await harness!.ledger()).executionId,
    ))!;
    const [node] = await listPaperFindings(job.researchJobId);
    assert.equal(node.version, 2);
    assert.equal(node.tier, "core");
    assert.deepEqual(
      node.claims?.map((claim) => claim.claimId),
      ["PAPER001:c1", "PAPER001:c2", "PAPER001:c3"],
    );
    assert.deepEqual(node.subquestionIds, ["sq2", "sq1"]);
    assert.deepEqual(node.findings, [
      "Latent displacement from the goal is decodable from area 7a.",
    ]);
    assert.deepEqual(node.mechanisms, [
      "Recurrent coupling, not feedforward input, carries the state.",
    ]);
    assert.deepEqual(node.limitations, [
      "Decoding is correlational; inheritance from other areas is untested.",
    ]);
    assert.equal(
      node.researchQuestion,
      "How does parietal cortex compute a latent state?",
    );
    assert.equal(
      node.method,
      "Neural recordings during virtual navigation plus an RNN model.",
    );
    assert.equal(node.claims?.[0].evidence.verified, false);
    assert.deepEqual(node.hooks?.datasets, []);
  });

  it("names the missing frame slots and the claim minimum for a core node", async function () {
    await harness!.verifiedRead(["PAPER001"], "body");
    const { sq2: _dropped, ...slots } = coreNode().frameSlots as Record<
      string,
      string
    >;
    assert.match(
      await failure(coreNode({ frameSlots: slots })),
      /frame slot[s]? sq2/,
    );
    assert.match(
      await failure(
        coreNode({ claims: (coreNode().claims as unknown[]).slice(0, 2) }),
      ),
      /at least 3 claims/,
    );
    assert.match(
      await failure(
        coreNode({
          claims: (coreNode().claims as Record<string, unknown>[]).map(
            (claim) => ({
              ...claim,
              subquestionIds: [],
            }),
          ),
        }),
      ),
      /subquestion/,
    );
  });

  it("rejects claim evidence deeper than the verified read", async function () {
    await harness!.verifiedRead(["PAPER001"], "abstract");
    assert.match(await failure(coreNode()), /body evidence[\s\S]*abstract/);
  });

  it("requires exactly one of candidate links or an explicit no-link reason", async function () {
    await harness!.verifiedRead(["PAPER001"], "body");
    assert.match(
      await failure(coreNode({ candidateLinks: [] })),
      /candidateLinks[\s\S]*noLinkSeen/,
    );
    assert.match(
      await failure(coreNode({ noLinkSeen: "isolated" })),
      /either candidateLinks or noLinkSeen/,
    );
    assert.match(
      await failure(
        coreNode({
          candidateLinks: [
            { target: "1:NOPE0001", type: "extends", note: "x" },
          ],
        }),
      ),
      /outside the frozen corpus/,
    );
    assert.match(
      await failure(
        coreNode({
          candidateLinks: [
            { target: "1:PAPER001", type: "extends", note: "x" },
          ],
        }),
      ),
      /itself/,
    );
    await record(
      coreNode({
        candidateLinks: undefined,
        noLinkSeen: "No overlap with the other papers.",
      }),
    );
  });

  it("accepts a peripheral node with one claim and identity slots only", async function () {
    const job = (await loadResearchJobForExecution(
      (await harness!.ledger()).executionId,
    ))!;
    const corpus = await listResearchCorpusItems({
      researchJobId: job.researchJobId,
    });
    const item = corpus.find((entry) => entry.itemKey === "PAPER003")!;
    await saveResearchCorpusItem({
      ...item,
      version: 2,
      tier: "peripheral",
      tierSource: "host",
    });
    await harness!.verifiedRead(["PAPER003"], "abstract");
    await record(
      {
        mainMessage: "A review of hippocampal gaze coupling.",
        relevance: "Background only.",
        confidence: "medium",
        frameSlots: {
          question: "Does gaze embody belief?",
          approach: "Review",
          system: "Primates",
        },
        claims: [
          {
            statement: "Primate hippocampus is modulated by gaze.",
            kind: "context",
            subquestionIds: ["sq1"],
            evidence: { sourceKind: "abstract" },
          },
        ],
        noLinkSeen:
          "Background review; no specific claim relates to the other papers.",
      },
      "PAPER003",
    );
    const [node] = await listPaperFindings(job.researchJobId);
    assert.equal(node.tier, "peripheral");
    assert.lengthOf(node.claims || [], 1);
  });

  it("keeps legacy findings valid for jobs without a frame", async function () {
    const job = (await loadResearchJobForExecution(
      (await harness!.ledger()).executionId,
    ))!;
    await saveResearchJob(
      { ...job, frame: undefined, updatedAt: job.updatedAt + 1 },
      harness!.conversationKey,
    );
    await harness!.verifiedRead(["PAPER001"], "body");
    await record(legacyFinding());
    const [node] = await listPaperFindings(job.researchJobId);
    assert.equal(node.version, 1);
  });

  it("advertises the claim-based node in the tool schema", function () {
    const tool = createResearchUpdateTool({} as never);
    const finding = (tool.spec.inputSchema as any).properties.papers.items
      .properties.finding;
    assert.deepEqual(finding.required, [
      "mainMessage",
      "relevance",
      "confidence",
    ]);
    for (const key of [
      "claims",
      "frameSlots",
      "hooks",
      "candidateLinks",
      "noLinkSeen",
      "questionsRaised",
      "tier",
    ]) {
      assert.property(finding.properties, key);
    }
    assert.deepEqual(finding.properties.claims.items.required, [
      "statement",
      "kind",
      "subquestionIds",
      "evidence",
    ]);
  });
});
