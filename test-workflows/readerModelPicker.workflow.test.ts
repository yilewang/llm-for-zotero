import { assert } from "chai";
import type { CodexAppServerModelCatalogEntry } from "../src/codexAppServer/modelCatalog";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * The composer's model menu has a Main | Reader switch. Main is the model
 * list as it always was. Reader picks the model that reads papers for the
 * host: "Same as main", the runtime's own models, then the configured API
 * models. One reader is kept per runtime. The button keeps showing the main
 * model only; its tooltip names the reader.
 *
 * Runs in the real sidebar panel and the real standalone window. Claude Code
 * has no catalog hook in the workflow API, so its list is covered by unit
 * tests only.
 */

const PREFIX = "extensions.zotero.llmforzotero.";
const ALPHA = { id: "workflow-reader-alpha", model: "alpha-main" };
const ALPHA_2 = { id: "workflow-reader-alpha-2", model: "alpha-second" };
const BETA = { id: "workflow-reader-beta", model: "beta-reader" };

function providerGroups(models: Array<{ id: string; model: string }>) {
  const alpha = models.filter((entry) => entry.id !== BETA.id);
  const beta = models.filter((entry) => entry.id === BETA.id);
  const model = (entry: { id: string; model: string }) => ({
    id: entry.id,
    model: entry.model,
    temperature: 0.3,
    outputTokenLimit: { mode: "auto" },
  });
  return JSON.stringify(
    [
      alpha.length && {
        id: "workflow-reader-alpha-provider",
        authMode: "api_key",
        apiBase: "https://workflow-reader-alpha.invalid/v1",
        apiKey: "workflow-key-alpha",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: alpha.map(model),
      },
      beta.length && {
        id: "workflow-reader-beta-provider",
        authMode: "api_key",
        apiBase: "https://workflow-reader-beta.invalid/v1",
        apiKey: "workflow-key-beta",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: beta.map(model),
      },
    ].filter(Boolean),
  );
}

function codexModel(name: string): CodexAppServerModelCatalogEntry {
  return {
    id: name,
    model: name,
    displayName: name,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["low", "high"],
  };
}
const CODEX_MAIN = codexModel("gpt-6-sol");
const CODEX_READER = codexModel("gpt-6.1-sol");

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
  assert.isTrue(check(), message);
}

function all<T extends HTMLElement>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector)) as T[];
}

const settings: Record<string, string | boolean | number> = {
  modelProviderGroups: providerGroups([ALPHA, ALPHA_2, BETA]),
  modelProviderGroupsMigrationVersion: 3,
  lastUsedModelEntryId: ALPHA.id,
  conversationSystem: "upstream",
  enableCodexAppServerMode: true,
  enableClaudeCodeMode: false,
  codexAppServerModel: CODEX_MAIN.model,
  codexAppServerReasoning: "auto",
  codexAppServerPath: "/workflow/codex",
  lastUsedRuntimeMode: "chat",
  readerChoiceAgent: "",
  readerChoiceCodex: "",
  readerChoiceClaude: "",
};

