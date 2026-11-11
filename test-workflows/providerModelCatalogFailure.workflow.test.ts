import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const prefix = "extensions.zotero.llmforzotero.";
const manualHint =
  "This provider did not return a model list; enter the model name manually.";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
  assert.isTrue(check(), message);
}

function isVisible(element: HTMLElement | null | undefined): boolean {
  return Boolean(element) && element!.style.display !== "none";
}

describe("workflow: model catalog failure hint in Preferences", function () {
  this.timeout(30000);
  let api: WorkflowTestApi;
  let preferences: Window | undefined;
  let previous = new Map<string, unknown>();

  let groupId = "";
  let rowSelector = "";
  let settings: Record<string, string | number> = {};

  // Each test gets its own group id and apiKey so the in-memory catalog
  // cache from an earlier test cannot satisfy a later one.
  function useProvider(
    suffix: string,
    fields: Record<string, unknown> = {},
  ): void {
    groupId = `workflow-catalog-failure-${suffix}`;
    rowSelector = `[data-llm-provider-row="${groupId}"]`;
    settings = {
      modelProviderGroupsMigrationVersion: 3,
      lastUsedModelEntryId: `${groupId}-model`,
      modelProviderGroups: JSON.stringify([
        {
          id: groupId,
          authMode: "api_key",
          providerProtocol: "openai_chat_compat",
          presetIdOverride: "openai",
          apiBase: "https://api.openai.com/v1",
          apiKey: `workflow-key-${suffix}`,
          ...fields,
          models: [{ id: `${groupId}-model`, model: "gpt-saved" }],
        },
      ]),
    };
  }

  function applySettings(): void {
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(prefix + key, value, true);
  }

  async function openPreferences(): Promise<Window> {
    preferences = (Zotero.Utilities.Internal as any).openPreferences(
      "llmforzotero-preferences",
    );
    await waitFor(
      () => Boolean(preferences?.document.querySelector(rowSelector)),
      "provider card must render",
    );
    const row = preferences!.document.querySelector(rowSelector)!;
    if (row.getAttribute("data-open") !== "true")
      row.querySelector<HTMLButtonElement>(".llm-pref-row-toggle")!.click();
    return preferences!;
  }

  async function closePreferences(): Promise<void> {
    preferences?.close();
    await waitFor(
      () => !preferences || preferences.closed,
      "Preferences must close",
    );
    preferences = undefined;
  }

  function part<T extends HTMLElement>(win: Window, selector: string): T {
    return win.document.querySelector(`${rowSelector} ${selector}`) as T;
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
  });

  afterEach(async function () {
    await closePreferences();
    await api.reset();
    for (const [key, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
      else
        Zotero.Prefs.set(
          prefix + key,
          value as string | number | boolean,
          true,
        );
    }
  });

  it("explains a 404 catalog, keeps manual entry, and recovers on Refresh", async function () {
    useProvider("404");
    applySettings();
    api.configureModelCatalogFetch({ status: 404 });
    const win = await openPreferences();
    const hintOf = () =>
      part<HTMLElement>(win, ".llm-pref-model-row .llm-pref-hint");
    await waitFor(
      () =>
        isVisible(hintOf()) &&
        hintOf().dataset.error === "true" &&
        hintOf().textContent === manualHint,
      "the manual-entry hint must appear after the catalog request fails",
    );
    const hint = hintOf();
    assert.isNotEmpty(api.getModelCatalogRequests());
    assert.include(hint.title, "404");
    assert.isTrue(isVisible(part(win, ".llm-pref-model-row input")));
    assert.isFalse(isVisible(part(win, ".llm-pref-model-row select")));
    const refresh = part<HTMLButtonElement>(win, ".llm-pref-model-refresh");
    assert.exists(refresh);

    api.configureModelCatalogFetch({
      status: 200,
      body: { data: [{ id: "workflow-model-a" }] },
    });
    refresh.click();
    await waitFor(
      () =>
        Boolean(
          part(win, ".llm-pref-model-row select")?.querySelector(
            'option[value="workflow-model-a"]',
          ),
        ),
      "Refresh must list the fetched model in the dropdown",
    );
    assert.isFalse(isVisible(part(win, ".llm-pref-model-row .llm-pref-hint")));
    assert.isTrue(isVisible(part(win, ".llm-pref-model-row select")));
  });

  it("shows the unauthorized message for a 401 catalog", async function () {
    useProvider("401");
    applySettings();
    api.configureModelCatalogFetch({ status: 401 });
    const win = await openPreferences();
    const hintOf = () =>
      part<HTMLElement>(win, ".llm-pref-model-row .llm-pref-hint");
    await waitFor(
      () => isVisible(hintOf()) && hintOf().dataset.error === "true",
      "the error status line must appear after the catalog request fails",
    );
    const hint = hintOf();
    assert.include(hint.title, "401");
    assert.include(hint.textContent || "", "401");
  });

  it("offers the model dropdown for a customized provider", async function () {
    useProvider("customized", {
      presetIdOverride: "customized",
      apiBase: "https://llm.example.test/v1",
    });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: [{ id: "workflow-custom-a" }] },
    });
    const win = await openPreferences();
    await waitFor(
      () =>
        Boolean(
          part(win, ".llm-pref-model-row select")?.querySelector(
            'option[value="workflow-custom-a"]',
          ),
        ),
      "the customized provider must list the fetched model in the dropdown",
    );
    assert.include(
      api.getModelCatalogRequests(),
      "https://llm.example.test/v1/models",
    );
    assert.exists(part(win, ".llm-pref-model-refresh"));
  });

  it("lists OpenCode Zen models without an API key", async function () {
    useProvider("zen", {
      presetIdOverride: "opencode",
      apiBase: "https://opencode.ai/zen/v1",
      apiKey: "",
    });
    applySettings();
    api.configureModelCatalogFetch({
      status: 200,
      body: { data: [{ id: "workflow-zen-a" }] },
    });
    const win = await openPreferences();
    await waitFor(
      () =>
        Boolean(
          part(win, ".llm-pref-model-row select")?.querySelector(
            'option[value="workflow-zen-a"]',
          ),
        ),
      "OpenCode Zen must list the fetched model without a key",
    );
    const hint = part<HTMLElement>(win, ".llm-pref-model-row .llm-pref-hint");
    assert.notInclude(hint.textContent || "", "Enter the API key");
    assert.include(
      api.getModelCatalogRequests(),
      "https://opencode.ai/zen/v1/models",
    );
    for (const headers of api.getModelCatalogRequestHeaders())
      assert.notProperty(headers, "Authorization");
  });
});
