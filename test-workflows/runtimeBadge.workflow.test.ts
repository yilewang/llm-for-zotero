import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

const ALL_RUNTIME_PREFS = {
  enableAgentMode: true,
  enableClaudeCodeMode: true,
  enableCodexAppServerMode: true,
  conversationSystem: "upstream",
  agentLibraryWriteMode: "auto",
};

const AGENT_ONLY_PREFS = {
  ...ALL_RUNTIME_PREFS,
  enableClaudeCodeMode: false,
  enableCodexAppServerMode: false,
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

describe("workflow: runtime badge", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    while (fixtures.length) {
      await api.cleanupFixture(fixtures.pop()!);
    }
    await api.reset();
  });

  async function createPaper(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
    });
    fixtures.push(fixture);
    return fixture;
  }

  function activeHeaderSystems(
    toggles: Array<{ system: string; visible: boolean; active: boolean }>,
  ): string[] {
    return toggles
      .filter((toggle) => toggle.visible && toggle.active)
      .map((toggle) => toggle.system);
  }

  it("lists Agent, Codex and Claude, and switches the sidebar panel from the badge", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paper = await createPaper("Runtime Badge Sidebar");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const initial = await api.getDiagnostics(panel.panelId);
      assert.equal(initial.runtimeBadge?.label, "Agent");
      assert.isTrue(initial.runtimeBadge?.clickable);
      assert.deepEqual(activeHeaderSystems(initial.runtimeSystemToggles), []);

      const menu = await api.openPanelRuntimeMenu(panel.panelId);
      assert.deepEqual(
        menu.menuItems.map((item) => [item.system, item.label, item.selected]),
        [
          ["upstream", "Agent", true],
          ["codex", "Codex", false],
          ["claude_code", "Claude", false],
        ],
      );

      const codex = await api.pickPanelRuntime(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      assert.equal(codex.runtimeBadge?.label, "Codex");
      assert.isFalse(codex.runtimeBadge?.menuOpen, "the pick closes the menu");
      assert.deepEqual(activeHeaderSystems(codex.runtimeSystemToggles), [
        "codex",
      ]);

      const agent = await api.pickPanelRuntime(panel.panelId, "upstream");
      assert.equal(agent.conversationSystem, "upstream");
      assert.equal(agent.runtimeBadge?.label, "Agent");
      assert.equal(agent.runtimeMode, "agent");
      assert.deepEqual(activeHeaderSystems(agent.runtimeSystemToggles), []);
    });
  });

  it("keeps the badge in step with the header buttons", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paper = await createPaper("Runtime Badge Header Sync");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.runtimeBadge?.label, "Codex");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.runtimeBadge?.label, "Agent");
    });
  });

  it("closes the menu on Escape and on an outside press without switching", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paper = await createPaper("Runtime Badge Dismiss");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      await api.openPanelRuntimeMenu(panel.panelId);
      const doc = Zotero.getMainWindow().document;
      doc.dispatchEvent(
        new (doc.defaultView as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      await Zotero.Promise.delay(100);
      const afterEscape = await api.getDiagnostics(panel.panelId);
      assert.isFalse(afterEscape.runtimeBadge?.menuOpen);
      assert.equal(afterEscape.conversationSystem, "upstream");

      await api.openPanelRuntimeMenu(panel.panelId);
      doc.dispatchEvent(
        new (doc.defaultView as any).MouseEvent("pointerdown", {
          bubbles: true,
        }),
      );
      await Zotero.Promise.delay(100);
      const afterOutside = await api.getDiagnostics(panel.panelId);
      assert.isFalse(afterOutside.runtimeBadge?.menuOpen);
      assert.equal(afterOutside.conversationSystem, "upstream");
    });
  });

  it("shows a static Agent label when only Agent is on", async function () {
    await withPrefs(AGENT_ONLY_PREFS, async () => {
      const paper = await createPaper("Runtime Badge Static");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const diagnostics = await api.getDiagnostics(panel.panelId);
      assert.isTrue(diagnostics.runtimeBadge?.visible);
      assert.equal(diagnostics.runtimeBadge?.label, "Agent");
      assert.isFalse(diagnostics.runtimeBadge?.clickable);
    });
  });

  it("names the built-in runtime Chat when the Agent feature is off but Codex is on", async function () {
    await withPrefs(
      {
        ...ALL_RUNTIME_PREFS,
        enableAgentMode: false,
        enableClaudeCodeMode: false,
      },
      async () => {
        const paper = await createPaper("Runtime Badge Chat");
        const panel = await api.renderPanelForItem(paper.parentItemId);
        const menu = await api.openPanelRuntimeMenu(panel.panelId);
        assert.deepEqual(
          menu.menuItems.map((item) => item.label),
          ["Chat", "Codex"],
        );
        const state = await api.getDiagnostics(panel.panelId);
        assert.equal(state.runtimeBadge?.label, "Chat");
        assert.equal(state.runtimeMode, "chat");
      },
    );
  });

  it("switches the standalone window from its badge and leaves the sidebar runtime alone", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paper = await createPaper("Runtime Badge Standalone");
      const sidebar = await api.renderPanelForItem(paper.parentItemId);
      await api.openStandaloneForItem(paper.parentItemId);
      try {
        const initial = await api.clickStandaloneTab("open");
        assert.equal(initial.conversationSystem, "upstream");
        assert.equal(initial.runtimeBadge?.label, "Agent");

        const menu = await api.openStandaloneRuntimeMenu();
        assert.deepEqual(
          menu.menuItems.map((item) => item.label),
          ["Agent", "Codex", "Claude"],
        );

        const codex = await api.pickStandaloneRuntime("codex");
        assert.equal(codex.conversationSystem, "codex");
        assert.equal(codex.runtimeBadge?.label, "Codex");
        assert.deepEqual(activeHeaderSystems(codex.runtimeSystemToggles), [
          "codex",
        ]);
        const sidebarAfterCodex = await api.getDiagnostics(sidebar.panelId);
        assert.equal(
          sidebarAfterCodex.conversationSystem,
          "upstream",
          "the sidebar runtime does not follow the window",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
          "upstream",
          "the window's runtime is not saved as the sidebar's",
        );

        const agent = await api.pickStandaloneRuntime("upstream");
        assert.equal(agent.conversationSystem, "upstream");
        assert.equal(agent.runtimeBadge?.label, "Agent");
        assert.deepEqual(activeHeaderSystems(agent.runtimeSystemToggles), []);
        const sidebarAfterAgent = await api.getDiagnostics(sidebar.panelId);
        assert.equal(sidebarAfterAgent.conversationSystem, "upstream");
      } finally {
        await api.closeStandalone();
      }
    });
  });
});
