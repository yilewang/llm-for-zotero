import { assert } from "chai";
import fs from "node:fs";
import path from "node:path";
import {
  TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS,
  TASK_PAPER_LEDGER_TOOL_NAMES,
  TASK_PAPER_MAX_CITATIONS_PER_TURN,
  TASK_PAPER_MAX_PAPERS,
  TASK_PAPER_MAX_READS_PER_TURN,
  TASK_PAPER_DIGEST_NO_TEXT_REASON,
  TASK_PAPER_SNIPPET_MAX_CHARS,
  applyDocumentCitations,
  applyFinalCitations,
  applyTaskPaperLedgerDelta,
  buildDigestFailureLedgerDelta,
  buildDigestLedgerDelta,
  createTaskPaperLedger,
  deriveTaskPaperLedgerDelta,
  firstBodyParagraph,
  taskPaperDigestPartLabel,
  taskPaperReadDepths,
  type TaskPaperLedgerDelta,
} from "../src/agent/context/taskPaperLedger";
import { createTrustedReadObservations } from "../src/agent/context/readObservation";
import { attestAndRecordRead } from "../src/agent/context/taskPaperLedgerRecorder";
import {
  DIGEST_FAILURE_REASONS,
  type HostPaperDigest,
} from "../src/agent/digests/paperDigestWorker";
import type { QuoteCitation } from "../src/shared/types";

function derive(
  toolName: string,
  input: unknown,
  content: unknown,
  extra: Partial<Parameters<typeof deriveTaskPaperLedgerDelta>[0]> = {},
): TaskPaperLedgerDelta {
  const delta = deriveTaskPaperLedgerDelta({
    toolName,
    callId: extra.callId || "call-1",
    input,
    content,
    libraryID: 1,
    ...extra,
  });
  assert.isNotNull(delta, `${toolName} should derive a delta`);
  return delta!;
}

function paperState(delta: TaskPaperLedgerDelta, key: string) {
  return delta.papers.find((paper) => paper.key === key)?.state;
}

function readsFor(delta: TaskPaperLedgerDelta, key: string) {
  return delta.reads.filter((read) => read.key === key);
}

/** A library_retrieve payload shaped like LibraryRetrieveService.retrieve. */
function libraryRetrieveFixture() {
  return {
    resourcePool: { type: "collection", scope: { libraryID: 3 } },
    candidates: [
      {
        itemId: "101",
        title: "Place cell drift",
        year: "2021",
        creators: ["Smith"],
        resourceState: ["available", "metadata_loaded", "text_indexed"],
        queryState: ["matched_bm25", "shortlisted"],
        score: 3,
        whyMatched: "title and abstract mention representational drift",
      },
      {
        itemId: "102",
        title: "Learning rules",
        resourceState: ["available", "metadata_loaded", "unsupported"],
        queryState: ["matched_metadata"],
        score: 1,
        whyMatched: "tag match",
      },
      {
        itemId: "103",
        title: "Abstract only",
        resourceState: ["available", "metadata_loaded"],
        queryState: ["matched_bm25"],
        score: 1,
        whyMatched: "abstract",
      },
      {
        itemId: "104",
        title: "Mineru paper",
        resourceState: ["available", "text_available"],
        queryState: ["matched_bm25", "content_loaded", "snippet_returned"],
        score: 2,
        whyMatched: "body",
      },
    ],
    paperMatches: [
      {
        itemId: "101",
        title: "Place cell drift",
        matchStatus: "strong",
        basis: ["chunk_text"],
        returnedSnippetCount: 1,
        confidence: "high",
        whyMatched: "body",
      },
      {
        itemId: "105",
        title: "Only a paper match",
        matchStatus: "weak",
        basis: ["metadata"],
        returnedSnippetCount: 0,
        confidence: "low",
        whyMatched: "venue",
      },
    ],
    snippets: [
      {
        snippetId: "s1",
        itemId: "101",
        contextItemId: "201",
        title: "Place cell drift",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: "Methods §2.3",
        snippet: "Cells drifted over weeks.",
        score: 2,
        whyMatched: "bm25 hit",
      },
      {
        snippetId: "s2",
        itemId: "103",
        title: "Abstract only",
        sourceKind: "abstract",
        matchMethod: "bm25",
        snippet: "We study drift.",
        score: 1,
        whyMatched: "abstract",
      },
      {
        snippetId: "s3",
        itemId: "104",
        contextItemId: "204",
        title: "Mineru paper",
        sourceKind: "mineru",
        matchMethod: "exact",
        snippet: "Exact drift phrase.",
        score: 1,
        whyMatched: "exact",
      },
      {
        snippetId: "s4",
        itemId: "106",
        title: "No text",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        snippet: "   ",
        score: 0,
        whyMatched: "",
      },
    ],
    warnings: [],
  };
}

