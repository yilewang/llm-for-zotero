import { assert } from "chai";
import { authorizeOriginalAction } from "../src/agent/authorization/policy";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { classifyRunCommandInvocation } from "../src/agent/tools/write/commandAnalysis";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The user's rule for Zotero scripts: Safe mode asks before a script runs and
 * runs it after approval; Auto and Yolo run it directly. A script that
 * reaches the raw database or the plugin's own permission settings stays
 * blocked in every mode. These tests use the real zotero_script tool, so the
 * plan each script earns is the one the agent would get.
 */
const context: AgentToolContext = {
  request: {
    conversationKey: 11,
    mode: "agent",
    userText: "retitle the paper",
    libraryID: 1,
  },
  item: null,
  currentAnswerText: "",
  modelName: "test-model",
};

const READ_SCRIPT = "return Zotero.Items.get(1).getField('title');";
const WRITE_SCRIPT =
  "const item = Zotero.Items.get(1); env.snapshot(item); item.setField('title', 'Renamed'); await item.saveTx(); return 1;";

const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });

async function decide(
  mode: "safe" | "auto" | "yolo",
  args: {
    access: "library" | "privileged";
    effect: "read" | "write";
    script: string;
  },
) {
  const validated = tool.validate({ ...args, description: "Script fixture" });
  assert.isTrue(validated.ok, JSON.stringify(validated));
  if (!validated.ok) throw new Error("unreachable");
  const plan = await tool.planInvocation!(validated.value, context);
  return authorizeOriginalAction(
    buildActionProposal({ tool, input: validated.value, plan }),
    { mode },
  );
}

describe("zotero_script authorization per permission mode", function () {
  const expected: Record<
    "safe" | "auto" | "yolo",
    Record<string, "execute" | "confirm">
  > = {
    safe: {
      "library/read": "execute",
      "library/write": "confirm",
      "privileged/read": "confirm",
      "privileged/write": "confirm",
    },
    auto: {
      "library/read": "execute",
      "library/write": "execute",
      "privileged/read": "execute",
      "privileged/write": "execute",
    },
    yolo: {
      "library/read": "execute",
      "library/write": "execute",
      "privileged/read": "execute",
      "privileged/write": "execute",
    },
  };
  for (const mode of ["safe", "auto", "yolo"] as const) {
    for (const access of ["library", "privileged"] as const) {
      for (const effect of ["read", "write"] as const) {
        it(`${mode}: ${access} ${effect} script -> ${expected[mode][`${access}/${effect}`]}`, async function () {
          const decision = await decide(mode, {
            access,
            effect,
            script: effect === "write" ? WRITE_SCRIPT : READ_SCRIPT,
          });
          assert.equal(decision.kind, expected[mode][`${access}/${effect}`]);
          if (mode === "auto" && decision.kind === "execute")
            assert.include(
              ["auto_policy", "safe_read"],
              decision.authority,
              "Auto runs a script under its own policy, not a model review",
            );
        });
      }
    }
    for (const script of [
      "env.snapshot(null); await Zotero.DB.queryAsync('DELETE FROM items');",
      "env.snapshot(null); Zotero.Prefs.set('extensions.zotero.llmforzotero.originalAgentPermissionMode', 'yolo', true);",
      "env.snapshot(null); Zotero.Prefs.set('llmforzotero.someNewPref', 1);",
      "env.snapshot(null); return Zotero.Prefs.get('extensions.zotero.llmforzotero.codexZoteroMcpBearerToken', true);",
      "env.snapshot(null); const s = new ActionAuthorizationService(null);",
      "env.snapshot(null); globalThis.grantStore = {};",
    ]) {
      it(`${mode}: blocks a hard risk signal: ${script.slice(15, 70)}`, async function () {
        const decision = await decide(mode, {
          access: "privileged",
          effect: "write",
          script,
        });
        assert.equal(decision.kind, "block");
      });
    }
    it(`${mode}: the plain word "authorization" does not block a script`, async function () {
      for (const script of [
        // An HTTP header in a privileged script.
        "env.snapshot(null); const r = await fetch('https://api.crossref.org/works', { headers: { Authorization: 'Bearer abc' } }); return r.status;",
        // A title string and a comment.
        "const item = Zotero.Items.get(1); env.snapshot(item); // authorization review\nitem.setField('title', 'Authorization in clinical trials'); await item.saveTx();",
      ]) {
        const decision = await decide(mode, {
          access: "privileged",
          effect: "write",
          script,
        });
        assert.notEqual(decision.kind, "block", script);
        assert.equal(decision.kind, mode === "safe" ? "confirm" : "execute");
      }
    });
  }

  it("auto: an ambiguous shell command still goes to model review", async function () {
    const originalIO = (globalThis as any).IOUtils;
    (globalThis as any).IOUtils = { exists: async () => false };
    try {
      const command = "python3 /tmp/unknown.py > /tmp/new.txt";
      const plan = await classifyRunCommandInvocation({ command });
      const decision = authorizeOriginalAction(
        buildActionProposal({
          tool: { spec: { name: "run_command" } } as never,
          input: { command },
          plan,
        }),
        { mode: "auto" },
      );
      assert.equal(decision.kind, "model_review");
    } finally {
      (globalThis as any).IOUtils = originalIO;
    }
  });
});

describe("zotero_script through the tool controller", function () {
  // An ordinary agent turn: the in-plugin agent owns permission.
  const agentContext: AgentToolContext = {
    ...context,
    request: {
      ...context.request,
      executionContext: {
        version: 1,
        executionId: "script-run",
        conversationKey: 11,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    } as AgentToolContext["request"],
  };
  const originalZotero = globalThis.Zotero;
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function fakeItem() {
    let title = "Original";
    return {
      id: 1,
      libraryID: 1,
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getField: (field: string) => (field === "title" ? title : ""),
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      toJSON: () => ({ itemType: "journalArticle", title }),
      setField: (field: string, value: string) => {
        if (field === "title") title = value;
      },
      saveTx: async () => undefined,
      title: () => title,
    };
  }

  async function prepare(mode: "safe" | "auto" | "yolo") {
    const item = fakeItem();
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => mode },
      Items: { get: (id: number) => (id === 1 ? item : null) },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register(
      createZoteroScriptTool({ allowUnsandboxedTestExecution: true }),
    );
    const prepared = await registry.prepareExecution(
      {
        id: `script-${mode}`,
        name: "zotero_script",
        arguments: {
          access: "privileged",
          effect: "write",
          script: WRITE_SCRIPT,
          description: "Rename the paper",
        },
      },
      agentContext,
    );
    return { item, prepared };
  }

  it("safe: shows the code for approval, then runs the script", async function () {
    const { item, prepared } = await prepare("safe");
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind !== "confirmation") return;
    const preview = prepared.action.fields.find(
      (field) => field.type === "code_preview",
    ) as { value?: string } | undefined;
    assert.equal(preview?.value, WRITE_SCRIPT);
    assert.equal(item.title(), "Original", "nothing runs before approval");
    const approved = await prepared.execute({ approved: true });
    assert.equal(approved.kind, "result");
    if (approved.kind !== "result") return;
    assert.isTrue(approved.execution.result.ok, JSON.stringify(approved));
    assert.equal(item.title(), "Renamed");
  });

  for (const mode of ["auto", "yolo"] as const) {
    it(`${mode}: runs the script with no confirmation`, async function () {
      const { item, prepared } = await prepare(mode);
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") return;
      assert.isTrue(prepared.execution.result.ok, JSON.stringify(prepared));
      assert.equal(item.title(), "Renamed");
    });
  }
});
