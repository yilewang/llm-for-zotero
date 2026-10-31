/**
 * The zotero-script skill is the one owner of zotero_script's working rules:
 * the env helpers, the undo rules and the copy-or-move recipe. It ships as a
 * built-in skill that installs and upgrades like the others, so a user's own
 * copy is kept. The model-facing description of zotero_script points to it,
 * and run_command and file_io state their use and approval in one sentence;
 * none of the three carries guidance text that no turn ever selects, and
 * literature_search's source rules live in its description alone.
 * test-workflows/zoteroScriptSkill.workflow.test.ts runs the recipe against
 * native Zotero.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import {
  getSkillRoutingDiagnostics,
  parseSkill,
} from "../src/agent/skills/skillLoader";
import { hashSkillForUpgrade } from "../src/agent/skills/managedBlock";
import { getCanonicalSkillFilePath } from "../src/agent/skills/nativeSkillPaths";
import { initUserSkills } from "../src/agent/skills/userSkills";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { toolGuidanceItems } from "../src/agent/tools/guidance";
import { createLoadSkillTool } from "../src/agent/tools/read/loadSkill";
import { LITERATURE_SEARCH_GUIDANCE } from "../src/agent/tools/read/literatureSearch";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";

const BODY_HASH_PREF_KEY = "extensions.zotero.llmForZotero.skillBodyHashes";
const SEEDED_PREF_KEY = "extensions.zotero.llmForZotero.seededBuiltinSkills";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: unknown;
  IOUtils?: unknown;
};

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
        if (parent === normalized) children.add(filePath);
        else if (parent.replace(/[\\/][^\\/]*$/, "") === normalized)
          children.add(parent);
      }
      return [...children];
    },
    read: async (path: string) => encoder.encode(files[path] || ""),
    write: async (path: string, data: Uint8Array) => {
      files[path] = decoder.decode(data);
      return data.byteLength;
    },
    remove: async (path: string) => {
      delete files[path];
    },
  };
}

function registry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function modelDescription(name: string): string {
  const spec = registry()
    .listTools()
    .find((tool) => tool.name === name);
  assert.exists(spec, `${name} is listed to models`);
  return spec!.description;
}

/** The recipe block, with its three constants set as a caller would. */
function recipe(instruction: string): string {
  const match =
    /### Copy or move items to another library[\s\S]*?```javascript\n([\s\S]*?)```/.exec(
      instruction,
    );
  assert.exists(match, "the skill carries the recipe as one script");
  return match![1]
    .replace(/^const sourceItemIds = .*;$/m, "const sourceItemIds = [11];")
    .replace(/^const targetLibraryID = .*;$/m, "const targetLibraryID = 2;")
    .replace(/^const move = .*;$/m, "const move = true;");
}

/**
 * Runs the skill's recipe against a small in-memory Zotero: one source item
 * (id 11) with a PDF (id 12) and, if asked, a linked file (id 13). The target
 * library (id 2) takes files but not linked files.
 */
