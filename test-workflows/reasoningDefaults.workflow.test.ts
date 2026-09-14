import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: custom endpoint reasoning defaults", function () {
  this.timeout(30000);
  it("renders Auto, selects Max, and preserves it through remount", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const prefix = "extensions.zotero.llmforzotero.";
    const base = "https://relay.example/v1";
    const settings: Record<string, unknown> = {
      conversationSystem: "upstream",
      lastUsedModelEntryId: "workflow-astra-model",
      lastUsedReasoningLevel: "none",
      lastUsedReasoningLevelByProvider: "{}",
      modelProviderGroupsMigrationVersion: 3,
      modelProviderGroups: JSON.stringify([
        {
          id: "workflow-astra",
          authMode: "api_key",
          apiBase: base,
          apiKey: "workflow-test",
          providerProtocol: "responses_api",
          models: [
            {
              id: "workflow-astra-model",
              model: "gpt-6-astra",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
      ]),
    };
    const previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    let fixture: WorkflowTestFixture | undefined;
    await api.reset();
    try {
      for (const [key, value] of Object.entries(settings))
        Zotero.Prefs.set(prefix + key, value, true);
      fixture = await api.createPaperWithPdfFixture({
        title: "Reasoning default",
        pdfTitle: "Reasoning PDF",
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const body = doc.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      const button = body.querySelector<HTMLButtonElement>(
        "#llm-reasoning-toggle",
      )!;
      assert.include(button.dataset.reasoningLabel, "Auto");
      button.click();
      const rows = Array.from(
        body.querySelectorAll<HTMLButtonElement>(
          "#llm-reasoning-menu .llm-reasoning-option",
        ),
      );
      assert.isFalse(rows.some((row) => /off/i.test(row.textContent || "")));
      const max = rows.find((row) =>
        /^max$/i.test((row.textContent || "").trim()),
      );
      assert.isOk(max, "Astra must offer Max");
      max!.click();
      const remounted = await api.remountPanel(panel.panelId);
      const restored = doc.querySelector(
        `[data-workflow-panel-id="${remounted.panelId}"] #llm-reasoning-toggle`,
      ) as HTMLButtonElement;
      assert.match(restored.dataset.reasoningLabel || "", /^max$/i);
    } finally {
      if (fixture) await api.cleanupFixture(fixture);
      await api.reset();
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
    }
  });
});
