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
    // Gecko fires focus events only in the active window, and a test window
    // behind another app cannot take activation on macOS. The focus
    // manager's test mode lets win.focus() raise it the way a click would.
    preferences!.focus();
    await waitFor(
      () => preferences!.document.hasFocus(),
      "Preferences must take focus",
    );
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

  function storedModel(): string | undefined {
    const groups = JSON.parse(
      String(Zotero.Prefs.get(prefix + "modelProviderGroups", true) || "[]"),
    ) as Array<{ id: string; models: Array<{ model: string }> }>;
    return groups.find((group) => group.id === groupId)?.models[0]?.model;
  }

  /** Whether the model field's suggestion list offers `modelId`. */
  async function waitForListedModel(
    win: Window,
    modelId: string,
    message: string,
  ): Promise<void> {
    await waitFor(
      () => isVisible(part(win, ".llm-pref-model-chevron")),
      message,
    );
    const input = part<HTMLInputElement>(win, ".llm-pref-model-row input");
    input.focus();
    await waitFor(
      () =>
        isVisible(part(win, ".llm-pref-model-list")) &&
        Array.from(
          win.document.querySelectorAll<HTMLElement>(
            `${rowSelector} .llm-pref-model-option`,
          ) as unknown as HTMLElement[],
        ).some((option) => option.dataset.modelId === modelId),
      message,
    );
  }

  const testModePref = "focusmanager.testmode";
  let savedTestMode: unknown;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    savedTestMode = Zotero.Prefs.get(testModePref, true);
    Zotero.Prefs.set(testModePref, true, true);
  });

  afterEach(async function () {
    await closePreferences();
    if (savedTestMode === undefined) Zotero.Prefs.clear(testModePref, true);
    else Zotero.Prefs.set(testModePref, savedTestMode as never, true);
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
    const input = part<HTMLInputElement>(win, ".llm-pref-model-row input");
    assert.isTrue(isVisible(input));
    assert.isFalse(
      isVisible(part(win, ".llm-pref-model-chevron")),
      "without a catalog the field has no list to open",
    );
    assert.isFalse(isVisible(part(win, ".llm-pref-model-list")));

    // Without a catalog every keystroke is saved, as before.
    input.focus();
    input.value = "typed-manual-model";
    input.dispatchEvent(
      new (win as any).InputEvent("input", { bubbles: true }),
    );
    assert.equal(storedModel(), "typed-manual-model");
    assert.isFalse(isVisible(part(win, ".llm-pref-model-list")));
    input.blur();

    const refresh = part<HTMLButtonElement>(win, ".llm-pref-model-refresh");
    assert.exists(refresh);

    api.configureModelCatalogFetch({
      status: 200,
      body: { data: [{ id: "workflow-model-a" }] },
    });
    refresh.click();
    await waitForListedModel(
      win,
      "workflow-model-a",
      "Refresh must list the fetched model in the model field",
    );
    assert.isFalse(isVisible(part(win, ".llm-pref-model-row .llm-pref-hint")));
    assert.equal(
      input.value,
      "typed-manual-model",
      "a saved model that is not in the catalog stays the field value",
    );
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

  it("offers the model list for a customized provider", async function () {
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
    await waitForListedModel(
      win,
      "workflow-custom-a",
      "the customized provider must list the fetched model",
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
    await waitForListedModel(
      win,
      "workflow-zen-a",
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
