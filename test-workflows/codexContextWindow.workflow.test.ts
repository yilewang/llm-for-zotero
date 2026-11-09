import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: Codex runtime context window", function () {
  this.timeout(30000);
  it("renders the runtime window and keeps it after remount", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const pref = "extensions.zotero.llmforzotero.enableCodexAppServerMode";
    const previous = Zotero.Prefs.get(pref, true);
    Zotero.Prefs.set(pref, true, true);
    await api.reset();
    const fixture = await api.createPaperWithPdfFixture({
      title: "Codex context window fixture",
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.clickPanelSystemToggle(panel.panelId, "codex");
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Test question",
        "Test response",
      );
      await api.askCapturingFinalRequest(panel.panelId, "Continue the test");
      const actual = await api.simulateProviderContextUsage(panel.panelId, {
        contextTokens: 56799,
        contextWindow: 828400,
        contextWindowIsAuthoritative: true,
      });
      assert.equal(actual.tokenUsageText, "57k / 828k (7%)");
      const remounted = await api.remountPanel(panel.panelId);
      const restored = await api.getDiagnostics(remounted.panelId);
      assert.equal(restored.tokenUsageText, "57k / 828k (7%)");
    } finally {
      await api.cleanupFixture(fixture);
      await api.reset();
      if (previous === undefined) Zotero.Prefs.clear?.(pref, true);
      else Zotero.Prefs.set(pref, previous, true);
    }
  });
});
