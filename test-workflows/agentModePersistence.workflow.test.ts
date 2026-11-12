import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

const AGENT_MODE_PREFS = {
  enableAgentMode: true,
  enableClaudeCodeMode: false,
  enableCodexAppServerMode: false,
  conversationSystem: "upstream",
  agentLibraryWriteMode: "auto",
};

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

describe("workflow: built-in runtime is always Agent", function () {
  this.timeout(30000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  afterEach(async function () {
    while (fixtures.length) {
      await api.cleanupFixture(fixtures.pop()!);
    }
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  async function createPaper(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
    });
    fixtures.push(fixture);
    return fixture;
  }

  it("keeps the footer visible and the context gauge hollow before the first message", async function () {
    await withPrefs(AGENT_MODE_PREFS, async () => {
      const paper = await createPaper("Agent Blank Footer Paper");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      // The built-in runtime opens in Agent mode with no toggle press.
      const blankAgent = await api.getDiagnostics(panel.panelId);
      assert.equal(blankAgent.runtimeMode, "agent");
      assert.isTrue(blankAgent.startPageActive);
      assert.isTrue(blankAgent.statusBarVisible);
      assert.isTrue(blankAgent.permissionControlVisible);
      assert.equal(blankAgent.permissionModeText, "auto");
      assert.equal(
        blankAgent.permissionModeFontSize,
        blankAgent.statusFontSize,
      );
      assert.closeTo(
        blankAgent.contextGaugeWidth || 0,
        Number.parseFloat(blankAgent.permissionModeFontSize || "0"),
        0.01,
      );
      assert.isBelow(
        blankAgent.contextGaugeInnerWidth || 0,
        blankAgent.contextGaugeWidth || 0,
      );
      assert.equal(
        blankAgent.contextGaugeInnerBackground,
        blankAgent.panelBackground,
      );
      const wrappedFooter = await api.measurePanelFooterLayout(panel.panelId, {
        width: 220,
        statusText:
          "This intentionally long status message must wrap onto additional lines without moving the permission and context controls.",
      });
      assert.isTrue(wrappedFooter.statusWrapped);
      assert.isTrue(wrappedFooter.controlsPinnedToFirstLine);
      assert.isTrue(wrappedFooter.textGlyphsAligned);
      assert.closeTo(
        wrappedFooter.permissionTextTop,
        wrappedFooter.statusTextTop,
        0.5,
      );
      assert.closeTo(
        wrappedFooter.permissionTextBottom,
        wrappedFooter.statusTextBottom,
        0.5,
      );
    });
  });

  it("keeps the footer row one text line tall with 6px above the text", async function () {
    await withPrefs(AGENT_MODE_PREFS, async () => {
      const paper = await createPaper("Agent Footer Spacing Paper");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const footer = await api.measurePanelFooterLayout(panel.panelId, {
        width: 360,
        statusText: "Ready",
      });
      assert.isFalse(footer.statusWrapped);
      assert.closeTo(footer.statusBarHeight, footer.statusLineHeight, 0.5);
      assert.closeTo(footer.spaceAboveStatus, 6, 0.5);
      assert.isTrue(footer.textGlyphsAligned);
    });
  });

  it("opens every paper in agent mode and ignores the old saved mode", async function () {
    await withPrefs(AGENT_MODE_PREFS, async () => {
      // A mode saved by an older build must not change anything.
      Zotero.Prefs.set(`${PREF_PREFIX}.lastUsedRuntimeMode`, "chat", true);
      const firstPaper = await createPaper("Agent Default Paper One");
      const secondPaper = await createPaper("Agent Default Paper Two");

      const firstPanel = await api.renderPanelForItem(firstPaper.parentItemId);
      const first = await api.getDiagnostics(firstPanel.panelId);
      assert.equal(first.runtimeMode, "agent");
      assert.equal(first.runtimeBadge?.label, "Agent");

      const secondPanel = await api.renderPanelForItem(
        secondPaper.parentItemId,
      );
      const second = await api.getDiagnostics(secondPanel.panelId);
      assert.equal(second.runtimeMode, "agent");

      // reset() drops every in-memory per-conversation choice, which is what a
      // Zotero restart does to the panel state.
      await api.reset();
      const afterRestart = await api.renderPanelForItem(
        firstPaper.parentItemId,
      );
      assert.equal(
        (await api.getDiagnostics(afterRestart.panelId)).runtimeMode,
        "agent",
      );
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.lastUsedRuntimeMode`, true),
        "chat",
        "nothing writes the old saved mode any more",
      );
    });
  });

  it("stays in chat and hides the badge when Agent, Codex and Claude are all off", async function () {
    await withPrefs(
      { ...AGENT_MODE_PREFS, enableAgentMode: false },
      async () => {
        const paper = await createPaper("Agent Off Paper");
        const panel = await api.renderPanelForItem(paper.parentItemId);
        const diagnostics = await api.getDiagnostics(panel.panelId);
        assert.equal(diagnostics.runtimeMode, "chat");
        assert.isFalse(
          diagnostics.runtimeBadge?.visible,
          "with Agent, Codex and Claude all off the badge is hidden",
        );
      },
    );
  });
});
