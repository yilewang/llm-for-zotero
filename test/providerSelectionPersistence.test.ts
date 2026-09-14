import { resolveProviderPresetId } from "../src/utils/providerPresets";
import { assert } from "chai";
import {
  buildProviderCatalogIdentity,
  getModelProviderGroups,
  getRuntimeModelEntries,
  normalizeModelProviderGroups,
  setModelProviderGroups,
  type StandardModelProviderGroup,
} from "../src/utils/modelProviders";
import { PROVIDER_PRESETS } from "../src/utils/providerPresets";
import {
  canFetchProviderModels,
  providerGroupRequiresApiKey,
} from "../src/utils/providerModelPicker";
import { resolveProviderTransportEndpoint } from "../src/utils/providerTransport";
import { transitionProviderAuthMode } from "../src/modules/preferences/providerAuthModeTransition";

function localGroup(): StandardModelProviderGroup {
  return {
    id: "issue433-provider",
    authMode: "api_key",
    apiBase: "http://localhost:11434/v1",
    apiKey: "",
    presetIdOverride: "local_openai",
    providerProtocol: "openai_chat_compat",
    models: [
      {
        id: "issue433-model",
        model: "local-model",
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
    ],
  };
}

describe("explicit provider selection persistence", function () {
  let originalZotero: typeof Zotero;

  beforeEach(function () {
    originalZotero = globalThis.Zotero;
    const prefs = new Map<string, unknown>();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  for (const scenario of [
    {
      preset: "local_openai" as const,
      apiBase: "http://localhost:11434/v1",
      protocol: "openai_chat_compat" as const,
      label: "Local (OpenAI-compatible)",
      endpoint: "http://localhost:11434/v1/chat/completions",
    },
    {
      preset: "ollama" as const,
      apiBase: "http://localhost:1234",
      protocol: "ollama_native" as const,
      label: "Ollama (local)",
      endpoint: "http://localhost:1234/api/chat",
    },
  ]) {
    it(`retains ${scenario.preset} on a conflicting port through save and reload`, function () {
      setModelProviderGroups([
        {
          ...localGroup(),
          apiBase: scenario.apiBase,
          providerProtocol: scenario.protocol,
          presetIdOverride: scenario.preset,
        },
      ]);
      const [saved] = getModelProviderGroups();
      const [runtime] = getRuntimeModelEntries();
      assert.equal(saved.presetIdOverride, scenario.preset);
      assert.equal(resolveProviderPresetId(saved), scenario.preset);
      assert.isTrue(canFetchProviderModels(saved));
      assert.isFalse(providerGroupRequiresApiKey(saved));
      assert.equal(
        buildProviderCatalogIdentity(saved).provider,
        scenario.preset,
      );
      assert.equal(runtime.providerLabel, scenario.label);
      assert.equal(runtime.providerProtocol, scenario.protocol);
      assert.equal(
        resolveProviderTransportEndpoint({
          apiBase: runtime.apiBase,
          protocol: runtime.providerProtocol,
        }),
        scenario.endpoint,
      );
    });
  }

  it("round-trips every registered preset and Customized", function () {
    for (const presetIdOverride of [
      ...PROVIDER_PRESETS.map((preset) => preset.id),
      "customized" as const,
    ]) {
      setModelProviderGroups([{ ...localGroup(), presetIdOverride }]);
      assert.equal(
        getModelProviderGroups()[0].presetIdOverride,
        presetIdOverride,
      );
    }
  });

  it("retains URL inference for absent and invalid selections", function () {
    for (const presetIdOverride of [undefined, null, "unknown", 42]) {
      const groups = normalizeModelProviderGroups([
        { ...localGroup(), presetIdOverride },
      ]);
      assert.isUndefined(groups[0].presetIdOverride);
      setModelProviderGroups(groups);
      assert.equal(
        resolveProviderPresetId(getModelProviderGroups()[0]),
        "ollama",
      );
      assert.equal(
        getRuntimeModelEntries()[0].providerProtocol,
        "ollama_native",
      );
    }
  });

  it("preserves Customized protocol behavior on the Ollama port", function () {
    setModelProviderGroups([
      { ...localGroup(), presetIdOverride: "customized" },
    ]);
    const [saved] = getModelProviderGroups();
    assert.equal(resolveProviderPresetId(saved), "customized");
    assert.isUndefined(buildProviderCatalogIdentity(saved).provider);
    assert.equal(
      getRuntimeModelEntries()[0].providerProtocol,
      "openai_chat_compat",
    );
  });

  it("keeps a per-model protocol override above the selected preset", function () {
    const group = localGroup();
    group.models[0].providerProtocol = "responses_api";
    setModelProviderGroups([group]);
    assert.equal(getRuntimeModelEntries()[0].providerProtocol, "responses_api");
  });

  it("preserves selection through configurable auth transitions without applying it to dedicated modes", function () {
    for (const mode of ["codex_app_server", "copilot_auth"] as const) {
      setModelProviderGroups([transitionProviderAuthMode(localGroup(), mode)]);
      const [dedicated] = getModelProviderGroups();
      assert.equal(resolveProviderPresetId(dedicated), "customized");
      const restored = transitionProviderAuthMode(dedicated, "api_key");
      setModelProviderGroups([restored]);
      const [saved] = getModelProviderGroups();
      assert.equal(saved.presetIdOverride, "local_openai");
      assert.equal(saved.providerProtocol, "openai_chat_compat");
      assert.equal(
        getRuntimeModelEntries()[0].providerProtocol,
        "openai_chat_compat",
      );
    }
  });
});
