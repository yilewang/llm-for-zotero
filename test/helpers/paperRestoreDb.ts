import { DatabaseSync } from "node:sqlite";
import {
  getCurrentProfileSignature,
  initConversationRegistryStore,
  resetConversationRegistryStoreInitForTests,
} from "../../src/shared/conversationRegistry";
import {
  flushPaperRestoreSelectionWrites,
  initializePaperRestoreSelections,
  resetPaperRestoreSelectionStateForTests,
} from "../../src/shared/paperConversationRestore";
import type { ConversationSystem } from "../../src/shared/types";

/**
 * A small in-memory SQLite profile that lets the paper restore service
 * initialize, so paper restore targets can be written and read back through
 * the per-runtime pref wrappers. The caller's pref store backs Zotero.Prefs.
 */
export type PaperRestoreDb = {
  db: DatabaseSync;
  addPaperConversation: (
    system: ConversationSystem,
    conversationKey: number,
    libraryID: number,
    paperItemID: number,
  ) => void;
  initializeAllRuntimes: () => Promise<void>;
  close: () => Promise<void>;
};

const globalScope = globalThis as typeof globalThis & {
  Zotero?: unknown;
  ChromeUtils?: unknown;
};

function bindable(params?: unknown[]): never[] {
  return (params || []).map((value) =>
    value === undefined ? null : value,
  ) as never[];
}

export async function installPaperRestoreDb(params: {
  profileDir: string;
  prefStore: Map<string, unknown>;
}): Promise<PaperRestoreDb> {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER NOT NULL)`,
  );
  db.exec(`CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)`);
  db.exec(`CREATE TABLE llm_for_zotero_paper_conversations (
    conversation_key INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    paper_item_id INTEGER NOT NULL,
    webchat_session INTEGER NOT NULL DEFAULT 0
  )`);
  const queryAsync = async (sql: string, queryParams?: unknown[]) => {
    const statement = db.prepare(sql);
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return statement.all(...bindable(queryParams)) as Record<
        string,
        unknown
      >[];
    }
    statement.run(...bindable(queryParams));
    return [];
  };
  globalScope.Zotero = {
    Profile: { dir: params.profileDir },
    Items: { get: () => null },
    Prefs: {
      get: (key: string) => params.prefStore.get(key) ?? "",
      set: (key: string, value: unknown) => {
        params.prefStore.set(key, value);
      },
      clear: (key: string) => {
        params.prefStore.delete(key);
      },
    },
    DB: {
      queryAsync,
      executeTransaction: async <T>(task: () => Promise<T>): Promise<T> => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    debug: () => undefined,
  };
  globalScope.ChromeUtils = undefined;
  resetConversationRegistryStoreInitForTests();
  resetPaperRestoreSelectionStateForTests();
  await initConversationRegistryStore();

  return {
    db,
    addPaperConversation: (system, conversationKey, libraryID, paperItemID) => {
      db.prepare(
        `INSERT OR IGNORE INTO items (itemID, libraryID) VALUES (?, ?)`,
      ).run(paperItemID, libraryID);
      if (system === "upstream") {
        db.prepare(
          `INSERT INTO llm_for_zotero_paper_conversations
            (conversation_key, library_id, paper_item_id, webchat_session)
           VALUES (?, ?, ?, 0)`,
        ).run(conversationKey, libraryID, paperItemID);
      }
      db.prepare(
        `INSERT INTO llm_for_zotero_conversation_registry
          (instance_id, conversation_id, legacy_conversation_key, system, kind,
           profile_signature, library_id, paper_item_id, created_at, updated_at,
           title, valid, invalid_reason, is_paper_restore_target)
         VALUES (?, ?, ?, ?, 'paper', ?, ?, ?, 1, 1, NULL, 1, NULL, 0)`,
      ).run(
        `instance-${system}-${conversationKey}`,
        `conversation-${system}-${conversationKey}`,
        conversationKey,
        system,
        getCurrentProfileSignature(),
        libraryID,
        paperItemID,
      );
    },
    initializeAllRuntimes: () =>
      initializePaperRestoreSelections({
        chatStoreReady: true,
        claudeStoreReady: true,
        codexStoreReady: true,
      }),
    close: async () => {
      await flushPaperRestoreSelectionWrites();
      resetPaperRestoreSelectionStateForTests();
      resetConversationRegistryStoreInitForTests();
      db.close();
    },
  };
}
