import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";

describe("workflow: append to an open native note", function () {
  this.timeout(60000);
  it("persists an approved addition once while the editor is mounted", async function () {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(
      '<div data-schema-version="9"><h1>Append workflow</h1>\n<p>Keep this paragraph.</p>\n</div>',
    );
    await note.saveTx();
    let editor: any;
    try {
      editor = await (Zotero.Notes as any).open(note.id);
      await Zotero.Promise.delay(500);
      await initAgentChangeJournal();
      const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "note_write",
      );
      const input = tool.validate({
        mode: "append",
        targetNoteId: note.id,
        content: "One new paragraph.",
      });
      assert.isTrue(input.ok);
      const context = {
        request: {
          conversationKey: note.id,
          mode: "agent",
          userText: "Append one paragraph to this note",
          libraryID: note.libraryID,
        },
        item: note,
        modelName: "workflow",
        currentAnswerText: "",
      };
      const action = await tool.createPendingAction(input.value, context);
      assert.include(note.getNote(), "Keep this paragraph.");
      assert.notInclude(note.getNote(), "One new paragraph.");
      const approved = await tool.applyConfirmation(
        input.value,
        { content: "One new paragraph." },
        context,
      );
      assert.isTrue(approved.ok);
      await tool.execute(approved.value, context);
      await Zotero.Promise.delay(500);
      await note.reload(["note"], true);
      assert.include(note.getNote(), "Keep this paragraph.");
      assert.equal(
        (note.getNote().match(/One new paragraph\./g) || []).length,
        1,
      );
      assert.equal(action.mode, "review");
    } finally {
      if (editor?.tabID)
        (Zotero.getMainWindow() as any).Zotero_Tabs.close(editor.tabID);
      await note.eraseTx();
    }
  });
});
