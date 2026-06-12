import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { patchSkillFrontmatter } from "../src/agent/skills/frontmatterPatcher";
import { hashSkillForUpgrade } from "../src/agent/skills/managedBlock";
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
});
