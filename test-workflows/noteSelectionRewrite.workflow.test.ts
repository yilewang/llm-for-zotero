import { assert } from "chai";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { noteHtmlMatches } from "../src/utils/noteHtml";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

describe("workflow: selected note structure", function () {
  this.timeout(60000);
  for (const selection of [false, true])
    it(`${selection ? "selection" : "patches"}: rewrites the selection without empty bullets, verifies one change, and undoes exactly`, async function () {
      const api = (Zotero as any).LLMForZotero.api;
      await api.workflowTest.reset();
      await initAgentChangeJournal();
      const fixture = await api.workflowTest.createItemNoteFixture({
        title: "Selected rewrite source",
        pdfTitle: "Selection context",
        noteHtml:
          "<h2>Methodology</h2><ul><li>Simulated recordings across twelve sessions.</li><li>A decoder fitted on session one.</li><li>Control shuffled neuron identities.</li></ul><h2>Limitations</h2><p>Keep this unchanged.</p>",
      });
      const note = Zotero.Items.get(fixture.noteItemId);
      try {
        const before = note.getNote();
        const panel = await api.workflowTest.renderPanelForItem(note.id);
        const selected =
          "Simulated recordings across twelve sessions.\nA decoder fitted on session one.\nControl shuffled neuron identities.";
        await api.workflowTest.selectNoteEditorText(panel.panelId, selected);
        const send = await api.workflowTest.ask(
          panel.panelId,
          "Rewrite this part as one concise paragraph.",
        );
        assert.deepEqual(send.selectedTextSources, ["note-edit"]);
        const tool = api.agent.getToolDefinition("note_write");
        const validated = tool.validate({
          mode: "edit",
          targetNoteId: note.id,
          ...(selection
            ? {
                selection: {
                  index: 1,
                  replacement:
                    "Across twelve sessions, a decoder trained on session one was compared with a shuffled-identity control.",
                },
              }
            : {
                patches: [
                  {
                    find: send.selectedTexts[0],
                    replace:
                      "Across twelve sessions, a decoder trained on session one was compared with a shuffled-identity control.",
                  },
                ],
              }),
        });
        assert.isTrue(validated.ok);
        const context = {
          runId: `selected-rewrite-${note.key}`,
          request: {
            conversationKey: note.id,
            mode: "agent",
            libraryID: note.libraryID,
            userText: "Rewrite this part as one concise paragraph.",
            activeItemId: note.id,
            selectedTexts: send.selectedTexts,
            selectedTextSources: send.selectedTextSources,
            selectedTextNoteContexts: send.selectedTextNoteContexts,
            activeNoteContext: {
              noteId: note.id,
              title: note.getNoteTitle(),
              noteKind: "item",
              noteText: before,
              noteHtml: before,
            },
          },
          item: note,
          modelName: "workflow",
          currentAnswerText: "",
        };
        await tool.planInvocation(validated.value, context);
        const result = await tool.execute(validated.value, context);
        await note.reload(["note"], true);
        assert.notMatch(
          note.getNote(),
          /<li[^>]*>\s*<\/li>/i,
          "a verified rewrite must not leave empty bullets",
        );
        assert.isTrue(
          noteHtmlMatches(
            note.getNote(),
            selection
              ? "<h2>Methodology</h2><p>Across twelve sessions, a decoder trained on session one was compared with a shuffled-identity control.</p><h2>Limitations</h2><p>Keep this unchanged.</p>"
              : "<h2>Methodology</h2><ul><li>Across twelve sessions, a decoder trained on session one was compared with a shuffled-identity control.</li></ul><h2>Limitations</h2><p>Keep this unchanged.</p>",
          ),
        );
        assert.isTrue(result.content.noteVerification.matches);
        assert.equal(result.content.noteChange.state, "applied");
        const actions = await listJournalActions({ runId: context.runId });
        assert.lengthOf(actions, 1);
        assert.equal(actions[0].status, "applied");
        const undone = await revertActions({
          actions,
          zoteroGateway: new ZoteroGateway(),
          context: context as never,
        });
        assert.equal(undone.reverted, 1);
        await note.reload(["note"], true);
        assert.isTrue(noteHtmlMatches(note.getNote(), before));
      } finally {
        await api.workflowTest.reset();
        await api.workflowTest.cleanupFixture(fixture);
      }
    });
});
