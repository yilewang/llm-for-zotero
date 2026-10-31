import { assert } from "chai";
import {
  initAgentChangeJournal,
  listJournalActions,
  prepareJournalStep,
  updateJournalStep,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { executeLibraryMutationAction } from "../src/agent/services/mutationCoordinator";
import {
  describeCheckpointedBatch,
  readCheckpointedBatch,
  remainingOperations,
} from "../src/agent/services/checkpointedBatch";
import type { LibraryMutationOperation } from "../src/agent/services/libraryMutationService";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * A checkpointed bulk edit across a process that died: what the journal holds
 * after startup must still let the batch resume, count, and undo every item
 * done before the crash.
 */
describe("checkpointed bulk edit recovery", function () {
  const originalZotero = globalThis.Zotero;
  let db: ChangeJournalTestDb;

  const context = {
    request: { conversationKey: 41, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => index + 1);
  const tagOps = (count: number): LibraryMutationOperation[] =>
    ids(count).map((itemId) => ({
      type: "apply_tags",
      itemIds: [itemId],
      tags: ["x"],
    }));

  type Behavior = "normal" | "missing" | "normalized";

  /** An in-memory library with a tag edit, and a hook per item. */
  function library(options: {
    tagged?: number[];
    behavior?: (itemId: number) => Behavior;
    onExecute?: (itemId: number) => void;
  }) {
    const tags = new Map<number, Set<string>>();
    for (const itemId of options.tagged || []) tags.set(itemId, new Set(["x"]));
    const executed: number[] = [];
    const stateOf = (operation: { type: string; itemIds?: number[] }) => ({
      version: 1,
      operation: operation.type,
      items: (operation.itemIds || []).map((itemId) => ({
        itemId,
        exists: options.behavior?.(itemId) !== "missing",
        tags: [...(tags.get(itemId) || [])],
      })),
    });
    const service = {
      planOperation: async (operation: {
        type: string;
        itemIds: number[];
        tags: string[];
      }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `tag ${operation.itemIds.join(",")}`,
        precondition: stateOf(operation),
        inverseOperations: [
          {
            type: "remove_tags" as const,
            itemIds: operation.itemIds,
            tags: operation.tags,
          },
        ],
      }),
      executeOperation: async (operation: {
        type: string;
        itemIds: number[];
        tags: string[];
      }) => {
        const itemId = operation.itemIds[0];
        executed.push(itemId);
        options.onExecute?.(itemId);
        const behavior = options.behavior?.(itemId) || "normal";
        if (behavior === "missing")
          return {
            result: {
              operation: operation.type,
              result: { status: "missing", reason: "Item not found" },
            },
            effect: "none" as const,
            affectedCount: 0,
          };
        const had = tags.get(itemId)?.has("x");
        if (behavior === "normal")
          tags.set(itemId, new Set([...(tags.get(itemId) || []), "x"]));
        const changed = behavior === "normalized" || !had;
        return {
          result: { operation: operation.type, result: { updatedCount: 1 } },
          effect: changed ? ("applied" as const) : ("none" as const),
          affectedCount: changed ? 1 : 0,
          inverse: changed
            ? {
                description: "remove",
                inverseOperations: [
                  {
                    type: "remove_tags" as const,
                    itemIds: operation.itemIds,
                    tags: operation.tags,
                  },
                ],
              }
            : undefined,
        };
      },
      captureOperationState: async (operation: {
        type: string;
        itemIds: number[];
      }) => stateOf(operation),
    };
    return { service: service as never, tags, executed };
  }

  /** A step the process died in: written to the journal as applying. */
  async function seedCrashedStep(
    lib: ReturnType<typeof library>,
    actionId: string,
    itemId: number,
    landed: boolean,
  ) {
    const operation = tagOps(60)[itemId - 1];
    const stepId = `${actionId}:${100 + itemId}`;
    await prepareJournalStep({
      stepId,
      actionId,
      sequence: 100 + itemId,
      operation: "apply_tags",
      forward: operation,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [{ type: "remove_tags", itemIds: [itemId], tags: ["x"] }],
      },
      precondition: {
        version: 1,
        operation: "apply_tags",
        items: [{ itemId, exists: true, tags: [] }],
      },
      reversibility: "full",
      status: "prepared",
    });
    await updateJournalStep({ stepId, status: "applying" });
    if (landed) lib.tags.set(itemId, new Set(["x"]));
    return stepId;
  }

  /** Stops the call once this many items have run. */
  function stopAfter(count: number, executed: number[]) {
    return {
      get aborted() {
        return executed.length >= count;
      },
    };
  }

  beforeEach(async function () {
    db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("keeps the undo of items done before a crash when the resume stops at once", async function () {
    const lib = library({ tagged: [1, 2, 3, 4, 5] });
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: stopAfter(30, lib.executed),
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    assert.equal(first.checkpoint?.done, 30);

    // The process died before the call's last write: the action still says
    // "applying" with a zero count, as only the finally block sets the count.
    const row = db.actions.get(actionId)!;
    row.status = "applying";
    row.affected_count = 0;
    await initAgentChangeJournal();
    assert.equal(db.actions.get(actionId)?.status, "partially_applied");
    assert.equal(db.actions.get(actionId)?.affected_count, 0);

    const resumed = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: { aborted: true },
        resumeJournalAction: { actionId },
      } as AgentToolContext,
      facadeToolName: "library_update",
    });

    // Items 1 to 5 already had the tag, so 25 of the 30 changed something.
    const after = db.actions.get(actionId)!;
    assert.equal(after.status, "partially_applied", "never failed");
    assert.equal(after.affected_count, 25);
    assert.equal(resumed.checkpoint?.done, 30);
    assert.isTrue(resumed.checkpoint?.resumable);
    assert.deepEqual(
      [...db.steps.values()].filter((step) => step.status === "applied").length,
      25,
    );
  });

  it("keeps the forward payload of done steps across a restart and writes no item twice", async function () {
    const lib = library({ tagged: [1, 2, 3, 4, 5] });
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: stopAfter(30, lib.executed),
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    await initAgentChangeJournal();
    for (const step of db.steps.values())
      assert.notEqual(step.forward_json, "{}", `step ${step.step_id}`);

    const batch = await readCheckpointedBatch({
      actionId,
      conversationKey: 41,
    });
    assert.lengthOf(batch.remaining, 30, "the no-effect items are done");

    const finished = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        resumeJournalAction: { actionId },
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    assert.equal(finished.checkpoint?.done, 60);
    assert.deepEqual(
      [...lib.executed].sort((a, b) => a - b),
      ids(60),
    );
    assert.equal(db.actions.get(actionId)?.status, "applied");
    assert.equal(db.actions.get(actionId)?.affected_count, 55);
  });

  it("records an item whose write landed before the crash as applied, with its inverse", async function () {
    const lib = library({});
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: stopAfter(30, lib.executed),
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    const landedStep = await seedCrashedStep(lib, actionId, 31, true);
    const lostStep = await seedCrashedStep(lib, actionId, 32, false);
    await initAgentChangeJournal();
    const executedBefore = lib.executed.length;

    await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        resumeJournalAction: { actionId },
      } as AgentToolContext,
      facadeToolName: "library_update",
    });

    const landed = db.steps.get(landedStep)!;
    assert.equal(landed.status, "applied");
    assert.isString(landed.inverse_json, "keeps the inverse planned before");
    assert.deepEqual(
      JSON.parse(String(landed.expected_postcondition_json)).items,
      [{ itemId: 31, exists: true, tags: ["x"] }],
    );
    assert.equal(db.steps.get(lostStep)?.status, "failed");
    const reRun = lib.executed.slice(executedBefore);
    assert.notInclude(reRun, 31, "the landed item is not written again");
    assert.include(reRun, 32, "the lost item is written");
    assert.equal(db.actions.get(actionId)?.status, "applied");
    assert.equal(db.actions.get(actionId)?.affected_count, 60);
  });

  it("stops offering a resume once a resume changed nothing", async function () {
    const lib = library({
      behavior: (itemId) => (itemId === 7 ? "missing" : "normal"),
    });
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    assert.equal(first.checkpoint?.changed, 59);
    assert.isTrue(first.checkpoint?.resumable, "the first call changed items");

    const again = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        resumeJournalAction: { actionId },
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    assert.equal(again.checkpoint?.changed, 0);
    assert.lengthOf(again.checkpoint?.failed || [], 1);
    assert.isFalse(again.checkpoint?.resumable);
    assert.isTrue(again.checkpoint?.stalled);
    const text = describeCheckpointedBatch(again.checkpoint!);
    assert.include(text, "Failed again: item 7");
    assert.notInclude(text, `resumeBatchId:'${actionId}'`);
    assert.equal(db.actions.get(actionId)?.status, "partially_applied");
    assert.equal(db.actions.get(actionId)?.affected_count, 59);
  });

  it("does not count an item as done when Zotero does not show its change", async function () {
    const lib = library({
      behavior: (itemId) => (itemId === 9 ? "normalized" : "normal"),
    });
    const outcome = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context,
      facadeToolName: "library_update",
    });
    const checkpoint = outcome.checkpoint!;
    assert.lengthOf(checkpoint.failed, 1);
    assert.equal(checkpoint.done, 59);
    const text = describeCheckpointedBatch(checkpoint);
    assert.include(text, "Failed: item 9");
    assert.notInclude(text, "Nothing remains");
    // The write was journalled, so the action still undoes it.
    assert.equal(db.actions.get(outcome.actionId!)?.affected_count, 60);
  });

  it("owes an applied step whose post-image does not show its change", function () {
    const frozen = tagOps(2);
    const step = (itemId: number, tags: string[]) => ({
      status: "applied" as const,
      forwardJson: JSON.stringify(frozen[itemId - 1]),
      expectedPostconditionJson: JSON.stringify({
        version: 1,
        operation: "apply_tags",
        items: [{ itemId, exists: true, tags }],
      }),
    });
    assert.deepEqual(
      remainingOperations(frozen, [step(1, ["x"]), step(2, [])]),
      [frozen[1]],
    );
  });
  it("does not offer another resume for an item whose change Zotero never shows", async function () {
    const lib = library({
      behavior: (itemId) => (itemId === 9 ? "normalized" : "normal"),
    });
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    assert.isTrue(first.checkpoint?.resumable, "the first call finished items");
    for (let round = 1; round <= 2; round += 1) {
      const again = await executeLibraryMutationAction({
        service: lib.service,
        operations: tagOps(60),
        context: {
          ...context,
          resumeJournalAction: { actionId },
        } as AgentToolContext,
        facadeToolName: "library_update",
      });
      assert.isTrue(again.checkpoint?.stalled, `resume ${round}`);
      assert.isFalse(again.checkpoint?.resumable, `resume ${round}`);
      assert.include(
        describeCheckpointedBatch(again.checkpoint!),
        "Failed again: item 9",
      );
      assert.equal(
        db.actions.get(actionId)?.affected_count,
        60,
        "an item written again counts once",
      );
    }
  });

  it("settles the steps of an interrupted attempt only after the resume holds the action", async function () {
    const lib = library({});
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: stopAfter(30, lib.executed),
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    const stepId = await seedCrashedStep(lib, actionId, 31, true);
    await initAgentChangeJournal();
    // Another run holds the action, so this one's claim is refused.
    db.actions.get(actionId)!.status = "applying";
    let message = "";
    try {
      await executeLibraryMutationAction({
        service: lib.service,
        operations: tagOps(60),
        context: {
          ...context,
          resumeJournalAction: { actionId },
        } as AgentToolContext,
        facadeToolName: "library_update",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "cannot be continued");
    assert.equal(db.steps.get(stepId)?.status, "uncertain", "left alone");
    assert.equal(db.actions.get(actionId)?.status, "applying");
  });

  it("undoes a step settled after a crash through the real reverter", async function () {
    const lib = library({});
    const first = await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        signal: stopAfter(30, lib.executed),
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    const actionId = first.actionId!;
    const stepId = await seedCrashedStep(lib, actionId, 31, true);
    await initAgentChangeJournal();
    await executeLibraryMutationAction({
      service: lib.service,
      operations: tagOps(60),
      context: {
        ...context,
        resumeJournalAction: { actionId },
      } as AgentToolContext,
      facadeToolName: "library_update",
    });
    assert.equal(db.steps.get(stepId)?.status, "applied");
    assert.sameMembers([...(lib.tags.get(31) || [])], ["x"]);

    // The reverter reads and writes through a gateway: this one is backed by
    // the same tag store the fake service wrote.
    const itemOf = (itemId: number) => ({
      id: itemId,
      parentID: false,
      deleted: false,
      isRegularItem: () => true,
      getTags: () => [...(lib.tags.get(itemId) || [])].map((tag) => ({ tag })),
    });
    const [action] = await listJournalActions({
      conversationKey: 41,
      pendingOnly: true,
      limit: 1,
    });
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: (itemId: number) => itemOf(itemId),
        removeTagsFromItem: async (input: {
          itemId: number;
          tags: string[];
        }) => {
          const held = lib.tags.get(input.itemId) || new Set<string>();
          const removed = input.tags.filter((tag) => held.delete(tag));
          return { removed };
        },
      } as never,
      context,
    });

    assert.deepEqual(outcome.conflicts, []);
    assert.equal(outcome.reverted, 1);
    assert.equal(db.steps.get(stepId)?.status, "reverted");
    assert.deepEqual(
      [...lib.tags.get(31)!],
      [],
      "the item is back to the pre-state its step recorded",
    );
    for (let itemId = 1; itemId <= 60; itemId += 1)
      assert.lengthOf([...(lib.tags.get(itemId) || [])], 0, `item ${itemId}`);
  });
});
