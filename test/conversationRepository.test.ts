import { assert } from "chai";
import { conversationRepository } from "../src/core/conversations/repository";
import { codexAppServerForkService } from "../src/codexAppServer/forkService";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { buildConversationID } from "../src/shared/conversationRegistry";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

describe("conversationRepository", function () {
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

  it("does not fork Claude Code conversations", async function () {
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

    const result = await conversationRepository.forkConversation({
      system: "claude_code",
      kind: "global",
      libraryID: 1,
      sourceConversationKey: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 21,
      throughAssistantTimestamp: 200,
    });

    assert.isNull(result);
    assert.lengthOf(queries, 0);
  });

  it("does not fork a Codex conversation without a native provider session", async function () {
    const sourceConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_codex_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
          ) {
            return [
              {
                conversationID: buildConversationID({
                  conversationKey: sourceConversationKey,
                  system: "codex",
                  kind: "global",
                  libraryID: 7,
                }),
                conversationKey: sourceConversationKey,
                libraryID: 7,
                kind: "global",
                paperItemID: 0,
                createdAt: 100,
                updatedAt: 200,
                title: "Codex source",
                providerSessionId: null,
                userTurnCount: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const result = await conversationRepository.forkConversation({
      system: "codex",
      kind: "global",
      libraryID: 7,
      sourceConversationKey,
      throughAssistantTimestamp: 200,
    });

    assert.isNull(result);
    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("INSERT INTO llm_for_zotero_codex_conversations"),
      ),
    );
  });

  it("rejects older Codex fork requests before native thread fork", async function () {
    const sourceConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    const originalForkThread = codexAppServerForkService.forkThread;
    const forkCalls: string[] = [];
    codexAppServerForkService.forkThread = async (params) => {
      forkCalls.push(params.threadId);
      return "thread-forked";
    };
    try {
      globalScope.Zotero = {
        ...(originalZotero || {}),
        DB: {
          queryAsync: async (sql: string, params?: unknown[]) => {
            if (sql.includes("SELECT 1 AS present")) return [{ present: 1 }];
            if (
              sql.includes("FROM llm_for_zotero_codex_conversations c") &&
              sql.includes("WHERE c.conversation_key = ?")
            ) {
              return [
                {
                  conversationID: buildConversationID({
                    conversationKey: sourceConversationKey,
                    system: "codex",
                    kind: "global",
                    libraryID: 7,
                  }),
                  conversationKey: sourceConversationKey,
                  libraryID: 7,
                  kind: "global",
                  paperItemID: 0,
                  createdAt: 100,
                  updatedAt: 400,
                  title: "Codex source",
                  providerSessionId: "thread-source",
                  userTurnCount: 2,
                },
              ];
            }
            if (
              sql.includes("FROM llm_for_zotero_codex_messages") &&
              sql.includes("role = 'assistant'") &&
              sql.includes("ORDER BY")
            ) {
              return [{ timestamp: 400 }];
            }
            return [];
          },
        },
      };

      const result = await conversationRepository.forkConversation({
        system: "codex",
        kind: "global",
        libraryID: 7,
        sourceConversationKey,
        throughAssistantTimestamp: 200,
      });

      assert.isNull(result);
      assert.deepEqual(forkCalls, []);
    } finally {
      codexAppServerForkService.forkThread = originalForkThread;
    }
  });

  it("forks a latest Codex conversation through native thread fork and local message copy", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: { dir: "/tmp/zotero-profile" },
    };
    const sourceConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    const targetConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 99;
    const sourceConversationID = buildConversationID({
      conversationKey: sourceConversationKey,
      system: "codex",
      kind: "global",
      libraryID: 7,
    });
    const targetConversationID = buildConversationID({
      conversationKey: targetConversationKey,
      system: "codex",
      kind: "global",
      libraryID: 7,
    });
    const originalForkThread = codexAppServerForkService.forkThread;
    const originalArchiveThread = codexAppServerForkService.archiveThread;
    const originalCreateCatalogEntry =
      conversationRepository.createCatalogEntry;
    const originalGetCatalogEntry = conversationRepository.getCatalogEntry;
    const originalSetCatalogTitle = conversationRepository.setCatalogTitle;
    const forkCalls: string[] = [];
    const forkTargetConversationKeys: (number | undefined)[] = [];
    const archiveCalls: string[] = [];
    const insertedMessages: unknown[][] = [];
    const registryRows = new Map<number, Record<string, unknown>>();
    registryRows.set(sourceConversationKey, {
      conversationID: sourceConversationID,
      conversationKey: sourceConversationKey,
      system: "codex",
      kind: "global",
      profileSignature: "",
      libraryID: 7,
      paperItemID: null,
      instanceID: "instance-codex-source",
      valid: 1,
    });
    const sourceLedgerEntry = {
      conversationKey: sourceConversationKey,
      instanceID: "instance-codex-source",
      conversationID: sourceConversationID,
      profileSignature: "profile-65092053",
      system: "codex",
      kind: "global",
      libraryID: 7,
      issuedAt: 100,
      retiredAt: null,
    };
    let persistedProviderSessionId = "";
    let targetTitle = "";

    codexAppServerForkService.forkThread = async (params) => {
      forkCalls.push(params.threadId);
      forkTargetConversationKeys.push(params.targetConversationKey);
      return "thread-forked";
    };
    codexAppServerForkService.archiveThread = async (params) => {
      archiveCalls.push(params.threadId);
    };
    conversationRepository.createCatalogEntry = async (params) => ({
      instanceID: "instance-codex-target",
      conversationID: targetConversationID,
      conversationKey: targetConversationKey,
      system: params.system,
      kind: params.kind,
      libraryID: params.libraryID,
      paperItemID: params.paperItemID,
      createdAt: 100,
      lastActivityAt: 100,
      userTurnCount: 0,
    });
    conversationRepository.getCatalogEntry = async (target) => {
      if (target.conversationKey === sourceConversationKey) {
        return {
          conversationID: sourceConversationID,
          instanceID: "instance-codex-source",
          conversationKey: sourceConversationKey,
          system: "codex",
          kind: "global",
          libraryID: 7,
          createdAt: 100,
          lastActivityAt: 200,
          title: "Codex source",
          userTurnCount: 1,
          providerSessionId: "thread-source",
        };
      }
      if (target.conversationKey === targetConversationKey) {
        return {
          conversationID: targetConversationID,
          instanceID: "instance-codex-target",
          conversationKey: targetConversationKey,
          system: "codex",
          kind: "global",
          libraryID: 7,
          createdAt: 100,
          lastActivityAt: 200,
          title: targetTitle,
          userTurnCount: 1,
          providerSessionId: "thread-forked",
        };
      }
      return null;
    };
    conversationRepository.setCatalogTitle = async (target) => {
      targetTitle = target.title;
    };

    try {
      globalScope.Zotero = {
        ...(originalZotero || {}),
        Profile: { dir: "/tmp/zotero-profile" },
        DB: {
          executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
          queryAsync: async (sql: string, params?: unknown[]) => {
            if (
              sql.includes("FROM llm_for_zotero_codex_conversations c") &&
              sql.includes("SELECT c.conversation_id AS conversationID")
            ) {
              const key = Number(params?.[0] || 0);
              if (
                key === sourceConversationKey ||
                key === targetConversationKey
              ) {
                return [
                  {
                    conversationID:
                      key === sourceConversationKey
                        ? sourceConversationID
                        : targetConversationID,
                    instanceID:
                      key === sourceConversationKey
                        ? "instance-codex-source"
                        : "instance-codex-target",
                    conversationKey: key,
                    libraryID: 7,
                    kind: "global",
                    paperItemID: null,
                    createdAt: 100,
                    updatedAt: 200,
                    title:
                      key === sourceConversationKey
                        ? "Codex source"
                        : targetTitle,
                    providerSessionId:
                      key === sourceConversationKey
                        ? "thread-source"
                        : "thread-forked",
                    userTurnCount: 1,
                  },
                ];
              }
            }
            if (sql.includes("SELECT 1 AS present")) return [{ present: 1 }];
            if (
              sql.includes("SELECT conversation_id AS conversationID") &&
              sql.includes("FROM llm_for_zotero_codex_conversations")
            ) {
              const key = Number(params?.[0] || 0);
              if (
                key === sourceConversationKey ||
                key === targetConversationKey
              ) {
                return [
                  {
                    conversationID:
                      key === sourceConversationKey
                        ? sourceConversationID
                        : targetConversationID,
                  },
                ];
              }
              return [];
            }
            if (
              sql.includes("FROM llm_for_zotero_conversation_key_ledger") &&
              sql.includes("WHERE conversation_key = ?")
            ) {
              const key = Number(params?.[0] || 0);
              if (
                key === sourceConversationKey ||
                key === targetConversationKey
              ) {
                return [
                  {
                    conversationKey: key,
                    instanceID:
                      key === sourceConversationKey
                        ? "instance-codex-source"
                        : "instance-codex-target",
                    conversationID:
                      key === sourceConversationKey
                        ? sourceConversationID
                        : targetConversationID,
                    profileSignature: "profile-65092053",
                    system: "codex",
                    kind: "global",
                    libraryID: 7,
                    issuedAt: 100,
                    retiredAt: null,
                  },
                ];
              }
              return [];
            }
            if (
              sql.includes("FROM llm_for_zotero_conversation_registry") &&
              sql.includes("WHERE legacy_conversation_key = ?")
            ) {
              const key = Number(params?.[0] || 0);
              const row = registryRows.get(key);
              return row ? [row] : [];
            }
            if (
              sql.includes("INSERT INTO llm_for_zotero_conversation_registry")
            ) {
              const key = Number(params?.[1] || 0);
              registryRows.set(key, {
                conversationID: params?.[0],
                conversationKey: key,
                system: params?.[2],
                kind: params?.[3],
                profileSignature: params?.[4],
                libraryID: params?.[5],
                paperItemID: params?.[6],
                instanceID: params?.[10],
                valid: 1,
              });
              return [];
            }
            if (
              sql.includes("INSERT INTO llm_for_zotero_codex_conversations")
            ) {
              persistedProviderSessionId = String(
                (params || []).find((value) => value === "thread-forked") || "",
              );
              return [];
            }
            if (
              sql.includes("FROM llm_for_zotero_codex_messages") &&
              sql.includes("SELECT timestamp") &&
              sql.includes("role = 'assistant'")
            ) {
              return [{ timestamp: 200 }];
            }
            if (
              sql.includes("SELECT id, timestamp") &&
              sql.includes("FROM llm_for_zotero_codex_messages")
            ) {
              return [{ id: 4, timestamp: 200 }];
            }
            if (
              sql.includes("SELECT role, text, timestamp") &&
              sql.includes("FROM llm_for_zotero_codex_messages")
            ) {
              return [
                {
                  role: "user",
                  text: "Prompt",
                  timestamp: 100,
                  collection_contexts_json: JSON.stringify([
                    { collectionId: 55, libraryID: 7, name: "Methods" },
                  ]),
                  tag_contexts_json: JSON.stringify([
                    {
                      libraryID: 7,
                      name: "Stability",
                      normalizedName: "stability",
                      includeAutomatic: false,
                    },
                  ]),
                },
                {
                  role: "assistant",
                  text: "Answer",
                  timestamp: 200,
                  run_mode: "agent",
                  agent_run_id: "run-source",
                },
              ];
            }
            if (sql.includes("INSERT INTO llm_for_zotero_codex_messages")) {
              insertedMessages.push([...(params || [])]);
              return [];
            }
            return [];
          },
        },
      };

      const result = await conversationRepository.forkConversation({
        system: "codex",
        kind: "global",
        libraryID: 7,
        sourceConversationKey,
        throughAssistantTimestamp: 200,
      });
      assert.equal(result?.entry.conversationKey, targetConversationKey);
      assert.equal(result?.copiedMessageCount, 2);
      assert.deepEqual(forkCalls, ["thread-source"]);
      assert.deepEqual(forkTargetConversationKeys, [targetConversationKey]);
      assert.deepEqual(archiveCalls, []);
      assert.equal(persistedProviderSessionId, "thread-forked");
      assert.lengthOf(insertedMessages, 2);
      assert.include(
        insertedMessages[0],
        JSON.stringify([{ collectionId: 55, libraryID: 7, name: "Methods" }]),
      );
      assert.include(
        insertedMessages[0],
        JSON.stringify([
          {
            libraryID: 7,
            name: "Stability",
            normalizedName: "stability",
            includeAutomatic: false,
          },
        ]),
      );
      assert.deepEqual(
        insertedMessages.map((params) => params.slice(1, 7)),
        [
          [
            targetConversationKey,
            "user",
            "Prompt",
            insertedMessages[0]?.[4],
            undefined,
            undefined,
          ],
          [
            targetConversationKey,
            "assistant",
            "Answer",
            insertedMessages[1]?.[4],
            "agent",
            "run-source",
          ],
        ],
      );
      assert.equal(
        result?.forkLink.sourceConversationKey,
        sourceConversationKey,
      );
      assert.equal(
        result?.forkLink.targetConversationKey,
        targetConversationKey,
      );
    } finally {
      codexAppServerForkService.forkThread = originalForkThread;
      codexAppServerForkService.archiveThread = originalArchiveThread;
      conversationRepository.createCatalogEntry = originalCreateCatalogEntry;
      conversationRepository.getCatalogEntry = originalGetCatalogEntry;
      conversationRepository.setCatalogTitle = originalSetCatalogTitle;
    }
  });

  it("archives a native Codex fork when local message copy fails", async function () {
    const sourceConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 21;
    const targetConversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 99;
    const sourceConversationID = buildConversationID({
      conversationKey: sourceConversationKey,
      system: "codex",
      kind: "global",
      libraryID: 7,
    });
    const targetConversationID = buildConversationID({
      conversationKey: targetConversationKey,
      system: "codex",
      kind: "global",
      libraryID: 7,
    });
    const originalForkThread = codexAppServerForkService.forkThread;
    const originalArchiveThread = codexAppServerForkService.archiveThread;
    const originalCreateCatalogEntry =
      conversationRepository.createCatalogEntry;
    const originalDeleteCatalogEntry =
      conversationRepository.deleteCatalogEntry;
    const originalGetCatalogEntry = conversationRepository.getCatalogEntry;
    const forkCalls: string[] = [];
    const archiveCalls: string[] = [];
    const deletedEntries: Array<{
      system: string;
      kind: string;
      conversationKey: number;
    }> = [];
    const registryRows = new Map<number, Record<string, unknown>>();

    codexAppServerForkService.forkThread = async (params) => {
      forkCalls.push(params.threadId);
      return "thread-forked";
    };
    codexAppServerForkService.archiveThread = async (params) => {
      archiveCalls.push(params.threadId);
    };
    conversationRepository.createCatalogEntry = async (params) => ({
      conversationID: targetConversationID,
      conversationKey: targetConversationKey,
      system: params.system,
      kind: params.kind,
      libraryID: params.libraryID,
      paperItemID: params.paperItemID,
      createdAt: 100,
      lastActivityAt: 100,
      userTurnCount: 0,
    });
    conversationRepository.deleteCatalogEntry = async (target) => {
      deletedEntries.push({
        system: target.system,
        kind: target.kind,
        conversationKey: target.conversationKey,
      });
      return true;
    };
    conversationRepository.getCatalogEntry = async (target) => {
      if (target.conversationKey === sourceConversationKey) {
        return {
          conversationID: sourceConversationID,
          conversationKey: sourceConversationKey,
          system: "codex",
          kind: "global",
          libraryID: 7,
          createdAt: 100,
          lastActivityAt: 200,
          title: "Codex source",
          userTurnCount: 1,
          providerSessionId: "thread-source",
        };
      }
      return null;
    };

    try {
      globalScope.Zotero = {
        ...(originalZotero || {}),
        Profile: { dir: "/tmp/zotero-profile" },
        DB: {
          executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
          queryAsync: async (sql: string, params?: unknown[]) => {
            if (
              sql.includes("FROM llm_for_zotero_conversation_registry") &&
              sql.includes("WHERE legacy_conversation_key = ?")
            ) {
              const key = Number(params?.[0] || 0);
              const row = registryRows.get(key);
              return row ? [row] : [];
            }
            if (
              sql.includes("INSERT INTO llm_for_zotero_conversation_registry")
            ) {
              const key = Number(params?.[1] || 0);
              registryRows.set(key, {
                conversationID: params?.[0],
                conversationKey: key,
                system: params?.[2],
                kind: params?.[3],
                profileSignature: params?.[4],
                libraryID: params?.[5],
                paperItemID: params?.[6],
                instanceID: params?.[10],
                valid: 1,
              });
              return [];
            }
            if (
              sql.includes("FROM llm_for_zotero_codex_messages") &&
              sql.includes("SELECT timestamp") &&
              sql.includes("role = 'assistant'")
            ) {
              return [{ timestamp: 200 }];
            }
            if (
              sql.includes("INSERT INTO llm_for_zotero_codex_conversations")
            ) {
              return [];
            }
            if (
              sql.includes("SELECT id, timestamp") &&
              sql.includes("FROM llm_for_zotero_codex_messages")
            ) {
              throw new Error("copy failed");
            }
            return [];
          },
        },
      };

      let caught: unknown;
      try {
        await conversationRepository.forkConversation({
          system: "codex",
          kind: "global",
          libraryID: 7,
          sourceConversationKey,
          throughAssistantTimestamp: 200,
        });
      } catch (err) {
        caught = err;
      }

      assert.instanceOf(caught, Error);
      assert.equal((caught as Error).message, "copy failed");
      assert.deepEqual(forkCalls, ["thread-source"]);
      assert.deepEqual(archiveCalls, ["thread-forked"]);
      assert.deepEqual(deletedEntries, [
        {
          system: "codex",
          kind: "global",
          conversationKey: targetConversationKey,
        },
      ]);
    } finally {
      codexAppServerForkService.forkThread = originalForkThread;
      codexAppServerForkService.archiveThread = originalArchiveThread;
      conversationRepository.createCatalogEntry = originalCreateCatalogEntry;
      conversationRepository.deleteCatalogEntry = originalDeleteCatalogEntry;
      conversationRepository.getCatalogEntry = originalGetCatalogEntry;
    }
  });

  it("forks an upstream global conversation through the selected assistant turn", async function () {
    const sourceConversationKey = 2_000_000_021;
    let targetConversationKey = 0;
    let targetTitle = "";
    const insertedMessages: unknown[][] = [];
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const registryRows = new Map<number, Record<string, unknown>>();
    const ledgerRows = new Map<number, Record<string, unknown>>();
    const registryRowForGlobalConversation = (conversationKey: number) => ({
      conversationID: buildConversationID({
        conversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
      conversationKey,
      instanceID: `instance-upstream-${conversationKey}`,
      system: "upstream",
      kind: "global",
      profileSignature: "",
      libraryID: 7,
      paperItemID: 0,
      valid: 1,
    });
    const rowForGlobalConversation = (
      conversationKey: number,
      title: string,
    ) => ({
      conversationID: buildConversationID({
        conversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
      conversationKey,
      instanceID: `instance-upstream-${conversationKey}`,
      libraryID: 7,
      createdAt: 100,
      title,
      lastActivityAt: 300,
      userTurnCount: 2,
    });
    ledgerRows.set(sourceConversationKey, {
      conversationKey: sourceConversationKey,
      instanceID: `instance-upstream-${sourceConversationKey}`,
      conversationID: buildConversationID({
        conversationKey: sourceConversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
      profileSignature: "profile-default",
      system: "upstream",
      kind: "global",
      libraryID: 7,
      issuedAt: 100,
      retiredAt: null,
    });
    registryRows.set(
      sourceConversationKey,
      registryRowForGlobalConversation(sourceConversationKey),
    );

    globalScope.Zotero = {
      ...(originalZotero || {}),
      Libraries: {
        userLibraryID: 7,
      },
      DB: {
        executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("SELECT 1 AS present") &&
            (sql.includes("llm_for_zotero_global_conversations") ||
              sql.includes("llm_for_zotero_paper_conversations"))
          ) {
            return [{ present: 1 }];
          }
          if (
            sql.includes("SELECT conversation_id AS conversationID") &&
            sql.includes("FROM llm_for_zotero_global_conversations")
          ) {
            const key = Number(params?.[0] || 0);
            const row =
              key === sourceConversationKey
                ? rowForGlobalConversation(key, "Source title")
                : key === targetConversationKey
                  ? rowForGlobalConversation(key, targetTitle)
                  : null;
            return row ? [{ conversationID: row.conversationID }] : [];
          }
          queries.push({ sql, params });
          if (
            sql.includes("FROM llm_for_zotero_conversation_key_ledger") &&
            sql.includes("WHERE conversation_key = ?")
          ) {
            const row = ledgerRows.get(Number(params?.[0] || 0));
            return row ? [row] : [];
          }
          if (
            sql.includes("INSERT INTO llm_for_zotero_conversation_key_ledger")
          ) {
            const key = Number(params?.[0] || 0);
            ledgerRows.set(key, {
              conversationKey: key,
              instanceID: params?.[1],
              conversationID: params?.[2],
              system: params?.[3],
              kind: params?.[4],
              profileSignature: params?.[5],
              libraryID: params?.[6],
              paperItemID: params?.[7],
              issuedAt: params?.[8],
              retiredAt: params?.[9],
            });
            return [];
          }
          if (
            sql.includes("UPDATE llm_for_zotero_conversation_key_ledger") &&
            sql.includes("conversation_id")
          ) {
            const key = Number(params?.[1] || 0);
            const row = ledgerRows.get(key);
            if (row) {
              row.conversationID = params?.[0];
              ledgerRows.set(key, row);
            }
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            const key = Number(params?.[0] || 0);
            const registryRow = registryRows.get(key);
            return registryRow ? [registryRow] : [];
          }
          if (
            sql.includes("INSERT INTO llm_for_zotero_conversation_registry")
          ) {
            const key = Number(params?.[1] || 0);
            if (key) {
              registryRows.set(key, {
                ...registryRowForGlobalConversation(key),
                conversationID: params?.[0],
                profileSignature: params?.[4],
                libraryID: params?.[5],
                paperItemID: params?.[6],
                instanceID: params?.[10],
              });
            }
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_global_conversations gc") &&
            sql.includes("WHERE gc.conversation_key = ?")
          ) {
            const key = Number(params?.[0] || 0);
            if (key === sourceConversationKey) {
              return [rowForGlobalConversation(key, "Source title")];
            }
            if (key === targetConversationKey) {
              return [
                rowForGlobalConversation(
                  key,
                  targetTitle || "Fork: Source title",
                ),
              ];
            }
            return [];
          }
          if (
            sql.includes("SELECT conversation_key AS conversationKey") &&
            sql.includes("FROM llm_for_zotero_global_conversations") &&
            sql.includes("WHERE conversation_key = ?")
          ) {
            return [];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_global_conversations")) {
            targetConversationKey = Number(params?.[2] || 0);
            return [];
          }
          if (
            sql.includes("UPDATE llm_for_zotero_global_conversations") &&
            sql.includes("SET title = ?")
          ) {
            targetTitle = String(params?.[0] || "");
            return [];
          }
          if (
            sql.includes("SELECT id, timestamp") &&
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("role = 'assistant'")
          ) {
            return [{ id: 4, timestamp: 200 }];
          }
          if (
            sql.includes("SELECT role, text, timestamp") &&
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("ORDER BY timestamp ASC")
          ) {
            return [
              {
                role: "user",
                text: "First",
                timestamp: 100,
                collection_contexts_json: JSON.stringify([
                  { collectionId: 55, libraryID: 7, name: "Methods" },
                ]),
                tag_contexts_json: JSON.stringify([
                  {
                    libraryID: 7,
                    name: "Stability",
                    normalizedName: "stability",
                    includeAutomatic: false,
                  },
                ]),
              },
              { role: "assistant", text: "Answer", timestamp: 200 },
            ];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_chat_messages")) {
            insertedMessages.push([...(params || [])]);
            return [];
          }
          return [];
        },
      },
    };

    const result = await conversationRepository.forkConversation({
      system: "upstream",
      kind: "global",
      libraryID: 7,
      sourceConversationKey,
      throughAssistantTimestamp: 200,
    });

    assert.equal(result?.entry.conversationKey, targetConversationKey);
    assert.equal(result?.copiedMessageCount, 2);
    assert.equal(
      result?.targetAnchorAssistantTimestamp,
      insertedMessages[1]?.[4],
    );
    assert.deepInclude(result?.forkLink, {
      targetConversationKey,
      targetSystem: "upstream",
      targetKind: "global",
      sourceConversationKey,
      sourceSystem: "upstream",
      sourceKind: "global",
      sourceLibraryID: 7,
      sourceAssistantTimestamp: 200,
      targetAnchorAssistantTimestamp: insertedMessages[1]?.[4],
    });
    assert.equal(targetTitle, "Fork: Source title");
    assert.lengthOf(insertedMessages, 2);
    assert.include(
      insertedMessages[0],
      JSON.stringify([{ collectionId: 55, libraryID: 7, name: "Methods" }]),
    );
    assert.include(
      insertedMessages[0],
      JSON.stringify([
        {
          libraryID: 7,
          name: "Stability",
          normalizedName: "stability",
          includeAutomatic: false,
        },
      ]),
    );
    assert.equal(
      insertedMessages[0]?.[0],
      buildConversationID({
        conversationKey: targetConversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
    );
    assert.deepEqual(
      insertedMessages.map((params) => params.slice(1, 5)),
      [
        [targetConversationKey, "user", "First", insertedMessages[0]?.[4]],
        [
          targetConversationKey,
          "assistant",
          "Answer",
          insertedMessages[1]?.[4],
        ],
      ],
    );
    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("timestamp < ?") &&
          sql.includes("CASE role WHEN 'user' THEN 0"),
      ),
    );
  });

  it("cleans up an upstream fork catalog entry when message copy throws", async function () {
    const sourceConversationKey = 2_000_000_021;
    let targetConversationKey = 0;
    let insertAttempted = false;
    let deletedConversationKey = 0;
    const registryRows = new Map<number, Record<string, unknown>>();
    const ledgerRows = new Map<number, Record<string, unknown>>();
    const registryRowForGlobalConversation = (
      conversationKey: number,
      instanceID = "",
    ) => ({
      conversationID: buildConversationID({
        conversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
      conversationKey,
      system: "upstream",
      kind: "global",
      profileSignature: "",
      libraryID: 7,
      paperItemID: 0,
      instanceID,
      valid: 1,
    });
    const rowForGlobalConversation = (conversationKey: number) => ({
      conversationID: buildConversationID({
        conversationKey,
        system: "upstream",
        kind: "global",
        libraryID: 7,
      }),
      conversationKey,
      instanceID: `instance-upstream-${conversationKey}`,
      libraryID: 7,
      createdAt: 100,
      title: "Source title",
      lastActivityAt: 300,
      userTurnCount: 2,
    });

    globalScope.Zotero = {
      ...(originalZotero || {}),
      Libraries: {
        userLibraryID: 7,
      },
      DB: {
        executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            const key = Number(params?.[0] || 0);
            const registryRow = registryRows.get(key);
            return registryRow ? [registryRow] : [];
          }
          if (
            sql.includes("INSERT INTO llm_for_zotero_conversation_registry")
          ) {
            const key = Number(params?.[1] || 0);
            if (key) {
              registryRows.set(
                key,
                registryRowForGlobalConversation(
                  key,
                  String(params?.[12] || ""),
                ),
              );
            }
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_conversation_key_ledger") &&
            sql.includes("WHERE conversation_key = ?") &&
            sql.includes("instance_id AS instanceID")
          ) {
            const key = Number(params?.[0] || 0);
            const row = ledgerRows.get(key);
            return row ? [row] : [];
          }
          if (
            sql.includes("INSERT INTO llm_for_zotero_conversation_key_ledger")
          ) {
            const key = Number(params?.[0] || 0);
            if (key) {
              ledgerRows.set(key, {
                conversationKey: key,
                instanceID: String(params?.[1] || ""),
                conversationID: String(params?.[2] || ""),
                system: params?.[3],
                kind: params?.[4],
                profileSignature: params?.[5],
                libraryID: params?.[6],
                paperItemID: params?.[7],
                issuedAt: params?.[8],
                retiredAt: params?.[9],
                retirementReason: params?.[10],
              });
            }
            return [];
          }
          if (
            sql.includes("UPDATE llm_for_zotero_conversation_key_ledger") &&
            sql.includes("SET conversation_id = ?")
          ) {
            const key = Number(params?.[1] || 0);
            const row = ledgerRows.get(key);
            if (row) row.conversationID = params?.[0];
            return [];
          }
          if (
            sql.includes("SELECT 1 AS present") &&
            sql.includes("FROM llm_for_zotero_global_conversations") &&
            sql.includes("conversation_instance_id = ?")
          ) {
            const key = Number(params?.[0] || 0);
            return key === targetConversationKey ? [{ present: 1 }] : [];
          }
          if (
            sql.includes("FROM llm_for_zotero_global_conversations gc") &&
            sql.includes("WHERE gc.conversation_key = ?")
          ) {
            const key = Number(params?.[0] || 0);
            if (
              key === sourceConversationKey ||
              key === targetConversationKey
            ) {
              return [rowForGlobalConversation(key)];
            }
            return [];
          }
          if (
            sql.includes("SELECT conversation_key AS conversationKey") &&
            sql.includes("FROM llm_for_zotero_global_conversations") &&
            sql.includes("WHERE conversation_key = ?")
          ) {
            return [];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_global_conversations")) {
            targetConversationKey = Number(params?.[2] || 0);
            return [];
          }
          if (
            sql.includes("SELECT id, timestamp") &&
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("role = 'assistant'")
          ) {
            return [{ id: 4, timestamp: 200 }];
          }
          if (
            sql.includes("SELECT role, text, timestamp") &&
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("ORDER BY timestamp ASC")
          ) {
            return [{ role: "user", text: "First", timestamp: 100 }];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_chat_messages")) {
            insertAttempted = true;
            throw new Error("insert failed");
          }
          if (sql.includes("DELETE FROM llm_for_zotero_global_conversations")) {
            deletedConversationKey = Number(params?.[0] || 0);
            return [];
          }
          return [];
        },
      },
    };

    try {
      await conversationRepository.forkConversation({
        system: "upstream",
        kind: "global",
        libraryID: 7,
        sourceConversationKey,
        throughAssistantTimestamp: 200,
      });
      assert.fail("Expected forkConversation to throw");
    } catch (err) {
      assert.match(String(err), /insert failed/);
    }

    assert.isTrue(insertAttempted);
    assert.equal(deletedConversationKey, targetConversationKey);
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
        sql.includes(
          "INSERT OR IGNORE INTO llm_for_zotero_global_conversations",
        ),
      ),
    );
    assert.isFalse(
      queries.some(({ sql }) =>
        sql.includes("llm_for_zotero_conversation_registry"),
      ),
    );
  });
});
