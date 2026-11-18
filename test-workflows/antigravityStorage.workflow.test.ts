import { assert } from "chai";
import { config } from "../package.json";
import { getRuntimeKindKeyBand } from "../src/shared/conversationKeySpace";
import { CONVERSATION_STORE_TABLES_BY_SYSTEM } from "../src/shared/conversationStore/storeTables";
import { CONVERSATION_SCHEMA_MIGRATIONS_TABLE } from "../src/shared/conversationSchemaMigrations";
import {
  CONVERSATION_SYSTEM_CHECK_MIGRATION_ID,
  CONVERSATION_SYSTEM_CHECK_TABLES,
  findTablesWithConversationSystemCheck,
  removeConversationSystemChecks,
} from "../src/shared/conversationSystemCheckMigration";
import { CONVERSATION_REGISTRY_TABLE } from "../src/shared/conversationRegistry";

declare const Zotero: any;

/**
 * Antigravity storage on a real Zotero database.
 *
 * Databases created before Antigravity declare
 * CHECK(system IN ('upstream', 'claude_code', 'codex')) on the conversation
 * registry, key ledger, and search index. This suite puts that old schema
 * back on the test profile's tables (keeping their rows, indexes, and
 * triggers), then proves: the old schema refuses an Antigravity row; a rebuild
 * that fails before commit leaves the old schema and rows untouched; the
 * rebuild removes only the system CHECK, keeps every row, index, and trigger,
 * and records its migration; a second run does nothing; startup leaves the
 * old schema alone while the mode is off and rebuilds it once the mode is on;
 * and the Antigravity store issues keys in its own band once rebuilt.
 */
