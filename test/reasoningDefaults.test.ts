import { assert } from "chai";
import {
  configureModelCapabilityRuntime,
  refreshModelCatalog,
  getModelCapabilities,
  resetModelCapabilityStateForTests,
  resolveModelReasoningSelection,
} from "../src/modelCapabilities";
import {
  detectReasoningProvider,
  getReasoningOptions,
  getSelectedReasoningForItem,
} from "../src/modules/contextPanel/chat";
import {
  selectedReasoningCache,
  selectedReasoningProviderCache,
} from "../src/modules/contextPanel/state";
import { buildReasoningPayload, callLLMStream } from "../src/utils/llmClient";
import { OpenAIResponsesAgentAdapter } from "../src/agent/model/openaiResponses";
import { OpenAIChatCompatAgentAdapter } from "../src/agent/model/openaiCompatible";
import { computeProfileOverrideDraft } from "../src/modules/modelProfileEditor";

describe("model-aware reasoning defaults", function () {
  const base = "https://relay.example/v1";
  const originalZotero = globalThis.Zotero;
  beforeEach(function () {
    globalThis.Zotero = {
      Prefs: { get: () => "", set: () => {} },
    } as unknown as typeof Zotero;
    resetModelCapabilityStateForTests();
    selectedReasoningCache.clear();
    selectedReasoningProviderCache.clear();
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
    resetModelCapabilityStateForTests();
    selectedReasoningCache.clear();
    selectedReasoningProviderCache.clear();
  });

  it("offers Auto and Astra efforts through the custom-endpoint selector", function () {
    const model = "gpt-6-astra";
    const provider = detectReasoningProvider(model, base);
    const choices = getReasoningOptions(provider, model, base, "responses_api");
    assert.deepEqual(
      choices.map((choice) => choice.level),
      ["auto", "low", "medium", "high", "xhigh", "max"],
    );
    selectedReasoningProviderCache.set(1, provider);
    selectedReasoningCache.set(1, "none");
    const selection = getSelectedReasoningForItem(
      1,
      model,
      base,
      "responses_api",
    );
    assert.equal(selectedReasoningCache.get(1), "auto");
    assert.deepEqual(
      buildReasoningPayload(selection, true, model, base, "responses_api")
        .extra,
      {},
    );
    selectedReasoningCache.set(1, "max");
    const explicit = getSelectedReasoningForItem(
      1,
      model,
      base,
      "responses_api",
    );
    assert.equal(
      (
        buildReasoningPayload(explicit, true, model, base, "responses_api")
          .extra.reasoning as { effort: string }
      ).effort,
      "max",
    );
  });

  it("keeps an unfamiliar model usable without inventing support", function () {
    const model = "gpt-99-future";
    assert.equal(
      getModelCapabilities({ model, apiBase: base }).reasoning.kind,
      "unknown",
    );
    assert.deepEqual(
      getReasoningOptions(
        detectReasoningProvider(model, base),
        model,
        base,
      ).map((choice) => choice.level),
      ["auto"],
    );
    for (const level of ["auto", "none", "low"]) {
      assert.deepEqual(
        buildReasoningPayload({ provider: "openai", level }, false, model, base)
          .extra,
        {},
      );
    }
  });

  it("does not allow an explicit effort to bypass Astra capability validation", function () {
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "openai", level: "high", effort: "none" },
        true,
        "gpt-6-astra",
        base,
      ).extra,
      {},
    );
  });

  it("only offers Anthropic Off for profiles that permit disabled thinking", function () {
    const required = getReasoningOptions(
      "anthropic",
      "claude-mythos-preview",
      "https://api.anthropic.com",
      "anthropic_messages",
    );
    assert.notInclude(
      required.map((option) => option.level),
      "none",
    );
    const optional = getReasoningOptions(
      "anthropic",
      "claude-opus-4-7",
      "https://api.anthropic.com",
      "anthropic_messages",
    );
    assert.include(
      optional.map((option) => option.level),
      "none",
    );
  });

  it("does not extrapolate older GPT profiles to new minor releases", function () {
    assert.equal(
      getModelCapabilities({ model: "gpt-5.99", apiBase: base }).reasoning.kind,
      "unknown",
    );
  });

  it("uses structured endpoint choices, isolates endpoints, and preserves unknown values", async function () {
    configureModelCapabilityRuntime({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-6-astra",
                reasoning: {
                  kind: "select",
                  defaultOptionId: "quantum",
                  options: [
                    { id: "quantum", label: "Quantum", effort: "quantum" },
                  ],
                },
              },
            ],
          }),
        )) as typeof fetch,
    });
    const identity = {
      model: "gpt-6-astra",
      apiBase: base,
      protocol: "responses_api",
    };
    await refreshModelCatalog(identity);
    assert.deepEqual(
      getModelCapabilities(identity).reasoning.options.map(
        (option) => option.id,
      ),
      ["quantum"],
    );
    assert.deepEqual(
      getReasoningOptions("openai", identity.model, base, "responses_api").map(
        (option) => option.level,
      ),
      ["auto", "quantum"],
    );
    assert.equal(
      (
        buildReasoningPayload(
          { provider: "openai", level: "quantum" },
          true,
          identity.model,
          base,
          "responses_api",
        ).extra.reasoning as { effort: string }
      ).effort,
      "quantum",
    );
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "openai", level: "auto" },
        true,
        identity.model,
        base,
        "responses_api",
      ).extra,
      {},
    );
    assert.equal(
      getModelCapabilities({ ...identity, apiBase: "https://other.example/v1" })
        .reasoning.options[0].id,
      "low",
    );
    configureModelCapabilityRuntime({
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    await refreshModelCatalog(identity, { force: true });
    assert.equal(
      getModelCapabilities(identity).reasoning.options[0].id,
      "quantum",
    );
    assert.isTrue(getModelCapabilities(identity).stale);
  });

  it("does not infer effort choices from a support boolean or malformed metadata", async function () {
    configureModelCapabilityRuntime({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "future-model",
                supports_reasoning: true,
                reasoning: {
                  kind: "select",
                  options: [{ id: "bad", label: "Bad", effort: 7 }],
                },
              },
            ],
          }),
        )) as typeof fetch,
    });
    const identity = {
      model: "future-model",
      apiBase: base,
      protocol: "openai_chat_compat",
    };
    await refreshModelCatalog(identity);
    assert.equal(
      getModelCapabilities(identity).reasoning.kind,
      "server_default",
    );
    assert.deepEqual(
      getReasoningOptions(
        "unsupported",
        identity.model,
        base,
        "openai_chat_compat",
      ).map((option) => option.level),
      ["auto"],
    );
  });

  it("preserves explicit disabling and user-authored default options", function () {
    const model = "custom-model";
    const profileOverride = {
      forModel: model,
      reasoning: {
        kind: "select",
        options: [
          { id: "none", label: "Off", controls: { body: { think: false } } },
          {
            id: "default",
            label: "My default",
            controls: { body: { think: true } },
          },
        ],
      },
    };
    const capability = getModelCapabilities({
      model,
      apiBase: base,
      profileOverride,
    });
    assert.equal(
      resolveModelReasoningSelection(capability, { level: "default" }).kind,
      "option",
    );
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "customized", level: "none" },
        false,
        model,
        base,
        "ollama_native",
        { profileOverride },
      ).extra,
      { think: false },
    );
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "customized", level: "auto" },
        false,
        model,
        base,
        "ollama_native",
        { profileOverride },
      ).extra,
      {},
    );
  });

  it("keeps the Astra editor profile dynamic and encodes manual levels for unknown models", function () {
    const detected = getModelCapabilities({
      model: "gpt-6-astra",
      apiBase: base,
      protocol: "responses_api",
    });
    const unchanged = computeProfileOverrideDraft({
      detected,
      modelName: detected.model,
      rows: detected.reasoning.options.map((option) => ({ id: option.id })),
      extraJson: "",
    });
    assert.isUndefined(unchanged.override);
    const unknown = getModelCapabilities({
      model: "gpt-99",
      apiBase: base,
      protocol: "responses_api",
    });
    const manual = computeProfileOverrideDraft({
      detected: unknown,
      modelName: unknown.model,
      rows: [{ id: "high" }],
      extraJson: "",
    });
    assert.deepEqual(
      buildReasoningPayload(
        { provider: "openai", level: "high" },
        true,
        unknown.model,
        base,
        "responses_api",
        { profileOverride: manual.override },
      ).extra,
      { reasoning: { effort: "high" } },
    );
  });

  for (const protocol of ["responses_api", "openai_chat_compat"] as const) {
    for (const mode of ["chat", "agent"] as const) {
      for (const level of ["auto", "none", "max"]) {
        it(`sends ${level} consistently through ${mode} using ${protocol}`, async function () {
          const globals = globalThis as typeof globalThis & {
            ztoolkit?: unknown;
          };
          const previous = globals.ztoolkit;
          const bodies: Array<Record<string, unknown>> = [];
          globals.ztoolkit = {
            log: () => {},
            getGlobal: (name: string) =>
              name === "fetch"
                ? async (_url: string, init: RequestInit) => {
                    bodies.push(JSON.parse(String(init.body)));
                    if (protocol === "openai_chat_compat")
                      return new Response(
                        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                        { headers: { "content-type": "text/event-stream" } },
                      );
                    return {
                      ok: true,
                      status: 200,
                      headers: { get: () => "application/json" },
                      json: async () => ({
                        status: "completed",
                        output: [
                          {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "OK" }],
                          },
                        ],
                        choices: [
                          {
                            message: { role: "assistant", content: "OK" },
                            finish_reason: "stop",
                          },
                        ],
                      }),
                      text: async () => "",
                    };
                  }
                : undefined,
          };
          try {
            const params = {
              model: "gpt-6-astra",
              apiBase: base,
              apiKey: "test",
              providerProtocol: protocol,
              reasoning: { provider: "openai" as const, level },
            };
            if (mode === "chat")
              await callLLMStream({ ...params, prompt: "Hi" }, () => undefined);
            else
              await (
                protocol === "responses_api"
                  ? new OpenAIResponsesAgentAdapter()
                  : new OpenAIChatCompatAgentAdapter()
              ).runStep({
                request: {
                  ...params,
                  conversationKey: 1,
                  mode: "agent",
                  userText: "Hi",
                },
                messages: [{ role: "user", content: "Hi" }],
                tools: [],
              });
            assert.lengthOf(bodies, 1);
            if (level === "max") {
              if (protocol === "responses_api")
                assert.equal(
                  (bodies[0].reasoning as { effort: string }).effort,
                  "max",
                );
              else assert.equal(bodies[0].reasoning_effort, "max");
            } else {
              assert.notProperty(bodies[0], "reasoning");
              assert.notProperty(bodies[0], "reasoning_effort");
            }
            assert.notProperty(bodies[0], "temperature");
          } finally {
            globals.ztoolkit = previous;
          }
        });
      }
    }
  }
});
