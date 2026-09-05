import { assert } from "chai";
import { callLLM, callLLMStream } from "../src/utils/llmClient";
import {
  resolveOllamaNativeApiRoot,
  resolveOllamaNativeEndpoint,
  resolveProviderTransportEndpoint,
  buildProviderTransportHeaders,
} from "../src/utils/providerTransport";
import { detectProviderPreset } from "../src/utils/providerPresets";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

describe("ollama native protocol", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  /** NDJSON framing: one complete JSON object per line, no `data:` prefix. */
  function makeNdjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  function mockFetch(
    handler: (url: string, init?: RequestInit) => Promise<unknown>,
  ) {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? handler : undefined),
      log: () => undefined,
    };
  }

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  describe("endpoint resolution", function () {
    it("appends /api/chat to a bare origin", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434"),
        "http://localhost:11434/api/chat",
      );
    });

    it("strips a pasted /v1 rather than producing /v1/api/chat", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434/v1"),
        "http://localhost:11434/api/chat",
      );
    });

    it("does not double up when the base already names /api/chat", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434/api/chat"),
        "http://localhost:11434/api/chat",
      );
    });

    it("preserves a reverse-proxy path prefix", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("https://gpu.lan/ollama"),
        "https://gpu.lan/ollama/api/chat",
      );
      assert.equal(
        resolveOllamaNativeApiRoot("https://gpu.lan/ollama"),
        "https://gpu.lan/ollama/api",
      );
    });

    it("routes through the shared transport resolver", function () {
      assert.equal(
        resolveProviderTransportEndpoint({
          protocol: "ollama_native",
          apiBase: "http://localhost:11434",
        }),
        "http://localhost:11434/api/chat",
      );
    });
  });

  describe("headers", function () {
    it("omits Authorization when no key is configured", function () {
      const headers = buildProviderTransportHeaders({
        protocol: "ollama_native",
        apiKey: "",
      });
      assert.deepEqual(headers, { "Content-Type": "application/json" });
    });

    it("sends a bearer token when the server is behind a proxy that needs one", function () {
      const headers = buildProviderTransportHeaders({
        protocol: "ollama_native",
        apiKey: "proxy-secret",
      });
      assert.equal(headers.Authorization, "Bearer proxy-secret");
    });
  });

  describe("preset detection", function () {
    it("claims the default Ollama port", function () {
      assert.equal(detectProviderPreset("http://localhost:11434"), "ollama");
      assert.equal(detectProviderPreset("http://127.0.0.1:11434/v1"), "ollama");
    });

    it("claims a local base that names an /api path on a custom port", function () {
      assert.equal(detectProviderPreset("http://localhost:8081/api"), "ollama");
    });

    it("leaves other local ports to the generic local preset", function () {
      assert.equal(
        detectProviderPreset("http://localhost:1234/v1"),
        "local_openai",
      );
      assert.equal(
        detectProviderPreset("http://192.168.1.50:8000/v1"),
        "local_openai",
      );
    });

    it("does not claim hosted providers", function () {
      assert.equal(
        detectProviderPreset("https://api.openai.com/v1/responses"),
        "openai",
      );
      assert.equal(
        detectProviderPreset("https://api.anthropic.com/v1"),
        "anthropic",
      );
    });
  });

  describe("streaming", function () {
    it("separates message.thinking from message.content", async function () {
      const reasoning: string[] = [];
      const deltas: string[] = [];
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"role":"assistant","thinking":"Let me think. "},"done":false}\n',
          '{"message":{"role":"assistant","thinking":"Canberra it is."},"done":false}\n',
          '{"message":{"role":"assistant","content":"The capital "},"done":false}\n',
          '{"message":{"role":"assistant","content":"is Canberra."},"done":true,"done_reason":"stop","prompt_eval_count":11,"eval_count":18}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "What is the capital of Australia?",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        (delta) => deltas.push(delta),
        (event) => reasoning.push(event.details || ""),
      );

      assert.equal(text, "The capital is Canberra.");
      assert.deepEqual(deltas, ["The capital ", "is Canberra."]);
      assert.equal(reasoning.join(""), "Let me think. Canberra it is.");
    });

    it("reports usage from the final chunk", async function () {
      let usage: { promptTokens: number; completionTokens: number } | null =
        null;
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"hi"},"done":true,"prompt_eval_count":7,"eval_count":3}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
        undefined,
        (stats) => {
          usage = stats;
        },
      );

      assert.isNotNull(usage);
      assert.equal(usage!.promptTokens, 7);
      assert.equal(usage!.completionTokens, 3);
    });

    it("handles a JSON object split across chunk boundaries", async function () {
      const deltas: string[] = [];
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"split ',
          'across"},"done":false}\n{"message":{"content":" chunks"},"done":true}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        (delta) => deltas.push(delta),
      );

      assert.equal(text, "split across chunks");
    });

    it("flushes a final object that arrives without a trailing newline", async function () {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"no trailing newline"},"done":true}',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(text, "no trailing newline");
    });

    it("keeps multibyte characters intact across chunk boundaries", async function () {
      const encoder = new TextEncoder();
      const full = encoder.encode(
        '{"message":{"content":"思考中"},"done":true}\n',
      );
      // The JSON prefix is 23 bytes, so 思 occupies bytes 23-25. Cutting at 24
      // lands inside that codepoint, which is what the decoder must buffer.
      const cut = 24;
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(full.slice(0, cut));
            controller.enqueue(full.slice(cut));
            controller.close();
          },
        }),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(text, "思考中");
    });
  });

  describe("request payload", function () {
    it("posts to /api/chat with unlimited num_predict by default", async function () {
      let capturedUrl = "";
      let body: Record<string, unknown> = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(capturedUrl, "http://localhost:11434/api/chat");
      assert.equal(body.model, "gemma3");
      assert.equal(body.stream, true);
      const serializedMessages = (body.messages as Array<{ content?: string }>)
        .map((message) => message.content || "")
        .join("\n");
      assert.equal(
        serializedMessages.split(PAPER_CITATION_CONTRACT).length - 1,
        1,
      );
      // The plugin's 4096 default would let a thinking model spend the whole
      // budget reasoning and return empty content.
      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        -1,
        "untouched default must defer to Ollama's own unlimited default",
      );
    });

    it("merges user options.* instead of replacing the whole options object", async function () {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          profileOverride: {
            forModel: "qwen3:8b",
            extraBody: { options: { repeat_penalty: 1.1 } },
          },
        },
        () => undefined,
      );

      const options = body.options as Record<string, unknown>;
      assert.equal(options.repeat_penalty, 1.1, "the user parameter arrives");
      assert.equal(
        options.num_predict,
        -1,
        "a user options.* entry must not drop num_predict",
      );
      assert.isNumber(
        options.num_ctx,
        "losing num_ctx silently reinstates context truncation",
      );
      assert.isNumber(options.temperature);
    });

    it("allocates Ollama num_ctx from the explicit qwen3.8-max input cap", async function () {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3.8-max",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          inputTokenCap: 1_000_000,
        },
        () => undefined,
      );

      assert.equal(
        (body.options as Record<string, unknown>)?.num_ctx,
        1_000_000,
      );
    });

    it("preserves explicit output above detected limits", async function () {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3.8-max",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          maxTokens: 200_000,
          maxTokensExplicit: true,
          profileOverride: {
            forModel: "qwen3.8-max",
            limits: { outputTokens: 64_000 },
          },
        },
        () => undefined,
      );

      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        200_000,
      );
    });

    it("preserves an explicit 4096-token choice", async function () {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          maxTokens: 4096,
          maxTokensExplicit: true,
        },
        () => undefined,
      );

      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        4096,
      );
    });
  });

  describe("non-streaming", function () {
    it("returns message.content", async function () {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: { role: "assistant", content: "Canberra" },
          done: true,
        }),
        text: async () => "",
      }));

      const text = await callLLM({
        prompt: "capital?",
        model: "gemma3",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
      });

      assert.equal(text, "Canberra");
    });

    it("does not promote reasoning into the answer when content is empty", async function () {
      // The #363 shape. The answer stays empty: a server putting the answer in
      // the reasoning field is the server's bug, and silently promoting it
      // would hide the misconfiguration.
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: {
            role: "assistant",
            content: "",
            thinking: "The user is asking... The capital is Canberra.",
          },
          done: true,
        }),
        text: async () => "",
      }));

      const text = await callLLM({
        prompt: "capital?",
        model: "gemma4",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
      });

      assert.equal(text, "");
    });
  });
});
