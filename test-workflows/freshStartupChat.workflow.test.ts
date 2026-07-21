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
