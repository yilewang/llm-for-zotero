import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const API_MODEL_ENTRY_ID = "workflow-switch-api-model";
const WEBCHAT_MODEL_ENTRY_ID = "workflow-switch-webchat-model";
const MODEL_GROUPS = JSON.stringify([
  {
    id: "workflow-switch-api-provider",
    authMode: "api_key",
    apiBase: "http://localhost:1234/v1",
    apiKey: "",
    providerProtocol: "openai_chat_compat",
    presetIdOverride: "customized",
    models: [
      {
        id: API_MODEL_ENTRY_ID,
        model: "local-model",
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
    ],
  },
  {
    id: "workflow-switch-webchat-provider",
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

const SWITCHING_PREFS = {
  enableAgentMode: false,
  enableCodexAppServerMode: true,
  enableClaudeCodeMode: false,
  conversationSystem: "upstream",
  modelProviderGroups: MODEL_GROUPS,
  modelProviderGroupsMigrationVersion: 3,
  lastUsedModelEntryId: API_MODEL_ENTRY_ID,
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

function selectedModelEntryId(): unknown {
  return Zotero.Prefs.get(`${PREF_PREFIX}.lastUsedModelEntryId`, true);
}

describe("workflow: webchat mode switching", function () {
  this.timeout(90000);

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

  it("returns to the previous API conversation when an API model is picked from the webchat model menu", async function () {
    await withPrefs(SWITCHING_PREFS, async () => {
      fixture = await api.createPaperWithPdfFixture({
        title: "WebChat Switch Parent",
        pdfTitle: "WebChat Switch PDF",
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const seeded = await api.seedPanelStoredUserMessage(
        panel.panelId,
        "API question asked before webchat",
      );
      const apiConversationKey = seeded.conversationKey;
      assert.isOk(apiConversationKey);

      const entered = await api.selectPanelModelEntry(
        panel.panelId,
        WEBCHAT_MODEL_ENTRY_ID,
      );
      assert.isTrue(entered.webChatMode, "the panel should be in webchat");
      assert.isFalse(
        entered.modelButtonDisabled,
        "the model menu must stay usable inside webchat",
      );
      assert.isTrue(
        entered.runtimeSystemToggles.some(
          (toggle) => toggle.system === "codex" && toggle.visible,
        ),
        "the Codex toggle must stay visible inside webchat",
      );
      assert.notEqual(
        entered.conversationKey,
        apiConversationKey,
        "webchat must anchor on its own hidden session row",
      );
      const webChatSessionKey = entered.conversationKey;

      let left = await api.selectPanelModelEntry(
        panel.panelId,
        API_MODEL_ENTRY_ID,
      );
      // The API key can already be marked loaded from before WebChat. Wait
      // for its transcript to render, not just that cached identity flag.
      const renderDeadline = Date.now() + 15000;
      while (
        !(left.messageText || "").includes(
          "API question asked before webchat",
        ) &&
        Date.now() < renderDeadline
      ) {
        await Zotero.Promise.delay(25);
        left = await api.getDiagnostics(panel.panelId);
      }
      assert.isFalse(left.webChatMode);
      assert.equal(selectedModelEntryId(), API_MODEL_ENTRY_ID);
      assert.equal(
        left.conversationKey,
        apiConversationKey,
        "leaving webchat must return to the API conversation, not the hidden session row",
      );
      assert.include(
        left.messageText || "",
        "API question asked before webchat",
      );

      const rows = await api.listPanelHistory(panel.panelId);
      assert.isTrue(
        rows.some((row) => row.conversationKey === apiConversationKey),
      );
      assert.isFalse(
        rows.some((row) => row.conversationKey === webChatSessionKey),
        "the webchat session row must never surface in local history",
      );
    });
  });

  it("switches to Codex from webchat without leaving a webchat entry selected", async function () {
    await withPrefs(SWITCHING_PREFS, async () => {
      fixture = await api.createPaperWithPdfFixture({
        title: "WebChat Codex Switch Parent",
        pdfTitle: "WebChat Codex Switch PDF",
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const entered = await api.selectPanelModelEntry(
        panel.panelId,
        WEBCHAT_MODEL_ENTRY_ID,
      );
      assert.isTrue(entered.webChatMode);
      const webChatSessionKey = entered.conversationKey;

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      assert.isFalse(codex.webChatMode);
      assert.equal(
        selectedModelEntryId(),
        API_MODEL_ENTRY_ID,
        "switching runtimes must restore an API entry so upstream cannot re-enter webchat",
      );

      const upstream = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(upstream.conversationSystem, "upstream");
      assert.isFalse(
        upstream.webChatMode,
        "returning to upstream must not silently re-enter webchat",
      );
      assert.notEqual(upstream.conversationKey, webChatSessionKey);
    });
  });
});
