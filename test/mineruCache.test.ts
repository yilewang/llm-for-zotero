import { assert } from "chai";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  buildPdfFigureCropManifestHash,
} from "../src/services/pdf/pdfFigureCropCache";
import {
  buildAndWriteManifest,
  buildManifest,
  ensureManifest,
  finalizeMineruCacheFiles,
  validateMineruManifest,
  getMineruItemDir,
  MANIFEST_STRUCTURE_VERSION,
  isHeadingClassifiedDifferentlySinceV3,
  MINERU_SOURCE_PROVENANCE_KIND,
  MINERU_SOURCE_PROVENANCE_VERSION,
  normalizeMineruCacheFiles,
  readCachedMineruMd,
  readMineruSourceProvenance,
  readManifest,
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
  type MineruCacheFile,
} from "../src/services/mineru/mineruCache";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function setupMemoryIO(
  options: { maxWritePathLength?: number } = {},
): MemoryIO {
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
    makeDirectory: async (
      path: string,
      _opts?: { createAncestors?: boolean; ignoreExisting?: boolean },
    ) => {
      addDir(dirs, path);
    },
    write: async (path: string, data: Uint8Array) => {
      const normalized = normalizePath(path);
      if (
        options.maxWritePathLength &&
        normalized.length > options.maxWritePathLength
      ) {
        throw new Error(
          `Path exceeds ${options.maxWritePathLength} characters`,
        );
      }
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
      writes.push(normalized);
    },
    remove: async (
      path: string,
      _opts?: { recursive?: boolean; ignoreAbsent?: boolean },
    ) => {
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
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Profile: { dir: "/tmp/profile" },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };

  return { files, dirs, writes };
}

