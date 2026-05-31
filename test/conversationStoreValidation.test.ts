import { assert } from "chai";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  appendMessage,
  deleteUpstreamConversationLocalRows,
  loadConversation,
} from "../src/utils/chatStore";
import {
  appendClaudeMessage,
  initClaudeCodeStore,
  loadClaudeConversation,
  listClaudePaperConversations,
  repairClaudeConversationIdentityRegistry,
  upsertClaudeConversationSummary,
} from "../src/claudeCode/store";
import {
  appendCodexMessage,
  deleteCodexConversationLocalRows,
  initCodexAppServerStore,
  loadCodexConversation,
  listCodexPaperConversations,
  repairCodexConversationIdentityRegistry,
  repairMisroutedCodexConversationRows,
  upsertCodexConversationSummary,
} from "../src/codexAppServer/store";
import { buildConversationID } from "../src/shared/conversationRegistry";
import type { StoredChatMessage } from "../src/utils/chatStore";

type QueryRecord = {
  sql: string;
  params: unknown[];
};

const sampleMessage: StoredChatMessage = {
  role: "user",
  text: "hello",
  timestamp: 1,
};

function installQueryRecorder(
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [],
): { queries: QueryRecord[]; restore: () => void } {
  const originalZotero = globalThis.Zotero;
  const queries: QueryRecord[] = [];
  (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: Array.isArray(params) ? params : [] });
        return queryAsync(sql, params);
      },
      executeTransaction: async (callback: () => Promise<unknown>) =>
        await callback(),
    },
    debug: () => undefined,
    Profile: {
      dir: "/tmp/llm-for-zotero-test-profile",
    },
  } as unknown as typeof Zotero;
  return {
    queries,
    restore: () => {
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    },
  };
}

