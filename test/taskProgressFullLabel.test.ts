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
import {
  buildTaskCitedModel,
  createTaskCitedBlocks,
  earlierTaskPaperReads,
  hasTaskCitedContent,
  type TaskCitedHandlers,
} from "../src/modules/contextPanel/taskProgress/outsideView";
import { canOpenTaskPaperPassage } from "../src/modules/contextPanel/taskProgress/passageSource";
import { collectFakeText, fakeDocument, FakeElement } from "./helpers/fakeDom";

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

    it("shows a pages read's range in the plugin's language", function () {
      const read = digestRead({
        backend: "pdf",
        complete: true,
        scope: { source: "pages", pages: [{ from: 3, to: 5 }] },
        covered: ["pages 3–5", "pages 7"],
      });
      assert.equal(formatTaskPaperDigestDepth(read), "pages 3–5, pages 7");
      const globals = globalThis as unknown as { Zotero?: unknown };
      const previous = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
      try {
        assert.equal(formatTaskPaperDigestDepth(read), "第 3–5 页, 第 7 页");
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

    it("says how far the read went: Full with its tally, Part with its tally", function () {
      assert.equal(
        formatTaskPaperPassageLabel(read("complete", 32)),
        "Full · 32/32 chunks",
      );
      assert.equal(
        formatTaskPaperPassageLabel(read("partial", 30)),
        "Part · 30/32 chunks",
      );
    });

    const stored = (
      patch: Partial<TaskPaperReadEvent>,
    ): TaskPaperReadEvent => ({
      key: "1:7",
      callId: "c",
      toolName: "paper_read",
      granularity: "full",
      ...patch,
    });

    it("says Full alone when the read kept no tally, and Part for a full record with a partial tally", function () {
      assert.equal(formatTaskPaperPassageLabel(stored({})), "Full");
      assert.equal(
        formatTaskPaperPassageLabel(stored({ label: "12/40 chunks" })),
        "Part · 12/40 chunks",
        "an old record: granularity full, partial count",
      );
      assert.equal(
        formatTaskPaperPassageLabel(stored({ label: "40/40 chunks" })),
        "Full · 40/40 chunks",
      );
      assert.equal(
        formatTaskPaperPassageLabel(
          stored({ granularity: "digest", label: undefined }),
        ),
        "Part",
      );
    });

    it("keeps Full text for every other tool", function () {
      assert.equal(
        formatTaskPaperPassageLabel(
          stored({ toolName: "read_attachment", label: "12/40 chunks" }),
        ),
        "Full text",
      );
      assert.equal(
        formatTaskPaperPassageLabel(stored({ toolName: "library_retrieve" })),
        "Full text",
      );
    });

    it("offers Source for a partial paper_read and not for a host digest", function () {
      assert.isTrue(
        canOpenTaskPaperPassage(
          stored({ granularity: "digest", label: "30/32 chunks" }),
        ),
      );
      assert.isFalse(
        canOpenTaskPaperPassage(
          stored({ granularity: "digest", toolName: "task_update" }),
        ),
      );
    });

    describe("the heading in a paper's Cited list", function () {
      const paper = {
        itemId: 7,
        creator: "Quill",
        year: "2021",
        title: "Drift in place cells",
      };
      const model = (reads: TaskPaperReadEvent[], answer = "") =>
        buildTaskCitedModel({ reads, answer, paper });
      const handlers = (
        opened: TaskPaperReadEvent[] = [],
      ): TaskCitedHandlers => ({
        readLabel: (item) => formatTaskPaperPassageLabel(item, paper.title),
        readText: (item) => item.snippet || "",
        onOpenPassage: () => undefined,
        onOpenRead: (item) => {
          opened.push(item);
        },
        onShowPassage: () => undefined,
        onShowNamed: () => undefined,
        foldOpen: false,
        onToggleFold: () => undefined,
      });
      const draw = (
        built: ReturnType<typeof model>,
        opened: TaskPaperReadEvent[] = [],
      ) =>
        createTaskCitedBlocks(
          fakeDocument as unknown as Document,
          built,
          handlers(opened),
        ) as unknown as FakeElement[];

      it("takes a complete paper_read out of Read, not cited and heads the list with it", function () {
        const full = stored({
          label: "122/122 chunks",
          snippet: "Opening paragraph.",
        });
        const other = stored({
          toolName: "library_retrieve",
          granularity: "passage",
          snippet: "Methods recorded 400 neurons in CA1 over many sessions.",
        });
        const built = model([full, other]);
        assert.deepEqual(built.uncited, [other]);
        assert.strictEqual(built.reach?.read, full);
        const blocks = draw(built);
        assert.equal(
          blocks[0].findByClass("llm-task-paper-how")!.textContent,
          "Full · 122/122 chunks",
        );
        assert.include(blocks[0].className, "llm-task-reach");
        assert.notInclude(
          blocks[0].className,
          "llm-task-cited-item",
          "a heading, not a cited passage",
        );
        assert.isOk(blocks[0].findByClass("llm-task-paper-open"), "Source");
        assert.notInclude(
          collectFakeText(blocks.at(-1)!),
          "Full · 122/122 chunks",
          "the fold does not repeat it",
        );
        assert.include(collectFakeText(blocks.at(-1)!), "Methods recorded");
      });

      it("heads a question whose only use of the paper was the full read", function () {
        const built = model([stored({ label: "9/9 chunks" })]);
        assert.isTrue(hasTaskCitedContent(built));
        const blocks = draw(built);
        assert.lengthOf(blocks, 1, "no Cited line, no fold");
        assert.equal(
          blocks[0].findByClass("llm-task-paper-how")!.textContent,
          "Full · 9/9 chunks",
        );
        assert.isFalse(
          hasTaskCitedContent({
            cited: [],
            named: [],
            uncited: [],
            droppedReads: 0,
          }),
        );
      });

      it("shows one heading for several reads of one paper: the whole read over a partial one", function () {
        const partial = stored({
          granularity: "digest",
          label: "30/32 chunks",
        });
        const oldPartial = stored({ label: "12/40 chunks" });
        const whole = stored({ label: "32/32 chunks" });
        const built = model([partial, oldPartial, whole]);
        assert.strictEqual(built.reach?.read, whole);
        assert.isEmpty(built.uncited, "every one left the fold");
        assert.lengthOf(draw(built), 1);
        // With no complete read, the one that got furthest.
        const furthest = model([oldPartial, partial]);
        assert.strictEqual(furthest.reach?.read, partial);
        assert.equal(
          draw(furthest)[0].findByClass("llm-task-paper-how")!.textContent,
          "Part · 30/32 chunks",
        );
      });

      it("keeps Source on a partial read, and opens the read it names", function () {
        const partial = stored({
          granularity: "digest",
          label: "30/32 chunks",
        });
        const opened: TaskPaperReadEvent[] = [];
        const [heading] = draw(model([partial]), opened);
        const source = heading.findByClass("llm-task-paper-open")!;
        source.dispatchFakeEvent("click");
        assert.deepEqual(opened, [partial]);
      });

      it("counts a partial paper_read of an earlier question as that question's read", function () {
        const partial = stored({
          granularity: "digest",
          label: "30/32 chunks",
        });
        const hostDigest = stored({
          granularity: "digest",
          toolName: "task_update",
        });
        const turn = (reads: TaskPaperReadEvent[]) => ({
          reads,
          citations: [],
        });
        const earlier = earlierTaskPaperReads(
          { turns: { 1: turn([partial]), 2: turn([]) } } as never,
          2,
        );
        assert.equal(earlier?.from, 1);
        assert.deepEqual(earlier?.reads, [partial]);
        assert.isNull(
          earlierTaskPaperReads(
            { turns: { 1: turn([hostDigest]), 2: turn([]) } } as never,
            2,
          ),
          "a host digest is not a read of the paper's text",
        );
      });

      it("leaves read_attachment and untooled reads where they were", function () {
        const attachment = stored({
          toolName: "read_attachment",
          snippet: "Attached body.",
        });
        const built = model([attachment]);
        assert.isUndefined(built.reach);
        assert.deepEqual(built.uncited, [attachment]);
        const [fold] = draw(built);
        assert.include(collectFakeText(fold), "Read, not cited (1)");
      });
    });
  });
});
