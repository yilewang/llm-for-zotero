import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { initConversationKeyLedgerStore } from "../src/shared/conversationKeyLedger";
import {
  buildConversationID,
  getRegisteredConversationScope,
  initConversationRegistryStore,
  registerConversationScope,
} from "../src/shared/conversationRegistry";
import {
  formatConversationStoreError,
  logConversationStoreWarning,
} from "../src/shared/conversationStore/diagnostics";
import {
  normalizeCatalogTimestamp,
  normalizeConversationKey,
  normalizeLibraryID,
  normalizeLimit,
  normalizeOptionalLimit,
  normalizePaperItemID,
} from "../src/shared/conversationStore/keyNormalization";
import {
  canonicalMessageConversationSelector,
  messageJoinCondition,
  resolveMessageConversationSelector,
  resolveRepairingMessageConversationSelector,
} from "../src/shared/conversationStore/messageConversationSelector";
import { getMessagePaperContextRows } from "../src/shared/conversationStore/messagePaperContextRows";
import {
  deleteStoreConversationSearchIndex,
  refreshStoreConversationSearchIndex,
} from "../src/shared/conversationStore/searchIndex";
import { loadStoredConversationMessages } from "../src/services/providers/conversationStoreMessageMapping";
import {
  backfillStoreCatalogConversationIDs,
  backfillStoreCatalogConversationInstanceIDs,
  backfillStoreCatalogConversationTimestamps,
  repairRecoverableStoreCatalogMessageConversationIDs,
} from "../src/services/providers/conversationStoreIdentityRepair";
import {
  filterValidStoreConversationSummaries,
  refreshStoreConversationCatalogSummary,
  sameStoreCatalogScope,
  validateOrRepairStoreConversationSummary,
  type ConversationStoreCatalogConfig,
} from "../src/services/providers/conversationStoreCatalogSummary";

/**
 * The shared conversation-store mechanics, driven directly rather than through
 * a provider.  The fixture deliberately uses table names no provider owns: a
 * mechanic that still works here is one that carries no provider knowledge.
 */

const CATALOG_TABLE = "llm_for_zotero_fixture_conversations";
const MESSAGES_TABLE = "llm_for_zotero_fixture_messages";
const REGISTRY_TABLE = "llm_for_zotero_conversation_registry";
const PROFILE_SIGNATURE = "fixture-profile";
const LIBRARY_ID = 1;

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  run: (sql: string, params?: unknown[]) => void;
  debugMessages: string[];
};

function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  // Zotero 7's queryAsync wraps rows in a proxy that THROWS when code reads a
  // column the SELECT did not include (node:sqlite returns undefined). Mimic
  // that here or the suite silently passes on exactly the row-access bugs
  // that break the real plugin.
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const stmt = db.prepare(sql);
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  const debugMessages: string[] = [];
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: LIBRARY_ID },
    Items: { get: () => null },
    Profile: { dir: "/tmp/llm-for-zotero-shared-mechanics" },
    debug: (message: string) => {
      debugMessages.push(message);
    },
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => await task(),
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    run: (sql, params) => {
      db.prepare(sql).run(...((params || []) as never[]));
    },
    debugMessages,
  };
}

function createFixtureTables(harness: SqliteHarness): void {
  harness.run(
    `CREATE TABLE ${CATALOG_TABLE} (
      conversation_key INTEGER PRIMARY KEY,
      conversation_id TEXT,
      conversation_instance_id TEXT,
      library_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      paper_item_id INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      last_activity_at INTEGER,
      first_user_title TEXT,
      user_turn_count INTEGER DEFAULT 0,
      title TEXT
    )`,
  );
  harness.run(
    `CREATE TABLE ${MESSAGES_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key INTEGER NOT NULL,
      conversation_id TEXT,
      role TEXT NOT NULL,
      text TEXT,
      timestamp INTEGER NOT NULL,
      run_mode TEXT,
      agent_run_id TEXT,
      document_id TEXT,
      selected_text TEXT,
      selected_text_contexts_json TEXT,
      selected_texts_json TEXT,
      selected_text_sources_json TEXT,
      selected_text_note_contexts_json TEXT,
      forced_skill_ids_json TEXT,
      quote_citations_json TEXT,
      collection_contexts_json TEXT,
      tag_contexts_json TEXT,
      attached_conversations_json TEXT,
      screenshot_images TEXT,
      attachments_json TEXT,
      generated_images_json TEXT,
      model_name TEXT,
      model_entry_id TEXT,
      model_provider_label TEXT,
      interrupted INTEGER,
      webchat_run_state TEXT,
      webchat_completion_reason TEXT,
      reasoning_summary TEXT,
      reasoning_details TEXT,
      compact_marker INTEGER,
      context_tokens INTEGER,
      context_window INTEGER,
      paper_contexts_json TEXT,
      pdf_paper_contexts_json TEXT,
      full_text_paper_contexts_json TEXT,
      selected_text_paper_contexts_json TEXT,
      citation_paper_contexts_json TEXT
    )`,
  );
}

