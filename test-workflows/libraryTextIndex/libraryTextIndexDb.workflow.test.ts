import { assert } from "chai";
import {
  closeLibraryTextIndexDb,
  getLibraryTextIndexDbPath,
  openLibraryTextIndexDb,
} from "../../src/services/libraryTextIndex/db";

declare const Zotero: any;
declare const IOUtils: any;

describe("library text index database in the real Zotero runtime", function () {
  this.timeout(30000);

  it("opens a separate sqlite file in the data directory, round-trips a row, and closes", async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    const db = await openLibraryTextIndexDb();
    assert.isOk(db, "Zotero.DBConnection opened the plugin database");
    const path = getLibraryTextIndexDbPath();
    assert.isTrue(await IOUtils.exists(path), `${path} exists`);
    await db!.executeTransaction(async () => {
      await db!.queryAsync(
        `INSERT OR REPLACE INTO documents (attachment_id, attachment_key, library_id, title, source_type, source_fingerprint, chunker_version, chunk_count, total_tokens, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          42,
          "ABCD1234",
          1,
          "spike",
          "mineru",
          "fnv1a32-00000000",
          1,
          0,
          0,
          Date.now(),
        ],
      );
    });
    const rows = (await db!.queryAsync(
      `SELECT attachment_key FROM documents WHERE attachment_id = ?`,
      [42],
    )) as any[];
    assert.equal(rows[0].attachment_key, "ABCD1234");
    assert.throws(
      () => rows[0].missing_column,
      /missing_column|not present/i,
      "Zotero rows throw on absent columns",
    );
    await db!.queryAsync(`DELETE FROM documents WHERE attachment_id = ?`, [42]);
    await closeLibraryTextIndexDb();
    const again = await openLibraryTextIndexDb();
    assert.isOk(again, "reopens after close");
    // Never leave this bundle's second connection open: with SQLite's shared
    // cache it would pin the file, and a later Clear index would reopen it read-only.
    await closeLibraryTextIndexDb();
  });

  // #576: an index that already has the current schema must not be rewritten
  // by opening it, or every Zotero start marks a multi-GB file as changed for
  // backup and sync tools.
  it("leaves an up-to-date database file unmodified when it is opened and closed", async function () {
    await (
      Zotero as any
    ).LLMForZotero.api.workflowTest.waitForLibraryTextIndexIdle(30000);
    assert.isOk(await openLibraryTextIndexDb(), "creates the database");
    await closeLibraryTextIndexDb();
    const path = getLibraryTextIndexDbPath();
    const old = Date.UTC(2020, 0, 1);
    await IOUtils.setModificationTime(path, old);

    assert.isOk(await openLibraryTextIndexDb(), "reopens the database");
    await closeLibraryTextIndexDb();

    assert.equal(
      (await IOUtils.stat(path)).lastModified,
      old,
      "opening an up-to-date index wrote nothing to its file",
    );
  });
});