describe("workflow: reader model picker in the model menu", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture;
  let previous: Map<string, unknown>;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    api.configurePermissionCatalogs();
    api.configureCodexModelCatalogs(
      Array.from({ length: 12 }, () => ({
        models: [CODEX_MAIN, CODEX_READER],
      })),
    );
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(PREFIX + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(PREFIX + key, value, true);
    fixture = await api.createPaperWithPdfFixture({
      title: "Reader picker",
      pdfTitle: "Reader picker PDF",
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

  const pref = (key: string) => Zotero.Prefs.get(PREFIX + key, true);

  async function renderPanel(): Promise<HTMLElement> {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    return Zotero.getMainWindow().document.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
  }

  async function openStandalone(
    system: "upstream" | "codex",
  ): Promise<Document> {
    const standalone = await api.openStandaloneForItem(fixture.parentItemId);
    if (standalone.conversationSystem !== system)
      await api.pickStandaloneRuntime(system);
    const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
      | Window
      | undefined;
    assert.isOk(win && !win.closed, "the standalone window must open");
    return win!.document;
  }

  const modelButton = (root: ParentNode) =>
    root.querySelector<HTMLButtonElement>("#llm-model-toggle")!;
  const menu = (root: ParentNode) =>
    root.querySelector<HTMLElement>("#llm-model-menu")!;
  const isOpen = (root: ParentNode) => menu(root).style.display !== "none";
  const openMenu = (root: ParentNode) => modelButton(root).click();
  const tab = (root: ParentNode, which: "main" | "reader") =>
    menu(root).querySelector<HTMLButtonElement>(
      `[data-model-menu-tab="${which}"]`,
    )!;
  const readerOptions = (root: ParentNode) =>
    all<HTMLButtonElement>(
      menu(root),
      "[data-reader-option], [data-reader-model], [data-reader-entry-id]",
    );
  const selectedReader = (root: ParentNode) =>
    readerOptions(root).filter((option) =>
      option.classList.contains("llm-menu-option-selected"),
    );
  const tooltipReaderLine = (root: ParentNode) =>
    modelButton(root)
      .title.split("\n")
      .find((line) => line.startsWith("Reader:")) || "";

  /** Opens the menu, waits for the main list, and shows the Reader tab. */
  async function openReaderTab(root: ParentNode, ready: string) {
    openMenu(root);
    await waitFor(
      () => Boolean(menu(root).querySelector(ready)),
      "the main list must render",
    );
    assert.isTrue(
      tab(root, "main").classList.contains("active"),
      "the menu opens on Main",
    );
    tab(root, "reader").click();
    assert.isTrue(tab(root, "reader").classList.contains("active"));
  }

  for (const surface of ["panel", "standalone"] as const) {
    it(`switches Main | Reader in the ${surface} menu, picks an API reader, and keeps it`, async function () {
      const root: ParentNode =
        surface === "panel"
          ? await renderPanel()
          : await openStandalone("upstream");
      const labelBefore = modelButton(root).textContent;
      assert.include(labelBefore, ALPHA.model);

      openMenu(root);
      await waitFor(
        () =>
          Boolean(menu(root).querySelector(`[data-entry-id="${ALPHA.id}"]`)),
        "the main list must render",
      );
      // The switch is the first row, with two equal tabs; Main is active.
      const switchRow = menu(root).firstElementChild as HTMLElement;
      assert.isTrue(switchRow.classList.contains("llm-model-menu-switch"));
      assert.deepEqual(
        all<HTMLButtonElement>(switchRow, "button").map((b) =>
          b.textContent?.trim(),
        ),
        ["Main", "Reader"],
      );
      assert.isTrue(tab(root, "main").classList.contains("active"));
      assert.equal(
        getComputedStyle(switchRow).position,
        "sticky",
        "the switch stays at the top while the list scrolls",
      );
      const first = tab(root, "main").getBoundingClientRect();
      const second = tab(root, "reader").getBoundingClientRect();
      assert.approximately(first.width, second.width, 1, "equal tabs");
      assert.approximately(
        switchRow.getBoundingClientRect().width,
        menu(root).clientWidth - 12,
        3,
        "the switch spans the menu",
      );
      // Main keeps today's list: the main model's options, no reader rows.
      assert.isOk(menu(root).querySelector(`[data-entry-id="${BETA.id}"]`));
      assert.lengthOf(readerOptions(root), 0);

      // Reader: Same as main, then the API models; the Agent has no own ones.
      tab(root, "reader").click();
      assert.lengthOf(menu(root).querySelectorAll("[data-entry-id]"), 0);
      assert.isOk(menu(root).querySelector('[data-reader-option="same"]'));
      assert.deepEqual(
        all<HTMLElement>(menu(root), "[data-reader-entry-id]").map(
          (option) => option.dataset.readerEntryId,
        ),
        [ALPHA.id, ALPHA_2.id, BETA.id],
      );
      assert.lengthOf(menu(root).querySelectorAll("[data-reader-model]"), 0);
      assert.deepEqual(
        selectedReader(root).map((option) => option.dataset.readerOption),
        ["same"],
      );

      // Picking closes the menu, leaves the button text, and names the
      // reader in the tooltip only.
      menu(root)
        .querySelector<HTMLButtonElement>(
          `[data-reader-entry-id="${BETA.id}"]`,
        )!
        .click();
      assert.isFalse(isOpen(root), "picking closes the menu");
      assert.equal(modelButton(root).textContent, labelBefore);
      assert.notInclude(modelButton(root).textContent, BETA.model);
      // The layout pass applies the tooltip on the next frame.
      await waitFor(
        () => tooltipReaderLine(root).includes(BETA.model),
        "the tooltip must name the reader",
      );
      assert.match(tooltipReaderLine(root), /^Reader: .+ · /);
      assert.equal(
        pref("readerChoiceAgent"),
        surface === "panel" ? `entry:${BETA.id}` : "",
        "the sidebar saves the pick; the window keeps its own",
      );

      // Reopening starts on Main; the pick is still there on Reader.
      await openReaderTab(root, `[data-entry-id="${ALPHA.id}"]`);
      assert.deepEqual(
        selectedReader(root).map((option) => option.dataset.readerEntryId),
        [BETA.id],
      );
      // Same as main clears it.
      menu(root)
        .querySelector<HTMLButtonElement>('[data-reader-option="same"]')!
        .click();
      assert.isFalse(isOpen(root));
      await waitFor(
        () => tooltipReaderLine(root) === "",
        "the tooltip must drop the reader line",
      );
      assert.equal(modelButton(root).textContent, labelBefore);
      if (surface === "panel") assert.equal(pref("readerChoiceAgent"), "");
    });
  }

  it("keeps the sidebar's reader across a remount, and reads a deleted entry as Same as main", async function () {
    const root = await renderPanel();
    await openReaderTab(root, `[data-entry-id="${ALPHA.id}"]`);
    menu(root)
      .querySelector<HTMLButtonElement>(`[data-reader-entry-id="${BETA.id}"]`)!
      .click();
    assert.equal(pref("readerChoiceAgent"), `entry:${BETA.id}`);

    const remounted = await api.remountPanel(
      (root as HTMLElement).dataset.workflowPanelId!,
    );
    const restored = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${remounted.panelId}"]`,
    )!;
    await waitFor(
      () => tooltipReaderLine(restored).includes(BETA.model),
      "the remounted panel names the saved reader",
    );
    await openReaderTab(restored, `[data-entry-id="${ALPHA.id}"]`);
    assert.deepEqual(
      selectedReader(restored).map((option) => option.dataset.readerEntryId),
      [BETA.id],
    );

    // The reader's model entry is deleted in settings.
    Zotero.Prefs.set(
      PREFIX + "modelProviderGroups",
      providerGroups([ALPHA, ALPHA_2]),
      true,
    );
    const afterDelete = await api.remountPanel(remounted.panelId);
    const reopened = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${afterDelete.panelId}"]`,
    )!;
    await waitFor(
      () => modelButton(reopened).textContent!.includes(ALPHA.model),
      "the panel renders",
    );
    assert.equal(tooltipReaderLine(reopened), "");
    await openReaderTab(reopened, `[data-entry-id="${ALPHA.id}"]`);
    assert.deepEqual(
      selectedReader(reopened).map((option) => option.dataset.readerOption),
      ["same"],
    );
  });

  for (const surface of ["panel", "standalone"] as const) {
    it(`lists Codex's own models then the API models on Reader in the ${surface}, with a reader kept per runtime`, async function () {
      if (surface === "panel")
        Zotero.Prefs.set(PREFIX + "conversationSystem", "codex", true);
      const root: ParentNode =
        surface === "panel"
          ? await renderPanel()
          : await openStandalone("codex");
      const labelBefore = modelButton(root).textContent;
      assert.include(labelBefore, CODEX_MAIN.model);

      await openReaderTab(
        root,
        `[data-entry-id="codex_app_server::${CODEX_READER.model}"]`,
      );
      const kinds = readerOptions(root).map((option) =>
        option.dataset.readerOption
          ? "same"
          : option.dataset.readerModel
            ? "codex"
            : "api",
      );
      assert.equal(kinds[0], "same");
      assert.sameMembers(
        all<HTMLElement>(menu(root), "[data-reader-model]").map(
          (option) => option.dataset.readerModel!,
        ),
        [CODEX_MAIN.model, CODEX_READER.model],
      );
      assert.lengthOf(menu(root).querySelectorAll("[data-reader-entry-id]"), 3);
      assert.deepEqual(
        kinds.filter((kind, index) => kind !== kinds[index - 1]),
        ["same", "codex", "api"],
        "Same as main, then the runtime's models, then the API models",
      );

      menu(root)
        .querySelector<HTMLButtonElement>(
          `[data-reader-model="${CODEX_READER.model}"]`,
        )!
        .click();
      assert.isFalse(isOpen(root));
      assert.equal(modelButton(root).textContent, labelBefore);
      await waitFor(
        () => tooltipReaderLine(root).includes(`Codex · ${CODEX_READER.model}`),
        "the tooltip must name the Codex reader",
      );
      assert.equal(
        pref("readerChoiceCodex"),
        surface === "panel" ? `model:${CODEX_READER.model}` : "",
      );
      assert.equal(
        pref("readerChoiceAgent"),
        "",
        "the Agent's reader is its own",
      );

      // Back on the Agent runtime the Codex pick does not carry over.
      if (surface === "panel") {
        Zotero.Prefs.set(PREFIX + "conversationSystem", "upstream", true);
        const agentRoot = await renderPanel();
        await waitFor(
          () => modelButton(agentRoot).textContent!.includes(ALPHA.model),
          "the Agent panel renders",
        );
        await waitFor(
          () => tooltipReaderLine(agentRoot) === "",
          "the Agent has no reader",
        );
      } else {
        await api.pickStandaloneRuntime("upstream");
        await waitFor(
          () => modelButton(root).textContent!.includes(ALPHA.model),
          "the window returns to the Agent runtime",
        );
        await waitFor(
          () => tooltipReaderLine(root) === "",
          "the Agent has no reader",
        );
        await api.pickStandaloneRuntime("codex");
        await waitFor(
          () => tooltipReaderLine(root).includes(CODEX_READER.model),
          "the window keeps its Codex reader",
        );
      }
    });
  }
});