describe("mineruCache", function () {
  afterEach(function () {
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
  });

  it("withholds a cache read when publication starts while the file is being read", async function () {
    const memory = setupMemoryIO();
    await writeMineruCacheFiles(42, "# Intro", []);
    const io = (globalThis as any).IOUtils;
    const read = io.read;
    io.read = async (path: string) => {
      const data = await read(path);
      if (path.endsWith("/full.md"))
        memory.files.set(
          `${getMineruItemDir(42)}/_llm_write_pending.json`,
          bytes("{}"),
        );
      return data;
    };
    assert.isNull(await readCachedMineruMd(42));
  });
  it("accepts valid heading whitespace when verifying manifest offsets", function () {
    const md =
      "#  Introduction\n\nFirst\n\n#\tMethods\n\nSecond\n\n# Results\n\nThird";
    assert.doesNotThrow(() =>
      validateMineruManifest(md, buildManifest(md, [], 3), 3),
    );
  });
  it("rejects saved manifest page references outside its declared document", function () {
    const md = "# Intro\ntext";
    const manifest = buildManifest(
      md,
      [{ type: "text", text_level: 1, text: "Intro", page_idx: 400 }],
      200,
    );
    assert.throws(() => validateMineruManifest(md, manifest), /page index/);
  });
  it("preserves authoritative page totals when finalizing a saved sync package", function () {
    const md = "# Introduction\n\ntext";
    const manifest = buildManifest(
      md,
      [{ type: "text", text_level: 1, text: "Introduction", page_idx: 0 }],
      401,
    );
    const result = finalizeMineruCacheFiles(md, [
      { relativePath: "manifest.json", data: bytes(JSON.stringify(manifest)) },
      {
        relativePath: "content_list.json",
        data: bytes(
          '[{"type":"text","text_level":1,"text":"Introduction","page_idx":0}]',
        ),
      },
    ]);
    assert.equal(
      result.manifest.totalPages,
      401,
      "blank trailing pages remain part of the PDF",
    );
  });
  it("keeps repeated chapter headings attached to their own page and figures", function () {
    const md =
      "# Introduction\n\nfirst\n\n# Introduction\n\nsecond\n\n# Introduction\n\nthird";
    const list = [0, 200, 400].flatMap((page, index) => [
      { type: "text", text_level: 1, text: "Introduction", page_idx: page },
      {
        type: "image",
        img_path: `images/chunk-${index + 1}/figure.png`,
        image_caption: [`Fig. ${index + 1}`],
        page_idx: page,
      },
    ]);
    const manifest = buildManifest(md, list);
    assert.deepEqual(
      manifest.sections.map((section) => section.page),
      [0, 200, 400],
    );
    assert.deepEqual(
      manifest.sections.map((section) => section.figures[0].path),
      [
        "images/chunk-1/figure.png",
        "images/chunk-2/figure.png",
        "images/chunk-3/figure.png",
      ],
    );
    for (const section of manifest.sections)
      assert.match(
        md.slice(section.charStart, section.charEnd),
        /^# Introduction/,
      );
  });

  it("builds sections from ## and ### headings with levels and paths", function () {
    const md = [
      "# Paper title",
      "intro line",
      "## 1 Introduction",
      "text",
      "## 2 Algorithm",
      "text",
      "### 2.1 Weak form",
      "text",
      "### 2.2 Kinematic condition",
      "text",
      "## 3 Conclusion",
      "done",
    ].join("\n\n");
    const manifest = buildManifest(md, [
      { type: "text", text_level: 1, text: "Paper title", page_idx: 0 },
      { type: "text", text_level: 2, text: "2 Algorithm", page_idx: 1 },
      {
        type: "text",
        text_level: 3,
        text: "2.2 Kinematic condition",
        page_idx: 2,
      },
    ]);
    assert.isUndefined(manifest.noSections);
    assert.deepEqual(
      manifest.sections.map((s) => s.level),
      [1, 2, 2, 3, 3, 2],
    );
    assert.equal(
      manifest.sections[4].path,
      "2 Algorithm › 2.2 Kinematic condition",
    );
    assert.equal(manifest.sections[4].parentIndex, 2);
    assert.equal(manifest.sections[4].page, 2);
    assert.equal(manifest.sections[4].sectionId, "s4");
    assert.deepEqual(manifest.structure, {
      version: MANIFEST_STRUCTURE_VERSION,
      headingCounts: { h1: 1, h2: 3, h3: 2 },
      sectionsBuilt: 6,
      labelledChars: md.length - md.indexOf("# Paper title"),
    });
    assert.doesNotThrow(() => validateMineruManifest(md, manifest));
  });

  it("excludes a title block of several level-1 headings from section paths", function () {
    // Paper 4458 opens with an institute banner and then the paper title,
    // both level 1, before the first numbered section.
    const md = [
      "# Weierstraß-Institut für Angewandte Analysis und Stochastik",
      "preprint line",
      "# Numerics of thin-film free boundary problems",
      "author line",
      "## 1 Introduction",
      "text",
      "## 2 Algorithm",
      "text",
      "### 2.1 Weak form",
      "text",
    ].join("\n\n");
    const manifest = buildManifest(md, []);

    assert.deepEqual(
      manifest.sections.map((section) => section.path),
      [
        "Weierstraß-Institut für Angewandte Analysis und Stochastik",
        "Numerics of thin-film free boundary problems",
        "1 Introduction",
        "2 Algorithm",
        "2 Algorithm › 2.1 Weak form",
      ],
    );
  });

  it("keeps a stored manifest's figures when a rebuild has no content list", async function () {
    const memory = setupMemoryIO();
    const md = [
      "# Paper title",
      "intro line",
      "## 1 Introduction",
      "text",
      "## 2 Algorithm",
      "Figure 1 shows the mesh.",
    ].join("\n\n");
    await writeMineruCacheFiles(78, md, []);
    const figure = {
      label: "Figure 1",
      baseLabel: "Figure 1",
      path: "images/fig1.png",
      caption: "Figure 1. The adaptive mesh.",
      page: 3,
    };
    const table = {
      label: "Table 1",
      baseLabel: "Table 1",
      path: "images/tbl1.png",
      caption: "Table 1. Runtimes.",
      page: 4,
    };
    const stored = {
      sections: [
        {
          heading: "Paper title",
          level: 1,
          sectionId: "s0",
          path: "Paper title",
          charStart: 0,
          charEnd: md.length,
          figures: [],
          tables: [],
          equationCount: 0,
        },
        {
          heading: "2 Algorithm",
          level: 2,
          sectionId: "s1",
          path: "2 Algorithm",
          charStart: md.indexOf("## 2 Algorithm"),
          charEnd: md.length,
          figures: [figure],
          tables: [table],
          equationCount: 7,
        },
      ],
      allFigures: [{ ...figure, section: "2 Algorithm" }],
      allTables: [{ ...table, section: "2 Algorithm" }],
      totalChars: md.length,
      structure: {
        version: 2 as const,
        headingCounts: { h1: 1, h2: 2, h3: 0 },
        sectionsBuilt: 2,
        labelledChars: md.length,
      },
    };
    memory.files.set(
      `${getMineruItemDir(78)}/manifest.json`,
      bytes(JSON.stringify(stored)),
    );

    const rebuilt = await buildAndWriteManifest(78);
    assert.exists(rebuilt);
    assert.deepEqual(rebuilt!.allFigures, stored.allFigures);
    assert.deepEqual(rebuilt!.allTables, stored.allTables);
    const algorithm = rebuilt!.sections.find(
      (section) => section.heading === "2 Algorithm",
    );
    assert.deepEqual(algorithm?.figures, [figure]);
    assert.deepEqual(algorithm?.tables, [table]);
    assert.equal(algorithm?.equationCount, 7);
    const introduction = rebuilt!.sections.find(
      (section) => section.heading === "1 Introduction",
    );
    assert.deepEqual(
      introduction?.figures,
      [],
      "unmatched sections stay empty",
    );
  });

  it("hashes only the figure fields of a manifest for the crop cache", function () {
    const manifest = {
      sections: [
        {
          heading: "2 Algorithm",
          level: 2,
          sectionId: "s1",
          path: "2 Algorithm",
          charStart: 10,
          charEnd: 40,
          figures: [
            {
              label: "Figure 1",
              baseLabel: "Figure 1",
              path: "images/fig1.png",
              caption: "Figure 1. Mesh.",
              page: 2,
            },
          ],
          tables: [],
          equationCount: 0,
        },
      ],
      allFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          path: "images/fig1.png",
          caption: "Figure 1. Mesh.",
          page: 2,
          section: "2 Algorithm",
        },
      ],
      allTables: [],
      totalPages: 12,
      totalChars: 400,
    };
    const baseline = buildPdfFigureCropManifestHash(manifest);

    const withStructure = {
      ...manifest,
      structure: {
        version: 2,
        headingCounts: { h1: 1, h2: 1, h3: 0 },
        sectionsBuilt: 2,
        labelledChars: 400,
      },
    };
    assert.equal(
      buildPdfFigureCropManifestHash(withStructure),
      baseline,
      "a structure block is not figure geometry",
    );

    const withRenamedPath = {
      ...manifest,
      sections: [
        {
          ...manifest.sections[0],
          level: 3,
          path: "2 Algorithm › 2.1 Weak form",
        },
      ],
    };
    assert.equal(
      buildPdfFigureCropManifestHash(withRenamedPath),
      baseline,
      "section levels and heading paths are not figure geometry",
    );

    const withMovedFigure = {
      ...manifest,
      allFigures: [{ ...manifest.allFigures[0], path: "images/fig1-new.png" }],
    };
    assert.notEqual(
      buildPdfFigureCropManifestHash(withMovedFigure),
      baseline,
      "a figure's image path is figure geometry",
    );
  });

  it("rebuilds a stored manifest that predates structure version 2", async function () {
    const memory = setupMemoryIO();
    const md = [
      "# Paper title",
      "intro line",
      "## 1 Introduction",
      "text",
      "## 2 Algorithm",
      "text",
      "### 2.1 Weak form",
      "text",
      "## 3 Conclusion",
      "done",
    ].join("\n\n");
    await writeMineruCacheFiles(77, md, [
      {
        relativePath: "content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Paper title", page_idx: 0 },
            { type: "text", text_level: 2, text: "2 Algorithm", page_idx: 1 },
          ]),
        ),
      },
    ]);
    const legacyManifest = {
      sections: [
        {
          heading: "Paper title",
          charStart: 0,
          charEnd: md.length,
          figures: [],
          tables: [],
          equationCount: 0,
        },
      ],
      allFigures: [],
      allTables: [],
      figureBlocks: [
        {
          blockId: "block-1",
          kind: "figure",
          imagePaths: ["images/fig1.png"],
          markdownStart: 0,
          markdownEnd: 10,
          contextStart: 0,
          contextEnd: 20,
          labelHints: ["Figure 1"],
          captionHints: ["Figure 1. Overview."],
          sectionHeading: "2 Algorithm",
          confidence: "high",
          ambiguous: false,
        },
      ],
      totalChars: md.length,
      noSections: true,
    };
    memory.files.set(
      `${getMineruItemDir(77)}/manifest.json`,
      bytes(JSON.stringify(legacyManifest)),
    );

    const stored = await readManifest(77);
    assert.equal(stored?.sections.length, 1, "legacy manifests stay readable");
    assert.isUndefined(stored?.structure);

    const rebuilt = await ensureManifest(77);
    assert.equal(rebuilt?.structure?.version, MANIFEST_STRUCTURE_VERSION);
    assert.isAbove(rebuilt!.sections.length, 2);
    assert.isUndefined(rebuilt?.noSections);
    assert.deepEqual(
      rebuilt?.figureBlocks,
      legacyManifest.figureBlocks as typeof rebuilt.figureBlocks,
      "a rebuild keeps figure blocks the stripped full.md can no longer yield",
    );

    const persisted = await readManifest(77);
    assert.equal(persisted?.structure?.version, MANIFEST_STRUCTURE_VERSION);
    assert.deepEqual(
      persisted?.sections.map((s) => s.level),
      [1, 2, 2, 3, 2],
    );
    assert.equal(persisted?.sections[2].page, 1);
  });

  describe("short headings", function () {
    const CJK_MD = [
      "# 海马位置细胞的表征漂移",
      "## 摘要",
      "本文研究表征漂移。",
      "## 引言",
      "位置细胞缓慢漂移。",
      "## 方法",
      "我们记录了四十个细胞。",
      "## 结果",
      "解码准确率高于随机水平。",
      "## 讨论",
      "漂移与解码可以共存。",
      "## 结论",
      "漂移不妨碍解码。",
      "## 결과",
      "결과는 안정적이었다.",
      "## 結果",
      "結果は安定していた。",
    ].join("\n\n");

    it("keeps two-character Chinese, Japanese and Korean headings as sections", function () {
      const manifest = buildManifest(CJK_MD, [
        { type: "text", text_level: 2, text: "结果", page_idx: 3 },
      ]);
      assert.deepEqual(
        manifest.sections.map((section) => section.heading),
        [
          "海马位置细胞的表征漂移",
          "摘要",
          "引言",
          "方法",
          "结果",
          "讨论",
          "结论",
          "결과",
          "結果",
        ],
      );
      // The content list's two-character heading gives its section a page.
      assert.equal(
        manifest.sections.find((section) => section.heading === "结果")?.page,
        3,
      );
    });

    it("still drops short noise: Latin fragments, numbers, punctuation and a lone CJK character", function () {
      const md = [
        "# Drift",
        "## a",
        "Stray text.",
        "## 1.",
        "More text.",
        "## 图",
        "A figure fragment.",
        "## 、。",
        "Punctuation.",
        "## Results",
        "Decoding held.",
      ].join("\n\n");
      assert.deepEqual(
        buildManifest(md, []).sections.map((section) => section.heading),
        ["Drift", "Results"],
      );
    });

    it("drops CJK figure and table labels as headings while keeping 结果", function () {
      const md = [
        "# 漂移",
        "## 图1",
        "A figure label.",
        "## 表 2",
        "A table label.",
        "## 图 3",
        "Another figure label.",
        "## 圖4a",
        "A figure label.",
        "## 结果",
        "解码准确率高于随机水平。",
      ].join("\n\n");
      assert.deepEqual(
        buildManifest(md, []).sections.map((section) => section.heading),
        ["漂移", "结果"],
      );
    });

    it("names the headings that structure version 3 classifies differently from version 2", function () {
      // Kept now, dropped before (short CJK), or dropped now, kept before
      // (three-character figure and table labels).
      for (const changed of [
        "结果",
        "方法",
        "결과",
        "結果",
        " 结果 ",
        "图12",
        "表 3",
        "图 1",
        "圖4a",
      ])
        assert.isTrue(isHeadingClassifiedDifferentlySinceV3(changed), changed);
      for (const same of [
        "图1",
        "图",
        "a",
        "1.",
        "Results",
        "Figure 12",
        "一、引言",
        "三、结果与讨论",
      ])
        assert.isFalse(isHeadingClassifiedDifferentlySinceV3(same), same);
    });

    it("rebuilds a manifest of the previous structure version, which dropped the short headings", async function () {
      const memory = setupMemoryIO();
      await writeMineruCacheFiles(78, CJK_MD, []);
      const stale = {
        ...buildManifest(CJK_MD, []),
        sections: [],
        structure: {
          version: MANIFEST_STRUCTURE_VERSION - 1,
          headingCounts: { h1: 1, h2: 0, h3: 0 },
          sectionsBuilt: 1,
          labelledChars: 10,
        },
      };
      memory.files.set(
        `${getMineruItemDir(78)}/manifest.json`,
        bytes(JSON.stringify(stale)),
      );
      const rebuilt = await ensureManifest(78);
      assert.equal(rebuilt?.structure?.version, MANIFEST_STRUCTURE_VERSION);
      assert.include(
        rebuilt!.sections.map((section) => section.heading),
        "结果",
      );
    });
  });

  describe("manifest figure grouping", function () {
    it("stores base labels for compound figure entries in the manifest", function () {
      const md = [
        "# Abstract",
        "Opening text.",
        "# Results",
        "![Fig 1a](images/fig1a.png)",
        "![Fig 1b](images/fig1b.png)",
        "# Discussion",
        "Closing text.",
      ].join("\n\n");

      const manifest = buildManifest(md, [
        { type: "text", text_level: 1, text: "Abstract", page_idx: 0 },
        { type: "text", text_level: 1, text: "Results", page_idx: 1 },
        {
          type: "image",
          img_path: "images/fig1a.png",
          image_caption: ["Figure 1a. Screening path."],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/fig1b.png",
          image_caption: ["Figure 1b. Validation path."],
          page_idx: 1,
        },
        { type: "text", text_level: 1, text: "Discussion", page_idx: 2 },
      ]);

      assert.deepEqual(
        manifest.allFigures.map((figure) => figure.baseLabel),
        ["Figure 1", "Figure 1"],
      );
      assert.deepEqual(
        manifest.sections[1].figures.map((figure) => figure.path),
        ["images/fig1a.png", "images/fig1b.png"],
      );
      assert.deepEqual(manifest.figureBlocks?.[0]?.imagePaths, [
        "images/fig1a.png",
        "images/fig1b.png",
      ]);
    });
  });

  it("normalizes long MinerU root/container paths and rewrites references", function () {
    const title = "A ".repeat(90).trim();
    const originalImagePath = `${title}/auto/images/fig1.png`;
    const originalContentListPath = `${title}/auto/${title}_content_list.json`;
    const files: MineruCacheFile[] = [
      {
        relativePath: `${title}/auto/${title}.md`,
        data: bytes(`# Intro\n![Fig](${originalImagePath})`),
      },
      { relativePath: originalImagePath, data: bytes([1, 2, 3]) },
      {
        relativePath: originalContentListPath,
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Intro", page_idx: 0 },
            {
              type: "image",
              img_path: originalImagePath,
              image_caption: ["Fig. 1 caption"],
              page_idx: 0,
            },
          ]),
        ),
      },
    ];

    const normalized = normalizeMineruCacheFiles(
      `# Intro\n![Fig](${originalImagePath})`,
      files,
    );

    assert.include(normalized.mdContent, "](images/fig1.png)");
    assert.sameMembers(
      normalized.files.map((file) => file.relativePath),
      ["images/fig1.png", "content_list.json"],
    );
    assert.isFalse(
      normalized.files.some((file) => file.relativePath.includes(title)),
    );

    const contentList = normalized.files.find(
      (file) => file.relativePath === "content_list.json",
    );
    assert.exists(contentList);
    const parsed = JSON.parse(decoder.decode(contentList!.data));
    assert.equal(parsed[1].img_path, "images/fig1.png");
  });

  it("keeps an explicit merged content list canonical when chunk archives contain aliases", function () {
    const mergedContentList = [
      { type: "text", text: "first", page_idx: 0 },
      { type: "text", text: "second", page_idx: 200 },
    ];
    const normalized = normalizeMineruCacheFiles("# Merged", [
      {
        relativePath: "images/chunk-001/first_content_list.json",
        data: bytes('[{"type":"text","text":"first","page_idx":0}]'),
      },
      {
        relativePath: "images/chunk-002/second_content_list.json",
        data: bytes('[{"type":"text","text":"second","page_idx":0}]'),
      },
      {
        relativePath: "content_list.json",
        data: bytes(JSON.stringify(mergedContentList)),
      },
    ]);

    const canonicalFiles = normalized.files.filter(
      (file) => file.relativePath === "content_list.json",
    );
    assert.lengthOf(canonicalFiles, 1);
    assert.deepEqual(
      JSON.parse(decoder.decode(canonicalFiles[0].data)),
      mergedContentList,
    );
  });

  it("writes stripped full.md while preserving logical figure paths in manifest", async function () {
    const io = setupMemoryIO();
    const originalImagePath = "Long Paper Title/auto/images/fig1.png";
    const mdContent = [
      "# Intro",
      `![Fig](${originalImagePath})`,
      "Fig. 1 caption",
      "# Methods",
      "methods",
      "# Results",
      "results",
    ].join("\n");

    await writeMineruCacheFiles(42, mdContent, [
      {
        relativePath: "Long Paper Title/auto/Long Paper Title.md",
        data: bytes(mdContent),
      },
      { relativePath: originalImagePath, data: bytes([1, 2, 3, 4]) },
      {
        relativePath:
          "Long Paper Title/auto/Long Paper Title_content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Intro", page_idx: 0 },
            {
              type: "image",
              img_path: originalImagePath,
              image_caption: ["Fig. 1 caption"],
              page_idx: 0,
            },
            { type: "text", text_level: 1, text: "Methods", page_idx: 1 },
            { type: "text", text_level: 1, text: "Results", page_idx: 2 },
          ]),
        ),
      },
    ]);

    assert.equal(
      await readCachedMineruMd(42),
      [
        "# Intro",
        "Fig. 1 caption",
        "# Methods",
        "methods",
        "# Results",
        "results",
      ].join("\n"),
    );
    assert.isTrue(
      io.files.has("/tmp/zotero/llm-for-zotero-mineru/42/images/fig1.png"),
    );

    const manifest = await readManifest(42);
    assert.equal(manifest?.sections[0].figures[0].path, "images/fig1.png");
    assert.deepEqual(manifest?.figureBlocks?.[0]?.imagePaths, [
      "images/fig1.png",
    ]);
  });

  it("normalizes local MinerU nested ZIP output into agent-readable cache files", async function () {
    const io = setupMemoryIO();
    const archiveImagePath = "paper/pipeline/images/fig1.png";
    const imageRefPath = "images/fig1.png";
    const mdContent = [
      "# Intro",
      `![Fig](${imageRefPath})`,
      "# Results",
      "results",
    ].join("\n");

    await writeMineruCacheFiles(51, mdContent, [
      {
        relativePath: "paper/pipeline/full.md",
        data: bytes(mdContent),
      },
      {
        relativePath: archiveImagePath,
        data: bytes([1, 2, 3, 4]),
      },
      {
        relativePath: "paper/pipeline/paper_content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Intro", page_idx: 0 },
            {
              type: "image",
              img_path: imageRefPath,
              image_caption: ["Fig. 1 caption"],
              page_idx: 0,
            },
            { type: "text", text_level: 1, text: "Results", page_idx: 1 },
          ]),
        ),
      },
      {
        relativePath: "paper/pipeline/layout.json",
        data: bytes("{}"),
      },
      {
        relativePath: "paper/pipeline/middle.json",
        data: bytes("{}"),
      },
      {
        relativePath: "paper/pipeline/tables/table-1.png",
        data: bytes([1, 2, 3]),
      },
    ]);

    assert.equal(await readCachedMineruMd(51), "# Intro\n# Results\nresults");
    assert.includeMembers(io.writes, [
      "/tmp/zotero/llm-for-zotero-mineru/51/full.md",
      "/tmp/zotero/llm-for-zotero-mineru/51/content_list.json",
      "/tmp/zotero/llm-for-zotero-mineru/51/manifest.json",
    ]);
    assert.include(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/51/images/fig1.png",
    );
    assert.notInclude(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/51/layout.json",
    );
    assert.notInclude(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/51/middle.json",
    );
    assert.notInclude(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/51/tables/table-1.png",
    );

    const manifest = await readManifest(51);
    assert.equal(manifest?.sections[0].figures[0].path, "images/fig1.png");
    assert.deepEqual(manifest?.figureBlocks?.[0]?.imagePaths, [
      "images/fig1.png",
    ]);
  });

  it("skips unsafe archive paths", function () {
    const normalized = normalizeMineruCacheFiles("# Intro", [
      { relativePath: "paper/full.md", data: bytes("# Intro") },
      { relativePath: "../evil.png", data: bytes([1]) },
      { relativePath: "/tmp/evil.png", data: bytes([2]) },
      { relativePath: "C:\\tmp\\evil.png", data: bytes([3]) },
      { relativePath: "C:tmp/evil.png", data: bytes([4]) },
      { relativePath: "\\\\server\\share\\evil.png", data: bytes([4]) },
      { relativePath: "paper/images/good.png", data: bytes([5]) },
    ]);

    assert.deepEqual(
      normalized.files.map((file) => file.relativePath),
      ["images/good.png"],
    );
  });

  it("keeps simple cache layouts readable", async function () {
    const io = setupMemoryIO();
    await writeMineruCacheFiles(7, "# Simple\n![x](images/a.png)", [
      { relativePath: "full.md", data: bytes("# Simple\n![x](images/a.png)") },
      { relativePath: "images/a.png", data: bytes([9, 8, 7]) },
    ]);

    assert.equal(await readCachedMineruMd(7), "# Simple");
    assert.isTrue(
      io.files.has("/tmp/zotero/llm-for-zotero-mineru/7/images/a.png"),
    );
  });

  it("does not persist raw MinerU source images after figure crops are ready", async function () {
    const io = setupMemoryIO();
    const itemDir = "/tmp/zotero/llm-for-zotero-mineru/77";
    const cropPath = `${itemDir}/figure_crops/crops/figure-1.png`;
    const markdown = [
      "# Results",
      "![Figure 1](images/fig1.png)",
      "Figure 1. Better crop replacement.",
    ].join("\n");
    const contentList = [
      { type: "text", text_level: 1, text: "Results", page_idx: 0 },
      {
        type: "image",
        img_path: "images/fig1.png",
        image_caption: ["Figure 1. Better crop replacement."],
        page_idx: 0,
      },
    ];
    const sourceManifest = buildManifest(markdown, contentList);
    const canonicalManifest = buildManifest(
      "# Results\nFigure 1. Better crop replacement.",
      contentList,
    );
    const finalizedManifest = {
      ...canonicalManifest,
      figureBlocks: sourceManifest.figureBlocks,
    };
    io.files.set(cropPath, bytes([137, 80, 78, 71, 1]));
    io.files.set(
      `${itemDir}/figure_crops/figure_geometry.json`,
      bytes(
        JSON.stringify({
          version: PDF_FIGURE_CROP_CACHE_VERSION,
          attachmentId: 77,
          manifestHash: buildPdfFigureCropManifestHash(finalizedManifest),
          pdfFingerprint: "test",
          renderScale: 1.8,
          algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
          generatedAt: 1,
          expectedFigures: [
            {
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 1,
              status: "ok",
              cropPath,
            },
          ],
          missingFigures: [],
          entries: [
            {
              id: "figure-1",
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 1,
              cropPath,
              rect: { left: 0, top: 0, width: 100, height: 100 },
              confidence: 0.9,
              source: "pdf-image-object",
              warnings: [],
              mineruImagePaths: [],
            },
          ],
        }),
      ),
    );
    await writeMineruCacheFiles(77, markdown, [
      { relativePath: "full.md", data: bytes(markdown) },
      {
        relativePath: "content_list.json",
        data: bytes(JSON.stringify(contentList)),
      },
      {
        relativePath: "images/fig1.png",
        data: bytes([137, 80, 78, 71, 2]),
      },
    ]);

    assert.isFalse(
      io.files.has("/tmp/zotero/llm-for-zotero-mineru/77/images/fig1.png"),
    );
    assert.isTrue(io.files.has(cropPath));
  });

  it("keeps compound figure metadata without source image files", async function () {
    const io = setupMemoryIO();
    const markdown = [
      "## Results",
      "",
      "![Figure 2a](images/fig2a.png)",
      "",
      "![Figure 2b](images/fig2b.png)",
      "",
      "![Figure 2c](images/fig2c.png)",
      "",
      "Figure 2. Attractor network for probabilistic decision-making.",
    ].join("\n");
    await writeMineruCacheFiles(78, markdown, [
      { relativePath: "full.md", data: bytes(markdown) },
      {
        relativePath: "paper_content_list.json",
        data: bytes(
          JSON.stringify([
            {
              type: "image",
              img_path: "images/fig2a.png",
              image_caption: ["Figure 2. Attractor network."],
            },
            { type: "image", img_path: "images/fig2b.png" },
            { type: "image", img_path: "images/fig2c.png" },
          ]),
        ),
      },
      { relativePath: "images/fig2a.png", data: bytes([137, 80, 78, 71, 1]) },
      { relativePath: "images/fig2b.png", data: bytes([137, 80, 78, 71, 2]) },
      { relativePath: "images/fig2c.png", data: bytes([137, 80, 78, 71, 3]) },
    ]);

    const manifest = await readManifest(78);
    assert.deepEqual(manifest?.figureBlocks?.[0]?.imagePaths, [
      "images/fig2a.png",
      "images/fig2b.png",
      "images/fig2c.png",
    ]);
    for (const name of ["fig2a", "fig2b", "fig2c"]) {
      assert.isTrue(
        io.files.has(`/tmp/zotero/llm-for-zotero-mineru/78/images/${name}.png`),
      );
    }
  });

  it("writes lightweight parsed source metadata without fingerprinting the PDF", async function () {
    const io = setupMemoryIO();
    const pdfPath = "/tmp/zotero/storage/42/paper.pdf";
    const parent = {
      id: 10,
      key: "PARENTKEY",
      isRegularItem: () => true,
      isAttachment: () => false,
      getAttachments: () => [42],
    };
    const pdf = {
      id: 42,
      key: "PDFKEY",
      parentID: 10,
      attachmentFilename: "paper.pdf",
      attachmentContentType: "application/pdf",
      isRegularItem: () => false,
      isAttachment: () => true,
      getFilePathAsync: async () => {
        throw new Error("source metadata should not read PDF bytes");
      },
    };
    (globalThis as any).Zotero.Items = {
      get: (id: number) => (id === 10 ? parent : id === 42 ? pdf : null),
    };
    io.files.set(normalizePath(pdfPath), bytes([1, 2, 3, 4, 5]));

    await writeMineruCacheFiles(42, "# Intro", []);
    const written = await writeMineruSourceProvenanceForAttachment(
      pdf as unknown as Zotero.Item,
    );

    const raw = JSON.parse(
      decoder.decode(
        io.files.get(
          normalizePath(
            "/tmp/zotero/llm-for-zotero-mineru/42/_llm_source.json",
          ),
        )!,
      ),
    );
    assert.equal(raw.kind, MINERU_SOURCE_PROVENANCE_KIND);
    assert.equal(raw.version, MINERU_SOURCE_PROVENANCE_VERSION);
    assert.equal(raw.origin, "parsed");
    assert.equal(raw.parsedAt, raw.recordedAt);
    assert.notProperty(raw, "sourceFingerprint");
    assert.notProperty(raw, "provenanceStatus");

    const provenance = await readMineruSourceProvenance(42);
    assert.deepEqual(provenance, written);
    assert.equal(provenance?.attachmentKey, "PDFKEY");
    assert.equal(provenance?.parentItemKey, "PARENTKEY");
  });

  it("reads legacy source metadata without preserving fingerprint state", async function () {
    const io = setupMemoryIO();
    io.files.set(
      normalizePath("/tmp/zotero/llm-for-zotero-mineru/51/_llm_source.json"),
      bytes(
        JSON.stringify({
          attachmentId: 51,
          attachmentKey: "PDFMETA",
          sourceFilename: "original.pdf",
          sourceFingerprint: {
            kind: "file-chunk-hash",
            value: "fnv1a32-legacy",
            size: 4,
            strong: true,
          },
          provenanceStatus: "legacy_unverified",
          parsedAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
    );

    const provenance = await readMineruSourceProvenance(51);

    assert.equal(provenance?.kind, MINERU_SOURCE_PROVENANCE_KIND);
    assert.equal(provenance?.version, MINERU_SOURCE_PROVENANCE_VERSION);
    assert.equal(provenance?.origin, "parsed");
    assert.equal(provenance?.recordedAt, "2020-01-01T00:00:00.000Z");
    assert.equal(provenance?.parsedAt, "2020-01-01T00:00:00.000Z");
    assert.notProperty(
      provenance as Record<string, unknown>,
      "sourceFingerprint",
    );
    assert.notProperty(
      provenance as Record<string, unknown>,
      "provenanceStatus",
    );
  });

  it("keeps normalized writes below a Windows-style path limit", async function () {
    const io = setupMemoryIO({ maxWritePathLength: 260 });
    const title = "Long Windows Path Title ".repeat(12).trim();
    await writeMineruCacheFiles(
      55,
      `# Intro\n![Fig](${title}/auto/images/fig.png)`,
      [
        {
          relativePath: `${title}/auto/${title}.md`,
          data: bytes("# Intro"),
        },
        {
          relativePath: `${title}/auto/images/fig.png`,
          data: bytes([1, 2, 3]),
        },
      ],
    );

    assert.isTrue(io.writes.every((path) => path.length <= 260));
    assert.include(io.writes, "/tmp/zotero/llm-for-zotero-mineru/55/full.md");
    assert.include(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/55/images/fig.png",
    );
  });

  it("ignores unknown MinerU artifacts instead of writing them", async function () {
    const io = setupMemoryIO();

    await writeMineruCacheFiles(99, "# Intro", [
      { relativePath: "paper/full.md", data: bytes("# Intro") },
      {
        relativePath:
          "paper/very-long-nonimage-artifact-name-that-still-gets-written.txt",
        data: bytes([1]),
      },
    ]);

    assert.equal(await readCachedMineruMd(99), "# Intro");
    assert.notInclude(
      io.writes,
      "/tmp/zotero/llm-for-zotero-mineru/99/very-long-nonimage-artifact-name-that-still-gets-written.txt",
    );
  });
});
