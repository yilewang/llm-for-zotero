import { assert } from "chai";
import { isFullTextRead } from "../src/agent/digests/readScope";
import { buildTaskPaperCoverage } from "../src/agent/context/taskPaperCoverage";
import { initI18n } from "../src/utils/i18n";
import {
  renderHostPaperDigests,
  type HostPaperDigest,
} from "../src/agent/digests/paperDigestWorker";
import {
  applyTaskPaperLedgerDelta,
  buildDigestLedgerDelta,
  createTaskPaperLedger,
  deriveTaskPaperLedgerDelta,
  type TaskPaperDigestInput,
  type TaskPaperReadEvent,
} from "../src/agent/context/taskPaperLedger";
import {
  formatTaskPaperDigestDepth,
  formatTaskPaperPassageLabel,
} from "../src/modules/contextPanel/taskProgress/view";

/**
 * "Full" means the reader read every character of the paper's text: a
 * complete read of the full scope. Anything less is "Part", and a read of
 * named parts shows those parts, never "Full".
 */

function digestRead(
  source: TaskPaperDigestInput["source"],
): TaskPaperReadEvent {
  const delta = buildDigestLedgerDelta({
    callId: "call",
    toolName: "task_update",
    label: "Summarize each paper",
    digest: {
      contextItemId: 101,
      answer: "The paper in brief.",
      evidence: [],
      source,
    },
    paper: { libraryID: 1, itemId: 1, title: "Paper 1" },
  });
  return delta.reads.find((read) => read.granularity === "digest")!;
}