function strictRow<T extends Record<string, unknown>>(row: T): T {
  return new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(`DB column '${prop}' not found`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function strictConversationSummaryRow(
  row: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return strictRow({
    conversationID: null,
    conversationKey: 0,
    libraryID: 1,
    kind: "paper",
    paperItemID: null,
    createdAt: 100,
    updatedAt: 200,
    title: null,
    providerSessionId: null,
    scopedConversationKey: null,
    scopeType: null,
    scopeId: null,
    scopeLabel: null,
    cwd: null,
    modelName: null,
    effort: null,
    userTurnCount: 0,
    ...row,
  });
}

describe("strict Zotero DB row test fixture", function () {
  it("throws when code reads a column alias that the query did not select", function () {
    const row = strictRow({ selectedAlias: 1 });

    assert.throws(
      () => (row as Record<string, unknown>).missingAlias,
      "DB column 'missingAlias' not found",
    );
  });
});

describe("conversation store key validation", function () {
  it("rejects Codex-range keys at Claude store boundaries", async function () {
    const { queries, restore } = installQueryRecorder();
    try {
      await appendClaudeMessage(CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1, sampleMessage);
      await upsertClaudeConversationSummary({
        conversationKey: CODEX_PAPER_CONVERSATION_KEY_BASE + 1,
        libraryID: 1,
        kind: "paper",
      });

      assert.lengthOf(queries, 0);
    } finally {
      restore();
    }
  });

  it("rejects Claude-range keys at Codex store boundaries", async function () {
    const { queries, restore } = installQueryRecorder();
    try {
      await appendCodexMessage(CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1, sampleMessage);
      await upsertCodexConversationSummary({
        conversationKey: CLAUDE_PAPER_CONVERSATION_KEY_BASE + 1,
        libraryID: 1,
        kind: "paper",
      });

      assert.lengthOf(queries, 0);
    } finally {
      restore();
    }
  });

  it("rejects runtime keys in the upstream chat store", async function () {
    const { queries, restore } = installQueryRecorder();
    try {
      await appendMessage(CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1, sampleMessage);

      assert.lengthOf(queries, 0);
    } finally {
      restore();
    }
  });

  it("refuses to reassign an existing Codex paper conversation to a different paper", async function () {
    const conversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 123;
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        sql.includes("WHERE c.conversation_key = ?")
      ) {
        return [
          {
            conversationKey,
            libraryID: 1,
            kind: "paper",
            paperItemID: 3196,
            createdAt: 100,
            updatedAt: 200,
            title: "Existing paper",
            userTurnCount: 1,
          },
        ];
      }
      return [];
    });
    try {
      const stored = await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "paper",
        paperItemID: 3340,
      });

      assert.equal(stored, false);
      assert.isFalse(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_conversations"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("backfills missing Codex registry rows while listing legacy history", async function () {
    const conversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 3331;
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        sql.includes("c.kind = 'paper'") &&
        sql.includes("c.paper_item_id = ?")
      ) {
        return [
          {
            conversationKey,
            libraryID: 1,
            kind: "paper",
            paperItemID: 3326,
            createdAt: 100,
            updatedAt: 200,
            title: "Legacy paper chat",
            userTurnCount: 1,
          },
        ];
      }
      return [];
    });
    try {
      const entries = await listCodexPaperConversations(1, 3326, 10);

      assert.lengthOf(entries, 1);
      assert.equal(entries[0]?.conversationKey, conversationKey);
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_conversation_registry"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("lists missing-registry Codex rows under the catalog primary paper", async function () {
    const conversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 3342;
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        sql.includes("c.kind = 'paper'") &&
        sql.includes("c.paper_item_id = ?")
      ) {
        return [
          {
            conversationKey,
            libraryID: 1,
            kind: "paper",
            paperItemID: 3342,
            createdAt: 100,
            updatedAt: 200,
            title: "Wrong paper",
            userTurnCount: 1,
          },
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_codex_messages") &&
        sql.includes("paper_contexts_json AS paperContextsJson")
      ) {
        return [
          {
            paperContextsJson: JSON.stringify([{ itemId: 3326 }]),
          },
        ];
      }
      return [];
    });
    try {
      const entries = await listCodexPaperConversations(1, 3342, 10);

      assert.lengthOf(entries, 1);
      assert.equal(entries[0]?.paperItemID, 3342);
      const repairUpdate = queries.find((query) =>
        query.sql.includes("UPDATE llm_for_zotero_codex_conversations") &&
        query.sql.includes("paper_item_id = ?"),
      );
      assert.equal(repairUpdate, undefined);
    } finally {
      restore();
    }
  });

  it("backfills missing Claude registry rows while listing legacy history", async function () {
    const conversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 3331;
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_claude_conversations c") &&
        sql.includes("c.kind = 'paper'") &&
        sql.includes("c.paper_item_id = ?")
      ) {
        return [
          {
            conversationKey,
            libraryID: 1,
            kind: "paper",
            paperItemID: 3326,
            createdAt: 100,
            updatedAt: 200,
            title: "Legacy Claude chat",
            userTurnCount: 1,
          },
        ];
      }
      return [];
    });
    try {
      const entries = await listClaudePaperConversations(1, 3326, 10);

      assert.lengthOf(entries, 1);
      assert.equal(entries[0]?.conversationKey, conversationKey);
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_conversation_registry"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("loads registered Codex and Claude conversations with unmigrated legacy message rows", async function () {
    const codexConversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 77;
    const claudeConversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 77;
    const codexConversationID = buildConversationID({
      conversationKey: codexConversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 77,
      profileSignature: "profile-dev",
    });
    const claudeConversationID = buildConversationID({
      conversationKey: claudeConversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: 1,
      paperItemID: 77,
      profileSignature: "profile-dev",
    });
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      const queryParams = Array.isArray(params) ? params : [];
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?")
      ) {
        const conversationKey = Number(queryParams[0]);
        if (conversationKey === codexConversationKey) {
          return [
            {
              conversationID: codexConversationID,
              conversationKey,
              system: "codex",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 77,
              valid: 1,
            },
          ];
        }
        if (conversationKey === claudeConversationKey) {
          return [
            {
              conversationID: claudeConversationID,
              conversationKey,
              system: "claude_code",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 77,
              valid: 1,
            },
          ];
        }
      }
      if (
        sql.includes("FROM llm_for_zotero_codex_messages") &&
        sql.includes("ORDER BY timestamp ASC")
      ) {
        return [{ role: "user", text: "Codex legacy row", timestamp: 100 }];
      }
      if (
        sql.includes("FROM llm_for_zotero_claude_messages") &&
        sql.includes("ORDER BY timestamp ASC")
      ) {
        return [{ role: "user", text: "Claude legacy row", timestamp: 100 }];
      }
      return [];
    });
    try {
      const codexMessages = await loadCodexConversation(codexConversationKey);
      const claudeMessages = await loadClaudeConversation(claudeConversationKey);

      assert.equal(codexMessages[0]?.text, "Codex legacy row");
      assert.equal(claudeMessages[0]?.text, "Claude legacy row");
      const messageLoadQueries = queries.filter(
        (query) =>
          query.sql.includes("ORDER BY timestamp ASC") &&
          (query.sql.includes("llm_for_zotero_codex_messages") ||
            query.sql.includes("llm_for_zotero_claude_messages")),
      );
      assert.lengthOf(messageLoadQueries, 2);
      assert.isTrue(
        messageLoadQueries.every(
          (query) =>
            query.sql.includes("conversation_id = ?") &&
            query.sql.includes("conversation_key = ?"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("repairs safe stale upstream, Codex, and Claude message ids before loading", async function () {
    const upstreamConversationKey = 79;
    const codexConversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 78;
    const claudeConversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 78;
    const upstreamConversationID = buildConversationID({
      conversationKey: upstreamConversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 79,
      profileSignature: "profile-dev",
    });
    const codexConversationID = buildConversationID({
      conversationKey: codexConversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 78,
      profileSignature: "profile-dev",
    });
    const claudeConversationID = buildConversationID({
      conversationKey: claudeConversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: 1,
      paperItemID: 78,
      profileSignature: "profile-dev",
    });
    const staleCodexConversationID = buildConversationID({
      conversationKey: codexConversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 78,
      profileSignature: "profile-old",
    });
    const staleClaudeConversationID = buildConversationID({
      conversationKey: claudeConversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: 1,
      paperItemID: 78,
      profileSignature: "profile-old",
    });
    const staleUpstreamConversationID = buildConversationID({
      conversationKey: upstreamConversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 79,
      profileSignature: "profile-old",
    });
    let repairedUpstream = false;
    let repairedCodex = false;
    let repairedClaude = false;
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      const queryParams = Array.isArray(params) ? params : [];
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?")
      ) {
        const conversationKey = Number(queryParams[0]);
        if (conversationKey === upstreamConversationKey) {
          return [
            {
              conversationID: upstreamConversationID,
              conversationKey,
              system: "upstream",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 79,
              valid: 1,
            },
          ];
        }
        if (conversationKey === codexConversationKey) {
          return [
            {
              conversationID: codexConversationID,
              conversationKey,
              system: "codex",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 78,
              valid: 1,
            },
          ];
        }
        if (conversationKey === claudeConversationKey) {
          return [
            {
              conversationID: claudeConversationID,
              conversationKey,
              system: "claude_code",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 78,
              valid: 1,
            },
          ];
        }
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_chat_messages")
      ) {
        return [
          { conversationID: upstreamConversationID },
          { conversationID: staleUpstreamConversationID },
        ];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_codex_messages")
      ) {
        return [
          { conversationID: codexConversationID },
          { conversationID: staleCodexConversationID },
        ];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_claude_messages")
      ) {
        return [
          { conversationID: claudeConversationID },
          { conversationID: staleClaudeConversationID },
        ];
      }
      if (
        sql.includes("paper_contexts_json AS paperContextsJson") &&
        (sql.includes("FROM llm_for_zotero_chat_messages") ||
          sql.includes("FROM llm_for_zotero_codex_messages") ||
          sql.includes("FROM llm_for_zotero_claude_messages")) &&
        !sql.includes("ORDER BY timestamp ASC")
      ) {
        const itemId = sql.includes("llm_for_zotero_chat_messages") ? 79 : 78;
        return [{ paperContextsJson: JSON.stringify([{ itemId }]) }];
      }
      if (
        sql.includes("UPDATE llm_for_zotero_chat_messages") &&
        sql.includes("SET conversation_id = ?")
      ) {
        repairedUpstream = true;
        return [];
      }
      if (
        sql.includes("UPDATE llm_for_zotero_codex_messages") &&
        sql.includes("SET conversation_id = ?")
      ) {
        repairedCodex = true;
        return [];
      }
      if (
        sql.includes("UPDATE llm_for_zotero_claude_messages") &&
        sql.includes("SET conversation_id = ?")
      ) {
        repairedClaude = true;
        return [];
      }
      if (
        sql.includes("FROM llm_for_zotero_chat_messages") &&
        sql.includes("ORDER BY timestamp ASC")
      ) {
        return repairedUpstream
          ? [{ role: "user", text: "Recovered upstream row", timestamp: 100 }]
          : [];
      }
      if (
        sql.includes("FROM llm_for_zotero_codex_messages") &&
        sql.includes("ORDER BY timestamp ASC")
      ) {
        return repairedCodex
          ? [{ role: "user", text: "Recovered Codex row", timestamp: 100 }]
          : [];
      }
      if (
        sql.includes("FROM llm_for_zotero_claude_messages") &&
        sql.includes("ORDER BY timestamp ASC")
      ) {
        return repairedClaude
          ? [{ role: "user", text: "Recovered Claude row", timestamp: 100 }]
          : [];
      }
      return [];
    });
    try {
      const upstreamMessages = await loadConversation(upstreamConversationKey);
      const codexMessages = await loadCodexConversation(codexConversationKey);
      const claudeMessages = await loadClaudeConversation(claudeConversationKey);

      assert.equal(upstreamMessages[0]?.text, "Recovered upstream row");
      assert.equal(codexMessages[0]?.text, "Recovered Codex row");
      assert.equal(claudeMessages[0]?.text, "Recovered Claude row");
      assert.isTrue(
        queries.some(
          (query) =>
            query.sql.includes("UPDATE llm_for_zotero_chat_messages") &&
            query.params[0] === upstreamConversationID &&
            query.params[2] === staleUpstreamConversationID,
        ),
      );
      assert.isTrue(
        queries.some(
          (query) =>
            query.sql.includes("UPDATE llm_for_zotero_codex_messages") &&
            query.params[0] === codexConversationID &&
            query.params[2] === staleCodexConversationID,
        ),
      );
      assert.isTrue(
        queries.some(
          (query) =>
            query.sql.includes("UPDATE llm_for_zotero_claude_messages") &&
            query.params[0] === claudeConversationID &&
            query.params[2] === staleClaudeConversationID,
        ),
      );
    } finally {
      restore();
    }
  });

  it("refuses to merge stale message ids that belong to a different scope", async function () {
    const upstreamConversationKey = 80;
    const codexConversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 80;
    const claudeConversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 80;
    const upstreamConversationID = buildConversationID({
      conversationKey: upstreamConversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 80,
      profileSignature: "profile-dev",
    });
    const codexConversationID = buildConversationID({
      conversationKey: codexConversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 80,
      profileSignature: "profile-dev",
    });
    const claudeConversationID = buildConversationID({
      conversationKey: claudeConversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: 1,
      paperItemID: 80,
      profileSignature: "profile-dev",
    });
    const staleUpstreamConversationID = buildConversationID({
      conversationKey: upstreamConversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: 999,
      profileSignature: "profile-dev",
    });
    const staleCodexConversationID = buildConversationID({
      conversationKey: codexConversationKey,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 999,
      profileSignature: "profile-dev",
    });
    const staleClaudeConversationID = buildConversationID({
      conversationKey: claudeConversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: 1,
      paperItemID: 999,
      profileSignature: "profile-dev",
    });
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      const queryParams = Array.isArray(params) ? params : [];
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?")
      ) {
        const conversationKey = Number(queryParams[0]);
        if (conversationKey === upstreamConversationKey) {
          return [
            {
              conversationID: upstreamConversationID,
              conversationKey,
              system: "upstream",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 80,
              valid: 1,
            },
          ];
        }
        if (conversationKey === codexConversationKey) {
          return [
            {
              conversationID: codexConversationID,
              conversationKey,
              system: "codex",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 80,
              valid: 1,
            },
          ];
        }
        if (conversationKey === claudeConversationKey) {
          return [
            {
              conversationID: claudeConversationID,
              conversationKey,
              system: "claude_code",
              kind: "paper",
              profileSignature: "profile-dev",
              libraryID: 1,
              paperItemID: 80,
              valid: 1,
            },
          ];
        }
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_chat_messages")
      ) {
        return [{ conversationID: staleUpstreamConversationID }];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_codex_messages")
      ) {
        return [{ conversationID: staleCodexConversationID }];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_claude_messages")
      ) {
        return [{ conversationID: staleClaudeConversationID }];
      }
      if (sql.includes("ORDER BY timestamp ASC")) {
        return [{ role: "user", text: "Canonical row", timestamp: 100 }];
      }
      return [];
    });
    try {
      await loadConversation(upstreamConversationKey);
      await loadCodexConversation(codexConversationKey);
      await loadClaudeConversation(claudeConversationKey);

      assert.isFalse(
        queries.some(
          (query) =>
            query.sql.includes("UPDATE llm_for_zotero_chat_messages") ||
            query.sql.includes("UPDATE llm_for_zotero_codex_messages") ||
            query.sql.includes("UPDATE llm_for_zotero_claude_messages"),
        ),
      );
      const loadQueries = queries.filter((query) =>
        query.sql.includes("ORDER BY timestamp ASC"),
      );
      assert.lengthOf(loadQueries, 3);
      assert.isTrue(
        loadQueries.every(
          (query) =>
            query.sql.includes("WHERE conversation_id = ?") &&
            !query.sql.includes("conversation_key = ?"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("repairs safe stale message ids before refreshing catalog summaries", async function () {
    const conversationKey = 1009;
    const conversationID = buildConversationID({
      conversationKey,
      system: "upstream",
      kind: "global",
      libraryID: 2,
    });
    const staleConversationID = "legacy-upstream-stale-summary";
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?")
      ) {
        return [
          {
            conversationID,
            conversationKey,
            system: "upstream",
            kind: "global",
            profileSignature: "profile-test",
            libraryID: 2,
            paperItemID: null,
            valid: 1,
          },
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_global_conversations c") &&
        sql.includes("c.conversation_id AS conversationID")
      ) {
        return [
          {
            conversationID,
            conversationKey,
            libraryID: 2,
            kind: "global",
            paperItemID: null,
          },
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_paper_conversations c") &&
        sql.includes("c.conversation_id AS conversationID")
      ) {
        return [];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_chat_messages") &&
        params?.[0] === conversationKey
      ) {
        return [
          { conversationID },
          { conversationID: staleConversationID },
        ];
      }
      return [];
    });
    try {
      await appendMessage(conversationKey, sampleMessage);

      const repairIndex = queries.findIndex(
        (query) =>
          query.sql.includes("UPDATE llm_for_zotero_chat_messages") &&
          query.sql.includes("SET conversation_id = ?") &&
          query.sql.includes("OR conversation_id = ?"),
      );
      const summaryIndex = queries.findIndex((query) =>
        query.sql.includes("UPDATE llm_for_zotero_global_conversations"),
      );
      assert.isAtLeast(repairIndex, 0);
      assert.isAtLeast(summaryIndex, 0);
      assert.isBelow(repairIndex, summaryIndex);
    } finally {
      restore();
    }
  });

  it("repairs safe stale message ids before local deletion and refuses ambiguous stale deletion", async function () {
    const upstreamKey = 1010;
    const upstreamConversationID = buildConversationID({
      conversationKey: upstreamKey,
      system: "upstream",
      kind: "global",
      libraryID: 2,
    });
    const codexKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 10;
    const codexConversationID = buildConversationID({
      conversationKey: codexKey,
      system: "codex",
      kind: "global",
      libraryID: 2,
    });
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?")
      ) {
        if (params?.[0] === upstreamKey) {
          return [
            {
              conversationID: upstreamConversationID,
              conversationKey: upstreamKey,
              system: "upstream",
              kind: "global",
              profileSignature: "profile-test",
              libraryID: 2,
              paperItemID: null,
              valid: 1,
            },
          ];
        }
        if (params?.[0] === codexKey) {
          return [
            {
              conversationID: codexConversationID,
              conversationKey: codexKey,
              system: "codex",
              kind: "global",
              profileSignature: "profile-test",
              libraryID: 2,
              paperItemID: null,
              valid: 1,
            },
          ];
        }
      }
      if (
        sql.includes("FROM llm_for_zotero_global_conversations c") &&
        sql.includes("c.conversation_id AS conversationID")
      ) {
        return [
          {
            conversationID: upstreamConversationID,
            conversationKey: upstreamKey,
            libraryID: 2,
            kind: "global",
            paperItemID: null,
          },
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_paper_conversations c") &&
        sql.includes("c.conversation_id AS conversationID")
      ) {
        return [];
      }
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        sql.includes("c.conversation_id AS conversationID")
      ) {
        return [
          {
            conversationID: codexConversationID,
            conversationKey: codexKey,
            libraryID: 2,
            kind: "global",
            paperItemID: null,
          },
        ];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_chat_messages")
      ) {
        return [
          { conversationID: upstreamConversationID },
          { conversationID: "legacy-upstream-stale-delete" },
        ];
      }
      if (
        sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
        sql.includes("FROM llm_for_zotero_codex_messages")
      ) {
        return [
          { conversationID: codexConversationID },
          { conversationID: "stale-one" },
          { conversationID: "stale-two" },
        ];
      }
      return [];
    });
    try {
      await deleteUpstreamConversationLocalRows(upstreamKey, "global");
      let codexDeleteError = "";
      try {
        await deleteCodexConversationLocalRows(codexKey);
      } catch (err) {
        codexDeleteError = err instanceof Error ? err.message : String(err);
      }
      assert.match(codexDeleteError, /Refused to delete Codex conversation/);

      const repairIndex = queries.findIndex(
        (query) =>
          query.sql.includes("UPDATE llm_for_zotero_chat_messages") &&
          query.sql.includes("SET conversation_id = ?") &&
          query.sql.includes("OR conversation_id = ?"),
      );
      const deleteIndex = queries.findIndex(
        (query) =>
          query.sql.includes("DELETE FROM llm_for_zotero_chat_messages") &&
          query.sql.includes("conversation_id = ?"),
      );
      assert.isAtLeast(repairIndex, 0);
      assert.isAtLeast(deleteIndex, 0);
      assert.isBelow(repairIndex, deleteIndex);
      assert.isFalse(
        queries.some((query) =>
          query.sql.includes("DELETE FROM llm_for_zotero_codex_messages"),
        ),
      );
    } finally {
      restore();
    }
  });
});

