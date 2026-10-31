import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import {
  initAgentChangeJournal,
  JOURNAL_ACTIONS_TABLE,
} from "../src/agent/store/changeJournal";
import {
  initPlanDocumentStore,
  loadLatestDocumentForRun,
  loadPlanDocument,
} from "../src/agent/documents/store";
import {
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
} from "../src/agent/store/batchItemStore";
import {
  getBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import {
  describeLibraryMutationActions,
  nativeNoteWriteFacts,
} from "../src/agent/contracts/actionOperationEvidence";
import { renderRawNoteHtml } from "../src/services/notes/noteRendering";
import { canonicalJsonEqual } from "../src/agent/services/libraryMutation/canonicalJson";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import { MutationStateView } from "../src/agent/services/libraryMutation/stateView";
import type { AgentToolContext } from "../src/agent/types";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { innermostToolResult } from "../src/agent/contracts/toolResultEnvelope";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

/**
 * A batch of notes is N pieces of authored material, not one.
 *
 * Nothing froze the bodies the model wrote, so a retry after a crash could
 * write different text than the user approved, and nothing recorded which of
 * the fifty notes had already landed. Finalizing each body as its own durable
 * document before the first write is what makes both answerable.
 */
describe("note batch material", function () {
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  let failOnParent: number | undefined;
  let libraryUnavailable = false;

  function libraryItem(id: number) {
    return {
      id,
      libraryID: 1,
      parentID: false,
      deleted: false,
      version: 1,
      dateModified: "2026-09-11 10:00:00",
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
      if (libraryUnavailable) throw new Error("Zotero is unavailable");
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

  function context(runId = "run-batch-1"): AgentToolContext {
    return {
      request: {
        conversationKey: 8801,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId,
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } as unknown as AgentToolContext;
  }

  function notes() {
    return [
      { targetItemId: 1, content: "Summary of paper one." },
      { targetItemId: 2, content: "## Findings\n\nSummary of paper two." },
      { targetItemId: 3, content: "Summary of paper three." },
    ];
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    failOnParent = undefined;
    libraryUnavailable = false;
    db = new DatabaseSync(":memory:");
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
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
    native = installNativeNoteStore({
      startId: 500,
      onSave: (note: { parentID?: number }) => {
        if (failOnParent !== undefined && note.parentID === failOnParent)
          throw new Error("Zotero refused the note write");
      },
    });
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

  function validated(tool: ReturnType<typeof createNoteWriteBatchTool>) {
    const result = tool.validate({ notes: notes() });
    assert.isTrue(result.ok);
    if (!result.ok) throw new Error("validation failed");
    return result.value;
  }

  /** The host prepares a write tool before it asks the user to approve it. */
  async function prepare(
    tool: ReturnType<typeof createNoteWriteBatchTool>,
    input: ReturnType<typeof validated>,
    ctx = context(),
  ) {
    await tool.planInvocation(input, ctx);
    return input;
  }

  function runDocuments(runId = "run-batch-1") {
    return (
      db
        .prepare(
          `SELECT payload_json AS payloadJson FROM llm_for_zotero_plan_documents WHERE run_id = ?`,
        )
        .all(runId) as Array<{ payloadJson: string }>
    ).map(
      (row) =>
        JSON.parse(row.payloadJson) as {
          title: string;
          visibleMarkdown: string;
          visibleHtml: string;
        },
    );
  }

  function checklist(
    tool: ReturnType<typeof createNoteWriteBatchTool>,
    input: ReturnType<typeof validated>,
  ) {
    const action = tool.createPendingAction?.(input, context());
    return (
      action?.fields?.[0] as {
        items: Array<{ id: string; label: string; description?: string }>;
      }
    ).items;
  }

  function flattened(text: string): string {
    const value = text.replace(/\s+/g, " ").trim();
    return value.length > 160 ? `${value.slice(0, 160)}\u2026` : value;
  }

  function documentCount(): number {
    const rows = db
      .prepare(`SELECT COUNT(*) AS total FROM llm_for_zotero_plan_documents`)
      .all() as Array<{ total: number }>;
    return Number(rows[0].total);
  }

  it("finalizes one document per item before any note is written", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    assert.equal(documentCount(), 3, "one finalized document per note body");
    assert.lengthOf(output.batchItems || [], 3);
    const batchId = output.batchItems![0].batchId;
    const rows = await listBatchItems(batchId);
    assert.lengthOf(rows, 3);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      rows.map((row) => row.itemKey),
      ["item:1", "item:2", "item:3"],
    );
    // Each item's material is a distinct durable identity, not one shared ref.
    assert.lengthOf(new Set(rows.map((row) => row.materialRef.documentId)), 3);
    for (const row of rows) {
      assert.isString(row.actionId);
      assert.isNumber(row.stepSequence);
      assert.isNumber(row.noteId);
    }
    // One journal action owns every step, as Task 1 established.
    assert.lengthOf(new Set(rows.map((row) => row.actionId)), 1);
    // The module owns the public name, so the journal records it with no
    // facade supplying journalToolName.
    const journaled = db
      .prepare(
        `SELECT tool_name AS toolName FROM ${JOURNAL_ACTIONS_TABLE} WHERE action_id = ?`,
      )
      .get(rows[0].actionId) as { toolName: string } | undefined;
    assert.equal(journaled?.toolName, "note_write_batch");

    const job = await getBatchJob(batchId);
    assert.equal(job?.action, "note_write_batch");
    assert.equal(job?.totalCount, 3);
    assert.equal(job?.appliedCount, 3);
    assert.equal(job?.cursor, 3);
    assert.equal(job?.status, "completed");
  });

  it("writes the stored document's HTML, not the model-supplied body", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    const rows = await listBatchItems(output.batchItems![0].batchId);
    for (const row of rows) {
      const document = await loadPlanDocument(row.materialRef.documentId);
      assert.exists(document, "the item's material must still be stored");
      assert.equal(document!.contentHash, row.materialRef.contentHash);
      const note = native.notes.get(row.noteId!);
      assert.exists(note, "every saved row names a real note");
      assert.equal(
        note.stored,
        document!.visibleHtml,
        "the note carries exactly the finalized material",
      );
    }
  });

  it("reuses the run's documents when the same bodies are written again", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const first = await tool.execute(validated(tool), context());
    const second = await tool.execute(validated(tool), context());

    assert.equal(documentCount(), 3, "a retry mints no new documents");
    assert.deepEqual(
      (second.batchItems || []).map((entry) => entry.materialRef),
      (first.batchItems || []).map((entry) => entry.materialRef),
    );
  });

  it("marks only the item that failed, keeping the others written", async function () {
    failOnParent = 2;
    const tool = createNoteWriteBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());

    const batchId = output.batchItems![0].batchId;
    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    const failed = rows[1];
    assert.include(failed.error || "", "Zotero refused the note write");
    assert.isUndefined(failed.noteId);
    // Its material survives the failure, so a resume never regenerates it.
    assert.exists(await loadPlanDocument(failed.materialRef.documentId));

    const job = await getBatchJob(batchId);
    assert.equal(job?.appliedCount, 2);
    assert.equal(job?.status, "failed");

    assert.deepEqual(
      (output.batchItems || []).map((entry) => entry.status),
      ["saved", "failed", "saved"],
    );
  });

  it("executes the very operation the action contract proposed", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = validated(tool);
    const proposed = describeLibraryMutationActions(input);
    const output = await tool.execute(input, context());

    // A receipt counts as verified only when the recorded evidence names the
    // same operation the user approved, so host bookkeeping must not ride
    // inside the operation value.
    assert.lengthOf(output.actionEvidence || [], 1);
    assert.isTrue(
      canonicalJsonEqual(
        output.actionEvidence![0].operationValue,
        proposed[0].operationValue,
      ),
      "the executed operation must still equal the proposed one",
    );
  });

  it("refuses a batch whose rows do not describe its notes", async function () {
    const service = new LibraryMutationService(gateway);
    let failure: unknown;
    try {
      await service.executeOperation(
        { type: "save_notes_batch", notes: notes() },
        {
          ...context(),
          // Misaligned rows would write paper 1's approved material onto
          // paper 2, durably, so nothing may be written at all.
          batchBinding: {
            batchId: "batch-wrong",
            items: [
              {
                itemKey: "item:3",
                targetItemId: 3,
                material: {
                  documentId: "run-batch-1:document:1",
                  documentVersion: 1,
                  contentHash: "sha256:whatever",
                },
              },
            ],
          },
        } as never,
      );
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.include(
      (failure as Error).message,
      "The batch rows do not describe these notes",
    );
    assert.equal(native.notes.size, 0, "no note may be written");
  });

  it("is never mistaken for the run's finalized document", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    await tool.execute(validated(tool), context());

    // External backends replace the turn's answer with the run's finalized
    // document, so a note body picked up here would be spoken as the answer.
    assert.isNull(await loadLatestDocumentForRun("run-batch-1"));
  });

  it("retries into the same batch instead of orphaning the first", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    failOnParent = 2;
    const first = await tool.execute(
      await prepare(tool, validated(tool)),
      context(),
    );
    const batchId = first.batchItems![0].batchId;
    const interrupted = await listBatchItems(batchId);
    assert.deepEqual(
      interrupted.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    assert.deepEqual(
      (await listResumableBatches(8801)).map((entry) => entry.batchId),
      [batchId],
    );

    failOnParent = undefined;
    const second = await tool.execute(
      await prepare(tool, validated(tool)),
      context(),
    );

    // A fresh batch id per call would leave the first batch resumable for
    // ever, and Task 3 would then write every note a second time.
    assert.equal(second.batchItems![0].batchId, batchId);
    assert.equal(native.notes.size, 3, "only the failed item is written again");
    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      rows.map((row) => row.createdAt),
      interrupted.map((row) => row.createdAt),
      "the durable rows are reused, never re-seeded",
    );
    assert.isEmpty(await listResumableBatches(8801));
  });

  it("stores a note body the way a single note write would", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const output = await tool.execute(
      await prepare(tool, validated(tool)),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    const bodies = notes();
    for (const [index, row] of rows.entries()) {
      const note = native.notes.get(row.noteId!);
      // No synthetic title heading, and the same normalization note_write
      // applies: the two tools must store the same text.
      assert.equal(note.stored, renderRawNoteHtml(bodies[index].content));
    }
  });

  it("accepts note bodies that are not publishable documents", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({
      notes: [
        {
          targetItemId: 1,
          content: "See ![Figure 1](https://example.com/f1.png) for the curve.",
        },
        { targetItemId: 2, content: "Data lives in /Users/me/data/set.csv" },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;

    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved"],
      "a note may say what a published document may not",
    );
  });

  it("fails only the item whose body could not be finalized", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({
      notes: [
        { targetItemId: 1, content: "A fine note." },
        { targetItemId: 2, content: "x".repeat(2 * 1024 * 1024 + 16) },
        { targetItemId: 3, content: "Another fine note." },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;

    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "failed", "saved"],
      "one unusable body must not cost the other notes",
    );
    assert.isUndefined(rows[1].materialRef);
    assert.equal(native.notes.size, 2, "the failed item writes no note");
  });

  it("previews the finalized text on the confirmation card", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = await prepare(tool, validated(tool));

    const items = checklist(tool, input);
    assert.equal(
      tool.createPendingAction?.(input, context())?.toolName,
      "note_write_batch",
    );
    const byTitle = new Map(
      runDocuments().map((document) => [document.title, document]),
    );
    assert.lengthOf(items, 3);
    for (const item of items) {
      const document = byTitle.get(item.label);
      assert.exists(document, `no finalized material for ${item.label}`);
      assert.equal(
        item.description,
        flattened(document!.visibleMarkdown),
        "the user approves the text that will actually be written",
      );
    }
  });

  it("writes nothing until the batch is approved", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    await prepare(tool, validated(tool));

    assert.equal(documentCount(), 3, "material is frozen before approval");
    assert.equal(native.notes.size, 0, "a denied batch writes no note");
    assert.isEmpty(
      db.prepare(`SELECT batch_id FROM llm_for_zotero_agent_batch_items`).all(),
      "a denied batch leaves nothing to resume",
    );
  });

  it("keeps material aligned with the notes left checked", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = await prepare(tool, validated(tool));
    const applied = tool.applyConfirmation?.(
      input,
      { writeNotesChecklist: ["1", "3"] },
      context(),
    );
    assert.isTrue(applied?.ok);
    if (!applied?.ok) return;

    const output = await tool.execute(applied.value, context());
    const rows = await listBatchItems(output.batchItems![0].batchId);
    assert.deepEqual(
      rows.map((row) => row.itemKey),
      ["item:1", "item:3"],
    );
    const bodies = notes();
    for (const [index, row] of rows.entries()) {
      const note = native.notes.get(row.noteId!);
      assert.equal(
        note.stored,
        renderRawNoteHtml(bodies[index === 0 ? 0 : 2].content),
      );
    }
  });

  it("writes nothing again for an item its rows already name", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const first = await tool.execute(
      await prepare(tool, validated(tool)),
      context(),
    );
    const batchId = first.batchItems![0].batchId;
    const written = await listBatchItems(batchId);
    assert.equal(native.notes.size, 3);

    const second = await tool.execute(
      await prepare(tool, validated(tool)),
      context(),
    );

    // Inside a batch action `executeNoteCreation` has no journal recovery to
    // deduplicate against, so an unskipped item would mint a second note and
    // the row would forget the first one.
    assert.equal(native.notes.size, 3, "no second note for a written item");
    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.noteId),
      written.map((row) => row.noteId),
      "each row still names the note it wrote",
    );
    const payload = (
      second.content as { result: { result: Record<string, unknown> } }
    ).result.result;
    assert.equal(payload.createdCount, 0);
    assert.equal(payload.alreadySavedCount, 3);
    assert.deepEqual(
      (payload.notes as Array<{ status: string }>).map((row) => row.status),
      ["already_saved", "already_saved", "already_saved"],
    );
    assert.equal(second.effect, "none");
  });

  it("seeds an item that has no material as failed, never pending", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({
      notes: [
        { targetItemId: 1, content: "A fine note." },
        { targetItemId: 2, content: "x".repeat(2 * 1024 * 1024 + 16) },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    await prepare(tool, input.value);

    // The rows are seeded, then the write never reaches them. A `pending` row
    // with no material would tell a resume to write a note it cannot build.
    libraryUnavailable = true;
    await rejects(tool.execute(input.value, context()));

    const seeded = db
      .prepare(
        `SELECT status, error, material_document_id AS materialDocumentId
         FROM llm_for_zotero_agent_batch_items ORDER BY position`,
      )
      .all() as Array<{
      status: string;
      error: string | null;
      materialDocumentId: string | null;
    }>;
    assert.deepEqual(
      seeded.map((row) => row.status),
      ["pending", "failed"],
    );
    assert.isNull(seeded[1].materialDocumentId);
    assert.include(seeded[1].error || "", "2 MiB");
  });

  /** Let the batch's papers be cited the way Zotero resolves them. */
  function citablePapers() {
    const zotero = globalScope.Zotero as any;
    const notesOnly = zotero.Items;
    zotero.Items = {
      ...notesOnly,
      get: (id: number) =>
        targets.has(id)
          ? { ...targets.get(id), key: `PAPER${id}` }
          : notesOnly.get(id),
    };
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
  }

  function citationNotes() {
    return [
      { targetItemId: 1, content: "Drift is fast {{cite item=1 page=4}}." },
      { targetItemId: 2, content: "Drift is slow {{cite:item=2}}." },
      { targetItemId: 3, content: "Drift is absent." },
    ];
  }

  it("writes a batch item's citation request as a Zotero citation chip", async function () {
    citablePapers();
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({ notes: citationNotes() });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    const html = native.notes.get(rows[0].noteId!)?.stored || "";
    assert.match(
      html,
      /^<div data-citation-items="[^"]+" data-schema-version="9">/,
    );
    assert.include(html, 'class="citation-item">Smith, 2020, p. 4</span>');
    assert.notInclude(html, "{{cite");

    // The receipt proves each written note against the expanded HTML.
    const noteWrites = (output.actionEvidence?.[0] as any)?.noteWrites;
    assert.lengthOf(noteWrites || [], 2);
    assert.equal(noteWrites[0].verification.expectedHtml, html);
    const receipt = await nativeNoteWriteFacts(
      describeLibraryMutationActions(input.value)[0],
      noteWrites,
      gateway,
    );
    assert.isEmpty(receipt.reasons);
    assert.include(receipt.facts, `created_note:item:${rows[0].noteId}`);
  });

  it("verifies a cited batch note against the chip text it stored, not the citation request", async function () {
    citablePapers();
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({
      notes: [
        { targetItemId: 1, content: "Drift is fast {{cite item=1 page=4}}." },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    const stored = native.notes.get(rows[0].noteId!)?.stored || "";
    assert.include(stored, 'class="citation-item">Smith, 2020, p. 4</span>');
    const handler = libraryMutationHandlers.save_notes_batch;
    const operation = input.value.operation!;
    const state = (noteHtml: string) =>
      new MutationStateView({
        version: 1,
        operation: "save_notes_batch",
        items: [
          {
            itemId: rows[0].noteId!,
            exists: true,
            parentItemId: 1,
            noteHtml,
          },
        ],
      });
    assert.isTrue(handler.postconditionSatisfied(operation, state(stored)));
    // A body that is not the one approved still fails.
    assert.isFalse(
      handler.postconditionSatisfied(
        operation,
        state(stored.replace("Drift is fast", "Drift is slow")),
      ),
    );
    // A request that cannot be expanded is compared as written, so it fails.
    assert.isFalse(
      handler.postconditionSatisfied(
        {
          ...operation,
          notes: [{ targetItemId: 1, content: "Drift {{cite item=99}}." }],
        },
        state(stored),
      ),
    );
  });

  it("tells apart two cited works that share a label, and looks nothing up for a note without citations", async function () {
    citablePapers();
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({
      notes: [
        { targetItemId: 1, content: "Drift is fast {{cite item=1 page=4}}." },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    const stored = native.notes.get(rows[0].noteId!)?.stored || "";
    const handler = libraryMutationHandlers.save_notes_batch;
    const judge = (content: string, noteHtml = stored) =>
      handler.postconditionSatisfied(
        {
          type: "save_notes_batch",
          target: "item",
          notes: [{ targetItemId: 1, content }],
        },
        new MutationStateView({
          version: 1,
          operation: "save_notes_batch",
          items: [
            {
              itemId: rows[0].noteId!,
              exists: true,
              parentItemId: 1,
              noteHtml,
            },
          ],
        }),
      );
    // Papers 1 and 2 show the same label, "Smith, 2020, p. 4", but cite
    // different items; the stored chip cites paper 1.
    assert.isTrue(judge("Drift is fast {{cite item=1 page=4}}."));
    assert.isFalse(judge("Drift is fast {{cite item=2 page=4}}."));
    // The same item at another page is another chip.
    assert.isFalse(
      judge(
        "Drift is fast {{cite item=1 page=4}}.",
        stored.replace(/p\. 4/g, "p. 5"),
      ),
    );

    // A note without a citation request needs no library lookup.
    const zotero = globalScope.Zotero as any;
    const lookups: unknown[] = [];
    const items = zotero.Items;
    zotero.Items = {
      ...items,
      get: (id: number) => {
        lookups.push(id);
        return items.get(id);
      },
    };
    try {
      assert.isTrue(judge("Plain text.", "<p>Plain text.</p>"));
      assert.isEmpty(lookups, "no lookup for a body without citations");
    } finally {
      zotero.Items = items;
    }
  });

  it("fails only the batch item whose citation request is malformed", async function () {
    citablePapers();
    const tool = createNoteWriteBatchTool(gateway);
    const input = tool.validate({ notes: citationNotes() });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const output = await tool.execute(
      await prepare(tool, input.value),
      context(),
    );
    const rows = await listBatchItems(output.batchItems![0].batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    assert.include(rows[1].error || "", "is not a citation request");
    assert.equal(native.notes.size, 2, "the malformed item writes no note");
    for (const note of native.notes.values())
      assert.notInclude(note.stored, "{{cite");
  });

  it("expands citation requests in a batch written outside a durable batch", async function () {
    citablePapers();
    const service = new LibraryMutationService(gateway);
    const executed = (await service.executeOperation(
      { type: "save_notes_batch", notes: citationNotes() },
      context() as never,
    )) as any;
    const result = innermostToolResult(executed);
    const rows = result.notes as Array<{ status: string; reason?: string }>;
    assert.deepEqual(
      rows.map((row) => row.status),
      ["created", "error", "created"],
    );
    assert.include(rows[1].reason || "", "is not a citation request");
    const written = [...native.notes.values()].map((note) => note.stored);
    assert.lengthOf(written, 2);
    assert.include(
      written[0],
      'class="citation-item">Smith, 2020, p. 4</span>',
    );
    assert.notInclude(written[0], "{{cite");
  });

  it("never announces a batch item as the turn's finalized material", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const output = await tool.execute(validated(tool), context());
    assert.isUndefined(
      (output as { materialRef?: unknown }).materialRef,
      "batch material is announced per item, never as one turn material",
    );
  });
});
