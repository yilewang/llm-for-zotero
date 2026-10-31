import { assert } from "chai";
import { createMergeItemsTool } from "../src/agent/tools/write/mergeItems";
import { ItemCapability } from "../src/agent/services/zotero/itemCapability";
import { mutationPostconditionIsSatisfied } from "../src/agent/services/libraryMutation/handlerOperations";
import type { AgentPendingField, AgentToolContext } from "../src/agent/types";

type MergeOperation = {
  type: "merge_items";
  masterItemId: number;
  otherItemIds: number[];
};

/**
 * Merging N duplicate groups raised N cards. `groups` lets one card list every
 * group and one approval run them all; these tests pin the validation of the
 * ids, the card's rows, and what the user's unchecked rows exclude.
 */
describe("merge_items duplicate groups", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 42,
      mode: "agent",
      userText: "merge these duplicates",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  const fakeGateway = {
    getItem: (id: number) => ({
      id,
      getField: (name: string) => (name === "title" ? `Item ${id}` : ""),
    }),
  } as never;

  function operationsOf(value: unknown): MergeOperation[] {
    return (value as { operations: MergeOperation[] }).operations;
  }

  describe("validation", function () {
    const tool = createMergeItemsTool(fakeGateway);

    it("turns each group into its own merge operation", function () {
      const result = tool.validate({
        groups: [
          { masterItemId: 10, otherItemIds: [11, 12] },
          { masterItemId: 20, otherItemIds: [21] },
        ],
      });
      assert.isTrue(result.ok, result.ok ? "" : result.error);
      if (!result.ok) return;
      assert.deepEqual(
        operationsOf(result.value).map((op) => [
          op.masterItemId,
          op.otherItemIds,
        ]),
        [
          [10, [11, 12]],
          [20, [21]],
        ],
      );
    });

    it("keeps the single-group fields working", function () {
      const result = tool.validate({ masterItemId: 10, otherItemIds: [11] });
      assert.isTrue(result.ok);
      if (!result.ok) return;
      assert.deepEqual(
        operationsOf(result.value).map((op) => [
          op.masterItemId,
          op.otherItemIds,
        ]),
        [[10, [11]]],
      );
    });

    it("refuses a master listed among its own duplicates", function () {
      const result = tool.validate({
        groups: [{ masterItemId: 10, otherItemIds: [10, 11] }],
      });
      assert.isFalse(result.ok);
      if (result.ok) return;
      assert.match(result.error, /10/);
      assert.match(result.error, /master/i);
    });

    it("refuses an item that appears in two groups", function () {
      const result = tool.validate({
        groups: [
          { masterItemId: 10, otherItemIds: [11] },
          { masterItemId: 20, otherItemIds: [11] },
        ],
      });
      assert.isFalse(result.ok);
      if (result.ok) return;
      assert.match(result.error, /11/);
      assert.match(result.error, /more than one group/i);
    });

    it("refuses a call that mixes groups with the single-group fields", function () {
      const result = tool.validate({
        masterItemId: 10,
        otherItemIds: [11],
        groups: [{ masterItemId: 20, otherItemIds: [21] }],
      });
      assert.isFalse(result.ok);
    });

    it("refuses a group with no duplicates", function () {
      const result = tool.validate({
        groups: [{ masterItemId: 10, otherItemIds: [] }],
      });
      assert.isFalse(result.ok);
    });
  });

  describe("native checks before any card", function () {
    type FakeItem = {
      id: number;
      libraryID: number;
      itemTypeID?: number;
      deleted?: boolean;
      isRegularItem: () => boolean;
      isNote: () => boolean;
    };
    const items = new Map<number, FakeItem>();
    function regular(
      id: number,
      libraryID = 1,
      deleted = false,
      itemTypeID = 1,
    ) {
      items.set(id, {
        id,
        libraryID,
        deleted,
        itemTypeID,
        isRegularItem: () => true,
        isNote: () => false,
      });
    }
    const capability = new ItemCapability({
      getItem: (id) => (items.get(Number(id)) as never) || null,
      getCollectionSummary: () => null,
      resolveBibliographicItem: (item) => item ?? null,
    });

    beforeEach(function () {
      items.clear();
      regular(10);
      regular(11);
      regular(20);
      regular(21);
    });

    it("accepts regular, untrashed items in one library", function () {
      assert.isNull(
        capability.mergeRefusal([
          { masterItemId: 10, otherItemIds: [11] },
          { masterItemId: 20, otherItemIds: [21] },
        ]),
      );
    });

    it("refuses a duplicate already in the trash, as a merged one is", function () {
      regular(21, 1, true);
      assert.match(
        capability.mergeRefusal([
          { masterItemId: 10, otherItemIds: [11] },
          { masterItemId: 20, otherItemIds: [21] },
        ]) || "",
        /21.*trash/i,
      );
    });

    it("refuses an item that no longer exists", function () {
      items.delete(11);
      assert.match(
        capability.mergeRefusal([{ masterItemId: 10, otherItemIds: [11] }]) ||
          "",
        /11/,
      );
    });

    it("refuses a note, which is not a regular item", function () {
      items.set(11, {
        id: 11,
        libraryID: 1,
        isRegularItem: () => false,
        isNote: () => true,
      });
      assert.match(
        capability.mergeRefusal([{ masterItemId: 10, otherItemIds: [11] }]) ||
          "",
        /11.*regular/i,
      );
    });

    it("refuses a group that mixes item types, naming the group", function () {
      const scope = globalThis as { Zotero?: unknown };
      const original = scope.Zotero;
      scope.Zotero = {
        ItemTypes: {
          getName: (id: number) =>
            id === 1 ? "journalArticle" : "conferencePaper",
        },
      };
      try {
        regular(21, 1, false, 2);
        const refusal =
          capability.mergeRefusal([
            { masterItemId: 10, otherItemIds: [11] },
            { masterItemId: 20, otherItemIds: [21] },
          ]) || "";
        assert.match(refusal, /21.*conferencePaper/);
        assert.match(refusal, /master 20.*journalArticle/);
        assert.match(refusal, /same type/i);
      } finally {
        scope.Zotero = original;
      }
    });

    it("refuses a mixed-type group whose master is the odd one out", function () {
      regular(10, 1, false, 2);
      assert.match(
        capability.mergeRefusal([{ masterItemId: 10, otherItemIds: [11] }]) ||
          "",
        /11.*master 10.*same type/i,
      );
    });

    it("refuses groups that span libraries", function () {
      regular(20, 2);
      regular(21, 2);
      assert.match(
        capability.mergeRefusal([
          { masterItemId: 10, otherItemIds: [11] },
          { masterItemId: 20, otherItemIds: [21] },
        ]) || "",
        /librar/i,
      );
    });
  });

  describe("one card for every group", function () {
    const tool = createMergeItemsTool(fakeGateway);
    function input() {
      const result = tool.validate({
        groups: [
          { masterItemId: 10, otherItemIds: [11, 12] },
          { masterItemId: 20, otherItemIds: [21] },
          { masterItemId: 30, otherItemIds: [31] },
        ],
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }

    it("lists each master with its duplicates as checklist rows", async function () {
      const action = (await tool.createPendingAction!(input(), context)) as {
        title: string;
        description: string;
        fields: AgentPendingField[];
      };
      assert.deepEqual(
        action.fields.map((field) => [field.type, field.id, field.label]),
        [
          ["text", "masterInfo:0", "Master (kept)"],
          ["checklist", "duplicatesChecklist:0", "Duplicates to merge & trash"],
          ["text", "masterInfo:1", "Master (kept)"],
          ["checklist", "duplicatesChecklist:1", "Duplicates to merge & trash"],
          ["text", "masterInfo:2", "Master (kept)"],
          ["checklist", "duplicatesChecklist:2", "Duplicates to merge & trash"],
        ],
      );
      const first = action.fields[1] as Extract<
        AgentPendingField,
        { type: "checklist" }
      >;
      assert.deepEqual(
        first.items.map((item) => [item.id, item.label, item.checked]),
        [
          ["11", "Item 11", true],
          ["12", "Item 12", true],
        ],
      );
      assert.equal(
        (action.fields[0] as { value?: string }).value,
        "Item 10",
        "the master's title",
      );
      // A group may be left with nothing checked: it then merges nothing.
      assert.deepEqual(first.requiredForActionIds, []);
      assert.equal(
        action.description.split("not fully reversible").length - 1,
        1,
        "the irreversibility warning appears once",
      );
    });

    it("keeps the single-group card as it was", async function () {
      const single = tool.validate({ masterItemId: 10, otherItemIds: [11] });
      if (!single.ok) throw new Error(single.error);
      const action = (await tool.createPendingAction!(
        single.value,
        context,
      )) as { title: string; fields: AgentPendingField[] };
      assert.equal(action.title, "Merge 2 items");
      assert.deepEqual(
        action.fields.map((field) => field.id),
        ["masterInfo", "duplicatesChecklist"],
      );
      assert.isUndefined(action.fields[1].requiredForActionIds);
    });

    it("excludes unchecked rows, and a group left with none merges nothing", function () {
      const applied = tool.applyConfirmation!(
        input(),
        {
          "duplicatesChecklist:0": ["12"],
          "duplicatesChecklist:1": [],
          "duplicatesChecklist:2": ["31"],
        },
        context,
      );
      assert.isTrue(applied.ok, applied.ok ? "" : applied.error);
      if (!applied.ok) return;
      assert.deepEqual(
        operationsOf(applied.value).map((op) => [
          op.masterItemId,
          op.otherItemIds,
        ]),
        [
          [10, [12]],
          [30, [31]],
        ],
      );
    });

    it("merges nothing when every row of every group is unchecked", function () {
      const applied = tool.applyConfirmation!(
        input(),
        {
          "duplicatesChecklist:0": [],
          "duplicatesChecklist:1": [],
          "duplicatesChecklist:2": [],
        },
        context,
      );
      assert.isFalse(applied.ok);
    });
  });

  describe("native post-state of one group", function () {
    const operation: MergeOperation = {
      type: "merge_items",
      masterItemId: 10,
      otherItemIds: [11],
    };

    it("holds when the master exists and the trashed duplicate has no children left", function () {
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          operation as never,
          {
            version: 1,
            operation: "merge_items",
            items: [
              { itemId: 10, exists: true, childNoteIds: [5] },
              {
                itemId: 11,
                exists: true,
                deleted: true,
                childAttachmentIds: [],
                childNoteIds: [],
              },
            ],
          } as never,
        ),
      );
    });

    it("fails while a trashed duplicate still holds a child the master should have", function () {
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation as never,
          {
            version: 1,
            operation: "merge_items",
            items: [
              { itemId: 10, exists: true, childNoteIds: [] },
              {
                itemId: 11,
                exists: true,
                deleted: true,
                childAttachmentIds: [],
                childNoteIds: [5],
              },
            ],
          } as never,
        ),
      );
    });
  });
});
