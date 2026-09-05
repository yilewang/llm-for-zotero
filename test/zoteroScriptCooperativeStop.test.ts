import { assert } from "chai";
import { revertActions } from "../src/agent/services/changeReverter";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The time budget was enforced with `Promise.race`, which stops *waiting* for
 * the script but cannot stop the script. On timeout the tool reported failure
 * while the script kept running and kept mutating the library — and kept
 * writing into the very `snapshots` Map and `undoSteps` array the undo entry
 * had closed over. What "undo" did therefore depended on when the user
 * happened to click it.
 */
describe("zotero_script cooperative cancellation", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: {
      conversationKey: 3,
      mode: "agent",
      userText: "run",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  async function run(script: string, timeoutMs?: number) {
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Items: { get: () => null },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
    };
    await initAgentChangeJournal();
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "read",
      script,
      description: "cancellation probe",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("unreachable");
    const output = await tool.execute(validated.value, context);
    return output.content as Record<string, unknown>;
  }

  it("gives the script a stop signal it can honour", async function () {
    const result = await run(
      "return { hasStop: typeof env.shouldStop === 'function', stopped: env.shouldStop(), remaining: env.remainingMs() };",
    );
    const value = result.returnValue as Record<string, unknown>;
    assert.isTrue(value.hasStop, "long loops need a way to bail out cleanly");
    assert.isFalse(value.stopped, "the budget has not expired yet");
    assert.isAbove(value.remaining as number, 0);
  });

  it("counts down against a real deadline", async function () {
    const result = await run(
      "const before = env.remainingMs();" +
        "const start = Date.now(); while (Date.now() - start < 25) {}" +
        "return { before, after: env.remainingMs() };",
    );
    const value = result.returnValue as { before: number; after: number };
    // A constant would satisfy shouldStop() === false forever.
    assert.isBelow(value.after, value.before);
  });

  it("waits for an over-deadline script to settle before returning", async function () {
    this.timeout(10000);
    // timeoutMs clamps to a 1000ms floor, so the script must outlast that.
    const startedAt = Date.now();
    const result = await run(
      "await new Promise((r) => setTimeout(r, 2500)); return 'done';",
      1000,
    );

    assert.include(String(result.error), "timed out");
    const output = String(result.output);
    assert.isAtLeast(
      Date.now() - startedAt,
      2400,
      "the tool must retain ownership until the script has finished",
    );
    assert.include(output, "allowed to settle");
    assert.include(output, "env.shouldStop()");
    assert.equal(result.returnValue, "done");
  });

  it("includes post-deadline snapshots in the recorded undo", async function () {
    this.timeout(10000);
    const items = new Map<number, unknown>();
    const snapshotted: number[] = [];
    const restored: number[] = [];
    const makeItem = (id: number) => ({
      id,
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getField: () => {
        // captureItemSnapshot reads fields; record who gets snapshotted.
        if (!snapshotted.includes(id)) snapshotted.push(id);
        return "";
      },
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      toJSON: () => ({ itemType: "journalArticle" }),
      addTag: () => undefined,
      setField: () => undefined,
      setTags: () => undefined,
      setCreators: () => undefined,
      fromJSON: () => undefined,
      saveTx: async () => {
        if (!restored.includes(id)) restored.push(id);
        return undefined;
      },
    });
    for (const id of [1, 2, 3]) items.set(id, makeItem(id));
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Items: { get: (id: number) => items.get(id) || null },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
    };
    await initAgentChangeJournal();

    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "snapshot, overrun, keep snapshotting",
      timeoutMs: 1000,
      // One item is snapshotted before the budget expires; two more are
      // snapshotted afterwards, while the tool has already given up.
      script:
        "env.snapshot(Zotero.Items.get(1));" +
        "await new Promise((r) => setTimeout(r, 2500));" +
        "env.snapshot(Zotero.Items.get(2));" +
        "env.snapshot(Zotero.Items.get(3));" +
        "return 'late';",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;

    assert.include(String(result.error), "timed out");

    assert.deepEqual(
      snapshotted,
      [1, 2, 3],
      "the tool must not return before later snapshots are recorded",
    );

    const actions = await listJournalActions({
      conversationKey: context.request.conversationKey,
    });
    assert.lengthOf(actions, 1, "the timed-out script is one durable action");
    assert.equal(actions[0].status, "applied");
    assert.equal(actions[0].reversibility, "partial");
    assert.lengthOf(actions[0].steps, 1);
    assert.include(
      String(actions[0].steps[0].inverseJson),
      '"storage":"inline"',
      "script snapshots are stored as a checksummed recovery payload",
    );

    const outcome = await revertActions({
      actions,
      zoteroGateway: {
        getItem: (id: number) => items.get(id) || null,
        trashItems: async () => ({ trashedCount: 0 }),
      } as never,
      context,
    });
    assert.equal(outcome.reverted, 0);
    assert.equal(outcome.partiallyReverted, 1);
    assert.equal(outcome.residuals[0]?.actionId, actions[0].actionId);
    assert.deepEqual(
      restored.sort(),
      [1, 2, 3],
      "every recorded mutation remains undoable when the tool returns",
    );
  });
});
