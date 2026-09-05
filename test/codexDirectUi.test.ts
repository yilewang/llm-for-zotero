import { assert } from "chai";
import { config } from "../package.json";
import {
  addCodexDirectModelRow,
  attachCodexDirectCatalogInteractions,
  buildCodexDirectModelOptions,
  canOfferCodexDirectAuthMode,
  removeCodexDirectModelRow,
  updateCodexDirectModelRow,
} from "../src/utils/codexDirectProviderCard";
import type {
  CodexDirectProviderGroup,
  ModelProviderGroup,
} from "../src/utils/modelProviders";
import {
  getCodexDirectReasoningSelection,
  setCodexDirectReasoningSelection,
} from "../src/codexAuth/reasoningPrefs";
import { initI18n, t } from "../src/utils/i18n";
import {
  PROVIDER_MODEL_CONTROL_STYLE,
  createProviderCardSectionDivider,
  createProviderModelRowBlueprint,
  createProviderModelSectionBlueprint,
} from "../src/utils/providerCardModelSection";
import { createCodexDirectProviderCardController } from "../src/modules/preferences/providerCards/codexDirectProviderCardController";

function directGroup(): CodexDirectProviderGroup {
  return {
    id: "direct",
    apiBase: "https://chatgpt.com/backend-api/codex/responses",
    apiKey: "",
    authMode: "codex_auth",
    providerProtocol: "codex_responses",
    models: [
      { id: "row-a", model: "gpt-a" },
      { id: "row-b", model: "saved-missing" },
    ],
  };
}

class FakeSelect {
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) || []) listener();
  }
}

class FakeElement {
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  textContent = "";
  title = "";
  type = "";
  value = "";
  disabled = false;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) || []) listener();
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

