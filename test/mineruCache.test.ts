import { assert } from "chai";
import {
  normalizeMineruCacheFiles,
  readCachedMineruMd,
  readManifest,
  readMineruImageAsBase64,
  writeMineruCacheFiles,
  type MineruCacheFile,
} from "../src/modules/contextPanel/mineruCache";

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

  it("writes canonical full.md, images, and manifest content-list paths", async function () {
    setupMemoryIO();
    const originalImagePath = "Long Paper Title/auto/images/fig1.png";
    const mdContent = [
      "# Intro",
      `![Fig](${originalImagePath})`,
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
      mdContent.replace(originalImagePath, "images/fig1.png"),
    );
    assert.match(
      await readMineruImageAsBase64(42, "images/fig1.png"),
      /^data:image\/png;base64,/,
    );

    const manifest = await readManifest(42);
    assert.equal(manifest?.sections[0].figures[0].path, "images/fig1.png");
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
    ]);

    assert.equal(await readCachedMineruMd(51), mdContent);
    assert.match(
      await readMineruImageAsBase64(51, "images/fig1.png"),
      /^data:image\/png;base64,/,
    );
    assert.includeMembers(io.writes, [
      "/tmp/zotero/llm-for-zotero-mineru/51/full.md",
      "/tmp/zotero/llm-for-zotero-mineru/51/images/fig1.png",
      "/tmp/zotero/llm-for-zotero-mineru/51/content_list.json",
      "/tmp/zotero/llm-for-zotero-mineru/51/manifest.json",
    ]);

    const manifest = await readManifest(51);
    assert.equal(manifest?.sections[0].figures[0].path, "images/fig1.png");
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
    setupMemoryIO();
    await writeMineruCacheFiles(7, "# Simple\n![x](images/a.png)", [
      { relativePath: "full.md", data: bytes("# Simple\n![x](images/a.png)") },
      { relativePath: "images/a.png", data: bytes([9, 8, 7]) },
    ]);

    assert.equal(await readCachedMineruMd(7), "# Simple\n![x](images/a.png)");
    assert.match(
      await readMineruImageAsBase64(7, "images/a.png"),
      /^data:image\/png;base64,/,
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
    assert.includeMembers(io.writes, [
      "/tmp/zotero/llm-for-zotero-mineru/55/images/fig.png",
      "/tmp/zotero/llm-for-zotero-mineru/55/full.md",
    ]);
  });

  it("includes normalized and original paths in cache write errors", async function () {
    setupMemoryIO({ maxWritePathLength: 20 });

    try {
      await writeMineruCacheFiles(99, "# Intro", [
        { relativePath: "paper/full.md", data: bytes("# Intro") },
        { relativePath: "paper/images/fig.png", data: bytes([1]) },
      ]);
      assert.fail("Expected cache write to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.include(message, 'MinerU cache file "images/fig.png"');
      assert.include(message, '"paper/images/fig.png"');
      assert.notInclude(message, "{}");
    }
  });
});