describe("the Full label", function () {
  describe("isFullTextRead", function () {
    it("is a complete read of the full scope; an old record without a scope is of the full scope", function () {
      assert.isTrue(isFullTextRead({ complete: true }));
      assert.isTrue(
        isFullTextRead({ complete: true, scope: { source: "full" } }),
      );
      assert.isFalse(isFullTextRead({ complete: false }));
      assert.isFalse(
        isFullTextRead({
          complete: true,
          scope: { source: "sections", sections: ["abstract", "results"] },
        }),
      );
      assert.isFalse(
        isFullTextRead({ complete: true, scope: { source: "abstract" } }),
      );
    });
  });

  describe("a digest in Task progress", function () {
    it("shows Full for a complete read of the full text, also for an old record with no scope", function () {
      const read = digestRead({ backend: "mineru", complete: true });
      assert.isTrue(read.complete);
      assert.equal(formatTaskPaperDigestDepth(read), "Full");
      assert.equal(
        formatTaskPaperDigestDepth(
          digestRead({
            backend: "mineru",
            complete: true,
            scope: { source: "full" },
          }),
        ),
        "Full",
      );
    });

    it("records a complete full-text digest at full depth, above a cut section read", function () {
      const full = digestRead({ backend: "mineru", complete: true });
      assert.equal(full.depth, "full");
      const cut = digestRead({ backend: "pdf", complete: false });
      assert.notEqual(cut.depth, "full");
      const ledger = createTaskPaperLedger();
      for (const [callId, read] of [
        ["c1", cut],
        ["c2", full],
      ] as const) {
        applyTaskPaperLedgerDelta(
          ledger,
          {
            version: 1,
            callId,
            toolName: "task_update",
            papers: [
              {
                key: "1:1",
                libraryID: 1,
                itemId: 1,
                title: "Paper 1",
                state: "read",
              },
            ],
            reads: [{ ...read, callId }],
          },
          1,
        );
      }
      assert.equal(
        buildTaskPaperCoverage(ledger).papers[0].strongestGranularity,
        "full",
      );
    });

    it("shows a scoped read's depth names in the plugin's language", function () {
      const globals = globalThis as unknown as { Zotero?: unknown };
      const previous = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
      try {
        const read = digestRead({
          backend: "text",
          complete: true,
          scope: { source: "sections" },
          covered: ["Abstract", "Results", "notes", "metadata"],
        });
        assert.equal(
          formatTaskPaperDigestDepth(read),
          "摘要, Results, 笔记, 条目",
        );
      } finally {
        if (previous === undefined) delete globals.Zotero;
        else globals.Zotero = previous;
        initI18n();
      }
    });

    it("shows Part for a skimmed or cut read of the full text", function () {
      const read = digestRead({ backend: "pdf", complete: false });
      assert.equal(formatTaskPaperDigestDepth(read), "Part");
    });

    it("shows a scoped read's scope, never Full, however complete", function () {
      const sections = digestRead({
        backend: "mineru",
        complete: true,
        scope: { source: "sections" },
        covered: ["Abstract", "Results"],
      });
      assert.isFalse(sections.complete);
      assert.equal(formatTaskPaperDigestDepth(sections), "Abstract, Results");
      const abstract = digestRead({
        backend: "text",
        complete: true,
        scope: { source: "abstract" },
        covered: ["Abstract"],
      });
      assert.equal(formatTaskPaperDigestDepth(abstract), "Abstract");
      const pages = digestRead({
        backend: "pdf",
        complete: true,
        scope: { source: "pages", pages: [{ from: 3, to: 5 }] },
        covered: ["pages 3–5"],
      });
      assert.equal(formatTaskPaperDigestDepth(pages), "pages 3–5");
    });

    it("shows a scoped read saved before scope labels by its depth, and nothing for a failure or an unknown depth", function () {
      const base = {
        key: "1:1",
        callId: "c",
        toolName: "task_update",
        granularity: "digest" as const,
        snippet: "In brief.",
      };
      assert.equal(
        formatTaskPaperDigestDepth({ ...base, depth: "abstract" }),
        "Abstract",
      );
      assert.equal(
        formatTaskPaperDigestDepth({ ...base, depth: "section" }),
        "Sections",
      );
      assert.equal(formatTaskPaperDigestDepth(base), "");
      assert.equal(
        formatTaskPaperDigestDepth({
          ...base,
          snippet: undefined,
          complete: true,
        }),
        "",
      );
    });
  });

  describe("the coverage line a digest result gives the model", function () {
    const rendered = (source: Partial<HostPaperDigest["source"]>) =>
      renderHostPaperDigests(
        [
          {
            schema: 2,
            itemId: 1,
            contextItemId: 101,
            title: "Drift paper",
            answer: "A fine answer.",
            evidence: [],
            facets: [],
            gaps: [],
            source: {
              backend: "mineru",
              readCharacters: 10,
              totalCharacters: 10,
              complete: true,
              ...source,
            },
            model: "m",
            producedAt: 0,
            cacheKey: "k",
          },
        ],
        [],
        () => undefined,
      );

    it("says Full for every character of the text, also on an old record without a scope", function () {
      assert.include(rendered({}), "text: Full (every character)");
      assert.include(
        rendered({ scope: { source: "full" } }),
        "text: Full (every character)",
      );
    });

    it("says Part for an excerpt of the text", function () {
      const text = rendered({
        readCharacters: 10,
        totalCharacters: 40,
        complete: false,
      });
      assert.include(text, "text: Part (an excerpt), 10 of 40 characters");
      assert.notInclude(text, "Full");
    });

    it("names a scoped read's scope and never says Full, however complete", function () {
      const text = rendered({
        scope: { source: "sections", sections: ["abstract", "results"] },
        covered: ["Abstract", "Results"],
      });
      assert.include(text, "text: sections abstract, results only");
      assert.notInclude(text, "Full");
    });
  });

  describe("a full paper_read in Task progress", function () {
    const read = (status: string, processed: number) =>
      deriveTaskPaperLedgerDelta({
        toolName: "paper_read",
        callId: "full",
        input: { mode: "full" },
        content: {
          mode: "full",
          papers: [
            {
              paperContext: { libraryID: 1, itemId: 7, contextItemId: 8 },
              status,
              processedChunks: processed,
              totalChunks: 32,
              exactEvidence: [],
            },
          ],
        },
        libraryID: 1,
      })!.reads[0];

    it("labels a read of every chunk Full text and one that stopped short Part", function () {
      assert.equal(
        formatTaskPaperPassageLabel(read("complete", 32)),
        "Full text",
      );
      assert.equal(
        formatTaskPaperPassageLabel(read("partial", 30)),
        "Part · 30/32 chunks",
      );
    });
  });
});
