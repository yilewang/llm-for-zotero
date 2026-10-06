import { assert } from "chai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import type { StoredChatMessage } from "../src/utils/chatStore";
import {
  getClaudeAllocatedConversationKeyRange,
  getClaudeGlobalConversationKeyRange,
} from "../src/claudeCode/constants";
import {
  getCodexAllocatedConversationKeyRange,
  getCodexGlobalConversationKeyRange,
} from "../src/codexAppServer/constants";
import {
  UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
} from "../src/shared/conversationKeySpace";
import {
  CONVERSATION_SCHEMA_MIGRATIONS_TABLE,
  markConversationIDTransitionMigrationApplied,
} from "../src/shared/conversationSchemaMigrations";
import { startupSchemaFingerprintID } from "../src/shared/startupSchemaFingerprint";
import {
  ConversationRetiredError,
  isConversationKeyRetiredInMemory,
} from "../src/shared/conversationKeyLedger";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  getConversationWriteGeneration,
} from "../src/shared/conversationWriteFence";
import { pendingDeletionStore } from "../src/core/conversations/pendingDeletionStore";
import { conversationInstanceIdentityDigest } from "../src/core/conversations/recentlyDeletedConversations";
import { config } from "../package.json";
import {
  createDeterministicMasker,
  dumpDatabase,
  type DatabaseDump,
  FIXED_STORE_CLOCK_MS,
  installFixedClock,
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  snapshotSchema,
  sortedPrefs,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * Characterization of the three conversation stores
 * (src/utils/chatStore.ts = "upstream", src/claudeCode/store.ts =
 * "claude_code", src/codexAppServer/store.ts = "codex") against real SQLite.
 *
 * Every scenario runs once per store and records a golden: the scenario's
 * return values and errors plus a whole-database snapshot (every table, rows
 * in primary-key order, clock values and random instance IDs masked). The
 * goldens in test/fixtures/conversationStores/ were recorded on the code
 * before the store consolidation; a refactor must reproduce them exactly.
 *
 * The stores differ on purpose in places. Where a scenario pins a difference
 * from the step-7 report, a comment at the assertion names it (D1-D8 Claude
 * vs Codex; U1, U5-U14 upstream vs runtime). Differences not named here are
 * covered only by the whole-database goldens, if at all.
 *
 * To re-record after an intentional behaviour change, run this file with
 * UPDATE_CONVERSATION_STORE_GOLDENS=1 and review the fixture diff. That
 * merges the recorded scenarios into the existing goldens, so it is safe with
 * --grep. A removed or renamed scenario keeps its old golden; to drop those,
 * run the WHOLE file (no --grep, no .only) with
 * UPDATE_CONVERSATION_STORE_GOLDENS=prune, which writes exactly the scenarios
 * that ran. A prune run with --grep, -g, --fgrep or -f throws before it writes;
 * a `.only` in the source is not detected, so check for one first.
 */

type StoreName = "upstream" | "claude_code" | "codex";
type Kind = "global" | "paper";
type Identity = { instanceID: string; conversationID: string };
type DeleteIdentity = {
  instanceID?: string;
  conversationID?: string;
  onBeforeCommit?: () => Promise<void>;
  onCommit?: () => Promise<void>;
};

const STORE_NAMES: StoreName[] = ["upstream", "claude_code", "codex"];
const NOW = FIXED_STORE_CLOCK_MS;
const LIBRARY_ID = 1;
const PAPER_ITEM_ID = 77;
const PREF_PREFIX = config.prefsPrefix;

/** Message timestamps sit after the fixed clock so activity merges show. */
function at(offsetSeconds: number): number {
  return NOW + offsetSeconds * 1000;
}

type StoreAdapter = {
  name: StoreName;
  messagesTable: string;
  catalogTable(kind: Kind): string;
  init(): Promise<void>;
  create(
    kind: Kind,
    options?: { conversationKey?: number; paperItemID?: number },
  ): Promise<number>;
  append(
    key: number,
    message: StoredChatMessage,
    instanceID?: string,
  ): Promise<void>;
  load(key: number, limit: number): Promise<StoredChatMessage[]>;
  updateLatestUser(key: number, message: StoredChatMessage): Promise<void>;
  updateLatestAssistant(key: number, message: StoredChatMessage): Promise<void>;
  clear(
    key: number,
    identity?: Identity,
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void>;
  deleteTurn(
    key: number,
    userTimestamp: number,
    assistantTimestamp: number,
    userMessageID?: number,
    assistantMessageID?: number,
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void>;
  prune(key: number, keep: number): Promise<void>;
  touchTitle(
    key: number,
    kind: Kind,
    seed: string,
    expectedGeneration?: number,
  ): Promise<void>;
  setTitle(key: number, kind: Kind, seed: string): Promise<void>;
  getSummary(key: number, kind: Kind): Promise<unknown>;
  listGlobal(limit: number | null): Promise<Array<{ conversationKey: number }>>;
  listPaper(
    paperItemID: number,
    limit: number,
  ): Promise<Array<{ conversationKey: number }>>;
  listAllPaper(
    limit: number | null,
  ): Promise<Array<{ conversationKey: number }>>;
  deleteLocalRows(
    key: number,
    kind: Kind,
    identity?: DeleteIdentity,
  ): Promise<void>;
  preflight(key: number): Promise<void>;
};

function runtimeAdapter(name: "claude_code" | "codex"): StoreAdapter {
  const isClaude = name === "claude_code";
  const prefix = isClaude ? "claude" : "codex";
  const store = {
    init: isClaude ? claude.initClaudeCodeStore : codex.initCodexAppServerStore,
    createGlobal: isClaude
      ? claude.createClaudeGlobalConversation
      : codex.createCodexGlobalConversation,
    createPaper: isClaude
      ? claude.createClaudePaperConversation
      : codex.createCodexPaperConversation,
    append: isClaude ? claude.appendClaudeMessage : codex.appendCodexMessage,
    load: isClaude
      ? claude.loadClaudeConversation
      : codex.loadCodexConversation,
    updateLatestUser: isClaude
      ? claude.updateLatestClaudeUserMessage
      : codex.updateLatestCodexUserMessage,
    updateLatestAssistant: isClaude
      ? claude.updateLatestClaudeAssistantMessage
      : codex.updateLatestCodexAssistantMessage,
    clear: isClaude
      ? claude.clearClaudeConversation
      : codex.clearCodexConversation,
    deleteTurn: isClaude
      ? claude.deleteClaudeTurnMessages
      : codex.deleteCodexTurnMessages,
    prune: isClaude
      ? claude.pruneClaudeConversation
      : codex.pruneCodexConversation,
    touchTitle: isClaude
      ? claude.touchClaudeConversationTitle
      : codex.touchCodexConversationTitle,
    setTitle: isClaude
      ? claude.setClaudeConversationTitle
      : codex.setCodexConversationTitle,
    getSummary: isClaude
      ? claude.getClaudeConversationSummary
      : codex.getCodexConversationSummary,
    listGlobal: isClaude
      ? claude.listClaudeGlobalConversations
      : codex.listCodexGlobalConversations,
    listPaper: isClaude
      ? claude.listClaudePaperConversations
      : codex.listCodexPaperConversations,
    listAllPaper: isClaude
      ? claude.listAllClaudePaperConversationsByLibrary
      : codex.listAllCodexPaperConversationsByLibrary,
    deleteLocalRows: isClaude
      ? claude.deleteClaudeConversationLocalRows
      : codex.deleteCodexConversationLocalRows,
    preflight: isClaude
      ? claude.preflightDeleteClaudeConversationLocalRows
      : codex.preflightDeleteCodexConversationLocalRows,
  };
  return {
    name,
    messagesTable: `llm_for_zotero_${prefix}_messages`,
    catalogTable: () => `llm_for_zotero_${prefix}_conversations`,
    init: () => store.init(),
    create: async (kind, options = {}) => {
      const summary =
        kind === "global"
          ? await store.createGlobal(LIBRARY_ID, {
              conversationKey: options.conversationKey,
            })
          : await store.createPaper(
              LIBRARY_ID,
              options.paperItemID ?? PAPER_ITEM_ID,
              { conversationKey: options.conversationKey },
            );
      assert.ok(summary, `${name} create ${kind} returned no summary`);
      return summary!.conversationKey;
    },
    append: (key, message, instanceID) =>
      store.append(key, message, instanceID),
    load: (key, limit) => store.load(key, limit),
    updateLatestUser: (key, message) => store.updateLatestUser(key, message),
    updateLatestAssistant: (key, message) =>
      store.updateLatestAssistant(key, message),
    clear: (key, identity, onBeforeCommit) =>
      store.clear(key, identity, onBeforeCommit),
    deleteTurn: (key, u, a, uid, aid, onBeforeCommit) =>
      store.deleteTurn(key, u, a, uid, aid, onBeforeCommit),
    prune: (key, keep) => store.prune(key, keep),
    touchTitle: (key, _kind, seed, generation) =>
      store.touchTitle(key, seed, generation),
    setTitle: (key, _kind, seed) => store.setTitle(key, seed),
    getSummary: (key) => store.getSummary(key),
    listGlobal: (limit) => store.listGlobal(LIBRARY_ID, limit),
    listPaper: (paperItemID, limit) =>
      store.listPaper(LIBRARY_ID, paperItemID, limit),
    listAllPaper: (limit) => store.listAllPaper(LIBRARY_ID, limit),
    deleteLocalRows: (key, _kind, identity) =>
      store.deleteLocalRows(key, identity),
    preflight: (key) => store.preflight(key),
  };
}

const upstreamAdapter: StoreAdapter = {
  name: "upstream",
  messagesTable: "llm_for_zotero_chat_messages",
  // U1: two catalog tables, chosen by key range.
  catalogTable: (kind) =>
    kind === "global"
      ? "llm_for_zotero_global_conversations"
      : "llm_for_zotero_paper_conversations",
  init: () => upstream.initChatStore(),
  create: async (kind, options = {}) => {
    if (kind === "global") {
      const key = await upstream.createGlobalConversation(LIBRARY_ID, {
        conversationKey: options.conversationKey,
      });
      assert.isAbove(key, 0, "upstream create global returned no key");
      return key;
    }
    const summary = await upstream.createPaperConversation(
      LIBRARY_ID,
      options.paperItemID ?? PAPER_ITEM_ID,
      { conversationKey: options.conversationKey },
    );
    assert.ok(summary, "upstream create paper returned no summary");
    return summary!.conversationKey;
  },
  append: (key, message, instanceID) =>
    upstream.appendMessage(key, message, instanceID),
  load: (key, limit) => upstream.loadConversation(key, limit),
  updateLatestUser: (key, message) =>
    upstream.updateLatestUserMessage(key, message),
  updateLatestAssistant: (key, message) =>
    upstream.updateLatestAssistantMessage(key, message),
  clear: (key, identity, onBeforeCommit) =>
    upstream.clearConversation(key, identity, onBeforeCommit),
  deleteTurn: (key, u, a, uid, aid, onBeforeCommit) =>
    upstream.deleteTurnMessages(key, u, a, uid, aid, onBeforeCommit),
  prune: (key, keep) => upstream.pruneConversation(key, keep),
  touchTitle: (key, kind, seed, generation) =>
    kind === "global"
      ? upstream.touchGlobalConversationTitle(key, seed, generation)
      : upstream.touchPaperConversationTitle(key, seed, generation),
  setTitle: (key, kind, seed) =>
    kind === "global"
      ? upstream.setGlobalConversationTitle(key, seed)
      : upstream.setPaperConversationTitle(key, seed),
  getSummary: (key, kind) =>
    kind === "global"
      ? upstream.getGlobalConversation(key)
      : upstream.getPaperConversation(key),
  listGlobal: (limit) => upstream.listGlobalConversations(LIBRARY_ID, limit),
  listPaper: (paperItemID, limit) =>
    upstream.listPaperConversations(LIBRARY_ID, paperItemID, limit),
  listAllPaper: (limit) =>
    upstream.listAllPaperConversationsByLibrary(LIBRARY_ID, limit),
  deleteLocalRows: (key, kind, identity) =>
    upstream.deleteUpstreamConversationLocalRows(key, kind, identity),
  preflight: (key) =>
    upstream.preflightDeleteUpstreamConversationLocalRows(key),
};

const ADAPTERS: Record<StoreName, StoreAdapter> = {
  upstream: upstreamAdapter,
  claude_code: runtimeAdapter("claude_code"),
  codex: runtimeAdapter("codex"),
};

// ---------------------------------------------------------------------------
// Golden fixtures
// ---------------------------------------------------------------------------

const UPDATE_MODE = process.env.UPDATE_CONVERSATION_STORE_GOLDENS;
const UPDATE_GOLDENS = UPDATE_MODE === "1" || UPDATE_MODE === "prune";
/** "prune": write only what ran, so it needs a whole-file run. */
const PRUNE_GOLDENS = UPDATE_MODE === "prune";
if (
  PRUNE_GOLDENS &&
  process.argv.some((arg) => /^(--grep|-g|--fgrep|-f)(=|$)/.test(arg))
) {
  throw new Error(
    "UPDATE_CONVERSATION_STORE_GOLDENS=prune needs a whole-file run; use =1 with --grep",
  );
}
const FIXTURE_DIR = path.join(__dirname, "fixtures", "conversationStores");

function fixturePath(store: StoreName): string {
  return path.join(FIXTURE_DIR, `${store}.json`);
}

const goldens: Record<StoreName, Record<string, unknown>> = {
  upstream: {},
  claude_code: {},
  codex: {},
};
const recorded: Record<StoreName, Record<string, unknown>> = {
  upstream: {},
  claude_code: {},
  codex: {},
};
for (const store of STORE_NAMES) {
  if (existsSync(fixturePath(store))) {
    goldens[store] = JSON.parse(readFileSync(fixturePath(store), "utf8"));
  }
}

// ---------------------------------------------------------------------------
// Fixtures shared by the scenarios
// ---------------------------------------------------------------------------

function paperContext(itemId: number, title: string) {
  return { libraryID: 1, itemId, contextItemId: itemId, title };
}

function richUserMessage(
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "user",
    text: "how does this paper define salience?",
    timestamp: at(1),
    runMode: "agent",
    agentRunId: "run-7",
    documentId: "doc-3",
    selectedText: "salience map",
    selectedTexts: ["salience map", "attention gate"],
    selectedTextPaperContexts: [
      paperContext(41, "Paper A"),
      paperContext(42, "Paper B"),
    ],
    forcedSkillIds: ["write-note"],
    paperContexts: [paperContext(41, "Paper A")],
    pdfPaperContexts: [paperContext(42, "Paper B")],
    fullTextPaperContexts: [paperContext(43, "Paper C")],
    citationPaperContexts: [paperContext(44, "Paper D")],
    selectedCollectionContexts: [
      { collectionId: 9, name: "Reviews", libraryID: 1 },
    ],
    selectedTagContexts: [
      { name: "salience", normalizedName: "salience", libraryID: 1 },
    ],
    screenshotImages: ["data:image/png;base64,AAA", " "],
    attachments: [
      {
        id: "att-1",
        name: "figure.png",
        mimeType: "image/png",
        sizeBytes: 12,
        category: "image",
      },
      { id: "att-2", name: " ", category: "file" },
    ],
    modelAttachments: [
      {
        id: "att-1",
        name: "figure.png",
        mimeType: "image/png",
        sizeBytes: 12,
        category: "image",
      },
    ],
    modelName: "gpt-5",
    modelEntryId: "entry-1",
    modelProviderLabel: "OpenAI",
    contextTokens: 1200,
    contextWindow: 128000,
    ...overrides,
  } as unknown as StoredChatMessage;
}

function richAssistantMessage(
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "assistant",
    text: "salience is a weighted priority",
    timestamp: at(2),
    runMode: "agent",
    agentRunId: "run-7",
    documentId: "doc-3",
    quoteCitations: [
      {
        quoteText: "salience is defined as the weighted priority of a stimulus",
        citationLabel: "Smith 2020",
        itemId: 41,
        contextItemId: 41,
        allowShortQuoteText: true,
      },
    ],
    generatedImages: [
      {
        id: "img-1",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,BBB",
      },
    ],
    modelName: "gpt-5",
    modelEntryId: "entry-1",
    modelProviderLabel: "OpenAI",
    interrupted: true,
    completionStatus: "complete",
    completionReason: "stop",
    webchatRunState: "done",
    webchatCompletionReason: "finished",
    reasoningSummary: "thought briefly",
    reasoningDetails: "details",
    compactMarker: true,
    contextTokens: 3000,
    contextWindow: 128000,
    ...overrides,
  } as unknown as StoredChatMessage;
}

function plain(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return { role, text, timestamp, ...overrides } as StoredChatMessage;
}

/** Agent-owned and satellite tables a conversation deletion must purge. */
function createParticipantTables(harness: SqliteHarness): void {
  harness.run(
    `CREATE TABLE llm_for_zotero_agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key INTEGER NOT NULL,
      question_excerpt TEXT NOT NULL,
      tools_used_json TEXT NOT NULL,
      answer_excerpt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  harness.run(
    `CREATE TABLE llm_for_zotero_agent_coverage (
      scope_key TEXT NOT NULL,
      coverage_key TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      durable INTEGER NOT NULL,
      origin_conversation_key INTEGER,
      entry_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope_key, coverage_key)
    )`,
  );
  harness.run(
    `CREATE TABLE llm_for_zotero_attachment_refs (
      owner_type TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      blob_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(owner_type, owner_id, blob_hash)
    )`,
  );
  harness.run(
    `CREATE TABLE llm_for_zotero_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key INTEGER,
      tokens INTEGER
    )`,
  );
}

function seedParticipantRows(harness: SqliteHarness, key: number): void {
  harness.run(
    `INSERT INTO llm_for_zotero_agent_memory
       (conversation_key, question_excerpt, tools_used_json, answer_excerpt, created_at)
     VALUES (?, 'q', '[]', 'a', 1)`,
    [key],
  );
  harness.run(
    `INSERT INTO llm_for_zotero_agent_coverage
       (scope_key, coverage_key, resource_key, durable, origin_conversation_key, entry_json, updated_at)
     VALUES (?, 'cov', 'res', 1, ?, '{}', 1)`,
    [`conversation:${key}`, key],
  );
  harness.run(
    `INSERT INTO llm_for_zotero_attachment_refs
       (owner_type, owner_id, blob_hash, updated_at)
     VALUES ('conversation', ?, ?, 1)`,
    [key, `blob-${key}`],
  );
  harness.run(
    `INSERT INTO llm_for_zotero_usage_events (conversation_key, tokens)
     VALUES (?, 10)`,
    [key],
  );
}

/**
 * Drop NULL columns from dumped rows to keep the goldens small. Lossless:
 * the column set of every table is pinned by the init.coldStart golden, so
 * an absent column in a row means NULL.
 */
function withoutNullColumns(dump: DatabaseDump): DatabaseDump {
  return Object.fromEntries(
    Object.entries(dump).map(([table, rows]) => [
      table,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== null),
        ),
      ),
    ]),
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof ConversationRetiredError) {
    return {
      error: "ConversationRetiredError",
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "non-error", message: String(error) };
}

async function outcome<T>(task: () => Promise<T>): Promise<unknown> {
  try {
    const value = await task();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return describeError(error);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("conversation store characterization (golden)", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  const originalIsPending = pendingDeletionStore.isConversationPendingDeletion;
  let harness: SqliteHarness;
  let restoreClock: () => void;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
    restoreClock = installFixedClock();
  });

  afterEach(function () {
    pendingDeletionStore.isConversationPendingDeletion = originalIsPending;
    restoreClock();
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  after(async function () {
    if (!UPDATE_GOLDENS) return;
    // Write the fixtures in the repository's Prettier style, so
    // `prettier --check .` stays clean after a re-record.
    const prettier = await import("prettier");
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const store of STORE_NAMES) {
      const merged = PRUNE_GOLDENS
        ? recorded[store]
        : { ...goldens[store], ...recorded[store] };
      const ordered = Object.fromEntries(
        Object.keys(merged)
          .sort()
          .map((key) => [key, merged[key]]),
      );
      const file = fixturePath(store);
      const options = (await prettier.resolveConfig(file)) || {};
      writeFileSync(
        file,
        await prettier.format(JSON.stringify(ordered), {
          ...options,
          filepath: file,
        }),
      );
    }
  });

  function readRow(
    table: string,
    key: number,
  ): Record<string, unknown> | undefined {
    return harness.all(`SELECT * FROM ${table} WHERE conversation_key = ?`, [
      key,
    ])[0];
  }

  function identityOf(store: StoreAdapter, kind: Kind, key: number): Identity {
    const row = readRow(store.catalogTable(kind), key);
    assert.ok(row, `${store.name} has no ${kind} catalog row for ${key}`);
    return {
      instanceID: String(row!.conversation_instance_id),
      conversationID: String(row!.conversation_id),
    };
  }

  function messageRows(
    store: StoreAdapter,
    key: number,
  ): Array<Record<string, unknown>> {
    return harness.all(
      `SELECT id, role, text, timestamp FROM ${store.messagesTable}
       WHERE conversation_key = ? ORDER BY id`,
      [key],
    );
  }

  /**
   * Compare (or, in update mode, record) one scenario's golden: the result
   * plus the whole database and the pref store, masked as one structure so
   * an instance ID keeps one token across result and tables.
   */
  function golden(store: StoreName, scenario: string, result: unknown): void {
    const masked = createDeterministicMasker()({
      result,
      db: withoutNullColumns(dumpDatabase(harness.db)),
      prefs: sortedPrefs(harness.prefs),
    });
    const actual = JSON.parse(JSON.stringify(masked));
    if (UPDATE_GOLDENS) {
      recorded[store][scenario] = actual;
      return;
    }
    assert.property(
      goldens[store],
      scenario,
      `missing golden ${store}/${scenario}; record with UPDATE_CONVERSATION_STORE_GOLDENS=1`,
    );
    assert.deepEqual(
      actual,
      goldens[store][scenario],
      `golden ${store}/${scenario} changed`,
    );
  }

  /**
   * The statements a write ran inside its transaction, in order, with the
   * SQL whitespace collapsed. Pins the statement sequence of a write (the
   * deletion kernel must stay statement-for-statement identical, U13/U14)
   * without depending on template-literal indentation.
   */
  function transactionTrace(from: number): Array<{
    sql: string;
    params: unknown[];
  }> {
    // BEGIN, COMMIT and ROLLBACK appear as marker statements, so the trace
    // shows where each transaction starts and ends.
    return harness.statements
      .slice(from)
      .filter((statement) => statement.inTransaction)
      .map((statement) => ({
        sql: statement.sql.replace(/\s+/g, " ").trim(),
        params: statement.params,
      }));
  }

  for (const storeName of STORE_NAMES) {
    describe(storeName, function () {
      const store = ADAPTERS[storeName];
      const isUpstream = storeName === "upstream";
      const isCodex = storeName === "codex";

      /** A statement a hook issues, so the trace shows where the hook ran. */
      async function hookMarker(name: string): Promise<void> {
        await (
          globalScope.Zotero as unknown as {
            DB: { queryAsync: (sql: string) => Promise<unknown> };
          }
        ).DB.queryAsync(`SELECT '${name}' AS hook`);
      }

      async function initAndCreate(kind: Kind = "global"): Promise<number> {
        await store.init();
        return await store.create(kind);
      }

      // -------------------------------------------------------------------
      // init
      // -------------------------------------------------------------------

      it("init: cold start schema, migration markers and fingerprint", async function () {
        await store.init();
        const schema = snapshotSchema(harness.db);
        const fingerprintID = startupSchemaFingerprintID(
          isUpstream ? "upstream" : isCodex ? "codex" : "claude-code",
        );
        const migrationIDs = isUpstream
          ? upstream.CHAT_STORE_STARTUP_MIGRATION_IDS
          : isCodex
            ? codex.CODEX_STORE_STARTUP_MIGRATION_IDS
            : claude.CLAUDE_STORE_STARTUP_MIGRATION_IDS;
        const markers = harness
          .all(`SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}`)
          .map((row) => String(row.id))
          .sort();
        assert.include(markers, fingerprintID);
        // The ID-transition marker is declared but written later, by the
        // deferred startup maintenance; init writes the other two.
        for (const id of migrationIDs.slice(1)) assert.include(markers, id);
        assert.notInclude(markers, migrationIDs[0]);

        // Idempotent: a second init leaves the schema byte-identical.
        await store.init();
        assert.deepEqual(snapshotSchema(harness.db), schema);

        golden(storeName, "init.coldStart", {
          fingerprintID,
          migrationIDs: [...migrationIDs],
          markers,
          schema,
          tableInfo: Object.fromEntries(
            schema
              .filter((entry) => entry.type === "table")
              .map((entry) => [
                entry.name,
                harness.all(`PRAGMA table_info(${entry.name})`),
              ]),
          ),
          indexList: Object.fromEntries(
            schema
              .filter((entry) => entry.type === "table")
              .map((entry) => [
                entry.name,
                harness.all(`PRAGMA index_list(${entry.name})`),
              ]),
          ),
        });
      });

      it("init: a warm start opens no transaction and writes nothing", async function () {
        await store.init();
        await markConversationIDTransitionMigrationApplied();
        const before = dumpDatabase(harness.db);
        const transactions = harness.transactions();
        const from = harness.statements.length;
        await store.init();
        assert.equal(harness.transactions(), transactions);
        assert.deepEqual(
          harness.statements.slice(from).filter((s) => s.inTransaction),
          [],
        );
        assert.deepEqual(dumpDatabase(harness.db), before);
      });

      it("init: legacy rows without identity are backfilled", async function () {
        await store.init();
        const key = await store.create("global");
        await store.append(key, plain("user", "legacy", at(1)));
        harness.run(
          `UPDATE ${store.catalogTable("global")}
           SET conversation_instance_id = NULL, conversation_id = NULL`,
        );
        harness.run(`UPDATE ${store.messagesTable} SET conversation_id = NULL`);
        for (const table of [
          CONVERSATION_SCHEMA_MIGRATIONS_TABLE,
          "llm_for_zotero_conversation_registry",
          "llm_for_zotero_conversation_key_ledger",
          "llm_for_zotero_conversation_key_counters",
        ]) {
          harness.run(`DELETE FROM ${table}`);
        }
        resetConversationStoreProcessStateForTests();
        const from = harness.statements.length;
        await store.init();
        golden(storeName, "init.legacyBackfill", {
          trace: transactionTrace(from),
        });
      });

      it("exports: every exported name and its type", function () {
        const moduleExports: Record<string, unknown> = isUpstream
          ? upstream
          : isCodex
            ? codex
            : claude;
        const exported = Object.fromEntries(
          Object.keys(moduleExports)
            .sort()
            .map((name) => [name, typeof moduleExports[name]]),
        );
        // Dead exports kept on purpose (no production caller today).
        for (const name of isUpstream
          ? [
              "getGlobalConversationUserTurnCount",
              "getLatestEmptyGlobalConversation",
            ]
          : isCodex
            ? ["clearCodexConversation", "initCodexCodeStore"]
            : ["clearClaudeConversation"]) {
          assert.equal(exported[name], "function", `${name} is exported`);
        }
        golden(storeName, "exports", exported);
      });

      // -------------------------------------------------------------------
      // create / ensure
      // -------------------------------------------------------------------

      it("create: allocated ranges, catalog rows, ledger, registry and prefs", async function () {
        await store.init();
        const globalKey = await store.create("global");
        const secondGlobalKey = await store.create("global");
        const paperKey = await store.create("paper");
        const range = isUpstream
          ? {
              global: {
                start: UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
                endExclusive: UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
              },
              paper: {
                start: UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
                endExclusive: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
              },
            }
          : isCodex
            ? {
                global: getCodexAllocatedConversationKeyRange("global"),
                paper: getCodexAllocatedConversationKeyRange("paper"),
              }
            : {
                global: getClaudeAllocatedConversationKeyRange("global"),
                paper: getClaudeAllocatedConversationKeyRange("paper"),
              };
        for (const [kind, key] of [
          ["global", globalKey],
          ["global", secondGlobalKey],
          ["paper", paperKey],
        ] as const) {
          assert.isAtLeast(key, range[kind].start);
          assert.isBelow(key, range[kind].endExclusive);
        }
        assert.equal(secondGlobalKey, globalKey + 1, "monotonic allocator");
        const indexed = harness
          .all(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'llm_for_zotero_conversation_search_index'`,
          )
          .map(() =>
            harness.all(
              `SELECT legacy_conversation_key AS key
               FROM llm_for_zotero_conversation_search_index`,
            ),
          )[0];
        const allocatedPrefs = [...harness.prefs.keys()].filter((key) =>
          /LastAllocated/.test(key),
        );
        if (isUpstream) {
          // U10: upstream create refreshes no search index and writes no
          // last-allocated pref.
          assert.isUndefined(indexed);
          assert.deepEqual(allocatedPrefs, []);
        } else {
          // U10: the runtime create indexes the new row and remembers the
          // last allocated key per kind.
          assert.lengthOf(indexed!, 3);
          assert.isNotEmpty(allocatedPrefs);
        }
        const summaries = {
          global: await store.getSummary(globalKey, "global"),
          paper: await store.getSummary(paperKey, "paper"),
        };
        golden(storeName, "create.allocated", {
          keys: { globalKey, secondGlobalKey, paperKey },
          summaries,
        });
      });

      it("create: a preferred key in range is used, out of range throws", async function () {
        await store.init();
        const inRange = isUpstream
          ? UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE + 41
          : (isCodex
              ? getCodexGlobalConversationKeyRange()
              : getClaudeGlobalConversationKeyRange()
            ).start + 41;
        const preferred = await outcome(() =>
          store.create("global", { conversationKey: inRange }),
        );
        // A paper-range key requested for a global conversation is outside
        // the global range in every store.
        const outOfRange = await outcome(() =>
          store.create("global", {
            conversationKey: isUpstream
              ? UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 5
              : (isCodex
                  ? getCodexAllocatedConversationKeyRange("paper")
                  : getClaudeAllocatedConversationKeyRange("paper")
                ).start + 5,
          }),
        );
        assert.deepEqual(preferred, { ok: inRange });
        assert.property(outOfRange as object, "error");
        golden(storeName, "create.preferredKey", { preferred, outOfRange });
      });

      it("ensure: returns the latest existing conversation or creates one", async function () {
        await store.init();
        let result: unknown;
        if (isUpstream) {
          // U11: upstream ensure has different semantics: the global ensure
          // is a lookup that never creates, the paper ensure is "v1".
          const globalKey = await store.create("global");
          result = {
            existingGlobal: await upstream.ensureGlobalConversationExists(
              LIBRARY_ID,
              globalKey,
            ),
            missingGlobal: await upstream.ensureGlobalConversationExists(
              LIBRARY_ID,
              UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE + 999,
            ),
            firstPaper: await upstream.ensurePaperV1Conversation(
              LIBRARY_ID,
              PAPER_ITEM_ID,
            ),
            secondPaper: await upstream.ensurePaperV1Conversation(
              LIBRARY_ID,
              PAPER_ITEM_ID,
            ),
          };
        } else {
          const ensureGlobal = isCodex
            ? codex.ensureCodexGlobalConversation
            : claude.ensureClaudeGlobalConversation;
          const ensurePaper = isCodex
            ? codex.ensureCodexPaperConversation
            : claude.ensureClaudePaperConversation;
          const createdGlobal = await ensureGlobal(LIBRARY_ID);
          const older = await store.create("global");
          harness.run(
            `UPDATE ${store.catalogTable("global")}
             SET updated_at = ?, last_activity_at = ?
             WHERE conversation_key = ?`,
            [NOW - 5000, NOW - 5000, older],
          );
          const latestGlobal = await ensureGlobal(LIBRARY_ID);
          const createdPaper = await ensurePaper(LIBRARY_ID, PAPER_ITEM_ID);
          const existingPaper = await ensurePaper(LIBRARY_ID, PAPER_ITEM_ID);
          if (isCodex) {
            // D1: Codex ranks by MAX(last_activity_at, updated_at,
            // created_at); both rows tie on created_at, so the higher key
            // wins.
            assert.equal(latestGlobal?.conversationKey, older);
          } else {
            // D1: Claude ranks by the first non-null of last_activity_at,
            // updated_at, created_at, so the touched-earlier row loses.
            assert.equal(
              latestGlobal?.conversationKey,
              createdGlobal?.conversationKey,
            );
          }
          assert.equal(
            existingPaper?.conversationKey,
            createdPaper?.conversationKey,
          );
          result = { createdGlobal, latestGlobal, createdPaper, existingPaper };
        }
        golden(storeName, "ensure", result);
      });

      // -------------------------------------------------------------------
      // append
      // -------------------------------------------------------------------

      it("append: column-by-column round trip and catalog summary", async function () {
        const key = await initAndCreate("global");
        const from = harness.statements.length;
        await store.append(key, richUserMessage());
        await store.append(key, richAssistantMessage());
        const trace = transactionTrace(from);
        const loaded = await store.load(key, 50);
        assert.lengthOf(loaded, 2);
        golden(storeName, "append.roundTrip", {
          trace,
          loaded,
          summary: await store.getSummary(key, "global"),
        });
      });

      it("append: catalog activity after a message write (D5)", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "first", at(5)));
        const row = readRow(store.catalogTable("global"), key)!;
        if (isCodex) {
          // D5: Codex merges the message timestamp into updated_at and
          // last_activity_at inside the append transaction.
          assert.equal(Number(row.updated_at), at(5));
        } else if (!isUpstream) {
          // D5: Claude has no in-store activity touch; updated_at stays.
          assert.equal(Number(row.updated_at), NOW);
        } else {
          // U9: upstream catalogs have no updated_at column.
          assert.notProperty(row, "updated_at");
        }
        assert.equal(Number(row.last_activity_at), at(5));
        golden(storeName, "append.activity", { catalogRow: row });
      });

      it("append: a pending deletion freezes the conversation", async function () {
        const key = await initAndCreate("global");
        pendingDeletionStore.isConversationPendingDeletion = (candidate) =>
          candidate === key;
        const result = await outcome(() =>
          store.append(key, plain("user", "late", at(1))),
        );
        assert.deepEqual(result, {
          error: "Error",
          message: `Conversation ${key} is frozen by a pending deletion`,
        });
        assert.lengthOf(messageRows(store, key), 0);
        golden(storeName, "append.pendingDeletion", result);
      });

      it("append: a retired key throws ConversationRetiredError", async function () {
        const key = await initAndCreate("global");
        const identity = identityOf(store, "global", key);
        await store.deleteLocalRows(key, "global", identity);
        let caught: unknown;
        try {
          await store.append(key, plain("user", "after delete", at(1)));
        } catch (error) {
          caught = error;
        }
        assert.instanceOf(caught, ConversationRetiredError);
        golden(storeName, "append.retired", describeError(caught));
      });

      it("append: an instance mismatch is refused", async function () {
        const key = await initAndCreate("global");
        const result = await outcome(() =>
          store.append(key, plain("user", "wrong", at(1)), "other-instance"),
        );
        assert.deepEqual(result, {
          error: "Error",
          message: `Conversation ${key} instance identity mismatch`,
        });
        golden(storeName, "append.instanceMismatch", result);
      });

      if (isUpstream) {
        it("append: adopts a webchat session row (upstream only)", async function () {
          await store.init();
          const key = await upstream.createGlobalConversation(LIBRARY_ID, {
            webchatSession: true,
          });
          assert.equal(
            Number(readRow(store.catalogTable("global"), key)!.webchat_session),
            1,
          );
          await store.append(key, plain("user", "kept chatting", at(1)));
          assert.equal(
            Number(readRow(store.catalogTable("global"), key)!.webchat_session),
            0,
          );
          golden(storeName, "append.webchatAdoption", null);
        });
      }

      // -------------------------------------------------------------------
      // load
      // -------------------------------------------------------------------

      it("load: limit truncates to the newest rows; 0 and NaN are pinned as found", async function () {
        const key = await initAndCreate("global");
        for (let index = 1; index <= 5; index += 1) {
          await store.append(
            key,
            plain(index % 2 ? "user" : "assistant", `m${index}`, at(index)),
          );
        }
        golden(storeName, "load.limit", {
          two: (await store.load(key, 2)).map((m) => m.text),
          zero: (await store.load(key, 0)).map((m) => m.text),
          nan: (await store.load(key, Number.NaN)).map((m) => m.text),
        });
      });

      // -------------------------------------------------------------------
      // updateLatestUser / updateLatestAssistant
      // -------------------------------------------------------------------

      it("updateLatestUser: picks the latest user row and writes its column set (U5)", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        // Two user rows with one timestamp: the higher id is the latest.
        await store.append(key, plain("user", "u2-low-id", at(3)));
        await store.append(key, plain("user", "u2-high-id", at(3)));
        const from = harness.statements.length;
        await store.updateLatestUser(
          key,
          richUserMessage({
            text: "edited",
            timestamp: at(4),
            // U5: the runtime stores check the raw array length, so an
            // all-invalid context list is written as "[]"; upstream
            // normalises first and writes NULL.
            paperContexts: [{} as never],
            selectedTexts: undefined,
            selectedTextPaperContexts: undefined,
            selectedText: "legacy selection",
          }),
        );
        const rows = harness.all(
          `SELECT * FROM ${store.messagesTable}
           WHERE conversation_key = ? ORDER BY id`,
          [key],
        );
        assert.deepEqual(
          rows.map((row) => row.text),
          ["u1", "a1", "u2-low-id", "edited"],
        );
        golden(storeName, "updateLatestUser", {
          trace: transactionTrace(from),
          loaded: await store.load(key, 50),
        });
      });

      it("updateLatestAssistant: column set and context token merge (U6)", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        await store.append(key, plain("assistant", "a2", at(3)));
        const from = harness.statements.length;
        await store.updateLatestAssistant(
          key,
          richAssistantMessage({ text: "a2-edited", timestamp: at(4) }),
        );
        await store.updateLatestAssistant(
          key,
          plain("assistant", "a2-final", at(5), {
            contextTokens: 0,
            contextWindow: undefined,
          }),
        );
        const [latest] = harness.all(
          `SELECT context_tokens AS contextTokens, context_window AS contextWindow
           FROM ${store.messagesTable}
           WHERE conversation_key = ? AND text = 'a2-final'`,
          [key],
        );
        if (isUpstream) {
          // U6: upstream overwrites the context columns and accepts 0.
          assert.equal(latest.contextTokens, 0);
          assert.isNull(latest.contextWindow);
        } else {
          // U6: the runtime stores keep the previous value
          // (COALESCE(?, column)) and accept only values above 0.
          assert.equal(latest.contextTokens, 3000);
          assert.equal(latest.contextWindow, 128000);
        }
        golden(storeName, "updateLatestAssistant", {
          trace: transactionTrace(from),
          loaded: await store.load(key, 50),
        });
      });

      it("updateLatest: a pending deletion throws only in Codex (D5)", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        pendingDeletionStore.isConversationPendingDeletion = (candidate) =>
          candidate === key;
        const user = await outcome(() =>
          store.updateLatestUser(key, plain("user", "u1-edit", at(3))),
        );
        const assistant = await outcome(() =>
          store.updateLatestAssistant(
            key,
            plain("assistant", "a1-edit", at(4)),
          ),
        );
        const frozen = {
          error: "Error",
          message: `Conversation ${key} is frozen by a pending deletion`,
        };
        if (isCodex) {
          // D5: the in-transaction activity touch throws, and the message
          // UPDATE before it rolls back with the transaction.
          assert.deepEqual(user, frozen);
          assert.deepEqual(assistant, frozen);
          assert.deepEqual(
            messageRows(store, key).map((row) => row.text),
            ["u1", "a1"],
          );
        } else {
          assert.deepEqual(user, { ok: null });
          assert.deepEqual(assistant, { ok: null });
        }
        golden(storeName, "updateLatest.pendingDeletion", { user, assistant });
      });

      // -------------------------------------------------------------------
      // clear
      // -------------------------------------------------------------------

      it("clear: refuses when the catalog identity changed", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "kept", at(1)));
        const identity = identityOf(store, "global", key);
        const result = await outcome(() =>
          store.clear(key, { ...identity, instanceID: "other-instance" }),
        );
        assert.property(result as object, "error");
        assert.lengthOf(messageRows(store, key), 1);
        golden(storeName, "clear.identityRefused", result);
      });

      it("clear: deletes messages, resets session columns (D4/U7), bumps updated_at, runs onBeforeCommit in the transaction", async function () {
        await store.init();
        const key = await store.create("global");
        if (!isUpstream) {
          const upsert = isCodex
            ? codex.upsertCodexConversationSummary
            : claude.upsertClaudeConversationSummary;
          await upsert({
            conversationKey: key,
            libraryID: LIBRARY_ID,
            kind: "global",
            createdAt: NOW - 9000,
            updatedAt: NOW - 9000,
            providerSessionId: "session-1",
            scopedConversationKey: "scoped-1",
            scopeType: "paper",
            scopeId: "77",
            scopeLabel: "Paper 77",
            cwd: "/tmp/cwd",
            model: "model-1",
            effort: "high",
            ...(isCodex ? { providerPermissionState: "granted" } : {}),
          });
          if (isCodex) {
            harness.run(
              `UPDATE ${store.catalogTable("global")}
               SET provider_session_path_state = 'path-state'
               WHERE conversation_key = ?`,
              [key],
            );
          }
          harness.run(
            `UPDATE ${store.catalogTable("global")}
             SET updated_at = ? WHERE conversation_key = ?`,
            [NOW - 9000, key],
          );
        }
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        const identity = identityOf(store, "global", key);
        let hookSawTransaction: boolean | undefined;
        let hookSawMessages: number | undefined;
        const clearFrom = harness.statements.length;
        await store.clear(key, identity, async () => {
          const from = harness.statements.length;
          const rows = (await (
            globalScope.Zotero as unknown as {
              DB: {
                queryAsync: (
                  sql: string,
                  params: unknown[],
                ) => Promise<Array<Record<string, unknown>>>;
              };
            }
          ).DB.queryAsync(
            `SELECT COUNT(*) AS count FROM ${store.messagesTable} WHERE conversation_key = ?`,
            [key],
          )) as Array<{ count: number }>;
          hookSawTransaction = harness.statements[from].inTransaction;
          hookSawMessages = Number(rows[0].count);
        });
        assert.isTrue(hookSawTransaction);
        assert.equal(hookSawMessages, 0);
        const row = readRow(store.catalogTable("global"), key)!;
        assert.equal(Number(row.user_turn_count), 0);
        if (!isUpstream) {
          assert.equal(Number(row.updated_at), NOW);
          assert.isNull(row.provider_session_id);
          // U7: clear keeps the model and effort columns.
          assert.equal(row.model_name, "model-1");
        }
        if (isCodex) {
          // D4: Codex also NULLs its two provider state columns.
          assert.isNull(row.provider_permission_state);
          assert.isNull(row.provider_session_path_state);
        }
        golden(storeName, "clear.resets", {
          trace: transactionTrace(clearFrom),
          summary: await store.getSummary(key, "global"),
        });
      });

      it("clear: a throwing onBeforeCommit rolls the clear back", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        const before = dumpDatabase(harness.db);
        const result = await outcome(() =>
          store.clear(key, undefined, async () => {
            throw new Error("hook failed");
          }),
        );
        assert.deepEqual(result, { error: "Error", message: "hook failed" });
        assert.deepEqual(dumpDatabase(harness.db), before);
      });

      // -------------------------------------------------------------------
      // deleteTurnMessages
      // -------------------------------------------------------------------

      it("deleteTurnMessages: by row id with the role guard", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        await store.append(key, plain("user", "u2", at(3)));
        await store.append(key, plain("assistant", "a2", at(4)));
        const ids = Object.fromEntries(
          messageRows(store, key).map((row) => [row.text, Number(row.id)]),
        );
        // Role guard: the "user" id names an assistant row, so it stays.
        const from = harness.statements.length;
        await store.deleteTurn(key, at(1), at(2), ids.a1, ids.a1);
        const trace = transactionTrace(from);
        assert.deepEqual(
          messageRows(store, key).map((row) => row.text),
          ["u1", "u2", "a2"],
        );
        await store.deleteTurn(key, at(3), at(4), ids.u2, ids.a2);
        assert.deepEqual(
          messageRows(store, key).map((row) => row.text),
          ["u1"],
        );
        golden(storeName, "deleteTurn.byId", {
          trace,
          summary: await store.getSummary(key, "global"),
        });
      });

      it("deleteTurnMessages: by timestamp, newest id first; invalid timestamps are a no-op", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1-low", at(1)));
        await store.append(key, plain("user", "u1-high", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        await store.append(key, plain("user", "u2", at(3)));
        await store.deleteTurn(key, 0, at(2));
        await store.deleteTurn(key, at(1), Number.NaN);
        assert.lengthOf(messageRows(store, key), 4);
        await store.deleteTurn(key, at(1), at(2));
        assert.deepEqual(
          messageRows(store, key).map((row) => row.text),
          ["u1-low", "u2"],
        );
        golden(storeName, "deleteTurn.byTimestamp", null);
      });

      it("deleteTurnMessages: drops the search-index row inside the transaction and runs onBeforeCommit", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        await store.append(key, plain("user", "u2", at(3)));
        await store.append(key, plain("assistant", "a2", at(4)));
        const indexRows = () =>
          harness.all(
            `SELECT legacy_conversation_key FROM llm_for_zotero_conversation_search_index
             WHERE legacy_conversation_key = ?`,
            [key],
          ).length;
        assert.equal(indexRows(), 1);
        let insideIndexRows: number | undefined;
        const from = harness.statements.length;
        await store.deleteTurn(key, at(1), at(2), 0, 0, async () => {
          insideIndexRows = indexRows();
          await hookMarker("beforeCommit");
        });
        const trace = transactionTrace(from);
        assert.equal(insideIndexRows, 0);
        assert.equal(indexRows(), 1, "the post-commit refresh re-indexes");
        const before = dumpDatabase(harness.db);
        const failed = await outcome(() =>
          store.deleteTurn(key, at(3), at(4), 0, 0, async () => {
            throw new Error("hook failed");
          }),
        );
        assert.deepEqual(failed, { error: "Error", message: "hook failed" });
        assert.deepEqual(dumpDatabase(harness.db), before);
        golden(storeName, "deleteTurn.searchIndex", { failed, trace });
      });

      // -------------------------------------------------------------------
      // prune
      // -------------------------------------------------------------------

      it("prune: keep 3, 0, -1 and NaN (U8)", async function () {
        await store.init();
        const kept: Record<string, string[]> = {};
        let trace: ReturnType<typeof transactionTrace> = [];
        for (const keep of [3, 0, -1, Number.NaN]) {
          const key = await store.create("global");
          for (let index = 1; index <= 5; index += 1) {
            await store.append(
              key,
              plain(index % 2 ? "user" : "assistant", `m${index}`, at(index)),
            );
          }
          const from = harness.statements.length;
          await store.prune(key, keep);
          if (keep === 3) trace = transactionTrace(from);
          kept[String(keep)] = messageRows(store, key).map((row) =>
            String(row.text),
          );
        }
        assert.deepEqual(kept["3"], ["m3", "m4", "m5"]);
        assert.deepEqual(kept["NaN"], ["m1", "m2", "m3", "m4", "m5"]);
        if (isUpstream) {
          // U8: upstream clears the whole conversation for keep <= 0.
          assert.deepEqual(kept["0"], []);
          assert.deepEqual(kept["-1"], []);
        } else {
          // U8: the runtime stores keep at least one row (normalizeLimit).
          assert.deepEqual(kept["0"], ["m5"]);
          assert.deepEqual(kept["-1"], ["m5"]);
        }
        golden(storeName, "prune", { kept, trace });
      });

      // -------------------------------------------------------------------
      // titles
      // -------------------------------------------------------------------

      it("touchTitle: only when empty, capped (U12), skipped when frozen or stale", async function () {
        await store.init();
        const longSeed = `  ${"word ".repeat(30)}\u0007tail  `;
        const keys = {
          capped: await store.create("global"),
          kept: await store.create("global"),
          frozen: await store.create("global"),
          stale: await store.create("global"),
          empty: await store.create("global"),
        };
        await store.touchTitle(keys.capped, "global", longSeed);
        await store.touchTitle(keys.kept, "global", "first title");
        await store.touchTitle(keys.kept, "global", "second title");
        freezeConversationWrites(keys.frozen);
        await store.touchTitle(keys.frozen, "global", "frozen title");
        const generation = getConversationWriteGeneration(keys.stale);
        bumpConversationWriteGeneration(keys.stale);
        await store.touchTitle(keys.stale, "global", "stale title", generation);
        await store.touchTitle(keys.empty, "global", "   ");
        const titles = Object.fromEntries(
          Object.entries(keys).map(([name, key]) => [
            name,
            readRow(store.catalogTable("global"), key)!.title,
          ]),
        );
        // U12: the title cap is 64 characters upstream, 96 in the runtimes.
        assert.lengthOf(String(titles.capped), isUpstream ? 64 : 96);
        assert.equal(titles.kept, "first title");
        assert.isNull(titles.frozen);
        assert.isNull(titles.stale);
        assert.isNull(titles.empty);
        golden(storeName, "touchTitle", titles);
      });

      it("setTitle: overwrites, and an empty title is NULL vs a no-op (U12)", async function () {
        await store.init();
        const key = await store.create("global");
        await store.touchTitle(key, "global", "first title");
        await store.setTitle(key, "global", "renamed");
        const renamed = readRow(store.catalogTable("global"), key)!.title;
        await store.setTitle(key, "global", "   ");
        const afterEmpty = readRow(store.catalogTable("global"), key)!.title;
        assert.equal(renamed, "renamed");
        if (isUpstream) {
          // U12: upstream set ignores an empty title.
          assert.equal(afterEmpty, "renamed");
        } else {
          // U12: the runtime set writes NULL for an empty title.
          assert.isNull(afterEmpty);
        }
        golden(storeName, "setTitle", { renamed, afterEmpty });
      });

      if (isUpstream) {
        it("titles: the webchat predicate skips webchat rows (upstream only, U12)", async function () {
          await store.init();
          const globalKey = await upstream.createGlobalConversation(
            LIBRARY_ID,
            { webchatSession: true },
          );
          const paper = await upstream.createPaperConversation(
            LIBRARY_ID,
            PAPER_ITEM_ID,
            { webchatSession: true },
          );
          await store.touchTitle(globalKey, "global", "touched");
          await store.setTitle(globalKey, "global", "set");
          await store.touchTitle(paper!.conversationKey, "paper", "touched");
          await store.setTitle(paper!.conversationKey, "paper", "set");
          assert.isNull(
            readRow(store.catalogTable("global"), globalKey)!.title,
          );
          assert.isNull(
            readRow(store.catalogTable("paper"), paper!.conversationKey)!.title,
          );
          golden(storeName, "titles.webchat", null);
        });

        it("clearConversationTitle: identity clause and inTransaction (upstream only)", async function () {
          await store.init();
          const key = await store.create("global");
          await store.append(key, plain("user", "question", at(1)));
          await store.setTitle(key, "global", "named");
          const identity = identityOf(store, "global", key);
          await upstream.clearConversationTitle(key, {
            instanceID: "other-instance",
          });
          const afterWrongIdentity = readRow(
            store.catalogTable("global"),
            key,
          )!.title;
          await (
            globalScope.Zotero as unknown as {
              DB: {
                executeTransaction: (
                  task: () => Promise<void>,
                ) => Promise<void>;
              };
            }
          ).DB.executeTransaction(() =>
            upstream.clearConversationTitle(key, {
              ...identity,
              inTransaction: true,
            }),
          );
          assert.equal(afterWrongIdentity, "named");
          assert.isNull(readRow(store.catalogTable("global"), key)!.title);
          golden(storeName, "clearConversationTitle", null);
        });
      } else {
        it("setTitle: identity clause and inTransaction skip the search refresh (runtime)", async function () {
          await store.init();
          const setTitle = isCodex
            ? codex.setCodexConversationTitle
            : claude.setClaudeConversationTitle;
          const key = await store.create("global");
          await store.append(key, plain("user", "question", at(1)));
          const identity = identityOf(store, "global", key);
          await setTitle(key, "wrong identity", {
            instanceID: "other-instance",
          });
          const afterWrongIdentity = readRow(
            store.catalogTable("global"),
            key,
          )!.title;
          await setTitle(key, "in transaction", {
            ...identity,
            inTransaction: true,
          });
          const indexTitle = harness.all(
            `SELECT title FROM llm_for_zotero_conversation_search_index
             WHERE legacy_conversation_key = ?`,
            [key],
          )[0]?.title;
          assert.isNull(afterWrongIdentity);
          assert.equal(
            readRow(store.catalogTable("global"), key)!.title,
            "in transaction",
          );
          assert.notEqual(indexTitle, "in transaction");
          golden(storeName, "setTitle.identity", { indexTitle });
        });
      }

      // -------------------------------------------------------------------
      // list / getSummary
      // -------------------------------------------------------------------

      it("list: activity ordering (D1), limits and the turn-count filter", async function () {
        await store.init();
        const a = await store.create("global");
        const b = await store.create("global");
        const empty = await store.create("global");
        await store.append(a, plain("user", "a", at(1)));
        await store.append(b, plain("user", "b", at(1)));
        const catalog = store.catalogTable("global");
        if (isUpstream) {
          harness.run(
            `UPDATE ${catalog} SET last_activity_at = ? WHERE conversation_key = ?`,
            [at(9), a],
          );
          harness.run(
            `UPDATE ${catalog} SET last_activity_at = ? WHERE conversation_key = ?`,
            [at(5), b],
          );
        } else {
          // Row a: old last_activity_at, newer updated_at.
          // Row b: newer last_activity_at, older updated_at.
          harness.run(
            `UPDATE ${catalog} SET last_activity_at = ?, updated_at = ? WHERE conversation_key = ?`,
            [100, at(9), a],
          );
          harness.run(
            `UPDATE ${catalog} SET last_activity_at = ?, updated_at = ? WHERE conversation_key = ?`,
            [at(5), NOW, b],
          );
        }
        const all = (await store.listGlobal(null)).map(
          (row) => row.conversationKey,
        );
        const one = (await store.listGlobal(1)).map(
          (row) => row.conversationKey,
        );
        if (isUpstream) {
          // U9: upstream orders by COALESCE(last_activity_at, created_at)
          // and its global list hides empty conversations by default.
          assert.deepEqual(all, [a, b]);
        } else if (isCodex) {
          // D1: Codex orders by MAX(last_activity_at, updated_at, created_at).
          assert.deepEqual(all, [a, b, empty]);
        } else {
          // D1: Claude orders by COALESCE(last_activity_at, updated_at,
          // created_at): the first non-null value wins.
          assert.deepEqual(all, [b, empty, a]);
        }
        assert.deepEqual(one, all.slice(0, 1));
        golden(storeName, "list.global", {
          all,
          one,
          summaries: await store.listGlobal(null),
        });
      });

      it("list: paper lists and the library-wide list skip empty conversations", async function () {
        await store.init();
        const withTurns = await store.create("paper");
        const emptyPaper = await store.create("paper");
        const otherPaper = await store.create("paper", { paperItemID: 88 });
        await store.append(withTurns, plain("user", "q", at(1)));
        await store.append(otherPaper, plain("user", "q2", at(2)));
        const perPaper = (await store.listPaper(PAPER_ITEM_ID, 50)).map(
          (row) => row.conversationKey,
        );
        const library = (await store.listAllPaper(null)).map(
          (row) => row.conversationKey,
        );
        const libraryOne = (await store.listAllPaper(1)).map(
          (row) => row.conversationKey,
        );
        assert.sameMembers(perPaper, [withTurns, emptyPaper]);
        assert.deepEqual(library, [otherPaper, withTurns]);
        assert.deepEqual(libraryOne, [otherPaper]);
        golden(storeName, "list.paper", { perPaper, library, libraryOne });
      });

      it("list: repairs a missing registry row while listing (U9)", async function () {
        await store.init();
        const key = await store.create("global");
        await store.append(key, plain("user", "q", at(1)));
        harness.run(
          `DELETE FROM llm_for_zotero_conversation_registry
           WHERE legacy_conversation_key = ?`,
          [key],
        );
        const listed = (await store.listGlobal(null)).map(
          (row) => row.conversationKey,
        );
        const registryRows = harness.all(
          `SELECT system FROM llm_for_zotero_conversation_registry
           WHERE legacy_conversation_key = ?`,
          [key],
        );
        assert.deepEqual(listed, [key]);
        // U9: only the runtime stores validate (and so re-register) rows
        // while listing; upstream lists the catalog as it is.
        assert.lengthOf(registryRows, isUpstream ? 0 : 1);
        golden(storeName, "list.registryRepair", { listed });
      });

      if (!isUpstream) {
        it("repairIdentityRegistry: re-registers with the store's activity value (D1, D2)", async function () {
          await store.init();
          const repair = isCodex
            ? codex.repairCodexConversationIdentityRegistry
            : claude.repairClaudeConversationIdentityRegistry;
          const key = await store.create("global");
          await store.append(key, plain("user", "q", at(1)));
          // last_activity_at older than updated_at, and a stale cached turn
          // count (D2: Claude reads the cached column, Codex counts rows).
          harness.run(
            `UPDATE ${store.catalogTable("global")}
             SET last_activity_at = ?, updated_at = ?, user_turn_count = 5
             WHERE conversation_key = ?`,
            [at(1), at(9), key],
          );
          harness.run(
            `DELETE FROM llm_for_zotero_conversation_registry
             WHERE legacy_conversation_key = ?`,
            [key],
          );
          await repair();
          const [registered] = harness.all(
            `SELECT updated_at AS updatedAt FROM llm_for_zotero_conversation_registry
             WHERE legacy_conversation_key = ?`,
            [key],
          );
          // D1: Codex takes MAX(last_activity_at, updated_at, created_at);
          // Claude takes the first non-null, last_activity_at.
          assert.equal(Number(registered.updatedAt), isCodex ? at(9) : at(1));
          golden(storeName, "repairIdentityRegistry", null);
        });

        it("getSummary: providerPermissionState is Codex-only (D3)", async function () {
          await store.init();
          const key = await store.create("global");
          const upsert = isCodex
            ? codex.upsertCodexConversationSummary
            : claude.upsertClaudeConversationSummary;
          await upsert({
            conversationKey: key,
            libraryID: LIBRARY_ID,
            kind: "global",
            providerSessionId: "session-1",
            providerPermissionState: "granted",
          } as Parameters<typeof codex.upsertCodexConversationSummary>[0]);
          const summary = (await store.getSummary(key, "global")) as Record<
            string,
            unknown
          >;
          const listed = (await store.listGlobal(null))[0] as Record<
            string,
            unknown
          >;
          if (isCodex) {
            assert.equal(summary.providerPermissionState, "granted");
            assert.equal(listed.providerPermissionState, "granted");
          } else {
            assert.notProperty(summary, "providerPermissionState");
            assert.notProperty(
              readRow(store.catalogTable("global"), key)!,
              "provider_permission_state",
            );
          }
          golden(storeName, "getSummary.providerPermissionState", {
            summary,
            listed,
          });
        });

        // -----------------------------------------------------------------
        // upsert (runtime only)
        // -----------------------------------------------------------------

        it("upsert: COALESCE merge, scope refusal, ledger failure and inTransaction (D3)", async function () {
          await store.init();
          const upsert = (
            isCodex
              ? codex.upsertCodexConversationSummary
              : claude.upsertClaudeConversationSummary
          ) as (params: Record<string, unknown>) => Promise<boolean>;
          const globalRange = isCodex
            ? getCodexGlobalConversationKeyRange()
            : getClaudeGlobalConversationKeyRange();
          const key = globalRange.start + 11;
          const first = await upsert({
            conversationKey: key,
            libraryID: LIBRARY_ID,
            kind: "global",
            createdAt: NOW - 1000,
            updatedAt: NOW - 1000,
            title: "seed title",
            providerSessionId: "session-1",
            cwd: "/tmp/one",
            model: "model-1",
            effort: "low",
            providerPermissionState: "granted",
          });
          const merged = await upsert({
            conversationKey: key,
            libraryID: LIBRARY_ID,
            kind: "global",
            updatedAt: NOW - 500,
            cwd: "/tmp/two",
          });
          const afterMerge = readRow(store.catalogTable("global"), key)!;
          assert.equal(afterMerge.provider_session_id, "session-1");
          assert.equal(afterMerge.cwd, "/tmp/two");
          assert.equal(afterMerge.title, "seed title");
          assert.equal(Number(afterMerge.created_at), NOW - 1000);
          if (isCodex) {
            // D3: the Codex-only permission state merges with COALESCE.
            assert.equal(afterMerge.provider_permission_state, "granted");
          }
          const reassigned = await upsert({
            conversationKey: key,
            libraryID: 2,
            kind: "global",
          });
          const wrongKind = await upsert({
            conversationKey: key,
            libraryID: LIBRARY_ID,
            kind: "paper",
            paperItemID: PAPER_ITEM_ID,
          });
          // The ledger refuses a second instance for a live key; the upsert
          // returns false before it touches the registry or the catalog.
          const ledgerFrom = harness.statements.length;
          const ledgerRefused = await upsert({
            conversationKey: key,
            instanceID: "other-instance",
            libraryID: LIBRARY_ID,
            kind: "global",
          });
          assert.deepEqual(
            harness.statements
              .slice(ledgerFrom)
              .filter((statement) =>
                /^\s*(INSERT|UPDATE|DELETE)/i.test(statement.sql),
              )
              .map((statement) => statement.sql.trim().split(/\s+/)[0]),
            [],
          );
          const inTransactionKey = globalRange.start + 12;
          const statementsFrom = harness.statements.length;
          const inTransaction = await (
            globalScope.Zotero as unknown as {
              DB: {
                executeTransaction: (
                  task: () => Promise<boolean>,
                ) => Promise<boolean>;
              };
            }
          ).DB.executeTransaction(() =>
            upsert({
              conversationKey: inTransactionKey,
              libraryID: LIBRARY_ID,
              kind: "global",
              inTransaction: true,
            }),
          );
          const outsideTransaction = harness.statements
            .slice(statementsFrom)
            .filter((statement) => !statement.inTransaction).length;
          assert.isTrue(first);
          assert.isTrue(merged);
          assert.isFalse(reassigned);
          assert.isFalse(wrongKind);
          assert.isFalse(ledgerRefused);
          assert.isTrue(inTransaction);
          assert.equal(
            outsideTransaction,
            0,
            "inTransaction skips the post-commit registry sync and search refresh",
          );
          golden(storeName, "upsert", {
            first,
            merged,
            reassigned,
            wrongKind,
            ledgerRefused,
            inTransaction,
          });
        });

        // -----------------------------------------------------------------
        // clearSessionMetadata (runtime only)
        // -----------------------------------------------------------------

        it("clearSessionMetadata: session and instance predicates (D4)", async function () {
          await store.init();
          const clearSession = isCodex
            ? codex.clearCodexConversationSessionMetadata
            : claude.clearClaudeConversationSessionMetadata;
          const upsert = (
            isCodex
              ? codex.upsertCodexConversationSummary
              : claude.upsertClaudeConversationSummary
          ) as (params: Record<string, unknown>) => Promise<boolean>;
          const key = await store.create("global");
          const seed = async () => {
            await upsert({
              conversationKey: key,
              libraryID: LIBRARY_ID,
              kind: "global",
              updatedAt: NOW - 3000,
              providerSessionId: "session-1",
              scopedConversationKey: "scoped-1",
              scopeType: "paper",
              scopeId: "77",
              scopeLabel: "Paper 77",
              cwd: "/tmp/cwd",
              model: "model-1",
              providerPermissionState: "granted",
            });
            harness.run(
              `UPDATE ${store.catalogTable("global")} SET updated_at = ? WHERE conversation_key = ?`,
              [NOW - 3000, key],
            );
          };
          const identity = identityOf(store, "global", key);
          await seed();
          await clearSession(key, "other-session");
          const wrongSession = readRow(store.catalogTable("global"), key)!;
          await clearSession(key, "session-1", "other-instance");
          const wrongInstance = readRow(store.catalogTable("global"), key)!;
          await clearSession(key, "session-1", identity.instanceID);
          const cleared = readRow(store.catalogTable("global"), key)!;
          await seed();
          await clearSession(key);
          const unconditional = readRow(store.catalogTable("global"), key)!;
          assert.equal(wrongSession.provider_session_id, "session-1");
          assert.equal(wrongInstance.provider_session_id, "session-1");
          assert.isNull(cleared.provider_session_id);
          assert.equal(Number(cleared.updated_at), NOW);
          assert.equal(cleared.model_name, "model-1");
          assert.isNull(unconditional.provider_session_id);
          if (isCodex) {
            // D4: Codex also NULLs its two provider state columns.
            assert.isNull(cleared.provider_permission_state);
          }
          golden(storeName, "clearSessionMetadata", {
            wrongSession,
            wrongInstance,
            cleared,
            unconditional,
          });
        });
      }

      it("paper lifecycle: append, edit, clear and delete route to the paper catalog (U1)", async function () {
        await store.init();
        const key = await store.create("paper");
        const steps: Record<string, unknown> = {};
        await store.append(key, plain("user", "paper question", at(1)));
        await store.append(key, plain("assistant", "paper answer", at(2)));
        await store.updateLatestUser(key, plain("user", "paper edited", at(3)));
        await store.touchTitle(key, "paper", "paper title");
        steps.afterWrites = await store.getSummary(key, "paper");
        const identity = identityOf(store, "paper", key);
        await store.clear(key, identity);
        steps.afterClear = await store.getSummary(key, "paper");
        await store.append(key, plain("user", "again", at(4)));
        await store.deleteLocalRows(key, "paper", identity);
        steps.afterDelete = await store.getSummary(key, "paper");
        assert.isNull(steps.afterDelete);
        golden(storeName, "paper.lifecycle", steps);
      });

      // -------------------------------------------------------------------
      // deleteLocalRows / preflight
      // -------------------------------------------------------------------

      it("deleteLocalRows: ledger and identity refusals", async function () {
        await store.init();
        const key = await store.create("global");
        const identity = identityOf(store, "global", key);
        const neverIssuedKey = key + 1000;
        const unknown = await outcome(() =>
          store.deleteLocalRows(neverIssuedKey, "global", {
            instanceID: "x",
          }),
        );
        const mismatch = await outcome(() =>
          store.deleteLocalRows(key, "global", {
            instanceID: "other-instance",
          }),
        );
        // The catalog row's instance no longer matches the ledger's.
        harness.run(
          `UPDATE ${store.catalogTable("global")}
           SET conversation_instance_id = 'replaced-instance'
           WHERE conversation_key = ?`,
          [key],
        );
        const witness = await outcome(() =>
          store.deleteLocalRows(key, "global", identity),
        );
        harness.run(
          `UPDATE ${store.catalogTable("global")}
           SET conversation_instance_id = ?
           WHERE conversation_key = ?`,
          [identity.instanceID, key],
        );
        await store.deleteLocalRows(key, "global", identity);
        const retiredOther = await outcome(() =>
          store.deleteLocalRows(key, "global", {
            instanceID: "other-instance",
          }),
        );
        assert.equal(
          (unknown as { error: string }).error,
          "ConversationRetiredError",
        );
        assert.equal((mismatch as { error: string }).error, "Error");
        assert.match(
          String((witness as { message: string }).message),
          /catalog identity changed/,
        );
        assert.equal(
          (retiredOther as { error: string }).error,
          "ConversationRetiredError",
        );
        golden(storeName, "deleteLocalRows.refusals", {
          unknown,
          mismatch,
          witness,
          retiredOther,
        });
      });

      it("deleteLocalRows: purges every participant, hook order, retired-in-memory after commit", async function () {
        createParticipantTables(harness);
        await store.init();
        const key = await store.create("global");
        const survivor = await store.create("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        await store.append(survivor, plain("user", "kept", at(3)));
        seedParticipantRows(harness, key);
        seedParticipantRows(harness, survivor);
        const identity = identityOf(store, "global", key);
        const events: string[] = [];
        const from = harness.statements.length;
        await store.deleteLocalRows(key, "global", {
          ...identity,
          onBeforeCommit: async () => {
            events.push(
              `beforeCommit:retiredInMemory=${isConversationKeyRetiredInMemory(key)}`,
            );
            await hookMarker("beforeCommit");
          },
          onCommit: async () => {
            events.push(
              `commit:retiredInMemory=${isConversationKeyRetiredInMemory(key)}`,
            );
            await hookMarker("commit");
          },
        });
        events.push(
          `after:retiredInMemory=${isConversationKeyRetiredInMemory(key)}`,
        );
        assert.deepEqual(events, [
          "beforeCommit:retiredInMemory=false",
          "commit:retiredInMemory=false",
          "after:retiredInMemory=true",
        ]);
        for (const table of [
          store.messagesTable,
          store.catalogTable("global"),
          "llm_for_zotero_agent_memory",
          "llm_for_zotero_usage_events",
        ]) {
          assert.lengthOf(
            harness.all(`SELECT 1 FROM ${table} WHERE conversation_key = ?`, [
              key,
            ]),
            0,
            `${table} still holds rows for the deleted key`,
          );
          assert.isNotEmpty(
            harness.all(`SELECT 1 FROM ${table} WHERE conversation_key = ?`, [
              survivor,
            ]),
            `${table} lost the survivor's rows`,
          );
        }
        const [tombstone] = harness.all(
          `SELECT identity_digest AS digest
           FROM llm_for_zotero_conversation_deletion_tombstones
           WHERE conversation_key = ?`,
          [key],
        );
        // The goldens mask the digest, so pin what it is derived from.
        assert.equal(
          tombstone?.digest,
          conversationInstanceIdentityDigest({
            conversationKey: key,
            ...identity,
          }),
        );
        golden(storeName, "deleteLocalRows.purge", {
          events,
          trace: transactionTrace(from),
        });
      });

      it("deleteLocalRows: without an identity the ledger supplies the instance", async function () {
        const key = await initAndCreate("global");
        await store.append(key, plain("user", "u1", at(1)));
        await store.append(key, plain("assistant", "a1", at(2)));
        const from = harness.statements.length;
        await store.deleteLocalRows(key, "global");
        assert.isTrue(isConversationKeyRetiredInMemory(key));
        assert.isUndefined(readRow(store.catalogTable("global"), key));
        golden(storeName, "deleteLocalRows.noIdentity", {
          trace: transactionTrace(from),
        });
      });

      it("deleteLocalRows: a throwing onCommit rolls everything back", async function () {
        createParticipantTables(harness);
        await store.init();
        const key = await store.create("global");
        await store.append(key, plain("user", "u1", at(1)));
        seedParticipantRows(harness, key);
        const identity = identityOf(store, "global", key);
        const before = dumpDatabase(harness.db);
        const result = await outcome(() =>
          store.deleteLocalRows(key, "global", {
            ...identity,
            onCommit: async () => {
              throw new Error("commit hook failed");
            },
          }),
        );
        assert.deepEqual(result, {
          error: "Error",
          message: "commit hook failed",
        });
        // The only change that survives is the fork-link table, which the
        // deletion creates lazily in its own transaction before the purge.
        assert.deepEqual(dumpDatabase(harness.db), {
          ...before,
          llm_for_zotero_conversation_fork_links: [],
        });
        assert.isFalse(isConversationKeyRetiredInMemory(key));
      });

      it("preflight: ambiguous stale message ids refuse the deletion", async function () {
        await store.init();
        const key = await store.create("global");
        await store.append(key, plain("user", "u1", at(1)));
        const clean = await outcome(() => store.preflight(key));
        harness.run(
          `INSERT INTO ${store.messagesTable}
             (conversation_id, conversation_key, role, text, timestamp)
           VALUES ('stale-a', ?, 'user', 'x', 1), ('stale-b', ?, 'user', 'y', 2)`,
          [key, key],
        );
        const refused = await outcome(() => store.preflight(key));
        const deleteRefused = await outcome(() =>
          store.deleteLocalRows(
            key,
            "global",
            identityOf(store, "global", key),
          ),
        );
        assert.deepEqual(clean, { ok: null });
        assert.property(refused as object, "error");
        assert.deepEqual(deleteRefused, refused);
        golden(storeName, "preflight", { clean, refused });
      });

      // -------------------------------------------------------------------
      // fork (upstream and Codex; Claude has none, D8)
      // -------------------------------------------------------------------

      if (storeName === "claude_code") {
        it("fork: the Claude store exports no fork functions (D8)", function () {
          const exported = Object.keys(claude);
          assert.notInclude(exported, "forkClaudeConversationMessages");
          assert.notInclude(
            exported,
            "getLatestClaudeForkableAssistantTimestamp",
          );
        });
      } else {
        it("fork: copies through the assistant anchor (D8)", async function () {
          await store.init();
          const source = await store.create("global");
          const target = await store.create("global");
          await store.append(source, plain("user", "u1", at(1)));
          await store.append(source, plain("assistant", "a1", at(2)));
          await store.append(source, plain("user", "u2", at(3)));
          await store.append(source, plain("assistant", "a2", at(4)));
          const fork = isCodex
            ? codex.forkCodexConversationMessages
            : upstream.forkUpstreamConversationMessages;
          const sourceIdentity = identityOf(store, "global", source);
          const result = await fork({
            sourceConversationKey: source,
            sourceInstanceID: sourceIdentity.instanceID,
            sourceConversationID: sourceIdentity.conversationID,
            targetConversationKey: target,
            throughAssistantTimestamp: at(2),
            timestampBase: at(10),
          });
          const missingAnchor = await fork({
            sourceConversationKey: source,
            targetConversationKey: target,
            throughAssistantTimestamp: at(99),
          });
          assert.deepEqual(result, {
            copiedMessageCount: 2,
            targetAnchorAssistantTimestamp: at(10) + 1,
          });
          assert.deepEqual(missingAnchor, {
            copiedMessageCount: 0,
            targetAnchorAssistantTimestamp: 0,
          });
          if (isCodex) {
            // D5: the fork's afterCopy touches the Codex catalog activity.
            assert.equal(
              Number(readRow(store.catalogTable("global"), target)!.updated_at),
              at(10) + 1,
            );
          }
          golden(storeName, "fork", {
            result,
            missingAnchor,
            target: await store.load(target, 50),
          });
        });
      }

      if (isCodex) {
        it("latestForkableAssistantTimestamp: skips compact and webchat rows (Codex only, D8)", async function () {
          await store.init();
          const key = await store.create("global");
          const latest = () =>
            codex.getLatestCodexForkableAssistantTimestamp(key);
          const empty = await latest();
          await store.append(key, plain("user", "u1", at(1)));
          await store.append(key, plain("assistant", "a1", at(2)));
          await store.append(
            key,
            plain("assistant", "compact", at(3), { compactMarker: true }),
          );
          await store.append(
            key,
            plain("assistant", "webchat", at(4), {
              webchatRunState: "incomplete",
            }),
          );
          const result = await latest();
          assert.equal(empty, 0);
          assert.equal(result, at(2));
          golden(storeName, "latestForkable", { empty, result });
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

  describe("harness: realTransactions", function () {
    const zoteroDb = () =>
      (
        globalScope.Zotero as unknown as {
          DB: {
            executeTransaction: (task: () => Promise<unknown>) => Promise<void>;
          };
        }
      ).DB;

    it("a nested executeTransaction throws instead of joining", async function () {
      const result = await outcome(() =>
        zoteroDb().executeTransaction(async () => {
          await zoteroDb().executeTransaction(async () => undefined);
        }),
      );
      assert.deepEqual(result, {
        error: "Error",
        message: "Nested Zotero.DB.executeTransaction would deadlock",
      });
      assert.equal(harness.transactions(), 1);
    });

    it("concurrent executeTransaction calls queue and both succeed", async function () {
      const order: string[] = [];
      const run = (name: string) =>
        zoteroDb().executeTransaction(async () => {
          order.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`${name}:end`);
        });
      await Promise.all([run("a"), run("b")]);
      assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
      assert.equal(harness.transactions(), 2);
    });

    it("background work that outlives its transaction queues instead of throwing", async function () {
      let background!: Promise<unknown>;
      await zoteroDb().executeTransaction(async () => {
        // Started inside the transaction, runs after the outer commit.
        background = outcome(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await zoteroDb().executeTransaction(async () => undefined);
          return "done";
        });
      });
      assert.deepEqual(await background, { ok: "done" });
      assert.equal(harness.transactions(), 2);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-store startup order (D6, D7)
  // -------------------------------------------------------------------------

  describe("startup order across stores", function () {
    const CLAUDE_MESSAGES = "llm_for_zotero_claude_messages";
    const CLAUDE_CATALOG = "llm_for_zotero_claude_conversations";
    const CODEX_MESSAGES = "llm_for_zotero_codex_messages";
    const CODEX_CATALOG = "llm_for_zotero_codex_conversations";

    it("Codex init moves Codex-range rows out of the Claude tables, before its key remap (D6)", async function () {
      await claude.initClaudeCodeStore();
      // A legacy Claude catalog that still carries the permission column
      // (the transfer column list selects it from the Claude table).
      harness.run(
        `ALTER TABLE ${CLAUDE_CATALOG} ADD COLUMN provider_permission_state TEXT`,
      );
      const misroutedKey = getCodexGlobalConversationKeyRange().start + 3;
      harness.run(
        `INSERT INTO ${CLAUDE_CATALOG}
           (conversation_key, library_id, kind, created_at, updated_at, title)
         VALUES (?, 1, 'global', ?, ?, 'misrouted')`,
        [misroutedKey, NOW, NOW],
      );
      harness.run(
        `INSERT INTO ${CLAUDE_MESSAGES}
           (conversation_key, role, text, timestamp)
         VALUES (?, 'user', 'misrouted message', ?)`,
        [misroutedKey, at(1)],
      );
      const from = harness.statements.length;
      await codex.initCodexAppServerStore();
      const sqls = harness.statements.slice(from).map((s) => s.sql);
      const moveIndex = sqls.findIndex((sql) =>
        sql.includes(`INSERT INTO ${CODEX_CATALOG} (conversation_key`),
      );
      const remapIndex = sqls.findIndex(
        (sql) =>
          sql.includes(`FROM ${CODEX_CATALOG}`) &&
          sql.includes("ORDER BY updated_at DESC, conversation_key DESC"),
      );
      assert.isAtLeast(moveIndex, 0, "the misroute repair ran");
      assert.isAbove(remapIndex, moveIndex, "repair runs before the key remap");
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM ${CLAUDE_CATALOG} WHERE conversation_key = ?`,
          [misroutedKey],
        ),
        0,
      );
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM ${CODEX_MESSAGES} WHERE conversation_key = ?`,
          [misroutedKey],
        ),
        1,
      );
      golden("codex", "startup.misrouteRepair", null);
    });

    it("Codex init fails on a misrouted catalog row when the Claude catalog lacks the permission column (D6, as-is)", async function () {
      // Pinned as found: the transfer column list includes
      // provider_permission_state, which the current Claude catalog schema
      // does not have, so moving a misrouted catalog row aborts Codex init.
      await claude.initClaudeCodeStore();
      const misroutedKey = getCodexGlobalConversationKeyRange().start + 3;
      harness.run(
        `INSERT INTO ${CLAUDE_CATALOG}
           (conversation_key, library_id, kind, created_at, updated_at, title)
         VALUES (?, 1, 'global', ?, ?, 'misrouted')`,
        [misroutedKey, NOW, NOW],
      );
      const result = await outcome(() => codex.initCodexAppServerStore());
      assert.deepEqual(result, {
        error: "Error",
        message: "no such column: provider_permission_state",
      });
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM ${CLAUDE_CATALOG} WHERE conversation_key = ?`,
          [misroutedKey],
        ),
        1,
        "the failed init rolled back",
      );
    });

    it("Codex init skips the misroute repair once the ID transition is recorded (D6)", async function () {
      await claude.initClaudeCodeStore();
      await codex.initCodexAppServerStore();
      await markConversationIDTransitionMigrationApplied();
      const misroutedKey = getCodexGlobalConversationKeyRange().start + 4;
      harness.run(
        `INSERT INTO ${CLAUDE_MESSAGES}
           (conversation_key, role, text, timestamp)
         VALUES (?, 'user', 'misrouted later', ?)`,
        [misroutedKey, at(1)],
      );
      await codex.initCodexAppServerStore();
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM ${CLAUDE_MESSAGES} WHERE conversation_key = ?`,
          [misroutedKey],
        ),
        1,
      );
    });

    it("only Codex init cleans remembered key prefs, after its schema pass (D7)", async function () {
      const scalar = `${PREF_PREFIX}.codexAppServerLastAllocatedGlobalConversationKey`;
      const claudeScalar = `${PREF_PREFIX}.claudeCodeLastAllocatedGlobalConversationKey`;
      harness.prefs.set(scalar, 7);
      harness.prefs.set(claudeScalar, 7);
      await claude.initClaudeCodeStore();
      assert.equal(harness.prefs.get(scalar), 7, "Claude init cleans nothing");
      const prefs = (
        globalScope.Zotero as unknown as {
          Prefs: { set: (key: string, value: unknown) => void };
        }
      ).Prefs;
      const originalSet = prefs.set;
      let cleanedAtStatement = -1;
      prefs.set = (key, value) => {
        if (key === scalar) cleanedAtStatement = harness.statements.length;
        originalSet(key, value);
      };
      const from = harness.statements.length;
      await codex.initCodexAppServerStore();
      const fingerprintWrite = harness.statements.findIndex(
        (statement, index) =>
          index >= from &&
          statement.sql.includes(
            `INSERT INTO ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}`,
          ) &&
          statement.params[0] === startupSchemaFingerprintID("codex"),
      );
      assert.isAtLeast(fingerprintWrite, 0);
      assert.isAbove(cleanedAtStatement, fingerprintWrite);
      assert.equal(harness.prefs.get(scalar), 0);
      assert.equal(harness.prefs.get(claudeScalar), 0);
    });
  });
});
