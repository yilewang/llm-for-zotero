import { assert } from "chai";
import {
  computeProfileOverrideDraft,
  SUGGESTED_REASONING_LEVEL_IDS,
} from "../src/modules/modelProfileEditor";
import {
  coerceParameterValue,
  getModelCapabilities,
  getRuntimeReasoningOptions,
  normalizeProfileOverride,
  profileOverrideAppliesTo,
  resetModelCapabilityStateForTests,
  type ResolvedModelCapabilities,
} from "../src/modelCapabilities";
import {
  buildReasoningPayload,
  resolveUserExtraBody,
} from "../src/utils/llmClient";

/** A detected profile shaped like Ollama's think Off/On pair. */
function detectedThinkProfile(): ResolvedModelCapabilities {
  return getModelCapabilities({
    model: "qwen3:8b",
    apiBase: "http://localhost:11434",
    protocol: "ollama_native",
  });
}

describe("model profile editor logic", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  describe("computeProfileOverrideDraft", function () {
    it("a typed id is the whole input: stores the level with a derived body and forModel", function () {
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "ultra" }],
        extraJson: "",
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      assert.equal(draft.override?.forModel, "qwen3:8b");
      assert.deepEqual(
        draft.override?.reasoning?.options.map((o) => o.id),
        ["ultra"],
      );
      assert.deepEqual(draft.override?.reasoning?.options[0]?.controls?.body, {
        think: "ultra",
      });
      assert.deepEqual(draft.rowWarnings, [null]);
    });

    it("does not store rows that merely repeat the detected profile", function () {
      const detected = detectedThinkProfile();
      const rows = detected.reasoning.options.map((option) => ({
        id: option.id,
      }));
      const draft = computeProfileOverrideDraft({
        rows,
        extraJson: "",
        detected,
        modelName: "qwen3:8b",
      });
      assert.isUndefined(
        draft.override,
        "unchanged rows are not a customization",
      );
    });

    it("keeps a detected level's declared body — minimal stays think=false", function () {
      // The detected `minimal` means Off (think=false); re-deriving from the
      // id would send think="minimal" and silently turn thinking on.
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "minimal" }, { id: "ultra" }],
        extraJson: "",
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      const byId = Object.fromEntries(
        (draft.override?.reasoning?.options || []).map((o) => [
          o.id,
          o.controls?.body,
        ]),
      );
      assert.deepEqual(byId.minimal, { think: false });
      assert.deepEqual(byId.ultra, { think: "ultra" });
    });

    it("stores an explicit 'no reasoning' when every row is deleted", function () {
      const draft = computeProfileOverrideDraft({
        rows: [],
        extraJson: "",
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      assert.equal(draft.override?.reasoning?.kind, "none");
      assert.lengthOf(draft.override?.reasoning?.options || [], 0);
      // …and it survives the pref-store round trip.
      const reloaded = normalizeProfileOverride(draft.override);
      assert.equal(reloaded?.reasoning?.kind, "none");
    });

    it("stores nothing for zero rows when the model has no levels anyway", function () {
      const detected = detectedThinkProfile();
      const noReasoning: ResolvedModelCapabilities = {
        ...detected,
        reasoning: { kind: "none", options: [] },
      };
      const draft = computeProfileOverrideDraft({
        rows: [],
        extraJson: "",
        detected: noReasoning,
        modelName: "plain-model",
      });
      assert.isUndefined(draft.override);
    });

    it("warns per row only for what the store would drop: bad id, duplicate", function () {
      const draft = computeProfileOverrideDraft({
        rows: [
          { id: "Bad Level!" },
          { id: "high" },
          { id: "high" },
          { id: "ultra" },
        ],
        extraJson: "",
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      assert.match(draft.rowWarnings[0] || "", /remembered/);
      assert.isNull(draft.rowWarnings[1]);
      assert.match(draft.rowWarnings[2] || "", /Duplicate/);
      assert.isNull(
        draft.rowWarnings[3],
        "an unrecognized level derives its parameter — the model judges it, not the editor",
      );
      assert.isTrue(SUGGESTED_REASONING_LEVEL_IDS.includes("high"));
      assert.equal(coerceParameterValue("  high  "), "high");
    });

    it("rejects envelope keys in the JSON field with a visible error", function () {
      const draft = computeProfileOverrideDraft({
        rows: [],
        extraJson: '{"max_tokens": 128}',
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      assert.match(draft.extraError || "", /max_tokens/);
      assert.isUndefined(draft.override?.extraBody);
    });

    it("derives the parameter from the level name — the level IS the parameter", function () {
      // Ollama's profile declares its bodies with `think`, so a level the
      // model does not already declare derives think=<level> — including a
      // suggested id like `low`, since gpt-oss-style models take graded
      // think levels.
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "ultra" }, { id: "low" }],
        extraJson: "",
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      const byId = Object.fromEntries(
        (draft.override?.reasoning?.options || []).map((o) => [
          o.id,
          o.controls?.body,
        ]),
      );
      assert.deepEqual(byId.ultra, { think: "ultra" });
      assert.deepEqual(byId.low, { think: "low" });
      assert.deepEqual(draft.rowWarnings, [null, null]);
    });

    it("derives reasoning_effort for hosted chat profiles, only for new levels", function () {
      const detected = getModelCapabilities({
        provider: "openai",
        model: "gpt-5",
        protocol: "openai_chat_compat",
      });
      assert.isTrue(
        detected.reasoning.options.every((o) => !o.controls),
        "precondition: hosted legacy profiles declare no bodies",
      );
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "medium" }, { id: "ultra" }],
        extraJson: "",
        detected,
        modelName: "gpt-5",
      });
      const options = draft.override?.reasoning?.options || [];
      assert.isUndefined(
        options.find((o) => o.id === "medium")?.controls,
        "suggested levels keep their per-protocol built-in encoding",
      );
      assert.deepEqual(options.find((o) => o.id === "ultra")?.controls?.body, {
        reasoning_effort: "ultra",
      });
    });

    it("derives the nested reasoning.effort shape for the Responses API", function () {
      const detected = getModelCapabilities({
        provider: "openai",
        model: "gpt-5",
        protocol: "responses_api",
      });
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "ultra" }],
        extraJson: "",
        detected,
        modelName: "gpt-5",
      });
      assert.deepEqual(
        draft.override?.reasoning?.options[0]?.controls?.body,
        { reasoning: { effort: "ultra" } },
        "a flat reasoning_effort key would 400 on the Responses API",
      );
    });

    it("derives the thinkingConfig shape Gemini reads for a level family", function () {
      const detected = getModelCapabilities({
        provider: "gemini",
        model: "gemini-3-pro",
        protocol: "gemini_native",
      });
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "ultra" }],
        extraJson: "",
        detected,
        modelName: "gemini-3-pro",
      });
      assert.deepEqual(
        draft.override?.reasoning?.options[0]?.controls?.body,
        { thinkingConfig: { thinkingLevel: "ultra" } },
        "Gemini reads generationConfig.thinkingConfig; a flat key is dropped",
      );
    });

    it("derives a budget for the Gemini families that take one", function () {
      const detected = getModelCapabilities({
        provider: "gemini",
        model: "gemini-2.5-pro",
        protocol: "gemini_native",
      });
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "24000" }],
        extraJson: "",
        detected,
        modelName: "gemini-2.5-pro",
      });
      assert.deepEqual(
        draft.override?.reasoning?.options[0]?.controls?.body,
        { thinkingConfig: { thinkingBudget: 24000 } },
        "2.5 takes a token budget, not a level word",
      );
    });

    it("still speaks Ollama's think when the server declares no capabilities", function () {
      // An Ollama server that omits `capabilities` from /api/show leaves the
      // profile with no declared options to read the key from. Falling back to
      // a hosted `reasoning_effort` there would be silently ignored by Ollama.
      const detected = getModelCapabilities({
        model: "mistral-small:latest",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      });
      assert.lengthOf(
        detected.reasoning.options,
        0,
        "fixture must be a model with no detected levels",
      );
      const draft = computeProfileOverrideDraft({
        rows: [{ id: "ultra" }],
        extraJson: "",
        detected,
        modelName: "mistral-small:latest",
      });
      assert.deepEqual(draft.override?.reasoning?.options[0]?.controls?.body, {
        think: "ultra",
      });
    });

    it("preserves the user's JSON structure, dotted keys included", function () {
      const draft = computeProfileOverrideDraft({
        rows: [],
        extraJson: '{"a.b": 1, "options": {"repeat_penalty": 1.1}}',
        detected: detectedThinkProfile(),
        modelName: "qwen3:8b",
      });
      assert.deepEqual(draft.override?.extraBody, {
        "a.b": 1,
        options: { repeat_penalty: 1.1 },
      });
    });
  });

  describe("forModel dormancy", function () {
    const OVERRIDE = {
      forModel: "qwen3:8b",
      reasoning: {
        kind: "select" as const,
        options: [
          {
            id: "ultra",
            label: "ultra",
            enabled: true,
            controls: { body: { reasoning_effort: "ultra" } },
          },
        ],
      },
      extraBody: { top_k: 40 },
    };

    it("applies to its own model and stays dormant for another", function () {
      assert.isTrue(profileOverrideAppliesTo(OVERRIDE, "qwen3:8b"));
      assert.isTrue(profileOverrideAppliesTo(OVERRIDE, " qwen3:8b "));
      assert.isFalse(profileOverrideAppliesTo(OVERRIDE, "gemma3:4b"));
      assert.isTrue(
        profileOverrideAppliesTo({ extraBody: { top_k: 1 } }, "anything"),
        "overrides from before forModel existed apply unconditionally",
      );
    });

    it("capability resolution ignores a dormant override without deleting it", function () {
      const applied = getModelCapabilities({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
        profileOverride: OVERRIDE,
      });
      assert.deepEqual(
        applied.reasoning.options.map((o) => o.id),
        ["ultra"],
      );
      assert.equal(applied.provenance.reasoning, "user");

      const dormant = getModelCapabilities({
        model: "gemma3:4b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
        profileOverride: OVERRIDE,
      });
      assert.notEqual(dormant.provenance.reasoning, "user");
      assert.notInclude(
        dormant.reasoning.options.map((o) => o.id),
        "ultra",
      );
    });

    it("a dormant override contributes no extra request parameters", function () {
      assert.deepEqual(resolveUserExtraBody(OVERRIDE, "qwen3:8b"), {
        top_k: 40,
      });
      assert.isUndefined(resolveUserExtraBody(OVERRIDE, "gemma3:4b"));
      assert.isUndefined(resolveUserExtraBody(undefined, "qwen3:8b"));
    });
  });

  describe("reasoning menu sees the override", function () {
    it("offers a user-defined level and hides deleted ones", function () {
      const options = getRuntimeReasoningOptions({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
        profileOverride: {
          forModel: "qwen3:8b",
          reasoning: {
            kind: "select",
            options: [
              {
                id: "ultra",
                label: "ultra",
                enabled: true,
                controls: { body: { think: "high" } },
              },
            ],
          },
        },
      });
      assert.deepEqual(
        options.map((o) => o.level),
        ["ultra"],
        "the menu must offer exactly what the request builder will encode",
      );
    });

    it("hides the menu entirely for an explicit 'no reasoning' override", function () {
      const options = getRuntimeReasoningOptions({
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
        profileOverride: {
          forModel: "qwen3:8b",
          reasoning: { kind: "none", options: [] },
        },
      });
      assert.lengthOf(options, 0);
    });
  });

  describe("request payload honors the override end to end", function () {
    it("encodes a custom level's body and merges extraBody", function () {
      const payload = buildReasoningPayload(
        { provider: "local", level: "ultra" as never },
        false,
        "qwen3:8b",
        "http://localhost:11434",
        "ollama_native",
        {
          profileOverride: {
            forModel: "qwen3:8b",
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "ultra",
                  label: "ultra",
                  enabled: true,
                  controls: { body: { think: "high" } },
                },
              ],
            },
            extraBody: { options: { repeat_penalty: 1.1 } },
          },
        },
      );
      assert.deepEqual(payload.extra.think, "high");
      assert.deepEqual(payload.extra.options, { repeat_penalty: 1.1 });
    });
  });
});
