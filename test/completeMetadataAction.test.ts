import { assert } from "chai";
import { completeMetadataAction } from "../src/agent/actions/completeMetadata";
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

function makeBibliographicTarget(
  itemId: number,
  title: string,
  collectionIds: number[] = [],
  withPdf = false,
  libraryID = 1,
) {
  return {
    itemId,
    libraryID,
    itemType: "journalArticle",
    title,
    firstCreator: "Alice Example",
    year: "2024",
    attachments: withPdf
      ? [
          {
            contextItemId: itemId + 1000,
            title: `${title} PDF`,
            contentType: "application/pdf",
          },
        ]
      : [],
    tags: [],
    collectionIds,
  };
}

function ok<T>(value: T): AgentToolInputValidation<T> {
  return { ok: true, value };
}

describe("completeMetadata action", function () {
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

  it("supports legacy itemId input and only fills empty fields", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "101": {
              metadata: {
                title: "Existing Paper",
                fields: {
                  DOI: "10.1000/example",
                  abstractNote: "",
                  publicationTitle: "Existing Journal",
                  date: "",
                },
                creators: [
                  {
                    creatorType: "author",
                    name: "Existing Author",
                    fieldMode: 1,
                  },
                ],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [
            {
              patch: {
                abstractNote: "Remote abstract",
                publicationTitle: "Remote Journal",
                date: "2024",
                creators: [
                  {
                    creatorType: "author",
                    name: "Remote Author",
                    fieldMode: 1,
                  },
                ],
              },
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return {
            results: [{ itemId: 101 }],
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(101)
            ? [makeBibliographicTarget(101, "Existing Paper")]
            : [],
      } as never,
    });

    const result = await completeMetadataAction.execute({ itemId: 101 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    const metadata = (operations[0]?.metadata as Record<string, unknown>) || {};
    assert.equal(operations.length, 1);
    assert.equal(operations[0].itemId, 101);
    assert.equal(metadata.abstractNote, "Remote abstract");
    assert.equal(metadata.date, "2024");
    assert.notProperty(metadata, "publicationTitle");
    assert.notProperty(metadata, "creators");
    assert.deepEqual(result.output, {
      targeted: 1,
      updated: 1,
      skipped: 0,
      errors: 0,
      items: [
        {
          itemId: 101,
          title: "Existing Paper",
          missingFields: ["abstract", "tags", "PDF"],
          patchedFields: ["abstractNote", "date"],
          updated: true,
        },
      ],
    });
  });

  it("defaults to the current paper in paper chat", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "77": {
              metadata: {
                title: "Current Paper",
                fields: {
                  DOI: "10.1000/current",
                  abstractNote: "",
                },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { abstractNote: "Filled from remote" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return { results: [{ itemId: 77 }] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(77)
            ? [makeBibliographicTarget(77, "Current Paper")]
            : [],
        getItem: (itemId: number) => ({ id: itemId }),
      } as never,
      requestContext: {
        mode: "paper",
        activeItemId: 77,
        selectedPaperContexts: [
          { itemId: 88, contextItemId: 9901, title: "Other Selected Paper" },
        ],
      },
    });

    const result = await completeMetadataAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      operations.map((entry) => entry.itemId),
      [77],
    );
    assert.equal(result.output.targeted, 1);
    assert.equal(result.output.updated, 1);
  });

  it("uses selected papers in library chat and batches updates into one review", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "1": {
              metadata: {
                title: "Paper One",
                fields: { DOI: "10.1000/p1", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
            "2": {
              metadata: {
                title: "Paper Two",
                fields: { DOI: "10.1000/p2", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => ({
          results: [
            {
              patch: {
                abstractNote:
                  input.doi === "10.1000/p1" ? "Abstract one" : "Abstract two",
              },
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return {
            results: [{ itemId: 1 }, { itemId: 2 }],
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds
            .filter((itemId) => itemId === 1 || itemId === 2)
            .map((itemId) =>
              makeBibliographicTarget(
                itemId,
                itemId === 1 ? "Paper One" : "Paper Two",
              ),
            ),
        listBibliographicItemTargets: async () => ({
          items: [
            makeBibliographicTarget(1, "Paper One"),
            makeBibliographicTarget(2, "Paper Two"),
            makeBibliographicTarget(3, "Paper Three"),
          ],
          totalCount: 3,
        }),
      } as never,
      requestContext: {
        mode: "library",
        selectedPaperContexts: [
          { itemId: 1, contextItemId: 9001, title: "Paper One" },
          { itemId: 2, contextItemId: 9002, title: "Paper Two" },
        ],
      },
    });

    const result = await completeMetadataAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      operations.map((entry) => entry.itemId),
      [1, 2],
    );
    assert.equal(result.output.targeted, 2);
    assert.equal(result.output.updated, 2);
  });

  it("honors explicit collection scope with limit", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "31": {
              metadata: {
                title: "Newest Collection Paper",
                fields: { DOI: "10.1000/c31", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { abstractNote: "Collection abstract" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return { results: [{ itemId: 31 }] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [
            makeBibliographicTarget(31, "Newest Collection Paper", [55]),
            makeBibliographicTarget(22, "Outside Selection", []),
            makeBibliographicTarget(11, "Older Collection Paper", [55]),
          ],
          totalCount: 3,
        }),
      } as never,
    });

    const result = await completeMetadataAction.execute(
      {
        collectionIds: [55],
        limit: 1,
      },
      ctx,
    );

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      operations.map((entry) => entry.itemId),
      [31],
    );
    assert.equal(result.output.targeted, 1);
    assert.equal(result.output.updated, 1);
  });

  it("honors explicit all-library scope with limit", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "7": {
              metadata: {
                title: "Newest Paper",
                fields: { DOI: "10.1000/new", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { abstractNote: "Newest abstract" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return { results: [{ itemId: 7 }] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        listBibliographicItemTargets: async () => ({
          items: [makeBibliographicTarget(7, "Newest Paper")],
          totalCount: 1,
        }),
      } as never,
    });

    const result = await completeMetadataAction.execute(
      { scope: "all", limit: 1 },
      ctx,
    );

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      operations.map((entry) => entry.itemId),
      [7],
    );
    assert.equal(result.output.targeted, 1);
    assert.equal(result.output.updated, 1);
  });

  it("keeps explicit item targets inside the active library", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "7": {
              metadata: {
                title: "Active Library Paper",
                fields: { DOI: "10.1000/active", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { abstractNote: "Active abstract" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return { results: [{ itemId: 7 }] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds
            .filter((itemId) => itemId === 7 || itemId === 8)
            .map((itemId) =>
              itemId === 7
                ? makeBibliographicTarget(
                    7,
                    "Active Library Paper",
                    [],
                    false,
                    1,
                  )
                : makeBibliographicTarget(
                    8,
                    "Other Library Paper",
                    [],
                    false,
                    2,
                  ),
            ),
      } as never,
    });

    const result = await completeMetadataAction.execute(
      { itemIds: [7, 8] },
      ctx,
    );

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(
      operations.map((entry) => entry.itemId),
      [7],
    );
    assert.equal(result.output.targeted, 1);
  });

  it("does not propose metadata fields unsupported by the item type", async function () {
    const registry = new AgentToolRegistry();
    let updateArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "401": {
              metadata: {
                title: "Book-like Item",
                fields: {
                  DOI: "",
                  abstractNote: "",
                  publicationTitle: "",
                  date: "",
                },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [
            {
              patch: {
                abstractNote: "Remote abstract",
                publicationTitle: "Journal-only value",
                date: "2023",
                creators: [
                  {
                    creatorType: "author",
                    name: "Remote Author",
                    fieldMode: 1,
                  },
                ],
              },
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async (input) => {
          updateArgs = input;
          return { results: [{ itemId: 401 }] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(401)
            ? [makeBibliographicTarget(401, "Book-like Item")]
            : [],
        getItem: (itemId: number) => ({ id: itemId, libraryID: 1 }),
        isEditableArticleMetadataFieldSupported: (
          _item: unknown,
          fieldName: string,
        ) => fieldName !== "publicationTitle",
        supportsEditableArticleCreators: () => false,
      } as never,
    });

    const result = await completeMetadataAction.execute({ itemId: 401 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations =
      (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    const metadata = (operations[0]?.metadata as Record<string, unknown>) || {};
    assert.equal(metadata.abstractNote, "Remote abstract");
    assert.equal(metadata.date, "2023");
    assert.notProperty(metadata, "publicationTitle");
    assert.notProperty(metadata, "creators");
  });

  it("surfaces metadata write failures instead of completing with a generic denial", async function () {
    const registry = new AgentToolRegistry();

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "501": {
              metadata: {
                title: "Failing Item",
                fields: { DOI: "", abstractNote: "" },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { abstractNote: "Remote abstract" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => {
          throw new Error(
            "Unsupported metadata fields for book: publicationTitle",
          );
        },
      ),
    );

    const { ctx, progress } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(501)
            ? [makeBibliographicTarget(501, "Failing Item")]
            : [],
      } as never,
    });

    const result = await completeMetadataAction.execute({ itemId: 501 }, ctx);

    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "Unsupported metadata fields for book");
    assert.deepInclude(progress, {
      type: "step_done",
      step: "Applying metadata updates",
      summary: "Unsupported metadata fields for book: publicationTitle",
    });
  });

  it("returns a no-op success when no target paper can be improved", async function () {
    const registry = new AgentToolRegistry();
    let updateCalled = false;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: {
            "301": {
              metadata: {
                title: "Complete Paper",
                fields: {
                  DOI: "10.1000/complete",
                  abstractNote: "Already complete",
                  publicationTitle: "Journal",
                  date: "2024",
                },
                creators: [
                  {
                    creatorType: "author",
                    name: "Existing Author",
                    fieldMode: 1,
                  },
                ],
              },
              tags: [{ tag: "done" }],
              attachments: [{ contentType: "application/pdf" }],
            },
          },
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => ({
          results: [{ patch: { publicationTitle: "Journal" } }],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "update",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ok(args as Record<string, unknown>),
        async () => {
          updateCalled = true;
          return { results: [] };
        },
      ),
    );

    const { ctx } = createActionContext(registry, {
      zoteroGateway: {
        getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
          itemIds.includes(301)
            ? [makeBibliographicTarget(301, "Complete Paper", [], true)]
            : [],
      } as never,
    });

    const result = await completeMetadataAction.execute({ itemId: 301 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.isFalse(updateCalled);
    assert.deepEqual(result.output, {
      targeted: 1,
      updated: 0,
      skipped: 1,
      errors: 0,
      items: [
        {
          itemId: 301,
          title: "Complete Paper",
          missingFields: [],
          patchedFields: [],
          updated: false,
        },
      ],
    });
  });
});
