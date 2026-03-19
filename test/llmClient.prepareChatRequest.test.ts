import { assert } from "chai";
import {
  callEmbeddings,
  callLLM,
  callLLMStream,
  prepareChatRequest,
} from "../src/utils/llmClient";

describe("llmClient prepareChatRequest", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown })
    .ztoolkit;

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
      model: "deepseek-chat",
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
      providerProtocol: "responses_api",
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

  it("blocks embeddings when codex auth mode is selected", async function () {
    try {
      await callEmbeddings(["hello"], {
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        authMode: "codex_auth",
      });
      assert.fail("expected callEmbeddings to throw");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "does not support embeddings",
      );
    }
  });

  it("refreshes codex auth token on 401 and retries once", async function () {
    const prefsKey = "extensions.zotero.llmforzotero.modelProviderGroups";
    const versionKey =
      "extensions.zotero.llmforzotero.modelProviderGroupsMigrationVersion";
    (globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }).set(
      prefsKey,
      JSON.stringify([
        {
          id: "provider-codex",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          models: [{ id: "m1", model: "gpt-5.4", temperature: 0.3, maxTokens: 256 }],
        },
      ]),
    );
    (globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }).set(
      versionKey,
      2,
    );

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
          json: async () => ({ access_token: "new-access", refresh_token: "refresh-2" }),
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
