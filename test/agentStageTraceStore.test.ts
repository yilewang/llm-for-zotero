/**
 * Stage events through the real trace store: a stage event survives a write
 * and a read with every field intact, and a material the host announces after
 * the run brackets itself with its own generation stage.
 *
 * Moved from test/planTaskTransitionTransaction.test.ts when the plan engine
 * it shared a fixture with was deleted; neither case needs a plan.
 */
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { announceFinalizedMaterialForRunForTests } from "../src/modules/contextPanel/chat";
import {
  appendAgentRunEvent,
  appendAgentRunEvents,
  compactRunEventForPersistence,
  createAgentRun,
  getAgentRunTrace,
  initAgentTraceStore,
  isTruncatedToolResultContent,
  PERSISTED_TOOL_RESULT_MAX_BYTES,
} from "../src/agent/store/traceStore";
import {
  buildToolResultPreview,
  PREVIEW_MAX_BYTES,
} from "../src/agent/store/truncatedToolResult";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import type { AgentActionReceipt, AgentEvent } from "../src/agent/types";
import { bigPaperReadOverview } from "./helpers/bigPaperReadResult";
import {
  previewListing,
  previewRows,
} from "./helpers/toolResultPreviewPerformance";
import { ensureConversationKeyLedgerEntry } from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

describe("stage events in the trace store", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initAgentTraceStore();
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("round-trips a stage event through the real trace store", async function () {
    // The store has no event-type whitelist by design, so a stage event must
    // survive a real write and read with every field intact.
    const runId = "stage-round-trip";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "stage-instance",
      conversationID: "stage-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "stage-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    const stage: AgentEvent = {
      type: "agent_stage",
      stage: "zotero_action",
      status: "completed",
      callId: "call-1",
      toolName: "note_write",
      toolLabel: "Write note",
      receiptIds: ["receipt-1", "receipt-2"],
      materialRef: {
        documentId: "run:document:1",
        documentVersion: 1,
        contentHash: "sha256:note",
      },
      batchId: "batch-1",
      itemKey: "item:1",
    };
    await appendAgentRunEvent(runId, 1, stage);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage"],
    );
    assert.deepEqual(trace.events[0].payload, stage);
  });

  it("brackets a host-announced material with its own generation stage", async function () {
    // A native run's only material is the one the host announces after the
    // document is delivered. The run already carries stages the bridge
    // emitted, so the compatibility projection will not touch it -- this
    // append has to bracket itself, exactly as the runtime does.
    const runId = "material-stage-append";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "material-instance",
      conversationID: "material-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "material-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    await appendAgentRunEvent(runId, 1, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
    });
    await announceFinalizedMaterialForRunForTests(runId, {
      documentId: "run:document:9",
      documentVersion: 3,
      contentHash: "sha256:report",
      title: "The report",
      version: 2,
      documentKind: "report",
    } as never);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage", "agent_stage", "material_finalized"],
    );
    assert.deepEqual(trace.events[1].payload, {
      type: "agent_stage",
      stage: "generation",
      status: "completed",
      materialRef: {
        documentId: "run:document:9",
        documentVersion: 3,
        contentHash: "sha256:report",
      },
    });
  });
});

/**
 * Big tool results in the trace store: a successful result above the size
 * bound is stored as a marker naming the handle that holds it, unless it
 * carries receipts; everything else is stored whole.
 */
