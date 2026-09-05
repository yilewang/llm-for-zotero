import { assert } from "chai";
import { autoTagAction } from "../src/agent/actions/autoTag";
import type { ActionExecutionContext } from "../src/agent/actions";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

function createStubTool<TInput extends Record<string, unknown>, TResult>(
  spec: AgentToolDefinition<TInput, TResult>["spec"],
  validate: AgentToolDefinition<TInput, TResult>["validate"],
  execute: (
    input: TInput,
    context: Parameters<AgentToolDefinition<TInput, TResult>["execute"]>[1],
  ) => TResult | Promise<TResult>,
  extras: Partial<AgentToolDefinition<TInput, TResult>> = {},
): AgentToolDefinition<TInput, TResult> {
  return {
    spec,
    validate,
    execute: async (input, context) => {
      const content = await execute(input, context);
      return spec.mutability === "write"
        ? { content, effect: "applied" as const }
        : content;
    },
    ...(spec.mutability === "write"
      ? {
          planMutation: async () => ({
            effect: "write" as const,
            reversibility: "full" as const,
          }),
        }
      : {}),
    ...extras,
  };
}

function createActionContext(
  registry: AgentToolRegistry,
  overrides: Partial<ActionExecutionContext> = {},
) {
  const progress: unknown[] = [];
  const ctx: ActionExecutionContext = {
    registry,
    zoteroGateway: {} as never,
    libraryID: 1,
    confirmationMode: "native_ui",
    onProgress: (event) => {
      progress.push(event);
    },
    requestConfirmation: async () => ({ approved: true }),
    ...overrides,
  };
  return { ctx, progress };
}

function makePaperTarget(
  itemId: number,
  title: string,
  tags: string[] = [],
  collectionIds: number[] = [],
) {
  return {
    itemId,
    title,
    firstCreator: "Alice Example",
    year: "2024",
    attachments: [{ contextItemId: itemId + 1000, title: `${title} PDF` }],
    tags,
    collectionIds,
  };
}

function makeBibliographicTarget(
  itemId: number,
  title: string,
  tags: string[] = [],
  collectionIds: number[] = [],
  attachments: Array<{
    contextItemId: number;
    title: string;
    contentType: string;
  }> = [],
) {
  return {
    itemId,
    itemType: "journalArticle",
    title,
    firstCreator: "Alice Example",
    year: "2024",
    attachments,
    tags,
    collectionIds,
  };
}

function ok<T>(value: T): AgentToolInputValidation<T> {
  return { ok: true, value };
}

function registerReviewApplyTagsTool(
  registry: AgentToolRegistry,
  onExecute: (input: {
    assignments: Array<{ itemId: number; tags: string[] }>;
  }) => void,
): void {
  registry.register({
    spec: {
      name: "apply_tags",
      description: "apply tags",
      inputSchema: { type: "object" },
      mutability: "write",
      requiresConfirmation: true,
    },
    validate(args) {
      return ok(
        args as { assignments: Array<{ itemId: number; tags: string[] }> },
      );
    },
    planMutation: async () => ({
      effect: "write",
      reversibility: "full",
    }),
    createPendingAction(input) {
      return {
        toolName: "apply_tags",
        title: "Review tag additions",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "tag_assignment_table",
            id: "tagAssignments:apply_tags",
            label: "Suggested tags to add",
            rows: input.assignments.map((assignment) => ({
              id: `${assignment.itemId}`,
              label: `Paper ${assignment.itemId}`,
              value: assignment.tags,
            })),
          },
        ],
      };
    },
    async execute(input) {
      onExecute(input);
      return {
        content: {
          result: {
            updatedCount: input.assignments.length,
          },
        },
        effect: "applied",
      };
    },
  });
}

