import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import type { StoredChatMessage } from "../src/utils/chatStore";
import {
  notifyConversationCatalogChanged,
  subscribeConversationCatalogChanges,
  type ConversationCatalogChange,
} from "../src/core/conversations/conversationCatalogEvents";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("conversationCatalogEvents: one notice when the chat list changes", function () {
  it("delivers the changes of one turn to every subscriber at once", async function () {
    const first: ConversationCatalogChange[][] = [];
    const second: ConversationCatalogChange[][] = [];
    const offFirst = subscribeConversationCatalogChanges((changes) =>
      first.push([...changes]),
    );
    const offSecond = subscribeConversationCatalogChanges((changes) =>
      second.push([...changes]),
    );
    try {
      notifyConversationCatalogChanged("created", 11);
      notifyConversationCatalogChanged("turns", 11);
      assert.lengthOf(first, 0, "delivery waits for the current turn to end");
      await settle();
      assert.deepEqual(first, [
        [
          { reason: "created", conversationKey: 11 },
          { reason: "turns", conversationKey: 11 },
        ],
      ]);
      assert.deepEqual(second, first);
    } finally {
      offFirst();
      offSecond();
    }
  });

  it("stops delivering after unsubscribe, and one failing subscriber does not stop the others", async function () {
    const seen: number[] = [];
    const offFailing = subscribeConversationCatalogChanges(() => {
      throw new Error("subscriber failed");
    });
    const off = subscribeConversationCatalogChanges((changes) =>
      seen.push(...changes.map((change) => change.conversationKey || 0)),
    );
    try {
      notifyConversationCatalogChanged("renamed", 5);
      await settle();
      off();
      notifyConversationCatalogChanged("renamed", 6);
      await settle();
      assert.deepEqual(seen, [5]);
    } finally {
      offFailing();
      off();
    }
  });
});

describe("conversation stores announce chat-list changes", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  let changes: ConversationCatalogChange[];
  let unsubscribe: () => void;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
    changes = [];
    unsubscribe = subscribeConversationCatalogChanges((batch) =>
      changes.push(...batch),
    );
  });

  afterEach(function () {
    unsubscribe();
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  async function drain(): Promise<ConversationCatalogChange[]> {
    await settle();
    const out = changes;
    changes = [];
    return out;
  }

  const message = (role: "user" | "assistant", timestamp: number) =>
    ({ role, text: `${role} ${timestamp}`, timestamp }) as StoredChatMessage;

  const stores = [
    {
      system: "upstream",
      init: () => upstream.initChatStore(),
      create: async () => upstream.createGlobalConversation(1),
      append: (key: number, m: StoredChatMessage) =>
        upstream.appendMessage(key, m),
      rename: (key: number) => upstream.setGlobalConversationTitle(key, "New"),
      remove: (key: number) => upstream.deleteGlobalConversation(key),
    },
    {
      system: "claude_code",
      init: () => claude.initClaudeCodeStore(),
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))!.conversationKey,
      append: (key: number, m: StoredChatMessage) =>
        claude.appendClaudeMessage(key, m),
      rename: (key: number) => claude.setClaudeConversationTitle(key, "New"),
      remove: (key: number) => claude.deleteClaudeConversation(key),
    },
    {
      system: "codex",
      init: () => codex.initCodexAppServerStore(),
      create: async () =>
        (await codex.createCodexGlobalConversation(1))!.conversationKey,
      append: (key: number, m: StoredChatMessage) =>
        codex.appendCodexMessage(key, m),
      rename: (key: number) => codex.setCodexConversationTitle(key, "New"),
      remove: (key: number) => codex.deleteCodexConversation(key),
    },
  ];

  for (const store of stores) {
    it(`${store.system}: creating, adding a turn, renaming and deleting a chat each announce it`, async function () {
      await store.init();
      await drain();
      const key = await store.create();
      assert.deepInclude(await drain(), {
        reason: "created",
        conversationKey: key,
      });
      await store.append(key, message("user", 1_000));
      assert.deepInclude(await drain(), {
        reason: "turns",
        conversationKey: key,
      });
      await store.rename(key);
      assert.deepInclude(await drain(), {
        reason: "renamed",
        conversationKey: key,
      });
      await store.remove(key);
      assert.deepInclude(await drain(), {
        reason: "deleted",
        conversationKey: key,
      });
    });

    it(`${store.system}: reading the chat list announces nothing`, async function () {
      await store.init();
      const key = await store.create();
      await drain();
      if (store.system === "upstream") {
        await upstream.listGlobalConversations(1, 20);
        await upstream.loadConversation(key, 10);
      } else if (store.system === "claude_code") {
        await claude.listClaudeGlobalConversations(1, 20);
        await claude.loadClaudeConversation(key, 10);
      } else {
        await codex.listCodexGlobalConversations(1, 20);
        await codex.loadCodexConversation(key, 10);
      }
      assert.deepEqual(await drain(), []);
    });
  }
});
