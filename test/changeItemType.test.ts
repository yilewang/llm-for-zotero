import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import { MutationStateView } from "../src/agent/services/libraryMutation/stateView";
import type { ItemTypeRecord } from "../src/agent/services/libraryMutation/valueTypes";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The type-change path from library_update to undo, on a fake gateway that
 * models Zotero's rule: a field the new type lacks is dropped, and a creator
 * type the new type lacks becomes its primary type.
 */
const TYPE_FIELDS: Record<string, string[]> = {
  journalArticle: ["title", "publicationTitle", "volume", "issue", "date"],
  book: ["title", "volume", "date", "publisher"],
};
const CREATOR_TYPES: Record<string, string[]> = {
  journalArticle: ["author", "editor", "reviewedAuthor"],
  book: ["author", "editor"],
};

type FakeItem = { id: number; libraryID: number; record: ItemTypeRecord };

function changed(record: ItemTypeRecord, itemType: string): ItemTypeRecord {
  return {
    itemType,
    fields: Object.fromEntries(
      Object.entries(record.fields).filter(([field]) =>
        TYPE_FIELDS[itemType].includes(field),
      ),
    ),
    creators: record.creators.map((creator) =>
      CREATOR_TYPES[itemType].includes(creator.creatorType)
        ? creator
        : { ...creator, creatorType: "author" },
    ),
  };
}

function gatewayFor(
  item: FakeItem,
  options: { failRestore?: boolean; emptyOnChange?: string } = {},
) {
  const copy = (record: ItemTypeRecord) =>
    JSON.parse(JSON.stringify(record)) as ItemTypeRecord;
  return {
    getItem: (id: unknown) => (Number(id) === item.id ? item : null),
    resolveLibraryID: () => 1,
    getEditableArticleMetadata: () => ({
      itemId: item.id,
      itemType: item.record.itemType,
      title: item.record.fields.title,
      fields: {},
      creators: [],
    }),
    readItemTypeRecord: (target: FakeItem) => copy(target.record),
    planItemTypeChange: (target: FakeItem | null, itemType: string) => {
      if (!target || !TYPE_FIELDS[itemType])
        return { refusal: `"${itemType}" is not a regular Zotero item type` };
      const after = changed(target.record, itemType);
      return {
        fromType: target.record.itemType,
        toType: itemType,
        droppedFields: Object.keys(target.record.fields).filter(
          (field) => !(field in after.fields),
        ),
        after,
      };
    },
    changeItemType: async (params: { item: FakeItem; itemType: string }) => {
      params.item.record = changed(params.item.record, params.itemType);
      // A Zotero that empties a field the plan said would survive.
      if (options.emptyOnChange)
        delete params.item.record.fields[options.emptyOnChange];
    },
    restoreItemTypeRecord: async (params: {
      item: FakeItem;
      record: ItemTypeRecord;
    }) => {
      if (options.failRestore) throw new Error("Zotero rejected volume");
      params.item.record = copy(params.record);
    },
  };
}

function context(): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "make this a book",
      libraryID: 1,
      activeItemId: 7,
      executionContext: {
        version: 1,
        executionId: "item-type",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    runId: "item-type-run",
  } as never;
}

function article(): FakeItem {
  return {
    id: 7,
    libraryID: 1,
    record: {
      itemType: "journalArticle",
      fields: {
        title: "Drift",
        publicationTitle: "Neuron",
        volume: "12",
        issue: "3",
        date: "2020",
      },
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "reviewedAuthor", name: "Reviewed Lab" },
      ],
    },
  };
}

async function run(gateway: unknown, args: Record<string, unknown>) {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const prepared = await registry.prepareExecution(
    { id: "call-type", name: "library_update", arguments: args },
    context(),
  );
  return { registry, prepared };
}

