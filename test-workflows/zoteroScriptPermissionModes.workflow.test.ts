import "./hostSurfaceBootstrap";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import type {
  AgentToolContext,
  PreparedToolExecution,
} from "../src/agent/types";

/**
 * The user's rule for Zotero scripts, on real Zotero through the plugin
 * Agent's tool path: Safe shows the script and runs it after approval; Auto
 * and Yolo run it directly. Each write is read back from Zotero, undone, and
 * read back again. A type change from journalArticle to preprint drops
 * publicationTitle and volume, and its undo brings both back.
 */
describe("workflow: zotero_script in each permission mode", function () {
  this.timeout(90000);
  const suffix = `ScriptModes-${Date.now()}`;
  const created: Zotero.Item[] = [];
  let conversation = 2_501_000_000;
  let originalMode: ReturnType<typeof getOriginalAgentPermissionMode>;

  before(async function () {
    originalMode = getOriginalAgentPermissionMode();
    await initAgentChangeJournal();
  });
  after(async function () {
    setOriginalAgentPermissionMode(originalMode);
    for (const item of created) {
      const live = Zotero.Items.get(item.id);
      if (live) await live.eraseTx();
    }
  });

  function agentContext(text: string) {
    const contracts = new ActionContractService(new ZoteroGateway());
    const request = resolvedAgentRequest({
      conversationKey: ++conversation,
      mode: "agent",
      libraryID: Zotero.Libraries.userLibraryID,
      userText: text,
    });
    // An ordinary agent turn: the in-plugin agent owns permission.
    request.executionContext = createAgentExecutionContext(
      request,
      `script-modes-${conversation}`,
    );
    const context: AgentToolContext = {
      request,
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
    };
    const registry = new AgentToolRegistry(contracts);
    const api = (Zotero as any).LLMForZotero.api.agent;
    registry.register(api.getToolDefinition("zotero_script"));
    registry.register(api.getToolDefinition("undo"));
    return { registry, context };
  }

  async function makeArticle(title: string) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", title);
    item.setField("publicationTitle", `${suffix} Journal`);
    item.setField("volume", "42");
    await item.saveTx();
    created.push(item);
    return item;
  }

  function valuesNamed(value: unknown, key: string): unknown[] {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([name, child]) => [
        ...(name === key ? [child] : []),
        ...valuesNamed(child, key),
      ],
    );
  }

  /** Approve a card when one is shown; return the settled result. */
  async function settle(prepared: PreparedToolExecution, expectCard: boolean) {
    if (expectCard) {
      assert.equal(prepared.kind, "confirmation", "Safe shows a card first");
      if (prepared.kind !== "confirmation") throw new Error("unreachable");
      const preview = prepared.action.fields.find(
        (field) => field.type === "code_preview",
      );
      assert.exists(preview, "the card shows the script");
      prepared = await prepared.execute({ approved: true });
    }
    assert.equal(prepared.kind, "result", "the script runs without a card");
    if (prepared.kind !== "result") throw new Error("unreachable");
    const result = prepared.execution.result;
    assert.isTrue(result.ok, JSON.stringify(result.content));
    return result;
  }

  async function runScript(
    mode: "safe" | "auto" | "yolo",
    script: string,
    description: string,
  ) {
    setOriginalAgentPermissionMode(mode);
    const { registry, context } = agentContext(description);
    const prepared = await registry.prepareExecution(
      {
        id: `script-${mode}-${conversation}`,
        name: "zotero_script",
        arguments: {
          access: "privileged",
          effect: "write",
          script,
          description,
        },
      },
      context,
      { callerKind: "model" },
    );
    const result = await settle(prepared, mode === "safe");
    const actionId = [
      ...valuesNamed(result.content, "actionId"),
      ...valuesNamed(result.actionReceipts, "actionId"),
    ].find((id) => typeof id === "string") as string | undefined;
    return { registry, context, result, actionId };
  }

  async function undo(
    mode: "safe" | "auto" | "yolo",
    registry: AgentToolRegistry,
    context: AgentToolContext,
    actionId: string | undefined,
  ) {
    const prepared = await registry.prepareExecution(
      {
        id: `undo-${mode}-${conversation}`,
        name: "undo",
        arguments: actionId ? { actionId } : {},
      },
      context,
      { callerKind: "model" },
    );
    const settled =
      prepared.kind === "confirmation"
        ? await prepared.execute({ approved: true })
        : prepared;
    assert.equal(settled.kind, "result");
    if (settled.kind !== "result") throw new Error("unreachable");
    assert.isTrue(
      settled.execution.result.ok,
      JSON.stringify(settled.execution.result.content),
    );
  }

  for (const mode of ["safe", "auto", "yolo"] as const) {
    it(`${mode}: a title-changing script ${mode === "safe" ? "runs after approval" : "runs directly"}, and undo restores it`, async function () {
      const title = `${suffix} ${mode} title`;
      const item = await makeArticle(title);
      const { registry, context, actionId } = await runScript(
        mode,
        `const item = Zotero.Items.get(${item.id});
env.snapshot(item);
item.setField('title', ${JSON.stringify(`${title} changed`)});
await item.saveTx();
return item.id;`,
        `Rename the test paper in ${mode} mode`,
      );
      await item.reload(undefined as never, true);
      assert.equal(item.getField("title"), `${title} changed`);
      await undo(mode, registry, context, actionId);
      await item.reload(undefined as never, true);
      assert.equal(item.getField("title"), title);
    });
  }

  it("auto: a script changes journalArticle to preprint, and undo restores the type and both fields", async function () {
    const title = `${suffix} type change`;
    const item = await makeArticle(title);
    const { registry, context, actionId } = await runScript(
      "auto",
      `const item = Zotero.Items.get(${item.id});
env.snapshot(item);
item.setType(Zotero.ItemTypes.getID('preprint'));
await item.saveTx();
return item.itemType;`,
      "Change the test paper to a preprint",
    );
    await item.reload(undefined as never, true);
    assert.equal(item.itemType, "preprint");
    assert.equal(item.getField("title"), title);
    assert.equal(item.getField("publicationTitle", false, true), "");
    assert.equal(item.getField("volume", false, true), "");
    await undo("auto", registry, context, actionId);
    await item.reload(undefined as never, true);
    assert.equal(item.itemType, "journalArticle");
    assert.equal(item.getField("title"), title);
    assert.equal(item.getField("publicationTitle"), `${suffix} Journal`);
    assert.equal(item.getField("volume"), "42");
  });
});
