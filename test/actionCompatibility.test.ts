import { assert } from "chai";
import { auditLibraryAction } from "../src/agent/actions/auditLibrary";
import { autoTagAction } from "../src/agent/actions/autoTag";
import { discoverRelatedAction } from "../src/agent/actions/discoverRelated";
import { organizeUnfiledAction } from "../src/agent/actions/organizeUnfiled";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  ActionExecutionContext,
  ActionProgressEvent,
} from "../src/agent/actions/types";
import type { AgentToolDefinition } from "../src/agent/types";

function createStubTool<TInput extends Record<string, unknown>, TResult>(
  spec: AgentToolDefinition<TInput, TResult>["spec"],
  validate: AgentToolDefinition<TInput, TResult>["validate"],
  execute: AgentToolDefinition<TInput, TResult>["execute"],
): AgentToolDefinition<TInput, TResult> {
  return {
    spec,
    validate,
    execute,
  };
}

function createActionContext(
  registry: AgentToolRegistry,
  requestConfirmation: ActionExecutionContext["requestConfirmation"] = async () => ({
    approved: true,
  }),
) {
  const progress: ActionProgressEvent[] = [];
  const ctx: ActionExecutionContext = {
    registry,
    zoteroGateway: {} as never,
    services: {} as never,
    libraryID: 1,
    confirmationMode: "native_ui",
    onProgress: (event) => {
      progress.push(event);
    },
    requestConfirmation,
  };
  return { ctx, progress };
}