describe("autoTag action", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("uses a frozen durable-batch target order and checkpoints exact remaining IDs", async function () {
    const registry = new AgentToolRegistry();
    const applied: number[] = [];
    const checkpoints: Array<{
      cursor: number;
      plan?: Record<string, unknown>;
    }> = [];
    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          const assignments = (
            input as {
              assignments: Array<{ itemId: number }>;
            }
          ).assignments;
          applied.push(...assignments.map((entry) => entry.itemId));
          return { result: { updatedCount: assignments.length } };
        },
      ),
    );
    const { ctx } = createActionContext(registry, {
      confirmationMode: "auto_approve",
      checkpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.map((itemId) =>
            makeBibliographicTarget(itemId, `Frozen Paper ${itemId}`),
          ),
        listBibliographicItemTargets: async () => {
          throw new Error("resume must not re-query the dynamic scope");
        },
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "stable batch abstract" },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
    });

    const result = await autoTagAction.execute(
      {
        _batchItemIds: [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9],
        pageSize: 10,
      },
      ctx,
    );

    assert.isTrue(result.ok);
    assert.deepEqual(applied, [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9]);
    assert.deepEqual(
      checkpoints.map((checkpoint) => ({
        cursor: checkpoint.cursor,
        remainingItemIds: checkpoint.plan?.remainingItemIds,
      })),
      [
        {
          cursor: 0,
          remainingItemIds: [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9],
        },
        { cursor: 10, remainingItemIds: [9] },
        { cursor: 11, remainingItemIds: [] },
      ],
    );
  });

  it("targets explicit paper itemIds, filters non-papers, and includes already-tagged papers", async function () {
    const registry = new AgentToolRegistry();
    let applyArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          applyArgs = input;
          return {
            result: {
              updatedCount: 1,
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(2) || itemIds.includes(1)
            ? [
                makeBibliographicTarget(2, "Tagged Paper", ["existing"]),
                makeBibliographicTarget(1, "Untagged Paper"),
              ]
            : [],
        getEditableArticleMetadata: (item: { id: number } | null) => ({
          fields: {
            abstractNote:
              item?.id === 2 ? "Already tagged abstract" : "Fresh abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
    });

    const result = await autoTagAction.execute({ itemIds: [2, 3, 1] }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      (applyArgs?.assignments as Array<Record<string, unknown>>).map(
        (entry) => entry.itemId,
      ),
      [2, 1],
    );
    assert.deepEqual(result.output, {
      targeted: 2,
      tagged: 1,
      skipped: 1,
    });
  });

  it("uses selected collection context by default in library chat and preserves the requested limit", async function () {
    const registry = new AgentToolRegistry();
    let applyArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          applyArgs = input;
          return {
            result: {
              updatedCount: 1,
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [
            makeBibliographicTarget(31, "Newest Collection Paper", [], [55]),
            makeBibliographicTarget(22, "Outside Selection"),
            makeBibliographicTarget(11, "Older Collection Paper", [], [55]),
          ],
          totalCount: 3,
        }),
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "Collection-scoped abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestContext: {
        mode: "library",
        selectedCollectionContexts: [
          { collectionId: 55, name: "Selected", libraryID: 1 },
        ],
      },
    });

    const result = await autoTagAction.execute({ limit: 1 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      (applyArgs?.assignments as Array<Record<string, unknown>>).map(
        (entry) => entry.itemId,
      ),
      [31],
    );
    assert.deepEqual(result.output, {
      targeted: 1,
      tagged: 1,
      skipped: 0,
    });
  });

  it("uses selected tag context by default in library chat and preserves the requested limit", async function () {
    const registry = new AgentToolRegistry();
    let applyArgs: Record<string, unknown> | null = null;
    let tagContextName = "";

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          applyArgs = input;
          return {
            result: {
              updatedCount: 2,
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listTagItemTargets: async ({
          tagContext,
        }: {
          tagContext: { name: string };
        }) => {
          tagContextName = tagContext.name;
          return {
            tagName: tagContext.name,
            totalCount: 3,
            items: [
              makeBibliographicTarget(31, "Newest Stable Paper", ["Stable"]),
              makeBibliographicTarget(22, "Middle Stable Paper", ["Stable"]),
              makeBibliographicTarget(11, "Older Stable Paper", ["Stable"]),
            ],
          };
        },
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "Tag-scoped abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestContext: {
        mode: "library",
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
        ],
      },
    });

    const result = await autoTagAction.execute({ limit: 2 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(tagContextName, "Stable");
    assert.deepEqual(
      (applyArgs?.assignments as Array<Record<string, unknown>>).map(
        (entry) => entry.itemId,
      ),
      [31, 22],
    );
    assert.deepEqual(result.output, {
      targeted: 2,
      tagged: 2,
      skipped: 0,
    });
  });

  it("defaults to the active paper in paper chat even when other refs are present", async function () {
    const registry = new AgentToolRegistry();
    let applyArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          applyArgs = input;
          return {
            result: {
              updatedCount: 1,
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(77)
            ? [makeBibliographicTarget(77, "Current Paper")]
            : [],
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "Current paper abstract" },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestContext: {
        mode: "paper",
        activeItemId: 77,
        selectedPaperContexts: [
          { itemId: 88, contextItemId: 9901, title: "Other Selected Paper" },
        ],
        selectedCollectionContexts: [
          { collectionId: 99, name: "Extra Collection", libraryID: 1 },
        ],
      },
    });

    const result = await autoTagAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      (applyArgs?.assignments as Array<Record<string, unknown>>).map(
        (entry) => entry.itemId,
      ),
      [77],
    );
    assert.deepEqual(result.output, {
      targeted: 1,
      tagged: 1,
      skipped: 0,
    });
  });

  it("targets the active paper even when it has no PDF attachment", async function () {
    const registry = new AgentToolRegistry();
    let applyArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          applyArgs = input;
          return {
            result: {
              updatedCount: 1,
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(77)
            ? [makeBibliographicTarget(77, "Metadata-only Paper")]
            : [],
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "Metadata-only abstract" },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestContext: {
        mode: "paper",
        activeItemId: 77,
      },
    });

    const result = await autoTagAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      (applyArgs?.assignments as Array<Record<string, unknown>>).map(
        (entry) => entry.itemId,
      ),
      [77],
    );
    assert.deepEqual(result.output, {
      targeted: 1,
      tagged: 1,
      skipped: 0,
    });
  });

  it("opens a manual review card with empty starter tags when no LLM suggestions are available", async function () {
    const registry = new AgentToolRegistry();

    registry.register({
      spec: {
        name: "apply_tags",
        description: "apply tags",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: true,
      },
      validate(args) {
        return ok(
          args as {
            action: "add";
            assignments: Array<{ itemId: number; tags: string[] }>;
          },
        );
      },
      createPendingAction(input) {
        return {
          toolName: "apply_tags",
          title: "Review tag additions",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "tag_assignment_table",
              id: "tagAssignments:apply_tags",
              label: "Suggested tags to add",
              rows: input.assignments.map((assignment) => ({
                id: `${assignment.itemId}`,
                label: `Paper ${assignment.itemId}`,
                value: assignment.tags,
              })),
            },
          ],
        };
      },
      applyConfirmation(input, resolutionData) {
        const data = resolutionData as Record<string, unknown>;
        const rows = Array.isArray(data["tagAssignments:apply_tags"])
          ? (data["tagAssignments:apply_tags"] as Array<
              Record<string, unknown>
            >)
          : [];
        return ok({
          ...input,
          assignments: rows.map((row) => ({
            itemId: Number(row.id),
            tags: Array.isArray(row.value)
              ? row.value.filter(
                  (tag): tag is string => typeof tag === "string",
                )
              : [],
          })),
        });
      },
      async execute(input) {
        return {
          content: {
            result: {
              updatedCount: input.assignments.filter(
                (entry) => entry.tags.length > 0,
              ).length,
            },
          },
          effect: "applied",
        };
      },
    });

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [
            makeBibliographicTarget(1, "Paper One"),
            makeBibliographicTarget(2, "Paper Two", ["already-tagged"]),
          ],
          totalCount: 2,
        }),
        getEditableArticleMetadata: (item: { id: number } | null) => ({
          fields: {
            abstractNote:
              item?.id === 1 ? "Paper one abstract" : "Paper two abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async (_requestId, action) => {
        const field = action.fields[0] as Extract<
          (typeof action.fields)[number],
          { type: "tag_assignment_table" }
        >;
        assert.equal(field.type, "tag_assignment_table");
        assert.deepEqual(
          field.rows.map((row) => row.value),
          [[], []],
        );
        return {
          approved: true,
          data: {
            [field.id]: [
              { id: "1", value: ["machine learning"] },
              { id: "2", value: [] },
            ],
          },
        };
      },
    });

    const result = await autoTagAction.execute({ scope: "all", limit: 2 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output, {
      targeted: 2,
      tagged: 1,
      skipped: 1,
    });
  });

  it("tells the user when the model was unreachable instead of reporting no tags", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "apply_tags",
        description: "apply tags",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: true,
      },
      validate(args) {
        return ok(
          args as {
            action: "add";
            assignments: Array<{ itemId: number; tags: string[] }>;
          },
        );
      },
      createPendingAction(input) {
        return {
          toolName: "apply_tags",
          title: "Review tag additions",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "tag_assignment_table",
              id: "tagAssignments:apply_tags",
              label: "Suggested tags to add",
              rows: input.assignments.map((assignment) => ({
                id: `${assignment.itemId}`,
                label: `Paper ${assignment.itemId}`,
                value: assignment.tags,
              })),
            },
          ],
        };
      },
      applyConfirmation(input) {
        return ok(input);
      },
      async execute() {
        return {
          content: { result: { updatedCount: 0 } },
          effect: "none",
        };
      },
    });

    const { ctx, progress } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [makeBibliographicTarget(1, "Paper One")],
          totalCount: 1,
        }),
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "Paper one abstract" },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      llm: {
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
        llmCall: async () => {
          throw new Error("401 Unauthorized - Incorrect API key provided");
        },
      },
      requestConfirmation: async () => ({ approved: false }),
    });

    await autoTagAction.execute({ scope: "all", limit: 1 }, ctx);

    // Swallowing the failure into "" would leave the user with a green
    // "No tags applied" card and no hint the key is wrong.
    const summaries = progress
      .map((event) => (event as { summary?: string }).summary || "")
      .filter(Boolean);
    const unavailable = summaries.find((summary) =>
      summary.includes("AI suggestions unavailable"),
    );
    assert.isString(
      unavailable,
      `expected an unavailable notice, saw: ${summaries.join(" | ")}`,
    );
    assert.include(unavailable || "", "Incorrect API key");
  });

  it("navigates to the next page without applying current-page tags", async function () {
    const registry = new AgentToolRegistry();
    const executedItemIds: number[] = [];
    registerReviewApplyTagsTool(registry, (input) => {
      executedItemIds.push(
        ...input.assignments.map((assignment) => assignment.itemId),
      );
    });

    let confirmationCount = 0;
    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: Array.from({ length: 11 }, (_entry, index) =>
            makeBibliographicTarget(
              index + 1,
              `Neural Memory Paper ${index + 1}`,
            ),
          ),
          totalCount: 11,
        }),
        listLibraryTags: async () => [{ name: "neural memory", type: 0 }],
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "A neural memory paper with learning dynamics",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async () => {
        confirmationCount += 1;
        return confirmationCount === 1
          ? { approved: false, actionId: "next", data: {} }
          : { approved: true, actionId: "confirm", data: {} };
      },
    });

    const result = await autoTagAction.execute(
      { scope: "all", pageSize: 1 },
      ctx,
    );

    assert.isTrue(result.ok);
    assert.deepEqual(executedItemIds, [1]);
  });

  it("applies the current page on confirm and then advances", async function () {
    const registry = new AgentToolRegistry();
    const executedPages: number[][] = [];
    registerReviewApplyTagsTool(registry, (input) => {
      executedPages.push(
        input.assignments.map((assignment) => assignment.itemId),
      );
    });

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: Array.from({ length: 11 }, (_entry, index) =>
            makeBibliographicTarget(
              index + 1,
              `Neural Memory Paper ${index + 1}`,
            ),
          ),
          totalCount: 11,
        }),
        listLibraryTags: async () => [{ name: "neural memory", type: 0 }],
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "A neural memory paper with learning dynamics",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async () => ({
        approved: true,
        actionId: "confirm",
        data: {},
      }),
    });

    const result = await autoTagAction.execute(
      { scope: "all", pageSize: 1 },
      ctx,
    );

    assert.isTrue(result.ok);
    assert.deepEqual(executedPages, [[11, 10, 9, 8, 7, 6, 5, 4, 3, 2], [1]]);
    if (!result.ok) return;
    assert.deepInclude(result.output, {
      targeted: 11,
      tagged: 11,
      skipped: 0,
    });
  });

  it("continues from the next unprocessed item when page size changes", async function () {
    const registry = new AgentToolRegistry();
    const executedPages: number[][] = [];
    registerReviewApplyTagsTool(registry, (input) => {
      executedPages.push(
        input.assignments.map((assignment) => assignment.itemId),
      );
    });

    let confirmationCount = 0;
    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: Array.from({ length: 60 }, (_entry, index) =>
            makeBibliographicTarget(
              index + 1,
              `Neural Memory Paper ${index + 1}`,
            ),
          ),
          totalCount: 60,
        }),
        listLibraryTags: async () => [{ name: "neural memory", type: 0 }],
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "A neural memory paper with learning dynamics",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async () => {
        confirmationCount += 1;
        return {
          approved: true,
          actionId: "confirm",
          data: confirmationCount === 1 ? { pageSize: 50 } : {},
        };
      },
    });

    const result = await autoTagAction.execute(
      { scope: "all", pageSize: 20 },
      ctx,
    );

    assert.isTrue(result.ok);
    assert.deepEqual(executedPages, [
      Array.from({ length: 20 }, (_entry, index) => 60 - index),
      Array.from({ length: 40 }, (_entry, index) => 40 - index),
    ]);
    if (!result.ok) return;
    assert.deepInclude(result.output, {
      targeted: 60,
      tagged: 60,
      skipped: 0,
    });
  });

  it("cancels without applying current-page tags", async function () {
    const registry = new AgentToolRegistry();
    let executeCalls = 0;
    registerReviewApplyTagsTool(registry, () => {
      executeCalls += 1;
    });

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [makeBibliographicTarget(1, "Neural Memory Paper")],
          totalCount: 1,
        }),
        listLibraryTags: async () => [{ name: "neural memory", type: 0 }],
        getEditableArticleMetadata: () => ({
          fields: {
            abstractNote: "A neural memory paper with learning dynamics",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async () => ({
        approved: false,
        actionId: "cancel",
        data: {},
      }),
    });

    const result = await autoTagAction.execute(
      { scope: "all", pageSize: 1 },
      ctx,
    );

    assert.isTrue(result.ok);
    assert.equal(executeCalls, 0);
    if (!result.ok) return;
    assert.equal(result.output.stopped, true);
    assert.equal(result.output.tagged, 0);
  });

  /**
   * `ctx.signal` reached the LLM batch helper but never the outer page loop,
   * so pressing Stop mid-page aborted the model calls, fell back to
   * deterministic tags, and then *still opened the confirmation card* as if
   * nothing had happened. Stop has to stop.
   */
  it("stops before opening a confirmation card when the run is aborted", async function () {
    const registry = new AgentToolRegistry();
    const executedItemIds: number[] = [];
    registerReviewApplyTagsTool(registry, (input) => {
      executedItemIds.push(
        ...input.assignments.map((assignment) => assignment.itemId),
      );
    });

    const controller = new AbortController();
    controller.abort();

    let confirmationCount = 0;
    const { ctx } = createActionContext(registry, {
      signal: controller.signal,
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: Array.from({ length: 6 }, (_entry, index) =>
            makeBibliographicTarget(index + 1, `Paper ${index + 1}`),
          ),
          totalCount: 6,
        }),
        listLibraryTags: async () => [{ name: "existing", type: 0 }],
        getEditableArticleMetadata: () => ({
          fields: { abstractNote: "An abstract" },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async () => {
        confirmationCount += 1;
        return { approved: true, actionId: "confirm", data: {} };
      },
    });

    const result = await autoTagAction.execute(
      { scope: "all", pageSize: 2 },
      ctx,
    );

    assert.equal(
      confirmationCount,
      0,
      "an aborted run must not ask the user to approve anything",
    );
    assert.deepEqual(executedItemIds, [], "nothing may be applied after Stop");
    assert.isTrue(result.ok);
    assert.equal(
      (result.output as { stopped?: boolean } | undefined)?.stopped,
      true,
      "the result should report that the run was stopped",
    );
  });
});
