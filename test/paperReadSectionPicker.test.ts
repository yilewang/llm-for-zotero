import { assert } from "chai";
import {
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
} from "./helpers/retrievalCorpus";
import {
  getMineruItemDir,
  writeMineruCacheFiles,
} from "../src/services/mineru/mineruCache";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { deriveTaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";
import { SECTIONS_NOT_FOUND_RULE } from "../src/agent/digests/readScope";
import {
  SECTION_PICK_TASK_LINE,
  clearSectionPickCache,
} from "../src/agent/digests/sectionPicker";
import { ReaderCompletionError } from "../src/shared/readerCompletion";
import type { PdfContext } from "../src/services/paperContent/types";
import type { QuoteCitation } from "../src/shared/types";
import {
  CHINESE_DISCUSSION,
  CHINESE_MD,
  CHINESE_METHODS,
  CHINESE_RESULTS,
  COMBINED_DISCUSSION,
  COMBINED_MD,
  COMBINED_RESULTS,
  PLAIN_CHUNKS,
  PLAIN_CONTEXT,
  QUESTION,
  REVIEW_ABSTRACT,
  REVIEW_MD,
  SPREAD_A,
  SPREAD_B,
  SPREAD_MD,
  fakeReader,
  idOf,
  namesOf,
  type FakeReader,
} from "./helpers/sectionPickerFixtures";

/**
 * paper_read over named sections asks the reader which of a paper's own
 * sections hold them (sectionPicker.ts), in any language: a whole-sections
 * read reads the picked sections whole; a query read searches only the
 * chunks they hold, through the same chunk mapping as before. A failed pick
 * returns the paper's outline, never the whole paper.
 */

type Row = {
  paperContext: { itemId: number };
  status: string;
  covered: string[];
  unmatched: string[];
  paperCharacters?: number;
  readShare?: string;
  sections: Array<{ section: string; for?: string[]; characters: number }>;
  passages: Array<{
    text: string;
    sectionLabel?: string;
    chunkKind?: string;
    chunkIndex?: number;
    quoteCitationId?: string;
  }>;
  notFound?: { kind?: string; reason?: string; offers?: string };
  outline?: { sections: Array<{ sectionId: string; title?: string }> };
  chunkOutline?: Array<{ chunks: string; pages?: string; firstLine: string }>;
};
type Output = {
  read?: string;
  papers: Row[];
  quoteCitations?: QuoteCitation[];
  warnings?: string[];
  note?: string;
  readerFallback?: {
    type: string;
    chosen: { route: string; model: string };
    usedInstead: { route: string; model: string };
    reason: string;
  };
};

const REVIEW_VERDICT = {
  parts: [{ name: "results", none: true }],
  paper: {
    kind: "a review article",
    reason: "It surveys earlier studies and reports no results of its own.",
    offers: "A synthesis of drift rates reported across brain areas.",
  },
};

const PAPERS = [
  { libraryID: 1, itemId: 1, contextItemId: 101, title: "漂移" },
  { libraryID: 1, itemId: 2, contextItemId: 102, title: "Drift" },
  { libraryID: 1, itemId: 3, contextItemId: 103, title: "Spread" },
  { libraryID: 1, itemId: 4, contextItemId: 104, title: "Review" },
  { libraryID: 1, itemId: 5, contextItemId: 105, title: "Plain PDF" },
  { libraryID: 1, itemId: 6, contextItemId: 106, title: "Long PDF" },
  // A Chinese paper and a German one, neither with a Zotero abstract field.
  { libraryID: 1, itemId: 7, contextItemId: 107, title: "无摘要字段" },
  { libraryID: 1, itemId: 8, contextItemId: 108, title: "Drift auf Deutsch" },
].map((paper) => ({ ...paper, mineruCacheDir: "" }));
const GERMAN_RESULTS =
  "Die Dekodierung blieb an jedem Tag über dem Zufallsniveau.";
const GERMAN_MD = [
  "# Drift in Ortszellen",
  "",
  "## Zusammenfassung",
  "",
  "Wir untersuchen, ob Drift die Dekodierung der Position stört.",
  "",
  "## 1 Einleitung",
  "",
  "Ortszellen driften langsam.",
  "",
  "## 2 Ergebnisse",
  "",
  GERMAN_RESULTS,
].join("\n");
const TEXTS: Record<number, string> = {
  107: CHINESE_MD,
  108: GERMAN_MD,
  101: CHINESE_MD,
  102: COMBINED_MD,
  103: SPREAD_MD,
  104: REVIEW_MD,
};
const ABSTRACTS: Record<number, string> = {
  1: "本文的摘要：表征漂移不影响解码。",
  4: REVIEW_ABSTRACT,
};

/** A long plain PDF without headings or page numbers. */
const LONG_CHUNKS = Array.from(
  { length: 90 },
  (_, index) => `Invented passage ${index} about slow drift in place cells.`,
);
const LONG_CONTEXT = {
  title: "Long PDF",
  chunks: LONG_CHUNKS,
  chunkMeta: LONG_CHUNKS.map((text, chunkIndex) => ({
    chunkIndex,
    text,
    normalizedText: text,
    chunkKind: "body",
  })),
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 60,
  fullLength: LONG_CHUNKS.join("\n").length,
} as unknown as PdfContext;

const paper = (itemId: number) =>
  PAPERS.find((entry) => entry.itemId === itemId)!;

/** The section label each chunk of a cached paper carries. */
const chunkSections = (contextItemId: number, indexes: readonly number[]) =>
  indexes.map(
    (index) =>
      (pdfTextCache.get(contextItemId) as PdfContext).chunkMeta[index]
        ?.sectionLabel,
  );

/** The reads Task progress records for a picked paper_read output. */
function ledgerReads(output: Output, sections: string[]) {
  const delta = deriveTaskPaperLedgerDelta({
    toolName: "paper_read",
    callId: "call-picked",
    input: { mode: "targeted", sections },
    content: output,
    libraryID: 1,
  });
  return delta?.reads || [];
}

describe("paper_read named sections picked by the reader", function () {
  let previous: ReturnType<typeof snapshotTestGlobals>;
  let retrieveCalls: Array<{
    chunkIndexesByPaper?: Map<number, number[]>;
    papers: Array<{ itemId: number }>;
  }>;

  beforeEach(async function () {
    previous = snapshotTestGlobals();
    setupMemoryIO();
    setupZoteroGlobals();
    pdfTextCache.clear();
    clearSectionPickCache();
    retrieveCalls = [];
    for (const entry of PAPERS) {
      const text = TEXTS[entry.contextItemId];
      if (!text) continue;
      await writeMineruCacheFiles(entry.contextItemId, text, [
        { relativePath: "full.md", data: new TextEncoder().encode(text) },
      ]);
      await ensurePDFTextCached(mockPdfAttachment(entry.contextItemId));
      entry.mineruCacheDir = getMineruItemDir(entry.contextItemId);
    }
  });
  afterEach(function () {
    pdfTextCache.clear();
    clearSectionPickCache();
    restoreTestGlobals(previous);
  });

  async function read(
    reader: FakeReader,
    args: Record<string, unknown>,
    itemIds: number[],
    readerOptions: Record<string, unknown> = {
      readerFactories: reader.factories,
    },
  ): Promise<Output> {
    const targets = itemIds.map(paper);
    const service = {
      ensurePaperContext: async (ref: { contextItemId: number }) =>
        ref.contextItemId === 105
          ? PLAIN_CONTEXT
          : ref.contextItemId === 106
            ? LONG_CONTEXT
            : pdfTextCache.get(ref.contextItemId),
      getOverviewExcerpt: async () => {
        throw new Error("a named-sections read never reads the overview");
      },
    } as never;
    const tool = createPaperReadTool(
      service,
      {
        retrieveEvidence: async (params: never) => {
          retrieveCalls.push(params);
          return [];
        },
      } as never,
      {} as never,
      {
        getItem: (itemId: number) => ({
          libraryID: 1,
          key: `KEY${itemId}`,
          getField: (field: string) =>
            field === "abstractNote" ? ABSTRACTS[itemId] || "" : "",
        }),
        listPaperContexts: () => PAPERS,
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          PAPERS.find((entry) => entry.itemId === target.itemId),
      } as never,
      undefined,
      undefined,
      readerOptions as never,
    );
    const input = tool.validate({
      mode: "targeted",
      targets: targets.map((entry) => ({
        itemId: entry.itemId,
        contextItemId: entry.contextItemId,
      })),
      ...args,
    });
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, {
      request: {
        conversationKey: 1,
        mode: "agent",
        conversationKind: "paper",
        userText: QUESTION,
        libraryID: 1,
        model: "deepseek-flash",
        apiBase: "https://main.invalid",
        apiKey: "main-key",
        activeItemId: targets[0].itemId,
      },
      item: null,
      currentAnswerText: "",
      modelName: "test",
    } as never)) as Output;
  }

  const rowOf = (output: Output, itemId: number) =>
    output.papers.find((row) => row.paperContext.itemId === itemId)!;
  const ruleCount = (output: Output) =>
    (output.warnings || []).filter(
      (warning) => warning === SECTIONS_NOT_FOUND_RULE,
    ).length;

  /**
   * The user picked a Claude reader whose credential is refused (401): the
   * main model picks instead, and the result says so, as full mode does.
   */
  const refusedChosenReader = (reader: FakeReader) => ({
    readerChoice: () => ({ route: "claude_bridge", model: "opus-test" }),
    readerFactories: {
      ...reader.factories,
      claudeBridge: () => async () => {
        throw new ReaderCompletionError({
          reason: "not_configured",
          status: 401,
        });
      },
    },
  });

  describe("a pick by the main model after the chosen reader fails", function () {
    const pick = (prompt: string) => ({
      parts: [{ name: "results", sections: [idOf(prompt, "结果与讨论")] }],
    });

    it("names the fallback on a whole-sections read", async function () {
      const reader = fakeReader(pick);
      const output = await read(
        reader,
        { sections: ["results"] },
        [1],
        refusedChosenReader(reader),
      );
      assert.lengthOf(reader.pickPrompts, 1);
      assert.equal(rowOf(output, 1).status, "complete");
      assert.deepInclude(output.readerFallback!, {
        type: "reader_fallback",
        chosen: { route: "claude_bridge", model: "opus-test" },
        reason: "unauthorized",
      });
      assert.equal(output.readerFallback!.usedInstead.route, "turn_model");
    });

    it("names the fallback on a query read", async function () {
      const reader = fakeReader(pick);
      const output = await read(
        reader,
        { sections: ["results"], query: "解码准确率" },
        [1],
        refusedChosenReader(reader),
      );
      assert.lengthOf(retrieveCalls, 1);
      assert.equal(output.readerFallback?.reason, "unauthorized");
    });

    it("names no fallback when the chosen reader picks", async function () {
      const reader = fakeReader(pick);
      const output = await read(reader, { sections: ["results"] }, [1], {
        readerChoice: () => ({ route: "claude_bridge", model: "opus-test" }),
        readerFactories: reader.factories,
      });
      assert.lengthOf(reader.pickPrompts, 1);
      assert.isUndefined(output.readerFallback);
    });
  });

  describe("picks for several papers", function () {
    /**
     * A reader whose picks wait for `release`: it shows how many picks have
     * started while none has finished.
     */
    function deferredReader() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      const complete = () => async (prompt: string) => {
        if (!prompt.includes(SECTION_PICK_TASK_LINE)) return { text: "{}" };
        started.push(prompt);
        await gate;
        const line = prompt
          .split("\n")
          .find(
            (entry) =>
              /^s\d+ \|/.test(entry) &&
              /结果|Results|Population vectors/.test(entry),
          );
        return {
          text: JSON.stringify({
            parts: [{ name: "results", sections: [line!.split(" | ")[0]] }],
          }),
        };
      };
      return {
        started,
        release,
        factories: {
          turnModel: complete,
          codexResponses: complete,
          claudeBridge: complete,
        },
      };
    }
    const waitFor = async (condition: () => boolean) => {
      for (let wait = 0; wait < 100 && !condition(); wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };

    for (const [label, args] of [
      ["a whole-sections read", { sections: ["results"] }],
      ["a query read", { sections: ["results"], query: "decoder" }],
    ] as const)
      it(`starts every paper's pick before the first finishes in ${label}`, async function () {
        const deferred = deferredReader();
        const running = read(
          fakeReader(() => ({})),
          { ...args },
          [1, 2, 3],
          { readerFactories: deferred.factories },
        );
        await waitFor(() => deferred.started.length >= 3);
        assert.lengthOf(deferred.started, 3);
        deferred.release();
        const output = await running;
        assert.lengthOf(output.papers, 3);
        assert.deepEqual(
          output.papers.map((row) => row.paperContext.itemId),
          [1, 2, 3],
        );
      });
  });

  describe("whole sections (no query)", function () {
    it("reads the Zotero abstract first and the reader's 结果与讨论 whole, each passage with an id", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [{ name: "结果", sections: [idOf(prompt, "结果与讨论")] }],
      }));
      const output = await read(
        reader,
        { sections: ["abstract", "结果"] },
        [1],
      );
      assert.equal(output.read, "whole_sections");
      // The abstract keeps its rule; the picker gets the other name only,
      // with the user's question.
      assert.lengthOf(reader.pickPrompts, 1);
      assert.deepEqual(namesOf(reader.pickPrompts[0]), ["结果"]);
      assert.include(reader.pickPrompts[0], QUESTION);
      const row = rowOf(output, 1);
      assert.equal(row.status, "complete", JSON.stringify(row));
      assert.deepEqual(
        row.sections.map((entry) => entry.section),
        ["Abstract", "三、结果与讨论"],
      );
      assert.deepEqual(row.sections[1].for, ["结果"]);
      // A MinerU passage keeps the paper's own heading.
      assert.deepEqual(
        [...new Set(row.passages.slice(1).map((entry) => entry.sectionLabel))],
        ["三、结果与讨论"],
      );
      assert.include(row.covered, "三、结果与讨论 (for: 结果)");
      const text = row.passages.map((passage) => passage.text).join("\n");
      assert.include(text, ABSTRACTS[1]);
      assert.include(text, CHINESE_RESULTS);
      assert.include(text, CHINESE_DISCUSSION);
      assert.notInclude(text, CHINESE_METHODS);
      const ids = new Set(output.quoteCitations!.map((entry) => entry.id));
      for (const passage of row.passages)
        assert.isTrue(ids.has(passage.quoteCitationId!));
      // Task progress names the part the user asked for ("结果"), not the
      // paper's heading, and keeps the part's first paragraph.
      const reads = ledgerReads(output, ["abstract", "结果"]);
      assert.deepEqual(
        reads.map((entry) => [entry.label, entry.granularity]),
        [
          ["Abstract", "abstract"],
          ["结果", "section"],
        ],
      );
      assert.include(reads[1].snippet, CHINESE_RESULTS.slice(0, 10));
    });

    it("reports how much of the paper's text a picked whole read is, as a digest does", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [{ name: "结果", sections: [idOf(prompt, "结果与讨论")] }],
      }));
      const output = await read(reader, { sections: ["结果"] }, [1]);
      const row = rowOf(output, 1);
      assert.equal(row.paperCharacters, CHINESE_MD.length);
      const readChars = row.sections.reduce(
        (sum, entry) => sum + entry.characters,
        0,
      );
      assert.equal(
        row.readShare,
        `${Math.round((readChars / CHINESE_MD.length) * 100)}% of the paper's text`,
      );
    });

    it("reports no read share for an abstract read from the Zotero field alone", async function () {
      const reader = fakeReader(() => ({}));
      const output = await read(reader, { sections: ["abstract"] }, [1]);
      assert.isUndefined(rowOf(output, 1).readShare);
    });

    it("picks names in two languages for one paper in one reader call", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          { name: "results", sections: [idOf(prompt, "结果与讨论")] },
          { name: "方法", sections: [idOf(prompt, "二、方法")] },
        ],
      }));
      const output = await read(reader, { sections: ["results", "方法"] }, [1]);
      assert.lengthOf(reader.pickPrompts, 1);
      assert.deepEqual(namesOf(reader.pickPrompts[0]), ["results", "方法"]);
      const row = rowOf(output, 1);
      assert.deepEqual(
        row.sections.map((entry) => entry.section),
        ["二、方法", "三、结果与讨论"],
      );
      assert.include(
        row.passages.map((passage) => passage.text).join("\n"),
        CHINESE_METHODS,
      );
    });

    it("reads a Results and Discussion section whole for the discussion", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "discussion",
            sections: [idOf(prompt, "3 Results and Discussion")],
          },
        ],
      }));
      const output = await read(reader, { sections: ["discussion"] }, [2]);
      const text = rowOf(output, 2)
        .passages.map((passage) => passage.text)
        .join("\n");
      assert.include(text, COMBINED_RESULTS);
      assert.include(text, COMBINED_DISCUSSION);
    });

    it("reads every section the results are spread over", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "results",
            sections: [
              idOf(prompt, "3 Population vectors"),
              idOf(prompt, "4 Decoding survives"),
            ],
          },
        ],
      }));
      const output = await read(reader, { sections: ["results"] }, [3]);
      const row = rowOf(output, 3);
      assert.deepEqual(
        row.sections.map((entry) => entry.section),
        [
          "3 Population vectors drift at a fixed rate",
          "4 Decoding survives the drift",
        ],
      );
      const text = row.passages.map((passage) => passage.text).join("\n");
      assert.include(text, SPREAD_A);
      assert.include(text, SPREAD_B);
    });

    it("names a review without results per paper, with its kind and offers, and the rule once", async function () {
      const reader = fakeReader((prompt) =>
        prompt.includes("Title: Review")
          ? REVIEW_VERDICT
          : { parts: [{ name: "results", none: true }] },
      );
      const output = await read(reader, { sections: ["results"] }, [4, 2]);
      const review = rowOf(output, 4);
      assert.equal(review.status, "no_matching_sections");
      assert.deepEqual(review.unmatched, ["results"]);
      assert.deepEqual(review.notFound, REVIEW_VERDICT.paper);
      assert.lengthOf(review.passages, 0);
      const warnings = (output.warnings || []).join("\n");
      assert.include(warnings, "results (a review article");
      assert.include(warnings, REVIEW_VERDICT.paper.offers);
      assert.equal(ruleCount(output), 1);
      assert.include(output.note, "none of the named sections were found");
    });

    it("reads the chunk ranges the reader picks of a plain PDF without headings", async function () {
      const reader = fakeReader(() => ({
        parts: [{ name: "results", chunks: [{ from: 2, to: 3 }] }],
      }));
      const output = await read(reader, { sections: ["results"] }, [5]);
      assert.include(reader.pickPrompts[0], "c2 | page 3");
      const row = rowOf(output, 5);
      assert.deepEqual(
        row.passages.map((passage) => passage.chunkIndex),
        [2, 3],
      );
      assert.deepEqual(
        row.passages.map((passage) => passage.text),
        [PLAIN_CHUNKS[2], PLAIN_CHUNKS[3]],
      );
      // The section the model reads keeps where it was found; what a
      // passage and its quote popover show is the part the user asked for.
      assert.deepEqual(
        row.sections.map((entry) => entry.section),
        ["pages 3–4"],
      );
      assert.deepEqual(row.sections[0].for, ["results"]);
      assert.deepEqual(
        row.passages.map((passage) => passage.sectionLabel),
        ["Results", "Results"],
      );
      for (const citation of output.quoteCitations || [])
        assert.equal(citation.sourceSectionLabel, "Results");
      // Task progress shows the same part name, with the part's first
      // paragraph, never "pages 3–4" or "PDF text".
      const reads = ledgerReads(output, ["results"]);
      assert.deepEqual(
        reads.map((entry) => [entry.label, entry.granularity]),
        [["Results", "section"]],
      );
      assert.include(reads[0].snippet, PLAIN_CHUNKS[2]);
    });

    it("keeps a requested name that contains a comma as one name in passage labels", async function () {
      const reader = fakeReader(() => ({
        parts: [{ name: "methods, results", chunks: [{ from: 2, to: 3 }] }],
      }));
      const output = await read(
        reader,
        { sections: ["methods, results"] },
        [5],
      );
      const row = rowOf(output, 5);
      assert.deepEqual(
        [...new Set(row.passages.map((passage) => passage.sectionLabel))],
        ["Methods, results"],
      );
      assert.deepEqual(row.sections[0].for, ["methods, results"]);
      assert.deepEqual(
        ledgerReads(output, ["methods, results"]).map((entry) => entry.label),
        ["Methods, results"],
      );
    });

    it("serves the Zotero abstract field for 摘要 when the reader judges it the abstract", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "摘要",
            kind: "abstract",
            sections: [idOf(prompt, "## 摘要")],
          },
        ],
      }));
      const output = await read(reader, { sections: ["摘要"] }, [1]);
      assert.lengthOf(reader.pickPrompts, 1);
      const row = rowOf(output, 1);
      assert.equal(row.status, "complete", JSON.stringify(row));
      assert.deepEqual(
        row.sections.map((entry) => [entry.section, entry.for]),
        [["Abstract", ["摘要"]]],
      );
      assert.deepEqual(row.covered, ["Abstract"]);
      const text = row.passages.map((passage) => passage.text).join("\n");
      assert.include(text, ABSTRACTS[1]);
      assert.notInclude(text, "本文研究表征漂移是否影响位置解码");
      assert.deepEqual(
        [...new Set(row.passages.map((passage) => passage.chunkKind))],
        ["abstract"],
      );
    });

    it("reads the paper's own abstract section for Zusammenfassung when the record has none", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "Zusammenfassung",
            kind: "abstract",
            sections: [idOf(prompt, "## Abstract")],
          },
        ],
      }));
      const output = await read(reader, { sections: ["Zusammenfassung"] }, [2]);
      const row = rowOf(output, 2);
      assert.deepEqual(
        row.sections.map((entry) => entry.section),
        ["Abstract"],
      );
      assert.deepEqual(row.covered, ["Abstract"]);
      assert.include(
        row.passages.map((passage) => passage.text).join("\n"),
        "We ask whether representational drift impairs decoding of position.",
      );
      assert.equal(row.passages[0].chunkKind, "abstract");
    });

    it("sends an English abstract on a Chinese paper with no Zotero field and no classified abstract section to the pick with the other names", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "abstract",
            kind: "abstract",
            sections: [idOf(prompt, "## 摘要")],
          },
          { name: "results", sections: [idOf(prompt, "结果与讨论")] },
        ],
      }));
      const output = await read(
        reader,
        { sections: ["abstract", "results"] },
        [7],
      );
      assert.lengthOf(reader.pickPrompts, 1);
      assert.deepEqual(namesOf(reader.pickPrompts[0]), ["abstract", "results"]);
      const row = rowOf(output, 7);
      assert.equal(row.status, "complete", JSON.stringify(row));
      assert.deepEqual(row.unmatched, []);
      assert.notInclude((output.warnings || []).join("\n"), "Not found");
      const text = row.passages.map((passage) => passage.text).join("\n");
      assert.include(text, "本文研究表征漂移是否影响位置解码");
      assert.include(text, CHINESE_RESULTS);
    });

    it("sends an English abstract on a German paper to the pick", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "abstract",
            kind: "abstract",
            sections: [idOf(prompt, "Zusammenfassung")],
          },
        ],
      }));
      const output = await read(reader, { sections: ["abstract"] }, [8]);
      assert.lengthOf(reader.pickPrompts, 1);
      const row = rowOf(output, 8);
      assert.equal(row.status, "complete", JSON.stringify(row));
      assert.include(
        row.passages.map((passage) => passage.text).join("\n"),
        "Wir untersuchen, ob Drift die Dekodierung",
      );
    });

    it("sends a combined name that starts with Abstract to the pick and reads what it picks", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "Abstract and results",
            sections: [
              idOf(prompt, "## Abstract"),
              idOf(prompt, "3 Results and Discussion"),
            ],
          },
        ],
      }));
      const output = await read(
        reader,
        { sections: ["Abstract and results"] },
        [2],
      );
      assert.lengthOf(reader.pickPrompts, 1);
      assert.deepEqual(namesOf(reader.pickPrompts[0]), [
        "Abstract and results",
      ]);
      const row = rowOf(output, 2);
      const text = row.passages.map((passage) => passage.text).join("\n");
      assert.include(text, "We ask whether representational drift");
      assert.include(text, COMBINED_RESULTS);
    });

    it("keeps the abstract fast path, with no pick, for the exact name abstract when the Zotero field exists", async function () {
      const reader = fakeReader(() => {
        throw new Error("no pick for an abstract the record holds");
      });
      const output = await read(reader, { sections: ["abstract"] }, [1]);
      assert.lengthOf(reader.pickPrompts, 0);
      const row = rowOf(output, 1);
      assert.deepEqual(row.covered, ["Abstract"]);
      assert.include(
        row.passages.map((passage) => passage.text).join("\n"),
        ABSTRACTS[1],
      );
    });

    it("keeps the abstract fast path, with no pick, for the exact name abstract when a classified abstract section exists", async function () {
      const reader = fakeReader(() => {
        throw new Error("no pick for a classified abstract section");
      });
      const output = await read(reader, { sections: ["Abstracts"] }, [2]);
      assert.lengthOf(reader.pickPrompts, 0);
      assert.deepEqual(rowOf(output, 2).covered, ["Abstract"]);
    });

    it("returns the paper's outline when the reader cannot pick, and reads nothing of it", async function () {
      const reader = fakeReader(() => {
        throw new ReaderCompletionError({ reason: "not_configured" });
      });
      const output = await read(reader, { sections: ["results"] }, [2]);
      const row = rowOf(output, 2);
      assert.equal(row.status, "sections_not_chosen");
      assert.lengthOf(row.passages, 0);
      assert.isAbove(row.outline?.sections.length || 0, 2);
      assert.include(
        row.outline!.sections.map((section) => section.sectionId),
        "s4",
      );
      assert.match(
        (output.warnings || []).join("\n"),
        /could not choose the named sections.*sectionIds/,
      );
      assert.equal(ruleCount(output), 0);
    });

    it("returns a plain PDF's chunk outline with its pages when the reader cannot pick", async function () {
      const reader = fakeReader(() => {
        throw new ReaderCompletionError({ reason: "not_configured" });
      });
      const output = await read(reader, { sections: ["results"] }, [5]);
      const row = rowOf(output, 5);
      assert.equal(row.status, "sections_not_chosen");
      assert.lengthOf(row.passages, 0);
      // Pages as paper_read's pages input counts them, from 1.
      assert.deepEqual(row.chunkOutline, [
        { chunks: "0", pages: "1", firstLine: PLAIN_CHUNKS[0] },
        { chunks: "1", pages: "2", firstLine: PLAIN_CHUNKS[1] },
        { chunks: "2", pages: "3", firstLine: PLAIN_CHUNKS[2] },
        { chunks: "3", pages: "4", firstLine: PLAIN_CHUNKS[3] },
        { chunks: "4", pages: "5", firstLine: PLAIN_CHUNKS[4] },
      ]);
      const warnings = (output.warnings || []).join("\n");
      assert.include(warnings, "could not choose the named sections");
      assert.include(warnings, "pages");
      assert.notInclude(warnings, "sectionIds");
    });

    it("groups a long plain PDF's chunk outline and, without page numbers, points to a query or a full read", async function () {
      const reader = fakeReader(() => {
        throw new ReaderCompletionError({ reason: "not_configured" });
      });
      const output = await read(reader, { sections: ["results"] }, [6]);
      const row = rowOf(output, 6);
      assert.equal(row.status, "sections_not_chosen");
      const outline = row.chunkOutline || [];
      assert.isAtLeast(outline.length, 2);
      assert.isAtMost(outline.length, 40);
      assert.equal(outline[0].chunks, "0-2");
      assert.equal(outline[outline.length - 1].chunks.split("-").pop(), "89");
      assert.isUndefined(outline[0].pages);
      assert.equal(outline[0].firstLine, LONG_CHUNKS[0]);
      const warnings = (output.warnings || []).join("\n");
      assert.include(warnings, "query");
      assert.include(warnings, "mode:'full'");
      assert.notInclude(warnings, "sectionIds");
    });
  });

  describe("a query over named sections", function () {
    it("searches only the chunks of the section the reader picks for an English name in a Chinese paper", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [{ name: "results", sections: [idOf(prompt, "结果与讨论")] }],
      }));
      const output = await read(
        reader,
        { sections: ["results"], query: "解码准确率" },
        [1],
      );
      assert.notEqual(output.read, "whole_sections");
      assert.lengthOf(reader.pickPrompts, 1);
      assert.lengthOf(retrieveCalls, 1);
      const indexes = retrieveCalls[0].chunkIndexesByPaper?.get(101) || [];
      assert.isNotEmpty(indexes);
      assert.deepEqual(
        [...new Set(chunkSections(101, indexes))],
        ["三、结果与讨论"],
      );
    });

    it("searches the chunks of every section the results are spread over", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "results",
            sections: [
              idOf(prompt, "3 Population vectors"),
              idOf(prompt, "4 Decoding survives"),
            ],
          },
        ],
      }));
      await read(reader, { sections: ["results"], query: "decoder" }, [3]);
      assert.lengthOf(reader.pickPrompts, 1);
      const indexes = retrieveCalls[0].chunkIndexesByPaper?.get(103) || [];
      assert.deepEqual([...new Set(chunkSections(103, indexes))].sort(), [
        "3 Population vectors drift at a fixed rate",
        "4 Decoding survives the drift",
      ]);
    });

    it("searches a plain PDF's picked chunk range", async function () {
      const reader = fakeReader(() => ({
        parts: [{ name: "results", chunks: [{ from: 2, to: 3 }] }],
      }));
      await read(reader, { sections: ["results"], query: "decoder" }, [5]);
      assert.deepEqual(retrieveCalls[0].chunkIndexesByPaper?.get(105), [2, 3]);
    });

    it("does not search a review without results, and names its reason once", async function () {
      const reader = fakeReader(() => REVIEW_VERDICT);
      const output = await read(
        reader,
        { sections: ["results"], query: "drift rate" },
        [4],
      );
      assert.lengthOf(retrieveCalls, 0);
      assert.equal(rowOf(output, 4).status, "no_matching_sections");
      const warnings = (output.warnings || []).join("\n");
      assert.include(warnings, "results (a review article");
      assert.include(warnings, REVIEW_VERDICT.paper.reason);
      assert.equal(ruleCount(output), 1);
    });

    it("searches the picked chunks of an English abstract on a Chinese paper with no Zotero field", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "abstract",
            kind: "abstract",
            sections: [idOf(prompt, "## 摘要")],
          },
          { name: "results", sections: [idOf(prompt, "结果与讨论")] },
        ],
      }));
      const output = await read(
        reader,
        { sections: ["abstract", "results"], query: "解码准确率" },
        [7],
      );
      assert.lengthOf(reader.pickPrompts, 1);
      assert.deepEqual(namesOf(reader.pickPrompts[0]), ["abstract", "results"]);
      assert.notInclude((output.warnings || []).join("\n"), "Not found");
      const indexes = retrieveCalls[0].chunkIndexesByPaper?.get(107) || [];
      assert.includeMembers(
        [...new Set(chunkSections(107, indexes))],
        ["摘要", "三、结果与讨论"],
      );
    });

    it("sends a combined name that starts with Abstract to the pick in a query read", async function () {
      const reader = fakeReader((prompt) => ({
        parts: [
          {
            name: "Abstract and results",
            sections: [
              idOf(prompt, "## Abstract"),
              idOf(prompt, "3 Results and Discussion"),
            ],
          },
        ],
      }));
      await read(
        reader,
        { sections: ["Abstract and results"], query: "decoding" },
        [2],
      );
      assert.lengthOf(reader.pickPrompts, 1);
      const indexes = retrieveCalls[0].chunkIndexesByPaper?.get(102) || [];
      assert.includeMembers(
        [...new Set(chunkSections(102, indexes))],
        ["Abstract", "3 Results and Discussion"],
      );
    });

    it("points to the Zotero record for an abstract by another name that the paper's text lacks", async function () {
      const reader = fakeReader(() => ({
        parts: [{ name: "要旨", kind: "abstract", none: true }],
      }));
      const output = await read(
        reader,
        { sections: ["要旨"], query: "drift" },
        [4],
      );
      const warnings = (output.warnings || []).join("\n");
      assert.include(warnings, "The abstract of");
      assert.include(warnings, "is only in the Zotero record");
      assert.notInclude(warnings, "Not found in");
      assert.equal(ruleCount(output), 0);
    });

    it("does not search a paper the reader cannot pick for, and returns its outline", async function () {
      const reader = fakeReader(() => {
        throw new ReaderCompletionError({ reason: "not_configured" });
      });
      const output = await read(
        reader,
        { sections: ["results"], query: "decoding" },
        [2],
      );
      assert.lengthOf(retrieveCalls, 0);
      const row = rowOf(output, 2);
      assert.equal(row.status, "sections_not_chosen");
      assert.isAbove(row.outline?.sections.length || 0, 2);
      assert.match(
        (output.warnings || []).join("\n"),
        /could not choose the named sections.*sectionIds/,
      );
    });

    it("returns a plain PDF's chunk outline when the reader cannot pick, and does not search it", async function () {
      const reader = fakeReader(() => {
        throw new ReaderCompletionError({ reason: "not_configured" });
      });
      const output = await read(
        reader,
        { sections: ["results"], query: "decoder" },
        [5],
      );
      assert.lengthOf(retrieveCalls, 0);
      const row = rowOf(output, 5);
      assert.equal(row.status, "sections_not_chosen");
      assert.deepInclude(row.chunkOutline?.[2], { chunks: "2", pages: "3" });
      assert.include((output.warnings || []).join("\n"), "pages");
    });
  });
});
