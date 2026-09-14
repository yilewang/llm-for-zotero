import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { stripZoteroNoteWrapper } from "../src/modules/contextPanel/notePersistence";

describe("workflow: multiline note patch review and undo", function () {
  this.timeout(60000);

  it("carries a multiline selection through review, preserves native structure and images, and undoes exactly", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const fixture = await api.createItemNoteFixture({
      title: "Multiline patch parent",
      pdfTitle: "Multiline patch source",
      noteHtml:
        "<h2>Keep heading</h2><p>First paragraph</p><p>Second paragraph</p><p>Keep trailing paragraph.</p>",
    });
    const note = Zotero.Items.get(fixture.noteItemId);
    try {
      const win = Zotero.getMainWindow() as any;
      const pixels = Uint8Array.from(
        win.atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBc8AAAAASUVORK5CYII=",
        ),
        (c: string) => c.charCodeAt(0),
      );
      const image = await Zotero.Attachments.importEmbeddedImage({
        blob: new win.Blob([pixels], { type: "image/png" }),
        parentItemID: note.id,
      });
      note.setNote(
        `<h2>Keep heading</h2><p><strong>First paragraph</strong><img data-attachment-key="${image.key}"/></p><p>Second paragraph</p><p>Keep trailing paragraph.</p>`,
      );
      await note.saveTx();
      await note.reload(["note"], true);
      const before = note.getNote();
      const panel = await api.renderPanelForItem(note.id);
      await api.selectNoteEditorText(
        panel.panelId,
        "First paragraph\n\nSecond paragraph",
      );
      const send = await api.ask(
        panel.panelId,
        "Replace the selected text with Revised summary. Preserve formatting and the image.",
      );
      assert.deepEqual(send.selectedTextSources, ["note-edit"]);
      assert.equal(send.selectedTextNoteContexts?.[0]?.noteItemId, note.id);
      await initAgentChangeJournal();
      const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "note_write",
      );
      const input = tool.validate({
        mode: "edit",
        targetNoteId: note.id,
        patches: [
          { find: send.selectedTexts![0], replace: "Revised summary." },
        ],
      });
      assert.isTrue(input.ok);
      const context = {
        request: {
          conversationKey: fixture.parentItemId,
          mode: "agent" as const,
          libraryID: note.libraryID,
          userText: "Replace the selected text",
          activeItemId: note.id,
        },
        runId: `multiline-patch:${note.key}`,
        item: note,
        modelName: "workflow",
        currentAnswerText: "",
      };
      await tool.planInvocation(input.value, context);
      const action = await tool.createPendingAction(input.value, context);
      assert.equal(note.getNote(), before);
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "multiline-patch-review",
        action,
      });
      const card = Zotero.getMainWindow().document.querySelector<HTMLElement>(
        '[data-request-id="multiline-patch-review"]',
      )!;
      assert.isOk(card);
      assert.include(
        card.querySelector(".llm-note-review-preview")!.textContent,
        "Revised summary.",
      );
      assert.isTrue(
        card.querySelector<HTMLDetailsElement>(".llm-note-review-changes")!
          .open,
      );
      card.querySelector<HTMLButtonElement>('[data-kind="save"]')!.click();
      const resolution = await pending;
      assert.isTrue(resolution.approved);
      const approved = await tool.applyConfirmation(
        input.value,
        resolution.data,
        context,
      );
      assert.isTrue(approved.ok);
      await tool.execute(approved.value, context);
      await note.reload(["note"], true);
      const expected = before
        .replace("First paragraph", "Revised summary.")
        .replace("<p>Second paragraph</p>", "");
      assert.equal(
        stripZoteroNoteWrapper(note.getNote()),
        stripZoteroNoteWrapper(expected),
      );
      assert.deepEqual(note.getAttachments(), [image.id]);
      assert.isTrue(await image.fileExists());
      const actions = await listJournalActions({ runId: context.runId });
      assert.lengthOf(actions, 1);
      const outcome = await revertActions({
        actions,
        zoteroGateway: new ZoteroGateway(),
        context: context as any,
      });
      assert.equal(outcome.reverted, 1);
      await note.reload(["note"], true);
      assert.equal(
        stripZoteroNoteWrapper(note.getNote()),
        stripZoteroNoteWrapper(before),
      );
      assert.deepEqual(note.getAttachments(), [image.id]);
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