async function runRecipe(
  instruction: string,
  options: {
    move: boolean;
    annotations?: number;
    linkedFile?: boolean;
    failImport?: boolean;
    stopAfter?: number;
    sourceItemIds?: number[];
  },
) {
  const store = new Map<number, any>();
  let nextId = 100;
  const make = (fields: Record<string, any>) => {
    const item: any = {
      id: 0,
      title: "",
      deleted: false,
      parentID: null,
      libraryID: 1,
      isAtt: false,
      isRegularItem: () => false,
      isFileAttachment: () => false,
      getNotes: () => [],
      getAttachments: () =>
        [...store.values()]
          .filter((entry) => entry.parentID === item.id && entry.isAtt)
          .map((entry) => entry.id),
      getField: (name: string) => (name === "title" ? item.title : ""),
      saveTx: async () => {
        if (!item.id) item.id = nextId++;
        store.set(item.id, item);
      },
    };
    return Object.assign(item, fields);
  };
  const source = make({
    id: 11,
    title: "Source",
    isRegularItem: () => true,
    getAttachments: () => [12, ...(options.linkedFile ? [13] : [])],
    clone: (libraryID: number) =>
      make({ title: "Source", libraryID, isRegularItem: () => true }),
  });
  store.set(11, source);
  store.set(
    12,
    make({
      id: 12,
      title: "PDF",
      isAtt: true,
      attachmentLinkMode: 1,
      isFileAttachment: () => true,
      getAnnotations: () => new Array(options.annotations || 0).fill({}),
      getFilePathAsync: async () => "/papers/a.pdf",
    }),
  );
  if (options.linkedFile)
    store.set(
      13,
      make({
        id: 13,
        title: "Linked",
        isAtt: true,
        attachmentLinkMode: 2,
        isFileAttachment: () => true,
        getAnnotations: () => [],
        getFilePathAsync: async () => "/papers/b.txt",
      }),
    );
  const copyFile = async (params: any) => {
    if (options.failImport) throw new Error("disk full");
    const copy = make({
      title: params.title,
      isAtt: true,
      libraryID: 2,
      parentID: params.parentItemID,
      attachmentLinkMode: 1,
      fileExists: async () => true,
    });
    await copy.saveTx();
    return copy;
  };
  const zotero = {
    Libraries: {
      get: () => ({
        editable: true,
        filesEditable: true,
        allowsLinkedFiles: false,
      }),
    },
    Attachments: {
      LINK_MODE_LINKED_URL: 3,
      LINK_MODE_LINKED_FILE: 2,
      importFromFile: copyFile,
      linkFromFile: copyFile,
    },
    Items: {
      get: (id: number | number[]) =>
        Array.isArray(id) ? id.map((entry) => store.get(entry)) : store.get(id),
    },
  };
  let checks = 0;
  const env = {
    recordCreatedItem: () => undefined,
    snapshot: () => undefined,
    shouldStop: () =>
      options.stopAfter !== undefined && checks++ >= options.stopAfter,
  };
  const body = recipe(instruction)
    .replace(
      /^const sourceItemIds = .*;$/m,
      `const sourceItemIds = ${JSON.stringify(options.sourceItemIds || [11])};`,
    )
    .replace(/^const move = .*;$/m, `const move = ${options.move};`);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const results = await new AsyncFunction("Zotero", "env", body)(zotero, env);
  return { results, source };
}