/**
 * Every alias the shared mapper reads.  A caller that omits one gets a throw
 * from Zotero's row proxy rather than an undefined field, so the column list
 * is part of the mechanic's contract.
 */
const FIXTURE_MESSAGE_SELECT_COLUMNS_SQL = `id,
            role,
            text,
            timestamp,
            run_mode AS runMode,
            agent_run_id AS agentRunId,
            document_id AS documentId,
            selected_text AS selectedText,
            selected_text_contexts_json AS selectedTextContextsJson,
            selected_texts_json AS selectedTextsJson,
            selected_text_sources_json AS selectedTextSourcesJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            selected_text_note_contexts_json AS selectedTextNoteContextsJson,
            forced_skill_ids_json AS forcedSkillIdsJson,
            paper_contexts_json AS paperContextsJson,
            pdf_paper_contexts_json AS pdfPaperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson,
            quote_citations_json AS quoteCitationsJson,
            collection_contexts_json AS collectionContextsJson,
            tag_contexts_json AS tagContextsJson,
            attached_conversations_json AS attachedConversationsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            generated_images_json AS generatedImagesJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            interrupted,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            compact_marker AS compactMarker,
            context_tokens AS contextTokens,
            context_window AS contextWindow`;

function fixtureConversationID(
  conversationKey: number,
  kind: "global" | "paper",
  paperItemID?: number,
): string {
  return buildConversationID({
    conversationKey,
    system: "codex",
    kind,
    libraryID: LIBRARY_ID,
    paperItemID,
    profileSignature: PROFILE_SIGNATURE,
  });
}

function insertCatalogRow(
  harness: SqliteHarness,
  row: {
    conversationKey: number;
    conversationID?: string | null;
    instanceID?: string | null;
    kind?: "global" | "paper";
    paperItemID?: number | null;
    createdAt?: number | null;
    updatedAt?: number | null;
  },
): void {
  harness.run(
    `INSERT INTO ${CATALOG_TABLE}
       (conversation_key, conversation_id, conversation_instance_id, library_id,
        kind, paper_item_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.conversationKey,
      row.conversationID ?? null,
      row.instanceID ?? null,
      LIBRARY_ID,
      row.kind || "global",
      row.paperItemID ?? null,
      row.createdAt ?? null,
      row.updatedAt ?? null,
    ],
  );
}

function insertMessageRow(
  harness: SqliteHarness,
  row: {
    conversationKey: number;
    conversationID?: string | null;
    role?: "user" | "assistant";
    text?: string;
    timestamp: number;
    paperContextsJson?: string | null;
  },
): void {
  harness.run(
    `INSERT INTO ${MESSAGES_TABLE}
       (conversation_key, conversation_id, role, text, timestamp, paper_contexts_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.conversationKey,
      row.conversationID ?? null,
      row.role || "user",
      row.text ?? "message",
      row.timestamp,
      row.paperContextsJson ?? null,
    ],
  );
}

