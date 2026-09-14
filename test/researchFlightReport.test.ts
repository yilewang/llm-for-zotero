import { assert } from "chai";
import {
  auditStoredDocumentSupport,
  buildResearchFlightReport,
  renderResearchFlightReport,
  summarizeFlightRuns,
} from "../src/agent/research/flightReport";

describe("research flight report", function () {
  it("attributes run time to loop phases and counts robustness events", function () {
    const at = (seconds: number) => 1_000_000 + seconds * 1000;
    const timings = summarizeFlightRuns([
      {
        runId: "run",
        status: "completed",
        createdAt: at(0),
        completedAt: at(100),
        events: [
          {
            type: "status",
            createdAt: at(1),
            payload: { text: "Continuing agent (2/24)" },
          },
          {
            type: "tool_call",
            createdAt: at(5),
            payload: {
              name: "research_update",
              callId: "1",
              args: { operation: "inventory_scope" },
            },
          },
          {
            type: "tool_result",
            createdAt: at(6),
            payload: { callId: "1", ok: true },
          },
          {
            type: "tool_call",
            createdAt: at(16),
            payload: {
              name: "paper_read",
              callId: "2",
              args: { mode: "overview" },
            },
          },
          {
            type: "tool_result",
            createdAt: at(17),
            payload: { callId: "2", ok: true },
          },
          {
            type: "tool_call",
            createdAt: at(40),
            payload: {
              name: "research_update",
              callId: "3",
              args: {
                __llmForZoteroMalformedToolArguments: true,
                operation: "record_papers",
              },
            },
          },
          {
            type: "tool_result",
            createdAt: at(41),
            payload: { callId: "3", ok: false },
          },
          {
            type: "tool_call",
            createdAt: at(50),
            payload: {
              name: "research_update",
              callId: "4",
              args: { operation: "record_edges" },
            },
          },
          {
            type: "tool_result",
            createdAt: at(51),
            payload: { callId: "4", ok: true },
          },
          {
            type: "tool_call",
            createdAt: at(60),
            payload: {
              name: "research_update",
              callId: "5",
              args: { operation: "advance_phase", phase: "verification" },
            },
          },
          {
            type: "tool_result",
            createdAt: at(61),
            payload: { callId: "5", ok: true },
          },
          {
            type: "tool_call",
            createdAt: at(70),
            payload: {
              name: "paper_read",
              callId: "6",
              args: { mode: "targeted" },
            },
          },
          {
            type: "tool_result",
            createdAt: at(72),
            payload: { callId: "6", ok: true },
          },
          {
            type: "provider_event",
            createdAt: at(72),
            payload: { providerType: "agent_context_budget" },
          },
          {
            type: "tool_call",
            createdAt: at(80),
            payload: { name: "submit_document", callId: "7", args: {} },
          },
          {
            type: "tool_result",
            createdAt: at(81),
            payload: { callId: "7", ok: false },
          },
          {
            type: "tool_call",
            createdAt: at(90),
            payload: { name: "submit_document", callId: "8", args: {} },
          },
          {
            type: "tool_result",
            createdAt: at(91),
            payload: { callId: "8", ok: true },
          },
          {
            type: "status",
            createdAt: at(92),
            payload: { text: "Continuing agent (9/24)" },
          },
          { type: "final", createdAt: at(100), payload: {} },
        ],
      },
    ]);
    assert.equal(timings.wallTimeMs, 100_000);
    assert.equal(timings.rounds, 9);
    assert.equal(timings.malformedArguments, 1);
    assert.equal(timings.toolErrors, 2);
    assert.equal(timings.documentRejections, 1);
    assert.equal(timings.checkpointRestarts, 1);
    assert.equal(timings.targetedReads, 1);
    assert.deepEqual(timings.phaseMs, {
      planning: 0,
      inventory: 6_000,
      nodes: 35_000,
      links: 10_000,
      verification: 21_000,
      structure: 0,
      writing: 28_000,
    });
    assert.equal(timings.toolCalls["paper_read:targeted"], 1);
    assert.equal(timings.toolCalls["submit_document"], 2);
  });

  it("audits a stored document through its rendered Zotero item links", function () {
    const audit = auditStoredDocumentSupport({
      visibleMarkdown: [
        "## Thematic synthesis",
        "",
        "Two extends one [(A, 2019)](zotero://select/library/items/AAAA1111) [(B, 2021)](zotero://select/library/items/BBBB2222).",
        "",
        "One and three disagree [(A, 2019)](zotero://select/library/items/AAAA1111) [(C, 2023)](zotero://select/library/items/CCCC3333).",
      ].join("\n"),
      clusters: [
        {
          citationId: "C1",
          sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
        },
        {
          citationId: "C2",
          sources: [{ libraryID: 1, itemKey: "BBBB2222", evidenceRefs: [] }],
        },
        {
          citationId: "C3",
          sources: [{ libraryID: 1, itemKey: "CCCC3333", evidenceRefs: [] }],
        },
      ],
      edges: [
        { source: "1:AAAA1111", target: "1:BBBB2222", status: "verified" },
      ],
    });
    assert.equal(audit.crossPaperParagraphs, 2);
    assert.equal(audit.supported, 1);
    assert.deepEqual(audit.unsupported[0].unlinked, [
      "1:AAAA1111",
      "1:CCCC3333",
    ]);
  });

  it("renders the report with quality, tiers and run sections", function () {
    const report = buildResearchFlightReport({
      job: {
        researchJobId: "job",
        executionId: "execution",
        status: "completed",
        coverageStatus: "complete",
        frame: { version: 1, slots: [], revisedAt: 1 },
        synthesisPhase: "complete",
        nodeCapacity: {
          fullNodeCapacity: 3,
          linkViewTokens: 50_000,
          compactCoreTokens: 360,
          compactPeripheralTokens: 90,
          mandatoryTiering: false,
          measuredAt: 1,
        },
      } as never,
      corpus: [
        {
          libraryID: 1,
          itemKey: "A",
          screeningStatus: "included",
          tier: "core",
        },
        {
          libraryID: 1,
          itemKey: "B",
          screeningStatus: "included",
          tier: "supporting",
        },
      ] as never,
      findings: [
        { libraryID: 1, itemKey: "A", subquestionIds: [], claims: [] },
      ] as never,
      edges: [],
      questions: [],
      themes: [],
      subquestions: [{ id: "sq1", question: "q" }],
      runs: [
        {
          runId: "r",
          status: "completed",
          createdAt: 0,
          completedAt: 5000,
          events: [],
        },
      ],
    });
    const rendered = renderResearchFlightReport(report);
    assert.include(
      rendered,
      "tiers                              core 1, supporting 1",
    );
    assert.include(
      rendered,
      "full-node capacity                 3 (link view 50000 tokens, tiering optional)",
    );
    assert.include(rendered, "papers / nodes                     2 / 1");
    assert.include(rendered, "runs / wall time                   1 / 5.0 s");
    assert.equal(report.phase, "complete");
  });
});
