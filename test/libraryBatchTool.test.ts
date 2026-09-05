import { assert } from "chai";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";
import type { LibraryBatchJobStore } from "../src/agent/tools/write/libraryBatch";
import { ActionRegistry } from "../src/agent/actions/registry";
import { callTool } from "../src/agent/actions/executor";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { executeLibraryMutationAction } from "../src/agent/services/mutationCoordinator";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import type { BatchJobRecord } from "../src/agent/store/batchJobStore";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The batch engine was a complete propose/paginate/apply system that the
 * model could not name: its only entry points were the slash-command
 * controller and the public plugin API. So "tag my whole library" was not a
 * request the agent could accept at all.
 *
 * It runs unattended, so it is gated on the library write mode being "yolo".
 * A tool call cannot deliver per-page review — the runtime's confirmation
 * model is declarative and bracketing, and an action wants to block
 * mid-execution — so `safe` refuses and points at the surface that can.
 */
describe("library_batch", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: resolvedAgentRequest({
      conversationKey: 9,
      mode: "agent",
      userText: "tag my whole library",
      libraryID: 1,
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1/chat/completions",
      apiKey: "test",
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  function installMode(mode: string) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => mode },
      // No DB: the job store degrades to a no-op rather than failing the run.
      debug: () => undefined,
    };
  }

  function makeTool(execute?: (input: unknown, ctx: unknown) => unknown) {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute:
        execute ||
        (async () => ({
          ok: true,
          output: { tagged: 42, processed: 50 },
        })),
    } as never);
    return createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
    });
  }

  function makeJobStore(params?: {
    record?: BatchJobRecord | null;
    interrupted?: BatchJobRecord[];
    onAdvance?: (
      value: Parameters<LibraryBatchJobStore["advanceBatchJob"]>[0],
    ) => void;
    onMarkRunning?: (jobId: string) => void;
    onCreate?: (
      value: Parameters<LibraryBatchJobStore["createBatchJob"]>[0],
    ) => void;
    claim?: boolean;
  }): LibraryBatchJobStore {
    return {
      createBatchJob: async (value) => {
        params?.onCreate?.(value);
      },
      advanceBatchJob: async (value) => {
        params?.onAdvance?.(value);
      },
      finishBatchJob: async () => undefined,
      getBatchJob: async () => params?.record ?? null,
      listInterruptedBatchJobs: async () => params?.interrupted ?? [],
      markBatchJobRunning: async ({ jobId }) => {
        params?.onMarkRunning?.(jobId);
        return params?.claim ?? true;
      },
    };
  }

  it("lists the available jobs when the name is unknown", function () {
    const tool = makeTool();
    const result = tool.validate({ job: "nonsense" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "auto_tag");
  });

  it("refuses in safe mode and says where per-page review lives", async function () {
    installMode("safe");
    const tool = makeTool();
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { scope: "all" },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected safe mode to refuse");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "yolo");
    assert.include(message, "/auto_tag", "the user needs somewhere to go");
  });

  it("runs the job in yolo and reports real counts", async function () {
    installMode("yolo");
    const tool = makeTool();
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { scope: "all" },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;
    assert.equal(
      output.appliedCount,
      42,
      "the count must come from the action",
    );
    assert.equal(output.job, "auto_tag");
    assert.deepEqual(output.output, { tagged: 42, processed: 50 });
  });

  it("auto-approves inner confirmations, since yolo means the model decides", async function () {
    installMode("yolo");
    let seenMode = "";
    const tool = makeTool(async (_input, ctx) => {
      seenMode = (ctx as { confirmationMode: string }).confirmationMode;
      return { ok: true, output: { tagged: 1 } };
    });
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, context);
    assert.equal(seenMode, "auto_approve");
  });

  it("records one user-visible action with ordered steps across batch pages", async function () {
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Prefs: { get: () => "yolo" },
      Items: { get: () => null },
      debug: () => undefined,
    };
    await initAgentChangeJournal();

    let itemId = 0;
    const mutationService = {
      planOperation: async (operation: { itemIds: number[] }) => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: `tag item ${operation.itemIds[0]}`,
        inverseOperations: [
          {
            type: "remove_tags" as const,
            itemIds: operation.itemIds,
            tags: ["reviewed"],
          },
        ],
      }),
      executeOperation: async (operation: { itemIds: number[] }) => {
        const changed = operation.itemIds[0] < 3;
        return {
          result: {
            operation: "add_tags",
            result: {
              status: changed ? "updated" : "unchanged",
              itemId: operation.itemIds[0],
            },
          },
          inverse: changed
            ? {
                description: `remove tag from ${operation.itemIds[0]}`,
                inverseOperations: [
                  {
                    type: "remove_tags" as const,
                    itemIds: operation.itemIds,
                    tags: ["reviewed"],
                  },
                ],
              }
            : undefined,
          effect: changed ? ("applied" as const) : ("none" as const),
          affectedCount: changed ? 1 : 0,
        };
      },
      captureOperationState: async (operation: { itemIds: number[] }) => ({
        version: 1,
        operation: "add_tags",
        items: [{ itemId: operation.itemIds[0], tags: ["reviewed"] }],
      }),
    };
    const toolRegistry = new AgentToolRegistry();
    toolRegistry.register({
      spec: {
        name: "batch_test_write",
        description: "Apply one test page",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true as const, value: {} }),
      planMutation: () => ({
        effect: "write" as const,
        reversibility: "full" as const,
      }),
      execute: async (_input, toolContext) => {
        itemId += 1;
        const coordinated = await executeLibraryMutationAction({
          service: mutationService as never,
          operations: [
            {
              type: "add_tags",
              itemIds: [itemId],
              tags: ["reviewed"],
            },
          ],
          context: toolContext,
          facadeToolName: "batch_test_write",
        });
        return {
          content: coordinated,
          effect: coordinated.effect,
        };
      },
    });
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (_input: unknown, actionContext: unknown) => {
        await callTool(
          "batch_test_write",
          {},
          actionContext as never,
          "page 1",
        );
        await callTool(
          "batch_test_write",
          {},
          actionContext as never,
          "page 2",
        );
        await callTool(
          "batch_test_write",
          {},
          actionContext as never,
          "page 3 already satisfied",
        );
        return { ok: true, output: { tagged: 2, processed: 3 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore(),
    });
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const execution = await tool.execute(validated.value, {
      ...context,
      runId: "agent-run-9",
    });

    assert.equal(execution.effect, "applied");
    assert.equal(db.actions.size, 1);
    assert.equal(db.steps.size, 3);
    const action = [...db.actions.values()][0];
    assert.equal(action.run_id, "agent-run-9");
    assert.equal(action.tool_name, "library_batch");
    assert.equal(action.status, "applied");
    assert.equal(action.affected_count, 2);
    assert.deepEqual(
      [...db.steps.values()].map((step) => step.sequence_no),
      [1, 2, 3],
    );
    assert.deepEqual(
      [...db.steps.values()].map((step) => step.status),
      ["applied", "applied", "no_effect"],
    );
    assert.deepEqual(
      (await listJournalActions({ runId: "agent-run-9" })).map(
        (journalAction) => journalAction.actionId,
      ),
      [action.action_id],
      "interrupted-run recovery must find the batch through its agent run",
    );
  });

  it("retains an uncertain irreversible recovery barrier on the batch action", async function () {
    const db = new ChangeJournalTestDb();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: db,
      Prefs: { get: () => "yolo" },
      Items: { get: () => null },
      debug: () => undefined,
    };
    await initAgentChangeJournal();
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (_input: unknown, actionContext: unknown) => {
        const journalActionScope = (
          actionContext as {
            journalActionScope?: {
              recordStep: (outcome: {
                effect: "none";
                status: "uncertain";
                reversibility: "none";
                affectedCount: number;
              }) => void;
            };
          }
        ).journalActionScope;
        assert.isDefined(journalActionScope);
        journalActionScope!.recordStep({
          effect: "none",
          status: "uncertain",
          reversibility: "none",
          affectedCount: 0,
        });
        return { ok: false, error: "the forward call may have committed" };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore(),
    });
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context).catch(() => undefined);

    const action = [...db.actions.values()][0];
    assert.equal(action.status, "uncertain");
    assert.equal(action.reversibility, "none");
    assert.equal(action.affected_count, 0);
  });

  it("surfaces the script arguments on the confirmation card", function () {
    installMode("yolo");
    const tool = makeTool();
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { scope: "collection", collectionId: 12 },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const pending = tool.createPendingAction?.(validated.value, context);
    const preview = pending?.fields.find((f) => f.type === "code_preview");
    assert.include(
      (preview as never as { value: string })?.value,
      "collectionId",
    );
    assert.include(
      pending?.description || "",
      "reverted",
      "the user must know the run is recoverable before approving",
    );
  });

  it("propagates a failed job rather than reporting success", async function () {
    installMode("yolo");
    const tool = makeTool(async () => ({
      ok: false,
      error: "model unreachable",
    }));
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected the failure to propagate");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "model unreachable");
  });

  it("awaits exact action checkpoints instead of guessing from progress events", async function () {
    installMode("yolo");
    const advances: Array<
      Parameters<LibraryBatchJobStore["advanceBatchJob"]>[0]
    > = [];
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (_input: unknown, ctx: unknown) => {
        const actionCtx = ctx as {
          checkpoint: (value: unknown) => Promise<void>;
          onProgress: (value: unknown) => void;
        };
        actionCtx.onProgress({
          type: "step_done",
          step: "LLM",
          summary: "suggestions generated",
        });
        await actionCtx.checkpoint({
          cursor: 20,
          appliedCount: 17,
          totalCount: 42,
          plan: { remainingItemIds: [101, 102] },
        });
        return { ok: true, output: { tagged: 17, processed: 20 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore({
        onAdvance: (value) => advances.push(value),
      }),
    });
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, context);

    assert.lengthOf(advances, 1, "progress prose must not become a cursor");
    assert.include(advances[0], {
      cursor: 20,
      appliedCount: 17,
      totalCount: 42,
    });
    assert.deepEqual(advances[0].plan, { remainingItemIds: [101, 102] });
  });

  it("executes a scoped batch from the contract's frozen targets without duplicating them in the initial job input", async function () {
    installMode("yolo");
    let executedInput: Record<string, unknown> = {};
    let persistedInput: Record<string, unknown> = {};
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => {
        executedInput = input as Record<string, unknown>;
        return { ok: true, output: { tagged: 0, processed: 0 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore({
        onCreate: (value) => {
          persistedInput = value.input;
        },
      }),
    });
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { scope: "collection", collectionIds: [3], pageSize: 20 },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, {
      ...context,
      request: {
        ...context.request,
        actionContract: {
          version: 2,
          id: "contract-frozen",
          writeDisposition: "required",
          interpretationSource: "classifier",
          obligations: [
            {
              id: "obligation-frozen",
              capability: "zotero.tags",
              operation: "apply_tags",
              proofDomain: "zotero_state",
              coverage: "all",
              targetKind: "papers",
              scopeRole: "source",
              scope: {
                kind: "collection",
                includeDescendants: false,
                libraryID: 1,
                collectionId: 3,
                collectionPath: "Representation_Drift",
              },
              targetBoundary: {
                kind: "collection",
                libraryID: 1,
                frozenTargetIds: [41, 42, 43],
                scopeDigest: "v1:1:3:direct:41:42:43",
              },
            },
          ],
        },
      },
    });

    assert.deepEqual(executedInput._batchItemIds, [41, 42, 43]);
    assert.notProperty(executedInput, "scope");
    assert.notProperty(executedInput, "collectionIds");
    assert.deepEqual(persistedInput, {
      scope: "collection",
      collectionIds: [3],
      pageSize: 20,
      startOffset: 0,
    });
  });

  it("binds the sorted unresolved union across compatible source-collection obligations", async function () {
    installMode("yolo");
    let executedInput: Record<string, unknown> = {};
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => {
        executedInput = input as Record<string, unknown>;
        return { ok: true, output: { tagged: 0, processed: 0 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore(),
    });
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { itemIds: [999], pageSize: 20 },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const obligations = [
      { id: "source-2", collectionId: 12, frozenTargetIds: [52, 51] },
      { id: "source-1", collectionId: 11, frozenTargetIds: [42, 41] },
    ];
    await tool.execute(validated.value, {
      ...context,
      request: {
        ...context.request,
        actionContract: {
          version: 2,
          id: "contract-union",
          writeDisposition: "required",
          interpretationSource: "classifier",
          obligations: obligations.map((entry) => ({
            id: entry.id,
            capability: "zotero.tags" as const,
            operation: "apply_tags" as const,
            proofDomain: "zotero_state" as const,
            coverage: "all" as const,
            targetKind: "papers" as const,
            scopeRole: "source" as const,
            scope: {
              kind: "collection" as const,
              includeDescendants: false,
              libraryID: 1,
              collectionId: entry.collectionId,
              collectionPath: `Collection ${entry.collectionId}`,
            },
            targetBoundary: {
              kind: "collection" as const,
              libraryID: 1,
              frozenTargetIds: entry.frozenTargetIds,
              scopeDigest: `scope:${entry.collectionId}`,
            },
          })),
        },
        actionProgress: {
          version: 1,
          contractId: "contract-union",
          state: "partial",
          correctionCount: 0,
          obligations: [
            {
              obligationId: "source-2",
              status: "open",
              verifiedTargetIds: [],
              unresolvedTargetIds: ["item:52", "item:51"],
              journalStepIds: [],
              failureReasons: [],
            },
            {
              obligationId: "source-1",
              status: "fulfilled",
              verifiedTargetIds: ["item:41", "item:42"],
              unresolvedTargetIds: [],
              journalStepIds: ["done"],
              failureReasons: [],
            },
          ],
          appliedReceiptKeys: [],
          updatedAt: 1,
        },
      },
    });

    assert.deepEqual(executedInput._batchItemIds, [51, 52]);
    assert.notProperty(executedInput, "itemIds");
  });

  it("intersects a resumed durable plan with the current unresolved collection union", async function () {
    installMode("yolo");
    const record: BatchJobRecord = {
      jobId: "batch-auto_tag-intersection",
      conversationKey: 9,
      action: "auto_tag",
      inputJson: JSON.stringify({ itemIds: [31, 32, 33, 34] }),
      planJson: JSON.stringify({ remainingItemIds: [31, 32, 33] }),
      cursor: 1,
      appliedCount: 1,
      totalCount: 4,
      status: "failed",
      createdAt: 10,
      updatedAt: 20,
    };
    let executedInput: Record<string, unknown> = {};
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => {
        executedInput = input as Record<string, unknown>;
        return { ok: true, output: { tagged: 0, processed: 0 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      batchJobStore: makeJobStore({ record }),
    });
    const validated = tool.validate({ resumeJobId: record.jobId });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, {
      ...context,
      request: {
        ...context.request,
        actionContract: {
          version: 2,
          id: "contract-resume",
          writeDisposition: "required",
          interpretationSource: "classifier",
          obligations: [
            {
              id: "source-resume",
              capability: "zotero.tags",
              operation: "apply_tags",
              proofDomain: "zotero_state",
              coverage: "all",
              targetKind: "papers",
              scopeRole: "source",
              scope: {
                kind: "collection",
                includeDescendants: false,
                libraryID: 1,
                collectionId: 11,
                collectionPath: "Collection 11",
              },
              targetBoundary: {
                kind: "collection",
                libraryID: 1,
                frozenTargetIds: [32, 34],
                scopeDigest: "scope:11",
              },
            },
          ],
        },
        actionProgress: {
          version: 1,
          contractId: "contract-resume",
          state: "partial",
          correctionCount: 0,
          obligations: [
            {
              obligationId: "source-resume",
              status: "open",
              verifiedTargetIds: [],
              unresolvedTargetIds: ["item:32", "item:34"],
              journalStepIds: [],
              failureReasons: [],
            },
          ],
          appliedReceiptKeys: [],
          updatedAt: 1,
        },
      },
    });

    assert.deepEqual(executedInput._batchItemIds, [32]);
  });

  it("binds an empty target set when every applicable collection obligation is already closed", async function () {
    installMode("yolo");
    let executedInput: Record<string, unknown> = {};
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => {
        executedInput = input as Record<string, unknown>;
        return { ok: true, output: { tagged: 0, processed: 0 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore(),
    });
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { itemIds: [999] },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, {
      ...context,
      request: {
        ...context.request,
        actionContract: {
          version: 2,
          id: "contract-complete",
          writeDisposition: "required",
          interpretationSource: "classifier",
          obligations: [
            {
              id: "source-complete",
              capability: "zotero.tags",
              operation: "apply_tags",
              proofDomain: "zotero_state",
              coverage: "all",
              targetKind: "papers",
              scopeRole: "source",
              scope: {
                kind: "collection",
                includeDescendants: false,
                libraryID: 1,
                collectionId: 11,
                collectionPath: "Collection 11",
              },
              targetBoundary: {
                kind: "collection",
                libraryID: 1,
                frozenTargetIds: [41, 42],
                scopeDigest: "scope:11",
              },
            },
          ],
        },
        actionProgress: {
          version: 1,
          contractId: "contract-complete",
          state: "satisfied",
          correctionCount: 0,
          obligations: [
            {
              obligationId: "source-complete",
              status: "fulfilled",
              verifiedTargetIds: ["item:41", "item:42"],
              unresolvedTargetIds: [],
              journalStepIds: ["done"],
              failureReasons: [],
            },
          ],
          appliedReceiptKeys: [],
          updatedAt: 1,
        },
      },
    });

    assert.deepEqual(executedInput._batchItemIds, []);
    assert.notProperty(executedInput, "itemIds");
  });

  it("lists interrupted jobs without requiring yolo or confirmation", async function () {
    installMode("safe");
    const interrupted: BatchJobRecord = {
      jobId: "batch-auto_tag-1",
      conversationKey: 9,
      action: "auto_tag",
      inputJson: "{}",
      planJson: JSON.stringify({ remainingItemIds: [3] }),
      cursor: 2,
      appliedCount: 1,
      totalCount: 3,
      status: "failed",
      createdAt: 10,
      updatedAt: 20,
    };
    const actionRegistry = new ActionRegistry();
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      batchJobStore: makeJobStore({ interrupted: [interrupted] }),
    });
    const validated = tool.validate({ listInterrupted: true });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    assert.isFalse(
      await tool.shouldRequireConfirmation?.(validated.value, context),
    );
    const result = (await tool.execute(validated.value, context)).content as {
      interruptedJobs: Array<Record<string, unknown>>;
    };
    assert.deepInclude(result.interruptedJobs[0], {
      jobId: interrupted.jobId,
      cursor: 2,
      appliedCount: 1,
    });
  });

  it("resumes only the frozen remaining item IDs and preserves cumulative progress", async function () {
    installMode("yolo");
    const record: BatchJobRecord = {
      jobId: "batch-auto_tag-1",
      conversationKey: 9,
      action: "auto_tag",
      inputJson: JSON.stringify({ scope: "all", pageSize: 20 }),
      planJson: JSON.stringify({
        remainingItemIds: [31, 32],
        pageSize: 10,
        tagsPerPaper: 4,
      }),
      cursor: 20,
      appliedCount: 17,
      totalCount: 22,
      status: "failed",
      createdAt: 10,
      updatedAt: 20,
    };
    let resumedInput: Record<string, unknown> = {};
    let marked = "";
    const advances: Array<
      Parameters<LibraryBatchJobStore["advanceBatchJob"]>[0]
    > = [];
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async (input: unknown, ctx: unknown) => {
        resumedInput = input as Record<string, unknown>;
        await (
          ctx as { checkpoint: (value: unknown) => Promise<void> }
        ).checkpoint({
          cursor: 2,
          appliedCount: 2,
          totalCount: 2,
          plan: { remainingItemIds: [] },
        });
        return { ok: true, output: { tagged: 2, processed: 2 } };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      now: () => 1000,
      batchJobStore: makeJobStore({
        record,
        onAdvance: (value) => advances.push(value),
        onMarkRunning: (jobId) => {
          marked = jobId;
        },
      }),
    });
    const validated = tool.validate({ resumeJobId: record.jobId });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;

    assert.equal(marked, record.jobId);
    assert.deepEqual(resumedInput._batchItemIds, [31, 32]);
    assert.equal(resumedInput.startOffset, 0);
    assert.equal(resumedInput.pageSize, 10);
    assert.equal(resumedInput.tagsPerPaper, 4);
    assert.include(advances[0], {
      cursor: 22,
      appliedCount: 19,
      totalCount: 22,
    });
    assert.equal(output.appliedCount, 19);
    assert.equal(output.cursor, 22);
    assert.isTrue(output.resumed);
  });

  it("does not run a second concurrent resume after the durable claim is lost", async function () {
    installMode("yolo");
    const record: BatchJobRecord = {
      jobId: "batch-auto_tag-claimed",
      conversationKey: 9,
      action: "auto_tag",
      inputJson: "{}",
      planJson: JSON.stringify({ remainingItemIds: [31] }),
      cursor: 2,
      appliedCount: 1,
      totalCount: 3,
      status: "failed",
      createdAt: 10,
      updatedAt: 20,
    };
    let executed = false;
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async () => {
        executed = true;
        return { ok: true, output: {} };
      },
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      batchJobStore: makeJobStore({ record, claim: false }),
    });
    const validated = tool.validate({ resumeJobId: record.jobId });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    let message = "";
    try {
      await tool.execute(validated.value, context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.isFalse(executed);
    assert.include(message, "already running or was resumed elsewhere");
  });

  /**
   * `discover_related` calls ctx.requestConfirmation directly — it is an
   * interactive review workflow, not a batch pass — so running it through a
   * tool call would throw partway, after some work had already happened.
   * Advertising a job that cannot work is the kind of lie this whole effort
   * exists to remove.
   */
  it("refuses an interactive-only job up front, with somewhere to go", function () {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "discover_related",
      description: "Find related papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
    });

    const result = tool.validate({ job: "discover_related" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "interactive");
    assert.include(result.error, "/discover_related");
  });

  it("does not list an interactive-only job as available", function () {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "discover_related",
      description: "Find related papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
    });

    const result = tool.validate({ job: "" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "auto_tag");
    assert.notInclude(result.error, "discover_related");
  });

  it("refuses audit-note creation outside the durable batch boundary", function () {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "audit_library",
      description: "Audit metadata",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
    });

    const result = tool.validate({
      job: "audit_library",
      jobArgs: { scope: "all", saveNote: true },
    });

    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "not part of the durable batch transaction");
  });
});
