import { assert } from "chai";
import { isConversationKeyForKind } from "../src/shared/conversationKeySpace";
import type {
  WorkflowTestApi,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const CLAUDE_MODE_PREFS = {
  enableClaudeCodeMode: true,
  conversationSystem: "claude_code",
};

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

function assertDualRuntimeControls(
  diagnostics: WorkflowTestDiagnostics,
  activeSystem?: "codex" | "claude_code",
): void {
  const visible = diagnostics.runtimeSystemToggles.filter(
    (toggle) => toggle.visible,
  );
  const active = visible.filter((toggle) => toggle.active);
  assert.deepEqual(
    visible.map((toggle) => toggle.system),
    ["codex", "claude_code"],
  );
  assert.deepEqual(
    active.map((toggle) => toggle.system),
    activeSystem ? [activeSystem] : [],
  );
  for (const toggle of visible) {
    assert.equal(toggle.active, toggle.ariaPressed);
    assert.isFalse(toggle.disabled);
  }
}

async function diagnosticsMessage(
  api: WorkflowTestApi,
  panelId?: string,
): Promise<string> {
  const diagnostics = await api.getDiagnostics(panelId);
  return JSON.stringify(
    {
      panelId: diagnostics.panelId,
      activeItemId: diagnostics.activeItemId,
      contextSnapshot: diagnostics.contextSnapshot,
      chipText: diagnostics.chipText,
      inputValue: diagnostics.inputValue,
      statusText: diagnostics.statusText,
      lastSend: diagnostics.lastSend
        ? {
            contextSource: diagnostics.lastSend.contextSource,
            question: diagnostics.lastSend.question,
            paperContexts: diagnostics.lastSend.paperContexts,
            fullTextPaperContexts: diagnostics.lastSend.fullTextPaperContexts,
          }
        : null,
    },
    null,
    2,
  );
}

describe("workflow: selected item context send", function () {
  this.timeout(30000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  it("resolves a selected parent paper to its PDF context and captures it on send", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Harness Parent Paper",
      pdfTitle: "Workflow Harness Main PDF",
    });

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const context = panel.contextSnapshot;
    assert.isOk(
      context?.paperContext,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.equal(
      context?.paperContext?.itemId,
      fixture.parentItemId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.equal(
      context?.paperContext?.contextItemId,
      fixture.pdfAttachmentId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.notEqual(
      context?.sourceKind,
      "none",
      await diagnosticsMessage(api, panel.panelId),
    );

    const send = await api.ask(panel.panelId, "What is this paper about?");
    assert.include(send.question, "What is this paper about?");
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.parentItemId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.equal(
      send.contextSource?.paperContext?.contextItemId,
      fixture.pdfAttachmentId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.deepEqual(api.getLastSend(), send);
  });

  it("sends Claude Code paper turns through the original agent-mode envelope", async function () {
    await withPrefs(CLAUDE_MODE_PREFS, async () => {
      fixture = await api.createPaperWithPdfFixture({
        title: "Claude Workflow Parent Paper",
        pdfTitle: "Claude Workflow Main PDF",
      });

      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const send = await api.ask(panel.panelId, "Summarize this paper");

      assert.equal(
        send.runtimeMode,
        "agent",
        await diagnosticsMessage(api, panel.panelId),
      );
      assert.equal(
        send.modelProviderLabel,
        "Claude Code",
        await diagnosticsMessage(api, panel.panelId),
      );
      assert.equal(send.question, "Summarize this paper");
      assert.equal(
        send.contextSource?.paperContext?.itemId,
        fixture.parentItemId,
        await diagnosticsMessage(api, panel.panelId),
      );
      assert.equal(
        send.contextSource?.paperContext?.contextItemId,
        fixture.pdfAttachmentId,
        await diagnosticsMessage(api, panel.panelId),
      );
    });
  });

  it("switches directly between both paper runtimes and returns to a fresh draft", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: true,
        conversationSystem: "upstream",
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Dual Runtime Workflow Parent",
          pdfTitle: "Dual Runtime Workflow PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const initial = await api.getDiagnostics(panel.panelId);
        assert.equal(initial.conversationSystem, "upstream");
        assertDualRuntimeControls(initial);
        const geometry = await api.measurePanelRuntimeGeometry(panel.panelId, {
          width: 320,
          fontScale: 1.8,
        });
        assert.closeTo(geometry.containerWidth, 316, 4);
        assert.isAtLeast(geometry.runtimeWidth, 50, JSON.stringify(geometry));
        assert.isFalse(
          geometry.runtimeIntersectsLeadingContent,
          JSON.stringify(geometry),
        );
        assert.isFalse(
          geometry.runtimeIntersectsTrailingContent,
          JSON.stringify(geometry),
        );
        assert.isTrue(
          geometry.runtimeWithinContainer,
          JSON.stringify(geometry),
        );
        assert.isTrue(
          geometry.trailingContentWithinContainer,
          JSON.stringify(geometry),
        );
        assert.isTrue(
          geometry.clearButtonCompact,
          "the narrow header must replace the Clear label with its icon",
        );
        const wideGeometry = await api.measurePanelRuntimeGeometry(
          panel.panelId,
          {
            width: 700,
            fontScale: 1,
          },
        );
        assert.isFalse(
          wideGeometry.runtimeIntersectsTrailingContent,
          JSON.stringify(wideGeometry),
        );
        assert.isFalse(
          wideGeometry.clearButtonCompact,
          "the full Clear label must return when the header has room",
        );

        const rapid = await api.clickPanelSystemTogglesRapidly(panel.panelId, [
          "codex",
          "claude_code",
        ]);
        assert.equal(
          rapid.conversationSystem,
          "codex",
          "the sidebar busy guard must ignore a re-entrant second switch",
        );
        assertDualRuntimeControls(rapid, "codex");
        const resetUpstream = await api.clickPanelSystemToggle(
          panel.panelId,
          "codex",
        );
        assert.equal(resetUpstream.conversationSystem, "upstream");

        const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
        assert.equal(codex.conversationSystem, "codex");
        assert.isTrue(
          isConversationKeyForKind(
            "codex",
            "paper",
            codex.conversationKey || 0,
          ),
        );
        assertDualRuntimeControls(codex, "codex");
        const codexKey = codex.conversationKey;
        const codexMarker = "nonblank remembered Codex workflow chat";
        await api.seedPanelStoredUserMessage(panel.panelId, codexMarker);

        const claude = await api.clickPanelSystemToggle(
          panel.panelId,
          "claude_code",
        );
        assert.equal(claude.conversationSystem, "claude_code");
        assert.isTrue(
          isConversationKeyForKind(
            "claude_code",
            "paper",
            claude.conversationKey || 0,
          ),
        );
        assertDualRuntimeControls(claude, "claude_code");

        const upstream = await api.clickPanelSystemToggle(
          panel.panelId,
          "claude_code",
        );
        assert.equal(upstream.conversationSystem, "upstream");
        assert.isTrue(
          isConversationKeyForKind(
            "upstream",
            "paper",
            upstream.conversationKey || 0,
          ),
        );
        assertDualRuntimeControls(upstream);

        const freshCodex = await api.clickPanelSystemToggle(
          panel.panelId,
          "codex",
        );
        assert.equal(freshCodex.conversationSystem, "codex");
        assert.notEqual(freshCodex.conversationKey, codexKey);
        assert.notInclude(freshCodex.messageText || "", codexMarker);
        assertDualRuntimeControls(freshCodex, "codex");

        Zotero.Prefs.set(`${PREF_PREFIX}.enableClaudeCodeMode`, false, true);
        await Zotero.Promise.delay(250);
        const inactiveClaudeDisabled = await api.getDiagnostics(panel.panelId);
        assert.equal(inactiveClaudeDisabled.conversationSystem, "codex");
        assert.deepEqual(
          inactiveClaudeDisabled.runtimeSystemToggles
            .filter((toggle) => toggle.visible)
            .map((toggle) => toggle.system),
          ["codex"],
        );

        Zotero.Prefs.set(`${PREF_PREFIX}.enableClaudeCodeMode`, true, true);
        Zotero.Prefs.set(
          `${PREF_PREFIX}.enableCodexAppServerMode`,
          false,
          true,
        );
        await Zotero.Promise.delay(400);
        const activeCodexDisabled = await api.getDiagnostics(panel.panelId);
        assert.equal(activeCodexDisabled.conversationSystem, "upstream");
        assert.deepEqual(
          activeCodexDisabled.runtimeSystemToggles
            .filter((toggle) => toggle.visible)
            .map((toggle) => toggle.system),
          ["claude_code"],
        );
      },
    );
  });

  it("preserves a Chinese figure request at the normal-chat send boundary", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Issue 310 Workflow Paper",
      pdfTitle: "Issue 310 Workflow PDF",
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);

    const normalSend = await api.ask(panel.panelId, "帮我详细解释图1的内容");
    assert.equal(normalSend.question, "帮我详细解释图1的内容");
    assert.equal(
      normalSend.contextSource?.paperContext?.contextItemId,
      fixture.pdfAttachmentId,
      await diagnosticsMessage(api, panel.panelId),
    );
  });

  it("preserves a Chinese full-read request at the Agent send boundary", async function () {
    await withPrefs(CLAUDE_MODE_PREFS, async () => {
      fixture = await api.createPaperWithPdfFixture({
        title: "Issue 310 Agent Workflow Paper",
        pdfTitle: "Issue 310 Agent Workflow PDF",
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const agentSend = await api.ask(
        panel.panelId,
        "请先通读整篇论文，再回答问题。",
      );
      assert.equal(agentSend.runtimeMode, "agent");
      assert.equal(agentSend.question, "请先通读整篇论文，再回答问题。");
      assert.equal(
        agentSend.contextSource?.paperContext?.contextItemId,
        fixture?.pdfAttachmentId,
        await diagnosticsMessage(api, panel.panelId),
      );
    });
  });

  it("renders quote anchors as original-language quote cards in Chinese answers", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Original Language Quote Workflow Paper",
      pdfTitle: "Original Language Quote Workflow PDF",
    });

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const quoteText = "Memory engrams are highly dynamic during consolidation.";
    const result = await api.renderAssistantForPanel(panel.panelId, {
      text: `中文回答：\n\n[[quote:Q_workflow_original_language]]\n\n这句话说明上面的原文证据。`,
      quoteCitations: [
        {
          id: "Q_workflow_original_language",
          quoteText,
          citationLabel: "(Workflow, 2026)",
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
        },
      ],
    });

    assert.include(result.renderedText, quoteText);
    assert.include(result.renderedText, "中文回答");
    assert.deepEqual(result.quoteCardBodiesBeforeExpansion, [""]);
    assert.deepEqual(result.quoteCardBodies, [quoteText]);
    assert.deepEqual(result.quoteCardPreviewTexts, [quoteText]);
    assert.notInclude(result.renderedText, "记忆痕迹");
  });

  it("renders rejected quotes as amber cards without a visible status label", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Rejected Quote Workflow Paper",
      pdfTitle: "Rejected Quote Workflow PDF",
    });

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const quoteText =
      "This model interpretation does not appear in the complete source.";
    const result = await api.renderAssistantForPanel(panel.panelId, {
      text: `> ${quoteText}\n>\n> Not a source quote`,
    });

    assert.include(result.renderedText, quoteText);
    assert.notInclude(result.renderedText, "Not a source quote");
    assert.deepEqual(result.quoteCardBodiesBeforeExpansion, [quoteText]);
    assert.deepEqual(result.quoteCardBodies, [quoteText]);
    assert.deepEqual(result.quoteCardPreviewTexts, []);
    assert.deepEqual(result.quoteCardStatuses, ["not-source"]);
    assert.deepEqual(result.quoteCardCitationTexts, []);
    assert.deepEqual(result.quoteCardVerticalMargins, [
      { top: 10, bottom: 10 },
    ]);
  });

  it("rerenders only the changed assistant wrapper in a long multi-quote conversation", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Targeted Quote Refresh Workflow Paper",
      pdfTitle: "Targeted Quote Refresh Workflow PDF",
    });

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const result = await api.exerciseTargetedQuoteRefresh(panel.panelId);

    assert.equal(result.messageCount, 16);
    assert.equal(result.assistantMessageCount, 8);
    assert.equal(result.quoteCardCount, 64);
    assert.equal(result.unchangedWrapperCount, 15);
    assert.equal(result.replacedWrapperCount, 1);
    assert.isTrue(result.targetWasReplaced);
    assert.equal(result.targetNotSourceCardCount, 8);
    assert.equal(result.targetStrongBodyCount, 8);
  });
});
