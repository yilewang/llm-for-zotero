import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const WEBCHAT_MODEL_ENTRY_ID = "workflow-webchat-model";
const WEBCHAT_MODEL_GROUPS = JSON.stringify([
  {
    id: "workflow-webchat-provider",
    apiBase: "",
    apiKey: "",
    authMode: "webchat",
    providerProtocol: "web_sync",
    models: [
      {
        id: WEBCHAT_MODEL_ENTRY_ID,
        model: "chatgpt.com",
        temperature: 0.7,
        maxTokens: 4096,
      },
    ],
  },
]);

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

describe("workflow: panel lifecycle", function () {
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

  it("keeps a duplicate setup callback idempotent", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Duplicate Panel Setup Parent",
          pdfTitle: "Duplicate Panel Setup PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const initial = await api.getDiagnostics(panel.panelId);
        assert.isFalse(
          initial.runtimeSystemToggles.some(
            (toggle) => toggle.system === "codex" && toggle.visible,
          ),
        );

        const duplicate = await api.exerciseDuplicatePanelSetup(panel.panelId);
        assert.isTrue(duplicate.samePanelRoot);
        assert.isNotEmpty(duplicate.initializationGenerationBefore);
        assert.equal(
          duplicate.initializationGenerationAfter,
          duplicate.initializationGenerationBefore,
        );
        assert.isTrue(duplicate.panelStateSyncBefore);
        assert.isTrue(duplicate.panelStateSyncAfter);

        Zotero.Prefs.set(`${PREF_PREFIX}.enableCodexAppServerMode`, true, true);
        await Zotero.Promise.delay(250);
        const afterPreferenceChange = await api.getDiagnostics(panel.panelId);
        assert.isTrue(
          afterPreferenceChange.runtimeSystemToggles.some(
            (toggle) => toggle.system === "codex" && toggle.visible,
          ),
        );
      },
    );
  });

  it("preserves an unsent WebChat draft through a panel state refresh", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
        modelProviderGroups: WEBCHAT_MODEL_GROUPS,
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: WEBCHAT_MODEL_ENTRY_ID,
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "WebChat Draft Refresh Parent",
          pdfTitle: "WebChat Draft Refresh PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const draft = "This unsent WebChat prompt must survive.";
        const result = await api.exercisePanelDraftStateRefresh(
          panel.panelId,
          draft,
        );

        assert.isTrue(result.webChatMode);
        assert.equal(result.inputBeforeRefresh, draft);
        assert.equal(result.inputAfterRefresh, draft);
      },
    );
  });
});
