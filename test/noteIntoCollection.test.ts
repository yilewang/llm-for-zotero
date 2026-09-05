import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import type { AgentToolContext } from "../src/agent/types";

/**
 * Issue #374: "save the answer as a note into a specific folder" put the note
 * in the My Library root, or nowhere at all.
 *
 * There were two independent causes. The classifier sent the request to the
 * filesystem (fixed in Stage A), and — even once it reached Zotero — no layer
 * of the note-writing chain could express a collection, and the created
 * note's id was discarded on the way back up so no follow-up was possible.
 */
describe("note into a collection (issue #374)", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "save this answer as a note in the Neuroscience folder",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    journalFallbackApproved: true,
  };

  function makeGateway() {
    const saved: Array<Record<string, unknown>> = [];
    const gateway = {
      getCollectionSummary: (collectionId: number) => ({
        collectionId,
        name: "Neuroscience",
        libraryID: 1,
        path: "Neuroscience",
      }),
      getItem: () => null,
      getActiveNoteSnapshot: () => null,
      saveAnswerToNote: async (params: Record<string, unknown>) => {
        saved.push(params);
        return {
          status: "standalone_created" as const,
          noteId: 555,
          collections: params.collections as number[] | undefined,
        };
      },
      trashItems: async () => ({ trashedCount: 1, items: [] }),
    };
    return { gateway, saved };
  }

  it("accepts a collection target on note_write", function () {
    const { gateway } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [88],
    });
    assert.isTrue(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(
      (result.value as { collections?: number[] }).collections,
      [88],
    );
  });

  it("describes the stored note text rather than raw Markdown syntax", async function () {
    const { gateway } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "# Issue388 marker\n\n**Verified body.**",
      target: "standalone",
      collections: [88],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    const descriptor = (await tool.describeAction?.(result.value))?.[0];
    assert.equal(descriptor?.proofDomain, "zotero_state");
    assert.equal(descriptor?.operation, "note_create");
    assert.equal(
      descriptor?.parameters?.expectedText,
      "Issue388 marker\nVerified body.",
    );
  });

  it("names the destination collection on the confirmation card", function () {
    const { gateway } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [88],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    const pending = tool.createPendingAction?.(result.value, context);
    assert.include(
      pending?.description || "",
      "Neuroscience",
      "the user must see where the note is going before approving",
    );
  });

  it("files the note and returns its id through the mutation service", async function () {
    const { gateway, saved } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      {
        type: "save_note",
        content: "The answer.",
        target: "standalone",
        collections: [88],
      },
      context,
    );

    assert.equal(saved.length, 1);
    assert.deepEqual(
      saved[0].collections,
      [88],
      "the collection must reach the gateway",
    );

    const result = (outcome.result as { result: Record<string, unknown> })
      .result;
    assert.equal(
      result.noteId,
      555,
      "the note id must survive the trip back up",
    );
    assert.deepEqual(result.collections, [88]);
    assert.exists(outcome.inverse, "creating a note must be reversible");
  });

  it("treats a collection request as standalone even when target says item", async function () {
    const { gateway, saved } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "item",
      collections: [88],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;

    await tool.execute(result.value, context);

    assert.equal(saved.length, 1);
    assert.equal(
      saved[0].target,
      "standalone",
      "a child note cannot be a collection member, so the collection wins",
    );
    assert.deepEqual(saved[0].collections, [88]);
  });

  /**
   * A note containing an image takes a different branch: it is constructed
   * manually so the note id exists before images are imported. That branch
   * bypasses the mutation service entirely, so it needed the collection
   * filing separately — otherwise a figure note silently lost the collection
   * an identical text note landed in.
   */
  it("files a note that contains an image, which takes the manual branch", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const filed: number[] = [];
    try {
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
        Item: class {
          libraryID = 0;
          parentID: number | undefined;
          id = 777;
          constructor(public itemType: string) {}
          addToCollection(id: number) {
            filed.push(id);
          }
          setNote() {}
          async saveTx() {}
          getNote() {
            return "";
          }
        },
        Items: { get: () => null },
        debug: () => undefined,
      };

      const { gateway } = makeGateway();
      const tool = createEditCurrentNoteTool(gateway as never);
      const validated = tool.validate({
        mode: "create",
        content: "See ![Figure 1](file:///tmp/fig.png)",
        target: "standalone",
        collections: [88],
      });
      assert.isTrue(validated.ok, JSON.stringify(validated));
      if (!validated.ok) return;

      try {
        await tool.execute(validated.value, context);
      } catch {
        // The manual branch does real note persistence we are not stubbing;
        // what matters is that the collection was applied to the note object
        // before the save was attempted.
      }

      assert.deepEqual(
        filed,
        [88],
        "an image note must land in the same collection a text note would",
      );
    } finally {
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  /**
   * `addToCollection` does no existence check and never throws for a valid
   * integer — the failure lands later as a foreign-key violation on the
   * INSERT, inside the same transaction as the note itself. So a wrong
   * collection id did not merely skip the filing: it destroyed the generated
   * note and returned a raw SQLite error.
   */
  it("refuses an unresolvable collection instead of losing the note", async function () {
    const gateway = {
      getCollectionSummary: () => null,
      getItem: () => null,
      getActiveNoteSnapshot: () => null,
      saveAnswerToNote: async () => {
        throw new Error("saveAnswerToNote must not be reached");
      },
    };
    const tool = createEditCurrentNoteTool(gateway as never);
    const validated = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [4242],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected the create to be refused");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "4242");
    assert.include(
      message,
      "not created",
      "the user must be told the note was not written",
    );
  });

  it("does not name a destination it cannot resolve on the card", function () {
    const gateway = {
      getCollectionSummary: () => null,
      getItem: () => null,
      getActiveNoteSnapshot: () => null,
    };
    const tool = createEditCurrentNoteTool(gateway as never);
    const validated = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [4242],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const pending = tool.createPendingAction?.(validated.value, context);
    assert.notInclude(
      pending?.description || "",
      "4242",
      "inventing a label told the user the note was going somewhere real",
    );
  });
});
