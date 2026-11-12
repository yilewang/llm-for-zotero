import { assert } from "chai";
import type { CodexAppServerModelCatalogEntry } from "../src/codexAppServer/modelCatalog";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREFIX = "extensions.zotero.llmforzotero.";
const olderModel = model("gpt-6-sol", ["low", "high"]);
const newerModel = model("gpt-6.1-sol", ["low", "medium", "high", "max"]);

function model(
  name: string,
  efforts: string[],
): CodexAppServerModelCatalogEntry {
  return {
    id: name,
    model: name,
    displayName: name,
    description: "",
    hidden: false,
    supportedReasoningEfforts: efforts,
  };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
  assert.isTrue(check(), message);
}

function modelOption(root: ParentNode, name: string): HTMLButtonElement | null {
  return root.querySelector(
    `#llm-model-menu [data-entry-id="codex_app_server::${name}"]`,
  );
}

describe("workflow: Codex model catalog refresh", function () {
  this.timeout(30000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture;
  let previous: Map<string, unknown>;
  const settings: Record<string, string | boolean> = {
    enableCodexAppServerMode: true,
    conversationSystem: "codex",
    codexAppServerModel: "gpt-6-sol",
    codexAppServerReasoning: "auto",
    codexAppServerPath: "/workflow/codex",
    lastUsedRuntimeMode: "chat",
  };

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    api.configurePermissionCatalogs();
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(PREFIX + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(PREFIX + key, value, true);
    fixture = await api.createPaperWithPdfFixture({
      title: "Codex catalog refresh",
      pdfTitle: "Catalog refresh PDF",
    });
  });

  afterEach(async function () {
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
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

  async function renderPanel(): Promise<HTMLElement> {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    return Zotero.getMainWindow().document.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
  }

  function openModels(root: ParentNode): void {
    root.querySelector<HTMLButtonElement>("#llm-model-toggle")!.click();
  }

  for (const surface of ["panel", "standalone"] as const) {
    it(`discovers and selects gpt-6.1-sol after reopening the ${surface} picker`, async function () {
      api.configureCodexModelCatalogs([
        { models: [olderModel] },
        { models: [newerModel, olderModel] },
      ]);
      let root: ParentNode;
      if (surface === "panel") {
        root = await renderPanel();
      } else {
        const standalone = await api.openStandaloneForItem(
          fixture.parentItemId,
        );
        if (standalone.conversationSystem !== "codex")
          await api.clickStandaloneSystemToggle("codex");
        const windows = (Services as any).wm.getEnumerator(null);
        let doc: Document | undefined;
        while (windows.hasMoreElements()) {
          const candidate = (windows.getNext() as Window).document;
          if (
            candidate !== Zotero.getMainWindow().document &&
            candidate.querySelector("#llm-model-toggle")
          )
            doc = candidate;
        }
        assert.isOk(doc, "standalone chat must open");
        root = doc!;
      }
      openModels(root);
      await waitFor(
        () => Boolean(modelOption(root, olderModel.model)),
        "initial model must render",
      );
      await Zotero.Promise.delay(50);
      assert.isNull(modelOption(root, newerModel.model));
      openModels(root);
      openModels(root);
      await waitFor(
        () => Boolean(modelOption(root, newerModel.model)),
        "reopening must discover the new model",
      );
      modelOption(root, newerModel.model)!.click();
      root.querySelector<HTMLButtonElement>("#llm-reasoning-toggle")!.click();
      const reasoning = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          "#llm-reasoning-menu .llm-reasoning-option",
        ),
      ) as HTMLButtonElement[];
      const max = reasoning.find((row) => row.textContent?.trim() === "Max");
      assert.isOk(max, "new model must use its advertised reasoning efforts");
      max!.click();
      assert.include(
        root.querySelector("#llm-model-toggle")!.textContent,
        newerModel.model,
      );
      assert.equal(
        root.querySelector<HTMLButtonElement>("#llm-reasoning-toggle")!.dataset
          .reasoningLabel,
        "Max",
      );
      assert.equal(
        Zotero.Prefs.get(PREFIX + "codexAppServerModel", true),
        surface === "panel" ? newerModel.model : olderModel.model,
      );
      assert.equal(
        Zotero.Prefs.get(PREFIX + "codexAppServerReasoning", true),
        surface === "panel" ? "max" : "auto",
      );
      if (surface === "panel") {
        const remounted = await api.remountPanel(
          (root as HTMLElement).dataset.workflowPanelId!,
        );
        const restored = Zotero.getMainWindow().document.querySelector(
          `[data-workflow-panel-id="${remounted.panelId}"]`,
        )!;
        assert.include(
          restored.querySelector("#llm-model-toggle")!.textContent,
          newerModel.model,
        );
      }
    });
  }

  it("keeps the last catalog on refresh failure and retries from the menu", async function () {
    api.configureCodexModelCatalogs([
      { models: [olderModel] },
      { error: "temporary model catalog failure" },
      { models: [newerModel] },
    ]);
    const root = await renderPanel();
    openModels(root);
    await Zotero.Promise.delay(100);
    openModels(root);
    openModels(root);
    await waitFor(
      () =>
        Boolean(
          root.querySelector('[title="temporary model catalog failure"]'),
        ),
      "refresh error must be visible",
    );
    assert.isOk(
      modelOption(root, olderModel.model),
      "refresh failure must retain the last catalog",
    );
    const retry = root.querySelector<HTMLButtonElement>(
      '#llm-model-menu [data-model-menu-action="retry"]',
    );
    assert.isOk(retry, "failed catalog must offer retry");
    retry!.click();
    await waitFor(
      () => Boolean(modelOption(root, newerModel.model)),
      "retry must discover the new model",
    );
  });

  it("coalesces repeated opens and ignores a late catalog from the previous CLI path", async function () {
    api.configureCodexModelCatalogs([
      { models: [olderModel], delayed: true },
      { models: [newerModel] },
    ]);
    const root = await renderPanel();
    openModels(root);
    openModels(root);
    openModels(root);
    assert.deepEqual(api.getCodexModelCatalogRequests(), ["/workflow/codex"]);
    Zotero.Prefs.set(
      PREFIX + "codexAppServerPath",
      "/workflow/new-codex",
      true,
    );
    openModels(root);
    openModels(root);
    await waitFor(
      () => Boolean(modelOption(root, newerModel.model)),
      "new CLI path must load while the old request is pending",
    );
    await api.resolveDelayedCodexModelCatalog();
    assert.isOk(
      modelOption(root, newerModel.model),
      "late old-path response must not replace the new catalog",
    );
    assert.deepEqual(api.getCodexModelCatalogRequests(), [
      "/workflow/codex",
      "/workflow/new-codex",
    ]);
  });
});
