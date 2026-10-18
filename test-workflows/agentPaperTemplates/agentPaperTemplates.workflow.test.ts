import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../../test-live/agent/liveAgentCredentials";
import { renderShortcuts } from "../../src/modules/contextPanel/shortcuts";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../../src/modules/contextPanel/workflowTestTypes";

declare const Services: any;
declare const Zotero: any;
const prefix = "extensions.zotero.llmforzotero";

describe("workflow: Agent paper templates", function () {
  this.timeout(360000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture;
  const fixtures: WorkflowTestFixture[] = [];
  let panel: { panelId: string };
  let body: HTMLElement;
  const saved = new Map<string, unknown>();
  const marker = "PAPER-CONTEXT-ALPHA-7319";
  const prompt =
    "请调用 library_read 读取当前论文的全文，只回复正文中以 PAPER-CONTEXT- 开头的完整验证标记。不要搜索其他论文，不要写入。";
  const put = (key: string, value: any) => {
    const full = `${prefix}.${key}`;
    if (!saved.has(full)) saved.set(full, Zotero.Prefs.get(full, true));
    Zotero.Prefs.set(full, value, true);
  };
  async function until(check: () => boolean | Promise<boolean>) {
    const end = Date.now() + 180000;
    while (!(await check())) {
      if (Date.now() > end)
        throw new Error("Agent template workflow timed out");
      await Zotero.Promise.delay(100);
    }
  }
  const root = () => body.querySelector<HTMLElement>("#llm-main")!;
  before(async function () {
    api = Zotero.LLMForZotero.api.workflowTest;
    put("conversationSystem", "upstream");
    put("enableAgentMode", true);
    put("lastUsedRuntimeMode", "agent");
    put("shortcuts", JSON.stringify({ summarize: prompt }));
    fixture = await api.createPaperWithPdfFixture({
      title: "Agent current-paper template fixture",
      pdfTitle: "Current-paper PDF",
      pages: [
        `This paper verifies current attachment identity. The exact verification marker is ${marker}.`,
      ],
    });
    fixtures.push(fixture);
    panel = await api.renderPanelForItem(fixture.parentItemId);
    body = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    assert.isOk(body);
    await renderShortcuts(
      body,
      Zotero.Items.get(fixture.parentItemId),
      "paper",
    );
  });
  after(async function () {
    await api.closeStandalone();
    for (const value of fixtures) await api.cleanupFixture(value);
    for (const [key, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value, true);
    }
  });
  it("shows paper templates and sends a click through the composer", async function () {
    await until(() =>
      Boolean(body.querySelector("#llm-shortcuts .llm-shortcut-btn")),
    );
    const button = body.querySelector<HTMLButtonElement>(
      '#llm-shortcuts [data-shortcut-id="summarize"]',
    )!;
    assert.isOk(button);
    assert.isFalse(button.disabled);
    let sent = "";
    const send = body.querySelector<HTMLButtonElement>("#llm-send")!;
    const capture = (event: Event) => {
      event.stopImmediatePropagation();
      event.preventDefault();
      sent = body.querySelector<HTMLTextAreaElement>("#llm-input")!.value;
    };
    send.addEventListener("click", capture, true);
    try {
      button.click();
      assert.equal(sent, button.dataset.prompt);
    } finally {
      send.removeEventListener("click", capture, true);
    }
  });
  it("keeps templates available in a library conversation", async function () {
    await api.togglePanelConversationMode(panel.panelId);
    await until(() => root().dataset.conversationKind === "global");
    await until(() =>
      Boolean(body.querySelector("#llm-shortcuts .llm-shortcut-btn")),
    );
    assert.isFalse(
      body.querySelector<HTMLButtonElement>("#llm-shortcuts .llm-shortcut-btn")!
        .disabled,
    );
    await api.togglePanelConversationMode(panel.panelId);
    await until(() => root().dataset.conversationKind === "paper");
  });
  it("opens the standalone window on the source panel's paper", async function () {
    put(
      "lastUsedConversationModeMap",
      JSON.stringify({ [Zotero.Libraries.userLibraryID]: "global" }),
    );
    body.querySelector<HTMLButtonElement>("#llm-popout")!.click();
    await until(
      async () =>
        (await api.getStandaloneDiagnostics()).conversationKind === "paper",
    );
    const state = await api.getStandaloneDiagnostics();
    assert.equal(state.basePaperItemId, fixture.parentItemId);
    await api.closeStandalone();
  });
  const live = Services.env.get("LLM_FOR_ZOTERO_AGENT_LIVE") === "1";
  const engines = Services.env.get("LLM_FOR_ZOTERO_HARNESS_WORKER")
    ? ["builtin", "deepseek_harness"]
    : ["builtin"];
  for (const engine of engines) {
    (live ? it : it.skip)(
      `reads the current PDF after a template click with ${engine}`,
      async function () {
        const credentials = await resolveLiveAgentCredentials();
        assert.isOk(credentials, "A configured live provider is required");
        put(
          "modelProviderGroups",
          JSON.stringify([
            {
              id: "paper-template-provider",
              apiBase: credentials!.apiBase,
              apiKey: credentials!.apiKey,
              providerProtocol: credentials!.providerProtocol,
              models: [
                {
                  id: "paper-template-model",
                  model: credentials!.model,
                  maxTokens: 4096,
                },
              ],
            },
          ]),
        );
        put("lastUsedModelEntryId", "paper-template-model");
        put("agentExecutionEngine", engine);
        put("originalAgentPermissionMode", "safe");
        if (engine === "deepseek_harness") {
          put(
            "deepseekHarnessNodePath",
            Services.env.get("LLM_FOR_ZOTERO_HARNESS_NODE"),
          );
          put(
            "deepseekHarnessWorkerPath",
            Services.env.get("LLM_FOR_ZOTERO_HARNESS_WORKER"),
          );
        }
        fixture = await api.createPaperWithPdfFixture({
          title: `Current PDF for ${engine}`,
          pdfTitle: `PDF for ${engine}`,
          pages: [
            `This is a synthetic PDF. Its verification marker is ${marker}.`,
          ],
        });
        fixtures.push(fixture);
        panel = await api.renderPanelForItem(fixture.parentItemId);
        body = Zotero.getMainWindow().document.querySelector(
          `[data-workflow-panel-id="${panel.panelId}"]`,
        )!;
        await api.selectPanelModelEntry(panel.panelId, "paper-template-model");
        if (root().dataset.runtimeMode !== "agent")
          await api.clickPanelRuntimeModeToggle(panel.panelId);
        await renderShortcuts(
          body,
          Zotero.Items.get(fixture.parentItemId),
          "paper",
        );
        const button = body.querySelector<HTMLButtonElement>(
          '#llm-shortcuts [data-shortcut-id="summarize"]',
        )!;
        // Keep the live test bounded while exercising the real shortcut send.
        button.dataset.prompt = prompt;
        const key = Number(root().dataset.itemId);
        const before = await api.readChatTurnLifecycle(key);
        button.click();
        await until(async () => {
          const state = await api.readChatTurnLifecycle(key);
          return (
            !state.requestPending &&
            state.sendSettledSequence > before.sendSettledSequence
          );
        });
        const state = await api.readChatTurnLifecycle(key);
        assert.isTrue(
          state.memory.some(
            (m) => m.role === "assistant" && String(m.text).includes(marker),
          ),
        );
        assert.equal(root().dataset.basePaperItemId, `${fixture.parentItemId}`);
      },
    );
  }
});
