import { readFileSync } from "node:fs";
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { patchSkillFrontmatter } from "../src/agent/skills/frontmatterPatcher";
import {
  extractManagedBlock,
  hashSkillForUpgrade,
  spliceManagedBlock,
} from "../src/agent/skills/managedBlock";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  getCanonicalSkillFilePath,
  getLegacyUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
import { initUserSkills } from "../src/agent/skills/userSkills";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  IOUtils?: {
    exists?: (path: string) => Promise<boolean>;
    read?: (path: string) => Promise<Uint8Array>;
    write?: (path: string, data: Uint8Array) => Promise<number>;
    getChildren?: (path: string) => Promise<string[]>;
    makeDirectory?: (
      path: string,
      options?: { createAncestors?: boolean; ignoreExisting?: boolean },
    ) => Promise<void>;
  };
};

const BODY_HASH_PREF_KEY = "extensions.zotero.llmForZotero.skillBodyHashes";

const OLD_COMPARE_PAPERS = `---
id: compare-papers
description: Compare multiple papers by theme, methodology, or findings
version: 5
contexts: paper-set
activation: auto
match: /\\b(compare|contrast|difference|differ|similarities|similarity)\\b.*\\b(papers?|articles?|studies|works?)\\b/i
match: /\\b(papers?|articles?|studies)\\b.*\\b(compare|contrast|difference|differ|similarities|similarity)\\b/i
match: /\\bcomparative\\s+(analysis|review|study)\\b/i
match: /\\bhow\\s+(does|do|is|are)\\b.*\\bdiffer\\b/i
match: /\\bcompare\\b.*\\b(methods?|methodology|sections?|approach|results?|limitations?)\\b/i
---

<!--
  SKILL: Compare Papers

  This skill activates when you ask to compare multiple papers
  (e.g., "compare these two papers", "what are the differences?").

  You can customize:
  - Comparison dimensions: change what aspects are compared
  - Reading depth: adjust how deeply each paper is read
  - Output format: modify the comparison structure

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Comparing Multiple Papers — targeted first when the dimension is known

Use Zotero paper tools as resources, not a ritual. Batch selected papers in \`targets\`.

- If the user names a comparison dimension such as methods, results, limitations, theory, data, or figures, start with one batched targeted read:
  \`paper_read({ mode:'targeted', query:'methods methodology method section', targets:[...] })\`
- For broad requests like "compare these papers" with no dimension, call \`paper_read({ mode:'overview', targets:[...] })\` once, then answer or make one focused targeted call if a specific gap remains.
- For method-section requests, do not call overview first unless the targeted result is clearly insufficient.
- When \`paper_read\` returns exact passages, include short blockquotes from the already-returned passages when useful for grounding the comparison.
- If \`paper_read\` provides quote anchors like \`[[quote:Q_x7a2]]\`, use those anchor tokens for direct quotes instead of copying the quote/citation manually.
- If no quote anchor is provided for a direct quote, put the provided \`sourceLabel\` on the next non-empty line after the blockquote, before any commentary.
- Do not call visual/page tools, \`file_io\`, or \`run_command\` just to improve citation anchors or page numbers. Use the provided \`sourceLabel\`; the UI can bind citations after rendering.
- Stop after the first useful batched result when it covers the selected papers. Make at most one follow-up \`paper_read({ mode:'targeted', ... })\` for a concrete missing dimension.
`;

