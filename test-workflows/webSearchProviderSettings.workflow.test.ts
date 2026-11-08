import { assert } from "chai";
import { setModelProviderGroups } from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestPanel,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * Web search provider choice, end to end in the real Zotero host: the
 * preferences window renders the card from saved prefs and model profiles,
 * and a real Agent turn sends the tool schemas that follow from them. The
 * chat model is a held fake provider; DeepSeek and OpenRouter are blocked so
 * that the dummy key never leaves the machine and no search is made. Requests
 * through fetch and through Zotero.HTTP.request are both blocked.
 *
 * Contract under test:
 * - the default, and an old saved "auto", read as Tavily with only the Tavily
 *   section shown;
 * - choosing DeepSeek shows only the DeepSeek section (profile key masked)
 *   and the Agent searches through DeepSeek;
 * - choosing Tavily again shows only the Tavily section.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-web-search-provider.invalid/v1";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const CHAT_GROUP_ID = "workflow-web-search-chat-group";
const CHAT_ENTRY_ID = "workflow-web-search-chat-model";
const DEEPSEEK_GROUP_ID = "workflow-web-search-deepseek-group";
const DEEPSEEK_KEY = "sk-workflow-dummy-deepseek-9876";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "enableAgentMode",
  "outputTokenAutoMigrationNoticePending",
  "webAccessProvider",
  "tavilyApiKey",
];

