import { assert } from "chai";
import { loadUserSkills } from "../src/agent/skills/userSkills";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  IOUtils?: {
    exists?: (path: string) => Promise<boolean>;
    read?: (path: string) => Promise<Uint8Array>;
    getChildren?: (path: string) => Promise<string[]>;
  };
};

describe("obsolete user skills", function () {
  let originalZotero: typeof globalScope.Zotero;
  let originalIOUtils: typeof globalScope.IOUtils;

  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalIOUtils = globalScope.IOUtils;
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    globalScope.IOUtils = originalIOUtils;
  });

  it("preserves obsolete files on disk but does not load them as active skills", async function () {
    const baseDir = "/tmp/llm-for-zotero-test";
    const skillsDir = `${baseDir}/llm-for-zotero/skills`;
    const noteFromPaperPath = `${skillsDir}/note-from-paper.md`;
    const customPath = `${skillsDir}/custom-skill.md`;
    const files: Record<string, string> = {
      [noteFromPaperPath]: [
        "---",
        "id: note-from-paper",
        "description: Old note skill",
        "version: 1",
        "match: /note/i",
        "---",
        "",
        "Old obsolete guidance with file_io(read, '{mineruCacheDir}/full.md').",
      ].join("\n"),
      [customPath]: [
        "---",
        "id: custom-skill",
        "description: Custom still loads",
        "version: 1",
        "match: /custom/i",
        "---",
        "",
        "Custom instruction.",
      ].join("\n"),
    };

    globalScope.Zotero = {
      DataDirectory: { dir: baseDir },
      debug: () => undefined,
    };
    globalScope.IOUtils = {
      exists: async () => true,
      getChildren: async () => [noteFromPaperPath, customPath],
      read: async (path: string) => new TextEncoder().encode(files[path] || ""),
    };

    const skills = await loadUserSkills();
    assert.deepEqual(
      skills.map((skill) => skill.id),
      ["custom-skill"],
    );
  });
});
