import { assert } from "chai";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";

/**
 * `zotero_script` executes privileged JavaScript against the live Zotero
 * object. Before this suite it ran write-mode scripts with no confirmation
 * card at all, and the trace showed only a model-authored one-line
 * description — so the user approved nothing and could not see what ran.
 *
 * The contract pinned here mirrors `run_command`: the source itself is the
 * confirmation surface, via a `code_preview` field.
 */
describe("zotero_script confirmation", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 7,
      mode: "agent",
      userText: "tidy up",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });

  function validated(mode: "read" | "write", script: string) {
    const result = tool.validate({
      access: mode === "read" ? "library" : "privileged",
      effect: mode,
      script,
      description: "Tidy collections",
    });
    assert.isTrue(
      result.ok,
      `fixture should validate: ${JSON.stringify(result)}`,
    );
    if (!result.ok) throw new Error("unreachable");
    return result.value;
  }

  const WRITE_SCRIPT =
    "const items = await Zotero.Items.getAll(1);\nfor (const i of items) { env.snapshot(i); i.addTag('x'); await i.saveTx(); }";

  it("classifies a write-mode script as a state change", async function () {
    const input = validated("write", WRITE_SCRIPT);
    const plan = await tool.planInvocation?.(input, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "state_change");
    assert.include(plan?.effects || [], "modify");
  });

  it("shows the actual source in a code_preview field, not a summary", async function () {
    const input = validated("write", WRITE_SCRIPT);
    const pending = await tool.createPendingAction?.(input, context);
    assert.exists(pending, "write scripts must render a confirmation card");
    const preview = pending?.fields.find((f) => f.type === "code_preview");
    assert.exists(preview, "expected a code_preview field");
    const value = (preview as never as { value: string }).value;
    assert.equal(value, WRITE_SCRIPT, "the card must show the script verbatim");
    assert.equal(
      (preview as never as { language?: string }).language,
      "javascript",
    );
  });

  it("proves library read mode at the runtime boundary", async function () {
    const input = validated("read", "return Zotero.Items.getAll(1).length;");
    const plan = await tool.planInvocation?.(input, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "read_only");
    assert.equal(plan?.assurance, "runtime_enforced");
  });

  it("keeps privileged read mode ambiguous", async function () {
    const input = tool.validate({
      access: "privileged",
      effect: "read",
      script: "return Zotero.Items.getAll(1).length;",
      description: "Count items",
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const plan = await tool.planInvocation?.(input.value, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "ambiguous");
    assert.equal(plan?.assurance, "unknown");
  });
});

/**
 * `mode:'read'` was never a sandbox — the evaluator hands the script the real
 * `Zotero` global either way (`fn(Zotero, env)`). So the note fence, which
 * exists to keep note creation on the validated `note_write` path, has to
 * apply regardless of the mode the model declared.
 *
 * The undo-instrumentation guard deliberately does NOT move: `env.snapshot`
 * is a no-op in read mode, so requiring it there would reject every
 * legitimate read script while preventing no write at all.
 */
describe("zotero_script mode guards", function () {
  const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });
  const NOTE_WRITE_SCRIPT =
    "const n = new Zotero.Item('note'); n.setNote('<p>hi</p>'); await n.saveTx();";

  it("refuses a note write declared as read mode", function () {
    const result = tool.validate({
      access: "library",
      effect: "read",
      script: NOTE_WRITE_SCRIPT,
      description: "Sneak a note in",
    });
    assert.isFalse(
      result.ok,
      "declaring read mode must not be a way around the note fence",
    );
  });

  it("still refuses a note write in write mode", function () {
    const result = tool.validate({
      access: "privileged",
      effect: "write",
      script: `env.snapshot(null); ${NOTE_WRITE_SCRIPT}`,
      description: "Sneak a note in",
    });
    assert.isFalse(result.ok);
  });

  it("still accepts an ordinary read script with no undo instrumentation", function () {
    const result = tool.validate({
      access: "library",
      effect: "read",
      script: "return Zotero.Items.getAll(1).length;",
      description: "Count items",
    });
    assert.isTrue(
      result.ok,
      "read scripts must not be forced to call env.snapshot, which no-ops in read mode",
    );
  });
});
