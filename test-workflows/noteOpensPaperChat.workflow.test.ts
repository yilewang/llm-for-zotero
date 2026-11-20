import "./hostSurfaceBootstrap";
import { assert } from "chai";

/**
 * Opening a note is a place to write, not a new conversation (issue #577):
 * the sidebar keeps the parent paper's chat, and a note's own chats stay
 * reachable from that paper's history.
 */
describe("workflow: opening a note keeps its paper's chat", function () {
  this.timeout(60000);

  const api = () => (Zotero as any).LLMForZotero.api.workflowTest;

  /** Diagnostics once the panel shows `marker` (history loads after mount). */
  async function waitForMessage(panelId: string, marker: string) {
    const deadline = Date.now() + 10000;
    let diagnostics = await api().getDiagnostics(panelId);
    while (
      !(diagnostics.messageText || "").includes(marker) &&
      Date.now() < deadline
    ) {
      await Zotero.Promise.delay(50);
      diagnostics = await api().getDiagnostics(panelId);
    }
    return diagnostics;
  }
  let fixture: any = null;

  beforeEach(async function () {
    await api().reset();
    fixture = await api().createItemNoteFixture({
      title: "Note keeps paper chat parent",
      pdfTitle: "Note keeps paper chat PDF",
      noteHtml: "<p>Notes taken while reading.</p>",
    });
  });

  afterEach(async function () {
    await api().reset();
    if (fixture) await api().cleanupFixture(fixture);
    fixture = null;
  });

  it("shows the parent paper's chat, not a note chat, when the note is opened", async function () {
    const paperPanel = await api().renderPanelForItem(fixture.parentItemId);
    const paper = await api().seedPanelStoredUserMessage(
      paperPanel.panelId,
      "paper chat marker",
    );

    const notePanel = await api().renderStartupPanelForItem(fixture.noteItemId);
    const opened = await waitForMessage(notePanel.panelId, "paper chat marker");

    assert.equal(opened.conversationKind, "paper");
    assert.notOk(opened.noteId, JSON.stringify(opened));
    assert.equal(opened.conversationKey, paper.conversationKey);
    assert.include(opened.messageText || "", "paper chat marker");
  });

  it("lists a note's chat in its paper's history and moves between the two", async function () {
    // A note chat from before this change, or opened from the history.
    const noteChatPanel = await api().renderPanelForItem(fixture.noteItemId);
    const mounted = await api().getDiagnostics(noteChatPanel.panelId);
    assert.equal(mounted.noteId, fixture.noteItemId, JSON.stringify(mounted));
    const noteChat = await api().seedPanelStoredUserMessage(
      noteChatPanel.panelId,
      "note chat marker",
    );
    assert.equal(
      noteChat.noteId,
      fixture.noteItemId,
      JSON.stringify({ ...noteChat, contextSnapshot: undefined }),
    );

    const paperPanel = await api().renderStartupPanelForItem(
      fixture.noteItemId,
    );
    const paper = await api().seedPanelStoredUserMessage(
      paperPanel.panelId,
      "paper chat marker",
    );
    assert.notOk(paper.noteId);

    const paperHistory = await api().listPanelHistory(paperPanel.panelId);
    const noteRow = paperHistory.find(
      (row: any) => row.conversationKey === noteChat.conversationKey,
    );
    assert.ok(noteRow, JSON.stringify(paperHistory));
    assert.equal(noteRow.scopeLabel, "Note chat");

    const inNoteChat = await api().clickPanelHistoryRow(
      paperPanel.panelId,
      noteChat.conversationKey,
    );
    assert.equal(inNoteChat.noteId, fixture.noteItemId);
    assert.include(inNoteChat.messageText || "", "note chat marker");

    const noteHistory = await api().listPanelHistory(paperPanel.panelId, {
      reopen: true,
    });
    assert.ok(
      noteHistory.some(
        (row: any) => row.conversationKey === paper.conversationKey,
      ),
      JSON.stringify(noteHistory),
    );

    const backInPaper = await api().clickPanelHistoryRow(
      paperPanel.panelId,
      paper.conversationKey,
    );
    assert.notOk(backInPaper.noteId);
    assert.include(backInPaper.messageText || "", "paper chat marker");
  });
});
