import { assert } from "chai";
import * as mineruChunking from "../src/utils/mineruChunking";
import {
  buildMineruPageRanges,
  extractMineruPageCountFromDumpData,
  mergeMineruChunkResults,
} from "../src/utils/mineruChunking";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function file(relativePath: string, content: string) {
  return { relativePath, data: encoder.encode(content) };
}

describe("mineruChunking", function () {
  it("finds pdftk installed on a non-system Windows PATH directory", function () {
    const buildCandidates = (
      mineruChunking as unknown as {
        buildMineruExecutablePathCandidates?: (
          pathValue: string,
          executableName: string,
          isWindows: boolean,
        ) => string[];
      }
    ).buildMineruExecutablePathCandidates;

    assert.isFunction(buildCandidates);
    assert.include(
      buildCandidates!(
        "C:\\Windows\\System32;E:\\PDFtk\\PDFtk Server\\bin\\;",
        "pdftk",
        true,
      ),
      "E:\\PDFtk\\PDFtk Server\\bin\\pdftk.exe",
    );
  });

  it("directs pdftk page-count output to a file instead of stdout", function () {
    const buildArguments = (
      mineruChunking as unknown as {
        buildMineruDumpDataArguments?: (
          pdfPath: string,
          outputPath: string,
        ) => string[];
      }
    ).buildMineruDumpDataArguments;

    assert.isFunction(buildArguments);
    assert.deepEqual(
      buildArguments!("E:\\papers\\book.pdf", "C:\\Temp\\pages.txt"),
      ["E:\\papers\\book.pdf", "dump_data", "output", "C:\\Temp\\pages.txt"],
    );
  });

  it("prefers the authoritative pdftk count over heuristic PDF scanning", function () {
    const selectPageCount = (
      mineruChunking as unknown as {
        selectMineruPageCount?: (
          detectedCount: number | null,
          pdftkCount: number | null,
        ) => number | null;
      }
    ).selectMineruPageCount;

    assert.isFunction(selectPageCount);
    assert.equal(selectPageCount!(32, 714), 714);
    assert.equal(selectPageCount!(32, null), 32);
  });

  it("keeps PDFs at or below 200 pages in one range", function () {
    assert.deepEqual(buildMineruPageRanges(199), [
      { index: 0, startPage: 1, endPage: 199, total: 199 },
    ]);
    assert.deepEqual(buildMineruPageRanges(200), [
      { index: 0, startPage: 1, endPage: 200, total: 200 },
    ]);
  });

  it("splits longer PDFs into consecutive 200-page ranges", function () {
    assert.deepEqual(buildMineruPageRanges(401), [
      { index: 0, startPage: 1, endPage: 200, total: 401 },
      { index: 1, startPage: 201, endPage: 400, total: 401 },
      { index: 2, startPage: 401, endPage: 401, total: 401 },
    ]);
  });

  it("reads page counts from pdftk dump_data output", function () {
    assert.equal(
      extractMineruPageCountFromDumpData(
        "InfoBegin\nNumberOfPages: 714\nInfoEnd\n",
      ),
      714,
    );
    assert.equal(
      extractMineruPageCountFromDumpData(
        "InfoBegin\nNumberOfPages: 402\nInfoEnd\n",
      ),
      402,
    );
  });

  it("rejects a split PDF whose actual page count does not match its range", function () {
    const validateSplitPageCount = (
      mineruChunking as unknown as {
        validateMineruSplitPageCount?: (
          actualPageCount: number | null,
          range: { startPage: number; endPage: number },
        ) => void;
      }
    ).validateMineruSplitPageCount;

    assert.isFunction(validateSplitPageCount);
    assert.doesNotThrow(() =>
      validateSplitPageCount!(200, { startPage: 201, endPage: 400 }),
    );
    assert.throws(
      () => validateSplitPageCount!(199, { startPage: 201, endPage: 400 }),
      /expected 200 pages.*found 199/i,
    );
  });

  it("merges chunks while isolating assets and offsetting page indexes", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 2, total: 4 },
        result: {
          mdContent: "# First\n\n![figure](images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "first image"),
          ],
        },
      },
      {
        range: { index: 1, startPage: 3, endPage: 4, total: 4 },
        result: {
          mdContent: "# Second\n\n![figure](images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "second image"),
          ],
        },
      },
    ]);

    assert.include(merged.mdContent, "images/chunk-001/images/figure.png");
    assert.include(merged.mdContent, "images/chunk-002/images/figure.png");
    assert.deepEqual(
      merged.files.map((item) => item.relativePath),
      [
        "images/chunk-001/images/figure.png",
        "images/chunk-002/images/figure.png",
        "content_list.json",
      ],
    );

    const contentList = JSON.parse(
      decoder.decode(
        merged.files.find((item) => item.relativePath === "content_list.json")
          ?.data,
      ),
    ) as Array<{ page_idx: number; img_path: string }>;
    assert.deepEqual(contentList, [
      {
        page_idx: 0,
        img_path: "images/chunk-001/images/figure.png",
      },
      {
        page_idx: 2,
        img_path: "images/chunk-002/images/figure.png",
      },
    ]);
  });

  it("rewrites paths from MinerU archives with a job/auto container", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](images/figure.png)",
          files: [
            file("job-id/auto/job-id.md", "ignored"),
            file(
              "job-id/auto/job-id_content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("job-id/auto/images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.include(merged.mdContent, "images/chunk-001/images/figure.png");
    assert.include(
      decoder.decode(
        merged.files.find((item) => item.relativePath === "content_list.json")
          ?.data,
      ),
      "images/chunk-001/images/figure.png",
    );
    assert.include(
      merged.files.map((item) => item.relativePath),
      "images/chunk-001/images/figure.png",
    );
  });

  it("rewrites a relative Markdown image target exactly once", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](./images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.equal(
      merged.mdContent,
      "<!-- MinerU pages 1-1 -->\n\n![figure](images/chunk-001/images/figure.png)",
    );
  });

  it("rewrites a full job/auto Markdown image target exactly once", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](job-id/auto/images/figure.png)",
          files: [
            file("job-id/auto/full.md", "ignored"),
            file(
              "job-id/auto/content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("job-id/auto/images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.equal(
      merged.mdContent,
      "<!-- MinerU pages 1-1 -->\n\n![figure](images/chunk-001/images/figure.png)",
    );
  });

  it("rejects chunk ranges with gaps before merging", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 4 },
            result: { mdContent: "first", files: [] },
          },
          {
            range: { index: 1, startPage: 4, endPage: 4, total: 4 },
            result: { mdContent: "second", files: [] },
          },
        ]),
      /contiguous/i,
    );
  });

  it("rejects overlapping chunk ranges before merging", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 4 },
            result: { mdContent: "first", files: [] },
          },
          {
            range: { index: 1, startPage: 2, endPage: 4, total: 4 },
            result: { mdContent: "second", files: [] },
          },
        ]),
      /contiguous/i,
    );
  });

  it("rejects content-list page indexes outside their source chunk", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 2 },
            result: {
              mdContent: "content",
              files: [
                file("content_list.json", '[{"type":"text","page_idx":2}]'),
              ],
            },
          },
        ]),
      /page_idx.*outside/i,
    );
  });

  it("rejects an invalid chunk content list instead of silently dropping it", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: {
              mdContent: "content",
              files: [file("content_list.json", "not json")],
            },
          },
        ]),
      /valid.*content list/i,
    );
  });

  it("rejects a chunk with no content list", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: { mdContent: "content", files: [] },
          },
        ]),
      /content list/i,
    );
  });

  it("rejects content-list paths whose chunk assets are missing", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: {
              mdContent: "content",
              files: [
                file(
                  "content_list.json",
                  '[{"type":"image","page_idx":0,"img_path":"images/missing.png"}]',
                ),
              ],
            },
          },
        ]),
      /missing.*asset/i,
    );
  });
});