function catalogConfig(
  overrides: Partial<ConversationStoreCatalogConfig> = {},
): ConversationStoreCatalogConfig {
  return {
    system: "codex",
    storeLabel: "Fixture",
    catalogTable: CATALOG_TABLE,
    messagesTable: MESSAGES_TABLE,
    buildConversationID: (params) =>
      fixtureConversationID(
        params.conversationKey,
        params.kind,
        params.paperItemID ?? undefined,
      ),
    getPaperContextRows: (conversationKey) =>
      getMessagePaperContextRows(MESSAGES_TABLE, conversationKey),
    rememberPaperConversationKey: () => undefined,
    ...overrides,
  };
}

describe("shared conversation store mechanics", function () {
  let harness: SqliteHarness;

  beforeEach(async function () {
    harness = installSqliteZotero();
    createFixtureTables(harness);
    await initConversationKeyLedgerStore();
    await initConversationRegistryStore();
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
  });

  describe("diagnostics", function () {
    it("prefixes every store warning and survives a missing Zotero global", function () {
      logConversationStoreWarning("something drifted");
      assert.deepEqual(harness.debugMessages, [
        "[llm-for-zotero] [warn] LLM: something drifted",
      ]);

      const saved = globalScope.Zotero;
      globalScope.Zotero = undefined;
      assert.doesNotThrow(() => logConversationStoreWarning("no sink"));
      globalScope.Zotero = saved;
    });

    it("renders an Error by message and anything else by string", function () {
      assert.strictEqual(
        formatConversationStoreError(new Error("boom")),
        "boom",
      );
      assert.strictEqual(formatConversationStoreError(42), "42");
      assert.strictEqual(formatConversationStoreError(null), "null");
    });
  });

  describe("boundary normalization", function () {
    it("collapses every unusable identifier to null", function () {
      assert.strictEqual(normalizeConversationKey(12.9), 12);
      assert.isNull(normalizeConversationKey(0));
      assert.isNull(normalizeConversationKey(-1));
      assert.isNull(normalizeConversationKey(Number.NaN));
      assert.strictEqual(normalizeLibraryID(3), 3);
      assert.isNull(normalizeLibraryID(0));
      assert.strictEqual(normalizePaperItemID(7.2), 7);
      assert.isNull(normalizePaperItemID(Number.NaN));
    });

    it("keeps a history limit at one row or more, and falls back on junk", function () {
      assert.strictEqual(normalizeLimit(0, 200), 1);
      assert.strictEqual(normalizeLimit(5.9, 200), 5);
      assert.strictEqual(normalizeLimit(Number.NaN, 200), 200);
    });

    it("treats null and unusable optional limits alike as no limit", function () {
      assert.isNull(normalizeOptionalLimit(null));
      assert.isNull(normalizeOptionalLimit(undefined));
      assert.isNull(normalizeOptionalLimit(0));
      assert.strictEqual(normalizeOptionalLimit(4), 4);
    });

    it("stamps now onto a catalog row with no usable timestamp", function () {
      const before = Date.now();
      const stamped = normalizeCatalogTimestamp(null);
      assert.isAtLeast(stamped, before);
      assert.strictEqual(normalizeCatalogTimestamp(1700), 1700);
      assert.isAtLeast(normalizeCatalogTimestamp(-5), before);
    });
  });

  describe("message conversation selector", function () {
    it("matches nothing when no scope is registered for the key", async function () {
      const selector = await resolveMessageConversationSelector(9001);
      assert.strictEqual(selector.whereSql, "1 = 0");
      assert.deepEqual(selector.params, []);
    });

    it("matches the conversation id plus the legacy rows under the key", async function () {
      const conversationKey = 9002;
      const conversationID = fixtureConversationID(conversationKey, "global");
      await registerConversationScope({
        conversationID,
        conversationKey,
        system: "codex",
        kind: "global",
        libraryID: LIBRARY_ID,
        createdAt: 1,
        updatedAt: 1,
      });

      const selector =
        await resolveMessageConversationSelector(conversationKey);
      assert.include(selector.whereSql, "conversation_id = ?");
      assert.include(selector.whereSql, "conversation_key = ?");
      assert.deepEqual(selector.params, [conversationID, conversationKey]);
    });

    it("narrows to the conversation id alone in the canonical selector", async function () {
      const conversationKey = 9003;
      const conversationID = fixtureConversationID(conversationKey, "global");
      await registerConversationScope({
        conversationID,
        conversationKey,
        system: "codex",
        kind: "global",
        libraryID: LIBRARY_ID,
        createdAt: 1,
        updatedAt: 1,
      });
      const registered = await getRegisteredConversationScope(conversationKey);

      const selector = canonicalMessageConversationSelector(registered!);
      assert.strictEqual(selector.whereSql, "conversation_id = ?");
      assert.deepEqual(selector.params, [conversationID]);
    });

    it("expresses the same ownership rule as a join between two aliases", function () {
      const sql = messageJoinCondition("m", "c");
      assert.include(sql, "m.conversation_id = c.conversation_id");
      assert.include(sql, "m.conversation_key = c.conversation_key");
    });

    it("stamps the conversation id onto the legacy rows before selecting", async function () {
      const conversationKey = 9004;
      const conversationID = fixtureConversationID(conversationKey, "global");
      await registerConversationScope({
        conversationID,
        conversationKey,
        system: "codex",
        kind: "global",
        libraryID: LIBRARY_ID,
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, { conversationKey, timestamp: 1 });

      await resolveRepairingMessageConversationSelector(
        {
          messagesTable: MESSAGES_TABLE,
          storeLabel: "Fixture",
          getPaperContextRows: (key) =>
            getMessagePaperContextRows(MESSAGES_TABLE, key),
          log: logConversationStoreWarning,
        },
        conversationKey,
      );

      const [row] = harness.all(
        `SELECT conversation_id AS conversationID FROM ${MESSAGES_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(row.conversationID, conversationID);
    });
  });

  describe("paper context row access", function () {
    it("returns only the rows that carry at least one paper-context column", async function () {
      const conversationKey = 9005;
      insertMessageRow(harness, { conversationKey, timestamp: 1 });
      insertMessageRow(harness, {
        conversationKey,
        timestamp: 2,
        paperContextsJson: '[{"itemId":5}]',
      });

      const rows = await getMessagePaperContextRows(
        MESSAGES_TABLE,
        conversationKey,
      );

      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0].paperContextsJson, '[{"itemId":5}]');
    });
  });

  describe("search index maintenance", function () {
    it("logs and swallows a refresh failure instead of failing the write", async function () {
      const saved = globalScope.Zotero;
      globalScope.Zotero = {
        ...(saved || {}),
        debug: (message: string) => harness.debugMessages.push(message),
        DB: {
          queryAsync: async () => {
            throw new Error("index table is locked");
          },
          executeTransaction: async (task: () => Promise<unknown>) =>
            await task(),
        },
      };
      try {
        await refreshStoreConversationSearchIndex({
          system: "codex",
          storeLabel: "Fixture",
          conversationKey: 9006,
        });
      } finally {
        globalScope.Zotero = saved;
      }

      assert.isTrue(
        harness.debugMessages.some(
          (message) =>
            message.includes("Failed to refresh Fixture") &&
            message.includes("index table is locked"),
        ),
        `expected a refresh warning, saw ${JSON.stringify(harness.debugMessages)}`,
      );
    });

    it("deletes without raising when the index store has no such row", async function () {
      await deleteStoreConversationSearchIndex({
        system: "codex",
        conversationKey: 9007,
      });
    });
  });

  describe("row to message mapping", function () {
    it("decodes the context columns and drops the ones that will not parse", async function () {
      const conversationKey = 9008;
      const conversationID = fixtureConversationID(conversationKey, "global");
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        text: "first",
        timestamp: 10,
        paperContextsJson: JSON.stringify([
          { itemId: 5, contextItemId: 5, title: "Paper A", libraryID: 1 },
        ]),
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        text: "second",
        timestamp: 20,
        paperContextsJson: "{not json",
      });

      const messages = await loadStoredConversationMessages({
        messagesTable: MESSAGES_TABLE,
        selectColumnsSql: FIXTURE_MESSAGE_SELECT_COLUMNS_SQL,
        whereSql: "conversation_id = ?",
        params: [conversationID],
        limit: 10,
      });

      assert.deepEqual(
        messages.map((message) => message.text),
        ["first", "second"],
      );
      assert.strictEqual(messages[0].paperContexts?.[0]?.itemId, 5);
      assert.isUndefined(messages[1].paperContexts);
    });

    it("returns the newest rows in display order when the limit bites", async function () {
      const conversationKey = 9009;
      const conversationID = fixtureConversationID(conversationKey, "global");
      for (const timestamp of [10, 20, 30]) {
        insertMessageRow(harness, {
          conversationKey,
          conversationID,
          text: `t${timestamp}`,
          timestamp,
        });
      }

      const messages = await loadStoredConversationMessages({
        messagesTable: MESSAGES_TABLE,
        selectColumnsSql: FIXTURE_MESSAGE_SELECT_COLUMNS_SQL,
        whereSql: "conversation_id = ?",
        params: [conversationID],
        limit: 2,
      });

      assert.deepEqual(
        messages.map((message) => message.text),
        ["t20", "t30"],
      );
    });

    it("skips a row whose role is neither user nor assistant", async function () {
      const conversationKey = 9010;
      const conversationID = fixtureConversationID(conversationKey, "global");
      harness.run(
        `INSERT INTO ${MESSAGES_TABLE}
           (conversation_key, conversation_id, role, text, timestamp)
         VALUES (?, ?, 'system', 'ignored', 1)`,
        [conversationKey, conversationID],
      );

      const messages = await loadStoredConversationMessages({
        messagesTable: MESSAGES_TABLE,
        selectColumnsSql: FIXTURE_MESSAGE_SELECT_COLUMNS_SQL,
        whereSql: "conversation_id = ?",
        params: [conversationID],
        limit: 10,
      });

      assert.deepEqual(messages, []);
    });
  });

  describe("identity repair", function () {
    it("builds the missing conversation id for the catalog and its messages", async function () {
      const conversationKey = 9011;
      insertCatalogRow(harness, {
        conversationKey,
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, { conversationKey, timestamp: 1 });

      await backfillStoreCatalogConversationIDs(catalogConfig());

      const expected = fixtureConversationID(conversationKey, "global");
      const [catalog] = harness.all(
        `SELECT conversation_id AS conversationID FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      const [message] = harness.all(
        `SELECT conversation_id AS conversationID FROM ${MESSAGES_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(catalog.conversationID, expected);
      assert.strictEqual(message.conversationID, expected);
    });

    it("never rewrites a conversation id that is already set", async function () {
      const conversationKey = 9012;
      insertCatalogRow(harness, {
        conversationKey,
        conversationID: "already-set",
        createdAt: 1,
        updatedAt: 1,
      });

      await backfillStoreCatalogConversationIDs(catalogConfig());

      const [catalog] = harness.all(
        `SELECT conversation_id AS conversationID FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(catalog.conversationID, "already-set");
    });

    it("adopts the registry's instance id and mints one where there is none", async function () {
      const adopted = 9013;
      const minted = 9014;
      const adoptedID = fixtureConversationID(adopted, "global");
      await registerConversationScope({
        conversationID: adoptedID,
        conversationKey: adopted,
        system: "codex",
        kind: "global",
        libraryID: LIBRARY_ID,
        createdAt: 1,
        updatedAt: 1,
      });
      const [registered] = harness.all(
        `SELECT instance_id AS instanceID FROM ${REGISTRY_TABLE} WHERE conversation_id = ?`,
        [adoptedID],
      );
      insertCatalogRow(harness, {
        conversationKey: adopted,
        conversationID: adoptedID,
        createdAt: 1,
        updatedAt: 1,
      });
      insertCatalogRow(harness, {
        conversationKey: minted,
        conversationID: fixtureConversationID(minted, "global"),
        createdAt: 1,
        updatedAt: 1,
      });

      await backfillStoreCatalogConversationInstanceIDs(CATALOG_TABLE);

      const rows = harness.all(
        `SELECT conversation_key AS conversationKey,
                conversation_instance_id AS instanceID
         FROM ${CATALOG_TABLE}
         ORDER BY conversation_key`,
      );
      assert.strictEqual(rows[0].instanceID, registered.instanceID);
      assert.isString(rows[1].instanceID);
      assert.notStrictEqual(rows[1].instanceID, registered.instanceID);
    });

    it("recovers missing catalog timestamps from the conversation's messages", async function () {
      const conversationKey = 9015;
      insertCatalogRow(harness, { conversationKey });
      insertMessageRow(harness, { conversationKey, timestamp: 500 });
      insertMessageRow(harness, { conversationKey, timestamp: 900 });

      await backfillStoreCatalogConversationTimestamps({
        catalogTable: CATALOG_TABLE,
        messagesTable: MESSAGES_TABLE,
      });

      const [row] = harness.all(
        `SELECT created_at AS createdAt, updated_at AS updatedAt
         FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(Number(row.createdAt), 500);
      assert.strictEqual(Number(row.updatedAt), 900);
    });

    it("reports nothing checked for a conversation key that cannot be one", async function () {
      const result = await repairRecoverableStoreCatalogMessageConversationIDs(
        catalogConfig(),
        0,
      );
      assert.deepEqual(result, { checked: 0, repaired: 0, refused: 0 });
    });

    it("stamps the catalog's conversation id onto its unclaimed message rows", async function () {
      const conversationKey = 9016;
      const conversationID = fixtureConversationID(conversationKey, "global");
      insertCatalogRow(harness, {
        conversationKey,
        conversationID,
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, { conversationKey, timestamp: 1 });

      const result = await repairRecoverableStoreCatalogMessageConversationIDs(
        catalogConfig(),
        conversationKey,
      );

      assert.strictEqual(result.refused, 0);
      const [message] = harness.all(
        `SELECT conversation_id AS conversationID FROM ${MESSAGES_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(message.conversationID, conversationID);
    });
  });

  describe("catalog summary", function () {
    it("recomputes the first user title, activity and turn count from the messages", async function () {
      const conversationKey = 9017;
      const conversationID = fixtureConversationID(conversationKey, "global");
      insertCatalogRow(harness, {
        conversationKey,
        conversationID,
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        role: "user",
        text: "first question",
        timestamp: 10,
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        role: "assistant",
        text: "answer",
        timestamp: 20,
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        role: "user",
        text: "second question",
        timestamp: 30,
      });

      await refreshStoreConversationCatalogSummary(
        catalogConfig(),
        conversationKey,
      );

      const [row] = harness.all(
        `SELECT first_user_title AS firstUserTitle,
                last_activity_at AS lastActivityAt,
                user_turn_count AS userTurnCount
         FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(row.firstUserTitle, "first question");
      assert.strictEqual(Number(row.lastActivityAt), 30);
      assert.strictEqual(Number(row.userTurnCount), 2);
    });

    it("refreshes every catalog row when no key is given", async function () {
      for (const conversationKey of [9018, 9019]) {
        const conversationID = fixtureConversationID(conversationKey, "global");
        insertCatalogRow(harness, {
          conversationKey,
          conversationID,
          createdAt: 1,
          updatedAt: 1,
        });
        insertMessageRow(harness, {
          conversationKey,
          conversationID,
          role: "user",
          text: `q${conversationKey}`,
          timestamp: conversationKey,
        });
      }

      await refreshStoreConversationCatalogSummary(catalogConfig());

      const rows = harness.all(
        `SELECT user_turn_count AS userTurnCount FROM ${CATALOG_TABLE} ORDER BY conversation_key`,
      );
      assert.deepEqual(
        rows.map((row) => Number(row.userTurnCount)),
        [1, 1],
      );
    });

    it("refuses an unusable conversation key without touching the catalog", async function () {
      const conversationKey = 9020;
      const conversationID = fixtureConversationID(conversationKey, "global");
      insertCatalogRow(harness, {
        conversationKey,
        conversationID,
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        role: "user",
        timestamp: 5,
      });

      await refreshStoreConversationCatalogSummary(catalogConfig(), 0);

      const [row] = harness.all(
        `SELECT user_turn_count AS userTurnCount FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(Number(row.userTurnCount), 0);
    });

    it("compares a catalog scope by library, kind and paper", function () {
      const existing = {
        conversationID: "id",
        conversationKey: 9021,
        libraryID: 1,
        kind: "paper" as const,
        paperItemID: 7,
        createdAt: 1,
        updatedAt: 1,
      };
      assert.isTrue(
        sameStoreCatalogScope(existing, {
          libraryID: 1,
          kind: "paper",
          paperItemID: 7,
        }),
      );
      assert.isFalse(
        sameStoreCatalogScope(existing, {
          libraryID: 1,
          kind: "paper",
          paperItemID: 8,
        }),
      );
      assert.isFalse(
        sameStoreCatalogScope(existing, { libraryID: 2, kind: "paper" }),
      );
      // A global request ignores the paper id entirely.
      assert.isFalse(
        sameStoreCatalogScope(existing, {
          libraryID: 1,
          kind: "global",
          paperItemID: 7,
        }),
      );
    });

    it("registers a global summary that has no registry entry yet", async function () {
      const conversationKey = 9022;
      const summary = {
        conversationID: fixtureConversationID(conversationKey, "global"),
        conversationKey,
        libraryID: LIBRARY_ID,
        kind: "global" as const,
        createdAt: 1,
        updatedAt: 1,
        title: "restored",
      };

      const validated = await validateOrRepairStoreConversationSummary(
        catalogConfig(),
        summary,
      );

      assert.strictEqual(validated?.conversationKey, conversationKey);
      const registered = await getRegisteredConversationScope(conversationKey);
      assert.strictEqual(registered?.conversationID, summary.conversationID);
    });

    it("infers the paper of an unscoped paper summary from its own messages", async function () {
      const conversationKey = 9023;
      const conversationID = fixtureConversationID(conversationKey, "paper");
      insertCatalogRow(harness, {
        conversationKey,
        conversationID,
        kind: "paper",
        createdAt: 1,
        updatedAt: 1,
      });
      insertMessageRow(harness, {
        conversationKey,
        conversationID,
        timestamp: 1,
        paperContextsJson: JSON.stringify([
          { itemId: 77, contextItemId: 77, title: "Paper Z", libraryID: 1 },
        ]),
      });
      const remembered: number[][] = [];

      const validated = await validateOrRepairStoreConversationSummary(
        catalogConfig({
          rememberPaperConversationKey: (libraryID, paperItemID, key) => {
            remembered.push([libraryID, paperItemID, key]);
          },
        }),
        {
          conversationID,
          conversationKey,
          libraryID: LIBRARY_ID,
          kind: "paper" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      );

      assert.strictEqual(validated?.paperItemID, 77);
      assert.deepEqual(remembered, [[LIBRARY_ID, 77, conversationKey]]);
      const [catalog] = harness.all(
        `SELECT paper_item_id AS paperItemID FROM ${CATALOG_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(Number(catalog.paperItemID), 77);
    });

    it("drops a paper summary whose paper cannot be established", async function () {
      const conversationKey = 9024;
      const conversationID = fixtureConversationID(conversationKey, "paper");
      insertCatalogRow(harness, {
        conversationKey,
        conversationID,
        kind: "paper",
        createdAt: 1,
        updatedAt: 1,
      });

      const validated = await validateOrRepairStoreConversationSummary(
        catalogConfig(),
        {
          conversationID,
          conversationKey,
          libraryID: LIBRARY_ID,
          kind: "paper" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      );

      assert.isNull(validated);
    });

    it("keeps only the summaries that belong to the paper being listed", async function () {
      const wanted = 9025;
      const other = 9026;
      const summaries = [wanted, other].map((conversationKey, index) => ({
        conversationID: fixtureConversationID(
          conversationKey,
          "paper",
          index === 0 ? 77 : 88,
        ),
        conversationKey,
        libraryID: LIBRARY_ID,
        kind: "paper" as const,
        paperItemID: index === 0 ? 77 : 88,
        createdAt: 1,
        updatedAt: 1,
      }));

      const filtered = await filterValidStoreConversationSummaries(
        catalogConfig(),
        summaries,
        77,
      );

      assert.deepEqual(
        filtered.map((summary) => summary.conversationKey),
        [wanted],
      );
    });
  });
});
