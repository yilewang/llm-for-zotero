import { assert } from "chai";
import { composeRetrievalCandidateInvalidation } from "./helpers/hostSurfaces";
import {
  createBatchJourneyRegistry,
  installBatchJourneyEnvironment,
  type BatchJourneyEnvironment,
} from "./helpers/materialJourneys";
import {
  BATCH_ITEMS_TABLE,
  listBatchItems,
} from "../src/agent/store/batchItemStore";
import { getBatchJob } from "../src/agent/store/batchJobStore";
import { listJournalActions } from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import type { AgentToolContext } from "../src/agent/types";

/**
 * note_write_batch mode:'append' over existing notes: the user's Stop after
 * one note, the resume that appends the rest, and the frozen post-append
 * checksum that keeps a lost checkpoint from appending twice.
 */
describe("note batch append", function () {
  let environment: BatchJourneyEnvironment;
  const conversationKey = 881_202;
  let restoreInvalidator: (() => void) | null = null;

  before(function () {
    // An append invalidates cached paper context through a host surface the
    // plugin composes at startup.
    restoreInvalidator = composeRetrievalCandidateInvalidation();
  });
  after(function () {
    restoreInvalidator?.();
  });

  beforeEach(async function () {
    environment = await installBatchJourneyEnvironment();
  });
  afterEach(function () {
    environment.restore();
  });

  async function makeNote(html: string) {
    const note = new (globalThis.Zotero as any).Item("note");
    note.key = `APPEND${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    note.setNote(html);
    await note.saveTx();
    return note;
  }

  function occurrences(html: string, text: string): number {
    return html.split(text).length - 1;
  }

  function contextFor(signal?: { aborted: boolean }): AgentToolContext {
    return {
      request: {
        conversationKey,
        mode: "agent",
        userText: "Add a follow-up to each note",
        libraryID: 1,
        executionContext: {
          version: 1,
          executionId: "note-batch-append",
          conversationKey,
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
      runId: "note-batch-append-run",
      ...(signal ? { signal } : {}),
    } as never;
  }

  async function approve(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ) {
    const registry = createBatchJourneyRegistry(environment.library);
    let prepared = await registry.prepareExecution(
      {
        id: `call-${Math.random()}`,
        name: "note_write_batch",
        arguments: args,
      },
      context,
    );
    if (prepared.kind === "confirmation")
      prepared = await prepared.execute({ approved: true });
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") throw new Error("unreachable");
    return prepared.execution.result;
  }

  it("appends to each note once across a Stop and a resume, and one undo restores them", async function () {
    const notes = [
      await makeNote("<p>First note.</p>"),
      await makeNote("<p>Second note.</p>"),
      await makeNote("<p>Third note.</p>"),
    ];
    const before = notes.map((note) => note.getNote());
    const addition = (index: number) => `Follow-up ${index + 1}`;
    // Stop lands between notes, once the first append is in the library.
    const signal = {
      get aborted() {
        return notes[0].getNote().includes(addition(0));
      },
    };
    const first = await approve(
      {
        mode: "append",
        notes: notes.map((note, index) => ({
          targetNoteId: note.id,
          content: addition(index),
        })),
      },
      contextFor(signal),
    );
    assert.isTrue(first.ok, JSON.stringify(first.content));
    assert.equal(
      occurrences(notes[0].getNote(), addition(0)),
      1,
      JSON.stringify(first.content),
    );
    assert.equal(notes[1].getNote(), before[1]);
    assert.equal(notes[2].getNote(), before[2]);
    const batchId = (first.content as { stopped?: string }).stopped?.match(
      /batch (\S+);/,
    )?.[1];
    assert.exists(batchId, JSON.stringify(first.content));
    assert.deepEqual(
      (await listBatchItems(batchId!)).map((row) => row.status),
      ["saved", "pending", "pending"],
      JSON.stringify([first.content, await listBatchItems(batchId!)]),
    );
    const [receipt] = first.actionReceipts || [];
    assert.include(
      receipt?.verifiedFacts || [],
      `appended_note:item:${notes[0].id}`,
    );

    const resumed = await approve({ resumeBatchId: batchId }, contextFor());
    assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
    notes.forEach((note, index) =>
      assert.equal(occurrences(note.getNote(), addition(index)), 1),
    );
    assert.deepEqual(
      (await listBatchItems(batchId!)).map((row) => row.status),
      ["saved", "saved", "saved"],
    );

    // A checkpoint lost after the native append: the row reads pending, and
    // the frozen after-checksum proves the append already landed.
    await (globalThis.Zotero as any).DB.queryAsync(
      `UPDATE ${BATCH_ITEMS_TABLE} SET status = 'pending' WHERE batch_id = ? AND item_key = ?`,
      [batchId, `item:${notes[2].id}`],
    );
    const again = await approve({ resumeBatchId: batchId }, contextFor());
    assert.isTrue(again.ok, JSON.stringify(again.content));
    assert.equal(occurrences(notes[2].getNote(), addition(2)), 1);
    assert.equal(
      (await listBatchItems(batchId!))[2].status,
      "saved",
      "the landed append is recorded, not repeated",
    );

    const actions = await listJournalActions({ conversationKey });
    assert.lengthOf(
      new Set(actions.map((action) => action.actionId)),
      1,
      "the resumes continue the action the batch opened",
    );
    const undone = await revertActions({
      actions: [actions[0]],
      zoteroGateway: new ZoteroGateway(),
      context: contextFor(),
    });
    assert.isAtLeast(undone.reverted, 1, JSON.stringify(undone));
    notes.forEach((note, index) =>
      assert.equal(note.getNote(), before[index], `note ${index + 1}`),
    );
  });

  it("fails an item whose note changed after approval, and appends nothing to it", async function () {
    const note = await makeNote("<p>Original.</p>");
    const registry = createBatchJourneyRegistry(environment.library);
    const prepared = await registry.prepareExecution(
      {
        id: "call-changed",
        name: "note_write_batch",
        arguments: {
          mode: "append",
          notes: [{ targetNoteId: note.id, content: "Addition" }],
        },
      },
      contextFor(),
    );
    if (prepared.kind !== "confirmation") throw new Error("expected a card");
    note.setNote("<p>Edited by the user.</p>");
    await note.saveTx();
    const done = await prepared.execute({ approved: true });
    if (done.kind !== "result") throw new Error("unreachable");
    assert.equal(note.getNote(), "<p>Edited by the user.</p>");
    assert.include(
      JSON.stringify(done.execution.result.content),
      "changed after the batch was approved",
    );
  });

  it("resumes a create batch, whose stored job keeps the pre-append shape, as creates", async function () {
    const library = environment.library;
    const signal = {
      get aborted() {
        return library.notes.size >= 1;
      },
    };
    const first = await approve(
      {
        notes: [1, 2].map((id) => ({
          targetItemId: id,
          content: `Summary of paper ${id}`,
        })),
      },
      contextFor(signal),
    );
    const batchId = (first.content as { stopped?: string }).stopped?.match(
      /batch (\S+);/,
    )?.[1];
    assert.exists(batchId, JSON.stringify(first.content));
    // The job row a create batch stores is the shape it had before appends:
    // no mode, no note ids, no checksums.
    const stored = JSON.parse((await getBatchJob(batchId!))?.inputJson || "{}");
    assert.deepEqual(Object.keys(stored).sort(), ["notes", "target"]);
    assert.deepEqual(Object.keys(stored.notes[0]).sort(), [
      "itemKey",
      "targetItemId",
    ]);
    const resumed = await approve({ resumeBatchId: batchId }, contextFor());
    assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
    const parents = [...library.notes.values()].map((note) => note.parentID);
    assert.sameMembers(parents, [1, 2], "one new note on each paper");
  });

  it("registers an appended citation in the note's own root, once, and a lost checkpoint does not append it twice", async function () {
    const zotero = globalThis.Zotero as any;
    zotero.URI = {
      getItemURI: (item: { key: string }) =>
        `http://zotero.org/users/local/abc/items/${item.key}`,
    };
    zotero.Utilities = {
      ...zotero.Utilities,
      Item: {
        itemToCSLJSON: () => ({
          title: "Paper",
          author: [{ family: "Smith" }],
          issued: { "date-parts": [[2020]] },
        }),
      },
    };
    const note = await makeNote(
      '<div data-schema-version="9"><p>First note.</p></div>',
    );
    const result = await approve(
      {
        mode: "append",
        notes: [
          { targetNoteId: note.id, content: "See {{cite item=1 page=4}}." },
        ],
      },
      contextFor(),
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    const html = note.getNote();
    assert.equal(
      occurrences(html, "data-schema-version"),
      1,
      "the note keeps one root",
    );
    assert.match(html, /^<div data-citation-items="[^"]+"/);
    assert.include(
      decodeURIComponent(html.match(/data-citation-items="([^"]+)"/)![1]),
      "items/PAPER1",
    );
    assert.include(html, 'class="citation-item">Smith, 2020, p. 4</span>');
    assert.notInclude(html, "{{cite");

    // A checkpoint lost after the native append: the frozen after-checksum
    // must equal the note as it was really written, or the resume appends
    // the part again, or fails as changed after approval.
    const rows = await zotero.DB.queryAsync(
      `SELECT batch_id FROM ${BATCH_ITEMS_TABLE}`,
    );
    const batchId = rows[0].batch_id as string;
    assert.exists(batchId);
    await zotero.DB.queryAsync(
      `UPDATE ${BATCH_ITEMS_TABLE} SET status = 'pending' WHERE batch_id = ?`,
      [batchId],
    );
    const again = await approve({ resumeBatchId: batchId }, contextFor());
    assert.isTrue(again.ok, JSON.stringify(again.content));
    assert.equal(note.getNote(), html, "nothing is appended a second time");
    assert.equal((await listBatchItems(batchId))[0].status, "saved");
  });

  it("fails the whole call when an entry lacks the id its mode needs", function () {
    const tool = createNoteWriteBatchTool({} as never);
    const create = tool.validate({
      notes: [{ targetItemId: 1, content: "a" }, { content: "b" }],
    });
    assert.isFalse(create.ok);
    if (!create.ok) assert.include(create.error, "entry 2 has no targetItemId");
    const append = tool.validate({
      mode: "append",
      notes: [
        { targetNoteId: 5, content: "a" },
        { targetItemId: 6, content: "b" },
      ],
    });
    assert.isFalse(append.ok);
    if (!append.ok) assert.include(append.error, "entry 2 has no targetNoteId");
  });

  it("requires targetNoteId in append mode and one entry per note", function () {
    const tool = createNoteWriteBatchTool({} as never);
    assert.isFalse(
      tool.validate({
        mode: "append",
        notes: [{ targetItemId: 1, content: "x" }],
      }).ok,
    );
    const twice = tool.validate({
      mode: "append",
      notes: [
        { targetNoteId: 5, content: "a" },
        { targetNoteId: 5, content: "b" },
      ],
    });
    assert.isFalse(twice.ok);
    if (!twice.ok) assert.include(twice.error, "appears twice");
  });
});