describe("misrouted Codex conversation repair", function () {
  const codexKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 123;

  it("moves Codex-range rows out of Claude tables when Codex has no matching key", async function () {
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (sql.includes("FROM sqlite_master")) return [{ name: "ok" }];
      if (sql.includes("SELECT DISTINCT conversation_key AS conversationKey")) {
        return [{ conversationKey: codexKey }];
      }
      if (sql.includes("COUNT(*) AS rowCount")) {
        if (sql.includes("FROM llm_for_zotero_claude_")) return [{ rowCount: 1 }];
        if (sql.includes("FROM llm_for_zotero_codex_")) return [{ rowCount: 0 }];
      }
      return [];
    });
    try {
      await repairMisroutedCodexConversationRows();

      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_conversations"),
        ),
      );
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_messages"),
        ),
      );
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("DELETE FROM llm_for_zotero_claude_conversations"),
        ),
      );
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("DELETE FROM llm_for_zotero_claude_messages"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("does not overwrite existing Codex rows", async function () {
    const warnings: string[] = [];
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (sql.includes("FROM sqlite_master")) return [{ name: "ok" }];
      if (sql.includes("SELECT DISTINCT conversation_key AS conversationKey")) {
        return [{ conversationKey: codexKey }];
      }
      if (sql.includes("COUNT(*) AS rowCount")) return [{ rowCount: 1 }];
      return [];
    });
    (
      globalThis as typeof globalThis & {
        Zotero?: typeof Zotero & { debug?: (message: string) => void };
      }
    ).Zotero!.debug = (message: string) => {
      warnings.push(message);
    };
    try {
      await repairMisroutedCodexConversationRows();

      assert.isFalse(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_conversations"),
        ),
      );
      assert.isFalse(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_messages"),
        ),
      );
      assert.lengthOf(warnings, 2);
    } finally {
      restore();
    }
  });
});