const OLD_EVIDENCE_BASED_QA = `---
id: evidence-based-qa
description: Locate specific passages in one or more papers that support a given claim, returning quoted evidence with page and section citations. Not for general questions — use simple-paper-qa for those.
version: 3
contexts: single-paper,paper-set
activation: auto
match: /\\b(what method|what approach|what technique|what model|how did they|how does it|what results?|what data|what dataset|what experiment|what metric|what performance|what accuracy|what baseline)\\b/i
match: /\\b(find|locate|where|which section|which page|quote|passage|excerpt|evidence|proof|support|mention)\\b.*\\b(paper|article|study|text|document)\\b/i
match: /\\b(does (this|the) paper|do the authors?)\\b.*\\b(mention|discuss|address|cover|report|describe|analyze|analyse|use|propose|introduce|present|evaluate|compare)\\b/i
match: /\\b(specific|particular|exact|precise)\\b.*\\b(result|finding|number|figure|statistic|claim|statement)\\b/i
---

<!--
  SKILL: Evidence-Based Q&A

  This skill activates for specific questions about methods, results, or
  evidence in a paper (e.g., "what method did they use?", "find where
  they discuss accuracy").

  You can customize:
  - Retrieval strategy: change how evidence is gathered
  - Tool budget: adjust the number of allowed tool calls
  - Answer format: modify how evidence is presented

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Evidence-Based Paper Q&A — read then retrieve, then answer

When the user asks about specific methods, results, data, or needs to locate
a particular claim in a paper, use a two-step approach.

### Recipe

**Step 1 — Gather context:**

- Call \`paper_read({ mode:'overview' })\` first to understand the paper's structure and main claims.

**Step 2 — Targeted retrieval (only if Step 1 is insufficient):**
Call \`paper_read({ mode:'targeted', query:'<the specific question>' })\` with a focused question. This returns the most relevant passages ranked by relevance.

**Step 3 — Answer from the evidence.**
Do NOT make additional retrieval calls. If the evidence does not fully answer
the question, say what you found and what is missing rather than making
more tool calls.

If \`paper_read\` provides quote anchors like \`[[quote:Q_x7a2]]\`, use those
anchor tokens for direct quotes instead of copying the quote/citation manually.
If no quote anchor is provided for a direct quote, put the provided
\`sourceLabel\` on the next non-empty line after the blockquote, before any
commentary.

### Budget

Aim for 1–2 tool calls total. \`paper_read({ mode:'overview' })\` often answers in one call.
The normal fallback is overview + targeted retrieval = 2 calls.
Only exceed 2 calls if the paper's indexing is incomplete (check indexingState).
`;

function installMockSkillEnvironment(
  baseDir: string,
  files: Record<string, string>,
  prefs: Map<string, string>,
): void {
  const dirs = new Set<string>([`${baseDir}/llm-for-zotero/skills`]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  globalScope.Zotero = {
    DataDirectory: { dir: baseDir },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, String(value)),
    },
    debug: () => undefined,
  };
  globalScope.IOUtils = {
    exists: async (path: string) => dirs.has(path) || path in files,
    makeDirectory: async (path: string) => {
      dirs.add(path);
    },
    getChildren: async (path: string) => {
      const normalized = path.replace(/\/$/, "");
      const children = new Set<string>();
      for (const filePath of Object.keys(files)) {
        const parent = filePath.replace(/[\\/][^\\/]*$/, "");
        if (parent === normalized) {
          children.add(filePath);
          continue;
        }
        const grandparent = parent.replace(/[\\/][^\\/]*$/, "");
        if (grandparent === normalized) {
          children.add(parent);
        }
      }
      return [...children];
    },
    read: async (path: string) => encoder.encode(files[path] || ""),
    write: async (path: string, data: Uint8Array) => {
      files[path] = decoder.decode(data);
      return data.byteLength;
    },
  };
}