describe("action compatibility after tool refactors", function () {
  it("discover_related reads nested read_library results and uses nested import counts", async function () {
    const registry = new AgentToolRegistry();
    let searchArgs: Record<string, unknown> | null = null;
    let importArgs: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: {
            "101": {
              metadata: {
                title: "Seed Paper",
                fields: {
                  DOI: "10.1000/seed",
                },
                creators: [],
              },
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
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async (input) => {
          searchArgs = input;
          return {
            results: [
              {
                title: "Related One",
                doi: "10.1000/r1",
                authors: ["Alice Example"],
                year: 2024,
              },
              {
                title: "Related Two",
                doi: "10.1000/r2",
                authors: ["Bob Example"],
                year: 2023,
              },
            ],
          };
        },
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "import_identifiers",
          description: "import",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async (input) => {
          importArgs = input;
          return {
            result: {
              succeeded: 1,
              failed: 1,
              itemIds: [501],
            },
          };
        },
      ),
    );

    const { ctx } = createActionContext(registry, async () => ({
      approved: true,
      actionId: "import",
      data: {
        selectedPaperIds: ["paper-1", "paper-2"],
      },
    }));

    const result = await discoverRelatedAction.execute({ itemId: 101 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(searchArgs?.doi, "10.1000/seed");
    assert.deepEqual(
      importArgs?.identifiers,
      ["10.1000/r1", "10.1000/r2"],
    );
    assert.deepEqual(result.output, {
      seedTitle: "Seed Paper",
      discovered: 2,
      imported: 1,
    });
  });

  it("organize_unfiled reads collectionId summaries and nested move counts", async function () {
    const registry = new AgentToolRegistry();
    let queryCalls = 0;
    const { ctx, progress } = createActionContext(registry);

    registry.register(
      createStubTool(
        {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => {
          queryCalls += 1;
          if (queryCalls === 1) {
            return {
              results: [{ itemId: 1 }, { itemId: 2 }, { itemId: 3 }],
            };
          }
          return {
            results: [
              { collectionId: 11, name: "Memory" },
              { collectionId: 12, name: "Dynamics" },
            ],
          };
        },
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "move_to_collection",
          description: "move",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          result: {
            selectedCount: 3,
            movedCount: 2,
            skippedCount: 1,
          },
        }),
      ),
    );

    const result = await organizeUnfiledAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output, {
      unfiled: 3,
      moved: 2,
      remaining: 1,
    });
    assert.include(
      progress
        .filter((event) => event.type === "step_done")
        .map((event) => ("summary" in event ? event.summary : "")),
      "2 collections available",
    );
  });

  it("auto_tag uses nested tag update counts from apply_tags", async function () {
    const registry = new AgentToolRegistry();

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          result: {
            selectedCount: 3,
            updatedCount: 2,
            skippedCount: 1,
          },
        }),
      ),
    );

    const { ctx } = createActionContext(registry);
    ctx.zoteroGateway = {
      listBibliographicItemTargets: async () => ({
        items: [
          {
            itemId: 1,
            itemType: "journalArticle",
            title: "Paper One",
            firstCreator: "Alice Example",
            year: "2024",
            attachments: [],
            tags: [],
            collectionIds: [],
          },
          {
            itemId: 2,
            itemType: "journalArticle",
            title: "Paper Two",
            firstCreator: "Bob Example",
            year: "2023",
            attachments: [],
            tags: ["existing"],
            collectionIds: [],
          },
          {
            itemId: 3,
            itemType: "journalArticle",
            title: "Paper Three",
            firstCreator: "Cara Example",
            year: "2022",
            attachments: [],
            tags: [],
            collectionIds: [],
          },
        ],
        totalCount: 3,
      }),
      getEditableArticleMetadata: () => ({
        fields: {
          abstractNote: "Abstract",
        },
      }),
      getItem: (itemId: number) => ({ id: itemId }),
    } as never;
    const result = await autoTagAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output, {
      targeted: 3,
      tagged: 2,
      skipped: 1,
    });
  });

  it("audit_library still succeeds when save_note returns status without a note id", async function () {
    const registry = new AgentToolRegistry();

    registry.register(
      createStubTool(
        {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: [
            {
              itemId: 11,
              title: "Incomplete Paper",
              metadata: {
                title: "Incomplete Paper",
                fields: {
                  DOI: "",
                  url: "",
                  abstractNote: "",
                },
                creators: [],
              },
              tags: [],
              attachments: [],
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "edit_current_note",
          description: "edit note",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          result: {
            status: "standalone_created",
          },
        }),
      ),
    );

    const { ctx } = createActionContext(registry);
    const result = await auditLibraryAction.execute({ saveNote: true }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output, {
      total: 1,
      itemsWithIssues: 1,
      issues: [
        {
          itemId: 11,
          title: "Incomplete Paper",
          missingFields: ["abstract", "DOI/URL", "tags", "PDF"],
        },
      ],
      noteId: undefined,
    });
  });

  it("discover_related surfaces failure when every search mode fails", async function () {
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
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: {
            "101": {
              metadata: {
                title: "Seed Paper",
                fields: { DOI: "10.1000/seed" },
                creators: [],
              },
            },
          },
        }),
      ),
    );

    // Every fetchMode call throws → registry returns ok: false for all three.
    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => {
          throw new Error("OpenAlex unreachable");
        },
      ),
    );

    const { ctx } = createActionContext(registry);
    const result = await discoverRelatedAction.execute({ itemId: 101 }, ctx);

    assert.isFalse(
      result.ok,
      "action must fail when every search mode fails (currently collapses to empty-success)",
    );
  });

  it("discover_related does not import when the load_more iteration cap is hit", async function () {
    const registry = new AgentToolRegistry();
    let importCalls = 0;

    registry.register(
      createStubTool(
        {
          name: "read_library",
          description: "read",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: {
            "101": {
              metadata: {
                title: "Seed Paper",
                fields: { DOI: "10.1000/seed" },
                creators: [],
              },
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
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: [
            { title: "P1", doi: "10.1000/p1", authors: [], year: 2024 },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "import_identifiers",
          description: "import",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => {
          importCalls += 1;
          return {
            result: { succeeded: 1, failed: 0, itemIds: [501] },
          };
        },
      ),
    );

    // User keeps clicking "Load more" forever → loop must exit via the
    // iteration cap and NOT fall through into the import branch.
    const { ctx } = createActionContext(registry, async () => ({
      approved: true,
      actionId: "load_more",
      data: { selectedPaperIds: ["recommendations-1"] },
    }));

    const result = await discoverRelatedAction.execute({ itemId: 101 }, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(
      result.output.imported,
      0,
      "must not import after load_more cap — no explicit import confirmation",
    );
    assert.equal(
      importCalls,
      0,
      "import_identifiers must not be called when cap is hit",
    );
  });
});