describe("chat history startup schema compatibility", function () {
  const legacyConversationColumns = [
    { name: "conversation_key" },
    { name: "library_id" },
    { name: "kind" },
    { name: "paper_item_id" },
    { name: "title" },
  ];

  it("adds legacy Claude catalog timestamp columns before creating the activity index", async function () {
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (sql.includes("PRAGMA table_info(llm_for_zotero_claude_conversations)")) {
        return legacyConversationColumns;
      }
      return [];
    });
    try {
      await initClaudeCodeStore();

      const createdAtColumnIndex = queries.findIndex(
        (query) =>
          query.sql.includes("ALTER TABLE llm_for_zotero_claude_conversations") &&
          query.sql.includes("ADD COLUMN created_at INTEGER"),
      );
      const updatedAtColumnIndex = queries.findIndex(
        (query) =>
          query.sql.includes("ALTER TABLE llm_for_zotero_claude_conversations") &&
          query.sql.includes("ADD COLUMN updated_at INTEGER"),
      );
      const timestampBackfillIndex = queries.findIndex(
        (query) =>
          query.sql.includes("UPDATE llm_for_zotero_claude_conversations") &&
          query.sql.includes("SET created_at = COALESCE"),
      );
      const activityIndexIndex = queries.findIndex((query) =>
        query.sql.includes(
          "CREATE INDEX IF NOT EXISTS llm_for_zotero_claude_conversations_kind_idx",
        ),
      );

      assert.isAtLeast(createdAtColumnIndex, 0);
      assert.isAtLeast(updatedAtColumnIndex, 0);
      assert.isAtLeast(timestampBackfillIndex, 0);
      assert.isAtLeast(activityIndexIndex, 0);
      assert.isBelow(createdAtColumnIndex, activityIndexIndex);
      assert.isBelow(updatedAtColumnIndex, activityIndexIndex);
      assert.isBelow(timestampBackfillIndex, activityIndexIndex);
    } finally {
      restore();
    }
  });

  it("adds legacy Codex catalog timestamp columns before creating the activity index", async function () {
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (sql.includes("PRAGMA table_info(llm_for_zotero_codex_conversations)")) {
        return legacyConversationColumns;
      }
      return [];
    });
    try {
      await initCodexAppServerStore();

      const createdAtColumnIndex = queries.findIndex(
        (query) =>
          query.sql.includes("ALTER TABLE llm_for_zotero_codex_conversations") &&
          query.sql.includes("ADD COLUMN created_at INTEGER"),
      );
      const updatedAtColumnIndex = queries.findIndex(
        (query) =>
          query.sql.includes("ALTER TABLE llm_for_zotero_codex_conversations") &&
          query.sql.includes("ADD COLUMN updated_at INTEGER"),
      );
      const timestampBackfillIndex = queries.findIndex(
        (query) =>
          query.sql.includes("UPDATE llm_for_zotero_codex_conversations") &&
          query.sql.includes("SET created_at = COALESCE"),
      );
      const activityIndexIndex = queries.findIndex((query) =>
        query.sql.includes(
          "CREATE INDEX IF NOT EXISTS llm_for_zotero_codex_conversations_kind_idx",
        ),
      );

      assert.isAtLeast(createdAtColumnIndex, 0);
      assert.isAtLeast(updatedAtColumnIndex, 0);
      assert.isAtLeast(timestampBackfillIndex, 0);
      assert.isAtLeast(activityIndexIndex, 0);
      assert.isBelow(createdAtColumnIndex, activityIndexIndex);
      assert.isBelow(updatedAtColumnIndex, activityIndexIndex);
      assert.isBelow(timestampBackfillIndex, activityIndexIndex);
    } finally {
      restore();
    }
  });
});

