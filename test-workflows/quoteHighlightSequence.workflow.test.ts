/**
 * Highlighting a quote in a reader that has already searched: the shared
 * paragraph jump every path uses (answer citations, Task progress, selected
 * text) against Zotero's real PDF.js.
 *
 * PDF.js empties and refills the same result list for each new search, so a
 * finished search can look exactly like the one before it (two quotes on one
 * page with one match each). And the reader page cannot read a request object
 * made in the plugin's code, so a later copy of a repeated quote is selected
 * through the find bar's own request. Each case reads PDF.js's own state
 * after the jump: its query, its match count and its selected match.
 */
import { assert } from "chai";
import {
  scrollToExactQuoteInReader,
  scrollToSelectedTextInReader,
} from "../src/services/pdf/livePdfSelectionLocator";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const C = "Representational drift has been reported in many brain areas.";
const A =
  "Turnover of dendritic spines predicts the rate at which place fields reorganize over two weeks.";
const B = "These changes were stable across sessions in every recorded animal.";
const D = "Alpha beta gamma delta epsilon zeta eta.";
const E = "Theta iota kappa lambda mu nu xi.";
/** Page indexes: C on the first page, A and B on the second, D and E twice on the third. */
const PAGE_C = 0;
const PAGE_AB = 1;
const PAGE_DE = 2;
/** Far below the 10 s a search that looked unfinished used to wait. */
const PROMPT_MS = 5000;

describe("workflow: quote highlight sequence", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture;

  function viewerApp(reader: any): any {
    const frame = reader?._internalReader?._primaryView?._iframeWindow;
    return (frame?.wrappedJSObject || frame)?.PDFViewerApplication;
  }

  function readerOf(itemId: number): any {
    return ((Zotero as any).Reader._readers || []).find(
      (reader: any) => reader.itemID === itemId,
    );
  }

  async function closeReaders() {
    for (const reader of [...((Zotero as any).Reader._readers || [])]) {
      if (reader.itemID === fixture?.pdfAttachmentId) await reader.close?.();
    }
    await Zotero.Promise.delay(200);
  }

  /** A reader opened fresh on the fixture, its PDF.js loaded. */
  async function freshReader(): Promise<any> {
    await closeReaders();
    await (Zotero as any).Reader.open(fixture.pdfAttachmentId);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const app = viewerApp(readerOf(fixture.pdfAttachmentId));
      if (app?.pdfViewer?.pagesCount > 0 && app.findController) break;
      await Zotero.Promise.delay(50);
    }
    const reader = readerOf(fixture.pdfAttachmentId);
    assert.isOk(viewerApp(reader)?.findController, "PDF.js is loaded");
    return reader;
  }

  /** PDF.js's own find state. */
  function native(reader: any) {
    const findController = viewerApp(reader).findController;
    return {
      query: String(findController.state?.query ?? ""),
      total: Number(findController._matchesCountTotal),
      page: Number(findController._selected?.pageIdx),
      match: Number(findController._selected?.matchIdx),
    };
  }

  async function jump(
    reader: any,
    text: string,
    pageIndex: number,
    occurrence?: number,
  ) {
    const startedAt = Date.now();
    const result = await scrollToExactQuoteInReader(reader, text, {
      expectedPageIndex: pageIndex,
      ...(occurrence !== undefined
        ? { sourceMatchPageOccurrence: occurrence }
        : {}),
    });
    return { result, ms: Date.now() - startedAt };
  }

  function assertHighlighted(
    outcome: { result: any; ms: number },
    reader: any,
    expected: { query: string; total: number; page: number; match: number },
    label: string,
  ) {
    assert.equal(
      outcome.result.navigationStatus,
      "paragraph-selected",
      `${label}: ${JSON.stringify(outcome.result)}`,
    );
    assert.isBelow(outcome.ms, PROMPT_MS, `${label}: no wait for a change`);
    assert.deepEqual(native(reader), expected, `${label}: PDF.js state`);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Quote highlight sequence",
      pdfTitle: "Quote highlight sequence",
      pages: [
        `Introduction. ${C} Other text follows here.`,
        `Results. ${A} ${B}`,
        `Repeats. ${D} ${E} Filler words here. ${D} ${E}`,
      ],
    });
  });

  after(async function () {
    await closeReaders();
    if (fixture) await api.cleanupFixture(fixture);
  });

  it("highlights a second quote with one match on the same page, and again", async function () {
    const reader = await freshReader();
    assertHighlighted(
      await jump(reader, A, PAGE_AB),
      reader,
      { query: A, total: 1, page: PAGE_AB, match: 0 },
      "A",
    );
    assertHighlighted(
      await jump(reader, B, PAGE_AB),
      reader,
      { query: B, total: 1, page: PAGE_AB, match: 0 },
      "B after A",
    );
    assertHighlighted(
      await jump(reader, A, PAGE_AB),
      reader,
      { query: A, total: 1, page: PAGE_AB, match: 0 },
      "A after B",
    );
    assertHighlighted(
      await jump(reader, C, PAGE_C),
      reader,
      { query: C, total: 1, page: PAGE_C, match: 0 },
      "C on another page",
    );
  });

  it("highlights a quote after the user's own search on its page", async function () {
    const reader = await freshReader();
    const app = viewerApp(reader);
    app.findBar.open();
    const field = app.findBar._findField ?? app.findBar.findField;
    field.value = "dendritic spines";
    const view: any = field.ownerDocument.defaultView;
    field.dispatchEvent(
      new (view.InputEvent ?? view.Event)("input", { bubbles: true }),
    );
    const deadline = Date.now() + 5000;
    while (native(reader).total !== 1 && Date.now() < deadline) {
      await Zotero.Promise.delay(40);
    }
    assert.deepEqual(native(reader), {
      query: "dendritic spines",
      total: 1,
      page: PAGE_AB,
      match: 0,
    });

    assertHighlighted(
      await jump(reader, A, PAGE_AB),
      reader,
      { query: A, total: 1, page: PAGE_AB, match: 0 },
      "A after the user's search",
    );
  });

  it("selects the later copy of a repeated quote", async function () {
    const reader = await freshReader();
    assertHighlighted(
      await jump(reader, D, PAGE_DE, 1),
      reader,
      { query: D, total: 2, page: PAGE_DE, match: 1 },
      "D, second copy",
    );
    assertHighlighted(
      await jump(reader, E, PAGE_DE, 1),
      reader,
      { query: E, total: 2, page: PAGE_DE, match: 1 },
      "E, second copy, after D",
    );
    assertHighlighted(
      await jump(reader, D, PAGE_DE, 0),
      reader,
      { query: D, total: 2, page: PAGE_DE, match: 0 },
      "D, first copy, after E",
    );
  });

  it("highlights selected text and quotes on one page in any order", async function () {
    const reader = await freshReader();
    const selected = async (text: string) => {
      const startedAt = Date.now();
      const result = await scrollToSelectedTextInReader(reader, text, {
        expectedPageIndex: PAGE_AB,
      });
      return { result, ms: Date.now() - startedAt };
    };
    assertHighlighted(
      await selected(A),
      reader,
      { query: A, total: 1, page: PAGE_AB, match: 0 },
      "selected A",
    );
    assertHighlighted(
      await selected(B),
      reader,
      { query: B, total: 1, page: PAGE_AB, match: 0 },
      "selected B after selected A",
    );
    assertHighlighted(
      await jump(reader, A, PAGE_AB),
      reader,
      { query: A, total: 1, page: PAGE_AB, match: 0 },
      "quote A after selected B",
    );
  });
});
