import { assert } from "chai";
import type {
  WorkflowTestApi,
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

  it("renders quote anchors as original-language quote cards in Chinese answers", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Original Language Quote Workflow Paper",
      pdfTitle: "Original Language Quote Workflow PDF",
    });

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const quoteText =
      "Memory engrams are highly dynamic during consolidation.";
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
    assert.deepEqual(result.quoteCardBodies, [quoteText]);
    assert.notInclude(result.renderedText, "记忆痕迹");
  });
});
