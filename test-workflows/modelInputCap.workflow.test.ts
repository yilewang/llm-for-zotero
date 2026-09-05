import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import type { ModelProviderGroup } from "../src/utils/modelProviders";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MODEL_ENTRY_ID = "workflow-qwen38-model";

function providerGroups(inputTokenCap: number): ModelProviderGroup[] {
  return [
    {
      id: "workflow-qwen-provider",
      apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "workflow-test-key",
      authMode: "api_key",
      providerProtocol: "openai_chat_compat",
      models: [
        {
          id: MODEL_ENTRY_ID,
          model: "qwen3.8-max",
          temperature: 0.3,
          maxTokens: 4096,
          inputTokenCap,
        },
      ],
    },
  ];
}

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
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value, true);
    }
  }
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: user-authoritative model input cap", function () {
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

  it("keeps an edited cap through remount, send, and provider usage", async function () {
    await withPrefs(
      {
        conversationSystem: "upstream",
        modelProviderGroups: JSON.stringify(providerGroups(1_000_000)),
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: MODEL_ENTRY_ID,
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Input Cap Workflow Parent",
          pdfTitle: "Input Cap Workflow PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredTurn(
          panel.panelId,
          "Earlier question",
          "Earlier answer",
        );

        const remounted = await api.remountPanel(panel.panelId);
        const restored = await api.getDiagnostics(remounted.panelId);
        assert.include(restored.tokenUsageText || "", "/ 1M");

        const edited = await api.setWorkflowModelInputCap(
          remounted.panelId,
          MODEL_ENTRY_ID,
          750_000,
        );
        assert.include(edited.tokenUsageText || "", "/ 750k");

        const request = await api.askCapturingFinalRequest(
          remounted.panelId,
          "Continue with the edited cap",
        );
        assert.deepInclude(request.inputCap, {
          limitTokens: 750_000,
          limitSource: "advanced",
        });

        const afterUsage = await api.simulateProviderContextUsage(
          remounted.panelId,
          {
            contextTokens: 50_000,
            contextWindow: 128_000,
            contextWindowIsAuthoritative: true,
          },
        );
        assert.equal(afterUsage.tokenUsageText, "50k / 750k (7%)");
      },
    );
  });
});