describe("user skill bootstrap upgrades", function () {
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

  it("upgrades unmodified historical compare/evidence skills with no stored hashes", async function () {
    const baseDir = "/tmp/llm-for-zotero-bootstrap-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    const skillsDir = getLegacyUserSkillsDir();
    const comparePath = `${skillsDir}/compare-papers.md`;
    const evidencePath = `${skillsDir}/evidence-based-qa.md`;
    const files: Record<string, string> = {
      [comparePath]: OLD_COMPARE_PAPERS,
      [evidencePath]: OLD_EVIDENCE_BASED_QA,
    };
    const prefs = new Map<string, string>();

    installMockSkillEnvironment(baseDir, files, prefs);

    await initUserSkills();

    const canonicalCompare = files[getCanonicalSkillFilePath("compare-papers")];
    const canonicalEvidence =
      files[getCanonicalSkillFilePath("evidence-based-qa")];
    assert.include(canonicalCompare, "name: compare-papers");
    assert.include(canonicalEvidence, "name: evidence-based-qa");
    assert.equal(
      parseSkill(canonicalCompare).instruction,
      parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]).instruction,
    );
    assert.equal(
      parseSkill(canonicalEvidence).instruction,
      parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]).instruction,
    );
    assert.include(canonicalCompare, "contexts: paper-set,library-corpus");
    assert.include(
      canonicalEvidence,
      "contexts: single-paper,paper-set,library-corpus",
    );
    assert.equal(files[comparePath], OLD_COMPARE_PAPERS);
    assert.equal(files[evidencePath], OLD_EVIDENCE_BASED_QA);
  });

  it("skips legacy skills with unsafe path-like ids", async function () {
    const baseDir = "/tmp/llm-for-zotero-unsafe-skill-id-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    const skillsDir = getLegacyUserSkillsDir();
    const unsafePath = `${skillsDir}/unsafe.md`;
    const unsafeTarget = getCanonicalSkillFilePath("../../escape");
    const unsafeContent = [
      "---",
      "id: ../../escape",
      "description: Unsafe skill id",
      "version: 1",
      "contexts: any",
      "activation: auto",
      "---",
      "",
      "This should not be migrated into a path-like skill id.",
    ].join("\n");
    const files: Record<string, string> = {
      [unsafePath]: unsafeContent,
    };
    const prefs = new Map<string, string>();

    installMockSkillEnvironment(baseDir, files, prefs);

    await initUserSkills();

    assert.equal(files[unsafePath], unsafeContent);
    assert.notProperty(files, unsafeTarget);
  });

  it("recovers a default skill body already tracked by the failed bootstrap path", async function () {
    const baseDir = "/tmp/llm-for-zotero-bootstrap-recovery-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    const skillsDir = getLegacyUserSkillsDir();
    const comparePath = `${skillsDir}/compare-papers.md`;
    const metadataPatchedOldDefault = patchSkillFrontmatter(
      OLD_COMPARE_PAPERS,
      BUILTIN_SKILL_FILES["compare-papers.md"],
    );
    assert.isString(metadataPatchedOldDefault);
    const files: Record<string, string> = {
      [comparePath]: metadataPatchedOldDefault as string,
    };
    const oldSkill = parseSkill(OLD_COMPARE_PAPERS);
    const prefs = new Map<string, string>([
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "compare-papers.md": hashSkillForUpgrade(
            OLD_COMPARE_PAPERS,
            oldSkill.instruction,
          ),
        }),
      ],
    ]);

    installMockSkillEnvironment(baseDir, files, prefs);

    await initUserSkills();

    const canonicalCompare = files[getCanonicalSkillFilePath("compare-papers")];
    assert.include(canonicalCompare, "name: compare-papers");
    assert.equal(
      parseSkill(canonicalCompare).instruction,
      parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]).instruction,
    );
  });

  it("preserves a customized tracked body while patching old shipped contexts", async function () {
    const baseDir = "/tmp/llm-for-zotero-bootstrap-customized-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    const skillsDir = getLegacyUserSkillsDir();
    const comparePath = `${skillsDir}/compare-papers.md`;
    const metadataPatchedOldDefault = patchSkillFrontmatter(
      OLD_COMPARE_PAPERS,
      BUILTIN_SKILL_FILES["compare-papers.md"],
    );
    assert.isString(metadataPatchedOldDefault);
    const customized = (metadataPatchedOldDefault as string).replace(
      "Use Zotero paper tools as resources, not a ritual.",
      "Use my customized comparison workflow.",
    );
    const customSkill = parseSkill(customized);
    const files: Record<string, string> = {
      [comparePath]: customized,
    };
    const prefs = new Map<string, string>([
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "compare-papers.md": hashSkillForUpgrade(
            customized,
            customSkill.instruction,
          ),
        }),
      ],
    ]);

    installMockSkillEnvironment(baseDir, files, prefs);

    await initUserSkills();

    const canonicalCompare = files[getCanonicalSkillFilePath("compare-papers")];
    assert.notEqual(canonicalCompare, BUILTIN_SKILL_FILES["compare-papers.md"]);
    assert.include(canonicalCompare, "Use my customized comparison workflow.");
    assert.include(canonicalCompare, "contexts: paper-set,library-corpus");
    assert.include(canonicalCompare, "name: compare-papers");
  });

  it("refreshes the write-note managed block while preserving appended customizations", async function () {
    const baseDir = "/tmp/llm-for-zotero-bootstrap-write-note-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    const shipped = BUILTIN_SKILL_FILES["write-note.md"];
    // Simulate a user on an older shipped managed block who appended a
    // customization section after MANAGED-END (the supported flow).
    const oldManagedOnDisk = spliceManagedBlock(
      shipped,
      "\nOLD MANAGED CONTENT — previous shipped version.\n",
    );
    assert.isString(oldManagedOnDisk);
    const customization =
      "\n\n## Your customizations\n\nPath pattern: `{papertitle}/{papertitle}.md`\n";
    const onDisk = (oldManagedOnDisk as string) + customization;
    const onDiskSkill = parseSkill(onDisk);
    const writeNotePath = getCanonicalSkillFilePath("write-note");
    const files: Record<string, string> = {
      [writeNotePath]: onDisk,
    };
    const prefs = new Map<string, string>([
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "write-note.md": hashSkillForUpgrade(onDisk, onDiskSkill.instruction),
        }),
      ],
    ]);

    installMockSkillEnvironment(baseDir, files, prefs);

    await initUserSkills();

    const canonicalWriteNote = files[writeNotePath];
    assert.notInclude(canonicalWriteNote, "OLD MANAGED CONTENT");
    assert.equal(
      extractManagedBlock(canonicalWriteNote).block,
      extractManagedBlock(shipped).block,
    );
    assert.include(canonicalWriteNote, "## Your customizations");
    assert.include(
      canonicalWriteNote,
      "Path pattern: `{papertitle}/{papertitle}.md`",
    );
    assert.equal(
      parseSkill(canonicalWriteNote).version,
      parseSkill(shipped).version,
    );
    // The context_read source step lives in context_read's guidance (#541).
    assert.notInclude(canonicalWriteNote, "`context_read`");
    assert.include(canonicalWriteNote, "narrowly scoped note");
    assert.include(canonicalWriteNote, "`sourceMessageId`");
    assert.include(canonicalWriteNote, "returned `documentId`");
  });

  for (const [name, version] of [
    ["compare-papers", 7],
    ["compare-papers", 9],
    ["compare-papers", 10],
    ["compare-papers", 11],
    ["evidence-based-qa", 8],
    ["evidence-based-qa", 12],
    ["literature-review", 11],
    ["literature-review", 12],
    ["literature-review", 13],
    ["literature-review", 14],
    ["literature-review", 15],
    ["literature-review", 16],
    ["literature-review", 17],
    ["library-analysis", 5],
    ["reorganize-library", 1],
    ["write-note", 18],
    ["import-cited-reference", 6],
  ] as const) {
    for (const mode of ["tracked", "untracked-native", "customized"] as const) {
      it(`preserves upgrade ownership for ${name} (${mode})`, async function () {
        const baseDir = `/tmp/llm-for-zotero-skill-upgrade-${name}-${mode}`;
        const raw = readFileSync(
          new URL(
            `./fixtures/skillUpgrades/${name}-v${version}.md`,
            import.meta.url,
          ),
          "utf8",
        );
        const files: Record<string, string> = {};
        const prefs = new Map<string, string>();
        installMockSkillEnvironment(baseDir, files, prefs);
        // The canonical path follows the skill id, which can differ from the
        // shipped filename (import-cited-reference.md ships import-to-library).
        const skillId = parseSkill(BUILTIN_SKILL_FILES[`${name}.md`]).id;
        const filePath = getCanonicalSkillFilePath(skillId);
        const native = raw.replace("---\n", `---\nname: ${skillId}\n`);
        files[filePath] =
          mode === "customized"
            ? native + "\nKeep my private research workflow.\n"
            : native;
        if (mode !== "untracked-native") {
          prefs.set(
            BODY_HASH_PREF_KEY,
            JSON.stringify({
              [`${name}.md`]: hashSkillForUpgrade(
                raw,
                parseSkill(raw).instruction,
              ),
            }),
          );
        }
        const before = parseSkill(files[filePath]).instruction;
        await initUserSkills();
        const shippedSkill = BUILTIN_SKILL_FILES[`${name}.md`];
        if (mode === "customized" && extractManagedBlock(raw).block) {
          // A managed skill refreshes its block and keeps what follows it.
          assert.equal(
            extractManagedBlock(files[filePath]).block,
            extractManagedBlock(shippedSkill).block,
          );
          assert.include(files[filePath], "Keep my private research workflow.");
          return;
        }
        assert.equal(
          parseSkill(files[filePath]).instruction,
          mode === "customized" ? before : parseSkill(shippedSkill).instruction,
        );
      });
    }
  }

  it("bootstrap-upgrades an unmodified v15 write-note that has no stored hash", async function () {
    const baseDir = "/tmp/llm-for-zotero-bootstrap-write-note-v15-test";
    installMockSkillEnvironment(baseDir, {}, new Map<string, string>());
    // The exact v15 file: the one line and the version v16 changed.
    const v16 = readFileSync(
      new URL("./fixtures/skillUpgrades/write-note-v16.md", import.meta.url),
      "utf8",
    );
    const v15 = v16
      .replace("version: 16\n", "version: 15\n")
      .replace(
        'Use `context_read` with `source: "conversation"` only when',
        "Use `conversation_read` only when",
      );
    assert.notEqual(v15, v16);
    const writeNotePath = getCanonicalSkillFilePath("write-note");
    const files: Record<string, string> = { [writeNotePath]: v15 };

    installMockSkillEnvironment(baseDir, files, new Map<string, string>());
    await initUserSkills();

    const upgraded = files[writeNotePath];
    assert.equal(
      parseSkill(upgraded).version,
      parseSkill(BUILTIN_SKILL_FILES["write-note.md"]).version,
    );
    assert.equal(
      parseSkill(upgraded).instruction,
      parseSkill(BUILTIN_SKILL_FILES["write-note.md"]).instruction,
    );
    assert.notInclude(upgraded, "conversation_read");
  });

  it("neither adds nor strips the retired supersedes key and keeps legacy match metadata", function () {
    // supersedes is retired: a shipped file declaring it no longer propagates
    // the key, and a user file that still carries it keeps its line verbatim.
    const shipped = BUILTIN_SKILL_FILES["evidence-based-qa.md"].replace(
      "activation: auto\n",
      "activation: auto\nsupersedes: older-skill\n",
    );
    const old = BUILTIN_SKILL_FILES["evidence-based-qa.md"].replace(
      /version: \d+/,
      "version: 6\nmatch: legacy fixture only",
    );
    const patched = patchSkillFrontmatter(old, shipped);
    assert.isString(patched);
    assert.notInclude(patched as string, "supersedes:");
    assert.include(patched as string, "match:");
    assert.equal(
      parseSkill(patched as string).version,
      parseSkill(shipped).version,
    );

    const userCopy = old.replace(
      "match: legacy fixture only",
      "match: legacy fixture only\nsupersedes: user-kept",
    );
    const patchedUserCopy = patchSkillFrontmatter(userCopy, shipped);
    assert.isString(patchedUserCopy);
    assert.include(patchedUserCopy as string, "supersedes: user-kept");
  });
  for (const [name, version] of [["evidence-based-qa", 7]] as const) {
    it(`upgrades the unmodified baseline ${name} skill without stored hashes`, async function () {
      const baseDir = `/tmp/llm-for-zotero-baseline-${name}-upgrade`;
      const raw = readFileSync(
        new URL(
          `./fixtures/qaEvaluation/skills/${name}-v${version}.md`,
          import.meta.url,
        ),
        "utf8",
      );
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment(baseDir, files, prefs);
      const filePath = getCanonicalSkillFilePath(name);
      files[filePath] = raw;
      await initUserSkills();
      assert.equal(
        parseSkill(files[filePath]).instruction,
        parseSkill(BUILTIN_SKILL_FILES[`${name}.md`]).instruction,
      );
    });
    it(`upgrades the tracked untouched baseline ${name} body`, async function () {
      const baseDir = `/tmp/llm-for-zotero-tracked-${name}-upgrade`;
      const raw = readFileSync(
        new URL(
          `./fixtures/qaEvaluation/skills/${name}-v${version}.md`,
          import.meta.url,
        ),
        "utf8",
      );
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment(baseDir, files, prefs);
      const filePath = getCanonicalSkillFilePath(name);
      files[filePath] = raw;
      prefs.set(
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          [`${name}.md`]: hashSkillForUpgrade(raw, parseSkill(raw).instruction),
        }),
      );
      await initUserSkills();
      assert.equal(
        parseSkill(files[filePath]).instruction,
        parseSkill(BUILTIN_SKILL_FILES[`${name}.md`]).instruction,
      );
    });
  }
  function assertUpgradedToShipped(upgraded: string, name: string) {
    const shippedRaw = BUILTIN_SKILL_FILES[`${name}.md`];
    const shipped = parseSkill(shippedRaw);
    assert.equal(parseSkill(upgraded).version, shipped.version);
    assert.equal(parseSkill(upgraded).description, shipped.description);
    // A tracked upgrade refreshes only a managed block; text outside the
    // markers stays with the user.
    const shippedBlock = extractManagedBlock(shippedRaw).block;
    if (shippedBlock === null) {
      assert.equal(parseSkill(upgraded).instruction, shipped.instruction);
    } else {
      assert.equal(extractManagedBlock(upgraded).block, shippedBlock);
    }
    assert.deepEqual(parseSkill(upgraded).contexts, shipped.contexts);
  }
  it("patches old shipped analyze-figures contexts on a customized copy", async function () {
    const customized = readFileSync(
      new URL(
        "./fixtures/skillUpgrades/analyze-figures-v10.md",
        import.meta.url,
      ),
      "utf8",
    ).replace(
      "## Requested persistence",
      "My own figure rule.\n\n## Requested persistence",
    );
    const files: Record<string, string> = {};
    installMockSkillEnvironment(
      "/tmp/llm-for-zotero-customized-analyze-figures",
      files,
      new Map<string, string>(),
    );
    const filePath = getCanonicalSkillFilePath("analyze-figures");
    files[filePath] = customized;
    await initUserSkills();
    assert.include(files[filePath], "My own figure rule.");
    assert.deepEqual(parseSkill(files[filePath]).contexts, [
      "single-paper",
      "paper-set",
      "library-corpus",
      "visual-input",
    ]);
  });
  // Exact pre-edit copies of the previously shipped version of every skill
  // whose rules moved to a single owner. An unmodified install must upgrade
  // both without a stored hash (bootstrap raw hash) and with one (tracked
  // body hash); a missing hash leaves the user on the stale copy.
  for (const fixture of [
    "evidence-based-qa-v8",
    "evidence-based-qa-v9",
    "evidence-based-qa-v10",
    "evidence-based-qa-v12",
    "compare-papers-v7",
    "compare-papers-v9",
    "compare-papers-v10",
    "compare-papers-v11",
    "write-note-v16",
    "write-note-v18",
    "analyze-figures-v9",
    "analyze-figures-v10",
    "import-cited-reference-v3",
    "import-cited-reference-v4",
    "import-cited-reference-v6",
    "literature-review-v10",
    "literature-review-v11",
    "literature-review-v12",
    "literature-review-v13",
    "literature-review-v14",
    "literature-review-v15",
    "literature-review-v16",
    "literature-review-v17",
    "library-analysis-v4",
    "library-analysis-v5",
    "reorganize-library-v1",
    // The simplified texts main shipped at the same version numbers
    // (ad2c0fec) before the tool consolidation merged.
    "simplified/analyze-figures-v10",
    "simplified/compare-papers-v8",
    "simplified/evidence-based-qa-v9",
    "simplified/import-cited-reference-v4",
    "simplified/literature-review-v9",
    "simplified/write-note-v16",
  ] as const) {
    const name = fixture.replace(/^.*\//, "").replace(/-v\d+$/, "");
    // The canonical path follows the skill id, which can differ from the
    // shipped filename (import-cited-reference.md ships id import-to-library).
    const skillId = parseSkill(BUILTIN_SKILL_FILES[`${name}.md`]).id;
    const readFixture = () =>
      readFileSync(
        new URL(`./fixtures/skillUpgrades/${fixture}.md`, import.meta.url),
        "utf8",
      );
    it(`bootstrap-upgrades the unmodified previous ${fixture} without a stored hash`, async function () {
      const files: Record<string, string> = {};
      installMockSkillEnvironment(
        `/tmp/llm-for-zotero-previous-${fixture}`,
        files,
        new Map<string, string>(),
      );
      const filePath = getCanonicalSkillFilePath(skillId);
      files[filePath] = readFixture();
      await initUserSkills();
      assertUpgradedToShipped(files[filePath], name);
    });
    it(`upgrades the tracked unmodified previous ${fixture}`, async function () {
      const raw = readFixture();
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment(
        `/tmp/llm-for-zotero-tracked-previous-${fixture}`,
        files,
        prefs,
      );
      const filePath = getCanonicalSkillFilePath(skillId);
      files[filePath] = raw;
      prefs.set(
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          [`${name}.md`]: hashSkillForUpgrade(raw, parseSkill(raw).instruction),
        }),
      );
      await initUserSkills();
      assertUpgradedToShipped(files[filePath], name);
    });
  }
});
