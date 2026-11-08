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
    Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
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
      sidebarState: diagnostics.sidebarState,
      customTitlebar: diagnostics.customTitlebar,
      collapseToggleHost: diagnostics.collapseToggleHost,
      sidebarWidthPx: diagnostics.sidebarWidthPx,
      sidebarFlyout: diagnostics.sidebarFlyout,
      sidebarPanelWidthPx: diagnostics.sidebarPanelWidthPx,
      sidebarPanelOpacity: diagnostics.sidebarPanelOpacity,
      sidebarContent: diagnostics.sidebarContent,
      windowButtonsWidthPx: diagnostics.windowButtonsWidthPx,
      sidebarActionOrder: diagnostics.sidebarActionOrder,
      sidebarPrimaryActionOrder: diagnostics.sidebarPrimaryActionOrder,
      titleActionLabels: diagnostics.titleActionLabels,
      alignment: diagnostics.alignment,
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

  it("preserves the full sidebar content when revealed by hover", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Unified Standalone Sidebar",
      pdfTitle: "Workflow Unified Standalone Sidebar PDF",
    });
    fixtures.push(fixture);

    let expanded = await api.openStandaloneForItem(fixture.parentItemId);
    // History loads asynchronously after the chat panel mounts. Compare a
    // populated sidebar rather than racing its initial empty render.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (expanded.sidebarContent?.historyText) break;
      await Zotero.Promise.delay(25);
      expanded = await api.getStandaloneDiagnostics();
    }
    assert.isNotEmpty(expanded.sidebarContent?.historyText || "");
    assert.equal(
      expanded.sidebarState,
      "expanded",
      diagnosticsMessage(expanded),
    );
    // The library icon and label are gone from the header for good; on macOS
    // the native traffic lights take that space instead.
    assert.equal(
      expanded.collapseToggleHost,
      "sidebar-header",
      diagnosticsMessage(expanded),
    );
    if (expanded.customTitlebar) {
      assert.isAbove(
        expanded.windowButtonsWidthPx ?? 0,
        0,
        diagnosticsMessage(expanded),
      );
    }
    assert.deepEqual(
      expanded.sidebarActionOrder,
      ["new-chat", "search-history", "skills", "preferences"],
      diagnosticsMessage(expanded),
    );
    assert.deepEqual(
      expanded.sidebarPrimaryActionOrder,
      ["new-chat", "search-history", "skills"],
      diagnosticsMessage(expanded),
    );
    assert.deepEqual(
      expanded.titleActionLabels,
      ["Pin this paper", "Show task progress", "Export", "Delete conversation"],
      diagnosticsMessage(expanded),
    );
    assert.isDefined(expanded.alignment, diagnosticsMessage(expanded));
    assert.isAtMost(
      expanded.alignment?.toolbarCenterDeltaPx ?? Number.POSITIVE_INFINITY,
      0.5,
      diagnosticsMessage(expanded),
    );
    assert.isAtMost(
      expanded.alignment?.titleCenterDeltaPx ?? Number.POSITIVE_INFINITY,
      0.5,
      diagnosticsMessage(expanded),
    );
    assert.isAtMost(
      expanded.alignment?.toolbarControlCenterDeltaPx ??
        Number.POSITIVE_INFINITY,
      0.5,
      diagnosticsMessage(expanded),
    );
    assert.isAtMost(
      expanded.alignment?.titleTextCenterDeltaPx ?? Number.POSITIVE_INFINITY,
      0.5,
      diagnosticsMessage(expanded),
    );

    const collapsedSidebar = await api.toggleStandaloneSidebar();
    assert.equal(
      collapsedSidebar.sidebarState,
      "collapsed",
      diagnosticsMessage(collapsedSidebar),
    );
    assert.deepEqual(
      collapsedSidebar.sidebarActionOrder,
      expanded.sidebarActionOrder,
      diagnosticsMessage(collapsedSidebar),
    );

    // Collapsed now means the rail is gone from the layout altogether, so the
    // window controls and the collapse toggle both move into the tab row.
    assert.equal(
      collapsedSidebar.collapseToggleHost,
      "tab-row",
      diagnosticsMessage(collapsedSidebar),
    );
    assert.equal(
      collapsedSidebar.sidebarWidthPx ?? -1,
      0,
      diagnosticsMessage(collapsedSidebar),
    );
    assert.equal(
      collapsedSidebar.sidebarFlyout,
      "closed",
      diagnosticsMessage(collapsedSidebar),
    );

    // Hovering the toggle floats the sidebar back over the content, so its
    // actions stay reachable without expanding the rail again.
    const hovered = await api.hoverStandaloneSidebarToggle();
    assert.equal(hovered.sidebarFlyout, "open", diagnosticsMessage(hovered));
    assert.isAbove(
      hovered.sidebarPanelWidthPx ?? 0,
      100,
      diagnosticsMessage(hovered),
    );
    assert.equal(hovered.sidebarPanelOpacity, 1, diagnosticsMessage(hovered));
    // The rail itself still takes no space: the panel is floating above the
    // chat rather than pushing it aside.
    assert.equal(hovered.sidebarWidthPx ?? -1, 0, diagnosticsMessage(hovered));
    assert.deepEqual(
      hovered.sidebarContent?.labels,
      expanded.sidebarContent?.labels,
      "Hover must preserve every action label and its usable width",
    );
    assert.deepEqual(
      hovered.sidebarContent?.actionWidths,
      expanded.sidebarContent?.actionWidths,
      "Hover must preserve full action hit targets",
    );
    assert.isAbove(hovered.sidebarContent?.historyHeight ?? 0, 0);
    assert.equal(
      hovered.sidebarContent?.historyText,
      expanded.sidebarContent?.historyText,
      "Hover must retain the original history",
    );

    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const doc = win.document;
    const panel = doc.querySelector(".llm-standalone-sidebar-panel");
    const toolbar = doc.querySelector(".llm-standalone-tab-row")!;
    assert.equal(
      panel!.getBoundingClientRect().top,
      toolbar.getBoundingClientRect().top,
      "The flyout surface must reach the window top without a cutoff above New chat",
    );
    for (const node of Array.from(
      doc.querySelectorAll(".llm-standalone-tab-row-leading button"),
    ) as Element[]) {
      const control = node as HTMLElement;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      assert.isTrue(
        control.contains(
          doc.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        ),
        "Window toolbar controls must stay clickable above the flyout surface",
      );
    }
    for (const [action, overlayClass] of [
      ["search-history", ".llm-standalone-search-overlay"],
      ["skills", ".llm-standalone-skill-overlay"],
    ]) {
      await api.hoverStandaloneSidebarToggle();
      const button = doc.querySelector(
        `[data-sidebar-action="${action}"]`,
      ) as HTMLElement;
      const rect = button.getBoundingClientRect();
      assert.isTrue(
        button.contains(
          doc.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        ),
        `${action} must be clickable in the flyout`,
      );
      button.click();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (
            doc.querySelector(
              `#llmforzotero-standalone-chat-root > ${overlayClass}`,
            ) as HTMLElement
          ).style.display !== "none"
        )
          break;
        await Zotero.Promise.delay(25);
      }
      assert.notEqual(
        (
          doc.querySelector(
            `#llmforzotero-standalone-chat-root > ${overlayClass}`,
          ) as HTMLElement
        ).style.display,
        "none",
        `${action} must open its existing dialog`,
      );
      const overlay = doc.querySelector(
        `#llmforzotero-standalone-chat-root > ${overlayClass}`,
      )!;
      (
        overlay.querySelector(
          ".llm-standalone-search-close, .llm-standalone-skill-close",
        ) as HTMLElement
      ).click();
    }
    const previousChat = await api.seedStandaloneUserMessage(
      "Sidebar hover action regression",
    );
    await api.hoverStandaloneSidebarToggle();
    (
      doc.querySelector('[data-sidebar-action="new-chat"]') as HTMLElement
    ).click();
    let newChat = await api.getStandaloneDiagnostics();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (newChat.conversationKey !== previousChat.conversationKey) break;
      await Zotero.Promise.delay(25);
      newChat = await api.getStandaloneDiagnostics();
    }
    assert.notEqual(newChat.conversationKey, previousChat.conversationKey);
    assert.equal(newChat.sidebarState, "collapsed");
    assert.equal(
      doc.querySelector(".llm-standalone-sidebar-panel"),
      panel,
      "Actions must retain the same sidebar instance",
    );
    const reopened = await api.hoverStandaloneSidebarToggle();
    assert.deepEqual(
      reopened.sidebarContent?.labels,
      expanded.sidebarContent?.labels,
    );
    const historySelector = `.llm-standalone-conv-item[data-conversation-key="${previousChat.conversationKey}"]`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (doc.querySelector(historySelector)) break;
      await Zotero.Promise.delay(25);
    }
    const historyRow = doc.querySelector(historySelector) as HTMLElement;
    assert.isOk(
      historyRow,
      "The saved conversation stays available in the flyout",
    );
    historyRow.click();
    let restored = await api.getStandaloneDiagnostics();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (restored.messageText?.includes("Sidebar hover action regression"))
        break;
      await Zotero.Promise.delay(25);
      restored = await api.getStandaloneDiagnostics();
    }
    assert.include(
      restored.messageText || "",
      "Sidebar hover action regression",
    );
    assert.equal(restored.sidebarState, "collapsed");
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

  it("starts the standalone composer at one line with only its own resize handle", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow One Line Composer",
      pdfTitle: "Workflow One Line Composer PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);

    const resize = await api.exerciseStandaloneComposerManualResize();

    assert.deepEqual(resize.resizeHandleTargets, ["input"]);
    assert.closeTo(resize.heightBeforeDrag, resize.oneLineHeight, 1);
    // The composer text starts where the mode label above it starts.
    if (resize.textOffsetFromModeLabel !== null) {
      assert.closeTo(resize.textOffsetFromModeLabel, 0, 0.5);
    }
    // Only the window-aware handle resizes the standalone composer.
    assert.equal(resize.nativeResize, "none");
  });

  it("preserves a manually resized standalone composer while typing", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Manual Composer Resize",
      pdfTitle: "Workflow Manual Composer Resize PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);

    const resize = await api.exerciseStandaloneComposerManualResize();

    assert.isAbove(resize.heightAfterDrag, resize.heightBeforeDrag);
    assert.equal(resize.heightAfterInput, resize.heightAfterDrag);
    assert.isTrue(resize.manualHeightMarked);
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
    const seededPaper = await api.seedStandaloneUserMessage(paperMarker);
    assert.equal(
      seededPaper.conversationKey,
      paperConversationKey,
      diagnosticsMessage(seededPaper),
    );
    assert.include(
      seededPaper.messageText || "",
      paperMarker,
      diagnosticsMessage(seededPaper),
    );

    const openMode = await api.clickStandaloneTab("open");
    assert.equal(openMode.activeTab, "open", diagnosticsMessage(openMode));
    const libraryConversationKey = openMode.conversationKey;
    assert.notEqual(
      libraryConversationKey,
      paperConversationKey,
      diagnosticsMessage(openMode),
    );
    const libraryMarker = "workflow remembered library chat";
    const seededLibrary = await api.seedStandaloneUserMessage(libraryMarker);
    assert.equal(
      seededLibrary.conversationKey,
      libraryConversationKey,
      diagnosticsMessage(seededLibrary),
    );
    assert.include(
      seededLibrary.messageText || "",
      libraryMarker,
      diagnosticsMessage(seededLibrary),
    );

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

  it("switches conversations from its sidebar in place, keeping the mounted panel", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Standalone In-Place Switch",
      pdfTitle: "Workflow Standalone In-Place Switch PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const doc = win.document;
    const content = () =>
      doc.querySelector(".llm-standalone-content") as HTMLElement;
    const panelRoot = () =>
      content().querySelector("#llm-main") as HTMLElement | null;
    const chatText = () =>
      content().querySelector("#llm-chat-box")?.textContent || "";
    const input = () =>
      content().querySelector("#llm-input") as HTMLTextAreaElement | null;
    const mountedKey = () => Number(panelRoot()?.dataset.itemId || 0);
    const now = () => win.performance?.now() ?? Date.now();
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => resolve()),
      );
    const waitUntil = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (check()) return;
        await Zotero.Promise.delay(10);
      }
      assert.fail(`Timed out waiting for ${label}`);
    };
    const seedTurns = (marker: string) =>
      Array.from({ length: 12 }, (_, index) => [
        { role: "user" as const, text: `${marker} question ${index}` },
        {
          role: "assistant" as const,
          text: `${marker} answer ${index}. ${"Body text. ".repeat(40)}`,
        },
      ]).flat();

    /**
     * Two conversations in the current tab: A seeded, then a new chat B
     * seeded. B is mounted when this returns.
     */
    const seedTwo = async (label: string) => {
      const markerA = `${label} conversation A`;
      const markerB = `${label} conversation B`;
      await api.seedStandaloneConversation(seedTurns(markerA));
      const keyA = mountedKey();
      // A may be a remembered chat an earlier test left a draft in.
      input()!.value = "";
      input()!.dispatchEvent(new win.Event("input", { bubbles: true }));
      doc
        .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
        .click();
      await waitUntil(
        () => mountedKey() > 0 && mountedKey() !== keyA,
        `${label}: the new chat to mount`,
      );
      await api.seedStandaloneConversation(seedTurns(markerB));
      const keyB = mountedKey();
      const rowFor = (key: number) =>
        doc.querySelector<HTMLElement>(
          `.llm-standalone-conv-item[data-conversation-key="${key}"]`,
        );
      await waitUntil(
        () => Boolean(rowFor(keyA) && rowFor(keyB)),
        `${label}: both sidebar rows`,
      );
      return { keyA, keyB, markerA, markerB, rowFor };
    };

    const timings: Record<string, number[]> = {};
    // Collected, not asserted at once, so the timing line is logged either way.
    const remounts: string[] = [];
    const checkSameRoot = (tab: string, root: HTMLElement | null) => {
      if (panelRoot() !== root || !root?.isConnected) {
        remounts.push(`${tab}: switch to ${mountedKey()} rebuilt the panel`);
      }
    };
    const switchTo = async (
      label: string,
      row: HTMLElement,
      key: number,
      marker: string,
    ) => {
      // Three numbers per switch: the click handler's own time, the time
      // until the chat shows, and the time until the window's DOM stops
      // changing (the second chat draw and the history list re-render).
      let lastMutation = now();
      const observer = new win.MutationObserver(() => {
        lastMutation = now();
      });
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      const started = now();
      row.click();
      const clicked = now();
      while (
        !(mountedKey() === key && chatText().includes(`${marker} answer 11`))
      ) {
        if (now() - started > 10000) {
          observer.disconnect();
          assert.fail(`${label}: timed out waiting for ${marker}`);
        }
        await nextFrame();
      }
      const shown = now();
      while (now() - lastMutation < 300 && now() - started < 3000) {
        await Zotero.Promise.delay(20);
      }
      observer.disconnect();
      (timings[`${label} click`] ||= []).push(clicked - started);
      (timings[`${label} shown`] ||= []).push(shown - started);
      (timings[`${label} settled`] ||= []).push(
        Math.max(lastMutation, shown) - started,
      );
    };

    for (const tab of ["open", "paper"] as const) {
      await api.clickStandaloneTab(tab);
      const { keyA, keyB, markerA, markerB, rowFor } = await seedTwo(tab);
      assert.notEqual(keyA, keyB);
      const root = panelRoot();
      assert.isOk(root, `${tab}: panel root`);
      input()!.value = `${tab} draft kept in B`;
      input()!.dispatchEvent(new win.Event("input", { bubbles: true }));
      const statusLine = () =>
        content().querySelector("#llm-status") as HTMLElement | null;
      // Stands in for a status B's own request wrote ("sending", an error).
      statusLine()!.textContent = `${tab} status left by B`;

      await switchTo(tab, rowFor(keyA)!, keyA, markerA);
      checkSameRoot(tab, root);
      assert.notInclude(
        statusLine()?.textContent || "",
        "status left by B",
        `${tab}: A must not show B's status`,
      );
      assert.isFalse(
        content().querySelector("#llm-chat-box")?.hasAttribute("inert"),
        `${tab}: the chat takes input after the switch`,
      );
      assert.notInclude(chatText(), markerB, `${tab}: B's messages left`);
      assert.equal(input()!.value, "", `${tab}: A has no draft`);
      assert.isTrue(rowFor(keyA)!.classList.contains("active"));
      assert.isFalse(rowFor(keyB)!.classList.contains("active"));

      await switchTo(tab, rowFor(keyB)!, keyB, markerB);
      checkSameRoot(tab, root);
      assert.notInclude(chatText(), markerA, `${tab}: A's messages left`);
      assert.equal(input()!.value, `${tab} draft kept in B`);
      assert.isTrue(rowFor(keyB)!.classList.contains("active"));
      assert.isFalse(rowFor(keyA)!.classList.contains("active"));
      input()!.value = "";
      input()!.dispatchEvent(new win.Event("input", { bubbles: true }));

      for (let round = 0; round < 3; round += 1) {
        await switchTo(tab, rowFor(keyA)!, keyA, markerA);
        await switchTo(tab, rowFor(keyB)!, keyB, markerB);
        checkSameRoot(tab, root);
      }
    }
    const summary = Object.entries(timings)
      .map(([label, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return `${label}: median ${median.toFixed(1)} ms over ${values.length} [${values
          .map((value) => value.toFixed(1))
          .join(", ")}]`;
      })
      .join("; ");
    console.log(`Standalone conversation switch timing: ${summary}`);
    assert.deepEqual(remounts, [], "a sidebar switch rebuilt the panel");
  });
});
