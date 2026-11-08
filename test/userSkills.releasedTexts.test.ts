import { readFileSync, readdirSync } from "node:fs";
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { patchSkillFrontmatter } from "../src/agent/skills/frontmatterPatcher";
import {
  extractManagedBlock,
  hashSkillForUpgrade,
  MANAGED_END_MARKER,
} from "../src/agent/skills/managedBlock";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  getCanonicalSkillFilePath,
  getCanonicalUserSkillsDir,
  getLegacyUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
import { initUserSkills } from "../src/agent/skills/userSkills";

const BODY_HASH_PREF_KEY = "extensions.zotero.llmForZotero.skillBodyHashes";
const SEEDED_PREF_KEY = "extensions.zotero.llmForZotero.seededBuiltinSkills";
const SEEDED_DIR_PREF_KEY = "extensions.zotero.llmForZotero.seededSkillsDir";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: unknown;
  IOUtils?: unknown;
};

type MockProfile = {
  files: Record<string, string>;
  prefs: Map<string, string>;
  /** Folders made so far; pass them on to model a restart. */
  dirs: Set<string>;
  /** Point the mock at another Zotero profile folder (same data dir). */
  moveProfile: (profileDir: string) => void;
};

type MockOptions = {
  dirs?: Set<string>;
  /** Writes after this many never finish, as when Zotero quits mid-start. */
  hangAfterWrites?: number;
  /** Writes to matching paths fail, as on a full disk or a locked file. */
  failWrite?: (path: string) => boolean;
};

/**
 * A real-shaped file system: a folder exists when it was made or when a file
 * lies under it, as with IOUtils. Prefs survive a profile move, as they do
 * when Zotero copies or restores a profile to another path.
 */
function installProfile(
  baseDir: string,
  profileDir = `${baseDir}/profile`,
  files: Record<string, string> = {},
  prefs = new Map<string, string>(),
  options: MockOptions = {},
): MockProfile {
  const dirs = options.dirs || new Set<string>();
  let writes = 0;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const zotero = {
    DataDirectory: { dir: baseDir },
    Profile: { dir: profileDir },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, String(value)),
    },
    debug: () => undefined,
  };
  const isDir = (path: string) =>
    dirs.has(path) ||
    Object.keys(files).some((file) => file.startsWith(`${path}/`));
  globalScope.Zotero = zotero;
  globalScope.IOUtils = {
    exists: async (path: string) => path in files || isDir(path),
    makeDirectory: async (path: string) => {
      dirs.add(path);
    },
    getChildren: async (path: string) => {
      const children = new Set<string>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(`${path}/`)) continue;
        const rest = filePath.slice(path.length + 1);
        children.add(`${path}/${rest.split("/")[0]}`);
      }
      return [...children];
    },
    read: async (path: string) => encoder.encode(files[path] || ""),
    write: async (path: string, data: Uint8Array) => {
      if (
        options.hangAfterWrites !== undefined &&
        writes++ >= options.hangAfterWrites
      ) {
        return new Promise<number>(() => undefined);
      }
      if (options.failWrite?.(path)) {
        throw new Error(`write failed: ${path}`);
      }
      files[path] = decoder.decode(data);
      return data.byteLength;
    },
    remove: async (path: string) => {
      for (const file of Object.keys(files)) {
        if (file === path || file.startsWith(`${path}/`)) delete files[file];
      }
      dirs.delete(path);
    },
  };
  return {
    files,
    prefs,
    dirs,
    moveProfile: (next: string) => {
      zotero.Profile.dir = next;
    },
  };
}

function fixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/skillUpgrades/${name}.md`, import.meta.url),
    "utf8",
  );
}

function shipped(filename: string) {
  return parseSkill(BUILTIN_SKILL_FILES[filename]);
}

function withNativeName(raw: string): string {
  return raw.replace("---\n", `---\nname: ${parseSkill(raw).id}\n`);
}

function bodyHash(raw: string): string {
  return hashSkillForUpgrade(raw, parseSkill(raw).instruction);
}

/** The one-line change a user makes to a skill's plugin-owned text. */
function editOneLine(raw: string): string {
  const marker = raw.indexOf(MANAGED_END_MARKER);
  if (marker >= 0) {
    return `${raw.slice(0, marker)}My own rule inside the workflow.\n${raw.slice(marker)}`;
  }
  return raw.replace(
    /\n([^\n]+)\n*$/,
    "\n$1\nMy own rule inside the workflow.\n",
  );
}

function assertShippedBody(raw: string, filename: string): void {
  const block = extractManagedBlock(BUILTIN_SKILL_FILES[filename]).block;
  if (block !== null) {
    assert.equal(extractManagedBlock(raw).block, block);
  } else {
    assert.equal(parseSkill(raw).instruction, shipped(filename).instruction);
  }
  assert.equal(parseSkill(raw).version, shipped(filename).version);
}

// compare-papers v6 as v3.8.13 to v3.8.18 shipped it (d5907110).
const COMPARE_V6 = fixture("compare-papers-v6");
const COMPARE_V6_BODY = "yha6jl";

describe("released built-in texts upgrade (bug A)", function () {
  let originalZotero: unknown;
  let originalIOUtils: unknown;
  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalIOUtils = globalScope.IOUtils;
  });
  afterEach(function () {
    globalScope.Zotero = originalZotero;
    globalScope.IOUtils = originalIOUtils;
  });

  it("the fixture is the d5907110 text whose body hash is yha6jl", function () {
    assert.equal(bodyHash(COMPARE_V6), COMPARE_V6_BODY);
    assert.equal(parseSkill(COMPARE_V6).version, 6);
  });

  it("upgrades the copy a failed first start left at v13 with stored yha6jl", async function () {
    // The failed first start tracked the body, raised `version` to the
    // shipped number and added the native name line.
    const stuck = withNativeName(
      patchSkillFrontmatter(
        COMPARE_V6,
        BUILTIN_SKILL_FILES["compare-papers.md"],
      ) as string,
    );
    assert.equal(
      parseSkill(stuck).version,
      shipped("compare-papers.md").version,
    );
    const filePath = () => getCanonicalSkillFilePath("compare-papers");
    const profile = installProfile("/tmp/released-texts-stuck");
    profile.files[filePath()] = stuck;
    profile.prefs.set(
      BODY_HASH_PREF_KEY,
      JSON.stringify({ "compare-papers.md": COMPARE_V6_BODY }),
    );

    await initUserSkills();

    assertShippedBody(profile.files[filePath()], "compare-papers.md");
  });

  it("upgrades that v13-labelled copy at once when the stored hash was lost", async function () {
    const stuck = withNativeName(
      patchSkillFrontmatter(
        COMPARE_V6,
        BUILTIN_SKILL_FILES["compare-papers.md"],
      ) as string,
    );
    const profile = installProfile("/tmp/released-texts-stuck-no-pref");
    const filePath = getCanonicalSkillFilePath("compare-papers");
    profile.files[filePath] = stuck;

    await initUserSkills();

    assertShippedBody(profile.files[filePath], "compare-papers.md");
  });

  it("upgrades the legacy d5907110 copy on the first start with no stored hash", async function () {
    const profile = installProfile("/tmp/released-texts-legacy");
    const legacyPath = `${getLegacyUserSkillsDir()}/compare-papers.md`;
    profile.files[legacyPath] = COMPARE_V6;

    await initUserSkills();

    const filePath = getCanonicalSkillFilePath("compare-papers");
    assertShippedBody(profile.files[filePath], "compare-papers.md");
    assert.equal(
      JSON.parse(profile.prefs.get(BODY_HASH_PREF_KEY) || "{}")[
        "compare-papers.md"
      ],
      bodyHash(BUILTIN_SKILL_FILES["compare-papers.md"]),
    );

    // The second start finds it current and leaves it alone.
    const afterFirst = profile.files[filePath];
    await initUserSkills();
    assert.equal(profile.files[filePath], afterFirst);
  });

  it("upgrades the canonical d5907110 copy (with its name line) with no stored hash", async function () {
    const profile = installProfile("/tmp/released-texts-canonical");
    const filePath = getCanonicalSkillFilePath("compare-papers");
    profile.files[filePath] = withNativeName(COMPARE_V6);

    await initUserSkills();

    assertShippedBody(profile.files[filePath], "compare-papers.md");
  });

  // The upgrade hash leaves frontmatter out (managedBlock.ts): a known body
  // upgrades, and the user's frontmatter stays above the shipped body.
  const MY_MATCH = "match: /\\bmy lab's comparison\\b/i";
  function withFrontmatterEdits(raw: string): string {
    return withNativeName(raw)
      .replace("activation: auto\n", "activation: manual\nauthor: someone\n")
      .replace("\n---\n\n", `\n${MY_MATCH}\n---\n\n`);
  }
  function assertFrontmatterKept(raw: string): void {
    assert.include(raw, "author: someone");
    assert.include(raw, MY_MATCH);
    assert.equal(parseSkill(raw).activation, "manual");
    assert.equal(
      parseSkill(raw).description,
      shipped("compare-papers.md").description,
    );
  }
  for (const tracked of [false, true]) {
    it(`keeps frontmatter edits on a v6 copy with a shipped body (${tracked ? "tracked" : "no stored hash"})`, async function () {
      const profile = installProfile(
        `/tmp/released-texts-frontmatter-${tracked}`,
      );
      const filePath = getCanonicalSkillFilePath("compare-papers");
      profile.files[filePath] = withFrontmatterEdits(COMPARE_V6);
      assert.equal(bodyHash(profile.files[filePath]), COMPARE_V6_BODY);
      if (tracked) {
        profile.prefs.set(
          BODY_HASH_PREF_KEY,
          JSON.stringify({ "compare-papers.md": COMPARE_V6_BODY }),
        );
      }

      await initUserSkills();

      assertShippedBody(profile.files[filePath], "compare-papers.md");
      assertFrontmatterKept(profile.files[filePath]);
      // The next start finds it current and changes nothing.
      const afterFirst = profile.files[filePath];
      await initUserSkills();
      assert.equal(profile.files[filePath], afterFirst);
    });
  }

  it("still replaces an exact shipped v6 file as a whole", async function () {
    const profile = installProfile("/tmp/released-texts-exact-v6");
    const filePath = getCanonicalSkillFilePath("compare-papers");
    profile.files[filePath] = COMPARE_V6;
    await initUserSkills();
    assert.equal(
      profile.files[filePath],
      withNativeName(BUILTIN_SKILL_FILES["compare-papers.md"]),
    );
  });

  it("keeps a v6 copy with one line the user changed, over two starts", async function () {
    const profile = installProfile("/tmp/released-texts-edited-v6");
    const legacyPath = `${getLegacyUserSkillsDir()}/compare-papers.md`;
    const edited = editOneLine(COMPARE_V6);
    assert.notEqual(edited, COMPARE_V6);
    profile.files[legacyPath] = edited;
    const filePath = getCanonicalSkillFilePath("compare-papers");

    await initUserSkills();
    assert.include(profile.files[filePath], "My own rule inside the workflow.");
    assert.equal(
      parseSkill(profile.files[filePath]).instruction,
      parseSkill(edited).instruction,
    );

    await initUserSkills();
    assert.include(profile.files[filePath], "My own rule inside the workflow.");
    assert.equal(
      parseSkill(profile.files[filePath]).instruction,
      parseSkill(edited).instruction,
    );
  });

  it("refreshes a known write-note block among the user's own text with no stored hash", async function () {
    const v18 = fixture("write-note-v18");
    const customized = `${v18}\n## My customizations\n\nFile notes under {papertitle}.\n`;
    const profile = installProfile("/tmp/released-texts-write-note-block");
    const filePath = getCanonicalSkillFilePath("write-note");
    profile.files[filePath] = customized;

    await initUserSkills();

    assertShippedBody(profile.files[filePath], "write-note.md");
    assert.include(profile.files[filePath], "File notes under {papertitle}.");
  });

  // Every previous text with one line changed and no stored hash: the first
  // start keeps it and tracks it, and no later start may treat that tracked
  // copy as an untouched default.
  const fixtures = [
    ...readdirSync(new URL("./fixtures/skillUpgrades/", import.meta.url))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/, "")),
    ...readdirSync(
      new URL("./fixtures/skillUpgrades/simplified/", import.meta.url),
    ).map((file) => `simplified/${file.replace(/\.md$/, "")}`),
  ].filter((name) => !/simple-paper-qa/.test(name));
  for (const name of fixtures) {
    it(`keeps an edited ${name} with no stored hash over two starts`, async function () {
      const raw = fixture(name);
      const skill = parseSkill(raw);
      const filename = Object.keys(BUILTIN_SKILL_FILES).find(
        (file) => shipped(file).id === skill.id,
      ) as string;
      assert.isString(filename);
      const profile = installProfile(`/tmp/released-texts-edited-${name}`);
      const filePath = getCanonicalSkillFilePath(skill.id);
      profile.files[filePath] = editOneLine(raw);

      await initUserSkills();
      await initUserSkills();

      assert.include(
        profile.files[filePath],
        "My own rule inside the workflow.",
      );
    });
  }
});

