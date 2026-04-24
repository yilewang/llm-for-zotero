import { assert } from "chai";
import { completeMetadataAction } from "../src/agent/actions/completeMetadata";
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

function makeBibliographicTarget(
  itemId: number,
  title: string,
  collectionIds: number[] = [],
  withPdf = false,
) {
  return {
    itemId,
    itemType: "journalArticle",
    title,
    firstCreator: "Alice Example",
    year: "2024",
    attachments: withPdf
      ? [{
          contextItemId: itemId + 1000,
          title: `${title} PDF`,
          contentType: "application/pdf",
        }]
      : [],
    tags: [],
    collectionIds,
  };
}

function ok<T>(value: T): AgentToolInputValidation<T> {
  return { ok: true, value };
}

describe("completeMetadata action", function () {
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
                  { creatorType: "author", name: "Existing Author", fieldMode: 1 },
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
                  { creatorType: "author", name: "Remote Author", fieldMode: 1 },
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
          itemIds.includes(101) ? [makeBibliographicTarget(101, "Existing Paper")] : [],
      } as never,
    });

    const result = await completeMetadataAction.execute({ itemId: 101 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations = (updateArgs?.operations as Array<Record<string, unknown>>) || [];
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
          itemIds.includes(77) ? [makeBibliographicTarget(77, "Current Paper")] : [],
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
    const operations = (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(operations.map((entry) => entry.itemId), [77]);
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
          results: [{
            patch: {
              abstractNote: input.doi === "10.1000/p1" ? "Abstract one" : "Abstract two",
            },
          }],
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
              makeBibliographicTarget(itemId, itemId === 1 ? "Paper One" : "Paper Two"),
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
    const operations = (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(operations.map((entry) => entry.itemId), [1, 2]);
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

    const result = await completeMetadataAction.execute({
      collectionIds: [55],
      limit: 1,
    }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations = (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(operations.map((entry) => entry.itemId), [31]);
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
          items: [
            makeBibliographicTarget(7, "Newest Paper"),
          ],
          totalCount: 1,
        }),
      } as never,
    });

    const result = await completeMetadataAction.execute({ scope: "all", limit: 1 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    const operations = (updateArgs?.operations as Array<Record<string, unknown>>) || [];
    assert.deepEqual(operations.map((entry) => entry.itemId), [7]);
    assert.equal(result.output.targeted, 1);
    assert.equal(result.output.updated, 1);
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
                  { creatorType: "author", name: "Existing Author", fieldMode: 1 },
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
          itemIds.includes(301) ? [makeBibliographicTarget(301, "Complete Paper", [], true)] : [],
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
