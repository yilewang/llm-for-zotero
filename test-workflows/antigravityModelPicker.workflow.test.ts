import { assert } from "chai";
import type { AntigravityModelCatalog } from "../src/antigravity/modelCatalog";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREFIX = "extensions.zotero.llmforzotero.";

const catalog: AntigravityModelCatalog = {
  models: [
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      thoughtLevels: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    { id: "gemini-4-flint", name: "Gemini 4 Flint", thoughtLevels: [] },
  ],
  modelIds: [
    "gemini-4-argon-low",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
  ],
  defaultModel: "gemini-4-argon",
  defaultThoughtLevel: "medium",
};

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
  assert.isTrue(check(), message);
}

function modelOptions(root: ParentNode): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll("#llm-model-menu .llm-model-option[data-entry-id]"),
  ) as HTMLButtonElement[];
}

function reasoningOptions(root: ParentNode): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll("#llm-reasoning-menu .llm-reasoning-option"),
  ) as HTMLButtonElement[];
}

function label(button: HTMLElement): string {
  return button.textContent?.trim() || "";
}

describe("workflow: Antigravity model picker", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let previous: Map<string, unknown>;
  const settings: Record<string, string | boolean> = {
    enableAntigravityMode: true,
    conversationSystem: "upstream",
    antigravityRuntimeModel: "",
    antigravityThoughtLevel: "",
  };

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(PREFIX + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(PREFIX + key, value, true);
    api.configureAntigravityModelCatalog(catalog);
    fixture = await api.createPaperWithPdfFixture({
      title: "Antigravity model picker",
      pdfTitle: "Antigravity model picker PDF",
    });
  });

  afterEach(async function () {
    await api.reset();
    api.configureAntigravityModelCatalog(null);
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    for (const [key, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear(PREFIX + key, true);
      else
        Zotero.Prefs.set(
          PREFIX + key,
          value as string | number | boolean,
          true,
        );
    }
  });

  it("lists agy's models and thinking levels and stores the picks", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    const diagnostics = await api.clickPanelSystemToggle(
      panel.panelId,
      "antigravity",
    );
    assert.equal(diagnostics.conversationSystem, "antigravity");
    const root = Zotero.getMainWindow().document.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    const modelButton =
      root.querySelector<HTMLButtonElement>("#llm-model-toggle")!;
    const reasoningButton = root.querySelector<HTMLButtonElement>(
      "#llm-reasoning-toggle",
    )!;

    modelButton.click();
    await waitFor(
      () => modelOptions(root).length === 3,
      "the model menu must list Default and both catalog models",
    );
    assert.deepEqual(modelOptions(root).map(label), [
      "Default",
      "Gemini 4 Argon",
      "Gemini 4 Flint",
    ]);
    assert.isTrue(
      modelOptions(root)[0]!.classList.contains("llm-menu-option-selected"),
      "Default must be selected while the pref is empty",
    );

    modelOptions(root)
      .find((option) => label(option) === "Gemini 4 Argon")!
      .click();
    assert.equal(
      Zotero.Prefs.get(PREFIX + "antigravityRuntimeModel", true),
      "gemini-4-argon",
    );
    assert.include(modelButton.dataset.modelLabel || "", "Gemini 4 Argon");
    assert.isFalse(
      reasoningButton.classList.contains("llm-reasoning-btn-unavailable"),
      "a model with thinking levels must offer the reasoning control",
    );

    reasoningButton.click();
    await waitFor(
      () => reasoningOptions(root).length > 0,
      "the reasoning menu must open",
    );
    assert.deepEqual(reasoningOptions(root).map(label), [
      "Default",
      "Low",
      "Medium",
      "High",
    ]);
    reasoningOptions(root)
      .find((option) => label(option) === "High")!
      .click();
    assert.equal(
      Zotero.Prefs.get(PREFIX + "antigravityThoughtLevel", true),
      "high",
    );
    assert.equal(reasoningButton.dataset.reasoningLabel, "High");

    modelButton.click();
    await waitFor(
      () => modelOptions(root).length === 3,
      "the model menu must reopen",
    );
    modelOptions(root)
      .find((option) => label(option) === "Gemini 4 Flint")!
      .click();
    assert.equal(
      Zotero.Prefs.get(PREFIX + "antigravityRuntimeModel", true),
      "gemini-4-flint",
    );
    assert.equal(
      Zotero.Prefs.get(PREFIX + "antigravityThoughtLevel", true),
      "",
      "a level the new model lacks must fall back to Default",
    );
    assert.isTrue(
      reasoningButton.classList.contains("llm-reasoning-btn-unavailable"),
      "a model without thinking levels must not offer the reasoning control",
    );
    assert.equal(reasoningButton.dataset.reasoningLabel, "Default");

    modelButton.click();
    await waitFor(
      () => modelOptions(root).length === 3,
      "the model menu must reopen",
    );
    modelOptions(root)[0]!.click();
    assert.equal(
      Zotero.Prefs.get(PREFIX + "antigravityRuntimeModel", true),
      "",
      "Default must store agy's own default",
    );
  });
});
