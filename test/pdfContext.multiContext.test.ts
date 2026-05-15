import { assert } from "chai";
import {
  buildChunkMetadata,
  buildEvidencePack,
  buildFullPaperContext,
  buildPaperKey,
  buildPaperRetrievalCandidates,
  ensurePDFTextCached,
  renderEvidencePack,
} from "../src/modules/contextPanel/pdfContext";
import {
  readManifest,
  writeMineruCacheFiles,
} from "../src/modules/contextPanel/mineruCache";
import { tokenizeRetrievalText } from "../src/modules/contextPanel/retrievalTokenizer";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type {
  ChunkStat,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";

const encoder = new TextEncoder();

type MemoryIO = {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  writes: string[];
};

function bytes(value: string | number[]): Uint8Array {
  return typeof value === "string"
    ? encoder.encode(value)
    : new Uint8Array(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function addDir(dirs: Set<string>, path: string): void {
  let current = normalizePath(path);
  const ancestors: string[] = [];
  while (current && current !== "/") {
    ancestors.push(current);
    current = parentPath(current);
  }
  ancestors.push("/");
  for (const dir of ancestors.reverse()) dirs.add(dir);
}

function setupMemoryIO(): MemoryIO {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  addDir(dirs, "/tmp/zotero");

  const io = {
    exists: async (path: string) => {
      const normalized = normalizePath(path);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (path: string) => {
      const normalized = normalizePath(path);
      const data = files.get(normalized);
      if (!data) throw new Error(`Missing file: ${path}`);
      return data;
    },
    makeDirectory: async (path: string) => {
      addDir(dirs, path);
    },
    write: async (path: string, data: Uint8Array) => {
      const normalized = normalizePath(path);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
      writes.push(normalized);
    },
    remove: async (path: string) => {
      const normalized = normalizePath(path);
      for (const key of [...files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          files.delete(key);
        }
      }
      for (const key of [...dirs.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          dirs.delete(key);
        }
      }
    },
    getChildren: async (path: string) => {
      const normalized = normalizePath(path);
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const children = new Set<string>();
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(prefix) || key === normalized) continue;
        const rest = key.slice(prefix.length);
        const childName = rest.split("/")[0];
        if (childName) children.add(`${prefix}${childName}`);
      }
      return [...children];
    },
  };

  (globalThis as unknown as { IOUtils: typeof io }).IOUtils = io;
  return { files, dirs, writes };
}

function setupZoteroGlobals(parentTitle = "Mock MinerU Paper"): void {
  const parentItem = {
    getField: (field: string) => (field === "title" ? parentTitle : ""),
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Profile: { dir: "/tmp/profile" },
    Prefs: {
      get: (key: string) => (key.endsWith(".mineruEnabled") ? true : undefined),
      set: () => {},
    },
    Items: {
      get: (id: number) => (id === 100 ? parentItem : null),
    },
    PDFWorker: {
      getFullText: async () => ({ text: "" }),
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };
}

function mockPdfAttachment(id: number): Zotero.Item {
  return {
    id,
    parentID: 100,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    getField: (field: string) => (field === "title" ? "PDF" : ""),
  } as unknown as Zotero.Item;
}

function fullPaperRef(contextItemId: number): PaperContextRef {
  return {
    itemId: 100,
    contextItemId,
    title: "Mock MinerU Paper",
    firstCreator: "Tester",
    year: "2026",
  };
}

function tokenize(text: string): string[] {
  return tokenizeRetrievalText(text);
}

function buildPdfContext(chunks: string[]): PdfContext {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = chunks.map((chunk, index) => {
    const tf: Record<string, number> = {};
    const terms = tokenize(chunk);
    for (const term of terms) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    return {
      index,
      length: terms.length,
      tf,
      uniqueTerms,
    };
  });
  const avgChunkLength = chunkStats.length
    ? chunkStats.reduce((sum, chunk) => sum + chunk.length, 0) /
      chunkStats.length
    : 0;
  return {
    title: "Mock Paper",
    chunks,
    chunkMeta: buildChunkMetadata(chunks),
    chunkStats,
    docFreq,
    avgChunkLength,
    fullLength: chunks.join("\n\n").length,
  };
}

describe("pdfContext multi-context helpers", function () {
  let originalZotero: unknown;
  let originalIOUtils: unknown;
  let originalZtoolkit: unknown;

  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
      .Zotero;
    originalIOUtils = (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    originalZtoolkit = (globalThis as unknown as { ztoolkit?: unknown })
      .ztoolkit;
  });

  beforeEach(function () {
    pdfTextCache.clear();
    setupZoteroGlobals();
  });

  afterEach(function () {
    pdfTextCache.clear();
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    if (originalIOUtils === undefined) {
      delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    } else {
      (globalThis as unknown as { IOUtils?: unknown }).IOUtils =
        originalIOUtils;
    }
    if (originalZtoolkit === undefined) {
      delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    } else {
      (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit =
        originalZtoolkit;
    }
  });

  it("builds retrieval candidates with scores and metadata", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
      firstCreator: "Alice",
      year: "2024",
    };
    const context = buildPdfContext([
      "Gamma delta shared finding from paper A.",
      "Ablation and method details.",
      "Unrelated appendix details.",
    ]);
    const candidates = await buildPaperRetrievalCandidates(
      paper,
      context,
      "gamma delta finding",
      undefined,
      { topK: 2 },
    );
    assert.lengthOf(candidates, 2);
    assert.equal(candidates[0].paperKey, buildPaperKey(paper));
    assert.equal(candidates[0].itemId, 1);
    assert.isAtLeast(candidates[0].estimatedTokens, 1);
  });

  it("falls back to Zotero full-text cache when PDFWorker returns no text", async function () {
    const io = setupMemoryIO();
    const cachePath = "/tmp/zotero/storage/ABCD1234/.zotero-ft-cache";
    io.files.set(
      cachePath,
      bytes(
        [
          "Abstract",
          "This indexed Zotero text should be used when PDFWorker is empty.",
          "",
          "Discussion",
          "The full-text cache still contains usable paper content.",
        ].join("\n"),
      ),
    );
    const zotero = (globalThis as unknown as { Zotero: any }).Zotero;
    zotero.Fulltext = {
      getItemCacheFile: () => ({
        path: cachePath,
        exists: () => true,
      }),
    };

    await ensurePDFTextCached(mockPdfAttachment(123));
    const context = pdfTextCache.get(123);

    assert.equal(context?.sourceType, "zotero-fulltext-cache");
    assert.isAtLeast(context?.chunks.length || 0, 1);
    assert.include(
      context?.chunks.join("\n") || "",
      "indexed Zotero text should be used",
    );
  });

  it("ranks matching Korean text with Hangul n-gram retrieval", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Korean Paper",
      firstCreator: "Kim",
      year: "2026",
    };
    const context = buildPdfContext([
      "이 논문은 표현학습방법을 제안하고 실험으로 검증한다.",
      "This unrelated appendix describes baseline calibration.",
    ]);
    const candidates = await buildPaperRetrievalCandidates(
      paper,
      context,
      "학습방법",
      undefined,
      { topK: 2 },
    );

    assert.lengthOf(candidates, 2);
    assert.equal(candidates[0].chunkIndex, 0);
    assert.isAbove(candidates[0].bm25Score, candidates[1].bm25Score);
  });

  it("renders full paper context with metadata", function () {
    const paper: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
      citationKey: "Smith2023",
      firstCreator: "Smith et al.",
      year: "2023",
    };
    const context = buildPdfContext(["Main finding.", "Conclusion."]);
    const text = buildFullPaperContext(paper, context);
    assert.include(text, "Title: Paper B");
    assert.include(text, "Citation key: Smith2023");
    assert.include(text, "Source label: (Smith et al., 2023)");
    assert.include(text, "Answer format when quoting this paper:");
    assert.include(text, "Paper Text:");
  });

  it("renders evidence pack with quote-plus-source formatting", function () {
    const paperA: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
      firstCreator: "Zheng et al.",
      year: "2026",
    };
    const paperB: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
      citationKey: "Smith2023",
    };
    const rendered = renderEvidencePack({
      papers: [paperA, paperB],
      candidates: [
        {
          paperKey: buildPaperKey(paperA),
          itemId: 1,
          contextItemId: 11,
          title: "Paper A",
          firstCreator: "Zheng et al.",
          year: "2026",
          chunkIndex: 3,
          chunkText:
            "Abstract\nDespite global representational drift, the relative geometry remained stable across conditions.",
          estimatedTokens: 8,
          bm25Score: 0.7,
          embeddingScore: 0.1,
          hybridScore: 0.4,
          evidenceScore: 1.3,
        },
        {
          paperKey: buildPaperKey(paperB),
          itemId: 2,
          contextItemId: 22,
          title: "Paper B",
          citationKey: "Smith2023",
          chunkIndex: 1,
          chunkText: "Shared claim B",
          estimatedTokens: 8,
          bm25Score: 0.6,
          embeddingScore: 0.2,
          hybridScore: 0.4,
          evidenceScore: 0.9,
        },
      ],
    });
    assert.include(
      rendered,
      "Paper-grounded citation format for the final answer:",
    );
    assert.include(rendered, "Source label: (Zheng et al., 2026)");
    assert.include(
      rendered,
      "> Despite global representational drift, the relative geometry remained stable across conditions.",
    );
    assert.include(rendered, "Source label: (Paper 2)");
    assert.include(rendered, "> Shared claim B");
    assert.notInclude(rendered, "[P1-C4]");

    const pack = buildEvidencePack({
      papers: [paperA, paperB],
      candidates: [
        {
          paperKey: buildPaperKey(paperA),
          itemId: 1,
          contextItemId: 11,
          title: "Paper A",
          firstCreator: "Zheng et al.",
          year: "2026",
          chunkIndex: 3,
          chunkText:
            "Abstract\nDespite global representational drift, the relative geometry remained stable across conditions.",
          estimatedTokens: 8,
          bm25Score: 0.7,
          embeddingScore: 0.1,
          hybridScore: 0.4,
          evidenceScore: 1.3,
        },
      ],
    });
    assert.lengthOf(pack.quoteCitations, 1);
    assert.match(pack.quoteCitations[0].id, /^Q_/);
    assert.include(pack.contextText, `[[quote:${pack.quoteCitations[0].id}]]`);
  });

  it("builds chunk metadata with section labels and cleaned anchors", function () {
    const metadata = buildChunkMetadata([
      "Results\n\n23 activity. Representational drift increases over days.",
    ]);
    assert.lengthOf(metadata, 1);
    assert.equal(metadata[0].sectionLabel, "Results");
    assert.equal(metadata[0].chunkKind, "results");
    assert.equal(
      metadata[0].anchorText,
      "Representational drift increases over days.",
    );
    assert.isTrue(Boolean(metadata[0].leadingNoiseRemoved));
  });

  it("recognizes supplementary figure captions as figure-caption chunks", function () {
    const metadata = buildChunkMetadata([
      "Figure S7. Preserved relationship between place and grid cells across environments.",
    ]);
    assert.lengthOf(metadata, 1);
    assert.equal(metadata[0].chunkKind, "figure-caption");
  });

  it("keeps MinerU full.md text when manifest headings contain regex syntax", async function () {
    setupMemoryIO();
    const attachmentId = 1201;
    const specialHeading = "化粪池 $+$ 土地渗滤系统";
    const mdContent = [
      "# Introduction",
      "This paper introduces dry and cold region toilet renovation.",
      `# ${specialHeading}`,
      "This section compares septic tank plus soil infiltration systems.",
      "# Conclusion",
      "The paper recommends matching technologies to local constraints.",
    ].join("\n\n");

    await writeMineruCacheFiles(attachmentId, mdContent, [
      { relativePath: "paper/full.md", data: bytes(mdContent) },
      {
        relativePath: "paper/content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Introduction", page_idx: 0 },
            {
              type: "text",
              text_level: 1,
              text: specialHeading,
              page_idx: 1,
            },
            { type: "text", text_level: 1, text: "Conclusion", page_idx: 2 },
          ]),
        ),
      },
    ]);

    await ensurePDFTextCached(mockPdfAttachment(attachmentId));
    const context = pdfTextCache.get(attachmentId);
    assert.exists(context);
    const rendered = buildFullPaperContext(fullPaperRef(attachmentId), context);

    assert.include(rendered, "Paper Text:");
    assert.include(rendered, specialHeading);
    assert.include(rendered, "septic tank plus soil infiltration");
    assert.notInclude(
      rendered,
      "[No extractable PDF text available. Using metadata only.]",
    );
    assert.include(
      context!.chunkMeta.map((meta) => meta.sectionLabel),
      specialHeading,
    );
  });

  it("falls back to all MinerU markdown when manifest chunk metadata fails", async function () {
    const io = setupMemoryIO();
    const attachmentId = 1202;
    const mdContent = [
      "# Introduction",
      "The readable MinerU text should survive manifest failure.",
      "# Body",
      "Fallback-only text must still be visible to the model.",
      "# Conclusion",
      "The plugin must not degrade to metadata only.",
    ].join("\n\n");

    await writeMineruCacheFiles(attachmentId, mdContent, [
      { relativePath: "paper/full.md", data: bytes(mdContent) },
    ]);
    io.files.set(
      `/tmp/zotero/llm-for-zotero-mineru/${attachmentId}/manifest.json`,
      bytes(
        JSON.stringify({
          sections: [
            { heading: null, charStart: 0, charEnd: mdContent.length },
          ],
          totalChars: mdContent.length,
        }),
      ),
    );

    await ensurePDFTextCached(mockPdfAttachment(attachmentId));
    const context = pdfTextCache.get(attachmentId);
    assert.exists(context);
    const rendered = buildFullPaperContext(fullPaperRef(attachmentId), context);

    assert.include(rendered, "Paper Text:");
    assert.include(rendered, "Fallback-only text must still be visible");
    assert.notInclude(
      rendered,
      "[No extractable PDF text available. Using metadata only.]",
    );
    assert.isAbove(context!.chunks.length, 0);
    assert.equal(context!.fullLength, mdContent.length);
  });

  it("rebuilds stale MinerU manifests before chunking", async function () {
    const io = setupMemoryIO();
    const attachmentId = 1203;
    const mdV1 = [
      "# Introduction",
      "Old introduction.",
      "# Methods",
      "Old methods.",
      "# Conclusion",
      "Old conclusion.",
    ].join("\n\n");
    const mdV2 = [
      "# Introduction",
      "Updated introduction that should be sent to the model.",
      "# Methods",
      "Updated methods with more detail.",
      "# Conclusion",
      "Updated conclusion.",
    ].join("\n\n");

    await writeMineruCacheFiles(attachmentId, mdV1, [
      { relativePath: "paper/full.md", data: bytes(mdV1) },
      {
        relativePath: "paper/content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Introduction", page_idx: 0 },
            { type: "text", text_level: 1, text: "Methods", page_idx: 1 },
            { type: "text", text_level: 1, text: "Conclusion", page_idx: 2 },
          ]),
        ),
      },
    ]);
    io.files.set(
      `/tmp/zotero/llm-for-zotero-mineru/${attachmentId}/full.md`,
      bytes(mdV2),
    );

    await ensurePDFTextCached(mockPdfAttachment(attachmentId));
    const rebuiltManifest = await readManifest(attachmentId);
    const context = pdfTextCache.get(attachmentId);
    assert.exists(context);
    const rendered = buildFullPaperContext(fullPaperRef(attachmentId), context);

    assert.equal(rebuiltManifest?.totalChars, mdV2.length);
    assert.include(rendered, "Updated introduction that should be sent");
    assert.notInclude(rendered, "Old introduction.");
    assert.notInclude(
      rendered,
      "[No extractable PDF text available. Using metadata only.]",
    );
  });
});
