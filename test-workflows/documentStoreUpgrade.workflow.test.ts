/**
 * A v1 plan-document database across a real Zotero restart. The `seed` phase
 * replaces this build's document tables with the v1 shape (no origin_kind)
 * and fills them; Zotero quits; the `verify` phase starts a new Zotero on a
 * copy of that data folder, so the plugin's own startup migrates it.
 * `npm run test:document-store-upgrade` runs both phases
 * (scripts/run-document-store-upgrade-test.mjs); in an ordinary run
 * DOCUMENT_STORE_UPGRADE_PHASE is unset and these tests do nothing.
 */
import { assert } from "chai";
import {
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

declare const Zotero: any;

function upgradePhase(): string {
  return String(
    (globalThis as any).Services?.env?.get?.("DOCUMENT_STORE_UPGRADE_PHASE") ||
      "",
  );
}

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

describe("workflow: plan document store upgrade across a Zotero restart", function () {
  this.timeout(180000);

  async function waitForPlugin(): Promise<void> {
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    for (
      let waited = 0;
      waited < 100 && !Zotero.LLMForZotero?.api?.workflowTest;
      waited += 1
    )
      await Zotero.Promise.delay(100);
    await Zotero.Promise.delay(1000);
  }

  it("seed phase: replaces the document tables with the v1 shape and rows", async function () {
    if (upgradePhase() !== "seed") this.skip();
    await waitForPlugin();
    assert.match(
      Zotero.DataDirectory.dir,
      /[/\\]\.scaffold[/\\]test[/\\]data[/\\]?$/,
      "never rewrite the user's own library",
    );
    const q = (sql: string, params?: unknown[]) =>
      Zotero.DB.queryAsync(sql, params);
    await Zotero.DB.executeTransaction(async () => {
      for (const table of [
        PLAN_DOCUMENTS_TABLE,
        PLAN_DOCUMENT_COVERAGE_TABLE,
        PLAN_DOCUMENT_OUTBOX_TABLE,
        PLAN_DOCUMENT_OWNERS_TABLE,
        PLAN_DOCUMENT_ACTION_STATE_TABLE,
      ])
        await q(`DROP TABLE IF EXISTS ${table}`);
      await q(`
        CREATE TABLE ${PLAN_DOCUMENTS_TABLE} (
          document_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL, execution_id TEXT NOT NULL,
          conversation_key INTEGER NOT NULL, parent_task_id TEXT NOT NULL,
          content_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`);
      await q(`
        CREATE TABLE ${PLAN_DOCUMENT_COVERAGE_TABLE} (
          document_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
          status TEXT NOT NULL, payload_json TEXT NOT NULL,
          PRIMARY KEY (document_id, library_id, item_key)
        )`);
      await q(`
        CREATE TABLE ${PLAN_DOCUMENT_OUTBOX_TABLE} (
          outbox_id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE,
          conversation_key INTEGER NOT NULL, status TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      await q(`
        CREATE TABLE ${PLAN_DOCUMENT_OWNERS_TABLE} (
          document_id TEXT NOT NULL, conversation_key INTEGER NOT NULL,
          source_message_timestamp INTEGER NOT NULL,
          PRIMARY KEY (document_id, conversation_key)
        )`);
      await q(`
        CREATE TABLE ${PLAN_DOCUMENT_ACTION_STATE_TABLE} (
          document_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      await q(
        `INSERT INTO ${PLAN_DOCUMENTS_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          document.documentId,
          document.planId,
          document.planRevision,
          document.executionId,
          document.conversationKey,
          document.parentTaskId,
          document.contentHash,
          JSON.stringify({ ...document, coverageItems: [] }),
          document.createdAt,
        ],
      );
      await q(
        `INSERT INTO ${PLAN_DOCUMENT_COVERAGE_TABLE} VALUES (?, ?, ?, ?, ?, ?)`,
        [
          document.documentId,
          0,
          coverageItem.libraryID,
          coverageItem.itemKey,
          coverageItem.status,
          JSON.stringify(coverageItem),
        ],
      );
      await q(
        `INSERT INTO ${PLAN_DOCUMENT_OUTBOX_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          outbox.outboxId,
          outbox.documentId,
          outbox.conversationKey,
          outbox.status,
          JSON.stringify(outbox),
          outbox.createdAt,
          outbox.updatedAt,
        ],
      );
      await q(`INSERT INTO ${PLAN_DOCUMENT_OWNERS_TABLE} VALUES (?, ?, ?)`, [
        document.documentId,
        document.conversationKey,
        200,
      ]);
      await q(
        `INSERT INTO ${PLAN_DOCUMENT_ACTION_STATE_TABLE} VALUES (?, ?, ?)`,
        [document.documentId, JSON.stringify(actionState), 210],
      );
    });
    const columns = (await q(
      `PRAGMA table_info(${PLAN_DOCUMENTS_TABLE})`,
    )) as Array<{ name: string }>;
    assert.notInclude(
      columns.map((column) => column.name),
      "origin_kind",
      "the seeded table is the v1 shape",
    );
  });

  it("verify phase: the plugin's startup migrated the v1 documents and kept every value", async function () {
    if (upgradePhase() !== "verify") this.skip();
    await waitForPlugin();
    const columns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${PLAN_DOCUMENTS_TABLE})`,
    )) as Array<{ name: string }>;
    assert.include(
      columns.map((column) => column.name),
      "origin_kind",
      "startup added origin_kind",
    );
    const rows = (await Zotero.DB.queryAsync(
      `SELECT document_id AS documentId, origin_kind AS originKind
       FROM ${PLAN_DOCUMENTS_TABLE}`,
    )) as Array<{ documentId: string; originKind: string }>;
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].documentId, document.documentId);
    assert.equal(rows[0].originKind, "planned");
    const leftover = (await Zotero.DB.queryAsync(
      `SELECT name FROM sqlite_master WHERE name = ?`,
      [`${PLAN_DOCUMENTS_TABLE}_v1_migration`],
    )) as unknown[];
    assert.lengthOf(leftover, 0, "the migration left no temporary table");

    const migrated = await loadPlanDocument(document.documentId);
    assert.equal(migrated?.documentId, document.documentId);
    assert.equal(migrated?.version, 1);
    assert.lengthOf(migrated?.coverageItems || [], 1);
    assert.deepInclude(migrated?.coverageItems[0] || {}, coverageItem);
    assert.equal(migrated?.contentHash, document.contentHash);
    assert.equal(migrated?.conversationKey, 41);
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
    // Clean up the rows so the data folder holds no fixture.
    await Zotero.DB.queryAsync(
      `DELETE FROM ${PLAN_DOCUMENTS_TABLE} WHERE document_id = ?`,
      [document.documentId],
    );
    for (const table of [
      PLAN_DOCUMENT_COVERAGE_TABLE,
      PLAN_DOCUMENT_OUTBOX_TABLE,
      PLAN_DOCUMENT_OWNERS_TABLE,
      PLAN_DOCUMENT_ACTION_STATE_TABLE,
    ])
      await Zotero.DB.queryAsync(`DELETE FROM ${table} WHERE document_id = ?`, [
        document.documentId,
      ]);
  });
});
