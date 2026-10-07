import { assert } from "chai";
import {
  collectionAddOnly,
  receiptOperationLabel,
} from "../src/agent/contracts/operationCatalog";
import { formatReceiptStatus } from "../src/agent/contracts/actionEvaluation";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import type { MoveToCollectionOperation } from "../src/agent/services/libraryMutationService";
import { createMoveToCollectionTool } from "../src/agent/tools/write/moveToCollection";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { ADD_ONLY_NOTE } from "../src/agent/services/zotero/collectionCapability";

/**
 * A folder "move" without mode:'move' only adds the paper to the new folder.
 * It was still reported as a move: the receipt said "move_to_collection —
 * applied", the card and Task progress said "Moved to collection", and the
 * model told the user the paper had left its old folder.
 */
describe("a collection add is never reported as a move", function () {
  const receipt = (
    overrides: Partial<AgentActionReceipt> = {},
  ): AgentActionReceipt => ({
    version: 2,
    id: "move:result",
    proposalId: "move",
    proofDomain: "zotero_state",
    capability: "zotero.collections",
    operation: "move_to_collection",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:41"],
    appliedTargets: ["item:41"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  });

  it("calls an add 'Added to collection' and a move 'Moved to collection'", function () {
    const add = receipt({
      normalizedParameters: { destinationCollectionId: 3 },
    });
    const move = receipt({
      normalizedParameters: {
        sourceCollectionId: 2,
        destinationCollectionId: 3,
      },
    });
    const moveAll = receipt({
      normalizedParameters: { sourceCollectionId: "all" },
    });
    assert.equal(receiptOperationLabel(add), "Added to collection");
    assert.equal(receiptOperationLabel(move), "Moved to collection");
    assert.equal(receiptOperationLabel(moveAll), "Moved to collection");
    assert.isTrue(collectionAddOnly(add));
    assert.isFalse(collectionAddOnly(move));
    // Other operations keep their catalog words.
    assert.equal(
      receiptOperationLabel(receipt({ operation: "apply_tags" })),
      "Added tags",
    );
  });

  it("tells the model an add left the items in their other collections", function () {
    const [addLine, moveLine] = formatReceiptStatus([
      receipt(),
      receipt({ normalizedParameters: { sourceCollectionId: 2 } }),
    ]).split("\n");
    assert.equal(
      addLine,
      "[Action status: move_to_collection (added only; the items stay in their other collections) — applied 1/1; Verified; proof:zotero_state]",
    );
    assert.equal(
      moveLine,
      "[Action status: move_to_collection — applied 1/1; Verified; proof:zotero_state]",
    );
  });

  it("records a source collection only for a move", function () {
    const handler = libraryMutationHandlers.move_to_collection;
    const base: MoveToCollectionOperation = {
      type: "move_to_collection",
      itemIds: [41],
      targetCollectionId: 3,
    };
    assert.isUndefined(
      handler.actionParameters({ ...base, from: 2 } as never)
        .sourceCollectionId,
    );
    assert.equal(
      handler.actionParameters({ ...base, mode: "move", from: 2 } as never)
        .sourceCollectionId,
      2,
    );
  });

  it("refuses a source collection given without mode:'move'", function () {
    const tool = createMoveToCollectionTool(new ZoteroGateway());
    const stray = tool.validate({
      action: "add",
      itemIds: [41],
      targetCollectionId: 3,
      from: 2,
    });
    assert.isFalse(stray.ok);
    if (!stray.ok) assert.match(stray.error, /mode "move"/);
    const add = tool.validate({
      action: "add",
      itemIds: [41],
      targetCollectionId: 3,
    });
    assert.isTrue(add.ok);
    const move = tool.validate({
      action: "add",
      mode: "move",
      from: 2,
      itemIds: [41],
      targetCollectionId: 3,
    });
    assert.isTrue(move.ok);
  });

  it("says in the add result that nothing was removed", async function () {
    const item = {
      id: 41,
      libraryID: 1,
      collections: [2],
      parentID: false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      isAnnotation: () => false,
      getDisplayTitle: () => "Paper 41",
      addToCollection(cid: number) {
        this.collections.push(cid);
      },
      inCollection(cid: number) {
        return this.collections.includes(cid);
      },
      getField: () => "",
      getCreators: () => [],
      getTags: () => [],
      getAttachments: () => [],
      saveTx: async () => true,
    };
    (globalThis as Record<string, unknown>).Zotero = {
      Items: { get: (id: number) => (id === 41 ? item : null) },
      Collections: {
        get: (id: number) =>
          id > 0 ? { id, name: `C${id}`, libraryID: 1 } : null,
      },
      debug: () => undefined,
    };
    try {
      const gateway = new ZoteroGateway();
      (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
        id: number,
      ) => (id === 41 ? item : null);
      (
        gateway as unknown as { getCollectionSummary: (id: number) => unknown }
      ).getCollectionSummary = (id: number) => ({
        collectionId: id,
        name: `C${id}`,
        libraryID: 1,
        path: `C${id}`,
      });
      const result = await gateway.addItemsToCollections({
        assignments: [{ itemId: 41, targetCollectionId: 3 }],
      });
      assert.deepEqual(item.collections, [2, 3]);
      assert.equal(result.note, ADD_ONLY_NOTE);
      assert.match(result.note || "", /mode:'move'/);
    } finally {
      delete (globalThis as Record<string, unknown>).Zotero;
    }
  });
});
