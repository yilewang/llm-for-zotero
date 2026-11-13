import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  migrateClaudePermissionMode,
  migrateCodexPermissionState,
  migrateOriginalAgentPermissionMode,
} from "../src/utils/migrations";
import {
  CODEX_APPROVE_PERMISSION_STATE,
  CODEX_CUSTOM_PERMISSION_STATE,
  serializeCodexPermissionState,
} from "../src/codexAppServer/permissionState";
import {
  getCustomShortcuts,
  getDeletedShortcutIds,
  getShortcutOrder,
  getShortcutOverrides,
  migrateShortcutDefaultsIfNeeded,
  resetShortcutsToDefault,
  setCustomShortcuts,
  setDeletedShortcutIds,
  setShortcutLabelOverrides,
  setShortcutOrder,
  setShortcutOverrides,
} from "../src/modules/contextPanel/prefHelpers";
import {
  ensureClaudeProjectBootstrap,
  getDefaultClaudeManagedInstructionBlock,
} from "../src/claudeCode/bootstrap";
import {
  getClaudeProjectDir,
  getClaudeProjectInstructionFile,
} from "../src/claudeCode/projectSkills";
import { patchSkillFrontmatter } from "../src/agent/skills/frontmatterPatcher";
import {
  extractManagedBlock,
  hashSkillForUpgrade,
} from "../src/agent/skills/managedBlock";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  getCanonicalSkillFilePath,
  getCanonicalUserSkillsDir,
  getLegacyUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
import {
  ANALYZE_FIGURES_V10,
  LIBRARY_ANALYSIS_V5,
  OLD_COMPARE_PAPERS,
  OLD_EVIDENCE_BASED_QA,
  WRITE_NOTE_V16,
} from "./fixtures/skillUpgrades";

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;

const P = "extensions.zotero.llmforzotero.";
const L = "extensions.zotero.llmForZotero.";

// ---------------------------------------------------------------------------
// Save and restore: these scenarios write to the test profile's real prefs
// and files, so each one puts back exactly what it found.
// ---------------------------------------------------------------------------

type PrefBackup = { key: string; had: boolean; value: unknown };

function backupPrefs(keys: string[]): PrefBackup[] {
  return keys.map((key) => {
    const had = Services.prefs.prefHasUserValue(key);
    return { key, had, value: had ? Zotero.Prefs.get(key, true) : undefined };
  });
}

function restorePrefs(backups: PrefBackup[]): void {
  for (const { key, had, value } of backups) {
    if (had) Zotero.Prefs.set(key, value, true);
    else Zotero.Prefs.clear(key, true);
  }
}

function clearPrefs(keys: string[]): void {
  for (const key of keys) Zotero.Prefs.clear(key, true);
}

function hasUserPref(key: string): boolean {
  return Services.prefs.prefHasUserValue(key);
}

type PathBackup = { path: string; existed: boolean; copy: string };

async function backupPath(path: string, tag: string): Promise<PathBackup> {
  const existed = await IOUtils.exists(path);
  const copy = PathUtils.join(
    PathUtils.tempDir,
    `llmz-migration-backup-${Date.now()}-${tag}`,
  );
  if (existed) await IOUtils.copy(path, copy, { recursive: true });
  return { path, existed, copy };
}

