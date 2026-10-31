import { assert } from "chai";
import {
  initAgentChangeJournal,
  listJournalActions,
  prepareJournalAction,
  prepareJournalStep,
  updateJournalAction,
  updateJournalStep,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * A metadata row journalled before edits recorded only the fields they set:
 * its inverse names every field of the item type. It is written here straight
 * into the journal, not through the code that now writes the short form.
 */
describe("undo of a metadata row with the full-field inverse", function () {
  const originalZotero = globalThis.Zotero;
  const context = {
    request: { conversationKey: 77, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  beforeEach(async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("restores only the fields the edit set", async function () {
    const item = { id: 1, parentID: false, deleted: false };
    const fields: Record<string, string> = {
      title: "A paper",
      extra: "after",
      date: "2020",
    };
    const writes: Array<Record<string, unknown>> = [];
    await prepareJournalAction({
      actionId: "old-metadata",
      runId: "run-77",
      conversationKey: 77,
      toolName: "library_update",
      description: "old metadata edit",
      effect: "write",
      reversibility: "full",
      now: 100,
    });
    await prepareJournalStep({
      stepId: "old-metadata:1",
      actionId: "old-metadata",
      sequence: 1,
      operation: "update_metadata",
      forward: {
        type: "update_metadata",
        itemId: 1,
        metadata: { extra: "after" },
      },
      inverse: {
        version: 1,
        kind: "library_operations",
        operations: [
          {
            type: "update_metadata",
            itemId: 1,
            // Every editable field of the type, as the old code recorded it.
            metadata: {
              title: "A paper",
              extra: "before",
              date: "2019",
              creators: [],
            },
          },
        ],
      },
      reversibility: "full",
      now: 100,
    });
    await updateJournalStep({
      stepId: "old-metadata:1",
      status: "applied",
      reversibility: "full",
      expectedPostcondition: {
        version: 1,
        operation: "update_metadata",
        items: [
          {
            itemId: 1,
            exists: true,
            parentItemId: null,
            deleted: false,
            fields: { extra: "after" },
          },
        ],
      },
      now: 100,
    });
    await updateJournalAction({
      actionId: "old-metadata",
      status: "applied",
      reversibility: "full",
      affectedCount: 1,
      now: 100,
    });

    const [action] = await listJournalActions({
      conversationKey: 77,
      pendingOnly: true,
      limit: 1,
    });
    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: {
        getItem: () => item,
        resolveMetadataItem: () => item,
        resolveMetadataWriteTarget: () => ({ item }),
        getEditableArticleMetadata: () => ({
          itemId: 1,
          title: fields.title,
          fields: { ...fields },
          creators: [],
        }),
        updateArticleMetadata: async (input: {
          metadata: Record<string, string>;
        }) => {
          writes.push(input.metadata);
          Object.assign(fields, input.metadata);
          return { status: "updated" };
        },
      } as never,
      context,
    });

    assert.deepEqual(outcome.conflicts, []);
    assert.equal(outcome.reverted, 1);
    assert.deepEqual(writes, [{ extra: "before" }]);
    assert.equal(fields.extra, "before");
    assert.equal(fields.date, "2020", "a field the edit did not set is kept");
  });
});
