import { assert } from "chai";
import {
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_PLAN_TOOL_NAMES,
  ZOTERO_MCP_WRITE_TOOL_NAMES,
  ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
} from "../src/agent/mcp/server";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createBuiltInActionRegistry } from "../src/agent/actions";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";

/**
 * The registry and the MCP curated arrays are maintained by hand and have
 * silently diverged before: a registry-only addition is invisible over MCP,
 * and an MCP-only addition is uncallable. Nothing caught that.
 *
 * The expected list below comes from the registry itself, built the way the
 * plugin builds it. A tool passes if it is exposed over MCP, has a reason in
 * ZOTERO_MCP_EXCLUDED_TOOL_NAMES, or is `localAgentOnly` (the registry then
 * never lists it to an external client).
 */
function buildRegistry() {
  const stub = {} as never;
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stub,
    pdfService: stub,
    pdfPageService: stub,
    retrievalService: stub,
  });
  // The plugin registers library_batch after the built-in registry, because
  // it needs both registries (src/agent/index.ts).
  registry.register(
    createLibraryBatchTool({
      actionRegistry: createBuiltInActionRegistry(),
      toolRegistry: registry,
      zoteroGateway: stub,
    }),
  );
  return registry;
}

const exposed = new Set<string>([
  ...ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ...ZOTERO_MCP_PLAN_TOOL_NAMES,
  ...ZOTERO_MCP_WRITE_TOOL_NAMES,
]);

describe("MCP tool surface has not drifted from the registry", function () {
  it("accounts for every model-visible tool: exposed, excluded with a reason, or local-agent-only", function () {
    const registry = buildRegistry();
    const localAgentOnly = new Set(
      registry
        .listToolDefinitions()
        .filter((tool) => tool.spec.localAgentOnly === true)
        .map((tool) => tool.spec.name),
    );
    const unaccounted = registry
      .listTools()
      .map((spec) => spec.name)
      .filter(
        (name) =>
          !exposed.has(name) &&
          !ZOTERO_MCP_EXCLUDED_TOOL_NAMES[name] &&
          !localAgentOnly.has(name),
      );
    assert.deepEqual(
      unaccounted,
      [],
      "each of these must be added to the MCP arrays or given an exclusion reason",
    );
  });

  it("exposes the tools the capability audit named", function () {
    for (const name of [
      "library_cite",
      "library_settings",
      "note_write_batch",
      "read_attachment",
    ])
      assert.isTrue(exposed.has(name), `${name} must be exposed over MCP`);
  });

  it("never exposes a local-agent-only tool, and gives it no second owner in the exclusion table", function () {
    const registry = buildRegistry();
    const localAgentOnly = registry
      .listToolDefinitions()
      .filter((tool) => tool.spec.localAgentOnly === true)
      .map((tool) => tool.spec.name);
    assert.includeMembers(
      localAgentOnly,
      ["web_search", "web_read", "workflow_script"],
      "the registry no longer marks these local-agent-only",
    );
    for (const name of localAgentOnly) {
      assert.isFalse(exposed.has(name), `${name} is local-agent-only`);
      assert.notProperty(
        ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
        name,
        `${name} is already out of MCP through localAgentOnly`,
      );
    }
  });

  it("exposes only tools the registry has: an MCP-only name is uncallable", function () {
    const registered = new Set(
      buildRegistry()
        .listToolDefinitions()
        .map((tool) => tool.spec.name),
    );
    const orphans = [...exposed].filter((name) => !registered.has(name));
    assert.deepEqual(orphans, []);
  });

  it("gives every exclusion a reason a maintainer can act on", function () {
    for (const [name, reason] of Object.entries(
      ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
    )) {
      assert.isAbove(
        reason.length,
        30,
        `${name} needs a real reason, not a placeholder`,
      );
    }
  });

  it("names only registered tools in the exclusion table", function () {
    const registered = new Set(
      buildRegistry()
        .listToolDefinitions()
        .map((tool) => tool.spec.name),
    );
    const stale = Object.keys(ZOTERO_MCP_EXCLUDED_TOOL_NAMES).filter(
      (name) => !registered.has(name),
    );
    assert.deepEqual(stale, []);
  });

  it("does not both expose and exclude the same tool", function () {
    const contradictory = Object.keys(ZOTERO_MCP_EXCLUDED_TOOL_NAMES).filter(
      (name) => exposed.has(name),
    );
    assert.deepEqual(contradictory, []);
  });
});
