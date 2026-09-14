import { assert } from "chai";
import { executePreparedNoteChange } from "../src/agent/tools/write/preparedNoteChange";
import { executeNoteCreation } from "../src/agent/services/noteCreation";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { canonicalNoteHtml, noteHtmlMatches } from "../src/utils/noteHtml";
import { renderRawNoteHtml } from "../src/modules/contextPanel/notes";
import { persistVerifiedNoteHtml } from "../src/modules/contextPanel/notePersistence";

describe("workflow: verified note writing pipeline", function () {
  this.timeout(60000);
  it("creates once, appends once across retries, edits exactly, and preserves native evidence", async function () {
    await initAgentChangeJournal();
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Note pipeline disposable source");
    await paper.saveTx();
    let note: Zotero.Item | undefined;
    try {
      const context = {
        runId: `note-pipeline-${paper.id}`,
        request: { conversationKey: paper.id, libraryID: paper.libraryID },
        item: paper,
      } as never;
      const html = renderRawNoteHtml(
        '# Reading note\n\nA "stable" readout.\n\n- First result\n\n---',
      );
      const first = await executeNoteCreation({
        context,
        libraryID: paper.libraryID,
        parentItemId: paper.id,
        html,
      });
      note = Zotero.Items.get(first.content.noteId);
      const repeated = await executeNoteCreation({
        context,
        libraryID: paper.libraryID,
        parentItemId: paper.id,
        html,
      });
      assert.equal(repeated.content.noteId, note.id);
      await paper.reload(["childItems"], true);
      assert.deepEqual(paper.getNotes(), [note.id]);
      const params = {
        context,
        note,
        mode: "append" as const,
        html: "<p>Appended once.</p>",
      };
      const appended = await executePreparedNoteChange(params);
      const retry = await executePreparedNoteChange(params);
      assert.equal(appended.content.actionId, retry.content.actionId);
      await note.reload(["note"], true);
      assert.equal((note.getNote().match(/Appended once/g) || []).length, 1);
      const before = note.getNote();
      const edited = before.replace("Appended once.", "Edited once.");
      const result = await executePreparedNoteChange({
        context,
        note,
        mode: "edit",
        html: edited,
        expectedOriginalHtml: before,
      });
      await note.reload(["note"], true);
      assert.isTrue(noteHtmlMatches(note.getNote(), edited));
      assert.equal(result.content.noteVerification.matches, true);
      assert.equal(result.content.noteChange?.state, "applied");
      const [action] = await listJournalActions({
        actionId: result.content.actionId,
      });
      assert.equal(action.status, "applied");
      assert.include(action.steps[0].forwardJson, "Edited once.");
      assert.equal(
        canonicalNoteHtml(note.getNote()),
        canonicalNoteHtml(edited),
      );
    } finally {
      if (note) await note.eraseTx();
      await paper.eraseTx();
    }
  });

  it("accepts the recorded editor normalization while native reload still rejects real loss", async function () {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    const html =
      "<h1>Reading note</h1><ul><li>A &quot;stable&quot; readout.</li></ul><hr/>";
    const normalized =
      '<div data-schema-version="9"><h1>Reading note</h1>\n<ul>\n<li>\nA "stable" readout.\n</li>\n</ul>\n<hr>\n</div>';
    const save = note.saveTx.bind(note);
    let writes = 0;
    try {
      // Replay the captured editor serialization at the real native save boundary.
      note.saveTx = async (...args) => {
        writes++;
        note.setNote(normalized);
        return save(...args);
      };
      await persistVerifiedNoteHtml(note, html);
      await note.reload(["note"], true);
      assert.equal(writes, 1);
      assert.isTrue(noteHtmlMatches(note.getNote(), html));
    } finally {
      note.saveTx = save;
      if (note.id) await note.eraseTx();
    }
  });
});
