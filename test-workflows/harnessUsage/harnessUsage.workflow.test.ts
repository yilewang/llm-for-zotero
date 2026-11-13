import { assert } from "chai";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";

declare const Services: { env: { get(name: string): string } };

const endpoint = Services.env.get("LLM_FOR_ZOTERO_HARNESS_USAGE_FIXTURE");
describe("workflow: DeepSeek Harness usage", function () {
  this.timeout(60_000);

  (endpoint ? it : it.skip)(
    "stores the provider bill and renders measured input",
    async function () {
      assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const model = `dsh-usage-${Date.now()}`;
      const prefix = "extensions.zotero.llmforzotero.";
      const prefs = {
        conversationSystem: "upstream",
        enableAgentMode: true,
        agentExecutionEngine: "deepseek_harness",
        originalAgentPermissionMode: "safe",
        deepseekHarnessNodePath: Services.env.get(
          "LLM_FOR_ZOTERO_HARNESS_NODE",
        ),
        deepseekHarnessWorkerPath: Services.env.get(
          "LLM_FOR_ZOTERO_HARNESS_WORKER",
        ),
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: "harness-usage-model",
        modelProviderGroups: JSON.stringify([
          {
            id: "harness-usage-provider",
            apiBase: endpoint,
            apiKey: "synthetic-fixture",
            authMode: "api_key",
            providerProtocol: "openai_chat_compat",
            models: [
              {
                id: "harness-usage-model",
                model,
                inputTokenCap: 1_000_000,
              },
            ],
          },
        ]),
      };
      const saved = new Map<string, unknown>();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Harness usage fixture",
      });
      try {
        for (const [name, value] of Object.entries(prefs)) {
          saved.set(prefix + name, Zotero.Prefs.get(prefix + name, true));
          Zotero.Prefs.set(prefix + name, value, true);
        }
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.selectPanelModelEntry(panel.panelId, "harness-usage-model");
        const body = Zotero.getMainWindow().document.querySelector(
          `[data-workflow-panel-id="${panel.panelId}"]`,
        )!;
        assert.equal(
          (await api.getDiagnostics(panel.panelId)).runtimeMode,
          "agent",
        );
        const send = await api.startPanelChatSend(
          panel.panelId,
          "Return the synthetic fixture answer.",
        );
        const deadline = Date.now() + 35_000;
        let state = await api.readChatTurnLifecycle(send.conversationKey);
        while (
          state.sendSettledSequence <= send.sendSettledSequenceBefore &&
          Date.now() < deadline
        ) {
          await Zotero.Promise.delay(100);
          state = await api.readChatTurnLifecycle(send.conversationKey);
        }
        assert.isAbove(
          state.sendSettledSequence,
          send.sendSettledSequenceBefore,
        );
        assert.include(
          state.memory.at(-1)?.text,
          "Synthetic usage fixture answer.",
        );
        assert.lengthOf(state.usageRows, 1);
        assert.include(state.usageRows[0], {
          runtime: "agent",
          model,
          tokenSource: "provider",
          promptTokens: 7123,
          completionTokens: 47,
          totalTokens: 7170,
          cacheReadTokens: 1536,
        });
        const gauge = body.querySelector<HTMLElement>("#llm-token-usage")!;
        assert.include(gauge.textContent, "7.1k / 1M (<1%)");
        assert.notInclude(gauge.title.toLowerCase(), "estimated");

        const win = (
          Zotero.Utilities.Internal as unknown as {
            openPreferences: (pane: string) => Window;
          }
        ).openPreferences("llmforzotero-preferences");
        try {
          const until = Date.now() + 20_000;
          const doc = () => win.document;
          const paneReady = () =>
            doc().querySelector("#llmforzotero-model-sections")
              ?.childElementCount;
          while (!paneReady() && Date.now() < until) {
            await Zotero.Promise.delay(100);
          }
          assert.isOk(paneReady(), "Preferences finished rendering");
          const usageTab = doc().querySelector<HTMLElement>(
            '[data-pref-tab="usage"]',
          );
          assert.isOk(usageTab);
          usageTab!.click();
          const root = doc().querySelector("#llmforzotero-usage-root")!;
          const modelRow = () =>
            Array.from(root.querySelectorAll('[data-usage-row="model"]')).find(
              (row) => row?.textContent?.includes(model),
            );
          while (!modelRow() && Date.now() < until) {
            await Zotero.Promise.delay(100);
          }
          assert.isOk(
            modelRow(),
            `Usage lists ${model} among: ${Array.from(
              root.querySelectorAll(
                '[data-usage-row="model"], [data-usage-empty]',
              ),
              (row) => row?.textContent,
            ).join(", ")}`,
          );
          assert.include(modelRow()!.textContent || "", "7.2k");
        } finally {
          win.close();
        }
      } finally {
        await api.cleanupFixture(fixture);
        await api.reset();
        for (const [name, value] of saved) {
          if (value === undefined) Zotero.Prefs.clear(name, true);
          else Zotero.Prefs.set(name, value as string | number | boolean, true);
        }
      }
    },
  );
});