describe("Claude conversation identity repair", function () {
  const conversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 3340;

  it("keeps the Claude catalog primary paper while repairing registry rows", async function () {
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_claude_conversations c") &&
        sql.includes("ORDER BY updatedAt DESC")
      ) {
        return [
          strictConversationSummaryRow({
            conversationKey,
            kind: "paper",
            paperItemID: 3340,
            title: "Wrong paper",
            userTurnCount: 1,
          }),
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_claude_messages") &&
        sql.includes("paper_contexts_json AS paperContextsJson")
      ) {
        return [
          {
            paperContextsJson: JSON.stringify([
              {
                itemId: 3196,
                contextItemId: 3197,
                title: "Stable and Dynamic Coding for Working Memory",
              },
            ]),
          },
        ];
      }
      return [];
    });
    try {
      await repairClaudeConversationIdentityRegistry();

      const catalogQuery = queries.find(
        (query) =>
          query.sql.includes("FROM llm_for_zotero_claude_conversations c") &&
          query.sql.includes("ORDER BY updatedAt DESC"),
      );
      assert.include(catalogQuery?.sql || "", "AS userTurnCount");
      assert.include(catalogQuery?.sql || "", "provider_session_id AS providerSessionId");
      assert.include(catalogQuery?.sql || "", "model_name AS modelName");

      const repairUpdate = queries.find((query) =>
        query.sql.includes("UPDATE llm_for_zotero_claude_conversations") &&
        query.sql.includes("paper_item_id = ?"),
      );
      assert.equal(repairUpdate, undefined);
      assert.isFalse(
        queries.some(
          (query) =>
            query.sql.includes("FROM llm_for_zotero_claude_messages") &&
            query.sql.includes("paper_contexts_json AS paperContextsJson"),
        ),
      );
      const registryInsert = queries.find((query) =>
        query.sql.includes("INSERT INTO llm_for_zotero_conversation_registry"),
      );
      assert.equal(registryInsert?.params[6], 3340);
    } finally {
      restore();
    }
  });

  it("migrates legacy ambiguous Claude registry invalidation when a primary paper exists", async function () {
    const primaryPaperItemID = 3196;
    const key = CLAUDE_PAPER_CONVERSATION_KEY_BASE + primaryPaperItemID;
    const conversationID = `lfz:profile-test:claude_code:paper:lib-1:paper-${primaryPaperItemID}:legacy-${key}`;
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      if (
        sql.includes("FROM llm_for_zotero_claude_conversations c") &&
        (sql.includes("WHERE c.conversation_key = ?") ||
          sql.includes("c.kind = 'paper'"))
      ) {
        return [
          strictConversationSummaryRow({
            conversationID,
            conversationKey: key,
            libraryID: 1,
            kind: "paper",
            paperItemID: primaryPaperItemID,
            title: "Legacy multi-paper chat",
            userTurnCount: 1,
          }),
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?") &&
        params?.[0] === key
      ) {
        return [
          {
            conversationID,
            conversationKey: key,
            system: "claude_code",
            kind: "paper",
            profileSignature: "profile-test",
            libraryID: 1,
            paperItemID: primaryPaperItemID,
            valid: 0,
            invalidReason: "ambiguous paper context evidence",
          },
        ];
      }
      return [];
    });
    try {
      const entries = await listClaudePaperConversations(
        1,
        primaryPaperItemID,
        10,
      );

      assert.lengthOf(entries, 1);
      assert.equal(entries[0]?.paperItemID, primaryPaperItemID);
      assert.isTrue(
        queries.some(
          (query) =>
            query.sql.includes("llm_for_zotero_conversation_registry") &&
            query.sql.includes("valid = 1") &&
            query.sql.includes("invalid_reason = NULL") &&
            query.params.includes(key),
        ),
      );
    } finally {
      restore();
    }
  });
});

