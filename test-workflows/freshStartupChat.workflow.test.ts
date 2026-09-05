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

  it("preserves the active library conversation after navigating into a paper and back", async function () {
    const standaloneNote = await api.createStandaloneNoteFixture({
      noteHtml: "<p>Workflow library navigation note.</p>",
    });
    const paper = await api.createPaperWithPdfFixture({
      title: "Workflow Library Navigation Paper",
      pdfTitle: "Workflow Library Navigation PDF",
    });
    fixtures.push(standaloneNote, paper);

    const startupPanel = await api.renderStartupPanelForItem(
      standaloneNote.noteItemId,
    );
    const marker = "workflow active library conversation marker";
    const activeLibrary = await api.seedPanelStoredUserMessage(
      startupPanel.panelId,
      marker,
    );
    assert.equal(
      activeLibrary.conversationKind,
      "global",
      diagnosticsMessage(activeLibrary),
    );

    await api.renderStartupPanelForItem(paper.parentItemId);
    const returnedPanel = await api.renderStartupPanelForItem(
      standaloneNote.noteItemId,
    );
    const returnedLibrary = await api.getDiagnostics(returnedPanel.panelId);

    assert.equal(
      returnedLibrary.conversationKey,
      activeLibrary.conversationKey,
      diagnosticsMessage(returnedLibrary),
    );
    assert.include(
      returnedLibrary.messageText || "",
      marker,
      diagnosticsMessage(returnedLibrary),
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

  it("labels standalone item-note windows as ordinary paper chat", async function () {
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
    assert.equal(diagnostics.paperTabText, "Paper chat");
    assert.equal(
      diagnostics.titleText,
      "Workflow Standalone Item Note Parent",
      diagnosticsMessage(diagnostics),
    );
  });

  it("labels standalone standalone-note windows as ordinary library chat", async function () {
    const fixture = await api.createStandaloneNoteFixture({
      noteHtml: "<p>Workflow standalone note title</p><p>Body.</p>",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(fixture.noteItemId);
    assert.equal(
      diagnostics.activeTab,
      "open",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(diagnostics.openTabText, "Library chat");
    assert.equal(
      diagnostics.titleText,
      "Library chat",
      diagnosticsMessage(diagnostics),
    );
  });
});