describe("tool results in the trace store", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;
  const runId = "tool-result-compaction";
  const conversationKey = 43;

  /** A Zotero.DB row: reading a column the SELECT did not name throws. */
  function zoteroRow(row: Record<string, unknown>) {
    return new Proxy(row, {
      get(target, prop, receiver) {
        if (
          typeof prop === "string" &&
          prop !== "then" &&
          prop !== "toJSON" &&
          !(prop in target)
        ) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement
              .all(...(bindable(params) as never[]))
              .map((row) => zoteroRow(row as Record<string, unknown>));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    clearAgentToolResultHandleStore();
    await initAgentTraceStore();
    await ensureConversationKeyLedgerEntry({
      conversationKey,
      instanceID: "compaction-instance",
      conversationID: "compaction-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "compaction-profile",
      libraryID: 1,
      paperItemID: conversationKey,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
  });

  afterEach(function () {
    clearAgentToolResultHandleStore();
    db.close();
    globalScope.Zotero = originalZotero;
  });

  function toolResult(
    textLength: number,
    extra: Partial<Extract<AgentEvent, { type: "tool_result" }>> = {},
  ): Extract<AgentEvent, { type: "tool_result" }> {
    return {
      type: "tool_result",
      callId: "call-1",
      name: "paper_read",
      ok: true,
      actionReceipts: [],
      content: { text: "a".repeat(textLength) },
      ...extra,
    };
  }

  const receipt = {
    version: 2,
    id: "receipt-1",
    proposalId: "proposal-1",
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:1"],
    appliedTargets: ["item:1"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
  } as unknown as AgentActionReceipt;

  it("stores a result above the bound as a marker naming its handle", async function () {
    const event = toolResult(40_000, { toolResultHandle: "trh_abc" });
    await appendAgentRunEvent(runId, 1, event);
    const trace = await getAgentRunTrace(runId);
    const payload = trace.events[0].payload as Extract<
      AgentEvent,
      { type: "tool_result" }
    >;
    assert.deepEqual(payload.content, {
      truncated: true,
      handle: "trh_abc",
      bytes: JSON.stringify(event.content).length,
      preview: { text: `${"a".repeat(200)}…` },
    });
    assert.isTrue(isTruncatedToolResultContent(payload.content));
    assert.equal(payload.toolResultHandle, "trh_abc");
    assert.equal(payload.callId, "call-1");
  });

  it("stores whole a big result that carries receipts, a small one, a failed one, and one without a handle", async function () {
    const events: AgentEvent[] = [
      toolResult(40_000, {
        toolResultHandle: "trh_receipt",
        actionReceipts: [receipt],
      }),
      toolResult(1_000, { toolResultHandle: "trh_small" }),
      toolResult(40_000, { ok: false, toolResultHandle: "trh_failed" }),
      toolResult(40_000),
    ];
    for (const [index, event] of events.entries())
      await appendAgentRunEvent(runId, index + 1, event);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.payload),
      events,
    );
  });

  it("leaves other events and old persisted markers alone", function () {
    const delta: AgentEvent = { type: "message_delta", text: "x" };
    assert.strictEqual(compactRunEventForPersistence(delta), delta);
    assert.isFalse(isTruncatedToolResultContent({ text: "a" }));
    assert.isFalse(isTruncatedToolResultContent({ truncated: true }));
    assert.isTrue(isTruncatedToolResultContent({ truncated: true, bytes: 9 }));
    const atBound = toolResult(0, {
      toolResultHandle: "trh_bound",
      content: "a".repeat(PERSISTED_TOOL_RESULT_MAX_BYTES - 2),
    });
    assert.strictEqual(compactRunEventForPersistence(atBound), atBound);
  });

  it("keeps a bounded preview of a 1.3 MB paper read: its mode, receipt and every paper's label", function () {
    const content = bigPaperReadOverview();
    assert.isAbove(JSON.stringify(content).length, 1_300_000);
    const marker = compactRunEventForPersistence(
      toolResult(0, { toolResultHandle: "trh_big", content }),
    ) as Extract<AgentEvent, { type: "tool_result" }>;
    assert.isTrue(isTruncatedToolResultContent(marker.content));
    assert.isBelow(JSON.stringify(marker.content).length, 8 * 1024);
    const preview = (marker.content as { preview?: any }).preview;
    assert.equal(preview.mode, "overview");
    assert.equal(preview.readingReceipt.returnedPapers, 12);
    assert.deepEqual(preview.paperEvidenceProgress, {
      heldPapers: 12,
      advanced: true,
    });
    assert.deepEqual(
      preview.results.map((result: any) => result.citationLabel),
      (content.results as any[]).map((result) => result.citationLabel),
    );
    assert.deepEqual(
      preview.results.map((result: any) => [
        result.totalChunks,
        result.coverage,
        result.backend,
      ]),
      (content.results as any[]).map(() => [240, "capacity_sampled", "mineru"]),
    );
    // The text and the citation list shrink.
    assert.isBelow(preview.results[0].text.length, 202);
    assert.isAtLeast(preview.quoteCitations.length, 3);
    assert.isBelow(preview.quoteCitations.length, 360);
    // The source result is not changed.
    assert.lengthOf(content.quoteCitations as unknown[], 360);
  });

  it("appends a batch of rows in one transaction, in order, compacting big results", async function () {
    const big = toolResult(40_000, { toolResultHandle: "trh_batch" });
    await appendAgentRunEvents(runId, [
      { seq: 1, event: { type: "message_delta", text: "a" }, createdAt: 10 },
      { seq: 2, event: { type: "message_delta", text: "b" }, createdAt: 11 },
      { seq: 3, event: big, createdAt: 12 },
    ]);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => [
        entry.seq,
        entry.eventType,
        entry.createdAt,
      ]),
      [
        [1, "message_delta", 10],
        [2, "message_delta", 11],
        [3, "tool_result", 12],
      ],
    );
    assert.isTrue(
      isTruncatedToolResultContent(
        (trace.events[2].payload as { content?: unknown }).content,
      ),
    );
  });

  it("the handle store keeps a 1.3 MB result and reads it back from the database", async function () {
    const content = {
      results: Array.from({ length: 130 }, (_, index) => ({
        itemId: index + 1,
        text: `${index}:`.padEnd(10_000, "p"),
      })),
    };
    assert.isAbove(JSON.stringify(content).length, 1_300_000);
    // The handle store creates its table once per process; this test's
    // fresh database needs it too, with the store's own schema.
    db.exec(`CREATE TABLE IF NOT EXISTS llm_for_zotero_agent_tool_result_handles (
      conversation_key INTEGER NOT NULL,
      handle TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      input_digest TEXT,
      resource_signature TEXT,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_key, handle)
    )`);
    const record = createAgentToolResultHandleRecord({
      conversationKey,
      toolName: "paper_read",
      toolCallId: "call-big",
      inputDigest: "sha256:input",
      content,
      createdAt: 5,
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);
    // The same content is the same handle: a second write is an upsert.
    const again = createAgentToolResultHandleRecord({
      conversationKey,
      toolName: "paper_read",
      toolCallId: "call-big",
      inputDigest: "sha256:input",
      content,
      createdAt: 6,
    });
    assert.equal(again!.handle, record!.handle);
    await upsertAgentToolResultHandles([again!]);
    clearAgentToolResultHandleStore();
    const stored = await getAgentToolResultHandle({
      conversationKey,
      handle: record!.handle,
    });
    assert.deepEqual(stored?.content, content);
  });

  it("the handle store reports whether a record reached the database", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey,
      toolName: "paper_read",
      toolCallId: "call-confirm",
      inputDigest: "sha256:input",
      content: { text: "kept" },
      createdAt: 5,
    })!;
    // The store creates its table once per process; this database is fresh.
    db.exec(`CREATE TABLE IF NOT EXISTS llm_for_zotero_agent_tool_result_handles (
      conversation_key INTEGER NOT NULL,
      handle TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      input_digest TEXT,
      resource_signature TEXT,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_key, handle)
    )`);
    assert.isTrue(await upsertAgentToolResultHandles([record]));
    const zotero = globalScope.Zotero as {
      DB: { queryAsync: (sql: string, params?: unknown[]) => unknown };
    };
    const query = zotero.DB.queryAsync;
    zotero.DB.queryAsync = async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT OR REPLACE INTO llm_for_zotero_agent_tool"))
        throw new Error("database is locked");
      return query(sql, params);
    };
    assert.isFalse(
      await upsertAgentToolResultHandles([{ ...record, createdAt: 6 }]),
      "a write the database refused is not reported as stored",
    );
    assert.isFalse(await upsertAgentToolResultHandles([]));
  });

  it("builds a big result's preview before the batch transaction opens", async function () {
    let inTransaction = false;
    let readInside = 0;
    const zotero = globalScope.Zotero as {
      DB: { executeTransaction: (task: () => Promise<unknown>) => unknown };
    };
    const transaction = zotero.DB.executeTransaction;
    zotero.DB.executeTransaction = async (task) =>
      transaction(async () => {
        inTransaction = true;
        try {
          return await task();
        } finally {
          inTransaction = false;
        }
      });
    const content: Record<string, unknown> = {};
    Object.defineProperty(content, "text", {
      enumerable: true,
      get() {
        if (inTransaction) readInside += 1;
        return "a".repeat(40_000);
      },
    });
    await appendAgentRunEvents(runId, [
      {
        seq: 1,
        event: toolResult(0, { toolResultHandle: "trh_outside", content }),
        createdAt: 10,
      },
    ]);
    const trace = await getAgentRunTrace(runId);
    const persisted = (trace.events[0].payload as { content?: unknown })
      .content as { preview?: { text?: string } };
    assert.isTrue(isTruncatedToolResultContent(persisted));
    assert.equal(persisted.preview?.text, `${"a".repeat(200)}\u2026`);
    assert.equal(readInside, 0, "the transaction only inserts rows");
  });
});

