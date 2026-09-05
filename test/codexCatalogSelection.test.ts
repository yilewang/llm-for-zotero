import { assert } from "chai";
import {
  buildCodexReasoningChoices,
  buildCodexReasoningConfig,
  buildCodexRuntimeModelCandidates,
  formatCodexReasoningLabel,
  reconcileCodexReasoningChoice,
} from "../src/codex/catalogSelection";
import { getCodexAppServerReasoningChoices } from "../src/codexAppServer/modelCatalog";

describe("shared Codex catalog selection", function () {
  it("formats XHigh and future wire values without a fixed union", function () {
    assert.equal(formatCodexReasoningLabel("xhigh"), "XHigh");
    assert.equal(
      formatCodexReasoningLabel("future_super-depth"),
      "Future Super Depth",
    );
  });

  it("builds ordered catalog choices with a default-bearing Auto label", function () {
    const choices = buildCodexReasoningChoices({
      efforts: [
        { value: "low", description: "Fast" },
        { value: "LOW", description: "duplicate" },
        { value: "max", description: "Deep" },
        { value: "ultra", description: "Excluded" },
      ],
      defaultEffort: "max",
      excludedEfforts: ["ULTRA"],
      showDefaultInAutoLabel: true,
    });

    assert.deepEqual(choices, [
      { value: "auto", label: "Auto (Max)" },
      { value: "low", label: "Low", description: "Fast" },
      { value: "max", label: "Max", description: "Deep" },
    ]);
    assert.equal(reconcileCodexReasoningChoice("MAX", choices), "max");
    assert.equal(reconcileCodexReasoningChoice("ultra", choices), "auto");
  });

  it("preserves a missing saved model before catalog-ordered models", function () {
    assert.deepEqual(
      buildCodexRuntimeModelCandidates({
        selectedModel: "saved-model",
        catalogModels: [
          { model: "gpt-b", displayName: "GPT B" },
          { model: "GPT-B", displayName: "duplicate" },
          { model: "gpt-a", displayName: "GPT A" },
        ],
      }),
      [
        {
          model: "saved-model",
          displayName: "saved-model",
          source: "saved",
        },
        { model: "gpt-b", displayName: "GPT B", source: "catalog" },
        { model: "gpt-a", displayName: "GPT A", source: "catalog" },
      ],
    );
  });

  it("builds exact effort configs and omits Auto", function () {
    assert.isUndefined(buildCodexReasoningConfig("auto"));
    assert.deepEqual(buildCodexReasoningConfig("Future-Max"), {
      provider: "openai",
      level: "default",
      effort: "Future-Max",
    });
  });

  it("keeps App Server fallback efforts and advertised Ultra", function () {
    const fallback = getCodexAppServerReasoningChoices({
      models: [],
      selectedModel: "not-loaded",
    });
    assert.isAbove(fallback.length, 1);

    const advertised = getCodexAppServerReasoningChoices({
      selectedModel: "gpt-codex",
      models: [
        {
          id: "gpt-codex",
          model: "gpt-codex",
          displayName: "GPT Codex",
          description: "",
          hidden: false,
          supportedReasoningEfforts: ["low", "ultra"],
        },
      ],
    });
    assert.include(
      advertised.map((choice) => choice.value),
      "ultra",
    );
  });
});
