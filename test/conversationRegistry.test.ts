import { assert } from "chai";
import {
  buildConversationID,
  getConversationScopeValidationDetails,
  getPaperContextOwnershipEvidenceFromRows,
  inferSinglePaperItemIdFromContextRows,
  registerConversationScope,
  validateConversationScope,
} from "../src/shared/conversationRegistry";
import { repairRecoverableMessageConversationIDs } from "../src/shared/conversationMessageIdentityRepair";

describe("conversation registry", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("rejects scope and profile mismatches for a registered key", async function () {
    globalScope.Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-registry-test",
      },
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationKey: 123,
                system: "codex",
                kind: "paper",
                profileSignature: "profile-dev",
                libraryID: 1,
                paperItemID: 3196,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
      }),
      true,
    );
    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3340,
      }),
      false,
    );
    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-other",
        libraryID: 1,
        paperItemID: 3196,
      }),
      false,
    );
  });

  it("treats unregistered runtime keys as unsafe once the registry DB exists", async function () {
    globalScope.Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-registry-test",
      },
      DB: {
        queryAsync: async () => [],
      },
    };

    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
      }),
      false,
    );
    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "upstream",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
      }),
      true,
    );
  });

  it("allows implicit validation for same-scope legacy conversation ids", async function () {
    const conversationKey = 2_000_000_003;
    const legacyConversationID =
      "llm-chat:v1:profile-dev:upstream:2000000000";
    const canonicalConversationID = buildConversationID({
      conversationKey,
      system: "upstream",
      kind: "global",
      profileSignature: "profile-dev",
      libraryID: 1,
    });
    globalScope.Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-registry-test",
      },
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID: legacyConversationID,
                conversationKey,
                system: "upstream",
                kind: "global",
                profileSignature: "profile-dev",
                libraryID: 1,
                paperItemID: null,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const implicit = await getConversationScopeValidationDetails({
      conversationKey,
      system: "upstream",
      kind: "global",
      profileSignature: "profile-dev",
      libraryID: 1,
    });
    assert.isTrue(implicit.valid);

    const explicit = await getConversationScopeValidationDetails({
      conversationID: canonicalConversationID,
      conversationKey,
      system: "upstream",
      kind: "global",
      profileSignature: "profile-dev",
      libraryID: 1,
    });
    assert.isFalse(explicit.valid);
    assert.equal(explicit.reason, "conversation_id_mismatch");
  });

  it("does not clear invalid registry state during ordinary registration", async function () {
    const row = {
      conversationKey: 123,
      system: "codex",
      kind: "paper",
      profileSignature: "profile-dev",
      libraryID: 1,
      paperItemID: 3196,
      valid: 0,
      invalidReason: "ambiguous paper context evidence",
      title: "Ambiguous chat",
      updatedAt: 100,
    };
    globalScope.Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-registry-test",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [row];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_conversation_registry")) {
            if (sql.includes("valid = 1")) row.valid = 1;
            if (sql.includes("invalid_reason = NULL")) {
              row.invalidReason = "";
            }
            row.updatedAt = Number(params?.[8] || row.updatedAt);
          }
          return [];
        },
      },
    };

    const scope = {
      conversationKey: 123,
      system: "codex" as const,
      kind: "paper" as const,
      profileSignature: "profile-dev",
      libraryID: 1,
      paperItemID: 3196,
    };
    assert.equal(await validateConversationScope(scope), false);
    assert.equal(
      await registerConversationScope({
        ...scope,
        updatedAt: 200,
        title: "Same ambiguous chat",
      }),
      true,
    );
    assert.equal(row.valid, 0);
    assert.equal(row.invalidReason, "ambiguous paper context evidence");
    assert.equal(await validateConversationScope(scope), false);
  });

  it("refuses to reuse one legacy key for a different canonical chat", async function () {
    const rows = new Map<number, Record<string, unknown>>();
    globalScope.Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-registry-test",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const queryParams = Array.isArray(params) ? params : [];
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            const row = rows.get(Number(queryParams[0]));
            return row ? [row] : [];
          }
          if (sql.includes("INSERT INTO llm_for_zotero_conversation_registry")) {
            const [
              conversationID,
              legacyConversationKey,
              system,
              kind,
              profileSignature,
              libraryID,
              paperItemID,
            ] = queryParams;
            rows.set(Number(legacyConversationKey), {
              conversationID,
              conversationKey: legacyConversationKey,
              system,
              kind,
              profileSignature,
              libraryID,
              paperItemID,
              valid: 1,
            });
          }
          return [];
        },
      },
    };

    const conversationKey = 2_000_000_001;
    assert.equal(
      await registerConversationScope({
        conversationKey,
        system: "upstream",
        kind: "global",
        profileSignature: "profile-dev",
        libraryID: 1,
      }),
      true,
    );
    assert.equal(
      rows.get(conversationKey)?.conversationID,
      buildConversationID({
        conversationKey,
        system: "upstream",
        kind: "global",
        profileSignature: "profile-dev",
        libraryID: 1,
      }),
    );
    assert.equal(
      await registerConversationScope({
        conversationKey,
        system: "upstream",
        kind: "global",
        profileSignature: "profile-dev",
        libraryID: 2,
      }),
      false,
    );
  });

  it("allows validation in test contexts where Zotero DB is unavailable", async function () {
    globalScope.Zotero = {};

    assert.equal(
      await validateConversationScope({
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
      }),
      true,
    );
  });

  it("reports multi-paper message context as referenced-paper evidence", function () {
    assert.deepEqual(
      getPaperContextOwnershipEvidenceFromRows([
        {
          paperContextsJson: JSON.stringify([{ itemId: 3196 }]),
          citationPaperContextsJson: JSON.stringify([{ itemId: 3340 }]),
        },
      ]),
      {
        paperItemIDs: [3196, 3340],
        singlePaperItemID: null,
      },
    );
    assert.equal(
      inferSinglePaperItemIdFromContextRows([
        {
          paperContextsJson: JSON.stringify([
            { itemId: 3196, contextItemId: 3197, title: "Paper" },
          ]),
          fullTextPaperContextsJson: JSON.stringify([
            { itemID: 3196, contextItemId: 3198, title: "Paper" },
          ]),
        },
      ]),
      3196,
    );
  });

  it("repairs stale message ids when referenced papers include the primary paper", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const result = await repairRecoverableMessageConversationIDs({
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT DISTINCT conversation_id AS conversationID")) {
          return [
            { conversationID: "canonical-id" },
            { conversationID: "legacy-stale-id" },
          ];
        }
        return [];
      },
      tableName: "llm_for_zotero_test_messages",
      registered: {
        conversationID: "canonical-id",
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
        valid: true,
      },
      getPaperContextRows: async () => [
        {
          paperContextsJson: JSON.stringify([
            { itemId: 3196 },
            { itemId: 3340 },
          ]),
        },
      ],
      storeLabel: "test",
    });

    assert.equal(result.status, "repaired");
    assert.isTrue(
      queries.some((query) =>
        query.sql.includes("UPDATE llm_for_zotero_test_messages"),
      ),
    );
  });

  it("refuses stale message id repair when message context points to a different primary paper", async function () {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const result = await repairRecoverableMessageConversationIDs({
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT DISTINCT conversation_id AS conversationID")) {
          return [
            { conversationID: "canonical-id" },
            { conversationID: "legacy-stale-id" },
          ];
        }
        return [];
      },
      tableName: "llm_for_zotero_test_messages",
      registered: {
        conversationID: "canonical-id",
        conversationKey: 123,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-dev",
        libraryID: 1,
        paperItemID: 3196,
        valid: true,
      },
      getPaperContextRows: async () => [
        {
          paperContextsJson: JSON.stringify([{ itemId: 3340 }]),
        },
      ],
      storeLabel: "test",
    });

    assert.equal(result.status, "refused");
    assert.match(result.reason || "", /paper 3340, not 3196/);
    assert.isFalse(
      queries.some((query) =>
        query.sql.includes("UPDATE llm_for_zotero_test_messages"),
      ),
    );
  });
});