describe("taskPaperLedger", function () {
  describe("deriveTaskPaperLedgerDelta", function () {
    it("maps library_retrieve rows to matched, skimmed and read", function () {
      const delta = derive(
        "library_retrieve",
        { query: "drift" },
        libraryRetrieveFixture(),
        { runId: "run-1", turnIndex: 2 },
      );
      assert.equal(delta.callId, "call-1");
      assert.equal(delta.runId, "run-1");
      assert.equal(delta.turnIndex, 2);
      // The retrieval's own scope library wins over the call's fallback.
      assert.equal(paperState(delta, "3:101"), "read");
      assert.equal(paperState(delta, "3:102"), "matched");
      assert.equal(paperState(delta, "3:103"), "skimmed");
      assert.equal(paperState(delta, "3:104"), "read");
      assert.equal(paperState(delta, "3:105"), "matched");
      assert.isUndefined(
        paperState(delta, "3:106"),
        "a snippet row with no text is not a read",
      );

      const p101 = delta.papers.find((paper) => paper.key === "3:101")!;
      assert.include(p101, {
        itemId: 101,
        libraryID: 3,
        contextItemId: 201,
        title: "Place cell drift",
        year: "2021",
        creator: "Smith",
        // The body snippet names its extraction, more specific than the index.
        text: "pdf_text",
      });
      assert.equal(
        delta.papers.find((paper) => paper.key === "3:104")!.text,
        "mineru",
      );
      assert.equal(
        delta.papers.find((paper) => paper.key === "3:102")!.text,
        "none",
      );

      const reads101 = readsFor(delta, "3:101");
      assert.deepEqual(
        reads101.map((read) => [read.granularity, read.method, read.label]),
        [
          ["metadata", "bm25", undefined],
          ["section", "bm25", "Methods §2.3"],
        ],
        "a paperMatch for a known candidate adds no second metadata read",
      );
      assert.equal(reads101[1].snippet, "Cells drifted over weeks.");
      assert.equal(reads101[1].whyMatched, "bm25 hit");
      assert.equal(reads101[1].runId, "run-1");
      assert.equal(reads101[1].turnIndex, 2);
      assert.deepEqual(
        readsFor(delta, "3:103").map((read) => read.granularity),
        ["metadata", "abstract"],
      );
      assert.deepEqual(
        readsFor(delta, "3:104").map((read) => read.granularity),
        ["metadata", "passage"],
      );
      assert.deepEqual(
        readsFor(delta, "3:105").map((read) => read.method),
        ["metadata"],
      );
    });

    it("maps paper_read overview by backend and coverage", function () {
      const delta = derive(
        "paper_read",
        { mode: "overview" },
        {
          mode: "overview",
          results: [
            {
              backend: "mineru",
              text: "Full MinerU text",
              coverage: "complete",
              paperContext: { itemId: 10, contextItemId: 20, title: "A" },
            },
            {
              backend: "raw_pdf_text",
              text: "Opening pages",
              coverage: "capacity_sampled",
              paperContext: { itemId: 11, contextItemId: 21, title: "B" },
            },
            {
              backend: "zotero_metadata",
              sourceKind: "zotero_metadata",
              text: "Title: C\nAbstract: An abstract about drift.",
              paperContext: { itemId: 12, contextItemId: 22 },
            },
            {
              backend: "zotero_metadata",
              sourceKind: "zotero_metadata",
              text: "Title: D",
              paperContext: { itemId: 13, contextItemId: 23 },
            },
            {
              backend: "mineru",
              ok: false,
              warning: "missing",
              paperContext: { itemId: 14, contextItemId: 24 },
            },
          ],
        },
      );
      assert.equal(paperState(delta, "1:10"), "read");
      assert.equal(readsFor(delta, "1:10")[0].granularity, "full");
      assert.equal(
        delta.papers.find((paper) => paper.key === "1:10")!.text,
        "mineru",
      );
      assert.equal(paperState(delta, "1:11"), "skimmed");
      assert.equal(readsFor(delta, "1:11")[0].granularity, "passage");
      assert.equal(
        delta.papers.find((paper) => paper.key === "1:11")!.text,
        "pdf_text",
      );
      assert.equal(paperState(delta, "1:12"), "skimmed");
      assert.equal(readsFor(delta, "1:12")[0].granularity, "abstract");
      assert.equal(
        readsFor(delta, "1:12")[0].snippet,
        "An abstract about drift.",
      );
      assert.equal(paperState(delta, "1:13"), "matched");
      assert.isUndefined(paperState(delta, "1:14"));
    });

    it("takes a complete overview read's snippet from the first body paragraph, not the title block", function () {
      const text =
        "[chunk 0]\n# Emergence of stable ensembles\nMeng-jun Sheng, Di Lu and Mu-ming Poo\nInstitute of Neuroscience, Shanghai\n\n## Abstract\n\nRepresentational drift was measured in 124 mice across 30 days, and the population code stayed decodable while single cells drifted.\n\n[chunk 1]\nMethods follow.";
      assert.equal(
        firstBodyParagraph(text),
        "Representational drift was measured in 124 mice across 30 days, and the population code stayed decodable while single cells drifted.",
      );
      const delta = derive(
        "paper_read",
        { mode: "overview" },
        {
          mode: "overview",
          results: [
            {
              backend: "mineru",
              text,
              coverage: "complete",
              paperContext: { itemId: 10, contextItemId: 20, title: "A" },
            },
          ],
        },
      );
      assert.equal(readsFor(delta, "1:10")[0].granularity, "full");
      assert.match(
        readsFor(delta, "1:10")[0].snippet || "",
        /^Representational drift was measured/,
      );
      assert.notInclude(readsFor(delta, "1:10")[0].snippet, "[chunk");
      assert.notInclude(readsFor(delta, "1:10")[0].snippet, "#");
    });

    it("takes a Chinese paper's abstract as its body paragraph, not its title block", function () {
      const abstract =
        "表征漂移是指在行为表现保持稳定的情况下，单个神经元的反应特性随时间逐渐改变的现象。本研究在一百二十四只小鼠中连续记录了三十天的海马CA1区神经元活动，发现群体编码在单细胞漂移的同时仍然可以准确解码动物的位置。";
      assert.isAtLeast(abstract.length, 100);
      const text = `[chunk 0]\n# 稳定神经集群的涌现\n张三，李四，王五\n中国科学院神经科学研究所\n\n## 摘要\n\n${abstract}\n\n[chunk 1]\n方法如下。`;
      assert.equal(firstBodyParagraph(text), abstract);
    });

    it("keeps an abstract that names a university once it reads as prose", function () {
      const abstract =
        "Patients treated at the University hospital over five years showed fewer relapses, and the effect held after adjustment for age and severity.";
      assert.equal(
        firstBodyParagraph(`# Title\nA. Author, B. Author\n\n${abstract}`),
        abstract,
      );
    });

    it("skips affiliation and short paragraphs, and falls back to the first paragraph", function () {
      assert.equal(
        firstBodyParagraph(
          "[passage p. 1]\nTitle\n\nDepartment of Neurobiology, University of Somewhere, 1 Road, City, State, Zip, Country, Planet, Galaxy\n\nWe recorded place cells in CA1 over many weeks and found that their tuning reorganized gradually while the decoded position stayed accurate.",
        ),
        "We recorded place cells in CA1 over many weeks and found that their tuning reorganized gradually while the decoded position stayed accurate.",
      );
      assert.equal(
        firstBodyParagraph("[chunk 0]\n# Only a title"),
        "Only a title",
      );
      assert.equal(firstBodyParagraph(""), "");
    });

    const GRID_TEXT =
      "[chunk 0]\n# Grid cells and spatial memory\n\nJane Doe1, John Smith2\n\n1 Department of Neuroscience, University of Example\n\n## Abstract\n\nGrid cells in the entorhinal cortex provide a metric for space. Here we show that human participants rely on grid-like codes during navigation in virtual reality across many sessions.";
    const GRID_ABSTRACT =
      "Grid cells in the entorhinal cortex provide a metric for space. Here we show that human participants rely on grid-like codes during navigation in virtual reality across many sessions.";

    it("takes every whole-text read's snippet from the first body paragraph", function () {
      const sampled = derive(
        "paper_read",
        { mode: "overview" },
        {
          mode: "overview",
          results: [
            {
              backend: "mineru",
              text: GRID_TEXT,
              coverage: "capacity_sampled",
              paperContext: { itemId: 10, contextItemId: 20, title: "Grid" },
            },
          ],
        },
      );
      assert.equal(readsFor(sampled, "1:10")[0].granularity, "passage");
      assert.equal(readsFor(sampled, "1:10")[0].snippet, GRID_ABSTRACT);
      const attachment = derive(
        "read_attachment",
        { target: { itemId: 10 } },
        { itemId: 10, title: "Grid", textContent: GRID_TEXT },
      );
      assert.equal(readsFor(attachment, "1:10")[0].snippet, GRID_ABSTRACT);
      const attachmentRows = derive(
        "read_attachment",
        {},
        { results: [{ itemId: 10, title: "Grid", content: GRID_TEXT }] },
      );
      assert.equal(readsFor(attachmentRows, "1:10")[0].snippet, GRID_ABSTRACT);
      const library = derive(
        "library_read",
        {},
        { results: [{ itemId: 10, title: "Grid", content: GRID_TEXT }] },
      );
      assert.equal(readsFor(library, "1:10")[0].snippet, GRID_ABSTRACT);
    });

    it("takes a Chinese abstract with a few Latin words and numbers over the title", function () {
      const abstract =
        "摘要：本研究使用 fMRI 和 EEG 技术记录了 32 名受试者在空间导航任务中的海马体活动，并利用深度学习模型解码其位置信息。结果表明模型解码准确率显著高于基线。";
      assert.equal(
        firstBodyParagraph(
          `[chunk 0]\n# 基于深度学习的海马体神经元活动解码研究\n\n张三¹, 李四², 王五¹\n\n1. 北京大学生命科学学院，北京 100871；2. 中国科学院神经科学研究所，上海 200031\n\n${abstract}\n\n关键词：海马体；深度学习`,
        ),
        abstract,
      );
    });

    it("skips an author list or an affiliation that ends with a period", function () {
      assert.equal(
        firstBodyParagraph(
          "# Title of the paper on something\n\nJ. Doe, A. Smith, B. Jones, C. Wang, D. Lee, E. Kim, F. Park, G. Chen.\n\nAbstract. We studied how grid cells keep their phase over many days.",
        ),
        "Abstract. We studied how grid cells keep their phase over many days.",
      );
      assert.equal(
        firstBodyParagraph(
          "# Title of the paper on something\n\nJ. Doe, A. Smith and B. Jones.\n\nWe report that grid cells keep their phase across many days of recording in freely moving rats.",
        ),
        "We report that grid cells keep their phase across many days of recording in freely moving rats.",
      );
      assert.equal(
        firstBodyParagraph(
          "# Title\n\nJane Doe and John Smith\n\nDepartment of Psychology, Stanford University, Stanford, CA 94305, USA.\n\nWe report that the hippocampus encodes time in a population code across many days of recording.",
        ),
        "We report that the hippocampus encodes time in a population code across many days of recording.",
      );
      assert.equal(
        firstBodyParagraph(
          "# Title\n\nJane Doe and John Smith\n\nCorrespondence should be sent to the first author at jane@example.org.\n\nWe report that the hippocampus encodes time in a population code across many days of recording.",
        ),
        "We report that the hippocampus encodes time in a population code across many days of recording.",
      );
    });

    it("maps paper_read targeted passages to sections, passages and pages", function () {
      const paperContext = { itemId: 10, contextItemId: 20, title: "A" };
      const delta = derive(
        "paper_read",
        { mode: "targeted", query: "drift" },
        {
          mode: "targeted",
          results: [],
          papers: [
            {
              paperContext,
              status: "matched",
              passages: [
                { text: "In Methods we ...", sectionLabel: "Methods" },
                { text: "An unlabelled passage", chunkIndex: 4 },
                {
                  text: "Page text",
                  chunkKind: "page",
                  sectionLabel: "Page 5",
                  pageIndex: 4,
                },
              ],
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              status: "no_matches",
              passages: [],
            },
          ],
        },
      );
      assert.equal(paperState(delta, "1:10"), "read");
      assert.deepEqual(
        readsFor(delta, "1:10").map((read) => [read.granularity, read.label]),
        [
          ["section", "Methods"],
          ["passage", undefined],
          ["page", "Page 5"],
        ],
      );
      assert.isUndefined(
        paperState(delta, "1:11"),
        "a paper with no passages was not read",
      );
    });

    it("maps paper_read outline to skimmed, full and figures to read", function () {
      const outline = derive(
        "paper_read",
        { mode: "outline" },
        {
          mode: "outline",
          papers: [
            {
              paperContext: { itemId: 10, contextItemId: 20 },
              outline: {
                sections: [{ title: "Intro" }, { title: "Methods" }],
              },
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              outline: { sections: [] },
            },
          ],
        },
      );
      assert.equal(paperState(outline, "1:10"), "skimmed");
      assert.deepEqual(readsFor(outline, "1:10")[0], {
        key: "1:10",
        callId: "call-1",
        toolName: "paper_read",
        granularity: "outline",
        method: "outline",
        label: "Intro · Methods",
      });
      assert.isUndefined(paperState(outline, "1:11"));

      const full = derive(
        "paper_read",
        { mode: "full" },
        {
          mode: "full",
          papers: [
            {
              paperContext: { itemId: 10, contextItemId: 20 },
              processedChunks: 30,
              totalChunks: 32,
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              processedChunks: 0,
              totalChunks: 10,
            },
          ],
        },
      );
      assert.equal(readsFor(full, "1:10")[0].granularity, "full");
      assert.equal(readsFor(full, "1:10")[0].label, "30/32 chunks");
      assert.isUndefined(paperState(full, "1:11"));

      const figures = derive(
        "paper_read",
        { mode: "figures" },
        {
          mode: "figures",
          status: "ok",
          figures: [
            {
              label: "Figure 2",
              caption: "Drift over days",
              cropPath: "/tmp/fig2.png",
              pageIndex: 3,
              paperContext: { itemId: 10, contextItemId: 20 },
            },
            {
              label: "Figure 3",
              paperContext: { itemId: 11, contextItemId: 21 },
            },
          ],
        },
      );
      assert.deepEqual(
        readsFor(figures, "1:10").map((read) => [
          read.granularity,
          read.label,
          read.snippet,
        ]),
        [["figure", "Figure 2 · p. 4", "Drift over days"]],
      );
      assert.isUndefined(
        paperState(figures, "1:11"),
        "a figure without a crop was not seen",
      );
    });

    it("maps catalog search rows to matched metadata reads", function () {
      const delta = derive(
        "library_search",
        { entity: "items", mode: "search", text: "drift" },
        {
          results: [
            { itemId: 10, title: "A", firstCreator: "Smith", year: 2020 },
            { collectionId: 5, name: "Not a paper" },
          ],
        },
      );
      assert.deepEqual(delta.papers, [
        {
          key: "1:10",
          libraryID: 1,
          itemId: 10,
          title: "A",
          year: "2020",
          creator: "Smith",
          state: "matched",
        },
      ]);
      assert.equal(delta.reads[0].method, "search");
    });

    it("resolves attachment-only rows through the host resolver, else skips them", function () {
      const content = {
        attachmentId: 20,
        title: "notes.md",
        textContent: "Attachment body",
      };
      const input = { target: { contextItemId: 20 } };
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "read_attachment",
          callId: "c",
          input,
          content,
          libraryID: 1,
        }),
      );
      const delta = derive("read_attachment", input, content, {
        resolvePaper: (ref) =>
          ref.contextItemId === 20 ? { itemId: 10, libraryID: 2 } : null,
      });
      assert.equal(paperState(delta, "2:10"), "read");
      assert.equal(delta.papers[0].contextItemId, 20);
      assert.equal(readsFor(delta, "2:10")[0].granularity, "full");
    });

    it("records rendered pages from paper_read visual mode", function () {
      const delta = derive(
        "paper_read",
        { target: { itemId: 10 }, mode: "visual", pages: [3, 4] },
        {
          target: { itemId: 10, contextItemId: 20, title: "A" },
          pageCount: 2,
          results: [
            { pageIndex: 2, pageLabel: "3" },
            { pageIndex: 3, pageLabel: "4" },
          ],
        },
      );
      assert.deepEqual(
        readsFor(delta, "1:10").map((read) => [read.granularity, read.label]),
        [["page", "p. 3, p. 4"]],
      );
    });

    it("records the page index a passage or page read came from (D5)", function () {
      const paperContext = { itemId: 10, contextItemId: 20, title: "A" };
      const targeted = derive(
        "paper_read",
        { mode: "targeted", query: "drift" },
        {
          mode: "targeted",
          results: [],
          papers: [
            {
              paperContext,
              status: "matched",
              passages: [
                {
                  text: "Printed page text",
                  chunkKind: "page",
                  pageIndex: 13,
                  pageLabel: "4",
                },
                {
                  text: "In Methods we ...",
                  sectionLabel: "Methods",
                  pageIndex: 5,
                },
              ],
            },
          ],
        },
      );
      assert.deepEqual(
        readsFor(targeted, "1:10").map((read) => [read.label, read.pageIndex]),
        [
          ["p. 4", 13],
          ["Methods", 5],
        ],
      );

      const visual = derive(
        "paper_read",
        { target: { itemId: 10 }, mode: "visual", pages: [3, 4] },
        {
          target: { itemId: 10, contextItemId: 20, title: "A" },
          pageCount: 2,
          results: [
            { pageIndex: 2, pageLabel: "3" },
            { pageIndex: 3, pageLabel: "4" },
          ],
        },
      );
      // The first page the label names.
      assert.equal(readsFor(visual, "1:10")[0].pageIndex, 2);
    });

    it("returns null for unknown tools and empty payloads", function () {
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "web_read",
          callId: "c",
          input: {},
          content: { results: [{ itemId: 10, text: "x" }] },
          libraryID: 1,
        }),
      );
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "paper_read",
          callId: "c",
          input: { mode: "full", target: { itemId: 10 } },
          content: {},
          libraryID: 1,
        }),
      );
    });

    it("caps reads per paper and clips snippet and whyMatched", function () {
      const snippets = Array.from({ length: 20 }, (_, index) => ({
        itemId: "10",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: `Section ${index}`,
        snippet: `${"x".repeat(400)} ${index}`,
        whyMatched: "w".repeat(300),
      }));
      const delta = derive(
        "library_retrieve",
        { query: "q" },
        {
          snippets,
        },
      );
      const reads = readsFor(delta, "1:10");
      assert.lengthOf(reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(delta.droppedReads, 20 - TASK_PAPER_MAX_READS_PER_TURN);
      assert.isAtMost(reads[0].snippet!.length, 280);
      assert.isTrue(reads[0].snippet!.endsWith("…"));
      assert.isAtMost(reads[0].whyMatched!.length, 120);
    });
  });

  describe("taskPaperReadDepths", function () {
    it("sorts a retrieval's papers into text, shallow and metadata-only", function () {
      const depths = taskPaperReadDepths(
        derive(
          "library_retrieve",
          { query: "drift" },
          libraryRetrieveFixture(),
        ),
      );
      // 101 and 104 returned body passages; 103 only its abstract; 102 and
      // 105 only a metadata row, which is no read at all.
      assert.deepEqual(depths, {
        text: [101, 104],
        shallow: [103],
        noText: [],
      });
    });

    it("counts an overview of a paper's text, sampled or complete, and reports a paper with none", function () {
      const depths = taskPaperReadDepths(
        derive(
          "paper_read",
          { mode: "overview" },
          {
            mode: "overview",
            results: [
              {
                backend: "mineru",
                text: "Full MinerU text",
                coverage: "complete",
                paperContext: { itemId: 10, contextItemId: 20 },
              },
              {
                backend: "raw_pdf_text",
                text: "Opening pages",
                coverage: "capacity_sampled",
                paperContext: { itemId: 11, contextItemId: 21 },
              },
              {
                backend: "zotero_metadata",
                sourceKind: "zotero_metadata",
                coverage: "abstract_only",
                text: "Title: C\nAbstract: An abstract about drift.",
                paperContext: { itemId: 12, contextItemId: 22 },
              },
              {
                backend: "zotero_metadata",
                sourceKind: "zotero_metadata",
                coverage: "metadata_only",
                text: "Title: D",
                paperContext: { itemId: 13, contextItemId: 23 },
              },
            ],
          },
        ),
      );
      assert.deepEqual(depths, {
        text: [10, 11],
        shallow: [12],
        noText: [12, 13],
      });
    });

    it("counts an outline as shallow and a figure or a page as text", function () {
      assert.deepEqual(
        taskPaperReadDepths(
          derive(
            "paper_read",
            { mode: "outline" },
            {
              mode: "outline",
              papers: [
                {
                  paperContext: { itemId: 10, contextItemId: 20 },
                  outline: { sections: [{ title: "Intro" }] },
                },
              ],
            },
          ),
        ),
        { text: [], shallow: [10], noText: [] },
      );
      assert.deepEqual(
        taskPaperReadDepths(
          derive(
            "paper_read",
            { target: { itemId: 10 }, mode: "visual", pages: [3] },
            {
              target: { itemId: 10, contextItemId: 20 },
              results: [{ pageIndex: 2, pageLabel: "3" }],
            },
          ),
        ),
        { text: [10], shallow: [], noText: [] },
      );
    });

    it("never reports missing text from a search listing, only from a read that tried", function () {
      const depths = taskPaperReadDepths(
        derive(
          "library_retrieve",
          { query: "drift" },
          libraryRetrieveFixture(),
        ),
      );
      assert.notInclude(
        depths.noText,
        102,
        "an unsupported candidate row is a listing, not a read",
      );
      assert.deepEqual(taskPaperReadDepths(null), {
        text: [],
        shallow: [],
        noText: [],
      });
    });
  });

  describe("applyTaskPaperLedgerDelta", function () {
    it("is idempotent by run and call, and keeps states monotone", function () {
      const ledger = createTaskPaperLedger();
      const read = derive(
        "library_retrieve",
        { query: "q" },
        libraryRetrieveFixture(),
        {
          runId: "run-1",
        },
      );
      applyTaskPaperLedgerDelta(ledger, read, 1);
      const snapshot = JSON.stringify(ledger);
      applyTaskPaperLedgerDelta(ledger, read, 1);
      assert.equal(JSON.stringify(ledger), snapshot, "replay is a no-op");

      const weaker = derive(
        "library_search",
        { mode: "search" },
        { results: [{ itemId: 101, libraryID: 3, title: "Place cell drift" }] },
        { runId: "run-1", callId: "call-2" },
      );
      applyTaskPaperLedgerDelta(ledger, weaker, 1);
      const entry = ledger.papers["3:101"];
      assert.equal(entry.state, "read", "a weaker read never lowers state");
      assert.equal(entry.turns[1].state, "read");
      assert.lengthOf(entry.turns[1].reads, 3);

      // The same call id in another run (MCP request ids restart) applies.
      const otherRun = { ...weaker, runId: "run-2" };
      applyTaskPaperLedgerDelta(ledger, otherRun, 2);
      assert.equal(entry.latestTurn, 2);
      assert.equal(entry.turns[2].state, "matched");
      assert.equal(entry.state, "read");
      assert.deepEqual(ledger.order.slice(0, 2), ["3:101", "3:102"]);
      assert.equal(entry.text, "pdf_text");
      assert.deepEqual(entry.contextItemIds, [201]);
    });

    it("caps reads per paper per turn across calls", function () {
      const ledger = createTaskPaperLedger();
      for (let call = 0; call < 5; call += 1) {
        applyTaskPaperLedgerDelta(
          ledger,
          derive(
            "paper_read",
            { mode: "targeted" },
            {
              papers: [
                {
                  paperContext: { itemId: 10, contextItemId: 20 },
                  passages: [1, 2, 3, 4].map((index) => ({
                    text: `call ${call} passage ${index}`,
                  })),
                },
              ],
            },
            { callId: `call-${call}` },
          ),
          1,
        );
      }
      const turn = ledger.papers["1:10"].turns[1];
      assert.lengthOf(turn.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(turn.droppedReads, 20 - TASK_PAPER_MAX_READS_PER_TURN);
      assert.isTrue(turn.reads.every((read) => read.turnIndex === 1));
    });

    it("caps papers per conversation", function () {
      const ledger = createTaskPaperLedger();
      const results = Array.from(
        { length: TASK_PAPER_MAX_PAPERS + 3 },
        (_, index) => ({ itemId: index + 1 }),
      );
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "big",
          toolName: "library_search",
          papers: results.map((row) => ({
            key: `1:${row.itemId}`,
            libraryID: 1,
            itemId: row.itemId,
            state: "matched" as const,
          })),
          reads: [],
        },
        1,
      );
      assert.lengthOf(ledger.order, TASK_PAPER_MAX_PAPERS);
      assert.equal(ledger.droppedPapers, 3);
    });
  });

  describe("host paper digests", function () {
    function digest(
      itemId: number,
      overrides: Partial<HostPaperDigest> = {},
    ): HostPaperDigest {
      return {
        schema: 2,
        itemId,
        contextItemId: itemId + 100,
        title: `Paper ${itemId}`,
        answer:
          "Cells drift slowly over days while the population code stays stable.",
        evidence: [
          {
            section: "Methods",
            quote: "We recorded 40 cells over 10 days.",
            chunk: 3,
          },
          { quote: "Population readouts stayed stable." },
        ],
        facets: [{ label: "Methods", content: "Two-photon imaging." }],
        gaps: [],
        source: {
          backend: "mineru",
          readCharacters: 4000,
          totalCharacters: 4000,
          complete: true,
        },
        model: "m",
        producedAt: 1,
        cacheKey: "k",
        ...overrides,
      };
    }
    const paper = (itemId: number) => ({
      libraryID: 1,
      itemId,
      contextItemId: itemId + 100,
      title: `Paper ${itemId}`,
      year: "2021",
      creator: "Smith",
    });

    it("records one digest read and one passage per verified evidence entry, never through the tool switch", function () {
      const delta = buildDigestLedgerDelta({
        runId: "run-d",
        callId: "call-7",
        toolName: "task_update",
        digest: digest(1),
        paper: paper(1),
      });
      assert.equal(delta.callId, "call-7:digest:1");
      assert.equal(delta.runId, "run-d");
      assert.equal(delta.toolName, "task_update");
      assert.isFalse(TASK_PAPER_LEDGER_TOOL_NAMES.has("task_update"));
      assert.deepEqual(delta.papers, [
        {
          key: "1:1",
          libraryID: 1,
          itemId: 1,
          contextItemId: 101,
          title: "Paper 1",
          year: "2021",
          creator: "Smith",
          text: "mineru",
          state: "read",
        },
      ]);
      assert.deepEqual(
        delta.reads.map((read) => [
          read.granularity,
          read.method,
          read.label,
          read.snippet,
          read.chunk,
          read.callId,
          read.runId,
        ]),
        [
          [
            "digest",
            "digest",
            undefined,
            "Cells drift slowly over days while the population code stays stable.",
            undefined,
            "call-7:digest:1",
            "run-d",
          ],
          [
            "passage",
            "digest",
            "Methods",
            "We recorded 40 cells over 10 days.",
            3,
            "call-7:digest:1",
            "run-d",
          ],
          [
            "passage",
            "digest",
            undefined,
            "Population readouts stayed stable.",
            undefined,
            "call-7:digest:1",
            "run-d",
          ],
        ],
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(delta)),
        delta,
        "no undefined keys: the live and replayed deltas are equal",
      );
      assert.deepEqual(taskPaperReadDepths(delta).text, [1]);
    });

    it("keeps an answer whole up to its own cap, evidence at the snippet cap, and caps the reads per paper", function () {
      // A 220-word answer is about 1,500 characters.
      const whole = "Representational drift ".repeat(65).trim();
      assert.isAbove(whole.length, TASK_PAPER_SNIPPET_MAX_CHARS);
      assert.isAtMost(whole.length, TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS);
      const kept = buildDigestLedgerDelta({
        callId: "call-7",
        toolName: "task_update",
        digest: digest(2, {
          answer: whole,
          evidence: [{ section: "Results", quote: "quote ".repeat(100) }],
        }),
        paper: paper(2),
      });
      assert.equal(kept.reads[0].snippet, whole, "read in full on the row");
      assert.isAtMost(
        kept.reads[1].snippet!.length,
        TASK_PAPER_SNIPPET_MAX_CHARS,
        "evidence keeps the ordinary cap",
      );

      const long = "word ".repeat(400);
      const delta = buildDigestLedgerDelta({
        callId: "call-7",
        toolName: "task_update",
        digest: digest(2, {
          answer: long,
          source: {
            backend: "pdf",
            readCharacters: 1,
            totalCharacters: 2,
            totalEstimated: true,
            complete: false,
          },
          evidence: Array.from({ length: 20 }, (_, index) => ({
            quote: `Quote ${index}.`,
          })),
        }),
        paper: paper(2),
      });
      assert.equal(
        delta.reads[0].snippet!.length,
        TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS,
      );
      assert.isTrue(delta.reads[0].snippet!.endsWith("…"));
      assert.lengthOf(delta.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(delta.droppedReads, 21 - TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(delta.papers[0].text, "pdf_text");
      assert.notProperty(delta, "runId");
    });

    it("applies one delta per paper under the same task_update call", function () {
      const ledger = createTaskPaperLedger();
      for (const itemId of [1, 2]) {
        applyTaskPaperLedgerDelta(
          ledger,
          buildDigestLedgerDelta({
            runId: "run-d",
            callId: "call-7",
            toolName: "task_update",
            digest: digest(itemId),
            paper: paper(itemId),
          }),
          1,
        );
      }
      assert.deepEqual(ledger.order, ["1:1", "1:2"]);
      assert.equal(ledger.papers["1:2"].state, "read");
      assert.lengthOf(ledger.papers["1:2"].turns[1].reads, 3);
    });

    it("never drops a digest read at the per-turn cap: three parts of six quotes each on one paper keep three digest reads", function () {
      const parts = ["papers", "stance", "limits"];
      const deltas = parts.map((partId) =>
        buildDigestLedgerDelta({
          runId: "run-d",
          callId: `call-7:${partId}`,
          toolName: "task_update",
          partId,
          label: `Part ${partId}`,
          digest: digest(1, {
            answer: `Answer of ${partId}.`,
            evidence: Array.from({ length: 6 }, (_, index) => ({
              quote: `Quote ${partId} ${index}.`,
            })),
          }),
          paper: paper(1),
        }),
      );
      const ledger = createTaskPaperLedger();
      for (const delta of deltas) applyTaskPaperLedgerDelta(ledger, delta, 1);
      const turn = ledger.papers["1:1"].turns[1];
      assert.deepEqual(
        turn.reads
          .filter((read) => read.granularity === "digest")
          .map((read) => [read.partId, read.snippet]),
        parts.map((partId) => [partId, `Answer of ${partId}.`]),
        "every part's digest read survives",
      );
      assert.lengthOf(turn.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(
        turn.reads.length + turn.droppedReads,
        3 * 7,
        "the reads that did not fit are counted, none lost silently",
      );

      const replayed = createTaskPaperLedger();
      for (const delta of JSON.parse(JSON.stringify(deltas))) {
        applyTaskPaperLedgerDelta(replayed, delta, 1);
      }
      assert.deepEqual(
        replayed.papers["1:1"].turns,
        ledger.papers["1:1"].turns,
      );
    });

    it("keeps a part's digest read when earlier reads of the paper already fill the turn", function () {
      const ledger = createTaskPaperLedger();
      const earlier: TaskPaperLedgerDelta = {
        version: 1,
        callId: "call-1",
        toolName: "paper_read",
        papers: [{ key: "1:1", libraryID: 1, itemId: 1, state: "read" }],
        reads: Array.from(
          { length: TASK_PAPER_MAX_READS_PER_TURN },
          (_, i) => ({
            key: "1:1",
            callId: "call-1",
            toolName: "paper_read",
            granularity: "passage" as const,
            method: "paper_read",
            snippet: `Earlier ${i}.`,
          }),
        ),
      };
      applyTaskPaperLedgerDelta(ledger, earlier, 1);
      applyTaskPaperLedgerDelta(
        ledger,
        buildDigestLedgerDelta({
          callId: "call-7",
          toolName: "task_update",
          partId: "papers",
          digest: digest(1, { evidence: [] }),
          paper: paper(1),
        }),
        1,
      );
      const turn = ledger.papers["1:1"].turns[1];
      assert.lengthOf(turn.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.deepEqual(
        turn.reads.filter((read) => read.granularity === "digest"),
        [turn.reads[turn.reads.length - 1]],
      );
      assert.equal(turn.droppedReads, 1);
      // A later passage read still yields to the cap.
      applyTaskPaperLedgerDelta(ledger, { ...earlier, callId: "call-2" }, 1);
      assert.lengthOf(turn.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.lengthOf(
        turn.reads.filter((read) => read.granularity === "digest"),
        1,
      );
    });

    it("records a failure's reason on the paper's row without reading it", function () {
      const failed = buildDigestFailureLedgerDelta({
        runId: "run-d",
        callId: "call-7",
        toolName: "task_update",
        failure: {
          target: "item:3",
          itemId: 3,
          reason: "No readable text",
          detail: "provider said no",
        },
        paper: paper(3),
      });
      assert.equal(failed.callId, "call-7:digest:3:failed");
      assert.deepEqual(
        failed.papers.map((row) => [row.state, row.text]),
        [["matched", "none"]],
      );
      assert.deepEqual(
        failed.reads.map((read) => [
          read.granularity,
          read.method,
          read.snippet,
          read.whyMatched,
        ]),
        [["digest", "digest", undefined, "No readable text"]],
      );
      assert.deepEqual(taskPaperReadDepths(failed), {
        text: [],
        shallow: [],
        noText: [],
      });
      const timeout = buildDigestFailureLedgerDelta({
        callId: "call-7",
        toolName: "task_update",
        failure: {
          target: "item:4",
          itemId: 4,
          reason: DIGEST_FAILURE_REASONS.timeout,
        },
        paper: paper(4),
      });
      assert.notProperty(
        timeout.papers[0],
        "text",
        "a timeout says nothing about the text",
      );
      assert.equal(
        TASK_PAPER_DIGEST_NO_TEXT_REASON,
        DIGEST_FAILURE_REASONS.noText,
        "the ledger names the worker's no-text reason",
      );

      // A later success in the same call is not swallowed by the failure.
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(ledger, failed, 1);
      applyTaskPaperLedgerDelta(
        ledger,
        buildDigestLedgerDelta({
          runId: "run-d",
          callId: "call-7",
          toolName: "task_update",
          digest: digest(3),
          paper: paper(3),
        }),
        1,
      );
      assert.equal(ledger.papers["1:3"].state, "read");
    });

    it("names the part on a digest read: its id, its label, and the relevance and stance it judged", function () {
      const delta = buildDigestLedgerDelta({
        runId: "run-d",
        callId: "call-7",
        toolName: "task_update",
        partId: "relevance",
        label: "Judge whether each paper bears on drift",
        digest: digest(1, {
          relevance: {
            level: "partial",
            reason: `It studies drift, not decoding. ${"More. ".repeat(80)}`,
          },
          stance: { position: "supports", reason: "Decoding stayed stable." },
        }),
        paper: paper(1),
      });
      const [read, ...passages] = delta.reads;
      assert.equal(read.granularity, "digest");
      assert.equal(read.partId, "relevance");
      assert.equal(read.label, "Judge whether each paper bears on drift");
      assert.equal(read.relevance?.level, "partial");
      assert.isAtMost(
        read.relevance!.reason.length,
        TASK_PAPER_SNIPPET_MAX_CHARS,
      );
      assert.deepEqual(read.stance, {
        position: "supports",
        reason: "Decoding stayed stable.",
      });
      // The evidence belongs to the part too, and keeps its section label.
      assert.deepEqual(
        passages.map((entry) => [entry.partId, entry.label]),
        [
          ["relevance", "Methods"],
          ["relevance", undefined],
        ],
      );
      assert.notProperty(passages[0], "relevance");
      assert.deepEqual(JSON.parse(JSON.stringify(delta)), delta);
    });

    it("records a digest without a part as before: no part keys, no label", function () {
      const delta = buildDigestLedgerDelta({
        callId: "call-7",
        toolName: "task_update",
        digest: digest(1),
        paper: paper(1),
      });
      for (const read of delta.reads) {
        assert.notProperty(read, "partId");
        assert.notProperty(read, "relevance");
        assert.notProperty(read, "stance");
      }
      assert.notProperty(delta.reads[0], "label");
    });

    it("names the part on a failed digest too", function () {
      const failed = buildDigestFailureLedgerDelta({
        callId: "call-7",
        toolName: "task_update",
        partId: "summaries",
        label: "Summarize each selected paper",
        failure: { reason: DIGEST_FAILURE_REASONS.thinText },
        paper: paper(3),
      });
      assert.deepEqual(
        failed.reads.map((read) => [
          read.granularity,
          read.partId,
          read.label,
          read.whyMatched,
          read.snippet,
        ]),
        [
          [
            "digest",
            "summaries",
            "Summarize each selected paper",
            "Too little text to analyze",
            undefined,
          ],
        ],
      );
    });

    it("keeps two parts' digests of one paper as two digest reads, each with its part", function () {
      const ledger = createTaskPaperLedger();
      for (const [partId, label, answer] of [
        ["summaries", "Summarize each selected paper", "A summary."],
        ["relevance", "Judge each paper's relevance", "A verdict."],
      ]) {
        applyTaskPaperLedgerDelta(
          ledger,
          buildDigestLedgerDelta({
            runId: "run-d",
            callId: `call-7:${partId}`,
            toolName: "task_update",
            partId,
            label,
            digest: digest(1, { answer, evidence: [] }),
            paper: paper(1),
          }),
          1,
        );
      }
      const reads = ledger.papers["1:1"].turns[1].reads.filter(
        (read) => read.granularity === "digest",
      );
      assert.deepEqual(
        reads.map((read) => [read.partId, read.label, read.snippet]),
        [
          ["summaries", "Summarize each selected paper", "A summary."],
          ["relevance", "Judge each paper's relevance", "A verdict."],
        ],
      );
    });

    it("still reads a row saved before parts: a digest read with no part fields", function () {
      const ledger = createTaskPaperLedger();
      const saved = JSON.parse(
        JSON.stringify({
          version: 1,
          callId: "call-old:digest:1",
          runId: "run-old",
          toolName: "task_update",
          papers: [{ key: "1:1", libraryID: 1, itemId: 1, state: "read" }],
          reads: [
            {
              key: "1:1",
              callId: "call-old:digest:1",
              runId: "run-old",
              toolName: "task_update",
              granularity: "digest",
              method: "digest",
              snippet: "An old summary.",
            },
          ],
        }),
      ) as TaskPaperLedgerDelta;
      applyTaskPaperLedgerDelta(ledger, saved, 1);
      const [read] = ledger.papers["1:1"].turns[1].reads;
      assert.equal(read.snippet, "An old summary.");
      assert.notProperty(read, "partId");
      assert.notProperty(read, "label");
    });

    describe("taskPaperDigestPartLabel", function () {
      it("is the description's first sentence", function () {
        assert.equal(
          taskPaperDigestPartLabel(
            "Judge whether each paper bears on drift. Give one reason.",
          ),
          "Judge whether each paper bears on drift",
        );
        assert.equal(
          taskPaperDigestPartLabel("  Summarize each selected paper  "),
          "Summarize each selected paper",
        );
        assert.equal(
          taskPaperDigestPartLabel("判断每篇论文是否与漂移有关。给出理由。"),
          "判断每篇论文是否与漂移有关",
        );
        // A question keeps its mark; a decimal point ends nothing.
        assert.equal(
          taskPaperDigestPartLabel(
            "Does each paper support the idea? Give the reason.",
          ),
          "Does each paper support the idea?",
        );
        assert.equal(
          taskPaperDigestPartLabel("这篇论文支持这个想法吗？请说明。"),
          "这篇论文支持这个想法吗？",
        );
        assert.equal(
          taskPaperDigestPartLabel("Report effects at p < 0.05 only"),
          "Report effects at p < 0.05 only",
        );
      });

      it("cuts a long first sentence at a word, within 60 characters", function () {
        const label = taskPaperDigestPartLabel(
          "For each paper extract the sample size, the recording method, the brain area and the main effect",
        )!;
        assert.isAtMost(label.length, 60);
        assert.equal(
          label,
          "For each paper extract the sample size, the recording…",
        );
        const unspaced = taskPaperDigestPartLabel("漂".repeat(80))!;
        assert.isAtMost(unspaced.length, 60);
        assert.isTrue(unspaced.endsWith("…"));
      });

      it("gives no label for an empty description", function () {
        assert.isUndefined(taskPaperDigestPartLabel(""));
        assert.isUndefined(taskPaperDigestPartLabel("   "));
        assert.isUndefined(taskPaperDigestPartLabel(undefined));
      });
    });
  });

  describe("applyFinalCitations", function () {
    function citation(
      id: string,
      fields: Partial<QuoteCitation> = {},
    ): QuoteCitation {
      return {
        id,
        quoteText: `quote ${id} ${"q".repeat(200)}`,
        citationLabel: "Smith 2021",
        itemId: 101,
        contextItemId: 201,
        sourceSectionLabel: "Results",
        pageHintLabel: "7",
        ...fields,
      };
    }

    it("marks cited papers, caps per turn, and replays idempotently", function () {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        derive("library_retrieve", { query: "q" }, libraryRetrieveFixture()),
        1,
      );
      const citations = [
        ...Array.from({ length: 10 }, (_, index) => citation(`c${index}`)),
        citation("c0"),
        citation("ctx-only", { itemId: undefined, contextItemId: 204 }),
        citation("unknown", { itemId: undefined, contextItemId: 999 }),
      ];
      applyFinalCitations(ledger, citations, 1);
      const cited = ledger.papers["3:101"];
      assert.equal(cited.state, "cited");
      assert.equal(cited.turns[1].state, "cited");
      assert.lengthOf(
        cited.turns[1].citations,
        TASK_PAPER_MAX_CITATIONS_PER_TURN,
      );
      assert.equal(cited.turns[1].droppedCitations, 2);
      assert.isAtMost(cited.turns[1].citations[0].quote!.length, 160);
      assert.include(cited.turns[1].citations[0], {
        citationId: "c0",
        turnIndex: 1,
        label: "Smith 2021",
        sectionLabel: "Results",
        pageLabel: "7",
      });
      assert.equal(ledger.papers["3:104"].state, "cited");
      const snapshot = JSON.stringify(ledger);
      applyFinalCitations(ledger, citations, 1);
      assert.equal(JSON.stringify(ledger), snapshot);
    });

    it("creates an entry for a cited paper that no read recorded", function () {
      const ledger = createTaskPaperLedger();
      applyFinalCitations(ledger, [citation("c1", { itemId: 55 })], 3, 1);
      assert.equal(ledger.papers["1:55"].state, "cited");
      assert.equal(ledger.papers["1:55"].latestTurn, 3);
    });

    it("re-applying a question's citations replaces them and recomputes state", function () {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "r1",
          toolName: "library_retrieve",
          papers: [
            { key: "1:7", libraryID: 1, itemId: 7, state: "read" },
            { key: "1:8", libraryID: 1, itemId: 8, state: "skimmed" },
          ],
          reads: [],
        },
        2,
      );
      applyFinalCitations(
        ledger,
        [citation("a", { itemId: 7 }), citation("b", { itemId: 8 })],
        2,
        1,
      );
      assert.equal(ledger.papers["1:7"].state, "cited");
      assert.equal(ledger.papers["1:8"].state, "cited");
      // The final answer dropped citation "b": paper 8 falls back to the
      // highest state its reads earned, in the turn and overall.
      applyFinalCitations(ledger, [citation("a", { itemId: 7 })], 2, 1);
      assert.equal(ledger.papers["1:7"].state, "cited");
      assert.equal(ledger.papers["1:8"].turns[2].state, "skimmed");
      assert.lengthOf(ledger.papers["1:8"].turns[2].citations, 0);
      assert.equal(ledger.papers["1:8"].state, "skimmed");
      // A citation of the same paper in another question is untouched.
      applyFinalCitations(ledger, [citation("c", { itemId: 8 })], 1, 1);
      applyFinalCitations(ledger, [], 2, 1);
      assert.equal(ledger.papers["1:8"].turns[1].state, "cited");
      assert.equal(ledger.papers["1:8"].state, "cited");
      assert.equal(ledger.papers["1:7"].state, "read");
      // A paper only a dropped citation created falls back to listed.
      applyFinalCitations(ledger, [citation("d", { itemId: 9 })], 3, 1);
      applyFinalCitations(ledger, [], 3, 1);
      assert.equal(ledger.papers["1:9"].state, "listed");
      assert.equal(ledger.papers["1:9"].turns[3].state, "listed");
    });
  });

  describe("applyDocumentCitations", function () {
    function readLedger() {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "r1",
          toolName: "paper_read",
          papers: [
            {
              key: "1:7",
              libraryID: 1,
              itemId: 7,
              itemKey: "SEVEN777",
              state: "read",
            },
            { key: "1:8", libraryID: 1, itemId: 8, state: "read" },
          ],
          reads: [],
        },
        2,
      );
      return ledger;
    }

    it("joins by item key, keeps the section label, and replays idempotently", function () {
      const ledger = readLedger();
      assert.equal(ledger.papers["1:7"].itemKey, "SEVEN777");
      const citations = [
        {
          citationId: "c1",
          libraryID: 1,
          itemKey: "SEVEN777",
          sectionLabel: "Discussion",
        },
        { citationId: "c2", libraryID: 1, itemKey: "EIGHT888", itemId: 8 },
      ];
      applyDocumentCitations(ledger, citations, 2);
      const seven = ledger.papers["1:7"];
      assert.equal(seven.state, "cited");
      assert.deepEqual(seven.turns[2].citations, [
        {
          citationId: "c1",
          turnIndex: 2,
          source: "document",
          sectionLabel: "Discussion",
        },
      ]);
      const eight = ledger.papers["1:8"];
      assert.equal(eight.state, "cited");
      assert.equal(eight.itemKey, "EIGHT888", "learns the key it was cited by");
      assert.isUndefined(eight.turns[2].citations[0].sectionLabel);
      const snapshot = JSON.stringify(ledger);
      applyDocumentCitations(ledger, citations, 2);
      assert.equal(JSON.stringify(ledger), snapshot);
      // Dropping a document citation falls back to the reads' state.
      applyDocumentCitations(ledger, [citations[0]], 2);
      assert.equal(ledger.papers["1:8"].state, "read");
      assert.lengthOf(ledger.papers["1:8"].turns[2].citations, 0);
    });

    it("creates an entry for an unknown cited item through the resolver, else drops it", function () {
      const ledger = readLedger();
      applyDocumentCitations(
        ledger,
        [
          { citationId: "x", libraryID: 1, itemKey: "NINE9999" },
          { citationId: "y", libraryID: 1, itemKey: "GONE0000" },
        ],
        2,
        (citation) => (citation.itemKey === "NINE9999" ? { itemId: 9 } : null),
      );
      assert.equal(ledger.papers["1:9"].state, "cited");
      assert.equal(ledger.papers["1:9"].itemKey, "NINE9999");
      assert.deepEqual(Object.keys(ledger.papers).sort(), [
        "1:7",
        "1:8",
        "1:9",
      ]);
    });

    it("files a source that names an attachment under its paper, not a row of its own", function () {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "r1",
          toolName: "paper_read",
          papers: [
            {
              key: "1:7",
              libraryID: 1,
              itemId: 7,
              contextItemId: 70,
              state: "read",
            },
          ],
          reads: [],
        },
        2,
      );
      // Known attachment: matched through the paper's context items.
      applyDocumentCitations(
        ledger,
        [{ citationId: "a", libraryID: 1, itemKey: "PDF70000", itemId: 70 }],
        2,
      );
      // Unknown attachment: the resolver climbs to its parent paper.
      applyDocumentCitations(
        ledger,
        [
          { citationId: "a", libraryID: 1, itemKey: "PDF70000", itemId: 70 },
          { citationId: "b", libraryID: 1, itemKey: "PDF71000", itemId: 71 },
        ],
        2,
        (citation) =>
          citation.itemId === 71 ? { itemId: 7, libraryID: 1 } : null,
      );
      assert.deepEqual(Object.keys(ledger.papers), ["1:7"]);
      assert.deepEqual(
        ledger.papers["1:7"].turns[2].citations.map((c) => c.citationId),
        ["a", "b"],
      );
      assert.include(ledger.papers["1:7"].contextItemIds, 71);
      assert.isUndefined(
        ledger.papers["1:7"].itemKey,
        "an attachment's key is not the paper's",
      );
    });

    it("names a paper only the document cited by the title the source carries", function () {
      const ledger = createTaskPaperLedger();
      applyDocumentCitations(
        ledger,
        [
          {
            citationId: "c",
            libraryID: 1,
            itemKey: "ONLY1234",
            itemId: 1234,
            title: "Drift in the cortex",
            firstCreator: "Smith",
            year: "2021",
          },
        ],
        1,
      );
      assert.include(ledger.papers["1:1234"], {
        title: "Drift in the cortex",
        creator: "Smith",
        year: "2021",
        itemKey: "ONLY1234",
      });
    });

    it("never disturbs the answer's citations, nor the answer the document's", function () {
      const ledger = readLedger();
      applyFinalCitations(
        ledger,
        [{ id: "q1", quoteText: "Quoted", itemId: 7 }],
        2,
        1,
      );
      applyDocumentCitations(
        ledger,
        [{ citationId: "d1", libraryID: 1, itemKey: "SEVEN777" }],
        2,
      );
      assert.deepEqual(
        ledger.papers["1:7"].turns[2].citations.map((c) => c.citationId),
        ["q1", "d1"],
      );
      applyFinalCitations(ledger, [], 2, 1);
      assert.deepEqual(
        ledger.papers["1:7"].turns[2].citations.map((c) => c.citationId),
        ["d1"],
      );
      assert.equal(ledger.papers["1:7"].state, "cited");
      applyDocumentCitations(ledger, [], 2);
      assert.equal(ledger.papers["1:7"].state, "read");
    });
  });

  describe("alignment with readObservation", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const items = new Map<number, Record<string, unknown>>([
      [10, { id: 10, key: "AAAA1111", libraryID: 1 }],
      [20, { id: 20, key: "PDFP1111", libraryID: 1, parentID: 10 }],
    ]);

    before(function () {
      (globalThis as { Zotero?: unknown }).Zotero = {
        Items: { get: (itemId: number) => items.get(itemId) || null },
      };
    });

    after(function () {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
    });

    function discoveredToolNames(): string[] {
      const names = new Set<string>();
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/name: "([a-z_]+)"/g)) {
              names.add(match[1]);
            }
          }
        }
      };
      walk(path.join(__dirname, "../src/agent/tools"));
      return [...names];
    }

    const row = {
      itemId: 10,
      contextItemId: 20,
      paperContext: { itemId: 10, contextItemId: 20 },
      text: "Body text",
      content: "Body text",
      snippet: "A snippet",
      abstract: "An abstract",
      metadata: { title: "T", abstract: "An abstract" },
      sourceKind: "pdf_text",
      cropPath: "/tmp/fig.png",
      backend: "mineru",
      coverage: "complete",
      pages: [{ pageIndex: 0 }],
      passages: [{ text: "Passage" }],
      processedChunks: 3,
      totalChunks: 3,
    };
    const fixtures: Array<{ input: Record<string, unknown>; result: unknown }> =
      [
        {
          input: {},
          result: {
            results: [row],
            papers: [row],
            candidates: [row],
            paperMatches: [row],
            snippets: [row],
            figures: [row],
          },
        },
        {
          input: { target: { itemId: 10 } },
          result: {
            text: "Body text",
            content: "Body text",
            abstract: "An abstract",
            pages: [{ pageIndex: 0 }],
            images: [{}],
          },
        },
        { input: { itemId: 10 }, result: { snippets: [row] } },
      ];
    const modes = [
      undefined,
      "overview",
      "outline",
      "targeted",
      "full",
      "figures",
      "visual",
      "capture",
    ];

    it("files each read of a paper_read overview with its paper's observation ids and item key", async function () {
      const { observations, paperLedgerDelta } = await attestAndRecordRead({
        toolName: "paper_read",
        callId: "obs",
        input: { mode: "overview" },
        result: {
          mode: "overview",
          results: [
            {
              backend: "mineru",
              text: "Body text of the paper.",
              coverage: "complete",
              paperContext: { itemId: 10, contextItemId: 20 },
            },
          ],
        },
        conversationKey: 5,
        libraryID: 1,
      });
      const ids = observations
        .filter((entry) => entry.itemKey === "AAAA1111")
        .map((entry) => entry.observationId);
      assert.isNotEmpty(ids);
      assert.equal(paperLedgerDelta!.papers[0].itemKey, "AAAA1111");
      assert.isNotEmpty(paperLedgerDelta!.reads);
      for (const read of paperLedgerDelta!.reads) {
        assert.deepEqual(read.observationIds, ids);
      }
    });

    it("records every read readObservation attests", async function () {
      const names = discoveredToolNames();
      assert.include(names, "paper_read");
      const attested = new Set<string>();
      for (const toolName of names) {
        for (const fixture of fixtures) {
          for (const mode of modes) {
            const input = mode ? { ...fixture.input, mode } : fixture.input;
            const observations = await createTrustedReadObservations({
              toolName,
              callId: "align",
              input,
              result: fixture.result,
            });
            if (!observations.length) continue;
            attested.add(toolName);
            const delta = deriveTaskPaperLedgerDelta({
              toolName,
              callId: "align",
              input,
              content: fixture.result,
              libraryID: 1,
            });
            assert.isNotNull(
              delta,
              `readObservation attests ${toolName} (mode ${mode}) but the task ledger records nothing`,
            );
            const observed = new Set(
              observations.map((entry) => entry.itemKey),
            );
            assert.isTrue(
              observed.has("AAAA1111") &&
                delta!.papers.some((paper) => paper.itemId === 10),
              `${toolName} (mode ${mode}) must record the attested paper`,
            );
          }
        }
      }
      for (const toolName of attested) {
        assert.isTrue(
          TASK_PAPER_LEDGER_TOOL_NAMES.has(toolName),
          `${toolName} is attested but not in TASK_PAPER_LEDGER_TOOL_NAMES`,
        );
      }
      assert.includeMembers(
        [...attested],
        [
          "library_retrieve",
          "paper_read",
          "library_search",
          "library_read",
          "read_attachment",
        ],
      );
    });
  });
});
