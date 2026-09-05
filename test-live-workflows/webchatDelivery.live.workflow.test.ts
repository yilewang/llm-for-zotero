import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestLiveWebChatTurn,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  ATTACHMENT_DELIVERY_CONTRACT_VERSION,
  relayGetExtensionStatus,
} from "../src/webchat/relayServer";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const WEBCHAT_MODEL_ENTRY_ID = "live-webchat-pdf-delivery";
const WEBCHAT_MODEL_GROUPS = JSON.stringify([
  {
    id: "live-webchat-pdf-provider",
    apiBase: "",
    apiKey: "",
    authMode: "webchat",
    providerProtocol: "web_sync",
    models: [
      {
        id: WEBCHAT_MODEL_ENTRY_ID,
        model: "chatgpt.com",
        temperature: 0,
        maxTokens: 1024,
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

function normalizeExactAnswer(text: string): string {
  return String(text || "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/[.!]$/, "");
}

function assertCommonReceipt(turn: WorkflowTestLiveWebChatTurn): void {
  const message = JSON.stringify(turn, null, 2);
  assert.equal(turn.outcome, "success", message);
  assert.equal(turn.relayStatus, "done", message);
  assert.equal(turn.runState, "done", message);
  assert.equal(turn.completionReason, "settled", message);
  assert.equal(turn.diagnostic?.composerTextMatched, true, message);
  assert.equal(turn.diagnostic?.userTurnMatched, true, message);
  assert.equal(turn.diagnostic?.assistantTurnMatched, true, message);
  assert.equal(turn.diagnostic?.attachmentContractVerified, true, message);
}

async function waitForExtensionCapability(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = relayGetExtensionStatus();
    if (
      status?.chatTabAlive === true &&
      status.contentScriptAlive === true &&
      status.supportedDeliveryContracts?.includes(
        ATTACHMENT_DELIVERY_CONTRACT_VERSION,
      )
    ) {
      return;
    }
    await Zotero.Promise.delay(500);
  }
  throw new Error(
    "Timed out waiting for Sync for Zotero to advertise the required delivery contract.",
  );
}

describe("live workflow: Zotero UI to ChatGPT delivery", function () {
  this.timeout(720_000);

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

  it("proves one exact PDF turn, the visible toggle, and one zero-PDF turn", async function () {
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
        const runId = String(Date.now());
        const pdfMarker = `ZOTERO_UI_PDF_${runId}`;
        const promptOnlyMarker = `ZOTERO_UI_NOPDF_${runId}`;
        fixture = await api.createPaperWithPdfFixture({
          title: `Live WebChat Delivery ${runId}`,
          pdfTitle: `Live WebChat Delivery PDF ${runId}`,
          pages: [`DOCUMENT_SENTINEL: ${pdfMarker}`],
        });
        const attachment = Zotero.Items.get(fixture.pdfAttachmentId);
        const expectedFilename = attachment?.getFilename?.() || "";
        assert.isNotEmpty(expectedFilename, "fixture PDF filename");

        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await waitForExtensionCapability();
        const pdfTurn = await api.sendLiveWebChatTurn(
          panel.panelId,
          "Read the attached PDF and reply with only the value after DOCUMENT_SENTINEL:. Do not add punctuation or formatting.",
        );
        const pdfMessage = JSON.stringify(pdfTurn, null, 2);
        assertCommonReceipt(pdfTurn);
        assert.isTrue(pdfTurn.webchatSendPdf, pdfMessage);
        assert.deepEqual(
          pdfTurn.pdfContextItemIds,
          [fixture.pdfAttachmentId],
          pdfMessage,
        );
        assert.equal(
          normalizeExactAnswer(pdfTurn.responseText),
          pdfMarker,
          pdfMessage,
        );
        assert.equal(pdfTurn.diagnostic?.attachmentRequested, true, pdfMessage);
        assert.equal(
          pdfTurn.diagnostic?.attachmentFilename,
          expectedFilename,
          pdfMessage,
        );
        assert.equal(
          pdfTurn.diagnostic?.attachmentFilenameConfirmed,
          true,
          pdfMessage,
        );
        assert.equal(
          pdfTurn.diagnostic?.attachmentReadyVerified,
          true,
          pdfMessage,
        );
        assert.equal(
          pdfTurn.diagnostic?.submittedAttachmentCount,
          1,
          pdfMessage,
        );
        assert.equal(pdfTurn.diagnostic?.submittedPdfCount, 1, pdfMessage);
        assert.isFalse(pdfTurn.chipAfterTurn.fullText, pdfMessage);

        const toggledOn = await api.toggleWebChatPdfChip(panel.panelId);
        assert.isTrue(toggledOn.fullText, JSON.stringify(toggledOn));
        assert.isFalse(toggledOn.inactive, JSON.stringify(toggledOn));
        const toggledOff = await api.toggleWebChatPdfChip(panel.panelId);
        assert.isFalse(toggledOff.fullText, JSON.stringify(toggledOff));
        assert.isTrue(toggledOff.inactive, JSON.stringify(toggledOff));

        const promptOnlyTurn = await api.sendLiveWebChatTurn(
          panel.panelId,
          `Reply exactly ${promptOnlyMarker}. Do not use or attach a document.`,
        );
        const promptOnlyMessage = JSON.stringify(promptOnlyTurn, null, 2);
        assertCommonReceipt(promptOnlyTurn);
        assert.isFalse(promptOnlyTurn.webchatSendPdf, promptOnlyMessage);
        assert.deepEqual(
          promptOnlyTurn.pdfContextItemIds,
          [],
          promptOnlyMessage,
        );
        assert.equal(
          normalizeExactAnswer(promptOnlyTurn.responseText),
          promptOnlyMarker,
          promptOnlyMessage,
        );
        assert.equal(
          promptOnlyTurn.diagnostic?.attachmentRequested,
          false,
          promptOnlyMessage,
        );
        assert.equal(
          promptOnlyTurn.diagnostic?.submittedAttachmentCount,
          0,
          promptOnlyMessage,
        );
        assert.equal(
          promptOnlyTurn.diagnostic?.submittedPdfCount,
          0,
          promptOnlyMessage,
        );
      },
    );
  });
});
