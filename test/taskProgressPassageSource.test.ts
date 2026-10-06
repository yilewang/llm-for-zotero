import { assert } from "chai";
import type { TaskPaperReadEvent } from "../src/agent/context/taskPaperLedger";
import { navigateToTaskPaperPassage } from "../src/modules/contextPanel/assistantCitationLinks";
import { locateQuoteInPageTexts } from "../src/services/pdf/livePdfSelectionLocator";
import { cleanTaskPaperSnippet } from "../src/modules/contextPanel/taskProgress/view";
import {
  buildTaskPaperPassageSearchTexts,
  canOpenTaskPaperPassage,
  taskPaperPassagePageLabel,
  type TaskPaperPassageTarget,
} from "../src/modules/contextPanel/taskProgress/passageSource";

function read(patch: Partial<TaskPaperReadEvent>): TaskPaperReadEvent {
  return {
    key: "1:1",
    callId: "c",
    toolName: "library_retrieve",
    granularity: "passage",
    ...patch,
  };
}

describe("task progress passage source", function () {
  it("names the printed page a label gives, and nothing else", function () {
    assert.equal(taskPaperPassagePageLabel("p. 4"), "4");
    assert.equal(taskPaperPassagePageLabel("p. 4, p. 5"), "4");
    assert.equal(taskPaperPassagePageLabel("pp. 12–13"), "12");
    assert.equal(taskPaperPassagePageLabel("P.iv"), "iv");
    assert.equal(taskPaperPassagePageLabel("Methods §2.3"), "");
    assert.equal(taskPaperPassagePageLabel("Appendix p. 4"), "");
    assert.equal(taskPaperPassagePageLabel(undefined), "");
  });

  it("offers a read with text, or a page read that names its page", function () {
    assert.isTrue(canOpenTaskPaperPassage(read({ snippet: "Some text." })));
    assert.isTrue(
      canOpenTaskPaperPassage(read({ granularity: "page", label: "p. 3" })),
    );
    assert.isFalse(canOpenTaskPaperPassage(read({ snippet: "   " })));
    assert.isFalse(canOpenTaskPaperPassage(read({ label: "p. 3" })));
    assert.isFalse(
      canOpenTaskPaperPassage(read({ granularity: "page", label: "Figures" })),
    );
    assert.isFalse(canOpenTaskPaperPassage(read({ granularity: "outline" })));
    assert.isTrue(
      canOpenTaskPaperPassage(read({ granularity: "full" })),
      "a whole-paper read opens the paper, with or without a snippet",
    );
  });

  it("never offers a digest's summary, which is not the paper's text; its evidence opens", function () {
    assert.isFalse(
      canOpenTaskPaperPassage(
        read({ granularity: "digest", method: "digest", snippet: "In brief." }),
      ),
    );
    assert.isTrue(
      canOpenTaskPaperPassage(
        read({ method: "digest", label: "Methods", snippet: "We recorded." }),
      ),
    );
  });

  it("looks for the shown text first, without a clipped ellipsis or cut word", function () {
    assert.deepEqual(
      buildTaskPaperPassageSearchTexts(
        "Place fields reorganize over two weeks of recor…",
        "## Results\nPlace fields reorganize over two weeks of recor…",
      ),
      [
        "Place fields reorganize over two weeks of",
        "Place fields reorganize over two weeks of recor",
        "## Results Place fields reorganize over two weeks of",
        "## Results Place fields reorganize over two weeks of recor",
      ],
    );
    assert.deepEqual(
      buildTaskPaperPassageSearchTexts("…ding spines turn over quickly.", ""),
      ["spines turn over quickly.", "ding spines turn over quickly."],
    );
  });

  it("dedupes, and keeps an unclipped text whole", function () {
    assert.deepEqual(
      buildTaskPaperPassageSearchTexts(
        "Drift scaled with experience.",
        "Drift  scaled\nwith experience.",
      ),
      ["Drift scaled with experience."],
    );
    assert.deepEqual(buildTaskPaperPassageSearchTexts("", "  "), []);
    // Too little left without the cut word: keep the clipped form only.
    assert.deepEqual(buildTaskPaperPassageSearchTexts("Drift sca…", ""), [
      "Drift sca",
    ]);
  });

  it("finds a clipped snippet's first search text in the page text", function () {
    const sentence =
      "Turnover of dendritic spines predicts the rate at which place fields reorganize over two weeks.";
    const pages = [
      { pageIndex: 0, pageLabel: "1", text: "Introduction. Background." },
      { pageIndex: 1, pageLabel: "2", text: `Results. ${sentence} More.` },
    ];
    const clipped = `${sentence.slice(0, 70)}…`;
    const [first] = buildTaskPaperPassageSearchTexts(clipped, clipped);
    const located = locateQuoteInPageTexts(pages, first);
    assert.equal(located.status, "resolved");
    assert.equal(located.computedPageIndex, 1);
  });

  it("adds the shown text's longest sentences after the whole passage", function () {
    const texts = buildTaskPaperPassageSearchTexts(
      "Short one. Spines turned over within days in every imaged animal. Place fields reorganized over two full weeks of recording.",
      "",
    );
    assert.deepEqual(texts, [
      "Short one. Spines turned over within days in every imaged animal. Place fields reorganized over two full weeks of recording.",
      "Place fields reorganized over two full weeks of recording.",
      "Spines turned over within days in every imaged animal.",
    ]);
  });

  it("resolves a MinerU-style snippet (heading, inline TeX, clipped) through the partial-span path", function () {
    const pages = [
      {
        pageIndex: 0,
        pageLabel: "1",
        text: "Introduction. Representational drift has been reported in many areas.",
      },
      {
        pageIndex: 1,
        pageLabel: "2",
        text: "Results. The drift rate Δr = αt grew linearly with experience across ten sessions of recording in the same animals, and readout stayed stable.",
      },
    ];
    const raw =
      "## Results\nThe drift rate $\\Delta r = \\alpha t$ grew linearly with experience across ten sessions of recording in the sa…";
    const texts = buildTaskPaperPassageSearchTexts(
      cleanTaskPaperSnippet(raw),
      raw,
    );
    assert.equal(
      texts[0],
      "Results The drift rate grew linearly with experience across ten sessions of recording in the",
      "the shown text: no heading marks, no TeX, no clipped word",
    );
    const located = locateQuoteInPageTexts(pages, texts[0]);
    assert.equal(located.status, "resolved", located.reason);
    assert.equal(located.computedPageIndex, 1);
    assert.notEqual(
      located.sourceMatchKind,
      "exact",
      "found by the locator's partial span, not an exact match",
    );
  });

  describe("navigateToTaskPaperPassage", function () {
    const scope = globalThis as typeof globalThis & { Zotero?: any };
    const original = scope.Zotero;
    afterEach(function () {
      if (original === undefined) delete scope.Zotero;
      else scope.Zotero = original;
    });

    function panel() {
      const status = { textContent: "", className: "" };
      const body = {
        querySelector: (selector: string) =>
          selector === "#llm-status" ? status : null,
      } as unknown as Element;
      return { body, status };
    }

    function target(
      patch: Partial<TaskPaperPassageTarget> = {},
    ): TaskPaperPassageTarget {
      return {
        itemId: 7,
        libraryID: 1,
        rawSnippet: "Some passage text read from the paper.",
        cleanedSnippet: "Some passage text read from the paper.",
        label: "Results",
        granularity: "passage",
        ...patch,
      };
    }

    it("says the paper has no PDF, and frees the button", async function () {
      scope.Zotero = {
        Items: {
          get: (id: number) =>
            id === 7
              ? {
                  id: 7,
                  isRegularItem: () => true,
                  isAttachment: () => false,
                  getAttachments: () => [8],
                }
              : id === 8
                ? {
                    id: 8,
                    isAttachment: () => true,
                    attachmentContentType: "text/html",
                  }
                : null,
        },
      };
      const { body, status } = panel();
      const button = { dataset: {} as Record<string, string>, disabled: false };
      const outcome = await navigateToTaskPaperPassage({
        body,
        target: target(),
        button: button as unknown as HTMLButtonElement,
      });
      assert.equal(outcome, "no-pdf");
      assert.equal(status.textContent, "No PDF for this paper");
      assert.equal(status.className, "llm-status llm-status-error");
      assert.isFalse(button.disabled);
      assert.equal(button.dataset.loading, "false");
    });

    it("opens the paper for a full-text read, without searching for its snippet", async function () {
      const opened: Array<{ itemId: number; location: unknown }> = [];
      let searched = 0;
      let focused = 0;
      const reader = { itemID: 8 };
      scope.Zotero = {
        Items: {
          get: (id: number) =>
            id === 7
              ? {
                  id: 7,
                  isRegularItem: () => true,
                  isAttachment: () => false,
                  getAttachments: () => [8],
                }
              : id === 8
                ? {
                    id: 8,
                    isAttachment: () => true,
                    attachmentContentType: "application/pdf",
                    // Any text search reads the attachment's text.
                    get attachmentText() {
                      searched += 1;
                      return Promise.resolve("");
                    },
                  }
                : null,
        },
        Reader: {
          open: async (itemId: number, location: unknown) => {
            opened.push({ itemId, location });
            return reader;
          },
        },
        getMainWindow: () => ({
          focus: () => {
            focused += 1;
          },
        }),
      };
      const { body, status } = panel();
      const shown: string[] = [];
      let text = "";
      Object.defineProperty(status, "textContent", {
        get: () => text,
        set: (value: string) => {
          text = value;
          shown.push(value);
        },
      });
      const button = { dataset: {} as Record<string, string>, disabled: false };
      const outcome = await navigateToTaskPaperPassage({
        body,
        target: target({
          granularity: "full",
          label: "",
          rawSnippet: "Representational drift was measured in 124 mice.",
          cleanedSnippet: "Representational drift was measured in 124 mice.",
        }),
        button: button as unknown as HTMLButtonElement,
      });
      assert.equal(outcome, "page");
      assert.lengthOf(opened, 1);
      assert.equal(opened[0].itemId, 8);
      assert.deepInclude(
        opened[0].location as object,
        { pageIndex: 0 },
        "the paper opens at its first page",
      );
      assert.equal(focused, 1);
      assert.equal(searched, 0, "no text search was attempted");
      assert.deepEqual(shown, ["Opened the paper"], "never 'Locating…'");
      assert.equal(status.textContent, "Opened the paper");
      assert.isFalse(button.disabled);
    });

    it("ignores a click while the button is already opening", async function () {
      let looked = 0;
      scope.Zotero = {
        Items: {
          get: () => {
            looked += 1;
            return null;
          },
        },
      };
      const { body, status } = panel();
      const button = {
        dataset: { loading: "true" } as Record<string, string>,
        disabled: true,
      };
      const outcome = await navigateToTaskPaperPassage({
        body,
        target: target(),
        button: button as unknown as HTMLButtonElement,
      });
      assert.equal(outcome, "busy");
      assert.equal(looked, 0);
      assert.equal(status.textContent, "");
      assert.isTrue(button.disabled, "the first click still owns the button");
    });
  });
});
