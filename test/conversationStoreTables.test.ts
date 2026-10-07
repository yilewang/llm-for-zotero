import { assert } from "chai";
import {
  CONVERSATION_CATALOG_TABLES,
  CONVERSATION_MESSAGE_TABLES,
  CONVERSATION_STORE_TABLES,
  getConversationCatalogTable,
  getConversationCatalogTables,
  getConversationStoreTables,
} from "../src/shared/conversationStore/storeTables";

/**
 * The store-table descriptors name persisted tables, and the satellites that
 * scan every store build SQL from their order.  Both are pinned here.
 */
describe("conversation store tables", function () {
  it("names every store's persisted tables, in store order", function () {
    assert.deepEqual(
      CONVERSATION_STORE_TABLES.map((store) => ({
        system: store.system,
        messageTable: store.messageTable,
        global: store.catalogTables.global,
        paper: store.catalogTables.paper,
      })),
      [
        {
          system: "upstream",
          messageTable: "llm_for_zotero_chat_messages",
          global: "llm_for_zotero_global_conversations",
          paper: "llm_for_zotero_paper_conversations",
        },
        {
          system: "claude_code",
          messageTable: "llm_for_zotero_claude_messages",
          global: "llm_for_zotero_claude_conversations",
          paper: "llm_for_zotero_claude_conversations",
        },
        {
          system: "codex",
          messageTable: "llm_for_zotero_codex_messages",
          global: "llm_for_zotero_codex_conversations",
          paper: "llm_for_zotero_codex_conversations",
        },
      ],
    );
  });

  it("lists each catalog once: upstream global, upstream paper, Claude, Codex", function () {
    assert.deepEqual(CONVERSATION_CATALOG_TABLES, [
      {
        system: "upstream",
        catalogTable: "llm_for_zotero_global_conversations",
        messageTable: "llm_for_zotero_chat_messages",
        kind: "global",
      },
      {
        system: "upstream",
        catalogTable: "llm_for_zotero_paper_conversations",
        messageTable: "llm_for_zotero_chat_messages",
        kind: "paper",
      },
      {
        system: "claude_code",
        catalogTable: "llm_for_zotero_claude_conversations",
        messageTable: "llm_for_zotero_claude_messages",
        kind: null,
      },
      {
        system: "codex",
        catalogTable: "llm_for_zotero_codex_conversations",
        messageTable: "llm_for_zotero_codex_messages",
        kind: null,
      },
    ]);
    assert.deepEqual(CONVERSATION_MESSAGE_TABLES, [
      "llm_for_zotero_chat_messages",
      "llm_for_zotero_claude_messages",
      "llm_for_zotero_codex_messages",
    ]);
    assert.deepEqual(
      getConversationCatalogTables("upstream").map((c) => c.catalogTable),
      [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
      ],
    );
  });

  it("finds a catalog by store and kind, and nothing for other values", function () {
    assert.equal(
      getConversationCatalogTable("upstream", "paper"),
      "llm_for_zotero_paper_conversations",
    );
    assert.equal(
      getConversationCatalogTable("codex", "global"),
      "llm_for_zotero_codex_conversations",
    );
    assert.isUndefined(getConversationCatalogTable("upstream", "note"));
    assert.isUndefined(getConversationCatalogTable("upstream", "constructor"));
    assert.isUndefined(getConversationCatalogTable("webchat", "global"));
    assert.isUndefined(getConversationCatalogTable("toString", "global"));
    assert.isUndefined(getConversationStoreTables("constructor"));
  });
});
