import { assert } from "chai";
import {
  compileReasoningControls,
  configureModelCapabilityRuntime,
  ensureModelCapabilities,
  getModelCapabilities,
  getDiscoveredModels,
  refreshModelCapabilityRegistry,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
  setModelCapabilityRegistryForTests,
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
              revision: 4,
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

  it("accepts a newer validated remote registry revision", async function () {
    configureModelCapabilityRuntime({
      fetch: (async () => {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              schemaVersion: 1,
              revision: 4,
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
});
