/**
 * A PDF whose first pages are blank is read by page in real Zotero, against a
 * PDF that pdf-lib generates and Zotero's own PDF worker extracts (no model,
 * no network):
 * - Zotero's text drops the blank leading pages, and the paper's load proves
 *   the shift from the bookmarks (`textPageOffset.pageOffset`);
 * - a page read puts each body page's own text on that PDF page, never a
 *   neighbour's;
 * - a page read of a paper that was never loaded proves the shift itself from
 *   the bookmarks, from PDFWorker's text and from Zotero's full-text cache;
 * - without bookmarks the shift cannot be proven, and the page read refuses
 *   rather than place text on the wrong page;
 * - bookmarks that two shifts fit equally well (a chapter title on every
 *   page) prove nothing: the paper gets no chapter map and no page map,
 *   and preloads whole;
 * - text that lost only trailing blank pages is proven at shift 0, and a
 *   page read works for every page its page map offers.
 */
import { assert } from "chai";
import { createPdfWithOutline } from "../test/helpers/outlinePdfFixture";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { PdfService } from "../src/agent/services/pdfService";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { paperTextStore } from "../src/services/paperContent/paperTextStore";
import { clearPdfBookmarksCache } from "../src/services/paperContent/pdfBookmarks";
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

/** One bookmark per body page, titled by the heading that opens it. */
const OUTLINE = Array.from({ length: BODY_PAGES }, (_, index) => ({
  title: `Heading ${BLANK_LEADING + index + 1} opens here`,
  page: BLANK_LEADING + index,
}));

type Fixture = { paper: PaperContextRef; parentItemId: number; path: string };

