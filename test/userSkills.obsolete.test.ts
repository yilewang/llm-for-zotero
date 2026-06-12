import { assert } from "chai";
import {
  getCanonicalSkillFilePath,
  getCanonicalUserSkillsDir,
  getLegacyUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
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
    globalScope.Zotero = {
      DataDirectory: { dir: baseDir },
      debug: () => undefined,
    };
    const legacySkillsDir = getLegacyUserSkillsDir();
    const canonicalSkillsDir = getCanonicalUserSkillsDir();
    const customSkillFile = getCanonicalSkillFilePath("custom-skill");
    const customSkillDir = customSkillFile.replace(/[\\/]SKILL\.md$/i, "");
    const skillsDir = legacySkillsDir;
    const noteFromPaperPath = `${skillsDir}/note-from-paper.md`;
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
      [customSkillFile]: [
        "---",
        "name: custom-skill",
        "id: custom-skill",
        "description: Custom still loads",
        "version: 1",
        "match: /custom/i",
        "---",
        "",
        "Custom instruction.",
      ].join("\n"),
    };

    globalScope.IOUtils = {
      exists: async (path: string) =>
        path === canonicalSkillsDir || path === customSkillDir || path in files,
      getChildren: async (path: string) =>
        path === canonicalSkillsDir ? [customSkillDir] : [],
      read: async (path: string) => new TextEncoder().encode(files[path] || ""),
    };

    const skills = await loadUserSkills();
    assert.deepEqual(
      skills.map((skill) => skill.id),
      ["custom-skill"],
    );
  });
});
