import { assert } from "chai";
import {
  buildTurnWindow,
  decideSavedFileClick,
  detectSavedFiles,
  displayLocalPath,
  extractLocalFilePaths,
  formatFileSize,
  isShowableSavedFile,
  resolveAgentFilesTargetForPanelItem,
  resolveTurnSavedFiles,
  SAVED_FILE_CARD_IMAGE_MAX_BYTES,
  savedFileCardPreviewKind,
  SAVED_FILE_PREVIEW_MAX_BYTES,
  SAVED_FILES_MANIFEST,
  savedFilePreviewKind,
  savedFileTile,
  savedFileTypeLabel,
} from "../src/modules/contextPanel/savedFileCards";

type Globals = { Zotero?: unknown; IOUtils?: unknown };
type FakeEntry = { dir?: boolean; mtime: number; data?: Uint8Array };

/** A tiny file system behind the IOUtils calls the cards make. */
function installFs(entries: Record<string, FakeEntry>) {
  const files = new Map(Object.entries(entries));
  (globalThis as typeof globalThis & Globals).IOUtils = {
    exists: async (path: string) => files.has(path),
    stat: async (path: string) => {
      const entry = files.get(path);
      if (!entry) throw new Error("missing");
      return {
        type: entry.dir ? "directory" : "regular",
        size: entry.data?.length || 10,
        lastModified: entry.mtime,
      };
    },
    getChildren: async (path: string) =>
      [...files.keys()].filter(
        (key) =>
          key.startsWith(`${path}/`) &&
          !key.slice(path.length + 1).includes("/"),
      ),
    read: async (path: string) => {
      const entry = files.get(path);
      if (!entry?.data) throw new Error("missing");
      return entry.data;
    },
    write: async (path: string, data: Uint8Array) => {
      files.set(path, { mtime: Date.now(), data });
    },
    makeDirectory: async (path: string) => {
      if (!files.has(path)) files.set(path, { dir: true, mtime: Date.now() });
    },
  };
  return files;
}

