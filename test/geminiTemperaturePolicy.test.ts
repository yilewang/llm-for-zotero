import { assert } from "chai";
import { callLLMStream } from "../src/utils/llmClient";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";
import type { AgentRuntimeRequest, ToolSpec } from "../src/agent/types";

describe("gemini temperature policy", function () {
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

  function mockFetchCapturingBody(): { bodies: Record<string, unknown>[] } {
    const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          if (url.includes("GenerateContent")) {
            captured.bodies.push(
              JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
            );
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: makeSseStream([
              'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\n',
            ]),
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "OK" }] } }],
            }),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };
    return captured;
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

  function chatParams(model: string, temperature?: number) {
    return {
      prompt: "Say hi.",
      model,
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native" as const,
      ...(temperature === undefined ? {} : { temperature }),
    };
  }

  function generationConfigOf(
    body: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return (body?.generationConfig as Record<string, unknown>) || {};
  }

  it("omits the default temperature for Gemini 3 chat requests", async function () {
    const captured = mockFetchCapturingBody();
    await callLLMStream(chatParams("gemini-3.6-flash"), () => undefined);
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.notProperty(generationConfig, "temperature");
  });

  it("keeps an explicit temperature for Gemini 3 chat requests", async function () {
    const captured = mockFetchCapturingBody();
    await callLLMStream(chatParams("gemini-3.6-flash", 0.5), () => undefined);
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.equal(generationConfig.temperature, 0.5);
  });

  it("keeps the default temperature for Gemini 2.5 chat requests", async function () {
    const captured = mockFetchCapturingBody();
    await callLLMStream(chatParams("gemini-2.5-flash"), () => undefined);
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.equal(generationConfig.temperature, 0.3);
  });

  const tools: ToolSpec[] = [
    {
      name: "query_library",
      description: "search",
      inputSchema: { type: "object" },
      mutability: "read",
      requiresConfirmation: false,
    },
  ];

  function agentRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Inspect this",
      model: "gemini-3.6-flash",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      providerProtocol: "gemini_native",
      ...overrides,
    };
  }

  it("omits the default temperature for Gemini 3 agent requests", async function () {
    const captured = mockFetchCapturingBody();
    const adapter = new GeminiNativeAgentAdapter();
    await adapter.runStep({
      request: agentRequest(),
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.notProperty(generationConfig, "temperature");
  });

  it("keeps an explicit temperature for Gemini 3 agent requests", async function () {
    const captured = mockFetchCapturingBody();
    const adapter = new GeminiNativeAgentAdapter();
    await adapter.runStep({
      request: agentRequest({ advanced: { temperature: 0.7 } }),
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.equal(generationConfig.temperature, 0.7);
  });

  it("keeps the default temperature for Gemini 2.5 agent requests", async function () {
    const captured = mockFetchCapturingBody();
    const adapter = new GeminiNativeAgentAdapter();
    await adapter.runStep({
      request: agentRequest({ model: "gemini-2.5-pro" }),
      messages: [{ role: "user", content: "Summarize it" }],
      tools,
    });
    const generationConfig = generationConfigOf(captured.bodies[0]);
    assert.equal(generationConfig.temperature, 0.3);
  });
});