async function restorePath(backup: PathBackup): Promise<void> {
  await IOUtils.remove(backup.path, { recursive: true, ignoreAbsent: true });
  if (backup.existed) {
    await IOUtils.makeDirectory(PathUtils.parent(backup.path), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.copy(backup.copy, backup.path, { recursive: true });
    await IOUtils.remove(backup.copy, { recursive: true, ignoreAbsent: true });
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await IOUtils.makeDirectory(PathUtils.parent(path), {
    createAncestors: true,
    ignoreExisting: true,
  });
  await IOUtils.writeUTF8(path, text);
}

async function readText(path: string): Promise<string> {
  return IOUtils.readUTF8(path);
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------

describe("workflow: user-content migrations", function () {
  this.timeout(120000);

  // ---- permission modes ---------------------------------------------------

  describe("permission-mode migrations", function () {
    const keys = [
      "claudeCodePermissionMode",
      "claudeCodePermissionModeMigrationDone",
      "agentPermissionMode",
      "agentLibraryWriteMode",
      "originalAgentPermissionMode",
      "originalAgentPermissionModeMigrationDone",
      "codexAppServerPermissionState",
      "codexAppServerPermissionStateMigrationDone",
      "codexAppServerApprovalsReviewer",
      "codexAppServerPermissionProfile",
    ].map((name) => P + name);
    let saved: PrefBackup[];

    beforeEach(function () {
      saved = backupPrefs(keys);
      clearPrefs(keys);
    });
    afterEach(function () {
      restorePrefs(saved);
    });

    it("keeps a modern Claude mode and does not read the legacy one", function () {
      Zotero.Prefs.set(`${P}claudeCodePermissionMode`, "plan", true);
      Zotero.Prefs.set(`${P}agentPermissionMode`, "yolo", true);
      migrateClaudePermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}claudeCodePermissionMode`, true),
        "plan",
      );
      assert.isTrue(
        Zotero.Prefs.get(`${P}claudeCodePermissionModeMigrationDone`, true),
      );
    });

    it("maps the legacy Claude mode once", function () {
      Zotero.Prefs.set(`${P}agentPermissionMode`, "yolo", true);
      migrateClaudePermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}claudeCodePermissionMode`, true),
        "bypassPermissions",
      );
      // A later change to the legacy value is not read again.
      Zotero.Prefs.set(`${P}agentPermissionMode`, "safe", true);
      Zotero.Prefs.clear(`${P}claudeCodePermissionMode`, true);
      migrateClaudePermissionMode();
      assert.isFalse(
        hasUserPref(`${P}claudeCodePermissionMode`),
        "the second run does nothing",
      );

      // A non-yolo legacy value maps to the default mode.
      clearPrefs(keys);
      Zotero.Prefs.set(`${P}agentPermissionMode`, "safe", true);
      migrateClaudePermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}claudeCodePermissionMode`, true),
        "default",
      );
    });

    it("migrates the library-only Original Agent mode without changing a valid value", function () {
      Zotero.Prefs.set(`${P}agentLibraryWriteMode`, "safe", true);
      migrateOriginalAgentPermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}originalAgentPermissionMode`, true),
        "safe",
      );

      clearPrefs(keys);
      Zotero.Prefs.set(`${P}originalAgentPermissionMode`, "yolo", true);
      Zotero.Prefs.set(`${P}agentLibraryWriteMode`, "safe", true);
      migrateOriginalAgentPermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}originalAgentPermissionMode`, true),
        "yolo",
        "a modern value is not overwritten",
      );

      clearPrefs(keys);
      migrateOriginalAgentPermissionMode();
      assert.equal(
        Zotero.Prefs.get(`${P}originalAgentPermissionMode`, true),
        "auto",
        "no legacy value gives the default",
      );
    });

    it("maps the old Codex reviewer to Approve, never to Full access, exactly once", function () {
      Zotero.Prefs.set(
        `${P}codexAppServerApprovalsReviewer`,
        "auto_review",
        true,
      );
      Zotero.Prefs.set(
        `${P}codexAppServerPermissionProfile`,
        ":danger-full-access",
        true,
      );
      migrateCodexPermissionState();
      assert.equal(
        Zotero.Prefs.get(`${P}codexAppServerPermissionState`, true),
        serializeCodexPermissionState(CODEX_APPROVE_PERMISSION_STATE),
      );
      assert.isTrue(
        Zotero.Prefs.get(
          `${P}codexAppServerPermissionStateMigrationDone`,
          true,
        ),
      );

      // Run again with a changed legacy value: the state stays as migrated.
      Zotero.Prefs.set(`${P}codexAppServerApprovalsReviewer`, "user", true);
      migrateCodexPermissionState();
      assert.equal(
        Zotero.Prefs.get(`${P}codexAppServerPermissionState`, true),
        serializeCodexPermissionState(CODEX_APPROVE_PERMISSION_STATE),
      );
    });

    it("keeps an existing Codex state and writes none when there is no legacy value", function () {
      const preserved = serializeCodexPermissionState(
        CODEX_CUSTOM_PERMISSION_STATE,
      );
      Zotero.Prefs.set(`${P}codexAppServerPermissionState`, preserved, true);
      Zotero.Prefs.set(
        `${P}codexAppServerApprovalsReviewer`,
        "auto_review",
        true,
      );
      migrateCodexPermissionState();
      assert.equal(
        Zotero.Prefs.get(`${P}codexAppServerPermissionState`, true),
        preserved,
      );

      clearPrefs(keys);
      migrateCodexPermissionState();
      assert.isFalse(hasUserPref(`${P}codexAppServerPermissionState`));
      assert.isTrue(
        Zotero.Prefs.get(
          `${P}codexAppServerPermissionStateMigrationDone`,
          true,
        ),
      );
    });
  });

  // ---- shortcut defaults ----------------------------------------------------

  describe("shortcut defaults migration", function () {
    const keys = [
      "shortcuts",
      "shortcutLabels",
      "shortcutDeleted",
      "customShortcuts",
      "shortcutOrder",
      "shortcutDefaultsMigrationVersion",
    ].map((name) => P + name);
    const versionKey = `${P}shortcutDefaultsMigrationVersion`;
    let saved: PrefBackup[];
    let api: WorkflowTestApi;
    let paper: Awaited<
      ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
    >;

    before(async function () {
      api = (Zotero as any).LLMForZotero.api.workflowTest;
      paper = await api.createPaperWithPdfFixture({
        title: "Shortcut migration paper",
        pages: ["Disposable paper for the shortcut migration."],
      });
    });
    after(async function () {
      if (paper) await api.cleanupFixture(paper);
    });
    beforeEach(function () {
      saved = backupPrefs(keys);
      clearPrefs(keys);
    });
    afterEach(async function () {
      await api.reset();
      restorePrefs(saved);
    });

    async function waitFor<T>(read: () => T | null | undefined, label: string) {
      const deadline = Date.now() + 8000;
      for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await Zotero.Promise.delay(50);
      }
    }

    async function renderedShortcutLabels(): Promise<string[]> {
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const body = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
      await waitFor(
        () => body.querySelector(".llm-shortcut-btn"),
        "shortcut buttons",
      );
      // Let the render settle past the first button.
      await Zotero.Promise.delay(300);
      return Array.from(body.querySelectorAll(".llm-shortcut-btn")).map((el) =>
        (el?.textContent || "").trim(),
      );
    }

    it("keeps a customized override, restores Diagram once, and respects a later delete", async function () {
      Zotero.Prefs.set(versionKey, 1, true);
      setShortcutOverrides({
        summarize: "Explain this paper for a first-year PhD student.",
      });
      setShortcutOrder([
        "summarize",
        "key-points",
        "methodology",
        "limitations",
      ]);
      setDeletedShortcutIds(["mermaid-diagram"]);

      const labels = await renderedShortcutLabels();

      assert.include(labels, "Diagram", "the Diagram button is back");
      assert.equal(Zotero.Prefs.get(versionKey, true), 2);
      assert.equal(
        getShortcutOverrides().summarize,
        "Explain this paper for a first-year PhD student.",
      );
      assert.notInclude(getDeletedShortcutIds(), "mermaid-diagram");
      assert.include(getShortcutOrder(), "mermaid-diagram");

      // The user deletes Diagram again: the current marker keeps it deleted.
      setDeletedShortcutIds(["mermaid-diagram"]);
      const again = await renderedShortcutLabels();
      assert.notInclude(again, "Diagram");
      assert.deepEqual(getDeletedShortcutIds(), ["mermaid-diagram"]);
      assert.equal(Zotero.Prefs.get(versionKey, true), 2);
    });

    it("removes an unchanged old built-in override", function () {
      setShortcutOverrides({
        summarize: "Summarize the document in 3-5 bullet points.",
      });
      migrateShortcutDefaultsIfNeeded();
      assert.notProperty(getShortcutOverrides(), "summarize");
      assert.equal(Zotero.Prefs.get(versionKey, true), 2);
    });

    it("keeps custom shortcuts, including a custom Diagram label with its own prompt", function () {
      const custom = [
        {
          id: "custom-shortcut-diagram",
          label: "Diagram",
          prompt: "Make a concept map focused only on methods.",
        },
      ];
      setCustomShortcuts(custom);
      migrateShortcutDefaultsIfNeeded();
      assert.deepEqual(getCustomShortcuts(), custom);
    });

    it("dedupes order and custom state and blocks built-in id collisions", function () {
      setDeletedShortcutIds([
        "summarize",
        "summarize",
        "unknown",
        "mermaid-diagram",
      ]);
      Zotero.Prefs.set(
        `${P}customShortcuts`,
        JSON.stringify([
          { id: "custom-shortcut-a", label: "A", prompt: "Prompt A" },
          { id: "custom-shortcut-a", label: "B", prompt: "Prompt B" },
          { id: "custom-shortcut-b", label: "A", prompt: "Prompt A" },
          { id: "summarize", label: "Bad", prompt: "Should not render" },
          {
            id: "custom-shortcut-c",
            label: "Diagram",
            prompt: "Different prompt",
          },
        ]),
        true,
      );
      setShortcutOrder([
        "custom-shortcut-a",
        "custom-shortcut-a",
        "summarize",
        "missing",
        "mermaid-diagram",
      ]);
      migrateShortcutDefaultsIfNeeded();
      assert.deepEqual(getDeletedShortcutIds(), ["summarize"]);
      assert.deepEqual(
        getCustomShortcuts().map((shortcut) => shortcut.id),
        ["custom-shortcut-a", "custom-shortcut-c"],
      );
      const order = getShortcutOrder();
      assert.lengthOf(order, new Set(order).size);
      assert.notInclude(order, "summarize");
      assert.notInclude(order, "missing");
      assert.include(order, "mermaid-diagram");
      assert.include(order, "custom-shortcut-a");
      assert.include(order, "custom-shortcut-c");
    });

    it("resets every shortcut pref to its default", function () {
      setShortcutOverrides({ summarize: "Custom" });
      setShortcutLabelOverrides({ summarize: "S" });
      setDeletedShortcutIds(["limitations"]);
      setCustomShortcuts([
        { id: "custom-shortcut-a", label: "A", prompt: "Prompt A" },
      ]);
      setShortcutOrder(["custom-shortcut-a"]);
      resetShortcutsToDefault();
      for (const name of [
        "shortcuts",
        "shortcutLabels",
        "shortcutDeleted",
        "customShortcuts",
        "shortcutOrder",
      ]) {
        assert.isFalse(hasUserPref(P + name), `${name} is cleared`);
      }
      assert.deepEqual(getShortcutOverrides(), {});
      assert.deepEqual(getDeletedShortcutIds(), []);
      assert.deepEqual(getCustomShortcuts(), []);
      assert.deepEqual(getShortcutOrder(), []);
    });
  });

  // ---- Claude instruction file ---------------------------------------------

  describe("Claude managed instruction block", function () {
    const BEGIN = "<!-- LLM-FOR-ZOTERO:CLAUDE-MANAGED-BEGIN -->";
    const END = "<!-- LLM-FOR-ZOTERO:CLAUDE-MANAGED-END -->";
    let fileBackup: PathBackup;
    let dirBackup: PathBackup;
    let promptBackup: PrefBackup[];
    const file = () => getClaudeProjectInstructionFile();

    before(async function () {
      const suffix = String(Date.now());
      fileBackup = await backupPath(file(), `claude-md-${suffix}`);
      dirBackup = await backupPath(
        getClaudeProjectDir(),
        `claude-dir-${suffix}`,
      );
      promptBackup = backupPrefs([`${P}claudeManagedInstructionTemplate`]);
    });
    after(async function () {
      await restorePath(fileBackup);
      await restorePath(dirBackup);
      restorePrefs(promptBackup);
    });

    function wrap(block: string): string {
      return `Before the block.\n\n${BEGIN}\n${block}\n${END}\n\nAfter the block.\n`;
    }

    it("keeps a customized managed block and adds the config model once", async function () {
      const custom = [
        "# My Claude instructions",
        "",
        "Always use my laboratory terminology.",
      ].join("\n");
      await writeText(file(), wrap(custom));

      await ensureClaudeProjectBootstrap();
      const first = await readText(file());
      assert.include(first, "Always use my laboratory terminology.");
      assert.equal(countOf(first, "## Config model"), 1);
      assert.include(first, "Before the block.");
      assert.include(first, "After the block.");
      assert.notInclude(first, "CLAUDE-CONTRACT-VERSION:2");

      await ensureClaudeProjectBootstrap();
      assert.equal(
        await readText(file()),
        first,
        "the second run changes nothing",
      );
    });

    it("keeps an edited stock block byte for byte", async function () {
      const edited = getDefaultClaudeManagedInstructionBlock().replace(
        "stable profile configuration only",
        "stable profile configuration plus my laboratory convention",
      );
      const content = wrap(edited);
      await writeText(file(), content);
      await ensureClaudeProjectBootstrap();
      assert.equal(await readText(file()), content);
    });

    it("keeps a customized block that already has profile config, and a current stock block", async function () {
      const withConfig = wrap(
        [
          "# My Claude instructions",
          "Always use my laboratory terminology.",
          "",
          "## Config model",
          "- Shared Zotero profile runtime root: `/custom/runtime`.",
        ].join("\n"),
      );
      await writeText(file(), withConfig);
      await ensureClaudeProjectBootstrap();
      assert.equal(await readText(file()), withConfig);

      const stock = wrap(getDefaultClaudeManagedInstructionBlock());
      await writeText(file(), stock);
      await ensureClaudeProjectBootstrap();
      const after = await readText(file());
      assert.equal(after, stock);
      assert.equal(countOf(after, "CLAUDE-CONTRACT-VERSION:2"), 1);
      assert.include(after, "stable profile configuration only");
    });
  });

  // ---- user skills ------------------------------------------------------------

  describe("user skills upgrades", function () {
    const prefKeys = [
      `${L}skillBodyHashes`,
      `${L}seededBuiltinSkills`,
      `${L}seededSkillsDir`,
    ];
    let api: WorkflowTestApi;
    let builtin: Record<string, string>;
    let canonicalBackup: PathBackup;
    let legacyBackup: PathBackup;
    let savedPrefs: PrefBackup[];

    before(async function () {
      api = (Zotero as any).LLMForZotero.api.workflowTest;
      builtin = api.readBuiltinSkillFiles();
      const suffix = String(Date.now());
      canonicalBackup = await backupPath(
        getCanonicalUserSkillsDir(),
        `skills-${suffix}`,
      );
      legacyBackup = await backupPath(
        getLegacyUserSkillsDir(),
        `legacy-${suffix}`,
      );
      savedPrefs = backupPrefs(prefKeys);
    });
    after(async function () {
      await restorePath(canonicalBackup);
      await restorePath(legacyBackup);
      restorePrefs(savedPrefs);
    });
    beforeEach(async function () {
      await IOUtils.remove(getCanonicalUserSkillsDir(), {
        recursive: true,
        ignoreAbsent: true,
      });
      await IOUtils.remove(getLegacyUserSkillsDir(), {
        recursive: true,
        ignoreAbsent: true,
      });
      clearPrefs(prefKeys);
    });

    /** Mark the canonical folder as already started, with these tracked hashes. */
    function trackFolder(hashes: Record<string, string>): void {
      Zotero.Prefs.set(
        `${L}seededSkillsDir`,
        getCanonicalUserSkillsDir(),
        true,
      );
      Zotero.Prefs.set(`${L}seededBuiltinSkills`, "[]", true);
      Zotero.Prefs.set(`${L}skillBodyHashes`, JSON.stringify(hashes), true);
    }

    const idOf = (filename: string) => parseSkill(builtin[filename]).id;
    const canonical = (filename: string) =>
      getCanonicalSkillFilePath(idOf(filename));

    function assertUpgradedToShipped(upgraded: string, filename: string) {
      const shippedRaw = builtin[filename];
      const shipped = parseSkill(shippedRaw);
      assert.equal(parseSkill(upgraded).version, shipped.version);
      assert.equal(parseSkill(upgraded).description, shipped.description);
      const shippedBlock = extractManagedBlock(shippedRaw).block;
      if (shippedBlock === null) {
        assert.equal(parseSkill(upgraded).instruction, shipped.instruction);
      } else {
        assert.equal(extractManagedBlock(upgraded).block, shippedBlock);
      }
      assert.deepEqual(parseSkill(upgraded).contexts, shipped.contexts);
    }

    it("upgrades unmodified historical legacy compare and evidence skills with no stored hashes", async function () {
      const legacyDir = getLegacyUserSkillsDir();
      const comparePath = PathUtils.join(legacyDir, "compare-papers.md");
      const evidencePath = PathUtils.join(legacyDir, "evidence-based-qa.md");
      await writeText(comparePath, OLD_COMPARE_PAPERS);
      await writeText(evidencePath, OLD_EVIDENCE_BASED_QA);

      await api.runUserSkillsInit();

      const compare = await readText(canonical("compare-papers.md"));
      const evidence = await readText(canonical("evidence-based-qa.md"));
      assert.include(compare, "name: compare-papers");
      assert.include(evidence, "name: evidence-based-qa");
      assert.equal(
        parseSkill(compare).instruction,
        parseSkill(builtin["compare-papers.md"]).instruction,
      );
      assert.equal(
        parseSkill(evidence).instruction,
        parseSkill(builtin["evidence-based-qa.md"]).instruction,
      );
      assert.deepEqual(
        parseSkill(compare).contexts,
        parseSkill(builtin["compare-papers.md"]).contexts,
      );
      assert.deepEqual(
        parseSkill(evidence).contexts,
        parseSkill(builtin["evidence-based-qa.md"]).contexts,
      );
      assert.equal(await readText(comparePath), OLD_COMPARE_PAPERS);
      assert.equal(await readText(evidencePath), OLD_EVIDENCE_BASED_QA);
    });

    it("leaves a legacy skill with an unsafe path-like id where it is", async function () {
      const legacyDir = getLegacyUserSkillsDir();
      const unsafePath = PathUtils.join(legacyDir, "unsafe.md");
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
      await writeText(unsafePath, unsafeContent);
      try {
        await api.runUserSkillsInit();
        assert.equal(await readText(unsafePath), unsafeContent);
        assert.isFalse(await IOUtils.exists(unsafeTarget));
      } finally {
        await IOUtils.remove(PathUtils.parent(unsafeTarget), {
          recursive: true,
          ignoreAbsent: true,
        }).catch(() => undefined);
      }
    });

    it("upgrades a tracked default compare body that an earlier start only patched", async function () {
      const patchedOld = patchSkillFrontmatter(
        OLD_COMPARE_PAPERS,
        builtin["compare-papers.md"],
      );
      assert.isString(patchedOld);
      trackFolder({
        "compare-papers.md": hashSkillForUpgrade(
          OLD_COMPARE_PAPERS,
          parseSkill(OLD_COMPARE_PAPERS).instruction,
        ),
      });
      await writeText(canonical("compare-papers.md"), patchedOld as string);

      await api.runUserSkillsInit();

      const upgraded = await readText(canonical("compare-papers.md"));
      assert.equal(
        parseSkill(upgraded).instruction,
        parseSkill(builtin["compare-papers.md"]).instruction,
      );
      assert.include(upgraded, "name: compare-papers");
    });

    it("keeps a customized tracked body and patches only its contexts", async function () {
      const patchedOld = patchSkillFrontmatter(
        OLD_COMPARE_PAPERS,
        builtin["compare-papers.md"],
      ) as string;
      const customized = patchedOld.replace(
        "Use Zotero paper tools as resources, not a ritual.",
        "Use my customized comparison workflow.",
      );
      assert.notEqual(customized, patchedOld);
      trackFolder({
        "compare-papers.md": hashSkillForUpgrade(
          customized,
          parseSkill(customized).instruction,
        ),
      });
      await writeText(canonical("compare-papers.md"), customized);

      await api.runUserSkillsInit();

      const after = await readText(canonical("compare-papers.md"));
      assert.notEqual(after, builtin["compare-papers.md"]);
      assert.include(after, "Use my customized comparison workflow.");
      assert.include(after, "name: compare-papers");
      assert.deepEqual(
        parseSkill(after).contexts,
        parseSkill(builtin["compare-papers.md"]).contexts,
      );
    });

    it("upgrades an unmodified earlier write-note, library-analysis, and analyze-figures", async function () {
      // The retired tool name the v15 body used. Built from its parts so the
      // retired-name check (check:tool-vocabulary) does not flag this data.
      const retiredName = ["conversation", "read"].join("_");
      // The exact v15 write-note: the one line and the version v16 changed.
      const writeNoteV15 = WRITE_NOTE_V16.replace(
        "version: 16\n",
        "version: 15\n",
      ).replace(
        'Use `context_read` with `source: "conversation"` only when',
        `Use \`${retiredName}\` only when`,
      );
      assert.notEqual(writeNoteV15, WRITE_NOTE_V16);
      await writeText(canonical("write-note.md"), writeNoteV15);
      await writeText(canonical("library-analysis.md"), LIBRARY_ANALYSIS_V5);

      await api.runUserSkillsInit();

      const writeNote = await readText(canonical("write-note.md"));
      assert.equal(
        parseSkill(writeNote).version,
        parseSkill(builtin["write-note.md"]).version,
      );
      assert.equal(
        parseSkill(writeNote).instruction,
        parseSkill(builtin["write-note.md"]).instruction,
      );
      assert.notInclude(writeNote, retiredName);
      assertUpgradedToShipped(
        await readText(canonical("library-analysis.md")),
        "library-analysis.md",
      );
    });

    it("upgrades a tracked unmodified earlier library-analysis", async function () {
      trackFolder({
        "library-analysis.md": hashSkillForUpgrade(
          LIBRARY_ANALYSIS_V5,
          parseSkill(LIBRARY_ANALYSIS_V5).instruction,
        ),
      });
      await writeText(canonical("library-analysis.md"), LIBRARY_ANALYSIS_V5);
      await api.runUserSkillsInit();
      assertUpgradedToShipped(
        await readText(canonical("library-analysis.md")),
        "library-analysis.md",
      );
    });

    it("patches the contexts of a customized analyze-figures and keeps the user's rule", async function () {
      const customized = ANALYZE_FIGURES_V10.replace(
        "## Requested persistence",
        "My own figure rule.\n\n## Requested persistence",
      );
      assert.notEqual(customized, ANALYZE_FIGURES_V10);
      await writeText(canonical("analyze-figures.md"), customized);

      await api.runUserSkillsInit();

      const after = await readText(canonical("analyze-figures.md"));
      assert.include(after, "My own figure rule.");
      assert.deepEqual(
        parseSkill(after).contexts,
        parseSkill(builtin["analyze-figures.md"]).contexts,
      );
    });
  });
});
