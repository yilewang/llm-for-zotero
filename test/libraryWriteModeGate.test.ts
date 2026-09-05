import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The mode is enforced at `prepareExecution` — the one point the in-plugin
 * runtime, MCP and the external bridge all pass through — rather than in the
 * tool listing. A gate that only hides a tool is decoration: `exposure` is
 * checked when listing and deliberately not when executing, because
 * seventeen internal tools are called by name through this same method.
 */
describe("library write mode gate", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  async function installMode(mode: string) {
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Prefs: { get: () => mode },
      debug: () => undefined,
    };
    await initAgentChangeJournal();
  }

  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "go",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  };

  function makeRegistry() {
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_batch",
        description: "batch",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      createPendingAction: () => ({
        toolName: "library_batch",
        title: "Review batch",
        description: "Review this library batch",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      async execute() {
        ran = true;
        return { content: { ok: true }, effect: "applied" };
      },
    } as never);
    return { registry, didRun: () => ran };
  }

  const call = { id: "c1", name: "library_batch", arguments: {} };

  it("refuses a yolo-only tool in safe mode, at execution", async function () {
    await installMode("safe");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.isFalse(didRun(), "the tool must not have run");
    assert.include(
      String((prepared.execution.result.content as { error?: string })?.error),
      "yolo",
    );
  });

  it("allows it in yolo", async function () {
    await installMode("yolo");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    assert.isTrue(didRun());
  });

  it("bypasses the yolo-only gate for a slash command but still reviews the plan", async function () {
    await installMode("safe");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context, {
      callerKind: "action",
    });
    assert.equal(prepared.kind, "confirmation");
    assert.isFalse(didRun());
    if (prepared.kind !== "confirmation") return;
    const execution = await prepared.execute();
    assert.isTrue(execution.result.ok);
    assert.isTrue(didRun());
  });

  it("defaults an undeclared caller to the stricter treatment", async function () {
    await installMode("safe");
    const { registry, didRun } = makeRegistry();
    await registry.prepareExecution(call, context, {});
    assert.isFalse(didRun());
  });

  it("reviews ordinary writes in safe mode from the same mutation plan", async function () {
    await installMode("safe");
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_update",
        description: "update",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      createPendingAction: () => ({
        toolName: "library_update",
        title: "Review update",
        description: "Review this library update",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      async execute() {
        ran = true;
        return { content: { ok: true }, effect: "applied" };
      },
    } as never);
    const prepared = await registry.prepareExecution(
      { id: "c2", name: "library_update", arguments: {} },
      context,
    );
    assert.equal(prepared.kind, "confirmation");
    assert.isFalse(ran);
  });
});
