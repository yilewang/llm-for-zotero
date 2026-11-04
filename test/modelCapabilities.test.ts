import { assert } from "chai";
import bundledRegistry from "../registry/model-capabilities.v1.json";
import {
  compileReasoningControls,
  configureModelCapabilityRuntime,
  ensureModelCapabilities,
  getModelCapabilities,
  getModelReasoningChoices,
  getDiscoveredModels,
  refreshModelCapabilityRegistry,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
  setModelCapabilityRegistryForTests,
  subscribeModelCapabilities,
  type ModelCapabilityRegistry,
} from "../src/modelCapabilities";
import {
  getModelInputTokenLimit,
  resolveContextWindowTokens,
} from "../src/utils/modelInputCap";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("model capability service", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  it("recognizes a new Kimi model from registry data without a plugin release", function () {
    const registry: ModelCapabilityRegistry = {
      schemaVersion: 1,
      revision: 3,
      models: [
        {
          match: { provider: "kimi", exact: "kimi-v4" },
          limits: {
            contextWindowTokens: 2_000_000,
            inputTokens: 2_000_000,
          },
          reasoning: {
            kind: "select",
            defaultOptionId: "ultra",
            options: [
              {
                id: "ultra",
                label: "Ultra",
                controls: {
                  body: {
                    thinking: { type: "enabled", effort: "ultra" },
                  },
                  omitTemperature: true,
                },
              },
            ],
          },
        },
      ],
    };

    assert.isTrue(setModelCapabilityRegistryForTests(registry));
    const capabilities = getModelCapabilities({
      provider: "kimi",
      model: "kimi-v4",
      apiBase: "https://api.moonshot.ai/v1",
    });
    assert.equal(capabilities.limits.inputTokens, 2_000_000);
    assert.deepEqual(
      capabilities.reasoning.options.map((option) => option.id),
      ["ultra"],
    );
    assert.equal(
      getModelInputTokenLimit("kimi-v4", {
        provider: "kimi",
        apiBase: "https://api.moonshot.ai/v1",
      }),
      2_000_000,
    );
    assert.deepEqual(
      compileReasoningControls(capabilities, { level: "ultra" }),
      {
        extra: { thinking: { type: "enabled", effort: "ultra" } },
        omitTemperature: true,
      },
    );
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "kimi", level: "ultra" },
        false,
        "kimi-v4",
        "https://api.moonshot.ai/v1",
        "openai_chat_compat",
      ),
      {
        extra: { thinking: { type: "enabled", effort: "ultra" } },
        omitTemperature: true,
      },
    );
  });

  it("labels the reasoning menu's first choice plainly as Auto", function () {
    const capabilities = getModelCapabilities({
      provider: "local",
      model: "profiled-local",
      profileOverride: {
        forModel: "profiled-local",
        reasoning: {
          kind: "select",
          defaultOptionId: "none",
          options: [
            {
              id: "none",
              label: "Disabled",
              controls: { body: { think: false } },
            },
          ],
        },
      },
    });

    assert.deepEqual(getModelReasoningChoices(capabilities)[0], {
      level: "auto",
      label: "Auto",
      enabled: true,
    });
  });

  it("applies controls for an explicit disabled option named none", function () {
    const capabilities = getModelCapabilities({
      provider: "local",
      model: "profiled-local",
      profileOverride: {
        forModel: "profiled-local",
        reasoning: {
          kind: "select",
          defaultOptionId: "none",
          options: [
            {
              id: "none",
              label: "Disabled",
              controls: { body: { think: false } },
            },
          ],
        },
      },
    });

    assert.deepEqual(
      compileReasoningControls(capabilities, { level: "none" }),
      { extra: { think: false }, omitTemperature: false },
    );
    const bare = getModelCapabilities({
      provider: "local",
      model: "bare-none-local",
      profileOverride: {
        forModel: "bare-none-local",
        reasoning: {
          kind: "select",
          options: [{ id: "none", label: "None" }],
        },
      },
    });
    assert.isNull(compileReasoningControls(bare, { level: "none" }));
  });

  it("never lets a disabled level inherit the capability-level enable patch", function () {
    // Only a registry entry can pair capability-level controls with a bare
    // disabled option — normalizeProfileOverride keeps per-option bodies only.
    const registry: ModelCapabilityRegistry = {
      schemaVersion: 1,
      revision: 3,
      models: [
        {
          match: { provider: "qwen", exact: "qwen-shared-controls" },
          reasoning: {
            kind: "select",
            defaultOptionId: "high",
            controls: { body: { enable_thinking: true } },
            options: [
              { id: "none", label: "None" },
              { id: "high", label: "High" },
            ],
          },
        },
      ],
    };
    assert.isTrue(setModelCapabilityRegistryForTests(registry));
    const capabilities = getModelCapabilities({
      provider: "qwen",
      model: "qwen-shared-controls",
      apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });

    // "high" has no controls of its own, so the shared patch still applies.
    assert.deepEqual(
      compileReasoningControls(capabilities, { level: "high" }),
      {
        extra: { enable_thinking: true },
        omitTemperature: false,
      },
    );
    // "none" must not turn thinking on.
    assert.isNull(compileReasoningControls(capabilities, { level: "none" }));
  });

  it("omits temperature from a declared control when the model fixes sampling", function () {
    const registry: ModelCapabilityRegistry = {
      schemaVersion: 1,
      revision: 3,
      models: [
        {
          match: { provider: "anthropic", exact: "claude-fixed-sampling" },
          reasoning: {
            kind: "select",
            options: [
              {
                id: "none",
                label: "Off",
                controls: { body: { thinking: { type: "disabled" } } },
              },
            ],
          },
          sampling: { temperature: "unsupported" },
        },
      ],
    };
    assert.isTrue(setModelCapabilityRegistryForTests(registry));
    const capabilities = getModelCapabilities({
      provider: "anthropic",
      model: "claude-fixed-sampling",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
    });

    // The option itself says nothing about temperature; the model's sampling
    // contract still has to keep it out of the request.
    assert.deepEqual(
      compileReasoningControls(capabilities, { level: "none" }),
      {
        extra: { thinking: { type: "disabled" } },
        omitTemperature: true,
      },
    );
  });

  it("knows Claude Haiku 5.5 rejects temperature, and keeps Haiku 4.5 configurable", function () {
    // https://platform.claude.com/docs/en/build-with-claude/thinking — on
    // Haiku 5.5 a non-default temperature returns a 400 on every request.
    const haiku55 = getModelCapabilities({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
    });
    assert.equal(haiku55.sampling.temperature, "unsupported");
    // 200k, not the API's 1M: tool views are sized from this limit, and a
    // 1M limit pushed library-wide views past Haiku's 100k-token price tier.
    assert.equal(haiku55.limits.contextWindowTokens, 200_000);
    assert.equal(haiku55.limits.inputTokens, 200_000);
    assert.equal(haiku55.limits.outputTokens, 128_000);
    // Sampling data must not displace the hand-maintained reasoning profile.
    assert.equal(haiku55.provenance.reasoning, "legacy");
    // Haiku 5.5 is the one 5.x model that may switch thinking off.
    assert.deepEqual(
      getModelReasoningChoices(haiku55).map((choice) => choice.label),
      ["Auto", "low", "medium", "high", "max", "Off"],
    );
    const opus55 = getModelCapabilities({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
    });
    assert.deepEqual(
      getModelReasoningChoices(opus55).map((choice) => choice.label),
      ["Auto", "low", "medium", "high", "xhigh", "max"],
    );

    const haiku45 = getModelCapabilities({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
    });
    assert.equal(haiku45.sampling.temperature, "configurable");

    for (const model of [
      "claude-haiku-5-5@20261001",
      "claude-haiku-5-5-20261001",
      "anthropic/claude-haiku-5-5",
    ]) {
      const dated = getModelCapabilities({
        provider: "anthropic",
        model,
        apiBase: "https://api.anthropic.com/v1",
        protocol: "anthropic_messages",
      });
      assert.equal(dated.sampling.temperature, "unsupported", model);
      assert.equal(dated.limits.contextWindowTokens, 200_000, model);
    }
  });

  it("uses live model metadata and preserves exact opaque model IDs", async function () {
    configureModelCapabilityRuntime({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "kimi-v4-20260809",
                context_length: 2_000_000,
                supports_reasoning: true,
                supports_image_in: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const identity = {
      provider: "kimi",
      model: "configured-placeholder",
      apiBase: "https://api.moonshot.ai/v1",
      protocol: "openai_chat_compat",
      apiKey: "secret-for-test",
    } as const;
    await refreshModelCatalog(identity);
    assert.deepEqual(
      getDiscoveredModels(identity).map((model) => model.id),
      ["kimi-v4-20260809"],
    );
    const capabilities = getModelCapabilities({
      ...identity,
      model: "kimi-v4-20260809",
    });
    assert.equal(capabilities.limits.contextWindowTokens, 2_000_000);
    assert.equal(capabilities.reasoning.kind, "server_default");
    assert.isTrue(capabilities.inputs.image);
  });

  it("runs bounded first-use discovery and applies scoped catalog data to requests", async function () {
    const calls: string[] = [];
    configureModelCapabilityRuntime({
      environment: "production",
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("raw.githubusercontent.com")) {
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              revision: bundledRegistry.revision + 1,
              models: [
                {
                  match: { provider: "kimi", exact: "kimi-v4" },
                  reasoning: {
                    kind: "select",
                    defaultOptionId: "ultra",
                    options: [{ id: "ultra", label: "Ultra" }],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "kimi-v4", context_length: 2_000_000 }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const identity = {
      provider: "kimi",
      model: "kimi-v4",
      apiBase: "https://api.moonshot.ai/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiKey: "secret-for-test",
      scope: "group-1",
    } as const;

    await ensureModelCapabilities(identity, { timeoutMs: 100 });

    assert.lengthOf(calls, 2);
    const capabilities = getModelCapabilities({
      provider: identity.provider,
      model: identity.model,
      apiBase: identity.apiBase,
      protocol: identity.protocol,
      authMode: identity.authMode,
    });
    assert.equal(capabilities.limits.contextWindowTokens, 2_000_000);
    assert.equal(
      getModelInputTokenLimit("kimi-v4", {
        provider: identity.provider,
        apiBase: identity.apiBase,
        protocol: identity.protocol,
        authMode: identity.authMode,
      }),
      2_000_000,
    );
    assert.deepEqual(
      capabilities.reasoning.options.map((option) => option.id),
      ["ultra"],
    );
  });

  describe("failed refreshes", function () {
    const identity = {
      provider: "kimi",
      model: "kimi-v4",
      apiBase: "https://api.moonshot.ai/v1",
      protocol: "openai_chat_compat",
      apiKey: "secret-for-test",
    } as const;

    it("waits 10 s before retrying a failed catalog fetch unless forced", async function () {
      let clock = 1_000_000;
      let fetches = 0;
      configureModelCapabilityRuntime({
        now: () => clock,
        fetch: (async () => {
          fetches += 1;
          throw new Error("offline");
        }) as typeof fetch,
      });
      await refreshModelCatalog(identity);
      await refreshModelCatalog(identity);
      clock += 5_000;
      await refreshModelCatalog(identity);
      assert.equal(fetches, 1);
      await refreshModelCatalog(identity, { force: true });
      assert.equal(fetches, 2);
      clock += 11_000;
      await refreshModelCatalog(identity);
      assert.equal(fetches, 3);
    });

    it("does not notify again when a repeated failure changes nothing", async function () {
      let clock = 1_000_000;
      configureModelCapabilityRuntime({
        now: () => clock,
        fetch: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      });
      let notifications = 0;
      const unsubscribe = subscribeModelCapabilities(() => {
        notifications += 1;
      });
      try {
        await refreshModelCatalog(identity);
        assert.equal(notifications, 1);
        clock += 61_000;
        await refreshModelCatalog(identity);
        await refreshModelCatalog(identity, { force: true });
        assert.equal(notifications, 1);
      } finally {
        unsubscribe();
      }
    });

    it("waits 60 s before retrying a failed registry fetch unless forced", async function () {
      let clock = 1_000_000;
      let fetches = 0;
      configureModelCapabilityRuntime({
        now: () => clock,
        fetch: (async () => {
          fetches += 1;
          throw new Error("offline");
        }) as typeof fetch,
      });
      assert.isFalse(await refreshModelCapabilityRegistry());
      assert.isFalse(await refreshModelCapabilityRegistry());
      assert.equal(fetches, 1);
      clock += 61_000;
      await refreshModelCapabilityRegistry();
      assert.equal(fetches, 2);
      await refreshModelCapabilityRegistry({ force: true });
      assert.equal(fetches, 3);
    });
  });

  it("accepts a newer validated remote registry revision", async function () {
    configureModelCapabilityRuntime({
      fetch: (async () => {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              schemaVersion: 1,
              revision: bundledRegistry.revision + 1,
              models: [
                {
                  match: { provider: "kimi", exact: "kimi-v4" },
                  limits: {
                    contextWindowTokens: 2_000_000,
                    inputTokens: 2_000_000,
                  },
                  reasoning: {
                    kind: "select",
                    defaultOptionId: "ultra",
                    options: [{ id: "ultra", label: "Ultra" }],
                  },
                },
              ],
            }),
        };
      }) as typeof fetch,
    });
    assert.isTrue(await refreshModelCapabilityRegistry({ force: true }));
    assert.deepEqual(
      getModelCapabilities({
        provider: "kimi",
        model: "kimi-v4",
      }).reasoning.options.map((option) => option.id),
      ["ultra"],
    );
  });

  it("rejects registry controls outside the model-control allowlist", function () {
    const accepted = setModelCapabilityRegistryForTests({
      schemaVersion: 1,
      revision: 3,
      models: [
        {
          match: { provider: "kimi", exact: "unsafe" },
          reasoning: {
            kind: "select",
            options: [
              {
                id: "ultra",
                label: "Ultra",
                controls: { body: { messages: ["must-not-be-allowed"] } },
              },
            ],
          },
        },
      ],
    });
    assert.isFalse(accepted);
  });

  it("keeps explicit user caps above discovered model limits", function () {
    assert.equal(
      getModelInputTokenLimit("kimi-k3", {
        provider: "kimi",
        apiBase: "https://api.moonshot.ai/v1",
      }),
      1048576,
    );
    assert.equal(
      resolveContextWindowTokens("kimi-k3", 2_000_000, {
        provider: "kimi",
        apiBase: "https://api.moonshot.ai/v1",
      }),
      2_000_000,
    );
  });

  it("ships qwen3.8-max context and output metadata", function () {
    const capabilities = getModelCapabilities({
      model: "openrouter/qwen3.8-max",
      apiBase: "https://proxy.example/v1",
    });

    assert.equal(capabilities.limits.contextWindowTokens, 1_000_000);
    assert.isUndefined(capabilities.limits.inputTokens);
    assert.equal(capabilities.limits.outputTokens, 131_072);
  });

  it("preserves arbitrary future model IDs and user reasoning levels", function () {
    const model = "relay/vendor-model-2031-alpha";
    const capabilities = getModelCapabilities({
      provider: "customized",
      model,
      profileOverride: {
        forModel: model,
        reasoning: {
          kind: "select",
          defaultOptionId: "quantum",
          options: [
            {
              id: "quantum",
              label: "Quantum",
              controls: { body: { reasoning_effort: "quantum" } },
            },
          ],
        },
      },
    });

    assert.equal(capabilities.model, model);
    assert.deepEqual(
      capabilities.reasoning.options.map((option) => option.id),
      ["quantum"],
    );
    assert.deepEqual(
      compileReasoningControls(capabilities, { level: "quantum" }),
      {
        extra: { reasoning_effort: "quantum" },
        omitTemperature: false,
      },
    );
  });

  it("lists models for Anthropic-compat proxy bases via the provider's OpenAI-compatible endpoint", async function () {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    configureModelCapabilityRuntime({
      environment: "test",
      fetch: (async (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => {
        requests.push({ url, headers: init?.headers || {} });
        return {
          ok: true,
          json: async () => ({ data: [{ id: "deepseek-chat" }] }),
        };
      }) as unknown as typeof fetch,
    });
    const models = await refreshModelCatalog({
      provider: "deepseek",
      model: "",
      apiBase: "https://api.deepseek.com/anthropic",
      protocol: "anthropic_messages",
      authMode: "api_key",
      apiKey: "sk-deepseek",
      scope: "group-ds",
    });
    assert.deepEqual(
      models.map((model) => model.id),
      ["deepseek-chat"],
    );
    assert.lengthOf(requests, 1);
    assert.equal(
      requests[0].url,
      "https://api.deepseek.com/models",
      "the /anthropic proxy base has no models route; use the OpenAI-compatible one",
    );
    assert.equal(requests[0].headers.Authorization, "Bearer sk-deepseek");
    assert.isUndefined(requests[0].headers["x-api-key"]);
  });

  it("authenticates Gemini catalog requests via header instead of the URL", async function () {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    configureModelCapabilityRuntime({
      environment: "test",
      fetch: (async (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => {
        requests.push({ url, headers: init?.headers || {} });
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "models/gemini-2.5-pro" }],
          }),
        };
      }) as unknown as typeof fetch,
    });
    const models = await refreshModelCatalog({
      provider: "gemini",
      model: "",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      protocol: "gemini_native",
      authMode: "api_key",
      apiKey: "gemini-key",
      scope: "group-gm",
    });
    assert.deepEqual(
      models.map((model) => model.id),
      ["gemini-2.5-pro"],
    );
    assert.lengthOf(requests, 1);
    assert.notInclude(requests[0].url, "gemini-key");
    assert.equal(requests[0].headers["x-goog-api-key"], "gemini-key");
  });

  it("coalesces concurrent catalog refreshes for the same identity", async function () {
    let fetchCalls = 0;
    let releaseFetch: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    configureModelCapabilityRuntime({
      environment: "test",
      fetch: (async () => {
        fetchCalls += 1;
        await gate;
        return {
          ok: true,
          json: async () => ({ data: [{ id: "kimi-k3" }] }),
        };
      }) as unknown as typeof fetch,
    });
    const identity = {
      provider: "kimi",
      model: "",
      apiBase: "https://api.moonshot.ai/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiKey: "k",
      scope: "group-1",
    };
    const first = refreshModelCatalog(identity);
    const second = refreshModelCatalog(identity);
    releaseFetch?.();
    const [firstModels, secondModels] = await Promise.all([first, second]);
    assert.equal(fetchCalls, 1, "concurrent callers share one request");
    assert.deepEqual(
      firstModels.map((model) => model.id),
      ["kimi-k3"],
    );
    assert.deepEqual(secondModels, firstModels);
  });

  it("compiles kimi-k3 reasoning as the top-level reasoning_effort field", function () {
    const capabilities = getModelCapabilities({
      provider: "kimi",
      model: "kimi-k3",
      apiBase: "https://api.moonshot.ai/v1",
      protocol: "openai_chat_compat",
    });
    assert.equal(capabilities.reasoning.kind, "select");
    assert.equal(capabilities.reasoning.defaultOptionId, "max");
    const compiled = compileReasoningControls(capabilities, { level: "low" });
    assert.deepEqual(compiled?.extra, { reasoning_effort: "low" });
  });

  it("maps Kimi-for-Coding model ids onto the K3 capability entries", function () {
    const identityBase = {
      provider: "kimi" as const,
      apiBase: "https://api.kimi.com/coding/v1",
      protocol: "openai_chat_compat" as const,
    };
    const k3 = getModelCapabilities({ ...identityBase, model: "k3" });
    assert.equal(k3.reasoning.kind, "select");
    assert.equal(k3.reasoning.defaultOptionId, "max");
    assert.deepEqual(compileReasoningControls(k3, { level: "high" })?.extra, {
      reasoning_effort: "high",
    });

    const k3Compact = getModelCapabilities({
      ...identityBase,
      model: "k3-256k",
    });
    assert.equal(k3Compact.reasoning.kind, "select");
    assert.equal(k3Compact.limits.contextWindowTokens, 262144);

    const forCoding = getModelCapabilities({
      ...identityBase,
      model: "kimi-for-coding",
    });
    assert.equal(forCoding.reasoning.kind, "select");
  });

  it("ships the deployable registry with the K3 reasoning_effort wire format", async function () {
    const { readFileSync } = await import("node:fs");
    const registry = JSON.parse(
      readFileSync("registry/model-capabilities.v1.json", "utf8"),
    ) as {
      revision: number;
      models: Array<{
        match: { provider?: string; prefix?: string; exact?: string };
        reasoning?: {
          options?: Array<{ controls?: { body?: Record<string, unknown> } }>;
        };
      }>;
    };
    const k3Entries = registry.models.filter(
      (entry) =>
        entry.match.provider === "kimi" &&
        (entry.match.prefix || entry.match.exact || "").includes("k3"),
    );
    assert.isAbove(k3Entries.length, 0, "registry keeps a kimi-k3 entry");
    for (const entry of k3Entries) {
      for (const option of entry.reasoning?.options || []) {
        assert.notProperty(
          option.controls?.body || {},
          "thinking",
          "K3 must not send the K2.x thinking parameter",
        );
        assert.property(option.controls?.body || {}, "reasoning_effort");
      }
    }
    const coveredPrefixes = registry.models
      .filter((entry) => entry.match.provider === "kimi")
      .map((entry) => entry.match.prefix || entry.match.exact || "");
    assert.include(coveredPrefixes, "k3", "coding-endpoint alias k3 covered");
    assert.include(
      coveredPrefixes,
      "kimi-for-coding",
      "coding-endpoint alias kimi-for-coding covered",
    );
  });

  it("fetches SiliconFlow chat models with Bearer auth, preserves full model IDs, and filters out non-chat models", async function () {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    configureModelCapabilityRuntime({
      environment: "test",
      fetch: (async (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => {
        requests.push({ url, headers: init?.headers || {} });
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              {
                id: "Qwen/Qwen2.5-72B-Instruct",
                object: "model",
                sub_type: "chat",
              },
              {
                id: "deepseek-ai/DeepSeek-V3",
                object: "model",
              },
              {
                id: "Pro/deepseek-ai/DeepSeek-R1",
                object: "model",
              },
              {
                id: "BAAI/bge-large-zh-v1.5",
                object: "model",
                sub_type: "embedding",
              },
              {
                id: "BAAI/bge-reranker-v2-m3",
                object: "model",
                sub_type: "reranker",
              },
              {
                id: "black-forest-labs/FLUX.1-schnell",
                object: "model",
                type: "image",
                sub_type: "text-to-image",
              },
              {
                id: "FunAudioLLM/SenseVoiceSmall",
                object: "model",
                type: "audio",
              },
              {
                id: "Qwen/Qwen3-Embedding-8B",
                object: "model",
              },
            ],
          }),
        };
      }) as unknown as typeof fetch,
    });

    const models = await refreshModelCatalog({
      provider: "siliconflow",
      model: "",
      apiBase: "https://api.siliconflow.cn/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiKey: "sf-test-key",
      scope: "group-sf",
    });

    assert.lengthOf(requests, 1);
    assert.equal(
      requests[0].url,
      "https://api.siliconflow.cn/v1/models?sub_type=chat",
    );
    assert.equal(requests[0].headers.Authorization, "Bearer sf-test-key");
    assert.deepEqual(
      models.map((m) => m.id),
      [
        "deepseek-ai/DeepSeek-V3",
        "Pro/deepseek-ai/DeepSeek-R1",
        "Qwen/Qwen2.5-72B-Instruct",
      ],
    );

    const deepseekCaps = getModelCapabilities({
      provider: "siliconflow",
      model: "deepseek-ai/DeepSeek-V3",
      apiBase: "https://api.siliconflow.cn/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      scope: "group-sf",
    });
    assert.equal(deepseekCaps.provider, "deepseek");
  });

  it("fetches LLMTR chat models with Bearer auth, keeps prefixed ids, and drops non-chat rows", async function () {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    configureModelCapabilityRuntime({
      environment: "test",
      fetch: (async (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => {
        requests.push({ url, headers: init?.headers || {} });
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              {
                id: "qwen/qwen3.8-27b-free",
                object: "model",
                supported_operations: ["CHAT_COMPLETIONS"],
              },
              {
                id: "llmtr/qwen3-8-27b",
                object: "model",
                supported_operations: ["CHAT_COMPLETIONS", "RESPONSES"],
              },
              {
                id: "openai/gpt-4o-mini",
                object: "model",
                supported_operations: ["RESPONSES"],
              },
              {
                id: "openai/text-embedding-3-small",
                object: "model",
                supported_operations: ["EMBEDDINGS"],
              },
              {
                id: "black-forest/flux",
                object: "model",
                supported_operations: ["IMAGES_GENERATIONS"],
              },
            ],
          }),
        };
      }) as unknown as typeof fetch,
    });

    const models = await refreshModelCatalog({
      provider: "llmtr",
      model: "",
      apiBase: "https://llmtr.com/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiKey: "llmtr-test-key",
      scope: "group-llmtr",
    });

    assert.lengthOf(requests, 1);
    assert.equal(requests[0].url, "https://llmtr.com/v1/models");
    assert.equal(requests[0].headers.Authorization, "Bearer llmtr-test-key");
    assert.deepEqual(
      models.map((model) => model.id),
      ["llmtr/qwen3-8-27b", "qwen/qwen3.8-27b-free"],
    );

    const qwenCaps = getModelCapabilities({
      provider: "llmtr",
      model: "llmtr/qwen3-8-27b",
      apiBase: "https://llmtr.com/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      scope: "group-llmtr",
    });
    assert.equal(qwenCaps.provider, "qwen");
  });
});
