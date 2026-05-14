import { assert } from "chai";
import {
  callEmbeddings,
  callLLM,
  callLLMStream,
  getResolvedEmbeddingConfig,
  prepareChatRequest,
} from "../src/utils/llmClient";

describe("llmClient prepareChatRequest", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  function mockFetch(
    handler: (_url: string, init?: RequestInit) => Promise<unknown>,
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

  function anthropicOkStream() {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
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

  it("reports document-context trimming effects before the request is sent", function () {
    const prepared = prepareChatRequest({
      prompt: "Summarize the paper.",
      context: "A".repeat(700000),
      model: "deepseek-custom",
      apiBase: "https://api.example.com/v1",
    });

    assert.isTrue(prepared.inputCap.capped);
    assert.isTrue(
      prepared.inputCap.effects.documentContextTrimmed ||
        prepared.inputCap.effects.documentContextDropped,
    );
  });

  it("includes extra system messages in the prepared request payload", function () {
    const prepared = prepareChatRequest({
      prompt: "Answer the question.",
      context: "Small context.",
      model: "gpt-4o-mini",
      apiBase: "https://api.example.com/v1",
      systemMessages: ["Briefly mention that retrieval was used."],
    });

    assert.include(
      prepared.messages.map((message) => String(message.content)).join("\n"),
      "Briefly mention that retrieval was used.",
    );
  });

  it("keeps system prompts inside input messages for Grok responses requests", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ output_text: "OK" }),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLM({
      prompt: "Say hi.",
      model: "grok-4",
      apiBase: "https://api.x.ai/v1/responses",
      apiKey: "xai-test",
    });

    assert.equal(output, "OK");
    assert.isNotNull(capturedBody);
    assert.notProperty(capturedBody as object, "instructions");
    assert.isArray(capturedBody?.input);
    const input = capturedBody?.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.role, "system");
    assert.include(
      String(input[0]?.content || ""),
      "You are an intelligent research assistant",
    );
    assert.equal(input[input.length - 1]?.role, "user");
  });

  it("merges non-agent chat system messages into a single leading system entry", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      "extensions.zotero.llmforzotero.systemPrompt",
      "You are a custom paper analyst.",
    );
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            const encoder = new TextEncoder();
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
                    ),
                  );
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                },
              }),
              json: async () => ({}),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLMStream(
      {
        prompt: "Summarize the attached paper.",
        context: "Paper context body.",
        history: [
          { role: "user", content: "Earlier question." },
          { role: "assistant", content: "Earlier answer." },
        ],
        model: "Qwen/Qwen3.5-27B",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-test",
        systemMessages: ["Mention if the document context was trimmed."],
      },
      () => undefined,
    );

    assert.equal(output, "OK");
    assert.isNotNull(capturedBody);
    assert.isArray(capturedBody?.messages);
    const messages = capturedBody?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(
      messages.filter((message) => message.role === "system").length,
      1,
    );
    assert.include(
      String(messages[0]?.content || ""),
      "You are a custom paper analyst.",
    );
    assert.include(String(messages[0]?.content || ""), "Document Context:");
    assert.include(
      String(messages[0]?.content || ""),
      "Mention if the document context was trimmed.",
    );
  });

  it("keeps explicit codex auth mode in prepared request", function () {
    const prepared = prepareChatRequest({
      prompt: "hello",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_auth",
    });

    assert.equal(prepared.authMode, "codex_auth");
  });

  it("strips image content from DeepSeek V4 chat requests", function () {
    const prepared = prepareChatRequest({
      prompt: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/v1",
    });

    const lastMessage = prepared.messages[prepared.messages.length - 1];
    assert.equal(lastMessage.role, "user");
    assert.isString(lastMessage.content);
    assert.include(String(lastMessage.content), "Describe this image.");
    assert.include(String(lastMessage.content), "image input");
    assert.notInclude(JSON.stringify(prepared.messages), "image_url");
  });

  it("keeps Anthropic Messages thinking off by default and preserves temperature", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    const output = await callLLMStream(
      {
        prompt: "Say ok.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        temperature: 0.3,
      },
      () => undefined,
    );

    assert.equal(output, "OK");
    assert.notProperty(capturedBody || {}, "thinking");
    assert.notProperty(capturedBody || {}, "output_config");
    assert.equal(capturedBody?.temperature, 0.3);
  });

  it("sends OpenAI prompt cache hints for cache-aware full context", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeSseStream([
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        json: async () => ({}),
        text: async () => "",
      };
    });

    await callLLMStream(
      {
        prompt: "Say ok.",
        context: "Stable paper text ".repeat(1200),
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "openai-test",
        providerProtocol: "openai_chat_compat",
        contextCache: {
          enabled: true,
          mode: "stable_prefix",
          provider: "openai",
          providerLabel: "OpenAI prompt cache",
          telemetry: "openai_cached_tokens",
          cacheKey: "openai:gpt-5.4:paper:abc",
          requestHints: {
            promptCacheKey: "openai:gpt-5.4:paper:abc",
            promptCacheRetention: "24h",
          },
        },
      },
      () => undefined,
    );

    assert.equal(capturedBody?.prompt_cache_key, "openai:gpt-5.4:paper:abc");
    assert.equal(capturedBody?.prompt_cache_retention, "24h");
  });

  it("sends Anthropic cache_control on stable system context", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Say ok.",
        context: "Stable paper text ".repeat(1200),
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        contextCache: {
          enabled: true,
          mode: "anthropic_block",
          provider: "anthropic",
          providerLabel: "Anthropic prompt cache",
          telemetry: "anthropic_read_write",
          cacheKey: "anthropic:paper:abc",
          requestHints: {
            anthropicCacheControl: { type: "ephemeral" },
          },
        },
      },
      () => undefined,
    );

    assert.isArray(capturedBody?.system);
    const system = capturedBody?.system as Array<Record<string, unknown>>;
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    assert.include(String(system[0]?.text || ""), "Document Context:");
  });

  it("sends PDF attachments as Anthropic Messages document blocks", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });
    const originalIOUtils = (
      globalThis as typeof globalThis & { IOUtils?: unknown }
    ).IOUtils;
    (
      globalThis as typeof globalThis & {
        IOUtils?: { read: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils = {
      read: async () => new TextEncoder().encode("%PDF test"),
    };

    try {
      await callLLMStream(
        {
          prompt: "Summarize this PDF.",
          model: "claude-sonnet-4-6",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "anthropic-test",
          providerProtocol: "anthropic_messages",
          attachments: [
            {
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/paper.pdf",
            },
          ],
        },
        () => undefined,
      );
    } finally {
      (
        globalThis as typeof globalThis & { IOUtils?: typeof originalIOUtils }
      ).IOUtils = originalIOUtils;
    }

    const messages = capturedBody?.messages as
      | Array<{ content?: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[messages.length - 1]?.content || [];
    const documentBlock = content.find((part) => part.type === "document") as
      | { source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    assert.equal(documentBlock?.source?.type, "base64");
    assert.equal(documentBlock?.source?.media_type, "application/pdf");
    assert.equal(documentBlock?.source?.data, "JVBERiB0ZXN0");
    assert.isUndefined(
      content.find(
        (part) =>
          part.type === "image" &&
          (part.source as { media_type?: string } | undefined)?.media_type ===
            "application/pdf",
      ),
    );
  });

  it("maps PDF data URLs to Anthropic Messages document blocks", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Summarize this PDF.",
        images: ["data:application/pdf;base64,JVBERi0x"],
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
      },
      () => undefined,
    );

    const messages = capturedBody?.messages as
      | Array<{ content?: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[messages.length - 1]?.content || [];
    const documentBlock = content.find((part) => part.type === "document") as
      | { source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    assert.equal(documentBlock?.source?.type, "base64");
    assert.equal(documentBlock?.source?.media_type, "application/pdf");
    assert.equal(documentBlock?.source?.data, "JVBERi0x");
    assert.isUndefined(
      content.find(
        (part) =>
          part.type === "image" &&
          (part.source as { media_type?: string } | undefined)?.media_type ===
            "application/pdf",
      ),
    );
  });

  it("uses adaptive thinking for Sonnet 4.6 and never sends temperature", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "xhigh" },
        temperature: 0.3,
        maxTokens: 4096,
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, { type: "adaptive" });
    assert.deepEqual(capturedBody?.output_config, { effort: "max" });
    assert.notProperty(capturedBody || {}, "temperature");
    assert.notNestedProperty(capturedBody || {}, "thinking.budget_tokens");
  });

  it("uses manual budget thinking for Haiku 4.5 with a valid budget", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-haiku-4-5",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "high" },
        temperature: 0.3,
        maxTokens: 4096,
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, {
      type: "enabled",
      budget_tokens: 3072,
    });
    assert.notProperty(capturedBody || {}, "temperature");
  });

  it("never sends manual budget thinking for Opus 4.7", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-opus-4-7",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "xhigh" },
        maxTokens: 4096,
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, { type: "adaptive" });
    assert.deepEqual(capturedBody?.output_config, { effort: "xhigh" });
    assert.notNestedProperty(capturedBody || {}, "thinking.budget_tokens");
  });

  it("emits Anthropic-compatible thinking deltas for regular streaming chat", async function () {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first."}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    const reasoningChunks: string[] = [];
    const output = await callLLMStream(
      {
        prompt: "Think.",
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com/anthropic",
        apiKey: "deepseek-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "deepseek", level: "xhigh" },
      },
      () => undefined,
      (event) => {
        if (event.details) reasoningChunks.push(event.details);
      },
    );

    assert.equal(output, "Done");
    assert.deepEqual(reasoningChunks, ["Plan first."]);
  });

  it("does not leak Anthropic thinking fields into OpenAI-compatible Claude calls", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeSseStream([
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        json: async () => ({}),
        text: async () => "",
      };
    });

    const output = await callLLMStream(
      {
        prompt: "Say ok.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.example.com/v1",
        apiKey: "compat-test",
        providerProtocol: "openai_chat_compat",
        reasoning: { provider: "anthropic", level: "high" },
      },
      () => undefined,
    );

    assert.equal(output, "OK");
    assert.notProperty(capturedBody || {}, "thinking");
    assert.notProperty(capturedBody || {}, "output_config");
    assert.notProperty(capturedBody || {}, "reasoning_effort");
  });

  it("downgrades Anthropic Messages reasoning after provider rejections", async function () {
    const requestBodies: Record<string, unknown>[] = [];
    mockFetch(async (_url, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      );
      if (requestBodies.length === 1) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "thinking.type adaptive is not supported",
        };
      }
      if (requestBodies.length === 2) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "budget_tokens is not supported",
        };
      }
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-sonnet-4-6",
        apiBase: "https://third-party.example/v1",
        apiKey: "proxy-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "high" },
        temperature: 0.3,
        maxTokens: 4096,
      },
      () => undefined,
    );

    assert.deepEqual(requestBodies[0]?.thinking, { type: "adaptive" });
    assert.deepEqual(requestBodies[1]?.thinking, {
      type: "enabled",
      budget_tokens: 3072,
    });
    assert.notProperty(requestBodies[2] || {}, "thinking");
    assert.equal(requestBodies[2]?.temperature, 0.3);
  });

  it("fails locally when Anthropic manual thinking cannot fit under max_tokens", async function () {
    try {
      await callLLMStream(
        {
          prompt: "Think.",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "anthropic-test",
          providerProtocol: "anthropic_messages",
          reasoning: { provider: "anthropic", level: "high" },
          maxTokens: 1024,
        },
        () => undefined,
      );
      assert.fail("expected max_tokens validation to fail locally");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "extended thinking requires max_tokens of at least 2048",
      );
    }
  });

  it("rejects Codex app-server in the generic LLM client", async function () {
    try {
      await callLLMStream(
        {
          prompt: "What changed?",
          model: "gpt-5.4",
          authMode: "codex_app_server" as const,
          apiBase: "",
        },
        () => undefined,
      );
      assert.fail("expected generic app-server transport to reject");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "native Codex conversation system",
      );
    }
  });

  it("throws when no dedicated embedding provider is configured", async function () {
    const setPref = globalThis.Zotero.Prefs.set as (
      key: string,
      value: unknown,
    ) => void;
    setPref("extensions.zotero.llmforzotero.embeddingProvider", "");
    setPref("extensions.zotero.llmforzotero.embeddingApiBase", "");
    try {
      await callEmbeddings(["hello"]);
      assert.fail("expected callEmbeddings to throw");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "No embedding provider configured",
      );
    }
  });

  it("changes embedding keys when the dedicated provider config changes", function () {
    const setPref = globalThis.Zotero.Prefs.set as (
      key: string,
      value: unknown,
    ) => void;
    setPref("extensions.zotero.llmforzotero.embeddingProvider", "openai");
    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://api.openai.com/v1",
    );
    setPref("extensions.zotero.llmforzotero.embeddingApiKey", "sk-first");
    setPref(
      "extensions.zotero.llmforzotero.embeddingModel",
      "text-embedding-3-small",
    );
    const initial = getResolvedEmbeddingConfig();

    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://proxy.example/v1",
    );
    const endpointChanged = getResolvedEmbeddingConfig();

    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://api.openai.com/v1",
    );
    setPref("extensions.zotero.llmforzotero.embeddingApiKey", "sk-second");
    const keyChanged = getResolvedEmbeddingConfig();

    assert.notEqual(initial.providerKey, endpointChanged.providerKey);
    assert.notEqual(initial.attemptKey, keyChanged.attemptKey);
  });

  it("refreshes codex auth token on 401 and retries once", async function () {
    const prefsKey = "extensions.zotero.llmforzotero.modelProviderGroups";
    const versionKey =
      "extensions.zotero.llmforzotero.modelProviderGroupsMigrationVersion";
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      prefsKey,
      JSON.stringify([
        {
          id: "provider-codex",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          models: [
            { id: "m1", model: "gpt-5.4", temperature: 0.3, maxTokens: 256 },
          ],
        },
      ]),
    );
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(versionKey, 2);

    const authJson = JSON.stringify({
      tokens: { access_token: "old-access", refresh_token: "refresh-1" },
      last_refresh: "2026-01-01T00:00:00.000Z",
    });
    const writes: string[] = [];
    let apiCallCount = 0;
    const fetchMock = async (url: string) => {
      if (url === "https://auth.openai.com/oauth/token") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            access_token: "new-access",
            refresh_token: "refresh-2",
          }),
          text: async () => "",
        };
      }
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => "unauthorized",
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ output_text: "OK after refresh" }),
        text: async () => "",
      };
    };

    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") return fetchMock;
        if (name === "process") return { env: { HOME: "/home/tester" } };
        if (name === "IOUtils") {
          return {
            exists: async () => true,
            read: async () => new TextEncoder().encode(authJson),
            makeDirectory: async () => undefined,
            write: async (_path: string, data: Uint8Array) => {
              writes.push(new TextDecoder("utf-8").decode(data));
            },
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLM({
      prompt: "ping",
      model: "gpt-5.4",
    });
    assert.equal(output, "OK after refresh");
    assert.equal(apiCallCount, 2);
    assert.isAtLeast(writes.length, 1);
    assert.include(writes[writes.length - 1], "new-access");
  });
});
