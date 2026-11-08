import { assert } from "chai";
import {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { buildConversationID } from "../src/shared/conversationRegistry";
import {
  CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
  CONVERSATION_SEARCH_INDEX_TABLE,
  deleteConversationSearchIndexRow,
  initConversationSearchIndexStore,
  loadTruncatedConversationIndexMatches,
  refreshConversationSearchIndex,
  refreshConversationSearchIndexForConversation,
  refreshConversationSearchIndexForSystem,
  searchConversationIndex,
  searchConversationIndexWithStatus,
} from "../src/shared/conversationSearchIndex";

describe("conversation search index", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  function installSearchIndexDb(
    params: {
      tables?: string[];
      searchRows?: Array<Record<string, unknown>>;
      liveConversationKeys?: number[];
      tableInfo?: Array<Record<string, unknown>>;
      handleQuery?: (
        sql: string,
        queryParams?: unknown[],
      ) => Promise<unknown> | unknown;
    } = {},
  ) {
    const tables = new Set(params.tables || []);
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, queryParams?: unknown[]) => {
          queries.push({ sql, params: queryParams });
          const handled = await params.handleQuery?.(sql, queryParams);
          if (handled !== undefined) return handled;
          if (sql.includes("FROM sqlite_master")) {
            const tableName = String(queryParams?.[0] || "");
            return tables.has(tableName) ? [{ name: tableName }] : [];
          }
          if (
            sql.includes(
              `PRAGMA table_info(${CONVERSATION_SEARCH_INDEX_TABLE})`,
            )
          ) {
            return params.tableInfo || [];
          }
          if (
            sql.includes(`FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`) &&
            (sql.includes("WHERE system = ?") ||
              sql.includes("WHERE si.system = ?")) &&
            sql.includes("body_text AS bodyText")
          ) {
            const searchRows = params.searchRows || [];
            if (!params.liveConversationKeys) return searchRows;
            const liveKeys = new Set(params.liveConversationKeys);
            return searchRows.filter((row) =>
              liveKeys.has(Number(row.conversationKey)),
            );
          }
          return [];
        },
      },
    };
    return { queries };
  }

  it("initializes a DB-backed search index table", async function () {
    const { queries } = installSearchIndexDb();

    assert.equal(await initConversationSearchIndexStore(), true);

    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("CREATE TABLE IF NOT EXISTS") &&
          sql.includes(CONVERSATION_SEARCH_INDEX_TABLE) &&
          sql.includes("search_key TEXT PRIMARY KEY") &&
          sql.includes("conversation_id TEXT NOT NULL") &&
          sql.includes("body_text TEXT NOT NULL"),
      ),
    );
    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("CREATE INDEX IF NOT EXISTS") &&
          sql.includes(
            "(system, library_id, user_turn_count, last_activity_at DESC)",
          ),
      ),
    );
  });

  it("recreates the cache when the old conversation_id primary key schema exists", async function () {
    const { queries } = installSearchIndexDb({
      tables: [CONVERSATION_SEARCH_INDEX_TABLE],
      tableInfo: [
        { name: "conversation_id", pk: 1 },
        { name: "legacy_conversation_key", pk: 0 },
      ],
    });

    assert.equal(await initConversationSearchIndexStore(), true);

    assert.isTrue(
      queries.some(({ sql }) =>
        sql.includes(`DROP TABLE IF EXISTS ${CONVERSATION_SEARCH_INDEX_TABLE}`),
      ),
    );
    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("CREATE TABLE IF NOT EXISTS") &&
          sql.includes("search_key TEXT PRIMARY KEY"),
      ),
    );
  });

  it("refreshes upstream, Claude, and Codex catalogs into the shared index", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
        "llm_for_zotero_chat_messages",
        "llm_for_zotero_claude_conversations",
        "llm_for_zotero_claude_messages",
        "llm_for_zotero_codex_conversations",
        "llm_for_zotero_codex_messages",
      ],
    });

    assert.equal(await refreshConversationSearchIndex(), true);

    assert.isTrue(
      queries.some(
        ({ sql, params }) =>
          sql.includes("INSERT OR REPLACE INTO") &&
          sql.includes("llm_for_zotero_global_conversations") &&
          sql.includes("llm_for_zotero_chat_messages") &&
          !sql.includes("c.updated_at") &&
          params?.[0] === "upstream",
      ),
    );
    assert.isTrue(
      queries.some(
        ({ sql, params }) =>
          sql.includes("INSERT OR REPLACE INTO") &&
          sql.includes("llm_for_zotero_claude_conversations") &&
          sql.includes("llm_for_zotero_claude_messages") &&
          params?.[0] === "claude_code",
      ),
    );
    assert.isTrue(
      queries.some(
        ({ sql, params }) =>
          sql.includes("INSERT OR REPLACE INTO") &&
          sql.includes("llm_for_zotero_codex_conversations") &&
          sql.includes("llm_for_zotero_codex_messages") &&
          params?.[0] === "codex",
      ),
    );
  });

  it("adds canonical key-kind filters while refreshing search rows", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
        "llm_for_zotero_chat_messages",
        "llm_for_zotero_codex_conversations",
        "llm_for_zotero_codex_messages",
      ],
    });

    assert.equal(
      await refreshConversationSearchIndexForSystem("upstream"),
      true,
    );
    assert.equal(await refreshConversationSearchIndexForSystem("codex"), true);

    const upstreamGlobalInsert = queries.find(
      ({ sql }) =>
        sql.includes("INSERT OR REPLACE INTO") &&
        sql.includes("llm_for_zotero_global_conversations"),
    );
    const upstreamPaperInsert = queries.find(
      ({ sql }) =>
        sql.includes("INSERT OR REPLACE INTO") &&
        sql.includes("llm_for_zotero_paper_conversations"),
    );
    const codexInsert = queries.find(
      ({ sql }) =>
        sql.includes("INSERT OR REPLACE INTO") &&
        sql.includes("llm_for_zotero_codex_conversations"),
    );

    assert.include(
      upstreamGlobalInsert?.sql || "",
      `c.conversation_key >= ${UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE}`,
    );
    assert.include(upstreamPaperInsert?.sql || "", "c.session_version > 0");
    assert.include(
      upstreamPaperInsert?.sql || "",
      `c.conversation_key < ${UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE}`,
    );
    assert.include(codexInsert?.sql || "", "c.kind = 'paper'");
    assert.include(
      codexInsert?.sql || "",
      `c.conversation_key >= ${CODEX_PAPER_CONVERSATION_KEY_BASE}`,
    );
  });

  it("searches indexed rows by current system and library", async function () {
    const conversationKey = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 44;
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_paper_conversations",
        "llm_for_zotero_chat_messages",
      ],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey,
            system: "upstream",
            kind: "paper",
            libraryID: 2,
            paperItemID: 44,
          }),
          conversationKey,
          system: "upstream",
          kind: "paper",
          libraryID: 2,
          paperItemID: 44,
          title: "Decoder margin",
          bodyText: "A discussion of stable decoding under drift.",
          lastActivityAt: 1234,
          userTurnCount: 2,
        },
      ],
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder drift",
      limit: 10,
    });

    assert.deepEqual(rows, [
      {
        conversationID: buildConversationID({
          conversationKey,
          system: "upstream",
          kind: "paper",
          libraryID: 2,
          paperItemID: 44,
        }),
        conversationKey,
        system: "upstream",
        kind: "paper",
        libraryID: 2,
        paperItemID: 44,
        title: "Decoder margin",
        bodyText: "A discussion of stable decoding under drift.",
        lastActivityAt: 1234,
        userTurnCount: 2,
      },
    ]);
    const searchQuery = queries.find(
      ({ sql }) =>
        sql.includes(`FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`) &&
        sql.includes("body_text AS bodyText"),
    );
    const searchSql = searchQuery?.sql || "";
    const tokenFilterSql = searchSql.slice(
      searchSql.indexOf("user_turn_count > 0"),
    );
    assert.include(
      tokenFilterSql,
      "\n        OR (LOWER(COALESCE(si.title, '')) LIKE ?",
    );
    assert.notInclude(
      tokenFilterSql,
      "\n       AND (LOWER(COALESCE(si.title, '')) LIKE ?",
    );
    assert.deepEqual(searchQuery?.params, [
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      "upstream",
      2,
      "%decoder%",
      "%decoder%",
      "%decoder%",
      "%drift%",
      "%drift%",
      "%drift%",
      2,
      10,
    ]);
    assert.isFalse(
      queries.some(({ sql }) => sql.includes("INSERT OR REPLACE INTO")),
    );
  });

  it("requires every word and applies the paper and activity filters in the read when asked", async function () {
    const { queries } = installSearchIndexDb({
      tables: ["llm_for_zotero_paper_conversations"],
      searchRows: [],
    });
    await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder drift",
      limit: 10,
      matchAllWords: true,
      paperItemID: 44,
      minLastActivityAt: 5_000,
    });
    const searchQuery = queries.find(
      ({ sql }) =>
        sql.includes(`FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`) &&
        sql.includes("body_text AS bodyText"),
    );
    const searchSql = searchQuery?.sql || "";
    const tokenFilterSql = searchSql.slice(
      searchSql.indexOf("user_turn_count > 0"),
    );
    assert.include(
      tokenFilterSql,
      "\n        AND (LOWER(COALESCE(si.title, '')) LIKE ?",
    );
    assert.notInclude(tokenFilterSql, "library chat");
    assert.include(searchSql, "si.kind = 'paper' AND si.paper_item_id = ?");
    assert.include(searchSql, "si.last_activity_at >= ?");
    assert.deepEqual(searchQuery?.params, [
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      "upstream",
      2,
      "%decoder%",
      "%decoder%",
      "%drift%",
      "%drift%",
      44,
      5_000,
      2,
      10,
    ]);
  });

  it("refreshes before searching only when explicitly requested", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_codex_conversations",
        "llm_for_zotero_codex_messages",
      ],
    });

    await searchConversationIndex({
      system: "codex",
      libraryID: 2,
      query: "decoder",
      refresh: true,
    });

    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("INSERT OR REPLACE INTO") &&
          sql.includes("llm_for_zotero_codex_conversations"),
      ),
    );
  });

  it("searches scope labels without applying a default result cap", async function () {
    const conversationKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    const { queries } = installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "General setup",
          bodyText: "No explicit scope keyword here.",
          lastActivityAt: 1234,
          userTurnCount: 1,
        },
      ],
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "library",
    });

    assert.lengthOf(rows, 1);
    const searchQuery = queries.find(
      ({ sql }) =>
        sql.includes(`FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`) &&
        sql.includes("body_text AS bodyText"),
    );
    assert.include(searchQuery?.sql || "", "library chat");
    assert.notInclude(searchQuery?.sql || "", "LIMIT ?");
    assert.deepEqual(searchQuery?.params, [
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      "upstream",
      2,
      "%library%",
      "%library%",
      "%library%",
      2,
    ]);
  });

  it("returns both library and paper chat matches for the active library", async function () {
    const globalKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    const paperKey = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 44;
    installSearchIndexDb({
      tables: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
      ],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey: globalKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: globalKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Decoder library discussion",
          bodyText: "Shared library chat notes.",
          lastActivityAt: 2000,
          userTurnCount: 1,
        },
        {
          conversationID: buildConversationID({
            conversationKey: paperKey,
            system: "upstream",
            kind: "paper",
            libraryID: 2,
            paperItemID: 44,
          }),
          conversationKey: paperKey,
          system: "upstream",
          kind: "paper",
          libraryID: 2,
          paperItemID: 44,
          title: "Decoder paper discussion",
          bodyText: "Paper chat notes.",
          lastActivityAt: 1000,
          userTurnCount: 1,
        },
      ],
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.deepEqual(
      rows.map((row) => row.kind),
      ["global", "paper"],
    );
  });

  it("canonicalizes same-scope stale ids and keeps duplicate stale ids distinct by key", async function () {
    const firstKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    const secondKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 3;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      searchRows: [
        {
          conversationID: "llm-chat:v1:profile-x:upstream:2000000000",
          conversationKey: firstKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Decoder first",
          bodyText: "decoder",
          lastActivityAt: 2000,
          userTurnCount: 1,
        },
        {
          conversationID: "llm-chat:v1:profile-x:upstream:2000000000",
          conversationKey: secondKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Decoder second",
          bodyText: "decoder",
          lastActivityAt: 1000,
          userTurnCount: 1,
        },
      ],
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.deepEqual(
      rows.map((row) => row.conversationKey),
      [firstKey, secondKey],
    );
    assert.deepEqual(
      rows.map((row) => row.conversationID),
      [
        buildConversationID({
          conversationKey: firstKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
        }),
        buildConversationID({
          conversationKey: secondKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
        }),
      ],
    );
  });

  it("excludes canonical ids that point at a different scope", async function () {
    const conversationKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey,
            system: "upstream",
            kind: "global",
            libraryID: 3,
          }),
          conversationKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Decoder mismatch",
          bodyText: "decoder",
          lastActivityAt: 1000,
          userTurnCount: 1,
        },
      ],
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.deepEqual(rows, []);
  });

  it("reports empty coverage when catalog rows are missing from an empty index", async function () {
    installSearchIndexDb({
      tables: ["llm_for_zotero_codex_conversations"],
      handleQuery: (sql) => {
        if (sql.includes("COUNT(*) AS indexedRowCount")) {
          return [{ indexedRowCount: 0, truncatedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS catalogRowCount")) {
          return [{ catalogRowCount: 1, missingIndexedRowCount: 1 }];
        }
        return undefined;
      },
    });

    const result = await searchConversationIndexWithStatus({
      system: "codex",
      libraryID: 2,
      query: "decoder",
    });

    assert.equal(result.status, "empty");
    assert.equal(result.indexedRowCount, 0);
    assert.equal(result.catalogRowCount, 1);
    assert.equal(result.truncatedRowCount, 0);
    assert.deepEqual(result.matches, []);
  });

  it("reports stale coverage when some catalog rows are missing from the index", async function () {
    installSearchIndexDb({
      tables: ["llm_for_zotero_codex_conversations"],
      handleQuery: (sql) => {
        if (sql.includes("COUNT(*) AS indexedRowCount")) {
          return [{ indexedRowCount: 1, truncatedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS catalogRowCount")) {
          return [{ catalogRowCount: 2, missingIndexedRowCount: 1 }];
        }
        return undefined;
      },
    });

    const result = await searchConversationIndexWithStatus({
      system: "codex",
      libraryID: 2,
      query: "decoder",
    });

    assert.equal(result.status, "stale");
    assert.equal(result.indexedRowCount, 1);
    assert.equal(result.catalogRowCount, 2);
  });

  it("reports stale coverage when indexed rows no longer have catalog rows", async function () {
    const liveKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 21;
    const staleKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 22;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      liveConversationKeys: [liveKey],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey: liveKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: liveKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Live decoder",
          bodyText: "decoder",
          lastActivityAt: 2000,
          userTurnCount: 1,
        },
        {
          conversationID: buildConversationID({
            conversationKey: staleKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: staleKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Deleted decoder",
          bodyText: "decoder",
          lastActivityAt: 3000,
          userTurnCount: 1,
        },
      ],
      handleQuery: (sql) => {
        if (sql.includes("COUNT(*) AS indexedRowCount")) {
          return [{ indexedRowCount: 2, truncatedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS catalogRowCount")) {
          return [{ catalogRowCount: 1, missingIndexedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS staleIndexedRowCount")) {
          return [{ staleIndexedRowCount: 1 }];
        }
        return undefined;
      },
    });

    const result = await searchConversationIndexWithStatus({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.equal(result.status, "stale");
    assert.equal(result.indexedRowCount, 2);
    assert.equal(result.catalogRowCount, 1);
    assert.equal(result.staleIndexedRowCount, 1);
    assert.deepEqual(
      result.matches.map((row) => row.conversationKey),
      [liveKey],
    );
  });

  it("filters direct indexed search results through live catalog rows", async function () {
    const liveKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 31;
    const staleKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 32;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      liveConversationKeys: [liveKey],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey: liveKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: liveKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Live decoder",
          bodyText: "decoder",
          lastActivityAt: 2000,
          userTurnCount: 1,
        },
        {
          conversationID: buildConversationID({
            conversationKey: staleKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: staleKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Deleted decoder",
          bodyText: "decoder",
          lastActivityAt: 3000,
          userTurnCount: 1,
        },
      ],
      handleQuery: (sql) => {
        if (sql.includes("COUNT(*) AS indexedRowCount")) {
          return [{ indexedRowCount: 2, truncatedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS catalogRowCount")) {
          return [{ catalogRowCount: 1, missingIndexedRowCount: 0 }];
        }
        if (sql.includes("COUNT(*) AS staleIndexedRowCount")) {
          return [{ staleIndexedRowCount: 1 }];
        }
        return undefined;
      },
    });

    const rows = await searchConversationIndex({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.deepEqual(
      rows.map((row) => row.conversationKey),
      [liveKey],
    );
  });

  it("reports truncated coverage when indexed bodies hit the storage limit", async function () {
    const conversationKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Large chat",
          bodyText: "decoder",
          lastActivityAt: 1234,
          userTurnCount: 1,
        },
      ],
      handleQuery: (sql) => {
        if (sql.includes("COUNT(*) AS indexedRowCount")) {
          return [{ indexedRowCount: 1, truncatedRowCount: 1 }];
        }
        if (sql.includes("COUNT(*) AS catalogRowCount")) {
          return [{ catalogRowCount: 1, missingIndexedRowCount: 0 }];
        }
        return undefined;
      },
    });

    const result = await searchConversationIndexWithStatus({
      system: "upstream",
      libraryID: 2,
      query: "decoder",
    });

    assert.equal(result.status, "truncated");
    assert.equal(result.truncatedRowCount, 1);
    assert.lengthOf(result.matches, 1);
  });

  it("loads truncated indexed rows for targeted full-message search", async function () {
    const conversationKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 2;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Large chat",
          bodyText: "decoder",
          lastActivityAt: 1234,
          userTurnCount: 1,
          bodyTruncated: 1,
        },
      ],
    });

    const rows = await loadTruncatedConversationIndexMatches({
      system: "upstream",
      libraryID: 2,
    });

    assert.lengthOf(rows, 1);
    assert.equal(rows[0]?.conversationKey, conversationKey);
    assert.equal(rows[0]?.bodyTruncated, true);
  });

  it("excludes truncated indexed rows without live catalog rows", async function () {
    const liveKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 41;
    const staleKey = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 42;
    installSearchIndexDb({
      tables: ["llm_for_zotero_global_conversations"],
      liveConversationKeys: [liveKey],
      searchRows: [
        {
          conversationID: buildConversationID({
            conversationKey: liveKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: liveKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Live large chat",
          bodyText: "decoder",
          lastActivityAt: 2000,
          userTurnCount: 1,
          bodyTruncated: 1,
        },
        {
          conversationID: buildConversationID({
            conversationKey: staleKey,
            system: "upstream",
            kind: "global",
            libraryID: 2,
          }),
          conversationKey: staleKey,
          system: "upstream",
          kind: "global",
          libraryID: 2,
          paperItemID: null,
          title: "Deleted large chat",
          bodyText: "decoder",
          lastActivityAt: 3000,
          userTurnCount: 1,
          bodyTruncated: 1,
        },
      ],
    });

    const rows = await loadTruncatedConversationIndexMatches({
      system: "upstream",
      libraryID: 2,
    });

    assert.deepEqual(
      rows.map((row) => row.conversationKey),
      [liveKey],
    );
  });

  it("does not refresh missing store tables", async function () {
    const { queries } = installSearchIndexDb();

    assert.equal(
      await refreshConversationSearchIndexForSystem("claude_code"),
      true,
    );

    assert.isFalse(
      queries.some(
        ({ sql }) =>
          sql.includes("INSERT OR REPLACE INTO") &&
          sql.includes("llm_for_zotero_claude_conversations"),
      ),
    );
  });

  it("prunes all system search rows when no source catalog table exists", async function () {
    const { queries } = installSearchIndexDb();

    assert.equal(await refreshConversationSearchIndexForSystem("codex"), true);

    const deleteQuery = queries.find(({ sql }) =>
      sql.includes(`DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`),
    );
    assert.include(deleteQuery?.sql || "", "WHERE system = ?");
    assert.notInclude(deleteQuery?.sql || "", "NOT EXISTS");
    assert.deepEqual(deleteQuery?.params, ["codex"]);
  });

  it("prunes stale search rows against the current catalog key and library", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_codex_conversations",
        "llm_for_zotero_codex_messages",
      ],
    });

    assert.equal(await refreshConversationSearchIndexForSystem("codex"), true);

    const pruneQuery = queries.find(
      ({ sql }) =>
        sql.includes(`DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`) &&
        sql.includes("NOT EXISTS"),
    );
    assert.include(pruneQuery?.sql || "", "llm_for_zotero_codex_conversations");
    assert.include(
      pruneQuery?.sql || "",
      `live_catalog.conversation_key = ${CONVERSATION_SEARCH_INDEX_TABLE}.legacy_conversation_key`,
    );
    assert.include(
      pruneQuery?.sql || "",
      `live_catalog.library_id = ${CONVERSATION_SEARCH_INDEX_TABLE}.library_id`,
    );
    assert.deepEqual(pruneQuery?.params, ["codex"]);
  });

  it("refreshes one indexed conversation by legacy key", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
        "llm_for_zotero_chat_messages",
      ],
    });

    assert.equal(
      await refreshConversationSearchIndexForConversation({
        system: "upstream",
        conversationKey: 1005,
      }),
      true,
    );

    const refreshQueries = queries.filter(
      ({ sql }) =>
        sql.includes("INSERT OR REPLACE INTO") &&
        sql.includes(CONVERSATION_SEARCH_INDEX_TABLE),
    );
    assert.lengthOf(refreshQueries, 2);
    assert.isTrue(
      refreshQueries.every(
        ({ sql, params }) =>
          sql.includes("AND (c.conversation_key = ?)") &&
          params?.[0] === "upstream" &&
          params?.[5] === 1005,
      ),
    );
  });

  it("refreshes one indexed conversation by canonical id", async function () {
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 8101;
    const conversationID = buildConversationID({
      conversationKey,
      system: "codex",
      kind: "global",
      libraryID: 1,
    });
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_codex_conversations",
        "llm_for_zotero_codex_messages",
      ],
    });

    assert.equal(
      await refreshConversationSearchIndexForConversation({
        system: "codex",
        conversationID,
        conversationKey,
      }),
      true,
    );

    const refreshQuery = queries.find(
      ({ sql }) =>
        sql.includes("INSERT OR REPLACE INTO") &&
        sql.includes("llm_for_zotero_codex_conversations"),
    );
    assert.isOk(refreshQuery);
    assert.include(refreshQuery?.sql || "", "AND (c.conversation_id = ?)");
    assert.include(refreshQuery?.sql || "", "GROUP_CONCAT(SUBSTR(m.text");
    assert.deepEqual(refreshQuery?.params, [
      "codex",
      "codex",
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      refreshQuery?.params?.[4],
      conversationID,
    ]);
  });

  it("indexes by conversation key without repairing messages from catalog ids", async function () {
    const { queries } = installSearchIndexDb({
      tables: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
        "llm_for_zotero_chat_messages",
      ],
    });

    assert.equal(
      await refreshConversationSearchIndexForSystem("upstream"),
      true,
    );

    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("UPDATE llm_for_zotero_chat_messages"),
      ),
    );
    const indexInsert = queries.find(({ sql }) =>
      sql.includes(`INSERT OR REPLACE INTO ${CONVERSATION_SEARCH_INDEX_TABLE}`),
    );
    assert.include(indexInsert?.sql || "", "? || ':' || c.conversation_key");
    assert.include(
      indexInsert?.sql || "",
      "m.conversation_key = c.conversation_key",
    );
  });

  it("deletes indexed rows by id or scoped legacy key", async function () {
    const { queries } = installSearchIndexDb();

    assert.equal(
      await deleteConversationSearchIndexRow({
        conversationID: "lfz:user:codex:paper:lib-1:paper-44:legacy-8101",
      }),
      true,
    );
    assert.equal(
      await deleteConversationSearchIndexRow({
        system: "claude_code",
        conversationKey: 7101,
      }),
      true,
    );

    const deletes = queries.filter(({ sql }) =>
      sql.includes(`DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}`),
    );
    assert.lengthOf(deletes, 2);
    assert.include(deletes[0].sql, "WHERE conversation_id = ?");
    assert.deepEqual(deletes[0].params, [
      "lfz:user:codex:paper:lib-1:paper-44:legacy-8101",
    ]);
    assert.include(deletes[1].sql, "WHERE system = ?");
    assert.include(deletes[1].sql, "AND legacy_conversation_key = ?");
    assert.deepEqual(deletes[1].params, ["claude_code", 7101]);
  });
});
