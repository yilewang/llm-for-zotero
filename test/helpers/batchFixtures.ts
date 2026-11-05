import type { ActionExecutionContext } from "../../src/agent/actions";
import { autoTagAction } from "../../src/agent/actions/autoTag";
import type { AgentAction } from "../../src/agent/actions/types";
import {
  initAgentChangeJournal,
  listJournalActions,
  type JournalActionWithSteps,
} from "../../src/agent/store/changeJournal";
import { createBuiltInToolRegistry } from "../../src/agent/tools";
import type { AgentToolRegistry } from "../../src/agent/tools/registry";
import type { AgentToolContext } from "../../src/agent/types";
import { ChangeJournalTestDb } from "./changeJournalTestDb";

/**
 * Batch actions driven end to end through the production tool registry, a
 * durable journal, and an in-memory library standing in for Zotero.
 *
 * The seam is the gateway: it owns every item's tags, collections, and
 * metadata fields, so what a forward write and its undo do is observable as
 * plain values. Only tools that would leave the process (online literature
 * search) are replaced, and they are replaced on the registered facade, so a
 * call still has to name the facade to reach them.
 */

const CONVERSATION_KEY = 5_150;

export type FixtureItemSeed = {
  itemId: number;
  title?: string;
  fields?: Record<string, string>;
  tags?: string[];
  collectionIds?: number[];
};

export type FixtureCollectionSeed = {
  collectionId: number;
  name: string;
};

export type BatchLibrary = {
  tagsOf(itemId: number): string[];
  collectionsOf(itemId: number): number[];
  fieldsOf(itemId: number): Record<string, string>;
  importedIdentifiers: string[];
  conversationKey: number;
  zoteroGateway: Record<string, unknown>;
};

type ItemState = {
  title: string;
  fields: Record<string, string>;
  tags: string[];
  collectionIds: number[];
};

