import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  JOURNAL_ACTIONS_TABLE,
  JOURNAL_PAYLOADS_TABLE,
  initAgentChangeJournal,
  listJournalActions,
  type JournalActionWithSteps,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

declare const Zotero: any;
declare const Cc: any;
declare const Ci: any;

const ITEM_COUNT = 120;
const STOP_AFTER = 60;

/** The restart test runs in two Zotero processes; see its describe block. */
function restartPhase(): string {
  return String(
    (globalThis as any).Services?.env?.get?.("W5D_RESTART_PHASE") || "",
  );
}

/**
 * Checkpointed bulk edits against real Zotero: a tag edit and a metadata edit
 * over 120 items, stopped after 60 and continued, an item that fails, the
 * unchanged path at 50 items, and journals written before batches froze
 * their items. Every assertion reads Zotero's own database.
 */
describe("workflow: checkpointed bulk edits", function () {
  this.timeout(600000);

  // A restart phase runs its own restart test and nothing else: the second
  // process has no use for the ordinary tests, and their 120-item writes
  // right after the start raced with the plugin's own startup.
  beforeEach(function () {
    if (
      restartPhase() &&
      !this.currentTest?.fullTitle().includes("across a Zotero restart")
    )
      this.skip();
  });

  const SUFFIX = `w5d${Date.now()}`;
  const created: number[] = [];
  /** The cards the last runTool call showed, in order. */
  let lastCards: string[] = [];

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  function contextFor(
    conversationKey: number,
    userText: string,
    extra: Partial<AgentToolContext> = {},
  ): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        userText,
        libraryID: libraryID(),
        executionContext: {
          version: 1,
          executionId: `w5d:${SUFFIX}:${conversationKey}`,
          conversationKey,
          conversationGeneration: 0,
          chatLibraryID: libraryID(),
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [libraryID()],
            outputDirectories: [],
          },
        },
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `w5d-run:${SUFFIX}:${conversationKey}`,
      ...extra,
    } as AgentToolContext;
  }

  /**
   * One library_update call through central authorization. `beforeRun`
   * runs after the card is shown and before it is approved.
   */
  async function runTool(
    args: Record<string, unknown>,
    context: AgentToolContext,
    options: { mode?: "safe" | "yolo"; beforeRun?: () => Promise<void> } = {},
  ): Promise<AgentToolResult> {
    const originalMode = getOriginalAgentPermissionMode();
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode(options.mode || "yolo");
      const registry = new AgentToolRegistry(
        new ActionContractService(new ZoteroGateway()),
      );
      registry.register(
        Zotero.LLMForZotero.api.agent.getToolDefinition("library_update"),
      );
      let prepared = await registry.prepareExecution(
        {
          id: `library_update:${Math.random()}`,
          name: "library_update",
          arguments: args,
        },
        context,
        { callerKind: "model" },
      );
      if (options.beforeRun) {
        assert.equal(prepared.kind, "confirmation", "a card is shown first");
        await options.beforeRun();
      }
      const cards: string[] = [];
      while (prepared.kind === "confirmation") {
        cards.push(
          `${prepared.action.title}: ${prepared.action.description || ""}`,
        );
        assert.isBelow(cards.length, 4, cards.join(" | "));
        prepared = await prepared.execute({ approved: true });
      }
      if (cards.length > 1) console.log(`W5-D cards: ${cards.join(" | ")}`);
      lastCards = cards;
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") throw new Error("unreachable");
      return prepared.execution.result;
    } finally {
      setOriginalAgentPermissionMode(originalMode);
    }
  }

  async function makeItems(label: string, count = ITEM_COUNT) {
    const ids: number[] = [];
    await Zotero.DB.executeTransaction(async () => {
      for (let index = 1; index <= count; index += 1) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID();
        item.setField("title", `${label} ${index} ${SUFFIX}`);
        item.setField("extra", `original ${index}`);
        await item.save();
        ids.push(item.id);
      }
    });
    created.push(...ids);
    return ids;
  }

  /** Items, by id, that hold the tag in Zotero's own tables. */
  async function taggedIds(ids: number[], tag: string): Promise<number[]> {
    const rows = (await Zotero.DB.columnQueryAsync(
      `SELECT itemTags.itemID FROM itemTags JOIN tags USING (tagID)
       WHERE tags.name = ? AND itemTags.itemID IN (${ids.join(",")})`,
      [tag],
    )) as number[];
    return rows.map(Number).sort((a, b) => a - b);
  }

  /** The `extra` field of each item, by id, from Zotero's own tables. */
  async function extraById(ids: number[]): Promise<Map<number, string>> {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT itemData.itemID AS itemID, itemDataValues.value AS value
       FROM itemData
       JOIN fields USING (fieldID)
       JOIN itemDataValues USING (valueID)
       WHERE fields.fieldName = 'extra' AND itemData.itemID IN (${ids.join(",")})`,
    )) as Array<{ itemID: number; value: string }>;
    return new Map(rows.map((row) => [Number(row.itemID), String(row.value)]));
  }

  /** Each item's clientDateModified, from Zotero's own tables. */
  async function modifiedById(ids: number[]): Promise<Map<number, string>> {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT itemID, clientDateModified FROM items
       WHERE itemID IN (${ids.join(",")})`,
    )) as Array<{ itemID: number; clientDateModified: string }>;
    return new Map(
      rows.map((row) => [Number(row.itemID), String(row.clientDateModified)]),
    );
  }

  async function journalFor(conversationKey: number) {
    return (await listJournalActions({ conversationKey, limit: 20 })).filter(
      (action) => action.toolName === "library_update",
    );
  }

  /** How many applied steps of the action name each item. */
  function appliedStepsPerItem(
    action: JournalActionWithSteps,
  ): Map<number, number> {
    const counts = new Map<number, number>();
    for (const step of action.steps) {
      if (step.status !== "applied") continue;
      const forward = JSON.parse(step.forwardJson) as {
        itemId?: number;
        itemIds?: number[];
      };
      for (const itemId of forward.itemIds || [forward.itemId || 0])
        counts.set(itemId, (counts.get(itemId) || 0) + 1);
    }
    return counts;
  }

  function batchOf(result: AgentToolResult): {
    checkpointedBatch: {
      batchId: string;
      total: number;
      done: number;
      changed: number;
      failed: Array<{ itemIds: number[]; error: string }>;
      notStarted: number;
      stopped: boolean;
    };
    message: string;
  } {
    const content = result.content as {
      result?: { result?: unknown };
      results?: Array<{ result?: unknown }>;
    };
    const inner = (content.result?.result ||
      content.results?.[0]?.result) as ReturnType<typeof batchOf>;
    assert.exists(inner?.checkpointedBatch, JSON.stringify(result.content));
    return inner;
  }

  function stopAfter(test: () => boolean) {
    return {
      get aborted() {
        return test();
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as never;
  }

  /**
   * Waits until Zotero and the plugin have finished starting, including the
   * journal's startup recovery, so the first write does not compete with them.
   */
  async function waitForStartup(): Promise<void> {
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    for (
      let waited = 0;
      waited < 100 && !Zotero.LLMForZotero?.api?.agent?.getToolDefinition;
      waited += 1
    )
      await Zotero.Promise.delay(100);
    await initAgentChangeJournal();
    await Zotero.Promise.delay(1000);
  }

  /** What Zotero's database connection says about its transaction state. */
  function describeDbLock(): string {
    const fields: Record<string, unknown> = {};
    try {
      fields.inTransaction = Zotero.DB.inTransaction();
    } catch {
      /* not available */
    }
    for (const key of Object.keys(Zotero.DB)) {
      const value = Zotero.DB[key];
      if (
        /transaction|lock|queue|caller/i.test(key) &&
        (value === null ||
          ["string", "number", "boolean"].includes(typeof value))
      )
        fields[key] = value;
    }
    return JSON.stringify(fields);
  }

  /** Wraps a restart test so a database timeout names the transaction state. */
  function diagnosed(test: (this: Mocha.Context) => Promise<void>) {
    return async function (this: Mocha.Context) {
      try {
        await test.call(this);
      } catch (error) {
        const { name, message } = error as Error;
        if (/timeout/i.test(`${name} ${message}`))
          console.log(`W5-D database timeout; ${describeDbLock()}`);
        throw error;
      }
    };
  }

  /**
   * Kills this Zotero process with SIGKILL once `test` holds, from inside the
   * call, so the batch dies between two items with nothing written after the
   * last finished one: no finally block, no shutdown, as in a crash. The
   * blocking process call never returns, because the kill ends this process.
   */
  function killedWhen(test: () => boolean) {
    return {
      get aborted() {
        if (test()) {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(
            Ci.nsIFile,
          );
          file.initWithPath("/bin/kill");
          const process = Cc["@mozilla.org/process/util;1"].createInstance(
            Ci.nsIProcess,
          );
          process.init(file);
          process.run(true, ["-9", String(Services.appinfo.processID)], 2);
        }
        return false;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as never;
  }

  /** Measurements go to a file named by W5D_REPORT_DIR, when it is set. */
  async function recordMeasurement(name: string, report: unknown) {
    console.log(`W5-D ${name}: ${JSON.stringify(report)}`);
    const dir = (globalThis as any).Services?.env?.get?.("W5D_REPORT_DIR");
    if (typeof dir === "string" && dir)
      await IOUtils.writeUTF8(
        PathUtils.join(dir, `${name}.json`),
        JSON.stringify(report, null, 2),
      );
  }

  after(async function () {
    if (created.length)
      await Zotero.Items.erase(created).catch(() => undefined);
  });

  it("stops a 120-item tag edit after 60, continues it changing each item once, and one undo restores all", async function () {
    const ids = await makeItems("Bulk tag");
    const tag = `bulk-${SUFFIX}`;
    const key = ids[0];
    const first = await runTool(
      { kind: "tags", action: "add", itemIds: ids, tags: [tag] },
      contextFor(key, "Tag all", {
        signal: stopAfter(() =>
          Zotero.Items.get(ids[STOP_AFTER - 1]).hasTag(tag),
        ),
      }),
    );
    assert.isTrue(first.ok, JSON.stringify(first.content));
    const stopped = batchOf(first);
    assert.deepInclude(stopped.checkpointedBatch, {
      total: ITEM_COUNT,
      done: STOP_AFTER,
      changed: STOP_AFTER,
      notStarted: ITEM_COUNT - STOP_AFTER,
      stopped: true,
    });
    assert.include(stopped.message, "60 of 120 done");
    assert.include(
      stopped.message,
      `resumeBatchId:'${stopped.checkpointedBatch.batchId}'`,
    );
    assert.deepEqual(await taggedIds(ids, tag), ids.slice(0, STOP_AFTER));
    const [receipt] = first.actionReceipts || [];
    assert.equal(receipt?.status, "partial", JSON.stringify(receipt));
    assert.equal(receipt?.verification, "verified");
    assert.deepEqual(
      receipt?.appliedTargets,
      ids.slice(0, STOP_AFTER).map((id) => `item:${id}`),
    );
    assert.deepEqual(receipt?.rejectedTargets, []);
    let [action] = await journalFor(key);
    assert.equal(action.status, "partially_applied");
    assert.lengthOf(action.steps, STOP_AFTER);

    const touchedBefore = await modifiedById(ids.slice(0, STOP_AFTER));
    await Zotero.Promise.delay(1100);
    const resumed = await runTool(
      { kind: "tags", resumeBatchId: stopped.checkpointedBatch.batchId },
      contextFor(key, "Continue"),
    );
    assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
    const done = batchOf(resumed);
    assert.deepInclude(done.checkpointedBatch, {
      batchId: stopped.checkpointedBatch.batchId,
      total: ITEM_COUNT,
      done: ITEM_COUNT,
      changed: ITEM_COUNT - STOP_AFTER,
      notStarted: 0,
      stopped: false,
    });
    assert.include(done.message, "Nothing remains.");
    assert.deepEqual(await taggedIds(ids, tag), ids);
    assert.deepEqual(
      await modifiedById(ids.slice(0, STOP_AFTER)),
      touchedBefore,
      "the resume did not write the items already done",
    );
    assert.deepEqual(
      resumed.actionReceipts?.flatMap((entry) => entry.appliedTargets),
      ids.slice(STOP_AFTER).map((id) => `item:${id}`),
    );
    const actions = await journalFor(key);
    assert.lengthOf(actions, 1, "the resume continued the batch's action");
    [action] = actions;
    assert.equal(action.status, "applied");
    const perItem = appliedStepsPerItem(action);
    for (const id of ids) assert.equal(perItem.get(id), 1, `item ${id}`);

    // Nothing is left, so continuing again changes nothing.
    const again = await runTool(
      { kind: "tags", resumeBatchId: stopped.checkpointedBatch.batchId },
      contextFor(key, "Continue"),
    );
    assert.isTrue(again.ok);
    assert.equal(batchOf(again).checkpointedBatch.changed, 0);
    assert.lengthOf((await journalFor(key))[0].steps, ITEM_COUNT);

    const undone = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context: contextFor(key, "Undo"),
    });
    assert.equal(undone.reverted, 1, JSON.stringify(undone).slice(0, 2000));
    assert.deepEqual(await taggedIds(ids, tag), []);
  });

  it("stops a 120-item metadata edit after 60, continues it changing each item once, and one undo restores all", async function () {
    const ids = await makeItems("Bulk metadata");
    const marker = `edited ${SUFFIX}`;
    const key = ids[0];
    const first = await runTool(
      { kind: "metadata", itemIds: ids, metadata: { extra: marker } },
      contextFor(key, "Edit all", {
        signal: stopAfter(
          () =>
            Zotero.Items.get(ids[STOP_AFTER - 1]).getField("extra") === marker,
        ),
      }),
    );
    assert.isTrue(first.ok, JSON.stringify(first.content));
    const stopped = batchOf(first);
    assert.deepInclude(stopped.checkpointedBatch, {
      total: ITEM_COUNT,
      done: STOP_AFTER,
      changed: STOP_AFTER,
      notStarted: ITEM_COUNT - STOP_AFTER,
      stopped: true,
    });
    let extras = await extraById(ids);
    ids.forEach((id, index) =>
      assert.equal(
        extras.get(id),
        index < STOP_AFTER ? marker : `original ${index + 1}`,
      ),
    );
    const receipts = first.actionReceipts || [];
    assert.lengthOf(receipts, ITEM_COUNT);
    assert.deepEqual(
      receipts.map((receipt) => receipt.status),
      ids.map((_, index) => (index < STOP_AFTER ? "applied" : "cancelled")),
    );

    const touchedBefore = await modifiedById(ids.slice(0, STOP_AFTER));
    await Zotero.Promise.delay(1100);
    const resumed = await runTool(
      { kind: "metadata", resumeBatchId: stopped.checkpointedBatch.batchId },
      contextFor(key, "Continue"),
    );
    assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
    assert.deepInclude(batchOf(resumed).checkpointedBatch, {
      done: ITEM_COUNT,
      changed: ITEM_COUNT - STOP_AFTER,
    });
    extras = await extraById(ids);
    for (const id of ids) assert.equal(extras.get(id), marker);
    assert.deepEqual(
      await modifiedById(ids.slice(0, STOP_AFTER)),
      touchedBefore,
      "the resume did not write the items already done",
    );
    const actions = await journalFor(key);
    assert.lengthOf(actions, 1);
    const perItem = appliedStepsPerItem(actions[0]);
    for (const id of ids) assert.equal(perItem.get(id), 1, `item ${id}`);

    const undone = await revertActions({
      actions,
      zoteroGateway: new ZoteroGateway(),
      context: contextFor(key, "Undo"),
    });
    assert.equal(undone.reverted, 1, JSON.stringify(undone).slice(0, 2000));
    extras = await extraById(ids);
    ids.forEach((id, index) =>
      assert.equal(extras.get(id), `original ${index + 1}`, `item ${id}`),
    );
  });

  it("reports an item deleted between the card and the run exactly, and changes the others", async function () {
    const count = 55;
    for (const kind of ["tags", "metadata"] as const) {
      const ids = await makeItems(`Bulk failure ${kind}`, count);
      const gone = ids[10];
      const tag = `bulk-fail-${SUFFIX}`;
      const marker = `failed ${SUFFIX}`;
      const result = await runTool(
        kind === "tags"
          ? { kind, action: "add", itemIds: ids, tags: [tag] }
          : { kind, itemIds: ids, metadata: { extra: marker } },
        contextFor(ids[0], "Change all"),
        {
          mode: "safe",
          beforeRun: () => Zotero.Items.erase([gone]),
        },
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      // A metadata item that vanished has no undo any more, so central
      // authorization shows the wider impact on a second card first.
      assert.lengthOf(
        lastCards,
        kind === "tags" ? 1 : 2,
        lastCards.join(" | "),
      );
      const { checkpointedBatch, message } = batchOf(result);
      assert.lengthOf(checkpointedBatch.failed, 1, message);
      assert.deepEqual(checkpointedBatch.failed[0].itemIds, [gone]);
      assert.equal(checkpointedBatch.changed, count - 1);
      assert.include(message, `Failed: item ${gone}:`);
      const live = ids.filter((id) => id !== gone);
      if (kind === "tags") {
        assert.deepEqual(await taggedIds(ids, tag), live);
      } else {
        const extras = await extraById(ids);
        for (const id of live) assert.equal(extras.get(id), marker);
      }
      const rejected = (result.actionReceipts || []).flatMap(
        (receipt) => receipt.rejectedTargets,
      );
      assert.deepEqual(rejected, [`item:${gone}`]);
    }
  });

  it("continues a stopped batch over MCP, and the result names what was done and what remains", async function () {
    // A standalone MCP client writes in conversation 0, so the batch is
    // stopped there in the plugin and continued by the MCP endpoint.
    const ids = await makeItems("Bulk MCP", 60);
    const tag = `bulk-mcp-${SUFFIX}`;
    const stopAt = 30;
    const first = await runTool(
      { kind: "tags", action: "add", itemIds: ids, tags: [tag] },
      contextFor(0, "Tag all", {
        signal: stopAfter(() => Zotero.Items.get(ids[stopAt - 1]).hasTag(tag)),
      }),
    );
    const { batchId } = batchOf(first).checkpointedBatch;
    assert.include(batchOf(first).message, "30 of 60 done");
    assert.include(batchOf(first).message, "30 remain.");
    const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new Endpoint().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "library_update",
          arguments: { kind: "tags", resumeBatchId: batchId },
        },
      },
    });
    assert.equal(status, 200);
    const payload = JSON.parse(body);
    assert.isNotTrue(payload.result?.isError, body);
    const text = payload.result.content[0].text as string;
    assert.include(text, "Changed 30 items; 60 of 60 done.", text);
    assert.include(text, "Nothing remains.");
    assert.deepEqual(await taggedIds(ids, tag), ids);
    const [action] = (await journalFor(0)).filter(
      (entry) => entry.actionId === batchId,
    );
    const perItem = appliedStepsPerItem(action);
    for (const id of ids) assert.equal(perItem.get(id), 1, `item ${id}`);
    // Conversation 0 is every standalone MCP client's: leave nothing for a
    // later "undo" there to find.
    const undone = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context: contextFor(0, "Undo"),
    });
    assert.equal(undone.reverted, 1);
  });

  it("runs an edit of 50 items as it always has: one action, no frozen batch", async function () {
    const ids = await makeItems("Bulk fifty", 50);
    const tag = `fifty-${SUFFIX}`;
    const result = await runTool(
      { kind: "tags", action: "add", itemIds: ids, tags: [tag] },
      contextFor(ids[0], "Tag fifty"),
    );
    assert.isTrue(result.ok);
    const content = result.content as { result?: { result?: unknown } };
    assert.notProperty(
      content.result?.result as object,
      "checkpointedBatch",
      JSON.stringify(content).slice(0, 500),
    );
    assert.equal(
      (content.result?.result as { updatedCount?: number }).updatedCount,
      50,
    );
    const [action] = await journalFor(ids[0]);
    assert.lengthOf(action.steps, 1);
    assert.equal(
      await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${JOURNAL_PAYLOADS_TABLE} WHERE action_id = ? AND kind = 'frozen_operations'`,
        [action.actionId],
      ),
      0,
    );
    assert.deepEqual(await taggedIds(ids, tag), ids);
  });

  it("does not continue a journal written before batches froze their items, and still undoes it", async function () {
    // The pre-change shape: an action with no frozen list, here one the
    // unchanged path writes, left interrupted.
    const ids = await makeItems("Bulk legacy", 40);
    const key = ids[0];
    const marker = `legacy ${SUFFIX}`;
    const result = await runTool(
      { kind: "metadata", itemIds: ids, metadata: { extra: marker } },
      contextFor(key, "Edit all"),
    );
    assert.isTrue(result.ok);
    const [action] = await journalFor(key);
    await Zotero.DB.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE} SET status = 'partially_applied' WHERE action_id = ?`,
      [action.actionId],
    );
    const refused = await runTool(
      { kind: "metadata", resumeBatchId: action.actionId },
      contextFor(key, "Continue"),
    );
    assert.isFalse(refused.ok);
    assert.include(
      JSON.stringify(refused.content),
      "is not a checkpointed batch",
    );
    assert.lengthOf((await journalFor(key))[0].steps, 40);
    const undone = await revertActions({
      actions: await journalFor(key),
      zoteroGateway: new ZoteroGateway(),
      context: contextFor(key, "Undo"),
    });
    assert.equal(undone.reverted, 1, JSON.stringify(undone).slice(0, 2000));
    const extras = await extraById(ids);
    ids.forEach((id, index) =>
      assert.equal(extras.get(id), `original ${index + 1}`),
    );
  });

  it("records the wall time of a 120-item tag edit and metadata edit, and of their undo (measurement)", async function () {
    const report: Record<string, unknown> = {};
    for (const kind of ["tags", "metadata"] as const) {
      const ids = await makeItems(`Bulk timing ${kind}`);
      const key = ids[0];
      let started = Date.now();
      const result = await runTool(
        kind === "tags"
          ? { kind, action: "add", itemIds: ids, tags: [`timing-${SUFFIX}`] }
          : { kind, itemIds: ids, metadata: { extra: `timed ${SUFFIX}` } },
        contextFor(key, "Change all"),
      );
      const runMs = Date.now() - started;
      assert.isTrue(result.ok);
      const actions = await journalFor(key);
      started = Date.now();
      const undone = await revertActions({
        actions,
        zoteroGateway: new ZoteroGateway(),
        context: contextFor(key, "Undo"),
      });
      report[kind] = {
        wallMs: runMs,
        steps: actions.map((action) => action.steps.length),
        undoMs: Date.now() - started,
        reverted: undone.reverted,
      };
      assert.equal(undone.reverted, 1);
    }
    await recordMeasurement("after", report);
  });

  /**
   * Resume across a real Zotero restart, in two processes: the
   * `interrupt` phase stops a batch and records it in the data folder; the
   * `resume` phase starts a new Zotero on a copy of that data folder and
   * continues it. `npm run test:bulk-edit-restart` runs both, stopped and
   * killed (scripts/run-bulk-edit-restart-test.mjs); in an ordinary run
   * W5D_RESTART_PHASE is unset and these do nothing.
   */
  describe("across a Zotero restart", function () {
    const recordPath = () =>
      PathUtils.join(Zotero.DataDirectory.dir, "w5d-restart-record.json");

    it(
      "interrupt phase: stops a 120-item tag edit after 60",
      diagnosed(async function () {
        if (restartPhase() !== "interrupt") this.skip();
        await waitForStartup();
        const ids: number[] = [];
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 1; index <= ITEM_COUNT; index += 1) {
            const item = new Zotero.Item("journalArticle");
            item.libraryID = libraryID();
            item.setField("title", `Restart ${index} ${SUFFIX}`);
            await item.save();
            ids.push(item.id);
          }
        });
        const tag = `restart-${SUFFIX}`;
        const result = await runTool(
          { kind: "tags", action: "add", itemIds: ids, tags: [tag] },
          contextFor(ids[0], "Tag all", {
            signal: stopAfter(() =>
              Zotero.Items.get(ids[STOP_AFTER - 1]).hasTag(tag),
            ),
          }),
        );
        const { checkpointedBatch } = batchOf(result);
        assert.equal(checkpointedBatch.done, STOP_AFTER);
        await IOUtils.writeUTF8(
          recordPath(),
          JSON.stringify({ ids, tag, batchId: checkpointedBatch.batchId }),
        );
      }),
    );

    it(
      "crash phase: Zotero is killed between items of a 120-item tag edit",
      diagnosed(async function () {
        if (restartPhase() !== "crash") this.skip();
        await waitForStartup();
        const ids: number[] = [];
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 1; index <= ITEM_COUNT; index += 1) {
            const item = new Zotero.Item("journalArticle");
            item.libraryID = libraryID();
            item.setField("title", `Crash ${index} ${SUFFIX}`);
            await item.save();
            ids.push(item.id);
          }
        });
        const tag = `crash-${SUFFIX}`;
        // No batch id: a crash gives the model no result, so the resume phase
        // finds the batch in the journal.
        await IOUtils.writeUTF8(
          recordPath(),
          JSON.stringify({ ids, tag, crashed: true }),
        );
        await runTool(
          { kind: "tags", action: "add", itemIds: ids, tags: [tag] },
          contextFor(ids[0], "Tag all", {
            signal: killedWhen(() =>
              Zotero.Items.get(ids[STOP_AFTER - 1]).hasTag(tag),
            ),
          }),
        );
        assert.fail("Zotero was not killed");
      }),
    );

    it(
      "resume phase: continues the batch after the restart and undoes it",
      diagnosed(async function () {
        if (restartPhase() !== "resume") this.skip();
        await waitForStartup();
        const record = JSON.parse(await IOUtils.readUTF8(recordPath())) as {
          ids: number[];
          tag: string;
          batchId?: string;
          crashed?: boolean;
        };
        const { ids, tag } = record;
        created.push(...ids);
        // A new process: the frozen list and the done steps come from disk.
        assert.deepEqual(await taggedIds(ids, tag), ids.slice(0, STOP_AFTER));
        let batchId = record.batchId || "";
        if (record.crashed) {
          // The process died before the call wrote the action's count.
          const [crashedAction] = await journalFor(ids[0]);
          batchId = crashedAction.actionId;
          console.log(
            `W5-D crash state: ${crashedAction.status}, affectedCount ${crashedAction.affectedCount}, ${crashedAction.steps.length} steps`,
          );
          assert.lengthOf(crashedAction.steps, STOP_AFTER);
          assert.equal(crashedAction.status, "partially_applied");
          assert.equal(
            crashedAction.affectedCount,
            0,
            "only a finished call writes the action's count",
          );
          // A resume that stops before its first item must not erase the undo
          // of the items done before the crash.
          const stoppedAtOnce = await runTool(
            { kind: "tags", resumeBatchId: batchId },
            contextFor(ids[0], "Continue", {
              // Authorization does not see the stop; the batch's own loop does.
              signal: stopAfter(() =>
                String(new Error().stack).includes("executeCheckpointedAction"),
              ),
            }),
          );
          assert.isTrue(
            stoppedAtOnce.ok,
            JSON.stringify(stoppedAtOnce.content),
          );
          const [afterStop] = await journalFor(ids[0]);
          assert.equal(afterStop.status, "partially_applied");
          assert.equal(afterStop.affectedCount, STOP_AFTER);
          assert.deepInclude(batchOf(stoppedAtOnce).checkpointedBatch, {
            done: STOP_AFTER,
            changed: 0,
          });
        }
        const resumed = await runTool(
          { kind: "tags", resumeBatchId: batchId },
          contextFor(ids[0], "Continue"),
        );
        assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
        assert.deepInclude(batchOf(resumed).checkpointedBatch, {
          batchId,
          done: ITEM_COUNT,
          changed: ITEM_COUNT - STOP_AFTER,
        });
        console.log(
          `W5-D resume readback: tagged ${(await taggedIds(ids, tag)).length} of ${ids.length}`,
        );
        assert.deepEqual(await taggedIds(ids, tag), ids);
        const actions = await journalFor(ids[0]);
        assert.lengthOf(actions, 1);
        const perItem = appliedStepsPerItem(actions[0]);
        for (const id of ids) assert.equal(perItem.get(id), 1, `item ${id}`);
        const undone = await revertActions({
          actions,
          zoteroGateway: new ZoteroGateway(),
          context: contextFor(ids[0], "Undo"),
        });
        assert.equal(undone.reverted, 1);
        assert.deepEqual(await taggedIds(ids, tag), []);
        await IOUtils.remove(recordPath());
      }),
    );
  });
});
