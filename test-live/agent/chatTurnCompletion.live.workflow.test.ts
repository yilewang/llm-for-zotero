import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MODEL_ENTRY_ID = "live-chat-model";

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

describe("live: ordinary chat turn completion in the panel", function () {
  this.timeout(600000);

  it("finishes two real chat turns without rebuilding the earlier answers", async function () {
    const credentials = await resolveLiveAgentCredentials();
    assert.isOk(
      credentials,
      "Configure the requested model in the explicitly selected test profile; this test must not silently skip.",
    );
    assert.include(
      ["openai_chat_compat", "anthropic_messages", "responses_api"],
      credentials!.providerProtocol,
    );

    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    let fixture: WorkflowTestFixture | null = null;
    try {
      await withPrefs(
        {
          conversationSystem: "upstream",
          enableClaudeCodeMode: false,
          enableCodexAppServerMode: false,
          modelProviderGroups: JSON.stringify([
            {
              id: "live-chat-provider",
              apiBase: credentials!.apiBase,
              apiKey: credentials!.apiKey,
              providerProtocol: credentials!.providerProtocol,
              models: [
                {
                  id: MODEL_ENTRY_ID,
                  model: credentials!.model,
                  temperature: 0.7,
                  maxTokens: 4096,
                },
              ],
            },
          ]),
          modelProviderGroupsMigrationVersion: 3,
          lastUsedModelEntryId: MODEL_ENTRY_ID,
        },
        async () => {
          fixture = await api.createPaperWithPdfFixture({
            title: "Live chat turn completion",
            pdfTitle: "Live chat turn completion PDF",
            pages: [
              "This synthetic page exists only so the panel has a paper to open.",
            ],
          });
          const panel = await api.renderPanelForItem(fixture.parentItemId);
          await api.selectPanelModelEntry(panel.panelId, MODEL_ENTRY_ID);

          const first = await api.sendLiveChatTurn(
            panel.panelId,
            "Reply with exactly the word OK.",
          );
          assert.isNotEmpty(
            first.answerText.trim(),
            "the first live turn must produce an answer",
          );
          assert.isTrue(
            first.assistantFinalized,
            "the first answer must stop streaming when the turn ends",
          );
          assert.isTrue(
            first.copyActionPresent,
            "the finished first answer must offer its copy action",
          );

          const second = await api.sendLiveChatTurn(
            panel.panelId,
            "Now reply with exactly the word DONE.",
          );
          assert.isNotEmpty(
            second.answerText.trim(),
            "the second live turn must produce an answer",
          );
          assert.isTrue(
            second.earlierWrappersPreserved,
            "finishing a turn must keep the earlier turns' rendered DOM instead of rebuilding the conversation",
          );
          assert.isTrue(
            second.assistantFinalized,
            "the second answer must stop streaming when the turn ends",
          );
          assert.isTrue(
            second.copyActionPresent,
            "the finished second answer must offer its copy action",
          );
          assert.isTrue(
            second.promptDeletable,
            "the finished turn's prompt must regain its delete control",
          );
          assert.isTrue(
            second.promptEditable,
            "the finished turn's prompt must become editable again",
          );
        },
      );
    } finally {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    }
  });
});
