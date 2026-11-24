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
  it("a note chat shows its paper as a removable chip", async function () {
    const panel = await api().renderPanelForItem(fixture.noteItemId);
    const diagnostics = await api().getDiagnostics(panel.panelId);
    assert.equal(diagnostics.noteId, fixture.noteItemId);
    assert.ok(
      (diagnostics.composerPaperContextKeys || []).some((key: string) =>
        key.startsWith(`${fixture.parentItemId}:`),
      ),
      JSON.stringify(diagnostics.composerPaperContextKeys),
    );
  });

  /** The paper's chat with its note open beside it, once the note's chip shows. */
  async function openNoteBesidePaperChat() {
    const win = Zotero.getMainWindow() as any;
    const panel = await api().renderPanelForItem(fixture.parentItemId);
    const noteLabel = `Note ${fixture.noteItemId}`;
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(fixture.noteItemId);

    const labels = async (): Promise<string[]> =>
      (await api().getDiagnostics(panel.panelId)).selectedContextLabels || [];
    const deadline = Date.now() + 10000;
    while (!(await labels()).includes(noteLabel) && Date.now() < deadline)
      await Zotero.Promise.delay(100);
    assert.include(await labels(), noteLabel, "the open note is attached");
    return { win, panel, noteLabel, labels };
  }

  it("the paper chat beside an open note carries the note as a removable chip", async function () {
    const { win, panel, noteLabel, labels } = await openNoteBesidePaperChat();
    const diagnostics = await api().getDiagnostics(panel.panelId);
    assert.ok(
      (diagnostics.composerPaperContextKeys || []).some((key: string) =>
        key.startsWith(`${fixture.parentItemId}:`),
      ),
      "the paper chip stays beside it",
    );

    const body = win.document.querySelector(
      `[data-workflow-panel-id='${panel.panelId}']`,
    ) as HTMLElement;
    (
      body.querySelector(
        ".llm-note-context-chip .llm-selected-context-clear",
      ) as HTMLElement
    ).click();
    await Zotero.Promise.delay(3000);
    assert.notInclude(
      await labels(),
      noteLabel,
      "a removed note chip stays removed",
    );

    await win.ZoteroPane.selectItem(fixture.parentItemId);
    await Zotero.Promise.delay(3000);
    await win.ZoteroPane.selectItem(fixture.noteItemId);
    await Zotero.Promise.delay(3000);
    assert.notInclude(
      await labels(),
      noteLabel,
      "it stays removed when the note is closed and opened again",
    );
  });

  it("sends the open note with every message, as it is when the message is sent", async function () {
    const { panel, noteLabel, labels } = await openNoteBesidePaperChat();

    const first = await api().ask(panel.panelId, "What does my note say?");
    assert.include(
      (first.selectedTexts || []).join("\n"),
      "Notes taken while reading.",
    );
    assert.include(
      await labels(),
      noteLabel,
      "the open note's chip outlives the send",
    );

    // The user keeps writing; the next message carries the note as it is now.
    const note = Zotero.Items.get(fixture.noteItemId);
    note.setNote("<p>Notes rewritten after the first answer.</p>");
    await note.saveTx();
    const second = await api().ask(panel.panelId, "And what does it say now?");
    assert.include(
      (second.selectedTexts || []).join("\n"),
      "Notes rewritten after the first answer.",
    );
  });

  it("sends a note that was closed once more, and attaches it again when it is reopened", async function () {
    const { win, panel, noteLabel, labels } = await openNoteBesidePaperChat();

    await win.ZoteroPane.selectItem(fixture.parentItemId);
    // The note tracker's safety-net check runs every two seconds.
    await Zotero.Promise.delay(3000);
    assert.include(
      await labels(),
      noteLabel,
      "closing the note leaves its chip",
    );

    await api().ask(panel.panelId, "One more question about that note");
    assert.notInclude(
      await labels(),
      noteLabel,
      "a closed note's chip goes with the next message",
    );

    await win.ZoteroPane.selectItem(fixture.noteItemId);
    const deadline = Date.now() + 10000;
    while (!(await labels()).includes(noteLabel) && Date.now() < deadline)
      await Zotero.Promise.delay(100);
    assert.include(await labels(), noteLabel, "reopening the note attaches it");
  });
});
