import { assert } from "chai";
import { isAbsolute, sep } from "node:path";
import {
  createWorkflowTestCommand,
  resolveWorkflowScaffoldEntrypoint,
} from "../scripts/workflow-command.mjs";

describe("workflow test runner command", function () {
  it("runs the guarded scaffold entrypoint through the current Node executable", function () {
    const command = createWorkflowTestCommand({
      argv: [],
      env: { PRESERVED: "yes" },
      execPath: "C:\\tools\\node.exe",
      scaffoldBin: "C:\\repo\\scripts\\workflow-scaffold.mjs",
    });

    assert.equal(command.command, "C:\\tools\\node.exe");
    assert.deepEqual(command.args, [
      "C:\\repo\\scripts\\workflow-scaffold.mjs",
      "--workflow-child",
    ]);
    assert.equal(command.env.PRESERVED, "yes");
    assert.equal(command.env.NODE_ENV, "test");
    assert.equal(command.env.LLM_FOR_ZOTERO_WORKFLOW_TESTS, "1");
    assert.notProperty(command.env, "LLM_FOR_ZOTERO_WEBCHAT_LIVE");
    assert.notProperty(command.env, "LLM_FOR_ZOTERO_AGENT_LIVE");
  });

  it("enables live workflow capabilities only for their explicit flags", function () {
    const command = createWorkflowTestCommand({
      argv: ["node", "runner", "--webchat-live", "--agent-live"],
      env: {},
      execPath: "/usr/bin/node",
      scaffoldBin: "/repo/scripts/workflow-scaffold.mjs",
    });

    assert.equal(command.env.LLM_FOR_ZOTERO_WEBCHAT_LIVE, "1");
    assert.equal(command.env.LLM_FOR_ZOTERO_AGENT_LIVE, "1");
  });

  it("resolves the local lifecycle wrapper without using npx", function () {
    const scaffoldBin = resolveWorkflowScaffoldEntrypoint();

    assert.isTrue(isAbsolute(scaffoldBin));
    assert.include(scaffoldBin, ["scripts", "workflow-scaffold.mjs"].join(sep));
  });
});