describe("Saved file cards", function () {
  const globals = globalThis as typeof globalThis & Globals;
  let savedZotero: unknown;
  let savedIOUtils: unknown;
  beforeEach(function () {
    savedZotero = globals.Zotero;
    savedIOUtils = globals.IOUtils;
    globals.Zotero = {
      DataDirectory: { dir: "/data" },
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Items: {
        get: (id: number) =>
          id === 10
            ? {
                key: "ABCD1234",
                getField: () => "",
                getCreators: () => [],
              }
            : undefined,
      },
    };
  });
  afterEach(function () {
    globals.Zotero = savedZotero;
    globals.IOUtils = savedIOUtils;
  });

  const folder = "/data/llm-for-zotero-files/ABCD1234";

  it("finds the paths an answer names, in order, once each", function () {
    const text = [
      "Created [FIP-explained.html](file:///Users/me/Desktop/FIP-explained.html).",
      "Also saved `~/Desktop/data.csv` and /Users/me/notes/summary.md.",
      `And ${folder} - My Paper/page one.html too.`,
      "Again: /Users/me/notes/summary.md, plus /usr/bin/tool (no extension).",
    ].join("\n");
    assert.deepEqual(
      extractLocalFilePaths(text, {
        homeDir: "/Users/me",
        folder: `${folder} - My Paper`,
      }),
      [
        "/Users/me/Desktop/FIP-explained.html",
        "/Users/me/Desktop/data.csv",
        "/Users/me/notes/summary.md",
        `${folder} - My Paper/page one.html`,
      ],
    );
  });

  it("keeps a named file outside the folder only if the turn changed it", async function () {
    const window = { start: 1000, end: 2000 };
    installFs({
      "/Users/me/Desktop/new.html": { mtime: 1500 },
      "/Users/me/Desktop/old.html": { mtime: 10 },
      "/data/storage/X/paper.pdf": { mtime: 1500 },
    });
    const found = await detectSavedFiles({
      text: "See /Users/me/Desktop/new.html, /Users/me/Desktop/old.html, /Users/me/Desktop/gone.html and /data/storage/X/paper.pdf",
      folder: null,
      window,
    });
    assert.deepEqual(found, ["/Users/me/Desktop/new.html"]);
  });

  it("adds files the turn saved in the folder, but not scratch or hidden ones", async function () {
    installFs({
      [folder]: { dir: true, mtime: 1 },
      [`${folder}/page.html`]: { mtime: 1500 },
      [`${folder}/earlier.html`]: { mtime: 500 },
      [`${folder}/.llm-files.json`]: { mtime: 1500 },
      [`${folder}/.work`]: { dir: true, mtime: 1500 },
      [`${folder}/.work/helper.py`]: { mtime: 1500 },
      [`${folder}/run.log`]: { mtime: 1500 },
    });
    const found = await detectSavedFiles({
      text: "Done.",
      folder,
      window: { start: 1000, end: 2000 },
    });
    assert.deepEqual(found, [`${folder}/page.html`]);
  });

  it("records a turn's files so a deleted file keeps its card", async function () {
    const files = installFs({
      [folder]: { dir: true, mtime: 1 },
      [`${folder}/page.html`]: { mtime: Date.now() },
    });
    const params = {
      target: { kind: "paper" as const, itemId: 10 },
      conversationKey: 77,
      assistantTimestamp: 123456,
      text: "Saved the page.",
      window: { start: Date.now() - 60_000, end: Date.now() + 60_000 },
    };
    assert.deepEqual(await resolveTurnSavedFiles(params), [
      `${folder}/page.html`,
    ]);
    const manifest = files.get(`${folder}/${SAVED_FILES_MANIFEST}`);
    assert.ok(manifest?.data);
    files.delete(`${folder}/page.html`);
    assert.deepEqual(await resolveTurnSavedFiles(params), [
      `${folder}/page.html`,
    ]);
  });

  it("bounds a turn by the next question, at most two hours on", function () {
    assert.deepEqual(
      buildTurnWindow({
        userTimestamp: 10_000,
        assistantTimestamp: 11_000,
        nextUserTimestamp: 50_000,
      }),
      { start: 5_000, end: 45_000 },
    );
    // Neighbouring turns meet without overlapping: a file saved early in the
    // second turn belongs to it alone.
    const first = buildTurnWindow({
      userTimestamp: 10_000,
      assistantTimestamp: 11_000,
      nextUserTimestamp: 50_000,
    });
    const second = buildTurnWindow({
      userTimestamp: 50_000,
      assistantTimestamp: 60_000,
    });
    assert.equal(first.end, second.start);
    const open = buildTurnWindow({
      userTimestamp: 10_000,
      assistantTimestamp: 11_000,
    });
    assert.equal(open.end, 11_000 + 2 * 60 * 60 * 1000 + 5_000);
  });

  it("picks a paper chat's paper, a PDF's parent, and a library chat's library", function () {
    assert.deepEqual(
      resolveAgentFilesTargetForPanelItem({
        id: 5,
        parentID: 10,
        isAttachment: () => true,
      }),
      { kind: "paper", itemId: 10 },
    );
    assert.deepEqual(
      resolveAgentFilesTargetForPanelItem({
        id: 10,
        isAttachment: () => false,
      }),
      { kind: "paper", itemId: 10 },
    );
    assert.isNull(resolveAgentFilesTargetForPanelItem(null));
  });

  it("knows which files it can show and shortens home paths", function () {
    assert.equal(savedFilePreviewKind("/a/B.HTML"), "html");
    assert.equal(savedFilePreviewKind("/a/b.md"), "markdown");
    assert.equal(savedFilePreviewKind("/a/b.png"), "image");
    assert.equal(savedFilePreviewKind("/a/b.docx"), "none");
    assert.equal(
      displayLocalPath("/Users/me/Desktop/x.html", "/Users/me"),
      "~/Desktop/x.html",
    );
  });

  it("names the file type and size for the card footer", function () {
    const id = (en: string) => en;
    assert.equal(savedFileTypeLabel("/a/b.html", id), "Web page");
    assert.equal(savedFileTypeLabel("/a/b.md", id), "Markdown note");
    assert.equal(savedFileTypeLabel("/a/b.JPG", id), "Picture");
    assert.equal(savedFileTypeLabel("/a/b.docx", id), "Word document");
    assert.equal(savedFileTypeLabel("/a/b.csv", id), "CSV file");
    assert.equal(savedFileTypeLabel("/a/README", id), "File");
    assert.equal(formatFileSize(0), "0 B");
    assert.equal(formatFileSize(12 * 1024), "12 KB");
    assert.equal(formatFileSize(1.4 * 1024 * 1024), "1.4 MB");
    assert.equal(formatFileSize(2 * 1024 * 1024), "2 MB");
  });

  it("picks the tile colour and letters", function () {
    assert.deepEqual(savedFileTile("/a/b.html", false), {
      type: "html",
      label: "HTML",
    });
    assert.deepEqual(savedFileTile("/a/b.markdown", false), {
      type: "md",
      label: "MARK",
    });
    assert.equal(savedFileTile("/a/b.webp", false).type, "image");
    assert.equal(savedFileTile("/a/b.xyz", false).type, "other");
    assert.deepEqual(savedFileTile("/a/b.html", true), {
      type: "missing",
      label: "?",
    });
  });

  it("picks what a card's preview area shows", function () {
    const html = SAVED_FILE_PREVIEW_MAX_BYTES;
    assert.equal(savedFileCardPreviewKind("/a/p.html", html), "html");
    assert.equal(savedFileCardPreviewKind("/a/p.htm", 0), "html");
    assert.equal(savedFileCardPreviewKind("/a/p.html", html + 1), "tile");
    assert.equal(savedFileCardPreviewKind("/a/n.md", html), "markdown");
    assert.equal(savedFileCardPreviewKind("/a/n.markdown", 5), "markdown");
    assert.equal(savedFileCardPreviewKind("/a/n.md", html + 1), "tile");
    const img = SAVED_FILE_CARD_IMAGE_MAX_BYTES;
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
      assert.equal(savedFileCardPreviewKind(`/a/x.${ext}`, img), "image", ext);
    }
    assert.equal(savedFileCardPreviewKind("/a/x.png", img + 1), "tile");
    assert.equal(savedFileCardPreviewKind("/a/x.csv", 10), "tile");
    assert.equal(savedFileCardPreviewKind("/a/x.pdf", 10), "tile");
    assert.equal(savedFileCardPreviewKind("/a/p.html", undefined), "tile");
  });

  it("decides what a click on the card does", function () {
    assert.isTrue(isShowableSavedFile("html", 10));
    assert.isFalse(isShowableSavedFile("text", 10));
    assert.isFalse(
      isShowableSavedFile("image", SAVED_FILE_PREVIEW_MAX_BYTES + 1),
    );
    const base = { showable: true, standalone: false };
    assert.equal(
      decideSavedFileClick({ ...base, standalone: true }),
      "side-panel",
    );
    assert.equal(decideSavedFileClick(base), "full-view");
    assert.equal(
      decideSavedFileClick({
        ...base,
        showable: false,
        standalone: true,
      }),
      "default-app",
    );
  });
});