describe("Codex Direct provider-card behavior", function () {
  const globals = globalThis as typeof globalThis & { Zotero?: typeof Zotero };
  let originalZotero: typeof Zotero | undefined;
  let prefs: Map<string, unknown>;

  before(function () {
    originalZotero = globals.Zotero;
  });

  beforeEach(function () {
    prefs = new Map<string, unknown>();
    globals.Zotero = {
      locale: "zh-CN",
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as typeof Zotero;
    initI18n();
  });

  after(function () {
    if (originalZotero) globals.Zotero = originalZotero;
    else delete globals.Zotero;
    initI18n();
  });

  it("offers the Direct auth mode only when no other Direct card exists", function () {
    const standard: ModelProviderGroup = {
      id: "standard",
      apiBase: "https://api.openai.com/v1",
      apiKey: "key",
      authMode: "api_key",
      providerProtocol: "openai_chat_compat",
      models: [],
    };
    const groups = [standard, directGroup()];
    assert.isFalse(canOfferCodexDirectAuthMode(groups, standard.id));
    assert.isTrue(canOfferCodexDirectAuthMode(groups, "direct"));
    assert.isTrue(canOfferCodexDirectAuthMode([standard], standard.id));
  });

  it("builds Direct and generic rows from the shared provider-card blueprint", function () {
    const doc = new FakeDocument() as unknown as Document;
    const section = createProviderModelSectionBlueprint({
      doc,
      sectionLabelStyle: "section-label",
      title: "Model names",
      addTitle: "Add model",
    });
    const directRow = createProviderModelRowBlueprint({
      doc,
      outlineButtonStyle: "outline-button",
      testLabel: "Test",
    });
    const genericRow = createProviderModelRowBlueprint({
      doc,
      outlineButtonStyle: "outline-button",
      testLabel: "Test",
    });
    const divider = createProviderCardSectionDivider(doc);

    const fakeSection = section.section as unknown as FakeElement;
    const fakeHeader = section.header as unknown as FakeElement;
    const fakeAddButton = section.addButton as unknown as FakeElement;
    const fakeRow = directRow.row as unknown as FakeElement;
    const fakeTestButton = directRow.testButton as unknown as FakeElement;
    const fakeStatus = directRow.status as unknown as FakeElement;
    const fakeGenericRow = genericRow.row as unknown as FakeElement;

    assert.strictEqual(fakeSection.children[0], fakeHeader);
    assert.equal(fakeHeader.children[0].textContent, "Model names");
    assert.equal(fakeHeader.children[1].textContent, "+");
    assert.equal(fakeAddButton.title, "Add model");
    assert.strictEqual(
      fakeRow.children[0],
      directRow.controls as unknown as FakeElement,
    );
    assert.equal(
      fakeRow.attributes.get("style"),
      fakeGenericRow.attributes.get("style"),
    );
    assert.equal(
      (directRow.controls as unknown as FakeElement).attributes.get("style"),
      (genericRow.controls as unknown as FakeElement).attributes.get("style"),
    );
    assert.equal(fakeTestButton.textContent, "Test");
    assert.equal(fakeTestButton.attributes.get("style"), "outline-button");
    assert.include(fakeStatus.attributes.get("style") || "", "display: none");
    assert.include(PROVIDER_MODEL_CONTROL_STYLE, "flex: 1; min-width: 0");
    assert.equal((divider as unknown as FakeElement).tagName, "hr");
  });

  it("builds a picker that excludes catalog models used by other rows", function () {
    const options = buildCodexDirectModelOptions({
      group: directGroup(),
      rowId: "row-b",
      catalog: [
        {
          model: "gpt-a",
          displayName: "GPT A",
          description: "",
          priority: 2,
          supportedReasoningEfforts: [],
        },
        {
          model: "gpt-b",
          displayName: "GPT B",
          description: "",
          priority: 1,
          supportedReasoningEfforts: [],
        },
      ],
    });
    assert.deepEqual(options, [
      {
        model: "saved-missing",
        label: "saved-missing",
        availability: "saved-unavailable",
      },
      { model: "gpt-b", label: "GPT B", availability: "available" },
    ]);
  });

  it("loads the catalog when the fake-DOM picker opens or receives focus", function () {
    const select = new FakeSelect();
    let popupOpenCount = 0;
    let refreshCount = 0;
    attachCodexDirectCatalogInteractions({
      target: select,
      popupMayOpen: () => popupOpenCount++,
      refreshCatalog: () => refreshCount++,
    });

    select.dispatch("mousedown");
    assert.equal(popupOpenCount, 1);
    assert.equal(refreshCount, 1);

    select.dispatch("focus");
    assert.equal(refreshCount, 2);

    select.dispatch("keydown");
    assert.equal(popupOpenCount, 2);
    assert.equal(refreshCount, 2);
  });

  it("renders Direct behavior through a disposable card controller", function () {
    const doc = new FakeDocument() as unknown as Document;
    let updated: CodexDirectProviderGroup | null = null;
    const controller = createCodexDirectProviderCardController({
      doc,
      group: directGroup(),
      sectionLabelStyle: "section-label",
      outlineButtonStyle: "outline-button",
      helperStyle: "helper",
      onGroupChange: (group) => {
        updated = group;
      },
      getFetch: () => undefined,
    });
    const section = controller.element as unknown as FakeElement;
    const header = section.children[0];
    const addButton = header.children[1];

    addButton.dispatch("click");

    assert.lengthOf(updated?.models || [], 3);
    assert.equal(updated?.models[2].model, "");
    controller.dispose();
  });

  it("adds, updates, deduplicates, and removes model rows", function () {
    const group = directGroup();
    assert.isNull(updateCodexDirectModelRow(group, "row-b", "GPT-A"));

    const updated = updateCodexDirectModelRow(group, "row-a", "gpt-c");
    assert.isNotNull(updated);
    assert.equal(updated?.models[0].model, "gpt-c");

    const changedSecond = updateCodexDirectModelRow(
      directGroup(),
      "row-b",
      "gpt-b",
    );
    assert.equal(changedSecond?.models[1].model, "gpt-b");

    const added = addCodexDirectModelRow(updated as CodexDirectProviderGroup);
    assert.lengthOf(added?.models || [], 3);
    assert.isNull(addCodexDirectModelRow(added as CodexDirectProviderGroup));

    const removed = removeCodexDirectModelRow(
      updated as CodexDirectProviderGroup,
      "row-a",
    );
    assert.deepEqual(removed?.models, [
      { id: "row-b", model: "saved-missing" },
    ]);
    assert.isNull(
      removeCodexDirectModelRow(removed as CodexDirectProviderGroup, "row-b"),
    );
  });

  it("migrates group-scoped reasoning choices to model-scoped preferences", function () {
    const key = `${config.prefsPrefix}.codexDirectReasoningSelections`;
    prefs.set(
      key,
      JSON.stringify({
        ["legacy-group\u0000gpt-a"]: "high",
        ["other-group\u0000gpt-b"]: "low",
      }),
    );

    assert.equal(getCodexDirectReasoningSelection("gpt-a"), "high");
    setCodexDirectReasoningSelection("gpt-a", "medium");
    assert.deepEqual(JSON.parse(String(prefs.get(key))), {
      "gpt-a": "medium",
      "gpt-b": "low",
    });
  });

  it("translates the complete Direct preference and catalog status set", function () {
    const strings = [
      "Select a Codex Direct model…",
      "Unavailable",
      "Fetching Codex Direct models…",
      "Couldn't fetch Codex Direct models:",
      "Fetching Codex model catalog…",
      "Catalog:",
      "models; test model:",
      "Inference:",
      "Inference was not run.",
      "The server returned no model output.",
      "The selected Codex Direct model is not available in the current catalog.",
      "Loading Codex Direct models. Current model is unverified.",
      "Loading Codex Direct models…",
      "Could not load Codex Direct models. Current model is unverified.",
      "Could not load Codex Direct models.",
      "Codex Direct did not return any available models.",
      "Retry loading Codex Direct models",
      "The saved Codex Direct model is no longer available. Select another model before sending.",
      "This saved model is not present in the current Codex Direct catalog.",
      "The saved Codex Direct model is unavailable. Select a model from the current catalog before sending.",
    ];
    for (const value of strings) assert.notEqual(t(value), value, value);
  });
});