export function createBatchLibrary(
  seeds: FixtureItemSeed[],
  collections: FixtureCollectionSeed[] = [],
): BatchLibrary {
  const items = new Map<number, ItemState>(
    seeds.map((seed) => [
      seed.itemId,
      {
        title: seed.title || `Batch Paper ${seed.itemId}`,
        fields: {
          abstractNote: "An abstract about memory consolidation.",
          ...seed.fields,
        },
        tags: [...(seed.tags || [])],
        collectionIds: [...(seed.collectionIds || [])],
      },
    ]),
  );
  const importedIdentifiers: string[] = [];
  let nextImportedId = 9_000;
  const target = (itemId: number) => {
    const state = items.get(itemId)!;
    return {
      itemId,
      itemType: "journalArticle",
      title: state.title,
      firstCreator: "Alice Example",
      year: "2024",
      attachments: [],
      tags: [...state.tags],
      collectionIds: [...state.collectionIds],
    };
  };
  const item = (itemId: number) => {
    const state = items.get(itemId);
    if (!state) return null;
    return {
      id: itemId,
      libraryID: 1,
      key: `ITEM${itemId}`,
      itemType: "journalArticle",
      version: 1,
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
      isAnnotation: () => false,
      deleted: false,
      getField: (field: string) =>
        field === "title" ? state.title : state.fields[field] || "",
      getTags: () => state.tags.map((tag) => ({ tag })),
      getCollections: () => [...state.collectionIds],
    };
  };
  const metadataOf = (itemId: number) => {
    const state = items.get(itemId);
    return state
      ? {
          title: state.title,
          itemType: "journalArticle",
          fields: { title: state.title, ...state.fields },
          creators: [],
        }
      : null;
  };
  const zoteroGateway: Record<string, unknown> = {
    getItem: item,
    resolveLibraryID: () => 1,
    getAllChildAttachmentInfos: async () => [],
    getItemCollectionIds: (itemId: number) => [
      ...(items.get(itemId)?.collectionIds || []),
    ],
    resolveMetadataItem: (params: { itemId?: number }) =>
      params.itemId ? item(params.itemId) : null,
    resolveMetadataWriteTarget: (params: { itemId?: number }) => {
      const target = params.itemId ? item(params.itemId) : null;
      return target ? { item: target } : { refusal: "No item to update" };
    },
    getBibliographicItemTargetsByItemIds: (ids: number[]) =>
      ids.filter((id) => items.has(id)).map(target),
    getPaperTargetsByItemIds: (ids: number[]) =>
      ids.filter((id) => items.has(id)).map(target),
    getEditableArticleMetadata: (candidate: { id?: number } | null) =>
      candidate?.id ? metadataOf(candidate.id) : null,
    metadataPatchRefusal: () => null,
    updateArticleMetadata: async (params: {
      item: { id: number };
      metadata: Record<string, unknown>;
    }) => {
      const state = items.get(params.item.id)!;
      const updatedFields: string[] = [];
      for (const [field, value] of Object.entries(params.metadata)) {
        if (field === "creators") continue;
        if (field === "title") state.title = String(value);
        else state.fields[field] = String(value);
        updatedFields.push(field);
      }
      return { status: "updated", itemId: params.item.id, updatedFields };
    },
    listLibraryTagNames: async () => [],
    listCollectionSummaries: () =>
      collections.map((collection) => ({
        collectionId: collection.collectionId,
        name: collection.name,
        path: collection.name,
        libraryID: 1,
      })),
    getCollectionSummary: (collectionId: number) => {
      const collection = collections.find(
        (entry) => entry.collectionId === collectionId,
      );
      return collection
        ? {
            collectionId,
            name: collection.name,
            path: collection.name,
            libraryID: 1,
          }
        : null;
    },
    addItemsToCollections: async (params: {
      assignments: Array<{ itemId: number; targetCollectionId: number }>;
    }) => {
      const rows = params.assignments.map((assignment) => {
        const state = items.get(assignment.itemId)!;
        const added = !state.collectionIds.includes(
          assignment.targetCollectionId,
        );
        if (added) state.collectionIds.push(assignment.targetCollectionId);
        return {
          itemId: assignment.itemId,
          targetCollectionId: assignment.targetCollectionId,
          status: added ? "added" : "skipped",
        };
      });
      const movedCount = rows.filter((row) => row.status === "added").length;
      return {
        selectedCount: rows.length,
        movedCount,
        skippedCount: rows.length - movedCount,
        items: rows,
      };
    },
    importPapersByIdentifiers: async (identifiers: string[]) => {
      importedIdentifiers.push(...identifiers);
      const rows = identifiers.map((identifier) => ({
        identifier,
        status: "imported" as const,
        itemId: nextImportedId++,
      }));
      return {
        succeeded: rows.length,
        failed: 0,
        itemIds: rows.map((row) => row.itemId),
        items: rows,
      };
    },
    applyTagAssignments: async (params: {
      assignments: Array<{ itemId: number; tags: string[] }>;
    }) => {
      const rows = params.assignments.map((assignment) => {
        const state = items.get(assignment.itemId)!;
        const addedTags = assignment.tags.filter(
          (tag) => !state.tags.includes(tag),
        );
        state.tags.push(...addedTags);
        return {
          itemId: assignment.itemId,
          status: addedTags.length ? "updated" : "skipped",
          addedTags,
          skippedTags: assignment.tags.filter(
            (tag) => !addedTags.includes(tag),
          ),
        };
      });
      const updatedCount = rows.filter(
        (row) => row.status === "updated",
      ).length;
      return {
        updatedCount,
        skippedCount: rows.length - updatedCount,
        items: rows,
      };
    },
    removeTagsFromItem: async (params: { itemId: number; tags: string[] }) => {
      const state = items.get(params.itemId)!;
      const removed = state.tags.filter((tag) => params.tags.includes(tag));
      state.tags = state.tags.filter((tag) => !params.tags.includes(tag));
      return { removed };
    },
    setItemTags: async (params: {
      assignments: Array<{ itemId: number; tags: string[] }>;
    }) => {
      const rows = params.assignments.map((assignment) => {
        const state = items.get(assignment.itemId)!;
        const previousTags = state.tags;
        state.tags = [...assignment.tags];
        return {
          itemId: assignment.itemId,
          status: "updated",
          previousTags,
          tags: [...assignment.tags],
        };
      });
      return { updatedCount: rows.length, skippedCount: 0, items: rows };
    },
  };
  return {
    tagsOf: (itemId) => [...(items.get(itemId)?.tags || [])],
    collectionsOf: (itemId) => [...(items.get(itemId)?.collectionIds || [])],
    fieldsOf: (itemId) => ({ ...(items.get(itemId)?.fields || {}) }),
    importedIdentifiers,
    conversationKey: CONVERSATION_KEY,
    zoteroGateway,
  };
}

let installedDb: ChangeJournalTestDb | null = null;

/**
 * Approves a review card exactly as shown: every editable table submits its
 * rows unchanged and every other field its current value, which is what a
 * user clicking Apply without editing sends back.
 */
export const approveAsShown: ActionExecutionContext["requestConfirmation"] =
  async (_requestId, action) => {
    const data: Record<string, unknown> = {};
    for (const field of action.fields as Array<Record<string, unknown>>) {
      const id = String(field.id);
      if (Array.isArray(field.rows)) {
        data[id] = (field.rows as Array<Record<string, unknown>>).map(
          (row) => ({ id: row.id, value: row.value }),
        );
      } else if ("value" in field) {
        data[id] = field.value;
      }
    }
    return { approved: true, data };
  };

