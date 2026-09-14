import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestNoteFixture,
  WorkflowTestStandaloneNoteFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function diagnosticsMessage(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("workflow: startup chat restoration", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  const fixtures: Array<
    | WorkflowTestFixture
    | WorkflowTestNoteFixture
    | WorkflowTestStandaloneNoteFixture
  > = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    await api.closeStandalone();
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("restores the last embedded paper conversation on startup", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Fresh Startup Paper",
      pdfTitle: "Workflow Fresh Startup PDF",
    });
    fixtures.push(fixture);

    const initialPanel = await api.renderPanelForItem(fixture.parentItemId);
    await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      "workflow original paper conversation marker",
    );
    const newConversation = await api.startNewPanelConversation(
      initialPanel.panelId,
    );
    const startupMarker = "workflow restored paper startup marker";
    const lastDiagnostics = await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      startupMarker,
    );
    const lastKey = lastDiagnostics.conversationKey;
    assert.isOk(lastKey, diagnosticsMessage(lastDiagnostics));
    assert.equal(
      lastKey,
      newConversation.conversationKey,
      diagnosticsMessage(lastDiagnostics),
    );
    assert.notEqual(
      lastKey,
      fixture.parentItemId,
      diagnosticsMessage(lastDiagnostics),
    );
    assert.include(
      lastDiagnostics.messageText || "",
      startupMarker,
      diagnosticsMessage(lastDiagnostics),
    );

    const startupPanel = await api.renderStartupPanelForItem(
      fixture.parentItemId,
    );
    const startupDiagnostics = await api.getDiagnostics(startupPanel.panelId);
    assert.equal(
      startupDiagnostics.conversationKind,
      "paper",
      diagnosticsMessage(startupDiagnostics),
    );
    assert.equal(
      startupDiagnostics.conversationKey,
      lastKey,
      diagnosticsMessage(startupDiagnostics),
    );
    assert.include(
      startupDiagnostics.messageText || "",
      startupMarker,
      diagnosticsMessage(startupDiagnostics),
    );
  });

  it("restores the active Paper Chat context badge from its full-text route", async function () {
    const title = "Workflow Restart Active Paper";
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: "Workflow Restart Active Paper PDF",
    });
    fixtures.push(fixture);

    const initialPanel = await api.renderPanelForItem(fixture.pdfAttachmentId);
    const paperContext = initialPanel.contextSnapshot?.paperContext;
    assert.isOk(paperContext, diagnosticsMessage(initialPanel));
    await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      "workflow paper sent-context restart marker",
      {
        paperContexts: [paperContext!],
        fullTextPaperContexts: [
          { ...paperContext!, contentSourceMode: "mineru" },
        ],
      },
    );

    const startupPanel = await api.renderStartupPanelForItem(
      fixture.pdfAttachmentId,
    );
    const restored = await api.getDiagnostics(startupPanel.panelId);

    assert.deepEqual(
      restored.sentContextBadgeLabels,
      ["Papers"],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.sentContextItemLabels,
      [title],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.composerPaperContextKeys,
      [`${paperContext!.itemId}:${paperContext!.contextItemId}`],
      diagnosticsMessage(restored),
    );

    const followUp = await api.ask(
      startupPanel.panelId,
      "workflow paper continuation marker",
    );
    assert.equal(
      followUp.contextSource?.paperContext?.itemId,
      paperContext!.itemId,
    );
    assert.equal(
      followUp.contextSource?.paperContext?.contextItemId,
      paperContext!.contextItemId,
    );
    assert.deepEqual(followUp.paperContexts || [], []);
    assert.deepEqual(followUp.fullTextPaperContexts || [], []);
    assert.deepEqual(followUp.pdfPaperContexts || [], []);
  });

  it("restores library mode and its last conversation on startup", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Library Startup Paper",
      pdfTitle: "Workflow Library Startup PDF",
    });
    fixtures.push(fixture);

    const initialPanel = await api.renderPanelForItem(fixture.parentItemId);
    await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      "workflow original paper before library mode",
    );
    const libraryMode = await api.togglePanelConversationMode(
      initialPanel.panelId,
    );
    assert.equal(
      libraryMode.conversationKind,
      "global",
      diagnosticsMessage(libraryMode),
    );
    await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      "workflow original library conversation marker",
    );
    const newConversation = await api.startNewPanelConversation(
      initialPanel.panelId,
    );
    const startupMarker = "workflow restored library startup marker";
    const lastDiagnostics = await api.seedPanelStoredUserMessage(
      initialPanel.panelId,
      startupMarker,
    );
    const lastKey = lastDiagnostics.conversationKey;
    assert.isOk(lastKey, diagnosticsMessage(lastDiagnostics));
    assert.equal(
      lastKey,
      newConversation.conversationKey,
      diagnosticsMessage(lastDiagnostics),
    );

    const startupPanel = await api.renderStartupPanelForItem(
      fixture.parentItemId,
    );
    const startupDiagnostics = await api.getDiagnostics(startupPanel.panelId);
    assert.equal(
      startupDiagnostics.conversationKind,
      "global",
      diagnosticsMessage(startupDiagnostics),
    );
    assert.equal(
      startupDiagnostics.conversationKey,
      lastKey,
      diagnosticsMessage(startupDiagnostics),
    );
    assert.include(
      startupDiagnostics.messageText || "",
      startupMarker,
      diagnosticsMessage(startupDiagnostics),
    );

    const standalone = await api.openStandaloneForLibraryAfterRestart();
    assert.equal(standalone.activeTab, "open", diagnosticsMessage(standalone));
    assert.equal(
      standalone.conversationKey,
      lastKey,
      diagnosticsMessage(standalone),
    );
    assert.include(
      standalone.messageText || "",
      startupMarker,
      diagnosticsMessage(standalone),
    );
  });

  it("restores Library Chat paper, collection, and tag badges after startup", async function () {
    const active = await api.createPaperWithPdfFixture({
      title: "Workflow Restart Library Host",
      pdfTitle: "Workflow Restart Library Host PDF",
    });
    const selected = await api.createPaperWithPdfFixture({
      title: "Workflow Restart Library Context",
      pdfTitle: "Workflow Restart Library Context PDF",
    });
    fixtures.push(active, selected);

    const panel = await api.renderPanelForItem(active.parentItemId);
    const libraryMode = await api.togglePanelConversationMode(panel.panelId);
    assert.equal(
      libraryMode.conversationKind,
      "global",
      diagnosticsMessage(libraryMode),
    );
    const selectedPaper = {
      itemId: selected.parentItemId,
      contextItemId: selected.pdfAttachmentId,
      title: "Workflow Restart Library Context",
      attachmentTitle: "Workflow Restart Library Context PDF",
    };
    await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow library sent-context restart marker",
      {
        paperContexts: [selectedPaper],
        fullTextPaperContexts: [
          { ...selectedPaper, contentSourceMode: "mineru" },
        ],
        selectedCollectionContexts: [
          {
            collectionId: 55,
            libraryID: Zotero.Libraries.userLibraryID,
            name: "Workflow Methods",
          },
        ],
        selectedTagContexts: [
          {
            libraryID: Zotero.Libraries.userLibraryID,
            name: "Workflow Stability",
            normalizedName: "workflow stability",
          },
        ],
      },
    );

    const startupPanel = await api.renderStartupPanelForItem(
      active.parentItemId,
    );
    const restored = await api.getDiagnostics(startupPanel.panelId);

    assert.deepEqual(
      restored.sentContextBadgeLabels,
      ["Collection", "Tag", "Papers"],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.sentContextItemLabels,
      [
        "Workflow Methods",
        "Workflow Stability",
        "Workflow Restart Library Context",
      ],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.composerPaperContextKeys,
      [`${selectedPaper.itemId}:${selectedPaper.contextItemId}`],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.composerCollectionLabels,
      ["Workflow Methods"],
      diagnosticsMessage(restored),
    );
    assert.deepEqual(
      restored.composerTagLabels,
      ["Workflow Stability"],
      diagnosticsMessage(restored),
    );

    const followUp = await api.ask(
      startupPanel.panelId,
      "workflow library continuation marker",
    );
    assert.deepEqual(
      (followUp.paperContexts || []).map(
        (paper) => `${paper.itemId}:${paper.contextItemId}`,
      ),
      [`${selectedPaper.itemId}:${selectedPaper.contextItemId}`],
    );
    assert.deepEqual(followUp.fullTextPaperContexts || [], []);
    assert.deepEqual(followUp.pdfPaperContexts || [], []);
    assert.lengthOf(followUp.selectedCollectionContexts || [], 1);
    assert.lengthOf(followUp.selectedTagContexts || [], 1);

    const standalone = await api.openStandaloneForLibraryAfterRestart();
    assert.deepEqual(
      standalone.composerPaperContextKeys,
      [`${selectedPaper.itemId}:${selectedPaper.contextItemId}`],
      diagnosticsMessage(standalone),
    );
    assert.deepEqual(
      standalone.composerCollectionLabels,
      ["Workflow Methods"],
      diagnosticsMessage(standalone),
    );
    assert.deepEqual(
      standalone.composerTagLabels,
      ["Workflow Stability"],
      diagnosticsMessage(standalone),
    );
  });

  it("keeps explicit new Paper and Library chats at their default context", async function () {
    const title = "Workflow New Conversation Defaults";
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: "Workflow New Conversation Defaults PDF",
    });
    fixtures.push(fixture);

    const panel = await api.renderPanelForItem(fixture.pdfAttachmentId);
    await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow context before new paper chat",
      {
        selectedCollectionContexts: [
          {
            collectionId: 77,
            libraryID: Zotero.Libraries.userLibraryID,
            name: "Old collection",
          },
        ],
      },
    );
    const restoredPanel = await api.renderStartupPanelForItem(
      fixture.pdfAttachmentId,
    );
    const restored = await api.getDiagnostics(restoredPanel.panelId);
    assert.deepEqual(
      restored.composerCollectionLabels,
      ["Old collection"],
      diagnosticsMessage(restored),
    );
    const newPaper = await api.startNewPanelConversation(
      restoredPanel.panelId,
      { allowReusedDraft: true },
    );
    assert.deepEqual(
      newPaper.composerPaperContextKeys,
      [`${fixture.parentItemId}:${fixture.pdfAttachmentId}`],
      diagnosticsMessage(newPaper),
    );
    assert.deepEqual(
      newPaper.composerCollectionLabels,
      [],
      diagnosticsMessage(newPaper),
    );
    assert.deepEqual(
      newPaper.composerTagLabels,
      [],
      diagnosticsMessage(newPaper),
    );

    const library = await api.togglePanelConversationMode(
      restoredPanel.panelId,
    );
    assert.equal(
      library.conversationKind,
      "global",
      diagnosticsMessage(library),
    );
    const newLibrary = await api.startNewPanelConversation(
      restoredPanel.panelId,
      { allowReusedDraft: true },
    );
    assert.deepEqual(
      newLibrary.composerPaperContextKeys,
      [],
      diagnosticsMessage(newLibrary),
    );
    assert.deepEqual(
      newLibrary.composerCollectionLabels,
      [],
      diagnosticsMessage(newLibrary),
    );
    assert.deepEqual(
      newLibrary.composerTagLabels,
      [],
      diagnosticsMessage(newLibrary),
    );
  });

  it("preserves a standalone note's own conversation after navigating into a paper and back", async function () {
    const standaloneNote = await api.createStandaloneNoteFixture({
      noteHtml: "<p>Workflow note navigation note.</p>",
    });
    const paper = await api.createPaperWithPdfFixture({
      title: "Workflow Note Navigation Paper",
      pdfTitle: "Workflow Note Navigation PDF",
    });
    fixtures.push(standaloneNote, paper);

    const startupPanel = await api.renderStartupPanelForItem(
      standaloneNote.noteItemId,
    );
    const marker = "workflow active note conversation marker";
    const activeNote = await api.seedPanelStoredUserMessage(
      startupPanel.panelId,
      marker,
    );
    // A note never borrows the library or a parent paper: it chats in its
    // own individual-item conversation keyed to the note.
    assert.equal(
      activeNote.conversationKind,
      "paper",
      diagnosticsMessage(activeNote),
    );
    assert.equal(
      activeNote.noteId,
      standaloneNote.noteItemId,
      diagnosticsMessage(activeNote),
    );

    await api.renderStartupPanelForItem(paper.parentItemId);
    const returnedPanel = await api.renderStartupPanelForItem(
      standaloneNote.noteItemId,
    );
    const returnedNote = await api.getDiagnostics(returnedPanel.panelId);

    assert.equal(
      returnedNote.conversationKey,
      activeNote.conversationKey,
      diagnosticsMessage(returnedNote),
    );
    assert.equal(
      returnedNote.noteId,
      standaloneNote.noteItemId,
      diagnosticsMessage(returnedNote),
    );
    assert.include(
      returnedNote.messageText || "",
      marker,
      diagnosticsMessage(returnedNote),
    );
  });

  it("preserves the active paper conversation when opening a standalone window after startup", async function () {
    const paper = await api.createPaperWithPdfFixture({
      title: "Workflow Standalone Persistence Paper",
      pdfTitle: "Workflow Standalone Persistence PDF",
    });
    fixtures.push(paper);

    const startupPanel = await api.renderStartupPanelForItem(
      paper.parentItemId,
    );
    const marker = "workflow active paper standalone marker";
    const activePaper = await api.seedPanelStoredUserMessage(
      startupPanel.panelId,
      marker,
    );

    const standalone = await api.openStandaloneForItem(paper.parentItemId);

    assert.equal(
      standalone.conversationKey,
      activePaper.conversationKey,
      diagnosticsMessage(standalone),
    );
    assert.include(
      standalone.messageText || "",
      marker,
      diagnosticsMessage(standalone),
    );
  });

  it("titles standalone item-note windows with the note itself, not its parent paper", async function () {
    const fixture = await api.createItemNoteFixture({
      title: "Workflow Standalone Item Note Parent",
      pdfTitle: "Workflow Standalone Item Note PDF",
      noteHtml: "<p>Workflow item note title</p><p>Body.</p>",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(fixture.noteItemId);
    assert.equal(
      diagnostics.activeTab,
      "paper",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(
      diagnostics.conversationKind,
      "paper",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(diagnostics.paperTabText, "Note chat");
    assert.equal(
      diagnostics.titleText,
      "Workflow item note title",
      diagnosticsMessage(diagnostics),
    );
  });

  it("titles standalone standalone-note windows with the note itself, not library chat", async function () {
    const fixture = await api.createStandaloneNoteFixture({
      noteHtml: "<p>Workflow standalone note title</p><p>Body.</p>",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(fixture.noteItemId);
    assert.equal(
      diagnostics.activeTab,
      "paper",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(
      diagnostics.conversationKind,
      "paper",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(diagnostics.paperTabText, "Note chat");
    assert.equal(
      diagnostics.titleText,
      "Workflow standalone note title",
      diagnosticsMessage(diagnostics),
    );
  });
});