type OfferedTool = {
  name?: string;
  description?: string;
  parameters?: {
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
  };
};

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function chatGroup() {
  return {
    id: CHAT_GROUP_ID,
    authMode: "api_key",
    apiBase: API_BASE,
    apiKey: "workflow-dummy-key",
    providerProtocol: "openai_chat_compat",
    models: [
      {
        id: CHAT_ENTRY_ID,
        model: "web-search-provider-model",
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
    ],
  };
}

function deepseekGroup(apiBase: string) {
  return {
    id: DEEPSEEK_GROUP_ID,
    authMode: "api_key",
    apiBase,
    apiKey: DEEPSEEK_KEY,
    providerProtocol: "openai_chat_compat",
    models: [
      {
        id: "workflow-web-search-deepseek-model",
        model: "deepseek-v4-flash",
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
    ],
  };
}

function openPreferences(): Window {
  const win = (
    Zotero.Utilities.Internal as unknown as {
      openPreferences: (pane: string) => Window;
    }
  ).openPreferences("llmforzotero-preferences");
  assert.isOk(win, "preferences window should open");
  return win;
}

async function closePreferences(win: Window): Promise<void> {
  win.close();
  const deadline = Date.now() + 10000;
  while (!win.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.isTrue(
    win.closed,
    "preferences window should close before the next suite runs",
  );
}

/** Wait until the preferences pane has built its dynamic settings UI. */
async function waitForPaneReady(win: Window): Promise<Element> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const pane = win.document.querySelector("#llmforzotero-prefs");
    const modelSections = pane?.querySelector("#llmforzotero-model-sections");
    const rect = (pane as HTMLElement | null)?.getBoundingClientRect?.();
    if (pane && rect && rect.height > 0 && modelSections?.childElementCount) {
      return pane;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("preferences pane never finished rendering");
}

describe("workflow: web search provider choice", function () {
  this.timeout(180_000);

  let api: WorkflowTestApi;
  let chat: HeldChatProvider;
  const blocked: HeldChatProvider[] = [];
  const previousPrefs = new Map<string, unknown>();
  let originalHttpRequest: typeof Zotero.HTTP.request | undefined;
  let fixture: WorkflowTestFixture | undefined;
  let prefsWindow: Window | undefined;

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  /**
   * Sends one Agent turn through the panel's own composer, reads the tool
   * schemas from the request the model received, then lets the turn finish
   * with plain text so no tool runs.
   */
  async function offeredTools(
    panel: WorkflowTestPanel,
    marker: string,
  ): Promise<Map<string, OfferedTool>> {
    const sent = await api.startPanelChatSend(
      panel.panelId,
      `${marker}: search the web for the latest Zotero release.`,
    );
    const stream = await chat.waitForStream(marker, 30_000);
    const body = JSON.parse(stream.requestBody) as {
      tools?: { function?: OfferedTool }[];
    };
    const answer = `${marker} answer`;
    stream.push(answer);
    stream.finish();
    let last: unknown = null;
    await until(
      async () => {
        const state = await api.readChatTurnLifecycle(sent.conversationKey);
        const reply = [...state.memory]
          .reverse()
          .find((message) => message.role === "assistant");
        last = { requestPending: state.requestPending, reply };
        return (
          !state.requestPending &&
          Boolean(reply) &&
          reply!.streaming !== true &&
          String(reply!.text || "").includes(answer)
        );
      },
      () => `the turn "${marker}" finishes: ${JSON.stringify(last)}`,
      30_000,
    );
    return new Map(
      (body.tools || []).map((tool) => [
        tool.function?.name || "",
        tool.function || {},
      ]),
    );
  }

  function card(win: Window) {
    const doc = win.document;
    const element = (id: string) =>
      doc.querySelector(`#llmforzotero-${id}`) as HTMLElement | null;
    return {
      select: element("web-access-provider") as HTMLSelectElement | null,
      tavily: element("tavily-settings"),
      tavilyKey: element("tavily-api-key") as HTMLInputElement | null,
      anysearch: element("anysearch-settings"),
      deepseek: element("deepseek-search-settings"),
      deepseekKey: element("deepseek-search-key"),
    };
  }

  function describeCard(win: Window): string {
    const view = card(win);
    return JSON.stringify({
      select: view.select?.value,
      tavilyHidden: view.tavily?.hidden,
      anysearchHidden: view.anysearch?.hidden,
      deepseekHidden: view.deepseek?.hidden,
      deepseekKey: view.deepseekKey?.textContent,
    });
  }

  function commitTavilyKey(win: Window, value: string): void {
    const input = card(win).tavilyKey;
    assert.isOk(input, "the Tavily key field exists");
    input!.value = value;
    const EventCtor = (win as unknown as { Event: typeof Event }).Event;
    input!.dispatchEvent(new EventCtor("change", { bubbles: true }));
  }

  function chooseProvider(win: Window, value: string): void {
    const select = card(win).select;
    assert.isOk(select, "the provider select exists");
    select!.value = value;
    const EventCtor = (win as unknown as { Event: typeof Event }).Event;
    select!.dispatchEvent(new EventCtor("change", { bubbles: true }));
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    chat = installHeldChatProvider(API_BASE);
    // Nothing in this suite may reach DeepSeek or the relay: their hosts get
    // a local 404 for any request made through the plugin's fetch, and a
    // rejected request through Zotero.HTTP.request (the DeepSeek search client).
    blocked.push(installHeldChatProvider(DEEPSEEK_ORIGIN));
    blocked.push(installHeldChatProvider("https://openrouter.ai"));
    originalHttpRequest = Zotero.HTTP.request;
    Zotero.HTTP.request = function (
      method: string,
      url: string,
      ...rest: any[]
    ) {
      if (
        String(url).startsWith(DEEPSEEK_ORIGIN) ||
        String(url).startsWith("https://openrouter.ai")
      ) {
        return Promise.reject(new Error(`blocked in workflow test: ${url}`));
      }
      return originalHttpRequest!.call(Zotero.HTTP, method, url, ...rest);
    } as typeof Zotero.HTTP.request;
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableAgentMode", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "agent", true);
    Zotero.Prefs.set(PREF_PREFIX + "webAccessProvider", "auto", true); // an old saved value
    Zotero.Prefs.set(PREF_PREFIX + "tavilyApiKey", "", true);
    setModelProviderGroups([
      chatGroup(),
      deepseekGroup(`${DEEPSEEK_ORIGIN}/v1`),
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", CHAT_ENTRY_ID, true);
  });

  after(async function () {
    if (prefsWindow && !prefsWindow.closed) await closePreferences(prefsWindow);
    chat?.failOpenStreams("workflow suite ended");
    if (originalHttpRequest) Zotero.HTTP.request = originalHttpRequest;
    // Restore the fetch wrappers in the reverse order of installation.
    for (const provider of blocked.splice(0).reverse()) provider.restore();
    chat?.restore();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  it("defaults to Tavily and offers DeepSeek only when chosen", async function () {
    await api.reset();
    api.enableLiveAgentSending();
    fixture = await api.createPaperWithPdfFixture({
      title: "Web search provider choice",
      pdfTitle: "Web search provider PDF",
      pages: ["Web search provider: one short page of text."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    assert.equal(
      (await api.getDiagnostics(panel.panelId)).runtimeMode,
      "agent",
      "the panel runs the in-plugin Agent",
    );

    // An old saved "auto" reads as Tavily, even with a DeepSeek profile.
    prefsWindow = openPreferences();
    await waitForPaneReady(prefsWindow);
    const win = prefsWindow;
    let view = card(win);
    assert.equal(view.select?.value, "tavily", `select: ${describeCard(win)}`);
    assert.isFalse(view.tavily?.hidden, "the Tavily section is shown");
    assert.isTrue(view.deepseek?.hidden);
    assert.isTrue(view.anysearch?.hidden);
    const none = await offeredTools(panel, "web-search-tavily-nokey");
    assert.isFalse(none.has("web_search"), "no Tavily key, no web_search");

    // Choose DeepSeek: only its section shows, and the Agent uses it.
    chooseProvider(win, "deepseek");
    view = card(win);
    assert.isFalse(view.deepseek?.hidden, `DeepSeek: ${describeCard(win)}`);
    assert.isTrue(view.tavily?.hidden);
    assert.isTrue(view.anysearch?.hidden);
    assert.include(
      view.deepseekKey?.textContent || "",
      "…9876",
      "the DeepSeek block names the masked profile key",
    );
    assert.notInclude(
      view.deepseekKey?.textContent || "",
      DEEPSEEK_KEY,
      "the full key is not shown",
    );
    const deepseekTools = await offeredTools(panel, "web-search-deepseek");
    const search = deepseekTools.get("web_search");
    assert.isOk(search, "web_search is offered with a DeepSeek profile");
    assert.equal(search!.parameters?.properties?.query?.maxLength, 128);
    assert.notProperty(search!.parameters?.properties || {}, "depth");
    assert.notProperty(search!.parameters?.properties || {}, "topic");
    assert.deepEqual(search!.parameters?.required, ["query", "need"]);
    assert.property(search!.parameters?.properties || {}, "gap");
    assert.include(search!.description || "", "DeepSeek Search");
    const deepseekRead = Object.keys(
      deepseekTools.get("web_read")?.parameters?.properties || {},
    );
    assert.include(deepseekRead, "urls", "web_read takes URLs on DeepSeek");
    for (const name of ["query", "depth", "chunksPerSource"])
      assert.notInclude(
        deepseekRead,
        name,
        `web_read has no ${name} on DeepSeek`,
      );

    // Back to Tavily: only its section shows, and it needs its own key.
    chooseProvider(win, "tavily");
    view = card(win);
    assert.isFalse(view.tavily?.hidden, `Tavily: ${describeCard(win)}`);
    assert.isTrue(view.deepseek?.hidden);
    assert.isTrue(view.anysearch?.hidden);
    const noKey = await offeredTools(panel, "web-search-tavily-again");
    assert.isFalse(noKey.has("web_search"), "no fallback to DeepSeek");
    commitTavilyKey(win, "tvly-workflow-dummy-key");
    const tavilyTools = await offeredTools(panel, "web-search-tavily-key");
    const tavilySearch = tavilyTools.get("web_search");
    assert.isOk(tavilySearch, "web_search is offered with a Tavily key");
    assert.property(tavilySearch!.parameters?.properties || {}, "depth");
    assert.notInclude(tavilySearch!.description || "", "DeepSeek");

    await closePreferences(win);
    prefsWindow = undefined;
  });
});
