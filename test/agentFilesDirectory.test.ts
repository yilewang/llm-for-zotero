import { assert } from "chai";
import {
  buildAgentFilesInstruction,
  buildPaperFolderName,
  buildShortPaperName,
  deleteAgentFilesFolders,
  isFolderForKey,
  listAgentFilesFolders,
  resolveAgentFilesFolder,
  sanitizeFolderNamePart,
} from "../src/utils/agentFilesDirectory";

type Globals = { Zotero?: unknown; IOUtils?: unknown };

describe("Agent saved-files folder", function () {
  const globals = globalThis as typeof globalThis & Globals;
  let savedZotero: unknown;
  let savedIOUtils: unknown;

  beforeEach(function () {
    savedZotero = globals.Zotero;
    savedIOUtils = globals.IOUtils;
  });

  afterEach(function () {
    globals.Zotero = savedZotero;
    globals.IOUtils = savedIOUtils;
  });

  function installZotero(children: string[] | null) {
    globals.Zotero = {
      DataDirectory: { dir: "/data" },
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1, getName: () => "Lab group" },
      Items: {
        get: (id: number) =>
          id === 10
            ? {
                key: "ABCD1234",
                getField: (field: string) =>
                  ({
                    title:
                      "Engineering flexible machine learning systems by traversing functionally invariant paths",
                    date: "2024-03-01",
                  })[field] || "",
                getCreators: () => [{ lastName: "Raghavan" }],
              }
            : undefined,
      },
    };
    globals.IOUtils = {
      exists: async () => children !== null,
      getChildren: async () =>
        (children || []).map((name) => `/data/llm-for-zotero-files/${name}`),
    };
  }

  it("names a paper by author, year, and the first title words", function () {
    assert.equal(
      buildShortPaperName({
        firstCreator: "Raghavan",
        year: "2024",
        title: "The Engineering of flexible machine learning systems",
      }),
      "Raghavan 2024 Engineering flexible machine",
    );
    assert.equal(buildPaperFolderName("ABCD1234", ""), "ABCD1234");
  });

  it("strips characters a folder name cannot hold", function () {
    assert.equal(sanitizeFolderNamePart('a/b:c*?"<>| d. '), "a b c d");
    assert.equal(sanitizeFolderNamePart("..hidden"), "hidden");
  });

  it("matches a folder by key whatever its name", function () {
    assert.isTrue(isFolderForKey("ABCD1234 - Old title", "ABCD1234"));
    assert.isTrue(isFolderForKey("ABCD1234", "ABCD1234"));
    assert.isFalse(isFolderForKey("ABCD12345 - Other", "ABCD1234"));
  });

  it("gives a new paper a key-and-name folder", async function () {
    installZotero(null);
    assert.equal(
      await resolveAgentFilesFolder({ kind: "paper", itemId: 10 }),
      "/data/llm-for-zotero-files/ABCD1234 - Raghavan 2024 Engineering flexible machine",
    );
  });

  it("keeps a renamed paper's existing folder", async function () {
    installZotero(["Library", "ABCD1234 - Old name"]);
    assert.equal(
      await resolveAgentFilesFolder({ kind: "paper", itemId: 10 }),
      "/data/llm-for-zotero-files/ABCD1234 - Old name",
    );
  });

  it("uses Library for the user library and a named folder for groups", async function () {
    installZotero([]);
    assert.equal(
      await resolveAgentFilesFolder({ kind: "library", libraryID: 1 }),
      "/data/llm-for-zotero-files/Library",
    );
    assert.equal(
      await resolveAgentFilesFolder({ kind: "library", libraryID: 5 }),
      "/data/llm-for-zotero-files/Library 5 - Lab group",
    );
  });

  it("gives no folder for a paper that is gone", async function () {
    installZotero([]);
    assert.isNull(await resolveAgentFilesFolder({ kind: "paper", itemId: 99 }));
  });

  it("tells the agent to show pages in the answer and where files go", function () {
    const text = buildAgentFilesInstruction("/data/llm-for-zotero-files/X");
    assert.include(text, "```html block");
    assert.include(
      text,
      "Save files for this chat in: /data/llm-for-zotero-files/X",
    );
    assert.include(text, "/data/llm-for-zotero-files/X/.work");
    assert.notInclude(
      buildAgentFilesInstruction(null),
      "Save files for this chat in",
    );
  });
});

describe("Saved files cleanup", function () {
  const globals = globalThis as typeof globalThis & {
    Zotero?: unknown;
    IOUtils?: unknown;
  };
  let savedZotero: unknown;
  let savedIOUtils: unknown;
  let removed: string[];
  beforeEach(function () {
    savedZotero = globals.Zotero;
    savedIOUtils = globals.IOUtils;
    removed = [];
    const root = "/data/llm-for-zotero-files";
    const tree: Record<string, { dir?: boolean; size?: number }> = {
      [root]: { dir: true },
      [`${root}/AAAA1111 - Kept paper`]: { dir: true },
      [`${root}/AAAA1111 - Kept paper/page.html`]: { size: 2048 },
      [`${root}/AAAA1111 - Kept paper/.llm-files.json`]: { size: 99 },
      [`${root}/BBBB2222 - Deleted paper`]: { dir: true },
      [`${root}/BBBB2222 - Deleted paper/old.html`]: { size: 10 },
      [`${root}/CCCC3333 - Trashed paper`]: { dir: true },
      [`${root}/Library`]: { dir: true },
      [`${root}/notes.txt`]: { size: 1 },
    };
    globals.Zotero = {
      DataDirectory: { dir: "/data" },
      Prefs: { get: () => undefined },
      Libraries: { getAll: () => [{ libraryID: 1 }] },
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === "AAAA1111"
            ? { deleted: false, getDisplayTitle: () => "Kept paper title" }
            : key === "CCCC3333"
              ? { deleted: true, getDisplayTitle: () => "Trashed" }
              : false,
      },
    };
    globals.IOUtils = {
      exists: async (path: string) => path in tree,
      stat: async (path: string) => {
        const entry = tree[path];
        if (!entry) throw new Error("missing");
        return { type: entry.dir ? "directory" : "regular", size: entry.size };
      },
      getChildren: async (path: string) =>
        Object.keys(tree).filter(
          (key) =>
            key.startsWith(`${path}/`) &&
            !key.slice(path.length + 1).includes("/"),
        ),
      remove: async (path: string) => {
        removed.push(path);
      },
    };
  });
  afterEach(function () {
    globals.Zotero = savedZotero;
    globals.IOUtils = savedIOUtils;
  });

  it("lists left-over folders first, with size and paper status", async function () {
    const folders = await listAgentFilesFolders();
    assert.deepEqual(
      folders.map((folder) => [folder.name, folder.status, folder.fileCount]),
      [
        ["BBBB2222 - Deleted paper", "gone", 1],
        ["CCCC3333 - Trashed paper", "trash", 0],
        ["AAAA1111 - Kept paper", "paper", 1],
        ["Library", "library", 0],
      ],
    );
    assert.equal(folders[2].bytes, 2048);
    assert.equal(folders[2].title, "Kept paper title");
  });

  it("deletes only folders inside the saved-files root", async function () {
    const result = await deleteAgentFilesFolders([
      "/data/llm-for-zotero-files/BBBB2222 - Deleted paper",
      "/data/llm-for-zotero-files",
      "/data/storage",
      "/data/llm-for-zotero-files/../storage",
    ]);
    assert.deepEqual(removed, [
      "/data/llm-for-zotero-files/BBBB2222 - Deleted paper",
    ]);
    assert.equal(result.failed.length, 3);
  });
});
