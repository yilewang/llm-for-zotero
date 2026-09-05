import { assert } from "chai";
import {
  configureModelCapabilityRuntime,
  getModelCapabilities,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { buildReasoningPayload } from "../src/utils/llmClient";
import { detectReasoningProvider } from "../src/modules/contextPanel/chat";
import { isLocalModelApiBase } from "../src/utils/providerPresets";

/**
 * The axis split: which reasoning levels a model has comes from the model, but
 * how a level is encoded on the wire comes from the server. Fusing the two is
 * what made `qwen3:14b` on Ollama receive DashScope's `chat_template_kwargs`.
 */
describe("local model reasoning", function () {
  const OLLAMA_BASE = "http://localhost:11434";

  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  /** Stand up an Ollama server reporting the given capabilities for one model. */
  async function primeOllamaCatalog(params: {
    model: string;
    capabilities: string[];
    contextLength?: number;
  }) {
    configureModelCapabilityRuntime({
      fetch: (async (url: string) => {
        if (String(url).endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: params.model }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            capabilities: params.capabilities,
            model_info: {
              "general.architecture": "testarch",
              "testarch.context_length": params.contextLength ?? 40960,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const identity = {
      model: params.model,
      apiBase: OLLAMA_BASE,
      protocol: "ollama_native",
    } as const;
    await refreshModelCatalog(identity);
    return identity;
  }

  it("offers Off/On for a thinking-capable model", async function () {
    const identity = await primeOllamaCatalog({
      model: "gemma4",
      capabilities: ["completion", "thinking"],
    });
    const capabilities = getModelCapabilities(identity);

    assert.equal(capabilities.reasoning.kind, "select");
    assert.deepEqual(
      capabilities.reasoning.options.map((o) => o.label),
      ["Off", "On"],
    );
    assert.equal(capabilities.provenance.reasoning, "live");
  });

  it("resolves live capabilities when the user typed the short name for a :latest tag", async function () {
    // /api/tags always reports the explicit tag (`qwen3:latest`) while the
    // same weights answer to plain `qwen3` on every endpoint — the hand-typed
    // short form must still find the thinking toggle and context window.
    configureModelCapabilityRuntime({
      fetch: (async (url: string) => {
        if (String(url).endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen3:latest" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "thinking"],
            model_info: {
              "general.architecture": "qwen3",
              "qwen3.context_length": 40960,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const identity = {
      model: "qwen3",
      apiBase: OLLAMA_BASE,
      protocol: "ollama_native",
    } as const;
    await refreshModelCatalog(identity);
    const capabilities = getModelCapabilities(identity);
    assert.deepEqual(
      capabilities.reasoning.options.map((o) => o.label),
      ["Off", "On"],
    );
    assert.equal(capabilities.provenance.reasoning, "live");
    assert.equal(capabilities.limits.contextWindowTokens, 40960);
  });

  it("offers no reasoning control for a non-thinking model", async function () {
    const identity = await primeOllamaCatalog({
      model: "gemma3",
      capabilities: ["completion"],
    });
    assert.equal(getModelCapabilities(identity).reasoning.kind, "none");
  });

  it("reads the real context window instead of the 128k default", async function () {
    const identity = await primeOllamaCatalog({
      model: "gemma3",
      capabilities: ["completion"],
      contextLength: 8192,
    });
    assert.equal(
      getModelCapabilities(identity).limits.contextWindowTokens,
      8192,
    );
  });

  it("takes tool support from what the server declares", async function () {
    const withTools = await primeOllamaCatalog({
      model: "qwen3:8b",
      capabilities: ["completion", "tools"],
    });
    assert.isTrue(getModelCapabilities(withTools).features.tools);
    resetModelCapabilityStateForTests();

    const withoutTools = await primeOllamaCatalog({
      model: "gemma3",
      capabilities: ["completion"],
    });
    assert.isFalse(
      getModelCapabilities(withoutTools).features.tools,
      "the optimistic tools:true default must yield to the server",
    );
  });

  describe("encoding", function () {
    it("emits think, not DashScope's chat_template_kwargs, for qwen on Ollama", async function () {
      const identity = await primeOllamaCatalog({
        model: "qwen3:14b",
        capabilities: ["completion", "thinking"],
      });

      const payload = buildReasoningPayload(
        { provider: "qwen", level: "default" },
        false,
        identity.model,
        OLLAMA_BASE,
        "ollama_native",
      );

      assert.deepEqual(payload.extra, { think: true });
      assert.notProperty(payload.extra, "chat_template_kwargs");
    });

    it("emits think:false for the Off level", async function () {
      const identity = await primeOllamaCatalog({
        model: "gemma4",
        capabilities: ["completion", "thinking"],
      });

      const payload = buildReasoningPayload(
        { provider: "local", level: "minimal" },
        false,
        identity.model,
        OLLAMA_BASE,
        "ollama_native",
      );

      assert.deepEqual(payload.extra, { think: false });
    });

    it("emits nothing for a model the server says cannot think", async function () {
      const identity = await primeOllamaCatalog({
        model: "gemma3",
        capabilities: ["completion"],
      });

      const payload = buildReasoningPayload(
        { provider: "local", level: "default" },
        false,
        identity.model,
        OLLAMA_BASE,
        "ollama_native",
      );

      assert.deepEqual(payload.extra, {});
    });

    it("leaves hosted providers untouched", function () {
      const payload = buildReasoningPayload(
        { provider: "deepseek", level: "high" },
        false,
        "deepseek-reasoner",
        "https://api.deepseek.com/v1",
        "openai_chat_compat",
      );
      assert.notProperty(
        payload.extra,
        "think",
        "a hosted provider must never pick up Ollama's encoding",
      );
      assert.property(payload.extra, "thinking");
    });
  });

  describe("provider detection", function () {
    it("keeps a recognized family when served locally", function () {
      assert.equal(
        detectReasoningProvider("qwen3:14b", OLLAMA_BASE),
        "qwen",
        "the level set belongs to the weights, not to the host",
      );
      assert.equal(
        detectReasoningProvider("deepseek-r1:8b", OLLAMA_BASE),
        "deepseek",
      );
    });

    it("falls back to local only for names that match nothing", function () {
      assert.equal(detectReasoningProvider("gemma4", OLLAMA_BASE), "local");
      assert.equal(detectReasoningProvider("mistral:7b", OLLAMA_BASE), "local");
      assert.equal(
        detectReasoningProvider("my-assistant:latest", OLLAMA_BASE),
        "local",
      );
    });

    it("stays unsupported for an unrecognized hosted model", function () {
      assert.equal(
        detectReasoningProvider("mystery-model", "https://api.example.com/v1"),
        "unsupported",
      );
      assert.equal(detectReasoningProvider("mystery-model"), "unsupported");
    });
  });

  describe("isLocalModelApiBase", function () {
    it("accepts loopback, LAN and mDNS hosts", function () {
      for (const base of [
        "http://localhost:11434",
        "http://127.0.0.1:1234/v1",
        "http://0.0.0.0:8080",
        "http://[::1]:11434",
        "http://192.168.1.50:8000/v1",
        "http://10.0.0.4:11434",
        "http://172.16.5.9:11434",
        "http://172.31.255.1:11434",
        "http://gpu.local:11434",
        "http://host.docker.internal:11434",
      ]) {
        assert.isTrue(isLocalModelApiBase(base), base);
      }
    });

    it("rejects hosted providers and public addresses", function () {
      for (const base of [
        "https://api.openai.com/v1",
        "https://api.anthropic.com/v1",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "http://172.32.0.1:11434",
        "http://11.0.0.1:11434",
        "http://193.168.1.1:11434",
        "",
        "not-a-url",
      ]) {
        assert.isFalse(isLocalModelApiBase(base), base);
      }
    });
  });
});