describe("zotero-script skill", function () {
  const raw = BUILTIN_SKILL_FILES["zotero-script.md"];
  const skill = parseSkill(raw || "");

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

  it("ships as an automatic built-in skill for any context", function () {
    assert.isString(raw, "bundled as zotero-script.md");
    assert.equal(skill.id, "zotero-script");
    assert.equal(skill.version, 1);
    assert.deepEqual(skill.contexts, ["any"]);
    assert.equal(skill.activation, "auto");
    assert.deepEqual(getSkillRoutingDiagnostics(skill), []);
  });

  it("loads on demand through load_skill", async function () {
    const tool = createLoadSkillTool({
      getSkills: () => [skill],
      getShippedInstruction: () => skill.instruction,
    });
    const loaded = (await tool.execute({ id: "zotero-script" }, {
      request: undefined,
    } as never)) as { found: boolean; instructions?: string };
    assert.isTrue(loaded.found);
    assert.equal(loaded.instructions, skill.instruction);
  });

  it("states exactly what undo of a write script reverses and what it cannot", function () {
    for (const phrase of [
      "Undo of a write script reverses only what the script recorded",
      "An item passed to `env.snapshot` returns to its snapshot: item type, fields, creators, tags, collections, parent item, trash state, and a note's HTML.",
      "An item passed to `env.recordCreatedItem` goes to the trash.",
      "Each `env.addInverse` entry is replayed.",
      "Undo cannot reverse an erased item, a renamed or moved attachment file, a change to an item the script did not snapshot",
      "`uncoveredObservedIds`",
      "privileged read script (`access:'privileged'` with `effect:'read'`), which the journal records as irreversible",
      "A write script that calls none of the three is refused.",
    ])
      assert.include(skill.instruction, phrase);
  });

  it("forbids moveToLibrary and states what a copy keeps, skips and loses", function () {
    for (const phrase of [
      "Never call `item.moveToLibrary()`: it erases the original permanently",
      "`access:'privileged'`, `effect:'write'`",
      "it gets no collections and no related items, and it keeps no link to the original",
      "PDF annotations are not copied; the script lists each file that has some in `skipped`.",
      "Name every entry in `skipped` to the user with its reason.",
      "the script trashes an original only when its copy is verified and nothing was skipped",
      "`awaitingUserDecision`: report each skipped entry and ask the user before you trash the original",
      "`Zotero.Libraries.isFilesEditable(id)`, and `Zotero.Libraries.getType(id) === 'user'` for linked files",
      "undo misses only changes made by a promise the script does not await",
      "Undo of the script trashes every copy and restores each trashed original.",
    ])
      assert.include(skill.instruction, phrase);
    const script = recipe(skill.instruction);
    for (const api of [
      "item.clone(targetLibraryID)",
      "note.clone(targetLibraryID)",
      "await LM.importFromFile({\n            file: path,\n            libraryID: targetLibraryID,\n            parentItemID: copy.id,",
      "target.allowsLinkedFiles",
      "target.filesEditable",
      "env.recordCreatedItem(copy)",
      "env.snapshot(item);\n    item.deleted = true;",
    ])
      assert.include(script, api);
    assert.notInclude(script, "moveToLibrary");
    assert.notMatch(script, /\berase(Tx)?\s*\(/);
  });

  it("keeps a moved original out of the trash while anything is skipped", async function () {
    const { results, source } = await runRecipe(skill.instruction, {
      move: true,
      linkedFile: true,
    });
    assert.deepEqual(
      results[0].skipped.map((entry: any) => entry.id),
      [13],
    );
    assert.isTrue(results[0].verified);
    assert.isFalse(results[0].trashed);
    assert.isTrue(results[0].awaitingUserDecision);
    assert.isFalse(source.deleted);
  });

  it("lists a PDF's annotations as skipped, still copies the file, and keeps the original", async function () {
    const { results, source } = await runRecipe(skill.instruction, {
      move: true,
      annotations: 2,
    });
    assert.lengthOf(results[0].attachments, 1);
    assert.deepEqual(
      results[0].skipped.map((entry: any) => [entry.id, entry.reason]),
      [[12, "2 annotations not copied"]],
    );
    assert.isFalse(results[0].trashed);
    assert.isTrue(results[0].awaitingUserDecision);
    assert.isFalse(source.deleted);
  });

  it("trashes the original of a move when its copy is verified and nothing was skipped", async function () {
    const { results, source } = await runRecipe(skill.instruction, {
      move: true,
    });
    assert.isEmpty(results[0].skipped);
    assert.isTrue(results[0].trashed);
    assert.isUndefined(results[0].awaitingUserDecision);
    assert.isTrue(source.deleted);
    const copy = await runRecipe(skill.instruction, { move: false });
    assert.isFalse(copy.results[0].trashed);
    assert.isFalse(copy.source.deleted);
  });

  it("reports a failed item and the items that did not run instead of losing the batch", async function () {
    const failed = await runRecipe(skill.instruction, {
      move: true,
      failImport: true,
      sourceItemIds: [11, 99],
    });
    assert.lengthOf(failed.results, 2);
    assert.equal(failed.results[0].error, "disk full");
    assert.isFalse(failed.results[0].trashed);
    assert.isFalse(failed.source.deleted);
    assert.equal(failed.results[1].error, "not a regular item");

    const stopped = await runRecipe(skill.instruction, {
      move: false,
      stopAfter: 1,
      sourceItemIds: [11, 11, 11],
    });
    assert.deepEqual(
      stopped.results.map((entry: any) => entry.error),
      [undefined, "not run: out of time", "not run: out of time"],
    );
  });

  it("ships a recipe that zotero_script accepts as a privileged write", async function () {
    const tool = createZoteroScriptTool();
    const validated = tool.validate({
      access: "privileged",
      effect: "write",
      script: recipe(skill.instruction),
      description: "Move one item to a group library",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;
    const plan = await tool.planInvocation!(validated.value, {} as never);
    assert.equal(plan.impact, "state_change");
    assert.equal(plan.reversibility, "partial");
  });

  it("is the one owner: zotero_script keeps no never-selected copy of its rules", function () {
    const tool = registry().getTool("zotero_script");
    assert.exists(tool);
    assert.isEmpty(toolGuidanceItems(tool!.guidance));
  });

  it("points zotero_script's model description at the skill", function () {
    assert.include(
      modelDescription("zotero_script"),
      "Before writing a write script, load the zotero-script skill: load_skill('zotero-script').",
    );
  });

  it("gives run_command and file_io one rule each, their use and their approval, and no other guidance", function () {
    assert.include(
      modelDescription("run_command"),
      "for scripts, conversions and CLI tools; read papers and the library with Zotero tools. Zotero asks no approval for a command that only reads; any other command goes through the caller's approval rules.",
    );
    assert.include(
      modelDescription("file_io"),
      "for data, scripts and exports; read papers with paper_read. Zotero asks no approval for reads; a write can be undone and goes through the caller's approval rules.",
    );
    for (const name of ["run_command", "file_io"])
      assert.isEmpty(
        toolGuidanceItems(registry().getTool(name)!.guidance),
        name,
      );
  });

  it("states literature_search's source and author rules in its description only", function () {
    assert.include(
      modelDescription("literature_search"),
      "Search mode can use source:'arxiv' (preprints) or source:'europepmc' (biomedical); recommendations, references and citations always use OpenAlex. Put author names in author, not in query.",
    );
    assert.notInclude(
      LITERATURE_SEARCH_GUIDANCE.instruction,
      "Source selection",
    );
    assert.notInclude(LITERATURE_SEARCH_GUIDANCE.instruction, "Author search");
  });

  describe("installation", function () {
    const filename = "zotero-script.md";
    const filePath = () => getCanonicalSkillFilePath("zotero-script");

    it("seeds a fresh profile and records the shipped hash", async function () {
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment("/tmp/zotero-script-fresh", files, prefs);
      await initUserSkills();
      assert.equal(
        parseSkill(files[filePath()]).instruction,
        skill.instruction,
      );
      assert.equal(parseSkill(files[filePath()]).version, skill.version);
      assert.equal(
        JSON.parse(prefs.get(BODY_HASH_PREF_KEY) || "{}")[filename],
        hashSkillForUpgrade(raw, skill.instruction),
      );
    });

    it("keeps a user's own zotero-script skill that predates the built-in", async function () {
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment("/tmp/zotero-script-personal", files, prefs);
      const personal = `---\nname: zotero-script\nid: zotero-script\ndescription: My own script conventions for this library\nversion: 3\n---\n\nAlways log the item key.\n`;
      files[filePath()] = personal;
      await initUserSkills();
      assert.equal(files[filePath()], personal);
    });

    it("keeps a seeded copy the user edited", async function () {
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment("/tmp/zotero-script-edited", files, prefs);
      await initUserSkills();
      const edited = `${files[filePath()]}\nAlways run a read script first.\n`;
      files[filePath()] = edited;
      await initUserSkills();
      assert.equal(files[filePath()], edited);
    });

    it("does not re-seed a copy the user deleted", async function () {
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installMockSkillEnvironment("/tmp/zotero-script-deleted", files, prefs);
      await initUserSkills();
      assert.include(JSON.parse(prefs.get(SEEDED_PREF_KEY) || "[]"), filename);
      delete files[filePath()];
      await initUserSkills();
      assert.notProperty(files, filePath());
    });
  });
});
