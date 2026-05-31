import { assert } from "chai";
import { conversationRepository } from "../src/core/conversations/repository";
import {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { buildConversationID } from "../src/shared/conversationRegistry";

describe("conversationRepository", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("normalizes upstream catalog rows behind the repository boundary", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes("FROM llm_for_zotero_global_conversations gc")) {
            return [
              {
                conversationKey: 2_000_000_021,
                libraryID: 7,
                createdAt: 100,
                title: "Repository title",
                lastActivityAt: 300,
                userTurnCount: 2,
              },
            ];
          }
          return [];
        },
      },
    };

    const rows = await conversationRepository.listCatalogEntries({
      system: "upstream",
      kind: "global",
      libraryID: 7,
      limit: 10,
      includeEmpty: true,
    });

    assert.deepEqual(rows, [
      {
        conversationID: buildConversationID({
          conversationKey: 2_000_000_021,
          system: "upstream",
          kind: "global",
          libraryID: 7,
        }),
        conversationKey: 2_000_000_021,
        system: "upstream",
        kind: "global",
        libraryID: 7,
        createdAt: 100,
        lastActivityAt: 300,
        title: "Repository title",
        userTurnCount: 2,
      },
    ]);
    assert.isTrue(
      queries.some(({ sql }) =>
        sql.includes("FROM llm_for_zotero_global_conversations gc"),
      ),
    );
    const listQuery = queries.find(({ sql }) =>
      sql.includes("FROM llm_for_zotero_global_conversations gc"),
    );
    assert.notInclude(listQuery?.sql || "", "HAVING");
    assert.notInclude(listQuery?.sql || "", "llm_for_zotero_chat_messages");
  });

  it("keeps upstream paper history visible without consulting stale runtime registry", async function () {
    const conversationKey = 42;
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes("llm_for_zotero_conversation_registry")) {
            throw new Error("history lists must not depend on registry state");
          }
          if (sql.includes("FROM llm_for_zotero_paper_conversations pc")) {
            return [
              {
                conversationID: buildConversationID({
                  conversationKey,
                  system: "upstream",
                  kind: "paper",
                  libraryID: 1,
                  paperItemID: 42,
                }),
                conversationKey,
                libraryID: 1,
                paperItemID: 42,
                sessionVersion: 1,
                createdAt: 100,
                title: "Paper chat",
                lastActivityAt: 200,
                userTurnCount: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const rows = await conversationRepository.listCatalogEntries({
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 42,
      limit: 10,
    });

    assert.lengthOf(rows, 1);
    assert.equal(rows[0]?.conversationKey, conversationKey);
    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("llm_for_zotero_conversation_registry"),
      ),
    );
  });

  it("drops upstream paper rows whose key is in the global range", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("FROM llm_for_zotero_paper_conversations pc")) {
            return [
              {
                conversationID: buildConversationID({
                  conversationKey: 2_000_000_003,
                  system: "upstream",
                  kind: "paper",
                  libraryID: 1,
                  paperItemID: 42,
                }),
                conversationKey: 2_000_000_003,
                libraryID: 1,
                paperItemID: 42,
                sessionVersion: 1,
                createdAt: 100,
                title: "Bad paper row",
                lastActivityAt: 200,
                userTurnCount: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const rows = await conversationRepository.listCatalogEntries({
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 42,
      limit: 10,
    });

    assert.deepEqual(rows, []);
  });

  it("routes catalog title updates by conversation system", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    };

    await conversationRepository.setCatalogTitle({
      system: "codex",
      kind: "global",
      conversationKey,
      title: "Renamed Codex chat",
    });

    const update = queries.find(({ sql }) =>
      sql.includes("UPDATE llm_for_zotero_codex_conversations"),
    );
    assert.isOk(update);
    assert.deepEqual(update?.params, ["Renamed Codex chat", conversationKey]);
  });

  it("routes catalog deletion by system and kind", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    };

    await conversationRepository.deleteCatalogEntry({
      system: "upstream",
      kind: "paper",
      conversationKey: 42,
    });

    const deleteQuery = queries.find(({ sql }) =>
      sql.includes("DELETE FROM llm_for_zotero_paper_conversations"),
    );
    assert.isOk(deleteQuery);
    assert.deepEqual(deleteQuery?.params, [42]);
  });

  it("repairs missing runtime registry rows when ensuring an existing Codex catalog row", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 44;
    const conversationID = buildConversationID({
      conversationKey,
      system: "codex",
      kind: "global",
      libraryID: 1,
      profileSignature: "profile-default",
    });
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_codex_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                libraryID: 1,
                kind: "global",
                paperItemID: null,
                createdAt: 100,
                updatedAt: 200,
                title: "Existing Codex chat",
                providerSessionId: null,
                scopedConversationKey: null,
                scopeType: null,
                scopeId: null,
                scopeLabel: null,
                cwd: null,
                modelName: null,
                effort: null,
                userTurnCount: 0,
              },
            ];
          }
          return [];
        },
      },
    };

    const entry = await conversationRepository.ensureCatalogEntry({
      system: "codex",
      kind: "global",
      conversationKey,
      libraryID: 1,
    });

    assert.equal(entry?.conversationKey, conversationKey);
    assert.isTrue(
      queries.some(
        ({ sql, params }) =>
          sql.includes("INSERT INTO llm_for_zotero_conversation_registry") &&
          params?.[0] === conversationID &&
          params?.[1] === conversationKey,
      ),
    );
  });

  it("does not clear unrelated invalid runtime registry rows while ensuring Codex catalog rows", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 45;
    const conversationID = buildConversationID({
      conversationKey,
      system: "codex",
      kind: "global",
      libraryID: 1,
      profileSignature: "profile-default",
    });
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_codex_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                libraryID: 1,
                kind: "global",
                paperItemID: null,
                createdAt: 100,
                updatedAt: 200,
                title: "Invalid Codex chat",
                providerSessionId: null,
                scopedConversationKey: null,
                scopeType: null,
                scopeId: null,
                scopeLabel: null,
                cwd: null,
                modelName: null,
                effort: null,
                userTurnCount: 1,
              },
            ];
          }
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                system: "codex",
                kind: "global",
                profileSignature: "profile-default",
                libraryID: 1,
                paperItemID: null,
                valid: 0,
                invalidReason: "manual invalidation",
              },
            ];
          }
          return [];
        },
      },
    };

    const entry = await conversationRepository.ensureCatalogEntry({
      system: "codex",
      kind: "global",
      conversationKey,
      libraryID: 1,
    });

    assert.equal(entry?.conversationKey, conversationKey);
    assert.isFalse(
      queries.some(
        ({ sql }) =>
          sql.includes("llm_for_zotero_conversation_registry") &&
          sql.includes("invalid_reason = NULL"),
      ),
    );
  });

  it("migrates legacy ambiguous invalid registry rows while ensuring Codex paper catalog rows", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const paperItemID = 3196;
    const conversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + paperItemID;
    const conversationID = buildConversationID({
      conversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID,
      profileSignature: "profile-default",
    });
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_codex_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                libraryID: 1,
                kind: "paper",
                paperItemID,
                createdAt: 100,
                updatedAt: 200,
                title: "Legacy multi-paper chat",
                providerSessionId: null,
                scopedConversationKey: null,
                scopeType: null,
                scopeId: null,
                scopeLabel: null,
                cwd: null,
                modelName: null,
                effort: null,
                userTurnCount: 1,
              },
            ];
          }
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                system: "codex",
                kind: "paper",
                profileSignature: "profile-default",
                libraryID: 1,
                paperItemID,
                valid: 0,
                invalidReason: "ambiguous paper context evidence",
              },
            ];
          }
          return [];
        },
      },
    };

    const entry = await conversationRepository.ensureCatalogEntry({
      system: "codex",
      kind: "paper",
      conversationKey,
      libraryID: 1,
      paperItemID,
    });

    assert.equal(entry?.conversationKey, conversationKey);
    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("llm_for_zotero_conversation_registry") &&
          sql.includes("valid = 1") &&
          sql.includes("invalid_reason = NULL"),
      ),
    );
  });

  it("routes message loading and turn deletion by conversation system", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        executeTransaction: async (fn: () => Promise<void>) => fn(),
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    };

    await conversationRepository.loadMessages({
      system: "codex",
      conversationKey,
      limit: 5,
    });
    await conversationRepository.deleteTurnMessages({
      system: "codex",
      conversationKey,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    const loadQuery = queries.find(
      ({ sql }) =>
        sql.includes("FROM llm_for_zotero_codex_messages") &&
        sql.includes("LIMIT ?"),
    );
    assert.isOk(loadQuery);
    assert.deepEqual(loadQuery?.params?.slice(-1), [5]);

    const deleteQueries = queries.filter(({ sql }) =>
      sql.includes("DELETE FROM llm_for_zotero_codex_messages"),
    );
    assert.lengthOf(deleteQueries, 2);
    assert.deepEqual(deleteQueries[0]?.params?.slice(-1), [100]);
    assert.deepEqual(deleteQueries[1]?.params?.slice(-1), [200]);
  });

  it("touches upstream empty draft activity through the repository", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = 2_000_000_021;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    };

    await conversationRepository.touchEmptyCatalogActivity({
      system: "upstream",
      kind: "global",
      conversationKey,
      timestamp: 1234,
    });

    const update = queries.find(
      ({ sql }) =>
        sql.includes("UPDATE llm_for_zotero_global_conversations") &&
        sql.includes("SET created_at = ?"),
    );
    assert.isOk(update);
    assert.deepEqual(update?.params?.slice(0, 3), [
      1234,
      1234,
      conversationKey,
    ]);
  });

  it("refuses to ensure an upstream global key owned by another library", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const conversationKey = 2_000_000_003;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_global_conversations gc") &&
            sql.includes("WHERE gc.conversation_key = ?")
          ) {
            return [
              {
                conversationID: buildConversationID({
                  conversationKey,
                  system: "upstream",
                  kind: "global",
                  libraryID: 3,
                }),
                conversationKey,
                libraryID: 3,
                createdAt: 100,
                title: "Other library",
                lastActivityAt: 200,
                userTurnCount: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const entry = await conversationRepository.ensureCatalogEntry({
      system: "upstream",
      kind: "global",
      libraryID: 1,
      conversationKey,
    });

    assert.equal(entry, null);
    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("INSERT OR IGNORE INTO llm_for_zotero_global_conversations"),
      ),
    );
    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("llm_for_zotero_conversation_registry"),
      ),
    );
  });
});