describe("tool result preview cost", function () {
  function entryCount(value: unknown): number {
    if (value === null || typeof value !== "object") return 0;
    const entries = Object.values(value);
    return (
      entries.length +
      entries.reduce((sum, entry) => sum + entryCount(entry), 0)
    );
  }

  function measuredPreview(content: unknown, exercise?: () => void) {
    const entries = Object.entries;
    const values = Object.values;
    const stringify = JSON.stringify;
    const iterator = Array.prototype[Symbol.iterator];
    const filter = Array.prototype.filter;
    const reduce = Array.prototype.reduce;
    const slice = Array.prototype.slice;
    let enumeratedEntries = 0;
    let arrayEntriesVisited = 0;
    let serializations = 0;
    let compositeSerializations = 0;
    let serializedChars = 0;
    Object.entries = ((value: object) => {
      const result = entries(value);
      enumeratedEntries += result.length;
      return result;
    }) as typeof Object.entries;
    Object.values = ((value: object) => {
      const result = values(value);
      enumeratedEntries += result.length;
      return result;
    }) as typeof Object.values;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      serializations += 1;
      if (args[0] !== null && typeof args[0] === "object")
        compositeSerializations += 1;
      const json = stringify.apply(JSON, args);
      serializedChars += json?.length ?? 0;
      return json;
    }) as typeof JSON.stringify;
    Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
      for (let index = 0; index < this.length; index += 1) {
        arrayEntriesVisited += 1;
        yield this[index];
      }
    } as typeof iterator;
    Array.prototype.filter = function (this: unknown[], ...args: unknown[]) {
      arrayEntriesVisited += this.length;
      return Reflect.apply(filter, this, args);
    } as typeof Array.prototype.filter;
    Array.prototype.reduce = function (this: unknown[], ...args: unknown[]) {
      arrayEntriesVisited += this.length;
      return Reflect.apply(reduce, this, args);
    } as typeof Array.prototype.reduce;
    Array.prototype.slice = function (this: unknown[], ...args: unknown[]) {
      const result = Reflect.apply(slice, this, args) as unknown[];
      arrayEntriesVisited += result.length;
      return result;
    } as typeof Array.prototype.slice;
    try {
      exercise?.();
      const preview = buildToolResultPreview(content);
      return {
        preview,
        enumeratedEntries,
        arrayEntriesVisited,
        serializations,
        compositeSerializations,
        serializedChars,
      };
    } finally {
      Object.entries = entries;
      Object.values = values;
      JSON.stringify = stringify;
      Array.prototype[Symbol.iterator] = iterator;
      Array.prototype.filter = filter;
      Array.prototype.reduce = reduce;
      Array.prototype.slice = slice;
    }
  }

  it("restores traversal and serialization APIs after successful and refused previews", function () {
    const entries = Object.entries;
    const values = Object.values;
    const stringify = JSON.stringify;
    const iterator = Array.prototype[Symbol.iterator];
    const filter = Array.prototype.filter;
    const reduce = Array.prototype.reduce;
    const slice = Array.prototype.slice;
    const refused = {
      get text() {
        throw new Error("unreadable result");
      },
    };
    for (const content of [previewRows(30), refused]) {
      const measured = measuredPreview(content);
      assert.strictEqual(Object.entries, entries);
      assert.strictEqual(Object.values, values);
      assert.strictEqual(JSON.stringify, stringify);
      assert.strictEqual(Array.prototype[Symbol.iterator], iterator);
      assert.strictEqual(Array.prototype.filter, filter);
      assert.strictEqual(Array.prototype.reduce, reduce);
      assert.strictEqual(Array.prototype.slice, slice);
      if (content === refused) assert.isUndefined(measured.preview);
      else assert.exists(measured.preview);
    }
  });

  it("counts negative-end slices as copied array work", function () {
    const source = Array.from({ length: 20 }, (_, index) => index);
    const measured = measuredPreview({ ok: true }, () => {
      for (let index = 0; index < source.length; index += 1)
        source.slice(0, -1);
    });
    assert.isAtLeast(measured.arrayEntriesVisited, 20 * 19);
  });

  it("previews 3,000 rows of five-entry arrays and a 1,000-item listing with bounded linear work", function () {
    const contents = [
      previewRows(3_000),
      previewRows(1_000),
      previewListing(1_000),
    ];
    const originals = contents.map((content) => JSON.stringify(content));
    const [big, small, items] = contents.map((content, index) => {
      const inputEntries = entryCount(content);
      const measured = measuredPreview(content);
      // At most two copy/measurement passes and two whole-copy serializations.
      // Count volume too: serializing a growing array repeatedly is quadratic
      // even when the number of stringify calls is only linear.
      assert.isAtMost(
        measured.enumeratedEntries,
        2 * inputEntries,
        "enumerated entries",
      );
      assert.isAtMost(
        measured.arrayEntriesVisited,
        4 * inputEntries,
        "array entries visited or copied",
      );
      assert.isAtMost(
        measured.serializations,
        2 * inputEntries,
        "serialization calls",
      );
      assert.isAtMost(
        measured.compositeSerializations,
        2,
        "whole-copy serializations",
      );
      assert.isAtMost(
        measured.serializedChars,
        2 * originals[index].length,
        "serialized characters",
      );
      assert.equal(
        JSON.stringify(content),
        originals[index],
        "the source is not changed",
      );
      return measured;
    });
    for (const { preview } of [big, small, items]) {
      assert.exists(preview);
      assert.isAtMost(JSON.stringify(preview).length, PREVIEW_MAX_BYTES);
    }
    const listed = items.preview as ReturnType<typeof previewListing>;
    assert.equal(listed.mode, "list");
    assert.equal(listed.totalCount, 1_000);
    assert.isAtLeast(listed.items.length, 3);
    // Every kept row keeps its fields, its arrays cut to at least three.
    for (const item of listed.items) {
      assert.isAtLeast(item.creators.length, 3);
      assert.equal(item.year, "2020");
    }
  });

  it("keeps a preview that fits untouched and refuses one that never fits", function () {
    const small = { mode: "list", items: [1, 2, 3, 4, 5, 6] };
    assert.deepEqual(buildToolResultPreview(small), small);
    // Keys alone exceed the bound: no copy fits.
    const keys = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`key_${index}`, index]),
    );
    assert.isUndefined(buildToolResultPreview(keys));
  });
});
