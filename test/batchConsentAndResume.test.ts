import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { createWriteNotesBatchTool } from "../src/agent/tools/write/writeNotesBatch";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * The binding constraint on "write a summary note for each of my 50 most
 * recent papers" was never the round budget — it was consent. `note_write`
 * takes one `targetItemId`, and every `mode:'create'` call returns its own
 * review card, so the request meant 50 tool calls and 50 human approvals.
 */
describe("batched note writing", function () {
  let saved: Array<{ itemId: number; content: string }>;
  let trashed: number[][];
  let nextNoteId: number;

  function gateway(overrides: Record<string, unknown> = {}) {
    return {
      getItem: (id: number) =>
        id === 999
          ? null
          : {
              id,
              getDisplayTitle: () => `Paper ${id}`,
              getField: () => "",
            },
      saveAnswerToNote: async (params: {
        item: { id: number };
        content: string;
      }) => {
        saved.push({ itemId: params.item.id, content: params.content });
        return { noteId: nextNoteId++ };
      },
      trashItems: async (params: { itemIds: number[] }) => {
        trashed.push(params.itemIds);
        return { trashedCount: params.itemIds.length, items: [] };
      },
      ...overrides,
    };
  }

  const context = {
    request: { conversationKey: 1, libraryID: 1 },
    modelName: "test-model",
  } as never;

  beforeEach(function () {
    saved = [];
    trashed = [];
    nextNoteId = 500;
  });

  it("writes one note per item in a single operation", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "Summary of one" },
          { targetItemId: 2, content: "Summary of two" },
        ],
      },
      context,
    );

    assert.deepEqual(
      saved.map((entry) => entry.itemId),
      [1, 2],
    );
    const result = (outcome.result as { result: Record<string, number> })
      .result;
    assert.equal(result.createdCount, 2);
  });

  it("keeps going when one target is bad", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "ok" },
          { targetItemId: 999, content: "missing target" },
          { targetItemId: 2, content: "also ok" },
        ],
      },
      context,
    );
    // One bad id must not cost the other forty-nine notes.
    const result = (
      outcome.result as {
        result: { createdCount: number; failedCount: number };
      }
    ).result;
    assert.equal(result.createdCount, 2);
    assert.equal(result.failedCount, 1);
  });

  it("undoes the whole set by trashing the notes it wrote", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "a" },
          { targetItemId: 2, content: "b" },
        ],
      },
      context,
    );
    await replayLibraryInverse(service, outcome, context as never);
    assert.deepEqual(trashed, [[500, 501]]);
  });

  describe("the confirmation card", function () {
    it("puts every note on one checklist rather than one card each", function () {
      const tool = createWriteNotesBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [
          { targetItemId: 1, content: "First summary" },
          { targetItemId: 2, content: "Second summary" },
        ],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const action = tool.createPendingAction?.(validated.value, context);
      const checklist = action?.fields?.[0] as
        | { type: string; items: Array<{ id: string; description?: string }> }
        | undefined;
      assert.equal(checklist?.type, "checklist");
      assert.lengthOf(checklist?.items || [], 2);
      // Approving fifty pieces of generated text sight-unseen is consent in
      // name only, so each row previews its content.
      assert.include(checklist?.items[0].description || "", "First summary");
    });

    it("writes only the notes left checked", async function () {
      const tool = createWriteNotesBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [
          { targetItemId: 1, content: "a" },
          { targetItemId: 2, content: "b" },
          { targetItemId: 3, content: "c" },
        ],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const applied = tool.applyConfirmation?.(validated.value, {
        writeNotesChecklist: ["1", "3"],
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        applied.value.operation.notes.map((n) => n.targetItemId),
        [1, 3],
      );
    });

    it("refuses when everything was unchecked", function () {
      const tool = createWriteNotesBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [{ targetItemId: 1, content: "a" }],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const applied = tool.applyConfirmation?.(validated.value, {
        writeNotesChecklist: [],
      });
      assert.isFalse(applied?.ok);
    });

    it("rejects entries with no content rather than writing empty notes", function () {
      const tool = createWriteNotesBatchTool(gateway() as never);
      const result = tool.validate({
        notes: [{ targetItemId: 1, content: "   " }],
      });
      assert.isFalse(result.ok);
    });
  });
});