describe("change_item_type through library_update", function () {
  const originalZotero = globalThis.Zotero;
  beforeEach(async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "safe" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("names the dropped fields on the card and in the result, verifies the type and creators, and undo restores the exact record", async function () {
    const item = article();
    const before = JSON.parse(JSON.stringify(item.record));
    const gateway = gatewayFor(item);
    const { prepared } = await run(gateway, {
      kind: "metadata",
      itemId: 7,
      itemType: "book",
    });
    assert.equal(prepared.kind, "confirmation");
    if (prepared.kind !== "confirmation") throw new Error("unreachable");
    const field = prepared.action.fields[0] as {
      type: string;
      rows: Array<{ key: string; label: string; before: string }>;
    };
    assert.equal(field.type, "review_table");
    assert.deepEqual(
      field.rows.map((row) => row.key),
      ["itemType", "publicationTitle", "issue"],
    );
    assert.equal(field.rows[1].before, "Neuron");
    assert.include(prepared.action.description || "", "drops 2 fields");
    assert.equal(
      item.record.itemType,
      "journalArticle",
      "the card writes nothing",
    );

    const done = await prepared.execute({ approved: true });
    assert.equal(done.kind, "result");
    if (done.kind !== "result") throw new Error("unreachable");
    const result = done.execution.result;
    assert.isTrue(result.ok, JSON.stringify(result.content));
    assert.include(
      JSON.stringify(result.content),
      '"droppedFields":["publicationTitle","issue"]',
    );
    assert.equal(item.record.itemType, "book");
    assert.deepEqual(item.record.creators[1], {
      creatorType: "author",
      name: "Reviewed Lab",
    });
    const [receipt] = result.actionReceipts || [];
    assert.equal(receipt?.operation, "change_item_type");
    assert.equal(receipt?.verification, "verified");
    assert.equal(receipt?.status, "applied");

    const actions = await listJournalActions({ runId: "item-type-run" });
    assert.lengthOf(actions, 1);
    const undone = await revertActions({
      actions,
      zoteroGateway: gateway as never,
      context: context(),
    });
    assert.equal(undone.reverted, 1, JSON.stringify(undone));
    assert.deepEqual(item.record, before);
  });

  it("reports an undo whose restore Zotero refuses as a failed undo, not a success", async function () {
    const item = article();
    const gateway = gatewayFor(item, { failRestore: true });
    const { prepared } = await run(gateway, {
      kind: "metadata",
      itemId: 7,
      itemType: "book",
    });
    if (prepared.kind !== "confirmation") throw new Error("expected a card");
    await prepared.execute({ approved: true });
    const actions = await listJournalActions({ runId: "item-type-run" });
    const undone = await revertActions({
      actions,
      zoteroGateway: gateway as never,
      context: context(),
    });
    assert.equal(undone.reverted, 0, JSON.stringify(undone));
    assert.equal(item.record.itemType, "book");
  });

  it("refuses the write when the item would now drop other fields than the card named", async function () {
    const item = article();
    const gateway = gatewayFor(item);
    const { prepared } = await run(gateway, {
      kind: "metadata",
      itemId: 7,
      itemType: "book",
    });
    if (prepared.kind !== "confirmation") throw new Error("expected a card");
    delete item.record.fields.issue;
    const done = await prepared.execute({ approved: true });
    if (done.kind !== "result") throw new Error("unreachable");
    assert.isFalse(done.execution.result.ok);
    assert.include(
      JSON.stringify(done.execution.result.content),
      "changed since the review",
    );
    assert.equal(item.record.itemType, "journalArticle");
  });

  it("does not verify a change that emptied a field the plan said would survive", async function () {
    const item = article();
    const gateway = gatewayFor(item, { emptyOnChange: "volume" });
    const { prepared } = await run(gateway, {
      kind: "metadata",
      itemId: 7,
      itemType: "book",
    });
    if (prepared.kind !== "confirmation") throw new Error("expected a card");
    const done = await prepared.execute({ approved: true });
    if (done.kind !== "result") throw new Error("unreachable");
    const [receipt] = done.execution.result.actionReceipts || [];
    assert.notEqual(receipt?.verification, "verified", JSON.stringify(receipt));
  });

  it("refuses to undo a type change after the user edited the item, and writes nothing", async function () {
    const item = article();
    const gateway = gatewayFor(item);
    const { prepared } = await run(gateway, {
      kind: "metadata",
      itemId: 7,
      itemType: "book",
    });
    if (prepared.kind !== "confirmation") throw new Error("expected a card");
    await prepared.execute({ approved: true });
    item.record.fields.title = "Drift, revised by the user";
    const afterEdit = JSON.parse(JSON.stringify(item.record));
    const actions = await listJournalActions({ runId: "item-type-run" });
    const undone = await revertActions({
      actions,
      zoteroGateway: gateway as never,
      context: context(),
    });
    assert.equal(undone.reverted, 0, JSON.stringify(undone));
    assert.include(JSON.stringify(undone), "onflict");
    assert.deepEqual(item.record, afterEdit, "the edited item is untouched");
  });

  it("refuses itemType together with metadata or several items", async function () {
    const gateway = gatewayFor(article());
    for (const args of [
      {
        kind: "metadata",
        itemId: 7,
        itemType: "book",
        metadata: { title: "x" },
      },
      { kind: "metadata", itemIds: [7, 8], itemType: "book" },
    ]) {
      const { prepared } = await run(gateway, args);
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") continue;
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        "itemType needs exactly one itemId",
      );
    }
  });

  it("judges the postcondition on type and creators, and the undo on the exact record", function () {
    const handler = libraryMutationHandlers.change_item_type;
    const state = (record: ItemTypeRecord) =>
      new MutationStateView({
        version: 1,
        operation: "change_item_type",
        items: [{ itemId: 7, exists: true, ...record }],
      });
    const forward = {
      type: "change_item_type" as const,
      itemId: 7,
      itemType: "book",
      droppedFields: ["publicationTitle"],
      expectedCreators: [{ creatorType: "author", lastName: "Lovelace" }],
    };
    const book = {
      itemType: "book",
      fields: { title: "Drift" },
      creators: [{ creatorType: "author", lastName: "Lovelace" }],
    };
    assert.isTrue(handler.postconditionSatisfied(forward, state(book)));
    assert.isFalse(
      handler.postconditionSatisfied(
        forward,
        state({ ...book, itemType: "journalArticle" }),
      ),
    );
    assert.isFalse(
      handler.postconditionSatisfied(
        forward,
        state({
          ...book,
          creators: [{ creatorType: "editor", lastName: "Lovelace" }],
        }),
      ),
    );
    // A field the plan expected to keep its value must still hold it.
    const withFields = { ...forward, expectedFields: { title: "Drift" } };
    assert.isTrue(handler.postconditionSatisfied(withFields, state(book)));
    assert.isFalse(
      handler.postconditionSatisfied(
        withFields,
        state({ ...book, fields: {} }),
      ),
    );
    const article = {
      itemType: "journalArticle",
      fields: { title: "Drift", publicationTitle: "Neuron" },
      creators: book.creators,
    };
    const { inverseOperations } = handler.planInverse(forward, state(article));
    assert.deepEqual(inverseOperations, [
      {
        type: "change_item_type",
        itemId: 7,
        itemType: "journalArticle",
        restore: { fields: article.fields, creators: article.creators },
      },
    ]);
    const inverse = inverseOperations![0] as typeof forward & {
      restore: Omit<ItemTypeRecord, "itemType">;
    };
    assert.isTrue(handler.postconditionSatisfied(inverse, state(article)));
    assert.isFalse(
      handler.postconditionSatisfied(
        inverse,
        state({ ...article, fields: { title: "Drift" } }),
      ),
    );
  });
});
