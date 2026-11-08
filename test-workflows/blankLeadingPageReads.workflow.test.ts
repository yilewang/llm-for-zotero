/**
 * A PDF whose first pages are blank is read by page in real Zotero, against a
 * PDF that pdf-lib generates and Zotero's own PDF worker extracts (no model,
 * no network):
 * - Zotero's text drops the blank leading pages, and the paper's load proves
 *   the shift from the bookmarks (`textPageOffset.pageOffset`);
 * - a page read puts each body page's own text on that PDF page, never a
 *   neighbour's;
 * - without bookmarks the shift cannot be proven, and the page read refuses
 *   rather than place text on the wrong page.
 */
import { assert } from "chai";
import { createPdfWithOutline } from "../test/helpers/outlinePdfFixture";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { PdfService } from "../src/agent/services/pdfService";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { paperTextStore } from "../src/services/paperContent/paperTextStore";
import { clearPageTextCache } from "../src/services/pdf/livePdfSelectionLocator";
import type { PaperContextRef } from "../src/shared/types";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

const BLANK_LEADING = 2;
const BODY_PAGES = 6;
const TOTAL_PAGES = BLANK_LEADING + BODY_PAGES;

/** The marker that only 1-based PDF page `page` carries. */
const marker = (page: number) => `Body page ${page} marker`;

/** Two blank pages, then body pages that open with their own heading. */
const PAGES: string[][] = [
  [],
  [],
  ...Array.from({ length: BODY_PAGES }, (_, index) => {
    const page = BLANK_LEADING + index + 1;
    return [
      `Heading ${page} opens here`,
      marker(page),
      `Filler sentence for page ${page}: the reading continues on this page.`,
    ];
  }),
];

type Fixture = { paper: PaperContextRef; parentItemId: number; path: string };

describe("workflow: page reads on a PDF with blank leading pages", function () {
  this.timeout(120000);
  const fixtures: Fixture[] = [];

  async function importPdf(title: string, bytes: Uint8Array): Promise<Fixture> {
    const parent = new Zotero.Item("book");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", title);
    const parentItemId = Number(await parent.saveTx());
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `blank-leading-${Date.now()}-${fixtures.length}.pdf`,
    );
    await IOUtils.write(path, bytes);
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parentItemId,
      contentType: "application/pdf",
    });
    const fixture: Fixture = {
      paper: {
        libraryID: parent.libraryID,
        itemId: parentItemId,
        contextItemId: attachment.id,
        title,
      },
      parentItemId,
      path,
    };
    fixtures.push(fixture);
    return fixture;
  }

  after(async function () {
    for (const fixture of fixtures) {
      const parent = Zotero.Items.get(fixture.parentItemId);
      if (parent) await parent.eraseTx();
      await IOUtils.remove(fixture.path, { ignoreAbsent: true });
    }
  });

  function pageService() {
    return new PdfPageService(new PdfService(), new ZoteroGateway());
  }

  function request(fixture: Fixture) {
    return resolvedAgentRequest({
      conversationKey: 0,
      mode: "agent",
      userText: "Read a page",
      libraryID: fixture.paper.libraryID,
      model: "gpt-workflow",
    });
  }

  it("places body text on its own PDF pages when bookmarks prove the shift", async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    const fixture = await importPdf(
      `Blank leading pages ${Date.now()}`,
      await createPdfWithOutline({
        pages: PAGES,
        outline: Array.from({ length: BODY_PAGES }, (_, index) => ({
          title: `Heading ${BLANK_LEADING + index + 1} opens here`,
          page: BLANK_LEADING + index,
        })),
      }),
    );
    assert.isFalse(paperTextStore.has(fixture.paper.contextItemId!));

    // Zotero's own extraction: the blank leading pages are gone.
    const extracted = await Zotero.PDFWorker.getFullText(
      fixture.paper.contextItemId,
    );
    console.log(
      `Zotero extraction: extractedPages=${extracted.extractedPages} totalPages=${extracted.totalPages}`,
    );
    assert.equal(extracted.totalPages, TOTAL_PAGES);
    assert.isBelow(
      String(extracted.text).split("\f").length,
      TOTAL_PAGES,
      "Zotero dropped the blank leading pages",
    );
    assert.include(extracted.text, marker(BLANK_LEADING + 1));

    // A chat's load proves the shift.
    const context = await new PdfService().ensurePaperContext(fixture.paper);
    const shift = context?.textPageOffset;
    assert.isOk(shift, "the load proved a text page offset");
    assert.equal(shift!.pageOffset, BLANK_LEADING);
    assert.isAtMost(
      shift!.pageOffset + shift!.textParts,
      Number(extracted.extractedPages),
    );

    // The page read lands each body page's text on that page. The page-text
    // cache is cleared first, so the read warms it again from the PDF and
    // takes the shift from the paper's stored text, not from the load's seed.
    clearPageTextCache();
    const result = await pageService().readPageTexts({
      paperContext: fixture.paper,
      request: request(fixture),
      pages: Array.from({ length: BODY_PAGES }, (_, i) => BLANK_LEADING + i),
    });
    assert.lengthOf(result.pages, BODY_PAGES);
    for (const entry of result.pages) {
      const pdfPage = entry.pageIndex + 1;
      assert.include(entry.text, marker(pdfPage), `page ${pdfPage} own text`);
      for (const other of [pdfPage - 1, pdfPage + 1]) {
        if (other < BLANK_LEADING + 1 || other > TOTAL_PAGES) continue;
        assert.notInclude(
          entry.text,
          marker(other),
          `page ${pdfPage} holds page ${other}'s text`,
        );
      }
    }

    // A blank leading page reads as empty, not as the first body page.
    const blank = await pageService().readPageTexts({
      paperContext: fixture.paper,
      request: request(fixture),
      pages: [0],
    });
    assert.equal(blank.pages[0].text.trim(), "");
  });

  it("refuses the page read when no bookmarks prove the shift", async function () {
    const fixture = await importPdf(
      `Blank leading pages, no bookmarks ${Date.now()}`,
      await createPdfWithOutline({ pages: PAGES }),
    );
    const context = await new PdfService().ensurePaperContext(fixture.paper);
    assert.isUndefined(context?.textPageOffset);
    let failure: unknown;
    try {
      await pageService().readPageTexts({
        paperContext: fixture.paper,
        request: request(fixture),
        pages: [BLANK_LEADING],
      });
    } catch (error) {
      failure = error;
    }
    assert.match(
      String((failure as Error)?.message ?? failure),
      /Could not read page text from this PDF/,
    );
  });
});
