/**
 * The reorganize-library skill: a large reorganization places papers from
 * their metadata, reading a paper only when its metadata cannot place it,
 * shows its proposed grouping in the chat before the first change, then
 * moves or tags the papers batch by batch with library_update assignments,
 * and declares the changes as one part over the papers so Task progress
 * counts them. Every tool and parameter it names exists in the model-facing
 * schemas.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import {
  getSkillRoutingDiagnostics,
  parseSkill,
} from "../src/agent/skills/skillLoader";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { REORGANIZE_LIBRARY_PARTS_GUIDANCE } from "../src/agent/tools/control/taskUpdate";

type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
};

describe("reorganize-library skill", function () {
  const raw = BUILTIN_SKILL_FILES["reorganize-library.md"];
  const skill = parseSkill(raw || "");

  function schemaOf(toolName: string): Schema {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const tool = registry.getTool(toolName);
    assert.exists(tool, `${toolName} is a model-facing tool`);
    return tool!.spec.inputSchema as Schema;
  }

  it("ships as an automatic skill for paper sets and library scopes", function () {
    assert.isString(raw, "bundled as reorganize-library.md");
    assert.equal(skill.id, "reorganize-library");
    assert.equal(skill.version, 2);
    assert.deepEqual(skill.contexts, ["paper-set", "library-corpus"]);
    assert.equal(skill.activation, "auto");
    assert.deepEqual(getSkillRoutingDiagnostics(skill), []);
  });

  it("shows the proposed grouping in the chat before creating, moving or tagging anything", function () {
    assert.include(
      skill.instruction,
      "Before creating, moving or tagging anything, show the proposed grouping in the chat",
    );
    assert.include(skill.instruction, "`request_user_input`");
  });

  it("places papers from their metadata, reading a paper only when its metadata cannot place it", function () {
    for (const phrase of [
      "Place each paper from its metadata first",
      "Read further only for a paper its metadata cannot place",
      "targeted `paper_read`, not its full text",
      "never read every paper by default",
      "Do not list them with a `zotero_script`",
    ])
      assert.include(skill.instruction, phrase);
    assert.include(schemaOf("paper_read").properties!.mode.enum!, "targeted");
    const search = schemaOf("library_search").properties!;
    assert.include(search.include.items!.enum!, "abstract");
    assert.containsAllKeys(search.filters.properties!, [
      "collectionId",
      "unfiled",
    ]);
    assert.containsAllKeys(search, ["limit", "offset"]);
    assert.include(
      schemaOf("library_retrieve").properties!.depth.enum!,
      "metadata",
    );
  });

  it("declares the moves as one part over the papers, and no read part for the survey", function () {
    // MCP hides task_update, so the part lives in its guidance (#541).
    assert.notInclude(raw, "task_update");
    const guidance = REORGANIZE_LIBRARY_PARTS_GUIDANCE.instruction;
    assert.include(guidance, "`task_update` as one part");
    assert.include(guidance, "`scope:true`");
    assert.include(guidance, "`targetIds`");
    assert.include(guidance, "`expectedCapability:'zotero.collections'`");
    assert.include(guidance, "Declare no read part for the survey");
    const task = schemaOf("task_update").properties!.tasks.items!.properties!;
    assert.containsAllKeys(task, [
      "scope",
      "targetIds",
      "expectedEffect",
      "expectedCapability",
    ]);
  });

  it("creates folders, then moves papers in batches of assignments, and never repeats a declined batch", function () {
    for (const phrase of [
      "`kind:'collection'`",
      "`parentCollectionId`",
      "`kind:'collections'`",
      "`assignments`",
      "`mode:'move'`",
      "`from`",
      "Do not repeat a batch the user declined",
    ])
      assert.include(skill.instruction, phrase);
    const update = schemaOf("library_update").properties!;
    assert.includeMembers(update.kind.enum!, ["collection", "collections"]);
    assert.includeMembers(update.action.enum!, ["create", "add"]);
    assert.include(update.mode.enum!, "move");
    assert.containsAllKeys(update, ["parentCollectionId", "from"]);
    assert.containsAllKeys(update.assignments.items!.properties!, [
      "itemId",
      "targetCollectionId",
    ]);
  });

  it("tags papers in the same batches, with per-paper tag assignments", function () {
    assert.include(
      REORGANIZE_LIBRARY_PARTS_GUIDANCE.instruction,
      "`'zotero.tags'`",
    );
    for (const phrase of [
      "`kind:'tags'`",
      "one `assignments` entry (`itemId`, `tags`) per paper",
    ])
      assert.include(skill.instruction, phrase);
    const update = schemaOf("library_update").properties!;
    assert.include(update.kind.enum!, "tags");
    assert.containsAllKeys(update.assignments.items!.properties!, [
      "itemId",
      "tags",
    ]);
  });

  it("reports what changed and what did not, from the receipts", function () {
    assert.include(skill.instruction, "Report from the receipts");
    assert.include(skill.instruction, "did not change and why");
  });
});
