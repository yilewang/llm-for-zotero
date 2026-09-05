import { assert } from "chai";
import { auditLibraryAction } from "../src/agent/actions/auditLibrary";
import { autoTagAction } from "../src/agent/actions/autoTag";
import { discoverRelatedAction } from "../src/agent/actions/discoverRelated";
import { organizeUnfiledAction } from "../src/agent/actions/organizeUnfiled";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type {
  ActionExecutionContext,
  ActionProgressEvent,
} from "../src/agent/actions/types";
import type { AgentToolDefinition } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

function createStubTool<TInput extends Record<string, unknown>, TResult>(
  spec: AgentToolDefinition<TInput, TResult>["spec"],
  validate: AgentToolDefinition<TInput, TResult>["validate"],
  execute: (
    input: TInput,
    context: Parameters<AgentToolDefinition<TInput, TResult>["execute"]>[1],
  ) => TResult | Promise<TResult>,
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
    assert.deepEqual(importArgs?.identifiers, ["10.1000/r1", "10.1000/r2"]);
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
      processed: 3,
      skippedUnmatched: undefined,
      stopped: undefined,
    });
    assert.include(
      progress
        .filter((event) => event.type === "step_done")
        .map((event) => ("summary" in event ? event.summary : "")),
      "Moved 2 items",
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
    let invalidations = 0;
    let listedAfterInvalidation = false;
    ctx.zoteroGateway = {
      invalidateLibrarySearchCache: () => {
        invalidations += 1;
      },
      listBibliographicItemTargets: async () => {
        listedAfterInvalidation = invalidations > 0;
        return {
          items: [
            {
              itemId: 1,
              itemType: "journalArticle",
              title: "Hippocampal Memory Consolidation",
              firstCreator: "Alice Example",
              year: "2024",
              attachments: [],
              tags: [],
              collectionIds: [],
            },
            {
              itemId: 2,
              itemType: "journalArticle",
              title: "Neural Drift Dynamics",
              firstCreator: "Bob Example",
              year: "2023",
              attachments: [],
              tags: ["existing"],
              collectionIds: [],
            },
            {
              itemId: 3,
              itemType: "journalArticle",
              title: "Cortical Representational Stability",
              firstCreator: "Cara Example",
              year: "2022",
              attachments: [],
              tags: [],
              collectionIds: [],
            },
          ],
          totalCount: 3,
        };
      },
      getEditableArticleMetadata: () => ({
        fields: {
          abstractNote:
            "Memory consolidation and neural drift dynamics in cortical representations.",
        },
      }),
      getItem: (itemId: number) => ({ id: itemId }),
    } as never;
    const result = await autoTagAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.isAtLeast(invalidations, 1);
    assert.isTrue(listedAfterInvalidation);
    assert.deepInclude(result.output, {
      targeted: 3,
      tagged: 2,
      skipped: 1,
    });
  });

  it("auto_tag refresh reloads library targets before rebuilding the current page", async function () {
    const registry = new AgentToolRegistry();
    let applyCalls = 0;

    registry.register(
      createStubTool(
        {
          name: "apply_tags",
          description: "apply tags",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: true,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          result: {
            selectedCount: 1,
            updatedCount: 1,
            skippedCount: 0,
          },
        }),
      ),
    );
    registry.getTool("apply_tags")!.createPendingAction = () => ({
      toolName: "apply_tags",
      mode: "review",
      title: "Page 1 of 1: Add tags",
      fields: [],
      actions: [
        { id: "confirm", label: "Confirm" },
        { id: "refresh", label: "Refresh", approved: false },
        { id: "cancel", label: "Cancel", approved: false },
      ],
      defaultActionId: "confirm",
      cancelActionId: "cancel",
    });

    const { ctx } = createActionContext(registry, async () => {
      applyCalls += 1;
      return applyCalls === 1
        ? { approved: false, actionId: "refresh", data: {} }
        : { approved: true, actionId: "confirm", data: {} };
    });
    let listCalls = 0;
    ctx.zoteroGateway = {
      invalidateLibrarySearchCache: () => undefined,
      listBibliographicItemTargets: async () => {
        listCalls += 1;
        const title =
          listCalls === 1
            ? "Initial Hippocampal Memory"
            : "Fresh Collection Item";
        return {
          items: [
            {
              itemId: listCalls,
              itemType: "journalArticle",
              title,
              firstCreator: "Alice Example",
              year: "2024",
              attachments: [],
              tags: [],
              collectionIds: [],
            },
          ],
          totalCount: 1,
        };
      },
      getEditableArticleMetadata: () => ({
        fields: { abstractNote: "memory dynamics" },
      }),
      getItem: (itemId: number) => ({ id: itemId }),
    } as never;

    const result = await autoTagAction.execute({}, ctx);

    assert.isTrue(result.ok);
    assert.isAtLeast(listCalls, 2);
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
              attachments: [],
              tags: [],
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

    const { ctx, progress } = createActionContext(registry);
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
          missingFields: [
            "creators",
            "date/year",
            "abstract",
            "DOI/URL",
            "publication venue",
            "tags",
            "PDF",
          ],
        },
      ],
      metadataFixed: 0,
      fixable: 0,
      skipped: 1,
      remaining: 1,
      stopped: undefined,
      noteId: undefined,
    });
    assert.notInclude(
      progress
        .filter((event) => event.type === "step_done")
        .map((event) => ("summary" in event ? event.summary : "")),
      "No fixable metadata changes for this page",
    );
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

  it("discover_related treats load more as best-effort and hides it once results stop growing to the limit", async function () {
    const registry = new AgentToolRegistry();
    const searchedLimits: number[] = [];

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
        async (input) => {
          const limit = Number(input.limit || 20);
          searchedLimits.push(limit);
          const returnedCount = limit >= 40 ? 21 : limit;
          return {
            results: Array.from({ length: returnedCount }, (_entry, index) => ({
              title: `Related ${index + 1}`,
              doi: `10.1000/${input.mode}-${index + 1}`,
              authors: [],
              year: 2024,
            })),
          };
        },
      ),
    );

    let reviewCount = 0;
    const { ctx } = createActionContext(
      registry,
      async (_requestId, action) => {
        const field = action.fields[0] as {
          loadMoreActionId?: string;
          loadMoreLabel?: string;
        };
        reviewCount += 1;
        if (reviewCount === 1) {
          assert.equal(field.loadMoreActionId, "load_more");
          assert.equal(field.loadMoreLabel, "Load more");
          return {
            approved: true,
            actionId: "load_more",
            data: { selectedPaperIds: [] },
          };
        }
        assert.isUndefined(field.loadMoreActionId);
        assert.equal(field.loadMoreLabel, "Load more");
        return {
          approved: false,
          actionId: "cancel",
          data: { selectedPaperIds: [] },
        };
      },
    );

    const result = await discoverRelatedAction.execute({ itemId: 101 }, ctx);

    assert.isTrue(result.ok);
    assert.includeMembers(searchedLimits, [20, 40]);
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
