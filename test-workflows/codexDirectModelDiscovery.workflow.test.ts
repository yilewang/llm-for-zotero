import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const prefix = "extensions.zotero.llmforzotero.";
const groupId = "workflow-codex-direct-discovery";
const newRowId = "workflow-codex-direct-new";
const rowSelector = `[data-llm-provider-row="${groupId}"]`;

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
  assert.isTrue(check(), message);
}

describe("workflow: Codex Direct model discovery in Preferences", function () {
  this.timeout(30000);
  let api: WorkflowTestApi;
  let preferences: Window | undefined;
  let previous: Map<string, unknown>;

  const settings = {
    modelProviderGroupsMigrationVersion: 3,
    lastUsedModelEntryId: "workflow-codex-direct-old",
    modelProviderGroups: JSON.stringify([
      {
        id: groupId,
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        models: [
          { id: "workflow-codex-direct-old", model: "gpt-6-astra" },
          { id: newRowId, model: "" },
        ],
      },
    ]),
  };

  async function openPreferences(): Promise<Window> {
    preferences = (Zotero.Utilities.Internal as any).openPreferences(
      "llmforzotero-preferences",
    );
    await waitFor(
      () => Boolean(preferences?.document.querySelector(rowSelector)),
      "Codex Direct provider card must render",
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

  function selectors(win: Window): HTMLSelectElement[] {
    return Array.from(
      win.document.querySelectorAll(
        `${rowSelector} .llm-pref-model-row select`,
      ),
    ) as HTMLSelectElement[];
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(prefix + key, value, true);
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

  for (const cachedClientVersion of ["0.0.0", "0.200.0"]) {
    it(`pulls and saves GPT-6.1 Sol when the local cache version is ${cachedClientVersion}`, async function () {
      api.configureCodexDirectCatalog({ cachedClientVersion });
      const win = await openPreferences();
      const emptyPicker = () =>
        selectors(win).find((select) => select.value === "");
      await waitFor(
        () =>
          Boolean(emptyPicker()?.querySelector('option[value="gpt-6.1-sol"]')),
        "auto-pull must offer GPT-6.1 Sol in the Direct Preferences picker",
      );
      const select = emptyPicker()!;
      assert.equal(
        select.querySelector('option[value="gpt-6.1-sol"]')!.textContent,
        "GPT-6.1-Sol",
      );
      assert.isNull(
        select.querySelector('option[value="gpt-6-astra"]'),
        "a model already used by another row stays excluded",
      );
      const expectedVersion =
        cachedClientVersion === "0.0.0" ? "0.162.1" : cachedClientVersion;
      assert.isNotEmpty(api.getCodexDirectCatalogRequests());
      for (const url of api.getCodexDirectCatalogRequests())
        assert.equal(
          new URL(url).searchParams.get("client_version"),
          expectedVersion,
        );

      select.focus();
      select.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
      select.value = "gpt-6.1-sol";
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      await waitFor(() => {
        const groups = JSON.parse(
          String(Zotero.Prefs.get(prefix + "modelProviderGroups", true)),
        );
        return (
          groups
            .find((group: any) => group.id === groupId)
            ?.models.find((row: any) => row.id === newRowId)?.model ===
          "gpt-6.1-sol"
        );
      }, "choosing the model must persist the selected Direct row");
      await closePreferences();
      const reopened = await openPreferences();
      await waitFor(
        () =>
          selectors(reopened).some((select) => select.value === "gpt-6.1-sol"),
        "selected model must survive reopening Preferences",
      );
    });
  }
});
