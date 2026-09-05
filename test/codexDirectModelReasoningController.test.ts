import { assert } from "chai";
import { config } from "../package.json";
import { createCodexDirectModelReasoningController } from "../src/modules/contextPanel/setupHandlers/controllers/codexDirectModelReasoningController";
import {
  getModelEntryById,
  setLastUsedModelEntryId,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import {
  loadCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { setCodexDirectReasoningSelection } from "../src/codexAuth/reasoningPrefs";

describe("Codex Direct panel model/reasoning controller", function () {
  const globals = globalThis as typeof globalThis & { Zotero?: typeof Zotero };
  let originalZotero: typeof Zotero | undefined;

  before(function () {
    originalZotero = globals.Zotero;
  });

  beforeEach(async function () {
    const prefs = new Map<string, unknown>();
    globals.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as typeof Zotero;
    resetCodexDirectCatalogForTests();
    setModelProviderGroups([
      {
        id: "direct",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        models: [{ id: "direct-row", model: "gpt-direct" }],
      },
    ]);
    setLastUsedModelEntryId("direct-row");
    await loadCodexDirectCatalog({
      authPath: "/test/auth.json",
      readText: async () =>
        JSON.stringify({ tokens: { access_token: "token" } }),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-direct",
                display_name: "GPT Direct",
                visibility: "list",
                priority: 1,
                supported_reasoning_levels: [
                  { effort: "medium" },
                  { effort: "high" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });
  });

  afterEach(function () {
    resetCodexDirectCatalogForTests();
  });

  after(function () {
    if (originalZotero) globals.Zotero = originalZotero;
    else delete globals.Zotero;
  });

  it("owns selected availability, reasoning reconciliation, and send config", function () {
    const controller = createCodexDirectModelReasoningController({
      getSelectedEntry: () => getModelEntryById("direct-row"),
      isRuntimeConversationSystem: () => false,
      onStateChange: () => undefined,
    });

    assert.equal(controller.getSelectedEntry()?.model, "gpt-direct");
    assert.deepEqual(
      controller
        .resolveReasoningSelection()
        .choices.map((choice) => choice.value),
      ["auto", "medium", "high"],
    );
    setCodexDirectReasoningSelection("gpt-direct", "high");
    assert.equal(controller.resolveReasoningSelection().mode, "high");
    assert.equal(controller.getSendReasoning()?.effort, "high");
    assert.equal(
      controller.getRetryReasoning(getModelEntryById("direct-row")!)?.effort,
      "high",
    );
    controller.dispose();
  });

  it("rejects an unavailable saved model before send", function () {
    setModelProviderGroups([
      {
        id: "direct",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        models: [{ id: "missing-row", model: "missing-model" }],
      },
    ]);
    setLastUsedModelEntryId("missing-row");
    const controller = createCodexDirectModelReasoningController({
      getSelectedEntry: () => getModelEntryById("missing-row"),
      isRuntimeConversationSystem: () => false,
      onStateChange: () => undefined,
    });

    assert.throws(
      () => controller.getSendReasoning(),
      "saved Codex Direct model is unavailable",
    );
    controller.dispose();
  });

  it("unsubscribes catalog refreshes on dispose", function () {
    let refreshes = 0;
    const controller = createCodexDirectModelReasoningController({
      getSelectedEntry: () => getModelEntryById("direct-row"),
      isRuntimeConversationSystem: () => false,
      onStateChange: () => {
        refreshes += 1;
      },
    });
    controller.dispose();
    resetCodexDirectCatalogForTests();

    assert.equal(refreshes, 0);
    assert.equal(
      globalThis.Zotero.Prefs.get(
        `${config.prefsPrefix}.lastUsedModelEntryId`,
        true,
      ),
      "direct-row",
    );
  });
});
