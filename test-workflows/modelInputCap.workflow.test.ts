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
          outputTokenLimit: { mode: "auto" },
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
    Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
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

  // Issue #497: the paper text travels in the user turn. The cap still has to
  // give up history first, then paper text, and the question last.
  const DOCUMENT_MARKER = "CAP-DOCUMENT-START";
  const TRUNCATION_NOTICE = "[Context truncated to fit model input limit]";

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    return (content as Array<{ text?: string }>)
      .map((part) => part.text || "")
      .join("\n");
  }

  function documentOf(chars: number): string {
    return `${DOCUMENT_MARKER}\n${"An invented sentence of paper text. ".repeat(Math.ceil(chars / 36))}`;
  }

  it("shortens the paper text and leaves the question whole", function () {
    const question = `Explain Figure 4. ${"Cover every panel in turn. ".repeat(20)}END-OF-QUESTION`;
    const prepared = api.prepareDocumentContextRequest({
      conversationKey: -4971,
      apiBase: "https://relay-497-cap.example/v1",
      apiKey: "workflow-dummy-key",
      model: "relay-497-cap-model",
      providerProtocol: "openai_chat_compat",
      prompt: question,
      context: documentOf(60_000),
      contextMode: "retrieval",
      inputTokenCap: 6_000,
    });
    assert.isTrue(prepared.capped);
    assert.deepInclude(prepared.effects, {
      documentContextTrimmed: true,
      documentContextDropped: false,
      promptTrimmed: false,
    });
    const last = prepared.messages[prepared.messages.length - 1];
    assert.equal(last.role, "user");
    const text = textOf(last.content);
    assert.include(text, DOCUMENT_MARKER, "the paper is in the user turn");
    assert.include(text, TRUNCATION_NOTICE);
    assert.include(text, question, "the question is not cut");
    assert.isBelow(text.indexOf(TRUNCATION_NOTICE), text.indexOf(question));
    for (const message of prepared.messages) {
      if (message.role === "system")
        assert.notInclude(textOf(message.content), DOCUMENT_MARKER);
    }
  });

  it("keeps a cached paper when older turns are dropped", function () {
    const turn = (index: number) => [
      {
        role: "user" as const,
        content: `Question ${index}. ${"Filler question text. ".repeat(280)}`,
      },
      {
        role: "assistant" as const,
        content: `Answer ${index}. ${"Filler answer text. ".repeat(300)}`,
      },
    ];
    const prepared = api.prepareDocumentContextRequest({
      conversationKey: -4972,
      // DeepSeek caches a stable prefix, so the paper is anchored at the head.
      apiBase: "https://api.deepseek.com/anthropic",
      apiKey: "workflow-dummy-key",
      model: "deepseek-flash",
      providerProtocol: "anthropic_messages",
      prompt: "Explain Figure 4.",
      context: documentOf(8_000),
      history: [1, 2, 3, 4, 5, 6].flatMap(turn),
      contextMode: "full",
      inputTokenCap: 8_000,
    });
    assert.isTrue(prepared.capped);
    assert.deepInclude(prepared.effects, {
      historyDropped: true,
      documentContextTrimmed: false,
      documentContextDropped: false,
    });
    const holders = prepared.messages.filter((message) =>
      textOf(message.content).includes(DOCUMENT_MARKER),
    );
    assert.lengthOf(holders, 1, "the paper is sent once");
    const firstUser = prepared.messages.find(
      (message) => message.role === "user",
    );
    assert.strictEqual(
      holders[0],
      firstUser,
      "the paper opens the first user message that is left",
    );
    assert.match(textOf(firstUser!.content), /^Document Context:\n/);
    assert.notInclude(
      prepared.messages.map((message) => textOf(message.content)).join("\n"),
      "Question 1.",
      "the oldest turn went first",
    );
    const last = prepared.messages[prepared.messages.length - 1];
    assert.include(textOf(last.content), "Explain Figure 4.");
  });
});
