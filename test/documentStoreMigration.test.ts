import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  initPlanDocumentStore,
  loadDocumentActionState,
  loadDocumentIdForMessageOwner,
  loadPlanDocument,
  loadPlanDocumentOutbox,
  PLAN_DOCUMENT_ACTION_STATE_TABLE,
  PLAN_DOCUMENT_COVERAGE_TABLE,
  PLAN_DOCUMENT_OUTBOX_TABLE,
  PLAN_DOCUMENT_OWNERS_TABLE,
  PLAN_DOCUMENTS_TABLE,
} from "../src/agent/documents/store";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

describe("DocumentArtifactV2 store migration", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  beforeEach(function () {
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
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("preserves legacy IDs, coverage, outbox, ownership, and action state", async function () {
    const coverageItem = {
      libraryID: 1,
      itemKey: "AAAA1111",
      title: "Paper",
      status: "included",
      evidenceDepth: "body",
    };
    const document = {
      version: 1,
      documentId: "document-legacy",
      documentVersion: 1,
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      conversationKey: 41,
      parentTaskId: "task-1",
      contractDigest: "sha256:contract",
      title: "Legacy review",
      visibleMarkdown: "# Legacy review\n\nComplete.",
      visibleHtml: "<h1>Legacy review</h1><p>Complete.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [],
      assets: [],
      coverageStatus: "complete",
      coverageItems: [coverageItem],
      validation: {
        integrityValidated: true,
        groundingReviewed: "passed",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:legacy",
      createdAt: 100,
    };
    const outbox = {
      version: 1,
      outboxId: "document-legacy:message",
      documentId: "document-legacy",
      conversationKey: 41,
      messageTimestamp: 200,
      visibleMarkdown: document.visibleMarkdown,
      status: "delivered",
      attemptCount: 1,
      createdAt: 100,
      updatedAt: 200,
      deliveredAt: 200,
    };
    const actionState = {
      version: 1,
      documentId: "document-legacy",
      lastExportedAt: 210,
      lastExportedName: "legacy.md",
      updatedAt: 210,
    };

    db.exec(`
      CREATE TABLE ${PLAN_DOCUMENTS_TABLE} (
        document_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL, execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL, parent_task_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE ${PLAN_DOCUMENT_COVERAGE_TABLE} (
        document_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
        status TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY (document_id, library_id, item_key)
      );
      CREATE TABLE ${PLAN_DOCUMENT_OUTBOX_TABLE} (
        outbox_id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE,
        conversation_key INTEGER NOT NULL, status TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ${PLAN_DOCUMENT_OWNERS_TABLE} (
        document_id TEXT NOT NULL, conversation_key INTEGER NOT NULL,
        source_message_timestamp INTEGER NOT NULL,
        PRIMARY KEY (document_id, conversation_key)
      );
      CREATE TABLE ${PLAN_DOCUMENT_ACTION_STATE_TABLE} (
        document_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO ${PLAN_DOCUMENTS_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      document.documentId,
      document.planId,
      document.planRevision,
      document.executionId,
      document.conversationKey,
      document.parentTaskId,
      document.contentHash,
      JSON.stringify({ ...document, coverageItems: [] }),
      document.createdAt,
    );
    db.prepare(
      `INSERT INTO ${PLAN_DOCUMENT_COVERAGE_TABLE} VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      document.documentId,
      0,
      coverageItem.libraryID,
      coverageItem.itemKey,
      coverageItem.status,
      JSON.stringify(coverageItem),
    );
    db.prepare(
      `INSERT INTO ${PLAN_DOCUMENT_OUTBOX_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      outbox.outboxId,
      outbox.documentId,
      outbox.conversationKey,
      outbox.status,
      JSON.stringify(outbox),
      outbox.createdAt,
      outbox.updatedAt,
    );
    db.prepare(
      `INSERT INTO ${PLAN_DOCUMENT_OWNERS_TABLE} VALUES (?, ?, ?)`,
    ).run(document.documentId, document.conversationKey, 200);
    db.prepare(
      `INSERT INTO ${PLAN_DOCUMENT_ACTION_STATE_TABLE} VALUES (?, ?, ?)`,
    ).run(document.documentId, JSON.stringify(actionState), 210);

    await initPlanDocumentStore();

    const migrated = await loadPlanDocument(document.documentId);
    assert.equal(migrated?.documentId, "document-legacy");
    assert.equal(migrated?.version, 1);
    assert.lengthOf(migrated?.coverageItems || [], 1);
    assert.deepInclude(migrated?.coverageItems[0] || {}, coverageItem);
    assert.equal(
      (
        db
          .prepare(
            `SELECT origin_kind AS originKind FROM ${PLAN_DOCUMENTS_TABLE}`,
          )
          .get() as { originKind?: string }
      ).originKind,
      "planned",
    );
    assert.equal(
      (await loadPlanDocumentOutbox(document.documentId))?.status,
      "delivered",
    );
    assert.equal(
      await loadDocumentIdForMessageOwner({
        conversationKey: 41,
        sourceMessageTimestamp: 200,
      }),
      document.documentId,
    );
    assert.deepInclude(
      (await loadDocumentActionState(document.documentId)) || {},
      actionState,
    );
  });
});
