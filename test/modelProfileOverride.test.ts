import { assert } from "chai";
import {
  configureModelCapabilityRuntime,
  expandDotPaths,
  flattenToDotPaths,
  getModelCapabilities,
  refreshModelCatalog,
  isForbiddenPathSegment,
  normalizeProfileOverride,
  parseJsonObjectField,
  parseKeyValueField,
  pruneProfileOverride,
  resetModelCapabilityStateForTests,
  stringifyJsonObjectField,
  stringifyKeyValueField,
  validateRegistry,
  type ModelProfileOverride,
} from "../src/modelCapabilities";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("model profile override", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  const IDENTITY = {
    model: "qwen3:8b",
    apiBase: "http://localhost:11434",
    protocol: "ollama_native",
  } as const;

  describe("precedence", function () {
    it("beats every detected source, per section", function () {
      const override: ModelProfileOverride = {
        forModel: IDENTITY.model,
        limits: { contextWindowTokens: 4096 },
      };
      const capabilities = getModelCapabilities({
        ...IDENTITY,
        profileOverride: override,
      });
      assert.equal(capabilities.limits.contextWindowTokens, 4096);
      assert.equal(capabilities.provenance.limits, "user");
    });

    it("leaves untouched sections on their detected source", function () {
      const capabilities = getModelCapabilities({
        ...IDENTITY,
        profileOverride: {
          forModel: IDENTITY.model,
          limits: { outputTokens: 999 },
        },
      });
      assert.equal(capabilities.provenance.limits, "user");
      assert.notEqual(
        capabilities.provenance.reasoning,
        "user",
        "overriding limits must not claim authorship of reasoning",
      );
    });

    it("replaces the reasoning option set outright", function () {
      const capabilities = getModelCapabilities({
        ...IDENTITY,
        profileOverride: {
          forModel: IDENTITY.model,
          reasoning: {
            kind: "select",
            defaultOptionId: "medium",
            options: [
              {
                id: "low",
                label: "Low",
                controls: { body: { think: "low" } },
              },
              {
                id: "medium",
                label: "Medium",
                controls: { body: { think: "medium" } },
              },
            ],
          },
        },
      });
      assert.deepEqual(
        capabilities.reasoning.options.map((o) => o.id),
        ["low", "medium"],
      );
      assert.equal(capabilities.provenance.reasoning, "user");
    });
  });

  describe("absent versus empty", function () {
    it("treats a cleared override as never having been set", function () {
      const detected = getModelCapabilities(IDENTITY);
      const afterReset = getModelCapabilities({
        ...IDENTITY,
        profileOverride: pruneProfileOverride({}),
      });
      assert.deepEqual(afterReset.limits, detected.limits);
      assert.deepEqual(afterReset.provenance, detected.provenance);
      assert.notEqual(afterReset.source, "user");
    });

    it("prunes empty sections rather than storing them", function () {
      assert.isUndefined(pruneProfileOverride({}));
      assert.isUndefined(pruneProfileOverride({ limits: {} }));
      assert.isUndefined(pruneProfileOverride(undefined));
      assert.deepEqual(pruneProfileOverride({ limits: { inputTokens: 10 } }), {
        limits: { inputTokens: 10 },
      });
    });

    it("does not keep an override alive on forModel alone", function () {
      // forModel is provenance, not a customization; an override that says
      // only "I was written for qwen3" has nothing to apply.
      assert.isUndefined(
        pruneProfileOverride({ forModel: "qwen3", limits: {} }),
      );
      assert.deepEqual(
        pruneProfileOverride({
          forModel: " qwen3 ",
          limits: { inputTokens: 10 },
        }),
        { limits: { inputTokens: 10 }, forModel: "qwen3" },
      );
    });

    it("does not read a zero or empty string as an override", function () {
      const normalized = normalizeProfileOverride({
        limits: { contextWindowTokens: 0, inputTokens: "", outputTokens: null },
      });
      assert.isUndefined(
        normalized,
        "blank fields must vanish, not clamp the model to nothing",
      );
    });
  });

  describe("dot-path expansion", function () {
    it("builds nested bodies", function () {
      assert.deepEqual(
        expandDotPaths([
          { key: "chat_template_kwargs.enable_thinking", value: true },
          { key: "top_k", value: 40 },
        ]),
        { chat_template_kwargs: { enable_thinking: true }, top_k: 40 },
      );
    });

    it("round-trips through flatten", function () {
      const nested = { a: { b: { c: 1 } }, d: "x" };
      assert.deepEqual(expandDotPaths(flattenToDotPaths(nested)), nested);
    });

    it("drops an entry whose path collides with a scalar", function () {
      assert.deepEqual(
        expandDotPaths([
          { key: "a", value: 1 },
          { key: "a.b", value: 2 },
        ]),
        { a: 1 },
      );
    });

    describe("prototype safety", function () {
      // A naive walker resolves these to Object.prototype and writes through
      // it, which mutates every object in the runtime. The symptom — a global
      // built-in vanishing — cannot be traced back to a typed parameter.
      for (const segment of ["__proto__", "constructor", "prototype"]) {
        it(`refuses ${segment} as a path segment`, function () {
          const before = Object.keys(Object.prototype).length;
          const result = expandDotPaths([
            { key: `${segment}.polluted`, value: "yes" },
          ]);
          assert.deepEqual(result, {});
          assert.isUndefined(
            ({} as Record<string, unknown>).polluted,
            "Object.prototype must be untouched",
          );
          assert.equal(Object.keys(Object.prototype).length, before);
          assert.equal(typeof {}.toString, "function");
        });
      }

      it("refuses a forbidden segment nested mid-path", function () {
        assert.deepEqual(
          expandDotPaths([{ key: "a.__proto__.b", value: 1 }]),
          {},
        );
      });

      it("strips forbidden segments when normalizing stored input", function () {
        const normalized = normalizeProfileOverride({
          extraBody: JSON.parse('{"__proto__":{"polluted":1},"top_k":40}'),
        });
        assert.deepEqual(normalized?.extraBody, { top_k: 40 });
        assert.isUndefined(({} as Record<string, unknown>).polluted);
      });

      it("flags the segments directly", function () {
        assert.isTrue(isForbiddenPathSegment("__proto__"));
        assert.isTrue(isForbiddenPathSegment("constructor"));
        assert.isTrue(isForbiddenPathSegment("prototype"));
        assert.isFalse(isForbiddenPathSegment("think"));
      });
    });
  });

  describe("reasoning level parameters (key=value)", function () {
    it("infers value types from the typed text", function () {
      assert.deepEqual(parseKeyValueField("think=high").value, {
        think: "high",
      });
      assert.deepEqual(parseKeyValueField("think=true").value, {
        think: true,
      });
      assert.deepEqual(parseKeyValueField("think=false").value, {
        think: false,
      });
      assert.deepEqual(parseKeyValueField("top_k=40").value, { top_k: 40 });
      assert.deepEqual(parseKeyValueField("penalty=-0.5").value, {
        penalty: -0.5,
      });
    });

    it("accepts several pairs and dot paths", function () {
      assert.deepEqual(
        parseKeyValueField(
          "chat_template_kwargs.enable_thinking=true, top_k=40",
        ).value,
        { chat_template_kwargs: { enable_thinking: true }, top_k: 40 },
      );
    });

    it("reports malformed pairs instead of dropping them silently", function () {
      const parsed = parseKeyValueField("think high, top_k=40");
      assert.deepEqual(parsed.value, { top_k: 40 });
      assert.deepEqual(parsed.rejected, ["think high"]);
    });

    it("rejects prototype-escaping and reserved keys", function () {
      const parsed = parseKeyValueField(
        "__proto__.x=1, messages=hi, think=high",
      );
      assert.deepEqual(parsed.value, { think: "high" });
      assert.deepEqual(parsed.rejected, ["__proto__.x=1", "messages=hi"]);
      assert.isUndefined(({} as Record<string, unknown>).x);
    });

    it("round-trips through the editor's rendering", function () {
      const body = { think: "high" };
      assert.deepEqual(
        parseKeyValueField(stringifyKeyValueField(body)).value,
        body,
      );
      assert.equal(stringifyKeyValueField(undefined), "");
    });
  });

  describe("a provider-introduced level the plugin does not know", function () {
    // Providers ship new effort values between plugin releases. A user must be
    // able to add one without waiting for us.
    const HOSTED = {
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
    } as const;

    const ULTRA_OVERRIDE: ModelProfileOverride = {
      forModel: HOSTED.model,
      reasoning: {
        kind: "select",
        options: [
          {
            id: "ultra",
            label: "ultra",
            enabled: true,
            controls: { body: { reasoning_effort: "ultra" } },
          },
        ],
      },
    };

    it("offers the level in the menu", function () {
      const capabilities = getModelCapabilities({
        ...HOSTED,
        profileOverride: ULTRA_OVERRIDE,
      });
      assert.deepEqual(
        capabilities.reasoning.options.map((o) => o.id),
        ["ultra"],
      );
    });

    it("sends the level's own parameters rather than a guessed effort", function () {
      const payload = buildReasoningPayload(
        { provider: "openai", level: "ultra" },
        true,
        HOSTED.model,
        HOSTED.apiBase,
        "responses_api",
        { profileOverride: ULTRA_OVERRIDE },
      );
      assert.deepEqual(payload.extra, { reasoning_effort: "ultra" });
    });

    it("without parameters, falls back to the provider's own handling", function () {
      // resolveOpenAIReasoningEffort walks OPENAI_EFFORT_ORDER and returns the
      // lowest supported effort for an unrecognized level, so "ultra" would
      // quietly mean "minimal". The editor warns about exactly this case.
      const payload = buildReasoningPayload(
        { provider: "openai", level: "ultra" },
        true,
        HOSTED.model,
        HOSTED.apiBase,
        "responses_api",
        {
          profileOverride: {
            forModel: HOSTED.model,
            reasoning: {
              kind: "select",
              options: [{ id: "ultra", label: "ultra", enabled: true }],
            },
          },
        },
      );
      const reasoning = payload.extra.reasoning as { effort?: string };
      assert.notEqual(
        reasoning?.effort,
        "ultra",
        "an unknown level cannot invent a wire value on its own",
      );
    });

    it("accepts an id shaped so the pref store will remember it", function () {
      const normalized = normalizeProfileOverride(ULTRA_OVERRIDE);
      assert.deepEqual(
        normalized?.reasoning?.options.map((o) => o.id),
        ["ultra"],
      );
    });
  });

  describe("turning reasoning off", function () {
    it("ships an off level for Ollama by default", async function () {
      configureModelCapabilityRuntime({
        fetch: (async (url: string) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("/api/tags")
                ? { models: [{ name: "gemma4" }] }
                : { capabilities: ["completion", "thinking"], model_info: {} },
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
      });
      const identity = {
        model: "gemma4",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      await refreshModelCatalog(identity);

      const off = getModelCapabilities(identity).reasoning.options.find(
        (option) => option.label.toLowerCase() === "off",
      );
      assert.isDefined(off, "a thinking model must ship a way to turn it off");
      assert.deepEqual(off?.controls?.body, { think: false });
    });

    it("sends the disabling parameter, not an absent one", function () {
      const payload = buildReasoningPayload(
        { provider: "local", level: "off" },
        false,
        "gemma4",
        "http://localhost:11434",
        "ollama_native",
        {
          profileOverride: {
            forModel: "gemma4",
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "off",
                  label: "off",
                  enabled: true,
                  controls: { body: { think: false } },
                },
              ],
            },
          },
        },
      );
      assert.deepEqual(
        payload.extra,
        { think: false },
        "omitting the parameter would let the server enable thinking by default",
      );
    });

    it("supports an off level on a hosted provider too", function () {
      const payload = buildReasoningPayload(
        { provider: "openai", level: "off" },
        true,
        "gpt-5.4",
        "https://api.openai.com/v1/responses",
        "responses_api",
        {
          profileOverride: {
            forModel: "gpt-5.4",
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "off",
                  label: "off",
                  enabled: true,
                  controls: { body: { reasoning_effort: "none" } },
                },
              ],
            },
          },
        },
      );
      assert.deepEqual(payload.extra, { reasoning_effort: "none" });
    });

    it("keeps an off level's id storable so it survives a restart", function () {
      const normalized = normalizeProfileOverride({
        reasoning: {
          kind: "select",
          options: [
            {
              id: "off",
              label: "off",
              controls: { body: { think: false } },
            },
          ],
        },
      });
      assert.equal(normalized?.reasoning?.options[0].id, "off");
    });
  });

  describe("extra parameters (JSON)", function () {
    it("parses an object and preserves value types", function () {
      const parsed = parseJsonObjectField(
        '{"think": "high", "top_k": 40, "raw": true}',
      );
      assert.isUndefined(parsed.error);
      assert.deepEqual(parsed.value, {
        think: "high",
        top_k: 40,
        raw: true,
      });
    });

    it("treats blank as no parameters rather than an error", function () {
      assert.deepEqual(parseJsonObjectField("   "), {});
      assert.deepEqual(parseJsonObjectField(""), {});
    });

    it("reports malformed JSON instead of silently dropping it", function () {
      const parsed = parseJsonObjectField("{think: high}");
      assert.isString(parsed.error);
      assert.isUndefined(parsed.value);
    });

    it("rejects a non-object payload", function () {
      assert.isString(parseJsonObjectField("[1,2]").error);
      assert.isString(parseJsonObjectField('"text"').error);
      assert.isString(parseJsonObjectField("42").error);
    });

    it("strips prototype-escaping keys from parsed JSON", function () {
      const parsed = parseJsonObjectField(
        '{"__proto__": {"polluted": 1}, "top_k": 40}',
      );
      assert.deepEqual(parsed.value, { top_k: 40 });
      assert.isUndefined(({} as Record<string, unknown>).polluted);
    });

    it("round-trips through the editor's rendering", function () {
      const body = { think: "high", options: { repeat_penalty: 1.1 } };
      const text = stringifyJsonObjectField(body);
      assert.deepEqual(parseJsonObjectField(text).value, body);
    });

    it("renders nothing for an absent or empty object", function () {
      assert.equal(stringifyJsonObjectField(undefined), "");
      assert.equal(stringifyJsonObjectField({}), "");
    });
  });

  describe("trust boundary", function () {
    it("accepts arbitrary sampling keys a user needs locally", function () {
      const normalized = normalizeProfileOverride({
        extraBody: { top_k: 40, repeat_penalty: 1.1, stop: "END" },
      });
      assert.deepEqual(normalized?.extraBody, {
        top_k: 40,
        repeat_penalty: 1.1,
        stop: "END",
      });
    });

    it("still rejects the same keys from the remote registry", function () {
      const rejected = validateRegistry({
        schemaVersion: 1,
        revision: 9,
        models: [
          {
            match: { exact: "x" },
            reasoning: {
              kind: "select",
              options: [
                { id: "a", label: "A", controls: { body: { top_k: 40 } } },
              ],
            },
          },
        ],
      });
      assert.isNull(
        rejected,
        "the network-fetched registry keeps its allowlist",
      );
    });

    it("refuses an oversized override rather than storing it", function () {
      const huge = normalizeProfileOverride({
        extraBody: { blob: "x".repeat(20000) },
      });
      assert.isUndefined(huge);
    });
  });

  describe("request body", function () {
    it("merges extra parameters into the payload", function () {
      const payload = buildReasoningPayload(
        undefined,
        false,
        "qwen3:8b",
        "http://localhost:11434",
        "ollama_native",
        {
          profileOverride: {
            forModel: "qwen3:8b",
            extraBody: { top_k: 40 },
          },
        },
      );
      assert.deepEqual(payload.extra, { top_k: 40 });
    });

    it("refuses reserved envelope keys", function () {
      // Spread into the body after the envelope in most payload builders, so
      // these would replace the conversation, drop every tool, or disable
      // streaming — none of which look like a bad parameter to the user.
      const payload = buildReasoningPayload(
        undefined,
        false,
        "qwen3:8b",
        "http://localhost:11434",
        "ollama_native",
        {
          profileOverride: {
            forModel: "qwen3:8b",
            extraBody: {
              messages: [{ role: "user", content: "hijack" }],
              tools: [],
              model: "other-model",
              stream: false,
              top_k: 40,
            },
          },
        },
      );
      assert.deepEqual(payload.extra, { top_k: 40 });
    });

    it("lets the live reasoning selection win over static configuration", function () {
      const payload = buildReasoningPayload(
        { provider: "local", level: "high" },
        false,
        "custom-model",
        "http://localhost:11434",
        "ollama_native",
        {
          profileOverride: {
            forModel: "custom-model",
            extraBody: { think: false, top_k: 40 },
            reasoning: {
              kind: "select",
              options: [
                {
                  id: "high",
                  label: "High",
                  controls: { body: { think: "high" } },
                },
              ],
            },
          },
        },
      );
      assert.equal(
        payload.extra.think,
        "high",
        "the per-message control must not be shadowed by static config",
      );
      assert.equal(payload.extra.top_k, 40);
    });
  });

  describe("malformed input", function () {
    it("degrades instead of throwing", function () {
      for (const value of [
        null,
        undefined,
        42,
        "string",
        [],
        { limits: "nope" },
        { reasoning: { options: "nope" } },
        { inputs: { image: "yes" } },
        { extraBody: null },
      ]) {
        assert.doesNotThrow(() => normalizeProfileOverride(value));
      }
    });

    it("drops feature and input flags written by earlier builds", function () {
      // Per-model feature toggles are the plugin's job to detect, never the
      // user's to declare — a stored override from the build that offered
      // them loses those sections on read and keeps the rest.
      const normalized = normalizeProfileOverride({
        inputs: { image: true, pdf: true },
        features: { tools: false },
        sampling: { temperature: "fixed" },
        extraBody: { top_k: 40 },
      });
      assert.deepEqual(normalized, { extraBody: { top_k: 40 } });
    });

    it("drops reasoning options that have no id", function () {
      const normalized = normalizeProfileOverride({
        reasoning: {
          kind: "select",
          options: [{ label: "No id" }, { id: "ok", label: "OK" }],
        },
      });
      assert.deepEqual(
        normalized?.reasoning?.options.map((o) => o.id),
        ["ok"],
      );
    });

    it("drops request-envelope keys from imported reasoning controls", function () {
      const normalized = normalizeProfileOverride({
        forModel: "local-model",
        reasoning: {
          kind: "select",
          options: [
            {
              id: "high",
              label: "High",
              controls: {
                body: {
                  messages: [{ role: "user", content: "replace me" }],
                  tools: [],
                  stream: false,
                  top_k: 40,
                },
              },
            },
          ],
        },
      });
      assert.deepEqual(normalized?.reasoning?.options[0].controls?.body, {
        top_k: 40,
      });

      const payload = buildReasoningPayload(
        { provider: "local", level: "high" },
        false,
        "local-model",
        "http://127.0.0.1:1234/v1",
        "openai_chat_compat",
        { profileOverride: normalized },
      );
      assert.deepEqual(payload.extra, { top_k: 40 });
    });

    it("drops imported reasoning ids that the preference store cannot retain", function () {
      const normalized = normalizeProfileOverride({
        reasoning: {
          kind: "select",
          options: [
            { id: "valid", label: "Valid" },
            { id: "INVALID VALUE", label: "Invalid" },
          ],
        },
      });
      assert.deepEqual(
        normalized?.reasoning?.options.map((option) => option.id),
        ["valid"],
      );
    });
  });
});
