import { assert } from "chai";
import { autoTagAction } from "../src/agent/actions/autoTag";
import {
  listJournalActions,
  type JournalActionWithSteps,
} from "../src/agent/store/changeJournal";
import {
  builtInUndoTool,
  createBatchLibrary,
  installBatchJournal,
  runBatchActionFixture,
  undoFixture,
  type BatchLibrary,
} from "./helpers/batchFixtures";

/**
 * `undo` is the one recovery tool: no arguments undoes the newest reversible
 * action, and count/actionIds/dryRun revert several newest-first. Driven
 * through the production registry and a real journal, so the only fake is the
 * in-memory library behind the gateway.
 */
describe("undo tool", function () {
  let restore: () => void;
  let library: BatchLibrary;
  /** Oldest first: auto-tag of paper 1, then 2, then 3. */
  let actions: JournalActionWithSteps[];

  beforeEach(async function () {
    restore = await installBatchJournal();
    library = createBatchLibrary([{ itemId: 1 }, { itemId: 2 }, { itemId: 3 }]);
    for (const itemId of [1, 2, 3]) {
      const run = await runBatchActionFixture({
        action: autoTagAction,
        input: { itemIds: [itemId] },
        library,
      });
      if (!run.result.ok) throw new Error(JSON.stringify(run.result));
    }
    // The journal's own order (newest first, insertion breaks timestamp
    // ties), reversed: the runs can share a millisecond.
    actions = (
      await listJournalActions({ conversationKey: library.conversationKey })
    ).reverse();
    assert.lengthOf(actions, 3, "one journal action per auto-tag run");
    for (const itemId of [1, 2, 3]) {
      assert.isNotEmpty(library.tagsOf(itemId), `paper ${itemId} was tagged`);
    }
  });

  afterEach(function () {
    restore();
  });

  it("is the only registered recovery tool", function () {
    const registry = builtInUndoTool(library).registry;
    assert.exists(registry.getTool("undo"));
    assert.notExists(registry.getTool("undo_last_action"));
    assert.notExists(registry.getTool("revert_changes"));
  });

  it("dryRun with count lists the two newest reversible actions without reverting", async function () {
    const result = await undoFixture(library, { dryRun: true, count: 2 });

    assert.isTrue(result.dryRun);
    const changes = result.changes as Array<{ actionId: string }>;
    assert.deepEqual(
      changes.map((change) => change.actionId),
      [actions[2].actionId, actions[1].actionId],
    );
    for (const itemId of [1, 2, 3]) {
      assert.isNotEmpty(
        library.tagsOf(itemId),
        `paper ${itemId} kept its tags`,
      );
    }
  });

  it("with no arguments undoes only the newest action", async function () {
    const result = await undoFixture(library, {});

    assert.equal(result.status, "undone");
    assert.equal(result.actionId, actions[2].actionId);
    assert.deepEqual(library.tagsOf(3), []);
    assert.isNotEmpty(library.tagsOf(1));
    assert.isNotEmpty(library.tagsOf(2));
  });

  it("with actionIds reverts exactly those actions", async function () {
    const result = await undoFixture(library, {
      actionIds: [actions[0].actionId, actions[1].actionId],
    });

    assert.equal(result.reverted, 2);
    assert.sameMembers(result.actionIds as string[], [
      actions[0].actionId,
      actions[1].actionId,
    ]);
    assert.deepEqual(library.tagsOf(1), []);
    assert.deepEqual(library.tagsOf(2), []);
    assert.isNotEmpty(library.tagsOf(3), "the unnamed newest action remains");
  });

  it("shows the single-undo card for one action and the multi-revert card for several", async function () {
    const { tool, context } = builtInUndoTool(library);
    const single = tool.validate({});
    const many = tool.validate({ count: 2 });
    if (!single.ok || !many.ok) throw new Error("validation failed");

    const singleCard = await tool.createPendingAction!(single.value, context);
    assert.equal(singleCard.toolName, "undo");
    assert.equal(singleCard.title, "Confirm undo");
    assert.equal(
      (singleCard.fields[0] as { value?: unknown }).value,
      actions[2].actionId,
    );

    const manyCard = await tool.createPendingAction!(many.value, context);
    assert.equal(manyCard.toolName, "undo");
    assert.equal(manyCard.title, "Undo 2 changes");
  });

  it("describes new actions in words, not by operation name", function () {
    for (const action of actions) {
      assert.notMatch(action.description, /^Apply |_/u, action.description);
      assert.match(action.description, /^Add tags? .+ to /u);
    }
  });

  it("rebuilds the card label of an earlier row from its steps", async function () {
    // Rows written before descriptions were in words read "Apply apply_tags".
    const rows = (
      globalThis.Zotero as unknown as {
        DB: { actions: Map<string, { description: string }> };
      }
    ).DB.actions;
    rows.get(actions[2].actionId)!.description = "Apply apply_tags";
    rows.get(actions[1].actionId)!.description =
      "library_update: 2 planned changes";

    const { tool, context } = builtInUndoTool(library);
    const single = tool.validate({});
    if (!single.ok) throw new Error("validation failed");
    const card = await tool.createPendingAction!(single.value, context);
    assert.notInclude(String(card.description), "apply_tags");
    assert.match(String(card.description), /^Add tags? .+ to /u);
    const option = (card.fields[0] as { options?: Array<{ label: string }> })
      .options![0];
    assert.equal(option.label, card.description);

    const dryRun = await undoFixture(library, { dryRun: true, count: 2 });
    for (const change of dryRun.changes as Array<{ description: string }>) {
      assert.match(change.description, /^Add tags? .+ to /u);
    }
    const manyCard = await tool.createPendingAction!(
      (() => {
        const many = tool.validate({ count: 2 });
        if (!many.ok) throw new Error("validation failed");
        return many.value;
      })(),
      context,
    );
    assert.notMatch(String(manyCard.description), /apply_tags|library_update/u);

    const result = await undoFixture(library, {});
    assert.equal(result.status, "undone");
    assert.match(String(result.description), /^Add tags? .+ to /u);
  });

  it("treats an explicit dryRun:false with nothing else as a single undo", async function () {
    const { tool } = builtInUndoTool(library);
    const validated = tool.validate({ dryRun: false });
    if (!validated.ok) throw new Error("validation failed");
    assert.deepEqual(validated.value, {});

    const result = await undoFixture(library, { dryRun: false });
    assert.equal(result.status, "undone");
    assert.equal(result.actionId, actions[2].actionId);
    assert.deepEqual(library.tagsOf(3), []);
    assert.isNotEmpty(library.tagsOf(1));
    assert.isNotEmpty(library.tagsOf(2));
  });

  it("rejects a dryRun that is not a boolean", function () {
    const { tool } = builtInUndoTool(library);
    const stringy = tool.validate({ dryRun: "true" });
    assert.isFalse(stringy.ok);
    assert.include(
      (stringy as { error: string }).error,
      "dryRun must be a boolean",
    );
    assert.isFalse(tool.validate({ count: 2, dryRun: 1 }).ok);
  });

  it("refuses to mix a single actionId with the multi-revert arguments", function () {
    const { tool } = builtInUndoTool(library);
    const mixed = tool.validate({ actionId: "a", count: 2 });
    assert.isFalse(mixed.ok);
    const listed = tool.validate({ actionId: "a", actionIds: ["b"] });
    assert.isFalse(listed.ok);
  });
});
