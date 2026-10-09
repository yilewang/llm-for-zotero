import { assert } from "chai";
import {
  closeLibraryTextIndexDb,
  getLibraryTextIndexDbPath,
  openLibraryTextIndexDb,
  refuseLibraryTextIndexOpensForQuit,
} from "../../src/services/libraryTextIndex/db";

declare const Zotero: any;
declare const IOUtils: any;

describe("library text index database in the real Zotero runtime", function () {
  this.timeout(30000);

  after(async function () {
    // An assertion or query failure must not skip disposal of this bundle's
    // connection and turn the original failure into a native shutdown crash.
    refuseLibraryTextIndexOpensForQuit();
    await closeLibraryTextIndexDb({ throwOnError: true });
  });

  it("opens a separate sqlite file in the data directory, round-trips a row, and closes", async function () {
    assert.include(
      Zotero.DataDirectory.dir.replace(/\\/g, "/"),
      ".scaffold/test/data",
    );
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
});
