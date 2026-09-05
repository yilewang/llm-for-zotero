import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestWebChatPdfToggleDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const WEBCHAT_MODEL_ENTRY_ID = "workflow-webchat-pdf-delivery";
const WEBCHAT_MODEL_GROUPS = JSON.stringify([
  {
    id: "workflow-webchat-pdf-provider",
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

function diagnosticMessage(
  diagnostics: WorkflowTestWebChatPdfToggleDiagnostics,
): string {
  return JSON.stringify(diagnostics, null, 2);
}

describe("workflow: WebChat PDF delivery modes", function () {
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

  it("keeps PDF and prompt-only sends aligned with the visible chip across success and failure", async function () {
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
          title: "Workflow WebChat Delivery Parent",
          pdfTitle: "Workflow WebChat Delivery PDF",
          pages: ["WEBCHAT_WORKFLOW_PDF_SENTINEL_20260809"],
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const mirrorPanel = await api.renderPanelForItem(fixture.parentItemId);
        const result = await api.exerciseWebChatPdfToggleWorkflow(
          panel.panelId,
          mirrorPanel.panelId,
        );
        const message = diagnosticMessage(result);

        assert.isTrue(result.webChatMode, message);
        assert.isTrue(result.initialChip.fullText, message);
        assert.isFalse(result.initialChip.inactive, message);
        assert.equal(
          result.initialChip.contextItemId,
          fixture.pdfAttachmentId,
          message,
        );

        assert.isTrue(result.initialPdfTurn.webchatSendPdf, message);
        assert.deepEqual(
          result.initialPdfTurn.pdfContextItemIds,
          [fixture.pdfAttachmentId],
          message,
        );
        assert.isFalse(result.initialPdfTurn.chipAfterTurn.fullText, message);
        assert.isTrue(result.initialPdfTurn.chipAfterTurn.inactive, message);

        assert.isFalse(result.automaticPromptOnlyTurn.webchatSendPdf, message);
        assert.deepEqual(
          result.automaticPromptOnlyTurn.pdfContextItemIds,
          [],
          message,
        );

        assert.isTrue(result.chipAfterToggleOn.fullText, message);
        assert.isFalse(result.chipAfterToggleOn.inactive, message);
        assert.isTrue(result.failedPdfTurn.webchatSendPdf, message);
        assert.deepEqual(
          result.failedPdfTurn.pdfContextItemIds,
          [fixture.pdfAttachmentId],
          message,
        );
        assert.isTrue(result.failedPdfTurn.chipAfterTurn.fullText, message);
        assert.isFalse(result.failedPdfTurn.chipAfterTurn.inactive, message);

        assert.isFalse(result.chipAfterToggleOff.fullText, message);
        assert.isTrue(result.chipAfterToggleOff.inactive, message);
        assert.isFalse(result.explicitPromptOnlyTurn.webchatSendPdf, message);
        assert.deepEqual(
          result.explicitPromptOnlyTurn.pdfContextItemIds,
          [],
          message,
        );

        assert.isOk(result.mirrorPanel, message);
        assert.isTrue(result.mirrorPanel!.initialChip.fullText, message);
        assert.isFalse(
          result.mirrorPanel!.afterInitialPdfTurn.fullText,
          message,
        );
        assert.isFalse(
          result.mirrorPanel!.afterAutomaticPromptOnlyTurn.fullText,
          message,
        );
        assert.isTrue(result.mirrorPanel!.afterToggleOn.fullText, message);
        assert.isTrue(result.mirrorPanel!.afterFailedPdfTurn.fullText, message);
        assert.isFalse(result.mirrorPanel!.afterToggleOff.fullText, message);
        assert.isFalse(
          result.mirrorPanel!.afterExplicitPromptOnlyTurn.fullText,
          message,
        );
      },
    );
  });
});