describe("workflow: page reads on a PDF with blank leading pages", function () {
  this.timeout(120000);
  const fixtures: Fixture[] = [];

  async function importPdf(
    title: string,
    bytes: Uint8Array,
    parentType = "book",
  ): Promise<Fixture> {
    const parent = new Zotero.Item(parentType);
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
      await createPdfWithOutline({ pages: PAGES, outline: OUTLINE }),
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

  it("proves the shift for a paper that was never loaded, from PDFWorker and from Zotero's full-text cache", async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    // The import queues a Zotero background index that calls
    // Zotero.FullText.indexItems([id], { ignoreErrors: true }) about 5 s later
    // and rewrites the cache file. This wrapper skips that call, so the cache
    // phase is deterministic. Calls with { complete: true } and calls for other
    // items go to the original. It stays in place for the whole case.
    const indexItems = Zotero.Fulltext.indexItems;
    let queuedAttachmentId: number | undefined;
    Zotero.Fulltext.indexItems = async (...args: unknown[]) => {
      const ids = args[0] as number[];
      const options = (args[1] || {}) as { complete?: boolean };
      if (
        !options.complete &&
        queuedAttachmentId !== undefined &&
        Array.isArray(ids) &&
        ids.length === 1 &&
        ids[0] === queuedAttachmentId
      ) {
        return;
      }
      return indexItems.apply(Zotero.Fulltext, args);
    };
    try {
      const fixture = await importPdf(
        `Blank leading pages, never loaded ${Date.now()}`,
        await createPdfWithOutline({ pages: PAGES, outline: OUTLINE }),
      );
      const attachmentId = fixture.paper.contextItemId!;
      queuedAttachmentId = attachmentId;
      const cachePath = Zotero.Fulltext.getItemCacheFile(
        Zotero.Items.get(attachmentId),
      ).path;

      // Reads every page one at a time from a cold start (no stored text, page
      // text or bookmarks) and counts the PDFWorker extractions it needed.
      async function readEachPageCold(): Promise<number> {
        assert.isFalse(paperTextStore.has(attachmentId), "never loaded");
        clearPageTextCache();
        clearPdfBookmarksCache();
        const getFullText = Zotero.PDFWorker.getFullText;
        let workerCalls = 0;
        Zotero.PDFWorker.getFullText = (...args: unknown[]) => {
          if (Number(args[0]) === attachmentId) workerCalls += 1;
          return getFullText.apply(Zotero.PDFWorker, args);
        };
        try {
          for (let pageIndex = 0; pageIndex < TOTAL_PAGES; pageIndex += 1) {
            const result = await pageService().readPageTexts({
              paperContext: fixture.paper,
              request: request(fixture),
              pages: [pageIndex],
            });
            const text = result.pages[0].text;
            const pdfPage = pageIndex + 1;
            if (pdfPage <= BLANK_LEADING) {
              assert.equal(text.trim(), "", `blank page ${pdfPage}`);
              continue;
            }
            assert.include(text, marker(pdfPage), `page ${pdfPage} own text`);
            for (let other = BLANK_LEADING + 1; other <= TOTAL_PAGES; other++) {
              if (other === pdfPage) continue;
              assert.notInclude(
                text,
                marker(other),
                `page ${pdfPage} holds page ${other}'s text`,
              );
            }
          }
        } finally {
          Zotero.PDFWorker.getFullText = getFullText;
        }
        assert.isFalse(paperTextStore.has(attachmentId), "still never loaded");
        return workerCalls;
      }

      // Once Zotero has indexed the PDF, its full-text cache serves the read.
      // The wrapper above skips Zotero's queued index, so only this explicit
      // call writes the cache. The mtime check below guards that.
      await Zotero.Fulltext.indexItems([attachmentId], { complete: true });
      assert.isTrue(await IOUtils.exists(cachePath), "Zotero wrote its cache");
      const cachedText = await IOUtils.readUTF8(cachePath);
      assert.isBelow(
        cachedText.split("\f").length,
        TOTAL_PAGES,
        "the cache lost the blank leading pages",
      );
      const modifiedBefore = (await IOUtils.stat(cachePath)).lastModified;
      const fromCache = await readEachPageCold();
      const modifiedAfter = (await IOUtils.stat(cachePath)).lastModified;
      console.log(
        `Never-loaded read from the full-text cache: ${fromCache} extraction(s)`,
      );
      assert.equal(
        modifiedAfter,
        modifiedBefore,
        "Zotero's queued index rewrote the cache during the read",
      );
      assert.equal(fromCache, 0, "the read used Zotero's full-text cache");

      // Without a Zotero full-text cache entry the text comes from PDFWorker.
      // The cache is hidden by a stub, not deleted, so a queued background
      // index cannot bring it back.
      const getPages = Zotero.Fulltext.getPages;
      Zotero.Fulltext.getPages = async (...args: unknown[]) =>
        Number(args[0]) === attachmentId
          ? null
          : getPages.apply(Zotero.Fulltext, args);
      let fromWorker: number;
      try {
        fromWorker = await readEachPageCold();
      } finally {
        Zotero.Fulltext.getPages = getPages;
      }
      console.log(
        `Never-loaded read from PDFWorker: ${fromWorker} extraction(s)`,
      );
      assert.isAbove(fromWorker, 0, "the read extracted the PDF");
    } finally {
      Zotero.Fulltext.indexItems = indexItems;
    }
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

  it("gives a paper no chapter map or page map when two shifts fit its bookmarks equally, and preloads it whole", async function () {
    // One blank leading page; each chapter's title heads every page of it,
    // so shift 0 and shift 1 put every bookmark title on its page.
    const tiedPages: string[][] = [
      [],
      ["Chapter 1 Origins", marker(2), "Origins continue on this page."],
      ["Chapter 1 Origins", marker(3), "Origins continue on this page."],
      ["Chapter 2 Methods", marker(4), "Methods continue on this page."],
      ["Chapter 2 Methods", marker(5), "Methods continue on this page."],
    ];
    const fixture = await importPdf(
      `Tied shift ${Date.now()}`,
      await createPdfWithOutline({
        pages: tiedPages,
        outline: [
          { title: "Chapter 1 Origins", page: 1 },
          { title: "Chapter 2 Methods", page: 3 },
        ],
      }),
    );
    const extracted = await Zotero.PDFWorker.getFullText(
      fixture.paper.contextItemId,
    );
    assert.isBelow(
      String(extracted.text).split("\f").length,
      tiedPages.length,
      "Zotero dropped the blank leading page",
    );
    const context = await new PdfService().ensurePaperContext(fixture.paper);
    assert.isOk(context?.chunks.length);
    assert.isUndefined(context?.documentStructure, "no chapter map");
    assert.isUndefined(context?.textPages, "no page map");
    assert.isUndefined(context?.bookmarkSections, "no section map");
    assert.isUndefined(context?.textPageOffset, "no shift proven");
    const prepared = await preparePaperPromptContext(
      resolvedAgentRequest({
        conversationKey: 0,
        mode: "agent",
        libraryID: fixture.paper.libraryID,
        userText: "Explain this book",
        activePaperContext: fixture.paper,
        conversationKind: "paper",
      }),
    );
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.include(prepared.blocks[0], marker(5));
  });

  it("proves a shift of 0 for text that lost only trailing blank pages, and reads every page its page map offers", async function () {
    const TRAILING_BLANK = 2;
    // Body pages from PDF page 1, each opening with its own heading.
    const bodyPages = Array.from({ length: BODY_PAGES }, (_, index) => [
      `Heading ${index + 1} opens here`,
      marker(index + 1),
      `Filler sentence for page ${index + 1}: the reading continues on this page.`,
    ]);
    const trailing = [
      ...bodyPages,
      ...Array.from({ length: TRAILING_BLANK }, () => []),
    ];
    // A journal article: no chapter map, so its page map is what it offers.
    const fixture = await importPdf(
      `Trailing blank pages ${Date.now()}`,
      await createPdfWithOutline({
        pages: trailing,
        outline: bodyPages.map((lines, page) => ({ title: lines[0], page })),
      }),
      "journalArticle",
    );
    const extracted = await Zotero.PDFWorker.getFullText(
      fixture.paper.contextItemId,
    );
    assert.equal(extracted.totalPages, trailing.length);
    assert.isBelow(
      String(extracted.text).split("\f").length,
      trailing.length,
      "Zotero dropped the trailing blank pages",
    );
    const context = await new PdfService().ensurePaperContext(fixture.paper);
    assert.isUndefined(context?.documentStructure);
    assert.equal(context?.textPageOffset?.pageOffset, 0);
    assert.lengthOf(context?.textPages || [], trailing.length);

    clearPageTextCache();
    for (let pageIndex = 0; pageIndex < trailing.length; pageIndex += 1) {
      const result = await pageService().readPageTexts({
        paperContext: fixture.paper,
        request: request(fixture),
        pages: [pageIndex],
      });
      const text = result.pages[0].text;
      const pdfPage = pageIndex + 1;
      if (pdfPage > bodyPages.length) {
        assert.equal(text.trim(), "", `trailing blank page ${pdfPage}`);
        continue;
      }
      assert.include(text, marker(pdfPage), `page ${pdfPage} own text`);
    }
  });
});
