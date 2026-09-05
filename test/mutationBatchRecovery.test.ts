import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  executeLibraryMutationAction,
  summarizeMutationOutcomes,
} from "../src/agent/services/mutationCoordinator";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { executeAndRecordUndoBatch } from "../src/agent/tools/write/mutateLibraryShared";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { zoteroChangeDispatcher } from "../src/services/zoteroChangeDispatcher";

describe("multi-operation durable mutation recovery", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  async function installJournal() {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    return db;
  }

  const context = {
    request: { conversationKey: 41, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  function inverseFor(itemId: number) {
    return {
      type: "update_metadata" as const,
      itemId,
      metadata: { title: "old" },
    };
  }

  it("keeps an uncertain irreversible step in the parent recovery barrier", function () {
    const summary = summarizeMutationOutcomes([
      {
        effect: "none",
        status: "uncertain",
        reversibility: "none",
        affectedCount: 0,
      },
    ]);

    assert.deepEqual(summary, {
      effect: "none",
      reversibility: "none",
      affectedCount: 0,
    });
  });

  it("reports applied, partial, and zero effects from changed targets", async function () {
    const assignments = [
      { itemId: 1, tags: ["reviewed"] },
      { itemId: 2, tags: ["reviewed"] },
    ];
    for (const [updatedCount, expectedEffect] of [
      [2, "applied"],
      [1, "partial"],
      [0, "none"],
    ] as const) {
      const service = new LibraryMutationService({
        applyTagAssignments: async () => ({
          updatedCount,
          skippedCount: assignments.length - updatedCount,
          items: assignments.map((assignment, index) => ({
            itemId: assignment.itemId,
            status: index < updatedCount ? "updated" : "skipped",
            addedTags: index < updatedCount ? assignment.tags : [],
            skippedTags: index < updatedCount ? [] : assignment.tags,
          })),
        }),
      } as never);

      const execution = await service.executeOperation(
        { type: "apply_tags", assignments },
        context,
      );

      assert.equal(execution.effect, expectedEffect);
      assert.equal(execution.affectedCount, updatedCount);
    }
  });

  it("persists one action and every prepared inverse before the write starts", async function () {
    const db = await installJournal();
    let calls = 0;
    const applyingWitnesses: Array<{ status: unknown; inverse: unknown }> = [];
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${operation.itemId}`,
        inverseOperations: [inverseFor(operation.itemId)],
        precondition: { itemId: operation.itemId, title: "old" },
      }),
      executeOperation: async (operation: { itemId: number }) => {
        calls += 1;
        const step = [...db.steps.values()].find(
          (row) => row.sequence_no === calls,
        );
        applyingWitnesses.push({
          status: step?.status,
          inverse: step?.inverse_json,
        });
        if (calls === 2) throw new Error("second item is invalid");
        return {
          result: {
            operation: "update_metadata",
            result: { status: "updated", itemId: operation.itemId },
          },
          inverse: {
            description: `restore item ${operation.itemId}`,
            inverseOperations: [inverseFor(operation.itemId)],
          },
          effect: "applied" as const,
          affectedCount: 1,
        };
      },
      captureOperationState: async (operation: { itemId: number }) => ({
        version: 1,
        operation: "update_metadata",
        items: [{ itemId: operation.itemId, title: "new" }],
      }),
    };

    let message = "";
    try {
      await executeAndRecordUndoBatch(
        mutationService as never,
        [
          { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        "update_metadata",
      );
      assert.fail("expected the second operation to fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.include(message, "1 prior operation changed the library");
    assert.equal(db.actions.size, 1, "the batch is one user-visible action");
    assert.equal(db.steps.size, 2, "each attempted operation is one step");
    const action = [...db.actions.values()][0];
    assert.equal(action.status, "partially_applied");
    const steps = [...db.steps.values()].sort(
      (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
    );
    assert.deepEqual(
      steps.map((step) => step.status),
      ["applied", "uncertain"],
    );
    assert.deepEqual(
      applyingWitnesses.map((witness) => witness.status),
      ["applying", "applying"],
      "the durable claim precedes every forward call",
    );
    for (const witness of applyingWitnesses) {
      assert.isString(
        witness.inverse,
        "the inverse already exists at claim time",
      );
    }
  });

  it("does not demote an applied multi-operation action because another step was a no-op", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${operation.itemId}`,
        inverseOperations: [inverseFor(operation.itemId)],
      }),
      executeOperation: async (operation: { itemId: number }) => {
        const changed = operation.itemId === 1;
        return {
          result: {
            operation: "update_metadata",
            result: {
              status: changed ? "updated" : "unchanged",
              itemId: operation.itemId,
            },
          },
          inverse: changed
            ? {
                description: `restore item ${operation.itemId}`,
                inverseOperations: [inverseFor(operation.itemId)],
              }
            : undefined,
          effect: changed ? ("applied" as const) : ("none" as const),
          affectedCount: changed ? 1 : 0,
        };
      },
      captureOperationState: async (operation: { itemId: number }) => ({
        version: 1,
        operation: "update_metadata",
        items: [{ itemId: operation.itemId, title: "new" }],
      }),
    };

    const outcome = await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [
        { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
        { type: "update_metadata", itemId: 2, metadata: { title: "old" } },
      ],
      context,
      facadeToolName: "update_metadata",
    });

    assert.equal(outcome.effect, "applied");
    assert.equal(outcome.affectedCount, 1);
    assert.equal([...db.actions.values()][0].status, "applied");
    assert.equal([...db.actions.values()][0].affected_count, 1);
    assert.deepEqual(
      [...db.steps.values()].map((step) => step.status),
      ["applied", "no_effect"],
    );
  });

  it("retains an uncertain first operation's planned irreversible barrier", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "none" as const,
        description: "irreversible external mutation",
        reason: "No declarative inverse exists.",
      }),
      executeOperation: async () => {
        throw new Error("the forward call may have committed");
      },
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    let thrown: unknown;
    try {
      await executeLibraryMutationAction({
        service: mutationService as never,
        operations: [
          { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
        ],
        context,
        facadeToolName: "update_metadata",
      });
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    const action = [...db.actions.values()][0];
    const step = [...db.steps.values()][0];
    assert.equal(action.status, "uncertain");
    assert.equal(action.reversibility, "none");
    assert.equal(step.status, "uncertain");
  });

  it("reconciles a may-have-applied operation from native state before retry", async function () {
    const db = await installJournal();
    let executeCalls = 0;
    const operation = {
      type: "update_metadata" as const,
      itemId: 1,
      metadata: { title: "new" },
    };
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: "update 1",
        inverseOperations: [inverseFor(1)],
        precondition: {
          version: 1 as const,
          operation: "update_metadata" as const,
          items: [{ itemId: 1, exists: true, fields: { title: "old" } }],
        },
      }),
      executeOperation: async () => {
        executeCalls += 1;
        throw new Error("transport ended after Zotero committed");
      },
      captureOperationState: async () => ({
        version: 1 as const,
        operation: "update_metadata" as const,
        items: [{ itemId: 1, exists: true, fields: { title: "new" } }],
      }),
    };

    const outcome = await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [operation],
      context,
      facadeToolName: "update_metadata",
    });

    assert.equal(executeCalls, 1);
    assert.equal(outcome.effect, "none");
    assert.lengthOf(outcome.actionEvidence, 1);
    assert.equal(
      outcome.actionEvidence[0].postState.items?.[0].fields?.title,
      "new",
    );
    assert.equal([...db.actions.values()][0].status, "no_effect");
    assert.equal([...db.steps.values()][0].status, "no_effect");
  });

  it("does not start the next write when its durable step cannot be prepared", async function () {
    const db = await installJournal();
    let calls = 0;
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${operation.itemId}`,
        inverseOperations: [inverseFor(operation.itemId)],
      }),
      executeOperation: async (operation: { itemId: number }) => {
        calls += 1;
        return {
          result: {
            operation: "update_metadata",
            result: { status: "updated", itemId: operation.itemId },
          },
          inverse: {
            description: `restore item ${operation.itemId}`,
            inverseOperations: [inverseFor(operation.itemId)],
          },
          effect: "applied" as const,
          affectedCount: 1,
        };
      },
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };
    db.failWhen = (sql, params) =>
      sql.startsWith("INSERT INTO llm_for_zotero_agent_journal_steps_v2") &&
      params[2] === 2
        ? new Error("database is read-only")
        : null;

    let message = "";
    try {
      await executeAndRecordUndoBatch(
        mutationService as never,
        [
          { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        "update_metadata",
      );
      assert.fail("expected journal failure to stop the batch");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.equal(calls, 1, "no unjournalled second write may start");
    assert.include(message, "database is read-only");
    assert.include(message, "1 prior operation changed the library");
  });

  it("promotes a finalized deferred creation to fully reversible", async function () {
    const db = await installJournal();
    const inverse = {
      type: "delete_collection" as const,
      collectionId: 42,
      permanent: true,
    };
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "partial" as const,
        description: "create collection",
        deferredInverse: true,
        reason: "The collection ID is assigned after commit.",
      }),
      executeOperation: async () => ({
        result: {
          operation: "create_collection",
          result: { status: "created", collectionId: 42 },
        },
        inverse: {
          description: "delete collection 42",
          inverseOperations: [inverse],
        },
        effect: "applied" as const,
        affectedCount: 1,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "create_collection",
        collections: [{ collectionId: 42, exists: true }],
      }),
    };

    await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [{ type: "create_collection", name: "Created" }],
      context,
      facadeToolName: "manage_collections",
    });

    const action = [...db.actions.values()][0];
    const step = [...db.steps.values()][0];
    assert.equal(action.status, "applied");
    assert.equal(action.reversibility, "full");
    assert.equal(step.status, "applied");
    assert.isNull(step.error_text);
  });

  it("does not mistake selection counters for applied effects", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: "attempt metadata updates",
        inverseOperations: [inverseFor(1)],
      }),
      executeOperation: async () => ({
        result: {
          operation: "update_metadata",
          result: {
            selectedCount: 2,
            updatedCount: 0,
            skippedCount: 2,
            items: [
              { itemId: 1, status: "skipped" },
              { itemId: 2, status: "unchanged" },
            ],
          },
        },
        inverse: null,
        effect: "none" as const,
        affectedCount: 0,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    const outcome = await executeAndRecordUndoBatch(
      mutationService as never,
      [{ type: "update_metadata", itemId: 1, metadata: { title: "same" } }],
      context,
      "update_metadata",
    );

    assert.equal(
      outcome.content.appliedCount,
      0,
      "appliedCount reports objects actually changed",
    );
    assert.equal(outcome.effect, "none");
    assert.equal([...db.actions.values()][0].status, "no_effect");
    assert.equal([...db.actions.values()][0].affected_count, 0);
    assert.equal([...db.steps.values()][0].status, "no_effect");
  });

  it("does not report a prior no-op as applied when the next write is uncertain", async function () {
    const db = await installJournal();
    let calls = 0;
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${operation.itemId}`,
        inverseOperations: [inverseFor(operation.itemId)],
      }),
      executeOperation: async (operation: { itemId: number }) => {
        calls += 1;
        if (calls === 2) throw new Error("the second write may have committed");
        return {
          result: {
            operation: "update_metadata",
            result: { status: "unchanged", itemId: operation.itemId },
          },
          inverse: null,
          effect: "none" as const,
          affectedCount: 0,
        };
      },
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    let message = "";
    try {
      await executeLibraryMutationAction({
        service: mutationService as never,
        operations: [
          { type: "update_metadata", itemId: 1, metadata: { title: "same" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        facadeToolName: "update_metadata",
      });
      assert.fail("expected the second operation to be uncertain");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const action = [...db.actions.values()][0];
    assert.equal(action.status, "uncertain");
    assert.equal(action.affected_count, 0);
    assert.equal(action.reversibility, "full");
    assert.include(message, "The current operation may have applied");
    assert.notInclude(message, "operation was applied");
    assert.deepEqual(
      [...db.steps.values()]
        .sort(
          (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
        )
        .map((step) => step.status),
      ["no_effect", "uncertain"],
    );
  });

  it("reports failure when only no-ops precede a pre-write error", async function () {
    const db = await installJournal();
    const preWriteError = new Error("the second operation is invalid");
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => {
        if (operation.itemId === 2) throw preWriteError;
        return {
          effect: "write" as const,
          reversibility: "full" as const,
          description: `update ${operation.itemId}`,
          inverseOperations: [inverseFor(operation.itemId)],
        };
      },
      executeOperation: async (operation: { itemId: number }) => ({
        result: {
          operation: "update_metadata",
          result: { status: "unchanged", itemId: operation.itemId },
        },
        inverse: null,
        effect: "none" as const,
        affectedCount: 0,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    let thrown: unknown;
    try {
      await executeLibraryMutationAction({
        service: mutationService as never,
        operations: [
          { type: "update_metadata", itemId: 1, metadata: { title: "same" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        facadeToolName: "update_metadata",
      });
    } catch (error) {
      thrown = error;
    }

    assert.strictEqual(thrown, preWriteError);
    const action = [...db.actions.values()][0];
    assert.equal(action.status, "failed");
    assert.equal(action.affected_count, 0);
    assert.equal(action.reversibility, "full");
  });

  it("ignores no-op reversibility when a later change is irreversible", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility:
          operation.itemId === 1 ? ("full" as const) : ("none" as const),
        description: `update ${operation.itemId}`,
        inverseOperations:
          operation.itemId === 1 ? [inverseFor(operation.itemId)] : undefined,
        reason:
          operation.itemId === 2 ? "No declarative inverse exists." : undefined,
      }),
      executeOperation: async (operation: { itemId: number }) => ({
        result: {
          operation: "update_metadata",
          result: {
            status: operation.itemId === 1 ? "unchanged" : "updated",
            itemId: operation.itemId,
          },
        },
        inverse: null,
        effect:
          operation.itemId === 1 ? ("none" as const) : ("applied" as const),
        affectedCount: operation.itemId === 1 ? 0 : 1,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    const outcome = await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [
        { type: "update_metadata", itemId: 1, metadata: { title: "same" } },
        { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
      ],
      context,
      facadeToolName: "update_metadata",
    });

    assert.equal(outcome.effect, "applied");
    assert.equal(outcome.affectedCount, 1);
    const action = [...db.actions.values()][0];
    assert.equal(action.status, "irreversible");
    assert.equal(action.reversibility, "none");
    assert.deepEqual(
      [...db.steps.values()]
        .sort(
          (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
        )
        .map((step) => step.status),
      ["no_effect", "irreversible"],
    );
  });

  it("keeps partial effects and affected counts aligned across tool and journal output", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: "update two targets",
        inverseOperations: [inverseFor(1)],
      }),
      executeOperation: async () => ({
        result: {
          operation: "update_metadata",
          result: {
            selectedCount: 2,
            updatedCount: 1,
            skippedCount: 1,
          },
        },
        inverse: {
          description: "restore item 1",
          inverseOperations: [inverseFor(1)],
        },
        effect: "partial" as const,
        affectedCount: 1,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
      }),
    };

    const outcome = await executeAndRecordUndoBatch(
      mutationService as never,
      [{ type: "update_metadata", itemId: 1, metadata: { title: "new" } }],
      context,
      "update_metadata",
    );

    assert.equal(outcome.effect, "partial");
    assert.equal(outcome.content.appliedCount, 1);
    assert.equal([...db.actions.values()][0].status, "partially_applied");
    assert.equal([...db.actions.values()][0].affected_count, 1);
    assert.equal([...db.steps.values()][0].status, "partially_applied");
  });

  it("keeps a committed child-note row in durable history when its ID is unavailable", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "none" as const,
        description: "create a child note",
        reason: "The committed note ID was unavailable for recovery.",
      }),
      executeOperation: async () => ({
        result: {
          operation: "save_notes_batch",
          result: {
            createdCount: 0,
            failedCount: 0,
            notes: [{ targetItemId: 1, status: "created" }],
          },
        },
        inverse: null,
        effect: "applied" as const,
        affectedCount: 1,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "save_notes_batch",
      }),
    };

    await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [
        {
          type: "save_notes_batch",
          notes: [{ targetItemId: 1, content: "Created note" }],
        },
      ],
      context,
      facadeToolName: "note_write",
    });

    const action = [...db.actions.values()][0];
    const step = [...db.steps.values()][0];
    assert.equal(action.status, "irreversible");
    assert.equal(action.affected_count, 1);
    assert.equal(step.status, "irreversible");
  });

  it("records the outer semantic facade instead of its legacy delegate", async function () {
    const db = await installJournal();
    const mutationService = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: "update metadata",
        inverseOperations: [inverseFor(1)],
      }),
      executeOperation: async () => ({
        result: {
          operation: "update_metadata",
          result: { status: "updated", itemId: 1 },
        },
        inverse: {
          description: "restore item 1",
          inverseOperations: [inverseFor(1)],
        },
        effect: "applied" as const,
        affectedCount: 1,
      }),
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
        items: [{ itemId: 1, title: "new" }],
      }),
    };

    await executeLibraryMutationAction({
      service: mutationService as never,
      operations: [
        { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
      ],
      context: { ...context, journalToolName: "library_update" },
      facadeToolName: "update_metadata",
    });

    assert.equal([...db.actions.values()][0].tool_name, "library_update");
  });

  it("serializes cross-conversation write windows and attributes observations", async function () {
    const db = await installJournal();
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let secondStarted = false;
    const makeService = (itemId: number, wait: boolean) => ({
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${itemId}`,
        inverseOperations: [inverseFor(itemId)],
      }),
      executeOperation: async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (wait) {
          signalFirstStarted();
          await firstGate;
        } else {
          secondStarted = true;
        }
        await zoteroChangeDispatcher.dispatch({
          event: "modify",
          type: "item",
          ids: [itemId],
          extraData: { libraryID: 1 },
        });
        activeWrites -= 1;
        return {
          result: {
            operation: "update_metadata",
            result: { status: "updated", itemId },
          },
          inverse: {
            description: `restore ${itemId}`,
            inverseOperations: [inverseFor(itemId)],
          },
          effect: "applied" as const,
          affectedCount: 1,
        };
      },
      captureOperationState: async () => ({
        version: 1,
        operation: "update_metadata",
        items: [{ itemId, exists: true, fields: { title: "new" } }],
      }),
    });

    const first = executeLibraryMutationAction({
      service: makeService(1, true) as never,
      operations: [
        { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
      ],
      context,
      facadeToolName: "update_metadata",
    });
    await firstStarted;
    const second = executeLibraryMutationAction({
      service: makeService(2, false) as never,
      operations: [
        { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
      ],
      context: {
        ...context,
        request: { ...context.request, conversationKey: 42 },
      },
      facadeToolName: "update_metadata",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.isFalse(secondStarted, "the second Zotero write must wait");

    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(maximumActiveWrites, 1);
    assert.isTrue(secondStarted);
    assert.equal(db.observations.size, 2);
    const observed = [...db.observations.values()].map((row) => ({
      actionId: String(row.action_id),
      ids: JSON.parse(String(row.object_ids_json)) as number[],
    }));
    for (const row of observed) {
      const step = [...db.steps.values()].find(
        (candidate) => candidate.action_id === row.actionId,
      );
      const forward = JSON.parse(String(step?.forward_json)) as {
        itemId: number;
      };
      assert.deepEqual(row.ids, [forward.itemId]);
    }
  });

  it("refreshes a queued pre-image after another conversation writes", async function () {
    const db = await installJournal();
    let title = "original";
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondPreparedTitle = "";
    const service = {
      planOperation: async (operation: { itemId: number }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `update ${operation.itemId}`,
        inverseOperations: [
          {
            type: "update_metadata" as const,
            itemId: operation.itemId,
            metadata: { title },
          },
        ],
        precondition: { itemId: operation.itemId, title },
      }),
      executeOperation: async (operation: { itemId: number }) => {
        if (operation.itemId === 1) {
          signalFirstStarted();
          await firstGate;
          title = "first write";
        } else {
          const step = [...db.steps.values()].find((row) => {
            const forward = JSON.parse(String(row.forward_json)) as {
              itemId?: number;
            };
            return forward.itemId === 2;
          });
          const inverse = JSON.parse(String(step?.inverse_json)) as {
            operations?: Array<{ metadata?: { title?: string } }>;
          };
          secondPreparedTitle = inverse.operations?.[0]?.metadata?.title || "";
          title = "second write";
        }
        return {
          result: {
            operation: "update_metadata",
            result: { status: "updated", itemId: operation.itemId },
          },
          inverse: null,
          effect: "applied" as const,
          affectedCount: 1,
        };
      },
      captureOperationState: async (operation: { itemId: number }) => ({
        version: 1,
        operation: "update_metadata",
        items: [{ itemId: operation.itemId, title }],
      }),
    };

    const first = executeLibraryMutationAction({
      service: service as never,
      operations: [
        { type: "update_metadata", itemId: 1, metadata: { title: "first" } },
      ],
      context,
      facadeToolName: "update_metadata",
    });
    await firstStarted;
    const second = executeLibraryMutationAction({
      service: service as never,
      operations: [
        { type: "update_metadata", itemId: 2, metadata: { title: "second" } },
      ],
      context: {
        ...context,
        request: { ...context.request, conversationKey: 42 },
      },
      facadeToolName: "update_metadata",
    });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(
      secondPreparedTitle,
      "first write",
      "the queued inverse must describe the state immediately before its write",
    );
  });
});
