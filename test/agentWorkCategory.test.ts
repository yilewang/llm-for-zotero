import { assert } from "chai";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
  CODEX_NATIVE_WORK_KINDS,
  resolveAgentToolCallWorkCategory,
  resolveAgentWorkCategory,
  resolveCodexNativeWorkCategory,
  SKILL_ACTIVATION_TRACE_LABEL,
  SKILL_ACTIVATION_WORK_CATEGORY,
} from "../src/agent/workCategory";
import { mapCodexNativeSkillActivationToEvents } from "../src/codexAppServer/nativeActivityStages";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";
import { createSelfContainedTestTool } from "../src/agent/tools/test/createSelfContainedTestTool";
import type { AgentWorkCategory } from "../src/agent/types";

const root = process.cwd();

/**
 * Spec literals the source guard must see. A drop means the scan stopped
 * inspecting sites, not that the sites became correct.
 */
const EXPECTED_SPEC_LITERAL_SITES = 47;

const ALLOWED_WORK_CATEGORIES: readonly AgentWorkCategory[] = [
  "retrieval",
  "planning",
  "generation",
  "zotero_action",
  "external_system",
];

/**
 * The product meaning every registered tool must claim. A tool missing from
 * this table is a new tool whose trace meaning nobody decided.
 */
const EXPECTED_TOOL_CATEGORIES: Readonly<Record<string, AgentWorkCategory>> = {
  // Reads: library, paper, PDF, and network lookups that never write.
  library_search: "retrieval",
  library_read: "retrieval",
  library_retrieve: "retrieval",
  library_cite: "retrieval",
  paper_read: "retrieval",
  read_attachment: "retrieval",
  literature_search: "retrieval",
  literature_review: "retrieval",
  web_search: "retrieval",
  web_read: "retrieval",
  context_read: "retrieval",
  load_skill: "retrieval",
  // Task bookkeeping.
  task_update: "planning",
  request_user_input: "planning",
  // Authored deliverables.
  submit_document: "generation",
  // Zotero library changes.
  library_update: "zotero_action",
  note_write: "zotero_action",
  note_write_batch: "zotero_action",
  library_settings: "zotero_action",
  library_delete: "zotero_action",
  annotate_pdf: "zotero_action",
  undo: "zotero_action",
  // The facade's own label; a files-mode call resolves to its delegate's
  // external_system instead.
  library_import: "zotero_action",
  // Disk, shell, and arbitrary code.
  workflow_script: "external_system",
  file_io: "external_system",
  run_command: "external_system",
  zotero_script: "external_system",
};

function collectAgentSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectAgentSourceFiles(fullPath));
    } else if (fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("agent work categories", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const registeredSpecs = registry
    .listToolDefinitions()
    .map((tool) => tool.spec)
    .concat(
      createLibraryBatchTool({
        actionRegistry: {} as never,
        toolRegistry: {} as never,
        zoteroGateway: {} as never,
      }).spec,
      createSelfContainedTestTool().spec,
    );

  it("gives every registered tool a category from the allowed set", function () {
    const missing = registeredSpecs
      .filter((spec) => !spec.workCategory)
      .map((spec) => spec.name);
    assert.deepEqual(missing, [], "tools without a declared work category");
    const invalid = registeredSpecs
      .filter(
        (spec) =>
          !ALLOWED_WORK_CATEGORIES.includes(
            spec.workCategory as AgentWorkCategory,
          ),
      )
      .map((spec) => spec.name);
    assert.deepEqual(invalid, [], "tools with an unknown work category");
  });

  it("labels each tool with the work it actually performs", function () {
    const actual: Record<string, AgentWorkCategory> = {};
    for (const spec of registeredSpecs) {
      if (
        spec.name === "library_batch" ||
        spec.name === "self_contained_test_tool"
      )
        continue;
      actual[spec.name] = resolveAgentWorkCategory(spec);
    }
    assert.deepEqual(actual, EXPECTED_TOOL_CATEGORIES);
  });

  it("labels a control-class tool by its effect, not by its lifecycle", function () {
    const libraryBatch = registeredSpecs.find(
      (spec) => spec.name === "library_batch",
    )!;
    // library_batch is control class because it never consumes an action
    // contract itself, but every page it applies is a Zotero library change.
    assert.equal(libraryBatch.executionClass, "control");
    assert.equal(resolveAgentWorkCategory(libraryBatch), "zotero_action");

    const zoteroScript = registeredSpecs.find(
      (spec) => spec.name === "zotero_script",
    )!;
    assert.equal(zoteroScript.executionClass, "external_effect");
    assert.equal(resolveAgentWorkCategory(zoteroScript), "external_system");
  });

  it("returns the declared category without inspecting the tool name", function () {
    assert.equal(
      resolveAgentWorkCategory({
        name: "opaque_a",
        description: "generate",
        inputSchema: { type: "object" },
        executionClass: "control",
        workCategory: "generation",
        requiresConfirmation: false,
      }),
      "generation",
    );
    assert.equal(
      resolveAgentWorkCategory({
        name: "opaque_b",
        description: "system",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        workCategory: "external_system",
        requiresConfirmation: true,
      }),
      "external_system",
    );
  });

  it("declares a category next to every agent tool spec in the source tree", function () {
    const undeclared: string[] = [];
    let inspected = 0;
    for (const path of collectAgentSourceFiles(join(root, "src/agent"))) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        // Only spec literals, never the type declarations that spell the union.
        if (!/executionClass: "(read|control|external_effect)",$/.test(line))
          return;
        inspected += 1;
        if (/workCategory:/.test(lines[index + 1] || "")) return;
        undeclared.push(`${relative(root, path)}:${index + 1}`);
      });
    }
    // Without this the guard passes vacuously: a trailing comment, a wrapped
    // line, or a reordered field would drop sites from scope unnoticed.
    assert.equal(
      inspected,
      EXPECTED_SPEC_LITERAL_SITES,
      "the source scan lost or gained spec literals; update the count deliberately",
    );
    assert.deepEqual(
      undeclared,
      [],
      "every executionClass literal must be followed by its workCategory",
    );
  });

  it("labels a delegating facade by the delegate the call chose", function () {
    const libraryImport = registry.getTool("library_import")!;
    assert.equal(
      resolveAgentToolCallWorkCategory(libraryImport, {
        kind: "identifiers",
        identifiers: ["10.1000/example"],
      }),
      "zotero_action",
    );
    assert.equal(
      resolveAgentToolCallWorkCategory(libraryImport, {
        kind: "manual",
        items: [],
      }),
      "zotero_action",
    );
    assert.equal(
      resolveAgentToolCallWorkCategory(libraryImport, {
        kind: "files",
        paths: ["/tmp/paper.pdf"],
      }),
      "external_system",
    );
    // An unusable input never reaches a delegate, so the facade's own
    // declared category stands.
    assert.equal(
      resolveAgentToolCallWorkCategory(libraryImport, { kind: "nonsense" }),
      libraryImport.spec.workCategory,
    );
  });

  it("keeps a plain tool's category when it resolves no delegate", function () {
    const webSearch = registry.getTool("web_search")!;
    assert.isUndefined(webSearch.resolveWorkCategory);
    assert.equal(
      resolveAgentToolCallWorkCategory(webSearch, { query: "anything" }),
      "retrieval",
    );
  });

  it("maps every Codex native activity kind the chat panel renders", function () {
    assert.deepEqual(
      CODEX_NATIVE_WORK_KINDS.map((kind) => [
        kind,
        resolveCodexNativeWorkCategory(kind),
      ]),
      [
        ["web_search", "retrieval"],
        ["image_generation", "generation"],
        ["image_view", "retrieval"],
        ["command", "external_system"],
        ["file_changes", "external_system"],
      ],
    );
  });

  it("names skill activation in the table, not at the bridge that saw it", function () {
    // A skill is chosen before the work, so it belongs with planning; the
    // constant keeps that decision beside the registered tools' categories.
    assert.equal(SKILL_ACTIVATION_WORK_CATEGORY, "planning");
    const events = mapCodexNativeSkillActivationToEvents("graphwalk");
    assert.equal(events?.stage?.stage, SKILL_ACTIVATION_WORK_CATEGORY);
    assert.equal(
      events?.activity?.workCategory,
      SKILL_ACTIVATION_WORK_CATEGORY,
    );
    assert.isNull(mapCodexNativeSkillActivationToEvents("  "));
  });

  it("labels a skill activation from one constant both sides read", function () {
    // The bridge stamps the label and the trace reads it back; a label
    // written twice is a label that can disagree with itself.
    const events = mapCodexNativeSkillActivationToEvents("graphwalk");
    assert.equal(events?.stage?.toolLabel, SKILL_ACTIVATION_TRACE_LABEL);
    assert.equal(events?.activity?.toolLabel, SKILL_ACTIVATION_TRACE_LABEL);
    for (const path of [
      "src/codexAppServer/nativeActivityStages.ts",
      "src/modules/contextPanel/agentTrace/render.ts",
    ]) {
      const source = readFileSync(join(root, path), "utf8");
      assert.include(
        source,
        "SKILL_ACTIVATION_TRACE_LABEL",
        `${path} must read the shared label`,
      );
      assert.notMatch(
        source.replace(/SKILL_ACTIVATION_TRACE_LABEL/g, ""),
        /toolLabel[^\n]*"Skill"|label !== "Skill"/,
        `${path} must not spell the label a second time`,
      );
    }
  });

  it("leaves the panel and both bridges no second work-category taxonomy", function () {
    // A category literal outside the table is a second taxonomy: it drifts
    // from the specs without any test noticing.
    const scanned = [
      "src/modules/contextPanel/chat.ts",
      "src/modules/contextPanel/codexNative/turnCallbacks.ts",
      "src/codexAppServer/nativeActivityStages.ts",
      "src/codexAppServer/nativeClient.ts",
      "src/agent/externalBackendBridge.ts",
    ].map((path) => ({
      path,
      source: readFileSync(join(root, path), "utf8"),
    }));
    for (const file of scanned) {
      assert.isAbove(
        file.source.split("\n").length,
        100,
        `${file.path} was read but looks empty; the scan would pass vacuously`,
      );
      assert.deepEqual(
        file.source.match(/workCategory:\s*"/g) || [],
        [],
        `${file.path} must not hard-code categories`,
      );
    }
    // The kinds are resolved once, where the protocol is spoken; the panel
    // appends what that mapping hands it.
    const bridge = scanned.find((file) =>
      file.path.endsWith("nativeActivityStages.ts"),
    )!.source;
    const used = Array.from(
      bridge.matchAll(/kind:\s*"([a-z_]+)"/g),
      (match) => match[1],
    );
    assert.deepEqual(
      Array.from(new Set(used)).sort(),
      Array.from(CODEX_NATIVE_WORK_KINDS).sort(),
      "the mapping table must be exhaustive over the kinds the bridge handles",
    );
    for (const panel of scanned.slice(0, 2)) {
      assert.notMatch(
        panel.source,
        /resolveCodexNativeWorkCategory\(/,
        `${panel.path}: the panel must not resolve a native work category for itself`,
      );
    }
  });
});
