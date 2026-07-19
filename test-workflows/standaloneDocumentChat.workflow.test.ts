import { assert } from "chai";
import { isConversationKeyForKind } from "../src/shared/conversationKeySpace";
import type {
  WorkflowTestApi,
  WorkflowTestAttachmentFixture,
  WorkflowTestFixture,
  WorkflowTestStandaloneDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";

type AnyFixture = WorkflowTestFixture | WorkflowTestAttachmentFixture;
const PREF_PREFIX = "extensions.zotero.llmforzotero";

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value, true);
      }
    }
  }
}

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

function assertDualRuntimeControls(
  diagnostics: WorkflowTestStandaloneDiagnostics,
  activeSystem?: "codex" | "claude_code",
): void {
  const visible = diagnostics.runtimeSystemToggles.filter(
    (toggle) => toggle.visible,
  );
  const active = visible.filter((toggle) => toggle.active);
  assert.deepEqual(
    visible.map((toggle) => toggle.system),
    ["codex", "claude_code"],
    diagnosticsMessage(diagnostics),
  );
  assert.deepEqual(
    active.map((toggle) => toggle.system),
    activeSystem ? [activeSystem] : [],
    diagnosticsMessage(diagnostics),
  );
  for (const toggle of visible) {
    assert.equal(toggle.active, toggle.ariaPressed);
    assert.isFalse(toggle.disabled);
  }
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
    const paperConversationKey = initial.conversationKey;
    const paperMarker = "workflow remembered paper chat";
    await api.seedStandaloneUserMessage(paperMarker);

    const openMode = await api.clickStandaloneTab("open");
    assert.equal(openMode.activeTab, "open", diagnosticsMessage(openMode));
    const libraryConversationKey = openMode.conversationKey;
    assert.notEqual(
      libraryConversationKey,
      paperConversationKey,
      diagnosticsMessage(openMode),
    );
    const libraryMarker = "workflow remembered library chat";
    await api.seedStandaloneUserMessage(libraryMarker);

    const paperMode = await api.clickStandaloneTab("paper");
    assert.equal(paperMode.activeTab, "paper", diagnosticsMessage(paperMode));
    assert.equal(
      paperMode.conversationKey,
      paperConversationKey,
      diagnosticsMessage(paperMode),
    );
    assert.equal(
      paperMode.basePaperItemId,
      fixture.parentItemId,
      diagnosticsMessage(paperMode),
    );
    assert.include(
      paperMode.messageText || "",
      paperMarker,
      diagnosticsMessage(paperMode),
    );
    assert.notInclude(
      paperMode.messageText || "",
      libraryMarker,
      diagnosticsMessage(paperMode),
    );

    const restoredLibraryMode = await api.clickStandaloneTab("open");
    assert.equal(
      restoredLibraryMode.activeTab,
      "open",
      diagnosticsMessage(restoredLibraryMode),
    );
    assert.equal(
      restoredLibraryMode.conversationKey,
      libraryConversationKey,
      diagnosticsMessage(restoredLibraryMode),
    );
    assert.include(
      restoredLibraryMode.messageText || "",
      libraryMarker,
      diagnosticsMessage(restoredLibraryMode),
    );
    assert.notInclude(
      restoredLibraryMode.messageText || "",
      paperMarker,
      diagnosticsMessage(restoredLibraryMode),
    );

    const restoredPaperMode = await api.clickStandaloneTab("paper");
    assert.equal(
      restoredPaperMode.conversationKey,
      paperConversationKey,
      diagnosticsMessage(restoredPaperMode),
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

  it("switches both standalone Library Chat runtimes without resuming a nonblank chat", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: true,
        conversationSystem: "upstream",
      },
      async () => {
        const fixture = await api.createPaperWithPdfFixture({
          title: "Dual Runtime Standalone Parent",
          pdfTitle: "Dual Runtime Standalone PDF",
        });
        fixtures.push(fixture);

        await api.openStandaloneForItem(fixture.parentItemId);
        const initial = await api.clickStandaloneTab("open");
        assert.equal(initial.conversationSystem, "upstream");
        assert.equal(initial.conversationKind, "global");
        assertDualRuntimeControls(initial);
        const geometry = await api.measureStandaloneRuntimeGeometry({
          width: 500,
          fontScale: 1.8,
        });
        assert.closeTo(geometry.containerWidth, 500, 1);
        assert.isAtLeast(geometry.runtimeWidth, 50, JSON.stringify(geometry));
        assert.isFalse(geometry.runtimeIntersectsLeadingContent);
        assert.isTrue(geometry.runtimeWithinContainer);
        assert.closeTo(geometry.centeredContentOffset, 0, 1);

        const rapid = await api.clickStandaloneSystemTogglesRapidly([
          "codex",
          "claude_code",
        ]);
        assert.equal(
          rapid.conversationSystem,
          "claude_code",
          "the standalone generation guard must let the final click win",
        );
        assertDualRuntimeControls(rapid, "claude_code");
        const resetUpstream =
          await api.clickStandaloneSystemToggle("claude_code");
        assert.equal(resetUpstream.conversationSystem, "upstream");

        const codex = await api.clickStandaloneSystemToggle("codex");
        assert.equal(codex.conversationSystem, "codex");
        assert.isTrue(
          isConversationKeyForKind(
            "codex",
            "global",
            codex.conversationKey || 0,
          ),
          diagnosticsMessage(codex),
        );
        assertDualRuntimeControls(codex, "codex");
        const codexKey = codex.conversationKey;
        const codexMarker = "nonblank standalone Codex library chat";
        await api.seedStandaloneUserMessage(codexMarker);

        const claude = await api.clickStandaloneSystemToggle("claude_code");
        assert.equal(claude.conversationSystem, "claude_code");
        assert.isTrue(
          isConversationKeyForKind(
            "claude_code",
            "global",
            claude.conversationKey || 0,
          ),
          diagnosticsMessage(claude),
        );
        assertDualRuntimeControls(claude, "claude_code");

        const upstream = await api.clickStandaloneSystemToggle("claude_code");
        assert.equal(upstream.conversationSystem, "upstream");
        assert.isTrue(
          isConversationKeyForKind(
            "upstream",
            "global",
            upstream.conversationKey || 0,
          ),
          diagnosticsMessage(upstream),
        );
        assertDualRuntimeControls(upstream);

        const freshCodex = await api.clickStandaloneSystemToggle("codex");
        assert.equal(freshCodex.conversationSystem, "codex");
        assert.notEqual(
          freshCodex.conversationKey,
          codexKey,
          diagnosticsMessage(freshCodex),
        );
        assert.notInclude(
          freshCodex.messageText || "",
          codexMarker,
          diagnosticsMessage(freshCodex),
        );
        assertDualRuntimeControls(freshCodex, "codex");

        Zotero.Prefs.set(`${PREF_PREFIX}.enableClaudeCodeMode`, false, true);
        await Zotero.Promise.delay(250);
        const inactiveClaudeDisabled = await api.getStandaloneDiagnostics();
        assert.equal(inactiveClaudeDisabled.conversationSystem, "codex");
        assert.deepEqual(
          inactiveClaudeDisabled.runtimeSystemToggles
            .filter((toggle) => toggle.visible)
            .map((toggle) => toggle.system),
          ["codex"],
          diagnosticsMessage(inactiveClaudeDisabled),
        );

        Zotero.Prefs.set(`${PREF_PREFIX}.enableClaudeCodeMode`, true, true);
        Zotero.Prefs.set(
          `${PREF_PREFIX}.enableCodexAppServerMode`,
          false,
          true,
        );
        await Zotero.Promise.delay(400);
        const activeCodexDisabled = await api.getStandaloneDiagnostics();
        assert.equal(activeCodexDisabled.conversationSystem, "upstream");
        assert.deepEqual(
          activeCodexDisabled.runtimeSystemToggles
            .filter((toggle) => toggle.visible)
            .map((toggle) => toggle.system),
          ["claude_code"],
          diagnosticsMessage(activeCodexDisabled),
        );

        const restoredPaperTab = await api.clickStandaloneTab("paper");
        assert.equal(
          restoredPaperTab.activeTab,
          "paper",
          diagnosticsMessage(restoredPaperTab),
        );
      },
    );
  });

  it("restores each paper's active conversation after switching standalone items", async function () {
    const paperA = await api.createPaperWithPdfFixture({
      title: "Workflow Standalone Paper A",
      pdfTitle: "Workflow Standalone Paper A PDF",
    });
    const paperB = await api.createPaperWithPdfFixture({
      title: "Workflow Standalone Paper B",
      pdfTitle: "Workflow Standalone Paper B PDF",
    });
    fixtures.push(paperA, paperB);

    const initialA = await api.openStandaloneForItem(paperA.parentItemId);
    const conversationA = initialA.conversationKey;
    assert.isOk(conversationA, diagnosticsMessage(initialA));

    const marker = "workflow standalone paper A remembered conversation";
    const seededA = await api.seedStandaloneUserMessage(marker);
    assert.include(
      seededA.messageText || "",
      marker,
      diagnosticsMessage(seededA),
    );

    const switchedToB = await api.notifyStandaloneItemChanged(
      paperB.parentItemId,
    );
    assert.equal(
      switchedToB.basePaperItemId,
      paperB.parentItemId,
      diagnosticsMessage(switchedToB),
    );
    assert.notEqual(
      switchedToB.conversationKey,
      conversationA,
      diagnosticsMessage(switchedToB),
    );
    assert.notInclude(
      switchedToB.messageText || "",
      marker,
      diagnosticsMessage(switchedToB),
    );

    const restoredA = await api.notifyStandaloneItemChanged(
      paperA.parentItemId,
    );
    assert.equal(
      restoredA.basePaperItemId,
      paperA.parentItemId,
      diagnosticsMessage(restoredA),
    );
    assert.equal(
      restoredA.conversationKey,
      conversationA,
      diagnosticsMessage(restoredA),
    );
    assert.include(
      restoredA.messageText || "",
      marker,
      diagnosticsMessage(restoredA),
    );

    const rapidRestoredA = await api.notifyStandaloneItemChanges([
      paperB.parentItemId,
      paperA.parentItemId,
      paperB.parentItemId,
      paperA.parentItemId,
    ]);
    assert.equal(
      rapidRestoredA.basePaperItemId,
      paperA.parentItemId,
      diagnosticsMessage(rapidRestoredA),
    );
    assert.equal(
      rapidRestoredA.conversationKey,
      conversationA,
      diagnosticsMessage(rapidRestoredA),
    );
    assert.include(
      rapidRestoredA.messageText || "",
      marker,
      diagnosticsMessage(rapidRestoredA),
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
