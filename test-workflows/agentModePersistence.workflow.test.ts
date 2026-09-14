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

describe("workflow: agent mode persistence", function () {
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

      const blankChat = await api.getDiagnostics(panel.panelId);
      assert.isTrue(blankChat.startPageActive);
      assert.isTrue(blankChat.statusBarVisible);
      assert.closeTo(
        blankChat.contextGaugeWidth || 0,
        Number.parseFloat(blankChat.statusFontSize || "0"),
        0.01,
      );
      assert.equal(blankChat.contextGaugeHeight, blankChat.contextGaugeWidth);
      assert.equal(
        blankChat.contextGaugeInnerBackground,
        blankChat.panelBackground,
      );
      assert.isFalse(blankChat.permissionControlVisible);

      const blankAgent = await api.clickPanelRuntimeModeToggle(panel.panelId);
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

  it("carries an enabled agent mode to another paper and across a restart", async function () {
    await withPrefs(AGENT_MODE_PREFS, async () => {
      const firstPaper = await createPaper("Agent Persistence Paper One");
      const secondPaper = await createPaper("Agent Persistence Paper Two");

      const firstPanel = await api.renderPanelForItem(firstPaper.parentItemId);
      const initial = await api.getDiagnostics(firstPanel.panelId);
      assert.equal(
        initial.runtimeMode,
        "chat",
        "paper conversations still open in chat before any toggle",
      );

      const afterToggle = await api.clickPanelRuntimeModeToggle(
        firstPanel.panelId,
      );
      assert.equal(afterToggle.runtimeMode, "agent");

      const secondPanel = await api.renderPanelForItem(
        secondPaper.parentItemId,
      );
      const onSecondPaper = await api.getDiagnostics(secondPanel.panelId);
      assert.equal(
        onSecondPaper.runtimeMode,
        "agent",
        "switching papers keeps the agent mode the user turned on",
      );

      // reset() drops every in-memory per-conversation choice, which is what a
      // Zotero restart does to the panel state.
      await api.reset();

      const afterRestart = await api.renderPanelForItem(
        firstPaper.parentItemId,
      );
      const restarted = await api.getDiagnostics(afterRestart.panelId);
      assert.equal(
        restarted.runtimeMode,
        "agent",
        "agent mode survives a restart",
      );
    });
  });

  it("carries a disabled agent mode across a restart without touching library chat", async function () {
    await withPrefs(AGENT_MODE_PREFS, async () => {
      const paper = await createPaper("Agent Persistence Paper Three");

      const panel = await api.renderPanelForItem(paper.parentItemId);
      assert.equal(
        (await api.clickPanelRuntimeModeToggle(panel.panelId)).runtimeMode,
        "agent",
      );
      assert.equal(
        (await api.clickPanelRuntimeModeToggle(panel.panelId)).runtimeMode,
        "chat",
      );

      await api.reset();

      const afterRestart = await api.renderPanelForItem(paper.parentItemId);
      assert.equal(
        (await api.getDiagnostics(afterRestart.panelId)).runtimeMode,
        "chat",
        "turning agent mode off also sticks",
      );
    });
  });
});
