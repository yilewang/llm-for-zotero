import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  deleteConversationJournal,
  initAgentChangeJournal,
  JOURNAL_ACTIONS_TABLE,
  JOURNAL_STEPS_TABLE,
  LEGACY_JOURNAL_TABLE,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";

declare const Zotero: any;

/**
 * A change journal written before the v2 tables existed. Starting the journal
 * copies each v1 row into a v2 action and step, never deletes the v1 row,
 * keeps the old inverse visible, and refuses to replay it without a verifiable
 * post-image. Deleting a conversation removes both kinds of row for that
 * conversation only, so a later start cannot bring them back. Every assertion
 * reads the real SQLite rows or Zotero's own collection membership.
 */
describe("workflow: legacy v1 change journal migration", function () {
  this.timeout(120000);

  const suffix = Date.now();
  const K1 = 2_503_000_000 + (suffix % 1_000_000);
  const K2 = K1 + 1;
  const ids = {
    k1: `legacy-k1-${suffix}`,
    k2: `legacy-k2-${suffix}`,
  };
  const gateway = new ZoteroGateway();
  let createdLegacyTable = false;
  let collection: any = null;
  let paper: any = null;

  async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await Zotero.DB.queryAsync(sql, params)) || [];
  }

  async function legacyEntryIds(): Promise<string[]> {
    const found = await rows(
      `SELECT entry_id FROM ${LEGACY_JOURNAL_TABLE} WHERE entry_id IN (?, ?)`,
      [ids.k1, ids.k2],
    );
    return found.map((row) => String(row.entry_id)).sort();
  }

  async function v2ActionIds(): Promise<string[]> {
    const found = await rows(
      `SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE} WHERE action_id IN (?, ?)`,
      [ids.k1, ids.k2],
    );
    return found.map((row) => String(row.action_id)).sort();
  }

  before(async function () {
    // Make sure the v2 tables exist before the legacy table does.
    await initAgentChangeJournal();
    const existing = await rows(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      [LEGACY_JOURNAL_TABLE],
    );
    if (!existing.length) {
      createdLegacyTable = true;
      // Schema of the v1 journal (commit 14f344a49).
      await Zotero.DB.queryAsync(
        `CREATE TABLE ${LEGACY_JOURNAL_TABLE} (
          entry_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          conversation_key INTEGER NOT NULL,
          operation TEXT NOT NULL,
          description TEXT NOT NULL,
          inverse_json TEXT,
          irreversible_reason TEXT,
          item_count INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('reversible','irreversible','reverted')),
          created_at INTEGER NOT NULL
        )`,
      );
    }
    collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = `Legacy journal ${suffix}`;
    await collection.saveTx();
    paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", `Legacy journal paper ${suffix}`);
    paper.addToCollection(collection.id);
    await paper.saveTx();
  });

  after(async function () {
    // Remove only this test's rows; drop the v1 table only if this test made it.
    for (const key of [K1, K2]) {
      try {
        await deleteConversationJournal(key);
      } catch (_err) {
        // best effort
      }
    }
    for (const id of Object.values(ids)) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${JOURNAL_STEPS_TABLE} WHERE action_id = ?`,
        [id],
      ).catch(() => undefined);
      await Zotero.DB.queryAsync(
        `DELETE FROM ${JOURNAL_ACTIONS_TABLE} WHERE action_id = ?`,
        [id],
      ).catch(() => undefined);
      await Zotero.DB.queryAsync(
        `DELETE FROM ${LEGACY_JOURNAL_TABLE} WHERE entry_id = ?`,
        [id],
      ).catch(() => undefined);
    }
    if (createdLegacyTable) {
      await Zotero.DB.queryAsync(
        `DROP TABLE IF EXISTS ${LEGACY_JOURNAL_TABLE}`,
      );
    }
    if (paper) await Zotero.Items.get(paper.id)?.eraseTx();
    if (collection) await Zotero.Collections.get(collection.id)?.eraseTx();
  });

  async function seed(entryId: string, key: number): Promise<void> {
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${LEGACY_JOURNAL_TABLE}
        (entry_id, run_id, conversation_key, operation, description,
         inverse_json, irreversible_reason, item_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 'reversible', 1234)`,
      [
        entryId,
        `legacy-run-${suffix}`,
        key,
        "move_to_collection",
        "Filed a paper",
        JSON.stringify([
          {
            type: "remove_from_collection",
            itemIds: [paper.id],
            collectionId: collection.id,
          },
        ]),
      ],
    );
  }

  function context(key: number): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey: key,
        mode: "agent",
        userText: "Undo the old filing",
        libraryID: Zotero.Libraries.userLibraryID,
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
    } as AgentToolContext;
  }

  it("migrates v1 rows once, keeps the legacy row, and refuses unguarded replay", async function () {
    await seed(ids.k1, K1);
    await seed(ids.k2, K2);

    await initAgentChangeJournal();
    await initAgentChangeJournal();

    assert.deepEqual(await legacyEntryIds(), [ids.k1, ids.k2].sort());
    assert.deepEqual(await v2ActionIds(), [ids.k1, ids.k2].sort());
    const actionRows = await rows(
      `SELECT status, reversibility FROM ${JOURNAL_ACTIONS_TABLE}
       WHERE action_id = ?`,
      [ids.k1],
    );
    assert.lengthOf(actionRows, 1);
    assert.equal(actionRows[0].status, "applied");
    assert.equal(actionRows[0].reversibility, "partial");
    const stepRows = await rows(
      `SELECT step_id, status FROM ${JOURNAL_STEPS_TABLE}
       WHERE action_id = ?`,
      [ids.k1],
    );
    assert.lengthOf(stepRows, 1, "one step per migrated row");
    assert.equal(stepRows[0].step_id, `${ids.k1}:1`);
    assert.equal(stepRows[0].status, "applied");

    const [action] = await listJournalActions({
      conversationKey: K1,
      pendingOnly: true,
      limit: 5,
    });
    assert.equal(action.actionId, ids.k1, "the old inverse is still listed");

    const outcome = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context: context(K1),
    });
    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.include(outcome.conflicts[0].reason, "no expected post-image");

    const live = Zotero.Items.get(paper.id);
    assert.include(
      live.getCollections(),
      collection.id,
      "the item stays in its collection",
    );
  });

  it("deletes legacy and v2 rows with their conversation so they cannot remigrate", async function () {
    await deleteConversationJournal(K1);
    await initAgentChangeJournal();

    assert.deepEqual(await legacyEntryIds(), [ids.k2]);
    assert.deepEqual(await v2ActionIds(), [ids.k2]);
    const steps = await rows(
      `SELECT step_id FROM ${JOURNAL_STEPS_TABLE} WHERE action_id IN (?, ?)`,
      [ids.k1, ids.k2],
    );
    assert.deepEqual(
      steps.map((row) => String(row.step_id)),
      [`${ids.k2}:1`],
    );
  });
});
