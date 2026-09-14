import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { executePreparedNoteChange } from "../src/agent/tools/write/preparedNoteChange";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

describe("prepared note action lifecycle", function () {
  const original = globalThis.Zotero;
  let db: ChangeJournalTestDb;
  let stored: string;
  let pending: string;
  let writes: number;
  let fault: "none" | "lost_once" | "after_commit" | "mismatch" | "unavailable";
  let note: Zotero.Item;
  beforeEach(async function () {
    db = new ChangeJournalTestDb();
    stored = pending = "<p>Original</p>";
    writes = 0;
    fault = "none";
    note = {
      id: 41,
      key: "NOTE0041",
      libraryID: 1,
      isNote: () => true,
      getNoteTitle: () => "Reading note",
      getNote: () => pending,
      setNote: (s: string) => {
        pending = s;
      },
      reload: async () => {
        if (fault === "unavailable" && writes) throw Error("offline");
        pending = stored;
      },
      saveTx: async () => {
        writes++;
        if (fault === "mismatch") stored = "<p>Different native content</p>";
        else if (!(fault === "lost_once" && writes === 1)) stored = pending;
        if (fault === "after_commit") throw Error("notifier failed");
        return true;
      },
    } as never;
    globalThis.Zotero = { DB: db, Items: { get: () => note } } as never;
    await initAgentChangeJournal();
  });
  afterEach(function () {
    globalThis.Zotero = original;
  });
  const context = () =>
    ({
      runId: "test-note-run",
      request: {
        conversationKey: 41,
        libraryID: 1,
        actionContract: { id: "requested-change" },
      },
    }) as never;
  const append = () =>
    executePreparedNoteChange({
      context: context(),
      note,
      mode: "append",
      html: "<p>Appended</p>",
    });
  it("persists one append and resolves repeated submissions through the same durable action", async function () {
    const first = await append();
    const second = await append();
    assert.equal(writes, 1);
    assert.equal(first.content.actionId, second.content.actionId);
    assert.equal((stored.match(/Appended/g) || []).length, 1);
    assert.lengthOf(await listJournalActions({ conversationKey: 41 }), 1);
    assert.equal(second.content.noteChange?.state, "applied");
  });
  it("keeps an applied native write uncertain when recording the action outcome fails", async function () {
    db.failWhen = (sql, params) =>
      sql.startsWith("UPDATE llm_for_zotero_agent_journal_actions_v2") &&
      params[0] === "applied"
        ? new Error("Outcome storage unavailable")
        : null;
    await rejects(append());
    assert.equal(writes, 1);
    assert.include(stored, "Appended");
    const [action] = await listJournalActions({ conversationKey: 41 });
    assert.equal(action.status, "uncertain");
    db.failWhen = undefined;
    const recovered = await append();
    assert.equal(recovered.effect, "applied");
    assert.equal(writes, 1);
  });
  it("reconciles an exception after native commit without writing again", async function () {
    fault = "after_commit";
    const result = await append();
    assert.equal(result.effect, "applied");
    assert.equal(writes, 1);
  });
  it("retries once only when native readback proves the original remains", async function () {
    fault = "lost_once";
    await append();
    assert.equal(writes, 2);
  });
  it("preserves a different native result and the intended payload", async function () {
    fault = "mismatch";
    await rejects(append());
    assert.equal(writes, 1);
    assert.equal(stored, "<p>Different native content</p>");
    const [action] = await listJournalActions({ conversationKey: 41 });
    assert.equal(action.status, "uncertain");
    assert.include(action.steps[0].forwardJson, "Appended");
  });
  it("resolves interrupted verification after restart without repeating the append", async function () {
    fault = "unavailable";
    await rejects(append());
    fault = "none";
    await initAgentChangeJournal();
    const result = await append();
    assert.equal(writes, 1);
    assert.equal(result.effect, "applied");
  });
  it("preserves an edit made while image finalization was pending", async function () {
    await rejects(
      executePreparedNoteChange({
        context: context(),
        note,
        mode: "append",
        html: "<p>Pending figure</p>",
        finalizeHtml: async () => {
          stored = "<p>User edited during import</p>";
          return '<p>Requested figure</p><img data-attachment-key="IMAGE001">';
        },
      }),
      /another change|changed/,
    );
    assert.equal(writes, 0);
    assert.equal(stored, "<p>User edited during import</p>");
  });
  it("rejects a stale prepared before-state without writing", async function () {
    await rejects(
      executePreparedNoteChange({
        context: context(),
        note,
        mode: "edit",
        html: "<p>New</p>",
        expectedOriginalHtml: "<p>Stale</p>",
      }),
    );
    assert.equal(writes, 0);
  });
});
