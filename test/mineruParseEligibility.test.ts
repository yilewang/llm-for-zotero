import { assert } from "chai";
import {
  clearMineruEligibilityCacheForTests,
  extractPdfPageCountFromText,
  getMineruParseEligibility,
} from "../src/modules/mineruParseEligibility";
import { buildMineruFilenameMatcher } from "../src/utils/mineruConfig";

const encoder = new TextEncoder();

type MockItem = {
  id: number;
  itemType?: string;
  parentID?: number;
  attachmentFilename?: string;
  attachmentSyncedHash?: string;
  getField?: (field: string) => string;
  getFilePathAsync?: () => Promise<string | false>;
};

function pdfText(pageCount: number): string {
  return `%PDF-1.7
1 0 obj
<< /Type /Pages /Count ${pageCount} /Kids [] >>
endobj`;
}

function setupZoteroPrefs(
  overrides: {
    excludePatterns?: string[];
    maxAutoPages?: unknown;
  } = {},
): void {
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".mineruExcludePatterns")) {
          return JSON.stringify(overrides.excludePatterns || []);
        }
        if (key.endsWith(".mineruMaxAutoPages")) {
          return overrides.maxAutoPages === undefined
            ? 100
            : overrides.maxAutoPages;
        }
        return undefined;
      },
      set: () => {},
    },
  };
}

function setupIO(files: Record<string, string>): void {
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    read: async (path: string) => encoder.encode(files[path] || ""),
  };
}

function createPdf(
  id: number,
  filename = "paper.pdf",
  filePath = `/tmp/${id}.pdf`,
): MockItem {
  return {
    id,
    itemType: "attachment",
    attachmentFilename: filename,
    attachmentSyncedHash: `hash-${id}`,
    getField: (field) => (field === "title" ? filename : ""),
    getFilePathAsync: async () => filePath,
  };
}

function createParent(itemType = "journalArticle"): MockItem {
  return {
    id: 1,
    itemType,
  };
}

describe("mineruParseEligibility", function () {
  afterEach(function () {
    clearMineruEligibilityCacheForTests();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
  });

  it("extracts page count from a PDF pages dictionary", function () {
    assert.equal(extractPdfPageCountFromText(pdfText(42)), 42);
  });

  it("keeps a normal article PDF eligible", async function () {
    setupZoteroPrefs();
    setupIO({ "/tmp/101.pdf": pdfText(12) });

    const result = await getMineruParseEligibility(
      createParent(),
      createPdf(101) as Zotero.Item,
    );

    assert.isTrue(result.eligible);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.pageCount, 12);
  });

  it("does not skip Zotero book items when they are under the page limit", async function () {
    setupZoteroPrefs();
    setupIO({ "/tmp/102.pdf": pdfText(30) });

    const result = await getMineruParseEligibility(
      createParent("book") as Zotero.Item,
      createPdf(102) as Zotero.Item,
    );

    assert.isTrue(result.eligible);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.pageCount, 30);
  });

  it("skips PDFs over the configured automatic page limit", async function () {
    setupZoteroPrefs({ maxAutoPages: 100 });
    setupIO({ "/tmp/103.pdf": pdfText(412) });

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(103) as Zotero.Item,
    );

    assert.isFalse(result.eligible);
    assert.deepEqual(result.reasons, ["page_count"]);
    assert.equal(result.reasonLabel, "412 pages");
  });

  it("can skip page-count inspection for cheap manager row classification", async function () {
    setupZoteroPrefs({ maxAutoPages: 100 });
    setupIO({ "/tmp/107.pdf": pdfText(412) });

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(107) as Zotero.Item,
      { inspectPageCount: false },
    );

    assert.isTrue(result.eligible);
    assert.deepEqual(result.reasons, []);
    assert.isNull(result.pageCount);
  });

  it("skips filename-excluded PDFs", async function () {
    setupZoteroPrefs({ excludePatterns: ["translated"] });
    setupIO({ "/tmp/104.pdf": pdfText(10) });

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(104, "paper_translated.pdf") as Zotero.Item,
    );

    assert.isFalse(result.eligible);
    assert.deepEqual(result.reasons, ["filename"]);
    assert.equal(result.reasonLabel, "filename rule");
  });

  it("uses a provided filename matcher instead of recompiling prefs", async function () {
    setupZoteroPrefs({ excludePatterns: ["translated"] });
    setupIO({ "/tmp/108.pdf": pdfText(10) });
    const filenameMatcher = buildMineruFilenameMatcher([]);

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(108, "paper_translated.pdf") as Zotero.Item,
      { filenameMatcher },
    );

    assert.isTrue(result.eligible);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.pageCount, 10);
  });

  it("allows unknown page count when no other parse filter matches", async function () {
    setupZoteroPrefs();
    setupIO({ "/tmp/105.pdf": "%PDF-1.7\nno count here" });

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(105) as Zotero.Item,
    );

    assert.isTrue(result.eligible);
    assert.isNull(result.pageCount);
  });

  it("falls back to the default page limit when the saved value is zero", async function () {
    setupZoteroPrefs({ maxAutoPages: 0 });
    setupIO({ "/tmp/106.pdf": pdfText(999) });

    const result = await getMineruParseEligibility(
      createParent() as Zotero.Item,
      createPdf(106) as Zotero.Item,
    );

    assert.isFalse(result.eligible);
    assert.deepEqual(result.reasons, ["page_count"]);
    assert.equal(result.reasonLabel, "999 pages");
  });
});
