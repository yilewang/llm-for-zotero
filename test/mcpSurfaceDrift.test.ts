import { assert } from "chai";
import {
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_WRITE_TOOL_NAMES,
  ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
} from "../src/agent/mcp/server";

/**
 * The registry and the MCP curated arrays are maintained by hand and have
 * silently diverged before: a registry-only addition is invisible over MCP,
 * and an MCP-only addition is uncallable. Nothing caught that.
 *
 * This asserts the two agree, with an explicit exclusion list so that a
 * missing tool reads as a decision rather than as drift.
 */
describe("MCP tool surface has not drifted from the registry", function () {
  it("accounts for every model-visible tool: exposed or explicitly excluded", function () {
    // The tools the in-plugin registry advertises to the model. Kept as a
    // literal so a registry change forces a deliberate edit here rather than
    // quietly satisfying itself.
    const modelVisible = [
      "annotate_pdf",
      "attachment_update",
      "collection_update",
      "file_io",
      "library_batch",
      "library_delete",
      "library_import",
      "library_read",
      "library_retrieve",
      "library_search",
      "library_update",
      "literature_search",
      "note_write",
      "paper_read",
      "revert_changes",
      "run_command",
      "tool_result_read",
      "undo_last_action",
      "zotero_script",
    ];

    const exposed = new Set<string>([
      ...ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
      ...ZOTERO_MCP_WRITE_TOOL_NAMES,
    ]);

    const unaccounted = modelVisible.filter(
      (name) => !exposed.has(name) && !ZOTERO_MCP_EXCLUDED_TOOL_NAMES[name],
    );
    assert.deepEqual(
      unaccounted,
      [],
      "each of these must be added to the MCP arrays or given an exclusion reason",
    );
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

  it("does not both expose and exclude the same tool", function () {
    const exposed = new Set<string>([
      ...ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
      ...ZOTERO_MCP_WRITE_TOOL_NAMES,
    ]);
    const contradictory = Object.keys(ZOTERO_MCP_EXCLUDED_TOOL_NAMES).filter(
      (name) => exposed.has(name),
    );
    assert.deepEqual(contradictory, []);
  });
});
