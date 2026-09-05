import { assert } from "chai";
import { revertActions } from "../src/agent/services/changeReverter";
import { executeExternalMutation } from "../src/agent/services/mutationCoordinator";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { withActiveJournalAction } from "../src/agent/services/mutationCoordinator";
import {
  clearAgentChangeJournal,
  compactRevertedJournalAction,
  deleteConversationJournal,
  initAgentChangeJournal,
  JOURNAL_BLOB_CLEANUP_TABLE,
  JOURNAL_STEPS_TABLE,
  listJournalActions,
  prepareJournalAction,
  prepareJournalStep,
  queueJournalRecoveryBlobCleanupInTransaction,
  registerJournalRecoveryPayloads,
  updateJournalAction,
  updateJournalStep,
} from "../src/agent/store/changeJournal";
import { createUndoLastActionTool } from "../src/agent/tools/write/undoLastAction";
import { createRevertChangesTool } from "../src/agent/tools/write/revertChanges";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

describe("durable change journal v2", function () {
  const originalZotero = globalThis.Zotero;
  const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;
  const originalPathUtils = (globalThis as { PathUtils?: unknown }).PathUtils;
  let db: ChangeJournalTestDb;

  const context = {
    request: { conversationKey: 77, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  async function install(database = new ChangeJournalTestDb()) {
    db = database;
    globalThis.Zotero = {
      DB: db,
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    return db;
  }

  beforeEach(async function () {
    await install();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
    (globalThis as { IOUtils?: unknown }).IOUtils = originalIOUtils;
    (globalThis as { PathUtils?: unknown }).PathUtils = originalPathUtils;
  });

  async function prepareAction(params: {
    id: string;
    createdAt: number;
    reversibility?: "full" | "partial" | "none";
    recovery?: string;
    inverse?: unknown;
    status?: "applied" | "irreversible" | "revert_failed";
    description?: string;
    operation?: string;
    forward?: unknown;
    precondition?: unknown;
    expectedPostcondition?: unknown;
    result?: unknown;
  }) {
    const reversibility = params.reversibility || "full";
    await prepareJournalAction({
      actionId: params.id,
      runId: "run-77",
      conversationKey: 77,
      toolName: "test_mutation",
      description: params.description || params.id,
      effect: "write",
      reversibility,
      recovery:
        params.recovery ||
        (reversibility === "none" ? "This action has no inverse" : undefined),
      now: params.createdAt,
    });
    await prepareJournalStep({
      stepId: `${params.id}:1`,
      actionId: params.id,
      sequence: 1,
      operation: params.operation || "remove_from_collection",
      forward: params.forward || {},
      inverse: params.inverse,
      precondition: params.precondition,
      reversibility,
      status: reversibility === "none" ? "irreversible" : "prepared",
      now: params.createdAt,
    });
    const status =
      params.status || (reversibility === "none" ? "irreversible" : "applied");
    await updateJournalStep({
      stepId: `${params.id}:1`,
      status,
      reversibility,
      expectedPostcondition: params.expectedPostcondition,
      result: params.result,
      now: params.createdAt,
    });
    await updateJournalAction({
      actionId: params.id,
      status,
      reversibility,
      affectedCount: 1,
      now: params.createdAt,
    });
  }

  it("migrates v1 rows idempotently without deleting the legacy table data", async function () {
    const legacyDb = new ChangeJournalTestDb();
    legacyDb.addLegacyRow({
      entry_id: "legacy-action",
      run_id: "legacy-run",
      conversation_key: 77,
      operation: "move_to_collection",
      description: "Filed a paper",
      item_count: 1,
      inverse_json: JSON.stringify([
        {
          type: "remove_from_collection",
          itemIds: [4],
          collectionId: 9,
        },
      ]),
      irreversible_reason: null,
      status: "reversible",
      created_at: 1234,
    });

    await install(legacyDb);
    await initAgentChangeJournal();

    assert.equal(legacyDb.legacyRows.size, 1);
    assert.equal(legacyDb.actions.size, 1);
    assert.equal(legacyDb.steps.size, 1);
    assert.equal(legacyDb.actions.get("legacy-action")?.status, "applied");
    assert.equal(
      legacyDb.actions.get("legacy-action")?.reversibility,
      "partial",
    );
    assert.equal(legacyDb.steps.get("legacy-action:1")?.status, "applied");
  });

  it("keeps migrated v1 inverses visible but refuses unguarded replay", async function () {
    const legacyDb = new ChangeJournalTestDb();
    legacyDb.addLegacyRow({
      entry_id: "unguarded-legacy-action",
      run_id: "legacy-run",
      conversation_key: 77,
      operation: "move_to_collection",
      description: "Filed a paper",
      item_count: 1,
      inverse_json: JSON.stringify([
        {
          type: "remove_from_collection",
          itemIds: [4],
          collectionId: 9,
        },
      ]),
      irreversible_reason: null,
      status: "reversible",
      created_at: 1234,
    });
    await install(legacyDb);
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const removed: number[] = [];

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        removeItemFromCollection: async ({ itemId }: { itemId: number }) => {
          removed.push(itemId);
          return { removed: true };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.include(outcome.conflicts[0].reason, "no expected post-image");
    assert.deepEqual(removed, []);
  });

  it("deletes legacy rows with a conversation so they cannot remigrate", async function () {
    const legacyDb = new ChangeJournalTestDb();
    legacyDb.addLegacyRow({
      entry_id: "deleted-legacy-action",
      run_id: "legacy-run",
      conversation_key: 77,
      operation: "move_to_collection",
      description: "Filed a paper",
      item_count: 1,
      inverse_json: "[]",
      irreversible_reason: null,
      status: "reversible",
      created_at: 1234,
    });
    legacyDb.addLegacyRow({
      entry_id: "retained-legacy-action",
      run_id: "other-run",
      conversation_key: 88,
      operation: "move_to_collection",
      description: "Filed another paper",
      item_count: 1,
      inverse_json: "[]",
      irreversible_reason: null,
      status: "reversible",
      created_at: 1235,
    });

    await install(legacyDb);
    await deleteConversationJournal(77);
    await initAgentChangeJournal();

    assert.isFalse(legacyDb.legacyRows.has("deleted-legacy-action"));
    assert.isFalse(legacyDb.actions.has("deleted-legacy-action"));
    assert.isFalse(legacyDb.steps.has("deleted-legacy-action:1"));
    assert.isTrue(legacyDb.legacyRows.has("retained-legacy-action"));
    assert.isTrue(legacyDb.actions.has("retained-legacy-action"));
  });

  it("clears legacy rows with the v2 journal so they cannot remigrate", async function () {
    const legacyDb = new ChangeJournalTestDb();
    legacyDb.addLegacyRow({
      entry_id: "legacy-action",
      run_id: "legacy-run",
      conversation_key: 77,
      operation: "move_to_collection",
      description: "Filed a paper",
      item_count: 1,
      inverse_json: "[]",
      irreversible_reason: null,
      status: "reversible",
      created_at: 1234,
    });

    await install(legacyDb);
    await clearAgentChangeJournal();
    await initAgentChangeJournal();

    assert.equal(legacyDb.legacyRows.size, 0);
    assert.equal(legacyDb.actions.size, 0);
    assert.equal(legacyDb.steps.size, 0);
  });

  it("sweeps crash-orphaned recovery blobs while retaining referenced blobs", async function () {
    const directory = "/profile/llm-for-zotero/journal-recovery";
    const referenced = `${directory}/payload-referenced.bin`;
    const orphaned = `${directory}/payload-orphaned.bin`;
    db.payloads.set("payload-row", {
      payload_id: "payload-row",
      action_id: "action",
      storage_kind: "blob",
      blob_path: referenced,
    });
    const removed: string[] = [];
    (globalThis as { PathUtils?: unknown }).PathUtils = {
      profileDir: "/profile",
      join: (...parts: string[]) => parts.join("/"),
    };
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
      getChildren: async () => [referenced, orphaned],
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    await initAgentChangeJournal();

    assert.deepEqual(removed, [orphaned]);
  });

  it("queues every blob for conversation-scoped cleanup in the SQL test adapter", async function () {
    await prepareAction({
      id: "conversation-cleanup-payload",
      createdAt: 90,
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/changed.txt",
        payload: {
          storage: "blob",
          blobPath: "/tmp/conversation-recovery.bin",
          checksum: "abc",
          sizeBytes: 10,
        },
      },
    });
    await registerJournalRecoveryPayloads({
      actionId: "conversation-cleanup-payload",
      stepId: "conversation-cleanup-payload:1",
      value: JSON.parse(
        String(db.steps.get("conversation-cleanup-payload:1")?.inverse_json),
      ),
    });

    await db.executeTransaction(() =>
      queueJournalRecoveryBlobCleanupInTransaction(77),
    );

    assert.equal(db.cleanup.size, 1);
    assert.equal(
      [...db.cleanup.values()][0]?.blob_path,
      "/tmp/conversation-recovery.bin",
    );
  });

  it("rolls back cleanup intent and payload scrubbing when compaction fails", async function () {
    await prepareAction({
      id: "failed-compaction",
      createdAt: 95,
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/changed.txt",
        payload: {
          storage: "blob",
          blobPath: "/tmp/failed-compaction.bin",
          checksum: "abc",
          sizeBytes: 10,
        },
      },
    });
    await registerJournalRecoveryPayloads({
      actionId: "failed-compaction",
      stepId: "failed-compaction:1",
      value: JSON.parse(
        String(db.steps.get("failed-compaction:1")?.inverse_json),
      ),
    });
    await updateJournalAction({
      actionId: "failed-compaction",
      status: "reverted",
    });
    const inverseBefore = db.steps.get("failed-compaction:1")?.inverse_json;
    db.failWhen = (sql) =>
      sql.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      sql.includes("SET forward_json = '{}'")
        ? new Error("step scrub failed")
        : null;

    let errorMessage = "";
    try {
      await compactRevertedJournalAction("failed-compaction");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    assert.include(errorMessage, "step scrub failed");
    assert.equal(db.cleanup.size, 0);
    assert.equal(db.payloads.size, 1);
    assert.equal(
      db.steps.get("failed-compaction:1")?.inverse_json,
      inverseBefore,
    );
  });

  it("compacts reverted payloads while retaining lightweight history", async function () {
    const removed: string[] = [];
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      remove: async (path: string) => {
        removed.push(path);
      },
    };
    await prepareAction({
      id: "compact-reverted",
      createdAt: 100,
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/changed.txt",
        payload: {
          storage: "blob",
          blobPath: "/tmp/recovery.bin",
          checksum: "abc",
          sizeBytes: 10,
        },
      },
      expectedPostcondition: {
        kind: "file",
        path: "/tmp/changed.txt",
        exists: true,
        checksum: "def",
      },
      result: { changed: true },
    });
    await registerJournalRecoveryPayloads({
      actionId: "compact-reverted",
      stepId: "compact-reverted:1",
      value: JSON.parse(
        String(db.steps.get("compact-reverted:1")?.inverse_json),
      ),
    });
    await updateJournalStep({
      stepId: "compact-reverted:1",
      status: "reverted",
    });
    await updateJournalAction({
      actionId: "compact-reverted",
      status: "reverted",
    });

    assert.isTrue(await compactRevertedJournalAction("compact-reverted"));
    const [history] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });

    assert.equal(history.status, "reverted");
    assert.equal(history.description, "compact-reverted");
    assert.equal(history.steps[0].operation, "remove_from_collection");
    assert.equal(history.steps[0].forwardJson, "{}");
    assert.isUndefined(history.steps[0].inverseJson);
    assert.equal(db.payloads.size, 0);
    assert.equal(db.cleanup.size, 0);
    assert.deepEqual(removed, ["/tmp/recovery.bin"]);
  });

  it("reports partial undo residuals instead of claiming a full revert", async function () {
    const key = "export.quickCopy.setting";
    let value: unknown = "After";
    await prepareAction({
      id: "partial-undo-report",
      createdAt: 150,
      reversibility: "partial",
      recovery:
        "A side effect outside the recorded preference inverse may remain.",
      operation: "update_preference",
      inverse: {
        version: 1,
        kind: "preference",
        key,
        existed: true,
        value: "Before",
      },
      expectedPostcondition: {
        kind: "preference",
        key,
        existed: true,
        value: "After",
      },
    });
    const gateway = {
      listSettings: () => [
        { key, value, type: "string", description: "Quick Copy" },
      ],
      restoreSetting: (input: { existed: boolean; value?: unknown }) => {
        value = input.existed ? input.value : undefined;
      },
    } as never;
    const tool = createUndoLastActionTool(gateway);

    const execution = await tool.execute!({}, context);
    const result = execution.content as {
      status: string;
      reverted: number;
      partiallyReverted: number;
      residuals: Array<{ actionId: string; reason: string }>;
    };

    assert.equal(execution.effect, "partial");
    assert.equal(value, "Before");
    assert.equal(result.status, "partially_undone");
    assert.equal(result.reverted, 0);
    assert.equal(result.partiallyReverted, 1);
    assert.deepInclude(result.residuals[0], {
      actionId: "partial-undo-report",
      reason:
        "A side effect outside the recorded preference inverse may remain.",
    });
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess === "function") {
      assert.include(
        onSuccess({ label: "Undo Last Action", content: result }) || "",
        "Partially undone",
      );
    }
    assert.equal(db.actions.get("partial-undo-report")?.status, "reverted");
    assert.isNull(db.steps.get("partial-undo-report:1")?.inverse_json);
  });

  it("finishes mixed actions while reporting irreversible steps as residuals", async function () {
    const actionId = "mixed-partial-action";
    const key = "export.quickCopy.setting";
    let value: unknown = "After";
    await prepareJournalAction({
      actionId,
      runId: "run-77",
      conversationKey: 77,
      toolName: "mixed_mutation",
      description: "Mixed reversible and irreversible mutation",
      effect: "write",
      reversibility: "partial",
      recovery: "Only the recorded subset can be restored.",
      now: 160,
    });
    await prepareJournalStep({
      stepId: `${actionId}:1`,
      actionId,
      sequence: 1,
      operation: "update_preference",
      forward: { key, value: "After" },
      inverse: {
        version: 1,
        kind: "preference",
        key,
        existed: true,
        value: "Before",
      },
      now: 160,
    });
    await updateJournalStep({
      stepId: `${actionId}:1`,
      status: "applied",
      expectedPostcondition: {
        kind: "preference",
        key,
        existed: true,
        value: "After",
      },
      now: 160,
    });
    await prepareJournalStep({
      stepId: `${actionId}:2`,
      actionId,
      sequence: 2,
      operation: "irreversible_external_effect",
      forward: {},
      status: "irreversible",
      error: "The external side effect cannot be restored.",
      now: 160,
    });
    await prepareJournalStep({
      stepId: `${actionId}:3`,
      actionId,
      sequence: 3,
      operation: "never_started",
      forward: {},
      now: 160,
    });
    await updateJournalStep({
      stepId: `${actionId}:3`,
      status: "failed",
      error: "Interrupted before the write started",
      now: 160,
    });
    await updateJournalAction({
      actionId,
      status: "partially_applied",
      reversibility: "partial",
      affectedCount: 2,
      now: 160,
    });
    const gateway = {
      listSettings: () => [
        { key, value, type: "string", description: "Quick Copy" },
      ],
      restoreSetting: (input: { existed: boolean; value?: unknown }) => {
        value = input.existed ? input.value : undefined;
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(value, "Before");
    assert.equal(outcome.reverted, 0);
    assert.equal(outcome.partiallyReverted, 1);
    assert.include(outcome.residuals[0]?.reason || "", "recorded subset");
    assert.include(outcome.residuals[0]?.reason || "", "external side effect");
    assert.deepEqual(outcome.skipped, []);
    assert.equal(db.actions.get(actionId)?.status, "reverted");
    assert.equal(db.steps.get(`${actionId}:1`)?.status, "reverted");
    assert.equal(db.steps.get(`${actionId}:2`)?.status, "irreversible");
    assert.equal(db.steps.get(`${actionId}:3`)?.status, "failed");
    assert.isNull(db.steps.get(`${actionId}:1`)?.inverse_json);
  });

  it("keeps inverses retryable when atomic revert finalization fails", async function () {
    const actionId = "atomic-finalization-retry";
    const key = "export.quickCopy.setting";
    let value: unknown = "After";
    await prepareAction({
      id: actionId,
      createdAt: 170,
      operation: "update_preference",
      inverse: {
        version: 1,
        kind: "preference",
        key,
        existed: true,
        value: "Before",
      },
      expectedPostcondition: {
        kind: "preference",
        key,
        existed: true,
        value: "After",
      },
    });
    const gateway = {
      listSettings: () => [
        { key, value, type: "string", description: "Quick Copy" },
      ],
      restoreSetting: (input: { existed: boolean; value?: unknown }) => {
        value = input.existed ? input.value : undefined;
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    db.failWhen = (sql) =>
      sql.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
      sql.includes("SET forward_json = '{}'")
        ? new Error("atomic scrub failed")
        : null;

    const first = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(value, "Before");
    assert.equal(first.reverted, 0);
    assert.include(first.skipped[0]?.reason || "", "atomic scrub failed");
    assert.equal(db.actions.get(actionId)?.status, "revert_failed");
    assert.equal(db.steps.get(`${actionId}:1`)?.status, "reverted");
    assert.isNotNull(db.steps.get(`${actionId}:1`)?.inverse_json);

    db.failWhen = undefined;
    const [retryable] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const retry = await revertActions({
      actions: [retryable],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(retry.reverted, 1);
    assert.deepEqual(retry.skipped, []);
    assert.equal(db.actions.get(actionId)?.status, "reverted");
    assert.isNull(db.steps.get(`${actionId}:1`)?.inverse_json);
  });

  it("does not reopen a committed undo when the post-commit cleanup sweep fails", async function () {
    const actionId = "post-commit-sweep-failure";
    const key = "export.quickCopy.setting";
    let value: unknown = "After";
    await prepareAction({
      id: actionId,
      createdAt: 180,
      operation: "update_preference",
      inverse: {
        version: 1,
        kind: "preference",
        key,
        existed: true,
        value: "Before",
      },
      expectedPostcondition: {
        kind: "preference",
        key,
        existed: true,
        value: "After",
      },
    });
    const gateway = {
      listSettings: () => [
        { key, value, type: "string", description: "Quick Copy" },
      ],
      restoreSetting: (input: { existed: boolean; value?: unknown }) => {
        value = input.existed ? input.value : undefined;
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    db.failWhen = (sql) =>
      sql.startsWith(
        `SELECT cleanup_id, blob_path FROM ${JOURNAL_BLOB_CLEANUP_TABLE}`,
      )
        ? new Error("cleanup sweep unavailable")
        : null;

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(value, "Before");
    assert.equal(outcome.reverted, 1);
    assert.deepEqual(outcome.skipped, []);
    assert.equal(db.actions.get(actionId)?.status, "reverted");
    assert.isNull(db.steps.get(`${actionId}:1`)?.inverse_json);
  });

  it("reconciles prepared, applying, and partially completed crash windows", async function () {
    for (const id of [
      "uncertain",
      "partial",
      "not-started",
      "interrupted-revert",
    ]) {
      await prepareJournalAction({
        actionId: id,
        runId: "run-77",
        conversationKey: 77,
        toolName: "test_mutation",
        description: id,
        effect: "write",
        reversibility: "full",
        now: 100,
      });
      await prepareJournalStep({
        stepId: `${id}:1`,
        actionId: id,
        sequence: 1,
        operation: "update_metadata",
        forward: { type: "update_metadata", itemId: 1 },
        inverse: {
          version: 1,
          kind: "library_operations",
          operations: [],
        },
        now: 100,
      });
    }
    db.actions.get("uncertain")!.status = "applying";
    db.steps.get("uncertain:1")!.status = "applying";
    db.actions.get("partial")!.status = "applying";
    db.steps.get("partial:1")!.status = "applied";
    db.actions.get("interrupted-revert")!.status = "reverting";
    db.steps.get("interrupted-revert:1")!.status = "reverting";

    await initAgentChangeJournal();

    assert.equal(db.actions.get("uncertain")?.status, "uncertain");
    assert.equal(db.steps.get("uncertain:1")?.status, "uncertain");
    assert.equal(db.actions.get("partial")?.status, "partially_applied");
    assert.equal(db.steps.get("partial:1")?.status, "applied");
    assert.equal(db.actions.get("not-started")?.status, "failed");
    assert.equal(db.steps.get("not-started:1")?.status, "failed");
    assert.equal(db.actions.get("interrupted-revert")?.status, "revert_failed");
    assert.equal(db.steps.get("interrupted-revert:1")?.status, "revert_failed");
    assert.include(
      String(db.actions.get("interrupted-revert")?.recovery_text || ""),
      "stopped during undo",
    );
  });

  it("recomputes restart reversibility from actual effects and closes no-effect actions", async function () {
    const mixedActionId = "restart-actual-effects";
    const key = "export.quickCopy.setting";
    let value: unknown = "After";
    await prepareJournalAction({
      actionId: mixedActionId,
      runId: "run-77",
      conversationKey: 77,
      toolName: "mixed_restart",
      description: "One completed write and one unstarted irreversible plan",
      effect: "write",
      reversibility: "partial",
      recovery: "The planned second step would have been irreversible.",
      now: 190,
    });
    await prepareJournalStep({
      stepId: `${mixedActionId}:1`,
      actionId: mixedActionId,
      sequence: 1,
      operation: "update_preference",
      forward: { key, value: "After" },
      inverse: {
        version: 1,
        kind: "preference",
        key,
        existed: true,
        value: "Before",
      },
      reversibility: "full",
      now: 190,
    });
    await updateJournalStep({
      stepId: `${mixedActionId}:1`,
      status: "applied",
      reversibility: "full",
      expectedPostcondition: {
        kind: "preference",
        key,
        existed: true,
        value: "After",
      },
      now: 190,
    });
    await prepareJournalStep({
      stepId: `${mixedActionId}:2`,
      actionId: mixedActionId,
      sequence: 2,
      operation: "planned_irreversible_step",
      forward: {},
      reversibility: "none",
      error: "This plan never started.",
      now: 190,
    });
    db.actions.get(mixedActionId)!.status = "applying";

    const noEffectActionId = "restart-no-effect";
    await prepareJournalAction({
      actionId: noEffectActionId,
      runId: "run-77",
      conversationKey: 77,
      toolName: "no_effect_restart",
      description: "A planned irreversible operation that changed nothing",
      effect: "write",
      reversibility: "none",
      recovery: "The plan was irreversible if it changed anything.",
      now: 200,
    });
    await prepareJournalStep({
      stepId: `${noEffectActionId}:1`,
      actionId: noEffectActionId,
      sequence: 1,
      operation: "no_effect_operation",
      forward: {},
      reversibility: "none",
      now: 200,
    });
    await updateJournalStep({
      stepId: `${noEffectActionId}:1`,
      status: "no_effect",
      reversibility: "full",
      now: 200,
    });
    db.actions.get(noEffectActionId)!.status = "applying";

    await initAgentChangeJournal();

    assert.equal(db.actions.get(mixedActionId)?.status, "partially_applied");
    assert.equal(db.actions.get(mixedActionId)?.reversibility, "full");
    assert.isNull(db.actions.get(mixedActionId)?.recovery_text);
    assert.equal(db.steps.get(`${mixedActionId}:2`)?.status, "failed");
    assert.equal(db.actions.get(noEffectActionId)?.status, "no_effect");
    assert.equal(db.actions.get(noEffectActionId)?.reversibility, "full");

    const pending = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 10,
    });
    assert.deepEqual(
      pending.map((action) => action.actionId),
      [mixedActionId],
    );
    const gateway = {
      listSettings: () => [
        { key, value, type: "string", description: "Quick Copy" },
      ],
      restoreSetting: (input: { existed: boolean; value?: unknown }) => {
        value = input.existed ? input.value : undefined;
      },
    } as never;

    const outcome = await revertActions({
      actions: pending,
      zoteroGateway: gateway,
      context,
    });

    assert.equal(value, "Before");
    assert.equal(outcome.reverted, 1);
    assert.equal(outcome.partiallyReverted, 0);
    assert.deepEqual(outcome.residuals, []);
  });

  it("retires recovery blobs when restart proves the write never began", async function () {
    const actionId = "failed-before-claim-blob";
    const recoveryPath = "/tmp/failed-before-claim.bin";
    const removed: string[] = [];
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      remove: async (path: string) => {
        removed.push(path);
      },
    };
    await prepareJournalAction({
      actionId,
      runId: "run-77",
      conversationKey: 77,
      toolName: "file_io",
      description: "Overwrite a large file",
      effect: "write",
      reversibility: "full",
      now: 210,
    });
    await prepareJournalStep({
      stepId: `${actionId}:1`,
      actionId,
      sequence: 1,
      operation: "write_file",
      forward: { path: "/tmp/large.txt" },
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/large.txt",
        payload: {
          storage: "blob",
          blobPath: recoveryPath,
          checksum: "abc",
          sizeBytes: 100_000,
        },
      },
      reversibility: "full",
      now: 210,
    });
    await registerJournalRecoveryPayloads({
      actionId,
      stepId: `${actionId}:1`,
      value: JSON.parse(String(db.steps.get(`${actionId}:1`)?.inverse_json)),
    });
    db.actions.get(actionId)!.status = "applying";

    await initAgentChangeJournal();

    assert.equal(db.actions.get(actionId)?.status, "failed");
    assert.equal(db.steps.get(`${actionId}:1`)?.status, "failed");
    assert.isNull(db.steps.get(`${actionId}:1`)?.inverse_json);
    assert.equal(db.payloads.size, 0);
    assert.equal(db.cleanup.size, 0);
    assert.deepEqual(removed, [recoveryPath]);
  });

  it("keeps a failed revert visible and permits a later safe retry", async function () {
    await prepareAction({
      id: "retryable",
      createdAt: 200,
      operation: "move_to_collection",
      forward: {
        type: "move_to_collection",
        itemIds: [4],
        targetCollectionId: 9,
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "move_to_collection",
        items: [
          {
            itemId: 4,
            exists: true,
            parentItemId: null,
            deleted: false,
            collectionIds: [9],
          },
        ],
      },
    });
    let fail = true;
    const removed: number[] = [];
    let collections = [9];
    const gateway = {
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getCollections: () => collections,
      }),
      removeItemFromCollection: async ({ itemId }: { itemId: number }) => {
        if (fail) throw new Error("temporary Zotero failure");
        removed.push(itemId);
        collections = [];
        return { removed: true };
      },
    } as never;

    const [firstAction] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const failed = await revertActions({
      actions: [firstAction],
      zoteroGateway: gateway,
      context,
    });
    const [retryable] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    assert.equal(failed.reverted, 0);
    assert.equal(retryable.actionId, "retryable");
    assert.equal(retryable.status, "revert_failed");
    assert.equal(retryable.steps[0].status, "revert_failed");

    fail = false;
    const retried = await revertActions({
      actions: [retryable],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(retried.reverted, 1);
    assert.deepEqual(removed, [4]);
    assert.equal(db.actions.get("retryable")?.status, "reverted");
  });

  it("fails loudly on a per-target inverse error and checkpoints only the remaining target", async function () {
    const tags = new Map<number, string[]>([
      [1, ["After"]],
      [2, ["After"]],
    ]);
    await prepareAction({
      id: "partial-tag-inverse",
      createdAt: 250,
      operation: "set_item_tags",
      forward: {
        type: "set_item_tags",
        assignments: [
          { itemId: 1, tags: ["After"] },
          { itemId: 2, tags: ["After"] },
        ],
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "set_item_tags",
            assignments: [
              { itemId: 1, tags: ["Before"] },
              { itemId: 2, tags: ["Before"] },
            ],
          },
        ],
      },
      precondition: {
        version: 1,
        operation: "set_item_tags",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["Before"],
          },
          {
            itemId: 2,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["Before"],
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "set_item_tags",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["After"],
          },
          {
            itemId: 2,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["After"],
          },
        ],
      },
    });
    let failSecond = true;
    const gateway = {
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getTags: () => (tags.get(itemId) || []).map((tag) => ({ tag })),
      }),
      setItemTags: async ({
        assignments,
      }: {
        assignments: Array<{ itemId: number; tags: string[] }>;
      }) => {
        const assignment = assignments[0];
        if (assignment.itemId === 2 && failSecond) {
          return {
            changedCount: 0,
            items: [
              {
                itemId: 2,
                title: "Two",
                status: "error",
                reason: "item is locked",
              },
            ],
          };
        }
        const previousTags = tags.get(assignment.itemId) || [];
        tags.set(assignment.itemId, [...assignment.tags]);
        return {
          changedCount: 1,
          items: [
            {
              itemId: assignment.itemId,
              title: String(assignment.itemId),
              status: "updated",
              previousTags,
            },
          ],
        };
      },
    } as never;

    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const first = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(first.reverted, 0);
    assert.deepEqual(tags.get(1), ["Before"]);
    assert.deepEqual(tags.get(2), ["After"]);
    const remaining = JSON.parse(
      String(db.steps.get("partial-tag-inverse:1")?.inverse_json),
    ) as { operations: Array<{ assignments: Array<{ itemId: number }> }> };
    assert.deepEqual(
      remaining.operations.map((operation) => operation.assignments[0].itemId),
      [2],
    );
    assert.equal(
      db.steps.get("partial-tag-inverse:1")?.status,
      "revert_failed",
    );
    assert.include(first.skipped[0].reason, "item is locked");

    failSecond = false;
    const [retryable] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const retry = await revertActions({
      actions: [retryable],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(retry.reverted, 1);
    assert.deepEqual(tags.get(2), ["Before"]);
    assert.equal(db.actions.get("partial-tag-inverse")?.status, "reverted");
  });

  it("resumes a crash-interrupted bulk inverse when one target is already restored", async function () {
    const tags = new Map<number, string[]>([
      [1, ["Before"]],
      [2, ["After"]],
    ]);
    await prepareAction({
      id: "crashed-tag-inverse",
      createdAt: 260,
      status: "revert_failed",
      operation: "set_item_tags",
      forward: {
        type: "set_item_tags",
        assignments: [
          { itemId: 1, tags: ["After"] },
          { itemId: 2, tags: ["After"] },
        ],
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "set_item_tags",
            assignments: [
              { itemId: 1, tags: ["Before"] },
              { itemId: 2, tags: ["Before"] },
            ],
          },
        ],
      },
      precondition: {
        version: 1,
        operation: "set_item_tags",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["Before"],
          },
          {
            itemId: 2,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["Before"],
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "set_item_tags",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["After"],
          },
          {
            itemId: 2,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: ["After"],
          },
        ],
      },
    });
    const writes: number[] = [];
    const gateway = {
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getTags: () => (tags.get(itemId) || []).map((tag) => ({ tag })),
      }),
      setItemTags: async ({
        assignments,
      }: {
        assignments: Array<{ itemId: number; tags: string[] }>;
      }) => {
        const assignment = assignments[0];
        writes.push(assignment.itemId);
        const previousTags = tags.get(assignment.itemId) || [];
        tags.set(assignment.itemId, [...assignment.tags]);
        return {
          changedCount: 1,
          items: [
            {
              itemId: assignment.itemId,
              title: String(assignment.itemId),
              status: "updated",
              previousTags,
            },
          ],
        };
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.deepEqual(
      writes,
      [2],
      "the already-restored target is not replayed",
    );
    assert.deepEqual(tags.get(1), ["Before"]);
    assert.deepEqual(tags.get(2), ["Before"]);
    assert.equal(db.actions.get("crashed-tag-inverse")?.status, "reverted");
  });

  it("checkpoints and resumes targets inside a script-declared library inverse", async function () {
    const tags = new Map<number, string[]>([
      [1, ["Agent"]],
      [2, ["Agent"]],
    ]);
    const declaredOperation = {
      type: "set_item_tags" as const,
      assignments: [
        { itemId: 1, tags: ["Before"] },
        { itemId: 2, tags: ["Before"] },
      ],
    };
    const postItems = [1, 2].map((itemId) => ({
      itemId,
      exists: true,
      parentID: null,
      deleted: false,
      tags: [{ tag: "Agent" }],
      collectionIds: [],
    }));
    await prepareAction({
      id: "script-declared-tag-inverse",
      createdAt: 275,
      operation: "zotero_script",
      forward: { mode: "write", script: "declared tag inverse" },
      inverse: {
        version: 1,
        kind: "script_snapshots",
        snapshots: [],
        createdItemIds: [],
        declaredInverses: [
          {
            version: 1,
            kind: "library_operations",
            operations: [declaredOperation],
          },
        ],
      },
      expectedPostcondition: {
        kind: "script_effects",
        items: postItems,
        declared: [
          {
            kind: "library_operation",
            operation: declaredOperation,
            state: {
              version: 1,
              operation: "set_item_tags",
              items: [1, 2].map((itemId) => ({
                itemId,
                exists: true,
                parentItemId: null,
                deleted: false,
                tags: ["Agent"],
              })),
            },
          },
        ],
      },
    });
    let failSecond = true;
    const writes: number[] = [];
    const gateway = {
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getTags: () => (tags.get(itemId) || []).map((tag) => ({ tag })),
        getCollections: () => [],
      }),
      setItemTags: async ({
        assignments,
      }: {
        assignments: Array<{ itemId: number; tags: string[] }>;
      }) => {
        const assignment = assignments[0];
        writes.push(assignment.itemId);
        if (assignment.itemId === 2 && failSecond) {
          return {
            changedCount: 0,
            items: [
              {
                itemId: 2,
                title: "Two",
                status: "error",
                reason: "item is locked",
              },
            ],
          };
        }
        const previousTags = tags.get(assignment.itemId) || [];
        tags.set(assignment.itemId, [...assignment.tags]);
        return {
          changedCount: 1,
          items: [
            {
              itemId: assignment.itemId,
              title: String(assignment.itemId),
              status: "updated",
              previousTags,
            },
          ],
        };
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const first = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(first.reverted, 0);
    assert.deepEqual(tags.get(1), ["Before"]);
    assert.deepEqual(tags.get(2), ["Agent"]);
    const checkpoint = JSON.parse(
      String(db.steps.get("script-declared-tag-inverse:1")?.inverse_json),
    ) as {
      progress?: {
        phase?: string;
        declarationIndex?: number;
        unitIndex?: number;
      };
    };
    assert.deepEqual(checkpoint.progress, {
      version: 1,
      plannerVersion: 1,
      phase: "declared",
      declarationIndex: 0,
      unitIndex: 1,
    });

    // Also simulate the narrow crash window after target 1 committed but
    // before its cursor advance reached SQLite. A guarded retry must recognize
    // the inverse state and advance without writing target 1 a second time.
    checkpoint.progress = {
      version: 1,
      plannerVersion: 1,
      phase: "declared",
      declarationIndex: 0,
      unitIndex: 0,
    };
    db.steps.get("script-declared-tag-inverse:1")!.inverse_json =
      JSON.stringify(checkpoint);

    failSecond = false;
    const [retryable] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const retry = await revertActions({
      actions: [retryable],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(retry.reverted, 1);
    assert.deepEqual(writes, [1, 2, 2]);
    assert.deepEqual(tags.get(1), ["Before"]);
    assert.deepEqual(tags.get(2), ["Before"]);
    assert.equal(
      db.steps.get("script-declared-tag-inverse:1")?.status,
      "reverted",
    );
  });

  it("offers the newest reversible action while disclosing newer irreversible entries", async function () {
    await prepareAction({
      id: "older-reversible",
      createdAt: 100,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "remove_from_collection",
        items: [
          {
            itemId: 4,
            exists: true,
            parentItemId: null,
            deleted: false,
            collectionIds: [9],
          },
        ],
      },
    });
    await prepareAction({
      id: "newer-irreversible",
      createdAt: 200,
      reversibility: "none",
      description: "Irreversible shell command",
    });
    const removed: number[] = [];
    let collections = [9];
    const tool = createUndoLastActionTool({
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getCollections: () => collections,
      }),
      removeItemFromCollection: async ({ itemId }: { itemId: number }) => {
        removed.push(itemId);
        collections = [];
        return { removed: true };
      },
    } as never);
    const undoInput: { actionId?: string } = {};
    const pending = await tool.createPendingAction?.(undoInput, context);
    const actionField = pending?.fields.find(
      (field) => field.id === "actionId" && field.type === "select",
    );
    const blockerField = pending?.fields.find(
      (field) =>
        field.id === "newerIrreversible" && field.type === "review_table",
    );
    assert.equal(
      actionField?.type === "select" ? actionField.value : undefined,
      "older-reversible",
    );
    assert.equal(
      blockerField?.type === "review_table"
        ? blockerField.rows[0]?.label
        : undefined,
      "Irreversible shell command",
    );
    assert.equal(undoInput.actionId, "older-reversible");
    const mismatched = tool.applyConfirmation?.(
      undoInput,
      { actionId: "newer-irreversible" },
      context,
    );
    assert.isFalse(mismatched?.ok);

    // The registry executes this same validated input when an approval carries
    // no form payload, so the reviewed target must already be frozen here.
    await tool.execute!(undoInput, context);

    assert.deepEqual(removed, [4]);
    assert.equal(db.actions.get("older-reversible")?.status, "reverted");
    assert.equal(db.actions.get("newer-irreversible")?.status, "irreversible");
  });

  it("returns no effect when only irreversible actions remain", async function () {
    await prepareAction({
      id: "only-irreversible",
      createdAt: 100,
      reversibility: "none",
      description: "Read-mode script",
    });
    const tool = createUndoLastActionTool({} as never);

    assert.isFalse(await tool.shouldRequireConfirmation?.({}, context));
    const execution = await tool.execute!({}, context);

    assert.equal(execution.effect, "none");
    assert.include(JSON.stringify(execution.content), "no durable inverse");
    assert.equal(db.actions.get("only-irreversible")?.status, "irreversible");
  });

  it("refuses a confirmed undo target whose journal state changed", async function () {
    await prepareAction({
      id: "changed-after-confirmation",
      createdAt: 100,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
    });
    const tool = createUndoLastActionTool({} as never);
    const undoInput: { actionId?: string } = {};
    await tool.createPendingAction?.(undoInput, context);
    const confirmed = tool.applyConfirmation?.(
      undoInput,
      { actionId: "changed-after-confirmation" },
      context,
    );
    assert.isTrue(confirmed?.ok);
    if (!confirmed?.ok) return;
    await updateJournalAction({
      actionId: "changed-after-confirmation",
      status: "reverted",
    });

    let message = "";
    try {
      await tool.execute!(confirmed.value, context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.include(message, "changed before undo could start");
  });

  it("offers partially reversible actions", async function () {
    await prepareAction({
      id: "partial-undo-target",
      createdAt: 100,
      reversibility: "partial",
      recovery: "One external side effect may remain.",
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "remove_from_collection",
        items: [
          {
            itemId: 4,
            exists: true,
            parentItemId: null,
            deleted: false,
            collectionIds: [9],
          },
        ],
      },
    });
    let collections = [9];
    const tool = createUndoLastActionTool({
      getItem: (itemId: number) => ({
        id: itemId,
        parentID: false,
        deleted: false,
        getCollections: () => collections,
      }),
      removeItemFromCollection: async () => {
        collections = [];
        return { removed: true };
      },
    } as never);

    const execution = await tool.execute!({}, context);

    assert.equal(execution.effect, "partial");
    assert.equal(
      (execution.content as { status?: string }).status,
      "partially_undone",
    );
  });

  it("always confirms undo execution because no redo action is created", async function () {
    await prepareAction({
      id: "confirm-undo",
      createdAt: 100,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "remove_from_collection",
        items: [{ itemId: 4, exists: false }],
      },
    });
    const undoPlan = await createUndoLastActionTool({} as never).planMutation?.(
      {},
      context,
    );
    const revertPlan = await createRevertChangesTool(
      {} as never,
    ).planMutation?.({ count: 1, dryRun: false }, context);
    const revertTool = createRevertChangesTool({} as never);
    const dryRunPlan = await revertTool.planMutation?.(
      { count: 1, dryRun: true },
      context,
    );
    const dryRunExecution = await revertTool.execute(
      { count: 1, dryRun: true },
      context,
    );

    assert.deepInclude(undoPlan, {
      effect: "write",
      reversibility: "none",
      requiresConfirmation: true,
    });
    assert.deepInclude(revertPlan, {
      effect: "write",
      reversibility: "none",
      requiresConfirmation: true,
    });
    assert.deepEqual(dryRunPlan, {
      effect: "none",
      reversibility: "full",
    });
    assert.equal(dryRunExecution.effect, "none");
  });

  it("closes a pre-write journal failure without running the external write", async function () {
    let executed = false;
    db.failWhen = (sql, params) =>
      sql.startsWith(
        "UPDATE llm_for_zotero_agent_journal_steps_v2 SET status = ?",
      ) && params[0] === "applying"
        ? new Error("journal claim failed")
        : null;

    let errorMessage = "";
    try {
      await executeExternalMutation({
        context,
        toolName: "external_test",
        plan: {
          operation: "external_test",
          description: "External test",
          forward: { value: "after" },
          inverse: { value: "before" },
          reversibility: "full",
        },
        execute: async () => {
          executed = true;
          return { result: {}, changed: true };
        },
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    assert.include(errorMessage, "journal claim failed");
    assert.isFalse(executed);
    assert.equal([...db.actions.values()][0].status, "failed");
    assert.equal([...db.steps.values()][0].status, "failed");
  });

  it("journals a recognized command that creates a previously absent path", async function () {
    const originalChromeUtils = (globalThis as { ChromeUtils?: unknown })
      .ChromeUtils;
    let created = false;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/journal-new-output.txt" && created,
      read: async () => new TextEncoder().encode("created output"),
      remove: async () => undefined,
    };
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const pipe = () => ({ readString: async () => "" });
            return {
              stdout: pipe(),
              stderr: pipe(),
              wait: async () => {
                created = true;
                return { exitCode: 0 };
              },
              kill: () => undefined,
            };
          },
        },
      }),
    };
    try {
      const tool = createRunCommandTool();
      const validated = tool.validate({
        command: 'printf "created output" > "/tmp/journal-new-output.txt"',
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const plan = await tool.planMutation?.(validated.value, context);
      assert.equal(plan?.effect, "write");
      assert.equal(plan?.reversibility, "partial");

      await tool.execute(validated.value, context);
      const [action] = await listJournalActions({
        conversationKey: 77,
        limit: 1,
      });

      assert.equal(action.status, "applied");
      assert.equal(action.steps[0].operation, "run_command");
      assert.include(action.steps[0].inverseJson || "", '"operation":"delete"');
      assert.include(
        action.steps[0].expectedPostconditionJson || "",
        '"kind":"file"',
      );
    } finally {
      (globalThis as { ChromeUtils?: unknown }).ChromeUtils =
        originalChromeUtils;
    }
  });

  it("journals an unrecognized shell write instead of treating it as read-only", async function () {
    const originalChromeUtils = (globalThis as { ChromeUtils?: unknown })
      .ChromeUtils;
    let executed = false;
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const pipe = () => ({ readString: async () => "" });
            return {
              stdout: pipe(),
              stderr: pipe(),
              wait: async () => {
                executed = true;
                return { exitCode: 0 };
              },
              kill: () => undefined,
            };
          },
        },
      }),
    };
    try {
      const tool = createRunCommandTool();
      const validated = tool.validate({
        command: 'printf "created output" | tee /tmp/journal-gap',
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const plan = await tool.planMutation?.(validated.value, context);
      assert.deepInclude(plan, {
        effect: "write",
        reversibility: "none",
      });

      await tool.execute(validated.value, context);
      const [action] = await listJournalActions({
        conversationKey: 77,
        limit: 1,
      });

      assert.isTrue(executed);
      assert.equal(action.status, "irreversible");
      assert.equal(action.steps[0].operation, "run_command");
      assert.include(action.steps[0].forwardJson, "journal-gap");
    } finally {
      (globalThis as { ChromeUtils?: unknown }).ChromeUtils =
        originalChromeUtils;
    }
  });

  it("keeps a failed shell command that may already have written as irreversible", async function () {
    const originalChromeUtils = (globalThis as { ChromeUtils?: unknown })
      .ChromeUtils;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) => path === "/tmp/journal-victim",
      read: async () => new Uint8Array(),
    };
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const pipe = () => ({ readString: async () => "" });
            return {
              stdout: pipe(),
              stderr: pipe(),
              wait: async () => ({ exitCode: 1 }),
              kill: () => undefined,
            };
          },
        },
      }),
    };
    try {
      const tool = createRunCommandTool();
      const validated = tool.validate({
        command: 'false > "/tmp/journal-victim"',
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const approved = tool.applyConfirmation?.(validated.value, {}, context);
      assert.isTrue(approved?.ok);
      if (!approved?.ok) return;

      const result = (await tool.execute(approved.value, context)).content as {
        exitCode: number;
      };
      const [action] = await listJournalActions({
        conversationKey: 77,
        limit: 1,
      });

      assert.equal(result.exitCode, 1);
      assert.equal(action.status, "irreversible");
      assert.equal(action.steps[0].status, "irreversible");
      assert.include(
        action.steps[0].expectedPostconditionJson || "",
        '"kind":"file"',
      );
    } finally {
      (globalThis as { ChromeUtils?: unknown }).ChromeUtils =
        originalChromeUtils;
    }
  });

  it("resolves a cp destination directory to the created child file", async function () {
    const originalChromeUtils = (globalThis as { ChromeUtils?: unknown })
      .ChromeUtils;
    let copiedBytes: Uint8Array | null = null;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/existing-dir" ||
        (path === "/tmp/existing-dir/source.txt" && copiedBytes !== null),
      stat: async (path: string) => ({
        type: path === "/tmp/existing-dir" ? "directory" : "regular",
      }),
      read: async () => copiedBytes || new Uint8Array(),
    };
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const pipe = () => ({ readString: async () => "" });
            return {
              stdout: pipe(),
              stderr: pipe(),
              wait: async () => {
                copiedBytes = new TextEncoder().encode("copied");
                return { exitCode: 0 };
              },
              kill: () => undefined,
            };
          },
        },
      }),
    };
    try {
      const tool = createRunCommandTool();
      const validated = tool.validate({
        command: "cp /tmp/source.txt /tmp/existing-dir",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const approved = tool.applyConfirmation?.(validated.value, {}, context);
      assert.isTrue(approved?.ok);
      if (!approved?.ok) return;

      const result = (await tool.execute(approved.value, context)).content as {
        exitCode: number;
      };
      const [action] = await listJournalActions({
        conversationKey: 77,
        limit: 1,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(action.status, "applied");
      assert.include(
        action.steps[0].forwardJson,
        '"declaredOutputPath":"/tmp/existing-dir/source.txt"',
      );
      assert.include(
        action.steps[0].expectedPostconditionJson || "",
        '"kind":"file"',
      );
    } finally {
      (globalThis as { ChromeUtils?: unknown }).ChromeUtils =
        originalChromeUtils;
    }
  });

  it("restores the exact preimage bytes after a file_io overwrite", async function () {
    const originalBytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x80]);
    let currentBytes = new Uint8Array(originalBytes);
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) => path === "/tmp/non-utf8.txt",
      read: async () => new Uint8Array(currentBytes),
      write: async (_path: string, bytes: Uint8Array) => {
        currentBytes = new Uint8Array(bytes);
      },
    };
    const tool = createFileIOTool();
    assert.isFalse(
      tool.validate({
        action: "write",
        filePath: "/tmp/non-utf8.txt",
        content: "replacement",
        encoding: "utf-16le",
      }).ok,
    );
    const validated = tool.validate({
      action: "write",
      filePath: "/tmp/non-utf8.txt",
      content: "replacement",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const approved = tool.applyConfirmation?.(validated.value, {}, context);
    assert.isTrue(approved?.ok);
    if (!approved?.ok) return;

    await tool.execute(approved.value, context);
    assert.deepEqual(
      [...currentBytes],
      [...new TextEncoder().encode("replacement")],
    );
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {} as never,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.deepEqual([...currentBytes], [...originalBytes]);
  });

  it("rejects a malformed declarative inverse before later script mutations run", async function () {
    let title = "Before";
    const item = {
      id: 91,
      setField: (_field: string, value: string) => {
        title = value;
      },
      saveTx: async () => undefined,
    };
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => (id === 91 ? item : null) },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "reject an invalid inverse before writing",
      script: [
        "env.addInverse({ version: 1, kind: 'unsupported' });",
        "const item = Zotero.Items.get(91);",
        "item.setField('title', 'After');",
        "await item.saveTx();",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const execution = await tool.execute(validated.value, context);

    assert.equal(title, "Before");
    assert.include(JSON.stringify(execution.content), "payload is unsupported");
  });

  it("retains snapshots when a malformed inverse is declared after mutation", async function () {
    let title = "Before";
    const item = {
      id: 92,
      libraryID: 1,
      parentID: false,
      deleted: false,
      itemTypeID: 1,
      isNote: () => false,
      getField: (field: string) => (field === "title" ? title : ""),
      setField: (field: string, value: string) => {
        if (field === "title") title = value;
      },
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      setCreators: () => undefined,
      toJSON: () => ({ title }),
      fromJSON: (value: { title?: string }) => {
        if (value.title !== undefined) title = value.title;
      },
      saveTx: async () => undefined,
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => (id === 92 ? item : null) },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "retain a snapshot after a bad inverse",
      script: [
        "const item = Zotero.Items.get(92);",
        "env.snapshot(item);",
        "item.setField('title', 'After');",
        "await item.saveTx();",
        "env.addInverse({ version: 1, kind: 'unsupported' });",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context);
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    assert.equal(title, "After");
    assert.equal(action.reversibility, "partial");
    assert.include(action.steps[0].inverseJson || "", "script_snapshots");

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context,
    });

    assert.equal(outcome.partiallyReverted, 1);
    assert.equal(title, "Before");
  });

  it("keeps snapshot recovery when a declarative inverse cannot be guarded", async function () {
    let title = "Before";
    const item = {
      id: 93,
      libraryID: 1,
      parentID: false,
      deleted: false,
      itemTypeID: 1,
      isNote: () => false,
      getField: (field: string) => (field === "title" ? title : ""),
      setField: (field: string, value: string) => {
        if (field === "title") title = value;
      },
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      setCreators: () => undefined,
      toJSON: () => ({ title }),
      saveTx: async () => undefined,
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => (id === 93 ? item : null) },
      debug: () => undefined,
    } as never;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
    };
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "retain a snapshot when a file guard fails",
      script: [
        "const item = Zotero.Items.get(93);",
        "env.snapshot(item);",
        "item.setField('title', 'After');",
        "await item.saveTx();",
        "env.addInverse({ version: 1, kind: 'file', operation: 'delete', path: '/tmp/unguarded-file' });",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const execution = await tool.execute(validated.value, context);
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const outer = JSON.parse(action.steps[0].inverseJson || "null") as {
      payload?: { storage?: string; content?: string };
    };
    const bundle = JSON.parse(outer.payload?.content || "null") as {
      snapshots?: unknown[];
      declaredInverses?: unknown[];
    };

    assert.equal(title, "After");
    assert.lengthOf(bundle.snapshots || [], 1);
    assert.deepEqual(bundle.declaredInverses, []);
    assert.include(JSON.stringify(execution.content), "could not be guarded");
  });

  it("guards item targets named only by a Zotero script's declarative inverse", async function () {
    let tags = [{ tag: "Before" }];
    const item = {
      id: 91,
      libraryID: 1,
      parentID: false,
      deleted: false,
      getTags: () => tags,
      setTags: (next: Array<{ tag: string }>) => {
        tags = next;
      },
      getCollections: () => [],
      getField: () => "",
      getCreatorsJSON: () => [],
      toJSON: () => ({ tags }),
      saveTx: async () => undefined,
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Items: { get: (id: number) => (id === 91 ? item : null) },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "change tags with a declarative inverse",
      script: [
        "const item = Zotero.Items.get(91);",
        "env.addInverse({ version: 1, kind: 'library_operations', operations: [{ type: 'set_item_tags', assignments: [{ itemId: 91, tags: ['Before'] }] }] });",
        "item.setTags([{ tag: 'Agent' }]);",
        "await item.saveTx();",
        "env.addInverse({ version: 1, kind: 'unsupported' });",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context);
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });
    assert.include(
      action.steps[0].expectedPostconditionJson || "",
      '"kind":"script_effects"',
    );
    tags = [{ tag: "User" }];
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.deepEqual(tags, [{ tag: "User" }]);
  });

  it("rejects script snapshot coverage that overlaps a library-wide tag inverse", async function () {
    const declaredOperation = {
      type: "update_library_tag" as const,
      action: "rename" as const,
      tag: "New",
      newTag: "Old",
      libraryID: 1,
    };
    await prepareAction({
      id: "script-overlapping-tag-snapshot",
      createdAt: 1_360,
      operation: "zotero_script",
      inverse: {
        version: 1,
        kind: "script_snapshots",
        snapshots: [
          {
            itemId: 91,
            fields: { title: "Before" },
            creators: [],
            tags: [{ tag: "Old" }],
            collectionIds: [],
          },
        ],
        createdItemIds: [],
        declaredInverses: [
          {
            version: 1,
            kind: "library_operations",
            operations: [declaredOperation],
          },
        ],
        progress: {
          version: 1,
          plannerVersion: 1,
          phase: "declared",
          declarationIndex: 0,
          unitIndex: 0,
        },
      },
      expectedPostcondition: {
        kind: "script_effects",
        items: [],
        declared: [
          {
            kind: "library_operation",
            operation: declaredOperation,
            state: {
              version: 1,
              operation: "update_library_tag",
              libraryTags: [
                {
                  libraryID: 1,
                  name: "New",
                  observable: true,
                  exists: true,
                  itemIds: [91],
                },
                {
                  libraryID: 1,
                  name: "Old",
                  observable: true,
                  exists: false,
                  itemIds: [],
                },
              ],
            },
          },
        ],
      },
    });
    let writes = 0;
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        updateLibraryTag: async () => {
          writes += 1;
          return { status: "applied" };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.include(outcome.conflicts[0].reason, "item:91");
    assert.equal(writes, 0);
  });

  it("rejects whole-item overlap across declarations and bundled operations", async function () {
    const relationInverse = {
      type: "relate_items" as const,
      itemId: 10,
      relatedItemIds: [11],
      action: "remove" as const,
    };
    const restoreInverse = {
      type: "restore_from_trash" as const,
      itemIds: [10],
    };
    const guards = [
      {
        kind: "library_operation",
        operation: relationInverse,
        state: { version: 1, operation: "relate_items" },
      },
      {
        kind: "library_operation",
        operation: restoreInverse,
        state: { version: 1, operation: "restore_from_trash" },
      },
    ];
    const variants = [
      {
        id: "script-overlapping-declarations",
        declarationIndex: 1,
        declaredInverses: [
          {
            version: 1,
            kind: "library_operations",
            operations: [relationInverse],
          },
          {
            version: 1,
            kind: "library_operations",
            operations: [restoreInverse],
          },
        ],
      },
      {
        id: "script-overlapping-bundled-operations",
        declarationIndex: 0,
        declaredInverses: [
          {
            version: 1,
            kind: "library_operations",
            operations: [relationInverse, restoreInverse],
          },
        ],
      },
    ];
    for (const [index, variant] of variants.entries()) {
      await prepareAction({
        id: variant.id,
        createdAt: 1_362 + index,
        operation: "zotero_script",
        inverse: {
          version: 1,
          kind: "script_snapshots",
          snapshots: [],
          createdItemIds: [],
          declaredInverses: variant.declaredInverses,
          progress: {
            version: 1,
            plannerVersion: 1,
            phase: "declared",
            declarationIndex: variant.declarationIndex,
            unitIndex: 0,
          },
        },
        expectedPostcondition: {
          kind: "script_effects",
          items: [],
          declared: guards,
        },
      });
      let writes = 0;
      const [action] = await listJournalActions({
        conversationKey: 77,
        limit: 1,
      });

      const outcome = await revertActions({
        actions: [action],
        zoteroGateway: {
          relateItems: async () => {
            writes += 1;
          },
          restoreFromTrash: async () => {
            writes += 1;
          },
        } as never,
        context,
      });

      assert.equal(outcome.reverted, 0, variant.id);
      assert.lengthOf(outcome.conflicts, 1, variant.id);
      assert.include(outcome.conflicts[0].reason, "item:10", variant.id);
      assert.equal(writes, 0, variant.id);
    }
  });

  it("allows sibling relation atoms while still tracking whole-item coverage", async function () {
    const declaredOperation = {
      type: "relate_items" as const,
      itemId: 10,
      relatedItemIds: [11, 12],
      action: "remove" as const,
    };
    const itemState = (itemId: number) => ({
      itemId,
      exists: true,
      parentItemId: null,
      deleted: false,
    });
    await prepareAction({
      id: "script-multi-target-relation",
      createdAt: 1_365,
      operation: "zotero_script",
      inverse: {
        version: 1,
        kind: "script_snapshots",
        snapshots: [],
        createdItemIds: [],
        declaredInverses: [
          {
            version: 1,
            kind: "library_operations",
            operations: [declaredOperation],
          },
        ],
        progress: {
          version: 1,
          plannerVersion: 1,
          phase: "declared",
          declarationIndex: 0,
          unitIndex: 0,
        },
      },
      expectedPostcondition: {
        kind: "script_effects",
        items: [],
        declared: [
          {
            kind: "library_operation",
            operation: declaredOperation,
            state: {
              version: 1,
              operation: "relate_items",
              items: [itemState(10), itemState(11), itemState(12)],
              relations: [
                {
                  itemId: 10,
                  relatedItemId: 11,
                  related: true,
                  reciprocal: true,
                },
                {
                  itemId: 10,
                  relatedItemId: 12,
                  related: true,
                  reciprocal: true,
                },
              ],
            },
          },
        ],
      },
    });
    const relatedById = new Map<number, Set<string>>([
      [10, new Set(["K11", "K12"])],
      [11, new Set(["K10"])],
      [12, new Set(["K10"])],
    ]);
    const writes: number[] = [];
    const gateway = {
      getItem: (itemId: number) => ({
        id: itemId,
        key: `K${itemId}`,
        parentID: false,
        deleted: false,
        get relatedItems() {
          return [...(relatedById.get(itemId) || [])];
        },
      }),
      relateItems: async ({
        itemId,
        relatedItemIds,
        action,
      }: {
        itemId: number;
        relatedItemIds: number[];
        action: "add" | "remove";
      }) => {
        for (const relatedItemId of relatedItemIds) {
          writes.push(relatedItemId);
          if (action === "remove") {
            relatedById.get(itemId)?.delete(`K${relatedItemId}`);
            relatedById.get(relatedItemId)?.delete(`K${itemId}`);
          }
        }
        return {
          itemId,
          relatedCount: action === "add" ? relatedItemIds.length : 0,
          unrelatedCount: action === "remove" ? relatedItemIds.length : 0,
          items: relatedItemIds.map((relatedItemId) => ({
            relatedItemId,
            status: action === "add" ? "related" : "unrelated",
          })),
        };
      },
    } as never;
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.deepEqual(writes, [11, 12]);
    assert.deepEqual([...relatedById.get(10)!], []);
  });

  it("completes replay after clearing an originally absent declarative preference", async function () {
    let preferenceValue: unknown;
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Items: { get: () => null },
      Prefs: {
        get: () => preferenceValue,
        set: (_key: string, value: unknown) => {
          preferenceValue = value;
        },
        clear: () => {
          preferenceValue = undefined;
        },
      },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "set an originally absent preference",
      script: [
        "env.addInverse({ version: 1, kind: 'preference', key: 'export.quickCopy.setting', existed: false });",
        "Zotero.Prefs.set('export.quickCopy.setting', 'agent-value');",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context);
    assert.equal(preferenceValue, "agent-value");
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.equal(outcome.partiallyReverted, 1);
    assert.equal(outcome.residuals[0]?.actionId, action.actionId);
    assert.isUndefined(preferenceValue);
    assert.equal(db.actions.get(action.actionId)?.status, "reverted");
  });

  it("preserves automatic tag types when replaying a script snapshot", async function () {
    let title = "Before";
    let tags = [{ tag: "Imported", type: 1 }];
    const item = {
      id: 91,
      libraryID: 1,
      parentID: false,
      deleted: false,
      getField: (field: string) => (field === "title" ? title : ""),
      setField: (field: string, value: string) => {
        if (field === "title") title = value;
      },
      getCreatorsJSON: () => [],
      setCreators: () => undefined,
      getTags: () => tags.map((entry) => ({ ...entry })),
      removeTag: (tag: string) => {
        tags = tags.filter((entry) => entry.tag !== tag);
      },
      addTag: (tag: string, type?: number) => {
        tags.push({ tag, type: type ?? 0 });
      },
      getCollections: () => [],
      getAttachments: () => [],
      getNotes: () => [],
      isNote: () => false,
      toJSON: () => ({ title, tags: tags.map((entry) => ({ ...entry })) }),
      fromJSON: (json: { title?: string }) => {
        if (json.title !== undefined) title = json.title;
      },
      saveTx: async () => undefined,
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      DB: db,
      Items: { get: (id: number) => (id === 91 ? item : null) },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      description: "change a title while preserving automatic tags",
      script: [
        "const item = Zotero.Items.get(91);",
        "env.snapshot(item);",
        "item.setField('title', 'After');",
        "await item.saveTx();",
      ].join("\n"),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context);
    assert.equal(title, "After");
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: new ZoteroGateway(),
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.equal(outcome.partiallyReverted, 1);
    assert.equal(outcome.residuals[0]?.actionId, action.actionId);
    assert.equal(title, "Before");
    assert.deepEqual(tags, [{ tag: "Imported", type: 1 }]);
  });

  it("recognizes direct inverses that completed just before an undo crash", async function () {
    await prepareAction({
      id: "completed-note-inverse",
      createdAt: 1_380,
      status: "revert_failed",
      operation: "replace_note_html",
      inverse: {
        version: 1,
        kind: "note_html",
        noteId: 7,
        html: "<p>Before</p>",
      },
      expectedPostcondition: {
        kind: "note_html",
        noteId: 7,
        checksum: await sha256Text("<p>After</p>"),
      },
    });
    await prepareAction({
      id: "completed-file-inverse",
      createdAt: 1_381,
      status: "revert_failed",
      operation: "write_file",
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/completed-before-crash.txt",
        content: "Before",
      },
      expectedPostcondition: {
        kind: "file",
        path: "/tmp/completed-before-crash.txt",
        exists: true,
        checksum: await sha256Text("After"),
      },
    });
    await prepareAction({
      id: "completed-preference-inverse",
      createdAt: 1_382,
      status: "revert_failed",
      operation: "update_preference",
      inverse: {
        version: 1,
        kind: "preference",
        key: "export.quickCopy.setting",
        existed: false,
      },
      expectedPostcondition: {
        kind: "preference",
        key: "export.quickCopy.setting",
        existed: true,
        value: "After",
      },
    });
    let writes = 0;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/completed-before-crash.txt",
      read: async () => new TextEncoder().encode("Before"),
      write: async () => {
        writes += 1;
      },
      writeUTF8: async () => {
        writes += 1;
      },
      remove: async () => {
        writes += 1;
      },
    };
    const gateway = {
      getItem: (itemId: number) =>
        itemId === 7 ? { getNote: () => "<p>Before</p>" } : null,
      listSettings: () => [
        {
          key: "export.quickCopy.setting",
          value: undefined,
          type: "string",
          description: "Quick Copy",
        },
      ],
      restoreNoteHtml: async () => {
        writes += 1;
      },
      restoreSetting: () => {
        writes += 1;
      },
    } as never;
    const actions = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 10,
    });

    const outcome = await revertActions({
      actions,
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 3);
    assert.equal(writes, 0);
    assert.equal(db.actions.get("completed-note-inverse")?.status, "reverted");
    assert.equal(db.actions.get("completed-file-inverse")?.status, "reverted");
    assert.equal(
      db.actions.get("completed-preference-inverse")?.status,
      "reverted",
    );
  });

  it("recognizes a completed creator inverse regardless of object key order", async function () {
    await prepareAction({
      id: "completed-creator-inverse",
      createdAt: 1_382.5,
      status: "revert_failed",
      operation: "update_metadata",
      forward: {
        type: "update_metadata",
        itemId: 1,
        metadata: {
          creators: [
            {
              firstName: "Grace",
              lastName: "Hopper",
              creatorType: "author",
            },
          ],
        },
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "update_metadata",
            itemId: 1,
            metadata: {
              creators: [
                {
                  firstName: "Ada",
                  lastName: "Lovelace",
                  creatorType: "author",
                },
              ],
            },
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "update_metadata",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            fields: { title: "Paper" },
            creators: [
              {
                firstName: "Grace",
                lastName: "Hopper",
                creatorType: "author",
              },
            ],
          },
        ],
      },
    });
    let writes = 0;
    const creators = [
      {
        creatorType: "author",
        lastName: "Lovelace",
        firstName: "Ada",
      },
    ];
    const gateway = {
      getItem: () => ({ id: 1, parentID: false, deleted: false }),
      resolveMetadataItem: () => ({ id: 1, parentID: false, deleted: false }),
      getEditableArticleMetadata: () => ({
        itemId: 1,
        title: "Paper",
        fields: { title: "Paper" },
        creators,
      }),
      updateArticleMetadata: async () => {
        writes += 1;
        return { status: "updated" };
      },
    } as never;
    const actions = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 10,
    });

    const outcome = await revertActions({
      actions: actions.filter(
        (action) => action.actionId === "completed-creator-inverse",
      ),
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.equal(writes, 0);
    assert.equal(
      db.actions.get("completed-creator-inverse")?.status,
      "reverted",
    );
  });

  it("preserves a concurrent file edit after post-claim completion", async function () {
    const path = "/tmp/post-claim-concurrent-edit.txt";
    await prepareAction({
      id: "post-claim-concurrent-file-edit",
      createdAt: 1_383,
      status: "revert_failed",
      operation: "write_file",
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path,
        content: "Before",
      },
      expectedPostcondition: {
        kind: "file",
        path,
        exists: true,
        checksum: await sha256Text("After"),
      },
    });
    let content = "Before";
    let reads = 0;
    let writes = 0;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
      read: async () => {
        reads += 1;
        const observed = new TextEncoder().encode(content);
        if (reads === 2) {
          queueMicrotask(() => {
            content = "Concurrent user edit";
          });
        }
        return observed;
      },
      write: async (_path: string, bytes: Uint8Array) => {
        writes += 1;
        content = new TextDecoder().decode(bytes);
      },
    };
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {} as never,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.equal(reads, 2);
    assert.equal(writes, 0);
    assert.equal(content, "Concurrent user edit");
    assert.equal(
      db.actions.get("post-claim-concurrent-file-edit")?.status,
      "reverted",
    );
  });

  it("does not reload a recovery blob after the post-claim guard", async function () {
    const targetPath = "/tmp/blob-backed-restore-target.bin";
    const recoveryPath = "/tmp/blob-backed-restore-payload.bin";
    const beforeBytes = new TextEncoder().encode("Before");
    await prepareAction({
      id: "post-guard-recovery-blob-reload",
      createdAt: 1_384,
      status: "revert_failed",
      operation: "write_file",
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: targetPath,
        payload: {
          storage: "blob",
          blobPath: recoveryPath,
          checksum: await sha256Text("Before"),
          sizeBytes: beforeBytes.byteLength,
        },
      },
      expectedPostcondition: {
        kind: "file",
        path: targetPath,
        exists: true,
        checksum: await sha256Text("After"),
      },
    });
    await registerJournalRecoveryPayloads({
      actionId: "post-guard-recovery-blob-reload",
      stepId: "post-guard-recovery-blob-reload:1",
      value: JSON.parse(
        String(db.steps.get("post-guard-recovery-blob-reload:1")?.inverse_json),
      ),
    });
    let targetContent = "After";
    let recoveryReads = 0;
    let targetWrites = 0;
    let overwroteConcurrentEdit = false;
    const removedRecoveryPaths: string[] = [];
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
      read: async (path: string) => {
        if (path === recoveryPath) {
          recoveryReads += 1;
          if (recoveryReads === 3) {
            targetContent = "Concurrent user edit";
          }
          return beforeBytes;
        }
        return new TextEncoder().encode(targetContent);
      },
      write: async (path: string, bytes: Uint8Array) => {
        if (path !== targetPath) return;
        targetWrites += 1;
        overwroteConcurrentEdit ||= targetContent === "Concurrent user edit";
        targetContent = new TextDecoder().decode(bytes);
      },
      remove: async (path: string) => {
        removedRecoveryPaths.push(path);
      },
    };
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {} as never,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.equal(recoveryReads, 2);
    assert.equal(targetWrites, 1);
    assert.isFalse(overwroteConcurrentEdit);
    assert.equal(targetContent, "Before");
    assert.deepEqual(removedRecoveryPaths, [recoveryPath]);
    assert.equal(db.payloads.size, 0);
    assert.equal(db.cleanup.size, 0);
    assert.isNull(
      db.steps.get("post-guard-recovery-blob-reload:1")?.inverse_json,
    );
  });

  it("journals a mutating read-mode Zotero script as irreversible", async function () {
    let savedTitle = "Before";
    const item = {
      id: 91,
      setField: (_field: string, value: string) => {
        savedTitle = value;
      },
      saveTx: async () => undefined,
    };
    globalThis.Zotero = {
      ...(globalThis.Zotero as unknown as Record<string, unknown>),
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => (id === 91 ? item : null) },
      debug: () => undefined,
    } as never;
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "read",
      script:
        "const item = Zotero.Items.get(91); item.setField('title', 'After'); await item.saveTx(); return item.id;",
      description: "A falsely declared read script",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const plan = await tool.planMutation?.(validated.value, context);
    assert.deepInclude(plan, {
      effect: "write",
      reversibility: "none",
      requiresConfirmation: true,
    });

    await tool.execute(validated.value, context);
    const [action] = await listJournalActions({
      conversationKey: 77,
      limit: 1,
    });

    assert.equal(savedTitle, "After");
    assert.equal(action.toolName, "zotero_script");
    assert.equal(action.status, "irreversible");
    assert.equal(action.steps[0].operation, "zotero_script");
  });

  it("skips stale metadata, note, file, and created-item inverses", async function () {
    await prepareAction({
      id: "metadata-conflict",
      createdAt: 100,
      operation: "update_metadata",
      forward: {
        type: "update_metadata",
        itemId: 1,
        metadata: { title: "Agent title" },
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "update_metadata",
            itemId: 1,
            metadata: { title: "Before" },
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "update_metadata",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            fields: { title: "Agent title" },
          },
        ],
      },
    });
    await prepareAction({
      id: "note-conflict",
      createdAt: 200,
      operation: "edit_note",
      forward: { noteId: 7 },
      inverse: {
        version: 1,
        kind: "note_html",
        noteId: 7,
        html: "<p>Before</p>",
      },
      expectedPostcondition: {
        kind: "note_html",
        noteId: 7,
        checksum: await sha256Text("<p>Agent text</p>"),
      },
    });
    await prepareAction({
      id: "file-conflict",
      createdAt: 300,
      operation: "write_file",
      forward: { path: "/tmp/journal-conflict.txt" },
      inverse: {
        version: 1,
        kind: "file",
        operation: "restore",
        path: "/tmp/journal-conflict.txt",
        content: "Before",
      },
      expectedPostcondition: {
        kind: "file",
        path: "/tmp/journal-conflict.txt",
        exists: true,
        checksum: await sha256Text("Agent content"),
      },
    });
    await prepareAction({
      id: "created-conflict",
      createdAt: 400,
      operation: "create_note",
      forward: { noteId: 8 },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [{ type: "trash_items", itemIds: [8] }],
      },
      expectedPostcondition: {
        kind: "created_item",
        itemId: 8,
        exists: true,
        parentItemId: null,
        collections: [1],
      },
    });

    const writes: string[] = [];
    const items = new Map<number, any>([
      [1, { id: 1, parentID: false, deleted: false }],
      [7, { id: 7, getNote: () => "<p>User edit</p>" }],
      [
        8,
        {
          id: 8,
          parentID: false,
          getCollections: () => [2],
        },
      ],
    ]);
    const gateway = {
      getItem: (itemId: number) => items.get(itemId) || null,
      getEditableArticleMetadata: () => ({
        itemId: 1,
        title: "User title",
        fields: { title: "User title" },
        creators: [],
      }),
      updateArticleMetadata: async () => {
        writes.push("metadata");
        return { status: "updated" };
      },
      restoreNoteHtml: async () => {
        writes.push("note");
      },
      trashItems: async () => {
        writes.push("created-item");
        return { trashedCount: 1 };
      },
    } as never;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
      read: async () => new TextEncoder().encode("User file edit"),
      writeUTF8: async () => {
        writes.push("file");
      },
      remove: async () => {
        writes.push("file");
      },
    };
    const actions = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 10,
    });

    const outcome = await revertActions({
      actions,
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 4);
    assert.deepEqual(writes, []);
    assert.deepEqual(
      [...db.actions.values()].map((row) => row.status),
      ["revert_failed", "revert_failed", "revert_failed", "revert_failed"],
    );
  });

  it("reverts an untouched created item when optional live fields are undefined", async function () {
    await prepareAction({
      id: "created-item-undefined-fields",
      createdAt: 450,
      operation: "create_items",
      forward: {
        type: "create_items",
        items: [{ itemType: "journalArticle", fields: { title: "Created" } }],
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [{ type: "trash_items", itemIds: [8] }],
      },
      result: {
        operation: "create_items",
        result: { itemIds: [8] },
      },
      expectedPostcondition: {
        version: 1,
        operation: "create_items",
        items: [
          {
            itemId: 8,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: [],
            collectionIds: [],
            childAttachmentIds: [],
            childNoteIds: [],
          },
        ],
      },
    });
    const writes: number[][] = [];
    const item = {
      id: 8,
      parentID: false,
      deleted: false,
      isAttachment: () => false,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      getAttachments: () => [],
      getNotes: () => [],
    };
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: (itemId: number) => (itemId === 8 ? item : null),
        getEditableArticleMetadata: () => null,
        trashItems: async ({ itemIds }: { itemIds: number[] }) => {
          writes.push(itemIds);
          item.deleted = true;
          return {
            trashedCount: itemIds.length,
            items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
          };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.deepEqual(outcome.conflicts, []);
    assert.deepEqual(writes, [[8]]);
  });

  it("does not trash a created item after the user adds a tag", async function () {
    await prepareAction({
      id: "created-item-user-tag",
      createdAt: 475,
      operation: "create_items",
      forward: {
        type: "create_items",
        items: [{ itemType: "journalArticle", fields: { title: "Created" } }],
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [{ type: "trash_items", itemIds: [8] }],
      },
      result: {
        operation: "create_items",
        result: { itemIds: [8] },
      },
      expectedPostcondition: {
        version: 1,
        operation: "create_items",
        items: [
          {
            itemId: 8,
            exists: true,
            parentItemId: null,
            deleted: false,
            tags: [],
            collectionIds: [],
            childAttachmentIds: [],
            childNoteIds: [],
          },
        ],
      },
    });
    const item = {
      id: 8,
      parentID: false,
      deleted: false,
      isAnnotation: () => false,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => "",
      getTags: () => [{ tag: "User" }],
      getCollections: () => [],
      getAttachments: () => [],
      getNotes: () => [],
    };
    const writes: number[][] = [];
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: (itemId: number) => (itemId === 8 ? item : null),
        getEditableArticleMetadata: () => null,
        trashItems: async ({ itemIds }: { itemIds: number[] }) => {
          writes.push(itemIds);
          return { trashedCount: itemIds.length, items: [] };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.deepEqual(writes, []);
  });

  it("guards created collections, saved searches, and relations with real post-images", async function () {
    const collection = {
      id: 42,
      name: "Agent collection",
      parentID: false,
      deleted: false,
      getChildItems: () => [],
      getChildCollections: () => [],
    };
    const search = {
      id: 7,
      libraryID: 1,
      name: "Agent search",
      deleted: false,
      conditions: {
        1: { condition: "tag", operator: "is", value: "Agent" },
      },
      getConditions() {
        return this.conditions;
      },
    };
    const source = {
      id: 10,
      key: "SOURCE",
      libraryID: 1,
      parentID: false,
      deleted: false,
      relatedItems: ["TARGET"],
    };
    const target = {
      id: 11,
      key: "TARGET",
      libraryID: 1,
      parentID: false,
      deleted: false,
      relatedItems: ["SOURCE"],
    };
    const writes: string[] = [];
    const gateway = {
      getCollection: (id: number) => (id === 42 ? collection : null),
      getItem: (id: number) => (id === 10 ? source : id === 11 ? target : null),
      resolveLibraryID: () => 1,
      deleteCollection: async () => {
        writes.push("collection");
      },
      deleteSavedSearch: async () => {
        writes.push("search");
      },
      relateItems: async () => {
        writes.push("relation");
        return { changedCount: 1, items: [] };
      },
    } as never;
    globalThis.Zotero = {
      DB: db,
      Items: { get: (id: number) => (gateway as any).getItem(id) },
      Collections: { get: (id: number) => (gateway as any).getCollection(id) },
      Searches: { get: (id: number) => (id === 7 ? search : null) },
      debug: () => undefined,
    } as never;
    const service = new LibraryMutationService(gateway);
    const collectionForward = {
      type: "create_collection" as const,
      name: "Agent collection",
    };
    const searchForward = {
      type: "save_saved_search" as const,
      name: "Agent search",
      conditions: [{ condition: "tag", operator: "is", value: "Agent" }],
    };
    const relationForward = {
      type: "relate_items" as const,
      itemId: 10,
      relatedItemIds: [11],
      action: "add" as const,
    };
    await prepareAction({
      id: "created-collection-guard",
      createdAt: 100,
      operation: collectionForward.type,
      forward: collectionForward,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          { type: "delete_collection", collectionId: 42, permanent: true },
        ],
      },
      expectedPostcondition: await service.captureOperationState(
        collectionForward,
        context,
        { result: { collectionId: 42 } },
      ),
      result: { result: { collectionId: 42 } },
    });
    await prepareAction({
      id: "created-search-guard",
      createdAt: 200,
      operation: searchForward.type,
      forward: searchForward,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          { type: "delete_saved_search", savedSearchId: 7, permanent: true },
        ],
      },
      expectedPostcondition: await service.captureOperationState(
        searchForward,
        context,
        { result: { savedSearchId: 7 } },
      ),
      result: { result: { savedSearchId: 7 } },
    });
    await prepareAction({
      id: "relation-guard",
      createdAt: 300,
      operation: relationForward.type,
      forward: relationForward,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "relate_items",
            itemId: 10,
            relatedItemIds: [11],
            action: "remove",
          },
        ],
      },
      expectedPostcondition: await service.captureOperationState(
        relationForward,
        context,
      ),
    });

    collection.name = "User-renamed collection";
    search.conditions = {
      1: { condition: "tag", operator: "is", value: "User" },
    };
    source.relatedItems = [];
    target.relatedItems = [];
    const actions = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 10,
    });
    const outcome = await revertActions({
      actions,
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 3);
    assert.deepEqual(writes, []);
  });

  it("captures a created note without calling regular-item child getters", async function () {
    const note = {
      id: 42,
      parentID: false,
      deleted: false,
      isAnnotation: () => false,
      isAttachment: () => false,
      isNote: () => true,
      isRegularItem: () => false,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [7],
      getNote: () => "<p>Created note</p>",
      getAttachments: () => {
        throw new Error("getAttachments is invalid for notes");
      },
      getNotes: () => {
        throw new Error("getNotes is invalid for notes");
      },
    };
    const service = new LibraryMutationService({
      getItem: (itemId: number) => (itemId === 42 ? note : null),
      getEditableArticleMetadata: () => null,
    } as never);

    const state = await service.captureOperationState(
      { type: "save_note", content: "Created note" },
      context,
      { result: { noteId: 42 } },
    );

    assert.deepInclude(state.items?.[0], {
      itemId: 42,
      exists: true,
      collectionIds: [7],
      noteHtmlChecksum: await sha256Text("<p>Created note</p>"),
    });
    assert.notProperty(state.items?.[0] || {}, "childAttachmentIds");
    assert.notProperty(state.items?.[0] || {}, "childNoteIds");
  });

  it("refuses an uncertain inverse when the crash left no post-image guard", async function () {
    await prepareAction({
      id: "uncertain-without-postimage",
      createdAt: 500,
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "remove_from_collection",
            itemIds: [4],
            collectionId: 9,
          },
        ],
      },
    });
    db.actions.get("uncertain-without-postimage")!.status = "uncertain";
    db.steps.get("uncertain-without-postimage:1")!.status = "uncertain";
    const removed: number[] = [];
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        removeItemFromCollection: async ({ itemId }: { itemId: number }) => {
          removed.push(itemId);
          return { removed: true };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.include(outcome.conflicts[0].reason, "post-image");
    assert.deepEqual(removed, []);
  });

  it("captures a lazy external pre-image after a queued write completes", async function () {
    let value = "original";
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondPreparedValue = "";

    const run = (
      targetValue: string,
      toolContext: AgentToolContext,
      wait: boolean,
    ) =>
      executeExternalMutation({
        context: toolContext,
        toolName: "test_external_write",
        plan: async () => ({
          operation: "replace_value",
          description: `Replace value with ${targetValue}`,
          forward: { targetValue },
          inverse: { version: 1, kind: "test_value", value },
          precondition: { value },
          reversibility: "full" as const,
        }),
        execute: async () => {
          if (wait) {
            signalFirstStarted();
            await firstGate;
          } else {
            const action = [...db.actions.values()].find(
              (row) => row.conversation_key === 78,
            );
            const step = [...db.steps.values()].find(
              (row) => row.action_id === action?.action_id,
            );
            const inverse = JSON.parse(String(step?.inverse_json)) as {
              value?: string;
            };
            secondPreparedValue = inverse.value || "";
          }
          value = targetValue;
          return {
            result: { status: "updated", value },
            expectedPostcondition: { value },
            affectedCount: 1,
          };
        },
      });

    const first = run("first write", context, true);
    await firstStarted;
    const second = run(
      "second write",
      {
        ...context,
        request: { ...context.request, conversationKey: 78 },
      },
      false,
    );
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(secondPreparedValue, "first write");
  });

  it("rechecks conflicts inside the serialized undo write window", async function () {
    await prepareAction({
      id: "queued-undo",
      createdAt: 800,
      operation: "update_metadata",
      forward: {
        type: "update_metadata",
        itemId: 1,
        metadata: { title: "Agent title" },
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "update_metadata",
            itemId: 1,
            metadata: { title: "Before" },
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "update_metadata",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            fields: { title: "Agent title" },
          },
        ],
      },
    });
    let title = "Agent title";
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blocker = withActiveJournalAction("other-action", async () => {
      signalWriteStarted();
      await writeGate;
      title = "User title";
    });
    await writeStarted;
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const writes: string[] = [];
    const revert = revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: () => ({ id: 1, parentID: false, deleted: false }),
        resolveMetadataItem: () => ({ id: 1, parentID: false, deleted: false }),
        getEditableArticleMetadata: () => ({
          itemId: 1,
          title,
          fields: { title },
          creators: [],
        }),
        updateArticleMetadata: async () => {
          writes.push("metadata");
          return { status: "updated" };
        },
      } as never,
      context,
    });
    await Promise.resolve();
    releaseWrite();
    await blocker;
    const outcome = await revert;

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.deepEqual(writes, []);
  });

  it("rechecks the post-image after the journal step claim", async function () {
    await prepareAction({
      id: "claim-race",
      createdAt: 900,
      operation: "update_metadata",
      forward: {
        type: "update_metadata",
        itemId: 1,
        metadata: { title: "Agent title" },
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "update_metadata",
            itemId: 1,
            metadata: { title: "Before" },
          },
        ],
      },
      expectedPostcondition: {
        version: 1,
        operation: "update_metadata",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            fields: { title: "Agent title" },
          },
        ],
      },
    });
    let title = "Agent title";
    db.failWhen = (sql, params) => {
      if (
        sql.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE} SET status = ?`) &&
        params[0] === "reverting" &&
        params[2] === "claim-race:1"
      ) {
        title = "User title";
      }
      return null;
    };
    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const writes: string[] = [];

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: () => ({ id: 1, parentID: false, deleted: false }),
        resolveMetadataItem: () => ({ id: 1, parentID: false, deleted: false }),
        getEditableArticleMetadata: () => ({
          itemId: 1,
          title,
          fields: { title },
          creators: [],
        }),
        updateArticleMetadata: async () => {
          writes.push("metadata");
          return { status: "updated" };
        },
      } as never,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.deepEqual(writes, []);
    assert.equal(db.steps.get("claim-race:1")?.status, "revert_failed");
  });
});
