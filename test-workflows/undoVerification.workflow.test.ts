import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { innermostToolResult } from "../src/agent/contracts/toolResultEnvelope";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  initAgentChangeJournal,
  listJournalActions,
  selectUndoJournalAction,
} from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
} from "../src/agent/types";

declare const Zotero: any;

/**
 * An undo is credited only when each replayed step re-reads as restored in
 * Zotero's own state. Four ways it must not be: the user edited the item
 * after the agent did, a concurrent writer undid the inverse during the
 * replay, one action of several conflicts, and the journal changed between
 * the confirmation card and the click. Every assertion reads Zotero's items,
 * preferences, and journal rows.
 */
describe("workflow: undo verification", function () {
  this.timeout(120000);

  const suffix = `undoverify-${Date.now()}`;
  const created: Zotero.Item[] = [];
  let conversation = 2_502_000_000;
  let originalMode: ReturnType<typeof getOriginalAgentPermissionMode>;
  const gateway = new ZoteroGateway();

  before(async function () {
    originalMode = getOriginalAgentPermissionMode();
    await initAgentChangeJournal();
  });
  afterEach(function () {
    setOriginalAgentPermissionMode(originalMode);
  });
  after(async function () {
    setOriginalAgentPermissionMode(originalMode);
    for (const item of created) {
      const live = Zotero.Items.get(item.id);
      if (live) await live.eraseTx();
    }
  });

  function setup(mode: "safe" | "auto" | "yolo") {
    setOriginalAgentPermissionMode(mode);
    const key = ++conversation;
    const request = resolvedAgentRequest({
      conversationKey: key,
      mode: "agent",
      userText: "Change the test papers",
      libraryID: Zotero.Libraries.userLibraryID,
      executionContext: {
        version: 1,
        executionId: `undo-verify:${suffix}:${key}`,
        conversationKey: key,
        conversationGeneration: 0,
        chatLibraryID: Zotero.Libraries.userLibraryID,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: {
          libraryIDs: [Zotero.Libraries.userLibraryID],
          outputDirectories: [],
        },
      },
    });
    const context = {
      request,
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `undo-verify-run:${suffix}:${key}`,
    } as AgentToolContext;
    const registry = new AgentToolRegistry(new ActionContractService(gateway));
    const api = Zotero.LLMForZotero.api.agent;
    for (const name of ["library_update", "library_settings", "undo"])
      registry.register(api.getToolDefinition(name));
    return { key, context, registry };
  }

  async function makeItem(title: string) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", title);
    await item.saveTx();
    created.push(item);
    return item;
  }

  async function prepare(
    registry: AgentToolRegistry,
    context: AgentToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<PreparedToolExecution> {
    return registry.prepareExecution(
      { id: `${name}:${Math.random()}`, name, arguments: args },
      context,
      { callerKind: "model" },
    );
  }

  /** Runs one call, approving every card it shows, and returns its result. */
  async function run(
    registry: AgentToolRegistry,
    context: AgentToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<AgentToolResult> {
    let prepared = await prepare(registry, context, name, args);
    for (let cards = 0; prepared.kind === "confirmation"; cards += 1) {
      assert.isBelow(cards, 4, "too many cards");
      prepared = await prepared.execute({ approved: true });
    }
    if (prepared.kind !== "result") throw new Error("unreachable");
    return prepared.execution.result;
  }

  async function retitle(
    registry: AgentToolRegistry,
    context: AgentToolContext,
    item: Zotero.Item,
    title: string,
  ): Promise<string> {
    const result = await run(registry, context, "library_update", {
      kind: "metadata",
      itemIds: [item.id],
      metadata: { title },
    });
    assert.isTrue(result.ok, JSON.stringify(result.content));
    const [action] = await listJournalActions({
      conversationKey: context.request.conversationKey,
      limit: 1,
    });
    assert.exists(action, "the write is in the journal");
    return action.actionId;
  }

  async function title(item: Zotero.Item): Promise<string> {
    await item.reload(undefined as never, true);
    return item.getField("title");
  }

  async function journalRow(key: number, actionId: string) {
    const [row] = await listJournalActions({
      actionId,
      conversationKey: key,
      limit: 1,
    });
    return row;
  }

  async function userEdit(item: Zotero.Item, value: string) {
    item.setField("title", value);
    await item.saveTx();
  }

  it("A1: refuses to undo a title the user edited after the agent", async function () {
    const { key, context, registry } = setup("yolo");
    const item = await makeItem(`Before ${suffix}`);
    const actionX = await retitle(registry, context, item, `Agent ${suffix}`);
    await userEdit(item, `User ${suffix}`);

    const result = await run(registry, context, "undo", { actionId: actionX });

    assert.isFalse(result.ok, JSON.stringify(result.content));
    assert.notInclude(
      result.actionReceipts.map((receipt) => receipt.verification),
      "verified",
    );
    assert.equal(await title(item), `User ${suffix}`, "the edit is kept");
    const row = await journalRow(key, actionX);
    assert.equal(row.status, "revert_failed");
    const pending = await listJournalActions({
      actionId: actionX,
      pendingOnly: true,
    });
    assert.lengthOf(pending, 1, "the action stays selectable");
    assert.equal(
      (await selectUndoJournalAction({ conversationKey: key })).action
        ?.actionId,
      actionX,
    );
  });

  it("A2: a concurrent writer that undoes the inverse leaves the undo unverified, and a retry then verifies", async function () {
    const { key, context, registry } = setup("yolo");
    const prefName = "recursiveCollections";
    const prefKey = `extensions.zotero.${prefName}`;
    const before = Boolean(Zotero.Prefs.get(prefKey, true));
    let observer: unknown;
    try {
      const set = await run(registry, context, "library_settings", {
        action: "set",
        key: prefName,
        value: !before,
      });
      assert.isTrue(set.ok, JSON.stringify(set.content));
      assert.equal(Boolean(Zotero.Prefs.get(prefKey, true)), !before);
      const [action] = await listJournalActions({
        conversationKey: key,
        limit: 1,
      });
      const actionP = action.actionId;

      // A real concurrent writer: when the inverse restores the old value,
      // another writer puts the agent's value back. Pref observers run
      // synchronously inside Zotero.Prefs.set.
      let fired = 0;
      observer = Zotero.Prefs.registerObserver(prefName, () => {
        fired += 1;
        if (fired > 1) return;
        Zotero.Prefs.unregisterObserver(observer);
        observer = undefined;
        Zotero.Prefs.set(prefKey, !before, true);
      });
      const result = await run(registry, context, "undo", {
        actionId: actionP,
      });
      assert.isAtLeast(fired, 1, "the observer saw the inverse");
      if (observer !== undefined) Zotero.Prefs.unregisterObserver(observer);
      observer = undefined;

      const content = innermostToolResult(result.content) as {
        revertedSteps?: Array<{ verification: string }>;
      };
      assert.equal(
        content.revertedSteps?.[0]?.verification,
        "mismatched",
        JSON.stringify(result.content),
      );
      const receipt = result.actionReceipts[0];
      assert.equal(receipt.verification, "unverified");
      assert.include(receipt.rejectedTargets, `journal-action:${actionP}`);
      assert.equal(Boolean(Zotero.Prefs.get(prefKey, true)), !before);
      assert.equal((await journalRow(key, actionP)).status, "revert_failed");

      const retry = await run(registry, context, "undo", {
        actionId: actionP,
      });
      assert.isTrue(retry.ok, JSON.stringify(retry.content));
      assert.equal(retry.actionReceipts[0].verification, "verified");
      assert.equal(Boolean(Zotero.Prefs.get(prefKey, true)), before);
      assert.equal((await journalRow(key, actionP)).status, "reverted");
    } finally {
      if (observer !== undefined) Zotero.Prefs.unregisterObserver(observer);
      Zotero.Prefs.set(prefKey, before, true);
    }
  });

  it("A3: reverting two actions when one conflicts is partial and unverified", async function () {
    const { key, context, registry } = setup("yolo");
    const item1 = await makeItem(`Before ${suffix} T1`);
    const item2 = await makeItem(`Before ${suffix} T2`);
    const actionX = await retitle(
      registry,
      context,
      item1,
      `Agent ${suffix} 1`,
    );
    const actionY = await retitle(
      registry,
      context,
      item2,
      `Agent ${suffix} 2`,
    );
    await userEdit(item1, `User ${suffix} 1`);

    const result = await run(registry, context, "undo", {
      actionIds: [actionX, actionY],
    });

    const content = innermostToolResult(result.content) as {
      reverted: number;
      conflicts: unknown[];
    };
    assert.equal(content.reverted, 1, JSON.stringify(result.content));
    assert.lengthOf(content.conflicts, 1);
    assert.equal(result.effect, "partial");
    assert.notInclude(
      result.actionReceipts.map((receipt) => receipt.verification),
      "verified",
    );
    assert.equal(await title(item2), `Before ${suffix} T2`);
    assert.equal(await title(item1), `User ${suffix} 1`);
    assert.equal((await journalRow(key, actionX)).status, "revert_failed");
    assert.equal((await journalRow(key, actionY)).status, "reverted");
  });

  it("A4: an action reverted after its card was shown needs a new card and then fails, and the older action is untouched", async function () {
    const { key, context, registry } = setup("safe");
    const item1 = await makeItem(`Before ${suffix} T1`);
    const item2 = await makeItem(`Before ${suffix} T2`);
    const actionX = await retitle(
      registry,
      context,
      item1,
      `Agent ${suffix} 1`,
    );
    const actionY = await retitle(
      registry,
      context,
      item2,
      `Agent ${suffix} 2`,
    );

    const prepared = await prepare(registry, context, "undo", {});
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind !== "confirmation") throw new Error("unreachable");

    // Before the click, another path reverts Y (the action the card names).
    const rowY = await journalRow(key, actionY);
    const outcome = await revertActions({
      actions: [rowY],
      zoteroGateway: gateway,
      context,
    });
    assert.equal(outcome.reverted, 1);
    assert.equal(await title(item2), `Before ${suffix} T2`);

    // The click does not apply anything. The changed journal needs a fresh
    // card; the older action X must not be undone in the place of Y.
    const renewed = await prepared.execute({ approved: true });
    assert.equal(renewed.kind, "confirmation", "a new card is required");
    if (renewed.kind !== "confirmation") throw new Error("unreachable");
    assert.equal(await title(item1), `Agent ${suffix} 1`);
    assert.equal((await journalRow(key, actionX)).status, "applied");

    // Approving that card still names Y, which is gone, so the undo fails.
    const settled = await renewed.execute({ approved: true });
    assert.equal(settled.kind, "result");
    if (settled.kind !== "result") throw new Error("unreachable");
    const result = settled.execution.result;
    assert.isFalse(result.ok, JSON.stringify(result.content));
    assert.include(
      JSON.stringify(result.content),
      "changed before undo could start",
    );
    assert.equal(
      await title(item1),
      `Agent ${suffix} 1`,
      "the older action was not undone in its place",
    );
    assert.equal((await journalRow(key, actionX)).status, "applied");
    assert.equal((await journalRow(key, actionY)).status, "reverted");
  });
});
