import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestAttachmentFixture,
  WorkflowTestFixture,
  WorkflowTestStandaloneDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";

type AnyFixture = WorkflowTestFixture | WorkflowTestAttachmentFixture;

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function diagnosticsMessage(
  diagnostics: WorkflowTestStandaloneDiagnostics,
): string {
  return JSON.stringify(
    {
      activeTab: diagnostics.activeTab,
      conversationKey: diagnostics.conversationKey,
      activeItemId: diagnostics.activeItemId,
      rawContextItemId: diagnostics.rawContextItemId,
      basePaperItemId: diagnostics.basePaperItemId,
      contextItemId: diagnostics.contextItemId,
      conversationKind: diagnostics.conversationKind,
      statusText: diagnostics.statusText,
      titleText: diagnostics.titleText,
      chipText: diagnostics.chipText,
      messageText: diagnostics.messageText,
      paperTabText: diagnostics.paperTabText,
      openTabText: diagnostics.openTabText,
      lastSend: diagnostics.lastSend
        ? {
            question: diagnostics.lastSend.question,
            contextSource: diagnostics.lastSend.contextSource,
            paperContexts: diagnostics.lastSend.paperContexts,
            fullTextPaperContexts: diagnostics.lastSend.fullTextPaperContexts,
          }
        : null,
    },
    null,
    2,
  );
}

describe("workflow: standalone document chat", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  const fixtures: AnyFixture[] = [];

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

  it("opens a top-level Zotero PDF attachment in Paper Chat and sends with attachment-owned context", async function () {
    const fixture = await api.createStandaloneAttachmentFixture({
      title: "Workflow Standalone PDF",
      filename: "workflow-standalone.pdf",
      contentType: "application/pdf",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(
      fixture.attachmentItemId,
    );
    assert.equal(
      diagnostics.activeTab,
      "paper",
      diagnosticsMessage(diagnostics),
    );
    assert.equal(
      diagnostics.basePaperItemId,
      fixture.attachmentItemId,
      diagnosticsMessage(diagnostics),
    );

    const send = await api.askStandalone("What is this document?");
    const postSendDiagnostics = await api.getStandaloneDiagnostics();
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.attachmentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
    assert.equal(
      send.contextSource?.paperContext?.contextItemId,
      fixture.attachmentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
  });

  it("opens a top-level Zotero Markdown attachment in Paper Chat with text source mode", async function () {
    const fixture = await api.createStandaloneAttachmentFixture({
      title: "Workflow Standalone Markdown",
      filename: "workflow-standalone.md",
      contentType: "text/markdown",
      text: "# Workflow Standalone Markdown\n\nA text attachment.",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(
      fixture.attachmentItemId,
    );
    assert.equal(
      diagnostics.activeTab,
      "paper",
      diagnosticsMessage(diagnostics),
    );

    const send = await api.askStandalone("Summarize this Markdown file.");
    const postSendDiagnostics = await api.getStandaloneDiagnostics();
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.attachmentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
    assert.equal(
      send.contextSource?.paperContext?.contextItemId,
      fixture.attachmentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
    assert.equal(
      send.contextSource?.paperContext?.contentSourceMode,
      "markdown",
      diagnosticsMessage(postSendDiagnostics),
    );
  });

  it("keeps unsupported standalone attachments in Library Chat with status feedback", async function () {
    const fixture = await api.createStandaloneAttachmentFixture({
      title: "Workflow Unsupported Archive",
      filename: "workflow-archive.zip",
      contentType: "application/zip",
      text: "not a supported document",
    });
    fixtures.push(fixture);

    const diagnostics = await api.openStandaloneForItem(
      fixture.attachmentItemId,
    );
    assert.equal(
      diagnostics.activeTab,
      "open",
      diagnosticsMessage(diagnostics),
    );

    const afterClick = await api.clickStandaloneTab("paper");
    assert.equal(afterClick.activeTab, "open", diagnosticsMessage(afterClick));
    assert.include(
      afterClick.statusText || "",
      "supported Zotero document",
      diagnosticsMessage(afterClick),
    );
  });

  it("returns from Library Chat to Paper Chat for a valid parent paper", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Parent Paper",
      pdfTitle: "Workflow Parent Paper PDF",
    });
    fixtures.push(fixture);

    const initial = await api.openStandaloneForItem(fixture.parentItemId);
    assert.equal(initial.activeTab, "paper", diagnosticsMessage(initial));
    assert.equal(
      initial.basePaperItemId,
      fixture.parentItemId,
      diagnosticsMessage(initial),
    );

    const openMode = await api.clickStandaloneTab("open");
    assert.equal(openMode.activeTab, "open", diagnosticsMessage(openMode));

    const paperMode = await api.clickStandaloneTab("paper");
    assert.equal(paperMode.activeTab, "paper", diagnosticsMessage(paperMode));
    assert.equal(
      paperMode.basePaperItemId,
      fixture.parentItemId,
      diagnosticsMessage(paperMode),
    );

    const send = await api.askStandalone("What is the paper about?");
    const postSendDiagnostics = await api.getStandaloneDiagnostics();
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.parentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
    assert.equal(
      send.contextSource?.paperContext?.contextItemId,
      fixture.pdfAttachmentId,
      diagnosticsMessage(postSendDiagnostics),
    );
  });

  it("adds right-click Zotero context to a new blank Library Chat", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Right Click Context Paper",
      pdfTitle: "Workflow Right Click Context PDF",
    });
    fixtures.push(fixture);

    const initial = await api.openStandaloneForItem(fixture.parentItemId);
    assert.equal(initial.activeTab, "paper", diagnosticsMessage(initial));

    const openMode = await api.clickStandaloneTab("open");
    assert.equal(openMode.activeTab, "open", diagnosticsMessage(openMode));
    const oldConversationKey = openMode.conversationKey;
    assert.isOk(oldConversationKey, diagnosticsMessage(openMode));

    const oldMarker = "workflow old library chat marker before right click";
    const oldChat = await api.seedStandaloneUserMessage(oldMarker);
    assert.include(
      oldChat.messageText || "",
      oldMarker,
      diagnosticsMessage(oldChat),
    );

    const afterContext = await api.addItemsAsStandaloneContext([
      fixture.parentItemId,
    ]);
    assert.equal(
      afterContext.activeTab,
      "open",
      diagnosticsMessage(afterContext),
    );
    assert.notEqual(
      afterContext.conversationKey,
      oldConversationKey,
      diagnosticsMessage(afterContext),
    );
    assert.notInclude(
      afterContext.messageText || "",
      oldMarker,
      diagnosticsMessage(afterContext),
    );
    assert.include(
      (afterContext.statusText || "").toLowerCase(),
      "context added",
      diagnosticsMessage(afterContext),
    );
    assert.isAtLeast(
      afterContext.chipText.length,
      1,
      diagnosticsMessage(afterContext),
    );

    const send = await api.askStandalone("Use the newly added paper context.");
    const postSendDiagnostics = await api.getStandaloneDiagnostics();
    assert.equal(
      send.paperContexts?.[0]?.itemId,
      fixture.parentItemId,
      diagnosticsMessage(postSendDiagnostics),
    );
    assert.equal(
      send.paperContexts?.[0]?.contextItemId,
      fixture.pdfAttachmentId,
      diagnosticsMessage(postSendDiagnostics),
    );
  });
});