describe("workflow: Antigravity storage", function () {
  this.timeout(120000);

  const ENABLE_PREF = `${config.prefsPrefix}.enableAntigravityMode`;
  const OLD_SYSTEM_CHECK =
    "CHECK(system IN ('upstream', 'claude_code', 'codex'))";
  let enablePrefBefore: unknown;

  function storage() {
    const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
    if (!api?.antigravityStorage) {
      throw new Error("Workflow test harness is not installed");
    }
    return api.antigravityStorage as {
      init(): Promise<void>;
      createGlobalConversation(libraryID: number): Promise<number | null>;
      listGlobalConversationKeys(libraryID: number): Promise<number[]>;
      deleteConversation(conversationKey: number): Promise<void>;
    };
  }

  async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await Zotero.DB.queryAsync(sql, params)) || [];
  }

  async function tableSql(table: string): Promise<string> {
    const found = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table],
    );
    return String(found[0]?.sql || "");
  }

  async function dependentNames(table: string): Promise<string[]> {
    const found = await rows(
      `SELECT type || ':' || name AS id FROM sqlite_master
       WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
      [table],
    );
    return found.map((row) => String(row.id)).sort();
  }

  async function rowCount(table: string): Promise<number> {
    const found = await rows(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(found[0]?.n) || 0;
  }

  async function snapshot(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      result[table] = {
        rows: await rowCount(table),
        dependents: await dependentNames(table),
      };
    }
    return result;
  }

  async function migrationRecorded(): Promise<boolean> {
    const found = await rows(
      `SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [CONVERSATION_SYSTEM_CHECK_MIGRATION_ID],
    );
    return found.length > 0;
  }

  async function backupTables(): Promise<string[]> {
    const found = await rows(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE ?`,
      ["%__system_check_backup"],
    );
    return found.map((row) => String(row.name));
  }

  /**
   * Gives a table the pre-Antigravity definition: the same table with the
   * system CHECK, the same rows, and the same indexes and triggers.
   */
  async function restoreOldSchema(table: string): Promise<void> {
    const sql = await tableSql(table);
    if (sql.includes(OLD_SYSTEM_CHECK)) return;
    const oldSql = sql.replace(
      /(\bsystem\s+TEXT\s+NOT\s+NULL)/i,
      `$1 ${OLD_SYSTEM_CHECK}`,
    );
    assert.notEqual(oldSql, sql, `${table} has a system column`);
    const dependents = await rows(
      `SELECT sql FROM sqlite_master
       WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
      [table],
    );
    const backup = `${table}__test_old_schema`;
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${backup}`);
      await Zotero.DB.queryAsync(
        `CREATE TABLE ${backup} AS SELECT * FROM ${table}`,
      );
      await Zotero.DB.queryAsync(`DROP TABLE ${table}`);
      await Zotero.DB.queryAsync(oldSql);
      await Zotero.DB.queryAsync(
        `INSERT INTO ${table} SELECT * FROM ${backup}`,
      );
      await Zotero.DB.queryAsync(`DROP TABLE ${backup}`);
      for (const dependent of dependents) {
        await Zotero.DB.queryAsync(String(dependent.sql));
      }
    });
  }

  /**
   * Antigravity rows that earlier tests in this profile left behind cannot
   * exist under the old schema; they wait in a side table until `after`.
   */
  async function setAsideAntigravityRows(): Promise<void> {
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      const aside = `${table}__test_set_aside`;
      await Zotero.DB.executeTransaction(async () => {
        await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${aside}`);
        await Zotero.DB.queryAsync(
          `CREATE TABLE ${aside} AS SELECT * FROM ${table} WHERE system = 'antigravity'`,
        );
        await Zotero.DB.queryAsync(
          `DELETE FROM ${table} WHERE system = 'antigravity'`,
        );
      });
    }
  }

  async function restoreAntigravityRows(): Promise<void> {
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      const aside = `${table}__test_set_aside`;
      await Zotero.DB.executeTransaction(async () => {
        await Zotero.DB.queryAsync(
          `INSERT OR IGNORE INTO ${table} SELECT * FROM ${aside}`,
        );
        await Zotero.DB.queryAsync(`DROP TABLE ${aside}`);
      });
    }
  }

  async function restoreOldSchemaEverywhere(): Promise<void> {
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      await restoreOldSchema(table);
    }
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [CONVERSATION_SYSTEM_CHECK_MIGRATION_ID],
    );
  }

  async function insertAntigravityRegistryRow(id: string): Promise<void> {
    await Zotero.DB.queryAsync(
      `INSERT INTO ${CONVERSATION_REGISTRY_TABLE}
        (instance_id, conversation_id, legacy_conversation_key, system, kind,
         profile_signature, library_id, created_at, updated_at)
       VALUES (?, ?, ?, 'antigravity', 'global', 'test', 1, 1, 1)`,
      [
        `instance-${id}`,
        id,
        getRuntimeKindKeyBand("antigravity", "global").start,
      ],
    );
  }

  before(async function () {
    enablePrefBefore = Zotero.Prefs.get(ENABLE_PREF, true);
    Zotero.Prefs.set(ENABLE_PREF, false, true);
    await setAsideAntigravityRows();
    await restoreOldSchemaEverywhere();
  });

  after(async function () {
    Zotero.Prefs.set(ENABLE_PREF, Boolean(enablePrefBefore), true);
    // Leave the profile on the current schema for the suites that follow.
    await removeConversationSystemChecks();
    await restoreAntigravityRows();
  });

  it("starts from the pre-Antigravity schema, which refuses an Antigravity row", async function () {
    assert.deepEqual(await findTablesWithConversationSystemCheck(), [
      ...CONVERSATION_SYSTEM_CHECK_TABLES,
    ]);
    let refused: unknown = null;
    try {
      await insertAntigravityRegistryRow(`refused-${Date.now()}`);
    } catch (error) {
      refused = error;
    }
    assert.match(String(refused), /CHECK constraint failed/);
  });

  it("leaves the old schema and every row in place when the rebuild fails before commit", async function () {
    const before = await snapshot();
    let failure: unknown = null;
    try {
      await removeConversationSystemChecks({
        beforeCommit: async () => {
          throw new Error("simulated crash before commit");
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /simulated crash before commit/);
    assert.deepEqual(await findTablesWithConversationSystemCheck(), [
      ...CONVERSATION_SYSTEM_CHECK_TABLES,
    ]);
    assert.deepEqual(await snapshot(), before);
    assert.isFalse(await migrationRecorded());
    assert.deepEqual(await backupTables(), []);
  });

  it("removes only the system CHECK, keeps rows, indexes, and triggers, and records the migration", async function () {
    const before = await snapshot();
    const sqlBefore: Record<string, string> = {};
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      sqlBefore[table] = await tableSql(table);
    }

    const result = await removeConversationSystemChecks();

    assert.deepEqual(result.rebuilt, [...CONVERSATION_SYSTEM_CHECK_TABLES]);
    assert.deepEqual(await findTablesWithConversationSystemCheck(), []);
    assert.deepEqual(await snapshot(), before);
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      const sql = await tableSql(table);
      assert.notInclude(sql, OLD_SYSTEM_CHECK);
      // Everything else in the definition is unchanged, including the kind CHECK.
      assert.equal(
        sql.replace(/\s+/g, " "),
        sqlBefore[table]
          .replace(` ${OLD_SYSTEM_CHECK}`, "")
          .replace(/\s+/g, " "),
      );
      assert.include(sql, "CHECK(kind IN ('global', 'paper'))");
    }
    assert.isTrue(await migrationRecorded());
    assert.deepEqual(await backupTables(), []);

    const id = `accepted-${Date.now()}`;
    await insertAntigravityRegistryRow(id);
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CONVERSATION_REGISTRY_TABLE} WHERE conversation_id = ?`,
      [id],
    );
  });

  it("does nothing on a second run", async function () {
    const result = await removeConversationSystemChecks();
    assert.deepEqual(result.rebuilt, []);
  });

  it("leaves the old schema alone at startup while the mode is off, and rebuilds it once the mode is on", async function () {
    await restoreOldSchemaEverywhere();

    Zotero.Prefs.set(ENABLE_PREF, false, true);
    await storage().init();
    assert.deepEqual(await findTablesWithConversationSystemCheck(), [
      ...CONVERSATION_SYSTEM_CHECK_TABLES,
    ]);
    assert.isFalse(await migrationRecorded());

    Zotero.Prefs.set(ENABLE_PREF, true, true);
    await storage().init();
    assert.deepEqual(await findTablesWithConversationSystemCheck(), []);
    assert.isTrue(await migrationRecorded());
  });

  it("creates the Antigravity tables for every profile and issues keys in its own band", async function () {
    const tables = CONVERSATION_STORE_TABLES_BY_SYSTEM.antigravity;
    for (const table of [tables.messageTable, tables.catalogTables.global]) {
      assert.isNotEmpty(await tableSql(table), `${table} exists`);
    }

    const libraryID = Zotero.Libraries.userLibraryID;
    const key = Number(await storage().createGlobalConversation(libraryID));
    const band = getRuntimeKindKeyBand("antigravity", "global");
    assert.isAtLeast(key, band.start);
    assert.isBelow(key, band.endExclusive);
    assert.isBelow(key, Number.MAX_SAFE_INTEGER);

    const registered = await rows(
      `SELECT system, kind FROM ${CONVERSATION_REGISTRY_TABLE}
       WHERE legacy_conversation_key = ?`,
      [key],
    );
    assert.deepEqual(
      registered.map((row) => [row.system, row.kind]),
      [["antigravity", "global"]],
    );
    assert.include(await storage().listGlobalConversationKeys(libraryID), key);
    await storage().deleteConversation(key);
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CONVERSATION_REGISTRY_TABLE} WHERE legacy_conversation_key = ?`,
      [key],
    );
  });
});
