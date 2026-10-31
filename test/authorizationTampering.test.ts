import { assert } from "chai";
import { reachesAuthorizationState } from "../src/agent/tools/write/authorizationTampering";
import { classifyRunCommandInvocation } from "../src/agent/tools/write/commandAnalysis";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";

/**
 * zotero_script and run_command share one test for code that reaches the
 * plugin's permission state. The plain word "authorization" used to be part
 * of it, so an HTTP Authorization header, a comment or a paper title
 * blocked the whole script in every mode.
 */
describe("authorization tampering signal", function () {
  const blocked = [
    "Zotero.Prefs.set('extensions.zotero.llmforzotero.originalAgentPermissionMode', 'yolo', true)",
    "Zotero.Prefs.get('extensions.zotero.llmforzotero.agentLibraryWriteMode', true)",
    "Zotero.Prefs.set('llmforzotero.someNewPref', 1)",
    "Services.prefs.setCharPref('extensions.zotero.llmforzotero.anything', 'x')",
    "Zotero.Prefs.get('extensions.zotero.llmforzotero.codexZoteroMcpBearerToken', true)",
    "Zotero.Prefs.set('extensions.zotero.llmforzotero.codexAppServerPermissionState', '{}', true)",
    "globalThis.grantStore = {}",
    "new ActionAuthorizationService(reviewer)",
    "authorizeOriginalAction(proposal, { mode: 'yolo' })",
    'user_pref("extensions.zotero.llmforzotero.agentPermissionMode", "yolo");',
  ];
  const allowed = [
    "fetch(url, { headers: { Authorization: 'Bearer abc' } })",
    "// authorization review",
    "item.setField('title', 'Authorization in clinical trials')",
    "Zotero.Prefs.get('extensions.zotero.llmforzotero.mineruMode', true)",
    "Zotero.Prefs.set('extensions.zotero.recursiveCollections', true, true)",
  ];
  for (const text of blocked) {
    it(`blocks: ${text}`, function () {
      assert.isTrue(reachesAuthorizationState(text));
    });
  }
  for (const text of allowed) {
    it(`allows: ${text}`, function () {
      assert.isFalse(reachesAuthorizationState(text));
    });
  }

  const context: AgentToolContext = {
    request: {
      conversationKey: 3,
      mode: "agent",
      userText: "fetch works",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
  const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });
  async function scriptPlan(script: string) {
    const input = tool.validate({
      access: "privileged",
      effect: "write",
      script,
      description: "Fixture",
    });
    assert.isTrue(input.ok, JSON.stringify(input));
    if (!input.ok) throw new Error("unreachable");
    return tool.planInvocation!(input.value, context);
  }

  it("zotero_script: an Authorization header is not a protected boundary", async function () {
    const plan = await scriptPlan(
      "env.snapshot(null); const r = await fetch('https://api.crossref.org/works', { headers: { Authorization: 'Bearer abc' } }); return r.status;",
    );
    assert.notEqual(plan.impact, "prohibited");
    assert.notInclude(plan.riskSignals, "authorization_tampering");
  });

  it("zotero_script: a write to the plugin's permission pref stays prohibited", async function () {
    const plan = await scriptPlan(
      "env.snapshot(null); Zotero.Prefs.set('extensions.zotero.llmforzotero.originalAgentPermissionMode', 'yolo', true);",
    );
    assert.equal(plan.impact, "prohibited");
    assert.include(plan.riskSignals, "authorization_tampering");
  });

  describe("run_command", function () {
    const originalIO = (globalThis as any).IOUtils;
    beforeEach(function () {
      (globalThis as any).IOUtils = { exists: async () => false };
    });
    afterEach(function () {
      (globalThis as any).IOUtils = originalIO;
    });
    it("an Authorization header in a command is not tampering", async function () {
      const plan = await classifyRunCommandInvocation({
        command:
          "curl -H 'Authorization: Bearer abc' https://api.crossref.org/works > /tmp/works.json",
      });
      assert.notInclude(plan.riskSignals, "authorization_tampering");
    });
    it("writing the plugin's permission pref is tampering", async function () {
      const plan = await classifyRunCommandInvocation({
        command:
          "python3 -c \"open('prefs.js','a').write('user_pref(extensions.zotero.llmforzotero.agentPermissionMode, yolo)')\"",
      });
      assert.include(plan.riskSignals, "authorization_tampering");
    });
  });
});
