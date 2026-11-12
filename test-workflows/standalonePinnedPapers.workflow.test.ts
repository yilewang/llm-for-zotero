import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestStandaloneSidePanelDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The standalone window's side panel belongs to the chat shown: Library chat
 * keeps the panel open on its own New tab page and has no pin, and switching
 * back to Paper chat brings the paper's side chat back on its own key.
 *
 * Everything runs in the real window; sends go through the real composers
 * and send flow, and only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-standalone-pinned-papers.invalid/v1";
const GROUP_ID = "workflow-pinned-papers-group";
const ENTRY_ID = "workflow-pinned-papers-model";
const MODEL = "pinned-papers-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
  "standalonePinnedPapers",
];

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: standalone pinned papers", function () {
  this.timeout(240_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

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

  async function waitForSide(
    check: (state: WorkflowTestStandaloneSidePanelDiagnostics) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<WorkflowTestStandaloneSidePanelDiagnostics> {
    let state = await api.getStandaloneSidePanelDiagnostics();
    await until(
      async () => {
        state = await api.getStandaloneSidePanelDiagnostics();
        return check(state);
      },
      () => `${label}: ${JSON.stringify(state)}`,
      timeoutMs,
    );
    return state;
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    Zotero.Prefs.set(PREF_PREFIX + "standalonePinnedPapers", "", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "the fake model is configured");
  });

  after(async function () {
    provider?.restore();
    await api.closeStandalone();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    api.enableLiveAgentSending();
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    await api.closeStandalone();
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    Zotero.Prefs.set(PREF_PREFIX + "standalonePinnedPapers", "", true);
    await api.reset();
  });

  it("gives Library chat its own side panel", async function () {
    const paper = await api.createPaperWithPdfFixture({
      title: "Pinned papers workflow library paper",
      pdfTitle: "Pinned papers workflow library paper PDF",
      pages: ["Pinned papers workflow library paper: one short page."],
    });
    fixtures.push(paper);
    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneSidePanelControl("toggle");
    let side = await api.clickStandaloneSidePanelControl("new-sidechat");
    const paperSideKey = side.sideChat!.conversationKey;

    await api.clickStandaloneTab("open");
    side = await waitForSide(
      (state) =>
        state.open && state.view === "newtab" && state.tabs.length === 0,
      "Library chat: the panel stays open on its own New tab page",
    );
    const pins = await api.listStandalonePinnedPapers();
    assert.isFalse(pins.pinButton.visible, "Library chat has no pin");

    await api.clickStandaloneTab("paper");
    side = await waitForSide(
      (state) => state.open && state.sideChat?.conversationKey === paperSideKey,
      "Paper chat: the paper's side chat is back on its own key",
    );
    assert.lengthOf(side.tabs, 1);
  });
});
