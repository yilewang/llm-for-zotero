import { assert } from "chai";
import {
  resolvePaperImageSource,
  type PaperImageSourceDeps,
} from "../src/services/paperContent/paperImageSource";
import type { MineruManifest } from "../src/services/mineru/mineruCache";

const MANIFEST = {
  sections: [],
  allFigures: [
    {
      label: "Figure 1",
      baseLabel: "figure 1",
      path: "images/a.jpg",
      caption: "Figure 1: Loss",
      section: "Results",
      page: 4,
    },
  ],
  allTables: [],
  totalChars: 10,
  totalPages: 12,
} as unknown as MineruManifest;

function pdfCandidate(overrides: Record<string, unknown> = {}) {
  return {
    source: "embedded" as const,
    pageIndex: 2,
    rect: [0, 0, 10, 10] as [number, number, number, number],
    width: 300,
    height: 200,
    contentHash: "h1",
    dataUrl: "data:image/png;base64,AAAA",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PaperImageSourceDeps> = {}) {
  const calls = { manifest: 0, extract: 0 };
  const deps: PaperImageSourceDeps = {
    loadMineruManifest: async () => {
      calls.manifest += 1;
      return MANIFEST;
    },
    mineruItemDir: (attachmentId) => `C:/mineru/${attachmentId}`,
    fileExists: async () => true,
    readCropCache: async () => null,
    readImageAsDataUrl: async () => "data:image/jpeg;base64,BBBB",
    resolvePdfPath: async () => "C:/paper.pdf",
    statFile: async () => ({ size: 100, lastModified: 5 }),
    readFile: async () => new Uint8Array([1]),
    extractFromPdf: async () => {
      calls.extract += 1;
      return [pdfCandidate()];
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("paper image source", function () {
  it("uses MinerU figures for a MinerU-backed context", async function () {
    const { deps, calls } = makeDeps();
    const source = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: true,
      deps,
    });
    assert.equal(source!.kind, "mineru");
    const candidates = await source!.collect();
    assert.deepEqual(candidates, [
      {
        source: "mineru",
        pageIndex: 4,
        contentHash: candidates[0].contentHash,
        dataUrl: "data:image/jpeg;base64,BBBB",
        label: "Figure 1",
        caption: "Figure 1: Loss",
      },
    ]);
    assert.equal(calls.extract, 0);
  });

  it("uses pdf.js for an extracted-text context even when a manifest exists", async function () {
    const { deps, calls } = makeDeps();
    const source = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: false,
      deps,
    });
    assert.equal(source!.kind, "pdf");
    assert.equal(source!.fingerprint, "pdf:100:5");
    assert.deepEqual(await source!.collect(), [
      {
        source: "embedded",
        pageIndex: 2,
        rect: [0, 0, 10, 10],
        width: 300,
        height: 200,
        contentHash: "h1",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ]);
    assert.equal(calls.manifest, 0);
  });

  it("falls back to pdf.js when the MinerU manifest lists no usable figure", async function () {
    const { deps } = makeDeps({ fileExists: async () => false });
    const source = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: true,
      deps,
    });
    assert.equal(source!.kind, "pdf");
  });

  it("drops the pdf.js candidates the embedded-image filters reject", async function () {
    const { deps } = makeDeps({
      extractFromPdf: async () => [
        pdfCandidate({ width: 40, height: 40, contentHash: "icon" }),
        pdfCandidate({ contentHash: "keep" }),
        pdfCandidate({ contentHash: "keep", pageIndex: 3 }),
      ],
    });
    const source = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: false,
      deps,
    });
    const candidates = await source!.collect();
    assert.deepEqual(
      candidates.map((entry) => entry.contentHash),
      ["keep"],
    );
  });

  it("skips a MinerU figure whose file cannot be read", async function () {
    const { deps } = makeDeps({ readImageAsDataUrl: async () => null });
    const source = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: true,
      deps,
    });
    assert.lengthOf(await source!.collect(), 0);
  });

  it("returns nothing when the attachment has no local PDF", async function () {
    const { deps } = makeDeps({
      loadMineruManifest: async () => null,
      resolvePdfPath: async () => null,
    });
    assert.isNull(
      await resolvePaperImageSource({
        attachmentId: 7,
        useMineru: true,
        deps,
      }),
    );
  });

  it("gives the two sources different fingerprints", async function () {
    const { deps } = makeDeps();
    const mineru = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: true,
      deps,
    });
    const pdf = await resolvePaperImageSource({
      attachmentId: 7,
      useMineru: false,
      deps,
    });
    assert.notEqual(mineru!.fingerprint, pdf!.fingerprint);
  });
});
