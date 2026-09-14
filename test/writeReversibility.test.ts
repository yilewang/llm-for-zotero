import { ActionContractService } from "../src/agent/contracts/actionContract";
import { actionFixture, actionContractFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { normalizeOriginalAgentPermissionMode } from "../src/shared/originalAgentPermissionMode";
import { setOriginalAgentPermissionMode } from "../src/agent/originalAgentPermissionMode";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createLibrarySettingsTool } from "../src/agent/tools/write/librarySettings";
import type {
  AgentInvocationPlan,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";

describe("invocation-plan confirmation policy", function () {
  const originalZotero = globalThis.Zotero;
  const context = {
    request: {
      conversationKey: 1,
      actionContract: actionContractFixture("settings_update"),
      classifiedIntent: actionFixture("settings_update"),
      libraryID: 1,
      userText: "update the requested setting and write the result",
    },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  } as AgentToolContext;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  const writePlan = (
    reversibility: AgentInvocationPlan["reversibility"],
    reason = "Test state change.",
  ) => stateChangeInvocationPlan({ reversibility, reason });

  function tool(
    plan?: AgentInvocationPlan,
  ): AgentToolDefinition<Record<string, never>, unknown> {
    return {
      spec: {
        name: "future_write",
        description: "test write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      ...(plan ? { planInvocation: async () => plan } : {}),
      describeAction: () => [
        {
          id: "settings:test",
          proofDomain: "zotero_state",
          capability: "zotero.settings",
          operation: "settings_update",
          source: "zotero_native",
          requestedTargets: [],
          destinationCollectionIds: [],
        },
      ],
      createPendingAction: () => ({
        toolName: "future_write",
        title: "Review write",
        description: "Review this mutation",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => ({
        content: { status: "ran" },
        effect: "applied",
      }),
    };
  }

  async function prepare(params: {
    mode: "auto" | "safe" | "yolo";
    plan?: AgentInvocationPlan;
    journal: boolean;
  }) {
    const db = params.journal ? new ChangeJournalTestDb() : undefined;
    globalThis.Zotero = {
      ...(db ? { DB: db } : {}),
      Prefs: { get: () => params.mode },
      debug: () => undefined,
    } as never;
    if (db) await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register(tool(params.plan));
    return registry.prepareExecution(
      { id: "call-1", name: "future_write", arguments: {} },
      context,
    );
  }

  it("safe reviews every concrete write plan", async function () {
    const prepared = await prepare({
      mode: "safe",
      journal: true,
      plan: writePlan("full"),
    });
    assert.equal(prepared.kind, "confirmation");
  });

  it("auto runs a fully reversible initialized-journal plan directly", async function () {
    const prepared = await prepare({
      mode: "auto",
      journal: true,
      plan: writePlan("full"),
    });
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isTrue(prepared.execution.result.ok);
    }
  });

  it("auto executes clear partial and irreversible plans", async function () {
    for (const reversibility of ["partial", "none"] as const) {
      const prepared = await prepare({
        mode: "auto",
        journal: true,
        plan: writePlan(reversibility),
      });
      assert.equal(prepared.kind, "result", reversibility);
    }
  });

  it("defaults a future write without a planner to irreversible", async function () {
    const prepared = await prepare({ mode: "auto", journal: true });
    assert.equal(prepared.kind, "result");
  });

  it("does not let a tool override yolo with its own prompt", async function () {
    const prepared = await prepare({
      mode: "yolo",
      journal: true,
      plan: writePlan(
        "full",
        "Resume an interrupted batch only after reviewing its state.",
      ),
    });
    assert.equal(prepared.kind, "result");
  });

  it("applies the global write mode to library settings", async function () {
    for (const [mode, expectedKind] of [
      ["safe", "confirmation"],
      ["auto", "result"],
      ["yolo", "result"],
    ] as const) {
      const db = new ChangeJournalTestDb();
      globalThis.Zotero = {
        DB: db,
        Prefs: { get: () => mode },
        Items: { get: () => null },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        new ActionContractService({} as never),
      );
      registry.register(
        createLibrarySettingsTool({
          listSettings: () => [
            {
              key: "automaticTags",
              value: true,
              description: "Automatically save tags",
            },
          ],
          updateSetting: async () => ({
            status: "updated",
            key: "automaticTags",
            previousValue: true,
            value: false,
          }),
        } as never),
      );

      const prepared = await registry.prepareExecution(
        {
          id: `settings-${mode}`,
          name: "library_settings",
          arguments: {
            action: "set",
            key: "automaticTags",
            value: false,
          },
        },
        context,
      );

      assert.equal(prepared.kind, expectedKind, mode);
      if (prepared.kind === "result") {
        assert.isTrue(prepared.execution.result.ok, mode);
      }
    }
  });

  it("does not confirm a library setting that already has the requested value", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "safe" },
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register(
      createLibrarySettingsTool({
        listSettings: () => [
          {
            key: "automaticTags",
            value: false,
            description: "Automatically save tags",
          },
        ],
        updateSetting: async () => ({
          status: "unchanged",
          key: "automaticTags",
          value: false,
        }),
      } as never),
    );

    const prepared = await registry.prepareExecution(
      {
        id: "settings-no-op",
        name: "library_settings",
        arguments: {
          action: "set",
          key: "automaticTags",
          value: false,
        },
      },
      context,
    );

    assert.equal(prepared.kind, "result");
    const read = await registry.prepareExecution(
      {
        id: "settings-read",
        name: "library_settings",
        arguments: { action: "list" },
      },
      context,
    );
    assert.equal(read.kind, "result");
  });

  it("refuses yolo writes when the durable journal is unavailable", async function () {
    const prepared = await prepare({
      mode: "yolo",
      journal: false,
      plan: writePlan("full"),
    });
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        "durable change journal is unavailable",
      );
    }
  });

  it("blocks auto when durable authorization cannot be recorded", async function () {
    const prepared = await prepare({
      mode: "auto",
      journal: false,
      plan: writePlan("full"),
    });
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isFalse(prepared.execution.result.ok);
    }
  });

  describe("stored preference normalization", function () {
    it("defaults to auto", function () {
      assert.equal(normalizeOriginalAgentPermissionMode(undefined), "auto");
      assert.equal(normalizeOriginalAgentPermissionMode("nonsense"), "auto");
    });

    it("honours explicit safe and yolo modes", function () {
      assert.equal(normalizeOriginalAgentPermissionMode("safe"), "safe");
      assert.equal(normalizeOriginalAgentPermissionMode("yolo"), "yolo");
    });

    it("persists auto without silently converting it to safe", function () {
      const writes: unknown[][] = [];
      globalThis.Zotero = {
        Prefs: {
          set: (...args: unknown[]) => {
            writes.push(args);
          },
        },
      } as never;

      setOriginalAgentPermissionMode("auto");

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.[1], "auto");
      assert.equal(writes[0]?.[2], true);
    });
  });
});
