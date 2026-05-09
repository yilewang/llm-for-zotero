import { assert } from "chai";
import { autoTagAction } from "../src/agent/actions/autoTag";
import type { ActionExecutionContext } from "../src/agent/actions";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../src/agent/types";

function createStubTool<TInput extends Record<string, unknown>, TResult>(
  spec: AgentToolDefinition<TInput, TResult>["spec"],
  validate: AgentToolDefinition<TInput, TResult>["validate"],
  execute: AgentToolDefinition<TInput, TResult>["execute"],
  extras: Partial<AgentToolDefinition<TInput, TResult>> = {},
): AgentToolDefinition<TInput, TResult> {
  return {
    spec,
    validate,
    execute,
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
    services: {} as never,
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
  attachments: Array<{ contextItemId: number; title: string; contentType: string }> = [],
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

describe("autoTag action", function () {
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
            abstractNote: item?.id === 2 ? "Already tagged abstract" : "Fresh abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
    });

    const result = await autoTagAction.execute({ itemIds: [2, 3, 1] }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual((applyArgs?.assignments as Array<Record<string, unknown>>).map(
      (entry) => entry.itemId,
    ), [2, 1]);
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
    assert.deepEqual((applyArgs?.assignments as Array<Record<string, unknown>>).map(
      (entry) => entry.itemId,
    ), [31]);
    assert.deepEqual(result.output, {
      targeted: 1,
      tagged: 1,
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
    assert.deepEqual((applyArgs?.assignments as Array<Record<string, unknown>>).map(
      (entry) => entry.itemId,
    ), [77]);
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
        return ok(args as {
          action: "add";
          assignments: Array<{ itemId: number; tags: string[] }>;
        });
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
          ? (data["tagAssignments:apply_tags"] as Array<Record<string, unknown>>)
          : [];
        return ok({
          ...input,
          assignments: rows.map((row) => ({
            itemId: Number(row.id),
            tags: Array.isArray(row.value)
              ? row.value.filter((tag): tag is string => typeof tag === "string")
              : [],
          })),
        });
      },
      async execute(input) {
        return {
          result: {
            updatedCount: input.assignments.filter((entry) => entry.tags.length > 0).length,
          },
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
            abstractNote: item?.id === 1 ? "Paper one abstract" : "Paper two abstract",
          },
        }),
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestConfirmation: async (_requestId, action) => {
        const field = action.fields[0] as Extract<
          typeof action.fields[number],
          { type: "tag_assignment_table" }
        >;
        assert.equal(field.type, "tag_assignment_table");
        assert.deepEqual(field.rows.map((row) => row.value), [[], []]);
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
});
