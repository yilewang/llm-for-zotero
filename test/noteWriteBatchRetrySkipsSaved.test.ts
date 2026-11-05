import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import {
  createBatchItems,
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
  markBatchItemSaved,
} from "../src/agent/store/batchItemStore";
import {
  createBatchJob,
  getBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import type { AgentToolContext } from "../src/agent/types";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

/**
 * A new note batch over papers an earlier, unfinished batch already wrote.
 *
 * A Zotero restart starts a new run, and a batch's identity is derived from
 * its run, so the model's retry after a restart mints a new batch. Before,
 * that batch consulted only its own rows and wrote every paper again,
 * including the papers whose notes the earlier batch had already saved.
 */
describe("note batch retry skips notes an earlier batch saved", function () {
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  let unavailableTarget: number | undefined;
  let unavailableAfterNotes = 0;
  /** A statement the database refuses, to model a failing row write. */
  let refuseSql: RegExp | undefined;

  function libraryItem(id: number) {
    return {
      id,
      libraryID: 1,
      parentID: false,
      deleted: false,
      version: 1,
      dateModified: "2026-10-31 10:00:00",
      getDisplayTitle: () => `Paper ${id}`,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [],
      getNotes: () => [],
      async reload() {},
    };
  }

  const targets = new Map([1, 2, 3].map((id) => [id, libraryItem(id)]));

  const gateway = {
    resolveLibraryID: () => 1,
    getItem: (id: number) => {
      if (
        unavailableTarget === id &&
        native.notes.size >= unavailableAfterNotes
      )
        throw new Error("Zotero is unavailable");
      return targets.get(id) || native.notes.get(id) || null;
    },
    trashItems: async ({ itemIds }: { itemIds: number[] }) => ({
      trashedCount: itemIds.length,
      items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
    }),
    formatStructuredCitations: () => ({
      styleId: "apa",
      styleTitle: "APA",
      locale: "en-US",
      clusters: [],
      bibliographyEntries: [],
    }),
  } as never;

  function context(runId: string, conversationKey = 8801): AgentToolContext {
    return {
      request: {
        conversationKey,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId,
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } as unknown as AgentToolContext;
  }

  function firstBodies() {
    return [1, 2, 3].map((id) => ({
      targetItemId: id,
      content: `First summary of paper ${id}.`,
    }));
  }

  /** The bodies the model authors again after the restart. */
  function retryBodies(ids = [1, 2, 3]) {
    return ids.map((id) => ({
      targetItemId: id,
      content: `## Retry\n\nRewritten summary of paper ${id}.`,
    }));
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    refuseSql = undefined;
    db = new DatabaseSync(":memory:");
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (refuseSql?.test(sql)) throw new Error("database is locked");
          const statement = db.prepare(sql);
          const values = (params || []).map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...values);
          statement.run(...values);
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
      debug: () => undefined,
    } as unknown as typeof Zotero;
    native = installNativeNoteStore({ startId: 500 });
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    native.restore();
    globalScope.Zotero = originalZotero as typeof Zotero;
    db.close();
  });

  type Tool = ReturnType<typeof createNoteWriteBatchTool>;

  async function run(
    instance: Tool,
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ) {
    const validated = instance.validate(args);
    assert.isTrue(validated.ok, `validation failed: ${JSON.stringify(args)}`);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, ctx);
    return instance.execute(validated.value, ctx);
  }

  /**
   * Run one, interrupted after its first note: paper 1 is saved, and papers
   * 2 and 3 stay pending because the library became unreachable.
   */
  async function interruptedFirstRun(
    conversationKey = 8801,
    target?: "standalone",
  ): Promise<string> {
    const instance = createNoteWriteBatchTool(gateway);
    const validated = instance.validate({
      notes: firstBodies(),
      ...(target ? { target } : {}),
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const ctx = context("run-before-restart", conversationKey);
    await instance.planInvocation(validated.value, ctx);
    unavailableTarget = 2;
    unavailableAfterNotes = 1;
    await rejects(instance.execute(validated.value, ctx));
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    const [batch] = await listResumableBatches(conversationKey);
    assert.exists(batch, "the interrupted batch must be resumable");
    assert.deepEqual(
      (await listBatchItems(batch.batchId)).map((row) => row.status),
      ["saved", "pending", "pending"],
    );
    return batch.batchId;
  }

  function notesOnPaper(parentId: number): number {
    return [...native.notes.values()].filter(
      (note) => note.parentID === parentId && !note.deleted,
    ).length;
  }

  function payloadOf(output: { content: unknown }) {
    return (output.content as { result: { result: Record<string, unknown> } })
      .result.result;
  }

  function batchJobIds(): string[] {
    return (
      db
        .prepare(`SELECT job_id AS jobId FROM llm_for_zotero_agent_batch_jobs`)
        .all() as Array<{ jobId: string }>
    ).map((row) => row.jobId);
  }

  it("writes only the unwritten papers after a restart and reports the saved one", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;

    // After the restart: a new run, and the model authors every body again.
    const instance = createNoteWriteBatchTool(gateway);
    const validated = instance.validate({ notes: retryBodies() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const ctx = context("run-after-restart");
    await instance.planInvocation(validated.value, ctx);
    const card = instance.createPendingAction?.(validated.value, ctx);
    const checklist = (
      card?.fields?.[0] as { items?: Array<{ id: string }> } | undefined
    )?.items;
    assert.deepEqual(
      checklist?.map((entry) => entry.id),
      ["2", "3"],
      "the card asks to write only the papers that have no note yet",
    );
    const output = await instance.execute(validated.value, ctx);

    assert.equal(native.notes.size, 3, "exactly the two unwritten notes land");
    for (const id of [1, 2, 3])
      assert.equal(notesOnPaper(id), 1, `paper ${id} holds one note`);
    assert.include(
      native.notes.get(savedNoteId).stored,
      "First summary of paper 1",
      "the saved note is left as it was",
    );

    const payload = payloadOf(output);
    assert.equal(payload.createdCount, 2);
    assert.equal(payload.alreadySavedCount, 1);
    assert.match(
      String((output.content as Record<string, unknown>).alreadySavedNotice),
      /A later request writes new notes unless it also names items that batch still owes/,
      "the model learns that the user can still ask for different notes",
    );
    const rows = payload.notes as Array<Record<string, unknown>>;
    const skipped = rows.find((row) => row.itemKey === "item:1");
    assert.deepInclude(skipped, {
      targetItemId: 1,
      itemKey: "item:1",
      noteId: savedNoteId,
      status: "already_saved",
      batchId: earlierBatchId,
    });
    const announced = (output.batchItems || []).find(
      (entry) => entry.itemKey === "item:1",
    );
    assert.deepInclude(announced, {
      batchId: earlierBatchId,
      status: "saved",
      written: false,
      noteId: savedNoteId,
    });

    // The earlier batch now names the notes the retry wrote, so neither the
    // recovery lines nor a resume of it can invite a second write.
    const earlierRows = await listBatchItems(earlierBatchId);
    assert.deepEqual(
      earlierRows.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    const written = rows.filter((row) => row.status === "created");
    assert.deepEqual(
      earlierRows.slice(1).map((row) => row.noteId),
      written.map((row) => row.noteId),
    );
    assert.isEmpty(
      await listResumableBatches(8801),
      "no batch of this conversation is offered for resume",
    );
    const resumed = await run(
      createNoteWriteBatchTool(gateway),
      { resumeBatchId: earlierBatchId },
      context("run-after-restart"),
    );
    assert.equal(resumed.effect, "none");
    assert.equal(
      native.notes.size,
      3,
      "resuming the earlier batch writes nothing",
    );
  });

  it("changes no durable row while the retry still awaits confirmation", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const rawBefore = db
      .prepare(
        `SELECT * FROM llm_for_zotero_agent_batch_items ORDER BY batch_id, position`,
      )
      .all();
    const instance = createNoteWriteBatchTool(gateway);
    const validated = instance.validate({ notes: retryBodies() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const ctx = context("run-after-restart");
    await instance.planInvocation(validated.value, ctx);
    instance.createPendingAction?.(validated.value, ctx);
    assert.deepEqual(
      db
        .prepare(
          `SELECT * FROM llm_for_zotero_agent_batch_items ORDER BY batch_id, position`,
        )
        .all(),
      rawBefore,
    );
    assert.deepEqual(batchJobIds(), [earlierBatchId]);
  });

  it("is no retry when the call names none of the papers the earlier batch still owes", async function () {
    const earlierBatchId = await interruptedFirstRun();

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies([1]) },
      context("run-after-restart"),
    );

    assert.equal(notesOnPaper(1), 2, "a new note on paper 1 is written");
    assert.equal(payloadOf(output).createdCount, 1);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
    assert.deepEqual(
      (await listBatchItems(earlierBatchId)).map((row) => row.status),
      ["saved", "pending", "pending"],
      "the earlier batch still owes papers 2 and 3",
    );
  });

  it("writes an unrelated later request after a batch that ended with one permanent failure", async function () {
    // Batch A writes summaries on papers 1 and 2; paper 99 does not exist,
    // so its row stays failed and A stays on offer for resume.
    await run(
      createNoteWriteBatchTool(gateway),
      {
        notes: [
          { targetItemId: 1, content: "Summary 1" },
          { targetItemId: 2, content: "Summary 2" },
          { targetItemId: 99, content: "Summary 99" },
        ],
      },
      context("run-a"),
    );
    const [earlier] = await listResumableBatches(8801);
    assert.exists(earlier);
    assert.equal(native.notes.size, 2);

    // Later, in the same conversation: a different kind of note on 1 and 2.
    const output = await run(
      createNoteWriteBatchTool(gateway),
      {
        notes: [
          { targetItemId: 1, content: "Methods critique 1" },
          { targetItemId: 2, content: "Methods critique 2" },
        ],
      },
      context("run-b"),
    );

    assert.equal(native.notes.size, 4, "both new notes are written");
    assert.equal(payloadOf(output).createdCount, 2);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
    assert.deepEqual(
      (await listBatchItems(earlier.batchId)).map((row) => row.status),
      ["saved", "saved", "failed"],
      "the unrelated batch's open row is not settled",
    );
  });

  it("never writes a paper twice when resuming the earlier batch after the retry's settling was lost", async function () {
    const earlierBatchId = await interruptedFirstRun();
    await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );
    assert.equal(native.notes.size, 3);
    // The process was killed between the retry's writes and its settling.
    db.prepare(
      `UPDATE llm_for_zotero_agent_batch_items SET status = 'pending', note_id = NULL
       WHERE batch_id = ? AND item_key IN ('item:2', 'item:3')`,
    ).run(earlierBatchId);

    const resumed = await run(
      createNoteWriteBatchTool(gateway),
      { resumeBatchId: earlierBatchId },
      context("run-later"),
    );

    for (const id of [1, 2, 3])
      assert.equal(notesOnPaper(id), 1, `paper ${id} holds one note`);
    assert.equal(resumed.effect, "none");
    const resume = (resumed.content as { resume: Record<string, unknown> })
      .resume;
    assert.deepEqual(resume.skippedItemKeys, ["item:1", "item:2", "item:3"]);
    assert.deepEqual(
      (await listBatchItems(earlierBatchId)).map((row) => row.status),
      ["saved", "saved", "saved"],
      "the resume settles the rows the retry already wrote",
    );
    assert.isEmpty(await listResumableBatches(8801));
  });

  it("writes a paper again when the note the earlier batch saved now belongs to another paper", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    native.notes.get(savedNoteId).parentID = 3;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );

    assert.equal(notesOnPaper(1), 1, "paper 1 gets its note again");
    assert.equal(payloadOf(output).createdCount, 3);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
  });

  it("writes a paper again when the note the earlier batch saved is in another library", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    native.notes.get(savedNoteId).libraryID = 2;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );

    assert.equal(notesOnPaper(1), 2, "paper 1 gets a note in its own library");
    assert.equal(payloadOf(output).createdCount, 3);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
  });

  it("skips a standalone note that has no parent", async function () {
    const earlierBatchId = await interruptedFirstRun(8801, "standalone");
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    assert.notOk(native.notes.get(savedNoteId).parentID);

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies(), target: "standalone" },
      context("run-after-restart"),
    );

    assert.equal(native.notes.size, 3, "only the two unwritten notes land");
    assert.equal(payloadOf(output).createdCount, 2);
    assert.equal(payloadOf(output).alreadySavedCount, 1);
  });

  it("writes a standalone note again when the saved one now has a parent", async function () {
    const earlierBatchId = await interruptedFirstRun(8801, "standalone");
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    native.notes.get(savedNoteId).parentID = 1;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies(), target: "standalone" },
      context("run-after-restart"),
    );

    assert.equal(native.notes.size, 4, "paper 1's standalone note is written");
    assert.equal(payloadOf(output).createdCount, 3);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
  });

  it("treats a retry that names one owed paper as a retry and skips the saved paper", async function () {
    const earlierBatchId = await interruptedFirstRun();

    // A different kind of note over the same papers still names papers 2 and
    // 3, which the earlier batch owes. The call cannot tell it from a retry.
    const output = await run(
      createNoteWriteBatchTool(gateway),
      {
        notes: [1, 2, 3].map((id) => ({
          targetItemId: id,
          content: `Critique ${id}`,
        })),
      },
      context("run-b"),
    );

    assert.equal(notesOnPaper(1), 1, "the saved paper is skipped");
    assert.equal(payloadOf(output).createdCount, 2);
    assert.equal(payloadOf(output).alreadySavedCount, 1);
    assert.match(
      String((output.content as Record<string, unknown>).alreadySavedNotice),
      /1 item already had a note from an earlier unfinished batch/,
    );
    assert.deepEqual(
      (await listBatchItems(earlierBatchId)).map((row) => row.status),
      ["saved", "saved", "saved"],
    );
  });

  it("never writes a paper twice when resuming the first batch of a chain of three", async function () {
    const kill = (batchId: string, keys: string[]) => {
      for (const key of keys)
        db.prepare(
          `UPDATE llm_for_zotero_agent_batch_items SET status = 'pending', note_id = NULL
           WHERE batch_id = ? AND item_key = ?`,
        ).run(batchId, key);
    };
    const interrupted = async (
      runId: string,
      bodies: ReturnType<typeof firstBodies>,
      target: number,
      afterNotes: number,
    ) => {
      const instance = createNoteWriteBatchTool(gateway);
      const validated = instance.validate({ notes: bodies });
      assert.isTrue(validated.ok);
      if (!validated.ok) throw new Error("unreachable");
      const ctx = context(runId);
      await instance.planInvocation(validated.value, ctx);
      unavailableTarget = target;
      unavailableAfterNotes = afterNotes;
      await rejects(instance.execute(validated.value, ctx));
      unavailableTarget = undefined;
      unavailableAfterNotes = 0;
    };

    // A is interrupted before it wrote any note.
    await interrupted("run-a", firstBodies(), 1, 0);
    const a = batchJobIds()[0];
    assert.equal(native.notes.size, 0);

    // B retries the same papers and writes paper 1 before it is killed.
    await interrupted("run-b", retryBodies(), 2, 1);
    const b = batchJobIds().find((id) => id !== a)!;
    kill(a, ["item:1"]);

    // C names B only (A is hidden from resume), writes paper 2, and is
    // killed before it settles the earlier batches.
    await interrupted("run-c", retryBodies(), 3, 2);
    const c = batchJobIds().find((id) => id !== a && id !== b)!;
    kill(b, ["item:2"]);
    kill(a, ["item:2"]);
    assert.notInclude(
      JSON.parse((await getBatchJob(c))!.inputJson || "{}").retryOf,
      a,
      "C is two steps from A: only the chain links them",
    );

    // Resuming A must find the notes B and C wrote.
    await run(
      createNoteWriteBatchTool(gateway),
      { resumeBatchId: a },
      context("run-d"),
    );

    for (const id of [1, 2, 3])
      assert.equal(notesOnPaper(id), 1, `paper ${id} holds one note`);
    assert.equal(native.notes.size, 3);
  });

  it("finishes the call when settling the earlier batch fails after the write", async function () {
    await interruptedFirstRun();
    // The settling statement is the only one that sets a row saved with a
    // note id and no journal action.
    refuseSql = /SET status = 'saved', note_id = \?/;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );
    refuseSql = undefined;

    assert.equal(native.notes.size, 3);
    assert.equal(payloadOf(output).createdCount, 2);
    const retryBatchId = output.batchItems!.find(
      (entry) => entry.itemKey === "item:2",
    )!.batchId;
    assert.equal(
      (await getBatchJob(retryBatchId))?.status,
      "completed",
      "the retry's own batch is still closed",
    );
  });

  it("writes no batch row when every paper of the call is already saved", async function () {
    // Two open batches, each holding the other's missing note: A saved
    // paper 1 and owes paper 2; D saved papers 2 and 3 and owes paper 1.
    const earlierBatchId = await (async () => {
      const instance = createNoteWriteBatchTool(gateway);
      const validated = instance.validate({ notes: firstBodies().slice(0, 2) });
      if (!validated.ok) throw new Error("unreachable");
      const ctx = context("run-before-restart");
      await instance.planInvocation(validated.value, ctx);
      unavailableTarget = 2;
      unavailableAfterNotes = 1;
      await rejects(instance.execute(validated.value, ctx));
      unavailableTarget = undefined;
      return (await listResumableBatches(8801))[0].batchId;
    })();
    const [aRow1] = await listBatchItems(earlierBatchId);
    const nativeItem = (globalScope.Zotero as { Item: new () => any }).Item;
    const notesFor = async (parentID: number) => {
      const note = new nativeItem();
      note.parentID = parentID;
      note.setNote(`<p>D note ${parentID}</p>`);
      return note.saveTx() as Promise<number>;
    };
    await createBatchJob({
      jobId: "batch-d",
      conversationKey: 8801,
      action: "note_write_batch",
      input: {
        target: "item",
        notes: [1, 2, 3].map((id) => ({
          itemKey: `item:${id}`,
          targetItemId: id,
        })),
      },
      totalCount: 3,
      now: 1000,
    });
    await createBatchItems(
      "batch-d",
      [1, 2, 3].map((id) => ({
        itemKey: `item:${id}`,
        position: id,
        materialRef: aRow1.materialRef,
      })),
      1000,
    );
    for (const id of [2, 3])
      await markBatchItemSaved("batch-d", `item:${id}`, {
        noteId: await notesFor(id),
      });
    const rawBefore = db
      .prepare(
        `SELECT * FROM llm_for_zotero_agent_batch_items ORDER BY batch_id, position`,
      )
      .all();
    const notesBefore = native.notes.size;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies([1, 2]) },
      context("run-after-restart"),
    );

    assert.equal(native.notes.size, notesBefore, "nothing is written");
    assert.equal(output.effect, "none");
    assert.equal(payloadOf(output).alreadySavedCount, 2);
    assert.deepEqual(
      db
        .prepare(
          `SELECT * FROM llm_for_zotero_agent_batch_items ORDER BY batch_id, position`,
        )
        .all(),
      rawBefore,
      "a call that writes nothing writes no batch row either",
    );
  });

  it("does not report a note as saved when it was trashed while the card was pending", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    const instance = createNoteWriteBatchTool(gateway);
    const validated = instance.validate({ notes: retryBodies() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const ctx = context("run-after-restart");
    await instance.planInvocation(validated.value, ctx);
    // The user trashes the note before approving the card.
    native.notes.get(savedNoteId).deleted = true;
    const output = await instance.execute(validated.value, ctx);

    const payload = payloadOf(output);
    assert.equal(payload.alreadySavedCount, 0);
    const row = (payload.notes as Array<Record<string, unknown>>).find(
      (entry) => entry.itemKey === "item:1",
    );
    assert.equal(row?.status, "error");
    assert.match(String(row?.reason), /trash/);
    assert.isUndefined(
      (output.batchItems || []).find((entry) => entry.itemKey === "item:1"),
      "no outcome announces the trashed note as saved",
    );
  });

  it("settles the other batch when an interrupted retry is resumed", async function () {
    const earlierBatchId = await interruptedFirstRun();
    // The retry is interrupted too, after it wrote paper 2: both batches
    // still owe paper 3.
    const instance = createNoteWriteBatchTool(gateway);
    const validated = instance.validate({ notes: retryBodies() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const ctx = context("run-after-restart");
    await instance.planInvocation(validated.value, ctx);
    unavailableTarget = 3;
    unavailableAfterNotes = 2;
    await rejects(instance.execute(validated.value, ctx));
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    assert.equal(native.notes.size, 2);
    assert.deepEqual(
      (await listBatchItems(earlierBatchId)).map((row) => row.status),
      ["saved", "saved", "pending"],
      "the note the retry wrote before the throw settles the earlier row",
    );
    const retryBatchId = batchJobIds().find((id) => id !== earlierBatchId)!;

    await run(
      createNoteWriteBatchTool(gateway),
      { resumeBatchId: retryBatchId },
      context("run-after-restart"),
    );
    assert.equal(native.notes.size, 3);
    assert.isEmpty(
      await listResumableBatches(8801),
      "resuming one batch leaves the other nothing to offer",
    );
    const again = await run(
      createNoteWriteBatchTool(gateway),
      { resumeBatchId: earlierBatchId },
      context("run-after-restart"),
    );
    assert.equal(again.effect, "none");
    for (const id of [1, 2, 3])
      assert.equal(notesOnPaper(id), 1, `paper ${id} holds one note`);
  });

  it("writes a paper again when the note the earlier batch saved is in the trash", async function () {
    const earlierBatchId = await interruptedFirstRun();
    const savedNoteId = (await listBatchItems(earlierBatchId))[0].noteId!;
    native.notes.get(savedNoteId).deleted = true;

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );

    assert.equal(native.notes.size, 4);
    for (const id of [1, 2, 3])
      assert.equal(notesOnPaper(id), 1, `paper ${id} holds one live note`);
    const payload = payloadOf(output);
    assert.equal(payload.createdCount, 3);
    assert.equal(payload.alreadySavedCount, 0);
    const earlierRows = await listBatchItems(earlierBatchId);
    assert.notEqual(
      earlierRows[0].noteId,
      savedNoteId,
      "the earlier row now names the live note",
    );
    assert.isEmpty(await listResumableBatches(8801));
  });

  it("writes every paper when the earlier batch finished", async function () {
    await run(
      createNoteWriteBatchTool(gateway),
      { notes: firstBodies() },
      context("run-before-restart"),
    );
    assert.equal(native.notes.size, 3);

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart"),
    );

    assert.equal(native.notes.size, 6, "a new request writes new notes");
    assert.equal(payloadOf(output).createdCount, 3);
    assert.equal(payloadOf(output).alreadySavedCount, 0);
  });

  it("writes every paper when the earlier batch belongs to another conversation", async function () {
    const earlierBatchId = await interruptedFirstRun(8801);

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart", 8802),
    );

    assert.equal(native.notes.size, 4);
    assert.equal(payloadOf(output).createdCount, 3);
    assert.deepEqual(
      (await listBatchItems(earlierBatchId)).map((row) => row.status),
      ["saved", "pending", "pending"],
      "another conversation's batch is left as it was",
    );
  });

  it("keeps today's behaviour in the shared standalone conversation", async function () {
    // Standalone MCP clients all report conversation 0, so a batch there may
    // be another client's work; it is never taken as this call's history.
    await interruptedFirstRun(0);

    const output = await run(
      createNoteWriteBatchTool(gateway),
      { notes: retryBodies() },
      context("run-after-restart", 0),
    );

    assert.equal(native.notes.size, 4);
    assert.equal(payloadOf(output).createdCount, 3);
  });
});