describe("Codex conversation identity repair", function () {
  const conversationKey = CODEX_PAPER_CONVERSATION_KEY_BASE + 3340;

  it("keeps the Codex catalog primary paper while repairing registry rows", async function () {
    const { queries, restore } = installQueryRecorder(async (sql) => {
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        sql.includes("ORDER BY updatedAt DESC")
      ) {
        return [
          strictConversationSummaryRow({
            conversationKey,
            kind: "paper",
            paperItemID: 3340,
            title: "Wrong paper",
            userTurnCount: 1,
          }),
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_codex_messages") &&
        sql.includes("paper_contexts_json AS paperContextsJson")
      ) {
        return [
          {
            paperContextsJson: JSON.stringify([
              {
                itemId: 3196,
                contextItemId: 3197,
                title: "Stable and Dynamic Coding for Working Memory",
              },
            ]),
          },
        ];
      }
      return [];
    });
    try {
      await repairCodexConversationIdentityRegistry();

      const catalogQuery = queries.find(
        (query) =>
          query.sql.includes("FROM llm_for_zotero_codex_conversations c") &&
          query.sql.includes("ORDER BY updatedAt DESC"),
      );
      assert.include(catalogQuery?.sql || "", "AS userTurnCount");
      assert.include(catalogQuery?.sql || "", "provider_session_id AS providerSessionId");
      assert.include(catalogQuery?.sql || "", "model_name AS modelName");
      assert.notInclude(
        catalogQuery?.sql || "",
        "FROM llm_for_zotero_codex_conversations\n",
      );

      const repairUpdate = queries.find((query) =>
        query.sql.includes("UPDATE llm_for_zotero_codex_conversations") &&
        query.sql.includes("paper_item_id = ?"),
      );
      assert.equal(repairUpdate, undefined);
      assert.isFalse(
        queries.some(
          (query) =>
            query.sql.includes("FROM llm_for_zotero_codex_messages") &&
            query.sql.includes("paper_contexts_json AS paperContextsJson"),
        ),
      );
      const registryInsert = queries.find((query) =>
        query.sql.includes("INSERT INTO llm_for_zotero_conversation_registry"),
      );
      assert.equal(registryInsert?.params[6], 3340);
    } finally {
      restore();
    }
  });

  it("migrates legacy ambiguous Codex registry invalidation when a primary paper exists", async function () {
    const primaryPaperItemID = 3196;
    const key = CODEX_PAPER_CONVERSATION_KEY_BASE + primaryPaperItemID;
    const conversationID = `lfz:profile-test:codex:paper:lib-1:paper-${primaryPaperItemID}:legacy-${key}`;
    const { queries, restore } = installQueryRecorder(async (sql, params) => {
      if (
        sql.includes("FROM llm_for_zotero_codex_conversations c") &&
        (sql.includes("WHERE c.conversation_key = ?") ||
          sql.includes("c.kind = 'paper'"))
      ) {
        return [
          strictConversationSummaryRow({
            conversationID,
            conversationKey: key,
            libraryID: 1,
            kind: "paper",
            paperItemID: primaryPaperItemID,
            title: "Legacy multi-paper chat",
            userTurnCount: 1,
          }),
        ];
      }
      if (
        sql.includes("FROM llm_for_zotero_conversation_registry") &&
        sql.includes("WHERE legacy_conversation_key = ?") &&
        params?.[0] === key
      ) {
        return [
          {
            conversationID,
            conversationKey: key,
            system: "codex",
            kind: "paper",
            profileSignature: "profile-test",
            libraryID: 1,
            paperItemID: primaryPaperItemID,
            valid: 0,
            invalidReason: "ambiguous paper context evidence",
          },
        ];
      }
      return [];
    });
    try {
      const entries = await listCodexPaperConversations(
        1,
        primaryPaperItemID,
        10,
      );

      assert.lengthOf(entries, 1);
      assert.equal(entries[0]?.paperItemID, primaryPaperItemID);
      assert.isTrue(
        queries.some(
          (query) =>
            query.sql.includes("llm_for_zotero_conversation_registry") &&
            query.sql.includes("valid = 1") &&
            query.sql.includes("invalid_reason = NULL") &&
            query.params.includes(key),
        ),
      );
    } finally {
      restore();
    }
  });
});