/** Installs a fresh durable journal behind a minimal Zotero global. */
export async function installBatchJournal(): Promise<() => void> {
  const originalZotero = globalThis.Zotero;
  installedDb = new ChangeJournalTestDb();
  globalThis.Zotero = {
    DB: installedDb,
    Prefs: { get: () => "auto" },
    Items: { get: () => null },
    debug: () => undefined,
  } as never;
  await initAgentChangeJournal();
  return () => {
    globalThis.Zotero = originalZotero;
    installedDb = null;
  };
}

export type BatchActionRun<TOutput> = {
  result: Awaited<ReturnType<AgentAction<unknown, TOutput>["execute"]>>;
  /** Every journal action the run wrote, oldest first. */
  journal: JournalActionWithSteps[];
  /** The tool name of every call the action made, in order. */
  calls: string[];
  registry: AgentToolRegistry;
};

/**
 * Runs one batch action against `library` through the production registry.
 *
 * `replaceTools` swaps the execute of a registered tool by name, for tools
 * that would otherwise reach the network; the stub receives the tool's
 * validated input. `configure` may adjust the action context.
 */
export async function runBatchActionFixture<TInput, TOutput>(params: {
  action: AgentAction<TInput, TOutput>;
  input: TInput;
  library: BatchLibrary;
  replaceTools?: Record<string, (input: unknown) => unknown>;
  requestConfirmation?: ActionExecutionContext["requestConfirmation"];
  configure?: (ctx: ActionExecutionContext) => ActionExecutionContext;
}): Promise<BatchActionRun<TOutput>> {
  if (!installedDb) {
    throw new Error("Call installBatchJournal() before running a fixture");
  }
  const registry = createBuiltInToolRegistry({
    zoteroGateway: params.library.zoteroGateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  for (const [name, stub] of Object.entries(params.replaceTools || {})) {
    const tool = registry.getTool(name);
    if (!tool) throw new Error(`No registered tool named ${name}`);
    tool.execute = async (input: unknown) => stub(input) as never;
  }
  const calls: string[] = [];
  const prepareExecution = registry.prepareExecution.bind(registry);
  registry.prepareExecution = ((call, ...rest) => {
    calls.push(call.name);
    return prepareExecution(call, ...rest);
  }) as typeof registry.prepareExecution;
  const baseContext: ActionExecutionContext = {
    registry,
    zoteroGateway: params.library.zoteroGateway as never,
    libraryID: 1,
    conversationKey: params.library.conversationKey,
    confirmationMode: "native_ui",
    onProgress: () => undefined,
    requestConfirmation: params.requestConfirmation || approveAsShown,
  };
  const ctx = params.configure ? params.configure(baseContext) : baseContext;
  const result = await params.action.execute(params.input, ctx);
  const journal = (
    await listJournalActions({
      conversationKey: params.library.conversationKey,
    })
  ).sort((left, right) => left.createdAt - right.createdAt);
  return { result, journal, calls, registry };
}

/**
 * Runs the auto-tag batch action over `items` papers through the built-in
 * registry and returns the one journal action it wrote.
 *
 * `legacyJournalToolName` rewrites that action's stored tool name, the way a
 * journal written by an older build (before batch actions called facades)
 * sits in a user's database.
 */
export async function runAutoTagFixture(options: {
  items: number;
  legacyJournalToolName?: string;
}): Promise<{ journal: JournalActionWithSteps; gateway: BatchLibrary }> {
  const itemIds = Array.from(
    { length: options.items },
    (_, index) => index + 1,
  );
  const gateway = createBatchLibrary(itemIds.map((itemId) => ({ itemId })));
  const run = await runBatchActionFixture({
    action: autoTagAction,
    input: { itemIds },
    library: gateway,
  });
  if (!run.result.ok) {
    throw new Error(`auto_tag failed: ${JSON.stringify(run.result)}`);
  }
  if (run.journal.length !== 1) {
    throw new Error(`Expected one journal action, found ${run.journal.length}`);
  }
  let journal = run.journal[0];
  if (options.legacyJournalToolName) {
    const row = installedDb!.actions.get(journal.actionId);
    if (!row) throw new Error("journal action row missing");
    row.tool_name = options.legacyJournalToolName;
    journal = (
      await listJournalActions({ conversationKey: gateway.conversationKey })
    )[0];
  }
  return { journal, gateway };
}

/** The production registry's `undo` tool and a context for this library. */
export function builtInUndoTool(gateway: BatchLibrary) {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway.zoteroGateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const tool = registry.getTool("undo");
  if (!tool) throw new Error("No registered tool named undo");
  const context = {
    request: { conversationKey: gateway.conversationKey, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;
  return { registry, tool, context };
}

/**
 * Runs `undo` in the fixture's conversation. With no arguments it undoes the
 * newest reversible action.
 */
export async function undoFixture(
  gateway: BatchLibrary,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { tool, context } = builtInUndoTool(gateway);
  const input = tool.validate(args);
  if (!input.ok) throw new Error(input.error);
  const result = await tool.execute(input.value, context);
  return result.content as Record<string, unknown>;
}
