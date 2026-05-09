import { assert } from "chai";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";
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

  it("normalizes blank codex app server apiBase values for chat requests", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    let startedThread = false;

    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      "extensions.zotero.llmforzotero.modelProviderGroups",
      JSON.stringify([
        {
          id: "provider-codex-app",
          apiBase: "",
          apiKey: "",
          authMode: "codex_app_server",
          models: [
            {
              id: "model-1",
              model: "gpt-5.4",
              temperature: 0.3,
              maxTokens: 256,
            },
          ],
        },
      ]),
    );
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      "extensions.zotero.llmforzotero.modelProviderGroupsMigrationVersion",
      3,
    );

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }
      (globalThis.Zotero as unknown as { isWin?: boolean }).isWin = true;

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: {
                call: (params: { arguments?: string[] }) => Promise<unknown>;
              };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async (_params: { arguments?: string[] }) => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        startedThread = true;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        queueMicrotask(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Hello" } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        });
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const prepared = prepareChatRequest({
        prompt: "What changed?",
      });
      const output = await callLLMStream(
        {
          prompt: "What changed?",
        },
        () => undefined,
      );

      assert.equal(
        prepared.apiBase,
        "https://chatgpt.com/backend-api/codex/responses",
      );
      assert.equal(prepared.authMode, "codex_app_server");
      assert.equal(output, "Hello");
      assert.isTrue(startedThread);
    } finally {
      destroyCachedCodexAppServerProcess("codex_app_server_chat");
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
    }
  });

  it("routes codex app server chat requests through the local app-server transport", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    let lastTurnInput: unknown = "";
    let lastInjectedItems: unknown = null;
    let lastThreadStartParams: Record<string, unknown> | null = null;
    let lastTurnParams: Record<string, unknown> | null = null;
    const reasoning: string[] = [];
    const usage: Array<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }
      (globalThis.Zotero as unknown as { isWin?: boolean }).isWin = true;

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: {
                call: (params: { arguments?: string[] }) => Promise<unknown>;
              };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async (_params: { arguments?: string[] }) => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                        params?: Record<string, unknown> & { input?: unknown };
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        assert.equal(message.params?.ephemeral, true);
                        lastThreadStartParams = message.params || null;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        lastInjectedItems = message.params?.items ?? null;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        lastTurnParams = (message.params || {}) as Record<
                          string,
                          unknown
                        >;
                        lastTurnInput = message.params?.input ?? "";
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        queueMicrotask(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", delta: "Checking the history." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Hello" } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { totalTokens: 12, inputTokens: 9, outputTokens: 3 } } } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        });
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const chunks: string[] = [];
      const prepared = prepareChatRequest({
        prompt: "What changed?",
        image: "file:///C:/Users/alice/figure.png",
        history: [
          { role: "user", content: "Earlier question." },
          { role: "assistant", content: "Earlier answer." },
        ],
        model: "gpt-5.4",
        authMode: "codex_app_server",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        reasoning: {
          provider: "openai",
          level: "high",
        },
      });
      const output = await callLLMStream(
        {
          prompt: "What changed?",
          image: "file:///C:/Users/alice/figure.png",
          history: [
            { role: "user", content: "Earlier question." },
            { role: "assistant", content: "Earlier answer." },
          ],
          model: "gpt-5.4",
          authMode: "codex_app_server",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          reasoning: {
            provider: "openai",
            level: "high",
          },
        },
        (delta) => {
          chunks.push(delta);
        },
        (event) => {
          if (event.summary) {
            reasoning.push(event.summary);
          }
        },
        (event) => {
          usage.push(event);
        },
      );

      assert.equal(output, "Hello");
      assert.deepEqual(chunks, ["Hello"]);
      assert.deepEqual(reasoning, ["Checking the history."]);
      assert.deepEqual(usage, [
        {
          promptTokens: 9,
          completionTokens: 3,
          totalTokens: 12,
        },
      ]);
      assert.equal(lastTurnParams?.model, "gpt-5.4");
      assert.equal(lastTurnParams?.effort, "high");
      assert.equal(lastTurnParams?.summary, "detailed");
      assert.equal(
        lastThreadStartParams?.developerInstructions,
        (prepared.messages[0] as { content: string }).content,
      );
      assert.isArray(lastTurnInput);
      const input = lastTurnInput as Array<Record<string, unknown>>;
      const textParts = input
        .filter((part) => part.type === "text")
        .map((part) => String(part.text || ""));
      assert.deepEqual(textParts, ["What changed?"]);
      const imagePart = input.find((part) => part.type === "localImage");
      assert.deepEqual(imagePart, {
        type: "localImage",
        path: "/mnt/c/Users/alice/figure.png",
      });
      assert.deepEqual(lastInjectedItems, [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier question." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Earlier answer." }],
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess("codex_app_server_chat");
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
    }
  });

  it("falls back to legacy flattened chat input when thread/inject_items is unsupported", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const stdout = new MockStdout();
    const threadStartParams: Array<Record<string, unknown>> = [];
    const turnInputs: unknown[] = [];
    let injectAttemptCount = 0;

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log: () => void };
        }
      ).ztoolkit = {
        log: () => undefined,
      };

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async () => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                        params?: Record<string, unknown> & { input?: unknown };
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        threadStartParams.push(message.params || {});
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        injectAttemptCount += 1;
                        stdout.push(
                          `${JSON.stringify({
                            id: message.id,
                            error: {
                              code: -32601,
                              message:
                                "Invalid request: unknown variant `thread/inject_items`, expected one of initialize, thread/start",
                            },
                          })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        turnInputs.push(message.params?.input ?? null);
                        const turnId = `turn-${turnInputs.length}`;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: turnId } })}\n`,
                        );
                        queueMicrotask(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId, delta: turnInputs.length === 1 ? "First." : "Second." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId, status: "completed" } })}\n`,
                          );
                        });
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const firstParams = {
        prompt: "What changed?",
        context: "Full text from Zotero text mode.",
        history: [
          { role: "user" as const, content: "Earlier question." },
          { role: "assistant" as const, content: "Earlier answer." },
        ],
        model: "gpt-5.4",
        authMode: "codex_app_server" as const,
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
      };
      const secondParams = {
        prompt: "Focus on action items.",
        context: "Full text from Zotero text mode.",
        history: [
          { role: "user" as const, content: "Earlier question." },
          { role: "assistant" as const, content: "Earlier answer." },
        ],
        model: "gpt-5.4",
        authMode: "codex_app_server" as const,
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
      };
      const firstPrepared = prepareChatRequest(firstParams);
      const secondPrepared = prepareChatRequest(secondParams);

      const first = await callLLMStream(firstParams, () => undefined);
      const second = await callLLMStream(secondParams, () => undefined);

      assert.equal(first, "First.");
      assert.equal(second, "Second.");
      assert.equal(injectAttemptCount, 1);
      const extractSystemInstructions = (
        messages: typeof firstPrepared.messages,
      ) =>
        messages
          .filter((message) => message.role === "system")
          .map((message) => String(message.content).trim())
          .filter(Boolean)
          .join("\n\n");
      assert.equal(
        threadStartParams[0]?.developerInstructions,
        extractSystemInstructions(firstPrepared.messages),
      );
      assert.equal(
        threadStartParams[1]?.developerInstructions,
        extractSystemInstructions(secondPrepared.messages),
      );
      assert.include(
        String(threadStartParams[0]?.developerInstructions || ""),
        "Document Context:\nFull text from Zotero text mode.",
      );
      const flattenWithoutSystemMessages = (
        messages: typeof firstPrepared.messages,
      ) =>
        messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            type: "text",
            text: `${
              message.role === "system"
                ? "System"
                : message.role === "assistant"
                  ? "Assistant"
                  : "User"
            }:\n${String(message.content)}`,
          }));
      assert.deepEqual(
        turnInputs[0],
        flattenWithoutSystemMessages(firstPrepared.messages),
      );
      assert.deepEqual(
        turnInputs[1],
        flattenWithoutSystemMessages(secondPrepared.messages),
      );
    } finally {
      destroyCachedCodexAppServerProcess("codex_app_server_chat");
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("surfaces non-compatibility inject failures instead of falling back", async function () {
    const originalChromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: unknown;
      }
    ).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    let injectAttemptCount = 0;

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (path: string) => {
              Subprocess: { call: () => Promise<unknown> };
            };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async () => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/inject_items") {
                        injectAttemptCount += 1;
                        stdout.push(
                          `${JSON.stringify({
                            id: message.id,
                            error: {
                              code: -32000,
                              message:
                                "permission denied while updating thread metadata",
                            },
                          })}\n`,
                        );
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const request = {
        prompt: "What changed?",
        history: [
          { role: "user" as const, content: "Earlier question." },
          { role: "assistant" as const, content: "Earlier answer." },
        ],
        model: "gpt-5.4",
        authMode: "codex_app_server" as const,
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
      };

      try {
        await callLLMStream(request, () => undefined);
        assert.fail("expected inject failure to reject");
      } catch (error) {
        assert.include(
          (error as Error).message,
          "permission denied while updating thread metadata",
        );
      }

      try {
        await callLLMStream(request, () => undefined);
        assert.fail("expected inject failure to reject");
      } catch (error) {
        assert.include(
          (error as Error).message,
          "permission denied while updating thread metadata",
        );
      }

      assert.equal(injectAttemptCount, 2);
    } finally {
      destroyCachedCodexAppServerProcess("codex_app_server_chat");
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
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
