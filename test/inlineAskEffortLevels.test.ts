import { assert } from "chai";
import { describe, it } from "mocha";
import {
  detectReasoningProvider,
  getReasoningOptions,
} from "../src/modules/contextPanel/chat";
import type { InlineAskModelTarget } from "../src/modules/contextPanel/selectionPrompt/inlineAskModel";
import { inlineAskEffortLevels } from "../src/modules/contextPanel/selectionPrompt/inlineAskReader";

function target(
  overrides: Partial<InlineAskModelTarget> = {},
): InlineAskModelTarget {
  return {
    source: "inline_choice",
    entryId: "entry",
    model: "gpt-5.5-inline-ask",
    apiBase: "https://levels.invalid/v1",
    apiKey: "key",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    providerLabel: "Levels",
    displayLabel: "gpt-5.5-inline-ask",
    ...overrides,
  };
}

describe("inlineAskEffortLevels", function () {
  it("offers the enabled levels of the sidebar's reasoning menu for the model", function () {
    const model = target();
    const sidebar = getReasoningOptions(
      detectReasoningProvider(model.model, model.apiBase),
      model.model,
      model.apiBase,
      model.providerProtocol,
    ).filter((option) => option.enabled);
    const levels = inlineAskEffortLevels(model);
    assert.deepEqual(
      levels.map((level) => level.value),
      sidebar.map((option) => option.level),
    );
    assert.includeMembers(
      levels.map((level) => level.value),
      ["auto", "low", "high"],
    );
  });

  it("offers Auto only for a model without reasoning levels", function () {
    assert.deepEqual(
      inlineAskEffortLevels(target({ model: "inline-ask-model" })),
      [{ value: "auto", label: "Auto" }],
    );
  });

  it("offers Codex Direct levels from its catalog (Auto before it loads)", function () {
    const levels = inlineAskEffortLevels(
      target({
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        apiKey: "",
      }),
    );
    assert.equal(levels[0]?.value, "auto");
  });
});