describe("built-ins in a new profile skills folder (bug B)", function () {
  let originalZotero: unknown;
  let originalIOUtils: unknown;
  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalIOUtils = globalScope.IOUtils;
  });
  afterEach(function () {
    globalScope.Zotero = originalZotero;
    globalScope.IOUtils = originalIOUtils;
  });

  const ALL_BUILTINS = Object.keys(BUILTIN_SKILL_FILES);

  function builtinPath(filename: string): string {
    return getCanonicalSkillFilePath(shipped(filename).id);
  }

  it("writes literature-review into a new folder although the profile-wide record lists it", async function () {
    // The pre-change pref shapes: a JSON array of filenames and a JSON
    // object of body hashes, as an older profile at another path left them.
    const prefs = new Map<string, string>([
      [
        SEEDED_PREF_KEY,
        JSON.stringify([
          "literature-review.md",
          "reorganize-library.md",
          "compare-papers.md",
        ]),
      ],
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "literature-review.md": bodyHash(
            BUILTIN_SKILL_FILES["literature-review.md"],
          ),
        }),
      ],
    ]);
    const profile = installProfile(
      "/tmp/released-texts-new-folder",
      "/Users/me/restored-profile",
      {},
      prefs,
    );
    assert.isFalse(
      Object.keys(profile.files).some((file) =>
        file.startsWith(getCanonicalUserSkillsDir()),
      ),
    );

    await initUserSkills();

    for (const filename of ALL_BUILTINS) {
      assert.property(profile.files, builtinPath(filename), filename);
      assertShippedBody(profile.files[builtinPath(filename)], filename);
    }
    assert.includeMembers(
      JSON.parse(profile.prefs.get(SEEDED_PREF_KEY) || "[]"),
      ALL_BUILTINS,
    );
  });

  it("writes every built-in into the folder of a profile moved to a new path", async function () {
    const profile = installProfile(
      "/tmp/released-texts-moved",
      "/Users/me/old-profile",
    );
    await initUserSkills();
    const oldFolder = getCanonicalUserSkillsDir();
    // The user deletes a built-in in the old folder; the record lists it.
    delete profile.files[builtinPath("literature-review.md")];

    profile.moveProfile("/Users/me/new-profile");
    assert.notEqual(getCanonicalUserSkillsDir(), oldFolder);
    await initUserSkills();

    for (const filename of ALL_BUILTINS) {
      assert.property(profile.files, builtinPath(filename), filename);
    }
  });

  it("keeps a built-in the user deleted from an existing folder deleted", async function () {
    const profile = installProfile("/tmp/released-texts-deleted");
    await initUserSkills();
    const filePath = builtinPath("literature-review.md");
    assert.property(profile.files, filePath);
    delete profile.files[filePath];

    await initUserSkills();
    assert.notProperty(profile.files, filePath);
    await initUserSkills();
    assert.notProperty(profile.files, filePath);
  });

  it("keeps deletions recorded in the pre-change pref for an existing folder", async function () {
    // An existing folder from an older release: compare-papers present,
    // literature-review deleted, recorded in the old array-shaped pref.
    const files: Record<string, string> = {};
    const prefs = new Map<string, string>([
      [
        SEEDED_PREF_KEY,
        JSON.stringify(["compare-papers.md", "literature-review.md"]),
      ],
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "compare-papers.md": bodyHash(
            BUILTIN_SKILL_FILES["compare-papers.md"],
          ),
        }),
      ],
    ]);
    const profile = installProfile(
      "/tmp/released-texts-old-prefs",
      undefined,
      files,
      prefs,
    );
    files[builtinPath("compare-papers.md")] =
      BUILTIN_SKILL_FILES["compare-papers.md"];

    await initUserSkills();

    assert.notProperty(profile.files, builtinPath("literature-review.md"));
    assert.property(profile.files, builtinPath("compare-papers.md"));
    // A built-in the record never listed is still added.
    assert.property(profile.files, builtinPath("zotero-script.md"));
  });

  it("still migrates the user's legacy skills into a new folder", async function () {
    const personal = [
      "---",
      "id: my-lab-workflow",
      "description: Summarize lab meeting papers in my lab's format",
      "version: 2",
      "---",
      "",
      "Use my lab's template.",
      "",
    ].join("\n");
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(["literature-review.md"])],
    ]);
    const profile = installProfile(
      "/tmp/released-texts-migrate",
      undefined,
      {},
      prefs,
    );
    const legacyDir = getLegacyUserSkillsDir();
    const editedCompare = editOneLine(COMPARE_V6);
    profile.files[`${legacyDir}/my-lab-workflow.md`] = personal;
    profile.files[`${legacyDir}/compare-papers.md`] = editedCompare;

    await initUserSkills();

    const personalPath = getCanonicalSkillFilePath("my-lab-workflow");
    assert.include(profile.files[personalPath], "Use my lab's template.");
    assert.include(profile.files[personalPath], "name: my-lab-workflow");
    assert.include(
      profile.files[builtinPath("compare-papers.md")],
      "My own rule inside the workflow.",
    );
    assertShippedBody(
      profile.files[builtinPath("literature-review.md")],
      "literature-review.md",
    );
    // The legacy folder stays as it was.
    assert.equal(profile.files[`${legacyDir}/my-lab-workflow.md`], personal);
  });

  it("upgrades an untouched legacy copy migrated into a new folder despite another folder's stored hash", async function () {
    // The profile-wide hash record describes the old folder's copy (here the
    // current text), not the legacy copy the migration brings in.
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(["compare-papers.md"])],
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "compare-papers.md": bodyHash(
            BUILTIN_SKILL_FILES["compare-papers.md"],
          ),
        }),
      ],
    ]);
    const profile = installProfile(
      "/tmp/released-texts-migrated-stale",
      undefined,
      {},
      prefs,
    );
    profile.files[`${getLegacyUserSkillsDir()}/compare-papers.md`] = COMPARE_V6;

    await initUserSkills();

    assertShippedBody(
      profile.files[builtinPath("compare-papers.md")],
      "compare-papers.md",
    );
  });

  it("keeps an edited legacy copy migrated into a new folder", async function () {
    const prefs = new Map<string, string>([
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "compare-papers.md": bodyHash(
            BUILTIN_SKILL_FILES["compare-papers.md"],
          ),
        }),
      ],
    ]);
    const profile = installProfile(
      "/tmp/released-texts-migrated-edited",
      undefined,
      {},
      prefs,
    );
    profile.files[`${getLegacyUserSkillsDir()}/compare-papers.md`] =
      editOneLine(COMPARE_V6);

    await initUserSkills();
    await initUserSkills();

    assert.include(
      profile.files[builtinPath("compare-papers.md")],
      "My own rule inside the workflow.",
    );
  });

  it("records the folder once a start finishes", async function () {
    const profile = installProfile("/tmp/released-texts-records-dir");
    await initUserSkills();
    assert.equal(
      profile.prefs.get(SEEDED_DIR_PREF_KEY),
      getCanonicalUserSkillsDir(),
    );
  });

  it("redoes an interrupted first start: it migrates and seeds on the next start", async function () {
    const personal = [
      "---",
      "id: my-lab-workflow",
      "description: Summarize lab meeting papers in my lab's format",
      "version: 2",
      "---",
      "",
      "Use my lab's template.",
      "",
    ].join("\n");
    // A profile at a new path whose records list every built-in.
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(ALL_BUILTINS)],
    ]);
    const files: Record<string, string> = {};
    const dirs = new Set<string>();
    installProfile("/tmp/released-texts-interrupted", undefined, files, prefs);
    const legacyDir = getLegacyUserSkillsDir();
    files[`${legacyDir}/my-lab-workflow.md`] = personal;

    // Zotero quits after the folder is made and one file is written.
    installProfile("/tmp/released-texts-interrupted", undefined, files, prefs, {
      dirs,
      hangAfterWrites: 1,
    });
    void initUserSkills();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.isTrue(dirs.has(getCanonicalUserSkillsDir()));
    assert.notEqual(
      prefs.get(SEEDED_DIR_PREF_KEY),
      getCanonicalUserSkillsDir(),
    );
    assert.notProperty(files, builtinPath("literature-review.md"));

    installProfile("/tmp/released-texts-interrupted", undefined, files, prefs, {
      dirs,
    });
    await initUserSkills();

    assert.include(
      files[getCanonicalSkillFilePath("my-lab-workflow")],
      "Use my lab's template.",
    );
    for (const filename of ALL_BUILTINS) {
      assert.property(files, builtinPath(filename), filename);
    }
    assert.equal(prefs.get(SEEDED_DIR_PREF_KEY), getCanonicalUserSkillsDir());
  });

  it("keeps a deleted built-in and personal skill deleted in a known folder although legacy copies remain", async function () {
    const personal = [
      "---",
      "id: my-lab-workflow",
      "description: Summarize lab meeting papers in my lab's format",
      "version: 2",
      "---",
      "",
      "Use my lab's template.",
      "",
    ].join("\n");
    const profile = installProfile("/tmp/released-texts-legacy-deleted");
    const legacyDir = getLegacyUserSkillsDir();
    profile.files[`${legacyDir}/my-lab-workflow.md`] = personal;
    profile.files[`${legacyDir}/compare-papers.md`] = COMPARE_V6;
    await initUserSkills();
    const personalPath = getCanonicalSkillFilePath("my-lab-workflow");
    assert.property(profile.files, personalPath);
    assert.property(profile.files, builtinPath("compare-papers.md"));

    // The user deletes both skill folders.
    delete profile.files[personalPath];
    delete profile.files[builtinPath("compare-papers.md")];
    await initUserSkills();
    await initUserSkills();

    assert.notProperty(profile.files, personalPath);
    assert.notProperty(profile.files, builtinPath("compare-papers.md"));
    assert.equal(profile.files[`${legacyDir}/my-lab-workflow.md`], personal);
  });

  it("does not migrate legacy copies again into a folder from before the folder record", async function () {
    // Pre-change prefs: no folder record; the folder exists; the user
    // deleted compare-papers from it, and its legacy copy remains.
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(ALL_BUILTINS)],
    ]);
    const files: Record<string, string> = {};
    const profile = installProfile(
      "/tmp/released-texts-pre-record-legacy",
      undefined,
      files,
      prefs,
    );
    files[builtinPath("write-note.md")] = BUILTIN_SKILL_FILES["write-note.md"];
    files[`${getLegacyUserSkillsDir()}/compare-papers.md`] = COMPARE_V6;
    assert.isUndefined(prefs.get(SEEDED_DIR_PREF_KEY));

    await initUserSkills();

    assert.notProperty(profile.files, builtinPath("compare-papers.md"));
    assert.equal(prefs.get(SEEDED_DIR_PREF_KEY), getCanonicalUserSkillsDir());
  });

  it("treats a folder another folder's record names as new", async function () {
    // The record names the folder at the old path; this folder exists
    // (made, never finished) and the record lists every built-in.
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(ALL_BUILTINS)],
      [SEEDED_DIR_PREF_KEY, "/somewhere/else/.agents/skills"],
    ]);
    const dirs = new Set<string>();
    const profile = installProfile(
      "/tmp/released-texts-other-record",
      undefined,
      {},
      prefs,
      { dirs },
    );
    dirs.add(getCanonicalUserSkillsDir());

    await initUserSkills();

    for (const filename of ALL_BUILTINS) {
      assert.property(profile.files, builtinPath(filename), filename);
    }
  });

  // A profile hit by the old profile-wide record: its folder exists, the
  // record lists literature-review as seeded, and no folder record exists.
  function bugBVictim(name: string, otherFolderSkills: string[]) {
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(ALL_BUILTINS)],
    ]);
    const files: Record<string, string> = {};
    const profile = installProfile(`/tmp/${name}`, undefined, files, prefs);
    for (const filename of ALL_BUILTINS) {
      if (filename === "literature-review.md") continue;
      files[builtinPath(filename)] = BUILTIN_SKILL_FILES[filename];
    }
    // The folder of the profile's earlier path, under the same data dir.
    const runtimeParent = getCanonicalUserSkillsDir().replace(
      /\/profile-[^/]+\/\.agents\/skills$/,
      "",
    );
    assert.notEqual(runtimeParent, getCanonicalUserSkillsDir());
    for (const id of otherFolderSkills) {
      files[`${runtimeParent}/profile-0a1b2c3d/.agents/skills/${id}/SKILL.md`] =
        BUILTIN_SKILL_FILES[`${id}.md`];
    }
    return profile;
  }

  it("restores a built-in a moved profile lost when its earlier folder holds it", async function () {
    const profile = bugBVictim("released-texts-victim-moved", [
      "literature-review",
      "compare-papers",
    ]);
    assert.isUndefined(profile.prefs.get(SEEDED_DIR_PREF_KEY));

    await initUserSkills();

    assertShippedBody(
      profile.files[builtinPath("literature-review.md")],
      "literature-review.md",
    );
    assert.equal(
      profile.prefs.get(SEEDED_DIR_PREF_KEY),
      getCanonicalUserSkillsDir(),
    );
    // Recorded now: a later deletion stays.
    delete profile.files[builtinPath("literature-review.md")];
    await initUserSkills();
    assert.notProperty(profile.files, builtinPath("literature-review.md"));
  });

  it("keeps a built-in deleted when no other profile folder holds it", async function () {
    const profile = bugBVictim("released-texts-victim-deleted", [
      "compare-papers",
    ]);

    await initUserSkills();

    assert.notProperty(profile.files, builtinPath("literature-review.md"));
  });

  it("leaves a new folder pending when a built-in failed to write, and writes it on the next start", async function () {
    const prefs = new Map<string, string>([
      [SEEDED_PREF_KEY, JSON.stringify(ALL_BUILTINS)],
    ]);
    const files: Record<string, string> = {};
    const dirs = new Set<string>();
    installProfile("/tmp/released-texts-failed-seed", undefined, files, prefs, {
      dirs,
      failWrite: (path) => path.includes("/literature-review/"),
    });
    await initUserSkills();
    assert.notProperty(files, builtinPath("literature-review.md"));
    assert.equal(
      prefs.get(SEEDED_DIR_PREF_KEY),
      `pending:${getCanonicalUserSkillsDir()}`,
    );

    installProfile("/tmp/released-texts-failed-seed", undefined, files, prefs, {
      dirs,
    });
    await initUserSkills();

    assertShippedBody(
      files[builtinPath("literature-review.md")],
      "literature-review.md",
    );
    assert.equal(prefs.get(SEEDED_DIR_PREF_KEY), getCanonicalUserSkillsDir());
  });

  it("records a new folder although an existing copy failed to upgrade", async function () {
    const profile = installProfile(
      "/tmp/released-texts-failed-upgrade",
      undefined,
      {},
      new Map<string, string>(),
      { failWrite: (path) => path.includes("/compare-papers/") },
    );
    profile.files[builtinPath("compare-papers.md")] = COMPARE_V6;

    await initUserSkills();

    assert.equal(profile.files[builtinPath("compare-papers.md")], COMPARE_V6);
    assert.equal(
      profile.prefs.get(SEEDED_DIR_PREF_KEY),
      getCanonicalUserSkillsDir(),
    );
  });

  it("records the folder although adding a name line to a skill fails", async function () {
    const profile = installProfile(
      "/tmp/released-texts-normalize-fails",
      undefined,
      {},
      new Map<string, string>(),
      { failWrite: (path) => path.includes("/no-name-skill/") },
    );
    // A personal skill without a `name:` line in an existing folder.
    profile.files[getCanonicalSkillFilePath("no-name-skill")] = [
      "---",
      "id: no-name-skill",
      "description: A personal skill whose file has no name line yet",
      "version: 1",
      "---",
      "",
      "My own workflow.",
      "",
    ].join("\n");

    await initUserSkills().catch(() => undefined);

    assert.equal(
      profile.prefs.get(SEEDED_DIR_PREF_KEY),
      getCanonicalUserSkillsDir(),
    );
  });

  it("reads profiles with no skill prefs at all", async function () {
    const profile = installProfile("/tmp/released-texts-no-prefs");
    await initUserSkills();
    for (const filename of ALL_BUILTINS) {
      assert.property(profile.files, builtinPath(filename), filename);
    }
  });
});
